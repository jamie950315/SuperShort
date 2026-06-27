# CrossingFetch Design

## Goal

Build a separate Chrome/Edge Manifest V3 extension under `CrossingFetch/` that records TradingView K-line data and observable Flash Point Pro values so the algorithm can be reverse-engineered later.

## Completion Criteria

- The extension can be loaded independently from `CrossingFetch/`.
- It runs on `tw.tradingview.com` and `www.tradingview.com`.
- It records TradingView OHLCV bars from WebSocket messages when available.
- It reads visible Flash Point Pro text from the page, including C1/C2 values when TradingView exposes them in DOM text.
- It supports two modes:
  - `bar`: one final observed sample per completed K line.
  - `live`: one sample per configured interval.
- It exports records as JSONL.
- It reports whether Flash Point Pro values were readable instead of silently inventing values.
- Core parsing logic has executable Node tests.

## Architecture

`injected.js` runs in the page context and mirrors TradingView WebSocket text messages to the content script through `window.postMessage`. `content.js` uses `core.js` to parse those messages, extract OHLCV bars, sample visible Flash Point Pro text, and save records into IndexedDB. The floating panel controls start, stop, mode, interval, export, and clear operations.

## Components

- `manifest.json`: extension metadata and TradingView permissions.
- `core.js`: pure parsing and signal helpers shared by tests and browser scripts.
- `injected.js`: WebSocket observer for TradingView chart messages.
- `content.js`: UI, recorder loop, IndexedDB persistence, JSONL export.
- `content.css`: floating panel styling.
- `test/core.test.js`: Node tests for TradingView frame parsing, bar extraction, Flash Point text parsing, and crossing detection.

## Data Model

Each JSONL row is one sample:

```json
{
  "schema": "crossing-fetch.sample.v1",
  "sessionId": "cf_2026-06-21T10:00:00.000Z_x7p9",
  "mode": "bar",
  "reason": "bar-final-observed",
  "recordedAt": "2026-06-21T10:01:00.500Z",
  "page": {
    "url": "https://www.tradingview.com/chart/...",
    "title": "BTCUSDT"
  },
  "market": {
    "symbol": "BTCUSDT",
    "timeframe": "unknown"
  },
  "bar": {
    "time": 1782007200000,
    "open": 100,
    "high": 105,
    "low": 99,
    "close": 104,
    "volume": 12345
  },
  "flashPoint": {
    "c1": 77.06,
    "c2": 58.97,
    "readable": true,
    "signals": ["sell"]
  },
  "derived": {
    "crossing": "up"
  }
}
```

## Error Handling

If TradingView changes its message format, the recorder keeps running and reports `bars: 0`. If C1/C2 are drawn only on canvas, the sample stores `readable: false` with `c1` and `c2` as `null`. Export still works so partial data is not lost.

## Testing

Run:

```bash
node --test CrossingFetch/test/*.test.js
```

Manual verification:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Load unpacked `CrossingFetch/`.
4. Open a TradingView chart with Flash Point Pro visible.
5. Start recording.
6. Export JSONL and inspect whether bars and visible Flash Point values are present.
