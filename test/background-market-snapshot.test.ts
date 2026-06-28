import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

function loadBackground(extra: Record<string, unknown> = {}) {
  const code = readFileSync(join(process.cwd(), "background.js"), "utf8");
  const listeners = {
    installed: [] as Array<(...args: unknown[]) => unknown>,
    message: [] as Array<(msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown>
  };
  const sandbox: Record<string, unknown> = {
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
      getRandomValues(array: Uint32Array) {
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
        onInstalled: { addListener(fn: (...args: unknown[]) => unknown) { listeners.installed.push(fn); } },
        onMessage: { addListener(fn: (msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown) { listeners.message.push(fn); } }
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
  return { api: sandbox.__BMW_TEST__ as Record<string, (...args: unknown[]) => unknown>, listeners };
}

test("trading snapshot uses cached WebSocket bookTicker without REST bookTicker", async () => {
  let bookTickerCalls = 0;
  const { api, listeners } = loadBackground({
    fetch: async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/ticker/bookTicker") {
        bookTickerCalls += 1;
        return { ok: true, json: async () => ({ bidPrice: "99.0", askPrice: "99.2" }) };
      }
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
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  api.handleMarketBookTickerMessage("https://fapi.binance.com", JSON.stringify({
    e: "bookTicker",
    s: "BTCUSDT",
    b: "100.0",
    a: "100.2",
    E: 123456789
  }));

  const response = await new Promise<{ ok: boolean; result: Record<string, unknown> }>((resolve) => {
    listeners.message[0]({ type: "GET_TRADING_SNAPSHOT", symbol: "BTCUSDT" }, {}, (res) => {
      resolve(res as { ok: boolean; result: Record<string, unknown> });
    });
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.bid, "100.0");
  assert.equal(response.result.ask, "100.2");
  assert.equal(response.result.priceSource, "ws");
  assert.equal(bookTickerCalls, 0);
});

test("trading snapshot stops local REST calls while Binance IP ban is active", async () => {
  let fetchCalls = 0;
  const apiListeners: Array<(msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown> = [];
  const { api, listeners } = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(fn: (msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown) { apiListeners.push(fn); } }
      },
      storage: {
        local: {
          async get(keys: string[]) {
            const state: Record<string, unknown> = {
              apiKey: "key",
              apiSecret: "secret",
              baseUrl: "https://fapi.binance.com",
              recvWindow: 5000
            };
            return Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]]));
          },
          async set() {}
        }
      }
    },
    fetch: async (url: string) => {
      fetchCalls += 1;
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: false,
          status: 418,
          json: async () => ({
            code: -1003,
            msg: "Way too many requests; IP(111.248.116.22) banned until 9999999999999. Please use the websocket for live updates to avoid bans."
          })
        };
      }
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
      throw new Error(`Unexpected fetch ${url}`);
    }
  });
  listeners.message = apiListeners;

  api.handleMarketBookTickerMessage("https://fapi.binance.com", JSON.stringify({
    e: "bookTicker",
    s: "BTCUSDT",
    b: "100.0",
    a: "100.2",
    E: 123456789
  }));

  const snapshot = () => new Promise<{ ok: boolean; result: Record<string, unknown> }>((resolve) => {
    listeners.message[0]({ type: "GET_TRADING_SNAPSHOT", symbol: "BTCUSDT" }, {}, (res) => {
      resolve(res as { ok: boolean; result: Record<string, unknown> });
    });
  });

  await snapshot();
  const callsAfterBan = fetchCalls;
  await snapshot();

  assert.equal(callsAfterBan, 1);
  assert.equal(fetchCalls, callsAfterBan);
});

test("user data stream position cache drives market ticker PNL without REST", async () => {
  const sockets: Array<{ onopen?: () => void; onmessage?: (event: { data: string }) => void; close: () => void }> = [];
  const apiListeners: Array<(msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown> = [];
  let fetchCalls = 0;
  const storageState: Record<string, unknown> = {
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    recvWindow: 5000,
    dryRun: false
  };
  const { api, listeners } = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(fn: (msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown) { apiListeners.push(fn); } }
      },
      storage: {
        local: {
          async get(keys: string[]) {
            return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]));
          },
          async set(values: Record<string, unknown>) {
            Object.assign(storageState, values);
          }
        }
      }
    },
    fetch: async (url: string, options: { method?: string } = {}) => {
      fetchCalls += 1;
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/listenKey" && options.method === "POST") {
        return { ok: true, json: async () => ({ listenKey: "listen-key" }) };
      }
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    WebSocket: class MockWebSocket {
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      constructor() {
        sockets.push(this);
      }
      close() {}
    }
  });
  listeners.message = apiListeners;

  await api.ensureUserStreamForConfig({
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    recvWindow: 5000,
    dryRun: false
  });
  sockets[0].onopen?.();
  sockets[0].onmessage?.({ data: JSON.stringify({
    e: "ACCOUNT_UPDATE",
    a: {
      P: [{
        s: "BTCUSDT",
        ps: "BOTH",
        pa: "0.5",
        ep: "100.0",
        bep: "100.0",
        up: "0.25",
        mt: "cross"
      }]
    }
  }) });
  api.handleMarketBookTickerMessage("https://fapi.binance.com", JSON.stringify({
    e: "bookTicker",
    s: "BTCUSDT",
    b: "101.0",
    a: "101.2",
    E: 123456789
  }));

  const response = await new Promise<{ ok: boolean; result: Record<string, unknown> }>((resolve) => {
    listeners.message[0]({ type: "GET_MARKET_TICKER", symbol: "BTCUSDT" }, {}, (res) => {
      resolve(res as { ok: boolean; result: Record<string, unknown> });
    });
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.currentPrice, "101.1");
  assert.equal((response.result.position as Record<string, unknown>).positionAmt, 0.5);
  assert.equal((response.result.position as Record<string, unknown>).entryPrice, 100);
  assert.equal((response.result.position as Record<string, unknown>).breakEvenPrice, 100);
  assert.equal((response.result.position as Record<string, unknown>).unrealizedProfit, 0.55);
  assert.equal(fetchCalls, 1);
});

test("user stream listenKey requests stop while Binance IP ban is active", async () => {
  let fetchCalls = 0;
  const apiListeners: Array<(msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown> = [];
  const { api, listeners } = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(fn: (msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown) { apiListeners.push(fn); } }
      },
      storage: {
        local: {
          async get(keys: string[]) {
            const state: Record<string, unknown> = {
              apiKey: "key",
              apiSecret: "secret",
              baseUrl: "https://fapi.binance.com",
              recvWindow: 5000,
              dryRun: false
            };
            return Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]]));
          },
          async set() {}
        }
      }
    },
    fetch: async (url: string) => {
      fetchCalls += 1;
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: false,
          status: 418,
          json: async () => ({
            code: -1003,
            msg: "Way too many requests; IP(111.248.116.22) banned until 9999999999999. Please use the websocket for live updates to avoid bans."
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });
  listeners.message = apiListeners;

  await new Promise<{ ok: boolean }>((resolve) => {
    listeners.message[0]({ type: "GET_TRADING_SNAPSHOT", symbol: "BTCUSDT" }, {}, (res) => {
      resolve(res as { ok: boolean });
    });
  });
  const callsAfterBan = fetchCalls;
  await assert.rejects(() => api.ensureUserStreamForConfig({
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    recvWindow: 5000,
    dryRun: false
  }));

  assert.equal(callsAfterBan, 1);
  assert.equal(fetchCalls, callsAfterBan);
});

test("warmup starts user data stream for non-dry API sessions", async () => {
  let listenKeyCalls = 0;
  const sockets: unknown[] = [];
  const { api } = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} }
      },
      storage: {
        local: {
          async get(keys: string[]) {
            const state: Record<string, unknown> = {
              apiKey: "key",
              apiSecret: "secret",
              baseUrl: "https://fapi.binance.com",
              recvWindow: 5000,
              dryRun: false,
              autoSettlementEnabled: false
            };
            return Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]]));
          },
          async set() {}
        }
      }
    },
    fetch: async (url: string, options: { method?: string } = {}) => {
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
      if (parsed.pathname === "/fapi/v1/listenKey" && options.method === "POST") {
        listenKeyCalls += 1;
        return { ok: true, json: async () => ({ listenKey: "listen-key" }) };
      }
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    WebSocket: class MockWebSocket {
      constructor() {
        sockets.push(this);
      }
      close() {}
    }
  });

  await api.warmupSymbol("BTCUSDT");

  assert.equal(listenKeyCalls, 1);
  assert.equal(sockets.length, 2);
});

test("critical pending settlement and exit indexes persist before helpers return", async () => {
  const storageState: Record<string, unknown> = {
    pendingSettlementIndex: {},
    exitOrderIndex: {}
  };
  const writes: Array<Record<string, unknown>> = [];
  const { api } = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} }
      },
      storage: {
        local: {
          async get(keys: string[]) {
            return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]));
          },
          async set(values: Record<string, unknown>) {
            writes.push(values);
            Object.assign(storageState, values);
          }
        }
      }
    }
  });

  await api.addPendingSettlement({
    id: "ps_1",
    symbol: "BTCUSDT",
    entryClientOrderId: "mb_buy_1"
  });
  await api.addIndexedExitOrderId("BTCUSDT", "SELL", "mb_tp_sell_1");

  assert.deepEqual((storageState.pendingSettlementIndex as Record<string, unknown[]>).BTCUSDT?.[0]?.id, "ps_1");
  const exitIds = (storageState.exitOrderIndex as Record<string, Record<string, string[]>>).BTCUSDT?.SELL || [];
  assert.deepEqual(Array.from(exitIds), ["mb_tp_sell_1"]);
  assert.equal(writes.filter((item) => "pendingSettlementIndex" in item).length, 1);
  assert.equal(writes.filter((item) => "exitOrderIndex" in item).length, 1);
});

test("auto settlement replaces prior open TP when entry fill grows", async () => {
  const pending = {
    id: "ps_1",
    symbol: "SOLUSDC",
    entryClientOrderId: "mb_sell_entry",
    exitSide: "BUY",
    settlementPrice: "66.5800",
    placedQty: "0",
    makerTicks: 1
  };
  const storageState: Record<string, unknown> = {
    pendingSettlementIndex: { SOLUSDC: [pending] },
    pendingSettlementFillIndex: {},
    exitOrderIndex: {}
  };
  const postedOrders: URLSearchParams[] = [];
  const canceledOrders: URLSearchParams[] = [];
  const { api } = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} }
      },
      storage: {
        local: {
          async get(keys: string[]) {
            return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]));
          },
          async set(values: Record<string, unknown>) {
            Object.assign(storageState, values);
          }
        }
      }
    },
    fetch: async (url: string, options: { method?: string; body?: string } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/exchangeInfo") {
        return {
          ok: true,
          json: async () => ({
            symbols: [{
              symbol: "SOLUSDC",
              filters: [
                { filterType: "PRICE_FILTER", tickSize: "0.0001" },
                { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
                { filterType: "MIN_NOTIONAL", notional: "5" }
              ]
            }]
          })
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        const body = new URLSearchParams(options.body || "");
        postedOrders.push(body);
        return {
          ok: true,
          json: async () => ({
            symbol: "SOLUSDC",
            clientOrderId: body.get("newClientOrderId"),
            executedQty: "0"
          })
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "DELETE") {
        canceledOrders.push(parsed.searchParams);
        return {
          ok: true,
          json: async () => ({
            symbol: "SOLUSDC",
            origClientOrderId: parsed.searchParams.get("origClientOrderId"),
            executedQty: "0"
          })
        };
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
  const event = (cumQty: string) => ({
    e: "ORDER_TRADE_UPDATE",
    o: {
      s: "SOLUSDC",
      c: "mb_sell_entry",
      x: "TRADE",
      X: "PARTIALLY_FILLED",
      z: cumQty
    }
  });

  await api.processUserStreamEntryFill(config, event("0.67"));
  await api.processUserStreamEntryFill(config, event("1.34"));

  assert.equal(postedOrders.length, 2);
  assert.equal(canceledOrders.length, 1);
  assert.equal(postedOrders[0].get("quantity"), "0.670");
  assert.equal(postedOrders[1].get("quantity"), "1.340");
});

test("auto settlement re-prices one TP from average position after adding at a different price", async () => {
  const pending = {
    id: "ps_2",
    symbol: "BTCUSDT",
    entrySide: "BUY",
    exitSide: "SELL",
    entryClientOrderId: "mb_buy_second",
    entryPrice: "90.0",
    settlementPrice: "100.0",
    quantity: "1",
    placedQty: "0",
    roiPct: 10,
    leverage: 1,
    originalAmount: 90,
    makerTicks: 1
  };
  const storageState: Record<string, unknown> = {
    pendingSettlementIndex: { BTCUSDT: [pending] },
    pendingSettlementFillIndex: {},
    exitOrderIndex: { BTCUSDT: { SELL: ["mb_tp_sell_old"] } }
  };
  const postedOrders: URLSearchParams[] = [];
  const canceledOrders: URLSearchParams[] = [];
  const { api } = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} }
      },
      storage: {
        local: {
          async get(keys: string[]) {
            return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]));
          },
          async set(values: Record<string, unknown>) {
            Object.assign(storageState, values);
          }
        }
      }
    },
    fetch: async (url: string, options: { method?: string; body?: string } = {}) => {
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
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: true,
          json: async () => ([{
            symbol: "BTCUSDT",
            positionSide: "BOTH",
            positionAmt: "2",
            entryPrice: "95.0",
            breakEvenPrice: "95.0",
            leverage: "1",
            markPrice: "90.0",
            unRealizedProfit: "0"
          }])
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        const body = new URLSearchParams(options.body || "");
        postedOrders.push(body);
        return {
          ok: true,
          json: async () => ({
            symbol: "BTCUSDT",
            clientOrderId: body.get("newClientOrderId"),
            executedQty: "0"
          })
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "DELETE") {
        canceledOrders.push(parsed.searchParams);
        return {
          ok: true,
          json: async () => ({
            symbol: "BTCUSDT",
            origClientOrderId: parsed.searchParams.get("origClientOrderId"),
            executedQty: "0"
          })
        };
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
    o: { s: "BTCUSDT", c: "mb_buy_second", x: "TRADE", X: "FILLED", z: "1", l: "1" }
  });

  assert.equal(result.ok, true);
  assert.equal(canceledOrders.length, 1);
  assert.equal(canceledOrders[0].get("origClientOrderId"), "mb_tp_sell_old");
  assert.equal(postedOrders.length, 1);
  assert.equal(postedOrders[0].get("side"), "SELL");
  assert.equal(postedOrders[0].get("quantity"), "2.000");
  assert.equal(postedOrders[0].get("price"), "105.0");
  assert.equal(postedOrders[0].get("reduceOnly"), "true");
});

test("SL order preview uses leveraged ROI and midpoint trigger", async () => {
  const storageState: Record<string, unknown> = {
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    quoteAmount: "100",
    leverage: 1,
    offsetTicks: 0,
    autoSettlementEnabled: false,
    slOrderEnabled: true,
    slOrderRoiPct: "10",
    dryRun: true,
    autoReduceOnly: true,
    replaceReduceOnly: true,
    recvWindow: 5000,
    exitOrderIndex: {}
  };
  const apiListeners: Array<(msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown> = [];
  loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(fn: (msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown) { apiListeners.push(fn); } }
      },
      storage: {
        local: {
          async get(keys: string[]) {
            return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]));
          },
          async set(values: Record<string, unknown>) {
            Object.assign(storageState, values);
          }
        }
      }
    },
    fetch: async (url: string) => {
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
        return { ok: true, json: async () => ({ bidPrice: "99.8", askPrice: "100.1" }) };
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: true,
          json: async () => [{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0", leverage: "1" }]
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const response = await new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
    apiListeners[0]({
      type: "PLACE_MAKER_ORDER",
      side: "BUY",
      symbol: "BTCUSDT",
      quoteAmount: "100",
      leverage: 1,
      offsetTicks: 0,
      autoSettlementEnabled: false,
      slOrderEnabled: true,
      slOrderRoiPct: "10",
      dryRun: true
    }, {}, (res) => resolve(res as { ok: boolean; result?: Record<string, unknown>; error?: string }));
  });

  assert.equal(response.ok, true, response.error);
  const order = response.result?.order as Record<string, unknown>;
  const slOrder = order.slOrder as Record<string, unknown>;
  assert.equal(slOrder.enabled, true);
  assert.equal(slOrder.slPrice, "90.0");
  assert.equal(slOrder.triggerPrice, "95.0");
  assert.equal(slOrder.roiPct, 10);
});

test("SL-only pending entry places a Binance conditional STOP GTX reduce-only order from average position", async () => {
  const pending = {
    id: "ps_sl_1",
    symbol: "BTCUSDT",
    entrySide: "BUY",
    exitSide: "SELL",
    entryClientOrderId: "mb_buy_sl",
    settlementEnabled: false,
    slOrderEnabled: true,
    slOrderRoiPct: 10,
    slPriceOffset: "10.0",
    slPlacedQty: "0",
    makerTicks: 1
  };
  const storageState: Record<string, unknown> = {
    pendingSettlementIndex: { BTCUSDT: [pending] },
    pendingSettlementFillIndex: {},
    exitOrderIndex: {}
  };
  const postedAlgoOrders: URLSearchParams[] = [];
  const { api } = loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} }
      },
      storage: {
        local: {
          async get(keys: string[]) {
            return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]));
          },
          async set(values: Record<string, unknown>) {
            Object.assign(storageState, values);
          }
        }
      }
    },
    fetch: async (url: string, options: { method?: string; body?: string } = {}) => {
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
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: true,
          json: async () => ([{
            symbol: "BTCUSDT",
            positionSide: "BOTH",
            positionAmt: "1",
            entryPrice: "100.0",
            breakEvenPrice: "100.0",
            leverage: "1",
            markPrice: "96.0",
            unRealizedProfit: "-4.0"
          }])
        };
      }
      if (parsed.pathname === "/fapi/v1/algoOrder" && options.method === "POST") {
        const body = new URLSearchParams(options.body || "");
        postedAlgoOrders.push(body);
        return {
          ok: true,
          json: async () => ({
            algoId: 123,
            clientAlgoId: body.get("clientAlgoId"),
            algoStatus: "NEW"
          })
        };
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
    o: { s: "BTCUSDT", c: "mb_buy_sl", x: "TRADE", X: "FILLED", z: "1", l: "1" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.pending, false);
  assert.equal(postedAlgoOrders.length, 1);
  assert.equal(postedAlgoOrders[0].get("symbol"), "BTCUSDT");
  assert.equal(postedAlgoOrders[0].get("side"), "SELL");
  assert.equal(postedAlgoOrders[0].get("algoType"), "CONDITIONAL");
  assert.equal(postedAlgoOrders[0].get("type"), "STOP");
  assert.equal(postedAlgoOrders[0].get("timeInForce"), "GTX");
  assert.equal(postedAlgoOrders[0].get("quantity"), "1.000");
  assert.equal(postedAlgoOrders[0].get("price"), "90.0");
  assert.equal(postedAlgoOrders[0].get("triggerPrice"), "95.0");
  assert.equal(postedAlgoOrders[0].get("reduceOnly"), "true");
  assert.equal(postedAlgoOrders[0].get("workingType"), "CONTRACT_PRICE");
});

test("entry maker order retries five times with fresh maker-safe prices after GTX rejection", async () => {
  const storageState: Record<string, unknown> = {
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    quoteAmount: "10",
    leverage: 20,
    offsetTicks: 0,
    dryRun: false,
    autoReduceOnly: true,
    replaceReduceOnly: true,
    recvWindow: 5000,
    exitOrderIndex: {}
  };
  const postedOrders: URLSearchParams[] = [];
  const apiListeners: Array<(msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown> = [];
  const bookResponses = [
    { bidPrice: "100.0", askPrice: "100.2" },
    { bidPrice: "99.6", askPrice: "99.8" },
    { bidPrice: "99.4", askPrice: "99.6" },
    { bidPrice: "99.2", askPrice: "99.4" },
    { bidPrice: "99.0", askPrice: "99.2" },
    { bidPrice: "98.8", askPrice: "99.0" }
  ];

  loadBackground({
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(fn: (msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown) { apiListeners.push(fn); } }
      },
      storage: {
        local: {
          async get(keys: string[]) {
            return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]));
          },
          async set(values: Record<string, unknown>) {
            Object.assign(storageState, values);
          }
        }
      }
    },
    fetch: async (url: string, options: { method?: string; body?: string } = {}) => {
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
        return { ok: true, json: async () => bookResponses.shift() };
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: true,
          json: async () => [{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0", leverage: "20" }]
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        const body = new URLSearchParams(options.body || "");
        postedOrders.push(body);
        if (postedOrders.length <= 5) {
          return {
            ok: false,
            json: async () => ({ code: -5022, msg: "Due to maker only order, could not be fulfilled." })
          };
        }
        return {
          ok: true,
          json: async () => ({ status: "NEW", clientOrderId: body.get("newClientOrderId") })
        };
      }
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    }
  });

  const response = await new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
    apiListeners[0]({
      type: "PLACE_MAKER_ORDER",
      side: "BUY",
      symbol: "BTCUSDT",
      quoteAmount: "10",
      leverage: 20,
      offsetTicks: 0,
      dryRun: false
    }, {}, (res) => resolve(res as { ok: boolean; result?: Record<string, unknown>; error?: string }));
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(postedOrders.length, 6);
  assert.equal(postedOrders[0].get("price"), "100.1");
  assert.equal(postedOrders[5].get("price"), "98.9");
  assert.equal((response.result?.order as Record<string, unknown>).price, "98.9");
  assert.equal((response.result?.order as Record<string, unknown>).entryRetryAttempts, 5);
});
