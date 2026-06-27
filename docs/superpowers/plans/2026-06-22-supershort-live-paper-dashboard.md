# SuperShort Live Paper Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Raspberry Pi 5 friendly live Binance data + paper trading dashboard for SuperShort.

**Architecture:** Use a lightweight Node.js/TypeScript backend split into API and worker entrypoints, both sharing SQLite WAL storage and strategy modules. The React/Vite dashboard is served by the API and communicates through REST plus WebSocket updates.

**Tech Stack:** Node.js, TypeScript, Express, ws, better-sqlite3, React, Vite, lightweight-charts, systemd, Cloudflare Tunnel.

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `.gitignore`

- [ ] Add npm scripts for dev, build, test, API, worker, and frontend.
- [ ] Install backend/frontend dependencies.
- [ ] Verify `npm run typecheck` starts from a clean scaffold.

### Task 2: Shared Types And Config

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/server/config.ts`

- [ ] Define market event, candle, signal, paper order, trade, portfolio, strategy config, and health types.
- [ ] Load environment variables with safe defaults for paper mode.
- [ ] Ensure real trading remains disabled in version 1.

### Task 3: SQLite Storage

**Files:**
- Create: `src/server/db.ts`

- [ ] Open SQLite in WAL mode.
- [ ] Create tables for strategy config, candles, raw events, signals, paper orders, paper trades, portfolio snapshots, latency samples, and app state.
- [ ] Add repository helpers for dashboard queries and worker writes.
- [ ] Add retention cleanup for raw events.

### Task 4: Flash Point v0.8 And Candle Aggregator

**Files:**
- Create: `src/server/flashpoint.ts`
- Create: `src/server/candles.ts`
- Create: `test/flashpoint.test.js`

- [ ] Implement v0.8 exact C1/C2 calculation.
- [ ] Implement realtime candle aggregation for 1s/5s/15s/30s/1m.
- [ ] Detect long/short cross signals.
- [ ] Test warmup, zero range, and crossing behavior.

### Task 5: Paper GTX Executor

**Files:**
- Create: `src/server/paper.ts`
- Create: `test/paper.test.js`

- [ ] Simulate maker-safe order activation after measured delay.
- [ ] Reject post-only orders that would cross book after delay.
- [ ] Require trade-through or stable touch before fill.
- [ ] Simulate TP/SL reduce-only settlement.
- [ ] Track partial fill and audit metadata.

### Task 6: Binance Clients

**Files:**
- Create: `src/server/binance.ts`

- [ ] Connect USD-M Futures combined streams for aggTrade and bookTicker.
- [ ] Add read-only signed REST helpers for account display.
- [ ] Add latency sampler.
- [ ] Reconnect WebSocket with backoff.

### Task 7: Worker Service

**Files:**
- Create: `src/server/worker.ts`

- [ ] Load active strategy config.
- [ ] Consume Binance live events.
- [ ] Persist raw events, candles, signals, paper orders/trades, latency, portfolio snapshots.
- [ ] Broadcast process health via SQLite state.

### Task 8: API Service

**Files:**
- Create: `src/server/api.ts`

- [ ] Add login/logout/session endpoints.
- [ ] Add dashboard REST endpoints.
- [ ] Add browser WebSocket fanout.
- [ ] Serve built React dashboard.
- [ ] Ensure admin password is hash-based and not hardcoded.

### Task 9: Traditional Chinese Dashboard

**Files:**
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/styles.css`

- [ ] Build authenticated app shell in Traditional Chinese.
- [ ] Add realtime chart with 1s/5s/15s/30s/1m switcher.
- [ ] Add trade history, portfolio, settings, and system status pages.
- [ ] Keep real account values visually separate from paper values.

### Task 10: Deployment Files

**Files:**
- Create: `deploy/supershort-api.service`
- Create: `deploy/supershort-worker.service`
- Create: `deploy/cloudflared-config.example.yml`
- Create: `deploy/README.md`
- Create: `.env.example`

- [ ] Provide Pi 5 setup instructions.
- [ ] Provide password hash generation command.
- [ ] Provide systemd and Cloudflare Tunnel examples.

### Task 11: Verification

**Commands:**
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run dev:api`

- [ ] Run tests.
- [ ] Build backend and frontend.
- [ ] Start local API and verify health endpoints.
- [ ] Open dashboard locally and verify login, chart, tabs, settings, and status render.
