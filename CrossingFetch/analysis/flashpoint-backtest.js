"use strict";

const { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createGunzip, createGzip } = require("node:zlib");
const readline = require("node:readline");
const { once } = require("node:events");

const flashPoint = require("../flashpoint-algo");

const DAY_MS = 24 * 60 * 60 * 1000;
const INTERVALS = {
  "1s": 1000,
  "5s": 5000,
  "15s": 15000,
  "30s": 30000,
  "1m": 60000
};

const BASE_DATA_URL = "https://data.binance.vision/data/futures/um/daily/aggTrades";
const DEFAULT_TP_VALUES = [0.5, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20];
const DEFAULT_SL_VALUES = [0.5, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function utcDate(value) {
  return value.toISOString().slice(0, 10);
}

function parseUtcDate(date) {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function latestCompleteUtcRange(days, now = Date.now()) {
  const endMs = Math.floor(now / DAY_MS) * DAY_MS;
  return {
    startMs: endMs - days * DAY_MS,
    endMs,
    startDate: utcDate(new Date(endMs - days * DAY_MS)),
    endDateExclusive: utcDate(new Date(endMs))
  };
}

function dateRange(startMs, endMs) {
  const dates = [];
  for (let time = startMs; time < endMs; time += DAY_MS) {
    dates.push(utcDate(new Date(time)));
  }
  return dates;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function downloadDailyZip({ symbol, date, rawDir }) {
  ensureDir(rawDir);
  const file = join(rawDir, `${symbol}-aggTrades-${date}.zip`);
  if (existsSync(file)) return file;

  const url = `${BASE_DATA_URL}/${symbol}/${symbol}-aggTrades-${date}.zip`;
  run("curl", ["-fL", "--retry", "3", "--retry-delay", "2", "-o", file, url]);
  return file;
}

function parseAggTradeCsvLine(line) {
  if (!line || line.startsWith("agg_trade_id,")) return null;
  const columns = line.split(",");
  if (columns.length < 6) return null;
  const price = Number(columns[1]);
  const quantity = Number(columns[2]);
  const time = Number(columns[5]);
  if (![price, quantity, time].every(Number.isFinite)) return null;
  return { price, quantity, time };
}

function parseBarCsvLine(line) {
  if (!line || line.startsWith("time,")) return null;
  const [time, open, high, low, close, volume, trades] = line.split(",");
  const bar = {
    time: Number(time),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
    trades: Number(trades)
  };
  if (![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) return null;
  return bar;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "";
  return Number(value.toFixed(10)).toString();
}

class KlineWriter {
  constructor({ interval, intervalMs, startMs, endMs, outputDir, symbol }) {
    this.interval = interval;
    this.intervalMs = intervalMs;
    this.startMs = startMs;
    this.endMs = endMs;
    this.current = null;
    this.lastClose = null;
    this.rows = 0;
    this.outputPath = join(outputDir, `${symbol}-${interval}-${utcDate(new Date(startMs))}_${utcDate(new Date(endMs))}.csv.gz`);
    this.gzip = createGzip();
    this.stream = createWriteStream(this.outputPath);
    this.gzip.pipe(this.stream);
    this.gzip.write("time,open,high,low,close,volume,trades\n");
  }

  write(line) {
    if (!this.gzip.write(line)) return once(this.gzip, "drain");
    return null;
  }

  bucketFor(time) {
    return Math.floor(time / this.intervalMs) * this.intervalMs;
  }

  async fillGapUntil(bucket) {
    if (this.current === null || this.lastClose === null) return;
    let nextBucket = this.current.time + this.intervalMs;
    while (nextBucket < bucket && nextBucket < this.endMs) {
      this.current = {
        time: nextBucket,
        open: this.lastClose,
        high: this.lastClose,
        low: this.lastClose,
        close: this.lastClose,
        volume: 0,
        trades: 0
      };
      await this.flushCurrent();
      nextBucket += this.intervalMs;
    }
  }

  async flushCurrent() {
    if (!this.current) return;
    const bar = this.current;
    this.lastClose = bar.close;
    this.rows += 1;
    const wait = this.write([
      bar.time,
      formatNumber(bar.open),
      formatNumber(bar.high),
      formatNumber(bar.low),
      formatNumber(bar.close),
      formatNumber(bar.volume),
      bar.trades
    ].join(",") + "\n");
    if (wait) await wait;
  }

  async processTrade(trade) {
    if (trade.time < this.startMs || trade.time >= this.endMs) return;
    const bucket = this.bucketFor(trade.time);
    if (this.current && bucket > this.current.time) {
      await this.flushCurrent();
      await this.fillGapUntil(bucket);
      this.current = null;
    }
    if (!this.current) {
      const open = this.lastClose ?? trade.price;
      this.current = {
        time: bucket,
        open,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: 0,
        trades: 0
      };
    }
    this.current.high = Math.max(this.current.high, trade.price);
    this.current.low = Math.min(this.current.low, trade.price);
    this.current.close = trade.price;
    this.current.volume += trade.quantity;
    this.current.trades += 1;
  }

  async finish() {
    if (this.current) await this.flushCurrent();
    if (this.lastClose !== null) {
      let nextBucket = this.current ? this.current.time + this.intervalMs : this.startMs;
      while (nextBucket < this.endMs) {
        this.current = {
          time: nextBucket,
          open: this.lastClose,
          high: this.lastClose,
          low: this.lastClose,
          close: this.lastClose,
          volume: 0,
          trades: 0
        };
        await this.flushCurrent();
        nextBucket += this.intervalMs;
      }
    }
    this.gzip.end();
    await once(this.stream, "finish");
  }
}

async function streamZipLines(file, onLine) {
  const unzip = spawn("unzip", ["-p", file], { stdio: ["ignore", "pipe", "inherit"] });
  const closePromise = once(unzip, "close");
  const rl = readline.createInterface({ input: unzip.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    await onLine(line);
  }
  const [code] = await closePromise;
  if (code !== 0) throw new Error(`unzip failed for ${file}`);
}

async function buildKlines(options) {
  const symbol = options.symbol ?? "BTCUSDC";
  const days = Number(options.days ?? 30);
  const outDir = options.outDir ?? join(__dirname, "backtest-data");
  const range = options.startDate && options.endDate
    ? {
        startMs: parseUtcDate(options.startDate),
        endMs: parseUtcDate(options.endDate),
        startDate: options.startDate,
        endDateExclusive: options.endDate
      }
    : latestCompleteUtcRange(days);

  const symbolDir = join(outDir, symbol);
  const rawDir = join(symbolDir, "raw-aggTrades");
  const klineDir = join(symbolDir, "klines");
  ensureDir(rawDir);
  ensureDir(klineDir);

  const dates = dateRange(range.startMs, range.endMs);
  const writers = Object.entries(INTERVALS).map(([interval, intervalMs]) => (
    new KlineWriter({ interval, intervalMs, startMs: range.startMs, endMs: range.endMs, outputDir: klineDir, symbol })
  ));

  let trades = 0;
  for (const date of dates) {
    const file = downloadDailyZip({ symbol, date, rawDir });
    process.stderr.write(`processing ${basename(file)}\n`);
    await streamZipLines(file, async (line) => {
      const trade = parseAggTradeCsvLine(line);
      if (!trade || trade.time < range.startMs || trade.time >= range.endMs) return;
      trades += 1;
      for (const writer of writers) {
        await writer.processTrade(trade);
      }
    });
  }

  const intervals = {};
  for (const writer of writers) {
    await writer.finish();
    intervals[writer.interval] = { file: writer.outputPath, rows: writer.rows };
  }

  const manifest = {
    symbol,
    range,
    source: "Binance public data USD-M futures daily aggTrades",
    sourceUrl: `${BASE_DATA_URL}/${symbol}/`,
    generatedAt: new Date().toISOString(),
    trades,
    intervals
  };
  const manifestPath = join(symbolDir, `manifest-${range.startDate}_${range.endDateExclusive}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { ...manifest, manifestPath };
}

async function readKlineGzip(file) {
  const bars = [];
  const input = createReadStream(file).pipe(createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const bar = parseBarCsvLine(line);
    if (bar) bars.push(bar);
  }
  return bars;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function summarize(results) {
  const settled = results.filter((item) => item.outcome === "win" || item.outcome === "loss");
  const wins = settled.filter((item) => item.outcome === "win").length;
  const losses = settled.length - wins;
  const ambiguousLosses = settled.filter((item) => item.ambiguous).length;
  const holdSeconds = settled.map((item) => item.holdMs / 1000);
  const pnl = settled.reduce((sum, item) => sum + item.pnl, 0);
  return {
    trades: results.length,
    settled: settled.length,
    wins,
    losses,
    open: results.length - settled.length,
    ambiguousLosses,
    winRate: settled.length ? wins / settled.length : null,
    totalPnl: pnl,
    expectancy: settled.length ? pnl / settled.length : null,
    avgHoldSeconds: holdSeconds.length ? holdSeconds.reduce((sum, item) => sum + item, 0) / holdSeconds.length : null,
    medianHoldSeconds: percentile(holdSeconds, 0.5),
    p90HoldSeconds: percentile(holdSeconds, 0.9)
  };
}

function extractSignals(rows) {
  const signals = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.crossing !== "up" && row.crossing !== "down") continue;
    signals.push({
      index,
      time: row.time,
      direction: row.crossing === "up" ? "long" : "short",
      entry: row.close,
      c1: row.c1,
      c2: row.c2,
      crossValue: row.crossValue
    });
  }
  return signals;
}

function settleSignal(bars, signal, tp, sl) {
  const takeProfit = signal.direction === "long" ? signal.entry + tp : signal.entry - tp;
  const stopLoss = signal.direction === "long" ? signal.entry - sl : signal.entry + sl;
  for (let index = signal.index + 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const hitTp = signal.direction === "long" ? bar.high >= takeProfit : bar.low <= takeProfit;
    const hitSl = signal.direction === "long" ? bar.low <= stopLoss : bar.high >= stopLoss;
    if (!hitTp && !hitSl) continue;
    if (hitTp && hitSl) {
      return {
        ...signal,
        exitTime: bar.time,
        exit: stopLoss,
        outcome: "loss",
        ambiguous: true,
        pnl: -sl,
        holdMs: bar.time - signal.time
      };
    }
    return {
      ...signal,
      exitTime: bar.time,
      exit: hitTp ? takeProfit : stopLoss,
      outcome: hitTp ? "win" : "loss",
      ambiguous: false,
      pnl: hitTp ? tp : -sl,
      holdMs: bar.time - signal.time
    };
  }
  return { ...signal, outcome: "open", pnl: 0, holdMs: null, ambiguous: false };
}

function backtestSignals(bars, signals, { tp, sl }) {
  return signals.map((signal) => settleSignal(bars, signal, tp, sl));
}

function filterSignals(signals, filter) {
  return signals.filter((signal) => {
    if (filter.direction && signal.direction !== filter.direction) return false;
    if (filter.longMaxC1 !== undefined && signal.direction === "long" && !(signal.c1 <= filter.longMaxC1)) return false;
    if (filter.shortMinC1 !== undefined && signal.direction === "short" && !(signal.c1 >= filter.shortMinC1)) return false;
    if (filter.minC1 !== undefined && !(signal.c1 >= filter.minC1)) return false;
    if (filter.maxC1 !== undefined && !(signal.c1 <= filter.maxC1)) return false;
    return true;
  });
}

function analyzeThresholds(bars, signals, baseRisk) {
  const allSummary = summarize(backtestSignals(bars, signals, baseRisk));
  const minTrades = Math.max(30, Math.floor(allSummary.trades * 0.05));
  const thresholds = [];
  for (let value = 5; value <= 95; value += 5) {
    const longSignals = filterSignals(signals, { direction: "long", maxC1: value });
    const shortSignals = filterSignals(signals, { direction: "short", minC1: value });
    const combinedSignals = filterSignals(signals, { longMaxC1: value, shortMinC1: 100 - value });
    for (const item of [
      { mode: "long_c1_at_or_below", threshold: value, signals: longSignals },
      { mode: "short_c1_at_or_above", threshold: value, signals: shortSignals },
      { mode: "long_below_and_short_above_symmetric", threshold: value, signals: combinedSignals }
    ]) {
      const summary = summarize(backtestSignals(bars, item.signals, baseRisk));
      if (summary.trades >= minTrades) {
        thresholds.push({ mode: item.mode, threshold: item.threshold, ...summary });
      }
    }
  }
  thresholds.sort((a, b) => (
    (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity)
    || (b.winRate ?? 0) - (a.winRate ?? 0)
    || b.trades - a.trades
  ));
  return { minTrades, top: thresholds.slice(0, 15) };
}

function analyzeTpSlGrid(bars, signals, tpValues = DEFAULT_TP_VALUES, slValues = DEFAULT_SL_VALUES) {
  const rows = [];
  for (const tp of tpValues) {
    for (const sl of slValues) {
      const summary = summarize(backtestSignals(bars, signals, { tp, sl }));
      if (summary.settled > 0) rows.push({ tp, sl, ...summary });
    }
  }
  rows.sort((a, b) => (
    (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity)
    || (b.winRate ?? 0) - (a.winRate ?? 0)
    || b.trades - a.trades
  ));
  return rows;
}

function roundMetric(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function compactSummary(summary) {
  return {
    ...summary,
    winRate: roundMetric(summary.winRate, 6),
    totalPnl: roundMetric(summary.totalPnl, 4),
    expectancy: roundMetric(summary.expectancy, 6),
    avgHoldSeconds: roundMetric(summary.avgHoldSeconds, 3),
    medianHoldSeconds: roundMetric(summary.medianHoldSeconds, 3),
    p90HoldSeconds: roundMetric(summary.p90HoldSeconds, 3)
  };
}

async function analyzeManifest(manifestPath, options = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const baseRisk = {
    tp: Number(options.tp ?? 1),
    sl: Number(options.sl ?? 1)
  };
  const intervalResults = {};
  for (const interval of Object.keys(INTERVALS)) {
    const file = manifest.intervals[interval]?.file;
    if (!file) continue;
    process.stderr.write(`analyzing ${interval}\n`);
    const bars = await readKlineGzip(file);
    const rows = flashPoint.computeFlashPoint(bars);
    const signals = extractSignals(rows);
    const baseTrades = backtestSignals(bars, signals, baseRisk);
    const baseSummary = compactSummary(summarize(baseTrades));
    const threshold = analyzeThresholds(bars, signals, baseRisk);
    const grid = analyzeTpSlGrid(bars, signals).slice(0, 25).map((item) => compactSummary(item));
    intervalResults[interval] = {
      bars: bars.length,
      signals: signals.length,
      baseRisk,
      baseSummary,
      threshold: {
        minTrades: threshold.minTrades,
        top: threshold.top.map((item) => compactSummary(item))
      },
      tpSlTop: grid
    };
  }
  const result = {
    generatedAt: new Date().toISOString(),
    methodology: {
      entry: "Signal bar close after Flash Point Pro v0.8 exact C1/C2 crossing",
      settlement: "First later candle touching TP or SL; if both touch in the same candle, counted as SL loss",
      feesAndSlippage: "Not included",
      klineSource: "1s/5s/15s/30s/1m bars rebuilt from Binance USD-M aggTrades with empty intervals filled from previous close"
    },
    manifest,
    intervals: intervalResults
  };

  const outputPath = options.output
    ?? join(dirname(manifestPath), `flashpoint-backtest-${manifest.range.startDate}_${manifest.range.endDateExclusive}.json`);
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  writeFileSync(outputPath.replace(/\.json$/, ".md"), renderMarkdown(result));
  return { outputPath, result };
}

function percent(value) {
  if (value === null || value === undefined) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

function metric(value, digits = 3) {
  if (value === null || value === undefined) return "n/a";
  return Number(value).toFixed(digits);
}

function renderMarkdown(result) {
  const lines = [];
  lines.push("# Flash Point Pro BTCUSDC.P Backtest");
  lines.push("");
  lines.push(`Generated: ${result.generatedAt}`);
  lines.push(`Range: ${result.manifest.range.startDate} UTC through ${result.manifest.range.endDateExclusive} UTC exclusive`);
  lines.push(`Source: ${result.manifest.source}`);
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  for (const [key, value] of Object.entries(result.methodology)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("");
  lines.push("## Base TP/SL = 1/1");
  lines.push("");
  lines.push("| Interval | Bars | Signals | Settled | Win rate | Expectancy | Total PnL | Median hold | P90 hold | Ambiguous losses |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const [interval, data] of Object.entries(result.intervals)) {
    const s = data.baseSummary;
    lines.push(`| ${interval} | ${data.bars} | ${data.signals} | ${s.settled} | ${percent(s.winRate)} | ${metric(s.expectancy)} | ${metric(s.totalPnl)} | ${metric(s.medianHoldSeconds)}s | ${metric(s.p90HoldSeconds)}s | ${s.ambiguousLosses} |`);
  }
  lines.push("");
  lines.push("## Top Crossing Value Filters");
  lines.push("");
  for (const [interval, data] of Object.entries(result.intervals)) {
    lines.push(`### ${interval}`);
    lines.push("");
    lines.push(`Minimum sample count: ${data.threshold.minTrades}`);
    lines.push("");
    lines.push("| Mode | Threshold | Trades | Win rate | Expectancy | Total PnL |");
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const item of data.threshold.top.slice(0, 8)) {
      lines.push(`| ${item.mode} | ${item.threshold} | ${item.trades} | ${percent(item.winRate)} | ${metric(item.expectancy)} | ${metric(item.totalPnl)} |`);
    }
    lines.push("");
  }
  lines.push("## Top TP/SL Grid");
  lines.push("");
  for (const [interval, data] of Object.entries(result.intervals)) {
    lines.push(`### ${interval}`);
    lines.push("");
    lines.push("| TP | SL | Trades | Win rate | Expectancy | Total PnL | Median hold |");
    lines.push("|---:|---:|---:|---:|---:|---:|---:|");
    for (const item of data.tpSlTop.slice(0, 10)) {
      lines.push(`| ${item.tp} | ${item.sl} | ${item.trades} | ${percent(item.winRate)} | ${metric(item.expectancy)} | ${metric(item.totalPnl)} | ${metric(item.medianHoldSeconds)}s |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "help";
  if (command === "download") {
    const manifest = await buildKlines({
      symbol: args.symbol ?? "BTCUSDC",
      days: args.days ?? 30,
      outDir: args.out ?? join(__dirname, "backtest-data"),
      startDate: args.start,
      endDate: args.end
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (command === "analyze") {
    if (!args.manifest) throw new Error("--manifest is required");
    const { outputPath } = await analyzeManifest(args.manifest, {
      tp: args.tp,
      sl: args.sl,
      output: args.output
    });
    console.log(outputPath);
    return;
  }
  console.log("Usage:");
  console.log("  node CrossingFetch/analysis/flashpoint-backtest.js download --symbol BTCUSDC --days 30 --out CrossingFetch/analysis/backtest-data");
  console.log("  node CrossingFetch/analysis/flashpoint-backtest.js analyze --manifest <manifest.json>");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  INTERVALS,
  latestCompleteUtcRange,
  parseAggTradeCsvLine,
  parseBarCsvLine,
  extractSignals,
  settleSignal,
  backtestSignals,
  summarize,
  analyzeThresholds,
  analyzeTpSlGrid,
  renderMarkdown
};
