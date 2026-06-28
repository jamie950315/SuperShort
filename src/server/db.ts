import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import type {
  Candle,
  HealthStatus,
  IntervalName,
  PaperOrder,
  PaperTrade,
  PortfolioResetResult,
  PortfolioSnapshot,
  SignalEvent,
  StrategyConfig
} from "../shared/types.js";
import { defaultStrategyConfig } from "./config.js";

const storageCleanupBatchSize = 100_000;

export interface TelemetryCleanupResult {
  rawEventsDeleted: number;
  latencySamplesDeleted: number;
}

export interface StorageLimitResult extends TelemetryCleanupResult {
  enforced: boolean;
  maxBytes: number;
  beforeBytes: number;
  afterBytes: number;
}

export interface Store {
  db: Database.Database;
  close(): void;
  getActiveConfig(symbol: string): StrategyConfig;
  getPreviousConfig(symbol: string): StrategyConfig | null;
  saveStrategyConfig(config: Omit<StrategyConfig, "version" | "createdAt">): StrategyConfig;
  upsertCandle(candle: Candle): void;
  getCandles(symbol: string, interval: IntervalName, limit: number): Candle[];
  getClosedCandles(symbol: string, interval: IntervalName, limit: number, now?: number): Candle[];
  insertRawEvent(type: string, symbol: string, time: number, payload: unknown): void;
  cleanupRawEvents(retentionDays: number): number;
  cleanupTelemetry(retentionDays: number): TelemetryCleanupResult;
  enforceStorageLimit(maxBytes: number): StorageLimitResult;
  insertSignal(signal: SignalEvent): number;
  getSignals(symbol: string, interval: IntervalName, limit: number): SignalEvent[];
  upsertPaperOrder(order: PaperOrder): void;
  getPaperOrders(symbol: string, limit: number): PaperOrder[];
  getOpenPaperOrders(symbol: string): PaperOrder[];
  getPaperTrades(limit: number): PaperTrade[];
  upsertPaperTrade(trade: PaperTrade): void;
  resetPaperPortfolio(symbol: string, equity: number, time?: number): PortfolioResetResult;
  insertPortfolioSnapshot(snapshot: PortfolioSnapshot): void;
  getLatestPortfolio(): PortfolioSnapshot | null;
  insertLatency(kind: "ws" | "rest", valueMs: number, time: number): void;
  getLatencyPercentiles(kind: "ws" | "rest", sinceMs: number): { p50: number | null; p90: number | null; p99: number | null };
  setState(key: string, value: unknown): void;
  getState<T>(key: string, fallback: T): T;
  getHealth(databasePath: string, rawRetentionDays: number, storageMaxBytes: number): HealthStatus;
}

function fileBytes(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

export function databaseStorageBytes(databasePath: string): number {
  return fileBytes(databasePath) + fileBytes(`${databasePath}-wal`) + fileBytes(`${databasePath}-shm`);
}

function projectedVacuumBytes(db: Database.Database, databasePath: string): number {
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  const pageCount = Number(db.pragma("page_count", { simple: true }));
  const freelistCount = Number(db.pragma("freelist_count", { simple: true }));
  return Math.max(0, pageCount - freelistCount) * pageSize + fileBytes(`${databasePath}-wal`) + fileBytes(`${databasePath}-shm`);
}

function checkpointWal(db: Database.Database): void {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Best effort only. Storage cleanup can still continue and will retry next cycle.
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function candleFromRow(row: Record<string, unknown>): Candle {
  return {
    symbol: String(row.symbol),
    interval: row.interval as IntervalName,
    openTime: Number(row.open_time),
    closeTime: Number(row.close_time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    trades: Number(row.trades)
  };
}

function normalizeStrategyConfig(parsed: StrategyConfig, symbol: string, version: number, createdAt: number): StrategyConfig {
  const fallback = defaultStrategyConfig(symbol);
  return {
    ...fallback,
    ...parsed,
    version,
    createdAt,
    symbol,
    entryTtlMs: Number(parsed.entryTtlMs ?? 3000),
    slEnabled: parsed.slEnabled ?? true,
    slTriggerOffset: Number(parsed.slTriggerOffset ?? 0.5),
    makerSlRetryMs: Number(parsed.makerSlRetryMs ?? 3000),
    emergencySl: Number(parsed.emergencySl ?? 15),
    priceVelocityWindowMs: Number(parsed.priceVelocityWindowMs ?? 3000),
    maxPriceVelocityUsdPerSec: Number(parsed.maxPriceVelocityUsdPerSec ?? 5),
    slLadder: Array.isArray(parsed.slLadder) && parsed.slLadder.length > 0
      ? parsed.slLadder
      : fallback.slLadder
  };
}

export function openStore(databasePath: string): Store {
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_configs (
      version INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      open_time INTEGER NOT NULL,
      close_time INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      trades INTEGER NOT NULL,
      PRIMARY KEY (symbol, interval, open_time)
    );
    CREATE TABLE IF NOT EXISTS raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      symbol TEXT NOT NULL,
      time INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_raw_events_time ON raw_events(time);
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      time INTEGER NOT NULL,
      bucket INTEGER NOT NULL,
      direction TEXT NOT NULL,
      price REAL NOT NULL,
      c1 REAL NOT NULL,
      c2 REAL NOT NULL,
      config_version INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signals_symbol_interval_time ON signals(symbol, interval, time DESC);
    CREATE TABLE IF NOT EXISTS paper_orders (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      data TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_orders_symbol_status ON paper_orders(symbol, status);
    CREATE INDEX IF NOT EXISTS idx_paper_orders_symbol_created_at ON paper_orders(symbol, created_at DESC);
    CREATE TABLE IF NOT EXISTS paper_trades (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      data TEXT NOT NULL,
      entry_time INTEGER NOT NULL,
      exit_time INTEGER,
      pnl_usdc REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_trades_entry_time ON paper_trades(entry_time DESC);
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      time INTEGER PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS latency_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      value_ms REAL NOT NULL,
      time INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_latency_kind_time ON latency_samples(kind, time DESC);
    CREATE INDEX IF NOT EXISTS idx_latency_samples_time ON latency_samples(time);
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const count = db.prepare("SELECT COUNT(*) AS count FROM strategy_configs").get() as { count: number };
  if (count.count === 0) {
    const initial = defaultStrategyConfig();
    db.prepare("INSERT INTO strategy_configs (data, created_at) VALUES (?, ?)").run(
      JSON.stringify(initial),
      initial.createdAt
    );
  }

  return {
    db,
    close: () => db.close(),
    getActiveConfig(symbol) {
      const row = db.prepare("SELECT version, data, created_at FROM strategy_configs ORDER BY version DESC LIMIT 1").get() as
        | { version: number; data: string; created_at: number }
        | undefined;
      if (!row) return defaultStrategyConfig(symbol);
      const parsed = parseJson<StrategyConfig>(row.data, defaultStrategyConfig(symbol));
      return normalizeStrategyConfig(parsed, symbol, row.version, row.created_at);
    },
    getPreviousConfig(symbol) {
      const row = db.prepare("SELECT version, data, created_at FROM strategy_configs ORDER BY version DESC LIMIT 1 OFFSET 1").get() as
        | { version: number; data: string; created_at: number }
        | undefined;
      if (!row) return null;
      const parsed = parseJson<StrategyConfig>(row.data, defaultStrategyConfig(symbol));
      return normalizeStrategyConfig(parsed, symbol, row.version, row.created_at);
    },
    saveStrategyConfig(config) {
      const createdAt = Date.now();
      const data = { ...config, createdAt, version: 0 };
      const result = db.prepare("INSERT INTO strategy_configs (data, created_at) VALUES (?, ?)").run(JSON.stringify(data), createdAt);
      return { ...data, version: Number(result.lastInsertRowid) };
    },
    upsertCandle(candle) {
      db.prepare(`
        INSERT INTO candles (symbol, interval, open_time, close_time, open, high, low, close, volume, trades)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
          close_time=excluded.close_time,
          high=excluded.high,
          low=excluded.low,
          close=excluded.close,
          volume=excluded.volume,
          trades=excluded.trades
      `).run(candle.symbol, candle.interval, candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.trades);
    },
    getCandles(symbol, interval, limit) {
      const rows = db.prepare(`
        SELECT * FROM candles WHERE symbol = ? AND interval = ? ORDER BY open_time DESC LIMIT ?
      `).all(symbol, interval, limit) as Array<Record<string, unknown>>;
      return rows.reverse().map(candleFromRow);
    },
    getClosedCandles(symbol, interval, limit, now = Date.now()) {
      const rows = db.prepare(`
        SELECT * FROM candles WHERE symbol = ? AND interval = ? AND close_time < ? ORDER BY open_time DESC LIMIT ?
      `).all(symbol, interval, now, limit) as Array<Record<string, unknown>>;
      return rows.reverse().map(candleFromRow);
    },
    insertRawEvent(type, symbol, time, payload) {
      db.prepare("INSERT INTO raw_events (type, symbol, time, payload) VALUES (?, ?, ?, ?)").run(type, symbol, time, JSON.stringify(payload));
    },
    cleanupRawEvents(retentionDays) {
      return this.cleanupTelemetry(retentionDays).rawEventsDeleted;
    },
    cleanupTelemetry(retentionDays) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const rawEventsDeleted = db.prepare("DELETE FROM raw_events WHERE time < ?").run(cutoff).changes;
      const latencySamplesDeleted = db.prepare("DELETE FROM latency_samples WHERE time < ?").run(cutoff).changes;
      return { rawEventsDeleted, latencySamplesDeleted };
    },
    enforceStorageLimit(maxBytes) {
      const beforeBytes = databaseStorageBytes(databasePath);
      const emptyResult = {
        enforced: false,
        maxBytes,
        beforeBytes,
        afterBytes: beforeBytes,
        rawEventsDeleted: 0,
        latencySamplesDeleted: 0
      };
      if (!Number.isFinite(maxBytes) || maxBytes <= 0 || beforeBytes <= maxBytes) return emptyResult;

      checkpointWal(db);
      let rawEventsDeleted = 0;
      let latencySamplesDeleted = 0;
      const deleteRawEvents = db.prepare(`
        DELETE FROM raw_events
        WHERE id IN (
          SELECT id FROM raw_events ORDER BY time ASC, id ASC LIMIT ?
        )
      `);
      const deleteLatencySamples = db.prepare(`
        DELETE FROM latency_samples
        WHERE id IN (
          SELECT id FROM latency_samples ORDER BY time ASC, id ASC LIMIT ?
        )
      `);

      while (projectedVacuumBytes(db, databasePath) > maxBytes) {
        const changes = deleteRawEvents.run(storageCleanupBatchSize).changes;
        rawEventsDeleted += changes;
        if (changes === 0) break;
      }

      while (projectedVacuumBytes(db, databasePath) > maxBytes) {
        const changes = deleteLatencySamples.run(storageCleanupBatchSize).changes;
        latencySamplesDeleted += changes;
        if (changes === 0) break;
      }

      if (rawEventsDeleted > 0 || latencySamplesDeleted > 0) {
        db.exec("VACUUM");
        checkpointWal(db);
      }

      return {
        enforced: true,
        maxBytes,
        beforeBytes,
        afterBytes: databaseStorageBytes(databasePath),
        rawEventsDeleted,
        latencySamplesDeleted
      };
    },
    insertSignal(signal) {
      const result = db.prepare(`
        INSERT INTO signals (symbol, interval, time, bucket, direction, price, c1, c2, config_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(signal.symbol, signal.interval, signal.time, signal.bucket, signal.direction, signal.price, signal.c1, signal.c2, signal.configVersion);
      return Number(result.lastInsertRowid);
    },
    getSignals(symbol, interval, limit) {
      const rows = db.prepare("SELECT * FROM signals WHERE symbol = ? AND interval = ? ORDER BY time DESC LIMIT ?").all(symbol, interval, limit) as Array<Record<string, unknown>>;
      return rows.reverse().map((row) => ({
        id: Number(row.id),
        symbol: String(row.symbol),
        interval: row.interval as IntervalName,
        time: Number(row.time),
        bucket: Number(row.bucket),
        direction: row.direction as "long" | "short",
        price: Number(row.price),
        c1: Number(row.c1),
        c2: Number(row.c2),
        configVersion: Number(row.config_version)
      }));
    },
    upsertPaperOrder(order) {
      db.prepare(`
        INSERT INTO paper_orders (id, symbol, data, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data, status=excluded.status, updated_at=excluded.updated_at
      `).run(order.id, order.symbol, JSON.stringify(order), order.status, order.createdAt, Date.now());
    },
    getPaperOrders(symbol, limit) {
      const rows = db.prepare("SELECT data FROM paper_orders WHERE symbol = ? ORDER BY created_at DESC LIMIT ?").all(symbol, limit) as Array<{ data: string }>;
      return rows.map((row) => parseJson<PaperOrder>(row.data, null as unknown as PaperOrder)).filter(Boolean);
    },
    getOpenPaperOrders(symbol) {
      const rows = db.prepare("SELECT data FROM paper_orders WHERE symbol = ? AND status IN ('pending','resting','partial','filled','open') ORDER BY created_at ASC").all(symbol) as Array<{ data: string }>;
      return rows.map((row) => parseJson<PaperOrder>(row.data, null as unknown as PaperOrder)).filter(Boolean);
    },
    getPaperTrades(limit) {
      const rows = db.prepare("SELECT data FROM paper_trades ORDER BY entry_time DESC LIMIT ?").all(limit) as Array<{ data: string }>;
      return rows.map((row) => parseJson<PaperTrade>(row.data, null as unknown as PaperTrade)).filter(Boolean);
    },
    upsertPaperTrade(trade) {
      db.prepare(`
        INSERT INTO paper_trades (id, order_id, symbol, data, entry_time, exit_time, pnl_usdc)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data, exit_time=excluded.exit_time, pnl_usdc=excluded.pnl_usdc
      `).run(trade.id, trade.orderId, trade.symbol, JSON.stringify(trade), trade.entryTime, trade.exitTime, trade.pnlUsdc);
    },
    resetPaperPortfolio(symbol, equity, time = Date.now()) {
      const active = this.getActiveConfig(symbol);
      const openOrders = this.getOpenPaperOrders(symbol);
      const latest = this.getLatestPortfolio();
      const title = `Portfolio Reset：強制結清 ${openOrders.length} 筆，資金回到 ${equity} USDC`;
      const resetTrade: PaperTrade = {
        id: `reset_${time}_${Math.random().toString(36).slice(2, 8)}`,
        orderId: `portfolio_reset_${time}`,
        symbol,
        eventType: "portfolio_reset",
        title,
        details: `Reset time: ${new Date(time).toISOString()}\nClosed open paper orders: ${openOrders.length}\nPaper equity: ${equity} USDC`,
        direction: "long",
        status: "settled",
        entryTime: time,
        exitTime: time,
        holdMs: 0,
        entryPrice: null,
        exitPrice: null,
        quantity: 0,
        pnlUsdc: 0,
        reason: "manual_reset",
        configVersion: active.version
      };
      const snapshot: PortfolioSnapshot = {
        time,
        paperEquity: equity,
        paperRealizedPnl: 0,
        paperUnrealizedPnl: 0,
        openPaperPositions: 0,
        realWalletBalance: latest?.realWalletBalance ?? null,
        realAvailableBalance: latest?.realAvailableBalance ?? null,
        realUnrealizedPnl: latest?.realUnrealizedPnl ?? null
      };
      const transaction = db.transaction(() => {
        for (const order of openOrders) {
          const exitFillPrice = order.entryFillPrice ?? null;
          const settled: PaperOrder = {
            ...order,
            status: "settled",
            settledAt: time,
            exitFillPrice,
            pnlUsdc: 0,
            reason: "manual_reset",
            audit: { ...order.audit, manualResetAt: time, manualResetPreviousStatus: order.status }
          };
          db.prepare(`
            INSERT INTO paper_orders (id, symbol, data, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data=excluded.data, status=excluded.status, updated_at=excluded.updated_at
          `).run(settled.id, settled.symbol, JSON.stringify(settled), settled.status, settled.createdAt, time);
        }
        db.prepare(`
          INSERT INTO paper_trades (id, order_id, symbol, data, entry_time, exit_time, pnl_usdc)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(resetTrade.id, resetTrade.orderId, resetTrade.symbol, JSON.stringify(resetTrade), resetTrade.entryTime, resetTrade.exitTime, resetTrade.pnlUsdc);
        db.prepare("INSERT OR REPLACE INTO portfolio_snapshots (time, data) VALUES (?, ?)").run(snapshot.time, JSON.stringify(snapshot));
      });
      transaction();
      return { closedOrders: openOrders.length, resetTrade, snapshot };
    },
    insertPortfolioSnapshot(snapshot) {
      db.prepare("INSERT OR REPLACE INTO portfolio_snapshots (time, data) VALUES (?, ?)").run(snapshot.time, JSON.stringify(snapshot));
    },
    getLatestPortfolio() {
      const row = db.prepare("SELECT data FROM portfolio_snapshots ORDER BY time DESC LIMIT 1").get() as { data: string } | undefined;
      return row ? parseJson<PortfolioSnapshot>(row.data, null as unknown as PortfolioSnapshot) : null;
    },
    insertLatency(kind, valueMs, time) {
      db.prepare("INSERT INTO latency_samples (kind, value_ms, time) VALUES (?, ?, ?)").run(kind, valueMs, time);
    },
    getLatencyPercentiles(kind, sinceMs) {
      const rows = db.prepare("SELECT value_ms FROM latency_samples WHERE kind = ? AND time >= ? ORDER BY time DESC LIMIT 5000").all(kind, sinceMs) as Array<{ value_ms: number }>;
      const values = rows.map((row) => Number(row.value_ms)).filter(Number.isFinite);
      return { p50: percentile(values, 0.5), p90: percentile(values, 0.9), p99: percentile(values, 0.99) };
    },
    setState(key, value) {
      db.prepare("INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), Date.now());
    },
    getState<T>(key: string, fallback: T): T {
      const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as { value: string } | undefined;
      return row ? parseJson<T>(row.value, fallback) : fallback;
    },
    getHealth(databasePath, rawRetentionDays, storageMaxBytes) {
      const ws = this.getLatencyPercentiles("ws", Date.now() - 5 * 60 * 1000);
      const rest = this.getLatencyPercentiles("rest", Date.now() - 5 * 60 * 1000);
      const worker = this.getState("worker", { running: false, lastEventAt: null, reconnects: 0, message: "尚未啟動" });
      const binance = this.getState("binance", { wsConnected: false, restOk: false });
      return {
        now: Date.now(),
        worker,
        api: { running: true, uptimeSec: Math.floor(process.uptime()) },
        binance: {
          wsConnected: Boolean(binance.wsConnected),
          restOk: Boolean(binance.restOk),
          wsDelayP50: ws.p50,
          wsDelayP90: ws.p90,
          wsDelayP99: ws.p99,
          restP50: rest.p50,
          restP90: rest.p90,
          restP99: rest.p99
        },
        storage: {
          databasePath,
          rawRetentionDays,
          storageMaxBytes,
          sqliteBytes: existsSync(databasePath) ? databaseStorageBytes(databasePath) : null
        }
      };
    }
  };
}
