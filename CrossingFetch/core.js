(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CrossingFetchCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function parseTradingViewFrames(input) {
    if (typeof input !== "string" || !input) return [];

    if (!input.includes("~m~")) {
      const parsed = tryParseJson(input);
      return parsed ? [parsed] : [];
    }

    const messages = [];
    let cursor = 0;
    while (cursor < input.length) {
      const marker = input.indexOf("~m~", cursor);
      if (marker === -1) break;
      const lengthStart = marker + 3;
      const lengthEnd = input.indexOf("~m~", lengthStart);
      if (lengthEnd === -1) break;

      const length = Number(input.slice(lengthStart, lengthEnd));
      if (!Number.isFinite(length) || length < 0) {
        cursor = lengthEnd + 3;
        continue;
      }

      const payloadStart = lengthEnd + 3;
      const payload = input.slice(payloadStart, payloadStart + length);
      cursor = payloadStart + length;

      if (!payload || payload.startsWith("~h~")) continue;
      const parsed = tryParseJson(payload);
      if (parsed) messages.push(parsed);
    }
    return messages;
  }

  function extractBarsFromMessage(message) {
    if (!message || typeof message !== "object") return [];
    const bars = [];
    const seen = new Set();

    walk(message, (value) => {
      for (const bar of barsFromColumnObject(value)) addBar(bar);
      for (const bar of barsFromSeriesArray(value)) addBar(bar);
    });

    return bars.sort((a, b) => a.time - b.time);

    function addBar(bar) {
      if (!bar || !Number.isFinite(bar.time)) return;
      const key = String(bar.time);
      if (seen.has(key)) return;
      seen.add(key);
      bars.push(bar);
    }
  }

  function extractBarSeriesFromMessage(message) {
    if (!message || typeof message !== "object") return [];
    const series = [];

    walkWithPath(message, (value, path) => {
      const points = barsFromColumnObject(value);
      if (points.length) {
        series.push({ path: path.join("."), points });
        return;
      }
      if (!Array.isArray(value)) return;
      const arrayPoints = barsFromSeriesArray(value);
      if (arrayPoints.length) {
        series.push({ path: path.join("."), points: arrayPoints });
      }
    });

    return series;
  }

  function extractNumericSeriesFromMessage(message) {
    if (!message || typeof message !== "object") return [];
    const series = [];

    walkWithPath(message, (value, path) => {
      if (!Array.isArray(value)) return;
      const points = [];
      for (const item of value) {
        if (!item || typeof item !== "object" || !Array.isArray(item.v)) continue;
        if (looksLikeOhlcv(item.v)) continue;
        const point = normalizeNumericPoint(item.v);
        if (point) points.push(point);
      }
      if (points.length) {
        series.push({
          path: path.join("."),
          points
        });
      }
    });

    return series;
  }

  function extractFlashPointFromText(text) {
    const body = String(text || "").replace(/\s+/g, " ").trim();
    const c1 = readNamedNumber(body, /C1\s*(?:快线|快線)?\s*([-+]?\d+(?:\.\d+)?)/i);
    const c2 = readNamedNumber(body, /C2\s*(?:慢线|慢線)?\s*([-+]?\d+(?:\.\d+)?)/i);
    const thresholds = {
      goldenOuter: readNamedNumber(body, /金叉点外圈\s*([-+]?\d+(?:\.\d+)?)/),
      goldenInner: readNamedNumber(body, /金叉点内芯\s*([-+]?\d+(?:\.\d+)?)/),
      deathOuter: readNamedNumber(body, /死叉点外圈\s*([-+]?\d+(?:\.\d+)?)/),
      deathInner: readNamedNumber(body, /死叉点内芯\s*([-+]?\d+(?:\.\d+)?)/)
    };
    const signals = [];
    if (/(?:^|[\s:：])(?:买|買)(?:$|[\s:：])/.test(body)) signals.push("buy");
    if (/(?:^|[\s:：])(?:卖|賣)(?:$|[\s:：])/.test(body)) signals.push("sell");
    if (/加(?:仓|倉)/.test(body)) signals.push("add");

    return {
      c1,
      c2,
      readable: Number.isFinite(c1) || Number.isFinite(c2),
      thresholds,
      signals: Array.from(new Set(signals))
    };
  }

  function extractFlashPointFromVisibleTexts(texts, indicatorName) {
    const nodes = Array.isArray(texts)
      ? texts.map((text) => String(text || "").replace(/\s+/g, " ").trim()).filter(Boolean)
      : [];
    const name = indicatorName || "Flash Point Pro";
    const index = nodes.findIndex((text) => text.includes(name));
    if (index === -1) return emptyFlashPoint("indicator-legend");

    const values = [];
    for (let i = index + 1; i < Math.min(nodes.length, index + 80); i += 1) {
      const matches = nodes[i].match(/[+-]?\d+(?:\.\d+)?/g);
      if (!matches) continue;
      for (const raw of matches) {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0 && value <= 100) values.push(value);
        if (values.length >= 2) {
          return {
            ...extractFlashPointFromText(nodes.join(" ")),
            c1: values[0],
            c2: values[1],
            readable: true,
            source: "indicator-legend"
          };
        }
      }
    }

    return emptyFlashPoint("indicator-legend");
  }

  function detectCrossing(previous, current) {
    if (!hasNumber(previous, "c1") || !hasNumber(previous, "c2") || !hasNumber(current, "c1") || !hasNumber(current, "c2")) {
      return "none";
    }
    const prevC1 = Number(previous.c1);
    const prevC2 = Number(previous.c2);
    const currC1 = Number(current.c1);
    const currC2 = Number(current.c2);
    if (![prevC1, prevC2, currC1, currC2].every(Number.isFinite)) return "none";
    if (prevC1 <= prevC2 && currC1 > currC2) return "up";
    if (prevC1 >= prevC2 && currC1 < currC2) return "down";
    return "none";
  }

  function normalizeNumericPoint(values) {
    if (!Array.isArray(values) || values.length < 2) return null;
    const time = normalizeTime(values[0]);
    const numericValues = values.slice(1).map(Number).filter(Number.isFinite);
    if (!Number.isFinite(time) || !numericValues.length) return null;
    return { time, values: numericValues };
  }

  function looksLikeOhlcv(values) {
    if (!Array.isArray(values) || values.length < 5) return false;
    const normalized = normalizeBar(values);
    return Boolean(normalized);
  }

  function hasNumber(object, key) {
    return object && object[key] !== null && object[key] !== undefined && object[key] !== "" && Number.isFinite(Number(object[key]));
  }

  function barsFromColumnObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const t = value.t;
    const o = value.o;
    const h = value.h;
    const l = value.l;
    const c = value.c;
    if (![t, o, h, l, c].every(Array.isArray)) return [];

    const count = Math.min(t.length, o.length, h.length, l.length, c.length);
    const volume = Array.isArray(value.v) ? value.v : [];
    const bars = [];
    for (let i = 0; i < count; i += 1) {
      const bar = normalizeBar([t[i], o[i], h[i], l[i], c[i], volume[i]]);
      if (bar) bars.push(bar);
    }
    return bars;
  }

  function barsFromSeriesArray(value) {
    if (!Array.isArray(value)) return [];
    const bars = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || !Array.isArray(item.v)) continue;
      const bar = normalizeBar(item.v);
      if (bar) bars.push(bar);
    }
    return bars;
  }

  function normalizeBar(values) {
    if (!Array.isArray(values) || values.length < 5) return null;
    const time = normalizeTime(values[0]);
    const open = Number(values[1]);
    const high = Number(values[2]);
    const low = Number(values[3]);
    const close = Number(values[4]);
    const volume = values[5] === undefined || values[5] === null ? null : Number(values[5]);
    if (![time, open, high, low, close].every(Number.isFinite)) return null;
    if (![open, high, low, close].every(isReasonableMarketNumber)) return null;
    if (volume !== null && (!Number.isFinite(volume) || !isReasonableMarketNumber(volume))) return null;
    if (high < Math.max(open, low, close)) return null;
    if (low > Math.min(open, high, close)) return null;
    return {
      time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : null
    };
  }

  function normalizeTime(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NaN;
    return n < 100000000000 ? n * 1000 : n;
  }

  function isReasonableMarketNumber(value) {
    return Number.isFinite(value) && Math.abs(value) < 1e50;
  }

  function walk(value, visit, depth) {
    const level = depth || 0;
    if (level > 12 || value === null || value === undefined) return;
    visit(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit, level + 1);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) walk(item, visit, level + 1);
    }
  }

  function walkWithPath(value, visit, path, depth) {
    const currentPath = path || [];
    const level = depth || 0;
    if (level > 12 || value === null || value === undefined) return;
    visit(value, currentPath);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        walkWithPath(value[i], visit, currentPath.concat(String(i)), level + 1);
      }
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        walkWithPath(item, visit, currentPath.concat(key), level + 1);
      }
    }
  }

  function readNamedNumber(text, regex) {
    const match = text.match(regex);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isFinite(n) ? n : null;
  }

  function emptyFlashPoint(source) {
    return {
      c1: null,
      c2: null,
      readable: false,
      source,
      thresholds: {
        goldenOuter: null,
        goldenInner: null,
        deathOuter: null,
        deathInner: null
      },
      signals: []
    };
  }

  function tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  return {
    parseTradingViewFrames,
    extractBarsFromMessage,
    extractBarSeriesFromMessage,
    extractNumericSeriesFromMessage,
    extractFlashPointFromText,
    extractFlashPointFromVisibleTexts,
    detectCrossing
  };
});
