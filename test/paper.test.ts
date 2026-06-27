import assert from "node:assert/strict";
import test from "node:test";
import { PaperGtxExecutor } from "../src/server/paper.js";
import { defaultStrategyConfig } from "../src/server/config.js";
import type { BookTickerEvent, SignalEvent } from "../src/shared/types.js";

const book: BookTickerEvent = {
  symbol: "BTCUSDC",
  bidPrice: 100,
  bidQty: 10,
  askPrice: 100.1,
  askQty: 10,
  eventTime: 1000
};

const signal: SignalEvent = {
  symbol: "BTCUSDC",
  interval: "5s",
  time: 1000,
  bucket: 1000,
  direction: "long",
  price: 100.05,
  c1: 35,
  c2: 34,
  configVersion: 1
};

const singleSlLadder = [{ triggerOffset: 0.5, limitOffset: 1, quantityPct: 1 }];

test("paper GTX order becomes resting when still maker-safe after activation", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  executor.setBook(book);
  const order = executor.createOrder(signal, defaultStrategyConfig("BTCUSDC"), {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 50,
    sampleTime: 1000
  });
  assert.ok(order);
  const changed = executor.processBook({ ...book, eventTime: 1050 });
  assert.equal(changed[0].status, "resting");
});

test("paper GTX requires trade-through before entry fill", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  executor.setBook(book);
  const order = executor.createOrder(signal, defaultStrategyConfig("BTCUSDC"), {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });
  const touch = executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice, quantity: 99, eventTime: 1002, tradeTime: 1002 });
  assert.equal(touch.orders.length, 0);
  const through = executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: 1000, eventTime: 1003, tradeTime: 1003 });
  assert.equal(through.orders[0].status, "filled");
});

test("paper GTX SL waits for maker bounce instead of hard-stop fill", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = { ...defaultStrategyConfig("BTCUSDC"), tp: 10, sl: 1, slLadder: singleSlLadder };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });
  executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: 1000, eventTime: 1002, tradeTime: 1002 });
  const trigger = executor.processTrade({ symbol: "BTCUSDC", price: order.slPrice - 0.2, quantity: 1000, eventTime: 1003, tradeTime: 1003 });
  assert.equal(trigger.trades.length, 0);
  const bounce = executor.processTrade({ symbol: "BTCUSDC", price: order.slPrice + 0.1, quantity: 1000, eventTime: 1004, tradeTime: 1004 });
  assert.equal(bounce.trades[0].reason, "sl_reduce_only");
  assert.equal(bounce.trades[0].exitPrice, order.slPrice);
});

test("paper SL stop trigger is placed between entry and SL after entry fill", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = { ...defaultStrategyConfig("BTCUSDC"), tp: 10, sl: 1, slTriggerOffset: 0.5 };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });
  const fill = executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: 1000, eventTime: 1002, tradeTime: 1002 });

  assert.equal(fill.orders[0].status, "filled");
  assert.equal(fill.orders[0].audit.slStopTriggerPrice, order.entryIntentPrice - 0.5);
  assert.equal(fill.orders[0].audit.slStopLimitPrice, order.slPrice);
  assert.equal(fill.orders[0].audit.tpReduceOnlyPrice, order.tpPrice);
});

test("paper SL trigger activates before SL limit and SL fills only after maker bounce", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = { ...defaultStrategyConfig("BTCUSDC"), tp: 10, sl: 1, slTriggerOffset: 0.5, makerSlRetryMs: 3000, slLadder: singleSlLadder };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });
  executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: 1000, eventTime: 1002, tradeTime: 1002 });

  const trigger = executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.6, quantity: 1000, eventTime: 1003, tradeTime: 1003 });
  const triggeredLevel = trigger.orders[0].audit.slLadderOrders as Array<{ triggeredAt?: number; armedAt?: number }>;
  assert.equal(trigger.trades.length, 0);
  assert.equal(triggeredLevel[0].triggeredAt, 1003);
  assert.equal(triggeredLevel[0].armedAt, undefined);

  const breach = executor.processTrade({ symbol: "BTCUSDC", price: order.slPrice - 0.2, quantity: 1000, eventTime: 1004, tradeTime: 1004 });
  const armedLevel = breach.orders[0].audit.slLadderOrders as Array<{ armedAt?: number }>;
  assert.equal(breach.trades.length, 0);
  assert.equal(armedLevel[0].armedAt, 1004);

  const bounce = executor.processTrade({ symbol: "BTCUSDC", price: order.slPrice + 0.1, quantity: 1000, eventTime: 1005, tradeTime: 1005 });
  assert.equal(bounce.trades[0].reason, "sl_reduce_only");
  assert.equal(bounce.trades[0].exitPrice, order.slPrice);
});

test("paper SL ladder sizes reduce-only orders from the actual filled quantity", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = {
    ...defaultStrategyConfig("BTCUSDC"),
    entryTtlMs: 3000,
    slLadder: [
      { triggerOffset: 1, limitOffset: 1.5, quantityPct: 0.5 },
      { triggerOffset: 3, limitOffset: 3.5, quantityPct: 0.3 },
      { triggerOffset: 6, limitOffset: 6.5, quantityPct: 0.2 }
    ]
  };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });
  executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: order.quantity * 0.3, eventTime: 1500, tradeTime: 1500 });

  const expired = executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice + 0.1, quantity: 1000, eventTime: 4000, tradeTime: 4000 });
  const ladder = expired.orders[0].audit.slLadderOrders as Array<{ quantity: number; triggerPrice: number; limitPrice: number }>;

  assert.equal(expired.orders[0].filledQuantity < order.quantity, true);
  assert.equal(ladder.length, 3);
  assert.equal(ladder.reduce((sum, level) => sum + level.quantity, 0), expired.orders[0].filledQuantity);
  assert.equal(ladder[0].triggerPrice, order.entryIntentPrice - 1);
  assert.equal(ladder[0].limitPrice, order.entryIntentPrice - 1.5);
});

test("paper SL ladder can miss the first maker SL and fill a deeper remaining level", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = {
    ...defaultStrategyConfig("BTCUSDC"),
    tp: 10,
    emergencySl: 0,
    makerSlRetryMs: 3000,
    slLadder: [
      { triggerOffset: 1, limitOffset: 1.5, quantityPct: 0.5 },
      { triggerOffset: 3, limitOffset: 3.5, quantityPct: 0.3 },
      { triggerOffset: 6, limitOffset: 6.5, quantityPct: 0.2 }
    ]
  };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });
  executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: 1000, eventTime: 1002, tradeTime: 1002 });

  const firstMissed = executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 1.7, quantity: 1000, eventTime: 1003, tradeTime: 1003 });
  assert.equal(firstMissed.trades.length, 0);
  assert.equal(firstMissed.orders[0].audit.remainingQuantity, order.filledQuantity);

  const secondBreach = executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 3.7, quantity: 1000, eventTime: 1004, tradeTime: 1004 });
  assert.equal(secondBreach.trades.length, 0);

  const secondBounce = executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 3.4, quantity: 1000, eventTime: 1005, tradeTime: 1005 });

  assert.equal(secondBounce.trades[0].reason, "sl_reduce_only");
  assert.equal(secondBounce.trades[0].quantity, order.filledQuantity * 0.3);
  assert.equal(secondBounce.orders[0].status, "filled");
  assert.equal(secondBounce.orders[0].audit.remainingQuantity, order.filledQuantity * 0.7);
});

test("paper GTX SL places timeout reduce-only GTX at bar typical price after maker retry window expires", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = { ...defaultStrategyConfig("BTCUSDC"), tp: 10, sl: 1, makerSlRetryMs: 3000, emergencySl: 15, slLadder: singleSlLadder };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });
  executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: 1000, eventTime: 1002, tradeTime: 1002 });
  executor.processTrade({ symbol: "BTCUSDC", price: order.slPrice - 0.2, quantity: 1000, eventTime: 1003, tradeTime: 1003 });

  const timedOut = executor.processTrade(
    { symbol: "BTCUSDC", price: order.slPrice - 3, quantity: 1000, eventTime: 4003, tradeTime: 4003 },
    { typicalPrice: order.slPrice - 1.5 }
  );

  assert.equal(timedOut.trades.length, 0);
  assert.equal(timedOut.orders[0].status, "filled");
  const timeoutLevel = timedOut.orders[0].audit.slLadderOrders as Array<{ timeoutGtxPrice?: number }>;
  assert.equal(timeoutLevel[0].timeoutGtxPrice, order.slPrice - 1.5);

  const bounce = executor.processTrade({ symbol: "BTCUSDC", price: order.slPrice - 1.4, quantity: 1000, eventTime: 4004, tradeTime: 4004 });

  assert.equal(bounce.trades[0].reason, "sl_timeout_gtx");
  assert.equal(bounce.trades[0].exitPrice, order.slPrice - 1.5);
});

test("paper GTX SL uses emergency stop when price overshoots emergency distance", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = { ...defaultStrategyConfig("BTCUSDC"), tp: 10, sl: 1, makerSlRetryMs: 3000, emergencySl: 15, slLadder: singleSlLadder };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });
  executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: 1000, eventTime: 1002, tradeTime: 1002 });

  const emergency = executor.processTrade({ symbol: "BTCUSDC", price: order.entryFillPrice! - 15.5, quantity: 1000, eventTime: 1003, tradeTime: 1003 });

  assert.equal(emergency.trades[0].reason, "emergency_stop_market");
  assert.equal(emergency.trades[0].exitPrice, order.entryFillPrice! - 15.5);
});

test("paper SL system disabled ignores ladder and emergency exits but keeps TP active", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = {
    ...defaultStrategyConfig("BTCUSDC"),
    tp: 10,
    slEnabled: false,
    emergencySl: 2,
    slLadder: singleSlLadder
  };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });
  executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: 1000, eventTime: 1002, tradeTime: 1002 });

  const deepLoss = executor.processTrade({ symbol: "BTCUSDC", price: order.entryFillPrice! - 6, quantity: 1000, eventTime: 1003, tradeTime: 1003 });
  assert.equal(deepLoss.trades.length, 0);
  assert.equal(deepLoss.orders.length, 0);
  assert.equal(executor.openOrders()[0].status, "filled");

  const takeProfit = executor.processTrade({ symbol: "BTCUSDC", price: order.tpPrice + 0.1, quantity: 1000, eventTime: 1004, tradeTime: 1004 });
  assert.equal(takeProfit.trades[0].reason, "tp_reduce_only");
});

test("paper executor can continue open orders restored from storage", () => {
  const first = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  first.setBook(book);
  const order = first.createOrder(signal, defaultStrategyConfig("BTCUSDC"), {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  first.processBook({ ...book, eventTime: 1001 });

  const restored = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  restored.loadOrder(order);
  const result = restored.processTrade({
    symbol: "BTCUSDC",
    price: order.entryIntentPrice - 0.1,
    quantity: 1000,
    eventTime: 1002,
    tradeTime: 1002
  });

  assert.equal(result.orders[0].status, "filled");
});

test("paper GTX single mode refuses another order while one is open", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = { ...defaultStrategyConfig("BTCUSDC"), mode: "single" as const };
  executor.setBook(book);

  const first = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  const second = executor.createOrder({ ...signal, time: 1001 }, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1001
  });

  assert.ok(first);
  assert.equal(second, null);
});

test("paper reduce-only settlement waits for order activation latency after entry fill", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = { ...defaultStrategyConfig("BTCUSDC"), tp: 0.5, sl: 5 };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 50,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1050 });
  executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: 1000, eventTime: 1051, tradeTime: 1051 });

  const tooSoon = executor.processTrade({ symbol: "BTCUSDC", price: order.tpPrice + 0.1, quantity: 1000, eventTime: 1080, tradeTime: 1080 });
  assert.equal(tooSoon.trades.length, 0);

  const active = executor.processTrade({ symbol: "BTCUSDC", price: order.tpPrice + 0.1, quantity: 1000, eventTime: 1101, tradeTime: 1101 });
  assert.equal(active.trades[0].reason, "tp_reduce_only");
});

test("paper GTX entry TTL cancels an unfilled order after three seconds", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = { ...defaultStrategyConfig("BTCUSDC"), entryTtlMs: 3000 };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });

  const result = executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice + 0.1, quantity: 1000, eventTime: 4000, tradeTime: 4000 });

  assert.equal(result.orders[0].status, "canceled");
  assert.equal(result.orders[0].reason, "entry_ttl_cancel");
  assert.equal(result.trades.length, 0);
  assert.equal(executor.openOrders().length, 0);
});

test("paper GTX entry TTL keeps partial fill and cancels the remaining entry quantity", () => {
  const executor = new PaperGtxExecutor({ symbol: "BTCUSDC", tickSize: 0.1, referencePrice: 100 });
  const config = { ...defaultStrategyConfig("BTCUSDC"), entryTtlMs: 3000, tp: 1, sl: 5 };
  executor.setBook(book);
  const order = executor.createOrder(signal, config, {
    wsDelayMs: 10,
    restLatencyMs: 20,
    orderActivationDelayMs: 0,
    sampleTime: 1000
  });
  assert.ok(order);
  executor.processBook({ ...book, eventTime: 1001 });
  executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice - 0.1, quantity: order.quantity * 0.3, eventTime: 1500, tradeTime: 1500 });

  const expired = executor.processTrade({ symbol: "BTCUSDC", price: order.entryIntentPrice + 0.1, quantity: 1000, eventTime: 4000, tradeTime: 4000 });

  assert.equal(expired.orders[0].status, "filled");
  assert.equal(expired.orders[0].reason, "entry_ttl_cancel");
  assert.equal(expired.orders[0].filledQuantity < order.quantity, true);
  assert.equal(executor.openOrders().length, 1);

  const settled = executor.processTrade({ symbol: "BTCUSDC", price: order.tpPrice + 0.1, quantity: 1000, eventTime: 4001, tradeTime: 4001 });
  assert.equal(settled.trades[0].reason, "tp_reduce_only");
  assert.equal(settled.trades[0].quantity, expired.orders[0].filledQuantity);
});
