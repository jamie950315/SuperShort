const DEFAULTS = {
  apiKey: "",
  apiSecret: "",
  baseUrl: "https://fapi.binance.com",
  quoteAmount: "100",
  leverage: 20,
  offsetTicks: 0,
  exitChaseRetries: 2,
  autoSettlementEnabled: false,
  autoSettlementRoiPct: "1",
  slOrderEnabled: false,
  slOrderRoiPct: "1",
  profitOnlySettlementEnabled: false,
  pendingSettlementIndex: {},
  dryRun: true,
  autoReduceOnly: true,
  replaceReduceOnly: true,
  recvWindow: 5000,
  exitOrderIndex: {},
  pendingSettlementFillIndex: {}
};

const EXTENSION_VERSION = "0.4.4";
const EXCHANGE_INFO_CACHE = new Map();
const POSITION_CACHE = new Map();
const POSITION_CACHE_TTL_MS = 30000;
const REST_BAN_STATE = {
  until: 0,
  message: ""
};
const TEXT_ENCODER = new TextEncoder();
let EXIT_ORDER_INDEX_CACHE = null;
let EXIT_ORDER_INDEX_WRITE_TIMER = null;
let PENDING_SETTLEMENT_INDEX_CACHE = null;
let PENDING_SETTLEMENT_INDEX_WRITE_TIMER = null;
let PENDING_SETTLEMENT_FILL_INDEX_CACHE = null;
const PENDING_SETTLEMENT_WATCHERS = new Map();
const PENDING_SETTLEMENT_PROCESSING = new Set();
const AUTO_SETTLEMENT_FAST_POLL_MS = 120;
const AUTO_SETTLEMENT_FAST_WINDOW_MS = 3500;
const AUTO_SETTLEMENT_SLOW_POLL_MS = 1000;
const AUTO_SETTLEMENT_SLOW_WINDOW_MS = 30000;
const AUTO_SETTLEMENT_RETRY_COOLDOWN_MS = 1500;
const USER_STREAM_KEEPALIVE_MS = 50 * 60 * 1000;
const USER_STREAM_RECONNECT_BASE_MS = 1000;
const USER_STREAM_RECONNECT_MAX_MS = 30000;
const MARKET_STREAM_RECONNECT_BASE_MS = 1000;
const MARKET_STREAM_RECONNECT_MAX_MS = 30000;
const MARKET_STREAM_STALE_TIMEOUT_MS = 15000;
const MARKET_STREAM_WATCHDOG_INTERVAL_MS = 5000;
const ENTRY_MAKER_RETRY_LIMIT = 5;
const MARKET_BOOK_CACHE = new Map();
const MARKET_STREAM_STATE = {
  status: "idle",
  baseUrl: "",
  symbol: "",
  wsUrl: "",
  ws: null,
  reconnectTimer: null,
  watchdogTimer: null,
  reconnectAttempt: 0,
  nextReconnectAt: 0,
  connectedAt: 0,
  lastEventAt: 0,
  lastError: "",
  fallbackReason: "not started"
};
const USER_STREAM_STATE = {
  status: "idle",
  mode: "rest",
  baseUrl: "",
  apiKey: "",
  listenKey: "",
  wsUrl: "",
  ws: null,
  keepAliveTimer: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  startedAt: 0,
  connectedAt: 0,
  lastEventAt: 0,
  lastError: "",
  fallbackReason: "not started"
};
let HMAC_SECRET_CACHE = "";
let HMAC_KEY_CACHE = null;

chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (current[k] === undefined) patch[k] = v;
  }
  if (shouldResetPendingSettlementsOnInstall(details?.previousVersion, EXTENSION_VERSION)) {
    patch.pendingSettlementIndex = {};
    patch.pendingSettlementFillIndex = {};
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "GET_CONFIG") {
        sendResponse({ ok: true, config: await getConfigSafe() });
        return;
      }
      if (msg.type === "SAVE_CONFIG") {
        await chrome.storage.local.set(cleanConfig(msg.config || {}));
        sendResponse({ ok: true, config: await getConfigSafe() });
        return;
      }
      if (msg.type === "WARMUP_SYMBOL") {
        warmupSymbol(msg.symbol).catch(() => {});
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "GET_MARKET_TICKER") {
        const result = await getMarketTickerForMessage({ symbol: msg.symbol });
        sendResponse({ ok: true, result });
        return;
      }
      if (msg.type === "GET_TRADING_SNAPSHOT") {
        const result = await getTradingSnapshot({ symbol: msg.symbol });
        sendResponse({ ok: true, result });
        return;
      }
      if (msg.type === "PLACE_MAKER_ORDER") {
        const result = await placeMakerOrder({
          side: msg.side,
          symbol: msg.symbol,
          quoteAmount: msg.quoteAmount,
          leverage: msg.leverage,
          offsetTicks: msg.offsetTicks,
          exitChaseRetries: msg.exitChaseRetries,
          autoSettlementEnabled: msg.autoSettlementEnabled,
          autoSettlementRoiPct: msg.autoSettlementRoiPct,
          slOrderEnabled: msg.slOrderEnabled,
          slOrderRoiPct: msg.slOrderRoiPct,
          profitOnlySettlementEnabled: msg.profitOnlySettlementEnabled,
          autoReduceOnly: msg.autoReduceOnly,
          replaceReduceOnly: msg.replaceReduceOnly,
          dryRun: msg.dryRun
        });
        sendResponse({ ok: true, result });
        return;
      }
      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err), code: err?.code });
    }
  })();
  return true;
});

async function getConfigRaw() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

async function getConfigSafe() {
  const config = await getConfigRaw();
  return {
    ...config,
    apiSecret: config.apiSecret ? "********" : "",
    apiKeyMasked: config.apiKey ? mask(config.apiKey) : "",
    exitOrderIndex: undefined
  };
}

function cleanConfig(input) {
  const out = {};
  if (typeof input.apiKey === "string") out.apiKey = input.apiKey.trim();
  if (typeof input.apiSecret === "string" && input.apiSecret !== "********") out.apiSecret = input.apiSecret.trim();
  if (input.baseUrl === "https://fapi.binance.com" || input.baseUrl === "https://testnet.binancefuture.com") out.baseUrl = input.baseUrl;
  if (input.quoteAmount !== undefined) out.quoteAmount = String(input.quoteAmount).trim();
  if (input.leverage !== undefined) out.leverage = clampLeverage(input.leverage);
  if (input.offsetTicks !== undefined) out.offsetTicks = Math.max(0, Math.floor(Number(input.offsetTicks) || 0));
  if (input.exitChaseRetries !== undefined) out.exitChaseRetries = Math.min(5, Math.max(0, Math.floor(Number(input.exitChaseRetries) || 0)));
  if (input.autoSettlementEnabled !== undefined) out.autoSettlementEnabled = Boolean(input.autoSettlementEnabled);
  if (input.autoSettlementRoiPct !== undefined) out.autoSettlementRoiPct = normalizeRoiPct(input.autoSettlementRoiPct);
  if (input.slOrderEnabled !== undefined) out.slOrderEnabled = Boolean(input.slOrderEnabled);
  if (input.slOrderRoiPct !== undefined) out.slOrderRoiPct = normalizeRoiPct(input.slOrderRoiPct);
  if (input.profitOnlySettlementEnabled !== undefined) out.profitOnlySettlementEnabled = Boolean(input.profitOnlySettlementEnabled);
  if (input.dryRun !== undefined) out.dryRun = Boolean(input.dryRun);
  if (input.autoReduceOnly !== undefined) out.autoReduceOnly = Boolean(input.autoReduceOnly);
  if (input.replaceReduceOnly !== undefined) out.replaceReduceOnly = Boolean(input.replaceReduceOnly);
  if (input.recvWindow !== undefined) out.recvWindow = Math.max(1000, Math.floor(Number(input.recvWindow) || 5000));
  return out;
}

function mask(s) {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function clampLeverage(value) {
  const n = Math.floor(Number(value) || DEFAULTS.leverage);
  return Math.min(125, Math.max(1, n));
}

function normalizeRoiPct(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : Number(DEFAULTS.autoSettlementRoiPct);
  return String(Math.min(100, Math.max(0.01, safe)));
}

function shouldResetPendingSettlementsOnInstall(previousVersion, currentVersion) {
  if (!previousVersion) return false;
  return compareVersions(previousVersion, currentVersion) < 0 && compareVersions(previousVersion, "0.3.2") < 0;
}

function compareVersions(a, b) {
  const left = String(a || "0").split(".").map(n => Number(n) || 0);
  const right = String(b || "0").split(".").map(n => Number(n) || 0);
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function warmupSymbol(symbol) {
  const config = await getConfigRaw();
  if (!symbol) return;
  symbol = normalizeSymbol(symbol);
  const tasks = [getSymbolFilters(config.baseUrl, symbol)];
  tasks.push(ensureMarketStreamForSymbol(config, symbol));
  if (config.apiSecret) tasks.push(getHmacKey(config.apiSecret));
  if (config.apiKey && config.apiSecret) tasks.push(refreshExitOrderIndex(config, symbol));
  if (config.apiKey && config.apiSecret && !config.dryRun) {
    tasks.push(ensureUserStreamForConfig(config));
  }
  await Promise.allSettled(tasks);
}

async function placeMakerOrder({ side, symbol, quoteAmount, leverage, offsetTicks, exitChaseRetries, autoSettlementEnabled, autoSettlementRoiPct, slOrderEnabled, slOrderRoiPct, profitOnlySettlementEnabled, autoReduceOnly, replaceReduceOnly, dryRun }) {
  const config = await getConfigRaw();
  if (!config.apiKey || !config.apiSecret) throw new Error("API key/secret not configured");
  if (side !== "BUY" && side !== "SELL") throw new Error("side must be BUY or SELL");

  symbol = normalizeSymbol(symbol);
  quoteAmount = Number(quoteAmount || config.quoteAmount);
  if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) throw new Error("Invalid original amount");

  leverage = clampLeverage(leverage ?? config.leverage);
  const effectiveQuoteAmount = quoteAmount * leverage;
  if (!Number.isFinite(effectiveQuoteAmount) || effectiveQuoteAmount <= 0) throw new Error("Invalid leveraged notional amount");

  const effectiveAutoReduceOnly = autoReduceOnly === undefined ? Boolean(config.autoReduceOnly) : Boolean(autoReduceOnly);
  const effectiveReplaceReduceOnly = replaceReduceOnly === undefined ? Boolean(config.replaceReduceOnly) : Boolean(replaceReduceOnly);
  const effectiveExitChaseRetries = Math.min(5, Math.max(0, Math.floor(Number(exitChaseRetries ?? config.exitChaseRetries) || 0)));
  const effectiveAutoSettlementEnabled = autoSettlementEnabled === undefined ? Boolean(config.autoSettlementEnabled) : Boolean(autoSettlementEnabled);
  const effectiveAutoSettlementRoiPct = Number(normalizeRoiPct(autoSettlementRoiPct ?? config.autoSettlementRoiPct));
  const effectiveSlOrderEnabled = slOrderEnabled === undefined ? Boolean(config.slOrderEnabled) : Boolean(slOrderEnabled);
  const effectiveSlOrderRoiPct = Number(normalizeRoiPct(slOrderRoiPct ?? config.slOrderRoiPct));
  const effectiveProfitOnlySettlementEnabled = profitOnlySettlementEnabled === undefined
    ? Boolean(config.profitOnlySettlementEnabled)
    : Boolean(profitOnlySettlementEnabled);

  // Start a live open-orders reconciliation early when the short-lived position cache
  // says this click is likely an exit. If the cache is unavailable or wrong, we will
  // still do the live query after the fresh positionRisk response confirms reduce-only.
  const cachedPositionResult = readPositionCache(config, symbol);
  const likelyReduceOnlyExit = effectiveAutoReduceOnly && effectiveReplaceReduceOnly &&
    cachedPositionResult && wouldReducePosition(side, cachedPositionResult.position);
  const liveReplacementIdsPromise = likelyReduceOnlyExit
    ? getLiveReplaceableExitOrderIdsSafe(config, symbol, side)
    : null;

  const [filters, book, position] = await Promise.all([
    getSymbolFilters(config.baseUrl, symbol),
    publicGet(config.baseUrl, "/fapi/v1/ticker/bookTicker", { symbol }),
    getOneWayPosition(config, symbol)
  ]);
  const positionResult = { position, source: "rest", ageMs: 0 };

  const bid = Number(book.bidPrice);
  const ask = Number(book.askPrice);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid >= ask) {
    throw new Error(`Invalid book ticker: bid=${book.bidPrice}, ask=${book.askPrice}`);
  }

  const effectiveOffsetTicks = Math.max(0, Math.floor(Number(offsetTicks ?? config.offsetTicks) || 0));
  const makerTicks = effectiveOffsetTicks + 1;
  const makerPrice = calculateMakerPriceFromBook({ side, book, filters, makerTicks });
  const price = makerPrice.price;

  let reduceOnly = false;
  const qtyByQuote = Number(effectiveQuoteAmount) / Number(price);
  let qtyRaw = qtyByQuote;

  let sizingMode = "INPUT_NOTIONAL";

  if (effectiveAutoReduceOnly) {
    if (side === "BUY" && position.positionAmt < 0) {
      reduceOnly = true;
      qtyRaw = Math.abs(position.positionAmt);
      sizingMode = "FULL_POSITION_EXIT";
    } else if (side === "SELL" && position.positionAmt > 0) {
      reduceOnly = true;
      qtyRaw = position.positionAmt;
      sizingMode = "FULL_POSITION_EXIT";
    }
  }

  const quantity = floorToStep(qtyRaw, filters.stepSize);
  const quantityNum = Number(quantity);
  const protectedInitialPrice = reduceOnly
    ? protectProfitOnlySettlementPrice({
        enabled: effectiveProfitOnlySettlementEnabled,
        side,
        price,
        position,
        filters
      })
    : { price, adjusted: false, breakEvenPrice: null };
  const priceNum = Number(protectedInitialPrice.price);
  const notional = quantityNum * priceNum;
  if (quantityNum <= 0) throw new Error(`Quantity rounds to zero. stepSize=${filters.stepSize}`);
  if (quantityNum < Number(filters.minQty)) throw new Error(`Quantity ${quantity} < minQty ${filters.minQty}`);
  if (Number(filters.maxQty) > 0 && quantityNum > Number(filters.maxQty)) throw new Error(`Quantity ${quantity} > maxQty ${filters.maxQty}`);
  if (Number(filters.minNotional) > 0 && notional < Number(filters.minNotional)) throw new Error(`Notional ${notional.toFixed(8)} < minNotional ${filters.minNotional}`);

  let autoSettlementPlan = !reduceOnly && effectiveAutoSettlementEnabled
    ? buildAutoSettlementPlan({
        symbol,
        entrySide: side,
        entryPrice: protectedInitialPrice.price,
        quantity,
        originalAmount: quoteAmount,
        leverage,
        roiPct: effectiveAutoSettlementRoiPct,
        filters,
        makerTicks
      })
    : { enabled: false, reason: reduceOnly ? "reduce-only exit" : "disabled" };
  let slOrderPlan = !reduceOnly && effectiveSlOrderEnabled
    ? buildSlOrderPlan({
        symbol,
        entrySide: side,
        entryPrice: protectedInitialPrice.price,
        quantity,
        originalAmount: quoteAmount,
        leverage,
        roiPct: effectiveSlOrderRoiPct,
        filters,
        makerTicks
      })
    : { enabled: false, reason: reduceOnly ? "reduce-only exit" : "disabled" };

  const replacementInfo = reduceOnly && effectiveReplaceReduceOnly
    ? await getExitReplacementOrderIds(config, symbol, side, liveReplacementIdsPromise)
    : { ids: [], indexedIds: [], liveIds: [], source: "none" };
  const replacementClientOrderIds = replacementInfo.ids;

  const newClientOrderId = makeClientOrderId(side);
  const order = {
    symbol,
    side,
    type: "LIMIT",
    timeInForce: "GTX",
    quantity,
    price,
    recvWindow: config.recvWindow,
    newClientOrderId
  };

  if (reduceOnly) order.reduceOnly = "true";

  const preview = {
    symbol,
    side,
    price: protectedInitialPrice.price,
    quantity,
    originalAmount: quoteAmount,
    leverage,
    currentLeverage: position.leverage || null,
    quoteAmount: effectiveQuoteAmount,
    requestedNotional: effectiveQuoteAmount,
    actualNotional: notional,
    sizingMode,
    offsetTicks: effectiveOffsetTicks,
    makerTicks,
    exitChaseRetries: reduceOnly ? effectiveExitChaseRetries : 0,
    exitChaseAttempts: 0,
    entryRetryAttempts: 0,
    bid: book.bidPrice,
    ask: book.askPrice,
    timeInForce: "GTX",
    reduceOnly,
    replaceReduceOnly: reduceOnly && effectiveReplaceReduceOnly,
    cancelBeforeReplaceCount: replacementClientOrderIds.length,
    cancelBeforeReplaceClientOrderIds: replacementClientOrderIds,
    cancelBeforeReplaceSource: replacementInfo.source,
    cancelBeforeReplaceIndexedCount: replacementInfo.indexedIds.length,
    cancelBeforeReplaceLiveCount: replacementInfo.liveIds.length,
    detectedPositionAmt: position.positionAmt,
    positionSource: positionResult.source,
    positionAgeMs: positionResult.ageMs,
    baseUrl: config.baseUrl,
    newClientOrderId,
    autoSettlement: autoSettlementPlan,
    slOrder: slOrderPlan
  };
  preview.profitOnlySettlementEnabled = reduceOnly && effectiveProfitOnlySettlementEnabled;
  preview.profitOnlySettlementAdjusted = protectedInitialPrice.adjusted;
  preview.profitOnlySettlementAveragePrice = protectedInitialPrice.averagePrice;

  const effectiveDryRun = dryRun === undefined ? config.dryRun : Boolean(dryRun);
  if (effectiveDryRun) return { dryRun: true, order: preview };

  // Leverage only matters for opening / adding exposure. For full reduce-only exits,
  // changing leverage first adds an avoidable signed REST round trip and can slow exits.
  const leverageNeedsChange = !reduceOnly && (!position.leverage || Number(position.leverage) !== Number(leverage));
  const leveragePromise = leverageNeedsChange
    ? changeInitialLeverage(config, symbol, leverage)
    : Promise.resolve({
        skipped: true,
        leverage: position.leverage,
        reason: reduceOnly ? "reduce-only exit skips leverage change" : "already matched"
      });
  const cancelPromise = replacementClientOrderIds.length
    ? cancelIndexedExitOrders(config, symbol, replacementClientOrderIds)
    : Promise.resolve([]);

  const [leverageResponse, cancelResponses] = await Promise.all([leveragePromise, cancelPromise]);
  if (replacementClientOrderIds.length) {
    await removeIndexedExitOrderIds(symbol, side, replacementClientOrderIds);
  }

  let response;
  let finalClientOrderId = newClientOrderId;
  let exitChase = { attempts: 0, finalBook: book, finalPrice: price, finalNotional: notional };
  let entryRetry = { attempts: 0, finalBook: book, finalPrice: price, finalNotional: notional };

  if (reduceOnly && effectiveExitChaseRetries > 0) {
    const chaseResult = await placeReduceOnlyOrderWithChase({
      config,
      symbol,
      side,
      quantity,
      filters,
      makerTicks,
      initialBook: book,
      baseOrder: order,
      maxRetries: effectiveExitChaseRetries,
      profitOnlySettlement: {
        enabled: effectiveProfitOnlySettlementEnabled,
        position
      }
    });
    response = chaseResult.response;
    finalClientOrderId = chaseResult.order.newClientOrderId;
    exitChase = chaseResult.exitChase;
  } else {
    const entryResult = await placeEntryOrderWithMakerRetry({
      config,
      symbol,
      side,
      quantity,
      filters,
      makerTicks,
      initialBook: book,
      baseOrder: order,
      maxRetries: reduceOnly ? 0 : ENTRY_MAKER_RETRY_LIMIT,
      profitOnlySettlement: reduceOnly
        ? { enabled: effectiveProfitOnlySettlementEnabled, position }
        : { enabled: false, position: null }
    });
    response = entryResult.response;
    finalClientOrderId = entryResult.order.newClientOrderId;
    entryRetry = entryResult.entryRetry;
  }

  if (reduceOnly) {
    await addIndexedExitOrderId(symbol, side, finalClientOrderId);
  }

  let autoSettlementResult = null;
  if (!reduceOnly && (autoSettlementPlan.enabled || slOrderPlan.enabled)) {
    if (String(autoSettlementPlan.entryPrice) !== String(entryRetry.finalPrice)) {
      if (autoSettlementPlan.enabled) {
        autoSettlementPlan = buildAutoSettlementPlan({
          symbol,
          entrySide: side,
          entryPrice: entryRetry.finalPrice,
          quantity,
          originalAmount: quoteAmount,
          leverage,
          roiPct: effectiveAutoSettlementRoiPct,
          filters,
          makerTicks
        });
      }
      if (slOrderPlan.enabled) {
        slOrderPlan = buildSlOrderPlan({
          symbol,
          entrySide: side,
          entryPrice: entryRetry.finalPrice,
          quantity,
          originalAmount: quoteAmount,
          leverage,
          roiPct: effectiveSlOrderRoiPct,
          filters,
          makerTicks
        });
      }
    }
    autoSettlementResult = await registerAndTryAutoSettlement({
      config,
      symbol,
      plan: autoSettlementPlan,
      slOrderPlan,
      entryClientOrderId: finalClientOrderId,
      entryOrderResponse: response,
      filters
    });
  }

  const finalOrder = reduceOnly ? exitChase : entryRetry;
  preview.price = finalOrder.finalPrice || preview.price;
  preview.actualNotional = finalOrder.finalNotional || preview.actualNotional;
  preview.bid = finalOrder.finalBook?.bidPrice || preview.bid;
  preview.ask = finalOrder.finalBook?.askPrice || preview.ask;
  preview.newClientOrderId = finalClientOrderId;
  preview.exitChaseAttempts = exitChase.attempts || 0;
  preview.entryRetryAttempts = entryRetry.attempts || 0;
  preview.autoSettlement = autoSettlementPlan;
  preview.slOrder = slOrderPlan;
  if (finalOrder.profitOnlySettlement) {
    preview.profitOnlySettlementAdjusted = Boolean(finalOrder.profitOnlySettlement.adjusted);
    preview.profitOnlySettlementAveragePrice = finalOrder.profitOnlySettlement.averagePrice;
  }

  return { dryRun: false, order: preview, leverageResponse, cancelResponses, response, autoSettlementResult };
}

function normalizeSymbol(symbol) {
  const s = String(symbol || "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!s) throw new Error("Symbol is empty");
  return s;
}

async function getSymbolFilters(baseUrl, symbol) {
  const cacheKey = `${baseUrl}:${symbol}`;
  const cached = EXCHANGE_INFO_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.filters;

  const info = await publicGet(baseUrl, "/fapi/v1/exchangeInfo", { symbol });
  const s = info.symbols?.find(x => x.symbol === symbol);
  if (!s) throw new Error(`Symbol not found: ${symbol}`);

  const priceFilter = s.filters.find(f => f.filterType === "PRICE_FILTER");
  const lotSize = s.filters.find(f => f.filterType === "LOT_SIZE");
  const minNotional = s.filters.find(f => f.filterType === "MIN_NOTIONAL");
  if (!priceFilter || !lotSize) throw new Error(`Missing filters for ${symbol}`);

  const filters = {
    tickSize: priceFilter.tickSize,
    stepSize: lotSize.stepSize,
    minQty: lotSize.minQty,
    maxQty: lotSize.maxQty,
    minNotional: minNotional?.notional || minNotional?.minNotional || "0"
  };
  EXCHANGE_INFO_CACHE.set(cacheKey, { ts: Date.now(), filters });
  return filters;
}

function calculateMakerPriceFromBook({ side, book, filters, makerTicks }) {
  const bid = Number(book.bidPrice);
  const ask = Number(book.askPrice);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid >= ask) {
    throw new Error(`Invalid book ticker: bid=${book.bidPrice}, ask=${book.askPrice}`);
  }
  const tick = Number(filters.tickSize);
  const rawPrice = side === "BUY"
    ? ask - tick * makerTicks
    : bid + tick * makerTicks;
  if (rawPrice <= 0) throw new Error("Calculated price is <= 0");
  const price = side === "BUY"
    ? floorToStep(rawPrice, filters.tickSize)
    : ceilToStep(rawPrice, filters.tickSize);
  return { price, bid, ask };
}

function protectProfitOnlySettlementPrice({ enabled, side, price, position, filters }) {
  const rawBasis = position?.entryPrice || position?.breakEvenPrice;
  const basis = Number(rawBasis || 0);
  const current = Number(price);
  if (!enabled || !Number.isFinite(basis) || basis <= 0 || !Number.isFinite(current) || current <= 0) {
    return { price, adjusted: false, averagePrice: Number.isFinite(basis) && basis > 0 ? String(rawBasis) : null };
  }

  if (side === "SELL" && current < basis) {
    const protectedPrice = ceilToStep(basis, filters.tickSize);
    return {
      price: protectedPrice,
      adjusted: true,
      averagePrice: protectedPrice
    };
  }
  if (side === "BUY" && current > basis) {
    const protectedPrice = floorToStep(basis, filters.tickSize);
    return {
      price: protectedPrice,
      adjusted: true,
      averagePrice: protectedPrice
    };
  }
  return {
    price,
    adjusted: false,
    averagePrice: String(rawBasis)
  };
}

async function placeReduceOnlyOrderWithChase({ config, symbol, side, quantity, filters, makerTicks, initialBook, baseOrder, maxRetries, profitOnlySettlement }) {
  let lastError = null;
  let currentBook = initialBook;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      currentBook = await publicGet(config.baseUrl, "/fapi/v1/ticker/bookTicker", { symbol });
    }
    const makerPrice = calculateMakerPriceFromBook({ side, book: currentBook, filters, makerTicks });
    const protectedPrice = protectProfitOnlySettlementPrice({
      enabled: Boolean(profitOnlySettlement?.enabled),
      side,
      price: makerPrice.price,
      position: profitOnlySettlement?.position,
      filters
    });
    const nextOrder = {
      ...baseOrder,
      price: protectedPrice.price,
      quantity,
      newClientOrderId: makeClientOrderId(side)
    };
    try {
      const response = await signedRequest(config, "POST", "/fapi/v1/order", nextOrder);
      return {
        response,
        order: nextOrder,
        exitChase: {
          attempts: attempt,
          finalBook: currentBook,
          finalPrice: protectedPrice.price,
          finalNotional: Number(quantity) * Number(protectedPrice.price),
          profitOnlySettlement: protectedPrice
        }
      };
    } catch (err) {
      lastError = err;
      if (!isGtxRejectError(err) || attempt >= maxRetries) throw err;
    }
  }
  throw lastError || new Error("Exit chase failed");
}

async function placeEntryOrderWithMakerRetry({ config, symbol, side, quantity, filters, makerTicks, initialBook, baseOrder, maxRetries, profitOnlySettlement }) {
  let lastError = null;
  let currentBook = initialBook;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      currentBook = await publicGet(config.baseUrl, "/fapi/v1/ticker/bookTicker", { symbol });
    }
    const makerPrice = calculateMakerPriceFromBook({ side, book: currentBook, filters, makerTicks });
    const protectedPrice = protectProfitOnlySettlementPrice({
      enabled: Boolean(profitOnlySettlement?.enabled),
      side,
      price: makerPrice.price,
      position: profitOnlySettlement?.position,
      filters
    });
    const nextOrder = {
      ...baseOrder,
      price: protectedPrice.price,
      quantity,
      newClientOrderId: attempt === 0 ? baseOrder.newClientOrderId : makeClientOrderId(side)
    };
    try {
      const response = await signedRequest(config, "POST", "/fapi/v1/order", nextOrder);
      return {
        response,
        order: nextOrder,
        entryRetry: {
          attempts: attempt,
          finalBook: currentBook,
          finalPrice: protectedPrice.price,
          finalNotional: Number(quantity) * Number(protectedPrice.price),
          profitOnlySettlement: protectedPrice
        }
      };
    } catch (err) {
      lastError = err;
      if (!isGtxRejectError(err) || attempt >= maxRetries) throw err;
    }
  }
  throw lastError || new Error("Entry maker retry failed");
}

function isGtxRejectError(err) {
  const msg = String(err?.message || "");
  return err?.code === -5022 || /GTX|post[- ]?only|maker|immediately match|would immediately|Post Only/i.test(msg);
}


function buildAutoSettlementPreview({ config, symbol, book, filters }) {
  const enabled = Boolean(config.autoSettlementEnabled);
  const roiPct = Number(normalizeRoiPct(config.autoSettlementRoiPct));
  const leverage = clampLeverage(config.leverage);
  const originalAmount = Number(config.quoteAmount);
  const offsetTicks = Math.max(0, Math.floor(Number(config.offsetTicks) || 0));
  const makerTicks = offsetTicks + 1;
  if (!enabled || !Number.isFinite(originalAmount) || originalAmount <= 0) {
    return { enabled, roiPct, reason: enabled ? "invalid amount" : "disabled" };
  }
  const longEntry = calculateMakerPriceFromBook({ side: "BUY", book, filters, makerTicks }).price;
  const shortEntry = calculateMakerPriceFromBook({ side: "SELL", book, filters, makerTicks }).price;
  const longQty = floorToStep((originalAmount * leverage) / Number(longEntry), filters.stepSize);
  const shortQty = floorToStep((originalAmount * leverage) / Number(shortEntry), filters.stepSize);
  const longPlan = buildAutoSettlementPlan({ symbol, entrySide: "BUY", entryPrice: longEntry, quantity: longQty, originalAmount, leverage, roiPct, filters, makerTicks });
  const shortPlan = buildAutoSettlementPlan({ symbol, entrySide: "SELL", entryPrice: shortEntry, quantity: shortQty, originalAmount, leverage, roiPct, filters, makerTicks });
  return { enabled, roiPct, expectedProfit: (originalAmount * roiPct / 100).toFixed(4), long: longPlan, short: shortPlan };
}

function buildAutoSettlementPlan({ symbol, entrySide, entryPrice, quantity, originalAmount, leverage, roiPct, filters, makerTicks }) {
  const entry = Number(entryPrice);
  const qty = Number(quantity);
  const lev = clampLeverage(leverage);
  const roi = Number(normalizeRoiPct(roiPct));
  const underlyingMove = roi / 100 / lev;
  const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
  const rawTarget = entrySide === "BUY"
    ? entry * (1 + underlyingMove)
    : entry * (1 - underlyingMove);
  if (!Number.isFinite(rawTarget) || rawTarget <= 0) throw new Error("Invalid auto settlement target price");
  const settlementPrice = exitSide === "SELL"
    ? ceilToStep(rawTarget, filters.tickSize)
    : floorToStep(rawTarget, filters.tickSize);
  const expectedProfitByInput = Number(originalAmount) * roi / 100;
  const expectedProfitByPrice = Math.abs(Number(settlementPrice) - entry) * qty;
  return {
    enabled: true,
    settlementEnabled: true,
    symbol,
    entrySide,
    exitSide,
    entryPrice: String(entryPrice),
    settlementPrice,
    quantity: String(quantity),
    originalAmount: Number(originalAmount),
    leverage: lev,
    roiPct: roi,
    underlyingMovePct: underlyingMove * 100,
    expectedProfit: expectedProfitByInput.toFixed(4),
    expectedProfitByPrice: expectedProfitByPrice.toFixed(4),
    makerTicks
  };
}

function buildSlOrderPlan({ symbol, entrySide, entryPrice, quantity, originalAmount, leverage, roiPct, filters, makerTicks }) {
  const entry = Number(entryPrice);
  const qty = Number(quantity);
  const lev = clampLeverage(leverage);
  const roi = Number(normalizeRoiPct(roiPct));
  const underlyingMove = roi / 100 / lev;
  const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
  const rawTarget = entrySide === "BUY"
    ? entry * (1 - underlyingMove)
    : entry * (1 + underlyingMove);
  if (!Number.isFinite(rawTarget) || rawTarget <= 0) throw new Error("Invalid SL order price");
  const slPrice = exitSide === "SELL"
    ? floorToStep(rawTarget, filters.tickSize)
    : ceilToStep(rawTarget, filters.tickSize);
  const triggerPrice = midpointTriggerPrice({ entryPrice: entry, slPrice, side: exitSide, filters });
  const expectedLossByInput = Number(originalAmount) * roi / 100;
  const expectedLossByPrice = Math.abs(Number(slPrice) - entry) * qty;
  return {
    enabled: true,
    symbol,
    entrySide,
    exitSide,
    entryPrice: String(entryPrice),
    slPrice,
    triggerPrice,
    slPriceOffset: calculateAutoSettlementPriceOffset({
      entryPrice,
      settlementPrice: slPrice
    }),
    quantity: String(quantity),
    originalAmount: Number(originalAmount),
    leverage: lev,
    roiPct: roi,
    underlyingMovePct: underlyingMove * 100,
    expectedLoss: expectedLossByInput.toFixed(4),
    expectedLossByPrice: expectedLossByPrice.toFixed(4),
    makerTicks
  };
}

function midpointTriggerPrice({ entryPrice, slPrice, side, filters }) {
  const midpoint = (Number(entryPrice) + Number(slPrice)) / 2;
  if (!Number.isFinite(midpoint) || midpoint <= 0) throw new Error("Invalid SL trigger price");
  return side === "SELL"
    ? floorToStep(midpoint, filters.tickSize)
    : ceilToStep(midpoint, filters.tickSize);
}

async function registerAndTryAutoSettlement({ config, symbol, plan, slOrderPlan, entryClientOrderId, entryOrderResponse, filters }) {
  const exitSide = plan.enabled ? plan.exitSide : slOrderPlan.exitSide;
  const pending = {
    id: makePendingSettlementId(),
    symbol,
    entrySide: plan.enabled ? plan.entrySide : slOrderPlan.entrySide,
    exitSide,
    entryClientOrderId,
    entryOrderId: entryOrderResponse?.orderId || null,
    entryPrice: plan.enabled ? plan.entryPrice : slOrderPlan.entryPrice,
    settlementEnabled: Boolean(plan.enabled),
    settlementPrice: plan.enabled ? plan.settlementPrice : null,
    settlementPriceOffset: plan.enabled ? calculateAutoSettlementPriceOffset({
      entryPrice: plan.entryPrice,
      settlementPrice: plan.settlementPrice
    }) : null,
    quantity: plan.enabled ? plan.quantity : slOrderPlan.quantity,
    placedQty: "0",
    roiPct: plan.enabled ? plan.roiPct : null,
    leverage: plan.enabled ? plan.leverage : slOrderPlan.leverage,
    originalAmount: plan.enabled ? plan.originalAmount : slOrderPlan.originalAmount,
    makerTicks: plan.enabled ? plan.makerTicks : slOrderPlan.makerTicks,
    slOrderEnabled: Boolean(slOrderPlan?.enabled),
    slOrderRoiPct: slOrderPlan?.enabled ? slOrderPlan.roiPct : null,
    slPrice: slOrderPlan?.enabled ? slOrderPlan.slPrice : null,
    slTriggerPrice: slOrderPlan?.enabled ? slOrderPlan.triggerPrice : null,
    slPriceOffset: slOrderPlan?.enabled ? slOrderPlan.slPriceOffset : null,
    slPlacedQty: "0",
    slClientAlgoIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await addPendingSettlement(pending);
  const userStreamStatus = getUserStreamStatus();
  ensureUserStreamForConfig(config).catch(err => {
    USER_STREAM_STATE.lastError = err?.message || String(err);
    setUserStreamFallback("listenKey start failed");
  });
  if (!userStreamStatus.connected) {
    startFastSettlementWatcher(config, pending, filters).catch(() => {});
  }

  return {
    ok: true,
    pending: true,
    status: "watching",
    placedNow: "0",
    watcher: userStreamStatus.connected ? "ws" : "fast",
    userStream: userStreamStatus,
    pollMs: AUTO_SETTLEMENT_FAST_POLL_MS,
    fastWindowMs: AUTO_SETTLEMENT_FAST_WINDOW_MS
  };
}

function makePendingSettlementId() {
  const rand = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  return `ps_${Date.now()}_${rand}`;
}

async function ensureUserStreamForConfig(config) {
  if (!config?.apiKey || !config?.apiSecret) {
    setUserStreamFallback("missing API key/secret");
    return getUserStreamStatus();
  }
  if (config.dryRun) {
    setUserStreamDryRun();
    return getUserStreamStatus();
  }

  const baseUrl = config.baseUrl || DEFAULTS.baseUrl;
  if (USER_STREAM_STATE.ws && USER_STREAM_STATE.baseUrl === baseUrl && USER_STREAM_STATE.apiKey === config.apiKey && ["connecting", "connected"].includes(USER_STREAM_STATE.status)) {
    return getUserStreamStatus();
  }

  stopUserStream({ closeListenKey: false });
  USER_STREAM_STATE.status = "starting";
  USER_STREAM_STATE.mode = "fallback-rest";
  USER_STREAM_STATE.baseUrl = baseUrl;
  USER_STREAM_STATE.apiKey = config.apiKey;
  USER_STREAM_STATE.startedAt = Date.now();
  USER_STREAM_STATE.fallbackReason = "starting websocket";

  const streamConfig = { ...config, baseUrl };
  const listenKey = await startUserDataStream(streamConfig);
  USER_STREAM_STATE.listenKey = listenKey;
  USER_STREAM_STATE.wsUrl = buildUserStreamWsUrl(baseUrl, listenKey);
  openUserStreamSocket(streamConfig, USER_STREAM_STATE.wsUrl);
  scheduleUserStreamKeepAlive(streamConfig);
  return getUserStreamStatus();
}

function setUserStreamDryRun() {
  stopUserStream({ closeListenKey: false });
  USER_STREAM_STATE.status = "disabled";
  USER_STREAM_STATE.mode = "dry-run";
  USER_STREAM_STATE.listenKey = "";
  USER_STREAM_STATE.wsUrl = "";
  USER_STREAM_STATE.fallbackReason = "dry run";
  USER_STREAM_STATE.lastError = "";
}

function setUserStreamFallback(reason) {
  USER_STREAM_STATE.status = "fallback-rest";
  USER_STREAM_STATE.mode = "fallback-rest";
  USER_STREAM_STATE.fallbackReason = reason || "websocket unavailable";
}

function stopUserStream() {
  if (USER_STREAM_STATE.keepAliveTimer) {
    clearTimeout(USER_STREAM_STATE.keepAliveTimer);
    USER_STREAM_STATE.keepAliveTimer = null;
  }
  if (USER_STREAM_STATE.reconnectTimer) {
    clearTimeout(USER_STREAM_STATE.reconnectTimer);
    USER_STREAM_STATE.reconnectTimer = null;
  }
  if (USER_STREAM_STATE.ws) {
    try {
      USER_STREAM_STATE.ws.onopen = null;
      USER_STREAM_STATE.ws.onmessage = null;
      USER_STREAM_STATE.ws.onerror = null;
      USER_STREAM_STATE.ws.onclose = null;
      USER_STREAM_STATE.ws.close();
    } catch (_) {}
    USER_STREAM_STATE.ws = null;
  }
}

async function startUserDataStream(config) {
  const result = await userStreamRequest(config, "POST");
  if (!result?.listenKey) throw new Error("Binance did not return a listenKey");
  return String(result.listenKey);
}

async function keepAliveUserDataStream(config) {
  return userStreamRequest(config, "PUT");
}

async function userStreamRequest(config, method) {
  assertBinanceRestAllowed();
  const url = new URL("/fapi/v1/listenKey", config.baseUrl || DEFAULTS.baseUrl);
  const res = await fetch(url.toString(), {
    method,
    headers: { "X-MBX-APIKEY": config.apiKey }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw enrichHttpError(data, res.status);
  return data;
}

function buildUserStreamWsUrl(baseUrl, listenKey) {
  const encoded = encodeURIComponent(String(listenKey || ""));
  if (String(baseUrl || "").includes("testnet.binancefuture.com")) {
    return `wss://fstream.binancefuture.com/ws/${encoded}`;
  }
  return `wss://fstream.binance.com/private/ws/${encoded}`;
}

async function ensureMarketStreamForSymbol(config, symbol) {
  symbol = normalizeSymbol(symbol);
  const baseUrl = config.baseUrl || DEFAULTS.baseUrl;
  const sameStream = MARKET_STREAM_STATE.baseUrl === baseUrl && MARKET_STREAM_STATE.symbol === symbol;
  if (MARKET_STREAM_STATE.ws && MARKET_STREAM_STATE.baseUrl === baseUrl && MARKET_STREAM_STATE.symbol === symbol && ["connecting", "connected"].includes(MARKET_STREAM_STATE.status)) {
    return getMarketStreamStatus();
  }
  if (sameStream && MARKET_STREAM_STATE.reconnectTimer && Date.now() < MARKET_STREAM_STATE.nextReconnectAt) {
    return getMarketStreamStatus();
  }
  if (sameStream && MARKET_STREAM_STATE.status === "reconnecting" && Date.now() < MARKET_STREAM_STATE.nextReconnectAt) {
    return getMarketStreamStatus();
  }

  stopMarketStream();
  MARKET_STREAM_STATE.status = "connecting";
  MARKET_STREAM_STATE.baseUrl = baseUrl;
  MARKET_STREAM_STATE.symbol = symbol;
  MARKET_STREAM_STATE.wsUrl = buildMarketBookTickerWsUrl(baseUrl, symbol);
  MARKET_STREAM_STATE.fallbackReason = "connecting market websocket";
  MARKET_STREAM_STATE.lastError = "";
  openMarketStreamSocket({ baseUrl, symbol });
  return getMarketStreamStatus();
}

function stopMarketStream() {
  if (MARKET_STREAM_STATE.reconnectTimer) {
    clearTimeout(MARKET_STREAM_STATE.reconnectTimer);
    MARKET_STREAM_STATE.reconnectTimer = null;
  }
  stopMarketStreamWatchdog();
  if (MARKET_STREAM_STATE.ws) {
    try {
      MARKET_STREAM_STATE.ws.onopen = null;
      MARKET_STREAM_STATE.ws.onmessage = null;
      MARKET_STREAM_STATE.ws.onerror = null;
      MARKET_STREAM_STATE.ws.onclose = null;
      MARKET_STREAM_STATE.ws.close();
    } catch (_) {}
    MARKET_STREAM_STATE.ws = null;
  }
}

function buildMarketBookTickerWsUrl(baseUrl, symbol) {
  const streamName = `${normalizeSymbol(symbol).toLowerCase()}@bookTicker`;
  if (String(baseUrl || "").includes("testnet.binancefuture.com")) {
    return `wss://fstream.binancefuture.com/ws/${streamName}`;
  }
  return `wss://fstream.binance.com/public/ws/${streamName}`;
}

function openMarketStreamSocket(config) {
  if (typeof WebSocket !== "function") {
    MARKET_STREAM_STATE.status = "fallback-rest";
    MARKET_STREAM_STATE.fallbackReason = "WebSocket unavailable";
    return;
  }
  const ws = new WebSocket(MARKET_STREAM_STATE.wsUrl);
  MARKET_STREAM_STATE.ws = ws;
  ws.onopen = () => {
    if (MARKET_STREAM_STATE.ws !== ws) return;
    MARKET_STREAM_STATE.status = "connected";
    MARKET_STREAM_STATE.connectedAt = Date.now();
    MARKET_STREAM_STATE.lastEventAt = Date.now();
    MARKET_STREAM_STATE.reconnectAttempt = 0;
    MARKET_STREAM_STATE.fallbackReason = "";
    MARKET_STREAM_STATE.lastError = "";
    startMarketStreamWatchdog(ws, config);
  };
  ws.onmessage = (event) => {
    if (MARKET_STREAM_STATE.ws !== ws) return;
    MARKET_STREAM_STATE.lastEventAt = Date.now();
    handleMarketBookTickerMessage(config.baseUrl, event?.data);
  };
  ws.onerror = () => {
    if (MARKET_STREAM_STATE.ws !== ws) return;
    stopMarketStreamWatchdog();
    MARKET_STREAM_STATE.ws = null;
    MARKET_STREAM_STATE.status = "reconnecting";
    MARKET_STREAM_STATE.lastError = "Market WebSocket error";
    MARKET_STREAM_STATE.fallbackReason = "market websocket error";
    try { ws.close(); } catch (_) {}
    scheduleMarketStreamReconnect(config);
  };
  ws.onclose = () => {
    if (MARKET_STREAM_STATE.ws !== ws) return;
    stopMarketStreamWatchdog();
    MARKET_STREAM_STATE.ws = null;
    MARKET_STREAM_STATE.status = "reconnecting";
    MARKET_STREAM_STATE.fallbackReason = "market websocket closed";
    scheduleMarketStreamReconnect(config);
  };
}

function startMarketStreamWatchdog(ws, config) {
  stopMarketStreamWatchdog();
  MARKET_STREAM_STATE.watchdogTimer = setInterval(() => {
    if (MARKET_STREAM_STATE.ws !== ws || MARKET_STREAM_STATE.status !== "connected") return;
    const lastEventAt = Number(MARKET_STREAM_STATE.lastEventAt || MARKET_STREAM_STATE.connectedAt || 0);
    if (!lastEventAt || Date.now() - lastEventAt <= MARKET_STREAM_STALE_TIMEOUT_MS) return;
    MARKET_STREAM_STATE.lastError = "Market WebSocket stale";
    MARKET_STREAM_STATE.fallbackReason = "market websocket stale";
    try { ws.close(); } catch (_) {
      stopMarketStreamWatchdog();
      MARKET_STREAM_STATE.ws = null;
      MARKET_STREAM_STATE.status = "reconnecting";
      scheduleMarketStreamReconnect(config);
    }
  }, MARKET_STREAM_WATCHDOG_INTERVAL_MS);
  MARKET_STREAM_STATE.watchdogTimer?.unref?.();
}

function stopMarketStreamWatchdog() {
  if (!MARKET_STREAM_STATE.watchdogTimer) return;
  clearInterval(MARKET_STREAM_STATE.watchdogTimer);
  MARKET_STREAM_STATE.watchdogTimer = null;
}

function scheduleMarketStreamReconnect(config) {
  clearTimeout(MARKET_STREAM_STATE.reconnectTimer);
  const attempt = MARKET_STREAM_STATE.reconnectAttempt + 1;
  MARKET_STREAM_STATE.reconnectAttempt = attempt;
  const delay = Math.min(MARKET_STREAM_RECONNECT_MAX_MS, MARKET_STREAM_RECONNECT_BASE_MS * (2 ** Math.min(attempt - 1, 5)));
  MARKET_STREAM_STATE.nextReconnectAt = Date.now() + delay;
  MARKET_STREAM_STATE.reconnectTimer = setTimeout(() => {
    MARKET_STREAM_STATE.reconnectTimer = null;
    ensureMarketStreamForSymbol(config, config.symbol).catch(err => {
      MARKET_STREAM_STATE.lastError = err?.message || String(err);
      MARKET_STREAM_STATE.status = "fallback-rest";
      MARKET_STREAM_STATE.fallbackReason = "market reconnect failed";
      scheduleMarketStreamReconnect(config);
    });
  }, delay);
}

function handleMarketBookTickerMessage(baseUrl, raw) {
  let msg;
  try {
    msg = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
  const payload = msg?.data || msg;
  if (payload?.e !== "bookTicker" || !payload?.s) return null;
  const bid = Number(payload.b);
  const ask = Number(payload.a);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid >= ask) return null;

  const symbol = normalizeSymbol(payload.s);
  const snapshot = {
    symbol,
    bid: String(payload.b),
    ask: String(payload.a),
    bidQty: payload.B === undefined ? null : String(payload.B),
    askQty: payload.A === undefined ? null : String(payload.A),
    currentPrice: String((bid + ask) / 2),
    eventTime: Number(payload.E || 0) || null,
    updateId: payload.u === undefined ? null : Number(payload.u),
    receivedAt: Date.now(),
    source: "ws"
  };
  MARKET_BOOK_CACHE.set(marketBookCacheKey(baseUrl, symbol), snapshot);
  return snapshot;
}

function marketBookCacheKey(baseUrl, symbol) {
  return `${baseUrl || DEFAULTS.baseUrl}:${normalizeSymbol(symbol)}`;
}

function getMarketTickerSnapshot({ baseUrl, symbol }) {
  symbol = normalizeSymbol(symbol);
  const cached = MARKET_BOOK_CACHE.get(marketBookCacheKey(baseUrl || DEFAULTS.baseUrl, symbol));
  if (!cached) return {
    symbol,
    currentPrice: null,
    bid: null,
    ask: null,
    source: "none",
    ageMs: null,
    marketStreamStatus: getMarketStreamStatus()
  };
  return {
    ...cached,
    ageMs: Date.now() - cached.receivedAt,
    marketStreamStatus: getMarketStreamStatus()
  };
}

function bookFromMarketSnapshot(snapshot) {
  const bid = Number(snapshot?.bid);
  const ask = Number(snapshot?.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid >= ask) return null;
  return {
    bidPrice: String(snapshot.bid),
    askPrice: String(snapshot.ask),
    bidQty: snapshot.bidQty === undefined ? null : snapshot.bidQty,
    askQty: snapshot.askQty === undefined ? null : snapshot.askQty
  };
}

function assertBinanceRestAllowed() {
  const now = Date.now();
  if (REST_BAN_STATE.until && REST_BAN_STATE.until > now) {
    const err = new Error(REST_BAN_STATE.message || `Binance REST paused until ${REST_BAN_STATE.until}`);
    err.code = -1003;
    err.status = 418;
    err.banUntil = REST_BAN_STATE.until;
    err.localRestPause = true;
    throw err;
  }
}

function rememberBinanceRestBan(data) {
  const message = String(data?.msg || "");
  const match = message.match(/banned until\s+(\d{10,})/i);
  if (!match) return;
  const until = Number(match[1]);
  if (!Number.isFinite(until) || until <= Date.now()) return;
  REST_BAN_STATE.until = Math.max(REST_BAN_STATE.until || 0, until);
  REST_BAN_STATE.message = message;
}

async function getMarketTickerForMessage({ symbol }) {
  const config = await getConfigRaw();
  symbol = normalizeSymbol(symbol);
  ensureMarketStreamForSymbol(config, symbol).catch(err => {
    MARKET_STREAM_STATE.lastError = err?.message || String(err);
    MARKET_STREAM_STATE.status = "fallback-rest";
    MARKET_STREAM_STATE.fallbackReason = "market start failed";
  });
  const marketSnapshot = getMarketTickerSnapshot({ baseUrl: config.baseUrl, symbol });
  const cachedPosition = readPositionCache(config, symbol);
  if (!cachedPosition) return marketSnapshot;
  return {
    ...marketSnapshot,
    position: addLivePositionPnl(cachedPosition.position, marketSnapshot),
    positionSource: cachedPosition.source,
    positionAgeMs: cachedPosition.ageMs
  };
}

function getMarketStreamStatus() {
  return {
    status: MARKET_STREAM_STATE.status,
    connected: MARKET_STREAM_STATE.status === "connected",
    symbol: MARKET_STREAM_STATE.symbol,
    fallbackReason: MARKET_STREAM_STATE.fallbackReason,
    lastEventAt: MARKET_STREAM_STATE.lastEventAt,
    lastError: MARKET_STREAM_STATE.lastError,
    reconnectAttempt: MARKET_STREAM_STATE.reconnectAttempt
  };
}

function openUserStreamSocket(config, wsUrl) {
  if (typeof WebSocket !== "function") {
    setUserStreamFallback("WebSocket unavailable");
    return;
  }

  USER_STREAM_STATE.status = "connecting";
  USER_STREAM_STATE.mode = "fallback-rest";
  USER_STREAM_STATE.fallbackReason = "connecting websocket";

  const ws = new WebSocket(wsUrl);
  USER_STREAM_STATE.ws = ws;
  ws.onopen = () => {
    if (USER_STREAM_STATE.ws !== ws) return;
    USER_STREAM_STATE.status = "connected";
    USER_STREAM_STATE.mode = "websocket";
    USER_STREAM_STATE.connectedAt = Date.now();
    USER_STREAM_STATE.lastEventAt = Date.now();
    USER_STREAM_STATE.reconnectAttempt = 0;
    USER_STREAM_STATE.fallbackReason = "";
    USER_STREAM_STATE.lastError = "";
  };
  ws.onmessage = (event) => {
    if (USER_STREAM_STATE.ws !== ws) return;
    USER_STREAM_STATE.lastEventAt = Date.now();
    handleUserStreamMessage(config, event?.data).catch(err => {
      USER_STREAM_STATE.lastError = err?.message || String(err);
    });
  };
  ws.onerror = () => {
    if (USER_STREAM_STATE.ws !== ws) return;
    USER_STREAM_STATE.lastError = "User stream WebSocket error";
    USER_STREAM_STATE.ws = null;
    setUserStreamFallback("websocket error");
    try { ws.close(); } catch (_) {}
    scheduleUserStreamReconnect(config);
  };
  ws.onclose = () => {
    if (USER_STREAM_STATE.ws !== ws) return;
    USER_STREAM_STATE.ws = null;
    setUserStreamFallback("websocket closed");
    scheduleUserStreamReconnect(config);
  };
}

function scheduleUserStreamKeepAlive(config) {
  clearTimeout(USER_STREAM_STATE.keepAliveTimer);
  USER_STREAM_STATE.keepAliveTimer = setTimeout(() => {
    keepAliveUserDataStream(config)
      .then(() => scheduleUserStreamKeepAlive(config))
      .catch(err => {
        USER_STREAM_STATE.lastError = err?.message || String(err);
        stopUserStream({ closeListenKey: false });
        setUserStreamFallback("listenKey keepalive failed");
        scheduleUserStreamReconnect(config);
      });
  }, USER_STREAM_KEEPALIVE_MS);
}

function scheduleUserStreamReconnect(config) {
  clearTimeout(USER_STREAM_STATE.reconnectTimer);
  const attempt = USER_STREAM_STATE.reconnectAttempt + 1;
  USER_STREAM_STATE.reconnectAttempt = attempt;
  const delay = Math.min(USER_STREAM_RECONNECT_MAX_MS, USER_STREAM_RECONNECT_BASE_MS * (2 ** Math.min(attempt - 1, 5)));
  USER_STREAM_STATE.status = "reconnecting";
  USER_STREAM_STATE.mode = "fallback-rest";
  USER_STREAM_STATE.fallbackReason = `reconnecting in ${delay}ms`;
  USER_STREAM_STATE.reconnectTimer = setTimeout(() => {
    ensureUserStreamForConfig(config).catch(err => {
      USER_STREAM_STATE.lastError = err?.message || String(err);
      setUserStreamFallback("reconnect failed");
      scheduleUserStreamReconnect(config);
    });
  }, delay);
}

async function handleUserStreamMessage(config, raw) {
  let msg;
  try {
    msg = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    return;
  }
  if (msg?.e === "ACCOUNT_UPDATE") {
    rememberAccountUpdatePositions(config, msg);
  }
  if (isEntryFillEvent(msg)) {
    await processUserStreamEntryFill(config, msg);
  }
}

function rememberAccountUpdatePositions(config, msg) {
  const positions = msg?.a?.P;
  if (!Array.isArray(positions)) return [];
  const updated = [];
  for (const item of positions) {
    let symbol = "";
    try {
      symbol = normalizeSymbol(item?.s);
    } catch (_) {
      continue;
    }
    if (item?.ps && item.ps !== "BOTH") continue;
    const position = normalizeAccountPosition(config, symbol, item);
    writePositionCache(config, symbol, position);
    updated.push(position);
  }
  return updated;
}

function normalizeAccountPosition(config, symbol, item) {
  const previous = readPositionCache(config, symbol)?.position || {};
  const numOrNull = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const positionAmt = numOrNull(item?.pa) || 0;
  const entryPrice = numOrNull(item?.ep);
  const breakEvenPrice = numOrNull(item?.bep);
  const unrealizedProfit = numOrNull(item?.up);
  return {
    positionAmt,
    leverage: previous.leverage ?? null,
    entryPrice,
    breakEvenPrice,
    markPrice: previous.markPrice ?? null,
    unrealizedProfit,
    notional: previous.notional ?? null
  };
}

function isEntryFillEvent(msg) {
  const order = msg?.o;
  const clientOrderId = String(order?.c || "");
  return msg?.e === "ORDER_TRADE_UPDATE" &&
    order?.x === "TRADE" &&
    Number(order?.z || 0) > 0 &&
    (clientOrderId.startsWith("mb_buy_") || clientOrderId.startsWith("mb_sell_"));
}

async function processUserStreamEntryFill(config, event) {
  const order = event?.o || {};
  const symbol = normalizeSymbol(order.s);
  const clientOrderId = String(order.c || "");
  const index = await readPendingSettlementIndex();
  const pending = (Array.isArray(index[symbol]) ? index[symbol] : [])
    .find(item => item?.entryClientOrderId === clientOrderId);
  if (!pending) return { ok: true, pending: false, reason: "no matching pending settlement" };
  const filters = await getSymbolFilters(config.baseUrl, symbol);
  return processPendingSettlementWithExecution(config, pending, filters, {
    executedQty: Number(order.z || 0),
    status: String(order.X || ""),
    watcher: "ws",
    event
  });
}

function calculateSettlementDeltaFromEvent(pending, event, filters) {
  const executedQty = Number(event?.o?.z || 0);
  const placedQty = Number(pending?.placedQty || 0);
  const remainingToPlace = executedQty - placedQty;
  if (!Number.isFinite(remainingToPlace) || remainingToPlace <= Number(filters.stepSize) / 2) return "0";
  const placeQty = floorToStep(remainingToPlace, filters.stepSize);
  return Number(placeQty) > 0 ? placeQty : "0";
}

function getUserStreamStatus() {
  return {
    status: USER_STREAM_STATE.status,
    mode: USER_STREAM_STATE.mode,
    connected: USER_STREAM_STATE.status === "connected",
    fallbackReason: USER_STREAM_STATE.fallbackReason,
    lastEventAt: USER_STREAM_STATE.lastEventAt,
    lastError: USER_STREAM_STATE.lastError,
    reconnectAttempt: USER_STREAM_STATE.reconnectAttempt
  };
}

async function readPendingSettlementFillIndex() {
  if (PENDING_SETTLEMENT_FILL_INDEX_CACHE && typeof PENDING_SETTLEMENT_FILL_INDEX_CACHE === "object") {
    return PENDING_SETTLEMENT_FILL_INDEX_CACHE;
  }
  const data = await chrome.storage.local.get(["pendingSettlementFillIndex"]);
  PENDING_SETTLEMENT_FILL_INDEX_CACHE = data.pendingSettlementFillIndex && typeof data.pendingSettlementFillIndex === "object"
    ? data.pendingSettlementFillIndex
    : {};
  return PENDING_SETTLEMENT_FILL_INDEX_CACHE;
}

async function getSettlementFillPlacedQty(pending) {
  const index = await readPendingSettlementFillIndex();
  const placedQty = index?.[pending.symbol]?.[pending.entryClientOrderId]?.placedQty;
  const n = Number(placedQty || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function setSettlementFillPlacedQty(pending, placedQty) {
  const index = await readPendingSettlementFillIndex();
  const symbolIndex = index[pending.symbol] && typeof index[pending.symbol] === "object" ? index[pending.symbol] : {};
  index[pending.symbol] = {
    ...symbolIndex,
    [pending.entryClientOrderId]: {
      placedQty: String(placedQty),
      updatedAt: Date.now()
    }
  };
  PENDING_SETTLEMENT_FILL_INDEX_CACHE = index;
  await chrome.storage.local.set({ pendingSettlementFillIndex: index });
}

async function readPendingSettlementIndex() {
  if (PENDING_SETTLEMENT_INDEX_CACHE && typeof PENDING_SETTLEMENT_INDEX_CACHE === "object") {
    return PENDING_SETTLEMENT_INDEX_CACHE;
  }
  const data = await chrome.storage.local.get(["pendingSettlementIndex"]);
  PENDING_SETTLEMENT_INDEX_CACHE = data.pendingSettlementIndex && typeof data.pendingSettlementIndex === "object" ? data.pendingSettlementIndex : {};
  return PENDING_SETTLEMENT_INDEX_CACHE;
}

async function writePendingSettlementIndex(index) {
  PENDING_SETTLEMENT_INDEX_CACHE = index && typeof index === "object" ? index : {};
  await chrome.storage.local.set({ pendingSettlementIndex: PENDING_SETTLEMENT_INDEX_CACHE });
}

async function persistPendingSettlementIndexNow() {
  clearTimeout(PENDING_SETTLEMENT_INDEX_WRITE_TIMER);
  PENDING_SETTLEMENT_INDEX_WRITE_TIMER = null;
  await chrome.storage.local.set({ pendingSettlementIndex: PENDING_SETTLEMENT_INDEX_CACHE || {} });
}

async function addPendingSettlement(pending, options = {}) {
  const index = await readPendingSettlementIndex();
  const list = Array.isArray(index[pending.symbol]) ? index[pending.symbol] : [];
  index[pending.symbol] = [...list.filter(x => x?.id !== pending.id), pending].slice(-20);
  PENDING_SETTLEMENT_INDEX_CACHE = index;
  if (options.persist !== false) await persistPendingSettlementIndexNow();
}

async function updatePendingSettlement(pending, options = {}) {
  const index = await readPendingSettlementIndex();
  const list = Array.isArray(index[pending.symbol]) ? index[pending.symbol] : [];
  const next = list.map(x => x?.id === pending.id ? pending : x).filter(Boolean);
  if (next.length) index[pending.symbol] = next;
  else delete index[pending.symbol];
  PENDING_SETTLEMENT_INDEX_CACHE = index;
  if (options.persist !== false) await persistPendingSettlementIndexNow();
}

async function removePendingSettlement(pending, options = {}) {
  const index = await readPendingSettlementIndex();
  const list = Array.isArray(index[pending.symbol]) ? index[pending.symbol] : [];
  const next = list.filter(x => x?.id !== pending.id);
  if (next.length) index[pending.symbol] = next;
  else delete index[pending.symbol];
  PENDING_SETTLEMENT_INDEX_CACHE = index;
  if (options.persist !== false) await persistPendingSettlementIndexNow();
}

async function processPendingSettlementsForSymbol(config, symbol) {
  const index = await readPendingSettlementIndex();
  const list = Array.isArray(index[symbol]) ? [...index[symbol]] : [];
  if (!list.length) return [];
  const filters = await getSymbolFilters(config.baseUrl, symbol);
  const results = await Promise.allSettled(
    list.map(pending => processPendingSettlement(config, pending, filters))
  );
  return results.map((result, i) => result.status === "fulfilled"
    ? result.value
    : { ok: false, id: list[i]?.id, error: result.reason?.message || String(result.reason), code: result.reason?.code });
}

function watcherKey(pending) {
  return `${pending.symbol}:${pending.entryClientOrderId || pending.id}`;
}

async function startFastSettlementWatcher(config, pending, filters) {
  const key = watcherKey(pending);
  if (PENDING_SETTLEMENT_WATCHERS.has(key)) return;

  const controller = { stopped: false };
  PENDING_SETTLEMENT_WATCHERS.set(key, controller);

  try {
    const startedAt = Date.now();
    while (!controller.stopped && Date.now() - startedAt <= AUTO_SETTLEMENT_SLOW_WINDOW_MS) {
      const elapsed = Date.now() - startedAt;
      const result = await processPendingSettlement(config, pending, filters, { fromWatcher: true }).catch(err => ({ ok: false, error: err?.message || String(err), code: err?.code }));
      if (result?.pending === false) break;
      if (result?.placedNow && Number(result.placedNow) > 0 && String(result.status || "") === "FILLED") break;
      const waitMs = elapsed < AUTO_SETTLEMENT_FAST_WINDOW_MS ? AUTO_SETTLEMENT_FAST_POLL_MS : AUTO_SETTLEMENT_SLOW_POLL_MS;
      await sleep(waitMs);
    }
  } finally {
    PENDING_SETTLEMENT_WATCHERS.delete(key);
  }
}

async function processPendingSettlement(config, pending, filters, options = {}) {
  const order = await queryOrderByClientId(config, pending.symbol, pending.entryClientOrderId);
  const executedQty = Number(order.executedQty || order.cumQty || 0);
  return processPendingSettlementWithExecution(config, pending, filters, {
    executedQty,
    status: String(order.status || ""),
    watcher: options.fromWatcher ? "fast" : "snapshot"
  });
}

async function processPendingSettlementWithExecution(config, pending, filters, execution) {
  const key = watcherKey(pending);
  const now = Date.now();
  if (Number(pending.nextAttemptAt || 0) > now) {
    return {
      ok: true,
      pending: true,
      status: execution.status || "",
      executedQty: Number(execution.executedQty || 0),
      placedQty: Number(pending.placedQty || 0),
      placedNow: "0",
      reason: "cooldown",
      nextAttemptAt: pending.nextAttemptAt,
      watcher: execution.watcher
    };
  }
  if (PENDING_SETTLEMENT_PROCESSING.has(key)) {
    return { ok: true, pending: true, status: execution.status || "", placedNow: "0", reason: "already processing" };
  }
  PENDING_SETTLEMENT_PROCESSING.add(key);

  try {
    const executedQty = Number(execution.executedQty || 0);
    const status = String(execution.status || "");
    const tpEnabled = isPendingAutoSettlementEnabled(pending);
    const slEnabled = Boolean(pending.slOrderEnabled);
    let result = {
      ok: true,
      pending: true,
      status,
      executedQty,
      placedQty: Number(pending.placedQty || 0),
      placedNow: "0",
      watcher: execution.watcher
    };

    if (tpEnabled) {
      result = {
        ...result,
        ...(await processPendingTpSettlement(config, pending, filters, { executedQty, status, watcher: execution.watcher }))
      };
    } else if (!slEnabled) {
      const terminal = ["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(status);
      if (terminal) await removePendingSettlement(pending);
      return { ...result, pending: !terminal };
    }

    if (slEnabled) {
      const slResult = await processPendingSlOrder(config, pending, filters, { executedQty, status, watcher: execution.watcher });
      result = {
        ...result,
        pending: result.pending && slResult.pending,
        slOrder: slResult,
        slPlacedQty: slResult.slPlacedQty,
        slPrice: slResult.slPrice,
        slTriggerPrice: slResult.triggerPrice
      };
      if (slResult.ok === false) {
        return {
          ...result,
          ok: false,
          pending: true,
          retryable: slResult.retryable,
          error: slResult.error,
          code: slResult.code
        };
      }
    }

    return result;
  } finally {
    PENDING_SETTLEMENT_PROCESSING.delete(key);
  }
}

function isPendingAutoSettlementEnabled(pending) {
  return pending?.settlementEnabled !== false && Boolean(pending?.settlementPrice) && Boolean(pending?.exitSide);
}

async function processPendingTpSettlement(config, pending, filters, execution) {
  const executedQty = Number(execution.executedQty || 0);
  const pendingPlacedQty = Number(pending.placedQty || 0);
  const ledgerPlacedQty = await getSettlementFillPlacedQty(pending);
  const placedQty = Math.max(
    Number.isFinite(pendingPlacedQty) ? pendingPlacedQty : 0,
    ledgerPlacedQty
  );
  const remainingToPlace = executedQty - placedQty;
  const status = String(execution.status || "");

  if (remainingToPlace <= Number(filters.stepSize) / 2) {
    const terminal = ["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(status);
    if (!terminal && Number(pending.placedQty || 0) < placedQty) {
      pending.placedQty = floorToStep(placedQty, filters.stepSize);
      pending.updatedAt = Date.now();
      await updatePendingSettlement(pending);
    }
    if (terminal && !pending.slOrderEnabled) await removePendingSettlement(pending);
    return { ok: true, pending: !terminal || Boolean(pending.slOrderEnabled), status, executedQty, placedQty, placedNow: "0", watcher: execution.watcher };
  }

  const pendingExitIds = getPendingAutoSettlementExitClientOrderIds(pending);
  const indexedAutoExitIds = (await getIndexedExitOrderIds(pending.symbol, pending.exitSide))
    .filter(id => id.startsWith("mb_tp_"));
  const pendingExitIdSet = new Set(pendingExitIds);
  const foreignAutoExitIds = indexedAutoExitIds.filter(id => !pendingExitIdSet.has(id));
  const usePositionSettlement = pending.positionSettlement === true || foreignAutoExitIds.length > 0;
  let positionSettlement = null;
  if (usePositionSettlement) {
    const position = await getOneWayPosition(config, pending.symbol);
    positionSettlement = buildPositionBasedAutoSettlement({ pending, position, filters });
    pending.positionSettlement = true;
    pending.settlementPriceOffset = positionSettlement.priceOffset;
    pending.settlementPrice = positionSettlement.settlementPrice;
    pending.quantity = positionSettlement.quantity;
  }

  const existingExitIds = positionSettlement
    ? uniqueStrings([...pendingExitIds, ...indexedAutoExitIds])
    : pendingExitIds;
  let baseCoveredQty = placedQty;
  let placeQty = floorToStep(remainingToPlace, filters.stepSize);
  if (existingExitIds.length) {
    const cancelResult = await cancelPendingAutoSettlementExitOrders(config, pending, existingExitIds);
    baseCoveredQty = cancelResult.executedQty;
    pending.exitClientOrderIds = [];
    if (positionSettlement) {
      placeQty = positionSettlement.quantity;
    } else {
      const aggregateQty = executedQty - baseCoveredQty;
      placeQty = floorToStep(aggregateQty, filters.stepSize);
    }
  } else if (positionSettlement) {
    placeQty = positionSettlement.quantity;
  }
  if (Number(placeQty) <= 0) return { ok: true, pending: true, status, executedQty, placedQty, placedNow: "0", reason: "quantity below stepSize", watcher: execution.watcher };

  try {
    const reservedPlacedQty = positionSettlement
      ? floorToStep(executedQty, filters.stepSize)
      : floorToStep(baseCoveredQty + Number(placeQty), filters.stepSize);
    pending.placedQty = reservedPlacedQty;
    pending.updatedAt = Date.now();
    await setSettlementFillPlacedQty(pending, reservedPlacedQty);

    const placed = await placeAutoSettlementExitOrderWithChase({
      config,
      pending,
      filters,
      quantity: placeQty,
      maxRetries: 2
    });

    await addIndexedExitOrderId(pending.symbol, pending.exitSide, placed.clientOrderId);
    pending.exitClientOrderIds = [placed.clientOrderId];
    delete pending.nextAttemptAt;

    if (["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(status) && Number(pending.placedQty) >= executedQty - Number(filters.stepSize) / 2 && !pending.slOrderEnabled) {
      await removePendingSettlement(pending);
    } else {
      await updatePendingSettlement(pending);
    }

    return {
      ok: true,
      pending: true,
      status,
      executedQty,
      placedQty: pending.placedQty,
      placedNow: placeQty,
      settlementPrice: placed.price,
      attempts: placed.attempts,
      response: placed.response,
      watcher: execution.watcher
    };
  } catch (err) {
    pending.placedQty = floorToStep(baseCoveredQty, filters.stepSize);
    await setSettlementFillPlacedQty(pending, pending.placedQty);
    if (isReduceOnlyRejectError(err) || isGtxRejectError(err)) {
      pending.updatedAt = Date.now();
      pending.nextAttemptAt = pending.updatedAt + AUTO_SETTLEMENT_RETRY_COOLDOWN_MS;
      await updatePendingSettlement(pending);
      return { ok: false, pending: true, status, executedQty, placedQty, placedNow: "0", retryable: true, nextAttemptAt: pending.nextAttemptAt, error: err?.message || String(err), code: err?.code, watcher: execution.watcher };
    }
    throw err;
  }
}

function getPendingAutoSettlementExitClientOrderIds(pending) {
  return uniqueStrings(pending?.exitClientOrderIds)
    .filter(id => id.startsWith("mb_tp_"));
}

async function cancelPendingAutoSettlementExitOrders(config, pending, clientOrderIds) {
  const ids = uniqueStrings(clientOrderIds);
  if (!ids.length) return { ids: [], results: [], executedQty: 0 };
  const results = await cancelIndexedExitOrders(config, pending.symbol, ids);
  await removeIndexedExitOrderIds(pending.symbol, pending.exitSide, ids);
  const executedQty = results.reduce((sum, item) => {
    const qty = Number(item?.response?.executedQty ?? item?.response?.cumQty ?? 0);
    return sum + (Number.isFinite(qty) && qty > 0 ? qty : 0);
  }, 0);
  return { ids, results, executedQty };
}

function calculateAutoSettlementPriceOffset({ entryPrice, settlementPrice }) {
  const entry = Number(entryPrice);
  const settlement = Number(settlementPrice);
  const offset = Math.abs(settlement - entry);
  return Number.isFinite(offset) && offset > 0 ? String(offset) : null;
}

function buildPositionBasedAutoSettlement({ pending, position, filters }) {
  const positionAmt = Number(position?.positionAmt || 0);
  const averagePrice = Number(position?.entryPrice || 0);
  const positionQty = Math.abs(positionAmt);
  const expectedLong = pending.entrySide === "BUY" && pending.exitSide === "SELL";
  const expectedShort = pending.entrySide === "SELL" && pending.exitSide === "BUY";
  const sameDirection = (expectedLong && positionAmt > 0) || (expectedShort && positionAmt < 0);
  if (!sameDirection) throw new Error("Auto settlement position direction does not match entry side");
  if (!Number.isFinite(averagePrice) || averagePrice <= 0) throw new Error("Auto settlement average entry price is unavailable");
  if (!Number.isFinite(positionQty) || positionQty <= 0) throw new Error("Auto settlement position quantity is unavailable");

  const storedOffset = Number(pending.settlementPriceOffset || 0);
  const fallbackOffset = Number(calculateAutoSettlementPriceOffset({
    entryPrice: pending.entryPrice,
    settlementPrice: pending.settlementPrice
  }) || 0);
  const priceOffset = Number.isFinite(storedOffset) && storedOffset > 0 ? storedOffset : fallbackOffset;
  if (!Number.isFinite(priceOffset) || priceOffset <= 0) throw new Error("Auto settlement price offset is unavailable");

  const rawTarget = expectedLong ? averagePrice + priceOffset : averagePrice - priceOffset;
  if (!Number.isFinite(rawTarget) || rawTarget <= 0) throw new Error("Invalid average-price auto settlement target");
  const settlementPrice = expectedLong
    ? ceilToStep(rawTarget, filters.tickSize)
    : floorToStep(rawTarget, filters.tickSize);
  const quantity = floorToStep(positionQty, filters.stepSize);
  return {
    averagePrice,
    priceOffset: String(priceOffset),
    quantity,
    settlementPrice
  };
}

async function processPendingSlOrder(config, pending, filters, execution) {
  const executedQty = Number(execution.executedQty || 0);
  if (!Number.isFinite(executedQty) || executedQty <= Number(filters.stepSize) / 2) {
    return { ok: true, pending: true, slPlacedQty: pending.slPlacedQty || "0", placedNow: "0", reason: "no executed quantity" };
  }

  try {
    const position = await getOneWayPosition(config, pending.symbol);
    const slOrder = buildPositionBasedSlOrder({ pending, position, filters });
    const existingIds = uniqueStrings([
      ...getPendingSlOrderClientAlgoIds(pending),
      ...(await getIndexedExitOrderIds(pending.symbol, pending.exitSide)).filter(id => id.startsWith("mb_sl_"))
    ]);
    const currentSlPlacedQty = Number(pending.slPlacedQty || 0);
    const sameOrderAlreadyPlaced = currentSlPlacedQty >= Number(slOrder.quantity) - Number(filters.stepSize) / 2
      && String(pending.slPrice || "") === String(slOrder.slPrice)
      && String(pending.slTriggerPrice || "") === String(slOrder.triggerPrice)
      && existingIds.length > 0;
    if (sameOrderAlreadyPlaced) {
      return {
        ok: true,
        pending: true,
        slPlacedQty: pending.slPlacedQty,
        slPrice: pending.slPrice,
        triggerPrice: pending.slTriggerPrice,
        placedNow: "0",
        reason: "already placed"
      };
    }

    if (existingIds.length) {
      await cancelPendingSlAlgoOrders(config, pending, existingIds);
      pending.slClientAlgoIds = [];
    }

    const placed = await placeSlAlgoOrder({ config, pending, slOrder });
    await addIndexedExitOrderId(pending.symbol, pending.exitSide, placed.clientAlgoId);
    pending.slClientAlgoIds = [placed.clientAlgoId];
    pending.slPlacedQty = slOrder.quantity;
    pending.slPrice = slOrder.slPrice;
    pending.slTriggerPrice = slOrder.triggerPrice;
    pending.slPriceOffset = slOrder.priceOffset;
    pending.updatedAt = Date.now();
    delete pending.nextAttemptAt;

    const terminal = ["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(String(execution.status || ""));
    const tpComplete = !isPendingAutoSettlementEnabled(pending)
      || Number(pending.placedQty || 0) >= executedQty - Number(filters.stepSize) / 2;
    if (terminal && tpComplete) await removePendingSettlement(pending);
    else await updatePendingSettlement(pending);

    return {
      ok: true,
      pending: !(terminal && tpComplete),
      slPlacedQty: slOrder.quantity,
      slPrice: slOrder.slPrice,
      triggerPrice: slOrder.triggerPrice,
      placedNow: slOrder.quantity,
      clientAlgoId: placed.clientAlgoId,
      response: placed.response
    };
  } catch (err) {
    if (isReduceOnlyRejectError(err) || isGtxRejectError(err)) {
      pending.updatedAt = Date.now();
      pending.nextAttemptAt = pending.updatedAt + AUTO_SETTLEMENT_RETRY_COOLDOWN_MS;
      await updatePendingSettlement(pending);
      return { ok: false, pending: true, retryable: true, slPlacedQty: pending.slPlacedQty || "0", placedNow: "0", nextAttemptAt: pending.nextAttemptAt, error: err?.message || String(err), code: err?.code };
    }
    throw err;
  }
}

function getPendingSlOrderClientAlgoIds(pending) {
  return uniqueStrings(pending?.slClientAlgoIds)
    .filter(id => id.startsWith("mb_sl_"));
}

function buildPositionBasedSlOrder({ pending, position, filters }) {
  const positionAmt = Number(position?.positionAmt || 0);
  const averagePrice = Number(position?.entryPrice || 0);
  const positionQty = Math.abs(positionAmt);
  const expectedLong = pending.entrySide === "BUY" && pending.exitSide === "SELL";
  const expectedShort = pending.entrySide === "SELL" && pending.exitSide === "BUY";
  const sameDirection = (expectedLong && positionAmt > 0) || (expectedShort && positionAmt < 0);
  if (!sameDirection) throw new Error("SL order position direction does not match entry side");
  if (!Number.isFinite(averagePrice) || averagePrice <= 0) throw new Error("SL order average entry price is unavailable");
  if (!Number.isFinite(positionQty) || positionQty <= 0) throw new Error("SL order position quantity is unavailable");

  const storedOffset = Number(pending.slPriceOffset || 0);
  const fallbackOffset = Number(calculateAutoSettlementPriceOffset({
    entryPrice: pending.entryPrice,
    settlementPrice: pending.slPrice
  }) || 0);
  const priceOffset = Number.isFinite(storedOffset) && storedOffset > 0 ? storedOffset : fallbackOffset;
  if (!Number.isFinite(priceOffset) || priceOffset <= 0) throw new Error("SL order price offset is unavailable");

  const rawTarget = expectedLong ? averagePrice - priceOffset : averagePrice + priceOffset;
  if (!Number.isFinite(rawTarget) || rawTarget <= 0) throw new Error("Invalid average-price SL order target");
  const slPrice = expectedLong
    ? floorToStep(rawTarget, filters.tickSize)
    : ceilToStep(rawTarget, filters.tickSize);
  const triggerPrice = midpointTriggerPrice({
    entryPrice: averagePrice,
    slPrice,
    side: pending.exitSide,
    filters
  });
  const quantity = floorToStep(positionQty, filters.stepSize);
  return {
    averagePrice,
    priceOffset: String(priceOffset),
    quantity,
    slPrice,
    triggerPrice
  };
}

async function placeSlAlgoOrder({ config, pending, slOrder }) {
  const clientAlgoId = makeSlClientAlgoId(pending.exitSide);
  const order = {
    symbol: pending.symbol,
    side: pending.exitSide,
    algoType: "CONDITIONAL",
    type: "STOP",
    timeInForce: "GTX",
    quantity: slOrder.quantity,
    price: slOrder.slPrice,
    triggerPrice: slOrder.triggerPrice,
    reduceOnly: "true",
    workingType: "CONTRACT_PRICE",
    recvWindow: config.recvWindow,
    clientAlgoId
  };
  const response = await signedRequest(config, "POST", "/fapi/v1/algoOrder", order);
  return { response, clientAlgoId };
}

async function cancelPendingSlAlgoOrders(config, pending, clientAlgoIds) {
  const ids = uniqueStrings(clientAlgoIds);
  const settled = await Promise.allSettled(ids.map(clientAlgoId => (
    signedRequest(config, "DELETE", "/fapi/v1/algoOrder", {
      clientAlgoId,
      recvWindow: config.recvWindow
    })
  )));
  const results = settled.map((result, index) => normalizeCancelResult(result, ids[index], false));
  await removeIndexedExitOrderIds(pending.symbol, pending.exitSide, ids);
  return results;
}

async function placeAutoSettlementExitOrderWithChase({ config, pending, filters, quantity, maxRetries }) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let settlementPrice = pending.settlementPrice;

    // Fast path: the ROI target is normally away from the market, so send it
    // directly and let GTX guard maker-only status. Only refetch book after a
    // GTX rejection, which avoids one public REST round trip in the common case.
    if (attempt > 0) {
      const book = await publicGet(config.baseUrl, "/fapi/v1/ticker/bookTicker", { symbol: pending.symbol });
      settlementPrice = adjustSettlementPriceForMaker({
        targetPrice: pending.settlementPrice,
        side: pending.exitSide,
        book,
        filters,
        makerTicks: Number(pending.makerTicks || 1)
      });
    }

    const clientOrderId = makeAutoSettlementClientOrderId(pending.exitSide);
    const exitOrder = {
      symbol: pending.symbol,
      side: pending.exitSide,
      type: "LIMIT",
      timeInForce: "GTX",
      quantity,
      price: settlementPrice,
      reduceOnly: "true",
      recvWindow: config.recvWindow,
      newClientOrderId: clientOrderId
    };

    try {
      const response = await signedRequest(config, "POST", "/fapi/v1/order", exitOrder);
      return { response, price: settlementPrice, clientOrderId, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (!isGtxRejectError(err) || attempt >= maxRetries) throw err;
    }
  }
  throw lastError || new Error("Auto settlement exit failed");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isReduceOnlyRejectError(err) {
  const msg = String(err?.message || "");
  return err?.code === -2022 || /reduce[- ]?only|ReduceOnly|reduce only/i.test(msg);
}

function adjustSettlementPriceForMaker({ targetPrice, side, book, filters, makerTicks }) {
  const makerPrice = calculateMakerPriceFromBook({ side, book, filters, makerTicks });
  if (side === "SELL") return Number(targetPrice) > Number(makerPrice.price) ? targetPrice : makerPrice.price;
  return Number(targetPrice) < Number(makerPrice.price) ? targetPrice : makerPrice.price;
}

function makeAutoSettlementClientOrderId(side) {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `mb_tp_${side.toLowerCase()}_${Date.now()}_${rand[0].toString(36)}${rand[1].toString(36)}`.slice(0, 36);
}

function makeSlClientAlgoId(side) {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `mb_sl_${side.toLowerCase()}_${Date.now()}_${rand[0].toString(36)}${rand[1].toString(36)}`.slice(0, 36);
}

async function queryOrderByClientId(config, symbol, origClientOrderId) {
  return signedRequest(config, "GET", "/fapi/v1/order", {
    symbol,
    origClientOrderId,
    recvWindow: config.recvWindow
  });
}

async function refreshExitOrderIndex(config, symbol) {
  const orders = await getReplaceableReduceOnlyOrders(config, symbol);
  const grouped = { BUY: [], SELL: [] };
  for (const order of orders) {
    const side = order.side === "BUY" ? "BUY" : order.side === "SELL" ? "SELL" : null;
    const id = String(order.clientOrderId || order.origClientOrderId || "");
    if (side && id) grouped[side].push(id);
  }
  const current = await readExitOrderIndex();
  current[symbol] = {
    ...(current[symbol] || {}),
    BUY: grouped.BUY.slice(-5),
    SELL: grouped.SELL.slice(-5)
  };
  await persistExitOrderIndexNow(current);
}

async function getReplaceableReduceOnlyOrders(config, symbol, side) {
  const orders = await signedRequest(config, "GET", "/fapi/v1/openOrders", {
    symbol,
    recvWindow: config.recvWindow
  });
  if (!Array.isArray(orders)) return [];
  return orders.filter(order =>
    order.symbol === symbol &&
    (!side || order.side === side) &&
    isReduceOnlyOrder(order) &&
    isExtensionOrder(order)
  );
}

async function getLiveReplaceableExitOrderIds(config, symbol, side) {
  const orders = await getReplaceableReduceOnlyOrders(config, symbol, side);
  return orders
    .map(order => String(order.clientOrderId || order.origClientOrderId || ""))
    .filter(Boolean);
}

async function getLiveReplaceableExitOrderIdsSafe(config, symbol, side) {
  try {
    return { ids: await getLiveReplaceableExitOrderIds(config, symbol, side), error: null };
  } catch (err) {
    return { ids: [], error: err?.message || String(err), code: err?.code };
  }
}

async function getExitReplacementOrderIds(config, symbol, side, liveReplacementIdsPromise) {
  const livePromise = liveReplacementIdsPromise || getLiveReplaceableExitOrderIdsSafe(config, symbol, side);
  const [indexedIds, liveResult] = await Promise.all([
    getIndexedExitOrderIds(symbol, side),
    livePromise
  ]);
  if (liveResult?.error) {
    const err = new Error(`Cannot reconcile existing reduce-only exit orders: ${liveResult.error}`);
    if (liveResult.code !== undefined) err.code = liveResult.code;
    throw err;
  }
  const liveIds = Array.isArray(liveResult?.ids) ? liveResult.ids : [];
  return {
    ids: uniqueStrings([...indexedIds, ...liveIds]),
    indexedIds: uniqueStrings(indexedIds),
    liveIds: uniqueStrings(liveIds),
    source: liveReplacementIdsPromise ? "indexed+openOrders(speculative)" : "indexed+openOrders"
  };
}

function wouldReducePosition(side, position) {
  const amt = Number(position?.positionAmt || 0);
  return (side === "BUY" && amt < 0) || (side === "SELL" && amt > 0);
}

function uniqueStrings(values) {
  const list = Array.isArray(values) ? values : (values ? [values] : []);
  return [...new Set(list.filter(Boolean).map(String))];
}

function isReduceOnlyOrder(order) {
  return order.reduceOnly === true || order.reduceOnly === "true";
}

function isExtensionOrder(order) {
  const id = String(order.clientOrderId || order.origClientOrderId || "");
  return id.startsWith("mb_buy_") || id.startsWith("mb_sell_") || id.startsWith("mb_tp_") || id.startsWith("mb_sl_");
}

async function readExitOrderIndex() {
  if (EXIT_ORDER_INDEX_CACHE && typeof EXIT_ORDER_INDEX_CACHE === "object") return EXIT_ORDER_INDEX_CACHE;
  const data = await chrome.storage.local.get(["exitOrderIndex"]);
  EXIT_ORDER_INDEX_CACHE = data.exitOrderIndex && typeof data.exitOrderIndex === "object" ? data.exitOrderIndex : {};
  return EXIT_ORDER_INDEX_CACHE;
}

async function persistExitOrderIndexNow(index) {
  EXIT_ORDER_INDEX_CACHE = index && typeof index === "object" ? index : {};
  clearTimeout(EXIT_ORDER_INDEX_WRITE_TIMER);
  EXIT_ORDER_INDEX_WRITE_TIMER = null;
  await chrome.storage.local.set({ exitOrderIndex: EXIT_ORDER_INDEX_CACHE });
}

async function getIndexedExitOrderIds(symbol, side) {
  const index = await readExitOrderIndex();
  const ids = index?.[symbol]?.[side];
  return Array.isArray(ids) ? [...new Set(ids.filter(Boolean).map(String))].slice(-5) : [];
}

async function removeIndexedExitOrderIds(symbol, side, removedIds) {
  const index = await readExitOrderIndex();
  const symbolIndex = index[symbol] || {};
  const oldIds = Array.isArray(symbolIndex[side]) ? symbolIndex[side] : [];
  const removed = new Set(removedIds.map(String));
  index[symbol] = { ...symbolIndex, [side]: oldIds.filter(id => !removed.has(String(id))).slice(-5) };
  await persistExitOrderIndexNow(index);
}

async function addIndexedExitOrderId(symbol, side, newId) {
  const index = await readExitOrderIndex();
  const symbolIndex = index[symbol] || {};
  const oldIds = Array.isArray(symbolIndex[side]) ? symbolIndex[side] : [];
  index[symbol] = { ...symbolIndex, [side]: [...oldIds.filter(id => id !== newId), newId].slice(-5) };
  await persistExitOrderIndexNow(index);
}

async function cancelIndexedExitOrders(config, symbol, clientOrderIds) {
  const uniqueIds = uniqueStrings(clientOrderIds);
  if (!uniqueIds.length) return [];

  const results = [];
  for (let i = 0; i < uniqueIds.length; i += 10) {
    const chunk = uniqueIds.slice(i, i + 10);
    if (chunk.length > 1) {
      try {
        const batchResults = await batchCancelOpenOrdersByClientIds(config, symbol, chunk);
        results.push(...batchResults);
        continue;
      } catch (err) {
        // Fallback keeps replace mode usable on accounts/endpoints that reject batch cancel formatting.
      }
    }

    const settled = await Promise.allSettled(
      chunk.map(origClientOrderId => cancelOpenOrderByClientId(config, symbol, origClientOrderId))
    );
    results.push(...settled.map((result, j) => normalizeCancelResult(result, chunk[j], false)));
  }
  return results;
}

async function batchCancelOpenOrdersByClientIds(config, symbol, clientOrderIds) {
  const response = await signedRequest(config, "DELETE", "/fapi/v1/batchOrders", {
    symbol,
    origClientOrderIdList: JSON.stringify(clientOrderIds),
    recvWindow: config.recvWindow
  });
  if (!Array.isArray(response)) return [];
  return response.map((item, i) => {
    const origClientOrderId = clientOrderIds[i] || item.origClientOrderId || item.clientOrderId;
    if (item?.code !== undefined) {
      const err = new Error(item.msg || `Cancel failed: ${item.code}`);
      err.code = item.code;
      return normalizeCancelResult({ status: "rejected", reason: err }, origClientOrderId, true);
    }
    return { ok: true, batch: true, origClientOrderId, response: item };
  });
}

function normalizeCancelResult(result, origClientOrderId, batch) {
  if (result.status === "fulfilled") return { ok: true, batch, origClientOrderId, response: result.value };
  const err = result.reason;
  if (err?.code === -2011 || /Unknown order|Order does not exist/i.test(err?.message || "")) {
    return { ok: true, batch, ignored: true, origClientOrderId, error: err.message };
  }
  throw err;
}

async function cancelOpenOrderByClientId(config, symbol, origClientOrderId) {
  return signedRequest(config, "DELETE", "/fapi/v1/order", {
    symbol,
    origClientOrderId,
    recvWindow: config.recvWindow
  });
}

async function changeInitialLeverage(config, symbol, leverage) {
  return signedRequest(config, "POST", "/fapi/v1/leverage", {
    symbol,
    leverage,
    recvWindow: config.recvWindow
  });
}

async function getTradingSnapshot({ symbol }) {
  const config = await getConfigRaw();
  symbol = normalizeSymbol(symbol);
  ensureMarketStreamForSymbol(config, symbol).catch(err => {
    MARKET_STREAM_STATE.lastError = err?.message || String(err);
    MARKET_STREAM_STATE.status = "fallback-rest";
    MARKET_STREAM_STATE.fallbackReason = "snapshot market start failed";
  });

  const positionResult = config.apiKey && config.apiSecret
    ? await getFastPosition(config, symbol).catch(err => ({
        position: { error: err?.message || String(err), positionAmt: 0, leverage: null },
        source: err?.localRestPause ? "rest-paused" : "error",
        ageMs: null
      }))
    : { position: { error: "API key/secret not configured", positionAmt: 0, leverage: null }, source: "none", ageMs: null };
  let position = positionResult.position;
  if (config.apiKey && config.apiSecret) {
    processPendingSettlementsForSymbol(config, symbol).catch(() => {});
    if (!config.dryRun) {
      ensureUserStreamForConfig(config).catch(err => {
        USER_STREAM_STATE.lastError = err?.message || String(err);
        setUserStreamFallback("snapshot start failed");
      });
    } else if (config.dryRun) {
      setUserStreamDryRun();
    }
  }
  const marketSnapshot = getMarketTickerSnapshot({ baseUrl: config.baseUrl, symbol });
  const book = bookFromMarketSnapshot(marketSnapshot);
  const bid = Number(book?.bidPrice);
  const ask = Number(book?.askPrice);
  const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const mark = Number(position.markPrice || 0);
  const wsCurrent = Number(marketSnapshot.currentPrice);
  const currentPrice = Number.isFinite(wsCurrent) && wsCurrent > 0
    ? wsCurrent
    : Number.isFinite(mark) && mark > 0 ? mark : mid;
  position = addLivePositionPnl(position, { currentPrice });

  let autoSettlementPreview = null;
  try {
    if (book) {
      const filters = await getSymbolFilters(config.baseUrl, symbol);
      autoSettlementPreview = buildAutoSettlementPreview({ config, symbol, book, filters });
    }
  } catch (_) {
    autoSettlementPreview = null;
  }

  return {
    symbol,
    bid: book?.bidPrice || null,
    ask: book?.askPrice || null,
    currentPrice: currentPrice === null ? null : String(currentPrice),
    priceSource: marketSnapshot.currentPrice ? marketSnapshot.source : (Number.isFinite(mark) && mark > 0 ? "position-mark" : "none"),
    priceAgeMs: marketSnapshot.ageMs,
    marketStreamStatus: getMarketStreamStatus(),
    position,
    autoSettlementPreview,
    userStreamStatus: getUserStreamStatus()
  };
}

async function getFastPosition(config, symbol) {
  const cached = readPositionCache(config, symbol);
  if (cached) return cached;
  const position = await getOneWayPosition(config, symbol);
  return { position, source: "rest", ageMs: 0 };
}

function positionCacheKey(config, symbol) {
  return `${config.baseUrl}:${config.apiKey || ""}:${symbol}`;
}

function readPositionCache(config, symbol) {
  const cached = POSITION_CACHE.get(positionCacheKey(config, symbol));
  if (!cached) return null;
  const ageMs = Date.now() - cached.ts;
  if (ageMs > POSITION_CACHE_TTL_MS) return null;
  return { position: cached.position, source: "cache", ageMs };
}

function writePositionCache(config, symbol, position) {
  POSITION_CACHE.set(positionCacheKey(config, symbol), { ts: Date.now(), position });
}

function addLivePositionPnl(position, marketSnapshot) {
  if (!position || typeof position !== "object") return position;
  const currentPrice = Number(marketSnapshot?.currentPrice);
  const positionAmt = Number(position.positionAmt || 0);
  const basis = Number(position.breakEvenPrice || position.entryPrice || 0);
  const live = { ...position };
  if (Number.isFinite(currentPrice) && currentPrice > 0) {
    live.markPrice = currentPrice;
    live.notional = roundFinancial(Math.abs(positionAmt * currentPrice));
    if (Number.isFinite(positionAmt) && positionAmt !== 0 && Number.isFinite(basis) && basis > 0) {
      live.unrealizedProfit = roundFinancial((currentPrice - basis) * positionAmt);
    }
  }
  return live;
}

function roundFinancial(value) {
  return Number.isFinite(value) ? Number(value.toFixed(8)) : value;
}

async function getOneWayPosition(config, symbol) {
  const positions = await signedRequest(config, "GET", "/fapi/v3/positionRisk", { symbol, recvWindow: config.recvWindow });
  const both = Array.isArray(positions) ? positions.find(p => p.symbol === symbol && p.positionSide === "BOTH") : null;
  let position;
  if (!both) {
    position = {
      positionAmt: 0,
      leverage: null,
      entryPrice: null,
      breakEvenPrice: null,
      markPrice: null,
      unrealizedProfit: null,
      notional: null
    };
  } else {
    const leverage = Number(both.leverage || 0);
    const numOrNull = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    position = {
      positionAmt: numOrNull(both.positionAmt) || 0,
      leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : null,
      entryPrice: numOrNull(both.entryPrice),
      breakEvenPrice: numOrNull(both.breakEvenPrice),
      markPrice: numOrNull(both.markPrice),
      unrealizedProfit: numOrNull(both.unRealizedProfit ?? both.unrealizedProfit),
      notional: numOrNull(both.notional)
    };
  }
  writePositionCache(config, symbol, position);
  return position;
}

async function publicGet(baseUrl, path, params = {}) {
  assertBinanceRestAllowed();
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw enrichHttpError(data, res.status);
  return data;
}

async function signedRequest(config, method, path, params = {}) {
  assertBinanceRestAllowed();
  const signedParams = { ...params, timestamp: Date.now() };
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(signedParams)) {
    if (v !== undefined && v !== null && v !== "") query.append(k, String(v));
  }
  const signature = await hmacSha256Hex(config.apiSecret, query.toString());
  query.append("signature", signature);

  const url = new URL(path, config.baseUrl);
  const headers = { "X-MBX-APIKEY": config.apiKey };
  let fetchUrl = url.toString();
  const options = { method, headers };

  if (method === "GET" || method === "DELETE") {
    fetchUrl += `?${query.toString()}`;
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = query.toString();
  }

  const res = await fetch(fetchUrl, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw enrichHttpError(data, res.status);
  return data;
}

function enrichHttpError(data, status) {
  rememberBinanceRestBan(data);
  const err = new Error(data?.msg || `HTTP ${status}`);
  err.status = status;
  if (data?.code !== undefined) err.code = data.code;
  return err;
}

async function getHmacKey(secret) {
  if (HMAC_KEY_CACHE && HMAC_SECRET_CACHE === secret) return HMAC_KEY_CACHE;
  HMAC_SECRET_CACHE = secret;
  HMAC_KEY_CACHE = await crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return HMAC_KEY_CACHE;
}

async function hmacSha256Hex(secret, text) {
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function decimalsFromStep(step) {
  const s = String(step);
  if (!s.includes(".")) return 0;
  return s.replace(/0+$/, "").split(".")[1]?.length || 0;
}

function floorToStep(value, step) {
  const n = Number(step);
  const d = decimalsFromStep(step);
  const floored = Math.floor((Number(value) + Number.EPSILON) / n) * n;
  return floored.toFixed(d);
}

function ceilToStep(value, step) {
  const n = Number(step);
  const d = decimalsFromStep(step);
  const ceiled = Math.ceil((Number(value) - Number.EPSILON) / n) * n;
  return ceiled.toFixed(d);
}

function makeClientOrderId(side) {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `mb_${side.toLowerCase()}_${Date.now()}_${rand[0].toString(36)}${rand[1].toString(36)}`.slice(0, 36);
}

globalThis.__BMW_TEST__ = {
  buildUserStreamWsUrl,
  buildMarketBookTickerWsUrl,
  ensureMarketStreamForSymbol,
  handleMarketBookTickerMessage,
  getMarketTickerSnapshot,
  shouldResetPendingSettlementsOnInstall,
  isEntryFillEvent,
  calculateSettlementDeltaFromEvent,
  processUserStreamEntryFill,
  processPendingSettlementsForSymbol,
  ensureUserStreamForConfig,
  getUserStreamStatus,
  warmupSymbol,
  addPendingSettlement,
  addIndexedExitOrderId
};
