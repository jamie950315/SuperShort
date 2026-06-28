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
    if (input.c1 <= input.c2 && input.c2 - input.c1 <= 5) score += 1;
    if (input.crossing === "up") score += 2;
    return score;
  }

  function bearScore(input, profile) {
    let score = 0;
    if (input.c1 >= profile.short.watchC1) score += 1;
    if (input.c1 >= profile.short.readyC1) score += 1;
    if (input.c1 < input.c2) score += 1;
    if (input.c1 >= input.c2 && input.c1 - input.c2 <= 5) score += 1;
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
