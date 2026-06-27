export type IntervalName = "1s" | "5s" | "15s" | "30s" | "1m";

export type Direction = "long" | "short";

export type PaperOrderStatus =
  | "pending"
  | "resting"
  | "partial"
  | "filled"
  | "settled"
  | "rejected"
  | "canceled"
  | "open";

export type PaperFillReason =
  | "trade_through"
  | "stable_touch"
  | "partial_queue"
  | "gtx_reject"
  | "tp_reduce_only"
  | "sl_reduce_only"
  | "manual_reset"
  | "entry_ttl_cancel"
  | "sl_timeout_gtx"
  | "emergency_stop_market";

export interface AggTradeEvent {
  symbol: string;
  price: number;
  quantity: number;
  eventTime: number;
  tradeTime: number;
  buyerMaker?: boolean;
}

export interface BookTickerEvent {
  symbol: string;
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  eventTime: number;
}

export interface Candle {
  symbol: string;
  interval: IntervalName;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

export interface FlashPointState {
  rsv: number;
  c1: number;
  c2: number;
  slowDBase: number;
  crossing: "up" | "down" | null;
}

export interface SignalEvent {
  id?: number;
  symbol: string;
  interval: IntervalName;
  time: number;
  bucket: number;
  direction: Direction;
  price: number;
  c1: number;
  c2: number;
  configVersion: number;
}

export interface StrategyConfig {
  version: number;
  enabled: boolean;
  symbol: string;
  interval: IntervalName;
  persistMs: number;
  longBelow: number;
  shortAbove: number;
  tp: number;
  slEnabled: boolean;
  sl: number;
  slTriggerOffset: number;
  entryTtlMs: number;
  makerSlRetryMs: number;
  emergencySl: number;
  priceVelocityWindowMs: number;
  maxPriceVelocityUsdPerSec: number;
  slLevels: number[];
  slLadder: SlLadderLevel[];
  capital: number;
  leverage: number;
  compoundRate: number;
  mode: "independent" | "single";
  makerOffsetTicks: number;
  fillStrictness: "realistic";
  createdAt: number;
}

export interface SlLadderLevel {
  triggerOffset: number;
  limitOffset: number;
  quantityPct: number;
}

export interface LatencyStats {
  wsDelayMs: number | null;
  restLatencyMs: number | null;
  orderActivationDelayMs: number;
  sampleTime: number;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  signalId?: number;
  configVersion: number;
  direction: Direction;
  status: PaperOrderStatus;
  entryIntentPrice: number;
  entryFillPrice: number | null;
  quantity: number;
  filledQuantity: number;
  createdAt: number;
  activeAt: number;
  filledAt: number | null;
  settledAt: number | null;
  tpPrice: number;
  slPrice: number;
  exitFillPrice: number | null;
  pnlUsdc: number;
  reason: PaperFillReason | null;
  audit: Record<string, unknown>;
}

export interface PaperTrade {
  id: string;
  orderId: string;
  symbol: string;
  eventType?: "trade" | "portfolio_reset";
  title?: string;
  details?: string;
  direction: Direction;
  status: PaperOrderStatus;
  entryTime: number;
  exitTime: number | null;
  holdMs: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number;
  pnlUsdc: number;
  reason: PaperFillReason | null;
  configVersion: number;
}

export interface PortfolioSnapshot {
  time: number;
  paperEquity: number;
  paperRealizedPnl: number;
  paperUnrealizedPnl: number;
  openPaperPositions: number;
  realWalletBalance: number | null;
  realAvailableBalance: number | null;
  realUnrealizedPnl: number | null;
}

export interface HealthStatus {
  now: number;
  worker: {
    running: boolean;
    lastEventAt: number | null;
    reconnects: number;
    message: string;
  };
  api: {
    running: boolean;
    uptimeSec: number;
  };
  binance: {
    wsConnected: boolean;
    restOk: boolean;
    wsDelayP50: number | null;
    wsDelayP90: number | null;
    wsDelayP99: number | null;
    restP50: number | null;
    restP90: number | null;
    restP99: number | null;
  };
  storage: {
    databasePath: string;
    rawRetentionDays: number;
    storageMaxBytes: number;
    sqliteBytes: number | null;
  };
}

export interface DashboardPayload {
  config: StrategyConfig;
  previousConfig: StrategyConfig | null;
  candles: Candle[];
  signals: SignalEvent[];
  paperOrders: PaperOrder[];
  trades: PaperTrade[];
  portfolio: PortfolioSnapshot | null;
  health: HealthStatus;
}

export interface PortfolioResetResult {
  closedOrders: number;
  resetTrade: PaperTrade;
  snapshot: PortfolioSnapshot;
}

export interface StrategyQueryFilter {
  interval?: IntervalName;
  persistMs?: number;
  longBelow?: number;
  shortAbove?: number;
  tp?: number;
  sl?: number;
  mode?: StrategyConfig["mode"];
}

export interface StrategyQueryResultFilter {
  finalEquityMin?: number;
  winRateMin?: number;
  maxDrawdownPctMax?: number;
  tradeSharpeMin?: number;
  entriesMin?: number;
}

export type StrategyQueryRowType = "match" | "average" | "median";

export interface StrategyQueryRow {
  type: StrategyQueryRowType;
  interval: IntervalName | null;
  persistMs: number | null;
  longBelow: number | null;
  shortAbove: number | null;
  tp: number | null;
  sl: number | null;
  mode: StrategyConfig["mode"] | null;
  entries: number | null;
  wins: number | null;
  losses: number | null;
  winRate: number | null;
  within30s: number | null;
  p90HoldSeconds: number | null;
  p99HoldSeconds: number | null;
  maxHoldSeconds: number | null;
  totalUsdcPnl: number | null;
  expectancyPrice: number | null;
  meanUsdPerTrade: number | null;
  stdUsdPerTrade: number | null;
  tradeSharpe: number | null;
  cumulativeTradeSharpe: number | null;
  finalEquity: number | null;
  maxDrawdownPct: number | null;
}

export interface StrategyQueryMatchedValue {
  requested: number;
  values: number[];
  exact: boolean;
}

export interface StrategyQueryOptions {
  intervals: IntervalName[];
  modes: StrategyConfig["mode"][];
  persistMs: number[];
  longBelow: number[];
  shortAbove: number[];
  tp: number[];
  sl: number[];
}

export interface StrategyQueryResult {
  source: {
    path: string;
    rowCount: number;
  };
  filters: StrategyQueryFilter;
  resultFilters: StrategyQueryResultFilter;
  options: StrategyQueryOptions;
  matchedValues: Partial<Record<keyof StrategyQueryFilter, StrategyQueryMatchedValue>>;
  approximate: boolean;
  rows: StrategyQueryRow[];
}
