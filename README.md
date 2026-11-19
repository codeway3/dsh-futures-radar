# dsh-futures-radar · Futures Trend Radar

**English** | [中文](README.zh-CN.md)

A [DSH](https://github.com/deepseek-ai) plugin that monitors Chinese commodity futures with a daily
trend-breakout strategy computed on the **volume-weighted index**. After the close it builds the next
session's task list; while trading it watches live quotes and alerts on **trigger / close confirmation /
stop / take-profit**, journalling every alert for post-trade review.

> The early "30-second volume-spike" logic was removed: backtests showed it merely confirmed moves
> after the fact (negative expectancy for every holding window). Only the trend strategy remains.

## Strategy at a glance

- **Main strategy**: 55-day channel breakout (close beyond the prior 55-day high/low) + MA20 > MA60
  (reversed for shorts) + volume ratio ≥ 1.2 + TRIX(12) aligned with its signal line. Enter at the
  next session's open.
- **Exits**: **fixed 5% stop** (default) / close below MA20 (above for shorts) / TRIX cross-back /
  40-day time exit.
- **Auxiliary (long only)**: a 20-day drop of ≥ 15% within the last 10 sessions, then a close back
  above MA10 while still under MA60; 20-day hold.
- **Portfolio layer**: at most 8 concurrent positions, at most 2 per sector, ranked by volume ratio;
  reverse signals merge into a single position.

Signals are computed on EastMoney's **weighted index** (`159.<variety>fi`) to avoid roll gaps. The
index itself is not tradeable, so fills are modelled at the next open of the main continuous contract.

Backtest conventions and known caveats: [docs/trend-strategy.md](docs/trend-strategy.md) (Chinese).
The SAR stop variant was retracted after a look-ahead fix (PF 1.14 vs 1.39); the default is now the
C1 structural stop (struct_atr / 1% / 50%).

## Backtest (C1 structural-stop approximation, 2015-01 → 2026-11)

| Metric | C1 approximation |
|---|---:|
| Trades | 1202 |
| Win rate | 29.1% |
| Profit factor | 1.65 |
| Annualized return | +20.2% |
| Max drawdown | −26.8% |

Conventions: weighted index, 0.2% cost, max 8 concurrent / 2 per sector, C1 (struct_atr / 1% / 50%).
This is a simplified replay: no daily mark-to-market and no portfolio caps (150% notional / 30% margin /
5% risk), so live results should be lower. The old fixed 5% / 0.6% / 12% figures (1641 trades, PF 1.39,
+6.7% annualized, 14.7% drawdown) no longer describe the default strategy.

## Alerts

| Kind | Condition | Level |
|---|---|---|
| `trigger` | Price crosses the 55-day high/low intraday (warning only) | normal |
| `stop` | A position touches its stop price | strong |
| `tp` | A position reaches 2R (**hint only**, not part of backtest exits) | major |
| `confirm` | After the close: close beyond the channel + volume ratio + TRIX all pass. The alert states the concrete entry window (tonight's 21:00 night session / next day 09:00 morning session); whether to open is decided by the next-session task list (accepted by the portfolio → strong, rejected → normal) | strong/normal |

Each variety + kind + trading day alerts at most once.

**Trigger ≠ entry.** A trigger only means the price crossed the channel intraday; the close may pull
back, or volume/TRIX may fail. `confirm` is a post-close re-check and does **not** create an order by
itself — the next-session task list does, under the same portfolio rules (8 concurrent, 2 per sector).
The Signals tab labels every confirmation with "passed portfolio constraints" or "no entry + reason",
and lists unconfirmed varieties with the reason (close back inside, volume too low, TRIX not aligned).

## Journal

All alerts are appended to `~/.dsh/futures-radar/alerts.jsonl`:

```json
{"at":1762...,"type":"trend","kind":"trigger","code":"RB0","name":"螺纹","dir":"up",
 "price":3135,"level":"normal","text":"触发：突破 55 日高点 3130.00","day":"2026-11-10"}
```

```sh
# last 30 alerts
jq -r 'select(.type=="trend") | [.day,.kind,.code,.name,.price,.text] | @tsv' \
  ~/.dsh/futures-radar/alerts.jsonl | tail -30

# all alerts for one variety
jq -r 'select(.code=="RB0") | [.day,.kind,.price,.text] | @tsv' \
  ~/.dsh/futures-radar/alerts.jsonl
```

## Sizing profiles (C1 default / C2 observation)

Open the left-sidebar **Trend Radar** entry → **Config**. Enter dynamic account equity; risk per trade
is fixed by the profile:

| Profile | Risk/trade | Portfolio notional | Portfolio margin | Portfolio risk | Notes |
|---|---|---|---|---|---|
| **C1 conservative (default)** | 1.0% | 150% | 30% | 5% | Structural stop + 0.3ATR; 1 CU lot ≈ 1.8% risk, 0 lots at 1M |
| **C2 observation** | 1.5% | 200% | 40% | 8% | More aggressive, comparison only |

```
stop distance = broken 55-day level + 0.3ATR (falls back to 1.5ATR when the level is on the wrong side, 1%–8%)
position size = min(risk/trade ÷ stop distance, 50%)
lots          = min(notional budget ÷ contract, risk budget ÷ per-lot risk)   (rounded down)
```

Portfolio caps keep positions oldest-first and drop the **newest** position when notional, margin or
risk would exceed the cap; rejected entries are returned as `capRejected`.

Contract multipliers live in `data/multipliers.json`; the `unverified` list (BZ/PL/AD) should be
checked against exchange notices.

When the computed lots are 0 the plugin raises a **0-lot signal** alert and does **not** enter a
position. Positions reconstructed from daily bars while the plugin was offline are tagged
**backfilled** (not live-confirmed).

## CLI

```sh
npm run trend                                    # scan 61 varieties, print the next-session plan
node scripts/trend-scan.mjs --json               # machine-readable
node scripts/trend-scan.mjs --only=RB,M --date=2026-11-09
```

Default output (monitoring scope only):

```
监控起点 2026-11-10：历史持仓 5 个不计入（--all 显示全部）
── 当前持仓（组合层约束后 0/8）──
  （空仓）
── 明日任务 ──
  （无）
```

`--all` also shows historical positions and their exits. (CLI output is currently in Chinese.)

## Self-checks

```sh
npm run check                     # syntax
npm run selftest                  # 28 strategy + 30 alert tests
npm run selftest:trend            # strategy logic
npm run selftest:trend:monitor    # alert logic (incl. runtime end-to-end)
```

## Entry and config

The left-sidebar **Trend Radar** icon opens the main page with two tabs:

- **Signals**: status, positions (lots/actual risk/margin), 0-lot signals, next-day tasks, close confirmation, recent alerts;
- **Config**: account equity, sizing profile (C1/C2), included/excluded varieties.

There is no standalone settings page, enable switch or quiet hours any more; removing the plugin stops it.
A 30-minute pause remains at the top of the Signals tab.

## Data and limitations

- Sources: EastMoney weighted index (daily klines), Sina real-time snapshots.
- Daily cache: `~/.dsh/futures-radar/trend-daily.json`. Refreshes are incremental (only the last 30 days
  once history exists): every 2 hours while the market is open and every 30 minutes in the 15:00–18:00
  settlement window, every 4 hours otherwise, and not on weekends once the day's confirmation is done. Failed
  refreshes back off 30m → 1h → 2h → 4h (capped at 6h). Requests are spaced 1–2s apart; after 3
  consecutive failed refreshes the plugin trips a breaker (6h, then 12h, then 24h).
- The weighted index is not tradeable; stops are intraday-touch fills with gap opens honoured; limit-up
  / limit-down days are not special-cased; 2R is a hint, real exits use MA20 / TRIX / fixed stop / time.
- Price mapping: alert levels convert weighted-index levels to the main contract using
  `prev settlement / weighted prev close`, falling back to 1:1 when the ratio is outside 0.8–1.25.
  Historical positions use the current ratio (entry-day ratios are not stored).
- Close confirmation: targets the most recent **closed** trading day. It runs after 15:15 and also
  back-fills when the app is opened after 21:00 or at the weekend. It requires the daily cache to be
  refreshed after 15:10 and at least 90% of refreshable varieties to carry that day's bar; otherwise
  the panel shows "confirmation pending". A trading day is confirmed once and restarts do not re-push.
- Trading-day attribution: the night session starting at 21:00 belongs to the **next** trading day
  (Friday night → next Monday); 00:00–02:30 still belongs to that day. Dedupe, confirmation and
  journal dates follow this rule. Exchange holidays are not modelled — check them manually.
- Monitoring scope: `~/.dsh/futures-radar/monitor-start.json`. Only entries after that date are
  monitored; historical positions do not raise stop/take-profit alerts (`--all` shows them).
- Deployment assumption: all time checks (15:10 / 15:15 / 21:00, trading-day attribution) assume the
  machine runs in **UTC+8**.

## Install

Requires Node.js 22+ and a DSH build that provides the `webServer` service.

1. Link or copy this package into the profile's `node_modules`:

   ```sh
   ln -s /path/to/dsh-futures-radar ~/.dsh/profiles/desktop/node_modules/dsh-futures-radar
   ```

2. Register the bundle in the profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: futures-radar
         name: 'dsh-futures-radar'
   ```

3. Restart DSH (or toggle the plugin) and open **Trend Radar** in the left sidebar.

## License

MIT — see [LICENSE](LICENSE).
