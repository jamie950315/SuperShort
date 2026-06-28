# Live TradingView Signal Design

## Goal

Create a TradingView-first live signal framework for Flash Point Pro research. The first version is for human decision support, not automatic order execution.

The signal should help the user decide whether to prepare, enter, hold, trim, or exit a position in real time on BTCUSDC, ETHUSDC, and SOLUSDC. It should loosen the previous high-profit fixed-target rules enough to catch more reversals, while still keeping the displayed `ENTER` and `EXIT` states selective enough to preserve useful win rate.

## Current Research Baseline

The current six-month live-preview validation window is:

```text
2025-12-22 through 2026-06-20, inclusive UTC days
```

Generated reports:

- `CrossingFetch/analysis/backtest-data/live-preview-6m/BTCUSDC/indicator-grid-live-preview-focused/flashpoint-indicator-grid-2026-06-28T17-07-44-935Z.md`
- `CrossingFetch/analysis/backtest-data/live-preview-6m/ETHUSDC/indicator-grid-live-preview-focused/flashpoint-indicator-grid-2026-06-28T17-16-55-914Z.md`
- `CrossingFetch/analysis/backtest-data/live-preview-6m/SOLUSDC/indicator-grid-live-preview-focused/flashpoint-indicator-grid-2026-06-28T17-13-54-314Z.md`

Current high-quality baseline:

| Symbol | Best current use | Notes |
| --- | --- | --- |
| BTCUSDC | 5m, 10% target possible | Strong but sparse. Useful as a quality anchor. |
| ETHUSDC | 10m, 5% target preferred | 10% target is not the main live target because drawdown pressure is higher. |
| SOLUSDC | 10m, 10% target preferred | Best current fit for the previous high-profit target. |

These results remain the conservative reference. The live signal framework should not replace them; it should add earlier and more informative decision states.

## Signal States

The TradingView display uses six states:

| State | Meaning | Typical user action |
| --- | --- | --- |
| `WATCH` | A reversal may be forming. | Pay attention, no entry yet. |
| `READY` | Reversal quality is improving. | Prepare for entry confirmation. |
| `ENTER` | Entry conditions are strong enough. | Consider opening a position. |
| `HOLD` | Current position direction still looks healthy. | Continue holding. |
| `TRIM` | Momentum is weakening or opposite pressure is rising. | Protect profit or reduce exposure. |
| `EXIT` | Opposite pressure is clear. | Consider closing the position. |

The first version should treat `WATCH` and `READY` as permissive early warnings, while `ENTER` and `EXIT` remain stricter decision states.

## Display Format

Every visible signal should include side, state, and reasons.

Examples:

```text
BTC LONG WATCH: C1 low + RSI oversold
BTC LONG READY: C1 low + bull score 4 + MACD shrink
SOL SHORT ENTER: cross down + bear score 5 + divergence
ETH LONG HOLD: trend ok + gap rising + no bear pressure
BTC LONG TRIM: MACD fade + gap slope weak
SOL SHORT EXIT: cross up + bull score 4
```

Reason text should be short and stable. The first version should show two to four reasons per state so the user can understand why a label appeared without reading a separate panel.

## Symbol Profiles

The signal framework must detect the TradingView symbol and apply symbol-specific defaults.

| Symbol | Main timeframe | Early timeframe | Initial role |
| --- | ---: | ---: | --- |
| BTCUSDC | 5m | 2m / 15m | 5m decides the main state; 2m gives early warning; 15m can veto weak reversals. |
| ETHUSDC | 10m | 2m | 10m decides the main state; 2m gives early warning. |
| SOLUSDC | 10m | 3m | 10m decides the main state; 3m gives early warning. |

The indicator should display the detected target, for example:

```text
Target: BTCUSDC profile active
```

If the chart symbol is not BTCUSDC, ETHUSDC, or SOLUSDC, the display should warn that no tuned profile is active.

## State Logic

The first research model should use the existing Flash Point Pro C1/C2 data and derived features:

- C1 level
- C1/C2 cross direction
- bull score and bear score
- MACD shrink or fade
- RSI pressure
- divergence
- gap slope or trend pressure
- higher-timeframe agreement or veto

Suggested first-pass state rules:

| State | Long example | Short example |
| --- | --- | --- |
| `WATCH` | C1 low or early bull score appears. | C1 high or early bear score appears. |
| `READY` | `WATCH` plus stronger bull score or MACD shrink. | `WATCH` plus stronger bear score or MACD shrink. |
| `ENTER` | READY plus cross up, divergence, or multi-timeframe agreement. | READY plus cross down, divergence, or multi-timeframe agreement. |
| `HOLD` | Position side remains aligned with score, gap slope, and no strong opposite pressure. | Same logic inverted. |
| `TRIM` | Opposite score rises, MACD fades, or gap slope weakens. | Same logic inverted. |
| `EXIT` | Opposite cross or strong opposite score appears. | Same logic inverted. |

The first version should avoid hard fixed TP/SL labels. It can still use profit distance and adverse excursion as validation metrics.

## Validation Plan

The validation should answer a different question from the previous fixed-target grid.

Previous question:

```text
Can a strict signal reach 5% or 10% leveraged profit before stop?
```

New question:

```text
Can the live state sequence identify reversal opportunities early, keep the user in profitable moves, and exit before the reversal fails?
```

Required validation metrics:

- `WATCH -> READY -> ENTER` conversion rate
- `ENTER` win rate
- average and median favorable move after `ENTER`
- maximum favorable move before `TRIM` or `EXIT`
- adverse move after `ENTER`
- missed reversal rate
- false READY rate
- time from WATCH to ENTER
- time from ENTER to TRIM or EXIT
- side-specific performance for long and short
- symbol-specific performance for BTCUSDC, ETHUSDC, and SOLUSDC

The validation should use live-preview behavior, because intrabar signals can appear, disappear, or change before candle close.

## Research Approach

Use the previous six-month datasets as the baseline data source. The first validation pass should be offline and replay-based, using the same live-preview behavior as the current indicator grid.

Recommended sequence:

1. Build a state-machine validator that converts feature events into `WATCH / READY / ENTER / HOLD / TRIM / EXIT`.
2. Run broad symbol-specific parameter sweeps for WATCH, READY, ENTER, TRIM, and EXIT thresholds.
3. Rank by practical live usefulness, not only fixed TP:
   - primary: ENTER win rate and average favorable move
   - secondary: missed reversal rate and false READY rate
   - risk: adverse move and state churn
4. Produce per-symbol recommended profiles for TradingView display.
5. Only after the TradingView logic is understandable, consider mapping `ENTER / TRIM / EXIT` into paper trading rules.

## Scope Boundaries

In scope:

- TradingView-facing signal states
- reason text
- BTCUSDC, ETHUSDC, and SOLUSDC profiles
- live-preview validation
- research report output

Out of scope for the first version:

- real order execution
- automatic paper trading changes
- dashboard UI changes
- new exchange integration
- replacing the existing strict high-profit strategy reports

## Verification

The next implementation plan should include:

- unit tests for state transitions
- replay tests for intrabar signal persistence
- per-symbol validation reports
- `node --test CrossingFetch/test/*.test.js`
- `node --check` for changed CrossingFetch scripts

The work is complete only when the generated reports identify practical TradingView profiles and the checks pass.
