# Extension SL Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional browser-extension SL order that is placed as a Binance USD-M conditional STOP limit order with GTX/Post-Only semantics after an entry fill.

**Architecture:** Reuse the existing auto-settlement pending-entry flow so TP and SL are both attached to actual entry fills. Calculate SL from the same leveraged ROI formula as auto settlement, then place a `POST /fapi/v1/algoOrder` `STOP` order with `timeInForce=GTX`, `reduceOnly=true`, `price` at the SL limit, and `triggerPrice` halfway between average entry and SL.

**Tech Stack:** Chrome extension JavaScript, Binance USD-M Futures REST API, Node test runner with VM-loaded `background.js`.

---

### Task 1: Lock SL Order Behavior With Tests

**Files:**
- Modify: `test/background-market-snapshot.test.ts`
- Test: `test/background-market-snapshot.test.ts`

- [ ] Add a dry-run test proving `slOrderEnabled=true` creates an SL preview from leveraged ROI: long entry 100, 10% at 1x gives SL 90 and trigger 95.
- [ ] Add a fill-processing test proving an SL-only pending entry posts `POST /fapi/v1/algoOrder` with `algoType=CONDITIONAL`, `type=STOP`, `timeInForce=GTX`, `reduceOnly=true`, `price=90.0`, `triggerPrice=95.0`.
- [ ] Run `npm test -- test/background-market-snapshot.test.ts` and confirm the new tests fail because SL fields/functions are missing.

### Task 2: Add SL Config and Planning

**Files:**
- Modify: `background.js`
- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `content.js`

- [ ] Add `slOrderEnabled` and `slOrderRoiPct` defaults, config cleaning, popup fields, content-panel fields, save/load behavior, and message payloads.
- [ ] Add `buildSlOrderPlan()` using `roiPct / 100 / leverage`, rounding away from the entry price: long SL uses floor, short SL uses ceil.
- [ ] Add trigger calculation as the midpoint between entry/average entry and SL price, rounded toward the entry-safe side: long trigger uses floor, short trigger uses ceil.

### Task 3: Place Binance Conditional GTX SL Orders

**Files:**
- Modify: `background.js`

- [ ] Register pending settlement records when either TP or SL is enabled.
- [ ] On entry fill, use current one-way position average price and actual position quantity to build the SL order.
- [ ] Cancel and replace prior extension SL algo orders for that symbol/side before posting the latest full-position SL.
- [ ] Post SL via `POST /fapi/v1/algoOrder` with `algoType=CONDITIONAL`, `type=STOP`, `timeInForce=GTX`, `reduceOnly=true`, `workingType=CONTRACT_PRICE`.

### Task 4: Verify

**Files:**
- No additional file changes.

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Inspect output and fix failures before reporting completion.
