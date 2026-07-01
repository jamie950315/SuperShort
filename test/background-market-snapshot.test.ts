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
    setInterval,
    clearInterval,
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

async function placeMakerOrderWithBracketFixture(options: {
  side?: "BUY" | "SELL";
  quoteAmount?: string;
  leverage?: number;
  autoReduceOnly?: boolean;
  positionAmt?: string;
  positionNotional?: string;
  positionLeverage?: string;
  book?: { bidPrice: string; askPrice: string };
  bracketResponse?: unknown;
  bracketOk?: boolean;
  bracketStatus?: number;
  openOrders?: Array<Record<string, unknown>>;
  openOrdersResponse?: unknown;
  openOrdersOk?: boolean;
  openOrdersStatus?: number;
  dryRun?: boolean;
}) {
  const storageState: Record<string, unknown> = {
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    quoteAmount: options.quoteAmount ?? "200",
    leverage: options.leverage ?? 100,
    offsetTicks: 0,
    dryRun: options.dryRun ?? false,
    autoReduceOnly: options.autoReduceOnly ?? true,
    replaceReduceOnly: true,
    recvWindow: 5000,
    exitOrderIndex: {}
  };
  let orderPostCalls = 0;
  const postedOrders: URLSearchParams[] = [];
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
    fetch: async (url: string, fetchOptions: { method?: string; body?: string } = {}) => {
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
        return { ok: true, json: async () => options.book ?? { bidPrice: "99.8", askPrice: "100.1" } };
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: true,
          json: async () => [{
            symbol: "BTCUSDT",
            positionSide: "BOTH",
            positionAmt: options.positionAmt ?? "0",
            leverage: options.positionLeverage ?? String(options.leverage ?? 100),
            notional: options.positionNotional
          }]
        };
      }
      if (parsed.pathname === "/fapi/v1/leverageBracket") {
        assert.equal(parsed.searchParams.get("symbol"), "BTCUSDT");
        const ok = options.bracketOk ?? true;
        return {
          ok,
          status: options.bracketStatus ?? (ok ? 200 : 500),
          json: async () => options.bracketResponse ?? [{
            symbol: "BTCUSDT",
            brackets: [
              { bracket: 1, initialLeverage: 100, notionalFloor: "0", notionalCap: "10000" },
              { bracket: 2, initialLeverage: 50, notionalFloor: "10000", notionalCap: "50000" }
            ]
          }]
        };
      }
      if (parsed.pathname === "/fapi/v1/openOrders") {
        assert.equal(parsed.searchParams.get("symbol"), "BTCUSDT");
        const ok = options.openOrdersOk ?? true;
        return {
          ok,
          status: options.openOrdersStatus ?? (ok ? 200 : 500),
          json: async () => options.openOrdersResponse ?? options.openOrders ?? []
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && fetchOptions.method === "POST") {
        orderPostCalls += 1;
        postedOrders.push(new URLSearchParams(fetchOptions.body || ""));
        return { ok: true, json: async () => ({ symbol: "BTCUSDT", status: "NEW" }) };
      }
      if (parsed.pathname === "/fapi/v1/leverage" && fetchOptions.method === "POST") {
        return { ok: true, json: async () => ({ leverage: options.leverage ?? 100 }) };
      }
      throw new Error(`Unexpected fetch ${fetchOptions.method || "GET"} ${url}`);
    }
  });

  const response = await new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
    apiListeners[0]({
      type: "PLACE_MAKER_ORDER",
      side: options.side ?? "BUY",
      symbol: "BTCUSDT",
      quoteAmount: options.quoteAmount ?? "200",
      leverage: options.leverage ?? 100,
      offsetTicks: 0,
      autoReduceOnly: options.autoReduceOnly ?? true,
      dryRun: options.dryRun ?? false
    }, {}, (res) => resolve(res as { ok: boolean; result?: Record<string, unknown>; error?: string }));
  });

  return { response, orderPostCalls, postedOrders };
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

test("market stream watchdog closes stale connected sockets", async () => {
  let now = 1000;
  let watchdog: (() => void) | null = null;
  let closeCalls = 0;
  const sockets: Array<{ onopen?: () => void; onclose?: () => void; close: () => void }> = [];
  const { api } = loadBackground({
    Date: { now: () => now },
    setInterval: (fn: () => void) => {
      watchdog = fn;
      return 1;
    },
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    WebSocket: class MockWebSocket {
      onopen?: () => void;
      onclose?: () => void;
      constructor() {
        sockets.push(this);
      }
      close() {
        closeCalls += 1;
        this.onclose?.();
      }
    }
  });

  await api.ensureMarketStreamForSymbol({ baseUrl: "https://fapi.binance.com" }, "BTCUSDT");
  sockets[0].onopen?.();
  now += 16_001;
  watchdog?.();

  assert.equal(closeCalls, 1);
  assert.equal(api.getMarketTickerSnapshot({ baseUrl: "https://fapi.binance.com", symbol: "BTCUSDT" }).marketStreamStatus.status, "reconnecting");
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

test("auto settlement serializes same-symbol same-side TP placement", async () => {
  const makePending = (id: string, entryClientOrderId: string) => ({
    id,
    symbol: "BTCUSDT",
    entrySide: "BUY",
    exitSide: "SELL",
    entryClientOrderId,
    entryPrice: "90.0",
    settlementPrice: "100.0",
    quantity: "1",
    placedQty: "0",
    roiPct: 10,
    leverage: 1,
    originalAmount: 90,
    makerTicks: 1
  });
  const storageState: Record<string, unknown> = {
    pendingSettlementIndex: { BTCUSDT: [makePending("ps_a", "mb_buy_a"), makePending("ps_b", "mb_buy_b")] },
    pendingSettlementFillIndex: {},
    exitOrderIndex: { BTCUSDT: { SELL: ["mb_tp_sell_old"] } }
  };
  let activeTpPosts = 0;
  let maxConcurrentTpPosts = 0;
  const postedOrders: URLSearchParams[] = [];
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
      if (parsed.pathname === "/fapi/v1/order" && (options.method || "GET") === "GET") {
        return {
          ok: true,
          json: async () => ({
            symbol: "BTCUSDT",
            origClientOrderId: parsed.searchParams.get("origClientOrderId"),
            status: "FILLED",
            executedQty: "1"
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
      if (parsed.pathname === "/fapi/v1/order" && options.method === "DELETE") {
        return {
          ok: true,
          json: async () => ({
            symbol: "BTCUSDT",
            origClientOrderId: parsed.searchParams.get("origClientOrderId"),
            executedQty: "0"
          })
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        activeTpPosts += 1;
        maxConcurrentTpPosts = Math.max(maxConcurrentTpPosts, activeTpPosts);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeTpPosts -= 1;
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
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    }
  });

  const results = await api.processPendingSettlementsForSymbol({
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    recvWindow: 5000
  }, "BTCUSDT");

  assert.ok(Array.isArray(results));
  assert.ok(postedOrders.length >= 1);
  assert.equal(maxConcurrentTpPosts, 1);
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

test("auto settlement preview accepts 0.001% ROI and reports tick-rounded actual ROI", async () => {
  const storageState: Record<string, unknown> = {
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    quoteAmount: "100",
    leverage: 100,
    offsetTicks: 0,
    autoSettlementEnabled: true,
    autoSettlementRoiPct: "0.001",
    slOrderEnabled: false,
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
      if (parsed.pathname === "/fapi/v1/ticker/bookTicker") {
        return { ok: true, json: async () => ({ bidPrice: "66.5798", askPrice: "66.5800" }) };
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: true,
          json: async () => [{ symbol: "SOLUSDC", positionSide: "BOTH", positionAmt: "0", leverage: "100" }]
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const response = await new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
    apiListeners[0]({
      type: "PLACE_MAKER_ORDER",
      side: "BUY",
      symbol: "SOLUSDC",
      quoteAmount: "100",
      leverage: 100,
      offsetTicks: 0,
      autoSettlementEnabled: true,
      autoSettlementRoiPct: "0.001",
      dryRun: true
    }, {}, (res) => resolve(res as { ok: boolean; result?: Record<string, unknown>; error?: string }));
  });

  assert.equal(response.ok, true, response.error);
  const order = response.result?.order as Record<string, unknown>;
  const autoSettlement = order.autoSettlement as Record<string, unknown>;
  assert.equal(autoSettlement.roiPct, 0.001);
  assert.equal(autoSettlement.settlementPrice, "66.5800");
  assert.equal(autoSettlement.actualRoiPct, "0.0150");
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

test("manual reduce-only replace cancels indexed SL algo orders through algo endpoint", async () => {
  const storageState: Record<string, unknown> = {
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    quoteAmount: "100",
    leverage: 20,
    offsetTicks: 0,
    dryRun: false,
    autoReduceOnly: true,
    replaceReduceOnly: true,
    recvWindow: 5000,
    exitOrderIndex: { BTCUSDT: { SELL: ["mb_sl_sell_old", "mb_tp_sell_old"] } }
  };
  const canceledAlgoOrders: URLSearchParams[] = [];
  const canceledOrders: URLSearchParams[] = [];
  const postedOrders: URLSearchParams[] = [];
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
        return { ok: true, json: async () => ({ bidPrice: "99.8", askPrice: "100.1" }) };
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: true,
          json: async () => [{
            symbol: "BTCUSDT",
            positionSide: "BOTH",
            positionAmt: "1",
            entryPrice: "100.0",
            breakEvenPrice: "100.0",
            leverage: "20",
            markPrice: "100.0",
            notional: "100"
          }]
        };
      }
      if (parsed.pathname === "/fapi/v1/openOrders") {
        return {
          ok: true,
          json: async () => [{
            symbol: "BTCUSDT",
            side: "SELL",
            reduceOnly: "true",
            clientOrderId: "mb_tp_sell_old"
          }]
        };
      }
      if (parsed.pathname === "/fapi/v1/algoOrder" && options.method === "DELETE") {
        canceledAlgoOrders.push(parsed.searchParams);
        return {
          ok: true,
          json: async () => ({ clientAlgoId: parsed.searchParams.get("clientAlgoId"), algoStatus: "CANCELED" })
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "DELETE") {
        canceledOrders.push(parsed.searchParams);
        return {
          ok: true,
          json: async () => ({ origClientOrderId: parsed.searchParams.get("origClientOrderId"), status: "CANCELED" })
        };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        const body = new URLSearchParams(options.body || "");
        postedOrders.push(body);
        return { ok: true, json: async () => ({ status: "NEW", clientOrderId: body.get("newClientOrderId") }) };
      }
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    }
  });

  const response = await new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
    apiListeners[0]({
      type: "PLACE_MAKER_ORDER",
      side: "SELL",
      symbol: "BTCUSDT",
      quoteAmount: "100",
      leverage: 20,
      offsetTicks: 0,
      autoReduceOnly: true,
      replaceReduceOnly: true,
      dryRun: false
    }, {}, (res) => resolve(res as { ok: boolean; result?: Record<string, unknown>; error?: string }));
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(canceledAlgoOrders.length, 1);
  assert.equal(canceledAlgoOrders[0].get("clientAlgoId"), "mb_sl_sell_old");
  assert.equal(canceledOrders.length, 1);
  assert.equal(canceledOrders[0].get("origClientOrderId"), "mb_tp_sell_old");
  assert.equal(postedOrders.length, 1);
  const indexedIds = (storageState.exitOrderIndex as Record<string, Record<string, string[]>>).BTCUSDT.SELL;
  assert.equal(indexedIds.length, 1);
  assert.match(indexedIds[0], /^mb_sell_/);
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
      if (parsed.pathname === "/fapi/v1/leverageBracket") {
        return {
          ok: true,
          json: async () => [{
            symbol: "BTCUSDT",
            brackets: [{ bracket: 1, initialLeverage: 20, notionalFloor: "0", notionalCap: "50000" }]
          }]
        };
      }
      if (parsed.pathname === "/fapi/v1/openOrders") {
        return { ok: true, json: async () => [] };
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

test("entry order is blocked before posting when projected position exceeds leverage bracket cap", async () => {
  const storageState: Record<string, unknown> = {
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    quoteAmount: "200",
    leverage: 100,
    offsetTicks: 0,
    dryRun: false,
    autoReduceOnly: true,
    replaceReduceOnly: true,
    recvWindow: 5000,
    exitOrderIndex: {}
  };
  let orderPostCalls = 0;
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
        return { ok: true, json: async () => ({ bidPrice: "99.8", askPrice: "100.1" }) };
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return {
          ok: true,
          json: async () => [{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0", leverage: "100" }]
        };
      }
      if (parsed.pathname === "/fapi/v1/leverageBracket") {
        return {
          ok: true,
          json: async () => [{
            symbol: "BTCUSDT",
            brackets: [
              { bracket: 1, initialLeverage: 100, notionalFloor: "0", notionalCap: "10000" },
              { bracket: 2, initialLeverage: 50, notionalFloor: "10000", notionalCap: "50000" }
            ]
          }]
        };
      }
      if (parsed.pathname === "/fapi/v1/openOrders") {
        return { ok: true, json: async () => [] };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        orderPostCalls += 1;
        return { ok: true, json: async () => ({ symbol: "BTCUSDT" }) };
      }
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    }
  });

  const response = await new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
    apiListeners[0]({
      type: "PLACE_MAKER_ORDER",
      side: "BUY",
      symbol: "BTCUSDT",
      quoteAmount: "200",
      leverage: 100,
      offsetTicks: 0,
      dryRun: false
    }, {}, (res) => resolve(res as { ok: boolean; result?: Record<string, unknown>; error?: string }));
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /maximum allowable position/i);
  assert.match(response.error || "", /10000/);
  assert.equal(orderPostCalls, 0);
});

test("non-reduce-only opposite-side order that reduces exposure is not blocked by leverage bracket cap", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "SELL",
    quoteAmount: "20",
    leverage: 1,
    autoReduceOnly: false,
    positionAmt: "600",
    positionNotional: "60000",
    positionLeverage: "1"
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(orderPostCalls, 1);
});

test("projected bracket guard uses current position notional instead of repricing it at order price", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "200",
    leverage: 1,
    autoReduceOnly: false,
    positionAmt: "99",
    positionNotional: "9900",
    positionLeverage: "1",
    book: { bidPrice: "89.8", askPrice: "90.1" },
    bracketResponse: [{
      symbol: "BTCUSDT",
      brackets: [{ bracket: 1, initialLeverage: 1, notionalFloor: "0", notionalCap: "10000" }]
    }]
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /maximum allowable position/i);
  assert.equal(orderPostCalls, 0);
});

test("entry order is blocked when leverage bracket lookup fails and no cached cap is available", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "10",
    leverage: 20,
    bracketOk: false,
    bracketStatus: 500,
    bracketResponse: { code: -1000, msg: "bracket unavailable" }
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /leverage bracket/i);
  assert.equal(orderPostCalls, 0);
});

test("entry order is blocked when leverage bracket response omits the requested symbol", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "10",
    leverage: 20,
    bracketResponse: [{
      symbol: "ETHUSDT",
      brackets: [{ bracket: 1, initialLeverage: 125, notionalFloor: "0", notionalCap: "999999" }]
    }]
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /BTCUSDT/);
  assert.match(response.error || "", /leverage bracket/i);
  assert.equal(orderPostCalls, 0);
});

test("entry order is blocked when single leverage bracket object omits symbol", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "10",
    leverage: 20,
    bracketResponse: {
      brackets: [{ bracket: 1, initialLeverage: 125, notionalFloor: "0", notionalCap: "999999" }]
    }
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /BTCUSDT/);
  assert.match(response.error || "", /leverage bracket/i);
  assert.equal(orderPostCalls, 0);
});

test("entry order is blocked when open orders lookup fails", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "10",
    leverage: 20,
    openOrdersOk: false,
    openOrdersStatus: 500,
    openOrdersResponse: { code: -1000, msg: "open orders unavailable" }
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /open orders unavailable/i);
  assert.equal(orderPostCalls, 0);
});

test("entry order includes existing opening maker orders in leverage bracket projection", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "20",
    leverage: 100,
    openOrders: [{
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "NEW",
      price: "100",
      origQty: "90",
      executedQty: "0",
      reduceOnly: false,
      clientOrderId: "mb_buy_existing"
    }]
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /maximum allowable position/i);
  assert.equal(orderPostCalls, 0);
});

test("dry-run reduce-only preview does not query live open orders", async () => {
  const storageState: Record<string, unknown> = {
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    quoteAmount: "100",
    leverage: 20,
    offsetTicks: 0,
    dryRun: true,
    autoReduceOnly: true,
    replaceReduceOnly: true,
    recvWindow: 5000,
    exitOrderIndex: {}
  };
  let openOrdersCalls = 0;
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
          json: async () => [{
            symbol: "BTCUSDT",
            positionSide: "BOTH",
            positionAmt: "0.5",
            entryPrice: "100.0",
            breakEvenPrice: "100.0",
            leverage: "20",
            markPrice: "100.0",
            notional: "50"
          }]
        };
      }
      if (parsed.pathname === "/fapi/v1/openOrders") {
        openOrdersCalls += 1;
        return { ok: true, json: async () => [] };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  await new Promise<{ ok: boolean }>((resolve) => {
    apiListeners[0]({ type: "GET_TRADING_SNAPSHOT", symbol: "BTCUSDT" }, {}, (res) => resolve(res as { ok: boolean }));
  });

  const response = await new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
    apiListeners[0]({
      type: "PLACE_MAKER_ORDER",
      side: "SELL",
      symbol: "BTCUSDT",
      quoteAmount: "100",
      leverage: 20,
      offsetTicks: 0,
      autoReduceOnly: true,
      replaceReduceOnly: true,
      dryRun: true
    }, {}, (res) => resolve(res as { ok: boolean; result?: Record<string, unknown>; error?: string }));
  });

  assert.equal(response.ok, true, response.error);
  assert.equal((response.result?.order as Record<string, unknown>).reduceOnly, true);
  assert.equal(openOrdersCalls, 0);
});

test("expired leverage bracket cache is not used after live lookup fails", async () => {
  let now = 1_700_000_000_000;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
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
  let bracketCalls = 0;
  let orderPostCalls = 0;
  const apiListeners: Array<(msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => unknown> = [];
  loadBackground({
    Date: FakeDate,
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
        return { ok: true, json: async () => ({ bidPrice: "99.8", askPrice: "100.1" }) };
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return { ok: true, json: async () => [{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0", leverage: "20" }] };
      }
      if (parsed.pathname === "/fapi/v1/leverageBracket") {
        bracketCalls += 1;
        if (bracketCalls === 1) {
          return {
            ok: true,
            json: async () => [{
              symbol: "BTCUSDT",
              brackets: [{ bracket: 1, initialLeverage: 20, notionalFloor: "0", notionalCap: "50000" }]
            }]
          };
        }
        return { ok: false, status: 500, json: async () => ({ code: -1000, msg: "bracket unavailable" }) };
      }
      if (parsed.pathname === "/fapi/v1/openOrders") {
        return { ok: true, json: async () => [] };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        orderPostCalls += 1;
        return { ok: true, json: async () => ({ symbol: "BTCUSDT", status: "NEW" }) };
      }
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    }
  });

  const place = () => new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
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

  const first = await place();
  now += 10 * 60 * 1000 + 1;
  const second = await place();

  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, false);
  assert.match(second.error || "", /leverage bracket/i);
  assert.equal(orderPostCalls, 1);
});

test("flip order that opens the opposite side is checked against leverage bracket cap", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "SELL",
    quoteAmount: "300",
    leverage: 100,
    autoReduceOnly: false,
    positionAmt: "200",
    positionNotional: "20000",
    positionLeverage: "100",
    bracketResponse: [{
      symbol: "BTCUSDT",
      brackets: [{ bracket: 1, initialLeverage: 100, notionalFloor: "0", notionalCap: "9000" }]
    }]
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /maximum allowable position/i);
  assert.equal(orderPostCalls, 0);
});

test("flip order only counts the newly opened opposite-side remainder", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "SELL",
    quoteAmount: "210",
    leverage: 100,
    autoReduceOnly: false,
    positionAmt: "200",
    positionNotional: "20000",
    positionLeverage: "100",
    bracketResponse: [{
      symbol: "BTCUSDT",
      brackets: [{ bracket: 1, initialLeverage: 100, notionalFloor: "0", notionalCap: "2000" }]
    }]
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(orderPostCalls, 1);
});

test("entry maker retry rechecks leverage bracket with the retried price", async () => {
  const storageState: Record<string, unknown> = {
    apiKey: "key",
    apiSecret: "secret",
    baseUrl: "https://fapi.binance.com",
    quoteAmount: "100",
    leverage: 100,
    offsetTicks: 0,
    dryRun: false,
    autoReduceOnly: true,
    replaceReduceOnly: true,
    recvWindow: 5000,
    exitOrderIndex: {}
  };
  const bookResponses = [
    { bidPrice: "99.8", askPrice: "100.1" },
    { bidPrice: "104.8", askPrice: "105.1" },
    { bidPrice: "104.8", askPrice: "105.1" },
    { bidPrice: "104.8", askPrice: "105.1" },
    { bidPrice: "104.8", askPrice: "105.1" },
    { bidPrice: "104.8", askPrice: "105.1" }
  ];
  let orderPostCalls = 0;
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
        return { ok: true, json: async () => [{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0", leverage: "100" }] };
      }
      if (parsed.pathname === "/fapi/v1/leverageBracket") {
        return {
          ok: true,
          json: async () => [{
            symbol: "BTCUSDT",
            brackets: [{ bracket: 1, initialLeverage: 100, notionalFloor: "0", notionalCap: "10200" }]
          }]
        };
      }
      if (parsed.pathname === "/fapi/v1/openOrders") {
        return { ok: true, json: async () => [] };
      }
      if (parsed.pathname === "/fapi/v1/order" && options.method === "POST") {
        orderPostCalls += 1;
        return {
          ok: false,
          status: 400,
          json: async () => ({ code: -5022, msg: "Due to maker only order, could not be fulfilled." })
        };
      }
      throw new Error(`Unexpected fetch ${options.method || "GET"} ${url}`);
    }
  });

  const response = await new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
    apiListeners[0]({
      type: "PLACE_MAKER_ORDER",
      side: "SELL",
      symbol: "BTCUSDT",
      quoteAmount: "100",
      leverage: 100,
      offsetTicks: 0,
      dryRun: false
    }, {}, (res) => resolve(res as { ok: boolean; result?: Record<string, unknown>; error?: string }));
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /maximum allowable position/i);
  assert.equal(orderPostCalls, 1);
});

test("short entry includes existing sell opening maker orders in leverage bracket projection", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "SELL",
    quoteAmount: "20",
    leverage: 100,
    openOrders: [{
      symbol: "BTCUSDT",
      side: "SELL",
      type: "LIMIT",
      status: "NEW",
      price: "100",
      origQty: "90",
      executedQty: "0",
      reduceOnly: false,
      clientOrderId: "mb_sell_existing"
    }]
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /maximum allowable position/i);
  assert.equal(orderPostCalls, 0);
});

test("partial filled opening maker order only counts remaining notional", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "20",
    leverage: 100,
    bracketResponse: [{
      symbol: "BTCUSDT",
      brackets: [{ bracket: 1, initialLeverage: 100, notionalFloor: "0", notionalCap: "5000" }]
    }],
    openOrders: [{
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "PARTIALLY_FILLED",
      price: "100",
      origQty: "90",
      executedQty: "80",
      reduceOnly: false,
      clientOrderId: "mb_buy_existing"
    }]
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(orderPostCalls, 1);
});

test("partial filled opening maker order remaining quantity counts toward cap", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "20",
    leverage: 100,
    bracketResponse: [{
      symbol: "BTCUSDT",
      brackets: [{ bracket: 1, initialLeverage: 100, notionalFloor: "0", notionalCap: "2500" }]
    }],
    openOrders: [{
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "PARTIALLY_FILLED",
      price: "100",
      origQty: "90",
      executedQty: "80",
      reduceOnly: false,
      clientOrderId: "mb_buy_existing"
    }]
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /maximum allowable position/i);
  assert.equal(orderPostCalls, 0);
});

test("reduce-only open orders are excluded from opening exposure projection", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "20",
    leverage: 100,
    openOrders: [{
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "NEW",
      price: "100",
      origQty: "90",
      executedQty: "0",
      reduceOnly: "true",
      clientOrderId: "mb_buy_existing"
    }]
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(orderPostCalls, 1);
});

test("boolean true reduce-only open orders are excluded from opening exposure projection", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "20",
    leverage: 100,
    openOrders: [{
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "NEW",
      price: "100",
      origQty: "90",
      executedQty: "0",
      reduceOnly: true,
      clientOrderId: "mb_buy_existing"
    }]
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(orderPostCalls, 1);
});

test("string false reduce-only open orders are counted as opening exposure", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "20",
    leverage: 100,
    openOrders: [{
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "NEW",
      price: "100",
      origQty: "90",
      executedQty: "0",
      reduceOnly: "false",
      clientOrderId: "mb_buy_existing"
    }]
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /maximum allowable position/i);
  assert.equal(orderPostCalls, 0);
});

test("opening order with remaining quantity but no usable price fails closed", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "20",
    leverage: 100,
    openOrders: [{
      symbol: "BTCUSDT",
      side: "BUY",
      type: "STOP",
      status: "NEW",
      origQty: "1",
      executedQty: "0",
      reduceOnly: false,
      clientOrderId: "manual_buy_existing"
    }]
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /open order notional/i);
  assert.equal(orderPostCalls, 0);
});

test("non-array open orders response fails closed", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "20",
    leverage: 100,
    openOrders: { code: -1000, msg: "unexpected shape" } as unknown as Array<Record<string, unknown>>
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /open orders/i);
  assert.equal(orderPostCalls, 0);
});

test("opening order with invalid quantity fields fails closed", async () => {
  const { response, orderPostCalls } = await placeMakerOrderWithBracketFixture({
    side: "BUY",
    quoteAmount: "20",
    leverage: 100,
    openOrders: [{
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "NEW",
      price: "100",
      origQty: "not-a-number",
      executedQty: "0",
      reduceOnly: false,
      clientOrderId: "manual_buy_existing"
    }]
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /open order quantity/i);
  assert.equal(orderPostCalls, 0);
});
