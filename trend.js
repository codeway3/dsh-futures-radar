/**
 * 趋势策略 · 纯逻辑（无 IO、无副作用）
 *
 * 设计依据见 docs/trend-strategy.md：
 *   - 信号在加权指数上计算（东财 159.<品种>fi），无换月跳空
 *   - 主策略：55 日通道突破 + MA20>MA60 + 量比≥1.2 + TRIX(12) 同向
 *   - 出场：盘中止损 5% / 跌破 MA20 / TRIX 反向交叉 / 持有上限
 *   - 辅2：近 10 日跌≥15% + 上穿 MA10 + 仍在 MA60 下方 → 做多
 *   - 组合：并发上限 8、同板块 2、按量比降序、同品种反手合并
 *
 * 本模块只做「给定日线算信号与状态」，抓数据与执行在 scripts/ 下。
 */

export const TREND_DEFAULTS = {
  channel: 55,        // 突破通道长度
  fastMa: 20,
  slowMa: 60,
  exitMa: 20,         // 主策略出场均线
  volRatio: 1.2,      // 量比门槛
  trixPeriod: 12,
  trixSignal: 9,
  stopPct: 5,         // 灾难止损百分比（SAR 的下限）
  stopMode: 'fixed',  // 'fixed' 固定止损（默认）| 'sar' 纯 SAR | 'sar_floor' SAR + 灾难底线
  sarStep: 0.02,      // SAR 加速因子步长
  sarMax: 0.2,        // SAR 加速因子上限
  holdDays: 40,       // 最长持有交易日
  dedupeDays: 20,     // 同品种信号去重
  maxPositions: 8,    // 并发持仓上限
  maxSector: 2,       // 同板块同向上限
  warmup: 70,         // 计算指标所需最少 K 线
  minVol20: 5000,     // 近 20 日均量兜底下限（只挡极端不活跃；主过滤仍是 catalog 的 liquid 标记）
  volAllow: ['EC'],   // 成交量低但必须监控的品种（EC 集运欧线）
}

export const REBOUND_CONFIG = {
  ...TREND_DEFAULTS,
  exitMa: 10,
  holdDays: 20,
  dropPct: -15,       // 近 10 日内 20 日跌幅曾 ≤ -15%
  lookback: 10,
  channel: 0,         // 辅2 不用通道
  stopMode: 'fixed',  // 辅2 保持 5% 固定止损
}

const num = (x) => (Number.isFinite(x) ? x : NaN)

/** 指数移动平均 */
export function ema(values, period) {
  const out = new Array(values.length).fill(NaN)
  const k = 2 / (period + 1)
  let prev = NaN
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    prev = Number.isFinite(prev) ? prev + (v - prev) * k : v
    out[i] = prev
  }
  return out
}

/** 滚动最高/最低（不含当前 bar） */
function rollingExtreme(values, period, pick) {
  const out = new Array(values.length).fill(NaN)
  for (let i = period; i < values.length; i++) {
    let best = pick === 'max' ? -Infinity : Infinity
    for (let j = i - period; j < i; j++) {
      const v = values[j]
      if (!Number.isFinite(v)) continue
      best = pick === 'max' ? Math.max(best, v) : Math.min(best, v)
    }
    out[i] = Number.isFinite(best) ? best : NaN
  }
  return out
}

function rollingMean(values, period, inclusive = true) {
  const out = new Array(values.length).fill(NaN)
  for (let i = 0; i < values.length; i++) {
    const from = inclusive ? i - period + 1 : i - period
    const to = i
    if (from < 0) continue
    let sum = 0
    let n = 0
    for (let j = from; j <= to; j++) {
      if (Number.isFinite(values[j])) { sum += values[j]; n++ }
    }
    out[i] = n === period ? sum / n : NaN
  }
  return out
}

/**
 * 计算指标序列。
 * @param {Array<{date:string,o:number,h:number,l:number,c:number,v:number}>} bars 已按日期升序
 */
export function computeSeries(bars, cfg = TREND_DEFAULTS) {
  const n = bars.length
  const c = bars.map((b) => num(b.c))
  const h = bars.map((b) => num(b.h))
  const l = bars.map((b) => num(b.l))
  const v = bars.map((b) => num(b.v))

  const ma10 = rollingMean(c, 10)
  const ma20 = rollingMean(c, cfg.fastMa)
  const ma60 = rollingMean(c, cfg.slowMa)

  // TRIX(period)：三重 EMA 的变化率
  const e1 = ema(c, cfg.trixPeriod)
  const e2 = ema(e1, cfg.trixPeriod)
  const e3 = ema(e2, cfg.trixPeriod)
  const trix = e3.map((x, i) => (i === 0 || !Number.isFinite(x) || !Number.isFinite(e3[i - 1]) || e3[i - 1] === 0
    ? NaN
    : ((x / e3[i - 1]) - 1) * 100))
  const trixSig = ema(trix, cfg.trixSignal)

  // ATR(14) 百分比
  const tr = bars.map((b, i) => {
    if (i === 0) return num(b.h) - num(b.l)
    const pc = c[i - 1]
    return Math.max(num(b.h) - num(b.l), Math.abs(num(b.h) - pc), Math.abs(num(b.l) - pc))
  })
  const atr = rollingMean(tr, 14)
  const atrPct = atr.map((x, i) => (Number.isFinite(x) && c[i] > 0 ? (x / c[i]) * 100 : NaN))

  const hh = cfg.channel > 0 ? rollingExtreme(h, cfg.channel, 'max') : new Array(n).fill(NaN)
  const ll = cfg.channel > 0 ? rollingExtreme(l, cfg.channel, 'min') : new Array(n).fill(NaN)
  const volMa = rollingMean(v, 20)
  // 抛物线转向（SAR）：第 i 根的值只依赖前 i-1 根，盘中不会重绘
  const sar = sarSeries(h, l, cfg.sarStep, cfg.sarMax)

  return bars.map((b, i) => ({
    ...b,
    ma10: ma10[i],
    ma20: ma20[i],
    ma60: ma60[i],
    trix: trix[i],
    trixSig: trixSig[i],
    atrPct: atrPct[i],
    hh: hh[i],
    ll: ll[i],
    sar: sar[i],
    vr: Number.isFinite(v[i]) && Number.isFinite(volMa[i]) && volMa[i] > 0 ? v[i] / volMa[i] : NaN,
  }))
}

/** 近 n 根的平均成交量（只用有效的正数） */
export function avgVolume(series, n = 20) {
  const arr = series.slice(-n).map((r) => r.v).filter((v) => Number.isFinite(v) && v > 0)
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN
}

/** 流动性门槛：近 20 日均量低于 minVol20 的品种不监控；volAllow 里的品种豁免 */
export function liquidityOk(series, cfg = TREND_DEFAULTS, variety = '') {
  if (!cfg.minVol20) return true
  if (Array.isArray(cfg.volAllow) && cfg.volAllow.includes(String(variety).toUpperCase())) return true
  const v = avgVolume(series, 20)
  return Number.isFinite(v) && v >= cfg.minVol20
}

/**
 * 抛物线转向指标（Parabolic SAR）。
 * 第 i 根返回的价位在 i 开盘前就已确定：先用 i-1 的 EP/AF 推进一步，
 * 再用 i-1、i-2 的极值做钳制；i 根自身的极值只影响 i+1。
 */
export function sarSeries(high, low, step = 0.02, maxStep = 0.2) {
  const n = high.length
  const out = new Array(n).fill(NaN)
  if (n < 3) return out
  let up = true
  let af = step
  let ep = high[0]
  let sar = low[0]
  out[0] = sar
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(high[i]) || !Number.isFinite(low[i])) {
      out[i] = sar
      continue
    }
    // 第 i 根的 SAR 只用第 i-1 根及之前的数据算出，盘中可直接挂单
    sar += af * (ep - sar)
    if (up) {
      if (i >= 2) sar = Math.min(sar, low[i - 1], low[i - 2])
    } else if (i >= 2) {
      sar = Math.max(sar, high[i - 1], high[i - 2])
    }
    out[i] = sar
    // 用第 i 根更新状态，供第 i+1 根使用
    if (up) {
      if (low[i] < sar) {
        up = false
        sar = ep
        ep = low[i]
        af = step
      } else if (high[i] > ep) {
        ep = high[i]
        af = Math.min(af + step, maxStep)
      }
    } else if (high[i] > sar) {
      up = true
      sar = ep
      ep = high[i]
      af = step
    } else if (low[i] < ep) {
      ep = low[i]
      af = Math.min(af + step, maxStep)
    }
  }
  return out
}

/**
 * 当前 bar 上的止损位。
 * stopMode='fixed'      → 建仓时定死的 stopPct
 * stopMode='sar_floor'  → SAR 与 stopPct 灾难底线取更靠近价格的那个
 */
export function stopLevel(row, pos, cfg = TREND_DEFAULTS) {
  const fixed = pos.dir > 0 ? pos.entryPrice * (1 - cfg.stopPct / 100) : pos.entryPrice * (1 + cfg.stopPct / 100)
  if (cfg.stopMode !== 'sar_floor' && cfg.stopMode !== 'sar') return fixed
  const sar = row?.sar
  if (!Number.isFinite(sar)) return fixed
  if (cfg.stopMode === 'sar') return sar
  return pos.dir > 0 ? Math.max(sar, fixed) : Math.min(sar, fixed)
}

/**
 * 手数计算：给定期权、入场价、止损价、合约乘数。
 * 单笔风险固定 riskPct（默认 0.6%），名义仓位不超过 maxWeightPct（默认 12%）。
 * 返回 { weightPct, lots, notional, riskAmount, distPct }；参数不全返回 null。
 */
export function positionLots({
  entryPrice, stopPrice, equity, riskPct = 0.6, maxWeightPct = 12, multiplier,
} = {}) {
  const dist = Math.abs(entryPrice - stopPrice)
  if (![entryPrice, stopPrice, equity, multiplier].every(Number.isFinite)) return null
  if (entryPrice <= 0 || equity <= 0 || multiplier <= 0 || dist <= 0) return null
  const distPct = (dist / entryPrice) * 100
  const weightPct = Math.min((riskPct / distPct) * 100, maxWeightPct)
  const budget = equity * weightPct / 100
  const lots = Math.max(0, Math.floor(budget / (entryPrice * multiplier)))
  return {
    weightPct,
    lots,
    notional: lots * entryPrice * multiplier,
    riskAmount: lots * dist * multiplier,
    distPct,
  }
}

/**
 * 按「止损距离」定仓：单笔风险固定 riskPct，权重 = riskPct / 距离，上限 maxWeightPct。
 * 距离取建仓时 SAR 与灾难底线的实际距离，避免 SAR 贴在价格上时仓位爆掉。
 */
export function positionWeight(entryPrice, stopPrice, { riskPct = 0.6, maxWeightPct = 12 } = {}) {
  const distPct = Math.abs(entryPrice - stopPrice) / entryPrice * 100
  if (!Number.isFinite(distPct) || distPct <= 0) return { distPct, weightPct: 0 }
  return { distPct, weightPct: Math.min((riskPct / distPct) * 100, maxWeightPct) }
}

/** 主策略：通道突破 + 趋势方向 + 放量 + TRIX 同向 */
export function breakoutSignal(row, cfg = TREND_DEFAULTS) {
  if (!row) return 0
  const { c, ma20, ma60, vr, trix, trixSig, hh, ll } = row
  if (![c, ma20, ma60, vr, trix, trixSig, hh, ll].every(Number.isFinite)) return 0
  const long = c > hh && ma20 > ma60 && vr >= cfg.volRatio && trix > trixSig && trix > 0
  const short = c < ll && ma20 < ma60 && vr >= cfg.volRatio && trix < trixSig && trix < 0
  if (long) return 1
  if (short) return -1
  return 0
}

/** 辅2：暴跌后的右侧确认（上穿 MA10，仍在 MA60 下方） */
export function reboundSignal(series, i, cfg = REBOUND_CONFIG) {
  const row = series[i]
  const prev = series[i - 1]
  if (!row || !prev) return 0
  const { c, ma10, ma60 } = row
  if (![c, ma10, ma60, prev.c, prev.ma10].every(Number.isFinite)) return 0
  // 近 lookback 日内 20 日跌幅曾 ≤ dropPct
  let dropped = false
  for (let j = Math.max(1, i - cfg.lookback - 1); j <= i; j++) {
    const back = series[j - 20]
    if (!back || !Number.isFinite(back.c) || back.c <= 0) continue
    if ((series[j].c / back.c - 1) * 100 <= cfg.dropPct) { dropped = true; break }
  }
  if (!dropped) return 0
  if (!(c > ma10 && prev.c <= prev.ma10)) return 0
  if (!(c < ma60)) return 0
  return 1
}

/** 在给定 bar 上是否触及止损（含跳空穿价） */
export function stopHit(row, pos, cfg = TREND_DEFAULTS) {
  const { o, h, l } = row
  if (![o, h, l].every(Number.isFinite)) return false
  const level = stopLevel(row, pos, cfg)
  if (!Number.isFinite(level)) return false
  if (pos.dir > 0) {
    if (o <= level) return 'gap'
    if (l <= level) return 'touch'
  } else {
    if (o >= level) return 'gap'
    if (h >= level) return 'touch'
  }
  return false
}

/** 收盘条件出场：MA 突破 / TRIX 反向 / 持有到期 */
export function closeExit(row, pos, cfg = TREND_DEFAULTS) {
  const { c, ma20, trix, trixSig } = row
  if (![c, ma20, trix, trixSig].every(Number.isFinite)) return false
  const ema = cfg.exitMa === 10 ? row.ma10 : row.ma20
  if (!Number.isFinite(ema)) return false
  if (pos.dir > 0) {
    if (c < ema) return 'ma'
    if (trix < trixSig) return 'trix'
  } else {
    if (c > ema) return 'ma'
    if (trix > trixSig) return 'trix'
  }
  return false
}

/**
 * 状态机：从历史 bar 推演到最后一根，返回当前持仓与全部已平仓交易。
 * 入场按「次日开盘」，止损按盘中价（跳空按开盘价），MA/TRIX 出场按收盘价。
 */
export function replaySeries(series, { cfg = TREND_DEFAULTS, signalFn = breakoutAt, sector = '其他' } = {}) {
  const trades = []
  let pos = null
  let lastSignalIndex = -Infinity
  let stoppedToday = null

  for (let i = cfg.warmup; i < series.length; i++) {
    const row = series[i]

    if (pos) {
      const hit = stopHit(row, pos, cfg)
      if (hit) {
        const exitPrice = hit === 'gap' ? row.o : pos.stopPrice
        trades.push({ ...pos, exitIndex: i, exitDate: row.date, exitPrice, exitReason: 'stop', pnlPct: ((exitPrice / pos.entryPrice) - 1) * 100 * pos.dir })
        if (i === series.length - 1) stoppedToday = { ...trades[trades.length - 1] }
        pos = null
      } else {
        const why = closeExit(row, pos, cfg)
        const expired = i - pos.entryIndex >= cfg.holdDays
        // 最后一根 bar 的收盘出场不在这里执行：收盘才知道信号，只能次日开盘成交，
        // 交给 planVariety 输出「平仓」任务。盘中止损仍然当日生效（上面已处理）。
        if ((why || expired) && i < series.length - 1) {
          const exitPrice = row.c
          trades.push({ ...pos, exitIndex: i, exitDate: row.date, exitPrice, exitReason: why || 'hold', pnlPct: ((exitPrice / pos.entryPrice) - 1) * 100 * pos.dir })
          pos = null
        }
      }
    }

    if (!pos && i + 1 < series.length && i - lastSignalIndex >= cfg.dedupeDays) {
      const sig = signalFn(series, i, cfg)
      if (sig) {
        const entry = series[i + 1]
        if (Number.isFinite(entry.o) && entry.o > 0) {
          lastSignalIndex = i
          const stopPrice = sig > 0 ? entry.o * (1 - cfg.stopPct / 100) : entry.o * (1 + cfg.stopPct / 100)
          pos = {
            dir: sig, sector, signalIndex: i, signalDate: row.date,
            entryIndex: i + 1, entryDate: entry.date, entryPrice: entry.o, stopPrice,
          }
        }
      }
    }
  }

  return { pos, trades, lastSignalIndex, stoppedToday, lastBar: series[series.length - 1] }
}

/** 主策略信号函数适配（供 replaySeries 的 signalFn 使用） */
function breakoutAt(series, i, cfg) {
  return breakoutSignal(series[i], cfg)
}

/** 辅2 信号函数（需要看历史，所以整段传入） */
function reboundAt(series, i, cfg) {
  return reboundSignal(series, i, cfg)
}

/**
 * 单品种的明日任务。
 * @returns {null|{action:'open'|'close'|'reverse',dir:number,reason:string,...}}
 */
export function planVariety(series, { cfg = TREND_DEFAULTS, channel = 'main', sector = '其他', signalFn: injected = null } = {}) {
  const signalFn = injected || (channel === 'main' ? breakoutAt : reboundAt)
  const { pos, stoppedToday, lastSignalIndex } = replaySeries(series, { cfg, signalFn, sector })
  const i = series.length - 1
  const row = series[i]
  const sig = signalFn(series, i, cfg)
  const dedupeOk = i - lastSignalIndex >= cfg.dedupeDays

  // 今日已触发盘中止损 → 无需动作，仅回报
  if (stoppedToday) {
    return { action: 'stopped', dir: stoppedToday.dir, reason: '今日盘中已止损', price: stoppedToday.exitPrice, channel, sector }
  }

  if (!pos) {
    if (sig && dedupeOk) {
      return { action: 'open', dir: sig, reason: sig > 0 ? '通道突破做多' : '通道突破做空', channel, sector, vr: row.vr, close: row.c, atrPct: row.atrPct }
    }
    return null
  }

  // 持仓：反向信号 → 反手；否则看收盘是否触发退出
  if (sig && sig === -pos.dir) {
    return { action: 'reverse', dir: sig, from: pos.dir, reason: '反向信号（平仓并反手）', channel, sector, vr: row.vr, close: row.c }
  }
  const why = closeExit(row, pos, cfg)
  const expired = i - pos.entryIndex >= cfg.holdDays
  if (why || expired) {
    return { action: 'close', dir: pos.dir, reason: why ? (why === 'ma' ? '跌破出场均线' : 'TRIX 反向交叉') : '持有到期', channel, sector, close: row.c }
  }
  return null
}

/**
 * 组合层：排序 + 并发/板块硬限 + 反手合并。
 * @param {Array} tasks 各品种 planVariety 的结果（含 null）
 * @param {Array} openPositions 当前已持有的品种 [{code,sector,dir}]
 */
export function buildPlan(tasks, openPositions, cfg = TREND_DEFAULTS) {
  const valid = tasks.filter(Boolean)
  const closes = valid.filter((t) => t.action === 'close' || t.action === 'stopped')
  const reversals = valid.filter((t) => t.action === 'reverse')
  const opens = valid.filter((t) => t.action === 'open')

  // 反手 = 先平后开，占用一个新的仓位名额
  const pending = [...reversals, ...opens].sort((a, b) => (b.vr || 0) - (a.vr || 0))

  // 明日平仓的品种同样会在开盘释放名额，先扣掉
  const closing = new Set(closes.map((t) => t.code))
  const held = openPositions.filter((p) => !closing.has(p.code))
  const accepted = []
  const rejected = []

  for (const t of pending) {
    if (t.action === 'reverse') {
      const idx = held.findIndex((p) => p.code === t.code)
      if (idx >= 0) held.splice(idx, 1)
    }
    const sectorCount = held.filter((p) => p.sector === t.sector).length
    if (held.length >= cfg.maxPositions) {
      rejected.push({ ...t, reject: `并发已达上限 ${cfg.maxPositions}` })
      continue
    }
    if (sectorCount >= cfg.maxSector) {
      rejected.push({ ...t, reject: `板块「${t.sector}」已达上限 ${cfg.maxSector}` })
      continue
    }
    held.push({ code: t.code, sector: t.sector, dir: t.dir })
    accepted.push(t)
  }

  return { accepted, rejected, closes }
}

/**
 * 组合层回放：按入场日排序，施加并发/板块上限，返回被接受的仓位。
 * 供扫描脚本与宿主共用，保证"信号持仓"与"实盘可持仓"一致。
 */
export function applyPortfolio(positions, cfg = TREND_DEFAULTS) {
  const sorted = positions.slice().sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0))
  const accepted = []
  const rejected = []
  for (const p of sorted) {
    const openAtEntry = accepted.filter((q) => q.exitDate === null || q.exitDate === undefined || q.exitDate > p.entryDate)
    const sameSector = openAtEntry.filter((q) => q.sector === p.sector).length
    if (openAtEntry.length >= cfg.maxPositions) { rejected.push({ ...p, reject: `并发已达上限 ${cfg.maxPositions}` }); continue }
    if (sameSector >= cfg.maxSector) { rejected.push({ ...p, reject: `板块「${p.sector}」已达上限 ${cfg.maxSector}` }); continue }
    accepted.push(p)
  }
  return { accepted, rejected }
}
