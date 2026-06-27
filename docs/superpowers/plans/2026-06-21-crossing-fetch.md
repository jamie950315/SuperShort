# CrossingFetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone TradingView recorder extension that captures K-line data and observable Flash Point Pro values for later reverse engineering.

**Architecture:** A page-context script mirrors TradingView WebSocket messages to a content script. The content script parses OHLCV bars, samples visible Flash Point Pro text, stores JSON records in IndexedDB, and exports JSONL.

**Tech Stack:** Chrome/Edge Manifest V3, plain JavaScript, IndexedDB, Node built-in test runner.

---

### Task 1: Core Parser

**Files:**
- Create: `CrossingFetch/core.js`
- Test: `CrossingFetch/test/core.test.js`

- [x] **Step 1: Write tests for TradingView frame parsing, bar extraction, Flash Point text parsing, and crossing detection.**

Run: `node --test CrossingFetch/test/*.test.js`
Expected before implementation: fail because files do not exist.

- [x] **Step 2: Implement pure parser helpers.**

Expose:
- `parseTradingViewFrames(input)`
- `extractBarsFromMessage(message)`
- `extractFlashPointFromText(text)`
- `detectCrossing(previous, current)`

- [x] **Step 3: Run parser tests.**

Run: `node --test CrossingFetch/test/*.test.js`
Expected: pass.

### Task 2: Extension Shell

**Files:**
- Create: `CrossingFetch/manifest.json`
- Create: `CrossingFetch/injected.js`
- Create: `CrossingFetch/content.js`
- Create: `CrossingFetch/content.css`
- Create: `CrossingFetch/README.md`

- [x] **Step 1: Add Manifest V3 metadata and permissions.**

Use `storage`, `unlimitedStorage`, TradingView host permissions, and `web_accessible_resources` for `injected.js`.

- [x] **Step 2: Add the WebSocket mirror script.**

Patch page `WebSocket` construction and forward string messages to the content script with `window.postMessage`.

- [x] **Step 3: Add the content recorder panel.**

Implement Start, Stop, mode, interval, Export JSONL, Clear Session, and status.

- [x] **Step 4: Add IndexedDB persistence.**

Store samples in `CrossingFetchDB.samples`, keyed by auto-increment id and indexed by `sessionId`.

- [x] **Step 5: Add README install and use instructions in English.**

### Task 3: Verification

**Files:**
- Verify all `CrossingFetch/` files.

- [x] **Step 1: Run Node parser tests.**

Run: `node --test CrossingFetch/test/*.test.js`
Expected: pass.

- [x] **Step 2: Run syntax checks.**

Run:

```bash
node --check CrossingFetch/core.js
node --check CrossingFetch/content.js
node --check CrossingFetch/injected.js
```

Expected: no syntax errors.

- [x] **Step 3: Inspect manifest JSON.**

Run:

```bash
node -e "JSON.parse(require('node:fs').readFileSync('CrossingFetch/manifest.json','utf8')); console.log('manifest ok')"
```

Expected: `manifest ok`.
