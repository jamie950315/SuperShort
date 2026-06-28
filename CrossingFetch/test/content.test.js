const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("content script does not observe the whole TradingView DOM", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.doesNotMatch(content, /new MutationObserver/);
  assert.doesNotMatch(content, /observe\(document\.documentElement/);
  assert.match(content, /const FLASH_REFRESH_INTERVAL_MS = 500;/);
});

test("content script has a no-bar fallback sampler for readable C1 C2 values", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /const NO_BAR_FALLBACK_SAMPLE_MS = 1000;/);
  assert.match(content, /reason: "no-bar-flash-change"/);
  assert.match(content, /reason: "no-bar-fallback-interval"/);
});

test("content script saves C1 C2 crossings immediately in bar mode", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /saveCrossingEventSample\(current\)/);
  assert.match(content, /reason: "crossing-event"/);
  assert.match(content, /lastCrossingEventKey/);
});

test("content script caches numeric indicator series by path", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /latestIndicatorSeriesByPath = new Map/);
  assert.match(content, /latestIndicatorSeriesByPath\.set\(entry\.path/);
  assert.match(content, /rememberNumericSeries\(numericSeries\)/);
  assert.match(content, /rankIndicatorSeries/);
});

test("content script stores bar series source paths in samples", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /extractBarSeriesFromMessage\(message\)/);
  assert.match(content, /latestBarSeries/);
  assert.match(content, /barSeries: latestBarSeries/);
});

test("content script preserves recent series points for later reconstruction", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /recentPoints/);
  assert.match(content, /slice\(-20\)/);
});

test("content script accumulates recent series points across messages", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /latestBarSeriesByPath = new Map/);
  assert.match(content, /rememberBarSeries\(barSeries\)/);
  assert.match(content, /mergeRecentPoints/);
  assert.match(content, /dedupePointsByTime/);
});

test("content script stores same-socket bar and indicator snapshots", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /latestSocketSnapshot/);
  assert.match(content, /makeSocketSnapshot\(/);
  assert.match(content, /instantBar:/);
  assert.match(content, /instantBarSeries:/);
  assert.match(content, /instantIndicatorSeries:/);
  assert.match(content, /latestSocketSnapshot = null/);
});

test("content script keeps the last useful socket snapshot through unrelated messages", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /const socketSnapshot = makeSocketSnapshot/);
  assert.match(content, /if \(socketSnapshot\) latestSocketSnapshot = socketSnapshot/);
});

test("content script saves socket-aligned exact Flash Point samples", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /instantFlashPoint/);
  assert.match(content, /saveSocketAlignedSample\(socketSnapshot\)/);
  assert.match(content, /reason: "socket-aligned"/);
  assert.match(content, /lastSocketAlignedKey/);
});

test("content script resets dedupe state when clearing all samples", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /function resetSessionDedupeState/);
  assert.match(content, /lastSocketAlignedKey = ""/);
  assert.match(content, /lastBodyFlash = null/);
  assert.match(content, /clearAllSamples[\s\S]*resetSessionDedupeState\(\)/);
});

test("content script isolates pending IndexedDB writes across clears", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /let sessionGeneration = 0/);
  assert.match(content, /let writeChain = Promise\.resolve\(\)/);
  assert.match(content, /const generation = sessionGeneration/);
  assert.match(content, /if \(generation !== sessionGeneration \|\| sampleSessionId !== sessionId\) return/);
  assert.match(content, /clearCurrentSession[\s\S]*sessionGeneration \+= 1/);
  assert.match(content, /clearAllSamples[\s\S]*sessionGeneration \+= 1/);
});

test("content script throttles expensive market text detection", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /const MARKET_GUESS_CACHE_MS = 2000/);
  assert.match(content, /let cachedMarketGuess = null/);
  assert.match(content, /function guessMarket\(\)/);
  assert.match(content, /cachedMarketGuess\.href === href/);
  assert.match(content, /cachedMarketGuess\.title === title/);
  assert.match(content, /market: guessMarket\(\)/);
});

test("content script requires a strong Flash Point indicator candidate", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /function isStrongFlashPointSeries/);
  assert.match(content, /\.filter\(\(candidate\) => candidate\.strong\)/);
  assert.match(content, /function selectFlashPointCandidate/);
  assert.match(content, /candidates\.length === 1/);
});

test("content script rejects ambiguous explicit Flash Point candidates", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /dedupeEquivalentFlashPointCandidates/);
  assert.match(content, /if \(explicit\.length === 1\) return explicit\[0\]/);
  assert.match(content, /if \(explicit\.length > 1\) return null/);
});

test("analysis model rejects ambiguous explicit Flash Point candidates", () => {
  const model = fs.readFileSync(path.join(__dirname, "..", "analysis", "flash-point-model.js"), "utf8");
  assert.match(model, /dedupeEquivalentFlashPointCandidates/);
  assert.match(model, /if \(explicit\.length === 1\) return explicit\[0\]/);
  assert.match(model, /if \(explicit\.length > 1\) return null/);
});

test("manifest injects WebSocket mirror in the main world at document_start", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const mainWorldScript = manifest.content_scripts.find((entry) => {
    return entry.world === "MAIN" && entry.run_at === "document_start" && entry.js.includes("injected.js");
  });

  assert.ok(mainWorldScript, "injected.js must run in MAIN world before TradingView creates WebSockets");
});
