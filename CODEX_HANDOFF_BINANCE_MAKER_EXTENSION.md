# Codex Handoff: SuperShort

Current release package: `SuperShort-extension-0.4.1.zip`
Current extension name in `manifest.json`: `SuperShort`
Current version in `manifest.json`: `0.4.1`
Extension type: Chrome/Edge Manifest V3
Target sites: Binance Futures, TradingView (`tw.tradingview.com`, `www.tradingview.com`)
Primary goal: ultra-fast post-only maker order workflow for Binance USD-M Futures, with full-position reduce-only exits and optional automatic settlement.

## Critical safety notes

This is a real-money futures trading extension. Treat every change as potentially dangerous.

Never hardcode API keys, secrets, account IDs, IPs, or user-specific values. If a key appears in chat history or local notes, assume it is compromised and do not reuse it.

The extension stores Binance API key and secret in Chrome extension local storage. The intended API key permissions are:

- Read enabled
- Futures trading enabled
- Withdraw disabled
- IP restriction enabled

The extension must preserve these invariants:

- All entry and exit orders use `LIMIT` + `timeInForce=GTX`.
- Never silently downgrade to market order.
- Never intentionally place taker orders.
- Reduce-only exits must use `reduceOnly=true`.
- Opposite-side press while holding a position must close the full current live position, not only the configured input amount.
- Manual full-position exits must cancel old extension-created same-side reduce-only exit orders first.
- Do not cancel manually-created Binance TP/SL orders; only target extension-created IDs.
- Automatic settlement orders must be reduce-only and GTX.
- Dry run must not place orders, cancel orders, change leverage, or mutate live trading state.

## Current file layout

```text
binance-maker-extension/
  manifest.json
  background.js
  content.js
  content.css
  popup.html
  popup.js
  README.md
```

## High-level architecture

`background.js` is the trading engine and Binance API layer. It owns config, HMAC signing, order placement, reduce-only replacement, auto-settlement pending state, fast settlement watcher, exchange filter cache, position cache, and exit order index.

`content.js` injects the floating trading panel into Binance/TradingView pages. It handles UI input, draggable/resizable panel state, current price display, position PnL display, auto-settlement preview, and click messages to the background worker.

`content.css` styles the panel.

`popup.html` and `popup.js` provide extension settings: API key/secret, endpoint, amount, leverage, offset ticks, exit chase retries, auto-settlement toggle/ROI, dry run, reduce-only mode, and replace-exit mode.

`manifest.json` contains host permissions and content script matches.

## Current message API

`content.js` and `popup.js` talk to `background.js` via `chrome.runtime.sendMessage()`.

Current message types in `background.js`:

```text
GET_CONFIG
SAVE_CONFIG
WARMUP_SYMBOL
GET_TRADING_SNAPSHOT
PLACE_MAKER_ORDER
```

Expected behavior:

- `GET_CONFIG`: returns normalized config and masked API key.
- `SAVE_CONFIG`: validates and saves config.
- `WARMUP_SYMBOL`: preloads symbol filters, HMAC key, exit index.
- `GET_TRADING_SNAPSHOT`: returns current price, position, auto-settlement preview, pending settlement processing status.
- `PLACE_MAKER_ORDER`: computes maker-safe price, sizing, reduce-only state, replacement cancels, leverage change when needed, order submit, auto-settlement registration.

## Current default config

Check the `DEFAULTS` object in `background.js`. Current notable defaults:

```text
baseUrl = https://fapi.binance.com
quoteAmount = 100
leverage = 20
offsetTicks = 0
exitChaseRetries = 2
autoSettlementEnabled = false
autoSettlementRoiPct = 1
dryRun = true
autoReduceOnly = true
replaceReduceOnly = true
```

`quoteAmount` means original margin amount before leverage multiplication.

For opening/adding positions:

```text
notional = quoteAmount * leverage
quantity = floorToStep(notional / makerPrice, stepSize)
```

For full-position exits:

```text
quantity = abs(live positionAmt from fresh positionRisk)
```

## Maker pricing logic

Current formula:

```text
makerTicks = offsetTicks + 1
BUY price  = askPrice - tickSize * makerTicks
SELL price = bidPrice + tickSize * makerTicks
```

`offsetTicks=0` means closest maker-safe price. `offsetTicks=1` means one extra tick away from crossing.

All orders use `LIMIT` + `GTX`. If price becomes crossing during network delay, Binance rejects/expires the order instead of filling as taker.

## Reduce-only and replace-exit logic

When user presses the opposite side of a current position:

```text
positionAmt > 0 and side=SELL => full-position long exit, reduceOnly=true
positionAmt < 0 and side=BUY  => full-position short exit, reduceOnly=true
```

For reduce-only exits, `quoteAmount` input is ignored. The order size is based on fresh live `positionRisk`.

Before placing a new reduce-only exit, the extension reconciles old extension-created exits from:

1. Local `exitOrderIndex` cache.
2. Live Binance `GET /fapi/v1/openOrders` for the same symbol and side.

The cancel filter must be price-independent and quantity-independent. It should cancel old extension-created reduce-only exits even if the old exit order has a different price and smaller quantity.

Client order ID prefixes that identify extension-created orders:

```text
mb_buy_
mb_sell_
mb_tp_buy_
mb_tp_sell_
```

Manual Binance TP/SL orders must remain untouched.

Batch cancel uses `DELETE /fapi/v1/batchOrders` with fallback to single cancel. If live open-order reconciliation fails before placing a reduce-only exit, block the new exit rather than stacking another unknown reduce-only order.

Important user scenario that must continue to pass:

```text
1. User has a long position.
2. User presses Sell; extension creates a SELL reduceOnly exit but it does not fill.
3. User presses Buy again to add more long size.
4. User presses Sell again.
5. Extension must cancel the old SELL reduceOnly exit regardless of old price/quantity.
6. Extension must place one new SELL reduceOnly exit for the full current live position size.
```

Same mirrored behavior must work for short positions.

## Exit chase retries

`exitChaseRetries` applies only to reduce-only exits.

If a reduce-only GTX close is rejected because the maker price became crossing, the extension should:

1. Refetch latest `bookTicker`.
2. Recalculate maker-safe price.
3. Retry the reduce-only GTX exit.

Open/add orders do not use this chase retry path.

## Automatic settlement in 0.2.7

Feature name: automatic settlement.

User controls:

- Toggle enable/disable.
- ROI percentage input from `0.01` to `100`.
- Percentage is leveraged ROI, meaning after leverage.
- UI previews expected profit and settlement prices.

Settlement formula:

```text
underlyingMove = leveragedRoiPct / 100 / leverage

Long entry:
  settlement SELL price = entryPrice * (1 + underlyingMove)

Short entry:
  settlement BUY price = entryPrice * (1 - underlyingMove)

expectedProfit ≈ originalMarginAmount * leveragedRoiPct / 100
```

Settlement price must be rounded to the correct tick side:

- SELL target rounds upward/valid maker side as implemented in `buildAutoSettlementPlan`.
- BUY target rounds downward/valid maker side as implemented in `buildAutoSettlementPlan`.

After an opening or adding order is accepted, the extension registers a pending settlement plan. When the entry order actually fills, it sends an opposite-side `LIMIT GTX reduceOnly=true` settlement order.

Current latency design:

```text
entry accepted
=> add pending settlement to memory immediately
=> start fast watcher immediately
=> watcher polls entry order every 120 ms for first 3.5 s
=> then every 1000 ms up to 30 s
=> when executedQty increases, place settlement order for delta quantity
```

The snapshot loop is not the primary auto-settlement path. It is a fallback/UI sync path.

Partial fill behavior:

If an entry order fills in pieces, the extension should place settlement orders for each newly filled delta.

Example:

```text
BUY 0.010 BTC entry
executedQty 0.003 => place SELL reduceOnly 0.003 TP
executedQty 0.007 => delta 0.004 => place SELL reduceOnly 0.004 TP
executedQty 0.010 => delta 0.003 => place SELL reduceOnly 0.003 TP
```

This avoids placing reduce-only quantity larger than the actually opened position and ensures later fills are also covered.

Manual full-position exits must cancel extension-created auto-settlement orders too, using the `mb_tp_` prefix.

## Snapshot loop

`content.js` currently calls `refreshSnapshot(false)` every 250 ms.

Purpose:

- Update UI current price.
- Update average entry price and unrealized PnL display.
- Update auto-settlement preview.
- Process pending settlement fallback/recovery.
- Recover after service worker restart or page reload.

This interval was intentionally reduced to 250 ms by user request so current price, position, PnL, and auto-settlement preview all refresh at the same pace. It increases REST load and UI churn. Auto-settlement latency should still rely on User Stream and fast watcher paths rather than the snapshot loop alone.

## Latency-sensitive paths

Keep these paths small and non-blocking.

Entry/open/add path:

```text
get filters cache or exchangeInfo
get live bookTicker
get positionRisk or cached position for reduce-only decision
change leverage only if opening/adding and leverage differs
send LIMIT GTX order
if auto-settlement enabled, register pending settlement and start watcher immediately
```

Full-position exit path:

```text
get filters cache or exchangeInfo
get live bookTicker
get fresh positionRisk
reconcile old extension-created exits via local index + live openOrders
batch cancel old same-side reduceOnly exits
send LIMIT GTX reduceOnly full-size order
if GTX reject, chase retry using latest bookTicker
```

Auto-settlement fast path:

```text
query entry order by origClientOrderId
if executedQty > placedQty:
  delta = executedQty - placedQty
  place opposite LIMIT GTX reduceOnly for delta at precomputed target
if GTX reject:
  fetch bookTicker and retry maker-safe adjusted price
```

Current known performance tradeoff: full-position exits intentionally use fresh `positionRisk` for safety. Do not replace this with stale UI cache without adding strong safeguards.

## Current UI features

Injected panel:

- Default bottom-right.
- Draggable via title bar.
- Resizable via CSS `resize: both`.
- Position and size persisted.
- Current price above Long/Short buttons.
- If long, average entry under Long button and PnL next to Sell text.
- If short, average entry under Short button and PnL next to Buy text.
- Auto-settlement toggle and ROI input.
- Auto-settlement preview: expected profit, Long->Sell price, Short->Buy price.
- Dry run, reduce-only, replace-exit toggles.

Important UI fault handling:

After extension reload, old content scripts may throw `Extension context invalidated`. Current code should catch this, stop timers, disable trading buttons, and ask user to reload the page.

## API endpoints currently used

Public:

```text
GET /fapi/v1/exchangeInfo
GET /fapi/v1/ticker/bookTicker
```

Signed:

```text
POST   /fapi/v1/order
DELETE /fapi/v1/order
DELETE /fapi/v1/batchOrders
GET    /fapi/v1/order
GET    /fapi/v1/openOrders
GET    /fapi/v3/positionRisk
POST   /fapi/v1/leverage
```

Mainnet base URL:

```text
https://fapi.binance.com
```

Testnet base URL:

```text
https://testnet.binancefuture.com
```

## Current 0.2.8 Hybrid User Stream work

Goal: reduce auto-settlement latency by replacing REST polling as the primary fill detector with Binance USD-M Futures WebSocket user data stream.

Order execution still uses REST. WebSocket is only used for event detection.

Implemented in the current working tree:

```text
- manifest version bumped to 0.2.8.
- Mainnet/Testnet WebSocket host permissions added.
- listenKey startup and keepalive added for non-dry-run automatic settlement.
- User Stream WebSocket status is tracked in memory.
- ORDER_TRADE_UPDATE events for mb_buy_ / mb_sell_ entry IDs trigger pending settlement processing.
- Settlement quantity still uses accumulated fill minus already placed quantity.
- REST fast watcher and snapshot fallback remain available when WS is not connected.
- Dry run does not request a listenKey or open a WebSocket.
- Content panel shows WS connected / fallback / dry-run status.
- Node tests cover URL mapping, event filtering, delta sizing, dry-run stream suppression, and partial-fill settlement order shape.
```

Possible follow-up hardening:

1. Strengthen reconnect reconciliation.
   - On reconnect, reconcile pending entries using REST `GET /fapi/v1/order`.
   - Confirm storage state cannot miss a fill after service worker restart.

2. Track extension-created exit and TP events from User Stream.
   - Use `mb_tp_` and reduce-only exit order events to keep local indexes fresher.
   - Keep manual Binance TP/SL orders untouched.

3. Add stronger event deduplication metadata.
   - Persist last processed accumulated fill per pending entry.
   - Consider order ID + trade ID + accumulated fill for diagnostics.

4. Live Testnet validation.
   - Confirm Mainnet/Testnet listenKey WebSocket paths in the loaded extension.
   - Verify partial fills on Testnet before any Mainnet use.

Acceptance criteria for 0.2.8:

```text
- Entry order accepted while WS connected.
- Entry partial fill event arrives.
- Settlement reduceOnly GTX order is placed without waiting for 120 ms REST polling.
- Multiple partial fills produce delta-sized settlement orders.
- If WS disconnects, REST polling fallback still places settlement.
- Extension reload does not create duplicate settlement orders for already processed fill quantity.
- Dry run does not open WebSocket trading side effects beyond status if needed.
- No API key/secret appears in logs.
```

## Current 0.2.9 Market data WebSocket work

Goal: reduce `bookTicker` REST latency and UI polling load.

Added Binance Futures market WebSocket for `bookTicker` per active symbol. It keeps a low-age bid/ask cache for the floating panel's current-price display.

Implemented in the current working tree:

```text
- manifest version bumped to 0.2.9.
- Public market bookTicker WebSocket URL builder added.
- WARMUP_SYMBOL starts the market stream for the active symbol.
- GET_MARKET_TICKER returns a lightweight cached price snapshot without signed REST.
- content.js polls GET_MARKET_TICKER every 250 ms for the current price only.
- The existing 2 s GET_TRADING_SNAPSHOT loop remains for position/PnL/auto-settlement preview.
- Order placement still uses the existing maker-only REST path and LIMIT GTX safeguards.
- Node tests cover bookTicker URL mapping and cache updates.
```

## Current 0.2.10 250 ms snapshot work

Goal: make every visible panel update path refresh at 250 ms by user request.

Implemented in the current working tree:

```text
- manifest version bumped to 0.2.10.
- content.js now defines SNAPSHOT_INTERVAL_MS = 250.
- startSnapshotLoop uses SNAPSHOT_INTERVAL_MS instead of a hardcoded 2000 ms.
- MARKET_TICKER_INTERVAL_MS remains 250.
- Node tests cover both panel intervals.
```

Important tradeoff:

```text
GET_TRADING_SNAPSHOT still reads bookTicker/positionRisk and triggers pending-settlement fallback processing.
At 250 ms this can increase REST load compared with the older 2 s loop.
```

## Current 0.3.1 repeated-close protection

Problem observed:

```text
- Market WebSocket connection failures could create repeated connection attempts because the 250 ms panel refresh kept asking for a market ticker.
- Retryable automatic-settlement close failures could be retried too quickly after reduce-only/GTX rejection.
```

Implemented in the current working tree:

```text
- Market WebSocket reconnect now uses backoff and blocks new sockets while reconnect is pending.
- Retryable automatic-settlement close failures set pending.nextAttemptAt.
- Pending settlement processing returns reason="cooldown" before nextAttemptAt instead of placing another close order.
- Node tests cover both protections.
```

## Current 0.3.2 duplicate auto-settlement protection

Problem observed:

```text
Order history showed many reduce-only maker SELL closes for the same quantity in a short window.
These were successful close orders, not only retryable rejects.
Cooldown alone does not prevent successful duplicate placement.
```

Implemented in the current working tree:

```text
- Added pendingSettlementFillIndex to extension storage defaults.
- Automatic settlement now keeps a persistent ledger keyed by symbol + entryClientOrderId.
- The ledger stores the cumulative entry fill quantity already covered by settlement orders.
- Before sending a settlement close, the extension reserves the new covered quantity in storage.
- Duplicate pending records for the same entryClientOrderId share the same processing lock.
- Updating from a version before 0.3.2 clears old `pendingSettlementIndex` and `pendingSettlementFillIndex`.
- Node tests verify duplicate pending records place only one close order.
```

Possible policy:

```text
if bookTicker cache age <= 100 ms:
  use cache for maker price
else:
  REST /ticker/bookTicker fallback
```

Be conservative. Stale bid/ask increases GTX reject risk. Always log or display `bookSource=ws/rest` and age in dry run.

Acceptance criteria:

```text
- Bid/ask cache updates while panel is open.
- Dry run shows book source and age.
- If WS data is stale, REST is used.
- GTX reject rate must not increase significantly compared with REST-only path.
```

## Recommended next plan: 0.3.0 State machine cleanup

Goal: formalize order/position state and reduce scattered logic.

Suggested modules:

```text
api/binanceRest.js
api/binanceWs.js
core/filters.js
core/pricing.js
core/sizing.js
core/orderState.js
core/autoSettlement.js
core/reduceOnlyExit.js
ui/contentPanel.js
ui/popupSettings.js
```

State machine concepts:

```text
EntryOrder:
  NEW -> PARTIALLY_FILLED -> FILLED / CANCELED / EXPIRED / REJECTED

SettlementPlan:
  PENDING_ENTRY -> PARTIAL_SETTLED -> FULLY_SETTLED -> DONE / ABORTED

ExitReplace:
  RECONCILING_OLD_EXITS -> CANCELING -> PLACING -> PLACED / FAILED
```

Core invariant: local state can be wrong; REST reconciliation must be able to repair it.

## Testing checklist before every release

Static checks:

```bash
node --check background.js
node --check content.js
node --check popup.js
python3 -m json.tool manifest.json >/dev/null
```

Package checks:

```bash
rm -rf /tmp/binance-maker-extension-test
unzip -q binance-maker-extension.zip -d /tmp/binance-maker-extension-test
find /tmp/binance-maker-extension-test -maxdepth 2 -type f | sort
```

Popup DOM checks:

- Every ID referenced in `popup.js` exists in `popup.html`.
- Save Settings works.
- Paste API Key/Secret works.
- Version displayed in popup/README matches manifest.

Content panel checks:

- Every ID referenced in `content.js` exists in injected HTML.
- Panel appears on Binance Futures page.
- Panel appears on TradingView page.
- Drag works.
- Resize works.
- Position/size persists.
- Extension reload then page reload works.
- Old page after extension reload shows safe disabled state rather than throwing continuously.

Dry-run functional checks:

```text
No position + Buy:
  reduceOnly=false
  sizing = quoteAmount * leverage / price

No position + Sell:
  reduceOnly=false
  sizing = quoteAmount * leverage / price

Long position + Sell:
  reduceOnly=true
  sizing=FULL_POSITION_EXIT
  quantity == abs(live positionAmt)
  old SELL reduceOnly extension exits are detected regardless of price/quantity

Short position + Buy:
  reduceOnly=true
  sizing=FULL_POSITION_EXIT
  quantity == abs(live positionAmt)
  old BUY reduceOnly extension exits are detected regardless of price/quantity

Auto settlement ON + Buy open:
  pending settlement registered
  long settlement preview exists
  expectedProfit ≈ quoteAmount * roi / 100

Auto settlement ON + Sell open:
  pending settlement registered
  short settlement preview exists
  expectedProfit ≈ quoteAmount * roi / 100
```

Mainnet testing policy:

- Prefer Testnet.
- If Mainnet is required, user must run locally with their own fresh temporary IP-restricted key.
- Use smallest viable order size.
- Start with Dry run.
- Never ask Codex/assistant to run real-money trades remotely.

## Known limitations

- Current auto-settlement fill detection uses REST polling. It is faster than snapshot loop but still slower than WebSocket push.
- Chrome MV3 service workers can sleep/restart. Memory-only watcher/state can be lost; storage fallback exists but can miss ultra-short windows.
- Multiple TP reduce-only orders can be created for partial fills. This is intentional and quantity-safe.
- REST `bookTicker` is still in click path for entry/exits. It ensures fresh price but adds one round trip.
- Fresh `positionRisk` is still in full-position exit path. It adds latency but prevents wrong exit sizing.
- Binance rate limits can become relevant with very aggressive polling, multiple tabs, or many symbols.

## Suggested coding style for future work

- Keep trading-path functions small and explicit.
- Avoid storage writes on the critical path; write asynchronously/debounced after memory update.
- Avoid UI work on trading path.
- Prefer parallel independent REST calls.
- Treat cached price as dangerous unless age is very low and visible in dry run.
- Treat cached position as UI-only for exits; actual full-position exits should use fresh position unless a new safety model is added.
- Every live-action function should support dry-run behavior or be skipped in dry run.
- Surface source/age metadata in dry run: `positionSource`, `bookSource`, `bookAgeMs`, `watcher=ws/rest`.

## Quick mental model

This extension is a low-latency maker-only Binance Futures controller:

```text
User click
=> compute closest maker-safe price
=> send LIMIT GTX
=> if opposite existing position, full-position reduce-only exit
=> if auto settlement enabled for an entry, monitor fills
=> for each fill delta, send opposite LIMIT GTX reduceOnly TP
```

The next major improvement is not more REST polling. The next major improvement is Hybrid: REST for commands, WebSocket user stream for fills, REST fallback for reconciliation.
