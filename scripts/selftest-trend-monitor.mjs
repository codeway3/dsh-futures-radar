#!/usr/bin/env node
/**
 * 趋势提醒 · 自测
 *
 * 覆盖：监控位计算、预警带宽、临近/触发/止损/止盈四类提醒、
 *       方向过滤、按日去重、2R 止盈价，以及 runtime 的端到端拼装（mock 快照）。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TREND_DEFAULTS, computeSeries } from '../trend.js'
import { tradingDayOf, entryWindowText, mergeBars } from '../trend-runtime.js'
import {
  buildMonitorLevels, takeProfitPrice, evaluateOne, evaluateTicks, MONITOR_DEFAULTS,
} from '../trend-monitor.js'

let pass = 0
let fail = 0
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err?.message || err}`) }
}

async function testAsync(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) } catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err?.message || err}`) }
}

function day(i) {
  const d = new Date(Date.UTC(2020, 0, 1))
  d.setUTCDate(d.getUTCDate() + i)
  return d.toISOString().slice(0, 10)
}
function mkBars(closes, { vol = 1000, spread = 0.15 } = {}) {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]
    return { date: day(i), o, c, h: Math.max(o, c) + spread, l: Math.min(o, c) - spread, v: vol }
  })
}
function rising(n = 140) {
  const out = []
  for (let i = 0; i < n; i++) out.push(100 + 0.25 * i + 0.006 * i * i)
  return out
}

function seriesNearBreakout() {
  const bars = mkBars(rising())
  const s = computeSeries(bars, TREND_DEFAULTS)
  const last = s[s.length - 1]
  return { s, last }
}

test('buildMonitorLevels：给出触发位与趋势方向', () => {
  const { s, last } = seriesNearBreakout()
  const lv = buildMonitorLevels(s, TREND_DEFAULTS)
  assert.ok(Number.isFinite(lv.triggerUp))
  assert.ok(Number.isFinite(lv.triggerDown))
  assert.equal(lv.trendUp, true)
  assert.equal(lv.trendDown, false)
  assert.ok(lv.triggerUp <= last.c, '上涨序列里 55 日高点应低于现价')
})

test('takeProfitPrice：多头 2R / 空头 2R', () => {
  assert.ok(Math.abs(takeProfitPrice({ dir: 1, entryPrice: 100, stopPrice: 95 }) - 110) < 1e-9)
  assert.ok(Math.abs(takeProfitPrice({ dir: -1, entryPrice: 100, stopPrice: 105 }) - 90) < 1e-9)
})

test('takeProfitPrice：用入场止损距离，SAR 收紧不改止盈位', () => {
  const a = takeProfitPrice({ dir: 1, entryPrice: 100, stopPrice: 97, initialStop: 95 })
  assert.ok(Math.abs(a - 110) < 1e-9, '应按入场止损 95 算 2R=110')
  const b = takeProfitPrice({ dir: 1, entryPrice: 100, stopPrice: 97 })
  assert.ok(Math.abs(b - 106) < 1e-9, '没有 initialStop 时退回当前止损')
})

test('trigger：越过触发位时提醒', () => {
  const { s } = seriesNearBreakout()
  const lv = buildMonitorLevels(s, TREND_DEFAULTS)
  const price = lv.triggerUp * 1.002
  const seen = new Set()
  const alerts = evaluateOne({ code: 'RB0', name: '螺纹', levels: lv, price, position: null, seen, day: '2026-11-10' })
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].kind, 'trigger')
})

test('方向过滤：趋势向下时不提示做多预警', () => {
  const levels = {
    date: '2026-11-10', close: 99.8, triggerUp: 100, triggerDown: 80,
    ma20: 95, ma60: 97, atrPct: 1, trix: -0.1, trixSig: 0.1, vr: 1.3,
    trendUp: false, trendDown: true,
  }
  const seen = new Set()
  const alerts = evaluateOne({ code: 'X0', name: 'X', levels, price: 99.8, position: null, seen, day: 'd1' })
  assert.equal(alerts.filter((a) => a.kind === 'trigger' && a.dir === 'up').length, 0)
})

test('stop：多头触及止损价', () => {
  const { s } = seriesNearBreakout()
  const lv = buildMonitorLevels(s, TREND_DEFAULTS)
  const seen = new Set()
  const pos = { dir: 1, entryPrice: 150, stopPrice: 142.5 }
  const alerts = evaluateOne({ code: 'RB0', name: '螺纹', levels: lv, price: 142, position: pos, seen, day: '2026-11-10' })
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].kind, 'stop')
  assert.equal(alerts[0].level, 'strong')
})

test('tp：多头达到 2R', () => {
  const { s } = seriesNearBreakout()
  const lv = buildMonitorLevels(s, TREND_DEFAULTS)
  const seen = new Set()
  const pos = { dir: 1, entryPrice: 150, stopPrice: 142.5 }
  const alerts = evaluateOne({ code: 'RB0', name: '螺纹', levels: lv, price: 165.1, position: pos, seen, day: '2026-11-10' })
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].kind, 'tp')
})

test('去重：同品种同类型同一天只提醒一次', () => {
  const { s } = seriesNearBreakout()
  const lv = buildMonitorLevels(s, TREND_DEFAULTS)
  const seen = new Set()
  const price = lv.triggerUp * 1.002
  const a1 = evaluateOne({ code: 'RB0', name: '螺纹', levels: lv, price, position: null, seen, day: '2026-11-10' })
  const a2 = evaluateOne({ code: 'RB0', name: '螺纹', levels: lv, price, position: null, seen, day: '2026-11-10' })
  assert.equal(a1.length, 1)
  assert.equal(a2.length, 0)
  const a3 = evaluateOne({ code: 'RB0', name: '螺纹', levels: lv, price, position: null, seen, day: '2026-11-11' })
  assert.equal(a3.length, 1, '换一天可以再提醒')
})

test('evaluateTicks：批量评估', () => {
  const { s } = seriesNearBreakout()
  const lv = buildMonitorLevels(s, TREND_DEFAULTS)
  const items = [
    { code: 'RB0', name: '螺纹', levels: lv, price: lv.triggerUp * 0.998, position: null },
    { code: 'I0', name: '铁矿', levels: lv, price: lv.triggerUp * 1.002, position: null },
  ]
  const alerts = evaluateTicks(items, { seen: new Set(), day: '2026-11-10' })
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].kind, 'trigger')
  assert.equal(alerts[0].code, 'I0')
})

await testAsync('runtime：用磁盘缓存 + mock 快照产出提醒并写日志', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt-'))
  const file = path.join(tmp, 'cache.json')
  const closes = rising()
  const bars = mkBars(closes)
  fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), bars: { RB: bars } }))
  const written = []
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], name: 'x', quoteAt: Date.now() }],
    fetchBars: async () => bars,
    journal: { write: (ev) => { written.push(ev); return true } },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
  })
  const body = await rt.tick()
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.alerts))
  assert.ok(Array.isArray(body.confirmed), '返回体应包含 confirmed')
  assert.ok(Array.isArray(body.unconfirmed), '返回体应包含 unconfirmed')
})

await testAsync('runtime：收盘确认 + 手数计算（mock 大涨放量）', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt2-'))
  const file = path.join(tmp, 'cache.json')
  // 指数级加速上涨：TRIX 持续为正且抬升，末根放量突破 55 日高点
  const closes = Array.from({ length: 140 }, (_, i) => 100 * Math.exp(0.004 * i + 0.00002 * i * i))
  // 固定日期与时钟：不依赖运行时段（0-8 点 toISOString 会算成昨天）
  const todayStr = '2026-11-11'
  const fixedNow = () => new Date('2026-11-11T15:20:00+08:00')
  const endDate = new Date(todayStr)
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, v: 6000 }
  })
  bars[bars.length - 1].v = 30000 // 放量，满足量比；同时过流动性门槛
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date(todayStr + 'T15:20:00+08:00').getTime(), bars: { RB: bars } }))
  // 预置当天已推送的确认键：seedSeen 必须把它种进 seen，否则重载后会重复提醒
  fs.writeFileSync(path.join(tmp, 'suppress.json'), JSON.stringify({ day: todayStr, keys: ['RB0|confirm|2026-11-11'] }))
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], quoteAt: fixedNow().getTime() }],
    fetchBars: async () => bars,
    now: fixedNow,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const body = await rt.tick({ equity: 1000000, riskPct: 0.6 })
  assert.equal(body.confirmed.length, 1, '应确认 1 个突破')
  assert.equal((body.alerts || []).filter((a) => a.kind === 'confirm').length, 0, 'suppress 应抑制已推送的确认')
  assert.equal(body.confirmed[0].code, 'RB0')
  assert.ok(Number.isFinite(body.confirmed[0].lots) && body.confirmed[0].lots > 0, '应算出手数')
  const c0 = body.confirmed[0]
  assert.ok(Number.isFinite(c0.entryRef) && c0.entryRef > 0, '应有参考开仓价')
  assert.ok(Number.isFinite(c0.stop) && c0.stop < c0.entryRef, '止损应在开仓价下方')
  assert.ok(Math.abs(c0.tp - (c0.entryRef + 2 * (c0.entryRef - c0.stop))) < 1e-6, '2R 止盈应为两倍止损距离')
  assert.ok(Number.isFinite(c0.riskYuan) && c0.riskYuan > 0, '应算出单笔风险金额')
  assert.ok(typeof body.confirmWindow === 'string' && body.confirmWindow.includes('夜盘'), '应给出具体入场窗口')
})

await testAsync('runtime：日线未更新时不生成收盘确认（新鲜度守卫）', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt3-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 * Math.exp(0.004 * i + 0.00002 * i * i))
  // 日线截止到「昨天」：收盘扫描必须挂起，不能生成次日任务
  const endDate = new Date('2026-11-10T00:00:00+08:00')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate)
    d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, v: 6000 }
  })
  bars[bars.length - 1].v = 30000
  fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), bars: { RB: bars } }))
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], quoteAt: new Date('2026-11-11T15:20:00+08:00').getTime() }],
    fetchBars: async () => bars, // 数据源也还是昨天的
    now: () => new Date('2026-11-11T15:20:00+08:00'),
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const body = await rt.tick({ equity: 1000000 })
  assert.equal(body.confirmed.length, 0, '日线过期时不应确认')
  assert.equal(body.confirmPending, true, '应标记为待定')
})

await testAsync('runtime：实时 trigger 位按主连/加权比价换算', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt4-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 * Math.exp(0.004 * i + 0.00002 * i * i))
  const endDate = new Date()
  const bars = closes.map((c, i) => {
    const d = new Date(endDate)
    d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, v: 6000 }
  })
  bars[bars.length - 1].v = 30000
  fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), bars: { RB: bars } }))
  const series = computeSeries(bars, TREND_DEFAULTS)
  const row = series[series.length - 1]
  const prevClose = series[series.length - 2].c
  const ratio = 1.01
  const price = row.hh * ratio * 1.001 // 主连空间里刚好越过触发位
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: price, prevSettle: prevClose * ratio, quoteAt: Date.now() }],
    fetchBars: async () => bars,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const body = await rt.tick()
  const trig = body.alerts.find((a) => a.kind === 'trigger' && a.dir === 'up')
  assert.ok(trig, '应产出 trigger')
  assert.ok(Math.abs(trig.triggerPrice - row.hh * ratio) < 1e-6, `触发位应换算成 ${row.hh * ratio}，实际 ${trig.triggerPrice}`)
})

await testAsync('runtime：比价边界——价格只在主连空间越过触发位', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt5-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 * Math.exp(0.004 * i + 0.00002 * i * i))
  const endDate = new Date('2026-11-11T00:00:00+08:00')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, v: 6000 }
  })
  bars[bars.length - 1].v = 30000
  fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), bars: { RB: bars } }))
  const series = computeSeries(bars, TREND_DEFAULTS)
  const row = series[series.length - 1]
  const prevClose = series[series.length - 2].c
  const ratio = 0.98
  const price = row.hh * 0.99 // > 主连触发位 H*0.98，但仍 < 加权触发位 H
  const at = new Date('2026-11-11T09:30:00+08:00').getTime()
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: price, prevSettle: prevClose * ratio, quoteAt: at }],
    fetchBars: async () => bars,
    now: () => new Date(at),
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const body = await rt.tick()
  const trig = body.alerts.find((a) => a.kind === 'trigger' && a.dir === 'up')
  assert.ok(trig, '价格在主连空间越过触发位，应触发')
  assert.ok(Math.abs(trig.triggerPrice - row.hh * ratio) < 1e-6, `触发位应为 ${row.hh * ratio}`)
  assert.ok(price < row.hh, '该价格在加权空间并未突破——证明换算改变了判定')
})

test('tradingDayOf：夜盘归属下一交易日', () => {
  const t = (iso) => tradingDayOf(new Date(iso))
  assert.equal(t('2026-11-10T21:30:00+08:00'), '2026-11-11', '周二夜盘属于周三')
  assert.equal(t('2026-11-11T00:30:00+08:00'), '2026-11-11', '凌晨延续仍属当天')
  assert.equal(t('2026-11-13T22:00:00+08:00'), '2026-11-16', '周五夜盘属于下周一')
  assert.equal(t('2026-11-14T01:00:00+08:00'), '2026-11-16', '周六凌晨属于周五夜盘 → 下周一')
  assert.equal(t('2026-11-15T01:00:00+08:00'), '2026-11-16', '周日凌晨也归下周一')
  assert.equal(t('2026-11-11T10:00:00+08:00'), '2026-11-11', '日盘属于当天')
  assert.equal(t('2026-11-14T10:00:00+08:00'), '2026-11-16', '周末白天归下一交易日')
})

await testAsync('runtime：确认信号与宿主任务同源（板块上限拒绝）', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt6-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 * Math.exp(0.004 * i + 0.00002 * i * i))
  const endDate = new Date('2026-11-11')
  const mk = () => closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, v: 6000 }
  })
  const bars = { RB: mk(), HC: mk(), I: mk() }
  for (const k of Object.keys(bars)) bars[k][bars[k].length - 1].v = 30000
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-11T15:20:00+08:00').getTime(), bars }))
  const fixedNow = () => new Date('2026-11-11T15:20:00+08:00')
  const quote = (code) => ({ code, last: closes[closes.length - 1], quoteAt: fixedNow().getTime() })
  const logs = []
  const rt = createTrendRuntime({
    codes: ['RB0', 'HC0', 'I0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }], ['HC0', { label: '热卷' }], ['I0', { label: '铁矿' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [quote('RB0'), quote('HC0'), quote('I0')],
    fetchBars: async () => [],
    now: fixedNow,
    journal: { write: (ev) => { logs.push(ev); return true } },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const body = await rt.tick()
  assert.equal(body.confirmed.length, 3, '三个都应出确认')
  const ok = body.confirmed.filter((c) => c.accepted)
  const no = body.confirmed.filter((c) => !c.accepted)
  assert.equal(ok.length, 2, '板块上限 2，只应接受 2 个')
  assert.equal(no.length, 1, '第 3 个应被拒')
  assert.ok(/板块/.test(no[0].reject), `拒绝原因应含板块：${no[0].reject}`)
  const openTasks = body.tasks.filter((t) => t.action === 'open')
  assert.equal(openTasks.length, 2, '宿主任务也只应有 2 个开仓')
  assert.deepEqual(openTasks.map((t) => t.code).sort(), ok.map((c) => c.code).sort(), '宿主任务与确认接受集合一致')
  const confirmLogs = logs.filter((e) => e.kind === 'confirm')
  const rejectedLog = confirmLogs.find((e) => e.code === no[0].code)
  assert.ok(rejectedLog, '被拒确认也应写日志')
  assert.equal(rejectedLog.level, 'normal', '被拒确认日志级别应为 normal')
})

await testAsync('runtime：单品种日线未定稿时显式列为未确认', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt7-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 * Math.exp(0.004 * i + 0.00002 * i * i))
  const endDate = new Date('2026-11-11')
  const mk = (lastDate) => closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const date = i === closes.length - 1 ? lastDate : d.toISOString().slice(0, 10)
    const o = i ? closes[i - 1] : c
    return { date, o, c, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, v: 6000 }
  })
  // 10 个品种，只有 A 的末根停在昨天：9/10 = 90% 仍判定定稿
  const bars = {}
  for (const v of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
    bars[v] = mk(v === 'A' ? '2026-11-10' : '2026-11-11')
    bars[v][bars[v].length - 1].v = 30000
  }
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-11T15:20:00+08:00').getTime(), bars }))
  const fixedNow = () => new Date('2026-11-11T15:20:00+08:00')
  const codes = ['A0', 'B0', 'C0', 'D0', 'E0', 'F0', 'G0', 'H0', 'I0', 'J0']
  const rt = createTrendRuntime({
    codes,
    catalogByCode: new Map(codes.map((c) => [c, { label: c }])),
    sectorOf: (c) => `S${c[0]}`,
    fetchSnapshots: async () => codes.map((code) => ({ code, last: closes[closes.length - 1], quoteAt: fixedNow().getTime() })),
    fetchBars: async () => [],
    now: fixedNow,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const body = await rt.tick()
  assert.equal(body.confirmPending, false, '9/10 应判定定稿')
  assert.ok(!body.confirmed.some((c) => c.code === 'A0'), '过期品种不应出现在确认里')
  const u = body.unconfirmed.find((x) => x.code === 'A0')
  assert.ok(u, '过期品种必须显式列为未确认')
  assert.ok(/未定稿/.test(u.reason), `原因应说明未定稿：${u.reason}`)
})

await testAsync('runtime：辅2 反弹开仓也进入收盘确认', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt8-'))
  const file = path.join(tmp, 'cache.json')
  // 慢涨到 150 → 18 根急跌到 110 → 最后 1 根跳回 126（站上 MA10、仍在 MA60 下）
  const closes = Array.from({ length: 140 }, (_, i) => {
    if (i < 120) return 100 + i * (50 / 119)
    if (i < 139) return 150 - (i - 120) * (40 / 18)
    return 126
  })
  const endDate = new Date('2026-11-11')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, v: 6000 }
  })
  bars[bars.length - 1].v = 30000
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-11T15:20:00+08:00').getTime(), bars: { RB: bars } }))
  const fixedNow = () => new Date('2026-11-11T15:20:00+08:00')
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: 126, quoteAt: fixedNow().getTime() }],
    fetchBars: async () => [],
    now: fixedNow,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const body = await rt.tick()
  const rb = body.confirmed.find((c) => c.code === 'RB0')
  assert.ok(rb, '辅2 反弹应出现在确认里')
  assert.equal(rb.channel, 'rebound', '应标记为辅2通道')
  assert.equal(rb.accepted, true, '有开仓任务时应接受')
})

await testAsync('runtime：日线刷新失败时不会每 tick 全量重拉', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt9-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 + 0.3 * i)
  const endDate = new Date('2026-11-11')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, v: 6000 }
  })
  // 缓存是早上拉的：stale 为真，但数据未定稿
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-11T09:00:00+08:00').getTime(), bars: { RB: bars } }))
  let calls = 0
  const fixedNow = () => new Date('2026-11-11T15:20:00+08:00')
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], quoteAt: fixedNow().getTime() }],
    fetchBars: async () => { calls += 1; throw new Error('upstream down') },
    now: fixedNow,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const b1 = await rt.tick()
  await rt.tick()
  const b3 = await rt.tick()
  assert.equal(calls, 1, `失败后 30 分钟内不应重复刷新，实际调用 ${calls} 次`)
  assert.equal(b1.confirmPending, true, '数据未定稿应挂起确认')
  assert.equal(b3.confirmed.length, 0, '未定稿时不应产出确认')
})

await testAsync('runtime：21:00 后打开也能补做当天收盘确认，且不重复', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt10-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 * Math.exp(0.004 * i + 0.00002 * i * i))
  const endDate = new Date('2026-11-11')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, v: 6000 }
  })
  bars[bars.length - 1].v = 30000
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-11T15:20:00+08:00').getTime(), bars: { RB: bars } }))
  let clock = new Date('2026-11-11T21:30:00+08:00')
  const now = () => clock
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], quoteAt: clock.getTime() }],
    fetchBars: async () => bars,
    now,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const b1 = await rt.tick()
  assert.equal(b1.confirmDay, '2026-11-11', '21:30 应补确认 11-11')
  assert.equal(b1.confirmed.length, 1, '补确认应产出 1 条')
  assert.equal(b1.alerts.filter((a) => a.kind === 'confirm').length, 1, '应推一条确认提醒')
  // 跨到次日凌晨：目标仍是 11-11，已确认过，不应重复
  clock = new Date('2026-11-12T00:30:00+08:00')
  const b2 = await rt.tick()
  assert.equal(b2.confirmDay, '2026-11-11', '不应回退确认日')
  assert.equal(b2.alerts.filter((a) => a.kind === 'confirm').length, 0, '不应重复推确认')
})

await testAsync('runtime：权益变更跨交易日不重复推确认，且价格锚点不变', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt10b-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 * Math.exp(0.004 * i + 0.00002 * i * i))
  const endDate = new Date('2026-11-11')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, v: 6000 }
  })
  bars[bars.length - 1].v = 30000
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-11T15:20:00+08:00').getTime(), bars: { RB: bars } }))
  let clock = new Date('2026-11-11T18:01:00+08:00')
  let prevSettle = closes[closes.length - 2]
  const now = () => clock
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], prevSettle, quoteAt: clock.getTime() }],
    fetchBars: async () => bars,
    now,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const b1 = await rt.tick({ equity: 1000000 })
  assert.equal(b1.alerts.filter((a) => a.kind === 'confirm').length, 1, '18:01 应推一条确认')
  const firstPrice = b1.confirmed[0].entryRef
  // 真实事故组合：21:00 夜盘归属次日（seen.clear），同时权益变更重置 confirmDay
  prevSettle = prevSettle * 0.9
  clock = new Date('2026-11-11T21:00:00+08:00')
  const b2 = await rt.tick({ equity: 1500000 })
  assert.equal(b2.alerts.filter((a) => a.kind === 'confirm').length, 0, '同一收盘日不应重复推确认')
  assert.equal(b2.confirmed[0].entryRef, firstPrice, '重扫必须复用首次确认的比价锚点')
})

test('runtime：日志 ratio 优先，旧价格反推不覆盖已有锚点', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-ratio-seed-'))
  const day = '2026-11-11'
  const journalPath = path.join(tmp, 'alerts.jsonl')
  fs.writeFileSync(journalPath, [
    JSON.stringify({ type: 'trend', kind: 'confirm', code: 'RB0', day, price: 105, close: 100 }),
    JSON.stringify({ type: 'trend', kind: 'confirm', code: 'HC0', day, price: 105, close: 100 }),
    JSON.stringify({ type: 'trend', kind: 'confirm', code: 'I0', day, ratio: 1.06, price: 1, close: 1 }),
  ].join('\n'))
  fs.writeFileSync(path.join(tmp, 'runtime-state.json'), JSON.stringify({
    ratioAnchorVersion: 2,
    ratioAnchor: { [`RB0|${day}`]: 1.02, [`I0|${day}`]: 1.0 },
  }))
  const rt = createTrendRuntime({
    codes: ['RB0'], catalogByCode: new Map(), sectorOf: () => '黑色',
    fetchSnapshots: async () => [], fetchBars: async () => [],
    cacheFile: path.join(tmp, 'cache.json'),
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
    journal: { file: journalPath, write: () => true },
  })
  assert.equal(rt.state.ratioAnchor.get(`RB0|${day}`), 1.02, '旧日志无 ratio 时不能覆盖已有锚点')
  assert.equal(rt.state.ratioAnchor.get(`HC0|${day}`), 1.05, '没有锚点时才允许用价格反推回退')
  assert.equal(rt.state.ratioAnchor.get(`I0|${day}`), 1.06, '日志有 ratio 时应以 ratio 为准')
})

test('entryWindowText：把「明日开盘」翻译成具体窗口', () => {
  const t = (target, iso) => entryWindowText(target, new Date(iso))
  assert.ok(t('2026-11-11', '2026-11-11T16:00:00+08:00').includes('今晚 21:00 夜盘'))
  assert.ok(t('2026-11-11', '2026-11-11T21:30:00+08:00').includes('夜盘已开始'))
  assert.ok(t('2026-11-11', '2026-11-12T00:30:00+08:00').includes('夜盘时段'), '跨零点的夜盘不能当成早盘')
  assert.ok(t('2026-11-13', '2026-11-14T01:00:00+08:00').includes('夜盘时段'), '周五夜盘延续到周六凌晨')
  assert.ok(t('2026-11-11', '2026-11-12T08:00:00+08:00').includes('2026-11-12 09:00 早盘'))
  assert.ok(t('2026-11-11', '2026-11-12T10:00:00+08:00').includes('已开盘'))
  assert.ok(t('2026-11-13', '2026-11-14T10:00:00+08:00').includes('2026-11-16 09:00 早盘'))
})

test('mergeBars：同日覆盖、按日期排序', () => {
  const m = mergeBars(
    [{ date: '2026-11-10', c: 1 }, { date: '2026-11-11', c: 2 }],
    [{ date: '2026-11-11', c: 3 }, { date: '2026-11-12', c: 4 }],
  )
  assert.deepEqual(m.map((b) => b.date), ['2026-11-10', '2026-11-11', '2026-11-12'])
  assert.equal(m[1].c, 3, '同日应被新值覆盖')
})

test('runtime：增量刷新只拉最近 30 天', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt11-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 + 0.3 * i)
  const endDate = new Date('2026-11-12')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, v: 6000 }
  })
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-12T15:20:00+08:00').getTime(), bars: { RB: bars } }))
  let seen = null
  let calls = 0
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], quoteAt: Date.now() }],
    fetchBars: async (v, range) => {
      calls += 1
      seen = range
      return [
        { date: '2026-11-12', o: 140, c: 141, h: 142, l: 139, v: 6000 },
        { date: '2026-11-13', o: 141, c: 142, h: 143, l: 140, v: 6000 },
      ]
    },
    now: () => new Date('2026-11-13T15:20:00+08:00'),
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const body = await rt.tick()
  assert.equal(calls, 1)
  assert.equal(seen.begin, '20261013', `应从 11-12 往前 30 天开始拉，实际 ${seen.begin}`)
  assert.equal(seen.end, '20261113')
  assert.equal(body.date, '2026-11-13')
})

test('runtime：周末已确认后不再刷新日线', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt12-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 + 0.3 * i)
  const endDate = new Date('2026-11-13')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, v: 6000 }
  })
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-13T15:20:00+08:00').getTime(), bars: { RB: bars } }))
  let clock = new Date('2026-11-13T16:00:00+08:00')
  let calls = 0
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], quoteAt: clock.getTime() }],
    fetchBars: async () => { calls += 1; return bars },
    now: () => clock,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const friday = await rt.tick()
  assert.equal(friday.confirmDay, '2026-11-13', '周五应先完成确认')
  calls = 0
  clock = new Date('2026-11-14T10:00:00+08:00') // 周六
  const sat = await rt.tick()
  assert.equal(calls, 0, '周末已确认后不应再刷新日线')
  assert.equal(sat.confirmDay, '2026-11-13', '确认日不应变化')
})

test('runtime：盘中刷新间隔为 2 小时', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt14-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 + 0.3 * i)
  const endDate = new Date('2026-11-13')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, v: 6000 }
  })
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-13T08:00:00+08:00').getTime(), bars: { RB: bars } }))
  let clock = new Date('2026-11-13T09:30:00+08:00')
  let calls = 0
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], quoteAt: clock.getTime() }],
    fetchBars: async () => { calls += 1; return bars },
    now: () => clock,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  await rt.tick() // 09:30，距 08:00 仅 1.5 小时
  assert.equal(calls, 0, '盘中 2 小时内不应刷新')
  clock = new Date('2026-11-13T10:05:00+08:00') // 2h05
  await rt.tick()
  assert.equal(calls, 1, '满 2 小时应刷新一次')
})

test('runtime：刷新失败后按退避间隔重试', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt13-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 + 0.3 * i)
  const endDate = new Date('2026-11-13')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, v: 6000 }
  })
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-13T15:20:00+08:00').getTime(), bars: { RB: bars } }))
  let clock = new Date('2026-11-13T18:30:00+08:00')
  let calls = 0
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], quoteAt: clock.getTime() }],
    fetchBars: async () => { calls += 1; throw new Error('upstream down') },
    now: () => clock,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  await rt.tick() // 18:30 距 15:20 超过 3 小时，但不足 4 小时 → 不刷
  assert.equal(calls, 0, '收盘 4 小时窗口内不应刷新')
  clock = new Date('2026-11-13T19:25:00+08:00') // 4h05
  await rt.tick()
  assert.equal(calls, 1, '超过 4 小时应尝试一次')
  clock = new Date('2026-11-13T19:30:00+08:00')
  await rt.tick()
  assert.equal(calls, 1, '失败后 30 分钟内不应重试')
  clock = new Date('2026-11-13T19:56:00+08:00') // 首次失败后 31 分钟
  await rt.tick()
  assert.equal(calls, 2, '30 分钟后应再试一次')
})

test('runtime：连续失败 3 次后熔断 6 小时', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt15-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 + 0.3 * i)
  const endDate = new Date('2026-11-13')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, v: 6000 }
  })
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-13T09:00:00+08:00').getTime(), bars: { RB: bars } }))
  let clock = new Date('2026-11-13T15:20:00+08:00')
  let calls = 0
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], quoteAt: clock.getTime() }],
    fetchBars: async () => { calls += 1; throw new Error('fetch failed') },
    now: () => clock,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  await rt.tick() // 第 1 次失败
  clock = new Date('2026-11-13T15:51:00+08:00')
  await rt.tick() // 第 2 次失败
  clock = new Date('2026-11-13T16:52:00+08:00')
  const b3 = await rt.tick() // 第 3 次失败 → 熔断 6h
  assert.equal(calls, 3)
  assert.equal(b3.refreshFailures, 3)
  assert.ok(b3.refreshPausedUntil > clock.getTime(), '应进入 6 小时熔断')
  clock = new Date('2026-11-13T17:00:00+08:00')
  await rt.tick()
  assert.equal(calls, 3, '熔断期内不应再请求')
  clock = new Date('2026-11-13T22:53:00+08:00') // 6 小时后
  await rt.tick()
  assert.equal(calls, 4, '熔断结束后应再试一次')
})

test('runtime：刷新成功后清除失败计数与熔断', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt16-'))
  const file = path.join(tmp, 'cache.json')
  const closes = Array.from({ length: 140 }, (_, i) => 100 + 0.3 * i)
  const endDate = new Date('2026-11-13')
  const bars = closes.map((c, i) => {
    const d = new Date(endDate); d.setDate(d.getDate() - (closes.length - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, v: 6000 }
  })
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-13T09:00:00+08:00').getTime(), bars: { RB: bars } }))
  let clock = new Date('2026-11-13T15:20:00+08:00')
  let calls = 0
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[closes.length - 1], quoteAt: clock.getTime() }],
    fetchBars: async () => {
      calls += 1
      if (calls === 1) throw new Error('fetch failed')
      return bars
    },
    now: () => clock,
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  await rt.tick() // 失败
  clock = new Date('2026-11-13T15:51:00+08:00')
  const ok = await rt.tick() // 成功
  assert.equal(ok.refreshFailures, 0, '成功后失败计数应清零')
  assert.equal(ok.refreshPausedUntil, null, '成功后不应有熔断')
})

await testAsync('runtime：重启后补算的仓位带 backfilled 标记', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt17-'))
  const file = path.join(tmp, 'cache.json')
  fs.writeFileSync(path.join(tmp, 'runtime-state.json'), JSON.stringify({ lastTickAt: new Date('2026-10-25T15:00:00+08:00').getTime() }))
  const n = 140
  const closes = []
  for (let i = 0; i < n; i++) closes.push(i < 120 ? 100 + 0.05 * (i % 7) : 100 * Math.pow(1.01, i - 119))
  const end = new Date('2026-11-19')
  const bars = closes.map((c, i) => {
    const d = new Date(end); d.setDate(d.getDate() - (n - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, v: i >= 120 ? 6000 : 1000 }
  })
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-19T16:00:00+08:00').getTime(), bars: { RB: bars } }))
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[n - 1], quoteAt: new Date('2026-11-19T16:00:00+08:00').getTime() }],
    fetchBars: async () => bars,
    now: () => new Date('2026-11-19T16:00:00+08:00'),
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const body = await rt.tick({ equity: 1000000 })
  assert.equal(body.autoPositions.length, 1)
  assert.equal(body.autoPositions[0].backfilled, true, '离线期间补算的仓位应带补算标记')
  assert.equal(body.zeroLots.length, 0)
})

await testAsync('runtime：0 手信号只提醒、不进入持仓', async () => {
  const { createTrendRuntime } = await import('../trend-runtime.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-rt18-'))
  const file = path.join(tmp, 'cache.json')
  const n = 140
  const closes = []
  for (let i = 0; i < n; i++) closes.push(i < 120 ? 100 + 0.05 * (i % 7) : 100 * Math.pow(1.01, i - 119))
  const end = new Date('2026-11-19')
  const bars = closes.map((c, i) => {
    const d = new Date(end); d.setDate(d.getDate() - (n - 1 - i))
    const o = i ? closes[i - 1] : c
    return { date: d.toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, v: i >= 120 ? 6000 : 1000 }
  })
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date('2026-11-19T16:00:00+08:00').getTime(), bars: { RB: bars } }))
  const rt = createTrendRuntime({
    codes: ['RB0'],
    catalogByCode: new Map([['RB0', { label: '螺纹' }]]),
    sectorOf: () => '黑色',
    fetchSnapshots: async () => [{ code: 'RB0', last: closes[n - 1], quoteAt: new Date('2026-11-19T16:00:00+08:00').getTime() }],
    fetchBars: async () => bars,
    now: () => new Date('2026-11-19T16:00:00+08:00'),
    journal: { write: () => true },
    cacheFile: file,
    suppressFile: path.join(tmp, 'suppress.json'),
    startFile: path.join(tmp, 'start.json'),
  })
  const body = await rt.tick({ equity: 1000 })
  assert.equal(body.positions.length, 0, '0 手不应进入持仓')
  assert.equal(body.zeroLots.length, 1)
  assert.match(body.zeroLots[0].reason, /装不下 1 手/)
  assert.ok(body.alerts.some((a) => a.kind === 'zero-lot'), '应产生 0 手提醒')
})

console.log('')
console.log(`  趋势提醒自测：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
