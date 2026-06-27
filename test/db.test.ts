import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../src/server/db.js";
import type { PaperOrder } from "../src/shared/types.js";

function openTempStore() {
  const dir = mkdtempSync(join(tmpdir(), "supershort-db-"));
  const store = openStore(join(dir, "test.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("portfolio reset settles open paper orders and inserts reset history", () => {
  const { store, cleanup } = openTempStore();
  try {
    const order: PaperOrder = {
      id: "paper_open",
      symbol: "BTCUSDC",
      configVersion: 1,
      direction: "long",
      status: "filled",
      entryIntentPrice: 100,
      entryFillPrice: 100,
      quantity: 1,
      filledQuantity: 1,
      createdAt: 1000,
      activeAt: 1000,
      filledAt: 1100,
      settledAt: null,
      tpPrice: 115,
      slPrice: 95,
      exitFillPrice: null,
      pnlUsdc: 0,
      reason: null,
      audit: {}
    };
    store.upsertPaperOrder(order);

    const result = store.resetPaperPortfolio("BTCUSDC", 500, 2000);

    assert.equal(result.closedOrders, 1);
    assert.equal(store.getOpenPaperOrders("BTCUSDC").length, 0);
    assert.equal(store.getLatestPortfolio()?.paperEquity, 500);
    assert.equal(store.getLatestPortfolio()?.paperRealizedPnl, 0);
    assert.equal(store.getLatestPortfolio()?.openPaperPositions, 0);

    const [resetTrade] = store.getPaperTrades(1);
    assert.equal(resetTrade.eventType, "portfolio_reset");
    assert.equal(resetTrade.title, "Portfolio Reset：強制結清 1 筆，資金回到 500 USDC");
    assert.equal(resetTrade.reason, "manual_reset");

    const [settledOrder] = store.getPaperOrders("BTCUSDC", 1);
    assert.equal(settledOrder.status, "settled");
    assert.equal(settledOrder.settledAt, 2000);
    assert.equal(settledOrder.exitFillPrice, 100);
    assert.equal(settledOrder.reason, "manual_reset");
  } finally {
    cleanup();
  }
});

test("telemetry cleanup removes raw events and latency samples older than retention", () => {
  const { store, cleanup } = openTempStore();
  try {
    const now = Date.now();
    const old = now - 8 * 24 * 60 * 60 * 1000;

    store.insertRawEvent("bookTicker", "BTCUSDC", old, { bid: 1 });
    store.insertRawEvent("bookTicker", "BTCUSDC", now, { bid: 2 });
    store.insertLatency("ws", 10, old);
    store.insertLatency("ws", 20, now);

    const result = store.cleanupTelemetry(7);

    assert.equal(result.rawEventsDeleted, 1);
    assert.equal(result.latencySamplesDeleted, 1);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM raw_events").get() as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM latency_samples").get() as { count: number }).count, 1);
  } finally {
    cleanup();
  }
});

test("latency samples have a time index for retention cleanup", () => {
  const { store, cleanup } = openTempStore();
  try {
    const indexes = store.db.prepare("PRAGMA index_list(latency_samples)").all() as Array<{ name: string }>;
    assert.ok(indexes.some((index) => index.name === "idx_latency_samples_time"));
  } finally {
    cleanup();
  }
});

test("storage limit enforcement removes old telemetry without deleting trading records", () => {
  const { store, cleanup } = openTempStore();
  try {
    for (let index = 0; index < 100; index += 1) {
      store.insertRawEvent("bookTicker", "BTCUSDC", 1000 + index, { bid: index, payload: "x".repeat(1000) });
      store.insertLatency("ws", index, 1000 + index);
    }
    store.insertSignal({
      symbol: "BTCUSDC",
      interval: "1s",
      time: 2000,
      bucket: 2000,
      direction: "long",
      price: 65000,
      c1: 10,
      c2: 9,
      configVersion: 1
    });

    const result = store.enforceStorageLimit(1);

    assert.equal(result.enforced, true);
    assert.equal(result.rawEventsDeleted, 100);
    assert.equal(result.latencySamplesDeleted, 100);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM raw_events").get() as { count: number }).count, 0);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM latency_samples").get() as { count: number }).count, 0);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM signals").get() as { count: number }).count, 1);
  } finally {
    cleanup();
  }
});
