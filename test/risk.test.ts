import assert from "node:assert/strict";
import test from "node:test";
import { PriceVelocityGuard } from "../src/server/risk.js";

test("price velocity guard blocks entries when price moves too fast", () => {
  const guard = new PriceVelocityGuard({ windowMs: 3000, maxUsdPerSec: 5 });

  assert.equal(guard.update(100, 1000).tooFast, false);
  assert.equal(guard.update(104, 2000).tooFast, false);

  const fast = guard.update(118, 4000);

  assert.equal(fast.tooFast, true);
  assert.equal(fast.velocityUsdPerSec >= 5, true);
});

test("price velocity guard allows entries after fast move leaves the window", () => {
  const guard = new PriceVelocityGuard({ windowMs: 3000, maxUsdPerSec: 5 });

  guard.update(100, 1000);
  guard.update(118, 4000);
  const calm = guard.update(119, 8000);

  assert.equal(calm.tooFast, false);
});
