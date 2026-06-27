#!/usr/bin/env node
const {
  loadJsonl,
  dedupeBarFinalSamples,
  buildExactBarFinalTargets,
  buildExactFlashPointSeries,
  extractExactFlashPoint,
  PRICE_SOURCES,
  calculateRsv,
  ema,
  smoothAlpha,
  simpleMovingAverage,
  weightedMovingAverage,
  chineseSma,
  rmseAtIndices,
  inferSmoothedInput,
  flashPointC2Recurrence
} = require("./flash-point-model");

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node CrossingFetch/analysis/fit-exact-flash-point.js <file.jsonl> [more.jsonl]");
  process.exit(1);
}

const rows = files.flatMap(loadJsonl);
const samples = dedupeBarFinalSamples(rows);
const targets = buildExactBarFinalTargets(rows, samples);
if (targets.indices.length < 100) {
  console.error(`Need at least 100 exact bar-final targets; got ${targets.indices.length}.`);
  process.exit(1);
}

const warmup = Math.min(200, Math.floor(samples.length * 0.2));
const bars = samples.map((sample) => sample.bar);
const observedC1 = samples.map((sample, index) => {
  return Number.isFinite(targets.c1[index]) ? targets.c1[index] : Number(sample.flashPoint.c1);
});

const candidates = [];
for (const sourceName of ["close", "hlc3", "hlcc4", "hl2", "ohlc4"]) {
  for (let rsvPeriod = 2; rsvPeriod <= 20; rsvPeriod += 1) {
    const rsv = calculateRsv(bars, rsvPeriod, sourceName);
    for (const c1Spec of c1Smoothers(rsv)) {
      for (const c2Spec of c2Smoothers(c1Spec.values)) {
        candidates.push(scoreCandidate({
          name: `${c1Spec.name}-${c2Spec.name}`,
          params: { sourceName, rsvPeriod, ...c1Spec.params, ...c2Spec.params },
          c1: c1Spec.values,
          c2: c2Spec.values
        }));
      }
    }
  }
}

candidates.sort((a, b) => a.totalRmse - b.totalRmse);

const c2UpperBound = [];
for (const spec of c2Smoothers(observedC1)) {
  c2UpperBound.push(scoreC2Only(spec));
}
c2UpperBound.sort((a, b) => a.c2Rmse - b.c2Rmse);

const summary = {
  files: files.map((file) => file.split("/").pop()),
  rawRows: rows.length,
  barFinalSamples: samples.length,
  exactBarFinalTargets: targets.indices.length,
  warmup,
  gapSummary: summarizeGaps(samples),
  impliedC1Alpha: impliedC1Alpha(rows, samples).slice(0, 15),
  c1InputDiagnostics: c1InputDiagnostics().slice(0, 15),
  c1DoubleSmoothCandidates: c1DoubleSmoothCandidates().slice(0, 15),
  c2ExactContinuity: c2ExactContinuity(),
  c2WeightedRecurrence: c2WeightedRecurrence(),
  alignmentShiftCheck: alignmentShiftCheck(),
  bestFormulaCandidates: candidates.slice(0, 25),
  bestC2FromObservedC1: c2UpperBound.slice(0, 15)
};

console.log(JSON.stringify(summary, null, 2));

function c1Smoothers(values) {
  const specs = [];
  for (let period = 1; period <= 12; period += 1) {
    specs.push({ name: "c1-ema", params: { c1Period: period }, values: ema(values, period) });
    specs.push({ name: "c1-sma", params: { c1Period: period }, values: simpleMovingAverage(values, period) });
    specs.push({ name: "c1-wma", params: { c1Period: period }, values: weightedMovingAverage(values, period) });
    for (const weight of commonWeights(period)) {
      specs.push({
        name: "c1-cn-sma",
        params: { c1Period: period, c1Weight: weight },
        values: chineseSma(values, period, weight)
      });
    }
  }

  for (let alphaInt = 50; alphaInt <= 950; alphaInt += 25) {
    const alpha = alphaInt / 1000;
    specs.push({ name: "c1-alpha", params: { c1Alpha: alpha }, values: smoothAlpha(values, alpha) });
  }
  return specs;
}

function c2Smoothers(values) {
  const specs = [];
  for (let period = 1; period <= 12; period += 1) {
    specs.push({ name: "c2-ema", params: { c2Period: period }, values: ema(values, period) });
    specs.push({ name: "c2-sma", params: { c2Period: period }, values: simpleMovingAverage(values, period) });
    specs.push({ name: "c2-wma", params: { c2Period: period }, values: weightedMovingAverage(values, period) });
    for (const weight of commonWeights(period)) {
      specs.push({
        name: "c2-cn-sma",
        params: { c2Period: period, c2Weight: weight },
        values: chineseSma(values, period, weight)
      });
    }
  }
  return specs;
}

function scoreCandidate(candidate) {
  const c1Rmse = maskedRmse(candidate.c1, targets.c1, warmup);
  const c2Rmse = maskedRmse(candidate.c2, targets.c2, warmup);
  return {
    name: candidate.name,
    params: candidate.params,
    c1Rmse,
    c2Rmse,
    totalRmse: Math.hypot(c1Rmse, c2Rmse) / Math.SQRT2
  };
}

function scoreC2Only(spec) {
  return {
    name: spec.name,
    params: spec.params,
    c2Rmse: maskedRmse(spec.values, targets.c2, warmup)
  };
}

function c1DoubleSmoothCandidates() {
  const results = [];
  const alphas = [];
  for (let value = 1; value <= 100; value += 2) alphas.push(value / 100);

  for (const sourceName of ["close", "hlc3", "hlcc4", "hl2", "ohlc4"]) {
    for (let rsvPeriod = 2; rsvPeriod <= 12; rsvPeriod += 1) {
      const rsv = calculateRsv(bars, rsvPeriod, sourceName);
      for (const preAlpha of alphas) {
        const preSmoothed = smoothAlpha(rsv, preAlpha);
        for (const c1Alpha of alphas) {
          const c1 = smoothAlpha(preSmoothed, c1Alpha);
          results.push({
            sourceName,
            rsvPeriod,
            preAlpha,
            c1Alpha,
            c1Rmse: maskedRmse(c1, targets.c1, warmup)
          });
        }
      }
    }
  }

  return results.sort((a, b) => a.c1Rmse - b.c1Rmse);
}

function maskedRmse(predicted, expected, startIndex) {
  return rmseAtIndices(predicted, expected, targets.indices, startIndex);
}

function alignmentShiftCheck() {
  const rsv = calculateRsv(bars, 5, "hlc3");
  const c1 = smoothAlpha(rsv, 0.4);
  const c2 = simpleMovingAverage(c1, 3);
  const shifts = [];
  for (let shift = -10; shift <= 10; shift += 1) {
    shifts.push({
      shift,
      c1Rmse: rmseAtIndices(c1, targets.c1, targets.indices, warmup, shift),
      c2Rmse: rmseAtIndices(c2, targets.c2, targets.indices, warmup, shift)
    });
  }
  return shifts.sort((a, b) => (a.c1Rmse + a.c2Rmse) - (b.c1Rmse + b.c2Rmse)).slice(0, 10);
}

function c1InputDiagnostics() {
  const exactRows = rows
    .map((row) => ({ row, exact: extractExactFlashPoint(row) }))
    .filter((entry) => entry.exact && entry.row.bar);
  const finalTimes = samples.map((sample) => sample.bar.time);
  const diagnostics = [];

  for (const sourceName of Object.keys(PRICE_SOURCES)) {
    for (let rsvPeriod = 2; rsvPeriod <= 20; rsvPeriod += 1) {
      for (const mode of ["normal", "inverse", "closest-normal-or-inverse"]) {
        let total = 0;
        let count = 0;
        let chooseInverse = 0;
        for (const entry of exactRows) {
          const previousIndex = previousFinalIndex(finalTimes, entry.row.bar.time);
          if (previousIndex < rsvPeriod - 2) continue;
          const previousExact = extractExactFlashPoint(samples[previousIndex]);
          const previousC1 = previousExact?.c1 ?? Number(samples[previousIndex].flashPoint?.c1);
          const inferred = inferSmoothedInput(entry.exact.c1, previousC1, 0.4);
          const normal = rsvFromPreviousFinals(samples, previousIndex, entry.row.bar, rsvPeriod, sourceName);
          if (!Number.isFinite(inferred) || !Number.isFinite(normal)) continue;

          let predicted = normal;
          if (mode === "inverse") predicted = 100 - normal;
          if (mode === "closest-normal-or-inverse") {
            const inverse = 100 - normal;
            if (Math.abs(inverse - inferred) < Math.abs(normal - inferred)) {
              predicted = inverse;
              chooseInverse += 1;
            }
          }
          const diff = predicted - inferred;
          total += diff * diff;
          count += 1;
        }
        if (count >= 200) {
          diagnostics.push({
            sourceName,
            rsvPeriod,
            mode,
            count,
            rmse: Math.sqrt(total / count),
            chooseInverse
          });
        }
      }
    }
  }

  return diagnostics.sort((a, b) => a.rmse - b.rmse);
}

function c2ExactContinuity() {
  const exact = samples.map(extractExactFlashPoint);
  const rows = [];
  for (let index = 2; index < samples.length; index += 1) {
    if (!exact[index] || !exact[index - 1] || !exact[index - 2]) continue;
    const gap1 = samples[index].bar.time - samples[index - 1].bar.time;
    const gap2 = samples[index - 1].bar.time - samples[index - 2].bar.time;
    const sma3 = (exact[index].c1 + exact[index - 1].c1 + exact[index - 2].c1) / 3;
    rows.push({ gap1, gap2, diff: sma3 - exact[index].c2 });
  }
  return {
    all: summarizeDiffs(rows),
    contiguous5s: summarizeDiffs(rows.filter((row) => row.gap1 === 5000 && row.gap2 === 5000))
  };
}

function c2WeightedRecurrence() {
  const exact = buildExactFlashPointSeries(rows);
  const all = [];
  const contiguous5s = [];
  for (let index = 1; index < exact.length; index += 1) {
    const previous = exact[index - 1];
    const current = exact[index];
    const predicted = flashPointC2Recurrence(current.c1, previous.c1, previous.c2);
    const diff = predicted - current.c2;
    const row = { diff };
    all.push(row);
    if (current.time - previous.time === 5000) contiguous5s.push(row);
  }
  return {
    all: summarizeDiffs(all),
    contiguous5s: summarizeDiffs(contiguous5s)
  };
}

function summarizeDiffs(rows) {
  if (!rows.length) return { count: 0, rmse: Infinity, maxAbs: Infinity };
  let total = 0;
  let maxAbs = 0;
  for (const row of rows) {
    total += row.diff * row.diff;
    maxAbs = Math.max(maxAbs, Math.abs(row.diff));
  }
  return { count: rows.length, rmse: Math.sqrt(total / rows.length), maxAbs };
}

function summarizeGaps(items) {
  const gaps = {};
  for (let i = 1; i < items.length; i += 1) {
    const seconds = (items[i].bar.time - items[i - 1].bar.time) / 1000;
    gaps[seconds] = (gaps[seconds] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(gaps).sort((a, b) => Number(a[0]) - Number(b[0])));
}

function impliedC1Alpha(allRows, finalSamples) {
  const finalTimes = finalSamples.map((sample) => sample.bar.time);
  const exactRows = allRows
    .map((row) => ({ row, exact: extractExactFlashPoint(row) }))
    .filter((entry) => entry.exact && entry.row.bar);
  const results = [];

  for (const sourceName of Object.keys(PRICE_SOURCES)) {
    for (let rsvPeriod = 2; rsvPeriod <= 20; rsvPeriod += 1) {
      const alphas = [];
      for (const entry of exactRows) {
        const previousIndex = previousFinalIndex(finalTimes, entry.row.bar.time);
        if (previousIndex < rsvPeriod - 2) continue;
        const previousExact = extractExactFlashPoint(finalSamples[previousIndex]);
        const previousC1 = previousExact?.c1 ?? Number(finalSamples[previousIndex].flashPoint?.c1);
        const rsv = rsvFromPreviousFinals(finalSamples, previousIndex, entry.row.bar, rsvPeriod, sourceName);
        if (!Number.isFinite(previousC1) || !Number.isFinite(rsv) || Math.abs(rsv - previousC1) < 1e-9) continue;
        const alpha = (entry.exact.c1 - previousC1) / (rsv - previousC1);
        if (Number.isFinite(alpha) && alpha > -2 && alpha < 2) alphas.push(alpha);
      }
      if (alphas.length < 200) continue;
      results.push(alphaSummary(sourceName, rsvPeriod, alphas));
    }
  }

  return results.sort((a, b) => (a.q3 - a.q1) - (b.q3 - b.q1));
}

function previousFinalIndex(times, time) {
  let lo = 0;
  let hi = times.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid] < time) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function rsvFromPreviousFinals(finalSamples, previousIndex, currentBar, period, sourceName) {
  const source = PRICE_SOURCES[sourceName];
  const previousBars = finalSamples
    .slice(previousIndex - (period - 2), previousIndex + 1)
    .map((sample) => sample.bar);
  if (previousBars.length !== period - 1) return null;
  const bars = [...previousBars, currentBar];
  const highest = Math.max(...bars.map((bar) => bar.high));
  const lowest = Math.min(...bars.map((bar) => bar.low));
  const range = highest - lowest;
  if (!Number.isFinite(range) || range === 0) return 50;
  return ((source(currentBar) - lowest) / range) * 100;
}

function alphaSummary(sourceName, rsvPeriod, values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    sourceName,
    rsvPeriod,
    count: values.length,
    mean,
    median: sorted[Math.floor(sorted.length / 2)],
    q1: sorted[Math.floor(sorted.length * 0.25)],
    q3: sorted[Math.floor(sorted.length * 0.75)],
    sd: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
    inUnitInterval: values.filter((value) => value > 0 && value < 1).length
  };
}

function commonWeights(period) {
  return [...new Set([1, Math.max(1, Math.round(period / 2)), period])];
}
