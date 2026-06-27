# Flash Point Pro v0.7 Canonical Algorithm

Archived note: v0.8 exact is now the active baseline because the indicator author provided the Pine source code. Use `CrossingFetch/analysis/v08-canonical-algorithm.md` for current work.

This is the development baseline for CrossingFetch after the GPT-5.5-Pro v0.7 review.

## Core Formula

```text
HLCC4 = (HIGH + LOW + 2 * CLOSE) / 4
HH4 = HHV(HIGH, 4)
LL5 = LLV(LOW, 5)
RSV = clamp(100 * (HLCC4 - LL5) / (HH4 - LL5), 0, 100)

C1 = EMA(RSV, 4)
C2 = EMA((C1 + 2 * REF(C1, 1)) / 3, 2)
```

Equivalent update form:

```text
C1[t] = 0.4 * RSV[t] + 0.6 * C1[t-1]
C2[t] = (2 * C1[t] + 4 * C1[t-1] + 3 * C2[t-1]) / 9
```

When `HH4 == LL5`, reuse the previous RSV value. If there is no previous RSV, use `50`.

## Marker Rules

```text
加倉 = crossover(C1, C2), marker y = C1
賣 = crossunder(C1, C2), marker y = C2
買 = crossover(C1, C2) and C1 < 40, marker y = 20
高位賣 = crossunder(C1, C2) and C1 > 90, marker y = 85
```

Important v0.7 correction:

- `買` uses current `C1 < 40`, not `C2 < 40` and not interpolated `crossValue < 40`.
- `高位賣` uses current `C1 > 90`, not `C2 > 90` and not interpolated `crossValue > 90`.

## Local Baseline Files

- Runtime implementation: `CrossingFetch/flashpoint-algo.js`
- Pine Script reference: `CrossingFetch/flashpoint-reconstructed.pine`
- Evidence report: `CrossingFetch/analysis/final-flash-point-report.md`
- Regression tests: `CrossingFetch/test/flashpoint-algo.test.js`

Future development should reuse `CrossingFetch/flashpoint-algo.js` instead of reimplementing C1/C2 or marker rules ad hoc.
