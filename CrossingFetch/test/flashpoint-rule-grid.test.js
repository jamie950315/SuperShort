const assert = require("node:assert/strict");
const test = require("node:test");

const {
  shouldTradeSignal,
  parseAggTradeLine,
  PersistentSignalGate,
  computePartialFlashPoint,
  summarizeCandidateSet,
  settleOpenTrades,
  summarizeOpenTradeSettlements
} = require("../analysis/flashpoint-rule-grid");
const {
  calculateAnnualizedDailySharpe
} = require("../analysis/flashpoint-daily-sharpe");

function nearlyEqual(actual, expected, epsilon = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} !== ${expected}`);
}

test("filters long and short signals with extreme threshold values", () => {
  assert.equal(shouldTradeSignal({ direction: "long", c1: 9.99 }, { longBelow: 10, shortAbove: 90 }), true);
  assert.equal(shouldTradeSignal({ direction: "long", c1: 10 }, { longBelow: 10, shortAbove: 90 }), false);
  assert.equal(shouldTradeSignal({ direction: "long", c1: 19.99 }, { longBelow: 20, shortAbove: 90 }), true);
  assert.equal(shouldTradeSignal({ direction: "short", c1: 90.01 }, { longBelow: 20, shortAbove: 90 }), true);
  assert.equal(shouldTradeSignal({ direction: "short", c1: 90 }, { longBelow: 20, shortAbove: 90 }), false);
  assert.equal(shouldTradeSignal({ direction: "short", c1: 80.01 }, { longBelow: 20, shortAbove: 80 }), true);
});

test("parses Binance aggregate trade lines without requiring all CSV columns", () => {
  assert.deepEqual(parseAggTradeLine("123,65000.5,0.002,120,121,1719792000123,false"), {
    price: 65000.5,
    quantity: 0.002,
    time: 1719792000123
  });
  assert.equal(parseAggTradeLine("agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker"), null);
  assert.equal(parseAggTradeLine("bad,line"), null);
});

test("emits a signal only after it persists for the configured milliseconds", () => {
  const gate = new PersistentSignalGate(500);
  const signal = { bucket: 1000, direction: "long", c1: 35 };

  assert.equal(gate.update(signal, 1000), null);
  assert.equal(gate.update(signal, 1499), null);
  assert.deepEqual(gate.update(signal, 1500), signal);
  assert.equal(gate.update(signal, 1501), null);
});

test("resets pending signal persistence when direction changes", () => {
  const gate = new PersistentSignalGate(500);

  assert.equal(gate.update({ bucket: 1000, direction: "long", c1: 35 }, 1000), null);
  assert.equal(gate.update({ bucket: 1000, direction: "short", c1: 70 }, 1300), null);
  assert.equal(gate.update({ bucket: 1000, direction: "short", c1: 70 }, 1799), null);
  assert.deepEqual(gate.update({ bucket: 1000, direction: "short", c1: 70 }, 1800), {
    bucket: 1000,
    direction: "short",
    c1: 70
  });
});

test("computes partial Flash Point with exact v0.8 warmup and slow line", () => {
  const first = computePartialFlashPoint([], { time: 1000, open: 10, high: 10, low: 10, close: 10 });
  nearlyEqual(first.rsv, 0);
  nearlyEqual(first.c1, 0);
  nearlyEqual(first.c2, 0);

  const second = computePartialFlashPoint(
    [{ time: 1000, open: 10, high: 10, low: 10, close: 10 }],
    { time: 2000, open: 12, high: 12, low: 10, close: 12 },
    first
  );

  nearlyEqual(second.rsv, 75);
  nearlyEqual(second.c1, 30);
  nearlyEqual(second.c2, 6.66);
  assert.equal(second.crossing, "up");
});

test("settles no-SL long and short trades when TP is touched", () => {
  const trades = [
    { time: 1000, price: 100 },
    { time: 2000, price: 98.9 },
    { time: 3000, price: 101.1 },
    { time: 4000, price: 98.8 }
  ];
  const entries = [
    { id: 1, time: 1000, direction: "long", entry: 100 },
    { id: 2, time: 1000, direction: "short", entry: 100 }
  ];

  const results = settleOpenTrades(entries, trades, { tp: 1, sl: null });

  assert.equal(results[0].outcome, "win");
  assert.equal(results[0].holdMs, 2000);
  assert.equal(results[1].outcome, "win");
  assert.equal(results[1].holdMs, 1000);
});

test("settles SL before TP when stop is touched first", () => {
  const trades = [
    { time: 1000, price: 100 },
    { time: 2000, price: 98.9 },
    { time: 3000, price: 101.1 }
  ];
  const entries = [
    { id: 1, time: 1000, direction: "long", entry: 100 }
  ];

  const results = settleOpenTrades(entries, trades, { tp: 1, sl: 1 });

  assert.equal(results[0].outcome, "loss");
  assert.equal(results[0].holdMs, 1000);
});

test("summarizes leveraged account equity with configurable compounding", () => {
  const candidates = [
    { id: 1, time: 1000, entry: 65000, direction: "long", tpHitMs: [1000], slHitMs: [null] },
    { id: 2, time: 3000, entry: 65000, direction: "long", tpHitMs: [1000], slHitMs: [null] }
  ];

  const fixed = summarizeCandidateSet(candidates, 0, 0, 10, 5, true, {
    initialCapital: 500,
    leverage: 20,
    referencePrice: 65000,
    compoundRate: 0
  });
  const fullCompound = summarizeCandidateSet(candidates, 0, 0, 10, 5, true, {
    initialCapital: 500,
    leverage: 20,
    referencePrice: 65000,
    compoundRate: 1
  });

  nearlyEqual(fixed.finalEquity, 503.076923, 1e-6);
  nearlyEqual(fullCompound.finalEquity, 503.081657, 1e-6);
  assert.equal(fixed.bankrupt, false);
  assert.equal(fullCompound.bankrupt, false);
});

test("summarizes open trade settlement timing", () => {
  const summary = summarizeOpenTradeSettlements([
    { outcome: "win", holdMs: 1000 },
    { outcome: "win", holdMs: 30000 },
    { outcome: "open", holdMs: null }
  ]);

  assert.equal(summary.entries, 3);
  assert.equal(summary.wins, 2);
  assert.equal(summary.open, 1);
  assert.equal(summary.eventualWinRate, 2 / 3);
  assert.equal(summary.within30s, 2 / 3);
});

test("calculates annualized daily Sharpe from daily PnL", () => {
  const result = calculateAnnualizedDailySharpe([10, -5, 0, 15], {
    initialCapital: 100,
    periodsPerYear: 365
  });

  nearlyEqual(result.meanDailyReturn, 0.05);
  nearlyEqual(result.stdDailyReturn, 0.09128709291752769);
  nearlyEqual(result.sharpe365, 10.464224768228176);
});
