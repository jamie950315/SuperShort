import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseBinanceStreamMessage, shouldReconnectStaleStream } from "../src/server/binance.js";

test("Binance stream parser drops zero-price trades", () => {
  const parsed = parseBinanceStreamMessage(JSON.stringify({
    stream: "btcusdc@aggTrade",
    data: { s: "BTCUSDC", p: null, q: null, E: 1000, T: 1000, m: true }
  }), "BTCUSDC", 1000);

  assert.equal(parsed, null);
});

test("Binance stream parser accepts positive trades", () => {
  const parsed = parseBinanceStreamMessage(JSON.stringify({
    stream: "btcusdc@aggTrade",
    data: { s: "BTCUSDC", p: "65000.1", q: "0.01", E: 1000, T: 1000, m: true }
  }), "BTCUSDC", 1000);

  assert.equal(parsed?.kind, "trade");
  if (parsed?.kind === "trade") {
    assert.equal(parsed.event.price, 65000.1);
    assert.equal(parsed.event.quantity, 0.01);
  }
});

test("Binance stream watchdog reconnects only after stale timeout", () => {
  assert.equal(shouldReconnectStaleStream(20_000, 10_000, 15_000), false);
  assert.equal(shouldReconnectStaleStream(25_001, 10_000, 15_000), true);
  assert.equal(shouldReconnectStaleStream(25_001, null, 15_000), false);
});

test("Binance market stream subscribes to one trade stream to avoid duplicate fills", () => {
  const source = readFileSync("src/server/binance.ts", "utf8");
  assert.match(source, /@aggTrade/);
  assert.doesNotMatch(source, /\/\$\{lower\}@trade/);
});
