import assert from "node:assert/strict";
import test from "node:test";
import { sortStrategyQueryRows } from "../src/shared/strategyQueryTable.js";
import type { StrategyQueryRow } from "../src/shared/types.js";

function row(partial: Partial<StrategyQueryRow>): StrategyQueryRow {
  return {
    type: "match",
    interval: "5s",
    persistMs: 0,
    longBelow: 20,
    shortAbove: 55,
    tp: 1,
    sl: 2,
    mode: "single",
    entries: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    within30s: 0,
    p90HoldSeconds: 0,
    p99HoldSeconds: 0,
    maxHoldSeconds: 0,
    totalUsdcPnl: 0,
    expectancyPrice: 0,
    meanUsdPerTrade: 0,
    stdUsdPerTrade: 0,
    tradeSharpe: 0,
    cumulativeTradeSharpe: 0,
    finalEquity: 0,
    maxDrawdownPct: 0,
    ...partial
  };
}

test("sorts strategy query rows by numeric column and keeps summaries at bottom", () => {
  const rows = [
    row({ shortAbove: 60, finalEquity: 600 }),
    row({ shortAbove: 55, finalEquity: 800 }),
    row({ type: "average", finalEquity: 700 }),
    row({ type: "median", finalEquity: 700 })
  ];

  const sorted = sortStrategyQueryRows(rows, { key: "finalEquity", direction: "desc" });

  assert.deepEqual(sorted.map((item) => item.type), ["match", "match", "average", "median"]);
  assert.deepEqual(sorted.slice(0, 2).map((item) => item.finalEquity), [800, 600]);
});

test("sorts strategy query rows by text column", () => {
  const rows = [
    row({ interval: "30s" }),
    row({ interval: "5s" })
  ];

  const sorted = sortStrategyQueryRows(rows, { key: "interval", direction: "asc" });

  assert.deepEqual(sorted.map((item) => item.interval), ["5s", "30s"]);
});
