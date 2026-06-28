import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("worker does not let REST polling mark websocket as connected", () => {
  const source = readFileSync("src/server/worker.ts", "utf8");
  const pollAccount = extractFunction(source, "pollAccount");

  assert.match(source, /let binanceWsConnected = false/);
  assert.match(source, /wsConnected: false/);
  assert.match(pollAccount, /setBinanceState\(\{ restOk: true \}\)/);
  assert.match(pollAccount, /setBinanceState\(\{ restOk: false, error:/);
  assert.doesNotMatch(pollAccount, /wsConnected: true/);
});

test("worker websocket handlers preserve REST health state", () => {
  const source = readFileSync("src/server/worker.ts", "utf8");
  const onBookTickerStart = source.indexOf("onBookTicker(event)");
  const onStatusStart = source.indexOf("onStatus(status)");
  const streamEnd = source.indexOf("\n\nsetInterval", onStatusStart);
  assert.notEqual(onBookTickerStart, -1);
  assert.notEqual(onStatusStart, -1);
  assert.notEqual(streamEnd, -1);
  const onBookTicker = source.slice(onBookTickerStart, onStatusStart);
  const onStatus = source.slice(onStatusStart, streamEnd);

  assert.match(source, /function setBinanceState/);
  assert.match(source, /let binanceState = \{ \.\.\.store\.getState/);
  assert.match(source, /store\.setState\("binance", binanceState\)/);
  assert.match(source, /if \(shallowEqualState\(next, binanceState\)\) return/);
  assert.match(onBookTicker, /setBinanceState\(\{ wsConnected: true \}\)/);
  assert.match(onStatus, /setBinanceState\(\{ wsConnected: status\.connected \}\)/);
  assert.doesNotMatch(onBookTicker, /restOk: true/);
  assert.doesNotMatch(onStatus, /restOk: true/);
});

test("worker clears stale bookTicker state when websocket disconnects", () => {
  const source = readFileSync("src/server/worker.ts", "utf8");

  assert.match(source, /currentBook = null/);
  assert.match(source, /paper\.clearBook\(\)/);
  assert.match(source, /currentBook\.eventTime >= event\.tradeTime - 5_000/);
});

test("worker warms Flash Point state from stored closed candles on startup", () => {
  const source = readFileSync("src/server/worker.ts", "utf8");

  assert.match(source, /store\.getClosedCandles\(config\.symbol, interval, 200\)/);
  assert.match(source, /series\.update\(candle\)/);
});
