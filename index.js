/**
 * 行情雷达 · 宿主入口（趋势策略版）
 *
 * 只做三件事：
 *   1. 注册 /futures-radar/api
 *   2. op=trend：把 61 个品种的实时快照喂给趋势运行时，产出 trigger/confirm/stop/tp 提醒
 *   3. op=health / op=catalog：状态与品种目录
 *
 * 旧的「30 秒量价爆发」逻辑已整体移除（引擎/扫描器/基线/回放脚本）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sectorOf } from './sectors.js'
import { decodeGb18030, parseSnapshotText } from './snapshot.js'
import { openJournal, defaultJournalPath } from './journal.js'
import { createTrendRuntime } from './trend-runtime.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROUTE = '/futures-radar/api'
const SINA_REFERER = 'https://finance.sina.com.cn/'
const SINA_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
const SNAPSHOT_TTL_MS = 2000
const BATCH = 45
const MAX_CODES = 120
const CODE_RE = /^[A-Z]{1,3}(0|\d{3,4})$/

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

export const inject = ['webServer']

export function apply(ctx) {
  let catalog = []
  try {
    catalog = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'catalog.json'), 'utf8'))
  } catch (err) {
    ctx.logger?.warn?.(`futures-radar: 合约目录读取失败 ${String(err)}`)
  }
  const catalogByCode = new Map(catalog.map((c) => [c.code, c]))

  const journal = openJournal(defaultJournalPath())
  const snapCache = new Map()
  let trendRuntime = null
  let trendRuntimeKey = ''

  const upstream = async (url) => {
    const res = await fetch(url, {
      headers: { Referer: SINA_REFERER, 'User-Agent': SINA_UA },
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    })
    if (!res.ok) throw new Error(`上游 ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** 新浪快照：解析交给 snapshot.js */
  const fetchSnapshots = async (codes) => {
    const key = codes.join(',')
    const hit = snapCache.get(key)
    if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.rows

    const batches = []
    for (let i = 0; i < codes.length; i += BATCH) batches.push(codes.slice(i, i + BATCH))
    const rows = []
    await Promise.all(
      batches.map(async (batch) => {
        const url = `https://hq.sinajs.cn/list=${batch.map((c) => `nf_${c}`).join(',')}`
        const text = decodeGb18030(await upstream(url))
        const receivedAt = Date.now()
        rows.push(...parseSnapshotText(text, receivedAt))
      }),
    )
    snapCache.set(key, { at: Date.now(), rows })
    return rows
  }

  const respond = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const op = url.searchParams.get('op') || 'health'
    try {
      if (op === 'health') {
        respond(res, 200, {
          ok: true,
          op,
          version: VERSION,
          catalog: catalog.length,
          liquid: catalog.filter((c) => c.liquid !== false).length,
          journal: journal.file,
          trend: trendRuntime ? {
            date: trendRuntime.state.lastDate,
            positions: trendRuntime.state.positions.length,
            tasks: (trendRuntime.state.tasks || []).length,
            error: trendRuntime.state.lastError,
          } : null,
        })
        return
      }

      if (op === 'catalog') {
        respond(res, 200, {
          ok: true,
          op,
          items: catalog.map((c) => ({
            code: c.code,
            name: c.name,
            label: c.label || c.name,
            exchange: c.exchange,
            exchangeLabel: c.exchangeLabel,
            liquid: c.liquid !== false,
          })),
        })
        return
      }

      if (op === 'trend') {
        const raw = String(url.searchParams.get('codes') || '')
        let codes = raw
          ? raw.split(',').map((c) => c.trim().toUpperCase()).filter((c) => CODE_RE.test(c))
          : catalog.filter((c) => c.liquid !== false).map((c) => c.code)
        const exclude = new Set(
          String(url.searchParams.get('exclude') || '')
            .split(',')
            .map((c) => c.trim().toUpperCase())
            .filter((c) => CODE_RE.test(c)),
        )
        if (exclude.size) codes = codes.filter((c) => !exclude.has(c))
        codes = codes.slice(0, MAX_CODES)

        const key = codes.join(',')
        if (!trendRuntime || trendRuntimeKey !== key) {
          trendRuntime = createTrendRuntime({
            codes,
            catalogByCode,
            sectorOf,
            fetchSnapshots,
            journal,
            logger: ctx.logger,
          })
          trendRuntimeKey = key
        }
        const equity = Number(url.searchParams.get('equity') || 0) || 0
        const riskPct = Number(url.searchParams.get('risk') || 0) || undefined
        const body = await trendRuntime.tick({ equity, riskPct })
        respond(res, 200, body)
        return
      }

      respond(res, 200, { ok: false, op, error: `未知 op: ${op}` })
    } catch (err) {
      ctx.logger?.warn?.(`futures-radar: ${op} 失败 ${String(err)}`)
      respond(res, 200, { ok: false, op, error: String(err?.message || err) })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => {
        handle(req, res).catch((err) => {
          ctx.logger?.warn?.(`futures-radar: 处理失败 ${String(err)}`)
          try {
            respond(res, 500, { ok: false, error: String(err?.message || err) })
          } catch {
            /* 已结束 */
          }
        })
      },
    }),
  )

  ctx.logger?.info?.(`futures-radar ${VERSION}: 趋势策略 · ${catalog.length} 个合约`)
}
