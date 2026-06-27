# Flash Point Pro v0.8 Exact Canonical Algorithm

This is the active development baseline for CrossingFetch after the indicator author provided the Pine v5 source code.

## Core Formula

```text
typical_price = (2 * close + high + low) / 4

period_lowest = ta.lowest(low, 5)
period_highest = ta.highest(high, 4)

price_range = period_highest - period_lowest
stoch_val = price_range == 0 ? 0 : ((typical_price - period_lowest) / price_range) * 100

C1 = fast_k = ta.ema(stoch_val, 4)

slow_d_base = 0.667 * nz(fast_k[1]) + 0.333 * fast_k
C2 = slow_d = ta.ema(slow_d_base, 2)
```

Pine EMA seeding is part of the baseline. On the first bar, `nz(fast_k[1])` is `0`, so the first `slow_d_base` is `0.333 * fast_k`.

## Marker Rules

```text
加倉 = ta.crossover(fast_k, slow_d), marker y = fast_k
賣 = ta.crossunder(fast_k, slow_d), marker y = slow_d
買 = ta.crossover(fast_k, slow_d) and fast_k < 40, marker y = 20
高位賣 = ta.crossunder(fast_k, slow_d) and fast_k > 90, marker y = 85
```

## v0.7 Differences

```text
zero price range: v0.8 uses 0, v0.7 reused previous RSV
stoch clamp: v0.8 does not clamp
warmup: v0.8 follows Pine and computes from the first available bar
C2: v0.8 uses slow_d_base = 0.667 * nz(fast_k[1]) + 0.333 * fast_k, then EMA(2)
C2 initialization: first slow_d equals first slow_d_base
```

## Local Baseline Files

- Runtime implementation: `CrossingFetch/flashpoint-algo.js`
- Pine Script reference: `CrossingFetch/flashpoint-reconstructed.pine`
- Regression tests: `CrossingFetch/test/flashpoint-algo.test.js`
- Intrabar grid implementation: `CrossingFetch/analysis/flashpoint-rule-grid.js`
- Intrabar grid tests: `CrossingFetch/test/flashpoint-rule-grid.test.js`

Future Flash Point Pro research and production signal work should use v0.8 exact unless explicitly comparing against the archived v0.7 reconstruction.
