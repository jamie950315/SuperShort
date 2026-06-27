import type { AggTradeEvent, Candle, IntervalName } from "../shared/types.js";

export const INTERVAL_MS: Record<IntervalName, number> = {
  "1s": 1_000,
  "5s": 5_000,
  "15s": 15_000,
  "30s": 30_000,
  "1m": 60_000
};

export class MultiIntervalCandleBuilder {
  private active = new Map<IntervalName, Candle>();
  private lastClose = new Map<IntervalName, number>();

  constructor(private readonly symbol: string, private readonly intervals: IntervalName[] = ["1s", "5s", "15s", "30s", "1m"]) {}

  update(trade: AggTradeEvent): { closed: Candle[]; active: Candle[] } {
    const closed: Candle[] = [];
    const active: Candle[] = [];

    for (const interval of this.intervals) {
      const intervalMs = INTERVAL_MS[interval];
      const openTime = Math.floor(trade.tradeTime / intervalMs) * intervalMs;
      const closeTime = openTime + intervalMs - 1;
      const existing = this.active.get(interval);

      if (!existing) {
        const candle = this.makeCandle(interval, openTime, closeTime, trade.price, trade.quantity);
        this.active.set(interval, candle);
        active.push(candle);
        continue;
      }

      if (existing.openTime !== openTime) {
        closed.push(existing);
        this.lastClose.set(interval, existing.close);
        this.fillMissing(interval, existing.openTime + intervalMs, openTime, existing.close, closed);
        const candle = this.makeCandle(interval, openTime, closeTime, trade.price, trade.quantity);
        this.active.set(interval, candle);
        active.push(candle);
        continue;
      }

      existing.high = Math.max(existing.high, trade.price);
      existing.low = Math.min(existing.low, trade.price);
      existing.close = trade.price;
      existing.volume += trade.quantity;
      existing.trades += 1;
      active.push(existing);
    }

    return { closed, active };
  }

  snapshot(): Candle[] {
    return [...this.active.values()];
  }

  private makeCandle(interval: IntervalName, openTime: number, closeTime: number, price: number, quantity: number): Candle {
    return {
      symbol: this.symbol,
      interval,
      openTime,
      closeTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: quantity,
      trades: 1
    };
  }

  private fillMissing(interval: IntervalName, from: number, to: number, close: number, closed: Candle[]): void {
    const intervalMs = INTERVAL_MS[interval];
    for (let openTime = from; openTime < to; openTime += intervalMs) {
      closed.push({
        symbol: this.symbol,
        interval,
        openTime,
        closeTime: openTime + intervalMs - 1,
        open: close,
        high: close,
        low: close,
        close,
        volume: 0,
        trades: 0
      });
    }
  }
}
