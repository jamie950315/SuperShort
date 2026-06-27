import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import cookie from "cookie";
import express from "express";
import { WebSocketServer } from "ws";
import { loadConfig, verifyPassword } from "./config.js";
import { openStore } from "./db.js";
import { loadStrategyQueryRows, parseStrategyQueryFilters, queryStrategyRows } from "./strategyQuery.js";
import type { DashboardPayload, IntervalName } from "../shared/types.js";

const config = loadConfig();
const store = openStore(config.databasePath);
const app = express();
const sessions = new Map<string, { username: string; expiresAt: number }>();
const PAPER_RESET_EQUITY_USDC = 500;

app.use(express.json({ limit: "1mb" }));

function sessionCookie(token: string): string {
  return cookie.serialize("ss_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.nodeEnv === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60
  });
}

function getSession(req: express.Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const token = cookie.parse(header).ss_session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) return null;
  return session.username;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (getSession(req)) next();
  else res.status(401).json({ error: "unauthorized" });
}

function dashboardPayload(interval: IntervalName = "5s"): DashboardPayload {
  const active = store.getActiveConfig(config.symbol);
  return {
    config: active,
    previousConfig: store.getPreviousConfig(config.symbol),
    candles: store.getCandles(config.symbol, interval, 500),
    signals: store.getSignals(config.symbol, interval, 200),
    paperOrders: store.getPaperOrders(config.symbol, 10_000),
    trades: store.getPaperTrades(1000),
    portfolio: store.getLatestPortfolio(),
    health: store.getHealth(config.databasePath, config.rawRetentionDays, config.storageMaxBytes)
  };
}

app.get("/api/auth/me", (req, res) => {
  const username = getSession(req);
  res.json({ authenticated: Boolean(username), username });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!config.adminPasswordHash) {
    res.status(503).json({ error: "尚未設定 ADMIN_PASSWORD_HASH" });
    return;
  }
  if (username !== config.adminUsername || !password || !verifyPassword(password, config.adminPasswordHash)) {
    res.status(401).json({ error: "登入失敗" });
    return;
  }
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { username, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  res.setHeader("Set-Cookie", sessionCookie(token));
  res.json({ ok: true, username });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  const token = cookie.parse(req.headers.cookie ?? "").ss_session;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", cookie.serialize("ss_session", "", { path: "/", maxAge: 0 }));
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  res.json(store.getHealth(config.databasePath, config.rawRetentionDays, config.storageMaxBytes));
});

app.get("/api/dashboard", requireAuth, (req, res) => {
  const interval = String(req.query.interval ?? "5s") as IntervalName;
  res.json(dashboardPayload(interval));
});

app.get("/api/strategy-query", requireAuth, async (req, res) => {
  try {
    const { filters, resultFilters, limit } = parseStrategyQueryFilters(req.query);
    const { path, rows } = await loadStrategyQueryRows();
    res.json(queryStrategyRows(rows, filters, { limit, sourcePath: path, resultFilters }));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "strategy query failed" });
  }
});

app.post("/api/config", requireAuth, (req, res) => {
  const current = store.getActiveConfig(config.symbol);
  const body = req.body as Partial<typeof current>;
  const saved = store.saveStrategyConfig({
    ...current,
    ...body,
    symbol: config.symbol,
    enabled: body.enabled ?? current.enabled,
    slEnabled: body.slEnabled ?? current.slEnabled,
    slLevels: Array.isArray(body.slLevels) ? body.slLevels.map(Number).filter(Number.isFinite) : current.slLevels,
    slLadder: Array.isArray(body.slLadder)
      ? body.slLadder.map((level) => ({
        triggerOffset: Number(level.triggerOffset),
        limitOffset: Number(level.limitOffset),
        quantityPct: Number(level.quantityPct)
      }))
      : current.slLadder,
    capital: Number(body.capital ?? current.capital),
    leverage: Number(body.leverage ?? current.leverage),
    compoundRate: Number(body.compoundRate ?? current.compoundRate),
    tp: Number(body.tp ?? current.tp),
    sl: Number(body.sl ?? current.sl),
    slTriggerOffset: Number(body.slTriggerOffset ?? current.slTriggerOffset),
    entryTtlMs: Number(body.entryTtlMs ?? current.entryTtlMs),
    makerSlRetryMs: Number(body.makerSlRetryMs ?? current.makerSlRetryMs),
    emergencySl: Number(body.emergencySl ?? current.emergencySl),
    priceVelocityWindowMs: Number(body.priceVelocityWindowMs ?? current.priceVelocityWindowMs),
    maxPriceVelocityUsdPerSec: Number(body.maxPriceVelocityUsdPerSec ?? current.maxPriceVelocityUsdPerSec),
    longBelow: Number(body.longBelow ?? current.longBelow),
    shortAbove: Number(body.shortAbove ?? current.shortAbove),
    persistMs: Number(body.persistMs ?? current.persistMs),
    makerOffsetTicks: Number(body.makerOffsetTicks ?? current.makerOffsetTicks)
  });
  res.json(saved);
});

app.post("/api/portfolio/reset", requireAuth, (req, res) => {
  const interval = String(req.query.interval ?? "5s") as IntervalName;
  const time = Date.now();
  store.resetPaperPortfolio(config.symbol, PAPER_RESET_EQUITY_USDC, time);
  store.setState("paper_reset", { time, equity: PAPER_RESET_EQUITY_USDC });
  res.json(dashboardPayload(interval));
});

const clientDir = resolve("dist/client");
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get("*", (_req, res) => res.sendFile(join(clientDir, "index.html")));
}

const server = app.listen(config.port, "0.0.0.0", () => {
  const digest = createHash("sha256").update(config.databasePath).digest("hex").slice(0, 8);
  console.log(`SuperShort API listening on ${config.port}; db=${digest}`);
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket, request) => {
  const username = getSession(request as unknown as express.Request);
  if (!username) {
    socket.close(1008, "unauthorized");
    return;
  }
  const send = () => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(dashboardPayload("5s")));
  };
  send();
  const timer = setInterval(send, 1000);
  socket.on("close", () => clearInterval(timer));
});
