/**
 * 行情雷达 · 新浪快照解析
 *
 * 宿主（实时）和录制脚本（离线）必须共用同一套解析，
 * 否则录制数据缺字段、回放结论和实盘对不上。
 *
 * 两种布局：
 *   商品：0=name 1=HHMMSS 8=last 10=prevSettle 13=hold 14=volume 17=date
 *   CFFEX：0=open 3=last 4=volume 6=hold 13=prevSettle 36=date 37=HH:MM:SS，最后一段=中文名
 * CFFEX 用「首段是纯数字 + 末段含中文」自动识别。
 */

export const decodeGb18030 = (buf) => {
  try {
    return new TextDecoder('gb18030').decode(buf)
  } catch {
    return Buffer.from(buf).toString('utf8')
  }
}

export const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CLOCK_RE = /^\d{2}:\d{2}:\d{2}$/

/**
 * 解析交易所报价时间（返回毫秒时间戳，失败返回 null）。
 * 商品时间字段是 HHMMSS，CFFEX 是 HH:MM:SS；统一按北京时间（+08:00）解析，
 * 不依赖运行环境时区。
 */
export function parseQuoteTime(isCffex, f) {
  try {
    const date = String((isCffex ? f[36] : f[17]) || '').trim()
    let clock = String((isCffex ? f[37] : f[1]) || '').trim()
    if (!DATE_RE.test(date) || !clock) return null
    if (/^\d{6}$/.test(clock)) clock = `${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4, 6)}`
    if (!CLOCK_RE.test(clock)) return null
    const t = Date.parse(`${date}T${clock}+08:00`)
    return Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

/**
 * 解析一行 `var hq_str_nf_XXXX="..."`。
 * @returns null | { code, name, last, prevSettle, volume, hold, quoteAt, receivedAt }
 */
export function parseSnapshotLine(line, receivedAt = Date.now()) {
  const m = String(line).match(/var hq_str_nf_(\w+)="([^"]*)"/)
  if (!m) return null
  const code = m[1]
  const f = m[2].split(',')
  if (f.length < 18) return null
  const head = String(f[0] || '').trim()
  const tail = String(f[f.length - 1] || '').trim()
  const cffex = head !== '' && Number.isFinite(Number(head)) && /[\u4e00-\u9fa5]/.test(tail)
  const last = num(cffex ? f[3] : f[8])
  if (!Number.isFinite(last) || last === 0) return null
  return {
    code,
    name: cffex ? tail : f[0] || code,
    last,
    prevSettle: num(cffex ? f[13] : f[10]),
    volume: num(cffex ? f[4] : f[14]),
    hold: num(cffex ? f[6] : f[13]),
    quoteAt: parseQuoteTime(cffex, f),
    receivedAt,
  }
}

/** 解析整段响应 */
export function parseSnapshotText(text, receivedAt = Date.now()) {
  const rows = []
  for (const line of String(text).split('\n')) {
    const row = parseSnapshotLine(line, receivedAt)
    if (row) rows.push(row)
  }
  return rows
}
