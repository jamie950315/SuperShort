import { loadConfig } from "./config.js";
import { openStore } from "./db.js";
import { BinanceMarketStream, BinanceRestClient } from "./binance.js";
import { MultiIntervalCandleBuilder } from "./candles.js";
import { FlashPointSeries } from "./flashpoint.js";
import { PaperGtxExecutor } from "./paper.js";
import { PriceVelocityGuard } from "./risk.js";
import { PersistentSignalGate } from "./signalGate.js";
import type { BookTickerEvent, Candle, IntervalName, LatencyStats, PaperTrade, SignalEvent } from "../shared/types.js";

const config = loadConfig();
const store = openStore(config.databasePath);
const candles = new MultiIntervalCandleBuilder(config.symbol);
const flashSeries = new Map<IntervalName, FlashPointSeries>();
const paper = new PaperGtxExecutor({ symbol: config.symbol, referencePrice: 65000, tickSize: 0.1 });
const rest = new BinanceRestClient(config);
const priceVelocityGuard = new PriceVelocityGuard();
let currentBook: BookTickerEvent | null = null;
let reconnects = 0;
let gateConfigVersion = 0;
const signalGates = new Map<IntervalName, PersistentSignalGate>();
type PaperResetState = { time: number; equity: number };
let appliedPaperResetAt = store.getState<PaperResetState | null>("paper_reset", null)?.time ?? 0;
let binanceWsConnected = false;
let binanceState = { ...store.getState<Record<string, unknown>>("binance", { restOk: false }), wsConnected: false };
store.setState("binance", binanceState);

for (const interval of ["1s", "5s", "15s", "30s", "1m"] as IntervalName[]) {
  flashSeries.set(interval, new FlashPointSeries());
}

for (const order of store.getOpenPaperOrders(config.symbol)) {
  paper.loadOrder(order);
}

for (const interval of ["1s", "5s", "15s", "30s", "1m"] as IntervalName[]) {
  const series = flashSeries.get(interval);
  if (!series) continue;
  for (const candle of store.getClosedCandles(config.symbol, interval, 200)) {
    series.update(candle);
  }
}

function paperResetState(): PaperResetState | null {
  return store.getState<PaperResetState | null>("paper_reset", null);
}

function applyExternalPaperReset(): void {
  const reset = paperResetState();
  if (!reset || reset.time <= appliedPaperResetAt) return;
  paper.clearOrders();
  for (const order of store.getOpenPaperOrders(config.symbol)) {
    paper.loadOrder(order);
  }
  appliedPaperResetAt = reset.time;
}

function paperBaseline(activeCapital: number): { baseEquity: number; since: number } {
  const reset = paperResetState();
  return reset ? { baseEquity: reset.equity, since: reset.time } : { baseEquity: activeCapital, since: 0 };
}

function paperTradesSinceReset(trades: PaperTrade[], since: number): PaperTrade[] {
  return trades.filter((trade) => (trade.eventType ?? "trade") === "trade" && trade.entryTime >= since);
}

function latencyStats(): LatencyStats {
  const ws = store.getLatencyPercentiles("ws", Date.now() - 5 * 60 * 1000);
  const restStats = store.getLatencyPercentiles("rest", Date.now() - 5 * 60 * 1000);
  const restLatencyMs = restStats.p50 ?? 80;
  return {
    wsDelayMs: ws.p50,
    restLatencyMs,
    orderActivationDelayMs: Math.max(50, Math.min(1000, restLatencyMs + (ws.p90 ?? 25))),
    sampleTime: Date.now()
  };
}

function gateFor(interval: IntervalName): PersistentSignalGate {
  const active = store.getActiveConfig(config.symbol);
  if (active.version !== gateConfigVersion) {
    signalGates.clear();
    gateConfigVersion = active.version;
  }
  let gate = signalGates.get(interval);
  if (!gate) {
    gate = new PersistentSignalGate(active.persistMs);
    signalGates.set(interval, gate);
  }
  return gate;
}

function maybeSignal(candle: Candle, state: ReturnType<FlashPointSeries["preview"]>, price: number, time: number): SignalEvent | null {
  const active = store.getActiveConfig(config.symbol);
  if (!active.enabled || active.interval !== candle.interval) return null;
  if (state.crossing === "up" && state.c1 < active.longBelow) {
    return {
      symbol: candle.symbol,
      interval: candle.interval,
      time,
      bucket: candle.openTime,
      direction: "long",
      price,
      c1: state.c1,
      c2: state.c2,
      configVersion: active.version
    };
  }
  if (state.crossing === "down" && state.c1 > active.shortAbove) {
    return {
      symbol: candle.symbol,
      interval: candle.interval,
      time,
      bucket: candle.openTime,
      direction: "short",
      price,
      c1: state.c1,
      c2: state.c2,
      configVersion: active.version
    };
  }
  return null;
}

function typicalPrice(candle: Candle | undefined): number | undefined {
  return candle ? (2 * candle.close + candle.high + candle.low) / 4 : undefined;
}

function writePortfolioSnapshot(): void {
  const active = store.getActiveConfig(config.symbol);
  const baseline = paperBaseline(active.capital);
  const trades = paperTradesSinceReset(store.getPaperTrades(10_000), baseline.since);
  const realized = trades.reduce((sum, trade) => sum + trade.pnlUsdc, 0);
  const snapshot = store.getLatestPortfolio();
  store.insertPortfolioSnapshot({
    time: Date.now(),
    paperEquity: baseline.baseEquity + realized,
    paperRealizedPnl: realized,
    paperUnrealizedPnl: 0,
    openPaperPositions: store.getOpenPaperOrders(config.symbol).length,
    realWalletBalance: snapshot?.realWalletBalance ?? null,
    realAvailableBalance: snapshot?.realAvailableBalance ?? null,
    realUnrealizedPnl: snapshot?.realUnrealizedPnl ?? null
  });
}

function strategyConfigForNextOrder() {
  const active = store.getActiveConfig(config.symbol);
  if (active.compoundRate <= 0) return active;
  const baseline = paperBaseline(active.capital);
  const realized = paperTradesSinceReset(store.getPaperTrades(10_000), baseline.since).reduce((sum, trade) => sum + trade.pnlUsdc, 0);
  return {
    ...active,
    capital: Math.max(0, baseline.baseEquity + realized * active.compoundRate)
  };
}

function cleanupStorage(): void {
  const telemetry = store.cleanupTelemetry(config.rawRetentionDays);
  const limit = store.enforceStorageLimit(config.storageMaxBytes);
  store.setState("storage", { lastCleanupAt: Date.now(), telemetry, limit });
}

function shallowEqualState(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function setBinanceState(patch: { wsConnected?: boolean; restOk?: boolean; error?: string }): void {
  const next = { ...binanceState, ...patch };
  if (patch.restOk === true) delete next.error;
  if (shallowEqualState(next, binanceState)) return;
  binanceState = next;
  store.setState("binance", next);
}

async function pollAccount(): Promise<void> {
  const started = Date.now();
  try {
    const snapshot = await rest.accountSnapshot();
    store.insertLatency("rest", Date.now() - started, Date.now());
    const latest = store.getLatestPortfolio();
    store.insertPortfolioSnapshot({
      time: Date.now(),
      paperEquity: latest?.paperEquity ?? store.getActiveConfig(config.symbol).capital,
      paperRealizedPnl: latest?.paperRealizedPnl ?? 0,
      paperUnrealizedPnl: latest?.paperUnrealizedPnl ?? 0,
      openPaperPositions: latest?.openPaperPositions ?? 0,
      realWalletBalance: snapshot.walletBalance,
      realAvailableBalance: snapshot.availableBalance,
      realUnrealizedPnl: snapshot.unrealizedPnl
    });
    setBinanceState({ restOk: true });
  } catch (error) {
    setBinanceState({ restOk: false, error: (error as Error).message });
  }
}

const stream = new BinanceMarketStream(config, {
  onAggTrade(event) {
    applyExternalPaperReset();
    store.insertRawEvent("aggTrade", event.symbol, event.tradeTime, event);
    const changed = candles.update(event);
    for (const candle of [...changed.closed, ...changed.active]) {
      store.upsertCandle(candle);
    }
    for (const closed of changed.closed) {
      const series = flashSeries.get(closed.interval);
      if (!series) continue;
      series.update(closed);
    }

    const active = strategyConfigForNextOrder();
    const velocity = priceVelocityGuard.update(event.price, event.tradeTime, {
      windowMs: active.priceVelocityWindowMs,
      maxUsdPerSec: active.maxPriceVelocityUsdPerSec
    });
    store.setState("risk", { priceVelocityUsdPerSec: velocity.velocityUsdPerSec, tooFast: velocity.tooFast, time: event.tradeTime });
    const activeCandle = changed.active.find((candle) => candle.interval === active.interval);
    const series = activeCandle ? flashSeries.get(activeCandle.interval) : null;
    if (activeCandle && series) {
      const state = series.preview(activeCandle);
      const candidate = maybeSignal(activeCandle, state, event.price, event.tradeTime);
      const signal = gateFor(activeCandle.interval).update(candidate, event.tradeTime);
      if (signal && currentBook && currentBook.eventTime >= event.tradeTime - 5_000) {
        const id = store.insertSignal(signal);
        if (!velocity.tooFast) {
          const order = paper.createOrder({ ...signal, id }, active, latencyStats());
          if (order) store.upsertPaperOrder(order);
        }
      }
    }
    const paperResult = paper.processTrade(event, { typicalPrice: typicalPrice(activeCandle) });
    for (const order of paperResult.orders) store.upsertPaperOrder(order);
    for (const trade of paperResult.trades) store.upsertPaperTrade(trade);
    if (paperResult.trades.length) writePortfolioSnapshot();
    store.setState("worker", { running: true, lastEventAt: Date.now(), reconnects, message: "處理 live data" });
  },
  onBookTicker(event) {
    applyExternalPaperReset();
    binanceWsConnected = true;
    currentBook = event;
    paper.setBook(event);
    store.insertRawEvent("bookTicker", event.symbol, event.eventTime, event);
    for (const order of paper.processBook(event)) store.upsertPaperOrder(order);
    setBinanceState({ wsConnected: true });
  },
  onLatency(kind, valueMs, time) {
    store.insertLatency(kind, valueMs, time);
  },
  onStatus(status) {
    reconnects = status.reconnects;
    binanceWsConnected = status.connected;
    if (!status.connected) {
      currentBook = null;
      paper.clearBook();
    }
    store.setState("worker", { running: status.connected, lastEventAt: Date.now(), reconnects, message: status.message });
    setBinanceState({ wsConnected: status.connected });
  }
});

setInterval(() => {
  cleanupStorage();
}, 60 * 60 * 1000);

setInterval(() => {
  void pollAccount();
}, 30_000);

process.on("SIGINT", () => {
  stream.stop();
  store.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stream.stop();
  store.close();
  process.exit(0);
});

store.setState("worker", { running: true, lastEventAt: Date.now(), reconnects: 0, message: "啟動中" });
cleanupStorage();
stream.start();
void pollAccount();
