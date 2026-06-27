/*
 * Flash Point Pro exact algorithm implementation.
 * Ground truth source was provided by the indicator author on 2026-06-21.
 * This module mirrors the Pine v5 code, including EMA seeding, nz(fast_k[1]) behavior,
 * 0 denominator handling, and the 0.667 / 0.333 decimal coefficients.
 */
(function attachFlashPointAlgo(root) {
  const SENTINEL = 1e100;

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function round(value, digits = 8) {
    if (!isFiniteNumber(value)) return null;
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
  }

  function normalizeBar(bar) {
    const time = Number(bar.time);
    const open = Number(bar.open ?? bar.o);
    const high = Number(bar.high ?? bar.h);
    const low = Number(bar.low ?? bar.l);
    const close = Number(bar.close ?? bar.c);
    const volume = Number(bar.volume ?? bar.v ?? 0);
    if (![time, open, high, low, close].every(Number.isFinite)) return null;
    return { time, open, high, low, close, volume };
  }

  function highestHigh(bars, index, length) {
    let value = -Infinity;
    const start = Math.max(0, index - length + 1);
    for (let cursor = start; cursor <= index; cursor += 1) {
      value = Math.max(value, bars[cursor].high);
    }
    return value;
  }

  function lowestLow(bars, index, length) {
    let value = Infinity;
    const start = Math.max(0, index - length + 1);
    for (let cursor = start; cursor <= index; cursor += 1) {
      value = Math.min(value, bars[cursor].low);
    }
    return value;
  }

  function crossover(previousA, previousB, currentA, currentB) {
    return isFiniteNumber(previousA) && isFiniteNumber(previousB) && previousA <= previousB && currentA > currentB;
  }

  function crossunder(previousA, previousB, currentA, currentB) {
    return isFiniteNumber(previousA) && isFiniteNumber(previousB) && previousA >= previousB && currentA < currentB;
  }

  function estimateCrossValue(previousC1, previousC2, c1, c2, crossing) {
    if (crossing && isFiniteNumber(previousC1) && isFiniteNumber(previousC2)) {
      const previousDiff = previousC1 - previousC2;
      const currentDiff = c1 - c2;
      const denominator = currentDiff - previousDiff;
      const t = Math.abs(denominator) < 1e-12 ? 1 : Math.max(0, Math.min(1, -previousDiff / denominator));
      const value1 = previousC1 + (c1 - previousC1) * t;
      const value2 = previousC2 + (c2 - previousC2) * t;
      return (value1 + value2) / 2;
    }
    if (crossing === "up") return c1;
    if (crossing === "down") return c2;
    return null;
  }

  function computeFlashPoint(bars) {
    const sorted = bars
      .map(normalizeBar)
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);

    const out = [];
    let previousFastK = null;
    let previousSlowD = null;

    for (let index = 0; index < sorted.length; index += 1) {
      const bar = sorted[index];
      const periodLowest = lowestLow(sorted, index, 5);
      const periodHighest = highestHigh(sorted, index, 4);
      const priceRange = periodHighest - periodLowest;
      const typicalPrice = (2 * bar.close + bar.high + bar.low) / 4;
      const stochVal = priceRange === 0 ? 0 : ((typicalPrice - periodLowest) / priceRange) * 100;

      const fastK = previousFastK === null ? stochVal : 0.4 * stochVal + 0.6 * previousFastK;
      const slowDBase = 0.667 * (previousFastK ?? 0) + 0.333 * fastK;
      const slowD = previousSlowD === null ? slowDBase : (2 / 3) * slowDBase + (1 / 3) * previousSlowD;

      const crossGold = crossover(previousFastK, previousSlowD, fastK, slowD);
      const crossDead = crossunder(previousFastK, previousSlowD, fastK, slowD);
      const crossing = crossGold ? "up" : crossDead ? "down" : null;
      const crossValue = estimateCrossValue(previousFastK, previousSlowD, fastK, slowD, crossing);
      const condBuy = crossGold && fastK < 40;
      const condSellStrict = crossDead && fastK > 90;

      const tags = [];
      if (crossGold) {
        tags.push({ tag: "加倉", kind: "goldenCross", markerValue: fastK, lineValue: fastK, value: crossValue, source: "exact-original" });
      }
      if (crossDead) {
        tags.push({ tag: "賣", kind: "deathCross", markerValue: slowD, lineValue: slowD, value: crossValue, source: "exact-original" });
      }
      if (condBuy) {
        tags.push({ tag: "買", kind: "lowBuy", markerValue: 20, lineValue: fastK, value: crossValue, source: "exact-original" });
      }
      if (condSellStrict) {
        tags.push({ tag: "賣", kind: "highSell", markerValue: 85, lineValue: fastK, value: crossValue, source: "exact-original" });
      }

      const values = [
        fastK,
        slowD,
        crossDead ? slowD : SENTINEL,
        crossDead ? slowD : SENTINEL,
        crossGold ? fastK : SENTINEL,
        crossGold ? fastK : SENTINEL,
        crossGold ? fastK : SENTINEL,
        crossDead ? slowD : SENTINEL,
        condBuy ? 20 : SENTINEL,
        condSellStrict ? 85 : SENTINEL,
        crossGold ? fastK : SENTINEL,
        crossDead ? slowD : SENTINEL
      ];

      out.push({
        ...bar,
        typicalPrice: round(typicalPrice),
        periodLowest: round(periodLowest),
        periodHighest: round(periodHighest),
        stochVal: round(stochVal),
        rsv: round(stochVal),
        slowDBase: round(slowDBase),
        fastK: round(fastK),
        slowD: round(slowD),
        c1: round(fastK),
        c2: round(slowD),
        crossing,
        crossValue: round(crossValue),
        tags: tags.map((item) => ({
          ...item,
          markerValue: round(item.markerValue),
          lineValue: round(item.lineValue),
          value: round(item.value)
        })),
        values: values.map((value) => value === SENTINEL ? value : round(value))
      });

      previousFastK = fastK;
      previousSlowD = slowD;
    }

    return out;
  }

  function computeLatest(bars) {
    const out = computeFlashPoint(bars);
    return out.length ? out[out.length - 1] : null;
  }

  const api = {
    SENTINEL,
    computeFlashPoint,
    computeLatest,
    formula: {
      source: "Author-provided Pine v5 source code",
      typicalPrice: "(2 * close + high + low) / 4",
      periodLowest: "ta.lowest(low, 5)",
      periodHighest: "ta.highest(high, 4)",
      stochVal: "price_range == 0 ? 0 : ((typical_price - period_lowest) / price_range) * 100",
      fastK: "ta.ema(stoch_val, 4)",
      slowDBase: "0.667 * nz(fast_k[1]) + 0.333 * fast_k",
      slowD: "ta.ema(slow_d_base, 2)",
      crossGold: "ta.crossover(fast_k, slow_d)",
      crossDead: "ta.crossunder(fast_k, slow_d)",
      condBuy: "cross_gold and fast_k < 40",
      condSellStrict: "cross_dead and fast_k > 90",
      markerValues: {
        goldenCross: "fast_k",
        deathCross: "slow_d",
        lowBuy: 20,
        highSell: 85
      }
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CrossingFetchFlashPointAlgo = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
