/**
 * 趋势策略 · 实时提醒（纯逻辑）
 *
 * 三种提醒：
 *   trigger 已越过触发位（"信号触发"，需收盘确认）
 *   confirm 收盘确认（由运行时在收盘后复核产生）
 *   stop/tp 持仓止损/止盈
 *   stop    持仓触及止损价
 *   tp      持仓达到 2R 止盈
 *
 * 全部按「品种 + 类型 + 交易日」去重，一天只提醒一次，便于写日志复盘。
 */
import { TREND_DEFAULTS } from './trend.js'

export const MONITOR_DEFAULTS = {
  tpR: 2,            // 止盈 = 2R（R = 入场价到止损价的距离）
}

const pct = (x) => (Number.isFinite(x) ? x : NaN)

/** 从日线序列算监控位（触发/预警/止损参考） */
export function buildMonitorLevels(series, cfg = TREND_DEFAULTS) {
  if (!series || series.length < cfg.warmup) return null
  const row = series[series.length - 1]
  if (![row.c, row.ma20, row.ma60, row.hh, row.ll].every(Number.isFinite)) return null
  const close = row.c
  const atrPct = Number.isFinite(row.atrPct) ? row.atrPct : 1.5
  return {
    code: null,
    date: row.date,
    close,
    triggerUp: row.hh,
    triggerDown: row.ll,
    ma20: row.ma20,
    ma60: row.ma60,
    atrPct,
    trix: row.trix,
    trixSig: row.trixSig,
    vr: row.vr,
    // 趋势方向：只有顺势的突破才提示
    trendUp: Number.isFinite(row.ma20) && Number.isFinite(row.ma60) && row.ma20 > row.ma60,
    trendDown: Number.isFinite(row.ma20) && Number.isFinite(row.ma60) && row.ma20 < row.ma60,
  }
}

/** 持仓的止盈价：入场价 ± 2R */
export function takeProfitPrice(pos, monitor = MONITOR_DEFAULTS) {
  // 2R 用「入场时」的止损距离：SAR 收紧后当前止损会越来越近，不能拿来算止盈
  const base = pos && Number.isFinite(pos.initialStop) ? pos.initialStop : pos && pos.stopPrice
  if (!pos || !Number.isFinite(pos.entryPrice) || !Number.isFinite(base)) return NaN
  const risk = Math.abs(pos.entryPrice - base)
  if (!Number.isFinite(risk) || risk <= 0) return NaN
  return pos.dir > 0 ? pos.entryPrice + monitor.tpR * risk : pos.entryPrice - monitor.tpR * risk
}

function dedupeKey(code, kind, day) {
  return `${code}|${kind}|${day}`
}

/**
 * 评估单个品种。
 * @param {object} p
 * @param {string} p.code
 * @param {string} p.name
 * @param {object} p.levels   buildMonitorLevels 的结果
 * @param {number} p.price    最新价
 * @param {object|null} p.position  {dir, entryPrice, stopPrice}
 * @param {Set<string>} p.seen 去重集合（会被写入）
 * @param {string} p.day      交易日 YYYY-MM-DD
 */
export function evaluateOne({ code, name, levels, price, position, seen, day, at, monitor = MONITOR_DEFAULTS }) {
  const alerts = []
  if (!levels || !Number.isFinite(price) || price <= 0) return alerts
  const push = (kind, dir, text, level, extra = {}) => {
    const key = dedupeKey(code, kind, day)
    if (seen.has(key)) return
    seen.add(key)
    alerts.push({
      id: `${code}-${kind}-${day}`,
      kind,
      code,
      name,
      dir,
      price,
      at: at || Date.now(),
      day,
      level,
      text,
      ...extra,
    })
  }

  // ── 持仓：先看止损，再看止盈 ──
  if (position) {
    const { dir, entryPrice, stopPrice } = position
    const tp = takeProfitPrice(position, monitor)
    if (dir > 0 ? price <= stopPrice : price >= stopPrice) {
      push('stop', dir > 0 ? 'down' : 'up',
        `止损 ${stopPrice.toFixed(2)}（入场 ${entryPrice.toFixed(2)}）`, 'strong',
        { stopPrice, entryPrice, dirSign: dir })
    } else if (Number.isFinite(tp) && (dir > 0 ? price >= tp : price <= tp)) {
      const gain = (price / entryPrice - 1) * 100 * dir
      push('tp', dir > 0 ? 'up' : 'down',
        `止盈 ${monitor.tpR}R（${tp.toFixed(2)}），浮动 ${gain >= 0 ? '+' : ''}${gain.toFixed(2)}%`, 'major',
        { tpPrice: tp, entryPrice, dirSign: dir })
    }
    return alerts
  }

  // ── 空仓：突破预警与触发 ──
  const gapUp = ((levels.triggerUp - price) / price) * 100
  const gapDown = ((price - levels.triggerDown) / price) * 100

  if (levels.trendUp) {
    if (gapUp <= 0 && gapUp >= -3) {
      push('trigger', 'up', `触发：突破 55 日高点 ${levels.triggerUp.toFixed(2)}`, 'normal',
        { triggerPrice: levels.triggerUp })
    }
  }

  if (levels.trendDown) {
    if (gapDown <= 0 && gapDown >= -3) {
      push('trigger', 'down', `触发：跌破 55 日低点 ${levels.triggerDown.toFixed(2)}`, 'normal',
        { triggerPrice: levels.triggerDown })
    }
  }

  return alerts
}

/** 批量评估 */
export function evaluateTicks(items, { seen, day, at, monitor = MONITOR_DEFAULTS }) {
  const out = []
  for (const it of items) {
    const a = evaluateOne({ ...it, seen, day, at, monitor })
    if (a.length) out.push(...a)
  }
  return out
}
