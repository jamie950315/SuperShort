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
  assert.match(pollAccount, /wsConnected: binanceWsConnected, restOk: true/);
  assert.doesNotMatch(pollAccount, /wsConnected: true/);
});

test("worker clears stale bookTicker state when websocket disconnects", () => {
  const source = readFileSync("src/server/worker.ts", "utf8");

  assert.match(source, /currentBook = null/);
  assert.match(source, /paper\.clearBook\(\)/);
  assert.match(source, /currentBook\.eventTime >= event\.tradeTime - 5_000/);
});

test("worker warms Flash Point state from stored closed candles on startup", () => {
  const source = readFileSync("src/server/worker.ts", "utf8");

  assert.match(source, /store\.getCandles\(config\.symbol, interval, 200\)/);
  assert.match(source, /series\.update\(candle\)/);
});
