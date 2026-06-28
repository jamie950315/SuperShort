const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PRICE_SOURCES,
  calculateRsv,
  ema,
  smoothAlpha,
  simpleMovingAverage,
  weightedMovingAverage,
  chineseSma,
  leastSquaresAffine2,
  rmse,
  rmseAtIndices,
  inferSmoothedInput,
  dedupeBarFinalSamples,
  extractExactFlashPoint,
  extractExactFlashPointPoints,
  buildExactFlashPointSeries,
  buildExactBarFinalTargets,
  flashPointC2Recurrence,
  calculateFlashPointC2FromC1,
  makeFastCandidates
} = require("../analysis/flash-point-model");

test("calculates stochastic RSV from recent OHLC bars", () => {
  const bars = [
    { high: 10, low: 5, close: 7 },
    { high: 12, low: 6, close: 9 },
    { high: 11, low: 4, close: 10 }
  ];

  assert.deepEqual(calculateRsv(bars, 2).map((value) => value === null ? null : Math.round(value * 100) / 100), [
    null,
    57.14,
    75
  ]);
});

test("calculates HLCC4 weighted close price source", () => {
  assert.equal(PRICE_SOURCES.hlcc4({ high: 12, low: 6, close: 10 }), 9.5);
});

test("calculates TradingView-style EMA seeded by first finite value", () => {
  const values = [null, 10, 20, 30];
  assert.deepEqual(ema(values, 3), [null, 10, 15, 22.5]);
});

test("calculates arbitrary alpha smoothing seeded by first finite value", () => {
  const values = [null, 10, 20, 30];
  assert.deepEqual(smoothAlpha(values, 0.25), [null, 10, 12.5, 16.875]);
});

test("calculates Chinese SMA smoothing seeded by first finite value", () => {
  const values = [null, 10, 20, 30];
  assert.deepEqual(chineseSma(values, 3, 1).map((value) => value === null ? null : Math.round(value * 1000) / 1000), [
    null,
    10,
    13.333,
    18.889
  ]);
});

test("calculates simple and weighted moving averages", () => {
  assert.deepEqual(simpleMovingAverage([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.deepEqual(weightedMovingAverage([1, 2, 3, 4], 3), [null, null, 14 / 6, 20 / 6]);
});

test("dedupes bar-final samples by bar time and keeps the latest observation", () => {
  const rows = [
    { reason: "crossing-event", bar: { time: 1, open: 1, high: 2, low: 1, close: 2, volume: 1 }, flashPoint: { c1: 10, c2: 9, readable: true } },
    { reason: "bar-final-observed", bar: { time: 1, open: 1, high: 2, low: 1, close: 2, volume: 1 }, flashPoint: { c1: 11, c2: 10, readable: true } },
    { reason: "bar-final-observed", bar: { time: 2, open: 2, high: 3, low: 2, close: 3, volume: 1 }, flashPoint: { c1: 12, c2: 11, readable: true } }
  ];

  assert.deepEqual(dedupeBarFinalSamples(rows).map((row) => row.flashPoint.c1), [11, 12]);
});

test("dedupes bar-final samples using same-socket instant bars when present", () => {
  const rows = [
    {
      reason: "bar-final-observed",
      bar: { time: 1, open: 1, high: 2, low: 1, close: 2, volume: 1 },
      instantBar: { time: 2, open: 2, high: 3, low: 2, close: 3, volume: 1 },
      flashPoint: { c1: 10, c2: 9, readable: true }
    }
  ];

  assert.equal(dedupeBarFinalSamples(rows)[0].bar.time, 2);
});

test("extracts exact Flash Point values from cached indicator series", () => {
  const row = {
    indicatorSeries: [{
      path: "p.1.l9uPDe.st",
      latest: {
        time: 1782000000000,
        values: [57.123456, 54.654321, 1e100]
      }
    }]
  };

  assert.deepEqual(extractExactFlashPoint(row), {
    c1: 57.123456,
    c2: 54.654321,
    path: "p.1.l9uPDe.st"
  });
});

test("skips ambiguous non-Flash Point indicator series", () => {
  const row = {
    flashPoint: { c1: 70, c2: 65, readable: true },
    indicatorSeries: [{
      path: "p.1.otherIndicator.st",
      latest: {
        time: 1782000000000,
        values: [30, 29]
      }
    }]
  };

  assert.equal(extractExactFlashPoint(row), null);
});

test("uses non-l9uPDe series only when it matches visible Flash Point values", () => {
  const row = {
    flashPoint: { c1: 57, c2: 55, readable: true },
    indicatorSeries: [{
      path: "p.1.dynamicFlashPoint.st",
      latest: {
        time: 1782000000000,
        values: [57.5, 54.5]
      }
    }]
  };

  assert.deepEqual(extractExactFlashPoint(row), {
    c1: 57.5,
    c2: 54.5,
    path: "p.1.dynamicFlashPoint.st"
  });
});

test("skips multiple matching non-l9uPDe Flash Point candidates", () => {
  const row = {
    flashPoint: { c1: 57, c2: 55, readable: true },
    indicatorSeries: [
      {
        path: "p.1.dynamicFlashPointA.st",
        latest: { time: 1782000000000, values: [57.5, 54.5] }
      },
      {
        path: "p.1.dynamicFlashPointB.st",
        latest: { time: 1782000000000, values: [56.5, 55.5] }
      }
    ]
  };

  assert.equal(extractExactFlashPoint(row), null);
});

test("extracts exact Flash Point history from recent indicator points", () => {
  const row = {
    indicatorSeries: [{
      path: "p.1.l9uPDe.st",
      latest: {
        time: 3,
        values: [30.5, 29.5]
      },
      recentPoints: [
        { time: 1, values: [10.5, 9.5] },
        { time: 2, values: [20.5, 19.5] }
      ]
    }]
  };

  assert.deepEqual(extractExactFlashPointPoints(row), [
    { time: 1, c1: 10.5, c2: 9.5, path: "p.1.l9uPDe.st" },
    { time: 2, c1: 20.5, c2: 19.5, path: "p.1.l9uPDe.st" },
    { time: 3, c1: 30.5, c2: 29.5, path: "p.1.l9uPDe.st" }
  ]);
});

test("extracts exact Flash Point values from same-socket instant indicator series", () => {
  const row = {
    instantIndicatorSeries: [{
      path: "p.1.l9uPDe.st",
      latest: { time: 4, values: [44.5, 43.5] }
    }],
    indicatorSeries: [{
      path: "p.1.l9uPDe.st",
      latest: { time: 3, values: [30.5, 29.5] }
    }]
  };

  assert.deepEqual(extractExactFlashPoint(row), {
    c1: 44.5,
    c2: 43.5,
    path: "p.1.l9uPDe.st"
  });
});

test("extracts exact Flash Point values from explicit instantFlashPoint", () => {
  const row = {
    instantFlashPoint: {
      time: 5,
      c1: 55.5,
      c2: 54.5,
      path: "p.1.l9uPDe.st"
    },
    instantIndicatorSeries: [{
      path: "p.1.l9uPDe.st",
      latest: { time: 4, values: [44.5, 43.5] }
    }]
  };

  assert.deepEqual(extractExactFlashPoint(row), {
    c1: 55.5,
    c2: 54.5,
    path: "p.1.l9uPDe.st",
    source: "instantFlashPoint"
  });
});

test("uses socket-aligned samples as exact bar targets", () => {
  const rows = [
    {
      reason: "socket-aligned",
      bar: { time: 1, open: 1, high: 2, low: 1, close: 2, volume: 1 },
      flashPoint: { c1: 10, c2: 9, readable: true },
      instantFlashPoint: { time: 1, c1: 10.5, c2: 9.5, path: "p.1.l9uPDe.st" }
    }
  ];

  const samples = dedupeBarFinalSamples(rows);
  const targets = buildExactBarFinalTargets(rows, samples);

  assert.equal(samples.length, 1);
  assert.deepEqual(targets.indices, [0]);
  assert.equal(targets.c1[0], 10.5);
});

test("aligns exact bar-final targets to deduped sample positions", () => {
  const rows = [
    { reason: "bar-final-observed", bar: { time: 1, open: 1, high: 2, low: 1, close: 2, volume: 1 }, flashPoint: { c1: 10, c2: 9, readable: true } },
    { reason: "bar-final-observed", bar: { time: 2, open: 2, high: 3, low: 2, close: 3, volume: 1 }, flashPoint: { c1: 20, c2: 19, readable: true }, indicatorSeries: [{ path: "p.1.l9uPDe.st", latest: { values: [20.5, 19.5] } }] }
  ];

  const samples = dedupeBarFinalSamples(rows);
  const targets = buildExactBarFinalTargets(rows, samples);

  assert.deepEqual(targets.indices, [1]);
  assert.equal(targets.c1[1], 20.5);
  assert.equal(targets.c2[1], 19.5);
});

test("aligns exact bar-final targets from recent indicator points", () => {
  const rows = [
    { reason: "bar-final-observed", bar: { time: 1, open: 1, high: 2, low: 1, close: 2, volume: 1 }, flashPoint: { c1: 10, c2: 9, readable: true } },
    { reason: "bar-final-observed", bar: { time: 2, open: 2, high: 3, low: 2, close: 3, volume: 1 }, flashPoint: { c1: 20, c2: 19, readable: true } },
    {
      reason: "bar-final-observed",
      bar: { time: 3, open: 3, high: 4, low: 3, close: 4, volume: 1 },
      flashPoint: { c1: 30, c2: 29, readable: true },
      indicatorSeries: [{
        path: "p.1.l9uPDe.st",
        latest: { time: 3, values: [30.5, 29.5] },
        recentPoints: [
          { time: 2, values: [20.5, 19.5] },
          { time: 3, values: [30.5, 29.5] }
        ]
      }]
    }
  ];

  const samples = dedupeBarFinalSamples(rows);
  const targets = buildExactBarFinalTargets(rows, samples);

  assert.deepEqual(targets.indices, [1, 2]);
  assert.equal(targets.c1[1], 20.5);
  assert.equal(targets.c2[2], 29.5);
});

test("builds a deduped exact Flash Point time series", () => {
  const rows = [
    {
      indicatorSeries: [{
        path: "p.1.l9uPDe.st",
        recentPoints: [
          { time: 2, values: [20, 19] },
          { time: 1, values: [10, 9] }
        ]
      }]
    },
    {
      indicatorSeries: [{
        path: "p.1.l9uPDe.st",
        latest: { time: 2, values: [21, 20] },
        recentPoints: [
          { time: 3, values: [30, 29] }
        ]
      }]
    }
  ];

  assert.deepEqual(buildExactFlashPointSeries(rows), [
    { time: 1, c1: 10, c2: 9, path: "p.1.l9uPDe.st" },
    { time: 2, c1: 21, c2: 20, path: "p.1.l9uPDe.st" },
    { time: 3, c1: 30, c2: 29, path: "p.1.l9uPDe.st" }
  ]);
});

test("calculates Flash Point C2 recurrence from current and previous C1", () => {
  assert.equal(flashPointC2Recurrence(30, 21, 20), (2 * 30 + 4 * 21 + 3 * 20) / 9);

  const predicted = calculateFlashPointC2FromC1([
    { c1: 21, c2: 20 },
    { c1: 30, c2: 29 }
  ]);

  assert.deepEqual(predicted, [null, (2 * 30 + 4 * 21 + 3 * 20) / 9]);
});

test("computes RMSE over finite paired values only", () => {
  assert.equal(rmse([1, 2, null, 4], [2, 2, 3, 6]), Math.sqrt((1 + 0 + 4) / 3));
});

test("computes shifted RMSE over selected indices", () => {
  const predicted = [99, 10, 20, 30];
  const expected = [10, 20, 30, 40];
  assert.equal(rmseAtIndices(predicted, expected, [1, 2], 0, 1), 0);
});

test("infers original input from alpha-smoothed values", () => {
  assert.equal(inferSmoothedInput(46, 30, 0.4), 70);
});

test("solves two-input affine least squares coefficients", () => {
  const rows = [
    { x1: 1, x2: 2, y: 2 * 1 + 3 * 2 + 4 },
    { x1: 2, x2: 1, y: 2 * 2 + 3 * 1 + 4 },
    { x1: 3, x2: 4, y: 2 * 3 + 3 * 4 + 4 },
    { x1: 5, x2: 2, y: 2 * 5 + 3 * 2 + 4 }
  ];

  const result = leastSquaresAffine2(rows.map((row) => [row.x1, row.x2]), rows.map((row) => row.y));
  assert.ok(Math.abs(result.coefficients[0] - 2) < 1e-9);
  assert.ok(Math.abs(result.coefficients[1] - 3) < 1e-9);
  assert.ok(Math.abs(result.coefficients[2] - 4) < 1e-9);
  assert.equal(result.count, 4);
});

test("creates a bounded fast candidate set with common short-cycle formulas", () => {
  const candidates = makeFastCandidates();
  assert.ok(candidates.length > 0);
  assert.ok(candidates.length < 50000);
  assert.ok(candidates.some((candidate) => {
    return candidate.name === "rsv-ema-ema" &&
      candidate.params.rsvPeriod === 5 &&
      candidate.params.c1Period === 3 &&
      candidate.params.c2Period === 3;
  }));
});
