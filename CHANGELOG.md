# Changelog

All notable changes to this project are documented here.

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
