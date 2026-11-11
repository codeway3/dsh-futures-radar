window.__ModuleLoader__.load({
  id: 'dsh-futures-radar',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useReducer, useMemo, useRef } = React
    const h = React.createElement

    const API = '/futures-radar/api'
    const CFG_KEY = 'dsh-futures-radar.config.v1'
    const DEFAULT_CFG = {
      enabled: true,
      equity: 0,
      riskPct: 0.6,
      watch: '',
      exclude: '',
      quietOn: false,
      quietFrom: '11:25',
      quietTo: '13:35',
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

    /* ───────────── 静默与暂停 ───────────── */
    /* @testable:quiet-start */
    const toMins = (hhmm) => {
      const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/)
      if (!m) return null
      return Number(m[1]) * 60 + Number(m[2])
    }

    /** 当前是否处于静默时段（支持跨零点）或暂停中 */
    function isQuiet(cfg, now) {
      const t = now instanceof Date ? now : new Date(now)
      if (cfg.pauseUntil && t.getTime() < cfg.pauseUntil) return 'paused'
      if (!cfg.quietOn) return null
      const from = toMins(cfg.quietFrom)
      const to = toMins(cfg.quietTo)
      if (from === null || to === null || from === to) return null
      const cur = t.getHours() * 60 + t.getMinutes()
      const inside = from < to ? cur >= from && cur < to : cur >= from || cur < to
      return inside ? 'quiet' : null
    }
    /* @testable:quiet-end */

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
        cfg.riskPct ? 'risk=' + encodeURIComponent(cfg.riskPct) : '',
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
          tasks: Array.isArray(json.tasks) ? json.tasks : [],
          recent: Array.isArray(json.recent) ? json.recent : [],
          confirmed: Array.isArray(json.confirmed) ? json.confirmed : [],
          unconfirmed: Array.isArray(json.unconfirmed) ? json.unconfirmed : [],
          date: json.date || null,
          since: json.since || null,
          historical: Number(json.historical) || 0,
          confirmDay: json.confirmDay || null,
          confirmWindow: json.confirmWindow || null,
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
      const dep = [active, cfg.enabled, cfg.watch, cfg.exclude, cfg.equity, cfg.riskPct].join('|')

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
        const want = !!(active && cfg.enabled)
        if (want) {
          radar.wanted.add(token.current)
          radarStart({
            watch: cfg.watch,
            exclude: cfg.exclude,
          })
        } else {
          radar.wanted.delete(token.current)
          if (!radar.wanted.size) radarStop()
        }
      }, [dep])

      return { state: radar.state, err: radar.err, shown: radar.shown }
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
      .frr-pill{display:inline-flex;align-items:center;gap:6px;max-width:360px;
        padding:3px 6px 3px 8px;border-radius:8px;cursor:pointer;
        background:color-mix(in srgb, var(--dsw-alias-bg-l1,#1b1c1f) 90%, transparent);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
        color:var(--dsw-alias-label-secondary,#9aa0a8);white-space:nowrap;
        -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);animation:frr-in .16s ease}
      .frr-pill:hover,.frr-pill:focus-visible{color:var(--dsw-alias-label-primary,#e6e8eb);
        outline:none;border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.18))}
      .frr-dot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-label-quaternary,#6b7280)}
      .frr-name{color:var(--dsw-alias-label-tertiary,#868c94)}
      .frr-why{color:var(--dsw-alias-label-quaternary,#6b7280)}
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
      .frr-card{width:280px;padding:9px 10px;border-radius:10px;
        background:color-mix(in srgb, var(--dsw-alias-bg-l1,#1b1c1f) 96%, transparent);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
        color:var(--dsw-alias-label-secondary,#9aa0a8);white-space:normal;
        font-size:11px;line-height:1.7;box-shadow:0 6px 20px rgba(0,0,0,.28)}
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
      .frr-set{display:flex;flex-direction:column;gap:10px;font-size:12.5px;
        color:var(--dsw-alias-label-secondary);max-width:600px}
      .frr-set-title{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px}
      .frr-set-desc{color:var(--dsw-alias-label-quaternary);font-size:11px;line-height:1.6}
      .frr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .frr-row>span:first-child{width:84px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
      .frr-set select,.frr-set input[type=text],.frr-set input[type=time]{font:inherit;font-size:12px;
        padding:2px 6px;border-radius:6px;background:var(--dsw-alias-bg-l1,#1b1c1f);
        color:var(--dsw-alias-label-primary,#e6e8eb);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
      .frr-set input[type=text]{width:190px}
      .frr-set input[type=time]{width:96px}
      .frr-set button{font:inherit;font-size:11.5px;padding:3px 10px;border-radius:6px;cursor:pointer;
        background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
        color:var(--dsw-alias-label-tertiary,#868c94);
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
      .frr-set button:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}
      .frr-hint{color:var(--dsw-alias-label-quaternary);font-size:10.5px;line-height:1.6}
      .frr-list{display:flex;flex-direction:column;gap:2px;font-size:11px;
        font-variant-numeric:tabular-nums;max-height:220px;overflow:auto;min-width:240px}
      .frr-list i{font-style:normal;color:var(--dsw-alias-label-quaternary)}
      .frr-list-row{display:flex;gap:6px;align-items:baseline}
      .frr-unread{color:var(--dsw-alias-label-primary,#e6e8eb)}
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
          stroke: up ? 'var(--dsw-alias-label-secondary,#9aa0a8)' : 'var(--dsw-alias-label-tertiary,#868c94)',
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
      const [quietKind, setQuietKind] = useState(null)

      // 静默/暂停：每秒检查一次，跨过静默边界要能自动恢复
      useEffect(() => {
        const check = () => setQuietKind(isQuiet(cfg, Date.now()))
        check()
        const timer = setInterval(check, 15000)
        return () => clearInterval(timer)
      }, [cfg.quietOn, cfg.quietFrom, cfg.quietTo, cfg.pauseUntil])

      // 新事件入队（静默/暂停期间只入历史，不打扰）
      useEffect(() => {
        if (!cfg.enabled || !state.alerts || !state.alerts.length) return
        if (quietKind) return
        dispatch({ type: 'push', items: state.alerts })
      }, [state.at, cfg.enabled, quietKind])

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

      if (!cfg.enabled) return null
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

    function SettingsSection() {
      const cfg = useCfg()
      const { state, err, shown } = useRadarScan(cfg, true)
      const [watchDraft, setWatchDraft] = useState(cfg.watch || '')
      const [excludeDraft, setExcludeDraft] = useState(cfg.exclude || '')
      const [varieties, setVarieties] = useState([])

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
      const tasks = state.tasks || []
      const recent = state.recent || []
      const confirmed = state.confirmed || []
      const unconfirmed = state.unconfirmed || []
      const dirText = (d) => (d > 0 ? '多' : '空')

      return h(
        'div',
        { className: 'frr-set' },
        h(Styles),
        h(
          'div',
          null,
          h('div', { className: 'frr-set-title' }, '趋势雷达'),
          h(
            'div',
            { className: 'frr-set-desc' },
            '加权指数日线突破策略：盘后出任务，盘中提醒临近/触发/止盈止损。本地计算，数据来自东财与新浪。',
          ),
        ),

        h(
          'div',
          { className: 'frr-row' },
          h('span', null, '状态'),
          h(
            'span',
            { className: 'frr-hint' },
            stateText +
              (state.date ? ` · 数据日 ${state.date}` : '') +
              (state.since ? ` · 监控起点 ${state.since}` : '') +
              (state.historical ? ` · 历史持仓 ${state.historical} 未监控（止损/止盈不提醒）` : '') +
              ` · 持仓 ${positions.length}/8` +
              (tasks.length ? ` · 明日任务 ${tasks.length}` : '') +
              (pausedLeft ? ` · 已暂停 ${pausedLeft} 分钟` : ''),
          ),
          h(
            'button',
            {
              onClick: () =>
                writeCfg({ pauseUntil: pausedLeft ? 0 : Date.now() + 30 * 60 * 1000 }),
            },
            pausedLeft ? '恢复提醒' : '暂停 30 分钟',
          ),
        ),

        h(
          'div',
          { className: 'frr-row' },
          h('span', null, '账户权益'),
          h('input', {
            type: 'number',
            min: 0,
            step: 10000,
            value: cfg.equity || '',
            placeholder: '动态权益，如 1000000',
            style: { width: '130px' },
            onChange: (e) => writeCfg({ equity: Number(e.target.value) || 0 }),
          }),
          h('span', null, '风险/笔'),
          h('input', {
            type: 'number',
            min: 0.1,
            max: 3,
            step: 0.1,
            value: cfg.riskPct || 0.6,
            style: { width: '64px' },
            onChange: (e) => writeCfg({ riskPct: Number(e.target.value) || 0.6 }),
          }),
          h('span', { className: 'frr-hint' }, '%'),
        ),

        h(
          'div',
          { className: 'frr-row' },
          h('span', null, '启用'),
          h('input', {
            type: 'checkbox',
            checked: cfg.enabled !== false,
            onChange: (e) => writeCfg({ enabled: e.target.checked }),
          }),
          h('span', { className: 'frr-hint' }, '停止扫描'),
        ),

        h(
          'div',
          { className: 'frr-row' },
          h('span', null, '自选品种'),
          h('input', {
            type: 'text',
            value: watchDraft,
            placeholder: '留空=默认品种，可输中文名，如 国债',
            onChange: (e) => setWatchDraft(e.target.value),
            onBlur: () => writeCfg({ watch: watchDraft.trim() }),
            onKeyDown: (e) => {
              if (e.key === 'Enter') writeCfg({ watch: watchDraft.trim() })
            },
          }),
          h('span', { className: 'frr-hint' }, '只监控这些'),
        ),
        matchHint(watchDraft, (code) => {
          const parts = watchDraft.split(/[,，\s]+/).filter(Boolean)
          parts[parts.length - 1] = code
          const next = parts.join(',')
          setWatchDraft(next)
          writeCfg({ watch: next })
        }),
        h(
          'div',
          { className: 'frr-row' },
          h('span', null, '排除品种'),
          h('input', {
            type: 'text',
            value: excludeDraft,
            placeholder: '如 JR0,WH0',
            onChange: (e) => setExcludeDraft(e.target.value),
            onBlur: () => writeCfg({ exclude: excludeDraft.trim() }),
            onKeyDown: (e) => {
              if (e.key === 'Enter') writeCfg({ exclude: excludeDraft.trim() })
            },
          }),
          h('span', { className: 'frr-hint' }, '不监控这些'),
        ),
        matchHint(excludeDraft, (code) => {
          const parts = excludeDraft.split(/[,，\s]+/).filter(Boolean)
          parts[parts.length - 1] = code
          const next = parts.join(',')
          setExcludeDraft(next)
          writeCfg({ exclude: next })
        }),

        h(
          'div',
          { className: 'frr-row' },
          h('span', null, '静默时段'),
          h('input', {
            type: 'checkbox',
            checked: !!cfg.quietOn,
            onChange: (e) => writeCfg({ quietOn: e.target.checked }),
          }),
          h('input', {
            type: 'time',
            value: cfg.quietFrom || '11:25',
            onChange: (e) => writeCfg({ quietFrom: e.target.value }),
          }),
          h('span', { className: 'frr-hint' }, '至'),
          h('input', {
            type: 'time',
            value: cfg.quietTo || '13:35',
            onChange: (e) => writeCfg({ quietTo: e.target.value }),
          }),
          h('span', { className: 'frr-hint' }, '不弹窗，仍记历史'),
        ),

        h(
          'div',
          { className: 'frr-row', style: { alignItems: 'flex-start' } },
          h('span', null, '当前持仓'),
          h(
            'div',
            { className: 'frr-list' },
            positions.length
              ? positions.map((p) =>
                  h(
                    'div',
                    { key: p.code + p.entryDate, className: 'frr-list-row' },
                    h('span', null, `${p.name || p.code} ${dirText(p.dir)}`),
                    h('i', null, `入 ${p.entryDate} @${Number(p.entryMain ?? p.entryPrice).toFixed(2)}` +
                      (Number.isFinite(p.entryMain) ? '（主连）' : '')),
                    Number.isFinite(p.stopMain ?? p.stopPrice)
                      ? h('i', null, `止损 ${Number(p.stopMain ?? p.stopPrice).toFixed(2)}` +
                        (Number.isFinite(p.stopMain) ? '（主连）' : ''))
                      : null,
                    Number.isFinite(p.weightPct)
                      ? h('i', null, `仓位 ${p.weightPct.toFixed(0)}%`)
                      : null,
                    Number.isFinite(p.lots)
                      ? h('i', null, `约 ${p.lots} 手${p.unverified ? '（乘数待核）' : ''}`)
                      : null,
                  ),
                )
              : [h('i', { key: 'empty' }, state.since ? `自 ${state.since} 起无新开仓` : '空仓')],
          ),
        ),

        h(
          'div',
          { className: 'frr-row', style: { alignItems: 'flex-start' } },
          h('span', null, '明日任务'),
          h(
            'div',
            { className: 'frr-list' },
            tasks.length
              ? tasks.slice(0, 12).map((t) =>
                  h(
                    'div',
                    { key: t.code + t.action + (t.dir || ''), className: 'frr-list-row' },
                    h('span', null, `${t.name || t.code} ${t.action === 'close' ? '平' + dirText(t.dir) : t.action === 'reverse' ? '反手' + dirText(t.dir) : '开' + dirText(t.dir)}`),
                    h('i', null, t.reason || ''),
                  ),
                )
              : [h('i', { key: 'empty' }, '无')],
          ),
        ),

        h(
          'div',
          { className: 'frr-row', style: { alignItems: 'flex-start' } },
          h('span', null, `收盘确认${state.confirmDay ? `（${state.confirmDay}）` : ''}`),
          h(
            'div',
            { className: 'frr-list' },
            state.confirmWindow ? h('i', { key: 'window' }, `入场：${state.confirmWindow}`) : null,
            state.confirmPending
              ? [h('i', { key: 'pending' }, '日线尚未更新，收盘确认待定')]
              : confirmed.length
              ? confirmed.map((c) => {
                  const f = (v) => (Number.isFinite(v) ? Number(v).toFixed(2) : '—')
                  const ok = c.accepted !== false
                  const label = c.channel === 'rebound' ? '辅2 反弹' : '通道突破'
                  return h('div', { key: c.code, className: 'frr-list-row' },
                    h('span', null, `${c.name || c.code} ${dirText(c.dir)}`),
                    ok
                      ? h('i', null, `参考开仓 ${f(c.entryRef ?? c.closeMain)} · 止损 ${f(c.stop ?? c.estStop)}` +
                        (Number.isFinite(c.tp) ? ` · 2R 提示 ${f(c.tp)}` : '') +
                        (Number.isFinite(c.lots) ? ` · 约 ${c.lots} 手` : ''))
                      : h('i', null, `${label}信号已触发，但不开仓`),
                    h('i', { key: 'status' }, ok
                      ? `已过组合约束，按入场窗口执行${Number.isFinite(c.riskYuan) ? ` · 单笔风险约 ${Math.round(c.riskYuan).toLocaleString()} 元` : ''}`
                      : `原因：${c.reject || '未进入开仓计划'}`),
                  )
                })
              : [h('i', { key: 'empty' }, '暂无收盘确认')],
            ...unconfirmed.slice(0, 8).map((u) =>
              h('div', { key: 'u' + u.code, className: 'frr-list-row' },
                h('span', null, `${u.name || u.code} 未确认`),
                h('i', null, u.reason),
              ),
            ),
          ),
        ),

        h(
          'div',
          { className: 'frr-row', style: { alignItems: 'flex-start' } },
          h('span', null, '最近提醒'),
          h(
            'div',
            { className: 'frr-list' },
            recent.length
              ? recent.slice(-12).reverse().map((a, i) =>
                  h(
                    'div',
                    { key: a.code + a.kind + a.at + i, className: 'frr-list-row' },
                    h('i', null, timeText(a.at)),
                    h('span', null, `${KIND_TEXT[a.kind] || a.kind} ${a.name || a.code}`),
                    h('i', null, a.text || ''),
                  ),
                )
              : [h('i', { key: 'empty' }, '今日暂无提醒')],
          ),
        ),

        err ? h('div', { className: 'frr-hint' }, '错误：' + err) : null,
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
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'futures-radar', order: 52, label: '趋势雷达' },
            SettingsSection,
          ),
        )
      },
    }
  },
})
