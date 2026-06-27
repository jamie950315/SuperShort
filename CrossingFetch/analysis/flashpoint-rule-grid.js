"use strict";

const { createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline");
const { once } = require("node:events");

const INTERVALS = {
  "1s": 1000,
  "5s": 5000,
  "15s": 15000,
  "30s": 30000,
  "1m": 60000
};

const DEFAULT_PERSIST_MS = [0, 250, 500, 1000, 2000];
const DEFAULT_TP = [0.5, 1, 1.5, 2, 3, 5];
const DEFAULT_SL = [null, 5, 10, 20, 50];
const DEFAULT_LONG_BELOW = [10, 20, 35, 40, 45, 50];
const DEFAULT_SHORT_ABOVE = [55, 60, 65, 70, 80, 90];
const DEFAULT_COMPOUND = [0];

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function parseNumberList(value, fallback) {
  if (!value) return fallback;
  return String(value).split(",").map((item) => Number(item.trim())).filter(Number.isFinite);
}

function parseSlList(value) {
  if (!value) return DEFAULT_SL;
  return String(value).split(",").map((item) => {
    const trimmed = item.trim().toLowerCase();
    if (trimmed === "none" || trimmed === "null" || trimmed === "no-sl") return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : undefined;
  }).filter((item) => item !== undefined);
}

function parseCompoundList(value) {
  if (!value) return DEFAULT_COMPOUND;
  return String(value).split(",").map((item) => {
    const number = Number(item.trim());
    if (!Number.isFinite(number)) return undefined;
    return number > 1 ? number / 100 : number;
  }).filter((item) => item !== undefined);
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function round(value, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function shouldTradeSignal(signal, thresholds) {
  if (!signal || !Number.isFinite(signal.c1)) return false;
  if (signal.direction === "long") return signal.c1 < thresholds.longBelow;
  if (signal.direction === "short") return signal.c1 > thresholds.shortAbove;
  return false;
}

class PersistentSignalGate {
  constructor(persistMs) {
    this.persistMs = persistMs;
    this.pending = null;
    this.fired = new Set();
  }

  reset() {
    this.pending = null;
    this.fired = new Set();
  }

  keyFor(signal) {
    if (!signal) return null;
    return `${signal.bucket}:${signal.direction}`;
  }

  update(signal, time) {
    if (!signal) {
      this.pending = null;
      return null;
    }

    const key = this.keyFor(signal);
    if (this.fired.has(key)) return null;

    if (!this.pending || this.pending.key !== key) {
      this.pending = { key, startTime: time, signal };
      if (this.persistMs === 0) {
        this.fired.add(key);
        this.pending = null;
        return signal;
      }
      return null;
    }

    this.pending.signal = signal;
    if (time - this.pending.startTime >= this.persistMs) {
      this.fired.add(key);
      this.pending = null;
      return signal;
    }
    return null;
  }
}

function parseAggTradeLine(line, target) {
  if (!line || line.startsWith("agg_trade_id,")) return null;
  const comma1 = line.indexOf(",");
  if (comma1 < 0) return null;
  const comma2 = line.indexOf(",", comma1 + 1);
  if (comma2 < 0) return null;
  const comma3 = line.indexOf(",", comma2 + 1);
  if (comma3 < 0) return null;
  const comma4 = line.indexOf(",", comma3 + 1);
  if (comma4 < 0) return null;
  const comma5 = line.indexOf(",", comma4 + 1);
  if (comma5 < 0) return null;
  const comma6 = line.indexOf(",", comma5 + 1);
  if (comma6 < 0) return null;
  const price = Number(line.slice(comma1 + 1, comma2));
  const quantity = Number(line.slice(comma2 + 1, comma3));
  const time = Number(line.slice(comma5 + 1, comma6));
  if (![price, quantity, time].every(Number.isFinite)) return null;
  if (target) {
    target.price = price;
    target.quantity = quantity;
    target.time = time;
    return target;
  }
  return { price, quantity, time };
}

function makeZipStreamProcess(file) {
  const reader = process.env.FLASHPOINT_ZIP_READER;
  if (reader !== "python" && spawnSync("sh", ["-lc", "command -v unzip >/dev/null 2>&1"]).status === 0) {
    return spawn("unzip", ["-p", file], { stdio: ["ignore", "pipe", "inherit"] });
  }

  const script = [
    "import sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1]) as z:",
    "    for name in z.namelist():",
    "        with z.open(name) as f:",
    "            while True:",
    "                chunk = f.read(1024 * 1024)",
    "                if not chunk:",
    "                    break",
    "                sys.stdout.buffer.write(chunk)"
  ].join("\n");
  return spawn("python3", ["-c", script, file], { stdio: ["ignore", "pipe", "inherit"] });
}

async function streamZipLines(file, onLine) {
  const zipStream = makeZipStreamProcess(file);
  const closePromise = once(zipStream, "close");
  const rl = readline.createInterface({ input: zipStream.stdout, crlfDelay: Infinity });
  for await (const line of rl) await onLine(line);
  const [code] = await closePromise;
  if (code !== 0) throw new Error(`zip stream failed for ${file}`);
}

async function streamRawTrades(rawDir, onTrade) {
  const files = readdirSync(rawDir)
    .filter((file) => file.endsWith(".zip"))
    .sort()
    .map((file) => join(rawDir, file));
  for (const file of files) {
    process.stderr.write(`stream ${basename(file)}\n`);
    const trade = { price: 0, quantity: 0, time: 0 };
    await streamZipLines(file, async (line) => {
      if (parseAggTradeLine(line, trade)) await onTrade(trade);
    });
  }
}

function makePartialBar(trade, intervalMs) {
  return {
    time: Math.floor(trade.time / intervalMs) * intervalMs,
    open: trade.price,
    high: trade.price,
    low: trade.price,
    close: trade.price,
    volume: trade.quantity,
    trades: 1
  };
}

function updatePartialBar(bar, trade) {
  bar.high = Math.max(bar.high, trade.price);
  bar.low = Math.min(bar.low, trade.price);
  bar.close = trade.price;
  bar.volume += trade.quantity;
  bar.trades += 1;
}

function makeEmptyBar(time, close) {
  return { time, open: close, high: close, low: close, close, volume: 0, trades: 0 };
}

function highestHigh(bars, length) {
  let value = -Infinity;
  const start = Math.max(0, bars.length - length);
  for (let index = start; index < bars.length; index += 1) value = Math.max(value, bars[index].high);
  return value;
}

function lowestLow(bars, length) {
  let value = Infinity;
  const start = Math.max(0, bars.length - length);
  for (let index = start; index < bars.length; index += 1) value = Math.min(value, bars[index].low);
  return value;
}

function computePartialFlashPoint(closedBars, currentBar, previousState) {
  if (!currentBar) return null;
  const window = [...closedBars.slice(-4), currentBar];
  const highest4 = highestHigh(window, 4);
  const lowest5 = lowestLow(window, 5);
  const source = (currentBar.high + currentBar.low + 2 * currentBar.close) / 4;
  const rsv = Math.abs(highest4 - lowest5) < 1e-12
    ? 0
    : 100 * (source - lowest5) / (highest4 - lowest5);
  const c1 = previousState?.c1 == null ? rsv : 0.4 * rsv + 0.6 * previousState.c1;
  const slowDBase = 0.667 * (previousState?.c1 ?? 0) + 0.333 * c1;
  const c2 = previousState?.c2 == null ? slowDBase : (2 / 3) * slowDBase + (1 / 3) * previousState.c2;
  let crossing = null;
  if (previousState?.c1 != null && previousState?.c2 != null) {
    const previousDiff = previousState.c1 - previousState.c2;
    const currentDiff = c1 - c2;
    if (previousDiff <= 0 && currentDiff > 0) crossing = "up";
    if (previousDiff >= 0 && currentDiff < 0) crossing = "down";
  }
  return { rsv, c1, c2, slowDBase, crossing };
}

class IntrabarSignalExtractor {
  constructor({ interval, intervalMs, persistValues }) {
    this.interval = interval;
    this.intervalMs = intervalMs;
    this.closedBars = [];
    this.closedStates = [];
    this.partial = null;
    this.bucket = null;
    this.lastClose = null;
    this.gates = new Map(persistValues.map((persistMs) => [persistMs, new PersistentSignalGate(persistMs)]));
    this.events = [];
    this.maxLongBelow = Infinity;
    this.minShortAbove = -Infinity;
  }

  finishTo(nextBucket) {
    if (this.partial) {
      const state = computePartialFlashPoint(this.closedBars, this.partial, this.closedStates.at(-1));
      this.closedBars.push(this.partial);
      this.closedStates.push(state ?? this.closedStates.at(-1) ?? null);
      this.lastClose = this.partial.close;
    }

    let missingBucket = (this.bucket ?? nextBucket) + this.intervalMs;
    while (this.lastClose !== null && missingBucket < nextBucket) {
      const empty = makeEmptyBar(missingBucket, this.lastClose);
      const state = computePartialFlashPoint(this.closedBars, empty, this.closedStates.at(-1));
      this.closedBars.push(empty);
      this.closedStates.push(state ?? this.closedStates.at(-1) ?? null);
      missingBucket += this.intervalMs;
    }

    this.partial = null;
    this.bucket = nextBucket;
    for (const gate of this.gates.values()) gate.reset();
  }

  processTrade(trade) {
    const nextBucket = Math.floor(trade.time / this.intervalMs) * this.intervalMs;
    if (this.bucket === null) {
      this.bucket = nextBucket;
      this.partial = makePartialBar(trade, this.intervalMs);
      return;
    }

    if (nextBucket !== this.bucket) this.finishTo(nextBucket);
    if (!this.partial) this.partial = makePartialBar(trade, this.intervalMs);
    else updatePartialBar(this.partial, trade);

    const state = computePartialFlashPoint(this.closedBars, this.partial, this.closedStates.at(-1));
    const signal = state?.crossing
      ? {
          interval: this.interval,
          time: trade.time,
          bucket: this.bucket,
          direction: state.crossing === "up" ? "long" : "short",
          entry: trade.price,
          c1: state.c1,
          c2: state.c2
        }
      : null;

    for (const [persistMs, gate] of this.gates.entries()) {
      const emitted = gate.update(signal, trade.time);
      if (emitted) {
        if (emitted.direction === "long" && emitted.c1 >= this.maxLongBelow) continue;
        if (emitted.direction === "short" && emitted.c1 <= this.minShortAbove) continue;
        this.events.push({
          ...emitted,
          persistMs,
          id: this.events.length
        });
      }
    }
  }
}

class Heap {
  constructor(compare) {
    this.items = [];
    this.compare = compare;
  }

  push(item) {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(items[parent], items[index]) <= 0) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }

  peek() {
    return this.items[0];
  }

  pop() {
    const items = this.items;
    if (!items.length) return null;
    const result = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && this.compare(items[smallest], items[left]) > 0) smallest = left;
        if (right < items.length && this.compare(items[smallest], items[right]) > 0) smallest = right;
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest], items[index]];
        index = smallest;
      }
    }
    return result;
  }
}

function createHitArrays(entries, tpValues, slValues) {
  for (const entry of entries) {
    entry.tpHitMs = Array(tpValues.length).fill(null);
    entry.slHitMs = Array(slValues.length).fill(null);
  }
}

function settleEntriesFromTrade(entries, trade, tpValues, slValues, cursorState) {
  const {
    longTp,
    shortTp,
    longSl,
    shortSl
  } = cursorState;

  while (cursorState.cursor < entries.length && entries[cursorState.cursor].time < trade.time) {
    const entry = entries[cursorState.cursor];
    for (let index = 0; index < tpValues.length; index += 1) {
      const tp = tpValues[index];
      if (entry.direction === "long") longTp[index].push({ price: entry.entry + tp, entry });
      else shortTp[index].push({ price: entry.entry - tp, entry });
    }
    for (let index = 0; index < slValues.length; index += 1) {
      const sl = slValues[index];
      if (sl === null) continue;
      if (entry.direction === "long") longSl[index].push({ price: entry.entry - sl, entry });
      else shortSl[index].push({ price: entry.entry + sl, entry });
    }
    cursorState.cursor += 1;
  }

  for (let index = 0; index < tpValues.length; index += 1) {
    while (longTp[index].peek() && trade.price >= longTp[index].peek().price) {
      const hit = longTp[index].pop();
      if (hit.entry.tpHitMs[index] === null) hit.entry.tpHitMs[index] = trade.time - hit.entry.time;
    }
    while (shortTp[index].peek() && trade.price <= shortTp[index].peek().price) {
      const hit = shortTp[index].pop();
      if (hit.entry.tpHitMs[index] === null) hit.entry.tpHitMs[index] = trade.time - hit.entry.time;
    }
  }

  for (let index = 0; index < slValues.length; index += 1) {
    if (slValues[index] === null) continue;
    while (longSl[index].peek() && trade.price <= longSl[index].peek().price) {
      const hit = longSl[index].pop();
      if (hit.entry.slHitMs[index] === null) hit.entry.slHitMs[index] = trade.time - hit.entry.time;
    }
    while (shortSl[index].peek() && trade.price >= shortSl[index].peek().price) {
      const hit = shortSl[index].pop();
      if (hit.entry.slHitMs[index] === null) hit.entry.slHitMs[index] = trade.time - hit.entry.time;
    }
  }
}

async function populateHitTimes(rawDir, entries, tpValues, slValues) {
  entries.sort((a, b) => a.time - b.time || a.id - b.id);
  createHitArrays(entries, tpValues, slValues);
  const cursorState = {
    cursor: 0,
    longTp: tpValues.map(() => new Heap((a, b) => a.price - b.price)),
    shortTp: tpValues.map(() => new Heap((a, b) => b.price - a.price)),
    longSl: slValues.map(() => new Heap((a, b) => b.price - a.price)),
    shortSl: slValues.map(() => new Heap((a, b) => a.price - b.price))
  };
  await streamRawTrades(rawDir, async (trade) => {
    settleEntriesFromTrade(entries, trade, tpValues, slValues, cursorState);
  });
}

function outcomeFor(entry, tpIndex, slIndex) {
  const tpMs = entry.tpHitMs[tpIndex];
  const slMs = entry.slHitMs[slIndex];
  if (tpMs !== null && (slMs === null || tpMs <= slMs)) return { outcome: "win", holdMs: tpMs };
  if (slMs !== null) return { outcome: "loss", holdMs: slMs };
  return { outcome: "open", holdMs: null };
}

function summarizeOpenTradeSettlements(results, economics = {}) {
  const entries = results.length;
  const wins = results.filter((item) => item.outcome === "win").length;
  const losses = results.filter((item) => item.outcome === "loss").length;
  const open = entries - wins - losses;
  const holds = results
    .filter((item) => item.outcome === "win" || item.outcome === "loss")
    .map((item) => item.holdMs / 1000)
    .sort((a, b) => a - b);
  const within = (seconds) => entries
    ? results.filter((item) => item.outcome === "win" && item.holdMs <= seconds * 1000).length / entries
    : null;
  const percentile = (p) => holds.length
    ? holds[Math.min(holds.length - 1, Math.floor((holds.length - 1) * p))]
    : null;
  const totalPnl = entries
    ? wins * (economics.tp ?? 0) - losses * (economics.sl ?? 0)
    : 0;
  return {
    entries,
    wins,
    losses,
    open,
    eventualWinRate: entries ? wins / entries : null,
    lossRate: entries ? losses / entries : null,
    within5s: within(5),
    within10s: within(10),
    within30s: within(30),
    within60s: within(60),
    within300s: within(300),
    medianHoldSeconds: percentile(0.5),
    p90HoldSeconds: percentile(0.9),
    p99HoldSeconds: percentile(0.99),
    maxHoldSeconds: holds.length ? holds[holds.length - 1] : null,
    totalPnl,
    expectancy: entries ? totalPnl / entries : null
  };
}

function settleOpenTrades(entries, trades, options) {
  return entries.map((entry) => {
    const tpPrice = entry.direction === "long" ? entry.entry + options.tp : entry.entry - options.tp;
    const slPrice = options.sl === null || options.sl === undefined
      ? null
      : entry.direction === "long" ? entry.entry - options.sl : entry.entry + options.sl;
    for (const trade of trades) {
      if (trade.time <= entry.time) continue;
      const hitTp = entry.direction === "long" ? trade.price >= tpPrice : trade.price <= tpPrice;
      const hitSl = slPrice === null ? false : entry.direction === "long" ? trade.price <= slPrice : trade.price >= slPrice;
      if (hitTp) return { ...entry, outcome: "win", holdMs: trade.time - entry.time };
      if (hitSl) return { ...entry, outcome: "loss", holdMs: trade.time - entry.time };
    }
    return { ...entry, outcome: "open", holdMs: null };
  });
}

function selectCandidateSettlements(candidates, tpIndex, slIndex, tp, sl, singleActive) {
  const results = [];
  const settlements = [];
  let activeUntil = -Infinity;
  for (const entry of candidates) {
    if (singleActive && entry.time < activeUntil) continue;
    const outcome = outcomeFor(entry, tpIndex, slIndex);
    results.push(outcome);
    settlements.push({
      entryTime: entry.time,
      exitTime: outcome.holdMs === null ? null : entry.time + outcome.holdMs,
      outcome: outcome.outcome,
      holdMs: outcome.holdMs,
      pricePnl: outcome.outcome === "win" ? tp : outcome.outcome === "loss" ? -(sl ?? 0) : 0
    });
    if (singleActive) activeUntil = outcome.holdMs === null ? Infinity : entry.time + outcome.holdMs;
  }
  return { results, settlements };
}

function summarizeLeveragedAccount(settlements, economics = {}) {
  const initialCapital = economics.initialCapital;
  const leverage = economics.leverage;
  const referencePrice = economics.referencePrice;
  const compoundRate = economics.compoundRate ?? 0;
  if (![initialCapital, leverage, referencePrice].every(Number.isFinite)) return {};

  let equity = initialCapital;
  let peakEquity = initialCapital;
  let minEquity = initialCapital;
  let maxDrawdownUsdc = 0;
  let bankrupt = false;
  let accountTrades = 0;
  let skippedAfterBankruptcy = 0;
  const closeHeap = new Heap((a, b) => a.exitTime - b.exitTime || a.sequence - b.sequence);
  let sequence = 0;

  const applyClose = (item) => {
    equity += item.pnl;
    if (equity > peakEquity) peakEquity = equity;
    if (equity < minEquity) minEquity = equity;
    maxDrawdownUsdc = Math.max(maxDrawdownUsdc, peakEquity - equity);
    if (equity <= 0) bankrupt = true;
  };

  for (const settlement of settlements) {
    while (closeHeap.peek() && closeHeap.peek().exitTime <= settlement.entryTime) applyClose(closeHeap.pop());
    if (bankrupt || equity <= 0) {
      bankrupt = true;
      skippedAfterBankruptcy += 1;
      continue;
    }
    accountTrades += 1;
    if (settlement.exitTime === null || settlement.outcome === "open") continue;

    const desiredMargin = initialCapital + compoundRate * (equity - initialCapital);
    const margin = Math.max(0, Math.min(equity, desiredMargin));
    const quantity = (margin * leverage) / referencePrice;
    closeHeap.push({
      exitTime: settlement.exitTime,
      pnl: quantity * settlement.pricePnl,
      sequence: sequence += 1
    });
  }

  while (closeHeap.peek()) applyClose(closeHeap.pop());

  const totalUsdcPnl = equity - initialCapital;
  return {
    initialCapital,
    leverage,
    referencePrice,
    compoundRate,
    accountTrades,
    skippedAfterBankruptcy,
    finalEquity: equity,
    totalUsdcPnl,
    roi: initialCapital ? totalUsdcPnl / initialCapital : null,
    minEquity,
    maxDrawdownUsdc,
    maxDrawdownPct: peakEquity ? maxDrawdownUsdc / peakEquity : null,
    bankrupt
  };
}

function summarizeCandidateSet(candidates, tpIndex, slIndex, tp, sl, singleActive, economics = {}) {
  const { results, settlements } = selectCandidateSettlements(candidates, tpIndex, slIndex, tp, sl, singleActive);
  return {
    ...summarizeOpenTradeSettlements(results, { tp, sl: sl ?? 0 }),
    ...summarizeLeveragedAccount(settlements, economics)
  };
}

function makeFastAccountState(economics, compoundRate) {
  return {
    initialCapital: economics.initialCapital,
    leverage: economics.leverage,
    referencePrice: economics.referencePrice,
    compoundRate,
    equity: economics.initialCapital,
    peakEquity: economics.initialCapital,
    minEquity: economics.initialCapital,
    maxDrawdownUsdc: 0,
    bankrupt: false,
    accountTrades: 0,
    skippedAfterBankruptcy: 0
  };
}

function updateFastAccountState(state, pricePnl) {
  if (![state.initialCapital, state.leverage, state.referencePrice].every(Number.isFinite)) return;
  if (state.bankrupt || state.equity <= 0) {
    state.bankrupt = true;
    state.skippedAfterBankruptcy += 1;
    return;
  }

  state.accountTrades += 1;
  if (!pricePnl) return;

  const desiredMargin = state.initialCapital + state.compoundRate * (state.equity - state.initialCapital);
  const margin = Math.max(0, Math.min(state.equity, desiredMargin));
  const quantity = (margin * state.leverage) / state.referencePrice;
  state.equity += quantity * pricePnl;
  if (state.equity > state.peakEquity) state.peakEquity = state.equity;
  if (state.equity < state.minEquity) state.minEquity = state.equity;
  state.maxDrawdownUsdc = Math.max(state.maxDrawdownUsdc, state.peakEquity - state.equity);
  if (state.equity <= 0) state.bankrupt = true;
}

function summarizeFastAccountState(state) {
  const totalUsdcPnl = state.equity - state.initialCapital;
  return {
    initialCapital: state.initialCapital,
    leverage: state.leverage,
    referencePrice: state.referencePrice,
    compoundRate: state.compoundRate,
    accountTrades: state.accountTrades,
    skippedAfterBankruptcy: state.skippedAfterBankruptcy,
    finalEquity: state.equity,
    totalUsdcPnl,
    roi: state.initialCapital ? totalUsdcPnl / state.initialCapital : null,
    minEquity: state.minEquity,
    maxDrawdownUsdc: state.maxDrawdownUsdc,
    maxDrawdownPct: state.peakEquity ? state.maxDrawdownUsdc / state.peakEquity : null,
    bankrupt: state.bankrupt
  };
}

function buildCandidateBaseSummary(candidates, tpIndex, slIndex, tp, sl, singleActive, fastAccountOptions = null) {
  let entries = 0;
  let wins = 0;
  let losses = 0;
  let open = 0;
  let within5s = 0;
  let within10s = 0;
  let within30s = 0;
  let within60s = 0;
  let within300s = 0;
  let activeUntil = -Infinity;
  let closedCount = 0;
  let maxHoldSeconds = null;
  const holdBuckets = new Map();
  const settlements = [];
  const fastAccounts = fastAccountOptions
    ? new Map(fastAccountOptions.compoundRates.map((compoundRate) => [
        compoundRate,
        makeFastAccountState(fastAccountOptions.economics, compoundRate)
      ]))
    : null;

  const addHold = (holdMs) => {
    const holdSeconds = holdMs / 1000;
    const bucket = Math.floor(holdSeconds);
    closedCount += 1;
    maxHoldSeconds = maxHoldSeconds === null ? holdSeconds : Math.max(maxHoldSeconds, holdSeconds);
    holdBuckets.set(bucket, (holdBuckets.get(bucket) ?? 0) + 1);
  };

  for (const entry of candidates) {
    if (singleActive && entry.time < activeUntil) continue;

    const outcome = outcomeFor(entry, tpIndex, slIndex);
    entries += 1;
    if (outcome.outcome === "win") {
      wins += 1;
      if (outcome.holdMs <= 5_000) within5s += 1;
      if (outcome.holdMs <= 10_000) within10s += 1;
      if (outcome.holdMs <= 30_000) within30s += 1;
      if (outcome.holdMs <= 60_000) within60s += 1;
      if (outcome.holdMs <= 300_000) within300s += 1;
      addHold(outcome.holdMs);
    } else if (outcome.outcome === "loss") {
      losses += 1;
      addHold(outcome.holdMs);
    } else {
      open += 1;
    }

    if (!fastAccounts) {
      settlements.push({
        entryTime: entry.time,
        exitTime: outcome.holdMs === null ? null : entry.time + outcome.holdMs,
        outcome: outcome.outcome,
        holdMs: outcome.holdMs,
        pricePnl: outcome.outcome === "win" ? tp : outcome.outcome === "loss" ? -(sl ?? 0) : 0
      });
    }

    if (fastAccounts) {
      const pricePnl = outcome.outcome === "win" ? tp : outcome.outcome === "loss" ? -(sl ?? 0) : 0;
      for (const state of fastAccounts.values()) updateFastAccountState(state, pricePnl);
    }

    if (singleActive) activeUntil = outcome.holdMs === null ? Infinity : entry.time + outcome.holdMs;
  }

  const sortedHoldBuckets = closedCount ? [...holdBuckets.keys()].sort((a, b) => a - b) : [];
  const percentile = (p) => {
    if (!closedCount) return null;
    const target = Math.min(closedCount - 1, Math.floor((closedCount - 1) * p));
    let seen = 0;
    for (const bucket of sortedHoldBuckets) {
      seen += holdBuckets.get(bucket);
      if (seen > target) return bucket;
    }
    return maxHoldSeconds;
  };
  const totalPnl = entries ? wins * tp - losses * (sl ?? 0) : 0;

  return {
    summary: {
      entries,
      wins,
      losses,
      open,
      eventualWinRate: entries ? wins / entries : null,
      lossRate: entries ? losses / entries : null,
      within5s: entries ? within5s / entries : null,
      within10s: entries ? within10s / entries : null,
      within30s: entries ? within30s / entries : null,
      within60s: entries ? within60s / entries : null,
      within300s: entries ? within300s / entries : null,
      medianHoldSeconds: percentile(0.5),
      p90HoldSeconds: percentile(0.9),
      p99HoldSeconds: percentile(0.99),
      maxHoldSeconds,
      totalPnl,
      expectancy: entries ? totalPnl / entries : null
    },
    settlements,
    fastAccounts: fastAccounts
      ? new Map([...fastAccounts.entries()].map(([compoundRate, state]) => [compoundRate, summarizeFastAccountState(state)]))
      : null
  };
}

function makeRollingSummaryState(tp, sl, singleActive, fastAccountOptions = null) {
  return {
    tp,
    sl,
    singleActive,
    activeUntil: -Infinity,
    entries: 0,
    wins: 0,
    losses: 0,
    open: 0,
    within5s: 0,
    within10s: 0,
    within30s: 0,
    within60s: 0,
    within300s: 0,
    closedCount: 0,
    maxHoldSeconds: null,
    holdBuckets: new Map(),
    fastAccounts: fastAccountOptions
      ? new Map(fastAccountOptions.compoundRates.map((compoundRate) => [
          compoundRate,
          makeFastAccountState(fastAccountOptions.economics, compoundRate)
        ]))
      : null
  };
}

function addRollingHold(state, holdMs) {
  const holdSeconds = holdMs / 1000;
  const bucket = Math.floor(holdSeconds);
  state.closedCount += 1;
  state.maxHoldSeconds = state.maxHoldSeconds === null ? holdSeconds : Math.max(state.maxHoldSeconds, holdSeconds);
  state.holdBuckets.set(bucket, (state.holdBuckets.get(bucket) ?? 0) + 1);
}

function recordRollingOutcome(state, entry, outcome) {
  if (state.singleActive && entry.time < state.activeUntil) return;

  state.entries += 1;
  if (outcome.outcome === "win") {
    state.wins += 1;
    if (outcome.holdMs <= 5_000) state.within5s += 1;
    if (outcome.holdMs <= 10_000) state.within10s += 1;
    if (outcome.holdMs <= 30_000) state.within30s += 1;
    if (outcome.holdMs <= 60_000) state.within60s += 1;
    if (outcome.holdMs <= 300_000) state.within300s += 1;
    addRollingHold(state, outcome.holdMs);
  } else if (outcome.outcome === "loss") {
    state.losses += 1;
    addRollingHold(state, outcome.holdMs);
  } else {
    state.open += 1;
  }

  if (state.fastAccounts) {
    const pricePnl = outcome.outcome === "win" ? state.tp : outcome.outcome === "loss" ? -(state.sl ?? 0) : 0;
    for (const account of state.fastAccounts.values()) updateFastAccountState(account, pricePnl);
  }

  if (state.singleActive) {
    state.activeUntil = outcome.holdMs === null ? Infinity : entry.time + outcome.holdMs;
  }
}

function finalizeRollingSummaryState(state) {
  const sortedHoldBuckets = state.closedCount ? [...state.holdBuckets.keys()].sort((a, b) => a - b) : [];
  const percentile = (p) => {
    if (!state.closedCount) return null;
    const target = Math.min(state.closedCount - 1, Math.floor((state.closedCount - 1) * p));
    let seen = 0;
    for (const bucket of sortedHoldBuckets) {
      seen += state.holdBuckets.get(bucket);
      if (seen > target) return bucket;
    }
    return state.maxHoldSeconds;
  };
  const totalPnl = state.entries ? state.wins * state.tp - state.losses * (state.sl ?? 0) : 0;
  return {
    summary: {
      entries: state.entries,
      wins: state.wins,
      losses: state.losses,
      open: state.open,
      eventualWinRate: state.entries ? state.wins / state.entries : null,
      lossRate: state.entries ? state.losses / state.entries : null,
      within5s: state.entries ? state.within5s / state.entries : null,
      within10s: state.entries ? state.within10s / state.entries : null,
      within30s: state.entries ? state.within30s / state.entries : null,
      within60s: state.entries ? state.within60s / state.entries : null,
      within300s: state.entries ? state.within300s / state.entries : null,
      medianHoldSeconds: percentile(0.5),
      p90HoldSeconds: percentile(0.9),
      p99HoldSeconds: percentile(0.99),
      maxHoldSeconds: state.maxHoldSeconds,
      totalPnl,
      expectancy: state.entries ? totalPnl / state.entries : null
    },
    fastAccounts: state.fastAccounts
      ? new Map([...state.fastAccounts.entries()].map(([compoundRate, account]) => [compoundRate, summarizeFastAccountState(account)]))
      : null
  };
}

function buildCandidateMultiSummaries(candidates, tpValues, slValues, modes, fastAccountOptions = null) {
  const pairCount = tpValues.length * slValues.length;
  const independent = modes.includes("independent")
    ? Array(pairCount)
    : null;
  const single = modes.includes("single")
    ? Array(pairCount)
    : null;

  for (let tpIndex = 0; tpIndex < tpValues.length; tpIndex += 1) {
    for (let slIndex = 0; slIndex < slValues.length; slIndex += 1) {
      const pairIndex = tpIndex * slValues.length + slIndex;
      if (independent) independent[pairIndex] = makeRollingSummaryState(tpValues[tpIndex], slValues[slIndex], false, fastAccountOptions);
      if (single) single[pairIndex] = makeRollingSummaryState(tpValues[tpIndex], slValues[slIndex], true, fastAccountOptions);
    }
  }

  for (const entry of candidates) {
    for (let tpIndex = 0; tpIndex < tpValues.length; tpIndex += 1) {
      const tpMs = entry.tpHitMs[tpIndex];
      for (let slIndex = 0; slIndex < slValues.length; slIndex += 1) {
        const slMs = entry.slHitMs[slIndex];
        let outcome;
        if (tpMs !== null && (slMs === null || tpMs <= slMs)) outcome = { outcome: "win", holdMs: tpMs };
        else if (slMs !== null) outcome = { outcome: "loss", holdMs: slMs };
        else outcome = { outcome: "open", holdMs: null };

        const pairIndex = tpIndex * slValues.length + slIndex;
        if (independent) recordRollingOutcome(independent[pairIndex], entry, outcome);
        if (single) recordRollingOutcome(single[pairIndex], entry, outcome);
      }
    }
  }

  return { independent, single };
}

function compactSummary(summary) {
  const out = { ...summary };
  for (const key of Object.keys(out)) {
    if (typeof out[key] === "number") out[key] = round(out[key], 6);
  }
  return out;
}

async function extractIntervalEvents(rawDir, interval, intervalMs, persistValues, thresholds = {}) {
  const extractor = new IntrabarSignalExtractor({ interval, intervalMs, persistValues });
  extractor.maxLongBelow = thresholds.maxLongBelow ?? Infinity;
  extractor.minShortAbove = thresholds.minShortAbove ?? -Infinity;
  await streamRawTrades(rawDir, async (trade) => extractor.processTrade(trade));
  return extractor.events;
}

async function runGrid(options) {
  const rawDir = options.rawDir;
  if (!rawDir || !existsSync(rawDir)) throw new Error("--raw-dir is required");

  const outDir = options.outDir ?? join(process.cwd(), "CrossingFetch/analysis/backtest-data/BTCUSDC");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `flashpoint-rule-grid-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const mdPath = jsonPath.replace(/\.json$/, ".md");

  const intervals = (options.intervals ?? Object.keys(INTERVALS).join(",")).split(",").map((item) => item.trim()).filter(Boolean);
  const persistValues = parseNumberList(options.persist, DEFAULT_PERSIST_MS);
  const tpValues = parseNumberList(options.tp, DEFAULT_TP);
  const slValues = parseSlList(options.sl);
  const longBelowValues = parseNumberList(options.longBelow, DEFAULT_LONG_BELOW);
  const shortAboveValues = parseNumberList(options.shortAbove, DEFAULT_SHORT_ABOVE);
  const modes = (options.modes ?? "independent,single").split(",").map((item) => item.trim()).filter(Boolean);
  const compoundRates = parseCompoundList(options.compound);
  const initialCapital = Number(options.capital ?? 0);
  const leverage = Number(options.leverage ?? 0);
  const referencePrice = Number(options.referencePrice ?? options["reference-price"] ?? 0);
  const accountMode = options.accountMode ?? options["account-mode"] ?? "exact";

  const output = {
    generatedAt: new Date().toISOString(),
    rule: "Realtime partial Flash Point Pro crossing; long only C1 < longBelow; short only C1 > shortAbove; signal must persist; TP/SL tested from trade ticks.",
    inputs: {
      rawDir,
      intervals,
      persistValues,
      tpValues,
      slValues,
      longBelowValues,
      shortAboveValues,
      modes,
      compoundRates,
      economics: {
        initialCapital,
        leverage,
        referencePrice
      },
      accountMode
    },
    results: []
  };

  const writeCheckpoint = () => {
    output.results.sort((a, b) => (
      (b.within30s ?? -1) - (a.within30s ?? -1)
      || (b.eventualWinRate ?? -1) - (a.eventualWinRate ?? -1)
      || (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity)
      || b.entries - a.entries
    ));
    writeFileSync(jsonPath, JSON.stringify(output, null, 2));
    writeFileSync(mdPath, renderMarkdown(output));
  };

  for (const interval of intervals) {
    const intervalMs = INTERVALS[interval];
    if (!intervalMs) throw new Error(`Unsupported interval: ${interval}`);
    process.stderr.write(`extract interval ${interval}\n`);
    const events = await extractIntervalEvents(rawDir, interval, intervalMs, persistValues, {
      maxLongBelow: Math.max(...longBelowValues),
      minShortAbove: Math.min(...shortAboveValues)
    });
    process.stderr.write(`settle ${events.length} events for ${interval}\n`);
    await populateHitTimes(rawDir, events, tpValues, slValues);

    for (const persistMs of persistValues) {
      process.stderr.write(`summarize ${interval} persist ${persistMs}ms\n`);
      const byPersist = events.filter((event) => event.persistMs === persistMs);
      process.stderr.write(`persist ${persistMs}ms candidates ${byPersist.length}\n`);
      for (const longBelow of longBelowValues) {
        for (const shortAbove of shortAboveValues) {
          const candidates = byPersist.filter((event) => shouldTradeSignal(event, { longBelow, shortAbove }));
          if (!candidates.length) continue;
          process.stderr.write(`threshold long<${longBelow} short>${shortAbove} candidates ${candidates.length}\n`);
          if (accountMode === "fast") {
            const bases = buildCandidateMultiSummaries(
              candidates,
              tpValues,
              slValues,
              modes,
              {
                economics: { initialCapital, leverage, referencePrice },
                compoundRates
              }
            );
            for (const mode of modes) {
              const states = mode === "single" ? bases.single : bases.independent;
              if (!states) continue;
              for (let tpIndex = 0; tpIndex < tpValues.length; tpIndex += 1) {
                for (let slIndex = 0; slIndex < slValues.length; slIndex += 1) {
                  const pairIndex = tpIndex * slValues.length + slIndex;
                  const base = finalizeRollingSummaryState(states[pairIndex]);
                  for (const compoundRate of compoundRates) {
                    output.results.push({
                      interval,
                      persistMs,
                      longBelow,
                      shortAbove,
                      tp: tpValues[tpIndex],
                      sl: slValues[slIndex],
                      mode,
                      compoundRate,
                      ...compactSummary({
                        ...base.summary,
                        ...base.fastAccounts.get(compoundRate)
                      })
                    });
                  }
                }
              }
            }
          } else {
            for (let tpIndex = 0; tpIndex < tpValues.length; tpIndex += 1) {
              for (let slIndex = 0; slIndex < slValues.length; slIndex += 1) {
                for (const mode of modes) {
                  const singleActive = mode === "single";
                  const base = buildCandidateBaseSummary(
                    candidates,
                    tpIndex,
                    slIndex,
                    tpValues[tpIndex],
                    slValues[slIndex],
                    singleActive
                  );
                  for (const compoundRate of compoundRates) {
                    const summary = compactSummary({
                      ...base.summary,
                      ...summarizeLeveragedAccount(base.settlements, {
                        initialCapital,
                        leverage,
                        referencePrice,
                        compoundRate
                      })
                    });
                    output.results.push({
                      interval,
                      persistMs,
                      longBelow,
                      shortAbove,
                      tp: tpValues[tpIndex],
                      sl: slValues[slIndex],
                      mode,
                      compoundRate,
                      ...summary
                    });
                  }
                }
              }
            }
          }
          process.stderr.write(`finished threshold long<${longBelow} short>${shortAbove}\n`);
        }
      }
      writeCheckpoint();
    }
    writeCheckpoint();
    if (typeof global.gc === "function") global.gc();
  }
  writeCheckpoint();
  return { jsonPath, mdPath, output };
}

function pct(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function value(value, digits = 3) {
  return value === null || value === undefined ? "n/a" : Number(value).toFixed(digits);
}

function renderMarkdown(output) {
  const lines = [];
  lines.push("# Flash Point Pro Rule Grid");
  lines.push("");
  lines.push(`Generated: ${output.generatedAt}`);
  lines.push("");
  lines.push("## Inputs");
  lines.push("");
  lines.push(`- Intervals: ${output.inputs.intervals.join(", ")}`);
  lines.push(`- Persist ms: ${output.inputs.persistValues.join(", ")}`);
  lines.push(`- TP: ${output.inputs.tpValues.join(", ")}`);
  lines.push(`- SL: ${output.inputs.slValues.map((item) => item === null ? "none" : item).join(", ")}`);
  lines.push(`- Long thresholds: ${output.inputs.longBelowValues.map((item) => `C1 < ${item}`).join(", ")}`);
  lines.push(`- Short thresholds: ${output.inputs.shortAboveValues.map((item) => `C1 > ${item}`).join(", ")}`);
  lines.push(`- Modes: ${output.inputs.modes.join(", ")}`);
  lines.push(`- Capital: ${output.inputs.economics.initialCapital} USDC`);
  lines.push(`- Leverage: ${output.inputs.economics.leverage}x`);
  lines.push(`- Reference BTC price: ${output.inputs.economics.referencePrice} USDC`);
  lines.push(`- Compound rates: ${output.inputs.compoundRates.map((item) => `${(item * 100).toFixed(0)}%`).join(", ")}`);
  lines.push("");
  lines.push("## Top Final Equity");
  lines.push("");
  lines.push("| Rank | Interval | Persist | Long | Short | TP | SL | Mode | Compound | Entries | Final equity | ROI | MDD | 30s | Eventual | Loss | P99 hold |");
  lines.push("|---:|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const equityRows = [...output.results].sort((a, b) => (
    (b.finalEquity ?? -Infinity) - (a.finalEquity ?? -Infinity)
    || (b.roi ?? -Infinity) - (a.roi ?? -Infinity)
    || (a.maxDrawdownPct ?? Infinity) - (b.maxDrawdownPct ?? Infinity)
  ));
  for (const [index, row] of equityRows.slice(0, 50).entries()) {
    lines.push(`| ${index + 1} | ${row.interval} | ${row.persistMs} | <${row.longBelow} | >${row.shortAbove} | ${row.tp} | ${row.sl === null ? "none" : row.sl} | ${row.mode} | ${(row.compoundRate * 100).toFixed(0)}% | ${row.entries} | ${value(row.finalEquity, 2)} | ${pct(row.roi)} | ${pct(row.maxDrawdownPct)} | ${pct(row.within30s)} | ${pct(row.eventualWinRate)} | ${pct(row.lossRate)} | ${value(row.p99HoldSeconds)}s |`);
  }
  lines.push("");
  lines.push("## Top 30s Settlement");
  lines.push("");
  lines.push("| Rank | Interval | Persist | Long | Short | TP | SL | Mode | Compound | Entries | 30s | Eventual | Loss | Final equity | ROI | P99 hold | Max hold |");
  lines.push("|---:|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const settlementRows = [...output.results].sort((a, b) => (
    (b.within30s ?? -1) - (a.within30s ?? -1)
    || (b.eventualWinRate ?? -1) - (a.eventualWinRate ?? -1)
    || (b.finalEquity ?? -Infinity) - (a.finalEquity ?? -Infinity)
    || b.entries - a.entries
  ));
  for (const [index, row] of settlementRows.slice(0, 50).entries()) {
    lines.push(`| ${index + 1} | ${row.interval} | ${row.persistMs} | <${row.longBelow} | >${row.shortAbove} | ${row.tp} | ${row.sl === null ? "none" : row.sl} | ${row.mode} | ${(row.compoundRate * 100).toFixed(0)}% | ${row.entries} | ${pct(row.within30s)} | ${pct(row.eventualWinRate)} | ${pct(row.lossRate)} | ${value(row.finalEquity, 2)} | ${pct(row.roi)} | ${value(row.p99HoldSeconds)}s | ${value(row.maxHoldSeconds)}s |`);
  }
  lines.push("");
  lines.push("## Top Expectancy");
  lines.push("");
  lines.push("| Rank | Interval | Persist | Long | Short | TP | SL | Mode | Compound | Entries | 30s | Eventual | Loss | Expectancy | Final equity | P99 hold |");
  lines.push("|---:|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  const expectancyRows = [...output.results].sort((a, b) => (
    (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity)
    || (b.within30s ?? -1) - (a.within30s ?? -1)
  ));
  for (const [index, row] of expectancyRows.slice(0, 50).entries()) {
    lines.push(`| ${index + 1} | ${row.interval} | ${row.persistMs} | <${row.longBelow} | >${row.shortAbove} | ${row.tp} | ${row.sl === null ? "none" : row.sl} | ${row.mode} | ${(row.compoundRate * 100).toFixed(0)}% | ${row.entries} | ${pct(row.within30s)} | ${pct(row.eventualWinRate)} | ${pct(row.lossRate)} | ${value(row.expectancy)} | ${value(row.finalEquity, 2)} | ${value(row.p99HoldSeconds)}s |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "help";
  if (command === "grid") {
    const { jsonPath, mdPath } = await runGrid({
      rawDir: args["raw-dir"],
      outDir: args.out,
      intervals: args.intervals,
      persist: args.persist,
      tp: args.tp,
      sl: args.sl,
      longBelow: args["long-below"],
      shortAbove: args["short-above"],
      modes: args.modes,
      compound: args.compound,
      capital: args.capital,
      leverage: args.leverage,
      referencePrice: args["reference-price"],
      accountMode: args["account-mode"]
    });
    console.log(JSON.stringify({ jsonPath, mdPath }, null, 2));
    return;
  }
  console.log("Usage:");
  console.log("  node CrossingFetch/analysis/flashpoint-rule-grid.js grid --raw-dir CrossingFetch/analysis/backtest-data/BTCUSDC/raw-aggTrades");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  INTERVALS,
  shouldTradeSignal,
  parseAggTradeLine,
  streamZipLines,
  PersistentSignalGate,
  settleOpenTrades,
  summarizeOpenTradeSettlements,
  summarizeCandidateSet,
  summarizeLeveragedAccount,
  computePartialFlashPoint,
  IntrabarSignalExtractor,
  extractIntervalEvents,
  populateHitTimes,
  runGrid
};
