# CrossingFetch

CrossingFetch is a Chrome/Edge Manifest V3 extension for recording TradingView K-line data and visible Flash Point Pro values.

It is a recorder, not a trading tool. The exported JSONL data is intended for later analysis and algorithm reconstruction.

## Canonical Algorithm

Future development should use the Flash Point Pro v0.8 exact reconstruction as the baseline:

- runtime implementation: `flashpoint-algo.js`
- Pine Script reference: `flashpoint-reconstructed.pine`
- algorithm notes: `analysis/v08-canonical-algorithm.md`

The current baseline is:

```text
typical_price = (2 * close + high + low) / 4
period_lowest = ta.lowest(low, 5)
period_highest = ta.highest(high, 4)
stoch_val = price_range == 0 ? 0 : ((typical_price - period_lowest) / price_range) * 100
C1 = fast_k = ta.ema(stoch_val, 4)
slow_d_base = 0.667 * nz(fast_k[1]) + 0.333 * fast_k
C2 = slow_d = ta.ema(slow_d_base, 2)
```

Secondary markers use current C1 thresholds:

```text
買 = crossover(C1, C2) and fast_k < 40
高位賣 = crossunder(C1, C2) and fast_k > 90
```

## Install

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer Mode.
3. Choose Load unpacked.
4. Select the `CrossingFetch` folder.
5. Open a TradingView chart with Flash Point Pro visible.

## Recording Modes

- `Bar close`: stores the final observed sample for each completed K line.
- `Live interval`: stores one sample per configured interval.

## Export

Click `Export JSONL` in the floating panel. Each line is one sample with:

- page URL and title
- guessed symbol and timeframe
- latest OHLCV bar captured from TradingView WebSocket messages
- visible C1/C2 Flash Point Pro values when readable from page text
- visible signal labels when readable from page text
- derived C1/C2 crossing direction

If TradingView draws Flash Point Pro text only on canvas, C1/C2 may be exported as `null` with `readable: false`.

Exports are streamed from IndexedDB in chunks before the final download Blob is created. This keeps large sessions from requiring one full in-memory JSONL string.

## Storage Cleanup

- `Clear Session` deletes only the current recording session and starts a fresh session id.
- `Clear All` deletes every stored sample in the local CrossingFetch IndexedDB store and resets in-memory duplicate filters.

## Exact Indicator Matching

CrossingFetch still prefers the known Flash Point Pro internal series path when it is present. If TradingView changes that path, the recorder and analysis scripts only use a fallback series when its first two values closely match the visible C1/C2 values. Ambiguous fallback candidates are skipped instead of guessed.
