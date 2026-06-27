import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline";
import type {
  IntervalName,
  StrategyConfig,
  StrategyQueryFilter,
  StrategyQueryMatchedValue,
  StrategyQueryOptions,
  StrategyQueryResult,
  StrategyQueryResultFilter,
  StrategyQueryRow
} from "../shared/types.js";

const DEFAULT_CSV_PATH = "CrossingFetch/analysis/backtest-data/BTCUSDC-2024-07-01_2026-06-21/rule-grid-v08-exact-5s-15s-30s-1m-merged-500usdc-20x/flashpoint-rule-grid-v08-exact-compound0-trade-sharpe.csv";
const NUMERIC_FILTER_FIELDS = ["persistMs", "longBelow", "shortAbove", "tp", "sl"] as const;
const NUMERIC_ROW_FIELDS = [
  ...NUMERIC_FILTER_FIELDS,
  "entries",
  "wins",
  "losses",
  "winRate",
  "within30s",
  "p90HoldSeconds",
  "p99HoldSeconds",
  "maxHoldSeconds",
  "totalUsdcPnl",
  "expectancyPrice",
  "meanUsdPerTrade",
  "stdUsdPerTrade",
  "tradeSharpe",
  "cumulativeTradeSharpe",
  "finalEquity",
  "maxDrawdownPct"
] as const satisfies readonly (keyof StrategyQueryRow)[];
const SUMMARY_METRIC_FIELDS = NUMERIC_ROW_FIELDS.filter((field) => !NUMERIC_FILTER_FIELDS.includes(field as never));

type NumericFilterField = typeof NUMERIC_FILTER_FIELDS[number];
type StrategyMode = StrategyConfig["mode"];

interface StrategyQueryCache {
  path: string;
  mtimeMs: number;
  rows: StrategyQueryRow[];
}

let cache: StrategyQueryCache | null = null;

function csvPath(): string {
  return resolve(process.env.STRATEGY_QUERY_CSV_PATH ?? DEFAULT_CSV_PATH);
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "" || value.trim().toLowerCase() === "none") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseRequiredNumber(row: Record<string, string>, field: keyof StrategyQueryRow): number | null {
  return parseNumber(row[String(field)]);
}

function parseLine(line: string): string[] {
  return line.split(",");
}

function parseCsvRows(lines: string[]): StrategyQueryRow[] {
  const [headerLine, ...dataLines] = lines;
  if (!headerLine) return [];
  const headers = parseLine(headerLine);
  return dataLines
    .filter((line) => line.trim())
    .map((line) => {
      const values = parseLine(line);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
      return {
        type: "match",
        interval: row.interval as IntervalName,
        persistMs: parseRequiredNumber(row, "persistMs"),
        longBelow: parseRequiredNumber(row, "longBelow"),
        shortAbove: parseRequiredNumber(row, "shortAbove"),
        tp: parseRequiredNumber(row, "tp"),
        sl: parseRequiredNumber(row, "sl"),
        mode: row.mode as StrategyMode,
        entries: parseRequiredNumber(row, "entries"),
        wins: parseRequiredNumber(row, "wins"),
        losses: parseRequiredNumber(row, "losses"),
        winRate: parseRequiredNumber(row, "winRate"),
        within30s: parseRequiredNumber(row, "within30s"),
        p90HoldSeconds: parseRequiredNumber(row, "p90HoldSeconds"),
        p99HoldSeconds: parseRequiredNumber(row, "p99HoldSeconds"),
        maxHoldSeconds: parseRequiredNumber(row, "maxHoldSeconds"),
        totalUsdcPnl: parseRequiredNumber(row, "totalUsdcPnl"),
        expectancyPrice: parseRequiredNumber(row, "expectancyPrice"),
        meanUsdPerTrade: parseRequiredNumber(row, "meanUsdPerTrade"),
        stdUsdPerTrade: parseRequiredNumber(row, "stdUsdPerTrade"),
        tradeSharpe: parseRequiredNumber(row, "tradeSharpe"),
        cumulativeTradeSharpe: parseRequiredNumber(row, "cumulativeTradeSharpe"),
        finalEquity: parseRequiredNumber(row, "finalEquity"),
        maxDrawdownPct: parseRequiredNumber(row, "maxDrawdownPct")
      };
    });
}

export function parseStrategyQueryCsv(text: string): StrategyQueryRow[] {
  return parseCsvRows(text.split(/\r?\n/));
}

async function parseStrategyQueryCsvFile(path: string): Promise<StrategyQueryRow[]> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of rl) lines.push(line);
  return parseCsvRows(lines);
}

function numberValues(rows: StrategyQueryRow[], field: NumericFilterField): number[] {
  return [...new Set(rows.map((row) => row[field]).filter((value): value is number => value !== null && Number.isFinite(value)))]
    .sort((a, b) => a - b);
}

export function strategyQueryOptions(rows: StrategyQueryRow[]): StrategyQueryOptions {
  return {
    intervals: [...new Set(rows.map((row) => row.interval).filter((value): value is NonNullable<typeof value> => value !== null))],
    modes: [...new Set(rows.map((row) => row.mode).filter((value): value is NonNullable<typeof value> => value !== null))],
    persistMs: numberValues(rows, "persistMs"),
    longBelow: numberValues(rows, "longBelow"),
    shortAbove: numberValues(rows, "shortAbove"),
    tp: numberValues(rows, "tp"),
    sl: numberValues(rows, "sl")
  };
}

function closestValues(values: number[], requested: number): StrategyQueryMatchedValue {
  if (values.includes(requested)) return { requested, values: [requested], exact: true };
  const lower = values.filter((value) => value < requested).at(-1);
  const upper = values.find((value) => value > requested);
  return {
    requested,
    values: [lower, upper].filter((value): value is number => value !== undefined),
    exact: false
  };
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return cleanNumber(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return cleanNumber((sorted[middle - 1] + sorted[middle]) / 2);
}

function cleanNumber(value: number): number {
  return Number(value.toFixed(12));
}

function summaryRow(type: "average" | "median", rows: StrategyQueryRow[]): StrategyQueryRow {
  const summarize = type === "average" ? average : median;
  const row: StrategyQueryRow = {
    type,
    interval: null,
    persistMs: null,
    longBelow: null,
    shortAbove: null,
    tp: null,
    sl: null,
    mode: null,
    entries: null,
    wins: null,
    losses: null,
    winRate: null,
    within30s: null,
    p90HoldSeconds: null,
    p99HoldSeconds: null,
    maxHoldSeconds: null,
    totalUsdcPnl: null,
    expectancyPrice: null,
    meanUsdPerTrade: null,
    stdUsdPerTrade: null,
    tradeSharpe: null,
    cumulativeTradeSharpe: null,
    finalEquity: null,
    maxDrawdownPct: null
  };
  for (const field of SUMMARY_METRIC_FIELDS) {
    const values = rows.map((item) => item[field]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    row[field] = summarize(values);
  }
  return row;
}

export function queryStrategyRows(
  sourceRows: StrategyQueryRow[],
  filters: StrategyQueryFilter,
  options: { limit?: number; sourcePath?: string; resultFilters?: StrategyQueryResultFilter } = {}
): StrategyQueryResult {
  let rows = sourceRows;
  const matchedValues: StrategyQueryResult["matchedValues"] = {};
  const resultFilters = options.resultFilters ?? {};

  if (filters.interval) rows = rows.filter((row) => row.interval === filters.interval);
  if (filters.mode) rows = rows.filter((row) => row.mode === filters.mode);

  for (const field of NUMERIC_FILTER_FIELDS) {
    const requested = filters[field];
    if (requested === undefined) continue;
    const match = closestValues(numberValues(rows, field), requested);
    matchedValues[field] = match;
    rows = rows.filter((row) => row[field] !== null && match.values.includes(row[field]));
  }
  rows = rows.filter((row) => matchesResultFilters(row, resultFilters));

  const approximate = Object.values(matchedValues).some((match) => !match.exact);
  const limitedRows = rows.slice(0, Math.max(1, Math.min(options.limit ?? 200, 1000)));
  const resultRows = approximate && limitedRows.length > 0
    ? [...limitedRows, summaryRow("average", limitedRows), summaryRow("median", limitedRows)]
    : limitedRows;

  return {
    source: {
      path: options.sourcePath ?? "",
      rowCount: sourceRows.length
    },
    filters,
    resultFilters,
    options: strategyQueryOptions(sourceRows),
    matchedValues,
    approximate,
    rows: resultRows
  };
}

function matchesResultFilters(row: StrategyQueryRow, filters: StrategyQueryResultFilter): boolean {
  if (filters.finalEquityMin !== undefined && (row.finalEquity ?? -Infinity) < filters.finalEquityMin) return false;
  if (filters.winRateMin !== undefined && (row.winRate ?? -Infinity) < filters.winRateMin) return false;
  if (filters.maxDrawdownPctMax !== undefined && (row.maxDrawdownPct ?? Infinity) > filters.maxDrawdownPctMax) return false;
  if (filters.tradeSharpeMin !== undefined && (row.tradeSharpe ?? -Infinity) < filters.tradeSharpeMin) return false;
  if (filters.entriesMin !== undefined && (row.entries ?? -Infinity) < filters.entriesMin) return false;
  return true;
}

function oneValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseQueryNumber(params: Record<string, unknown>, field: NumericFilterField | "limit"): number | undefined {
  const raw = oneValue(params[field] as string | string[] | undefined);
  if (raw === undefined || raw.trim() === "") return undefined;
  const number = Number(raw);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a number`);
  return number;
}

function parseResultNumber(params: Record<string, unknown>, field: keyof StrategyQueryResultFilter): number | undefined {
  const raw = oneValue(params[field] as string | string[] | undefined);
  if (raw === undefined || raw.trim() === "") return undefined;
  const number = Number(raw);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a number`);
  if (field === "winRateMin" || field === "maxDrawdownPctMax") return number > 1 ? number / 100 : number;
  return number;
}

export function parseStrategyQueryFilters(params: Record<string, unknown>): { filters: StrategyQueryFilter; resultFilters: StrategyQueryResultFilter; limit: number } {
  const interval = oneValue(params.interval as string | string[] | undefined);
  const mode = oneValue(params.mode as string | string[] | undefined);
  const filters: StrategyQueryFilter = {};
  const resultFilters: StrategyQueryResultFilter = {};
  if (interval) {
    if (!["1s", "5s", "15s", "30s", "1m"].includes(interval)) throw new Error("interval is invalid");
    filters.interval = interval as IntervalName;
  }
  if (mode) {
    if (!["single", "independent"].includes(mode)) throw new Error("mode is invalid");
    filters.mode = mode as StrategyMode;
  }
  for (const field of NUMERIC_FILTER_FIELDS) {
    const value = parseQueryNumber(params, field);
    if (value !== undefined) filters[field] = value;
  }
  for (const field of ["finalEquityMin", "winRateMin", "maxDrawdownPctMax", "tradeSharpeMin", "entriesMin"] as const) {
    const value = parseResultNumber(params, field);
    if (value !== undefined) resultFilters[field] = value;
  }
  const limit = parseQueryNumber(params, "limit");
  return {
    filters,
    resultFilters,
    limit: Math.max(1, Math.min(limit ?? 200, 1000))
  };
}

export async function loadStrategyQueryRows(): Promise<{ path: string; rows: StrategyQueryRow[] }> {
  const path = csvPath();
  if (!existsSync(path)) throw new Error(`Strategy query CSV not found: ${path}`);
  const stat = statSync(path);
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs) return { path, rows: cache.rows };
  const rows = stat.size < 40_000_000
    ? parseStrategyQueryCsv(readFileSync(path, "utf8"))
    : await parseStrategyQueryCsvFile(path);
  cache = { path, mtimeMs: stat.mtimeMs, rows };
  return { path, rows };
}
