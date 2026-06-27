---
CRITICAL INSTRUCTIONS - READ FIRST
---

1. Read `~/.codex/LOCAL.md` first. If it has content, it has the highest priority and overrides conflicting rules in this file.
2. If `~/.codex/LOCAL.md` is missing or empty, follow this file.
3. Always respond to the user in Traditional Chinese, no matter what language the user uses.
4. `README.md` files must be written in English unless the user explicitly asks for another language.
5. Do not use default web search or WebFetch tools. If web search is needed, use the `/ccsearch` skill.

## Project Context

This workspace contains:

- The SuperShort Binance maker/GTX browser extension. This is the main product in the repo.
- A companion live paper trading dashboard and backend.
- A Binance maker/GTX trading model used by the extension and paper system.
- The `CrossingFetch` TradingView recorder/research extension.

Live deployment details are intentionally not stored in this public-safe file. Keep hostnames, SSH targets, private paths, database paths, domains, and operator-specific values in an uncommitted local override file.

Treat extension order-placement changes and paper dashboard changes as trading-system work. Keep changes conservative, scoped, and verified before deployment.

## Flash Point Pro v0.8 Exact Baseline

Future Flash Point Pro work must use the author's v0.8 exact formula unless the user explicitly asks to investigate another version.

Implementation source of truth:

- `src/server/flashpoint.ts`
- `test/flashpoint.test.ts`

Formula:

```text
typical_price = (2 * close + high + low) / 4

period_lowest  = ta.lowest(low, 5)
period_highest = ta.highest(high, 4)

price_range = period_highest - period_lowest
stoch_val = price_range == 0 ? 0 : ((typical_price - period_lowest) / price_range) * 100

C1 = fast_k = EMA(stoch_val, 4)

slow_d_base = 0.667 * nz(fast_k[1]) + 0.333 * fast_k
C2 = slow_d = EMA(slow_d_base, 2)
```

Important differences from old v0.7 research:

- Use zero-range `stoch_val = 0`.
- Do not clamp stoch to `0..100`.
- Use Pine-like EMA warmup.
- Use `slow_d_base = 0.667 * previous C1 + 0.333 * current C1`, then EMA(2).
- First `slow_d_base` uses `nz(fast_k[1])`, so missing previous C1 is `0`.

Signal rules:

```text
加倉 = crossover(C1, C2)
賣   = crossunder(C1, C2)

買 = crossover(C1, C2) and C1 < 40
高位賣 = crossunder(C1, C2) and C1 > 90
```

Strategy entry rules use configurable thresholds:

```text
Long  = crossover(C1, C2) and C1 < longBelow
Short = crossunder(C1, C2) and C1 > shortAbove
```

## Live Signal Display Rule

The worker trades from live active-candle previews, not only from closed candles.

This means an intrabar signal can appear, trigger a paper order, and later disappear from the reconstructed Flash Point line after the candle changes. When investigating a real entry, always inspect the `signals` table and the `paper_orders.signalId`. Do not rely only on reconstructed chart markers.

Dashboard chart work should show actual signal events from the `signals` table when the goal is to explain why a trade happened.

## Paper Trading Rules

The system is paper trading only unless the user explicitly asks for real order execution work.

Entry behavior:

- Uses Binance live websocket data.
- Uses a GTX/Post-Only maker model.
- Entry orders have `entryTtlMs`; if not filled in time, cancel with `entry_ttl_cancel`.
- `mode = single` means no new order while an order is pending/resting/partial/filled/open.
- Price velocity guard can block new entries while still recording signals.

SL behavior:

- `slEnabled` controls the entire SL system.
- If `slEnabled = false`, disable all SL behavior:
  - basic SL
  - SL ladder
  - emergency SL
  - maker SL retry
- If `slEnabled = false`, TP remains active.
- If `slEnabled = true`, SL uses the current ladder model.
- SL ladder quantities must be based on actual filled quantity, not intended order quantity.
- Multiple SL levels must not exceed current remaining position quantity.
- Partial SL/TP exits must add individual trade history records.
- Use `reduce-only` semantics in the model.

Current settings UI:

- `SL 系統` is a toggle.
- When disabled, hide SL configuration fields.
- When enabled, show:
  - `Maker SL retry ms`
  - `Emergency SL`
  - `SL Ladder trigger/limit/%`

## Binance Websocket Reliability

The Binance market stream must protect against stale connections.

Current expected behavior:

- Normal reconnect on `close` or `error`.
- Watchdog checks for stale connected sockets.
- If no Binance message arrives for the configured stale timeout, terminate the socket and reconnect.

If trades/signals stop but services are still active, check:

- `store.getHealth(...)`
- latest candles by interval
- latest `signals`
- latest `paper_orders`
- worker journal logs
- Binance websocket stale watchdog behavior

## Development Rules

- Prefer existing project patterns over new abstractions.
- Keep edits scoped to the requested behavior.
- Do not overwrite user data, downloaded JSONL recordings, generated reports, zip archives, or SQLite databases unless the user explicitly asks.
- Use `rg` or `rg --files` for searching.
- Use `apply_patch` for manual file edits.
- If future work changes Flash Point Pro behavior, update implementation and tests together.
- If future work changes paper trading behavior, add or update tests under `test/`.

## Verification Requirements

Before reporting completion, run the relevant checks and inspect the output.

For SuperShort dashboard/backend changes:

```bash
npm test
npm run typecheck
npm run build
```

For Pi5 deployment changes:

```bash
ssh user@host 'cd /path/to/supershort-live && npm ci && npm test && npm run typecheck && npm run build'
ssh user@host 'sudo systemctl restart supershort-api.service supershort-worker.service && sleep 2 && systemctl is-active supershort-api.service supershort-worker.service cloudflared.service && curl -fsS http://127.0.0.1:8788/api/health'
curl -I -s https://your-dashboard.example.com | head
```

For `CrossingFetch` changes:

```bash
node --test CrossingFetch/test/*.test.js
node --check CrossingFetch/flashpoint-algo.js
node --check CrossingFetch/content.js
node --check CrossingFetch/injected.js
node --check CrossingFetch/core.js
node --check CrossingFetch/analysis/flash-point-model.js
node --check CrossingFetch/analysis/fit-exact-flash-point.js
```

For documentation-only changes, inspect the changed file and report that no runtime tests were needed.

## Communication Style

- Final responses must be concise, direct, and in Traditional Chinese.
- Explain the result, actual changes, reason, and verification.
- Avoid engineering theater and vague status language.
- When multiple options exist, list pros and cons and recommend one.
