import assert from "node:assert/strict";
import test from "node:test";
import { computeFlashPointV08, FlashPointSeries } from "../src/server/flashpoint.js";
import type { Candle } from "../src/shared/types.js";

function candle(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { symbol: "BTCUSDC", interval: "5s", openTime, closeTime: openTime + 4999, open, high, low, close, volume: 1, trades: 1 };
}

test("Flash Point v0.8 initializes zero-range stoch to zero", () => {
  const state = computeFlashPointV08([], candle(0, 10, 10, 10, 10), null);
  assert.equal(state.rsv, 0);
  assert.equal(state.c1, 0);
  assert.equal(state.c2, 0);
});

test("Flash Point v0.8 matches Pine EMA warmup shape", () => {
  const first = computeFlashPointV08([], candle(0, 10, 10, 10, 10), null);
  const second = computeFlashPointV08([candle(0, 10, 10, 10, 10)], candle(5000, 12, 12, 10, 12), first);
  assert.equal(Math.round(second.rsv * 100) / 100, 75);
  assert.equal(Math.round(second.c1 * 100) / 100, 30);
  assert.equal(Math.round(second.c2 * 100) / 100, 6.66);
  assert.equal(second.crossing, "up");
});

test("Flash Point preview uses the active candle without committing it", () => {
  const series = new FlashPointSeries();
  series.update(candle(0, 10, 10, 10, 10));

  const active = candle(5000, 12, 12, 10, 12);
  const preview = series.preview(active);
  const committed = series.update(active);

  assert.deepEqual(preview, committed);

  const nextActive = candle(10000, 13, 13, 11, 13);
  const previewNext = series.preview(nextActive);
  const previewAgain = series.preview(nextActive);

  assert.deepEqual(previewAgain, previewNext);
});
