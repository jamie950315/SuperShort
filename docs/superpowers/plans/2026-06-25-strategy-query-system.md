# Strategy Query System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an authenticated Strategy 查詢 page backed by the existing CSV ranking dataset.

**Architecture:** Add a focused server module for CSV parsing, filtering, nearest-value matching, and summary rows. Expose it through `/api/strategy-query`, then add a compact React page inside the existing dashboard shell.

**Tech Stack:** TypeScript, Express, React, Vite, Node test runner.

---

### Task 1: Query Engine

**Files:**
- Create: `src/server/strategyQuery.ts`
- Test: `test/strategy-query.test.ts`

- [ ] **Step 1: Write tests for exact match, approximate match, average, and median**

Create tests with three rows: exact `shortAbove = 50`, exact `shortAbove = 55`, and a different `interval`. Assert that `shortAbove = 52` returns the `50` and `55` rows plus average and median summaries.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/strategy-query.test.ts`

Expected: fail because `src/server/strategyQuery.ts` does not exist.

- [ ] **Step 3: Implement query helpers**

Implement typed rows, numeric parsing, closest lower/higher value selection, exact categorical filtering, CSV parsing, average summary, median summary, and result limiting.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/strategy-query.test.ts`

Expected: pass.

### Task 2: API Endpoint

**Files:**
- Modify: `src/server/api.ts`
- Test: `test/strategy-query.test.ts`

- [ ] **Step 1: Add endpoint tests around request parsing helper**

Keep API parsing logic in `strategyQuery.ts` so it can be tested without starting an Express server.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/strategy-query.test.ts`

Expected: fail because request parsing helper is not implemented.

- [ ] **Step 3: Add authenticated route**

Add `GET /api/strategy-query` behind `requireAuth`, call the query service, and return JSON.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/strategy-query.test.ts`

Expected: pass.

### Task 3: Dashboard Page

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

- [ ] **Step 1: Add shared response types**

Define `StrategyQueryFilter`, `StrategyQueryRow`, `StrategyQueryResult`, and `StrategyQueryMatchedValue`.

- [ ] **Step 2: Add React page**

Add `strategyQuery` to page navigation. Build a form for `interval`, `persistMs`, `longBelow`, `shortAbove`, `tp`, `sl`, and `mode`. Fetch `/api/strategy-query`, render normal and summary rows, and display approximate-match notice.

- [ ] **Step 3: Add CSS**

Reuse existing panel, table, segmented, notice, and error styles. Add only small scoped styles for query form grid and summary rows.

### Task 4: Verification

**Files:**
- No production edits expected unless checks reveal issues.

- [ ] **Step 1: Run full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: no TypeScript errors.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: client and server builds succeed.

- [ ] **Step 4: Run API and web app**

Run API and web dev servers, log in if needed, call `/api/strategy-query`, and inspect that rows and summary values are returned.
