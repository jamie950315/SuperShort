# Live TradingView Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first TradingView-facing Flash Point Pro live signal panel for BTCUSDC, ETHUSDC, and SOLUSDC with `WATCH / READY / ENTER / HOLD / TRIM / EXIT` states and short reason text.

**Architecture:** Add a focused `CrossingFetch/live-signal.js` module that owns symbol profiles, state evaluation, reason formatting, and active-side tracking. Load that module before `content.js`, then let `content.js` feed it the current market, Flash Point values, and C1/C2 crossing so the existing panel can show the live target and signal line. Keep validation/reporting out of this first implementation so the TradingView tool becomes usable quickly without changing recorder behavior.

**Tech Stack:** Plain JavaScript browser extension, Manifest V3 content scripts, Node `node:test`, existing CrossingFetch UMD-style modules.

---

## File Structure

- Create `CrossingFetch/live-signal.js`
  - UMD-style module exported as `module.exports` for tests and `window.CrossingFetchLiveSignal` for the extension.
  - Contains tuned symbol profiles, symbol normalization, signal state evaluation, reason formatting, and a small tracker for `HOLD / TRIM / EXIT`.
- Create `CrossingFetch/test/live-signal.test.js`
  - Unit tests for symbol detection, WATCH/READY/ENTER logic, active-side tracking, reason text, and unknown symbol behavior.
- Modify `CrossingFetch/manifest.json`
  - Load `live-signal.js` between `core.js` and `content.js`.
- Modify `CrossingFetch/content.js`
  - Initialize the live signal tracker.
  - Feed the tracker from `makeSample()` and `refreshFlashDisplay()`.
  - Render target and signal text inside the existing panel.
- Modify `CrossingFetch/content.css`
  - Add compact styles for target, signal state, side, and reasons.
- Modify `CrossingFetch/test/content.test.js`
  - Assert that content script references the live signal module and renders the signal container.
- Modify `CrossingFetch/test/core.test.js` only if existing helper coverage exposes a symbol parsing issue. Otherwise leave it untouched.

## State Model

The first version uses current C1/C2 and crossing only. MACD, RSI, divergence, and gap slope reason strings are reserved for the later validator once those feature streams are connected.

Profiles:

```js
const PROFILES = {
  BTCUSDC: {
    label: "BTC",
    mainTimeframe: "5m",
    earlyTimeframes: ["2m", "15m"],
    long: { watchC1: 45, readyC1: 35, enterC1: 40, readyScore: 3, enterScore: 4 },
    short: { watchC1: 55, readyC1: 65, enterC1: 60, readyScore: 3, enterScore: 4 }
  },
  ETHUSDC: {
    label: "ETH",
    mainTimeframe: "10m",
    earlyTimeframes: ["2m"],
    long: { watchC1: 45, readyC1: 35, enterC1: 40, readyScore: 3, enterScore: 4 },
    short: { watchC1: 55, readyC1: 65, enterC1: 60, readyScore: 3, enterScore: 4 }
  },
  SOLUSDC: {
    label: "SOL",
    mainTimeframe: "10m",
    earlyTimeframes: ["3m"],
    long: { watchC1: 50, readyC1: 45, enterC1: 45, readyScore: 3, enterScore: 4 },
    short: { watchC1: 55, readyC1: 65, enterC1: 60, readyScore: 3, enterScore: 4 }
  }
};
```

Score rules:

```js
function bullScore(input, profile) {
  let score = 0;
  if (input.c1 <= profile.long.watchC1) score += 1;
  if (input.c1 <= profile.long.readyC1) score += 1;
  if (input.c1 > input.c2) score += 1;
  if (input.crossing === "up") score += 2;
  return score;
}

function bearScore(input, profile) {
  let score = 0;
  if (input.c1 >= profile.short.watchC1) score += 1;
  if (input.c1 >= profile.short.readyC1) score += 1;
  if (input.c1 < input.c2) score += 1;
  if (input.crossing === "down") score += 2;
  return score;
}
```

State rules:

- Without active position:
  - LONG `ENTER`: crossing up, C1 below `enterC1`, bull score >= `enterScore`
  - SHORT `ENTER`: crossing down, C1 above `enterC1`, bear score >= `enterScore`
  - `READY`: score >= `readyScore`
  - `WATCH`: C1 near reversal zone
- With active LONG:
  - `EXIT`: crossing down and bear score >= 4
  - `TRIM`: bear score >= 3 or C1 < C2
  - `HOLD`: otherwise, while no strong opposite pressure
- With active SHORT:
  - `EXIT`: crossing up and bull score >= 4
  - `TRIM`: bull score >= 3 or C1 > C2
  - `HOLD`: otherwise, while no strong opposite pressure

## Task 1: Live Signal Module Tests

**Files:**
- Create: `CrossingFetch/test/live-signal.test.js`
- Create later: `CrossingFetch/live-signal.js`

- [ ] **Step 1: Write failing tests for symbol profiles and basic states**

Create `CrossingFetch/test/live-signal.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const LiveSignal = require("../live-signal.js");

test("normalizes supported TradingView symbols to tuned profiles", () => {
  assert.equal(LiveSignal.normalizeSymbol("BINANCE:BTCUSDC.P"), "BTCUSDC");
  assert.equal(LiveSignal.normalizeSymbol("ETHUSDC"), "ETHUSDC");
  assert.equal(LiveSignal.normalizeSymbol("BINANCE:SOLUSDC"), "SOLUSDC");
  assert.equal(LiveSignal.normalizeSymbol("DOGEUSDC"), "DOGEUSDC");
});

test("returns a clear unsupported target warning", () => {
  const signal = LiveSignal.evaluateLiveSignal({
    market: { symbol: "DOGEUSDC", timeframe: "5m" },
    flash: { c1: 20, c2: 30, readable: true },
    crossing: "up"
  });

  assert.equal(signal.supported, false);
  assert.equal(signal.symbol, "DOGEUSDC");
  assert.equal(signal.state, "UNSUPPORTED");
  assert.equal(signal.text, "DOGEUSDC unsupported: no tuned profile");
});

test("creates a BTC long ready signal with reasons", () => {
  const signal = LiveSignal.evaluateLiveSignal({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { c1: 32, c2: 36, readable: true },
    crossing: "none"
  });

  assert.equal(signal.supported, true);
  assert.equal(signal.symbol, "BTCUSDC");
  assert.equal(signal.side, "LONG");
  assert.equal(signal.state, "READY");
  assert.match(signal.text, /^BTC LONG READY:/);
  assert.ok(signal.reasons.includes("C1 low"));
  assert.ok(signal.reasons.includes("bull score 3"));
});

test("creates a SOL short enter signal on high C1 cross down", () => {
  const signal = LiveSignal.evaluateLiveSignal({
    market: { symbol: "SOLUSDC", timeframe: "10m" },
    flash: { c1: 82, c2: 86, readable: true },
    crossing: "down"
  });

  assert.equal(signal.side, "SHORT");
  assert.equal(signal.state, "ENTER");
  assert.match(signal.text, /^SOL SHORT ENTER:/);
  assert.ok(signal.reasons.includes("cross down"));
  assert.ok(signal.reasons.includes("bear score 5"));
});

test("returns WAIT when Flash Point values are unreadable", () => {
  const signal = LiveSignal.evaluateLiveSignal({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { readable: false },
    crossing: "none"
  });

  assert.equal(signal.state, "WAIT");
  assert.equal(signal.text, "BTC WAIT: Flash Point values not readable");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test CrossingFetch/test/live-signal.test.js
```

Expected: fail with `Cannot find module '../live-signal.js'`.

## Task 2: Live Signal Module Implementation

**Files:**
- Create: `CrossingFetch/live-signal.js`
- Test: `CrossingFetch/test/live-signal.test.js`

- [ ] **Step 1: Implement the module**

Create `CrossingFetch/live-signal.js`:

```js
(function attachLiveSignal(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CrossingFetchLiveSignal = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createLiveSignalApi() {
  const PROFILES = {
    BTCUSDC: {
      label: "BTC",
      mainTimeframe: "5m",
      earlyTimeframes: ["2m", "15m"],
      long: { watchC1: 45, readyC1: 35, enterC1: 40, readyScore: 3, enterScore: 4 },
      short: { watchC1: 55, readyC1: 65, enterC1: 60, readyScore: 3, enterScore: 4 }
    },
    ETHUSDC: {
      label: "ETH",
      mainTimeframe: "10m",
      earlyTimeframes: ["2m"],
      long: { watchC1: 45, readyC1: 35, enterC1: 40, readyScore: 3, enterScore: 4 },
      short: { watchC1: 55, readyC1: 65, enterC1: 60, readyScore: 3, enterScore: 4 }
    },
    SOLUSDC: {
      label: "SOL",
      mainTimeframe: "10m",
      earlyTimeframes: ["3m"],
      long: { watchC1: 50, readyC1: 45, enterC1: 45, readyScore: 3, enterScore: 4 },
      short: { watchC1: 55, readyC1: 65, enterC1: 60, readyScore: 3, enterScore: 4 }
    }
  };

  function normalizeSymbol(symbol) {
    const raw = String(symbol || "").toUpperCase();
    const compact = raw
      .replace(/^.*:/, "")
      .replace(/[^A-Z0-9]/g, "");
    const match = compact.match(/(BTCUSDC|ETHUSDC|SOLUSDC)/);
    return match ? match[1] : compact || "UNKNOWN";
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function getProfile(symbol) {
    return PROFILES[normalizeSymbol(symbol)] || null;
  }

  function makeBaseSignal(symbol, profile, state, side, reasons) {
    const label = profile?.label || symbol;
    const normalizedReasons = reasons.filter(Boolean).slice(0, 4);
    const text = side
      ? `${label} ${side} ${state}: ${normalizedReasons.join(" + ")}`
      : `${label} ${state}: ${normalizedReasons.join(" + ")}`;
    return {
      supported: Boolean(profile),
      symbol,
      label,
      state,
      side,
      reasons: normalizedReasons,
      text
    };
  }

  function bullScore(input, profile) {
    let score = 0;
    if (input.c1 <= profile.long.watchC1) score += 1;
    if (input.c1 <= profile.long.readyC1) score += 1;
    if (input.c1 > input.c2) score += 1;
    if (input.crossing === "up") score += 2;
    return score;
  }

  function bearScore(input, profile) {
    let score = 0;
    if (input.c1 >= profile.short.watchC1) score += 1;
    if (input.c1 >= profile.short.readyC1) score += 1;
    if (input.c1 < input.c2) score += 1;
    if (input.crossing === "down") score += 2;
    return score;
  }

  function longReasons(input, score) {
    const reasons = [];
    if (input.crossing === "up") reasons.push("cross up");
    if (input.c1 <= input.profile.long.readyC1) reasons.push("C1 low");
    else if (input.c1 <= input.profile.long.watchC1) reasons.push("C1 near low");
    if (input.c1 > input.c2) reasons.push("C1 above C2");
    reasons.push(`bull score ${score}`);
    return reasons;
  }

  function shortReasons(input, score) {
    const reasons = [];
    if (input.crossing === "down") reasons.push("cross down");
    if (input.c1 >= input.profile.short.readyC1) reasons.push("C1 high");
    else if (input.c1 >= input.profile.short.watchC1) reasons.push("C1 near high");
    if (input.c1 < input.c2) reasons.push("C1 below C2");
    reasons.push(`bear score ${score}`);
    return reasons;
  }

  function evaluateNoPosition(input) {
    const bull = bullScore(input, input.profile);
    const bear = bearScore(input, input.profile);
    const longReady = input.c1 <= input.profile.long.readyC1 && bull >= input.profile.long.readyScore;
    const shortReady = input.c1 >= input.profile.short.readyC1 && bear >= input.profile.short.readyScore;
    const longWatch = input.c1 <= input.profile.long.watchC1;
    const shortWatch = input.c1 >= input.profile.short.watchC1;

    if (input.crossing === "up" && input.c1 <= input.profile.long.enterC1 && bull >= input.profile.long.enterScore) {
      return makeBaseSignal(input.symbol, input.profile, "ENTER", "LONG", longReasons(input, bull));
    }
    if (input.crossing === "down" && input.c1 >= input.profile.short.enterC1 && bear >= input.profile.short.enterScore) {
      return makeBaseSignal(input.symbol, input.profile, "ENTER", "SHORT", shortReasons(input, bear));
    }
    if (longReady && (!shortReady || bull >= bear)) {
      return makeBaseSignal(input.symbol, input.profile, "READY", "LONG", longReasons(input, bull));
    }
    if (shortReady) {
      return makeBaseSignal(input.symbol, input.profile, "READY", "SHORT", shortReasons(input, bear));
    }
    if (longWatch && (!shortWatch || bull >= bear)) {
      return makeBaseSignal(input.symbol, input.profile, "WATCH", "LONG", longReasons(input, bull));
    }
    if (shortWatch) {
      return makeBaseSignal(input.symbol, input.profile, "WATCH", "SHORT", shortReasons(input, bear));
    }
    return makeBaseSignal(input.symbol, input.profile, "WAIT", null, ["no reversal setup"]);
  }

  function evaluateWithPosition(input, activeSide) {
    const bull = bullScore(input, input.profile);
    const bear = bearScore(input, input.profile);
    if (activeSide === "LONG") {
      if (input.crossing === "down" && bear >= 4) {
        return makeBaseSignal(input.symbol, input.profile, "EXIT", "LONG", shortReasons(input, bear));
      }
      if (bear >= 3 || input.c1 < input.c2) {
        return makeBaseSignal(input.symbol, input.profile, "TRIM", "LONG", shortReasons(input, bear));
      }
      return makeBaseSignal(input.symbol, input.profile, "HOLD", "LONG", ["trend ok", "no bear pressure", `bull score ${bull}`]);
    }
    if (input.crossing === "up" && bull >= 4) {
      return makeBaseSignal(input.symbol, input.profile, "EXIT", "SHORT", longReasons(input, bull));
    }
    if (bull >= 3 || input.c1 > input.c2) {
      return makeBaseSignal(input.symbol, input.profile, "TRIM", "SHORT", longReasons(input, bull));
    }
    return makeBaseSignal(input.symbol, input.profile, "HOLD", "SHORT", ["trend ok", "no bull pressure", `bear score ${bear}`]);
  }

  function normalizeInput(options) {
    const symbol = normalizeSymbol(options?.market?.symbol || options?.symbol);
    const profile = getProfile(symbol);
    const flash = options?.flash || {};
    return {
      symbol,
      profile,
      timeframe: String(options?.market?.timeframe || options?.timeframe || "unknown"),
      c1: toNumber(flash.c1),
      c2: toNumber(flash.c2),
      crossing: options?.crossing === "up" || options?.crossing === "down" ? options.crossing : "none",
      readable: flash.readable !== false
    };
  }

  function evaluateLiveSignal(options) {
    const input = normalizeInput(options);
    if (!input.profile) {
      return {
        supported: false,
        symbol: input.symbol,
        label: input.symbol,
        state: "UNSUPPORTED",
        side: null,
        reasons: ["no tuned profile"],
        text: `${input.symbol} unsupported: no tuned profile`
      };
    }
    if (!input.readable || input.c1 === null || input.c2 === null) {
      return makeBaseSignal(input.symbol, input.profile, "WAIT", null, ["Flash Point values not readable"]);
    }
    return options?.activeSide
      ? evaluateWithPosition(input, options.activeSide)
      : evaluateNoPosition(input);
  }

  function createLiveSignalTracker() {
    let activeSide = null;
    return {
      getActiveSide() {
        return activeSide;
      },
      reset() {
        activeSide = null;
      },
      update(options) {
        const signal = evaluateLiveSignal({ ...options, activeSide });
        if (signal.state === "ENTER") activeSide = signal.side;
        if (signal.state === "EXIT") activeSide = null;
        return { ...signal, activeSide };
      }
    };
  }

  return {
    PROFILES,
    normalizeSymbol,
    getProfile,
    evaluateLiveSignal,
    createLiveSignalTracker
  };
});
```

- [ ] **Step 2: Run live signal tests**

Run:

```bash
node --test CrossingFetch/test/live-signal.test.js
```

Expected: pass all tests in `live-signal.test.js`.

- [ ] **Step 3: Commit module and tests**

Run:

```bash
git add CrossingFetch/live-signal.js CrossingFetch/test/live-signal.test.js
git commit -m "Add TradingView live signal evaluator"
```

Expected: commit succeeds.

## Task 3: Active-Side Tracker Tests

**Files:**
- Modify: `CrossingFetch/test/live-signal.test.js`
- Modify if needed: `CrossingFetch/live-signal.js`

- [ ] **Step 1: Add tracker tests**

Append to `CrossingFetch/test/live-signal.test.js`:

```js
test("tracker turns enter into hold, trim, and exit decisions", () => {
  const tracker = LiveSignal.createLiveSignalTracker();

  const enter = tracker.update({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { c1: 28, c2: 26, readable: true },
    crossing: "up"
  });
  assert.equal(enter.state, "ENTER");
  assert.equal(enter.side, "LONG");
  assert.equal(tracker.getActiveSide(), "LONG");

  const hold = tracker.update({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { c1: 52, c2: 44, readable: true },
    crossing: "none"
  });
  assert.equal(hold.state, "HOLD");
  assert.equal(hold.side, "LONG");

  const trim = tracker.update({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { c1: 64, c2: 66, readable: true },
    crossing: "none"
  });
  assert.equal(trim.state, "TRIM");
  assert.equal(trim.side, "LONG");

  const exit = tracker.update({
    market: { symbol: "BTCUSDC", timeframe: "5m" },
    flash: { c1: 75, c2: 80, readable: true },
    crossing: "down"
  });
  assert.equal(exit.state, "EXIT");
  assert.equal(exit.side, "LONG");
  assert.equal(tracker.getActiveSide(), null);
});

test("tracker can be reset manually", () => {
  const tracker = LiveSignal.createLiveSignalTracker();
  tracker.update({
    market: { symbol: "SOLUSDC", timeframe: "10m" },
    flash: { c1: 82, c2: 86, readable: true },
    crossing: "down"
  });
  assert.equal(tracker.getActiveSide(), "SHORT");

  tracker.reset();
  assert.equal(tracker.getActiveSide(), null);
});
```

- [ ] **Step 2: Run tests**

Run:

```bash
node --test CrossingFetch/test/live-signal.test.js
```

Expected: pass. If the first implementation returns `TRIM` instead of `EXIT` for the final row, adjust `evaluateWithPosition()` so crossing-based exit is checked before trim.

- [ ] **Step 3: Commit tracker behavior**

Run:

```bash
git add CrossingFetch/live-signal.js CrossingFetch/test/live-signal.test.js
git commit -m "Track live signal position state"
```

Expected: commit succeeds.

## Task 4: Load Module In Extension

**Files:**
- Modify: `CrossingFetch/manifest.json`
- Modify: `CrossingFetch/test/content.test.js`

- [ ] **Step 1: Add failing manifest test**

Append to `CrossingFetch/test/content.test.js`:

```js
test("manifest loads live signal module before content script", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const contentEntry = manifest.content_scripts.find((entry) => {
    return Array.isArray(entry.js) && entry.js.includes("content.js");
  });

  assert.ok(contentEntry, "content.js entry must exist");
  const liveSignalIndex = contentEntry.js.indexOf("live-signal.js");
  const contentIndex = contentEntry.js.indexOf("content.js");
  assert.ok(liveSignalIndex !== -1, "live-signal.js must be loaded");
  assert.ok(liveSignalIndex < contentIndex, "live-signal.js must load before content.js");
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
node --test CrossingFetch/test/content.test.js
```

Expected: fail with `live-signal.js must be loaded`.

- [ ] **Step 3: Update manifest**

Change the second content script `js` list in `CrossingFetch/manifest.json` to:

```json
"js": [
  "core.js",
  "live-signal.js",
  "content.js"
]
```

- [ ] **Step 4: Run content tests**

Run:

```bash
node --test CrossingFetch/test/content.test.js
```

Expected: pass.

- [ ] **Step 5: Commit manifest loading**

Run:

```bash
git add CrossingFetch/manifest.json CrossingFetch/test/content.test.js
git commit -m "Load live signal module in CrossingFetch"
```

Expected: commit succeeds.

## Task 5: Render Live Signal In Panel

**Files:**
- Modify: `CrossingFetch/content.js`
- Modify: `CrossingFetch/content.css`
- Modify: `CrossingFetch/test/content.test.js`

- [ ] **Step 1: Add failing content string test**

Append to `CrossingFetch/test/content.test.js`:

```js
test("content script renders live TradingView signal status", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /const LiveSignal = window\.CrossingFetchLiveSignal/);
  assert.match(content, /liveSignalTracker = LiveSignal\.createLiveSignalTracker\(\)/);
  assert.match(content, /id="cf-live-signal"/);
  assert.match(content, /renderLiveSignalStatus/);
});
```

- [ ] **Step 2: Run failing content test**

Run:

```bash
node --test CrossingFetch/test/content.test.js
```

Expected: fail because `content.js` does not reference `CrossingFetchLiveSignal` yet.

- [ ] **Step 3: Wire live signal tracker in `content.js`**

Near the top of `CrossingFetch/content.js`, after `const Core = window.CrossingFetchCore;`, add:

```js
  const LiveSignal = window.CrossingFetchLiveSignal;
```

Near the existing state variables, add:

```js
  let liveSignalTracker = LiveSignal?.createLiveSignalTracker?.() || null;
  let latestLiveSignal = null;
```

Inside `createPanel()` status markup, insert this before `<div class="cf-status" id="cf-status">Ready.</div>`:

```html
      <div class="cf-live-signal" id="cf-live-signal">Live signal: waiting for Flash Point.</div>
```

In `makeSample(mode, reason)`, after:

```js
    const crossing = Core.detectCrossing(previousFlash, flash);
```

add:

```js
    latestLiveSignal = updateLiveSignal({ market: guessMarket(), flash, crossing });
```

In `saveSocketAlignedSample(socketSnapshot)`, after:

```js
    const crossing = Core.detectCrossing(previousInstantFlash, flash);
```

add:

```js
    latestLiveSignal = updateLiveSignal({ market: guessMarket(), flash, crossing });
```

In `refreshFlashDisplay()`, after `latestFlash = next;`, add:

```js
    latestLiveSignal = updateLiveSignal({ market: guessMarket(), flash: next, crossing: "none" });
```

Add these functions before `updateStatus(extra)`:

```js
  function updateLiveSignal(input) {
    if (!liveSignalTracker) return null;
    return liveSignalTracker.update(input);
  }

  function renderLiveSignalStatus() {
    const container = document.querySelector("#cf-live-signal");
    if (!container) return;
    if (!latestLiveSignal) {
      container.textContent = "Live signal: waiting for Flash Point.";
      return;
    }
    const stateClass = String(latestLiveSignal.state || "WAIT").toLowerCase();
    container.className = `cf-live-signal cf-live-signal-${stateClass}`;
    const target = latestLiveSignal.supported
      ? `Target: ${latestLiveSignal.symbol} profile active`
      : `Target: ${latestLiveSignal.symbol} unsupported`;
    container.innerHTML = [
      `<div class="cf-live-target">${escapeHtml(target)}</div>`,
      `<div class="cf-live-text">${escapeHtml(latestLiveSignal.text)}</div>`
    ].join("");
  }
```

At the start of `updateStatus(extra)`, after the `if (!status) return;` guard, add:

```js
    renderLiveSignalStatus();
```

In `clearCurrentSession()` and `clearAllSamples()`, after `resetSessionDedupeState();`, add:

```js
      liveSignalTracker?.reset?.();
      latestLiveSignal = null;
```

- [ ] **Step 4: Add styles**

Append to `CrossingFetch/content.css`:

```css
.cf-live-signal {
  margin-top: 10px;
  padding: 8px;
  border: 1px solid #2f3847;
  border-radius: 6px;
  background: #111722;
  color: #d8dee8;
  line-height: 1.35;
}

.cf-live-target {
  margin-bottom: 4px;
  color: #8f9bab;
  font-size: 11px;
}

.cf-live-text {
  font-weight: 700;
}

.cf-live-signal-watch,
.cf-live-signal-ready {
  border-color: rgba(240, 185, 11, 0.65);
}

.cf-live-signal-enter,
.cf-live-signal-hold {
  border-color: rgba(46, 204, 113, 0.7);
}

.cf-live-signal-trim {
  border-color: rgba(245, 166, 35, 0.75);
}

.cf-live-signal-exit,
.cf-live-signal-unsupported {
  border-color: rgba(255, 92, 92, 0.75);
}
```

- [ ] **Step 5: Run content tests**

Run:

```bash
node --test CrossingFetch/test/content.test.js
```

Expected: pass.

- [ ] **Step 6: Commit panel rendering**

Run:

```bash
git add CrossingFetch/content.js CrossingFetch/content.css CrossingFetch/test/content.test.js
git commit -m "Show live TradingView signal in panel"
```

Expected: commit succeeds.

## Task 6: Full Verification

**Files:**
- All changed CrossingFetch files.

- [ ] **Step 1: Run CrossingFetch tests**

Run:

```bash
node --test CrossingFetch/test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 2: Run syntax checks**

Run:

```bash
node --check CrossingFetch/live-signal.js
node --check CrossingFetch/content.js
node --check CrossingFetch/core.js
node --check CrossingFetch/injected.js
node --check CrossingFetch/flashpoint-algo.js
node --check CrossingFetch/analysis/flash-point-model.js
node --check CrossingFetch/analysis/fit-exact-flash-point.js
node --check CrossingFetch/analysis/flashpoint-indicator-grid.js
node --check CrossingFetch/analysis/flashpoint-kline-indicator-grid.js
node --check CrossingFetch/analysis/flashpoint-rule-grid.js
```

Expected: every command exits with code 0 and prints no syntax error.

- [ ] **Step 3: Inspect changed files**

Run:

```bash
git diff --stat
git diff -- CrossingFetch/live-signal.js CrossingFetch/content.js CrossingFetch/content.css CrossingFetch/manifest.json CrossingFetch/test/live-signal.test.js CrossingFetch/test/content.test.js
```

Expected: diff only contains the live signal module, tests, manifest load order, and panel rendering.

- [ ] **Step 4: Manual TradingView smoke check**

Load the unpacked `CrossingFetch` extension in Chrome or the target browser, open a TradingView chart for each symbol, and confirm:

```text
BTCUSDC chart: panel shows Target: BTCUSDC profile active
ETHUSDC chart: panel shows Target: ETHUSDC profile active
SOLUSDC chart: panel shows Target: SOLUSDC profile active
Unsupported chart: panel shows unsupported profile warning
```

Expected: the panel updates without console errors and shows a state line such as `BTC LONG READY: C1 low + bull score 3`.

- [ ] **Step 5: Final commit if any verification fixes were needed**

Run only if Task 6 changed files:

```bash
git add CrossingFetch/live-signal.js CrossingFetch/content.js CrossingFetch/content.css CrossingFetch/manifest.json CrossingFetch/test/live-signal.test.js CrossingFetch/test/content.test.js
git commit -m "Verify TradingView live signal panel"
```

Expected: commit succeeds, or no commit is needed because verification required no changes.

## Self-Review

- Spec coverage:
  - TradingView-facing states are covered by `live-signal.js` and panel rendering.
  - Reason text is covered by `makeBaseSignal()` and tests.
  - BTCUSDC, ETHUSDC, and SOLUSDC profiles are covered by `PROFILES`.
  - Unsupported symbols are covered by tests and panel text.
  - Real order execution and paper trading remain out of scope.
- Placeholder scan:
  - The plan contains no unresolved markers or open-ended implementation steps.
- Type consistency:
  - The module consistently exposes `normalizeSymbol`, `getProfile`, `evaluateLiveSignal`, and `createLiveSignalTracker`.
  - Signal objects consistently use `supported`, `symbol`, `label`, `state`, `side`, `reasons`, and `text`.
