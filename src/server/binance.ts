import { createHmac } from "node:crypto";
import WebSocket from "ws";
import type { AggTradeEvent, BookTickerEvent } from "../shared/types.js";
import type { AppConfig } from "./config.js";

export interface BinanceStreamHandlers {
  onAggTrade(event: AggTradeEvent): void;
  onBookTicker(event: BookTickerEvent): void;
  onLatency(kind: "ws" | "rest", valueMs: number, time: number): void;
  onStatus(status: { connected: boolean; reconnects: number; message: string }): void;
}

export interface AccountSnapshot {
  walletBalance: number | null;
  availableBalance: number | null;
  unrealizedPnl: number | null;
  positions: Array<{ symbol: string; positionAmt: number; entryPrice: number; unrealizedProfit: number }>;
}

export type ParsedBinanceStreamEvent =
  | { kind: "trade"; event: AggTradeEvent; eventTime: number }
  | { kind: "book"; event: BookTickerEvent; eventTime: number }
  | null;

const STREAM_STALE_TIMEOUT_MS = 15_000;
const STREAM_WATCHDOG_INTERVAL_MS = 5_000;

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseBinanceStreamMessage(raw: string, symbol: string, now = Date.now()): ParsedBinanceStreamEvent {
  const parsed = JSON.parse(raw) as { stream?: string; data?: Record<string, unknown> };
  const data = parsed.data;
  const streamName = parsed.stream?.toLowerCase() ?? "";
  if (!data) return null;

  if (streamName.endsWith("@aggtrade") || streamName.endsWith("@trade")) {
    const price = positiveNumber(data.p);
    const quantity = positiveNumber(data.q);
    if (price === null || quantity === null) return null;
    const eventTime = Number(data.E ?? data.T ?? now);
    return {
      kind: "trade",
      eventTime,
      event: {
        symbol: String(data.s ?? symbol),
        price,
        quantity,
        eventTime,
        tradeTime: Number(data.T ?? eventTime),
        buyerMaker: Boolean(data.m)
      }
    };
  }

  if (streamName.endsWith("@bookticker")) {
    const bidPrice = positiveNumber(data.b);
    const bidQty = positiveNumber(data.B);
    const askPrice = positiveNumber(data.a);
    const askQty = positiveNumber(data.A);
    if (bidPrice === null || bidQty === null || askPrice === null || askQty === null) return null;
    const eventTime = Number(data.E ?? now);
    return {
      kind: "book",
      eventTime,
      event: {
        symbol: String(data.s ?? symbol),
        bidPrice,
        bidQty,
        askPrice,
        askQty,
        eventTime
      }
    };
  }

  return null;
}

export function shouldReconnectStaleStream(now: number, lastMessageAt: number | null, staleTimeoutMs: number): boolean {
  return lastMessageAt !== null && staleTimeoutMs > 0 && now - lastMessageAt > staleTimeoutMs;
}

export class BinanceRestClient {
  constructor(private readonly config: AppConfig) {}

  async ping(): Promise<number> {
    const started = Date.now();
    const response = await fetch(`${this.config.binanceBaseUrl}/fapi/v1/ping`);
    if (!response.ok) throw new Error(`Binance ping failed: ${response.status}`);
    return Date.now() - started;
  }

  async accountSnapshot(): Promise<AccountSnapshot> {
    if (!this.config.binanceApiKey || !this.config.binanceApiSecret) {
      return { walletBalance: null, availableBalance: null, unrealizedPnl: null, positions: [] };
    }
    const account = await this.signedGet("/fapi/v3/account");
    const positions = Array.isArray(account.positions)
      ? account.positions
          .map((item: Record<string, unknown>) => ({
            symbol: String(item.symbol),
            positionAmt: Number(item.positionAmt),
            entryPrice: Number(item.entryPrice),
            unrealizedProfit: Number(item.unrealizedProfit)
          }))
          .filter((item) => Math.abs(item.positionAmt) > 0)
      : [];
    return {
      walletBalance: Number(account.totalWalletBalance ?? NaN) || null,
      availableBalance: Number(account.availableBalance ?? NaN) || null,
      unrealizedPnl: Number(account.totalUnrealizedProfit ?? NaN) || null,
      positions
    };
  }

  private async signedGet(path: string): Promise<Record<string, unknown>> {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = createHmac("sha256", this.config.binanceApiSecret).update(query).digest("hex");
    const response = await fetch(`${this.config.binanceBaseUrl}${path}?${query}&signature=${signature}`, {
      headers: { "X-MBX-APIKEY": this.config.binanceApiKey }
    });
    if (!response.ok) throw new Error(`Binance signed GET ${path} failed: ${response.status} ${await response.text()}`);
    return await response.json() as Record<string, unknown>;
  }
}

export class BinanceMarketStream {
  private ws: WebSocket | null = null;
  private reconnects = 0;
  private stopped = false;
  private lastMessageAt: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: AppConfig, private readonly handlers: BinanceStreamHandlers) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stopWatchdog();
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const lower = this.config.symbol.toLowerCase();
    const url = `${this.config.binanceWsBaseUrl}/stream?streams=${lower}@aggTrade/${lower}@bookTicker`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.handlers.onStatus({ connected: false, reconnects: this.reconnects, message: "連線中" });

    ws.on("open", () => {
      this.lastMessageAt = Date.now();
      this.startWatchdog(ws);
      this.handlers.onStatus({ connected: true, reconnects: this.reconnects, message: "已連線" });
    });

    ws.on("message", (raw) => {
      const now = Date.now();
      this.lastMessageAt = now;
      try {
        const parsed = parseBinanceStreamMessage(String(raw), this.config.symbol, now);
        if (!parsed) return;
        this.handlers.onLatency("ws", Math.max(0, now - parsed.eventTime), now);
        if (parsed.kind === "trade") this.handlers.onAggTrade(parsed.event);
        else this.handlers.onBookTicker(parsed.event);
      } catch (error) {
        this.handlers.onStatus({ connected: false, reconnects: this.reconnects, message: `解析錯誤: ${(error as Error).message}` });
      }
    });

    ws.on("close", () => {
      this.stopWatchdog();
      this.handlers.onStatus({ connected: false, reconnects: this.reconnects, message: "已斷線" });
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      this.handlers.onStatus({ connected: false, reconnects: this.reconnects, message: `錯誤: ${error.message}` });
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    this.reconnects += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, this.reconnects));
    setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  private startWatchdog(ws: WebSocket): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.stopped || this.ws !== ws) return;
      if (!shouldReconnectStaleStream(Date.now(), this.lastMessageAt, STREAM_STALE_TIMEOUT_MS)) return;
      this.handlers.onStatus({ connected: false, reconnects: this.reconnects, message: "連線無資料，重新連線" });
      ws.terminate();
    }, STREAM_WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (!this.watchdog) return;
    clearInterval(this.watchdog);
    this.watchdog = null;
  }
}
