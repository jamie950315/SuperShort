# Flash Point Pro Final Data Report

Canonical v0.8 exact development baseline: `CrossingFetch/analysis/v08-canonical-algorithm.md`.

The previous v0.7 reconstruction is retained as an archived research result. Current signal work should use the author-provided v0.8 exact formula in `CrossingFetch/flashpoint-algo.js`.

## Scope

This report preserves the final usable evidence from the available CrossingFetch recordings.

## Author Source Update

The indicator author later provided the Pine v5 source code. The exact current formula is:

```text
typical_price = (2 * close + high + low) / 4
period_lowest = ta.lowest(low, 5)
period_highest = ta.highest(high, 4)
stoch_val = price_range == 0 ? 0 : ((typical_price - period_lowest) / price_range) * 100

C1 = fast_k = ta.ema(stoch_val, 4)
slow_d_base = 0.667 * nz(fast_k[1]) + 0.333 * fast_k
C2 = slow_d = ta.ema(slow_d_base, 2)
```

Important differences from v0.7:

- `price_range == 0` now sets `stoch_val` to `0`.
- `stoch_val` is not clamped.
- Pine EMA seeding starts from the first available bar.
- C2 uses the author decimal coefficients `0.667 / 0.333`.

Files analyzed:

- `crossing-fetch-cf_2026-06-21T03-39-10-237Z_vosxss.jsonl`
- `crossing-fetch-cf_2026-06-21T08-11-24-820Z_419jnr.jsonl`
- `crossing-fetch-cf_2026-06-21T09-20-21-062Z_62i2al.jsonl`

## Data Inventory

| File | Rows | Bar samples | Exact C1/C2 targets | Exact C1/C2 points | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `03-39-10-237Z_vosxss` | 2,490 | 1,883 | 612 | 768 | Longest session; older recorder format. |
| `08-11-24-820Z_419jnr` | 257 | 219 | 219 | 250 | Best path-aware reference session. |
| `09-20-21-062Z_62i2al` | 121 | 109 | 109 | 119 | Final instant-snapshot session. |

Combined:

- Raw rows: `2,868`
- Bar samples usable by analysis: `2,211`
- Exact C1/C2 targets: `940`
- Exact C1/C2 points: `1,137`

The final file has instant K-line and instant indicator data on every row:

- `instantBar` rows: `121 / 121`
- `instantIndicatorSeries` rows: `121 / 121`
- Rows where same-socket `l9uPDe` Flash Point data is present: `75 / 121`

## Confirmed Internal Series

The Flash Point Pro internal C1/C2 values are exposed by TradingView under paths containing:

```text
l9uPDe
```

The first two numeric values are:

```text
values[0] = C1
values[1] = C2
```

Other values such as `1e+100` are TradingView plot placeholders and must be ignored.

## C2 Formula

C2 is solved for the two newer path-aware recordings:

```text
C2[t] = (2 * C1[t] + 4 * C1[t-1] + 3 * C2[t-1]) / 9
```

Equivalent indicator-style form:

```text
C2 = EMA((C1 + 2 * REF(C1, 1)) / 3, 2)
```

Verification:

| File | Exact points | C2 recurrence RMSE | Max abs error |
| --- | ---: | ---: | ---: |
| `08-11-24-820Z_419jnr` | 250 | 0.0030786117 | 0.0086701806 |
| `09-20-21-062Z_62i2al` | 119 | 0.0029166021 | 0.0074398462 |

The old `03-39` session is not reliable for proving C2 because it was recorded before instant/path-aware synchronization. Its C2 recurrence error is much larger and should be treated as a recorder limitation, not as counter-evidence to the formula.

## Leading C1 Reconstruction

The strongest C1 candidate after reviewing the GPT-5.5-Pro progress package is:

```text
VAR1 = (HIGH + LOW + 2 * CLOSE) / 4
VAR2 = LLV(LOW, 5)
VAR3 = HHV(HIGH, 4)
C1 = EMA((VAR1 - VAR2) / (VAR3 - VAR2) * 100, 4)
```

In explicit update form:

```text
RSV_HLCC4_HH4_LL5 = 100 * (HLCC4 - LLV(LOW, 5)) / (HHV(HIGH, 4) - LLV(LOW, 5))
C1[t] = 0.4 * RSV_HLCC4_HH4_LL5[t] + 0.6 * C1[t-1]
```

Combined-data evidence:

- Best implied alpha cluster: `HLCC4`, period `4`
- Median implied C1 alpha: `0.4`
- Q1/Q3 implied C1 alpha: approximately `0.39994` / `0.40002`
- GPT-5.5-Pro's `HHV(high, 4) + LLV(low, 5)` range search improves C1 materially over the previous symmetric `HHV/LLV(4)` assumption.

Fair comparison using this project's exact targets:

| Dataset | `HH4/LL4` C1 RMSE | `HH4/LL5` C1 RMSE | `HH4/LL4` C1 p90 abs | `HH4/LL5` C1 p90 abs |
| --- | ---: | ---: | ---: | ---: |
| `03-39-10-237Z_vosxss` | 7.292051 | 3.357987 | 10.279960 | 0.824810 |
| `08-11-24-820Z_419jnr` | 6.948314 | 6.653701 | 12.029198 | 11.147492 |
| `09-20-21-062Z_62i2al` | 5.531938 | 5.793774 | 10.053025 | 10.065087 |
| Combined | 7.564010 | 5.103206 | 11.616980 | 5.002800 |

The `0.4` alpha is very strong evidence. The remaining mismatch means C1 is not proven bit-exact.

## Why C1 Is Not Fully Proven

Remaining C1 error is most likely caused by one or more of:

- TradingView intrabar state not matching the saved final OHLC snapshot.
- The indicator using a slightly different source stream than the visible K-line series.
- Session gaps and older recorder rows mixing non-synchronized C1/C2 values with later exact series data.
- Hidden range handling when the high/low windows change quickly.

The final file is better for synchronization, but it is short: only `109` exact bar targets and `119` exact C1/C2 points.

## Recorder State

The extension has been updated to preserve future exact data in these fields:

```text
instantBar
instantBarSeries
instantIndicatorSeries
instantFlashPoint
```

It also records `socket-aligned` samples when the same WebSocket payload contains both a K-line update and a matching Flash Point point:

```text
instantBar.time == instantFlashPoint.time
```

The analysis code treats `socket-aligned` samples as exact targets.

## Marker Rules

The GPT-5.5-Pro v0.7 package adds one hour of marker-focused records. These records do not change the C1/C2 formula, but they clarify the secondary marker thresholds:

```text
加倉 = crossover(C1, C2), marker y = C1
賣 = crossunder(C1, C2), marker y = C2
買 = crossover(C1, C2) and C1 < 40, marker y = 20
高位賣 = crossunder(C1, C2) and C1 > 90, marker y = 85
```

The rejected alternatives were:

```text
買 = crossover(C1, C2) and C2 < 40
高位賣 = crossunder(C1, C2) and C2 > 90
threshold check using interpolated crossValue
```

v0.7 validation summary:

| Dataset | Rule | TP | FP | FN | TN |
| --- | --- | ---: | ---: | ---: | ---: |
| All unique vectors | `買 = up and C1 < 40` | 120 | 0 | 0 | 1106 |
| All unique vectors | `高位賣 = down and C1 > 90` | 21 | 0 | 0 | 1205 |
| New one-hour clean records | `買 = up and C1 < 40` | 26 | 0 | 0 | 165 |
| New one-hour clean records | `高位賣 = down and C1 > 90` | 7 | 0 | 0 | 184 |

## Archived v0.7 Practical Formula

This was the final reconstructed formula before the author source code was available:

```text
HLCC4 = (HIGH + LOW + 2 * CLOSE) / 4
LL5 = LLV(LOW, 5)
HH4 = HHV(HIGH, 4)
RSV = 100 * (HLCC4 - LL5) / (HH4 - LL5)

C1 = EMA(RSV, 4)
C2 = EMA((C1 + 2 * REF(C1, 1)) / 3, 2)
```

Status:

- v0.7 remains useful for comparing old research runs.
- v0.8 exact is the current baseline for production signals and final backtests.
- Crossing labels still use C1/C2 crossing; secondary `買` and `高位賣` use current C1 thresholds.
