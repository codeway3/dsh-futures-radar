window.__ModuleLoader__.load({
  id: 'dsh-futures-radar',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useReducer, useMemo, useRef } = React
    const h = React.createElement

    const API = '/futures-radar/api'
    const CFG_KEY = 'dsh-futures-radar.config.v1'
    const DEFAULT_CFG = {
      equity: 1_000_000,
      profile: 'C1',
      watch: '',
      exclude: '',
      pauseUntil: 0,
    }

    /* ───────────── 配置 ───────────── */

    const cfgSubs = new Set()
    let cfgMemo = null

    function readCfg() {
      if (cfgMemo) return cfgMemo
      let out = Object.assign({}, DEFAULT_CFG)
      try {
        const raw = localStorage.getItem(CFG_KEY)
        if (raw) out = Object.assign(out, JSON.parse(raw))
      } catch (e) {
        /* 忽略 */
      }
      // 老配置里 equity=0：按默认 100 万启动，避免所有信号都是 0 手
      if (!Number(out.equity) || Number(out.equity) <= 0) out.equity = DEFAULT_CFG.equity
      cfgMemo = out
      return out
    }

    function writeCfg(patch) {
      cfgMemo = Object.assign({}, readCfg(), patch)
      try {
        localStorage.setItem(CFG_KEY, JSON.stringify(cfgMemo))
      } catch (e) {
        /* 忽略 */
      }
      cfgSubs.forEach((f) => f(cfgMemo))
    }

    function useCfg() {
      const [cfg, setCfg] = useState(readCfg)
      useEffect(() => {
        const fn = (next) => setCfg(next)
        cfgSubs.add(fn)
        return () => cfgSubs.delete(fn)
      }, [])
      return cfg
    }

    /* ───────────── 提示队列（纯函数，便于单测） ───────────── */
    /* @testable:toast-start */
    const TOAST_QUEUE_MAX = 8
    const TOAST_SEEN_MAX = 200

    function toastReducer(state, action) {
      switch (action.type) {
        case 'push': {
          const seen = new Set(state.seen)
          const queue = state.queue.slice()
          let added = 0
          for (const a of action.items || []) {
            const key = String(a.code) + '|' + String(a.at)
            if (seen.has(key)) continue
            seen.add(key)
            queue.push(a)
            added++
          }
          if (!added) return state
          return {
            queue: queue.slice(-TOAST_QUEUE_MAX),
            current: state.current,
            seen: Array.from(seen).slice(-TOAST_SEEN_MAX),
          }
        }
        case 'take': {
          if (state.current || !state.queue.length) return state
          return { queue: state.queue.slice(1), current: state.queue[0], seen: state.seen }
        }
        case 'dismiss':
          return { queue: state.queue, current: null, seen: state.seen }
        default:
          return state
      }
    }

    function toastTtl(alert) {
      if (!alert) return 0
      return alert.level === 'strong' ? 6000 : alert.level === 'major' ? 4500 : 3000
    }
    /* @testable:toast-end */

    /* 详情面板与倒计时暂停是同一个交互状态：
       打开详情 → 暂停倒计时；关闭详情 → **必须**一起解除暂停，
       否则定时器不会恢复，弹条会常驻。这条规则必须由 reducer 保证，
       不能靠两处 setState 各写一行。 */
    /* @testable:detail-start */
    const DETAIL_INIT = { detail: false, paused: false }

    function detailReducer(state, action) {
      switch (action.type) {
        case 'open':
          return { detail: true, paused: true }
        case 'close':
        case 'reset':
          return { detail: false, paused: false }
        case 'hover':
          // 悬停只切换暂停，不能影响详情面板
          return state.detail ? state : { detail: false, paused: !!action.paused }
        default:
          return state
      }
    }
    /* @testable:detail-end */

    /* ───────────── 轮询循环（可单测） ─────────────
       为什么要独立：快速关闭再打开时，旧请求可能比新请求晚返回。
       如果只判断"还活着"，旧结果会覆盖新结果，并且额外排一个定时器，
       变成两个轮询并发。这里用"代次"（generation）解决：
       启动/切换配置/停止都会让代次 +1，旧代次的响应一律丢弃。 */
    /* @testable:poll-start */
    function createRadarLoop(opts) {
      const intervalOpen = opts.intervalOpen || 5000
      const intervalClosed = opts.intervalClosed || 30000
      const s = {
        cfg: null,
        alive: false,
        timer: null,
        gen: 0,
        cfgKey: null,
        abort: null,
        requests: 0,
        applied: 0,
        discarded: 0,
      }

      async function tick() {
        s.timer = null
        const cfg = s.cfg
        if (!cfg || !s.alive) return
        const gen = s.gen
        s.requests += 1
        let interval = intervalClosed
        try {
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          s.abort = controller
          const json = await opts.fetchJson(opts.qsOf(cfg), controller ? controller.signal : undefined)
          s.abort = null
          if (!s.alive || gen !== s.gen) {
            s.discarded += 1 // 旧代次：丢弃结果，也不再排定时器
            return
          }
          s.applied += 1
          if (json && json.ok) {
            interval = json.open === true ? intervalOpen : intervalClosed
            opts.onResult(json)
          } else {
            opts.onError((json && json.error) || '雷达扫描失败')
          }
        } catch (e) {
          s.abort = null
          if ((e && e.name === 'AbortError') || !s.alive || gen !== s.gen) {
            s.discarded += 1
            return
          }
          opts.onError(String((e && e.message) || e))
        }
        if (!s.alive || gen !== s.gen) return
        s.timer = setTimeout(tick, interval)
      }

      return {
        start(cfg) {
          const key = JSON.stringify(cfg)
          // 配置没变且已在运行 → 复用现有轮询。
          // 否则新订阅者（例如刚打开设置页）会废弃一个本来有效的请求，
          // 而那个请求可能已经拿到本轮唯一的弹窗，提醒就这样丢了。
          if (s.alive && s.cfgKey === key) return
          s.cfg = cfg
          s.cfgKey = key
          s.gen += 1 // 确实换了配置，正在飞的请求作废
          if (s.alive) {
            if (!s.timer) s.timer = setTimeout(tick, 0) // 作废那次不会再排，补一个
            return
          }
          s.alive = true
          tick()
        },
        stop() {
          s.alive = false
          s.gen += 1
          if (s.timer) clearTimeout(s.timer)
          s.timer = null
          if (s.abort) {
            try {
              s.abort.abort()
            } catch {
              /* 忽略 */
            }
            s.abort = null
          }
        },
        refresh() {
          if (!s.alive) return
          if (s.timer) clearTimeout(s.timer)
          if (s.abort) {
            try { s.abort.abort() } catch { /* 忽略 */ }
            s.abort = null
          }
          s.timer = setTimeout(tick, 0)
        },
        stats() {
          return {
            alive: s.alive,
            gen: s.gen,
            hasTimer: !!s.timer,
            requests: s.requests,
            applied: s.applied,
            discarded: s.discarded,
            cfgKey: s.cfgKey,
          }
        },
      }
    }
    /* @testable:poll-end */

    /* ───────────── 轮询 ───────────── */

    const EMPTY = {
      at: 0,
      alerts: [],
      positions: [],
      tasks: [],
      recent: [],
      confirmed: [],
      unconfirmed: [],
      date: null,
      since: null,
      historical: 0,
      confirmDay: null,
      confirmWindow: null,
      state: 'idle',
    }

    /* ───────────── 共享轮询 ─────────────
       设置页和右下角提示都读同一份状态，只跑一个请求循环。
       否则两个消费者各拉一次，会互相消耗共享的冷却名额。 */

    const radar = {
      state: EMPTY,
      err: null,
      subs: new Set(),
      /** 真正需要数据的订阅者（活着且已启用） */
      wanted: new Set(),
      /** 真正被弹出过的告警（区别于"服务端已下发"） */
      shown: new Set(),
    }

    const radarNotify = () => {
      for (const fn of Array.from(radar.subs)) fn()
    }

    const radarQs = (cfg) =>
      [
        'op=trend',
        cfg.watch ? 'codes=' + encodeURIComponent(cfg.watch) : '',
        cfg.exclude ? 'exclude=' + encodeURIComponent(cfg.exclude) : '',
        cfg.equity ? 'equity=' + encodeURIComponent(cfg.equity) : '',
        cfg.profile ? 'profile=' + encodeURIComponent(cfg.profile) : '',
      ]
        .filter(Boolean)
        .join('&')

    // 循环本身在 createRadarLoop（可单测），这里只把结果灌进共享状态
    const radarLoop = createRadarLoop({
      qsOf: radarQs,
      fetchJson: async (qs, signal) => {
        const res = await fetch(`${API}?${qs}`, { cache: 'no-store', signal })
        return res.json()
      },
      intervalOpen: 5000,
      intervalClosed: 30000,
      onResult: (json) => {
        radar.state = {
          at: json.at,
          alerts: Array.isArray(json.alerts) ? json.alerts : [],
          positions: Array.isArray(json.positions) ? json.positions : [],
          zeroLots: Array.isArray(json.zeroLots) ? json.zeroLots : [],
          tasks: Array.isArray(json.tasks) ? json.tasks : [],
          recent: Array.isArray(json.recent) ? json.recent : [],
          confirmed: Array.isArray(json.confirmed) ? json.confirmed : [],
          unconfirmed: Array.isArray(json.unconfirmed) ? json.unconfirmed : [],
          date: json.date || null,
          since: json.since || null,
          historical: Number(json.historical) || 0,
          confirmDay: json.confirmDay || null,
          confirmWindow: json.confirmWindow || null,
          confirmPending: !!json.confirmPending,
          profiles: Array.isArray(json.profiles) ? json.profiles : [],
          capRejected: Array.isArray(json.capRejected) ? json.capRejected : [],
          closedManual: Array.isArray(json.closedManual) ? json.closedManual : [],
          refreshFailures: Number(json.refreshFailures) || 0,
          profile: json.profile || 'C1',
          state: json.state || 'idle',
        }
        radar.err = null
        radarNotify()
      },
      onError: (msg) => {
        radar.err = msg
        radarNotify()
      },
    })

    const radarStart = (cfg) => {
      radarLoop.start(cfg)
      radarNotify()
    }
    const radarStop = () => radarLoop.stop()

    /** 记录"这条确实被弹出来了"，供历史面板区分已下发/已展示 */
    function markShown(alert) {
      if (alert) radar.shown.add(String(alert.code) + '|' + String(alert.at))
    }

    function useRadarScan(cfg, active) {
      const [, force] = useReducer((x) => x + 1, 0)
      const token = useRef(null)
      if (!token.current) token.current = Symbol('radar-sub')
      const dep = [active, cfg.watch, cfg.exclude, cfg.equity, cfg.profile].join('|')

      useEffect(() => {
        radar.subs.add(force)
        return () => {
          radar.subs.delete(force)
          // 卸载时也要把自己从"想要数据"的集合里移除，
          // 否则插件关闭后定时器仍会继续请求
          radar.wanted.delete(token.current)
          if (!radar.wanted.size) radarStop()
        }
      }, [])

      useEffect(() => {
        // 只有「组件活着 + 已启用」的订阅者才算真的需要数据
        const want = !!active
        if (want) {
          radar.wanted.add(token.current)
          radarStart({
            watch: cfg.watch,
            exclude: cfg.exclude,
            equity: cfg.equity,
            profile: cfg.profile,
          })
        } else {
          radar.wanted.delete(token.current)
          if (!radar.wanted.size) radarStop()
        }
      }, [dep])

      return { state: radar.state, err: radar.err, shown: radar.shown, refresh: () => radarLoop.refresh() }
    }

    /* ───────────── 文案 ───────────── */

    /* @testable:text-start */
    const DIR_TEXT = { up: '拉升', down: '跳水', flat: '放量' }
    const DIR_ARROW = { up: '↑', down: '↓', flat: '·' }
    const KIND_TEXT = { trigger: '触发', confirm: '确认', stop: '止损', tp: '止盈', exit: '平仓' }
    const STATE_TEXT = { running: '运行中', warming: '预热中', stale: '数据过期', closed: '休市', idle: '待信号' }

    /** 「发生了什么」：趋势提醒直接读服务端给的 text；旧爆发提醒退回指标拼接 */
    function whatHappened(alert) {
      if (alert && alert.text) return alert.text
      const why = alert.why || {}
      const bits = []
      if (why.breakout) bits.push(alert.dir === 'down' ? '跌破前低' : '突破前高')
      if (why.volZ >= 1.5) bits.push('放量')
      if (why.rangeZ >= 1.5) bits.push('波动扩大')
      if (alert.dims && alert.dims.indexOf('burst') >= 0) bits.push('连续跳')
      if (why.oiZ >= 1.5) bits.push(why.oiRecent > 0 ? '增仓' : '减仓')
      return bits.length ? bits.join(' · ') : '量价异动'
    }

    const pctText = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '')
    const pad2 = (n) => String(n).padStart(2, '0')
    /** 把时间字段解析成 Date：数字=时间戳，字符串=ISO/本地时间 */
    const toDate = (at) => {
      if (at === null || at === undefined || at === '') return null
      const d = typeof at === 'number' ? new Date(at) : new Date(String(at).replace(' ', 'T'))
      return Number.isNaN(d.getTime()) ? null : d
    }
    // 一律按**本地时区**格式化，不能截取 UTC 字符串（否则 14:20 会显示成 06:20）
    const timeText = (at) => {
      const d = toDate(at)
      return d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : ''
    }
    const dateTimeText = (at) => {
      const d = toDate(at)
      return d ? pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : ''
    }
    /* @testable:text-end */

    /* ───────────── 样式 ───────────── */

    const STYLE = `
      .frr-dock{position:fixed;right:14px;bottom:16px;z-index:60;display:flex;flex-direction:column;
        align-items:flex-end;gap:6px;pointer-events:none;font-size:11.5px;line-height:1.5}
      .frr-wrap{pointer-events:auto;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
      .frr-pill{display:inline-flex;align-items:center;gap:6px;max-width:420px;min-width:0;
        padding:3px 6px 3px 8px;border-radius:8px;cursor:pointer;
        background:color-mix(in srgb, var(--dsw-alias-bg-l1,#1b1c1f) 90%, transparent);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
        color:var(--dsw-alias-label-secondary,#9aa0a8);white-space:nowrap;overflow:hidden;
        -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);animation:frr-in .16s ease}
      .frr-pill:hover,.frr-pill:focus-visible{color:var(--dsw-alias-label-primary,#e6e8eb);
        outline:none;border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.18))}
      .frr-dot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-label-quaternary,#6b7280)}
      .frr-name{color:var(--dsw-alias-label-tertiary,#868c94)}
      .frr-why{color:var(--dsw-alias-label-quaternary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
      .frr-dir{font-weight:500}
      .frr-meta{color:var(--dsw-alias-label-quaternary,#6b7280);font-variant-numeric:tabular-nums}
      .frr-major{color:var(--dsw-alias-label-primary,#e6e8eb);
        border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#b45309) 42%, transparent)}
      .frr-major .frr-dot{background:var(--dsw-alias-state-warn-primary,#b45309)}
      .frr-strong{border-color:var(--dsw-alias-state-warn-primary,#b45309)}
      /* 品种匹配提示：可点的候选代码 */
      .frr-matches{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:-2px 0 2px 84px}
      .frr-chip{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
        background:transparent;color:var(--dsw-alias-label-tertiary,#868c94);
        font:inherit;font-size:11px;padding:1px 7px;border-radius:10px;cursor:pointer}
      .frr-chip:hover,.frr-chip:focus-visible{color:var(--dsw-alias-label-primary,#e6e8eb);
        border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.18))}
      .frr-chip-dim{opacity:.55;border-style:dashed}
      .frr-x{border:0;background:transparent;color:inherit;opacity:.45;cursor:pointer;
        font:inherit;font-size:11px;line-height:1;padding:2px 3px;border-radius:4px}
      .frr-x:hover,.frr-x:focus-visible{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
      .frr-card{width:300px;padding:10px 11px;border-radius:10px;
        background:color-mix(in srgb, var(--dsw-alias-bg-l1,#1b1c1f) 96%, transparent);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
        color:var(--dsw-alias-label-secondary,#9aa0a8);white-space:normal;
        font-size:12px;line-height:1.7;box-shadow:0 6px 20px rgba(0,0,0,.28)}
      .frr-card-head{display:flex;align-items:baseline;gap:6px;margin-bottom:4px}
      .frr-card-title{color:var(--dsw-alias-label-primary,#e6e8eb);font-size:12px;font-weight:600}
      .frr-card-sub{color:var(--dsw-alias-label-quaternary,#6b7280);font-size:10px}
      .frr-kv{display:flex;gap:6px}
      .frr-kv>span:first-child{color:var(--dsw-alias-label-quaternary,#6b7280);width:60px;flex:none}
      .frr-spark{display:block;margin:4px 0 2px}
      .frr-state{pointer-events:none;font-size:10px;color:var(--dsw-alias-label-quaternary,#6b7280);
        background:color-mix(in srgb, var(--dsw-alias-bg-l1,#1b1c1f) 82%, transparent);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));
        border-radius:6px;padding:1px 6px}
      @keyframes frr-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
      @media (prefers-reduced-motion: reduce){.frr-pill{animation:none}}
      /* ── 主页面：居中容器 + 卡片分区 ── */
      .frr-page{box-sizing:border-box;width:min(100%,960px);max-width:960px;margin:0 auto;flex:0 1 auto;
        padding:14px 16px 28px;font-size:13px;line-height:1.6;
        height:100%;min-height:0;max-height:100%;overflow-y:auto;overflow-x:hidden;
        overscroll-behavior:contain;scrollbar-gutter:stable;
        scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.22) transparent;
        color:var(--dsw-alias-label-secondary,#9aa0a8)}
      .frr-page::-webkit-scrollbar{width:10px}
      .frr-page::-webkit-scrollbar-track{background:transparent}
      .frr-page::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:999px;
        border:2px solid transparent;background-clip:padding-box}
      .frr-page::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.28);background-clip:padding-box}
      /* 首屏优先：操作与手动确认放最前，别的卡片按原顺序排后 */
      .frr-priority-1{order:-3}
      .frr-priority-2{order:-2}
      .frr-page *{box-sizing:border-box}
      .frr-head{display:flex;align-items:center;gap:16px;
        padding:2px 2px 10px;margin-bottom:12px;
        border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}
      .frr-head-main{min-width:0;flex:1 1 auto}
      .frr-set-title{color:var(--dsw-alias-label-primary);font-weight:600;font-size:17px;letter-spacing:.01em}
      .frr-set-desc{color:var(--dsw-alias-label-quaternary);font-size:12px;line-height:1.6;margin-top:4px;max-width:620px}
      .frr-tabs{display:inline-flex;gap:3px;padding:3px;border-radius:10px;flex:none;
        background:var(--dsw-alias-bg-l2,rgba(255,255,255,.04));
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
      .frr-tab{font:inherit;font-size:12.5px;padding:5px 16px;border:0;border-radius:7px;cursor:pointer;
        background:transparent;color:var(--dsw-alias-label-tertiary,#868c94)}
      .frr-tab.is-on{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));
        color:var(--dsw-alias-label-primary,#e6e8eb)}
      .frr-tab:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}
      .frr-badges{display:flex;flex-wrap:nowrap;gap:6px;margin:0 0 12px;align-items:center;
        overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
      .frr-badges::-webkit-scrollbar{display:none}
      .frr-badges>*{flex:none}
      .frr-badge{display:inline-flex;align-items:baseline;gap:7px;padding:6px 11px;border-radius:8px;
        background:var(--dsw-alias-bg-l1,#1b1c1f);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));font-size:11.5px}
      .frr-badge b{color:var(--dsw-alias-label-primary,#e6e8eb);font-weight:600;font-size:13px;font-variant-numeric:tabular-nums}
      .frr-badge span{color:var(--dsw-alias-label-quaternary,#6b7280)}
      .frr-badge.warn b{color:#e8a44c}
      /* 固定两栏 + 同行等高：列数与行高都不随容器宽度跳变，模块间不留参差空隙 */
      .frr-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:stretch}
      .frr-panel{display:flex;flex-direction:column;background:var(--dsw-alias-bg-l1,#1b1c1f);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09));
        border-radius:12px;padding:12px 14px;min-width:0}
      .frr-panel.wide{grid-column:1/-1}
      .frr-panel-head{display:flex;align-items:center;gap:9px;margin-bottom:8px;
        padding-bottom:9px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.06))}
      .frr-panel-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e8eb);letter-spacing:.03em}
      .frr-panel-count{font-size:11px;color:var(--dsw-alias-label-quaternary,#6b7280);
        font-variant-numeric:tabular-nums;margin-left:auto}
      .frr-list{display:flex;flex-direction:column}
      .frr-list.scroll{max-height:320px;overflow:auto}
      .frr-item{padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.055))}
      .frr-item:first-child{padding-top:2px}
      .frr-item:last-child{border-bottom:0;padding-bottom:2px}
      .frr-item-main{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
      .frr-item-name{font-weight:600;color:var(--dsw-alias-label-primary,#e6e8eb);font-size:13px}
      .frr-item-meta{display:block;margin-top:4px;color:var(--dsw-alias-label-quaternary,#6b7280);
        font-size:11.5px;line-height:1.65;font-variant-numeric:tabular-nums}
      .frr-empty{flex:1 1 auto;display:flex;align-items:center;justify-content:center;min-height:56px;
        padding:14px 4px;color:var(--dsw-alias-label-quaternary,#6b7280);font-size:12px;text-align:center}
      .frr-rejected{opacity:.62}
      .frr-up{color:#f05a5a}
      .frr-down{color:#3fbf7f}
      .frr-tag{display:inline-block;font-size:11px;line-height:1.5;padding:1px 8px;border-radius:999px;
        color:var(--dsw-alias-label-tertiary,#868c94);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))}
      .frr-field{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
      .frr-field:last-child{margin-bottom:0}
      .frr-field-label{width:76px;flex:none;color:var(--dsw-alias-label-tertiary,#868c94);font-size:12.5px}
      .frr-field-ctrl{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1;min-width:0}
      .frr-page input,.frr-page select{font:inherit;font-size:12.5px;padding:5px 9px;border-radius:7px;
        background:var(--dsw-alias-bg-l2,rgba(255,255,255,.04));
        color:var(--dsw-alias-label-primary,#e6e8eb);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))}
      .frr-page input[type=text]{width:210px}
      .frr-page input[type=number]{width:140px}
      .frr-page button{font:inherit;font-size:12px;padding:5px 11px;border-radius:7px;cursor:pointer;
        background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
        color:var(--dsw-alias-label-tertiary,#868c94);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
      .frr-page button:hover,.frr-page button:focus-visible{color:var(--dsw-alias-label-primary,#e6e8eb)}
      .frr-chip-on{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12));
        color:var(--dsw-alias-label-primary,#e6e8eb);border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.26))}
      .frr-savebar{grid-column:1/-1;display:flex;align-items:center;gap:8px;padding-top:2px}
      .frr-primary{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.14)) !important;
        color:var(--dsw-alias-label-primary,#e6e8eb) !important;border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.28)) !important}
      .frr-savebar button:disabled{opacity:.45;cursor:not-allowed}
      .frr-manual-list{display:flex;flex-direction:column;gap:8px}
      .frr-manual{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;
        padding:8px 10px;background:var(--dsw-alias-bg-l2,rgba(255,255,255,.03))}
      .frr-manual-fields{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
      .frr-manual-fields label{display:flex;align-items:center;gap:4px;font-size:12px;
        color:var(--dsw-alias-label-quaternary,#6b7280)}
      .frr-manual-fields input{width:100px;font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;
        background:var(--dsw-alias-bg-l1,#1b1c1f);color:var(--dsw-alias-label-primary,#e6e8eb);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
      .frr-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
      .frr-action{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;
        padding:8px 10px;background:var(--dsw-alias-bg-l2,rgba(255,255,255,.03))}
      .frr-action-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
      .frr-action-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px 12px;margin-top:6px;font-size:12px}
      .frr-action-grid span{display:flex;gap:6px;min-width:0}
      .frr-action-grid i{color:var(--dsw-alias-label-quaternary,#6b7280);font-style:normal;flex:none}
      /* 价位允许换行，避免止盈等长数字被省略号截断 */
      .frr-action-grid b{color:var(--dsw-alias-label-primary,#e6e8eb);font-weight:500;
        font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
      .frr-hint{color:var(--dsw-alias-label-quaternary,#6b7280);font-size:11.5px;line-height:1.6}
      .frr-matches{display:flex;align-items:center;gap:6px;flex-wrap:wrap;width:100%;margin-top:2px}
      .frr-note{color:var(--dsw-alias-label-quaternary,#6b7280);font-size:11.5px;line-height:1.7;margin:0 0 10px}
      .frr-err{margin-top:14px;padding:9px 12px;border-radius:8px;font-size:12px;
        color:#e88a7a;background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e05252) 10%, transparent);
        border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary,#e05252) 30%, transparent)}
      @media (max-width:720px){
        .frr-page{padding:10px 10px 20px}
        .frr-head{flex-direction:column;align-items:stretch}
        .frr-field-label{width:100%}
        .frr-grid,.frr-actions{grid-template-columns:1fr}
      }
      @media (min-width:721px) and (max-width:860px){
        .frr-actions{grid-template-columns:repeat(2,minmax(0,1fr))}
      }
    `

    function Styles() {
      return h('style', { 'data-frr-style': 'futures-radar', dangerouslySetInnerHTML: { __html: STYLE } })
    }

    /* ───────────── 价格小图 ───────────── */

    function Spark(props) {
      const data = (props.values || []).filter((v) => Number.isFinite(v))
      if (data.length < 3) return null
      const w = 258
      const ht = 34
      const min = Math.min(...data)
      const max = Math.max(...data)
      const span = max - min || 1
      const pts = data
        .map((v, i) => {
          const x = (i / (data.length - 1)) * (w - 2) + 1
          const y = ht - 2 - ((v - min) / span) * (ht - 4)
          return x.toFixed(1) + ',' + y.toFixed(1)
        })
        .join(' ')
      const up = data[data.length - 1] >= data[0]
      return h(
        'svg',
        {
          className: 'frr-spark',
          width: w,
          height: ht,
          viewBox: `0 0 ${w} ${ht}`,
          role: 'img',
          'aria-label': '近 40 个采样的价格走势',
        },
        h('polyline', {
          points: pts,
          fill: 'none',
          stroke: up ? '#f05a5a' : '#3fbf7f',
          'stroke-width': '1.2',
          'stroke-linejoin': 'round',
        }),
      )
    }

    /* ───────────── 详情卡 ───────────── */

    function DetailCard(props) {
      const a = props.alert
      const rows = [
        ['事件', whatHappened(a)],
        ['类型', KIND_TEXT[a.kind] || '—'],
        ['方向', (DIR_ARROW[a.dir] || '') + ' ' + (DIR_TEXT[a.dir] || '')],
        Number.isFinite(a.triggerPrice) ? ['触发位', a.triggerPrice.toFixed(2)] : null,
        Number.isFinite(a.stopPrice) ? ['止损位', a.stopPrice.toFixed(2)] : null,
        Number.isFinite(a.tpPrice) ? ['止盈位', a.tpPrice.toFixed(2)] : null,
        Number.isFinite(a.gapPct) ? ['距离', a.gapPct.toFixed(2) + '%'] : null,
        ['时间', dateTimeText(a.at) || '—'],
      ].filter(Boolean)

      return h(
        'div',
        { className: 'frr-card', role: 'dialog', 'aria-label': '提醒详情', onKeyDown: (e) => { if (e.key === 'Escape') props.onClose() } },
        h(
          'div',
          { className: 'frr-card-head' },
          h('span', { className: 'frr-card-title' }, a.name || a.code),
          h('span', { className: 'frr-card-sub' }, a.code),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { className: 'frr-x', title: '关闭详情', 'aria-label': '关闭详情', onClick: props.onClose }, '✕'),
        ),
        h(Spark, { values: a.spark }),
        rows.map(([k, v]) => h('div', { className: 'frr-kv', key: k }, h('span', null, k), h('span', null, v))),
      )
    }

    /* ───────────── 右下角提示 ───────────── */

    function Pill(props) {
      const a = props.alert
      const movePct = a.pctFast
      return h(
        'div',
        {
          className: 'frr-pill frr-' + (a.level || 'minor'),
          role: 'button',
          tabIndex: 0,
          'aria-label': `${a.name || a.code} ${DIR_TEXT[a.dir] || '异动'} ${pctText(movePct)}，按回车查看详情`,
          onClick: props.onOpen,
          // 悬停/聚焦暂停倒计时，移开继续；详情开着时不受悬停影响（由 reducer 保证）
          onMouseEnter: () => props.onHover && props.onHover(true),
          onMouseLeave: () => props.onHover && props.onHover(false),
          onFocus: () => props.onHover && props.onHover(true),
          onBlur: () => props.onHover && props.onHover(false),
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
              e.preventDefault()
              props.onOpen()
            }
          },
        },
        h('i', { className: 'frr-dot' }),
        h('span', { className: 'frr-name' }, a.kind ? (KIND_TEXT[a.kind] || a.kind) : (DIR_ARROW[a.dir] || '')),
        h('span', { className: 'frr-name' }, a.name || a.code),
        Number.isFinite(movePct) ? h('span', null, pctText(movePct)) : null,
        h('span', { className: 'frr-why' }, whatHappened(a)),
        a.sectorActive >= 2 && a.sector
          ? h('span', { className: 'frr-tag' }, a.sector + '×' + a.sectorActive)
          : null,
        h('span', { className: 'frr-meta' }, timeText(a.at)),
        h(
          'button',
          {
            className: 'frr-x',
            title: '关闭',
            'aria-label': '关闭提示',
            onClick: (e) => {
              e.stopPropagation()
              props.onClose()
            },
          },
          '✕',
        ),
      )
    }

    function RadarDock() {
      const cfg = useCfg()
      const { state, err } = useRadarScan(cfg, true)
      const [toast, dispatch] = useReducer(toastReducer, { queue: [], current: null, seen: [] })
      const [ui, dispatchUi] = useReducer(detailReducer, DETAIL_INIT)
      const detail = ui.detail
      const paused = ui.paused
      const pausedUntil = cfg.pauseUntil || 0

      // 新事件入队（暂停期间只入历史，不打扰）
      useEffect(() => {
        if (!state.alerts || !state.alerts.length) return
        if (pausedUntil > Date.now()) return
        dispatch({ type: 'push', items: state.alerts })
      }, [state.at, pausedUntil])

      // 「已弹出」必须在它真正成为当前展示项时才登记。
      // 写在入队处会提前标脏：前一条还开着详情时，后一条会被误标成"已弹出"。
      useEffect(() => {
        if (toast.current) markShown(toast.current)
      }, [toast.current])

      useEffect(() => {
        if (toast.current || !toast.queue.length) return
        dispatch({ type: 'take' })
      }, [toast.current, toast.queue.length])

      // 倒计时：只依赖 current 与暂停状态；打开详情时不倒计时
      useEffect(() => {
        const cur = toast.current
        if (!cur || paused || detail) return undefined
        const timer = setTimeout(() => dispatch({ type: 'dismiss' }), toastTtl(cur))
        return () => clearTimeout(timer)
      }, [toast.current, paused, detail])

      useEffect(() => {
        dispatchUi({ type: 'reset' })
      }, [toast.current])

      // Esc 收起详情（reducer 保证同时解除暂停）
      useEffect(() => {
        if (!detail) return undefined
        const onKey = (e) => {
          if (e.key === 'Escape') dispatchUi({ type: 'close' })
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [detail])

      const closeDetail = () => dispatchUi({ type: 'close' })

      // 只在有信号（toast）或错误时显示，不再常驻右下角
      if (!toast.current && !err) return null

      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'div',
          { className: 'frr-dock' },
          toast.current
            ? h(
                'div',
                { className: 'frr-wrap' },
                detail ? h(DetailCard, { alert: toast.current, onClose: closeDetail }) : null,
                h(Pill, {
                  alert: toast.current,
                  onOpen: () => dispatchUi({ type: 'open' }),
                  onHover: (v) => dispatchUi({ type: 'hover', paused: v }),
                  onClose: () => {
                    closeDetail()
                    dispatch({ type: 'dismiss' })
                  },
                }),
              )
            : null,
          err
            ? h(
                'div',
                { className: 'frr-pill' },
                h('i', { className: 'frr-dot' }),
                h('span', { className: 'frr-name' }, '雷达：' + err),
              )
            : null,
        ),
      )
    }

    /* ───────────── 设置页 ───────────── */

    // 纯展示组件放在 RadarPage 外面：否则每次 setState 生成新组件类型，
    // 输入框会被 React 卸载重建，表现为每输一位就丢焦点。
    const dirCls = (d) => (d > 0 ? 'frr-up' : d < 0 ? 'frr-down' : '')
    const Section = ({ title, count, wide, className, children }) =>
      h('section', { className: 'frr-panel' + (wide ? ' wide' : '') + (className ? ' ' + className : '') },
        h('div', { className: 'frr-panel-head' },
          h('span', { className: 'frr-panel-title' }, title),
          count != null ? h('span', { className: 'frr-panel-count' }, String(count)) : null,
        ),
        children,
      )
    const Item = ({ name, dir, meta, rejected, tag }) =>
      h('div', { className: 'frr-item' + (rejected ? ' frr-rejected' : '') },
        h('div', { className: 'frr-item-main' },
          h('span', { className: 'frr-item-name ' + dirCls(dir) }, name),
          tag || null,
        ),
        meta ? h('div', { className: 'frr-item-meta' }, meta) : null,
      )
    const Empty = ({ children }) => h('div', { className: 'frr-empty' }, children)

    function RadarPage() {
      const cfg = useCfg()
      const [tab, setTab] = useState('signals')
      const { state, err, shown, refresh } = useRadarScan(cfg, true)
      const [watchDraft, setWatchDraft] = useState(cfg.watch || '')
      const [excludeDraft, setExcludeDraft] = useState(cfg.exclude || '')
      const [equityDraft, setEquityDraft] = useState(cfg.equity ? String(cfg.equity) : '')
      const [profileDraft, setProfileDraft] = useState(cfg.profile || 'C1')
      const [manualDrafts, setManualDrafts] = useState({})
      const [manualMsg, setManualMsg] = useState('')
      const [varieties, setVarieties] = useState([])

      // 配置只改草稿，点“保存配置”才写入；权益输入不再失焦提交
      useEffect(() => {
        setEquityDraft(cfg.equity ? String(cfg.equity) : '')
        setProfileDraft(cfg.profile || 'C1')
        setWatchDraft(cfg.watch || '')
        setExcludeDraft(cfg.exclude || '')
      }, [cfg.equity, cfg.profile, cfg.watch, cfg.exclude])

      const normalized = (v) => String(v ?? '').trim()
      const cfgDirty = Number(equityDraft) !== Number(cfg.equity || 0) ||
        profileDraft !== (cfg.profile || 'C1') ||
        normalized(watchDraft) !== normalized(cfg.watch) ||
        normalized(excludeDraft) !== normalized(cfg.exclude)
      const saveCfg = () => writeCfg({
        equity: Number(equityDraft) || 0,
        profile: profileDraft,
        watch: normalized(watchDraft),
        exclude: normalized(excludeDraft),
      })
      const resetCfgDrafts = () => {
        setEquityDraft(cfg.equity ? String(cfg.equity) : '')
        setProfileDraft(cfg.profile || 'C1')
        setWatchDraft(cfg.watch || '')
        setExcludeDraft(cfg.exclude || '')
      }

      // 品种目录只拉一次：用来支持"按名称找代码"（输中文也能搜到）
      useEffect(() => {
        let alive = true
        fetch(`${API}?op=catalog`, { cache: 'no-store' })
          .then((r) => r.json())
          .then((j) => {
            if (alive && j && j.ok && Array.isArray(j.items)) setVarieties(j.items)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])

      /** 按代码或中文名筛选品种；拿最后一段（逗号分隔）去匹配 */
      const matchVarieties = (text) => {
        const raw = String(text || '').trim()
        if (!raw) return []
        const parts = raw.split(/[,，\s]+/).filter(Boolean)
        const q = (parts.length ? parts[parts.length - 1] : raw).toUpperCase()
        return varieties
          .filter((v) => {
            const name = String(v.name || '') + String(v.label || '')
            return v.code.toUpperCase().includes(q) || name.toUpperCase().includes(q)
          })
          .slice(0, 6)
      }

      /** 匹配结果做成可点的小标签，点一下就把代码填进输入框 */
      const matchHint = (text, apply) => {
        const hits = matchVarieties(text)
        if (!hits.length) return null
        return h(
          'div',
          { className: 'frr-matches' },
          h('span', { className: 'frr-hint' }, '匹配：'),
          ...hits.map((v) =>
            h(
              'button',
              {
                key: v.code,
                className: 'frr-chip' + (v.liquid === false ? ' frr-chip-dim' : ''),
                title: v.liquid === false ? '低流动性，默认不跟踪' : v.name,
                onClick: () => apply(v.code),
              },
              (v.label || v.name) + ' ' + v.code,
            ),
          ),
        )
      }

      const [busy, setBusy] = useState(false)

      useEffect(() => {
        setWatchDraft(cfg.watch || '')
        setExcludeDraft(cfg.exclude || '')
      }, [cfg.watch, cfg.exclude])

      const pauseUntil = cfg.pauseUntil || 0
      const pausedLeft = pauseUntil > Date.now() ? Math.ceil((pauseUntil - Date.now()) / 60000) : 0
      const stateText = STATE_TEXT[state.state] || '未知'
      const positions = state.positions || []
      const zeroLots = state.zeroLots || []
      const tasks = state.tasks || []
      const recent = state.recent || []
      const closedManual = state.closedManual || []
      const confirmed = state.confirmed || []
      const rankOf = new Map(confirmed.map((c) => [c.code, c.rank]))
      const unconfirmed = state.unconfirmed || []
      const manualCodes = new Set(positions.map((p) => p.code))
      // 把「明日任务」和「收盘确认」合成一张可执行卡片：方向、手数、开仓、止损、止盈、风险
      // 已手动确认的品种不再重复显示开仓任务
      const actionRows = tasks
        .filter((t) => !(manualCodes.has(t.code) && (t.action === 'open' || t.action === 'reverse')))
        .map((t) => {
        const c = confirmed.find((x) => x.code === t.code && (x.channel || 'main') === (t.channel || 'main'))
        const entry = Number.isFinite(c?.entryRef) ? c.entryRef : (Number.isFinite(c?.closeMain) ? c.closeMain : t.close)
        const stop = Number.isFinite(c?.stop) ? c.stop : (Number.isFinite(c?.estStop) ? c.estStop : null)
        const risk = Number.isFinite(entry) && Number.isFinite(stop) ? Math.abs(entry - stop) : null
        const tp1 = risk ? entry + (t.dir > 0 ? risk : -risk) : null
        const tp2 = risk ? entry + (t.dir > 0 ? 2 * risk : -2 * risk) : null
        return { ...t, c, entry, stop, risk, tp1, tp2, lots: Number.isFinite(c?.lots) ? c.lots : null, riskYuan: c?.riskYuan ?? null }
      })
      const dirText = (d) => (d > 0 ? '多' : '空')
      const manualCandidates = confirmed
        .filter((c) => c.accepted !== false && Number(c.lots) > 0 && !manualCodes.has(c.code))
        .sort((a, b) => (Number(b.vr) || 0) - (Number(a.vr) || 0))
      const draftOf = (c) => manualDrafts[c.code] || {}
      const setDraft = (code, patch) => setManualDrafts((prev) => ({ ...prev, [code]: { ...(prev[code] || {}), ...patch } }))
      const confirmManual = async (c) => {
        const d = draftOf(c)
        const entry = Number(d.entry ?? c.entryRef ?? c.closeMain)
        const lots = Number(d.lots ?? c.lots)
        const stop = Number(c.stop ?? c.estStop)
        if (!(entry > 0) || !(lots > 0) || !(stop > 0)) { setManualMsg('买入价/手数无效'); return }
        const qs = new URLSearchParams({
          op: 'trend', manual: 'open', code: c.code, name: c.name || '',
          dir: String(c.dir), entryPrice: String(entry), stop: String(stop),
          lots: String(Math.floor(lots)), equity: String(cfg.equity || 0), profile: cfg.profile || 'C1',
        })
        if (cfg.watch) qs.set('codes', cfg.watch)
        if (cfg.exclude) qs.set('exclude', cfg.exclude)
        try {
          const res = await fetch(`${API}?${qs.toString()}`, { cache: 'no-store' })
          const j = await res.json()
          if (!j.ok) { setManualMsg(`确认失败：${j.error || '未知错误'}`); return }
          setManualMsg(`已确认 ${c.name || c.code} ${dirText(c.dir)} @${entry} · ${Math.floor(lots)} 手`)
          setManualDrafts((prev) => { const next = { ...prev }; delete next[c.code]; return next })
          refresh()
        } catch (e) {
          setManualMsg('确认失败：' + String(e.message || e))
        }
      }

      const closeManual = async (p) => {
        const raw = window.prompt(`平仓价（${p.name || p.code}，入场 ${p.entryPrice}）`, String(p.entryPrice))
        if (raw == null) return
        const exitPrice = Number(raw)
        if (!(exitPrice > 0)) { setManualMsg('平仓价无效'); return }
        const qs = new URLSearchParams({
          op: 'trend', manual: 'close', id: p.id, exitPrice: String(exitPrice),
          equity: String(cfg.equity || 0), profile: cfg.profile || 'C1',
        })
        if (cfg.watch) qs.set('codes', cfg.watch)
        if (cfg.exclude) qs.set('exclude', cfg.exclude)
        try {
          const res = await fetch(`${API}?${qs.toString()}`, { cache: 'no-store' })
          const j = await res.json()
          if (!j.ok) { setManualMsg(`平仓失败：${j.error || '未知错误'}`); return }
          setManualMsg(`已平仓 ${p.name || p.code} @${exitPrice}`)
          refresh()
        } catch (e) {
          setManualMsg('平仓失败：' + String(e.message || e))
        }
      }

      // 顶部状态徽章：把原来一长串 "·" 拼接拆成独立可读的指标。
      const badges = [
        { label: '状态', value: stateText, warn: state.state === 'stale' || state.state === 'closed' },
        { label: '权益', value: cfg.equity ? `${(cfg.equity / 10000).toFixed(0)} 万` : '未设置', warn: !cfg.equity },
        state.date ? { label: '数据日', value: state.date } : null,
        { label: '持仓', value: `${positions.length}/8` },
        state.since ? { label: '监控起点', value: state.since } : null,
        state.historical ? { label: '历史未监控', value: state.historical, warn: true } : null,
        state.refreshFailures ? { label: '刷新失败', value: state.refreshFailures, warn: true } : null,
        tasks.length ? { label: '明日任务', value: tasks.length } : null,
        pausedLeft ? { label: '已暂停', value: `${pausedLeft} 分钟`, warn: true } : null,
      ].filter(Boolean)

      return h(
        'div',
        { className: 'frr-page' },
        h(Styles),

        h(
          'div',
          { className: 'frr-head' },
          h(
            'div',
            { className: 'frr-head-main' },
            h('div', { className: 'frr-set-title' }, '趋势雷达'),
            h(
              'div',
              { className: 'frr-set-desc' },
              '加权指数日线突破策略：盘后出任务，盘中提醒触发 / 收盘确认 / 止损止盈。本地计算，数据来自东财与新浪。',
            ),
          ),
          h(
            'div',
            { className: 'frr-tabs' },
            h('button', { className: 'frr-tab' + (tab === 'signals' ? ' is-on' : ''), onClick: () => setTab('signals') }, '信号'),
            h('button', { className: 'frr-tab' + (tab === 'config' ? ' is-on' : ''), onClick: () => setTab('config') }, '配置'),
          ),
        ),

        tab === 'signals'
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'frr-badges' },
                badges.map((b, i) =>
                  h('span', { key: i, className: 'frr-badge' + (b.warn ? ' warn' : '') },
                    h('span', null, b.label), h('b', null, String(b.value))),
                ),
                h(
                  'button',
                  { style: { marginLeft: 'auto' }, onClick: () => writeCfg({ pauseUntil: pausedLeft ? 0 : Date.now() + 30 * 60 * 1000 }) },
                  pausedLeft ? '恢复提醒' : '暂停 30 分钟',
                ),
              ),
              h(
                'div',
                { className: 'frr-grid' },
                h(
                  Section,
                  { title: '当前持仓', count: positions.length },
                  h(
                    'div',
                    { className: 'frr-list' },
                    positions.length
                      ? positions.map((p) =>
                          h(Item, {
                            key: p.code + p.entryDate,
                            name: `${p.name || p.code} ${dirText(p.dir)}`,
                            dir: p.dir,
                            tag: p.manual ? h('button', { className: 'frr-x', onClick: () => closeManual(p) }, '平仓') : null,
                            meta: [
                              `入场 ${p.entryDate} @${Number(p.entryMain ?? p.entryPrice).toFixed(2)}${Number.isFinite(p.entryMain) ? '（主连）' : ''}${p.backfilled ? ' · 补算' : ''}`,
                              Number.isFinite(p.stopMain ?? p.stopPrice) ? `止损 ${Number(p.stopMain ?? p.stopPrice).toFixed(2)}` : null,
                              Number.isFinite(p.weightPct) ? `仓位 ${p.weightPct.toFixed(0)}%` : null,
                              Number.isFinite(p.lots) ? `约 ${p.lots} 手${p.unverified ? '（乘数待核）' : ''}` : null,
                            ].filter(Boolean).join(' · '),
                          }),
                        )
                      : h(Empty, null, state.since ? `自 ${state.since} 起无新开仓` : '空仓'),
                  ),
                ),

                closedManual.length
                  ? h(
                      Section,
                      { title: '手动回顾', count: closedManual.length },
                      h('div', { className: 'frr-list' },
                        closedManual.slice().reverse().map((p) =>
                          h(Item, {
                            key: p.id,
                            name: `${p.name || p.code} ${dirText(p.dir)}`,
                            dir: p.dir,
                            meta: `${p.entryDate} @${Number(p.entryPrice).toFixed(2)} → ${p.exitDate} @${Number(p.exitPrice).toFixed(2)} · ${p.pnlPct > 0 ? '+' : ''}${Number(p.pnlPct).toFixed(2)}%`,
                          }),
                        ),
                      ),
                    )
                  : null,

                zeroLots.length
                  ? h(
                      Section,
                      { title: '0 手信号', count: zeroLots.length },
                      h('div', { className: 'frr-list' },
                        zeroLots.map((z) =>
                          h(Item, {
                            key: z.code + z.entryDate,
                            name: `${z.name || z.code} ${dirText(z.dir)}`,
                            dir: z.dir,
                            meta: `${z.entryDate} @${Number(z.entryPrice).toFixed(2)} · ${z.reason || '0 手'} · 未开仓${z.backfilled ? '（补算）' : ''}`,
                          }),
                        ),
                      ),
                    )
                  : null,

                (state.capRejected || []).length
                  ? h(
                      Section,
                      { title: '组合剔除', count: state.capRejected.length },
                      h('div', { className: 'frr-list' },
                        state.capRejected.map((p) =>
                          h(Item, {
                            key: p.code + p.entryDate,
                            name: `${p.name || p.code} ${dirText(p.dir)}`,
                            dir: p.dir,
                            rejected: true,
                            meta: p.reason || '超出组合上限',
                          }),
                        ),
                      ),
                    )
                  : null,

                h(
                  Section,
                  { title: '明日操作', count: actionRows.length, wide: true, className: 'frr-priority-1' },
                  h('p', { className: 'frr-note' }, state.confirmWindow
                    ? `执行：${state.confirmWindow}；低开超过参考价 0.5% 不追`
                    : '明日开盘执行；低开超过参考价 0.5% 不追'),
                  h(
                    'div',
                    { className: 'frr-actions' },
                    actionRows.length
                      ? actionRows.slice(0, 12).map((t) => {
                          const fmt = (v) => (Number.isFinite(v) ? Number(v).toFixed(2) : '—')
                          const act = t.action === 'close' ? '平' + dirText(t.dir) : t.action === 'reverse' ? '反手' + dirText(t.dir) : '开' + dirText(t.dir)
                          const ok = t.c?.accepted !== false && (t.action === 'close' || (Number.isFinite(t.lots) && t.lots > 0))
                          const rank = rankOf.get(t.code)
                          const status = ok
                            ? (t.backfill ? '补位' : (Number(t.vr) < 1.3 ? '可执行 · 量比偏低' : '可执行'))
                            : (t.c?.lots === 0 ? '0 手观察' : '不开仓')
                          const fields = [
                            ['手数', Number.isFinite(t.lots) ? `${t.lots} 手` : '—'],
                            ['开仓', fmt(t.entry)],
                            ['止损', fmt(t.stop)],
                            ['止盈①', Number.isFinite(t.tp1) ? fmt(t.tp1) : '—'],
                            ['止盈②', Number.isFinite(t.tp2) ? fmt(t.tp2) : '—'],
                            ['风险', t.riskYuan ? `${Math.round(t.riskYuan).toLocaleString()} 元` : '—'],
                            ['量比', t.vr ? Number(t.vr).toFixed(2) : '—'],
                            ['板块', t.sector || '—'],
                            ['依据', t.reason || ''],
                          ]
                          return h('div', { key: t.code + t.action + (t.dir || ''), className: 'frr-action' + (ok ? '' : ' frr-rejected') },
                            h('div', { className: 'frr-action-head' },
                              h('span', { className: 'frr-item-name ' + dirCls(t.dir) }, `${t.name || t.code} ${act}`),
                              h('span', { className: 'frr-tag' }, `${rank ? '#' + rank + ' ' : ''}${status}`),
                            ),
                            h('div', { className: 'frr-action-grid' },
                              fields.map(([k, v]) => h('span', { key: k }, h('i', null, k), h('b', null, v))),
                            ),
                          )
                        })
                      : h(Empty, null, '明日无操作'),
                  ),
                ),

                h(
                  Section,
                  { title: '手动确认（确认后才进持仓）', count: manualCandidates.length, wide: true, className: 'frr-priority-2' },
                  manualMsg ? h('p', { className: 'frr-note' }, manualMsg) : null,
                  h(
                    'div',
                    { className: 'frr-manual-list' },
                    manualCandidates.length
                      ? manualCandidates.map((c) => {
                          const d = draftOf(c)
                          const f = (v) => (Number.isFinite(v) ? Number(v).toFixed(2) : '—')
                          return h('div', { key: c.code, className: 'frr-manual' },
                            h('div', { className: 'frr-action-head' },
                              h('span', { className: 'frr-item-name ' + dirCls(c.dir) }, `${c.name || c.code} ${dirText(c.dir)}`),
                              h('span', { className: 'frr-tag' }, `#${c.rank || '—'} 待确认`),
                            ),
                            h('div', { className: 'frr-manual-fields' },
                              h('label', null, '买入价',
                                h('input', {
                                  type: 'number', step: '0.01',
                                  value: d.entry ?? String(Number(c.entryRef || 0).toFixed(2)),
                                  onChange: (e) => setDraft(c.code, { entry: e.target.value }),
                                }),
                              ),
                              h('label', null, '手数',
                                h('input', {
                                  type: 'number', min: '1', step: '1',
                                  value: d.lots ?? String(c.lots || ''),
                                  onChange: (e) => setDraft(c.code, { lots: e.target.value }),
                                }),
                              ),
                              h('span', { className: 'frr-hint' }, `止损 ${f(c.stop ?? c.estStop)}`),
                              h('button', { className: 'frr-primary', onClick: () => confirmManual(c) }, '确认买入'),
                            ),
                          )
                        })
                      : h(Empty, null, '暂无可确认信号'),
                  ),
                ),

                h(
                  Section,
                  { title: `收盘确认${state.confirmDay ? ' · ' + state.confirmDay : ''}`, count: confirmed.length },
                  h(
                    'div',
                    null,
                    state.confirmWindow ? h('p', { className: 'frr-note' }, '入场：' + state.confirmWindow) : null,
                    h(
                      'div',
                      { className: 'frr-list' },
                      state.confirmPending
                        ? h(Empty, null, '日线尚未更新，收盘确认待定')
                        : confirmed.length
                        ? confirmed.map((c) => {
                            const f = (v) => (Number.isFinite(v) ? Number(v).toFixed(2) : '—')
                            const ok = c.accepted !== false
                            const label = c.channel === 'rebound' ? '辅2 反弹' : '通道突破'
                            const req = Number.isFinite(c.requiredEquity)
                              ? ` · 1 手约需权益 ${Math.ceil(c.requiredEquity / 10000).toLocaleString()} 万`
                              : ''
                            return h(Item, {
                              key: c.code,
                              name: `${c.name || c.code} ${dirText(c.dir)}`,
                              dir: c.dir,
                              rejected: !ok,
                              tag: h('span', { className: 'frr-tag' },
                                `${c.rank ? '#' + c.rank + ' ' : ''}${ok ? '过约束' : (c.lots === 0 ? '0 手观察' : '不开仓')}`),
                              meta: ok
                                ? `参考开仓 ${f(c.entryRef ?? c.closeMain)} · 止损 ${f(c.stop ?? c.estStop)}` +
                                  (Number.isFinite(c.tp) ? ` · 2R ${f(c.tp)}` : '') +
                                  (Number.isFinite(c.lots) ? ` · 约 ${c.lots} 手` : '') +
                                  (Number.isFinite(c.riskYuan) ? ` · 单笔风险约 ${Math.round(c.riskYuan).toLocaleString()} 元` : '')
                                : `${label}信号已触发 · 策略手数 ${Number.isFinite(c.lots) ? c.lots + ' 手' : '—'}${req} · 原因：${c.reject || '未进入开仓计划'}`,
                            })
                          })
                        : h(Empty, null, '暂无收盘确认'),
                      ...unconfirmed.slice(0, 8).map((u) =>
                        h(Item, {
                          key: 'u' + u.code,
                          name: `${u.name || u.code} 未确认`,
                          dir: 0,
                          rejected: true,
                          meta: u.reason,
                        }),
                      ),
                    ),
                  ),
                ),

                h(
                  Section,
                  { title: '最近提醒', count: recent.length, wide: true },
                  h(
                    'div',
                    { className: 'frr-list scroll' },
                    recent.length
                      ? recent.slice(-12).reverse().map((a, i) =>
                          h(Item, {
                            key: a.code + a.kind + a.at + i,
                            name: `${KIND_TEXT[a.kind] || a.kind} · ${a.name || a.code}`,
                            dir: a.dir === 'up' ? 1 : a.dir === 'down' ? -1 : 0,
                            tag: h('span', { className: 'frr-tag' }, timeText(a.at)),
                            meta: a.text || '',
                          }),
                        )
                      : h(Empty, null, '今日暂无提醒'),
                  ),
                ),
              ),
            )
          : h(
              'div',
              { className: 'frr-grid' },
              h(
                Section,
                { title: '定仓与权益' },
                h(
                  'div',
                  { className: 'frr-field' },
                  h('span', { className: 'frr-field-label' }, '账户权益'),
                  h(
                    'div',
                    { className: 'frr-field-ctrl' },
                    h('input', {
                      type: 'number',
                      min: 0,
                      step: 10000,
                      value: equityDraft,
                      placeholder: '动态权益，如 1000000',
                      onChange: (e) => setEquityDraft(e.target.value.replace(/[^\d]/g, '')),
                      onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
                    }),
                    h('span', { className: 'frr-hint' }, '单笔风险由定仓方案决定'),
                  ),
                ),
                h(
                  'div',
                  { className: 'frr-field' },
                  h('span', { className: 'frr-field-label' }, '定仓方案'),
                  h(
                    'div',
                    { className: 'frr-field-ctrl' },
                    (state.profiles && state.profiles.length
                      ? state.profiles
                      : [{ key: 'C1', label: 'C1 保守' }, { key: 'C2', label: 'C2 观察' }]
                    ).map((p) =>
                      h('button', {
                        key: p.key,
                        className: 'frr-tab' + (profileDraft === p.key ? ' is-on' : ''),
                        onClick: () => setProfileDraft(p.key),
                      }, p.label),
                    ),
                    h('span', { className: 'frr-hint' }, 'C1 默认；C2 仅作对比'),
                  ),
                ),
              ),
              h(
                Section,
                { title: '品种筛选' },
                h(
                  'div',
                  { className: 'frr-field' },
                  h('span', { className: 'frr-field-label' }, '自选品种'),
                  h(
                    'div',
                    { className: 'frr-field-ctrl' },
                    h('input', {
                      type: 'text',
                      value: watchDraft,
                      placeholder: '留空=默认品种，可输中文名，如 国债',
                      onChange: (e) => setWatchDraft(e.target.value),
                    }),
                    matchHint(watchDraft, (code) => {
                      const parts = watchDraft.split(/[,，\s]+/).filter(Boolean)
                      parts[parts.length - 1] = code
                      const next = parts.join(',')
                      setWatchDraft(next)
                      /* draft only */
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'frr-field' },
                  h('span', { className: 'frr-field-label' }, '排除品种'),
                  h(
                    'div',
                    { className: 'frr-field-ctrl' },
                    h('input', {
                      type: 'text',
                      value: excludeDraft,
                      placeholder: '如 JR0,WH0',
                      onChange: (e) => setExcludeDraft(e.target.value),
                    }),
                    matchHint(excludeDraft, (code) => {
                      const parts = excludeDraft.split(/[,，\s]+/).filter(Boolean)
                      parts[parts.length - 1] = code
                      const next = parts.join(',')
                      setExcludeDraft(next)
                      /* draft only */
                    }),
                  ),
                ),
                h('p', { className: 'frr-note' }, '输入中文名可搜索合约代码，点候选标签即可填入；留空表示使用默认品种池。'),
                h('div', { className: 'frr-savebar' },
                  h('button', { className: 'frr-primary', disabled: !cfgDirty, onClick: saveCfg }, '保存配置'),
                  h('button', { disabled: !cfgDirty, onClick: resetCfgDrafts }, '放弃修改'),
                  h('span', { className: 'frr-hint' }, cfgDirty ? '有未保存修改' : '已保存'),
                ),
              ),
            ),

        err ? h('div', { className: 'frr-err' }, '错误：' + err) : null,
      )
    }

    function RadarSidebarIcon() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'M12 3.5V12l6 3.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 12, r: 1.6, fill: 'currentColor' }),
      )
    }

    return {
      name: 'futures-radar',
      // 必须声明对 slots 服务的依赖，否则框架加载时 ctx.slots 不可用
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'futures-radar-toast', order: 60 }, RadarDock),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'dsh-futures-radar', order: 31, label: () => '趋势雷达' },
            RadarSidebarIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-futures-radar' }, RadarPage),
        )
      },
    }
  },
})
