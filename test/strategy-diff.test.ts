import assert from "node:assert/strict";
import test from "node:test";
import { defaultStrategyConfig } from "../src/server/config.js";
import { strategyDiffTitle, strategyDiffTooltip } from "../src/shared/strategyDiff.js";

test("strategy diff title summarizes changed strategy fields", () => {
  const previous = { ...defaultStrategyConfig("BTCUSDC"), version: 11, interval: "5s" as const, longBelow: 40, mode: "independent" as const };
  const current = { ...previous, version: 12, interval: "15s" as const, longBelow: 70, mode: "single" as const };

  assert.equal(strategyDiffTitle(previous, current), "Time Window 5s → 15s、Long C1 <40 → <70、模式 允許多筆 → 同時一筆");
});

test("strategy diff tooltip includes full previous and current strategy", () => {
  const previous = { ...defaultStrategyConfig("BTCUSDC"), version: 11, tp: 2, slEnabled: true };
  const current = {
    ...previous,
    version: 12,
    tp: 15,
    slEnabled: false,
    slLadder: [{ triggerOffset: 2, limitOffset: 2.5, quantityPct: 1 }]
  };

  const tooltip = strategyDiffTooltip(previous, current);

  assert.match(tooltip, /上一版 v11/);
  assert.match(tooltip, /新版 v12/);
  assert.match(tooltip, /TP: 2/);
  assert.match(tooltip, /TP: 15/);
  assert.match(tooltip, /SL System: 啟用/);
  assert.match(tooltip, /SL System: 停用/);
  assert.match(tooltip, /SL Ladder: 2→2.5:100%/);
});
