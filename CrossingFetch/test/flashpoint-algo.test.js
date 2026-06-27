const assert = require("node:assert/strict");
const test = require("node:test");

const algo = require("../flashpoint-algo");

function nearlyEqual(actual, expected, epsilon = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} !== ${expected}`);
}

test("computes exact v0.8 C1/C2 with Pine EMA seeding and author slow line", () => {
  const rows = algo.computeFlashPoint([
    { time: 1, open: 10, high: 10, low: 10, close: 10 },
    { time: 2, open: 12, high: 12, low: 10, close: 12 }
  ]);

  nearlyEqual(rows[0].rsv, 0);
  nearlyEqual(rows[0].c1, 0);
  nearlyEqual(rows[0].c2, 0);
  nearlyEqual(rows[1].rsv, 75);
  nearlyEqual(rows[1].c1, 30);
  nearlyEqual(rows[1].c2, 6.66);
  assert.deepEqual(rows[1].tags.map((tag) => tag.kind), ["goldenCross", "lowBuy"]);
});

test("uses zero stoch_val when price range is zero instead of reusing previous RSV", () => {
  const rows = algo.computeFlashPoint([
    { time: 1, open: 10, high: 10, low: 0, close: 10 },
    { time: 2, open: 10, high: 10, low: 0, close: 10 },
    { time: 3, open: 10, high: 10, low: 10, close: 10 },
    { time: 4, open: 10, high: 10, low: 10, close: 10 },
    { time: 5, open: 10, high: 10, low: 10, close: 10 },
    { time: 6, open: 10, high: 10, low: 10, close: 10 },
    { time: 7, open: 10, high: 10, low: 10, close: 10 }
  ]);

  nearlyEqual(rows[6].rsv, 0);
  nearlyEqual(rows[6].c1, 58.056);
});

test("uses current C1 thresholds for v0.8 secondary markers", () => {
  const lowBuyRows = algo.computeFlashPoint([
    { time: 1, open: 10, high: 10, low: 10, close: 10 },
    { time: 2, open: 12, high: 12, low: 10, close: 12 }
  ]);

  const highSellRows = algo.computeFlashPoint(
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 99]
      .map((price, index) => ({ time: index + 1, open: price, high: price, low: price, close: price }))
  );
  const highSellRow = highSellRows.find((row) => row.crossing === "down");

  assert.deepEqual(lowBuyRows[1].tags.map((tag) => tag.kind), ["goldenCross", "lowBuy"]);
  assert.ok(lowBuyRows[1].c1 < 40);
  assert.deepEqual(highSellRow.tags.map((tag) => tag.kind), ["deathCross", "highSell"]);
  assert.ok(highSellRow.c1 > 90);
});

test("exposes the v0.8 exact formula metadata as the development baseline", () => {
  assert.deepEqual(algo.formula, {
    source: "Author-provided Pine v5 source code",
    typicalPrice: "(2 * close + high + low) / 4",
    periodLowest: "ta.lowest(low, 5)",
    periodHighest: "ta.highest(high, 4)",
    stochVal: "price_range == 0 ? 0 : ((typical_price - period_lowest) / price_range) * 100",
    fastK: "ta.ema(stoch_val, 4)",
    slowDBase: "0.667 * nz(fast_k[1]) + 0.333 * fast_k",
    slowD: "ta.ema(slow_d_base, 2)",
    crossGold: "ta.crossover(fast_k, slow_d)",
    crossDead: "ta.crossunder(fast_k, slow_d)",
    condBuy: "cross_gold and fast_k < 40",
    condSellStrict: "cross_dead and fast_k > 90",
    markerValues: {
      goldenCross: "fast_k",
      deathCross: "slow_d",
      lowBuy: 20,
      highSell: 85
    }
  });
});
