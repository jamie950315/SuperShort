const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseTradingViewFrames,
  extractBarsFromMessage,
  extractBarSeriesFromMessage,
  extractNumericSeriesFromMessage,
  extractFlashPointFromText,
  extractFlashPointFromVisibleTexts,
  detectCrossing
} = require("../core");

function frame(payload) {
  const text = JSON.stringify(payload);
  return `~m~${text.length}~m~${text}`;
}

test("parses TradingView framed WebSocket payloads", () => {
  const messages = parseTradingViewFrames(frame({ m: "one", p: [1] }) + "~m~4~m~~h~1" + frame({ m: "two", p: [2] }));
  assert.deepEqual(messages, [
    { m: "one", p: [1] },
    { m: "two", p: [2] }
  ]);
});

test("extracts OHLCV bars from TradingView series arrays", () => {
  const bars = extractBarsFromMessage({
    m: "timescale_update",
    p: ["cs_test", {
      s1: {
        s: [
          { i: 0, v: [1782000000, 100, 105, 99, 104, 1234] },
          { i: 1, v: [1782000060, 104, 108, 103, 107, 1500] }
        ]
      }
    }]
  });
  assert.deepEqual(bars, [
    { time: 1782000000000, open: 100, high: 105, low: 99, close: 104, volume: 1234 },
    { time: 1782000060000, open: 104, high: 108, low: 103, close: 107, volume: 1500 }
  ]);
});

test("extracts OHLCV bar series with TradingView object paths", () => {
  const series = extractBarSeriesFromMessage({
    m: "timescale_update",
    p: ["cs_test", {
      price_series: {
        s: [
          { i: 0, v: [1782000000, 100, 105, 99, 104, 1234] }
        ]
      }
    }]
  });

  assert.deepEqual(series, [{
    path: "p.1.price_series.s",
    points: [
      { time: 1782000000000, open: 100, high: 105, low: 99, close: 104, volume: 1234 }
    ]
  }]);
});

test("extracts OHLCV bars from column arrays", () => {
  const bars = extractBarsFromMessage({
    m: "timescale_update",
    p: ["cs_test", {
      sds_1: {
        t: [1782000000, 1782000060],
        o: [100, 104],
        h: [105, 108],
        l: [99, 103],
        c: [104, 107],
        v: [1234, 1500]
      }
    }]
  });
  assert.equal(bars.length, 2);
  assert.equal(bars[1].close, 107);
});

test("rejects TradingView placeholder and impossible OHLC values as bars", () => {
  const bars = extractBarsFromMessage({
    m: "timescale_update",
    p: ["cs_test", {
      indicator_like: {
        s: [
          { i: 0, v: [1782000000, 84.72, 89.5, 89.5, 89.5, 1e100] },
          { i: 1, v: [1782000005, 52.66, 75.49, 1e100, 1e100, 1e100] },
          { i: 2, v: [1782000010, 100, 95, 101, 98, 12] }
        ]
      },
      price: {
        s: [
          { i: 0, v: [1782000015, 64204.8, 64204.8, 64204.8, 64204.8, 0.052] }
        ]
      }
    }]
  });

  assert.deepEqual(bars, [
    { time: 1782000015000, open: 64204.8, high: 64204.8, low: 64204.8, close: 64204.8, volume: 0.052 }
  ]);
});

test("extracts non-OHLC numeric indicator series from TradingView messages", () => {
  const series = extractNumericSeriesFromMessage({
    m: "timescale_update",
    p: ["cs_test", {
      flash_point_fast: {
        s: [
          { i: 0, v: [1782000000, 77.06, 58.97] },
          { i: 1, v: [1782000060, 80.12, 61.45] }
        ]
      },
      price: {
        s: [
          { i: 0, v: [1782000000, 100, 105, 99, 104, 1234] }
        ]
      }
    }]
  });

  assert.deepEqual(series, [{
    path: "p.1.flash_point_fast.s",
    points: [
      { time: 1782000000000, values: [77.06, 58.97] },
      { time: 1782000060000, values: [80.12, 61.45] }
    ]
  }]);
});

test("extracts visible Flash Point Pro values and labels", () => {
  const parsed = extractFlashPointFromText("C1快线 77.06 C2慢线 58.97 金叉点外圈 43.23 死叉点内芯 22.22 加仓 卖");
  assert.equal(parsed.c1, 77.06);
  assert.equal(parsed.c2, 58.97);
  assert.equal(parsed.thresholds.goldenOuter, 43.23);
  assert.equal(parsed.thresholds.deathInner, 22.22);
  assert.deepEqual(parsed.signals, ["sell", "add"]);
  assert.equal(parsed.readable, true);
});

test("extracts C1 C2 from indicator legend split across visible text nodes", () => {
  const parsed = extractFlashPointFromVisibleTexts([
    "BTCUSDC.P",
    "Flash Point Pro超短线",
    "57.13",
    "54.65",
    "EMA",
    "202.11"
  ]);

  assert.equal(parsed.c1, 57.13);
  assert.equal(parsed.c2, 54.65);
  assert.equal(parsed.source, "indicator-legend");
  assert.equal(parsed.readable, true);
});

test("detects C1 C2 crossings", () => {
  assert.equal(detectCrossing({ c1: 40, c2: 41 }, { c1: 42, c2: 41 }), "up");
  assert.equal(detectCrossing({ c1: 42, c2: 41 }, { c1: 40, c2: 41 }), "down");
  assert.equal(detectCrossing({ c1: 42, c2: 41 }, { c1: 43, c2: 41 }), "none");
  assert.equal(detectCrossing({ c1: null, c2: 41 }, { c1: 43, c2: 41 }), "none");
});
