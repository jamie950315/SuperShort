# Flash Point Pro Reverse Engineering Notes

Final consolidated report: `CrossingFetch/analysis/final-flash-point-report.md`.

Current canonical v0.8 exact baseline: `CrossingFetch/analysis/v08-canonical-algorithm.md`.

Archived v0.7 reconstruction baseline: `CrossingFetch/analysis/v07-canonical-algorithm.md`.

## Current Data

Primary files:

- `crossing-fetch-cf_2026-06-21T03-39-10-237Z_vosxss.jsonl`
- `crossing-fetch-cf_2026-06-21T08-11-24-820Z_419jnr.jsonl`
- `crossing-fetch-cf_2026-06-21T09-20-21-062Z_62i2al.jsonl`

Useful sample count:

- Old long file: 2,490 raw rows, 1,883 bar-final samples, 607 crossing-event samples.
- New path-aware file: 257 raw rows, 219 bar-final samples, 38 crossing-event samples.
- New path-aware file has 219 exact bar-final targets, 250 paired exact Flash Point points, and 250 paired bar points.
- Latest instant-snapshot file: 121 raw rows, 109 bar-final samples, 12 crossing-event samples.
- Latest instant-snapshot file has 121 rows with instant K-line data and 121 rows with instant indicator data, but only 51 rows have the `l9uPDe` Flash Point point at the same timestamp as the instant K-line.

Time coverage:

- Old file: `2026-06-21T03:39:10.000Z` to `2026-06-21T07:06:35.000Z`.
- New file: `2026-06-21T08:11:20.000Z` to `2026-06-21T08:34:45.000Z`.
- New file paired exact series gaps: 222 five-second gaps, 22 ten-second gaps, and 5 fifteen-second gaps.

## Confirmed Facts

- The TradingView indicator series sometimes exposes exact C1/C2 values in `indicatorSeries`.
- Rows whose indicator path includes `l9uPDe` have first two numeric values matching visible C1/C2.
- `FiJXgz` appears to be a different plotted series and should not be treated as C1/C2.
- `1e+100` values are TradingView plot placeholders and must be ignored for bar parsing.
- C1/C2 crossing must be recorded immediately; waiting for bar-final samples loses intrabar crossings.
- The current data is large enough for fitting. The remaining issue is the exact C1 input transform, not sample count.
- C2 is now effectively solved on the new path-aware file.
- Exact internal C1/C2 values are available in 612 bar-final rows and 925 rows overall through the `l9uPDe` indicator series.
- Exact internal C1/C2 values are available in every bar-final row in the new path-aware file.
- The recorder now saves `socket-aligned` rows immediately when the same WebSocket payload contains both a K-line update and a matching `l9uPDe` Flash Point point. These rows are treated as exact targets by the analysis scripts.

## Solved C2 Recurrence

On the new path-aware file, C2 is reproduced by:

```text
C2[t] = (2 * C1[t] + 4 * C1[t-1] + 3 * C2[t-1]) / 9
```

Equivalent form:

```text
C2[t] = 2/9 * C1[t] + 4/9 * C1[t-1] + 1/3 * C2[t-1]
```

Fit result:

```json
{
  "points": 249,
  "rmse": 0.0030786116839820513,
  "maxAbs": 0.008670180622717183
}
```

This is close enough that the remaining difference is likely floating-point precision, rounding, or TradingView's internal plot precision.

This recurrence is equivalent to the common indicator expression:

```text
C2 = EMA((C1 + 2 * REF(C1, 1)) / 3, 2)
```

## Best Formula Family So Far

The closest tested family is stochastic RSV followed by smoothing:

```text
source = HLC3 = (high + low + close) / 3
RSV = 100 * (source - lowest(low, period)) / (highest(high, period) - lowest(low, period))
C1 ≈ EMA(RSV, 4)
C2 ≈ EMA(C1, 3)
```

Best current standard stochastic fit on the new path-aware file:

```json
{
  "name": "c1-alpha-c2-sma",
  "params": {
    "sourceName": "hlc3",
    "rsvPeriod": 4,
    "c1Alpha": 0.425,
    "c2Period": 3
  },
  "c1Rmse": 6.840342796599195,
  "c2Rmse": 8.477039929350873,
  "totalRmse": 7.7022884761217405
}
```

The standard family remains a poor exact reconstruction. It identifies the neighborhood, but it does not explain C1.

## Stronger Recurrence Evidence

A direct least-squares recurrence search gives a clearer structure:

```text
C1[t] ≈ 0.3741385 * RSV_HLC3_4[t]
      + 0.6446298 * C1[t-1]
      + 0.1202920

C2[t] ≈ 0.4528004 * C1[t]
      + 0.6000494 * C2[t-1]
      - 2.8831629
```

Fit quality:

```json
{
  "c1": {
    "sourceName": "hlc3",
    "rsvPeriod": 4,
    "rmse": 5.003312680074452
  },
  "c2": {
    "input": "c1",
    "rmse": 3.511737649229217
  }
}
```

This older recurrence search is superseded for C2 by the exact recurrence above. The C1 side is still useful evidence that a direct stochastic formula is missing one input transform.

## Exact-Series Search

`fit-exact-flash-point.js` scores only rows where the internal `l9uPDe` series exposes unrounded C1/C2. It also computes implied one-step C1 alpha values from exact intrabar observations.

Current result on the new path-aware file:

```json
{
  "exactBarFinalTargets": 219,
  "bestFormulaCandidate": {
    "name": "c1-alpha-c2-sma",
    "params": {
      "sourceName": "hlc3",
      "rsvPeriod": 4,
      "c1Alpha": 0.425,
      "c2Period": 3
    },
    "c1Rmse": 6.840342796599195,
    "c2Rmse": 8.477039929350873,
    "totalRmse": 7.7022884761217405
  },
  "c2WeightedRecurrence": {
    "rmse": 0.0030786116839820513,
    "maxAbs": 0.008670180622717183
  }
}
```

The strongest new clue is the implied C1 smoothing coefficient. When each exact C1 point is compared against the previous final C1 and a current-bar RSV candidate, the best grouping is:

```json
{
  "sourceName": "hlc3",
  "rsvPeriod": 4,
  "count": 913,
  "median": 0.4000000000015202,
  "q1": 0.39744314035420736,
  "q3": 0.4299529646157404
}
```

The same clue remains in the new file. The implied C1 smoothing coefficient repeatedly centers on `0.4`, equivalent to a 4-period EMA-style update:

```text
C1[t] ≈ 0.4 * input[t] + 0.6 * C1[t-1]
```

The strongest C1 source candidate is now `HLCC4`, not plain `HLC3`. After reviewing the GPT-5.5-Pro progress package, the best range window is asymmetric: `HHV(HIGH, 4)` with `LLV(LOW, 5)`.

```text
HLCC4 = (HIGH + LOW + 2 * CLOSE) / 4
RSV = 100 * (HLCC4 - LLV(LOW, 5)) / (HHV(HIGH, 4) - LLV(LOW, 5))
C1 ≈ EMA(RSV, 4)
```

The implied-alpha diagnostic for this candidate is unusually strong:

```json
{
  "sourceName": "hlcc4",
  "rsvPeriod": 4,
  "count": 248,
  "median": 0.4,
  "q1": 0.39999999999999986,
  "q3": 0.40000000000000013
}
```

That q1/median/q3 cluster is the strongest C1 evidence so far.

The remaining mismatch appears around bars where current OHLC snapshots make RSV collapse toward 0 while the indicator keeps C1 high. Some of those cases look like intrabar timing, precision, or TradingView series-state differences rather than a different formula family.

## Interpretation

C2 is solved to near-exact precision. C1 is not fully bit-exact yet, but the strongest full formula candidate is now:

```text
VAR1 = (HIGH + LOW + 2 * CLOSE) / 4
VAR2 = LLV(LOW, 5)
VAR3 = HHV(HIGH, 4)
C1 = EMA((VAR1 - VAR2) / (VAR3 - VAR2) * 100, 4)
C2 = EMA((C1 + 2 * REF(C1, 1)) / 3, 2)
```

This matches the known C2 recurrence exactly and gives the strongest C1 alpha evidence. The remaining C1 error means this should be treated as the leading reconstruction, not a proven bit-for-bit clone.

The latest extension update keeps numeric indicator series cached by path, so future bar-final rows can include the most recent exact Flash Point Pro internal series instead of only the series attached to the latest WebSocket message.

It also writes a `socket-aligned` sample as soon as the WebSocket payload contains both:

```text
instantBar.time == instantFlashPoint.time
```

This is intended to catch intrabar C1/C2 crossings that happen between regular recorder ticks.

GPT-5.5-Pro v0.7 adds marker-threshold evidence from an extra one-hour capture. It does not change the C1/C2 formula, but it corrects the secondary marker rules:

```text
買 = crossover(C1, C2) and C1 < 40
高位賣 = crossunder(C1, C2) and C1 > 90
```

Using C2 or interpolated `crossValue` for those secondary thresholds produced false positives in the marker slots.

The recorder now also stores path-aware OHLC bar series:

```text
sample.bar.sourcePath
sample.barSeries[].path
sample.barSeries[].recentPoints
sample.indicatorSeries[].recentPoints
```

This is necessary because the largest remaining errors look like the recorded OHLC bars may not be the exact series used by Flash Point Pro, or may need historical points that were not preserved in the first recordings. Future JSONL files can now prove which TradingView series supplied the K-line data and can retain recent series history for reconstruction.

`recentPoints` is now accumulated by series path across WebSocket messages, not just copied from the latest message. Each stored series keeps up to 20 deduped recent points sorted by time. This should make the next recording much more useful for reconstructing the exact RSV window and C1/C2 state.

The fitting code now reads exact Flash Point values from both:

```text
indicatorSeries[].latest
indicatorSeries[].recentPoints
```

`buildExactBarFinalTargets()` uses those historical points when they match a sample bar time, so new-format JSONL files should produce more exact target rows without changing the analysis command.

A direct shift check does not support a simple one-bar alignment error. With the current best common approximation, shift `0` is much better than +/- 1 or larger:

```json
{
  "shift": 0,
  "c1Rmse": 9.426592735113633,
  "c2Rmse": 10.718663073468733
}
```

So the mismatch is more likely input-source/history/range handling than a plain series offset.

The latest exact-fit script also checks C2 by exact recurrence:

```json
{
  "c2WeightedRecurrence": {
    "all": {
      "count": 249,
      "rmse": 0.0030786116839820513
    },
    "contiguous5s": {
      "count": 222,
      "rmse": 0.0030517615198390117
    }
  },
  "bestC1InputDiagnostic": {
    "sourceName": "hlc3",
    "rsvPeriod": 4,
    "mode": "closest-normal-or-inverse",
    "rmse": 9.769541818463454,
    "chooseInverse": 10
  }
}
```

Interpretation:

- C2 is not `SMA(C1, 3)`; it is the weighted recurrence above.
- Letting each row choose normal RSV or inverse RSV improves C1 input fit only slightly. That is useful diagnostically, but it is not a credible original formula by itself.
- The new file has enough source-path and recent-point history to solve C2, but C1 still requires more input-source search.

## Next Search Directions

1. Treat C2 as solved and use the recurrence above.
2. Treat `HLCC4 + HHV(HIGH, 4) + LLV(LOW, 5) + EMA(4)` as the leading C1 reconstruction.
3. Investigate the remaining C1 error around intrabar updates where final OHLC makes raw RSV collapse but C1 remains high.
4. Capture exact bar snapshots and exact C1/C2 at the same WebSocket update if bit-for-bit matching is required.
5. Capture full historical WebSocket series payloads if exact reconstruction stalls, because current samples store only the latest 20 path-cached points.
