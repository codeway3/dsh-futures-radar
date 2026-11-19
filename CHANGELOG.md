# Changelog

All notable changes to this project are documented here.

## 0.1.1 — 2026-11-19

### Added

- Manual confirmation of real positions: enter actual fill price and lots before a signal enters
  the holdings area; record an exit price later for review.
- Action cards for tomorrow: direction, lots, entry, stop, 1R/2R targets, risk amount, volume ratio,
  sector and `#rank`, with separate 0-lot observations and required-equity hints.
- C1/C2 sizing profiles (structural stop + ATR buffer) and a draft/save config flow with an explicit
  save/discard bar.
- Replay reset from the monitor start date, so cleared historical positions no longer occupy
  portfolio slots.
- A sector backfill quality gate: the second slot in a sector requires volume ratio >= 1.3.
- CLI fallback to the local cache when the upstream refresh fails (`source=cache`).

### Changed

- Signals page restructured: content scrolls inside the panel, action/manual-confirm sections are
  shown first, and the layout uses a wider responsive grid.
- Tasks and confirmations are ranked by volume ratio; 0-lot signals remain visible as observations
  instead of disappearing or being counted as executable tasks.
- `trend-scan.mjs` defaults to C1 and reports cache-sourced output distinctly.

### Fixed

- The same close confirmation could be pushed twice and with contradictory acceptance when the
  night session crossed a trading day and equity/profile changed; a persistent `confirmSent` set now
  suppresses the duplicate.
- Confirmation reference prices drifted 2–4% after the night session because the main/weighted ratio
  was recomputed from the current tick. The ratio is now anchored per signal day, re-derived from the
  earliest confirmation log, and persisted.
- Real-time trigger and position levels now use a pre-night settled anchor during the night session;
  ratio jumps are journaled once per code/day.
- Reference prices are rounded to known tick sizes (AG/AU/CU/AL/ZN/SN) with a 2-decimal fallback.
- `seedSeen` could reference an undefined day; the confirm sent set and anchor cache are now seeded
  and persisted across restarts.
- Rejected/0-lot confirmations and tasks could disagree; sizing and portfolio decisions now share
  the same 0-lot and backfill rules.

### Tests

- 28 strategy tests and 32 alert/runtime tests, including the equity-change + cross-trading-day
  duplicate case, anchor stability, log-ratio precedence and legacy fallback.

## 0.1.0 — 2026-11-11

First versioned release (the repository had no prior commits).

### Added

- Close confirmation (`confirm`) with portfolio-acceptance marking, reference entry/stop/2R levels,
  estimated risk amount and lots.
- Concrete entry window in confirmations and the panel: tonight's 21:00 night session
  (where the product has one) or the next trading day's 09:00 morning session, including the
  cross-midnight night-session case.
- Trading-day attribution: the 21:00 night session belongs to the next trading day.
- Position sizing from account equity and risk per trade, with main-continuous price mapping.
- 2R take-profit hint (display only, not a backtest exit).
- Bilingual documentation: English `README.md` (default) and Chinese `README.zh-CN.md`.

### Changed

- Default stop is the fixed 5% stop; the SAR stop variant was retracted after a look-ahead fix.
- Trigger alerts are `normal` level; confirmations are `strong` when accepted, `normal` when rejected.
- Confirmations target the most recent closed trading day and back-fill when the app is opened
  after 21:00 or at the weekend; each trading day is confirmed once and restarts do not re-push.
- Host task list now shares the CLI plan (`buildPlan`) instead of using raw signals.
- The alert journal records `dataDate` and `dataAt` for traceability.

### Fixed

- Partial intraday bars could confirm a signal early (15:15 window + settled-data quorum).
- Panel confirmations, host tasks and the CLI plan could disagree on stale bars and rebound entries.
- A failed daily refresh caused a full 61-variety refetch on every tick.
- Sunday 01:00 was attributed to the wrong trading day.
- Rejected confirmations were journalled as `strong`.
- Rejected confirmations no longer display executable prices in the panel.

### Tests

- 28 strategy tests and 21 alert tests, including runtime end-to-end cases for stale bars,
  rebound confirmations, refresh throttling and the 21:00 back-fill.
