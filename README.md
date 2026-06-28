# SuperShort

SuperShort is primarily a Binance USD-M Futures browser extension for maker/GTX post-only order experiments.

The repository contains three related parts:

- The main Binance maker/GTX browser extension for post-only limit-order experiments.
- A TypeScript/React live dashboard and backend for Flash Point Pro v0.8 paper trading and monitoring.
- `CrossingFetch`, a TradingView recorder and research extension used to reconstruct and validate Flash Point behavior.

## Safety Model

The browser extension can place Binance orders when configured with credentials and Dry Run is disabled. Start with Testnet and Dry Run, use restricted Futures-only API keys, disable withdrawals, and keep API secrets out of committed files.

The dashboard/backend is a companion paper-trading and monitoring system. It uses Binance live market data and a conservative maker/GTX fill model, but it does not place real orders unless real execution work is explicitly added in the future.

## Browser Extension

Current extension version: `0.4.2`.

The root extension files are:

- `manifest.json`
- `background.js`
- `content.js`
- `content.css`
- `popup.html`
- `popup.js`

Extension behavior:

- BUY uses `askPrice - tickSize * (offsetTicks + 1)`.
- SELL uses `bidPrice + tickSize * (offsetTicks + 1)`.
- Orders are sent as `type=LIMIT` and `timeInForce=GTX`.
- If the order would immediately take liquidity, Binance should reject or expire it instead of filling as taker.
- In one-way mode, when pressing the opposite side of an existing position, the extension sends `reduceOnly=true` and caps quantity to the current position size.

Auto settlement behavior:

- Auto settlement places maker/GTX reduce-only TP orders for extension entry fills.
- When a later same-direction entry changes the average open position price, the extension replaces prior auto-settlement TP orders with one new TP order.
- The replacement TP uses the latest Binance average position entry price plus or minus the original settlement price offset.
- Example: a long opened at 100 with a +10 settlement target creates a TP at 110. If another long opens at 90 and the average entry becomes 95, the new TP is 105. The old 110 TP is canceled before the new TP is placed.
- Only extension auto-settlement orders with `mb_tp_` client ids are replaced by this flow.

Install:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer Mode.
3. Load unpacked and select this folder.
4. Open the extension popup and save API key/secret.
5. Start with Testnet and Dry Run enabled.

## Flash Point Pro Baseline

Current strategy work uses the author's Flash Point Pro v0.8 exact formula:

```text
typical_price = (2 * close + high + low) / 4

period_lowest  = lowest(low, 5)
period_highest = highest(high, 4)

price_range = period_highest - period_lowest
stoch_val = price_range == 0 ? 0 : ((typical_price - period_lowest) / price_range) * 100

C1 = EMA(stoch_val, 4)

slow_d_base = 0.667 * previous C1 + 0.333 * current C1
C2 = EMA(slow_d_base, 2)
```

Signal rules:

```text
Long  = crossover(C1, C2) and C1 < longBelow
Short = crossunder(C1, C2) and C1 > shortAbove
```

## Dashboard Requirements

- Node.js 22+
- npm
- SQLite support through `better-sqlite3`

## Dashboard Setup

```bash
npm ci
cp .env.example .env
npm run build
```

Edit `.env` locally. Do not commit real API keys, password hashes, session secrets, databases, logs, or generated output.

## Dashboard Environment

```text
NODE_ENV=production
PORT=8787
DATABASE_PATH=./data/supershort.db
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_BASE_URL=https://fapi.binance.com
BINANCE_WS_BASE_URL=wss://fstream.binance.com
SYMBOL=BTCUSDC
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=
SESSION_SECRET=change-this-with-openssl-rand-hex-32
```

Create an admin password hash after building:

```bash
node -e "import('./dist/server/config.js').then(m => console.log(m.hashPassword(process.argv[1])))" 'YOUR_PASSWORD_HERE'
```

Generate a session secret:

```bash
openssl rand -hex 32
```

## Development

Run the dashboard parts separately:

```bash
npm run dev:api
npm run dev:worker
npm run dev:web
```

Useful checks:

```bash
npm test
npm run typecheck
npm run build
```

`CrossingFetch` checks:

```bash
node --test CrossingFetch/test/*.test.js
node --check CrossingFetch/flashpoint-algo.js
node --check CrossingFetch/content.js
node --check CrossingFetch/injected.js
node --check CrossingFetch/core.js
node --check CrossingFetch/analysis/flash-point-model.js
node --check CrossingFetch/analysis/fit-exact-flash-point.js
```

## Project Layout

```text
background.js      Main extension service worker
content.js         Main extension page panel
popup.html/js      Extension settings popup
manifest.json      Main extension manifest
src/client/        Companion React dashboard
src/server/        Companion API, worker, Binance adapter, SQLite store, paper model
src/shared/        Shared strategy and table utilities
test/              Dashboard/backend and extension tests
deploy/            Example dashboard systemd and tunnel deployment files
CrossingFetch/     TradingView recorder, Flash Point research, tests
docs/              Design notes and implementation plans
```

## Data And Artifacts

Generated folders and local artifacts are intentionally ignored:

- `node_modules/`
- `dist/`
- `output/`
- `.superpowers/`
- local `.env` files
- SQLite databases
- logs
- zip archives
- large generated backtest datasets under `CrossingFetch/analysis/backtest-data/`

Keep only source, tests, safe documentation, and example configuration in git.
