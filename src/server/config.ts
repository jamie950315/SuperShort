import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StrategyConfig } from "../shared/types.js";

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databasePath: string;
  symbol: string;
  binanceApiKey: string;
  binanceApiSecret: string;
  binanceBaseUrl: string;
  binanceWsBaseUrl: string;
  adminUsername: string;
  adminPasswordHash: string;
  sessionSecret: string;
  rawRetentionDays: number;
  storageMaxBytes: number;
}

const defaultStorageMaxBytes = 20 * 1024 * 1024 * 1024;

export function loadConfig(): AppConfig {
  const databasePath = resolve(process.env.DATABASE_PATH ?? "./data/supershort.db");
  mkdirSync(dirname(databasePath), { recursive: true });

  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 8787),
    databasePath,
    symbol: (process.env.SYMBOL ?? "BTCUSDC").toUpperCase(),
    binanceApiKey: process.env.BINANCE_API_KEY ?? "",
    binanceApiSecret: process.env.BINANCE_API_SECRET ?? "",
    binanceBaseUrl: process.env.BINANCE_BASE_URL ?? "https://fapi.binance.com",
    binanceWsBaseUrl: process.env.BINANCE_WS_BASE_URL ?? "wss://fstream.binance.com",
    adminUsername: process.env.ADMIN_USERNAME ?? "admin",
    adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
    sessionSecret: process.env.SESSION_SECRET ?? "dev-session-secret-change-me",
    rawRetentionDays: Number(process.env.RAW_RETENTION_DAYS ?? 7),
    storageMaxBytes: Number(process.env.STORAGE_MAX_BYTES ?? defaultStorageMaxBytes)
  };
}

export function defaultStrategyConfig(symbol = "BTCUSDC"): StrategyConfig {
  return {
    version: 1,
    enabled: true,
    symbol,
    interval: "30s",
    persistMs: 0,
    longBelow: 20,
    shortAbove: 80,
    tp: 3,
    slEnabled: true,
    sl: 1,
    slTriggerOffset: 0.5,
    entryTtlMs: 3000,
    makerSlRetryMs: 3000,
    emergencySl: 8,
    priceVelocityWindowMs: 3000,
    maxPriceVelocityUsdPerSec: 5,
    slLevels: [0.5, 1, 2, 3, 5, 10],
    slLadder: [
      { triggerOffset: 1, limitOffset: 1.5, quantityPct: 0.5 },
      { triggerOffset: 3, limitOffset: 3.5, quantityPct: 0.3 },
      { triggerOffset: 6, limitOffset: 6.5, quantityPct: 0.2 }
    ],
    capital: 500,
    leverage: 20,
    compoundRate: 0,
    mode: "single",
    makerOffsetTicks: 0,
    fillStrictness: "realistic",
    createdAt: Date.now()
  };
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [scheme, salt, hash] = encoded.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
