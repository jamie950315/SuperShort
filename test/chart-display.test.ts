import assert from "node:assert/strict";
import test from "node:test";
import {
  CHART_RIGHT_SCALE_WIDTH,
  candleMarkerTime,
  displayVolumeValue,
  orderMarkerPosition,
  orderOverlayItems
} from "../src/client/chartDisplay.js";

test("display volume keeps low non-zero bars visible beside large spikes", () => {
  const maxVolume = 10_000;

  assert.equal(displayVolumeValue(0, maxVolume), 0);
  assert.equal(displayVolumeValue(1, maxVolume), 5);
  assert.equal(displayVolumeValue(10_000, maxVolume), 100);
});

test("order markers stay near candles instead of the chart edge", () => {
  assert.equal(orderMarkerPosition("long", "entry"), "belowBar");
  assert.equal(orderMarkerPosition("short", "entry"), "aboveBar");
  assert.equal(orderMarkerPosition("long", "exit"), "aboveBar");
  assert.equal(orderMarkerPosition("short", "exit"), "belowBar");
});

test("order marker time snaps fills to the containing candle open time", () => {
  const candles = [
    { openTime: 1_000, closeTime: 5_999 },
    { openTime: 6_000, closeTime: 10_999 }
  ];

  assert.equal(candleMarkerTime(8_742, candles), 6);
  assert.equal(candleMarkerTime(10_999, candles), 6);
  assert.equal(candleMarkerTime(11_000, candles), null);
});

test("order overlay items include entry and settlement on candle open time", () => {
  const candles = [{ openTime: 6_000, closeTime: 10_999 }];
  const orders = [{
    id: "a",
    direction: "long",
    filledAt: 8_742,
    settledAt: 10_100,
    entryFillPrice: 100,
    exitFillPrice: 101,
    reason: "tp_reduce_only",
    quantity: 0.1,
    filledQuantity: 0.1
  }];

  assert.deepEqual(orderOverlayItems(orders, candles, null), [
    { id: "a-entry", time: 6, price: 100, direction: "long", kind: "entry", quantity: 0.1 },
    { id: "a-exit", time: 6, price: 101, direction: "long", kind: "tp", quantity: 0.1 }
  ]);
});

test("order overlay items include every ladder exit fill", () => {
  const candles = [
    { openTime: 6_000, closeTime: 10_999 },
    { openTime: 11_000, closeTime: 15_999 }
  ];
  const orders = [{
    id: "ladder",
    direction: "long",
    filledAt: 8_742,
    settledAt: 15_100,
    entryFillPrice: 100,
    exitFillPrice: 96.5,
    reason: "sl_reduce_only",
    quantity: 0.1,
    filledQuantity: 0.1,
    audit: {
      exitFills: [
        { time: 10_100, price: 98.5, quantity: 0.05, reason: "sl_reduce_only" },
        { time: 15_100, price: 96.5, quantity: 0.03, reason: "sl_reduce_only" }
      ]
    }
  }];

  assert.deepEqual(orderOverlayItems(orders, candles, null), [
    { id: "ladder-entry", time: 6, price: 100, direction: "long", kind: "entry", quantity: 0.1 },
    { id: "ladder-exit-10100-98.5", time: 6, price: 98.5, direction: "long", kind: "sl", quantity: 0.05 },
    { id: "ladder-exit-15100-96.5", time: 11, price: 96.5, direction: "long", kind: "sl", quantity: 0.03 }
  ]);
});

test("shared chart right scale width leaves room for both price axes", () => {
  assert.equal(CHART_RIGHT_SCALE_WIDTH >= 80, true);
});
