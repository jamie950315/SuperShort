import type { Candle, FlashPointState } from "../shared/types.js";

export function ema(current: number, previous: number | null | undefined, length: number): number {
  if (previous === null || previous === undefined) return current;
  const alpha = 2 / (length + 1);
  return alpha * current + (1 - alpha) * previous;
}

export function computeFlashPointV08(
  candles: Candle[],
  current: Candle,
  previous: FlashPointState | null
): FlashPointState {
  const window = [...candles.slice(-4), current];
  const highWindow = window.slice(-4);
  const periodHighest = Math.max(...highWindow.map((bar) => bar.high));
  const periodLowest = Math.min(...window.slice(-5).map((bar) => bar.low));
  const typicalPrice = (2 * current.close + current.high + current.low) / 4;
  const range = periodHighest - periodLowest;
  const rsv = Math.abs(range) < 1e-12 ? 0 : ((typicalPrice - periodLowest) / range) * 100;
  const c1 = ema(rsv, previous?.c1, 4);
  const slowDBase = 0.667 * (previous?.c1 ?? 0) + 0.333 * c1;
  const c2 = ema(slowDBase, previous?.c2, 2);
  let crossing: FlashPointState["crossing"] = null;

  if (previous) {
    const previousDiff = previous.c1 - previous.c2;
    const currentDiff = c1 - c2;
    if (previousDiff <= 0 && currentDiff > 0) crossing = "up";
    if (previousDiff >= 0 && currentDiff < 0) crossing = "down";
  }

  return { rsv, c1, c2, slowDBase, crossing };
}

export class FlashPointSeries {
  private closed: Candle[] = [];
  private previous: FlashPointState | null = null;

  preview(candle: Candle): FlashPointState {
    return computeFlashPointV08(this.closed, candle, this.previous);
  }

  commit(candle: Candle): FlashPointState {
    const state = computeFlashPointV08(this.closed, candle, this.previous);
    this.closed.push(candle);
    if (this.closed.length > 64) this.closed.shift();
    this.previous = state;
    return state;
  }

  update(candle: Candle): FlashPointState {
    return this.commit(candle);
  }
}
