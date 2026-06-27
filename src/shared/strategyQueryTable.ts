import type { StrategyQueryRow } from "./types.js";

export type StrategyQuerySortKey = keyof StrategyQueryRow;
export type StrategyQuerySortDirection = "asc" | "desc";

export interface StrategyQuerySort {
  key: StrategyQuerySortKey;
  direction: StrategyQuerySortDirection;
}

function rankSummary(type: StrategyQueryRow["type"]): number {
  if (type === "average") return 1;
  if (type === "median") return 2;
  return 0;
}

function compareValues(a: StrategyQueryRow[StrategyQuerySortKey], b: StrategyQueryRow[StrategyQuerySortKey]): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "zh-TW", { numeric: true });
}

export function sortStrategyQueryRows(rows: StrategyQueryRow[], sort: StrategyQuerySort | null): StrategyQueryRow[] {
  if (!sort) return rows;
  const matches = rows.filter((row) => row.type === "match");
  const summaries = rows.filter((row) => row.type !== "match").sort((a, b) => rankSummary(a.type) - rankSummary(b.type));
  const direction = sort.direction === "asc" ? 1 : -1;
  return [
    ...matches.sort((a, b) => compareValues(a[sort.key], b[sort.key]) * direction),
    ...summaries
  ];
}
