import assert from "node:assert/strict";
import test from "node:test";
import { PersistentSignalGate } from "../src/server/signalGate.js";
import type { SignalEvent } from "../src/shared/types.js";

function signal(time: number, bucket = 1000): SignalEvent {
  return {
    symbol: "BTCUSDC",
    interval: "5s",
    time,
    bucket,
    direction: "long",
    price: 100,
    c1: 35,
    c2: 34,
    configVersion: 1
  };
}

test("persistent signal gate waits until signal survives the configured duration", () => {
  const gate = new PersistentSignalGate(500);

  assert.equal(gate.update(signal(1000), 1000), null);
  assert.equal(gate.update(signal(1250), 1250), null);

  const emitted = gate.update(signal(1500), 1500);
  assert.ok(emitted);
  assert.equal(emitted.time, 1500);
});

test("persistent signal gate resets when signal disappears before duration", () => {
  const gate = new PersistentSignalGate(500);

  assert.equal(gate.update(signal(1000), 1000), null);
  assert.equal(gate.update(null, 1200), null);
  assert.equal(gate.update(signal(1300), 1300), null);
  assert.equal(gate.update(signal(1600), 1600), null);

  assert.ok(gate.update(signal(1800), 1800));
});

test("persistent signal gate emits once per candle bucket", () => {
  const gate = new PersistentSignalGate(0);

  assert.ok(gate.update(signal(1000), 1000));
  assert.equal(gate.update(signal(1001), 1001), null);
  assert.ok(gate.update(signal(5000, 5000), 5000));
});
