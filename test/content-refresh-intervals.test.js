const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("content panel keeps REST-backed snapshots slower than market ticker updates", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /const SNAPSHOT_INTERVAL_MS = 5000;/);
  assert.match(content, /const MARKET_TICKER_INTERVAL_MS = 250;/);
  assert.match(content, /setInterval\(\(\) => refreshSnapshot\(false\), SNAPSHOT_INTERVAL_MS\)/);
  assert.doesNotMatch(content, /refreshSnapshot\(false\), 2000/);
});
