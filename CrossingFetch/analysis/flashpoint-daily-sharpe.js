"use strict";

const { existsSync, mkdirSync, writeFileSync, createWriteStream } = require("node:fs");
const { join } = require("node:path");

const {
  INTERVALS,
  shouldTradeSignal,
  extractIntervalEvents,
  populateHitTimes
} = require("./flashpoint-rule-grid");

const DAY_MS = 86_400_000;

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

function parseStringList(value, fallback) {
  if (!value) return fallback;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function parseUtcDay(date) {
  const time = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(time)) throw new Error(`Invalid UTC date: ${date}`);
  return Math.floor(time / DAY_MS);
}

function utcDateFromDay(dayIndex) {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function calculateAnnualizedDailySharpe(dailyPnl, options = {}) {
  const initialCapital = options.initialCapital ?? 1;
  const periodsPerYear = options.periodsPerYear ?? 365;
  const returns = dailyPnl.map((pnl) => pnl / initialCapital);
  const count = returns.length;
  const meanDailyReturn = count ? returns.reduce((sum, item) => sum + item, 0) / count : 0;
  let variance = 0;
  if (count > 1) {
    for (const item of returns) variance += (item - meanDailyReturn) ** 2;
    variance /= count - 1;
  }
  const stdDailyReturn = Math.sqrt(variance);
  const sharpe365 = stdDailyReturn > 0 ? meanDailyReturn / stdDailyReturn * Math.sqrt(periodsPerYear) : 0;
  return { meanDailyReturn, stdDailyReturn, sharpe365 };
}

function outcomeFor(entry, tpIndex, slIndex) {
  const tpMs = entry.tpHitMs[tpIndex];
  const slMs = entry.slHitMs[slIndex];
  if (tpMs !== null && (slMs === null || tpMs <= slMs)) return { outcome: "win", holdMs: tpMs };
  if (slMs !== null) return { outcome: "loss", holdMs: slMs };
  return { outcome: "open", holdMs: null };
}

function makeDailyState(tp, sl, singleActive, dayCount) {
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
    dailyPnl: new Float64Array(dayCount)
  };
}

function addHold(state, holdMs) {
  const holdSeconds = holdMs / 1000;
  const bucket = Math.floor(holdSeconds);
  state.closedCount += 1;
  state.maxHoldSeconds = state.maxHoldSeconds === null ? holdSeconds : Math.max(state.maxHoldSeconds, holdSeconds);
  state.holdBuckets.set(bucket, (state.holdBuckets.get(bucket) ?? 0) + 1);
}

function recordOutcome(state, entry, outcome, quantity, startDayIndex, dayCount) {
  if (state.singleActive && entry.time < state.activeUntil) return;
  state.entries += 1;

  let pricePnl = 0;
  if (outcome.outcome === "win") {
    state.wins += 1;
    pricePnl = state.tp;
    if (outcome.holdMs <= 5_000) state.within5s += 1;
    if (outcome.holdMs <= 10_000) state.within10s += 1;
    if (outcome.holdMs <= 30_000) state.within30s += 1;
    if (outcome.holdMs <= 60_000) state.within60s += 1;
    if (outcome.holdMs <= 300_000) state.within300s += 1;
    addHold(state, outcome.holdMs);
  } else if (outcome.outcome === "loss") {
    state.losses += 1;
    pricePnl = -state.sl;
    addHold(state, outcome.holdMs);
  } else {
    state.open += 1;
  }

  if (outcome.holdMs !== null) {
    const exitTime = entry.time + outcome.holdMs;
    const dayOffset = Math.floor(exitTime / DAY_MS) - startDayIndex;
    if (dayOffset >= 0 && dayOffset < dayCount) state.dailyPnl[dayOffset] += pricePnl * quantity;
  }

  if (state.singleActive) state.activeUntil = outcome.holdMs === null ? Infinity : entry.time + outcome.holdMs;
}

function percentileFromBuckets(state, p) {
  if (!state.closedCount) return null;
  const target = Math.min(state.closedCount - 1, Math.floor((state.closedCount - 1) * p));
  const buckets = [...state.holdBuckets.keys()].sort((a, b) => a - b);
  let seen = 0;
  for (const bucket of buckets) {
    seen += state.holdBuckets.get(bucket);
    if (seen > target) return bucket;
  }
  return state.maxHoldSeconds;
}

function finalizeState(state, options) {
  const dailyPnl = Array.from(state.dailyPnl);
  const totalUsdcPnl = dailyPnl.reduce((sum, item) => sum + item, 0);
  const positiveDays = dailyPnl.filter((item) => item > 0).length;
  const negativeDays = dailyPnl.filter((item) => item < 0).length;
  const zeroDays = dailyPnl.length - positiveDays - negativeDays;
  const sharpe = calculateAnnualizedDailySharpe(dailyPnl, {
    initialCapital: options.initialCapital,
    periodsPerYear: options.periodsPerYear
  });
  const meanDailyPnl = dailyPnl.length ? totalUsdcPnl / dailyPnl.length : 0;
  let dailyPnlVariance = 0;
  if (dailyPnl.length > 1) {
    for (const item of dailyPnl) dailyPnlVariance += (item - meanDailyPnl) ** 2;
    dailyPnlVariance /= dailyPnl.length - 1;
  }
  const maxDailyGain = dailyPnl.length ? Math.max(...dailyPnl) : 0;
  const maxDailyLoss = dailyPnl.length ? Math.min(...dailyPnl) : 0;
  const entries = state.entries;
  const lossRate = entries ? state.losses / entries : null;

  return {
    entries,
    wins: state.wins,
    losses: state.losses,
    open: state.open,
    eventualWinRate: entries ? state.wins / entries : null,
    lossRate,
    within5s: entries ? state.within5s / entries : null,
    within10s: entries ? state.within10s / entries : null,
    within30s: entries ? state.within30s / entries : null,
    within60s: entries ? state.within60s / entries : null,
    within300s: entries ? state.within300s / entries : null,
    medianHoldSeconds: percentileFromBuckets(state, 0.5),
    p90HoldSeconds: percentileFromBuckets(state, 0.9),
    p99HoldSeconds: percentileFromBuckets(state, 0.99),
    maxHoldSeconds: state.maxHoldSeconds,
    totalUsdcPnl,
    finalEquity: options.initialCapital + totalUsdcPnl,
    roi: options.initialCapital ? totalUsdcPnl / options.initialCapital : null,
    dailySharpe365: sharpe.sharpe365,
    meanDailyReturn: sharpe.meanDailyReturn,
    stdDailyReturn: sharpe.stdDailyReturn,
    meanDailyPnl,
    stdDailyPnl: Math.sqrt(dailyPnlVariance),
    positiveDays,
    negativeDays,
    zeroDays,
    maxDailyGain,
    maxDailyLoss
  };
}

function makeStates(tpValues, slValues, modes, dayCount) {
  const pairCount = tpValues.length * slValues.length;
  const result = {};
  if (modes.includes("independent")) result.independent = Array(pairCount);
  if (modes.includes("single")) result.single = Array(pairCount);
  for (let tpIndex = 0; tpIndex < tpValues.length; tpIndex += 1) {
    for (let slIndex = 0; slIndex < slValues.length; slIndex += 1) {
      const pairIndex = tpIndex * slValues.length + slIndex;
      if (result.independent) result.independent[pairIndex] = makeDailyState(tpValues[tpIndex], slValues[slIndex], false, dayCount);
      if (result.single) result.single[pairIndex] = makeDailyState(tpValues[tpIndex], slValues[slIndex], true, dayCount);
    }
  }
  return result;
}

function writeCsv(file, rows) {
  const columns = [
    "interval", "persistMs", "longBelow", "shortAbove", "tp", "sl", "mode",
    "entries", "wins", "losses", "open", "eventualWinRate", "lossRate",
    "within30s", "p90HoldSeconds", "p99HoldSeconds", "maxHoldSeconds",
    "totalUsdcPnl", "finalEquity", "roi", "dailySharpe365",
    "meanDailyReturn", "stdDailyReturn", "meanDailyPnl", "stdDailyPnl",
    "positiveDays", "negativeDays", "zeroDays", "maxDailyGain", "maxDailyLoss"
  ];
  const stream = createWriteStream(file, { encoding: "utf8" });
  stream.write(`${columns.join(",")}\n`);
  for (const row of rows) stream.write(`${columns.map((column) => row[column] ?? "").join(",")}\n`);
  return new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on("error", reject);
  });
}

function formatPct(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "n/a"
    : Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
}

function renderTable(title, rows, note = "") {
  const lines = [`## ${title}`, ""];
  if (note) lines.push(note, "");
  lines.push("| # | TW | Persist | Long | Short | TP | SL | Mode | Entries | PnL | Daily Sharpe 365 | Win | <=30s | p99 hold | Max hold | Positive days | Negative days | Max day loss |");
  lines.push("| -: | - | -: | - | - | -: | -: | - | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: |");
  rows.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.interval} | ${row.persistMs} | <${row.longBelow} | >${row.shortAbove} | ${row.tp} | ${row.sl} | ${row.mode} | ${row.entries} | ${formatNumber(row.totalUsdcPnl)} | ${formatNumber(row.dailySharpe365, 4)} | ${formatPct(row.eventualWinRate)} | ${formatPct(row.within30s)} | ${formatNumber(row.p99HoldSeconds, 0)}s | ${formatNumber(row.maxHoldSeconds, 2)}s | ${row.positiveDays} | ${row.negativeDays} | ${formatNumber(row.maxDailyLoss)} |`);
  });
  return lines.join("\n");
}

function renderMarkdown(output) {
  const rows = output.results;
  const minEntries = (row) => row.entries >= 10_000;
  const positive = (row) => minEntries(row) && row.totalUsdcPnl > 0;
  const shortHold = (row) => positive(row) && row.within30s >= 0.7 && row.p99HoldSeconds <= 90;
  const strictShortHold = (row) => positive(row) && row.within30s >= 0.75 && row.p99HoldSeconds <= 60;
  const maxHoldCapped = (row) => positive(row) && row.maxHoldSeconds <= 300;
  const bySharpe = (a, b) => b.dailySharpe365 - a.dailySharpe365 || b.totalUsdcPnl - a.totalUsdcPnl;

  const lines = [
    "# Flash Point Pro v0.8 Exact - Daily Annualized Sharpe",
    "",
    `Generated: ${output.generatedAt}`,
    "",
    "## Scope",
    "",
    `- Data: ${output.inputs.startDate} through ${output.inputs.endDate}.`,
    `- Calendar days: ${output.inputs.dayCount}.`,
    `- Intervals: ${output.inputs.intervals.join(", ")}.`,
    "- 1s is excluded.",
    "- Only compound 0% is calculated.",
    "- Daily PnL is realized on exit day.",
    "- Annualization uses sqrt(365), suitable for BTC calendar-day trading.",
    "",
    "## Formula",
    "",
    "```text",
    "daily_return = daily_realized_pnl / 500",
    "daily_sharpe_365 = avg(daily_return) / stdev(daily_return) * sqrt(365)",
    "```",
    "",
    `- Rows: ${rows.length.toLocaleString("en-US")}.`,
    `- Rows with entries >= 10,000: ${rows.filter(minEntries).length.toLocaleString("en-US")}.`,
    `- Positive rows with entries >= 10,000: ${rows.filter(positive).length.toLocaleString("en-US")}.`,
    `- Strict short-hold rows: ${rows.filter(strictShortHold).length.toLocaleString("en-US")}.`,
    "",
    renderTable("Top 100 By Daily Sharpe 365", rows.filter(minEntries).sort(bySharpe).slice(0, 100), "Minimum entries: 10,000."),
    "",
    renderTable("Top 100 Positive By Daily Sharpe 365", rows.filter(positive).sort(bySharpe).slice(0, 100), "Positive total PnL and minimum entries: 10,000."),
    "",
    renderTable("Top 100 Short-Hold By Daily Sharpe 365", rows.filter(shortHold).sort(bySharpe).slice(0, 100), "Positive PnL, entries >= 10,000, <=30s >= 70%, p99 <= 90s."),
    "",
    renderTable("Top 100 Strict Short-Hold By Daily Sharpe 365", rows.filter(strictShortHold).sort(bySharpe).slice(0, 100), "Positive PnL, entries >= 10,000, <=30s >= 75%, p99 <= 60s."),
    "",
    renderTable("Top 100 Max-Hold <= 300s By Daily Sharpe 365", rows.filter(maxHoldCapped).sort(bySharpe).slice(0, 100), "Positive PnL, entries >= 10,000, longest hold <= 300 seconds."),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

async function runDailySharpe(options) {
  const rawDir = options.rawDir;
  if (!rawDir || !existsSync(rawDir)) throw new Error("--raw-dir is required");
  const outDir = options.outDir ?? join(process.cwd(), "CrossingFetch/analysis/backtest-data/BTCUSDC");
  mkdirSync(outDir, { recursive: true });

  const intervals = parseStringList(options.intervals, ["5s", "15s", "30s", "1m"]);
  const persistValues = parseNumberList(options.persist, [0, 250, 500, 1000, 2000]);
  const tpValues = parseNumberList(options.tp, [0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15]);
  const slValues = parseNumberList(options.sl, [0.5, 1, 1.5, 2, 3, 4, 5, 10]);
  const longBelowValues = parseNumberList(options.longBelow, [10, 20, 35, 40, 45, 50]);
  const shortAboveValues = parseNumberList(options.shortAbove, [55, 60, 65, 70, 80, 90]);
  const modes = parseStringList(options.modes, ["single", "independent"]);
  const initialCapital = Number(options.capital ?? 500);
  const leverage = Number(options.leverage ?? 20);
  const referencePrice = Number(options.referencePrice ?? 65000);
  const quantity = initialCapital * leverage / referencePrice;
  const startDayIndex = parseUtcDay(options.startDate);
  const endDayIndex = parseUtcDay(options.endDate);
  const dayCount = endDayIndex - startDayIndex + 1;
  if (dayCount <= 0) throw new Error("--end-date must be on or after --start-date");

  const output = {
    generatedAt: new Date().toISOString(),
    inputs: {
      rawDir,
      startDate: options.startDate,
      endDate: options.endDate,
      dayCount,
      intervals,
      persistValues,
      tpValues,
      slValues,
      longBelowValues,
      shortAboveValues,
      modes,
      economics: { initialCapital, leverage, referencePrice, quantity }
    },
    results: []
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
      process.stderr.write(`daily sharpe ${interval} persist ${persistMs}ms\n`);
      const byPersist = events.filter((event) => event.persistMs === persistMs);
      for (const longBelow of longBelowValues) {
        for (const shortAbove of shortAboveValues) {
          const candidates = byPersist.filter((event) => shouldTradeSignal(event, { longBelow, shortAbove }));
          if (!candidates.length) continue;
          const states = makeStates(tpValues, slValues, modes, dayCount);
          for (const entry of candidates) {
            for (let tpIndex = 0; tpIndex < tpValues.length; tpIndex += 1) {
              for (let slIndex = 0; slIndex < slValues.length; slIndex += 1) {
                const pairIndex = tpIndex * slValues.length + slIndex;
                const outcome = outcomeFor(entry, tpIndex, slIndex);
                if (states.independent) recordOutcome(states.independent[pairIndex], entry, outcome, quantity, startDayIndex, dayCount);
                if (states.single) recordOutcome(states.single[pairIndex], entry, outcome, quantity, startDayIndex, dayCount);
              }
            }
          }
          for (const mode of modes) {
            const modeStates = states[mode];
            if (!modeStates) continue;
            for (let tpIndex = 0; tpIndex < tpValues.length; tpIndex += 1) {
              for (let slIndex = 0; slIndex < slValues.length; slIndex += 1) {
                const pairIndex = tpIndex * slValues.length + slIndex;
                output.results.push({
                  interval,
                  persistMs,
                  longBelow,
                  shortAbove,
                  tp: tpValues[tpIndex],
                  sl: slValues[slIndex],
                  mode,
                  compoundRate: 0,
                  ...finalizeState(modeStates[pairIndex], {
                    initialCapital,
                    periodsPerYear: 365
                  })
                });
              }
            }
          }
          process.stderr.write(`finished daily sharpe ${interval} ${persistMs}ms long<${longBelow} short>${shortAbove}\n`);
        }
      }
    }
    if (typeof global.gc === "function") global.gc();
  }

  output.results.sort((a, b) => b.dailySharpe365 - a.dailySharpe365 || b.totalUsdcPnl - a.totalUsdcPnl);
  const stem = `flashpoint-rule-grid-v08-exact-compound0-daily-sharpe-${options.startDate}_${options.endDate}`;
  const jsonPath = join(outDir, `${stem}.json`);
  const csvPath = join(outDir, `${stem}.csv`);
  const mdPath = join(outDir, `${stem}.md`);
  writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  await writeCsv(csvPath, output.results);
  writeFileSync(mdPath, renderMarkdown(output));
  return { jsonPath, csvPath, mdPath, output };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "help";
  if (command === "daily-sharpe") {
    const result = await runDailySharpe({
      rawDir: args["raw-dir"],
      outDir: args.out,
      startDate: args["start-date"],
      endDate: args["end-date"],
      intervals: args.intervals,
      persist: args.persist,
      tp: args.tp,
      sl: args.sl,
      longBelow: args["long-below"],
      shortAbove: args["short-above"],
      modes: args.modes,
      capital: args.capital,
      leverage: args.leverage,
      referencePrice: args["reference-price"]
    });
    console.log(JSON.stringify({
      jsonPath: result.jsonPath,
      csvPath: result.csvPath,
      mdPath: result.mdPath,
      rows: result.output.results.length
    }, null, 2));
    return;
  }
  console.log("Usage:");
  console.log("  node CrossingFetch/analysis/flashpoint-daily-sharpe.js daily-sharpe --raw-dir ... --start-date 2024-07-01 --end-date 2026-06-20");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DAY_MS,
  calculateAnnualizedDailySharpe,
  runDailySharpe
};
