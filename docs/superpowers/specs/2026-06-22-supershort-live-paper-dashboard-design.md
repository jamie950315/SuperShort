# SuperShort Live Paper Dashboard Design

## Goal

Build a Raspberry Pi 5 service for SuperShort live monitoring and paper trading.

Version 1 uses Binance live market data and Binance signed read-only account APIs, but it does not place real orders. The dashboard can be hosted through Cloudflare Tunnel at an operator-owned hostname.

The dashboard UI must be written in Traditional Chinese. Technical documentation and `README.md` files remain in English unless explicitly requested otherwise.

## Explicit Non-Goals For Version 1

- No real Binance order placement.
- No market orders.
- No taker fallback.
- No UI switch that can secretly enable live trading.
- No API secret in frontend code, browser storage, SQLite, logs, or committed files.

## Runtime Architecture

Use a lightweight multi-process architecture suitable for Raspberry Pi 5 long-running operation.

### Processes

| Process | Responsibility |
|---|---|
| Trading Worker | Binance WebSocket connections, Binance latency sampler, Flash Point v0.8 realtime signal engine, paper GTX executor, event persistence |
| Dashboard API | Admin authentication, REST APIs, browser WebSocket fanout, strategy config management, portfolio queries, static dashboard hosting |

The trading worker and API server run as separate `systemd` services. The worker must continue processing market data even if the dashboard is reloaded, opened in multiple tabs, or restarted.

### Storage

Use SQLite in WAL mode.

| Data | Retention |
|---|---|
| Raw aggTrade/bookTicker events | 7 days |
| 1s/5s/15s/30s/1m K lines | Permanent |
| Paper trade ledger | Permanent |
| Paper portfolio snapshots | Permanent |
| Strategy config history | Permanent |
| Latency samples | Rolling retention, enough for recent diagnostics |

SQLite is preferred over a separate database server for Pi 5 simplicity. Tables must be indexed around chart loading, recent trades, open paper positions, and portfolio history.

## Binance Integration

### Market Data

The worker connects to Binance USD-M Futures WebSocket streams for:

- `aggTrade`
- `bookTicker`
- Any additional kline or mark-price stream needed for diagnostics

The system builds K lines locally from live trade events for:

- `1s`
- `5s`
- `15s`
- `30s`
- `1m`

Empty intervals are filled from previous close so Flash Point calculations remain continuous.

### Account Data

The backend may use signed Binance REST APIs or user data streams only for read-only real account display:

- Futures wallet balance
- Available balance
- Margin state
- Existing position state
- Unrealized PnL

The first version does not submit, cancel, or modify any real Binance order.

## Flash Point Signal Engine

Use the author-provided Flash Point Pro v0.8 exact formula for live strategy work:

```text
typical_price = (2 * close + high + low) / 4

period_lowest  = lowest(low, 5)
period_highest = highest(high, 4)

price_range = period_highest - period_lowest
stoch_val = price_range == 0 ? 0 : ((typical_price - period_lowest) / price_range) * 100

C1 = fast_k = EMA(stoch_val, 4)

slow_d_base = 0.667 * nz(fast_k[1]) + 0.333 * fast_k
C2 = slow_d = EMA(slow_d_base, 2)
```

Signal rules:

```text
long/add signal = crossover(C1, C2)
short/sell signal = crossunder(C1, C2)

long entry allowed when direction is long and C1 < configured long threshold
short entry allowed when direction is short and C1 > configured short threshold
```

The signal engine must support independent calculations for each configured time window:

- `1s`
- `5s`
- `15s`
- `30s`
- `1m`

## Paper GTX Execution Model

Version 1 paper trading uses a realistic conservative maker model. It should be conservative enough to avoid fantasy fills, but not exaggerated into an unusable model.

### Latency Model

The worker continuously measures Binance connectivity from the Pi:

- WebSocket event delay estimate
- REST round-trip latency
- Recent reconnects
- Recent WebSocket gaps

The paper engine uses recent rolling samples, especially the latest 5 minutes, to estimate when a simulated order becomes active.

### Entry Model

When a signal appears:

1. Apply signal persistence rule.
2. Calculate maker-safe GTX entry price from live book state.
3. Apply measured simulated order delay.
4. If the order would cross after the delay, mark it as `GTX_REJECT`.
5. If it remains maker-safe, mark it as resting.
6. Do not count a fill only because price touches the limit.
7. Require later trade-through, stable touch, or queue-confidence condition.
8. Support partial fill simulation.

### Settlement Model

All paper settlements are modeled as GTX reduce-only exits.

Supported exit concepts:

- TP maker exit
- SL maker exit
- Optional deeper GTX SL repricing rules
- Partial fills
- Rejected maker exit due to post-only crossing
- Reprice attempts when configured

No market settlement is allowed in version 1.

### Fill Metadata

Every paper trade and fill event must store enough information to audit why it happened:

- Signal time
- Effective simulated order time
- Direction
- Entry/exit intended price
- Actual simulated fill price
- Full or partial fill
- Delay sample used
- Fill reason
- GTX reject reason, if any
- Strategy config version

## Dashboard Information Architecture

The dashboard is an authenticated Traditional Chinese admin interface.

### Login

- Username: `admin`
- Password is not committed in plaintext.
- Deployment uses a password hash stored in the Pi environment.
- Sessions use secure HTTP-only cookies behind Cloudflare HTTPS.

### Main Navigation

| Page | Purpose |
|---|---|
| 即時圖表 | Realtime K lines, Flash Point lines, signals, entries, settlements |
| 交易紀錄 | Latest 1000 paper trades and fill audit details |
| Portfolio | Real Binance account read-only state and paper strategy performance |
| 策略設定 | Configure strategy rules and paper execution settings |
| 系統狀態 | Worker health, Binance WebSocket state, latency, storage, Cloudflare/local status |

### 即時圖表

Requirements:

- Switch time window: `1s`, `5s`, `15s`, `30s`, `1m`.
- Show price K lines.
- Show C1/C2 indicator panel or overlay detail.
- Mark long/short signals.
- Mark paper entries.
- Mark paper settlements.
- Mark rejected GTX opportunities separately from filled paper trades.
- Stream updates from backend WebSocket.
- Keep the chart readable on desktop browser.

### 交易紀錄

Requirements:

- Show up to latest 1000 paper trades.
- Filter by direction, status, strategy config, and time window.
- Show entry/settlement times and hold time.
- Show PnL in USDC.
- Show fill model reason.
- Show partial fill details where applicable.

### Portfolio

Requirements:

Separate real account data from paper strategy results.

| Section | Content |
|---|---|
| Real Binance Account | Balance, available margin, positions, unrealized PnL, read-only status |
| Paper Strategy | Equity, realized PnL, unrealized PnL, open paper positions, win/loss stats |

The UI must make it visually obvious which numbers are real account values and which are paper simulation values.

### 策略設定

Admin settings:

- Enabled time window
- Signal persistence milliseconds
- Long C1 threshold
- Short C1 threshold
- TP value
- SL value
- Optional deeper GTX SL repricing levels
- Capital
- Leverage
- Compound percentage
- Single-position vs independent-position simulation
- Maker price offset ticks
- Paper fill strictness parameters

Every settings change creates a config version. Paper trades must reference the config version used.

### 系統狀態

Show:

- Trading worker running state
- Last Binance event time
- Binance WebSocket reconnect count
- REST latency p50/p90/p99
- WebSocket delay p50/p90/p99
- SQLite size
- Raw event retention status
- Dashboard API health
- Cloudflare Tunnel status where available

## Deployment

Target host:

- Raspberry Pi 5
- Cloudflare Tunnel domain: operator-owned hostname

Deployment shape:

- Node.js + TypeScript backend
- React + Vite dashboard
- SQLite WAL database
- `systemd` services:
  - `supershort-worker.service`
  - `supershort-api.service`
  - Cloudflare Tunnel service, if not already managed externally

Environment variables live on the Pi and are not committed:

```text
BINANCE_API_KEY
BINANCE_API_SECRET
ADMIN_USERNAME
ADMIN_PASSWORD_HASH
SESSION_SECRET
DATABASE_PATH
BINANCE_BASE_URL
BINANCE_WS_BASE_URL
```

The deployment must include a clear setup script or README for:

- Installing dependencies
- Building frontend/backend
- Creating the SQLite database
- Creating password hash
- Installing systemd services
- Configuring Cloudflare Tunnel
- Viewing logs
- Restarting services

## Security Rules

- Never expose Binance API secret to the browser.
- Never store Binance API secret in SQLite.
- Never log signed request secrets.
- Use restricted Binance API keys:
  - Futures read enabled
  - Futures trading disabled for version 1 where possible
  - Withdraw disabled
  - IP restriction enabled when practical
- Dashboard requires login.
- Cloudflare Tunnel should point only to local Dashboard API.
- Real order placement code must not be active in version 1.

## Testing And Verification

Minimum verification before considering version 1 complete:

- Unit tests for Flash Point v0.8 calculation.
- Unit tests for signal threshold rules.
- Unit tests for paper GTX fill/reject conditions.
- Unit tests for config versioning.
- Backend health endpoint test.
- Dashboard build check.
- Manual browser test for:
  - login
  - chart time-window switch
  - live updates
  - trade history
  - portfolio separation
  - strategy settings save
  - system status
- Pi deployment smoke test:
  - worker starts after reboot
  - API starts after reboot
  - Cloudflare URL loads dashboard
  - Binance WebSocket reconnects after network interruption
  - no real order API call is made

## Implementation Order

1. Create backend/frontend project structure.
2. Add SQLite schema and data access layer.
3. Add auth and session handling.
4. Add Binance market WebSocket collector.
5. Add K line aggregator for all time windows.
6. Add Flash Point v0.8 realtime signal engine.
7. Add realistic conservative paper GTX executor.
8. Add portfolio/account read-only module.
9. Add dashboard API and browser WebSocket.
10. Build Traditional Chinese React dashboard.
11. Add systemd service files and deployment scripts.
12. Configure Cloudflare Tunnel instructions.
13. Run local tests, browser test, and Pi smoke test.

## Open Follow-Up Decisions

These can be finalized during implementation without changing the core design:

- Exact charting library.
- Exact UI component library or custom components.
- Initial values for paper fill strictness parameters.
- Whether Cloudflare Access should be added in front of the app in addition to app login.
