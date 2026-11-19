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
  TREND_DEFAULTS, REBOUND_CONFIG, SIZING_PROFILES, entryStopPrice, computeSeries, replaySeries, planVariety, applyPortfolio, buildPlan,
  breakoutSignal, reboundSignal, stopLevel, liquidityOk, positionWeight, positionLots,
} from './trend.js'
import { buildMonitorLevels, evaluateOne, MONITOR_DEFAULTS } from './trend-monitor.js'

const FIELDS = 'f51,f52,f53,f54,f55,f56'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
// 已核对的最小变动价位；未收录品种先按 0.01 兜底，避免输出 12 位小数
const PRICE_TICKS = { AG: 1, AU: 0.02, CU: 10, AL: 5, ZN: 5, SN: 10 }
// 锚点结构变更时递增；旧版本的 ratioAnchor 不再直接信任，由日志重建
const RATIO_ANCHOR_VERSION = 2
const REFRESH_MS = 30 * 60 * 1000 // 收盘定稿/确认挂起时的刷新间隔
const SESSION_REFRESH_MS = 2 * 60 * 60 * 1000 // 盘中（含夜盘）2 小时刷一次
const BREAKER_AFTER = 3 // 连续失败几次后熔断
// 熔断时长：3 次 6 小时，4 次 12 小时，5 次及以上 24 小时
const breakerMs = (n) => (n >= 5 ? 24 * 60 * 60 * 1000 : n === 4 ? 12 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000)
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

/** 合并日线：新数据覆盖同日旧数据，按日期升序。用于增量刷新。 */
export function mergeBars(prev, next) {
  const map = new Map()
  for (const b of prev || []) if (b && b.date) map.set(b.date, b)
  for (const b of next || []) if (b && b.date) map.set(b.date, b)
  return Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}
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

export function createTrendRuntime({ codes, catalogByCode, sectorOf, fetchSnapshots, fetchBars: fetchBarsOpt, now: nowOpt, journal, logger, cacheFile, suppressFile, startFile, manualFile } = {}) {
  const file = cacheFile || defaultTrendCachePath()
  const suppressPath = suppressFile || defaultSuppressPath()
  const startPath = startFile || defaultStartPath()
  const manualPath = manualFile || path.join(path.dirname(file), 'manual-positions.json')
  // 运行态（只放 lastTickAt，避免为它重写 2.5MB 的日线缓存）
  const stateFile = path.join(path.dirname(file), 'runtime-state.json')
  let bootAt = 0
  const fetchBars = fetchBarsOpt || fetchWeighted
  // 可注入时钟：自测固定到 15:20，避免依赖真实时段
  const now = typeof nowOpt === 'function' ? nowOpt : () => new Date()
  const today = () => tradingDayOf(now())
  // 参考价至少保留 2 位，避免日志/面板出现 12 位小数；完整 tick 表后续接入
  const roundPrice = (v, code) => {
    if (!Number.isFinite(v)) return v
    const step = PRICE_TICKS[varietyOf(code)] || 0.01
    return Number((Math.round(v / step) * step).toFixed(4))
  }
  const multipliers = loadMultipliers()
  let equity = 0
  let riskPct = 0.6
  let activeCfg = { ...TREND_DEFAULTS, ...SIZING_PROFILES.C1 }
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
    refreshFailures: 0,   // 连续刷新失败次数（指数退避用）
    pausedUntil: 0,       // 熔断截止时间（连续失败后暂停刷新）
    confirmPending: false, // 已收盘但日线未更新，确认扫描挂起
    confirmPendingDay: null, // 待定所属交易日
    confirmWindow: null, // 最近一次确认对应的入场窗口文案
    historical: 0, // 监控起点之前的历史持仓数（仅展示）
    rejectedTasks: [], // 被组合层拒绝的开仓（给确认卡片标注）
    seen: new Set(),
    seenDay: today(),
    confirmSent: new Set(), // 已推送过的收盘确认，按 code|confirm|day，不随 seen 清空
    ratioAnchor: new Map(), // code|signalDay → 主连/加权比价，首次确认后固化
    ratioJumpLogged: new Set(), // code|settledDay，夜盘比价异常只记一次
    startDate: null,   // 监控起点（早于此日入场的历史仓位不展示）
    confirmDay: null,  // 已完成收盘确认扫描的日期
    confirmed: [],     // 今日收盘确认（明日开盘入场）
    unconfirmed: [],   // 今日提醒过、但收盘未确认的品种及原因
    lastAlerts: [],
    recent: [],
    tasks: [],
    zeroLots: [],        // 信号成立但手数为 0（只提醒，不进入持仓）
    zeroAlerted: new Set(),
    backfilledKeys: new Set(), // 已确认是「补算」的仓位（跨重启保留标记）
    lastTickAt: 0,       // 上次运行 tick 的时间（判断重启后的补算仓位）
    profile: 'C1',       // 定仓方案：C1 默认，C2 观察
    capRejected: [],     // 因组合上限被剔除的仓位
    manual: [],          // 用户手动确认的真实持仓（带买入价）
    manualClosed: [],    // 已平仓的手动持仓，供回顾验证
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
    // 上次运行时间：重启后 entryDate 晚于它的仓位视为「补算」，没有实时提醒
    try {
      const rt = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      state.lastTickAt = Number(rt?.lastTickAt) || 0
      if (Array.isArray(rt?.backfilledKeys)) state.backfilledKeys = new Set(rt.backfilledKeys.slice(-100))
      if (Array.isArray(rt?.confirmSent)) state.confirmSent = new Set(rt.confirmSent.slice(-500))
      if (Number(rt?.ratioAnchorVersion) === RATIO_ANCHOR_VERSION && rt?.ratioAnchor && typeof rt.ratioAnchor === 'object') {
        state.ratioAnchor = new Map(Object.entries(rt.ratioAnchor).slice(-500))
      }
      if (Array.isArray(rt?.ratioJumpLogged)) state.ratioJumpLogged = new Set(rt.ratioJumpLogged.slice(-200))
    } catch { /* 首次运行 */ }
    // 手动确认真实持仓（与策略回放分开，只有用户确认才进入这里）
    try {
      const raw = JSON.parse(fs.readFileSync(manualPath, 'utf8'))
      if (Array.isArray(raw?.positions)) state.manual = raw.positions
      if (Array.isArray(raw?.closed)) state.manualClosed = raw.closed.slice(-100)
    } catch { /* 没有手动持仓文件 */ }
    bootAt = state.lastTickAt || 0
  }

  function saveManual() {
    try {
      fs.mkdirSync(path.dirname(manualPath), { recursive: true })
      fs.writeFileSync(manualPath, JSON.stringify({ positions: state.manual, closed: state.manualClosed.slice(-100) }, null, 2))
    } catch (err) {
      logger?.warn?.(`futures-radar: 手动持仓写入失败 ${String(err)}`)
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ updatedAt: state.updatedAt, bars: state.bars }))
    } catch (err) {
      logger?.warn?.(`futures-radar: 趋势缓存写入失败 ${String(err)}`)
    }
  }

  function persistRuntime() {
    try {
      fs.writeFileSync(stateFile, JSON.stringify({
        lastTickAt: state.lastTickAt,
        backfilledKeys: Array.from(state.backfilledKeys || []).slice(-100),
        confirmSent: Array.from(state.confirmSent || []).slice(-500),
        ratioAnchorVersion: RATIO_ANCHOR_VERSION,
        ratioAnchor: Object.fromEntries(Array.from(state.ratioAnchor || new Map()).slice(-500)),
        ratioJumpLogged: Array.from(state.ratioJumpLogged || []).slice(-200),
      }))
    } catch { /* 运行态写失败不影响主流程 */ }
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
    const ratioSeen = new Set()
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"trend"')) continue
      try {
        const ev = JSON.parse(line)
        if (ev?.kind === 'confirm' && ev.code && ev.day) {
          state.confirmSent.add(`${ev.code}|confirm|${ev.day}`)
          // 新日志有 ratio 字段时以它为准；旧日志没有 ratio，只在缺锚点时用价格反推
          const anchorKey = `${ev.code}|${ev.day}`
          const logRatio = Number(ev.ratio)
          if (logRatio > 0.8 && logRatio < 1.25) {
            state.ratioAnchor.set(anchorKey, logRatio)
            ratioSeen.add(anchorKey)
          } else if (!ratioSeen.has(anchorKey) && !state.ratioAnchor.has(anchorKey) &&
            Number(ev.price) > 0 && Number(ev.close) > 0) {
            const r = Number(ev.price) / Number(ev.close)
            if (r > 0.8 && r < 1.25) {
              state.ratioAnchor.set(anchorKey, r)
              ratioSeen.add(anchorKey)
            }
          }
        }
        if (days.has(ev?.day) && ev.code && ev.kind) state.seen.add(`${ev.code}|${ev.kind}|${ev.day}`)
      } catch {
        /* 坏行跳过 */
      }
    }
    try {
      const raw = JSON.parse(fs.readFileSync(suppressPath, 'utf8'))
      if (raw?.day === today() && Array.isArray(raw.keys)) {
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
    const confirmSeen = new Set()
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
        if (ev.kind === 'confirm') {
          const key = `${ev.code}|${ev.day}`
          if (confirmSeen.has(key)) continue
          confirmSeen.add(key)
        }
        if (ev.kind === 'ratio_jump') continue
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
      const fullBegin = new Date(end)
      fullBegin.setDate(fullBegin.getDate() - 900)
      const targets = codes.filter((c) => {
        const v = varietyOf(c)
        return /^[A-Za-z]+$/.test(v) && !['IC', 'IF', 'IH', 'IM', 'T', 'TF', 'TL', 'TS'].includes(v.toUpperCase())
      })
      let changed = 0
      const queue = targets.slice()
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const worker = async () => {
        while (queue.length) {
          const code = queue.shift()
          const v = varietyOf(code)
          // 增量：已有完整历史时只拉最近 30 天再合并；没有缓存才拉 900 天
          const prev = state.bars[v]
          let begin = fullBegin
          if (prev && prev.length >= TREND_DEFAULTS.warmup) {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(prev[prev.length - 1]?.date || ''))
            if (m) {
              const b = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
              b.setDate(b.getDate() - 30)
              if (b > fullBegin) begin = b
            }
          }
          // 间隔 1–2 秒 + 抖动：东财对并发/请求节奏敏感，宁可慢一点
          await sleep(1000 + Math.random() * 1000)
          try {
            const bars = await fetchBars(v.toLowerCase(), { begin: ymd(begin), end: ymd(end) })
            if (bars && bars.length) {
              if (prev) {
                state.bars[v] = mergeBars(prev, bars)
                changed++
              } else if (bars.length > TREND_DEFAULTS.warmup) {
                state.bars[v] = bars
                changed++
              }
            }
          } catch (err) {
            state.lastError = String(err?.message || err)
          }
        }
      }
      await Promise.all(Array.from({ length: 3 }, worker))
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
    // 先给任务算手数：0 手不占组合名额，让后面的可执行品种补位
    const sizeTask = (t, row, cfg) => {
      const mult = multipliers.contracts[varietyOf(t.code)]
      if (!(equity > 0) || !mult || !t.dir) return { ...t, lots: null }
      const stop = stopLevel(row, { dir: t.dir, entryPrice: row.c }, cfg)
      const size = positionLots({ entryPrice: row.c, stopPrice: stop, equity, riskPct: cfg.riskPct, maxWeightPct: cfg.maxWeightPct, multiplier: mult })
      return { ...t, lots: size?.lots ?? null }
    }
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

      const series = computeSeries(bars, activeCfg)
      lastDate = series[series.length - 1].date
      // 流动性门槛：近 20 日均量不足的品种不监控（不提示、不开仓）
      if (!liquidityOk(series, activeCfg, v)) { illiquid += 1; continue }
      lastRows.set(code, series[series.length - 1])
      state.prevClose.set(code, series[series.length - 2]?.c ?? NaN)
      const lv = buildMonitorLevels(series, activeCfg)
      if (lv) levels.set(code, { ...lv, code, name, sector })

      const main = replaySeries(series, { cfg: activeCfg, signalFn: (s, i) => breakoutSignal(s[i], activeCfg), sector, fromDate: state.startDate })
      for (const t of main.trades) all.push({ code, name, sector, channel: 'main', ...t, exitDate: t.exitDate, exitReason: t.exitReason })
      if (main.pos) all.push({ code, name, sector, channel: 'main', ...main.pos, exitDate: null, exitReason: null })
      const tMain = planVariety(series, { cfg: activeCfg, channel: 'main', sector, fromDate: state.startDate })
      if (tMain) {
        const task = { ...tMain, code, name }
        const sized = sizeTask(task, series[series.length - 1], activeCfg)
        if ((task.action !== 'open' && task.action !== 'reverse') || sized.lots !== 0) rawTasks.push(sized)
      }

      const seriesR = computeSeries(bars, REBOUND_CONFIG)
      const rb = replaySeries(seriesR, { cfg: REBOUND_CONFIG, signalFn: (s, i) => reboundSignal(s, i, REBOUND_CONFIG), sector, fromDate: state.startDate })
      for (const t of rb.trades) all.push({ code, name, sector, channel: 'rebound', ...t, exitDate: t.exitDate, exitReason: t.exitReason })
      if (rb.pos) all.push({ code, name, sector, channel: 'rebound', ...rb.pos, exitDate: null, exitReason: null })
      const tR = planVariety(seriesR, { cfg: REBOUND_CONFIG, channel: 'rebound', sector, fromDate: state.startDate })
      if (tR) {
        const task = { ...tR, code, name }
        const sized = sizeTask(task, seriesR[seriesR.length - 1], REBOUND_CONFIG)
        if ((task.action !== 'open' && task.action !== 'reverse') || sized.lots !== 0) rawTasks.push(sized)
      }
    }

    // 监控起点当天及之前入场的仓位都算历史：重置发生在盘中，当天开盘建的仓也应视为旧仓
    const scoped = state.startDate
      ? all.filter((p) => (p.entryDate || '') > state.startDate)
      : all
    // 监控起点之前仍在持有的仓位数（只用于提示，不参与提醒）
    state.historical = state.startDate
      ? applyPortfolio(all, activeCfg).accepted.filter(
          (p) => (p.exitDate == null || p.exitDate >= (lastDate || '')) && (p.entryDate || '') <= state.startDate,
        ).length
      : 0
    // 本次启动前的最后运行时间：entryDate 晚于它说明是离线期间补算出来的仓位
    const bootDate = bootAt ? ymdOf(new Date(bootAt)) : (state.startDate || '')
    const { accepted } = applyPortfolio(scoped, activeCfg)
    const mapped = accepted
      .filter((p) => p.exitDate === null || p.exitDate === undefined || p.exitDate >= (lastDate || ''))
      // 展示与提醒用「当前」止损位：SAR 会随价格移动，不能停留在建仓价
      .map((p) => {
        // 入场时的止损（定仓与止盈都用它），当前止损单独给出（提醒用）
        const entryStop = p.stopPrice
        const curRow = lastRows.get(p.code)
        const stopPrice = stopLevel(curRow, p, activeCfg)
        // 方向守卫：止损落在价格错误一侧时标记出来（提醒层会立即触发止损）
        const px = Number.isFinite(curRow?.c) && curRow.c > 0 ? curRow.c : NaN
        const stopBreached = Number.isFinite(px) && ((p.dir > 0 && stopPrice >= px) || (p.dir < 0 && stopPrice <= px))
        const { weightPct } = positionWeight(p.entryPrice, entryStop, { riskPct: activeCfg.riskPct, maxWeightPct: activeCfg.maxWeightPct })
        const mult = multipliers.contracts[varietyOf(p.code)] || null
        const size = equity > 0 && mult
          ? positionLots({ entryPrice: p.entryPrice, stopPrice: entryStop, equity, riskPct: activeCfg.riskPct, maxWeightPct: activeCfg.maxWeightPct, multiplier: mult })
          : null
        const backfillKey = `${p.code}|${p.channel || 'main'}|${p.entryDate}`
        const backfilled = !!(bootDate && (p.entryDate || '') > bootDate) || state.backfilledKeys.has(backfillKey)
        if (backfilled) state.backfilledKeys.add(backfillKey)
        return {
          ...p, stopPrice, entryStop, weightPct, multiplier: mult, riskPct: activeCfg.riskPct, lots: size?.lots ?? null,
          stopBreached, unverified: multipliers.unverified.has(varietyOf(p.code)),
          backfilled,
        }
      })
    const nonZero = mapped.filter((p) => p.lots !== 0)
    // 组合上限：按建仓时间从旧到新保留，超出名义/保证金/风险上限时剔除最新仓位
    const limitNotional = equity > 0 ? (equity * activeCfg.maxNotionalPct) / 100 : Infinity
    const limitMargin = equity > 0 ? (equity * activeCfg.maxMarginPct) / 100 : Infinity
    const limitRisk = equity > 0 ? (equity * activeCfg.maxRiskPct) / 100 : Infinity
    const ordered = nonZero.slice().sort((a, b) => ((a.entryDate || '') < (b.entryDate || '') ? -1 : 1))
    const kept = []
    const capRejected = []
    const used = { notional: 0, margin: 0, risk: 0 }
    for (const p of ordered) {
      const lots = Number(p.lots) || 0
      const mult = Number(p.multiplier) || 0
      const notional = lots * Number(p.entryPrice) * mult
      const risk = lots * Math.abs(Number(p.entryPrice) - Number(p.stopPrice)) * mult
      const margin = (notional * (activeCfg.marginRatePct || 10)) / 100
      if (lots > 0 && (used.notional + notional > limitNotional || used.margin + margin > limitMargin || used.risk + risk > limitRisk)) {
        capRejected.push({
          ...p,
          capReason: `组合上限：名义 ${((used.notional + notional) / equity * 100).toFixed(0)}% / 保证金 ${((used.margin + margin) / equity * 100).toFixed(0)}% / 风险 ${((used.risk + risk) / equity * 100).toFixed(1)}%`,
        })
        continue
      }
      kept.push(p)
      used.notional += notional
      used.margin += margin
      used.risk += risk
    }
    state.positions = kept
    state.capRejected = capRejected
    state.zeroLots = mapped
      .filter((p) => p.lots === 0)
      .map((p) => ({ ...p, reason: `仓位上限 ${Number(p.weightPct || 0).toFixed(0)}% 装不下 1 手` }))
    state.levels = levels
    state.names = names
    state.illiquid = illiquid
    state.lastDate = lastDate
    // 平仓/反手任务只对「组合层真正持有」的品种出现；开仓任务保留（capped 在计划层）
    const held = new Set(state.positions.map((p) => p.code))
    // 宿主任务与 CLI 同源：都过 buildPlan（并发/板块上限），不再把裸信号当任务
    const openVars = state.positions.map((p) => ({ code: p.code, sector: p.sector, dir: p.dir }))
    const plan = buildPlan(rawTasks, openVars, activeCfg)
    state.tasks = [...plan.closes.filter((t) => held.has(t.code)), ...plan.accepted]
    state.rejectedTasks = plan.rejected
    state.dirty = false
  }

  /** 主入口：每次轮询调用 */
  /** 收盘后（15:15 起、且日线在 15:10 后刷新过）才做「收盘确认」扫描，一天一次 */
  // 动态刷新间隔：盘中（含夜盘）2 小时；收盘定稿窗口（15:00–18:00）30 分钟；其余 4 小时；
  // 周末不刷；但本交易日的收盘确认还没完成时，周末仍按 4 小时补数据
  const refreshIntervalMs = (d = now()) => {
    // 收盘确认还挂着（数据未定稿）时，保持 30 分钟节奏，尽快补上
    if (state.confirmPending) return REFRESH_MS
    if (isMarketOpen(d)) return SESSION_REFRESH_MS
    const wd = d.getDay()
    const m = d.getHours() * 60 + d.getMinutes()
    if (wd === 0 || wd === 6) {
      return state.confirmDay === closedTradingDay(d) ? Infinity : 4 * 60 * 60 * 1000
    }
    if (m >= 15 * 60 && m <= 18 * 60) return REFRESH_MS
    return 4 * 60 * 60 * 1000
  }
  const backoffMs = (n) => Math.min(REFRESH_MS * Math.pow(2, Math.max(0, n - 1)), 6 * 60 * 60 * 1000)

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
    if (!(row.vr >= activeCfg.volRatio)) return `量比 ${Number(row.vr).toFixed(2)} < ${activeCfg.volRatio}`
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
      const series = computeSeries(bars, activeCfg)
      if (!liquidityOk(series, activeCfg, v)) continue
      const row = series[series.length - 1]
      const sig = breakoutSignal(row, activeCfg)
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
      const r = ratioOf(code, day)
      // 手数按主连等价价算（加权价 × 比价），与真实成交口径一致
      const estStop = roundPrice(stopLevel(row, { dir: sig, entryPrice: row.c }, activeCfg) * r, code)
      const entryMain = roundPrice(row.c * r, code)
      const size = equity > 0 && mult
        ? positionLots({ entryPrice: entryMain, stopPrice: estStop, equity, riskPct: activeCfg.riskPct, maxWeightPct: activeCfg.maxWeightPct, multiplier: mult })
        : null
      if (size && size.lots === 0) { accepted = false; reject = '0 手（当前权益/风险预算不足）' }
      // 明日开盘前先给出可执行的参考三价：开仓参考、止损、2R 止盈
      const risk = Math.abs(entryMain - estStop)
      const tp = roundPrice(sig > 0 ? entryMain + 2 * risk : entryMain - 2 * risk, code)
      const riskYuan = size?.lots && mult ? risk * mult * size.lots : null
      const riskPerLot = mult ? risk * mult : null
      const requiredEquity = riskPerLot && activeCfg.riskPct > 0 ? riskPerLot / (activeCfg.riskPct / 100) : null
      confirmed.push({
        code, name, dir: sig, channel: 'main', close: row.c, closeMain: entryMain, vr: row.vr, multiplier: mult,
        entryRef: entryMain, stop: estStop, tp, risk, riskYuan, estStop, ratio: r, lots: size?.lots ?? null,
        riskPerLot, requiredEquity, riskPct: riskPerLot && equity > 0 ? (riskPerLot / equity) * 100 : null,
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
            const r = ratioOf(code, day)
            const entryMain = roundPrice(rowR.c * r, code)
            const estStop = roundPrice(stopLevel(rowR, { dir: sigR, entryPrice: rowR.c }, REBOUND_CONFIG) * r, code)
            const risk = Math.abs(entryMain - estStop)
            const tp = roundPrice(sigR > 0 ? entryMain + 2 * risk : entryMain - 2 * risk, code)
            const size = equity > 0 && mult
              ? positionLots({ entryPrice: entryMain, stopPrice: estStop, equity, riskPct: activeCfg.riskPct, maxWeightPct: activeCfg.maxWeightPct, multiplier: mult })
              : null
            const riskYuan = size?.lots && mult ? risk * mult * size.lots : null
            const riskPerLot = mult ? risk * mult : null
            const requiredEquity = riskPerLot && activeCfg.riskPct > 0 ? riskPerLot / (activeCfg.riskPct / 100) : null
            confirmed.push({
              code, name, dir: sigR, channel: 'rebound', close: rowR.c, closeMain: entryMain, vr: rowR.vr,
              multiplier: mult, entryRef: entryMain, stop: estStop, tp, risk,
              riskYuan,
              riskPerLot, requiredEquity, riskPct: riskPerLot && equity > 0 ? (riskPerLot / equity) * 100 : null,
              estStop, ratio: r, lots: size?.lots ?? null, accepted: !!rbTask, reject: rbRejected?.reject ?? null,
            })
          }
        }
      }
    }
    // 统一按量比给出观察优先级（rank=1 最强），与组合层排序口径一致
    confirmed.sort((a, b) => (Number(b.vr) || 0) - (Number(a.vr) || 0))
    confirmed.forEach((c, i) => { c.rank = i + 1 })
    state.confirmed = confirmed
    state.unconfirmed = unconfirmed
    state.confirmDay = day
    persistRuntime()
  }

  async function tick(opts = {}) {
    const nextEquity = Number(opts.equity)
    if (Number.isFinite(nextEquity) && nextEquity > 0 && nextEquity !== equity) {
      equity = nextEquity
      state.confirmDay = null // 权益变了，确认手数要重算
      state.dirty = true
    }
    if (Number.isFinite(Number(opts.riskPct)) && Number(opts.riskPct) > 0) riskPct = Number(opts.riskPct)
    if (SIZING_PROFILES[opts.profile] && opts.profile !== state.profile) {
      state.profile = opts.profile
      state.confirmDay = null // 方案变了，确认手数要重算
      state.dirty = true
    }
    const prof = SIZING_PROFILES[state.profile] || SIZING_PROFILES.C1
    activeCfg = { ...TREND_DEFAULTS, ...prof }
    if (Number.isFinite(Number(opts.riskPct)) && Number(opts.riskPct) > 0) activeCfg.riskPct = Number(opts.riskPct)
    const day = today()
    if (day !== state.seenDay) { state.seen.clear(); state.seenDay = day }

    const paused = !!state.pausedUntil && now().getTime() < state.pausedUntil
    const interval = refreshIntervalMs()
    const stale = now().getTime() - state.updatedAt > interval
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
    // 失败后退避：连续失败 1/2/3/4+ 次分别等 30m/1h/2h/4h（上限 6h）
    const waitMs = interval === Infinity ? Infinity : state.refreshFailures ? backoffMs(state.refreshFailures) : interval
    const due = Number.isFinite(waitMs) && now().getTime() - (state.refreshTriedAt || 0) >= waitMs
    if (!paused && due && (stale || missing)) {
      state.refreshTriedAt = now().getTime()
      const before = state.updatedAt
      await refreshDaily()
      if (state.updatedAt !== before) {
        state.refreshFailures = 0
        state.pausedUntil = 0
      } else {
        state.refreshFailures = (state.refreshFailures || 0) + 1
        if (state.refreshFailures >= BREAKER_AFTER) {
          state.pausedUntil = now().getTime() + breakerMs(state.refreshFailures)
        }
      }
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
    const ratioOf = (code, day) => {
      // 收盘确认的比价必须固化在「信号日」：夜盘 tick 的前结算会跳变，
      // 同一批确认重扫时不能再用新 tick 重算历史价。
      const anchorKey = day ? `${code}|${day}` : null
      if (anchorKey && state.ratioAnchor.has(anchorKey)) return state.ratioAnchor.get(anchorKey)
      const q = byCode.get(code)
      const pc = state.prevClose.get(code)
      if (!q || !Number.isFinite(q.prevSettle) || q.prevSettle <= 0 || !Number.isFinite(pc) || pc <= 0) return 1
      const r = q.prevSettle / pc
      const valid = r > 0.8 && r < 1.25
      if (valid && anchorKey) {
        if (state.ratioAnchor.size >= 500) state.ratioAnchor.clear()
        state.ratioAnchor.set(anchorKey, r)
      }
      return valid ? r : 1
    }

    // 已收盘锚点：15:15–21:00 用当前前结算抓一次，夜盘实时触发/持仓沿用，
    // 避免 21:00 前结算字段跳变把历史价位整体平移；白天恢复当前比价。
    const settledDay = closedTradingDay(now())
    const localMinutes = now().getHours() * 60 + now().getMinutes()
    if (localMinutes >= 15 * 60 + 15 && localMinutes < 21 * 60) {
      for (const code of codes) ratioOf(code, settledDay)
    }
    const night = localMinutes >= 21 * 60 || localMinutes < 3 * 60
    const liveRatioOf = (code) => {
      if (!night) return ratioOf(code)
      const key = `${code}|${settledDay}`
      const anchor = state.ratioAnchor.get(key)
      if (!Number.isFinite(anchor)) return ratioOf(code)
      const current = ratioOf(code)
      if (Math.abs(current / anchor - 1) > 0.01 && !state.ratioJumpLogged.has(key)) {
        state.ratioJumpLogged.add(key)
        try {
          journal?.write?.({
            at: now().getTime(), type: 'trend', kind: 'ratio_jump', code, day: settledDay,
            ratio: current, anchor, text: `夜盘比价 ${current.toFixed(4)} vs 已收盘锚点 ${anchor.toFixed(4)}`,
          })
        } catch { /* 日志失败不影响提醒 */ }
      }
      return anchor
    }

    // 持仓的手数与展示价统一到主连等价价
    for (const p of state.positions) {
      const r = liveRatioOf(p.code)
      p.ratio = r
      p.entryMain = p.entryPrice * r
      p.stopMain = Number.isFinite(p.stopPrice) ? p.stopPrice * r : null
      const mult = p.multiplier
      const size = equity > 0 && mult
        ? positionLots({ entryPrice: p.entryMain, stopPrice: p.entryStop * r, equity, riskPct: activeCfg.riskPct, maxWeightPct: activeCfg.maxWeightPct, multiplier: mult })
        : null
      p.lots = size?.lots ?? null
    }

    const alerts = []
    const at = now().getTime()
    state.lastTickAt = at
    persistRuntime()
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
          const sentBefore = state.confirmSent.has(key)
          if (!sentBefore) state.confirmSent.add(key)
          if (!sentBefore && !state.seen.has(key)) {
            state.seen.add(key)
            alerts.push(a)
            state.recent.push(a)
            try {
              journal?.write?.({ at, type: 'trend', kind: 'confirm', code: c.code, name: c.name, dir: a.dir, price: c.closeMain ?? c.close, level: a.level, text: a.text, day: target, dataDate: target, dataAt: state.updatedAt, close: c.close, ratio: c.ratio })
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
        const r = liveRatioOf(code)
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
    // 0 手信号：只提醒，不进入持仓
    for (const z of state.zeroLots || []) {
      const key = `${z.code}|${z.entryDate}`
      if (state.zeroAlerted.has(key)) continue
      state.zeroAlerted.add(key)
      const a = {
        id: `${z.code}-zero-${z.entryDate}`, kind: 'zero-lot', code: z.code, name: z.name,
        dir: z.dir > 0 ? 'up' : 'down', price: z.entryPrice, at, day: today(), level: 'normal',
        text: `0 手信号：${z.channel === 'rebound' ? '辅2 暴跌反弹' : z.dir > 0 ? '突破 55 日高点' : '跌破 55 日低点'} ${z.entryDate}，${z.reason}，未开仓${z.backfilled ? '（补算）' : ''}`,
      }
      alerts.push(a)
      state.recent.push(a)
      try {
        journal?.write?.({ at, type: 'trend', kind: 'zero-lot', code: z.code, name: z.name, dir: a.dir, price: z.entryPrice, level: 'normal', text: a.text, day: a.day })
      } catch { /* 日志失败不影响提醒 */ }
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
      positions: state.manual.map((p) => {
        const distPct = Math.abs(p.entryPrice - p.stopPrice) / p.entryPrice * 100
        const weightPct = distPct > 0 ? Math.min((activeCfg.riskPct / distPct) * 100, activeCfg.maxWeightPct) : 0
        return {
          ...p, manual: true, channel: 'manual',
          entryMain: p.entryPrice, stopMain: p.stopPrice, weightPct,
          backfilled: false, stopBreached: false,
        }
      }),
      // 策略回放仓（不直接展示；只有用户手动确认的仓位才进入 positions）
      autoPositions: state.positions.map((p) => ({
        code: p.code, name: p.name, sector: p.sector, dir: p.dir, channel: p.channel,
        entryDate: p.entryDate, entryPrice: p.entryPrice, stopPrice: p.stopPrice,
        entryStop: p.entryStop, weightPct: p.weightPct, stopBreached: !!p.stopBreached,
        ratio: p.ratio, entryMain: p.entryMain, stopMain: p.stopMain,
        lots: p.lots ?? null, unverified: !!p.unverified, multiplier: p.multiplier ?? null,
        backfilled: !!p.backfilled,
      })),
      closedManual: (state.manualClosed || []).slice(-20).map((p) => ({
        id: p.id, code: p.code, name: p.name, dir: p.dir, entryDate: p.entryDate,
        entryPrice: p.entryPrice, exitDate: p.exitDate, exitPrice: p.exitPrice,
        lots: p.lots, pnlPct: p.pnlPct,
      })),
      zeroLots: (state.zeroLots || []).map((p) => ({
        code: p.code, name: p.name, sector: p.sector, dir: p.dir, channel: p.channel,
        entryDate: p.entryDate, entryPrice: p.entryPrice, stopPrice: p.stopPrice,
        weightPct: p.weightPct, lots: 0, reason: p.reason, backfilled: !!p.backfilled,
      })),
      illiquid: state.illiquid || 0,
      historical: state.historical || 0,
      tasks: state.tasks || [],
      confirmed: state.confirmed,
      unconfirmed: state.unconfirmed,
      confirmDay: state.confirmDay,
      confirmWindow: state.confirmWindow || null,
      confirmPending: !!state.confirmPending,
      equity,
      profile: state.profile,
      profileLabel: (SIZING_PROFILES[state.profile] || SIZING_PROFILES.C1).label,
      profiles: Object.values(SIZING_PROFILES).map((p) => ({
        key: p.key, label: p.label, riskPct: p.riskPct, maxWeightPct: p.maxWeightPct,
        maxNotionalPct: p.maxNotionalPct, maxMarginPct: p.maxMarginPct, maxRiskPct: p.maxRiskPct,
      })),
      capRejected: (state.capRejected || []).map((p) => ({
        code: p.code, name: p.name, dir: p.dir, entryDate: p.entryDate, lots: p.lots,
        entryPrice: p.entryPrice, reason: p.capReason,
      })),
      refreshFailures: state.refreshFailures || 0,
      refreshPausedUntil: state.pausedUntil || null,
      recent: state.recent.slice(-20),
      error: state.lastError,
    }
  }

  /** 用户手动确认一笔真实持仓：只有这里写入的仓位才会进入「当前持仓」 */
  function manualOpen(input = {}) {
    const code = String(input.code || '').toUpperCase()
    const dir = Number(input.dir)
    const entryPrice = Number(input.entryPrice)
    const stopPrice = Number(input.stop)
    const lots = Math.floor(Number(input.lots))
    if (!code || ![1, -1].includes(dir)) return { ok: false, error: '品种或方向无效' }
    if (!(entryPrice > 0) || !(stopPrice > 0)) return { ok: false, error: '买入价/止损价无效' }
    if ((dir > 0 && stopPrice >= entryPrice) || (dir < 0 && stopPrice <= entryPrice)) return { ok: false, error: '止损方向错误' }
    if (!(lots > 0)) return { ok: false, error: '手数必须大于 0' }
    if (state.manual.some((p) => p.code === code)) return { ok: false, error: `${code} 已有手动持仓` }
    const mult = multipliers.contracts[varietyOf(code)]
    if (!mult) return { ok: false, error: '缺少合约乘数' }
    const name = input.name || catalogByCode?.get?.(code)?.label || catalogByCode?.get?.(code)?.name || code
    const position = {
      id: `${code}-${now().getTime()}`,
      code, name, dir, entryDate: today(), entryPrice, stopPrice, lots, multiplier: mult,
      channel: 'manual', manual: true, sector: sectorOf ? sectorOf(code) : '其他',
      entryMain: entryPrice, stopMain: stopPrice, createdAt: now().getTime(),
    }
    state.manual.push(position)
    saveManual()
    return { ok: true, position }
  }

  /** 手动平仓：记录真实出场价，写入 closed 供回顾 */
  function manualClose(input = {}) {
    const id = String(input.id || '')
    const exitPrice = Number(input.exitPrice)
    const idx = state.manual.findIndex((p) => p.id === id)
    if (idx < 0) return { ok: false, error: '找不到该手动持仓' }
    if (!(exitPrice > 0)) return { ok: false, error: '平仓价无效' }
    const [p] = state.manual.splice(idx, 1)
    const pnlPct = ((exitPrice / p.entryPrice) - 1) * 100 * p.dir
    const closed = { ...p, exitDate: today(), exitPrice, pnlPct, closedAt: now().getTime() }
    state.manualClosed.push(closed)
    state.manualClosed = state.manualClosed.slice(-100)
    saveManual()
    return { ok: true, closed }
  }

  load()
  seedSeen()
  seedRecent()
  return { tick, state, file, refreshDaily, rebuild, manualOpen, manualClose }
}
