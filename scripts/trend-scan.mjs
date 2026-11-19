#!/usr/bin/env node
/**
 * 趋势策略 · 盘后扫描
 *
 * 用法：
 *   node scripts/trend-scan.mjs                 # 扫描全部品种，输出明日任务清单
 *   node scripts/trend-scan.mjs --json          # 机器可读输出
 *   node scripts/trend-scan.mjs --date=2026-11-09
 *   node scripts/trend-scan.mjs --only=RB,M,Y   # 只扫指定品种
 *
 * 数据：东方财富加权指数 159.<品种>fi（日线，成交量加权，无换月跳空）
 * 说明：加权指数不可交易，本脚本只出信号；成交价需在次日开盘按主连执行。
 *
 * 组合层：先按历史逐笔回放并施加「并发上限 + 同板块上限 + 量比排序」，
 * 只保留被组合接受的仓位，避免出现「信号持仓 11 笔但实盘只能持 8 笔」的错位。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sectorOf } from '../sectors.js'
import { defaultStartPath, defaultTrendCachePath } from '../trend-runtime.js'
import {
  TREND_DEFAULTS, REBOUND_CONFIG, SIZING_PROFILES,
  computeSeries, planVariety, replaySeries, buildPlan, applyPortfolio, stopLevel, breakoutSignal, reboundSignal, liquidityOk, positionWeight,
} from '../trend.js'

const CFG = { ...TREND_DEFAULTS, ...SIZING_PROFILES.C1 }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const FIELDS = 'f51,f52,f53,f54,f55,f56' // date, open, close, high, low, volume
const CONCURRENCY = 6
const CFFEX = new Set(['IC', 'IF', 'IH', 'IM', 'T', 'TF', 'TL', 'TS'])

function parseArgs(argv) {
  const out = { json: false, date: null, only: null, begin: null, days: 900 }
  for (const a of argv) {
    if (a === '--json') out.json = true
    else if (a.startsWith('--date=')) out.date = a.slice(7)
    else if (a.startsWith('--only=')) out.only = a.slice(7).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    else if (a.startsWith('--begin=')) out.begin = a.slice(8)
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7)) || out.days
    else if (a === '--all') out.all = true
  }
  return out
}

function ymd(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}

async function fetchWeighted(varLower, { begin, end }) {
  const secid = `159.${varLower}fi`
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1`
    + `&beg=${begin}&end=${end}&fields1=f1,f2,f3&fields2=${FIELDS}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout?.(15000),
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
  return { name: data.name, bars }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

const varietyOf = (code) => String(code).replace(/\d+$/, '')
const fmtPct = (x, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}%` : '—')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog.json'), 'utf8'))
  const tracked = catalog.filter((c) => c.liquid !== false)
  const target = args.only
    ? tracked.filter((c) => args.only.includes(varietyOf(c.code)) || args.only.includes(c.code))
    : tracked

  const candidates = target.filter((c) => {
    const v = varietyOf(c.code)
    return /^[A-Za-z]+$/.test(v) && !CFFEX.has(v.toUpperCase())
  })

  const end = args.date ? args.date.replace(/-/g, '') : ymd(new Date())
  let begin = args.begin
  if (!begin) {
    const d = new Date()
    d.setDate(d.getDate() - Math.max(200, args.days))
    begin = ymd(d)
  }

  const fetched = await mapLimit(candidates, CONCURRENCY, async (c) => {
    const v = varietyOf(c.code)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchWeighted(v.toLowerCase(), { begin, end })
        if (!r || r.bars.length < TREND_DEFAULTS.warmup) return { c, v, error: r ? `K线不足（${r.bars.length}）` : '无数据' }
        let bars = r.bars
        if (args.date) bars = bars.filter((b) => b.date <= args.date)
        if (bars.length < TREND_DEFAULTS.warmup) return { c, v, error: `截至 ${args.date} K线不足（${bars.length}）` }
        return { c, v, bars, name: r.name }
      } catch (err) {
        if (attempt === 1) return { c, v, error: String(err.message || err) }
        await new Promise((r) => setTimeout(r, 300))
      }
    }
    return { c, v, error: '未知' }
  })

  const ok = fetched.filter((x) => x.bars)
  const failed = fetched.filter((x) => x.error)
  let usedCache = false
  // 上游全挂时降级读本地日线缓存，并明确标注
  if (failed.length) {
    try {
      const cache = JSON.parse(fs.readFileSync(defaultTrendCachePath(), 'utf8'))
      for (const f of failed) {
        const raw = cache?.bars?.[f.v]
        if (!Array.isArray(raw) || raw.length < CFG.warmup) continue
        const bars = args.date ? raw.filter((b) => b.date <= args.date) : raw
        if (bars.length < CFG.warmup) continue
        ok.push({ c: f.c, v: f.v, bars, name: f.c.label || f.c.name })
        usedCache = true
      }
    } catch { /* 没有缓存就保持空结果 */ }
  }

  // 1) 每个品种独立回放，收集全部仓位与今日任务
  const allPositions = []
  const todayTasks = []
  const illiquid = []
  let lastDate = ''
  for (const item of ok) {
    const sector = sectorOf(item.c.code) || '其他'
    const name = item.c.label || item.c.name
    const series = computeSeries(item.bars, CFG)
    if (!liquidityOk(series, CFG, item.v)) { illiquid.push(item.v); continue }
    lastDate = series[series.length - 1].date

    const main = replaySeries(series, { cfg: CFG, signalFn: (s, i) => breakoutSignal(s[i], CFG), sector })
    for (const t of main.trades) {
      allPositions.push({ code: item.c.code, name, sector, dir: t.dir, channel: 'main', entryDate: t.entryDate, exitDate: t.exitDate, entryPrice: t.entryPrice, exitPrice: t.exitPrice, pnlPct: t.pnlPct, exitReason: t.exitReason })
    }
    if (main.pos) {
      const st = stopLevel(series[series.length - 1], main.pos, CFG)
      allPositions.push({ code: item.c.code, name, sector, dir: main.pos.dir, channel: 'main', entryDate: main.pos.entryDate, exitDate: null, entryPrice: main.pos.entryPrice, pnlPct: ((series[series.length - 1].c / main.pos.entryPrice) - 1) * 100 * main.pos.dir, exitReason: null, stopPrice: st, weightPct: positionWeight(main.pos.entryPrice, main.pos.stopPrice, { riskPct: CFG.riskPct, maxWeightPct: CFG.maxWeightPct }).weightPct })
    }
    const task = planVariety(series, { cfg: CFG, channel: 'main', sector })
    if (task) todayTasks.push({ ...task, code: item.c.code, var: item.v, name, channel: 'main' })

    const seriesR = computeSeries(item.bars, REBOUND_CONFIG)
    const rb = replaySeries(seriesR, { cfg: REBOUND_CONFIG, signalFn: (s, i) => reboundSignal(s, i, REBOUND_CONFIG), sector })
    for (const t of rb.trades) {
      allPositions.push({ code: item.c.code, name, sector, dir: t.dir, channel: 'rebound', entryDate: t.entryDate, exitDate: t.exitDate, entryPrice: t.entryPrice, exitPrice: t.exitPrice, pnlPct: t.pnlPct, exitReason: t.exitReason })
    }
    if (rb.pos) {
      const stR = stopLevel(seriesR[seriesR.length - 1], rb.pos, REBOUND_CONFIG)
      allPositions.push({ code: item.c.code, name, sector, dir: rb.pos.dir, channel: 'rebound', entryDate: rb.pos.entryDate, exitDate: null, entryPrice: rb.pos.entryPrice, pnlPct: ((seriesR[seriesR.length - 1].c / rb.pos.entryPrice) - 1) * 100 * rb.pos.dir, exitReason: null, stopPrice: stR, weightPct: positionWeight(rb.pos.entryPrice, rb.pos.stopPrice, { riskPct: CFG.riskPct, maxWeightPct: CFG.maxWeightPct }).weightPct })
    }
    const taskR = planVariety(seriesR, { cfg: REBOUND_CONFIG, channel: 'rebound', sector })
    if (taskR) todayTasks.push({ ...taskR, code: item.c.code, var: item.v, name, channel: 'rebound' })
  }

  // 2) 组合层回放：只有被接受的仓位才真实存在
  const { accepted } = applyPortfolio(allPositions, CFG)
  const allOpen = accepted.filter((p) => p.exitDate === null || p.exitDate >= lastDate)
  // 与宿主一致：监控起点之前的仓位算历史
  let since = null
  try {
    const raw = JSON.parse(fs.readFileSync(defaultStartPath(), 'utf8'))
    since = raw && typeof raw.date === 'string' ? raw.date : null
  } catch { /* 没有起点文件 */ }
  if (args.all) since = null
  const openPositions = since ? allOpen.filter((p) => (p.entryDate || '') > since) : allOpen
  const heldCodes = new Set(openPositions.map((p) => p.code))

  // 3) 明日任务：只保留被接受持仓的平仓/反手 + 通过风控的新开仓
  const openVars = openPositions.map((p) => ({ code: p.code, sector: p.sector, dir: p.dir }))
  const plan = buildPlan(todayTasks, openVars, CFG)
  // 只保留真实持仓的平仓任务（信号持仓可能被组合层拒绝过）
  const closes = plan.closes.filter((t) => heldCodes.has(t.code))

  if (args.json) {
    console.log(JSON.stringify({
      date: lastDate,
      scanned: ok.length,
      source: usedCache ? 'cache' : 'live',
      failed: failed.map((f) => ({ code: f.c.code, error: f.error })),
      openPositions,
      closes,
      accepted: plan.accepted,
      rejected: plan.rejected,
    }, null, 2))
    return
  }

  const dirLabel = (d) => (d > 0 ? '多' : '空')
  console.log('')
  console.log(`  趋势雷达 · 盘后扫描   数据截止 ${lastDate}   品种 ${ok.length}/${fetched.length}`)
  if (failed.length) console.log(`  跳过：${failed.map((f) => `${f.c.code}(${f.error})`).join('  ')}`)
  if (illiquid.length) console.log(`  流动性不足（均量<${CFG.minVol20}）不监控：${illiquid.join(' ')}`)
  console.log('')
  if (since) {
    const hidden = allOpen.length - openPositions.length
    console.log(`  监控起点 ${since}：历史持仓 ${hidden} 个不计入（--all 显示全部）`)
  }
  console.log(`  ── 当前持仓（组合层约束后 ${openPositions.length}/${CFG.maxPositions}）──`)
  if (!openPositions.length) console.log('    （空仓）')
  for (const p of openPositions.sort((a, b) => (b.pnlPct || 0) - (a.pnlPct || 0))) {
    const stop = p.stopPrice ? `止损 ${p.stopPrice.toFixed(2)}` : ''
    console.log(`    ${p.code.padEnd(7)} ${String(p.name).padEnd(10)} ${dirLabel(p.dir)}  ${p.channel === 'rebound' ? '辅2' : '主'}  入场 ${p.entryDate} @${p.entryPrice.toFixed(2)}  ${stop}  仓位 ${Number(p.weightPct || 0).toFixed(0)}%  浮动 ${fmtPct(p.pnlPct)}`)
  }
  console.log('')
  console.log('  ── 明日任务 ──')
  const act = {
    open: (t) => `[开${dirLabel(t.dir)}] ${t.code} ${t.name} 量比 ${Number(t.vr).toFixed(2)}  ${t.reason}`,
    close: (t) => `[平${dirLabel(t.dir)}] ${t.code} ${t.name}  ${t.reason}`,
    reverse: (t) => `[反手${dirLabel(t.dir)}] ${t.code} ${t.name} 平${dirLabel(t.from)}开${dirLabel(t.dir)}  量比 ${Number(t.vr).toFixed(2)}`,
  }
  const line = (t) => (act[t.action] ? act[t.action](t) : `[${t.action}] ${t.code} ${t.name}  ${t.reason}`)
  if (!closes.length && !plan.accepted.length) console.log('    （无）')
  for (const t of closes) console.log(`    ${line(t)}`)
  for (const t of plan.accepted) console.log(`    ${line(t)}`)
  if (plan.rejected.length) {
    console.log('')
    console.log('  ── 风控拦截 ──')
    for (const t of plan.rejected) console.log(`    ${t.code.padEnd(7)} ${String(t.name).padEnd(10)} ${t.reject}${t.vr ? `（量比 ${Number(t.vr).toFixed(2)}）` : ''}`)
  }
  console.log('')
  if (usedCache) console.log('  ⚠ 上游请求失败，已降级使用本地缓存日线；结果可能滞后，请以宿主刷新后的数据为准。')
  console.log('  提示：加权指数不可交易，实际成交在次日开盘的主连合约。')
  console.log('')
}

main().catch((err) => {
  console.error('趋势扫描失败：', err?.message || err)
  process.exit(1)
})
