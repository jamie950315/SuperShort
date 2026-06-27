import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadBackground(extra = {}) {
  const code = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const listeners = {
    installed: [],
    message: []
  };
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    RegExp,
    Error,
    JSON,
    crypto: {
      getRandomValues(array) {
        for (let i = 0; i < array.length; i += 1) array[i] = 123456 + i;
        return array;
      },
      subtle: {
        async importKey() {
          return {};
        },
        async sign() {
          return new Uint8Array([1, 2, 3, 4]).buffer;
        }
      }
    },
    chrome: {
      runtime: {
        onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
        onMessage: { addListener(fn) { listeners.message.push(fn); } }
      },
      storage: {
        local: {
          async get() { return {}; },
          async set() {}
        }
      }
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    WebSocket: class MockWebSocket {},
    ...extra
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "background.js" });
  return { ...sandbox.__BMW_TEST__, __listeners: listeners };
}

function sendRuntimeMessage(api, message) {
  return new Promise((resolve) => {
    const listener = api.__listeners.message[0];
    assert.equal(typeof listener, "function");
    listener(message, {}, resolve);
  });
}

function makeStorage(initial) {
  const state = { ...initial };
  return {
    state,
    async get(keys) {
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map(key => [key, state[key]]));
      }
      return { ...state };
    },
    async set(values) {
      Object.assign(state, values);
    }
  };
}

test("0.2.8 derives the correct USD-M user stream WebSocket URL", () => {
  const api = loadBackground();
  assert.equal(
    api.buildUserStreamWsUrl("https://fapi.binance.com", "abc123"),
    "wss://fstream.binance.com/private/ws/abc123"
  );
  assert.equal(
    api.buildUserStreamWsUrl("https://testnet.binancefuture.com", "abc123"),
    "wss://fstream.binancefuture.com/ws/abc123"
  );
});

test("0.2.8 recognizes only extension entry fill events", () => {
  const api = loadBackground();
  assert.equal(api.isEntryFillEvent({
    e: "ORDER_TRADE_UPDATE",
    o: { c: "mb_buy_1", x: "TRADE", z: "0.003" }
  }), true);
  assert.equal(api.isEntryFillEvent({
    e: "ORDER_TRADE_UPDATE",
    o: { c: "mb_tp_sell_1", x: "TRADE", z: "0.003" }
  }), false);
  assert.equal(api.isEntryFillEvent({
    e: "ACCOUNT_UPDATE",
    o: { c: "mb_buy_1", x: "TRADE", z: "0.003" }
  }), false);
});

test("0.2.8 computes settlement delta from accumulated fill without double counting", () => {
  const api = loadBackground();
  const pending = { placedQty: "0.003" };
  assert.equal(api.calculateSettlementDeltaFromEvent(pending, {
    e: "ORDER_TRADE_UPDATE",
    o: { c: "mb_buy_1", x: "TRADE", X: "PARTIALLY_FILLED", z: "0.007", l: "0.004" }
  }, { stepSize: "0.001" }), "0.004");
  assert.equal(api.calculateSettlementDeltaFromEvent(pending, {
    e: "ORDER_TRADE_UPDATE",
    o: { c: "mb_buy_1", x: "TRADE", X: "PARTIALLY_FILLED", z: "0.003", l: "0.000" }
  }, { stepSize: "0.001" }), "0");
});

test("0.2.8 dry run does not request a listenKey or open WebSocket", async () => {
  let fetchCalls = 0;
  let socketCalls = 0;
  const api = loadBackground({
    fetch: async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => ({ listenKey: "abc123" }) };
    },
    WebSocket: class MockWebSocket {
      constructor() {
        socketCalls += 1;
      }
    }
  });
  const status = await api.ensureUserStreamForConfig({
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    dryRun: true
  });
  assert.equal(status.mode, "dry-run");
  assert.equal(fetchCalls, 0);
  assert.equal(socketCalls, 0);
});

test("0.2.8 user stream partial fill places only the new settlement delta as GTX reduce-only", async () => {
  const storage = makeStorage({
    pendingSettlementIndex: {
      BTCUSDT: [{
        id: "ps_1",
        symbol: "BTCUSDT",
        entrySide: "BUY",
        exitSide: "SELL",
        entryClientOrderId: "mb_buy_entry",
        settlementPrice: "101.0",
        placedQty: "0.003",
        makerTicks: 1
      }]
    },
    exitOrderIndex: {}
  });
  const orderBodies = [];
  const api = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} }
      },
      storage: { local: storage }
    },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/exchangeInfo") {
        return {
          ok: true,
          json: async () => ({
            symbols: [{
              symbol: "BTCUSDT",
              filters: [
                { filterType: "PRICE_FILTER", tickSize: "0.1" },
                { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
                { filterType: "MIN_NOTIONAL", notional: "5" }
              ]
            }]
          })
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        const body = new URLSearchParams(options.body);
        orderBodies.push(Object.fromEntries(body.entries()));
        return { ok: true, json: async () => ({ status: "NEW", clientOrderId: body.get("newClientOrderId") }) };
      }
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    }
  });

  const result = await api.processUserStreamEntryFill({
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    recvWindow: 5000
  }, {
    e: "ORDER_TRADE_UPDATE",
    o: { s: "BTCUSDT", c: "mb_buy_entry", x: "TRADE", X: "PARTIALLY_FILLED", z: "0.007", l: "0.004" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.placedNow, "0.004");
  assert.equal(orderBodies.length, 1);
  assert.equal(orderBodies[0].symbol, "BTCUSDT");
  assert.equal(orderBodies[0].side, "SELL");
  assert.equal(orderBodies[0].type, "LIMIT");
  assert.equal(orderBodies[0].timeInForce, "GTX");
  assert.equal(orderBodies[0].reduceOnly, "true");
  assert.equal(orderBodies[0].quantity, "0.004");
  assert.equal(orderBodies[0].price, "101.0");
  assert.equal(storage.state.pendingSettlementIndex.BTCUSDT[0].placedQty, "0.007");
});

test("profit-only settlement clamps manual long exit price to break-even", async () => {
  const apiListeners = { message: [] };
  const storage = makeStorage({
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    quoteAmount: "100",
    leverage: 20,
    offsetTicks: 0,
    exitChaseRetries: 0,
    autoSettlementEnabled: false,
    dryRun: true,
    autoReduceOnly: true,
    replaceReduceOnly: false,
    profitOnlySettlementEnabled: true,
    recvWindow: 5000
  });
  const api = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(fn) { apiListeners.message.push(fn); } }
      },
      storage: { local: storage }
    },
    fetch: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/exchangeInfo") {
        return {
          ok: true,
          json: async () => ({
            symbols: [{
              symbol: "BTCUSDT",
              filters: [
                { filterType: "PRICE_FILTER", tickSize: "0.1" },
                { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
                { filterType: "MIN_NOTIONAL", notional: "5" }
              ]
            }]
          })
        };
      }
      if (parsed.pathname === "/fapi/v1/ticker/bookTicker") {
        return { ok: true, json: async () => ({ bidPrice: "99.0", askPrice: "99.2" }) };
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: true,
          json: async () => ([{
            symbol: "BTCUSDT",
            positionSide: "BOTH",
            positionAmt: "0.100",
            entryPrice: "100.0",
            breakEvenPrice: "100.0",
            leverage: "20",
            markPrice: "99.1",
            unRealizedProfit: "-0.009"
          }])
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const response = await new Promise((resolve) => {
    apiListeners.message[0]({
      type: "PLACE_MAKER_ORDER",
      side: "SELL",
      symbol: "BTCUSDT",
      quoteAmount: "100",
      leverage: 20,
      offsetTicks: 0,
      exitChaseRetries: 0,
      autoSettlementEnabled: false,
      autoReduceOnly: true,
      replaceReduceOnly: false,
      profitOnlySettlementEnabled: true,
      dryRun: true
    }, {}, resolve);
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.order.reduceOnly, true);
  assert.equal(response.result.order.price, "100.0");
  assert.equal(response.result.order.profitOnlySettlementAdjusted, true);
  assert.equal(response.result.order.profitOnlySettlementAveragePrice, "100.0");
});

test("profit-only settlement clamps manual short exit price to break-even", async () => {
  const apiListeners = { message: [] };
  const storage = makeStorage({
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    quoteAmount: "100",
    leverage: 20,
    offsetTicks: 0,
    exitChaseRetries: 0,
    autoSettlementEnabled: false,
    dryRun: true,
    autoReduceOnly: true,
    replaceReduceOnly: false,
    profitOnlySettlementEnabled: true,
    recvWindow: 5000
  });
  loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(fn) { apiListeners.message.push(fn); } }
      },
      storage: { local: storage }
    },
    fetch: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/exchangeInfo") {
        return {
          ok: true,
          json: async () => ({
            symbols: [{
              symbol: "BTCUSDT",
              filters: [
                { filterType: "PRICE_FILTER", tickSize: "0.1" },
                { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
                { filterType: "MIN_NOTIONAL", notional: "5" }
              ]
            }]
          })
        };
      }
      if (parsed.pathname === "/fapi/v1/ticker/bookTicker") {
        return { ok: true, json: async () => ({ bidPrice: "100.8", askPrice: "101.0" }) };
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: true,
          json: async () => ([{
            symbol: "BTCUSDT",
            positionSide: "BOTH",
            positionAmt: "-0.100",
            entryPrice: "100.0",
            breakEvenPrice: "100.0",
            leverage: "20",
            markPrice: "100.9",
            unRealizedProfit: "-0.009"
          }])
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const response = await new Promise((resolve) => {
    apiListeners.message[0]({
      type: "PLACE_MAKER_ORDER",
      side: "BUY",
      symbol: "BTCUSDT",
      quoteAmount: "100",
      leverage: 20,
      offsetTicks: 0,
      exitChaseRetries: 0,
      autoSettlementEnabled: false,
      autoReduceOnly: true,
      replaceReduceOnly: false,
      profitOnlySettlementEnabled: true,
      dryRun: true
    }, {}, resolve);
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.order.reduceOnly, true);
  assert.equal(response.result.order.price, "100.0");
  assert.equal(response.result.order.profitOnlySettlementAdjusted, true);
  assert.equal(response.result.order.profitOnlySettlementAveragePrice, "100.0");
});

test("market bookTicker stream URL uses the public realtime endpoint", () => {
  const api = loadBackground();
  assert.equal(
    api.buildMarketBookTickerWsUrl("https://fapi.binance.com", "BTCUSDT"),
    "wss://fstream.binance.com/public/ws/btcusdt@bookTicker"
  );
  assert.equal(
    api.buildMarketBookTickerWsUrl("https://testnet.binancefuture.com", "BTCUSDT"),
    "wss://fstream.binancefuture.com/ws/btcusdt@bookTicker"
  );
});

test("market bookTicker messages update a lightweight price snapshot without REST", () => {
  const api = loadBackground();
  api.handleMarketBookTickerMessage("https://fapi.binance.com", JSON.stringify({
    e: "bookTicker",
    s: "BTCUSDT",
    b: "100.0",
    a: "100.2",
    E: 123456789
  }));
  const snapshot = api.getMarketTickerSnapshot({
    baseUrl: "https://fapi.binance.com",
    symbol: "BTCUSDT"
  });
  assert.equal(snapshot.symbol, "BTCUSDT");
  assert.equal(snapshot.bid, "100.0");
  assert.equal(snapshot.ask, "100.2");
  assert.equal(snapshot.currentPrice, "100.1");
  assert.equal(snapshot.source, "ws");
});

test("market WebSocket failures do not create a new socket on every 250 ms ticker poll", async () => {
  const sockets = [];
  class MockWebSocket {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close() {}
  }
  const api = loadBackground({ WebSocket: MockWebSocket });
  await api.ensureMarketStreamForSymbol({ baseUrl: "https://fapi.binance.com" }, "BTCUSDT");
  assert.equal(sockets.length, 1);
  sockets[0].onerror();
  await api.ensureMarketStreamForSymbol({ baseUrl: "https://fapi.binance.com" }, "BTCUSDT");
  await api.ensureMarketStreamForSymbol({ baseUrl: "https://fapi.binance.com" }, "BTCUSDT");
  assert.equal(sockets.length, 1);
});

test("retryable auto-settlement close failure is cooled down before another close attempt", async () => {
  const storage = makeStorage({
    pendingSettlementIndex: {
      BTCUSDT: [{
        id: "ps_retry",
        symbol: "BTCUSDT",
        entrySide: "BUY",
        exitSide: "SELL",
        entryClientOrderId: "mb_buy_retry",
        settlementPrice: "101.0",
        placedQty: "0",
        makerTicks: 1
      }]
    },
    exitOrderIndex: {}
  });
  let postCalls = 0;
  const api = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} }
      },
      storage: { local: storage }
    },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/exchangeInfo") {
        return {
          ok: true,
          json: async () => ({
            symbols: [{
              symbol: "BTCUSDT",
              filters: [
                { filterType: "PRICE_FILTER", tickSize: "0.1" },
                { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
                { filterType: "MIN_NOTIONAL", notional: "5" }
              ]
            }]
          })
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        postCalls += 1;
        return { ok: false, status: 400, json: async () => ({ code: -2022, msg: "ReduceOnly Order is rejected." }) };
      }
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    }
  });

  const config = {
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    recvWindow: 5000
  };
  const event = {
    e: "ORDER_TRADE_UPDATE",
    o: { s: "BTCUSDT", c: "mb_buy_retry", x: "TRADE", X: "PARTIALLY_FILLED", z: "0.004", l: "0.004" }
  };

  const first = await api.processUserStreamEntryFill(config, event);
  const second = await api.processUserStreamEntryFill(config, event);

  assert.equal(first.retryable, true);
  assert.equal(second.reason, "cooldown");
  assert.equal(postCalls, 1);
});

test("duplicate pending settlements for the same entry client id place only one close order", async () => {
  const storage = makeStorage({
    pendingSettlementIndex: {
      BTCUSDT: [
        {
          id: "ps_dup_1",
          symbol: "BTCUSDT",
          entrySide: "BUY",
          exitSide: "SELL",
          entryClientOrderId: "mb_buy_duplicate",
          settlementPrice: "101.0",
          placedQty: "0",
          makerTicks: 1
        },
        {
          id: "ps_dup_2",
          symbol: "BTCUSDT",
          entrySide: "BUY",
          exitSide: "SELL",
          entryClientOrderId: "mb_buy_duplicate",
          settlementPrice: "101.0",
          placedQty: "0",
          makerTicks: 1
        }
      ]
    },
    pendingSettlementFillIndex: {},
    exitOrderIndex: {}
  });
  let postCalls = 0;
  const api = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} }
      },
      storage: { local: storage }
    },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/exchangeInfo") {
        return {
          ok: true,
          json: async () => ({
            symbols: [{
              symbol: "BTCUSDT",
              filters: [
                { filterType: "PRICE_FILTER", tickSize: "0.1" },
                { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
                { filterType: "MIN_NOTIONAL", notional: "5" }
              ]
            }]
          })
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "GET") {
        return {
          ok: true,
          json: async () => ({ status: "PARTIALLY_FILLED", executedQty: "0.004" })
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        postCalls += 1;
        return { ok: true, json: async () => ({ status: "NEW" }) };
      }
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    }
  });

  const results = await api.processPendingSettlementsForSymbol({
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    recvWindow: 5000
  }, "BTCUSDT");

  assert.equal(postCalls, 1);
  assert.equal(results.filter(result => result.placedNow === "0.004").length, 1);
  assert.equal(storage.state.pendingSettlementFillIndex.BTCUSDT.mb_buy_duplicate.placedQty, "0.004");
});

test("0.3.2 upgrade resets unsafe pre-ledger pending settlement state once", () => {
  const api = loadBackground();
  assert.equal(api.shouldResetPendingSettlementsOnInstall("0.3.1", "0.3.2"), true);
  assert.equal(api.shouldResetPendingSettlementsOnInstall("0.3.2", "0.3.2"), false);
  assert.equal(api.shouldResetPendingSettlementsOnInstall("0.3.2", "0.3.3"), false);
  assert.equal(api.shouldResetPendingSettlementsOnInstall(undefined, "0.3.2"), false);
});
