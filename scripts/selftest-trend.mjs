#!/usr/bin/env node
/**
 * 趋势策略 · 纯逻辑自测
 *
 * 覆盖：指标口径、突破/反弹信号、止损（盘中/跳空）、均线与 TRIX 出场、
 *       状态机（次日开盘入场）、任务生成（开/平/反手/已止损）、
 *       组合层（量比排序、板块上限、并发上限、反手释放名额）。
 */
import assert from 'node:assert'
import {
  TREND_DEFAULTS, REBOUND_CONFIG, computeSeries, breakoutSignal, reboundSignal,
  stopHit, closeExit, replaySeries, planVariety, buildPlan, ema,
  sarSeries, stopLevel, positionWeight, positionLots, avgVolume, liquidityOk,
} from '../trend.js'

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`      ${err?.message || err}`)
  }
}

function day(i) {
  const d = new Date(Date.UTC(2020, 0, 1))
  d.setUTCDate(d.getUTCDate() + i)
  return d.toISOString().slice(0, 10)
}

/** 用收盘价数组造 OHLCV（open=前一日收盘，避免缺口干扰） */
function mkBars(closes, { vol = 1000, spread = 0.15 } = {}) {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]
    const v = Array.isArray(vol) ? vol[i] : vol
    return { date: day(i), o, c, h: Math.max(o, c) + spread, l: Math.min(o, c) - spread, v }
  })
}

/** 全部 1000，最后一根放量到 3000 */
function spikeVol(n) {
  const arr = new Array(n).fill(1000)
  arr[n - 1] = 3000
  return arr
}

/** 加速上涨：保证 TRIX > 信号线 */
function risingSeries(n = 120, base = 100, speed = 0.25, accel = 0.006) {
  const closes = []
  for (let i = 0; i < n; i++) closes.push(base + speed * i + accel * i * i)
  return closes
}

test('ema 收敛到常数', () => {
  const out = ema(new Array(200).fill(50), 12)
  assert.ok(Math.abs(out[out.length - 1] - 50) < 1e-9)
})

test('computeSeries：常数序列的均线与量比', () => {
  const bars = mkBars(new Array(100).fill(100), { vol: 500 })
  const s = computeSeries(bars, TREND_DEFAULTS)
  const last = s[s.length - 1]
  assert.ok(Math.abs(last.ma20 - 100) < 1e-6, `ma20=${last.ma20}`)
  assert.ok(Math.abs(last.ma60 - 100) < 1e-6)
  assert.ok(Math.abs(last.vr - 1) < 1e-6, `vr=${last.vr}`)
})

test('computeSeries：hh/ll 为前 N 根极值（不含当前）', () => {
  const bars = mkBars(new Array(80).fill(100))
  bars[79] = { ...bars[79], c: 130, h: 131 }
  const s = computeSeries(bars, TREND_DEFAULTS)
  const last = s[s.length - 1]
  assert.ok(last.hh < 130, 'hh 不应包含当前 bar')
  assert.ok(Math.abs(last.hh - 100.15) < 1e-6, `hh=${last.hh}`)
})

test('breakoutSignal：加速上涨 + 放量触发做多', () => {
  const closes = risingSeries()
  const s = computeSeries(mkBars(closes, { vol: spikeVol(closes.length) }), TREND_DEFAULTS)
  assert.equal(breakoutSignal(s[s.length - 1], TREND_DEFAULTS), 1)
})

test('breakoutSignal：加速下跌 + 放量触发做空', () => {
  const closes = risingSeries().map((v) => 240 - v)
  const s = computeSeries(mkBars(closes, { vol: spikeVol(closes.length) }), TREND_DEFAULTS)
  assert.equal(breakoutSignal(s[s.length - 1], TREND_DEFAULTS), -1)
})

test('breakoutSignal：横盘不触发', () => {
  const s = computeSeries(mkBars(new Array(120).fill(100)), TREND_DEFAULTS)
  assert.equal(breakoutSignal(s[s.length - 1], TREND_DEFAULTS), 0)
})

test('stopHit：盘中触及与跳空穿价', () => {
  const pos = { dir: 1, entryPrice: 100, stopPrice: 95 }
  assert.equal(stopHit({ o: 96, h: 97, l: 94, c: 96 }, pos), 'touch')
  assert.equal(stopHit({ o: 93, h: 95, l: 92, c: 94 }, pos), 'gap')
  assert.equal(stopHit({ o: 96, h: 97, l: 95.5, c: 96 }, pos), false)
  const short = { dir: -1, entryPrice: 100, stopPrice: 105 }
  assert.equal(stopHit({ o: 104, h: 106, l: 103, c: 104 }, short), 'touch')
  assert.equal(stopHit({ o: 107, h: 108, l: 106, c: 107 }, short), 'gap')
})

test('closeExit：跌破均线与 TRIX 反向', () => {
  const cfg = { ...TREND_DEFAULTS, exitMa: 20 }
  assert.equal(closeExit({ c: 98, ma10: 99, ma20: 100, trix: 1, trixSig: 2 }, { dir: 1 }, cfg), 'ma')
  assert.equal(closeExit({ c: 102, ma10: 101, ma20: 100, trix: 1, trixSig: 2 }, { dir: 1 }, cfg), 'trix')
  assert.equal(closeExit({ c: 102, ma10: 101, ma20: 100, trix: 3, trixSig: 2 }, { dir: 1 }, cfg), false)
})

test('replaySeries：信号次日开盘入场', () => {
  const s = computeSeries(mkBars(risingSeries()), TREND_DEFAULTS)
  const fireAt = 100
  const { trades, pos } = replaySeries(s, { cfg: TREND_DEFAULTS, signalFn: (_s, i) => (i === fireAt ? 1 : 0) })
  assert.ok(pos, '应持有仓位')
  assert.equal(pos.entryIndex, fireAt + 1)
  assert.ok(Math.abs(pos.entryPrice - s[fireAt + 1].o) < 1e-9)
  assert.equal(trades.length, 0)
})

test('replaySeries：盘中止损按止损价成交', () => {
  const closes = risingSeries(130)
  const s = computeSeries(mkBars(closes), TREND_DEFAULTS)
  const fireAt = 100
  // 在信号后第 3 根制造一根长下影，触发止损
  s[fireAt + 3] = { ...s[fireAt + 3], l: s[fireAt + 2].l - 50, c: s[fireAt + 2].c }
  const { trades } = replaySeries(s, { cfg: TREND_DEFAULTS, signalFn: (_s, i) => (i === fireAt ? 1 : 0) })
  assert.equal(trades.length, 1)
  assert.equal(trades[0].exitReason, 'stop')
})

test('replaySeries：持有到期强制平仓（非最后一根）', () => {
  const s = computeSeries(mkBars(risingSeries(200)), TREND_DEFAULTS)
  const { trades } = replaySeries(s, { cfg: { ...TREND_DEFAULTS, holdDays: 5 }, signalFn: (_s, i) => (i === 100 ? 1 : 0) })
  assert.equal(trades.length, 1)
  assert.equal(trades[0].exitReason, 'hold')
})

test('planVariety：无仓 + 最后一根信号 → 开仓', () => {
  const s = computeSeries(mkBars(risingSeries()), TREND_DEFAULTS)
  const task = planVariety(s, {
    cfg: TREND_DEFAULTS, channel: 'main', sector: '黑色',
    signalFn: (_s, i) => (i === s.length - 1 ? 1 : 0),
  })
  assert.equal(task.action, 'open')
  assert.equal(task.dir, 1)
  assert.equal(task.sector, '黑色')
})

test('planVariety：最后一根跌破均线 → 平仓任务', () => {
  const n = 140
  const closes = risingSeries(n)
  // 最后 40 根拉平，让 MA20 贴近现价，再用 1% 的跌幅跌破 MA20（不触发 5% 止损）
  const flat = closes[n - 41]
  for (let i = n - 40; i < n; i++) closes[i] = flat
  closes[n - 1] = flat * 0.99
  const s = computeSeries(mkBars(closes), TREND_DEFAULTS)
  const fireAt = n - 2
  const last = s[n - 1]
  assert.ok(last.c < last.ma20, `构造失败 c=${last.c} ma20=${last.ma20}`)
  const task = planVariety(s, {
    // 这个用例只验证「收盘跌破均线 → 平仓任务」，止损位固定成 5%，不让 SAR 提前触发
    cfg: { ...TREND_DEFAULTS, dedupeDays: 0, stopMode: 'fixed' }, channel: 'main', sector: '能化',
    signalFn: (_s, i) => (i === fireAt ? 1 : 0),
  })
  assert.ok(task, '应产出任务')
  assert.equal(task.action, 'close')
  assert.equal(task.dir, 1)
})

test('planVariety：持仓 + 反向信号 → 反手', () => {
  const s = computeSeries(mkBars(risingSeries()), TREND_DEFAULTS)
  const last = s.length - 1
  const task = planVariety(s, {
    cfg: { ...TREND_DEFAULTS, dedupeDays: 0 }, channel: 'main', sector: '有色',
    signalFn: (_s, i) => (i === 100 ? 1 : i === last ? -1 : 0),
  })
  assert.ok(task, '应产出任务')
  assert.equal(task.action, 'reverse')
  assert.equal(task.from, 1)
  assert.equal(task.dir, -1)
})

test('sarSeries：上涨序列里 SAR 始终低于价格', () => {
  const closes = risingSeries(120)
  const bars = mkBars(closes)
  const h = bars.map((b) => b.h)
  const l = bars.map((b) => b.l)
  const sar = sarSeries(h, l, 0.02, 0.2)
  for (let i = 5; i < sar.length; i++) {
    assert.ok(Number.isFinite(sar[i]), `第 ${i} 根 SAR 应有限`)
    assert.ok(sar[i] < closes[i] + 1e-9, `第 ${i} 根 SAR 应低于价格`)
  }
})

test('sarSeries 无前视：第 i 根的高低点不得影响第 i 根 SAR', () => {
  const bars = mkBars(risingSeries(120))
  const h = bars.map((b) => b.h)
  const l = bars.map((b) => b.l)
  const base = sarSeries(h, l)
  const i = 90
  const h2 = h.slice()
  const l2 = l.slice()
  h2[i] = h[i] * 1.3   // 把第 i 根拉成巨幅震荡
  l2[i] = l[i] * 0.7
  const pert = sarSeries(h2, l2)
  assert.equal(pert[i], base[i], '第 i 根 SAR 不能依赖第 i 根自身 high/low')
  assert.notEqual(pert[i + 1], base[i + 1], '第 i+1 根应受第 i 根影响')
})

test('sarSeries：不重绘（第 i 根只依赖前 i 根）', () => {
  const bars = mkBars(risingSeries(120).map((v, i) => v + (i % 7 === 0 ? 3 : 0)))
  const h = bars.map((b) => b.h)
  const l = bars.map((b) => b.l)
  const full = sarSeries(h, l, 0.02, 0.2)
  // 截断到 80 根后重算，前 80 个值必须完全一致
  const cut = sarSeries(h.slice(0, 80), l.slice(0, 80), 0.02, 0.2)
  for (let i = 1; i < 80; i++) {
    if (Number.isNaN(full[i]) && Number.isNaN(cut[i])) continue
    assert.ok(Math.abs(full[i] - cut[i]) < 1e-9, `第 ${i} 根被后续数据影响`)
  }
})

test('stopLevel：sar_floor 取 SAR 与 5% 底线中更靠近价格的那个', () => {
  const pos = { dir: 1, entryPrice: 100 }
  assert.equal(stopLevel({ sar: 97 }, pos, { ...TREND_DEFAULTS, stopMode: 'sar_floor' }), 97)
  assert.equal(stopLevel({ sar: 80 }, pos, { ...TREND_DEFAULTS, stopMode: 'sar_floor' }), 95)
  assert.equal(stopLevel({ sar: 97 }, pos, { ...TREND_DEFAULTS, stopMode: 'fixed' }), 95)
  const short = { dir: -1, entryPrice: 100 }
  assert.equal(stopLevel({ sar: 103 }, short, { ...TREND_DEFAULTS, stopMode: 'sar_floor' }), 103)
  assert.equal(stopLevel({ sar: 120 }, short, { ...TREND_DEFAULTS, stopMode: 'sar_floor' }), 105)
})

test('positionWeight：按止损距离定仓，单笔风险固定 0.6%，上限 12%', () => {
  const a = positionWeight(100, 95)   // 距离 5% → 12%
  assert.ok(Math.abs(a.distPct - 5) < 1e-9)
  assert.ok(Math.abs(a.weightPct - 12) < 1e-9)
  const b = positionWeight(100, 97)   // 距离 3% → 20%，被 12% 截断
  assert.ok(Math.abs(b.weightPct - 12) < 1e-9)
  const c = positionWeight(100, 90, { riskPct: 0.6, maxWeightPct: 40 }) // 距离 10% → 6%
  assert.ok(Math.abs(c.weightPct - 6) < 1e-9)
})

test('positionLots：按权益与止损距离算手数', () => {
  // 100 万权益、止损距离 5%、乘数 10：权重 12% → 12 万名义 → 120 手，风险 6000 元 = 0.6%
  const a = positionLots({ entryPrice: 100, stopPrice: 95, equity: 1000000, multiplier: 10 })
  assert.equal(a.weightPct, 12)
  assert.equal(a.lots, 120)
  assert.equal(a.riskAmount, 6000)
  // 距离 2%：理论 30%，被 12% 上限压住 → 实际风险 0.24%
  const b = positionLots({ entryPrice: 100, stopPrice: 98, equity: 1000000, multiplier: 10 })
  assert.equal(b.weightPct, 12)
  assert.equal(b.lots, 120)
  assert.equal(b.riskAmount, 2400)
  // 距离 10%：权重 6% → 6 万名义 → 60 手，风险仍是 6000
  const c = positionLots({ entryPrice: 100, stopPrice: 90, equity: 1000000, multiplier: 10 })
  assert.equal(c.weightPct, 6)
  assert.equal(c.lots, 60)
  assert.equal(c.riskAmount, 6000)
  // 参数缺失 → null
  assert.equal(positionLots({ entryPrice: 100, stopPrice: 95, equity: 0, multiplier: 10 }), null)
  assert.equal(positionLots({ entryPrice: 100, stopPrice: 95, equity: 1000000 }), null)
})

test('stopHit：sar_floor 下盘中跌破 SAR 即触发', () => {
  const pos = { dir: 1, entryPrice: 100, stopPrice: 95 }
  const cfg = { ...TREND_DEFAULTS, stopMode: 'sar_floor' }
  assert.equal(stopHit({ o: 99, h: 100, l: 97.5, sar: 98 }, pos, cfg), 'touch')
  assert.equal(stopHit({ o: 97, h: 99, l: 96, sar: 98 }, pos, cfg), 'gap')
  assert.equal(stopHit({ o: 99, h: 100, l: 98.5, sar: 98 }, pos, cfg), false)
})

test('liquidityOk：均量门槛与 volAllow 豁免', () => {
  const bars = mkBars(risingSeries(60), { vol: 800 })
  const s = computeSeries(bars, TREND_DEFAULTS)
  assert.ok(Math.abs(avgVolume(s, 20) - 800) < 1e-9)
  assert.equal(liquidityOk(s, { ...TREND_DEFAULTS, minVol20: 5000 }, 'RB'), false)
  assert.equal(liquidityOk(s, { ...TREND_DEFAULTS, minVol20: 5000 }, 'EC'), true, 'EC 必须豁免')
  assert.equal(liquidityOk(s, { ...TREND_DEFAULTS, minVol20: 100 }, 'RB'), true)
  assert.equal(liquidityOk(s, { ...TREND_DEFAULTS, minVol20: 0 }, 'RB'), true, '0 表示不启用')
})

test('planVariety：最后一根盘中止损 → stopped', () => {
  const s = computeSeries(mkBars(risingSeries()), TREND_DEFAULTS)
  const fireAt = 100
  const last = s.length - 1
  const stop = s[fireAt + 1].o * 0.95
  s[last] = { ...s[last], l: stop - 5, c: stop + 1, o: s[last].o }
  const task = planVariety(s, {
    cfg: TREND_DEFAULTS, channel: 'main', sector: '农产品',
    signalFn: (_s, i) => (i === fireAt ? 1 : 0),
  })
  assert.equal(task.action, 'stopped')
})

test('buildPlan：按量比降序，板块上限 2', () => {
  const tasks = [
    { code: 'RB0', name: '螺纹', action: 'open', dir: 1, sector: '黑色', vr: 1.5 },
    { code: 'HC0', name: '热卷', action: 'open', dir: 1, sector: '黑色', vr: 2.5 },
    { code: 'I0', name: '铁矿', action: 'open', dir: 1, sector: '黑色', vr: 3.5 },
    { code: 'M0', name: '豆粕', action: 'open', dir: 1, sector: '农产品', vr: 1.1 },
  ]
  const plan = buildPlan(tasks, [], { ...TREND_DEFAULTS, maxPositions: 8, maxSector: 2 })
  const codes = plan.accepted.map((t) => t.code)
  assert.deepEqual(codes, ['I0', 'HC0', 'M0'], `accepted=${codes}`)
  assert.equal(plan.rejected.length, 1)
  assert.equal(plan.rejected[0].code, 'RB0')
  assert.ok(/板块/.test(plan.rejected[0].reject))
})

test('buildPlan：并发上限生效', () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    code: `X${i}`, name: `X${i}`, action: 'open', dir: 1, sector: `S${i}`, vr: 1 + i * 0.1,
  }))
  const plan = buildPlan(tasks, [], { ...TREND_DEFAULTS, maxPositions: 3, maxSector: 2 })
  assert.equal(plan.accepted.length, 3)
  assert.equal(plan.rejected.length, 2)
  assert.ok(plan.rejected.every((t) => /并发/.test(t.reject)))
})

test('buildPlan：反手释放原仓位名额', () => {
  const open = [{ code: 'RB0', sector: '黑色', dir: 1 }]
  const tasks = [
    { code: 'RB0', name: '螺纹', action: 'reverse', dir: -1, from: 1, sector: '黑色', vr: 2 },
    { code: 'I0', name: '铁矿', action: 'open', dir: 1, sector: '黑色', vr: 1.5 },
  ]
  const plan = buildPlan(tasks, open, { ...TREND_DEFAULTS, maxPositions: 1, maxSector: 1 })
  assert.equal(plan.accepted.length, 1)
  assert.equal(plan.accepted[0].code, 'RB0')
  assert.equal(plan.rejected[0].code, 'I0')
})

test('buildPlan：平仓任务不受上限影响', () => {
  const open = [
    { code: 'A', sector: 'S', dir: 1 }, { code: 'B', sector: 'S', dir: 1 },
  ]
  const tasks = [
    { code: 'A', name: 'A', action: 'close', dir: 1, sector: 'S' },
    { code: 'C', name: 'C', action: 'open', dir: 1, sector: 'T', vr: 1.3 },
  ]
  const plan = buildPlan(tasks, open, { ...TREND_DEFAULTS, maxPositions: 2, maxSector: 2 })
  assert.equal(plan.closes.length, 1)
  assert.equal(plan.accepted.length, 1)
})

test('reboundSignal：暴跌后上穿 MA10 才触发', () => {
  const closes = []
  for (let i = 0; i < 60; i++) closes.push(100)   // 60 根平在 100
  for (let i = 0; i < 10; i++) closes.push(100 - (i + 1) * 2) // 10 根跌到 80（-20%）
  for (let i = 0; i < 10; i++) closes.push(80)    // 10 根横盘
  closes.push(80.8)                               // 最后一根上穿 MA10
  const s = computeSeries(mkBars(closes), REBOUND_CONFIG)
  assert.equal(reboundSignal(s, s.length - 1, REBOUND_CONFIG), 1, '最后一根应触发辅2')
  // 同结构但最后一根不涨 → 不触发
  const s2 = computeSeries(mkBars([...closes.slice(0, -1), 79.6]), REBOUND_CONFIG)
  assert.equal(reboundSignal(s2, s2.length - 1, REBOUND_CONFIG), 0)
})

console.log('')
console.log(`  趋势策略自测：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
