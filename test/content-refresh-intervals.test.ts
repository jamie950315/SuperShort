import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function extractFunction(source: string, name: string) {
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

function loadSymbolHelpers(source: string) {
  const quotes = source.match(/const SYMBOL_QUOTES = \[[^\]]+\];/)?.[0] || "";
  const coerce = source.includes("function coerceSymbolCandidate")
    ? extractFunction(source, "coerceSymbolCandidate")
    : "";
  const find = extractFunction(source, "findSymbolCandidateFromText");
  const normalize = extractFunction(source, "normalizeSymbolInput");
  return Function(`${quotes}\n${coerce}\n${find}\n${normalize}\nreturn { findSymbolCandidateFromText, normalizeSymbolInput };`)() as {
    findSymbolCandidateFromText(value: string): string | null;
    normalizeSymbolInput(value: string): string;
  };
}

test("content panel keeps REST-backed trading snapshots on a conservative interval", () => {
  const content = readFileSync("content.js", "utf8");
  assert.match(content, /const SNAPSHOT_INTERVAL_MS = 5000;/);
  assert.match(content, /const MARKET_TICKER_INTERVAL_MS = 250;/);
  assert.match(content, /setInterval\(\(\) => refreshSnapshot\(false\), SNAPSHOT_INTERVAL_MS\)/);
});

test("content panel refreshes position and PNL from market ticker payloads", () => {
  const content = readFileSync("content.js", "utf8");
  assert.match(content, /if \(res\.result\?\.position\) updateMarketUi\(res\.result\)/);
  assert.match(content, /else updateCurrentPriceUi\(res\.result\)/);
});

test("content panel does not clear auto-settle preview when ticker omits preview data", () => {
  const content = readFileSync("content.js", "utf8");
  assert.match(content, /if \("autoSettlementPreview" in \(data \|\| \{\}\)\) \{/);
  assert.match(content, /updateAutoSettlementPreview\(data\.autoSettlementPreview\)/);
});

test("content panel does not overwrite websocket status when ticker omits user stream data", () => {
  const content = readFileSync("content.js", "utf8");
  assert.match(content, /if \("userStreamStatus" in \(data \|\| \{\}\)\) \{/);
  assert.match(content, /updateUserStreamStatus\(data\.userStreamStatus\)/);
});

test("content symbol parser preserves USDC quote symbols", () => {
  const content = readFileSync("content.js", "utf8");
  assert.match(content, /const SYMBOL_QUOTES = \["FDUSD", "USDC", "USDT", "BUSD", "USD"\]/);
  const helpers = loadSymbolHelpers(content);
  assert.equal(helpers.normalizeSymbolInput("BINANCE:BTCUSDC.P"), "BTCUSDC");
  assert.equal(helpers.normalizeSymbolInput("BTC/USDC"), "BTCUSDC");
  assert.equal(helpers.findSymbolCandidateFromText("Bitcoin BTCUSDC perpetual"), "BTCUSDC");
});

test("content panel auto-detects symbol changes on SPA navigation", () => {
  const content = readFileSync("content.js", "utf8");
  assert.match(content, /function installSymbolAutoDetect/);
  assert.match(content, /history\[method\] = function patchedHistoryMethod/);
  assert.doesNotMatch(content, /new MutationObserver/);
  assert.match(content, /symbol\.value = ""/);
  assert.match(content, /applyDetectedSymbol\(false/);
});

test("content panel does not auto-detect symbol during high-frequency ticker refresh", () => {
  const content = readFileSync("content.js", "utf8");
  const refreshMarketTicker = extractFunction(content, "refreshMarketTicker");
  const refreshSnapshot = extractFunction(content, "refreshSnapshot");

  assert.match(content, /symbolManuallyLocked/);
  assert.match(content, /currentSymbolForRequest/);
  assert.doesNotMatch(content, /symbol\.value \|\| "BTCUSDT"/);
  assert.doesNotMatch(refreshMarketTicker, /applyDetectedSymbol\(false, \{ refresh: false \}\)/);
  assert.doesNotMatch(refreshSnapshot, /applyDetectedSymbol\(false, \{ refresh: false \}\)/);
});

test("content order placement uses only the guarded current symbol", () => {
  const content = readFileSync("content.js", "utf8");
  const place = extractFunction(content, "place");

  assert.match(place, /currentSymbolForRequest\(\)/);
  assert.doesNotMatch(place, /guessSymbol\(\)/);
});

test("content symbol parser does not default empty symbols to BTCUSDT", () => {
  const content = readFileSync("content.js", "utf8");
  const helpers = loadSymbolHelpers(content);

  assert.equal(helpers.normalizeSymbolInput(""), "");
});

test("popup exposes profit-only settlement setting", () => {
  const html = readFileSync("popup.html", "utf8");
  const js = readFileSync("popup.js", "utf8");

  assert.match(html, /id="profitOnlySettlementEnabled"/);
  assert.match(js, /profitOnlySettlementEnabled/);
});
