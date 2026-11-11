/**
 * 趋势策略 · 宿主运行时
 *
 * 负责：
 *   1. 维护加权日线缓存（磁盘 + 内存），按需刷新
 *   2. 用 trend.js 回放历史，得到「组合层接受后」的持仓与明日任务
 *   3. 每次轮询用实时快照评估 trigger / stop / tp 提醒，收盘后做 confirm 复核
 *   4. 所有提醒写入 journal（JSONL），供复盘
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TREND_DEFAULTS, REBOUND_CONFIG, computeSeries, replaySeries, planVariety, applyPortfolio, buildPlan,
  breakoutSignal, reboundSignal, stopLevel, liquidityOk, positionWeight, positionLots,
} from './trend.js'
import { buildMonitorLevels, evaluateOne, MONITOR_DEFAULTS } from './trend-monitor.js'

const FIELDS = 'f51,f52,f53,f54,f55,f56'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const REFRESH_MS = 30 * 60 * 1000 // 日线最多 30 分钟刷一次
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 合约乘数表（手数计算用）：不可读时返回空表，手数显示为 — */
function loadMultipliers() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'multipliers.json'), 'utf8'))
    return { contracts: raw.contracts || {}, unverified: new Set(raw.unverified || []) }
  } catch {
    return { contracts: {}, unverified: new Set() }
  }
}

export function defaultTrendCachePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'futures-radar', 'trend-daily.json')
}

export function defaultSuppressPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'futures-radar', 'suppress.json')
}

export function defaultStartPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'futures-radar', 'monitor-start.json')
}

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
// 必须用本地日期：toISOString 是 UTC，东八区 0–8 点会算成昨天
const pad2 = (n) => String(n).padStart(2, '0')
const ymdOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const nextWeekday = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  do {
    x.setDate(x.getDate() + 1)
  } while (x.getDay() === 0 || x.getDay() === 6)
  return x
}

/**
 * 期货交易日（近似，不含节假日）：
 * - 21:00 起的夜盘属于下一个交易日（周五夜盘 → 下周一）
 * - 00:00–02:30 是前一晚夜盘的延续，仍属当天；周六凌晨属周五夜盘 → 下周一
 * - 周末白天归到下一个交易日
 */
const prevWeekday = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  do {
    x.setDate(x.getDate() - 1)
  } while (x.getDay() === 0 || x.getDay() === 6)
  return x
}

/**
 * 最近一个「已收盘」的交易日（收盘确认的目标日）：
 * - 15:15 之前 → 上一个工作日（当天还没收盘）
 * - 15:15 之后（含夜盘、周末）→ 当天/最近工作日，收盘价已定稿
 * 这样 21:00 之后打开插件，仍然能补做当天收盘确认。
 */
export function closedTradingDay(d = new Date()) {
  const m = d.getHours() * 60 + d.getMinutes()
  let base = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (m < 15 * 60 + 15) base = prevWeekday(base)
  while (base.getDay() === 0 || base.getDay() === 6) base = prevWeekday(base)
  return ymdOf(base)
}

const parseYmd = (s) => {
  const [y, m, d] = String(s).split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * 把「明日开盘」翻译成具体入场窗口：
 * 收盘确认后，下一交易日 N 的夜盘从收盘日 D 的 21:00 开始，早盘 N 日 09:00。
 */
export function entryWindowText(target, d = new Date()) {
  const D = parseYmd(target)
  const N = nextWeekday(D)
  const nextStr = ymdOf(N)
  const nightStart = new Date(D.getFullYear(), D.getMonth(), D.getDate(), 21, 0)
  // 夜盘跨零点，最晚到次日 02:30（不同品种 23:00 / 01:00 / 02:30）
  const nightEnd = new Date(D.getFullYear(), D.getMonth(), D.getDate() + 1, 2, 30)
  const nextOpen = new Date(N.getFullYear(), N.getMonth(), N.getDate(), 9, 0)
  const nextClose = new Date(N.getFullYear(), N.getMonth(), N.getDate(), 15, 0)
  if (d < nightStart) return `今晚 21:00 夜盘（若该品种有夜盘）或 ${nextStr} 09:00 早盘`
  if (d < nightEnd) {
    return ymdOf(d) === target
      ? `夜盘已开始（视品种至 23:00/01:00/02:30），或 ${nextStr} 09:00 早盘`
      : `夜盘时段（视品种至 01:00/02:30，部分已收），或 ${nextStr} 09:00 早盘`
  }
  if (d < nextOpen) return `${nextStr} 09:00 早盘`
  if (d < nextClose) return `已开盘，按现价执行（参考价为收盘价）`
  return `已错过计划窗口，按现价执行`
}

export function tradingDayOf(d = new Date()) {
  const wd = d.getDay() // 0=周日 … 6=周六
  const m = d.getHours() * 60 + d.getMinutes()
  if (m >= 21 * 60) return ymdOf(nextWeekday(d))
  if (m < 2 * 60 + 30) return wd === 6 || wd === 0 ? ymdOf(nextWeekday(d)) : ymdOf(d)
  if (wd === 0 || wd === 6) return ymdOf(nextWeekday(d))
  return ymdOf(d)
}

function varietyOf(code) {
  return String(code).replace(/\d+$/, '')
}

async function fetchWeighted(varLower, { begin, end }) {
  const secid = `159.${varLower}fi`
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1`
    + `&beg=${begin}&end=${end}&fields1=f1,f2,f3&fields2=${FIELDS}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout?.(10000),
  })
  if (!res.ok) throw new Error(`上游 ${res.status}`)
  const json = await res.json()
  const data = json?.data
  if (!data?.klines?.length) return null
  const bars = []
  for (const line of data.klines) {
    const [date, o, c, h, l, v] = line.split(',')
    const bar = { date, o: Number(o), c: Number(c), h: Number(h), l: Number(l), v: Number(v) }
    if (![bar.o, bar.c, bar.h, bar.l].every(Number.isFinite)) continue
    bars.push(bar)
  }
  return bars
}

export function createTrendRuntime({ codes, catalogByCode, sectorOf, fetchSnapshots, fetchBars: fetchBarsOpt, now: nowOpt, journal, logger, cacheFile, suppressFile, startFile } = {}) {
  const file = cacheFile || defaultTrendCachePath()
  const suppressPath = suppressFile || defaultSuppressPath()
  const startPath = startFile || defaultStartPath()
  const fetchBars = fetchBarsOpt || fetchWeighted
  // 可注入时钟：自测固定到 15:20，避免依赖真实时段
  const now = typeof nowOpt === 'function' ? nowOpt : () => new Date()
  const today = () => tradingDayOf(now())
  const multipliers = loadMultipliers()
  let equity = 0
  let riskPct = 0.6
  const state = {
    loadedAt: 0,
    refreshing: null,
    bars: {},          // var → bars
    updatedAt: 0,
    lastDate: null,
    positions: [],     // 组合层接受后的持仓
    levels: new Map(), // code → monitor levels
    prevClose: new Map(), // code → 加权前收盘（主连/加权比价锚点）
    refreshTriedAt: 0,    // 上次尝试刷新日线的时间（避免每 tick 全量重拉）
    confirmPending: false, // 已收盘但日线未更新，确认扫描挂起
    confirmPendingDay: null, // 待定所属交易日
    confirmWindow: null, // 最近一次确认对应的入场窗口文案
    historical: 0, // 监控起点之前的历史持仓数（仅展示）
    rejectedTasks: [], // 被组合层拒绝的开仓（给确认卡片标注）
    seen: new Set(),
    seenDay: today(),
    startDate: null,   // 监控起点（早于此日入场的历史仓位不展示）
    confirmDay: null,  // 已完成收盘确认扫描的日期
    confirmed: [],     // 今日收盘确认（明日开盘入场）
    unconfirmed: [],   // 今日提醒过、但收盘未确认的品种及原因
    lastAlerts: [],
    recent: [],
    tasks: [],
    dirty: true,
    lastError: null,
  }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && raw.bars && typeof raw.bars === 'object') {
        state.bars = raw.bars
        state.updatedAt = Number(raw.updatedAt) || 0
      }
    } catch { /* 首次运行没有缓存 */ }
    // 监控起点：早于该日期入场的仓位视为历史，不计入持仓/不参与止损止盈提醒
    try {
      const raw = JSON.parse(fs.readFileSync(startPath, 'utf8'))
      if (raw && typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) state.startDate = raw.date
    } catch { /* 没有起点文件＝全量回放 */ }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ updatedAt: state.updatedAt, bars: state.bars }))
    } catch (err) {
      logger?.warn?.(`futures-radar: 趋势缓存写入失败 ${String(err)}`)
    }
  }

  /**
   * 用当天日志恢复去重键；另外读一份手动抑制表。
   * 插件重载后内存集合是空的，不种种子就会把当天提醒重复写一遍。
   * 清空日志时把"已触发过"的键写进抑制表，可以做到「只从此刻开始检测新信号」。
   */
  function seedSeen() {
    const days = new Set([today(), closedTradingDay(now())].filter(Boolean))
    let text = ''
    try {
      text = fs.readFileSync(journal?.file || '', 'utf8')
    } catch {
      text = ''
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"trend"')) continue
      try {
        const ev = JSON.parse(line)
        if (days.has(ev?.day) && ev.code && ev.kind) state.seen.add(`${ev.code}|${ev.kind}|${ev.day}`)
      } catch {
        /* 坏行跳过 */
      }
    }
    try {
      const raw = JSON.parse(fs.readFileSync(suppressPath, 'utf8'))
      if (raw?.day === day && Array.isArray(raw.keys)) {
        for (const k of raw.keys) {
          if (!String(k).includes('|pre|')) state.seen.add(String(k))
        }
      }
    } catch {
      /* 没有抑制表 */
    }
  }

  /** 从当天日志恢复「最近提醒」，供设置页展示 */
  function seedRecent() {
    const days = new Set([today(), closedTradingDay(now())].filter(Boolean))
    const out = []
    let text = ''
    try {
      text = fs.readFileSync(journal?.file || '', 'utf8')
    } catch {
      return
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"trend"')) continue
      try {
        const ev = JSON.parse(line)
        if (!days.has(ev?.day)) continue
        out.push({ at: ev.at, kind: ev.kind, code: ev.code, name: ev.name, dir: ev.dir, price: ev.price, text: ev.text, day: ev.day })
      } catch {
        /* 坏行跳过 */
      }
    }
    state.recent = out.slice(-50)
  }

  async function refreshDaily() {
    if (state.refreshing) return state.refreshing
    state.refreshing = (async () => {
      const end = now()
      const begin = new Date(end)
      begin.setDate(begin.getDate() - 900)
      const targets = codes.filter((c) => {
        const v = varietyOf(c)
        return /^[A-Za-z]+$/.test(v) && !['IC', 'IF', 'IH', 'IM', 'T', 'TF', 'TL', 'TS'].includes(v.toUpperCase())
      })
      let changed = 0
      const queue = targets.slice()
      const worker = async () => {
        while (queue.length) {
          const code = queue.shift()
          const v = varietyOf(code)
          try {
            const bars = await fetchBars(v.toLowerCase(), { begin: ymd(begin), end: ymd(end) })
            if (bars && bars.length > TREND_DEFAULTS.warmup) { state.bars[v] = bars; changed++ }
          } catch (err) {
            state.lastError = String(err?.message || err)
          }
        }
      }
      await Promise.all(Array.from({ length: 6 }, worker))
      state.loadedAt = Date.now()
      // 只有真的拿到过数据才推进 updatedAt；全部失败时保持旧时间戳，收盘守卫就不会被绕过
      if (changed) {
        state.updatedAt = now().getTime()
        save()
      }
      state.dirty = true
      state.refreshing = null
    })()
    return state.refreshing
  }

  /** 重建持仓、监控位与明日任务 */
  function rebuild() {
    const all = []
    const levels = new Map()
    const names = new Map()
    const rawTasks = []
    const lastRows = new Map()
    let illiquid = 0
    let lastDate = null

    for (const code of codes) {
      const v = varietyOf(code)
      const bars = state.bars[v]
      if (!bars || bars.length < TREND_DEFAULTS.warmup) continue
      const name = catalogByCode?.get?.(code)?.label || catalogByCode?.get?.(code)?.name || v
      names.set(code, name)
      const sector = sectorOf ? sectorOf(code) : '其他'

      const series = computeSeries(bars, TREND_DEFAULTS)
      lastDate = series[series.length - 1].date
      // 流动性门槛：近 20 日均量不足的品种不监控（不提示、不开仓）
      if (!liquidityOk(series, TREND_DEFAULTS, v)) { illiquid += 1; continue }
      lastRows.set(code, series[series.length - 1])
      state.prevClose.set(code, series[series.length - 2]?.c ?? NaN)
      const lv = buildMonitorLevels(series, TREND_DEFAULTS)
      if (lv) levels.set(code, { ...lv, code, name, sector })

      const main = replaySeries(series, { cfg: TREND_DEFAULTS, signalFn: (s, i) => breakoutSignal(s[i], TREND_DEFAULTS), sector })
      for (const t of main.trades) all.push({ code, name, sector, channel: 'main', ...t, exitDate: t.exitDate, exitReason: t.exitReason })
      if (main.pos) all.push({ code, name, sector, channel: 'main', ...main.pos, exitDate: null, exitReason: null })
      const tMain = planVariety(series, { cfg: TREND_DEFAULTS, channel: 'main', sector })
      if (tMain) rawTasks.push({ ...tMain, code, name })

      const seriesR = computeSeries(bars, REBOUND_CONFIG)
      const rb = replaySeries(seriesR, { cfg: REBOUND_CONFIG, signalFn: (s, i) => reboundSignal(s, i, REBOUND_CONFIG), sector })
      for (const t of rb.trades) all.push({ code, name, sector, channel: 'rebound', ...t, exitDate: t.exitDate, exitReason: t.exitReason })
      if (rb.pos) all.push({ code, name, sector, channel: 'rebound', ...rb.pos, exitDate: null, exitReason: null })
      const tR = planVariety(seriesR, { cfg: REBOUND_CONFIG, channel: 'rebound', sector })
      if (tR) rawTasks.push({ ...tR, code, name })
    }

    // 监控起点当天及之前入场的仓位都算历史：重置发生在盘中，当天开盘建的仓也应视为旧仓
    const scoped = state.startDate
      ? all.filter((p) => (p.entryDate || '') > state.startDate)
      : all
    // 监控起点之前仍在持有的仓位数（只用于提示，不参与提醒）
    state.historical = state.startDate
      ? applyPortfolio(all, TREND_DEFAULTS).accepted.filter(
          (p) => (p.exitDate == null || p.exitDate >= (lastDate || '')) && (p.entryDate || '') <= state.startDate,
        ).length
      : 0
    const { accepted } = applyPortfolio(scoped, TREND_DEFAULTS)
    state.positions = accepted
      .filter((p) => p.exitDate === null || p.exitDate === undefined || p.exitDate >= (lastDate || ''))
      // 展示与提醒用「当前」止损位：SAR 会随价格移动，不能停留在建仓价
      .map((p) => {
        // 入场时的止损（定仓与止盈都用它），当前止损单独给出（提醒用）
        const entryStop = p.stopPrice
        const curRow = lastRows.get(p.code)
        const stopPrice = stopLevel(curRow, p, TREND_DEFAULTS)
        // 方向守卫：止损落在价格错误一侧时标记出来（提醒层会立即触发止损）
        const px = Number.isFinite(curRow?.c) && curRow.c > 0 ? curRow.c : NaN
        const stopBreached = Number.isFinite(px) && ((p.dir > 0 && stopPrice >= px) || (p.dir < 0 && stopPrice <= px))
        const { weightPct } = positionWeight(p.entryPrice, entryStop, { riskPct: 0.6, maxWeightPct: 12 })
        const mult = multipliers.contracts[varietyOf(p.code)] || null
        const size = equity > 0 && mult
          ? positionLots({ entryPrice: p.entryPrice, stopPrice: entryStop, equity, riskPct, multiplier: mult })
          : null
        return { ...p, stopPrice, entryStop, weightPct, multiplier: mult, riskPct, lots: size?.lots ?? null, stopBreached, unverified: multipliers.unverified.has(varietyOf(p.code)) }
      })
    state.levels = levels
    state.names = names
    state.illiquid = illiquid
    state.lastDate = lastDate
    // 平仓/反手任务只对「组合层真正持有」的品种出现；开仓任务保留（capped 在计划层）
    const held = new Set(state.positions.map((p) => p.code))
    // 宿主任务与 CLI 同源：都过 buildPlan（并发/板块上限），不再把裸信号当任务
    const openVars = state.positions.map((p) => ({ code: p.code, sector: p.sector, dir: p.dir }))
    const plan = buildPlan(rawTasks, openVars, TREND_DEFAULTS)
    state.tasks = [...plan.closes.filter((t) => held.has(t.code)), ...plan.accepted]
    state.rejectedTasks = plan.rejected
    state.dirty = false
  }

  /** 主入口：每次轮询调用 */
  /** 收盘后（15:15 起、且日线在 15:10 后刷新过）才做「收盘确认」扫描，一天一次 */
  const isMarketOpen = (d = now()) => {
    const wd = d.getDay() // 0=周日 … 6=周六
    const m = d.getHours() * 60 + d.getMinutes()
    const daySession = wd >= 1 && wd <= 5 && ((m >= 9 * 60 && m < 11 * 60 + 30) || (m >= 13 * 60 + 30 && m < 15 * 60))
    const nightHead = wd >= 1 && wd <= 5 && m >= 21 * 60
    const nightTail = wd >= 2 && wd <= 6 && m < 2 * 60 + 30 // 周五夜盘延续到周六凌晨
    return daySession || nightHead || nightTail
  }

  function whyNotConfirmed(row) {
    if (!(row.c > row.hh || row.c < row.ll)) return '收盘收回通道内'
    if (!(row.vr >= TREND_DEFAULTS.volRatio)) return `量比 ${Number(row.vr).toFixed(2)} < ${TREND_DEFAULTS.volRatio}`
    const long = row.c > row.hh
    if (long ? !(row.ma20 > row.ma60) : !(row.ma20 < row.ma60)) return '均线方向不符'
    if (long ? !(row.trix > row.trixSig && row.trix > 0) : !(row.trix < row.trixSig && row.trix < 0)) return 'TRIX 未确认'
    return '条件不满足'
  }

  function confirmSweep(day, ratioOf = () => 1) {
    const confirmed = []
    const noted = new Set(
      state.recent.filter((a) => a.day === day && a.kind === 'trigger').map((a) => a.code),
    )
    const unconfirmed = []
    const accOpen = new Set(
      state.tasks.filter((t) => t.action === 'open' || t.action === 'reverse').map((t) => t.code),
    )
    const rejectMap = new Map((state.rejectedTasks || []).map((t) => [t.code, t.reject]))
    for (const code of codes) {
      const v = varietyOf(code)
      const bars = state.bars[v]
      if (!bars || bars.length < TREND_DEFAULTS.warmup) continue
      const name = catalogByCode?.get?.(code)?.label || catalogByCode?.get?.(code)?.name || v
      // 该品种自己的末根不是今天 → 数据未定稿：不确认，但要显式列出，避免「有任务没确认」的静默分裂
      if (bars[bars.length - 1].date !== day) {
        const hasTask = state.tasks.some((t) => t.code === code && (t.action === 'open' || t.action === 'reverse'))
        if (noted.has(code) || hasTask) {
          unconfirmed.push({ code, name, reason: `日线未定稿（末根 ${bars[bars.length - 1].date}）` })
        }
        continue
      }
      const series = computeSeries(bars, TREND_DEFAULTS)
      if (!liquidityOk(series, TREND_DEFAULTS, v)) continue
      const row = series[series.length - 1]
      const sig = breakoutSignal(row, TREND_DEFAULTS)
      if (sig) {
        const heldNow = state.positions.some((p) => p.code === code)
        let accepted = true
        let reject = null
        if (heldNow && !accOpen.has(code)) {
          accepted = false
          reject = '已持仓，不加仓'
        } else if (!accOpen.has(code)) {
          accepted = false
          reject = rejectMap.get(code) || '未进入明日开仓计划（去重/组合层）'
        }
        const mult = multipliers.contracts[varietyOf(code)] || null
      const r = ratioOf(code)
      // 手数按主连等价价算（加权价 × 比价），与真实成交口径一致
      const estStop = stopLevel(row, { dir: sig, entryPrice: row.c }, TREND_DEFAULTS) * r
      const entryMain = row.c * r
      const size = equity > 0 && mult
        ? positionLots({ entryPrice: entryMain, stopPrice: estStop, equity, riskPct, multiplier: mult })
        : null
      // 明日开盘前先给出可执行的参考三价：开仓参考、止损、2R 止盈
      const risk = Math.abs(entryMain - estStop)
      const tp = sig > 0 ? entryMain + 2 * risk : entryMain - 2 * risk
      const riskYuan = size?.lots && mult ? risk * mult * size.lots : null
      confirmed.push({
        code, name, dir: sig, channel: 'main', close: row.c, closeMain: entryMain, vr: row.vr, multiplier: mult,
        entryRef: entryMain, stop: estStop, tp, risk, riskYuan, estStop, ratio: r, lots: size?.lots ?? null,
        accepted, reject,
      })
      } else if (noted.has(code)) {
        unconfirmed.push({ code, name, reason: whyNotConfirmed(row) })
      }
      // 辅2 反弹开仓不在 trigger 链里，但任务链会开仓，确认清单必须覆盖
      if (!sig) {
        const rbTask = state.tasks.find((t) => t.code === code && t.action === 'open' && t.channel === 'rebound')
        const rbRejected = (state.rejectedTasks || []).find((t) => t.code === code && t.channel === 'rebound')
        if (rbTask || rbRejected) {
          const seriesR = computeSeries(bars, REBOUND_CONFIG)
          const rowR = seriesR[seriesR.length - 1]
          const sigR = reboundSignal(seriesR, seriesR.length - 1, REBOUND_CONFIG)
          if (sigR) {
            const mult = multipliers.contracts[varietyOf(code)] || null
            const r = ratioOf(code)
            const entryMain = rowR.c * r
            const estStop = stopLevel(rowR, { dir: sigR, entryPrice: rowR.c }, REBOUND_CONFIG) * r
            const risk = Math.abs(entryMain - estStop)
            const tp = sigR > 0 ? entryMain + 2 * risk : entryMain - 2 * risk
            const size = equity > 0 && mult
              ? positionLots({ entryPrice: entryMain, stopPrice: estStop, equity, riskPct, multiplier: mult })
              : null
            confirmed.push({
              code, name, dir: sigR, channel: 'rebound', close: rowR.c, closeMain: entryMain, vr: rowR.vr,
              multiplier: mult, entryRef: entryMain, stop: estStop, tp, risk,
              riskYuan: size?.lots && mult ? risk * mult * size.lots : null,
              estStop, ratio: r, lots: size?.lots ?? null, accepted: !!rbTask, reject: rbRejected?.reject ?? null,
            })
          }
        }
      }
    }
    state.confirmed = confirmed
    state.unconfirmed = unconfirmed
    state.confirmDay = day
  }

  async function tick(opts = {}) {
    if (Number.isFinite(Number(opts.equity)) && Number(opts.equity) > 0) equity = Number(opts.equity)
    if (Number.isFinite(Number(opts.riskPct)) && Number(opts.riskPct) > 0) riskPct = Number(opts.riskPct)
    const day = today()
    if (day !== state.seenDay) { state.seen.clear(); state.seenDay = day }

    const stale = now().getTime() - state.updatedAt > REFRESH_MS
    const refreshable = (c) => {
      const v = varietyOf(c)
      return /^[A-Za-z]+$/.test(v) && !['IC', 'IF', 'IH', 'IM', 'T', 'TF', 'TL', 'TS'].includes(v.toUpperCase())
    }
    const missing = codes.some((c) => {
      if (!refreshable(c)) return false // 金融期货不参与日线刷新，别让它们把 missing 永久顶成 true
      const v = varietyOf(c)
      const bars = state.bars[v]
      return !bars || bars[bars.length - 1].date < day
    })
    const triedRecently = now().getTime() - (state.refreshTriedAt || 0) < REFRESH_MS
    // 失败时 updatedAt 不再推进，stale 会一直为真；必须用 triedRecently 兜住，
    // 否则盘中会每个 tick（5 秒）全量重拉 61 个品种
    if (!triedRecently && (stale || missing)) {
      state.refreshTriedAt = now().getTime()
      await refreshDaily()
    }
    if (state.dirty || !state.levels.size) rebuild()

    let quotes = []
    try {
      quotes = await fetchSnapshots(codes)
    } catch (err) {
      state.lastError = String(err?.message || err)
    }
    const byCode = new Map(quotes.map((q) => [q.code, q]))
    const posByCode = new Map(state.positions.map((p) => [p.code, p]))

    // 主连/加权比价：用 前结算 / 加权前收盘 做锚点，把加权价位换算到主连
    const ratioOf = (code) => {
      const q = byCode.get(code)
      const pc = state.prevClose.get(code)
      if (!q || !Number.isFinite(q.prevSettle) || q.prevSettle <= 0 || !Number.isFinite(pc) || pc <= 0) return 1
      const r = q.prevSettle / pc
      return r > 0.8 && r < 1.25 ? r : 1
    }

    // 持仓的手数与展示价统一到主连等价价
    for (const p of state.positions) {
      const r = ratioOf(p.code)
      p.ratio = r
      p.entryMain = p.entryPrice * r
      p.stopMain = Number.isFinite(p.stopPrice) ? p.stopPrice * r : null
      const mult = p.multiplier
      const size = equity > 0 && mult
        ? positionLots({ entryPrice: p.entryMain, stopPrice: p.entryStop * r, equity, riskPct, multiplier: mult })
        : null
      p.lots = size?.lots ?? null
    }

    const alerts = []
    const at = now().getTime()
    // 跨交易日时清掉上一天的待定标记（以「已收盘交易日」为准）
    const target = closedTradingDay(now())
    if (state.confirmPending && state.confirmPendingDay !== target) {
      state.confirmPending = false
      state.confirmPendingDay = null
    }
    // 补做最近一个已收盘交易日的确认；已确认过更晚的交易日就不回退
    if (target && (!state.confirmDay || target > state.confirmDay)) {
      const settledAt = Date.parse(`${target}T15:10:00+08:00`)
      const withBars = codes.filter((c) => {
        if (!refreshable(c)) return false
        const b = state.bars[varietyOf(c)]
        return b && b.length >= TREND_DEFAULTS.warmup
      })
      const settledCount = withBars.filter((c) => {
        const b = state.bars[varietyOf(c)]
        return b[b.length - 1].date === target
      }).length
      const barSettled = state.lastDate === target && Number(state.updatedAt || 0) >= settledAt &&
        withBars.length > 0 && settledCount >= Math.ceil(withBars.length * 0.9)
      if (!barSettled) {
        state.confirmPending = true
        state.confirmPendingDay = target
        state.confirmWindow = null // 数据未定稿，别沿用上一次的窗口文案
      } else {
        state.confirmPending = false
        state.confirmPendingDay = null
        state.confirmWindow = entryWindowText(target, now())
        confirmSweep(target, ratioOf)
        for (const c of state.confirmed) {
          const tail = c.accepted ? '，已过组合约束' : `，不开仓（${c.reject}）`
          const a = {
            id: `${c.code}-confirm-${target}`, kind: 'confirm', code: c.code, name: c.name,
            dir: c.dir > 0 ? 'up' : 'down', price: c.closeMain ?? c.close, at, day: target, level: c.accepted ? 'strong' : 'normal',
            text: `收盘确认：${c.channel === 'rebound' ? '辅2 暴跌反弹' : c.dir > 0 ? '突破 55 日高点' : '跌破 55 日低点'}${tail}；入场：${state.confirmWindow}`,
          }
          const key = `${c.code}|confirm|${target}`
          if (!state.seen.has(key)) {
            state.seen.add(key)
            alerts.push(a)
            state.recent.push(a)
            try {
              journal?.write?.({ at, type: 'trend', kind: 'confirm', code: c.code, name: c.name, dir: a.dir, price: c.closeMain ?? c.close, level: a.level, text: a.text, day: target, dataDate: target, dataAt: state.updatedAt, close: c.close })
            } catch { /* 日志失败不影响提醒 */ }
          }
        }
      }
    }
    for (const code of codes) {
      const lv = state.levels.get(code)
      if (!lv) continue
      const q = byCode.get(code)
      if (!q || !Number.isFinite(q.last) || q.last <= 0) continue
      // 休市/午休时快照价是冻结的：超过 10 分钟没更新就不评估，避免用旧价误报
      if (!Number.isFinite(q.quoteAt) || at - q.quoteAt > 10 * 60 * 1000) continue
        const pos = posByCode.get(code)
        // 价位统一到主连：加权触发位 × 比价，持仓价同比例缩放
        const r = ratioOf(code)
        const lvMain = r === 1 ? lv : { ...lv, triggerUp: lv.triggerUp * r, triggerDown: lv.triggerDown * r }
        const posMain = pos
          ? {
              dir: pos.dir,
              entryPrice: pos.entryPrice * r,
              stopPrice: pos.stopPrice * r,
              initialStop: pos.entryStop * r,
            }
          : null
        const out = evaluateOne({
          code, name: lv.name, levels: lvMain, price: q.last,
          position: posMain,
          seen: state.seen, day, at, monitor: MONITOR_DEFAULTS,
        })
      for (const a of out) {
        alerts.push(a)
        try {
          journal?.write?.({
            at: a.at, type: 'trend', kind: a.kind, code: a.code, name: a.name,
            dir: a.dir, price: a.price, level: a.level, text: a.text,
            triggerPrice: a.triggerPrice ?? null, stopPrice: a.stopPrice ?? null, tpPrice: a.tpPrice ?? null,
            day: a.day,
          })
        } catch { /* 日志失败不影响提醒 */ }
      }
    }
    state.lastAlerts = alerts
    for (const a of alerts) state.recent.push({ at: a.at, kind: a.kind, code: a.code, name: a.name, dir: a.dir, price: a.price, text: a.text, day: a.day })
    if (state.recent.length > 50) state.recent = state.recent.slice(-50)
    return {
      ok: true,
      op: 'trend',
      at,
      date: state.lastDate,
      since: state.startDate,
      state: alerts.length ? 'running' : 'idle',
      open: isMarketOpen(),
      alerts,
      positions: state.positions.map((p) => ({
        code: p.code, name: p.name, sector: p.sector, dir: p.dir, channel: p.channel,
        entryDate: p.entryDate, entryPrice: p.entryPrice, stopPrice: p.stopPrice,
        entryStop: p.entryStop, weightPct: p.weightPct, stopBreached: !!p.stopBreached,
        ratio: p.ratio, entryMain: p.entryMain, stopMain: p.stopMain,
        lots: p.lots ?? null, unverified: !!p.unverified, multiplier: p.multiplier ?? null,
      })),
      illiquid: state.illiquid || 0,
      historical: state.historical || 0,
      tasks: state.tasks || [],
      confirmed: state.confirmed,
      unconfirmed: state.unconfirmed,
      confirmDay: state.confirmDay,
      confirmWindow: state.confirmWindow || null,
      confirmPending: !!state.confirmPending,
      recent: state.recent.slice(-20),
      error: state.lastError,
    }
  }

  load()
  seedSeen()
  seedRecent()
  return { tick, state, file, refreshDaily, rebuild }
}
