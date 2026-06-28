const fs = require("node:fs");

function loadJsonl(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  return text.split(/\n+/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${file} line ${index + 1}: ${error.message}`);
    }
  });
}

function isValidBar(bar) {
  if (!bar) return false;
  const nums = [bar.time, bar.open, bar.high, bar.low, bar.close];
  if (!nums.every(Number.isFinite)) return false;
  if (![bar.open, bar.high, bar.low, bar.close].every((value) => Math.abs(value) < 1e50)) return false;
  if (bar.volume !== null && bar.volume !== undefined && (!Number.isFinite(bar.volume) || Math.abs(bar.volume) >= 1e50)) {
    return false;
  }
  if (bar.high < Math.max(bar.open, bar.low, bar.close)) return false;
  if (bar.low > Math.min(bar.open, bar.high, bar.close)) return false;
  return true;
}

function sampleBar(row) {
  return isValidBar(row?.instantBar) ? row.instantBar : row?.bar;
}

function isExactSampleReason(reason) {
  return reason === "bar-final-observed" || reason === "stop-final-observed" || reason === "socket-aligned";
}

function dedupeBarFinalSamples(rows) {
  const byTime = new Map();
  for (const row of rows) {
    const bar = sampleBar(row);
    if (!row?.flashPoint?.readable || !isValidBar(bar)) continue;
    if (!isExactSampleReason(row.reason)) continue;
    byTime.set(bar.time, { ...row, bar });
  }
  return [...byTime.values()].sort((a, b) => a.bar.time - b.bar.time);
}

function extractExactFlashPoint(row) {
  const exact = extractExactFlashPointPoints(row).at(-1);
  if (!exact) return null;
  const { time, ...rest } = exact;
  return rest;
}

function extractExactFlashPointPoints(row) {
  const instantSeries = Array.isArray(row?.instantIndicatorSeries) ? row.instantIndicatorSeries : [];
  const cachedSeries = Array.isArray(row?.indicatorSeries) ? row.indicatorSeries : [];
  const series = [...cachedSeries, ...instantSeries];
  const byTime = new Map();
  const candidatesByTime = new Map();
  for (const entry of series) {
    const points = [];
    if (Array.isArray(entry.recentPoints)) points.push(...entry.recentPoints);
    if (entry.latest) points.push(entry.latest);
    for (const point of points) {
      const values = point?.values || [];
      const time = Number.isFinite(point?.time) ? point.time : row?.bar?.time;
      if (!Number.isFinite(time) || !looksLikeFlashPointValues(values) || !isStrongFlashPointSeries(entry, values, row)) continue;
      const candidates = candidatesByTime.get(time) || [];
      candidates.push({
        time,
        c1: values[0],
        c2: values[1],
        path: entry.path,
        score: scoreFlashPointSeries(entry, values, row)
      });
      candidatesByTime.set(time, candidates);
    }
  }
  for (const [time, candidates] of candidatesByTime.entries()) {
    const selected = selectFlashPointCandidate(candidates);
    if (!selected) continue;
    byTime.set(time, {
      time: selected.time,
      c1: selected.c1,
      c2: selected.c2,
      path: selected.path,
      score: selected.score
    });
  }
  const instant = row?.instantFlashPoint;
  const instantTime = Number.isFinite(instant?.time) ? instant.time : sampleBar(row)?.time;
  if (Number.isFinite(instantTime) && Number.isFinite(instant?.c1) && Number.isFinite(instant?.c2)) {
    byTime.set(instantTime, {
      time: instantTime,
      c1: instant.c1,
      c2: instant.c2,
      path: instant.path || "instantFlashPoint",
      source: "instantFlashPoint"
    });
  }
  return [...byTime.values()]
    .map(({ score, ...point }) => point)
    .sort((a, b) => a.time - b.time);
}

function looksLikeFlashPointValues(values) {
  return Array.isArray(values)
    && Number.isFinite(values[0])
    && Number.isFinite(values[1])
    && values[0] >= -20
    && values[0] <= 120
    && values[1] >= -20
    && values[1] <= 120;
}

function scoreFlashPointSeries(entry, values, row) {
  let score = 0;
  if (String(entry?.path || "").includes("l9uPDe")) score += 100;
  if (Number.isFinite(row?.flashPoint?.c1)) score -= Math.abs(values[0] - row.flashPoint.c1);
  if (Number.isFinite(row?.flashPoint?.c2)) score -= Math.abs(values[1] - row.flashPoint.c2);
  return score;
}

function isStrongFlashPointSeries(entry, values, row) {
  if (String(entry?.path || "").includes("l9uPDe")) return true;
  if (!Number.isFinite(row?.flashPoint?.c1) || !Number.isFinite(row?.flashPoint?.c2)) return false;
  return Math.abs(values[0] - row.flashPoint.c1) <= 2 && Math.abs(values[1] - row.flashPoint.c2) <= 2;
}

function selectFlashPointCandidate(candidates) {
  const explicit = candidates.filter((candidate) => String(candidate.path || "").includes("l9uPDe"));
  if (explicit.length) return explicit.sort((a, b) => b.score - a.score)[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function extractExactFlashPointAt(row, time) {
  const exact = extractExactFlashPointPoints(row).find((point) => point.time === time);
  if (!exact) return null;
  return {
    c1: exact.c1,
    c2: exact.c2,
    path: exact.path
  };
}

function buildExactFlashPointSeries(rows) {
  const byTime = new Map();
  for (const row of rows) {
    for (const point of extractExactFlashPointPoints(row)) {
      byTime.set(point.time, point);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function buildExactBarFinalTargets(rows, samples) {
  const exactByTime = new Map();
  for (const row of rows) {
    if (!isValidBar(sampleBar(row))) continue;
    if (!isExactSampleReason(row.reason)) continue;
    for (const exact of extractExactFlashPointPoints(row)) {
      exactByTime.set(exact.time, {
        c1: exact.c1,
        c2: exact.c2,
        path: exact.path
      });
    }
  }

  const c1 = new Array(samples.length).fill(null);
  const c2 = new Array(samples.length).fill(null);
  const indices = [];
  for (let index = 0; index < samples.length; index += 1) {
    const exact = exactByTime.get(samples[index]?.bar?.time);
    if (!exact) continue;
    c1[index] = exact.c1;
    c2[index] = exact.c2;
    indices.push(index);
  }

  return { c1, c2, indices };
}

const PRICE_SOURCES = {
  close: (bar) => bar.close,
  hlc3: (bar) => (bar.high + bar.low + bar.close) / 3,
  hlcc4: (bar) => (bar.high + bar.low + 2 * bar.close) / 4,
  hl2: (bar) => (bar.high + bar.low) / 2,
  ohlc4: (bar) => (bar.open + bar.high + bar.low + bar.close) / 4
};

function calculateRsv(bars, period, sourceName = "close") {
  const source = PRICE_SOURCES[sourceName] || PRICE_SOURCES.close;
  return bars.map((bar, index) => {
    if (index + 1 < period) return null;
    const window = bars.slice(index + 1 - period, index + 1);
    const highest = Math.max(...window.map((item) => item.high));
    const lowest = Math.min(...window.map((item) => item.low));
    const range = highest - lowest;
    if (!Number.isFinite(range) || range === 0) return 50;
    return ((source(bar) - lowest) / range) * 100;
  });
}

function ema(values, period) {
  return smoothAlpha(values, 2 / (period + 1));
}

function smoothAlpha(values, alpha) {
  let previous = null;
  return values.map((value) => {
    if (!Number.isFinite(value)) return null;
    if (previous === null) {
      previous = value;
    } else {
      previous = alpha * value + (1 - alpha) * previous;
    }
    return previous;
  });
}

function chineseSma(values, period, weight) {
  let previous = null;
  return values.map((value) => {
    if (!Number.isFinite(value)) return null;
    if (previous === null) {
      previous = value;
    } else {
      previous = (weight * value + (period - weight) * previous) / period;
    }
    return previous;
  });
}

function simpleMovingAverage(values, period) {
  return values.map((_, index) => {
    if (index + 1 < period) return null;
    const window = values.slice(index + 1 - period, index + 1);
    if (!window.every(Number.isFinite)) return null;
    return window.reduce((sum, value) => sum + value, 0) / period;
  });
}

function weightedMovingAverage(values, period) {
  const denominator = (period * (period + 1)) / 2;
  return values.map((_, index) => {
    if (index + 1 < period) return null;
    const window = values.slice(index + 1 - period, index + 1);
    if (!window.every(Number.isFinite)) return null;
    return window.reduce((sum, value, offset) => sum + value * (offset + 1), 0) / denominator;
  });
}

function rmse(actual, expected, startIndex = 0) {
  let total = 0;
  let count = 0;
  for (let i = startIndex; i < Math.min(actual.length, expected.length); i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (!Number.isFinite(a) || !Number.isFinite(e)) continue;
    const diff = a - e;
    total += diff * diff;
    count += 1;
  }
  return count ? Math.sqrt(total / count) : Infinity;
}

function rmseAtIndices(predicted, expected, indices, startIndex = 0, shift = 0) {
  let total = 0;
  let count = 0;
  for (const index of indices) {
    if (index < startIndex) continue;
    const predictedIndex = index + shift;
    const diff = predicted[predictedIndex] - expected[index];
    if (!Number.isFinite(diff)) continue;
    total += diff * diff;
    count += 1;
  }
  return count ? Math.sqrt(total / count) : Infinity;
}

function inferSmoothedInput(current, previous, alpha) {
  if (![current, previous, alpha].every(Number.isFinite) || alpha === 0) return NaN;
  return (current - (1 - alpha) * previous) / alpha;
}

function flashPointC2Recurrence(currentC1, previousC1, previousC2) {
  if (![currentC1, previousC1, previousC2].every(Number.isFinite)) return null;
  return (2 * currentC1 + 4 * previousC1 + 3 * previousC2) / 9;
}

function calculateFlashPointC2FromC1(points) {
  return points.map((point, index) => {
    if (index === 0) return null;
    return flashPointC2Recurrence(point.c1, points[index - 1].c1, points[index - 1].c2);
  });
}

function leastSquaresAffine2(inputs, outputs) {
  const matrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  const vector = [0, 0, 0];
  let count = 0;

  for (let i = 0; i < Math.min(inputs.length, outputs.length); i += 1) {
    const row = inputs[i];
    const y = outputs[i];
    if (!Array.isArray(row) || row.length < 2 || !Number.isFinite(row[0]) || !Number.isFinite(row[1]) || !Number.isFinite(y)) {
      continue;
    }
    const x = [row[0], row[1], 1];
    for (let r = 0; r < 3; r += 1) {
      vector[r] += x[r] * y;
      for (let c = 0; c < 3; c += 1) matrix[r][c] += x[r] * x[c];
    }
    count += 1;
  }

  return { coefficients: solve3x3(matrix, vector), count };
}

function solve3x3(matrix, vector) {
  const a = matrix.map((row) => row.slice());
  const b = vector.slice();
  for (let i = 0; i < 3; i += 1) {
    let pivot = i;
    for (let r = i + 1; r < 3; r += 1) {
      if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    }
    [a[i], a[pivot]] = [a[pivot], a[i]];
    [b[i], b[pivot]] = [b[pivot], b[i]];
    const divisor = a[i][i];
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-12) return [NaN, NaN, NaN];
    for (let c = i; c < 3; c += 1) a[i][c] /= divisor;
    b[i] /= divisor;
    for (let r = 0; r < 3; r += 1) {
      if (r === i) continue;
      const factor = a[r][i];
      for (let c = i; c < 3; c += 1) a[r][c] -= factor * a[i][c];
      b[r] -= factor * b[i];
    }
  }
  return b;
}

function evaluateCandidate(samples, candidate, warmup = 100) {
  const bars = samples.map((row) => row.bar);
  const expectedC1 = samples.map((row) => Number(row.flashPoint.c1));
  const expectedC2 = samples.map((row) => Number(row.flashPoint.c2));
  const predicted = candidate.predict(bars);
  const c1Rmse = rmse(predicted.c1, expectedC1, warmup);
  const c2Rmse = rmse(predicted.c2, expectedC2, warmup);
  return {
    name: candidate.name,
    params: candidate.params,
    c1Rmse,
    c2Rmse,
    totalRmse: Math.sqrt((c1Rmse * c1Rmse + c2Rmse * c2Rmse) / 2)
  };
}

function makeCandidates() {
  const candidates = [];
  for (let rsvPeriod = 2; rsvPeriod <= 30; rsvPeriod += 1) {
    for (let c1Period = 1; c1Period <= 15; c1Period += 1) {
      for (let c2Period = 1; c2Period <= 15; c2Period += 1) {
        candidates.push({
          name: "rsv-ema-ema",
          params: { rsvPeriod, c1Period, c2Period },
          predict(bars) {
            const rsv = calculateRsv(bars, rsvPeriod);
            const c1 = ema(rsv, c1Period);
            const c2 = ema(c1, c2Period);
            return { c1, c2 };
          }
        });
        candidates.push({
          name: "rsv-ema-sma-simple",
          params: { rsvPeriod, c1Period, c2Period },
          predict(bars) {
            const rsv = calculateRsv(bars, rsvPeriod);
            const c1 = ema(rsv, c1Period);
            const c2 = simpleMovingAverage(c1, c2Period);
            return { c1, c2 };
          }
        });
        candidates.push({
          name: "rsv-ema-wma",
          params: { rsvPeriod, c1Period, c2Period },
          predict(bars) {
            const rsv = calculateRsv(bars, rsvPeriod);
            const c1 = ema(rsv, c1Period);
            const c2 = weightedMovingAverage(c1, c2Period);
            return { c1, c2 };
          }
        });
        candidates.push({
          name: "rsv-ema-rsv-ema",
          params: { rsvPeriod, c1Period, c2Period },
          predict(bars) {
            const rsv = calculateRsv(bars, rsvPeriod);
            const c1 = ema(rsv, c1Period);
            const c2 = ema(rsv, c2Period);
            return { c1, c2 };
          }
        });
      }
    }
    for (let c1Period = 1; c1Period <= 15; c1Period += 1) {
      for (let c1Weight = 1; c1Weight <= c1Period; c1Weight += 1) {
        for (let c2Period = 1; c2Period <= 15; c2Period += 1) {
          for (let c2Weight = 1; c2Weight <= c2Period; c2Weight += 1) {
            candidates.push({
              name: "rsv-sma-sma",
              params: { rsvPeriod, c1Period, c1Weight, c2Period, c2Weight },
              predict(bars) {
                const rsv = calculateRsv(bars, rsvPeriod);
                const c1 = chineseSma(rsv, c1Period, c1Weight);
                const c2 = chineseSma(c1, c2Period, c2Weight);
                return { c1, c2 };
              }
            });
          }
        }
      }
    }
  }
  return candidates;
}

function makeFastCandidates() {
  const candidates = [];
  const rsvPeriods = range(3, 10);
  const sourceNames = ["close", "hlc3", "hl2", "ohlc4"];
  const smoothPeriods = range(1, 8);
  for (const sourceName of sourceNames) for (const rsvPeriod of rsvPeriods) {
    for (const c1Period of smoothPeriods) {
      for (const c2Period of smoothPeriods) {
        candidates.push({
          name: "rsv-ema-ema",
          params: { sourceName, rsvPeriod, c1Period, c2Period },
          predict(bars) {
            const rsv = calculateRsv(bars, rsvPeriod, sourceName);
            const c1 = ema(rsv, c1Period);
            const c2 = ema(c1, c2Period);
            return { c1, c2 };
          }
        });
      }
    }

    for (const c1Period of smoothPeriods) {
      for (const c2Period of smoothPeriods) {
        for (const c1Weight of commonWeights(c1Period)) {
          for (const c2Weight of commonWeights(c2Period)) {
            candidates.push({
              name: "rsv-sma-sma",
              params: { sourceName, rsvPeriod, c1Period, c1Weight, c2Period, c2Weight },
              predict(bars) {
                const rsv = calculateRsv(bars, rsvPeriod, sourceName);
                const c1 = chineseSma(rsv, c1Period, c1Weight);
                const c2 = chineseSma(c1, c2Period, c2Weight);
                return { c1, c2 };
              }
            });
            candidates.push({
              name: "rsv-ema-sma",
              params: { sourceName, rsvPeriod, c1Period, c2Period, c2Weight },
              predict(bars) {
                const rsv = calculateRsv(bars, rsvPeriod, sourceName);
                const c1 = ema(rsv, c1Period);
                const c2 = chineseSma(c1, c2Period, c2Weight);
                return { c1, c2 };
              }
            });
          }
        }
      }
    }
  }
  const alphas = [0.1, 0.125, 0.15, 0.1666666667, 0.2, 0.25, 0.3, 0.3333333333, 0.4, 0.5, 0.6, 0.6666666667, 0.75, 0.8, 0.9, 1];
  for (const sourceName of sourceNames) for (const rsvPeriod of rsvPeriods) {
    for (const c1Alpha of alphas) {
      for (const c2Alpha of alphas) {
        candidates.push({
          name: "rsv-alpha-alpha",
          params: { sourceName, rsvPeriod, c1Alpha, c2Alpha },
          predict(bars) {
            const rsv = calculateRsv(bars, rsvPeriod, sourceName);
            const c1 = smoothAlpha(rsv, c1Alpha);
            const c2 = smoothAlpha(c1, c2Alpha);
            return { c1, c2 };
          }
        });
      }
    }
  }
  return candidates;
}

function range(start, end) {
  const values = [];
  for (let value = start; value <= end; value += 1) values.push(value);
  return values;
}

function commonWeights(period) {
  return [...new Set([1, Math.max(1, Math.round(period / 2)), period])];
}

module.exports = {
  loadJsonl,
  isValidBar,
  PRICE_SOURCES,
  dedupeBarFinalSamples,
  extractExactFlashPoint,
  extractExactFlashPointPoints,
  extractExactFlashPointAt,
  buildExactFlashPointSeries,
  buildExactBarFinalTargets,
  calculateRsv,
  ema,
  smoothAlpha,
  simpleMovingAverage,
  weightedMovingAverage,
  chineseSma,
  rmse,
  rmseAtIndices,
  inferSmoothedInput,
  flashPointC2Recurrence,
  calculateFlashPointC2FromC1,
  leastSquaresAffine2,
  evaluateCandidate,
  makeCandidates,
  makeFastCandidates
};
