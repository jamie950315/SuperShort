const assert = require("node:assert/strict");
const test = require("node:test");

const {
  latestCompleteUtcRange,
  parseAggTradeCsvLine,
  settleSignal,
  backtestSignals,
  summarize
} = require("../analysis/flashpoint-backtest");

test("selects the latest complete UTC day range", () => {
  const range = latestCompleteUtcRange(30, Date.parse("2026-06-21T11:58:31.000Z"));
  assert.equal(range.startDate, "2026-05-22");
  assert.equal(range.endDateExclusive, "2026-06-21");
});

test("parses Binance USD-M aggregate trade csv rows", () => {
  assert.deepEqual(
    parseAggTradeCsvLine("264085257,63462.3,0.207,512894891,512894895,1781913600056,true"),
    { price: 63462.3, quantity: 0.207, time: 1781913600056 }
  );
  assert.equal(parseAggTradeCsvLine("agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker"), null);
});

test("settles long trades on the first later TP or SL touch", () => {
  const bars = [
    { time: 1000, high: 100, low: 100, close: 100 },
    { time: 2000, high: 100.8, low: 99.8, close: 100.5 },
    { time: 3000, high: 101.1, low: 100.4, close: 101 }
  ];
  const signal = { index: 0, time: 1000, direction: "long", entry: 100, c1: 35 };

  const result = settleSignal(bars, signal, 1, 1);

  assert.equal(result.outcome, "win");
  assert.equal(result.exit, 101);
  assert.equal(result.holdMs, 2000);
});

test("counts same-candle TP and SL touches as conservative losses", () => {
  const bars = [
    { time: 1000, high: 100, low: 100, close: 100 },
    { time: 2000, high: 101.2, low: 98.8, close: 100.2 }
  ];
  const signal = { index: 0, time: 1000, direction: "long", entry: 100, c1: 35 };

  const result = settleSignal(bars, signal, 1, 1);

  assert.equal(result.outcome, "loss");
  assert.equal(result.ambiguous, true);
  assert.equal(result.pnl, -1);
});

test("summarizes settled backtest results", () => {
  const bars = [
    { time: 1000, high: 100, low: 100, close: 100 },
    { time: 2000, high: 101.2, low: 100, close: 101 },
    { time: 3000, high: 101, low: 99, close: 99 }
  ];
  const signals = [
    { index: 0, time: 1000, direction: "long", entry: 100, c1: 35 },
    { index: 1, time: 2000, direction: "long", entry: 101, c1: 45 }
  ];

  const summary = summarize(backtestSignals(bars, signals, { tp: 1, sl: 1 }));

  assert.equal(summary.trades, 2);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.expectancy, 0);
});
