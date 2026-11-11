import fs from 'node:fs'
import path from 'node:path'

/**
 * 触发日志：把每一次"通过判定"的事件原样落到磁盘。
 *
 * 为什么必须落盘：
 * 1. 提醒是不是有效，当场判断不了 —— 要看收盘确认或之后几天怎么走；
 * 2. 事后评估需要当时**实际使用的价位与参数**（含比价、数据日），
 *    如果只存价格和方向，回测就会用今天的参数去解释昨天的决策；
 * 3. 有了这份日志，才能统计"哪类信号是假信号"，再反推过滤规则。
 *
 * 因此这里记录的是**决策现场**，不是一个摘要。
 */

/** 单文件上限，超过就轮转一份 .1 后重开（避免无限增长） */
export const JOURNAL_MAX_BYTES = 8 * 1024 * 1024

export function defaultJournalPath() {
  const home = process.env.DSH_HOME || path.join(process.env.HOME || '.', '.dsh')
  return path.join(home, 'futures-radar', 'alerts.jsonl')
}

function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file)
    if (st.size < JOURNAL_MAX_BYTES) return
    fs.renameSync(file, `${file}.1`)
  } catch {
    /* 文件不存在＝无需轮转 */
  }
}

export function openJournal(file) {
  const target = file || defaultJournalPath()
  let broken = false
  // 日志是附加能力：目录建不了（权限/只读盘）也不能让插件起不来
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    rotateIfNeeded(target)
  } catch {
    broken = true
  }
  return {
    file: target,
    /**
     * 记录一次判定。写失败不影响主流程（日志不能拖垮行情检测）。
     * @param {object} ev 事件对象（见 index.js 的 journalEvent）
     */
    write(ev) {
      if (broken) return false
      try {
        fs.appendFileSync(target, JSON.stringify(ev) + '\n')
        return true
      } catch {
        broken = true
        return false
      }
    },
    get failed() {
      return broken
    },
  }
}

/** 读取日志（评估脚本与测试共用）；坏行跳过，不因一行损坏丢掉整份数据 */
export function readJournal(file) {
  const out = []
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return out
  }
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      bad++
    }
  }
  out.badLines = bad
  return out
}
