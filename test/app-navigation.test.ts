import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("settings page exposes a shortcut to strategy query", () => {
  const source = readFileSync("src/client/App.tsx", "utf8");

  assert.match(source, /onOpenStrategyQuery/);
  assert.match(source, /查詢策略結果/);
  assert.match(source, /setPage\("strategyQuery"\)/);
});

test("strategy query page uses Traditional Chinese title and tested-value datalists", () => {
  const source = readFileSync("src/client/App.tsx", "utf8");

  assert.doesNotMatch(source, /Strategy 查詢/);
  assert.match(source, /策略查詢/);
  assert.match(source, /datalist/);
  assert.match(source, /optionValues/);
});

test("strategy query page has tabs for limit search and result search", () => {
  const source = readFileSync("src/client/App.tsx", "utf8");

  assert.match(source, /用條件查/);
  assert.match(source, /用結果查/);
  assert.match(source, /queryMode/);
});

test("history page shows entry and exit times including ongoing positions", () => {
  const source = readFileSync("src/client/App.tsx", "utf8");

  assert.match(source, /進場時間/);
  assert.match(source, /出場時間/);
  assert.match(source, /payload\.paperOrders/);
  assert.match(source, /filledAt/);
});
