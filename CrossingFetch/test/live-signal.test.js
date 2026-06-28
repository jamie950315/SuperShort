const assert = require("node:assert/strict");
const test = require("node:test");

const LiveSignal = require("../live-signal.js");

test("normalizes supported TradingView symbols to tuned profiles", () => {
  assert.equal(LiveSignal.normalizeSymbol("BINANCE:BTCUSDC.P"), "BTCUSDC");
  assert.equal(LiveSignal.normalizeSymbol("ETHUSDC"), "ETHUSDC");
  assert.equal(LiveSignal.normalizeSymbol("BINANCE:SOLUSDC"), "SOLUSDC");
  assert.equal(LiveSignal.normalizeSymbol("DOGEUSDC"), "DOGEUSDC");
});

test("returns a clear unsupported target warning", () => {
  const signal = LiveSignal.evaluateLiveSignal({
    market: { symbol: "DOGEUSDC", timeframe: "5m" },
    flash: { c1: 20, c2: 30, readable: true },
    crossing: "up"
  });

  assert.equal(signal.supported, false);
  assert.equal(signal.symbol, "DOGEUSDC");
  assert.equal(signal.state, "UNSUPPORTED");
  assert.equal(signal.text, "DOGEUSDC unsupported: no tuned profile");
});

test("creates a BTC long ready signal with reasons", () => {
  const signal = LiveSignal.evaluateLiveSignal({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { c1: 32, c2: 36, readable: true },
    crossing: "none"
  });

  assert.equal(signal.supported, true);
  assert.equal(signal.symbol, "BTCUSDC");
  assert.equal(signal.side, "LONG");
  assert.equal(signal.state, "READY");
  assert.match(signal.text, /^BTC LONG READY:/);
  assert.ok(signal.reasons.includes("C1 low"));
  assert.ok(signal.reasons.includes("bull score 3"));
});

test("creates a SOL short enter signal on high C1 cross down", () => {
  const signal = LiveSignal.evaluateLiveSignal({
    market: { symbol: "SOLUSDC", timeframe: "10m" },
    flash: { c1: 82, c2: 86, readable: true },
    crossing: "down"
  });

  assert.equal(signal.side, "SHORT");
  assert.equal(signal.state, "ENTER");
  assert.match(signal.text, /^SOL SHORT ENTER:/);
  assert.ok(signal.reasons.includes("cross down"));
  assert.ok(signal.reasons.includes("bear score 5"));
});

test("returns WAIT when Flash Point values are unreadable", () => {
  const signal = LiveSignal.evaluateLiveSignal({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { readable: false },
    crossing: "none"
  });

  assert.equal(signal.state, "WAIT");
  assert.equal(signal.text, "BTC WAIT: Flash Point values not readable");
});

test("tracker turns enter into hold, trim, and exit decisions", () => {
  const tracker = LiveSignal.createLiveSignalTracker();

  const enter = tracker.update({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { c1: 28, c2: 26, readable: true },
    crossing: "up"
  });
  assert.equal(enter.state, "ENTER");
  assert.equal(enter.side, "LONG");
  assert.equal(tracker.getActiveSide(), "LONG");

  const hold = tracker.update({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { c1: 52, c2: 44, readable: true },
    crossing: "none"
  });
  assert.equal(hold.state, "HOLD");
  assert.equal(hold.side, "LONG");

  const trim = tracker.update({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { c1: 64, c2: 66, readable: true },
    crossing: "none"
  });
  assert.equal(trim.state, "TRIM");
  assert.equal(trim.side, "LONG");

  const exit = tracker.update({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { c1: 75, c2: 80, readable: true },
    crossing: "down"
  });
  assert.equal(exit.state, "EXIT");
  assert.equal(exit.side, "LONG");
  assert.equal(tracker.getActiveSide(), null);
});

test("tracker can be reset manually", () => {
  const tracker = LiveSignal.createLiveSignalTracker();
  tracker.update({
    market: { symbol: "SOLUSDC", timeframe: "10m" },
    flash: { c1: 82, c2: 86, readable: true },
    crossing: "down"
  });
  assert.equal(tracker.getActiveSide(), "SHORT");

  tracker.reset();
  assert.equal(tracker.getActiveSide(), null);
});
