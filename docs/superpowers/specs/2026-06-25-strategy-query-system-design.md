# Strategy Query System Design

## Goal

Build a web query page for SuperShort strategy research results. The page lets the user enter a strategy combination and inspect final equity, ROI, win rate, drawdown, Sharpe, hold-time, and trade-count metrics from the existing CSV ranking dataset.

## Data Source

Use `CrossingFetch/analysis/backtest-data/BTCUSDC-2024-07-01_2026-06-21/rule-grid-v08-exact-5s-15s-30s-1m-merged-500usdc-20x/flashpoint-rule-grid-v08-exact-compound0-trade-sharpe.csv`.

This CSV is the first supported source because it already contains the required strategy columns and performance metrics while staying much smaller than the full JSON grid.

## Query Inputs

The first version supports:

- `interval`
- `persistMs`
- `longBelow`
- `shortAbove`
- `tp`
- `sl`
- `mode`

Empty fields mean "any value" for that field. Filled fields are used as filters.

## Matching Behavior

For exact categorical fields, rows must match:

- `interval`
- `mode`

For numeric strategy fields, the system first searches exact values:

- `persistMs`
- `longBelow`
- `shortAbove`
- `tp`
- `sl`

If a numeric value is not present in the filtered dataset, the system includes rows from the closest lower value and closest higher value for that field. For example, if the user asks for `shortAbove = 52` and available values are `50` and `55`, the result includes rows for both values.

If multiple numeric fields are approximate, each field contributes its closest lower and higher values. The final result is the intersection of those candidate values.

## Summary Rows

When approximate matching is used, append two calculated rows:

- Average
- Median

Calculated rows summarize numeric metric columns across the returned matched rows. Strategy key columns are displayed as `平均` or `中位數` in the result type column and stay blank where a single strategy value would be misleading.

## API

Add authenticated API endpoint:

`GET /api/strategy-query`

Query parameters:

- `interval`
- `persistMs`
- `longBelow`
- `shortAbove`
- `tp`
- `sl`
- `mode`
- `limit`

Response shape:

- `source`: CSV path and row count
- `filters`: normalized filters
- `matchedValues`: exact or approximate values used for each field
- `approximate`: boolean
- `rows`: matched rows plus summary rows

The server lazily loads and caches the CSV. It reparses when the file mtime changes.

## UI

Add a new dashboard page named `Strategy 查詢`.

The page contains:

- Compact filter form
- Search button
- Result count and approximate-match notice
- Table with strategy columns and performance metrics
- Summary rows visually separated from normal rows

The UI follows the existing dashboard visual system: dark background, compact panels, sticky table header, restrained colors.

## Error Handling

If the CSV is missing, the API returns a clear error. The UI displays the error in the existing notice/error style.

Invalid numeric inputs are ignored on the client until search, then rejected by the API with a readable error.

## Verification

Required checks:

- Unit tests for exact matching
- Unit tests for approximate lower/upper matching
- Unit tests for average and median summary rows
- `npm test`
- `npm run typecheck`
- `npm run build`
- Run the app and inspect API/UI output
