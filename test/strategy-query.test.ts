import assert from "node:assert/strict";
import test from "node:test";
import {
  parseStrategyQueryFilters,
  parseStrategyQueryCsv,
  strategyQueryOptions,
  queryStrategyRows
} from "../src/server/strategyQuery.js";

const sampleCsv = `interval,persistMs,longBelow,shortAbove,tp,sl,mode,entries,wins,losses,winRate,within30s,p90HoldSeconds,p99HoldSeconds,maxHoldSeconds,totalUsdcPnl,expectancyPrice,meanUsdPerTrade,stdUsdPerTrade,tradeSharpe,cumulativeTradeSharpe,finalEquity,maxDrawdownPct
5s,500,40,50,1,2,single,10,7,3,0.7,0.5,8,20,40,120,0.2,12,2,6,18,620,0.1
5s,500,40,55,1,2,single,20,12,8,0.6,0.4,10,30,50,80,0.1,4,3,1.333333,8,580,0.2
15s,500,40,55,1,2,single,40,30,10,0.75,0.6,12,35,60,160,0.4,4,5,0.8,12,660,0.15
5s,500,45,55,1,2,independent,30,18,12,0.6,0.3,14,45,80,-40,-0.2,-1.333333,4,-0.333333,-2,460,0.3
`;

test("strategy query returns exact strategy rows without summary rows", () => {
  const rows = parseStrategyQueryCsv(sampleCsv);

  const result = queryStrategyRows(rows, {
    interval: "5s",
    persistMs: 500,
    longBelow: 40,
    shortAbove: 55,
    tp: 1,
    sl: 2,
    mode: "single"
  });

  assert.equal(result.approximate, false);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].type, "match");
  assert.equal(result.rows[0].shortAbove, 55);
  assert.equal(result.rows[0].finalEquity, 580);
});

test("strategy query uses nearest lower and upper numeric values when exact value is missing", () => {
  const rows = parseStrategyQueryCsv(sampleCsv);

  const result = queryStrategyRows(rows, {
    interval: "5s",
    persistMs: 500,
    longBelow: 40,
    shortAbove: 52,
    tp: 1,
    sl: 2,
    mode: "single"
  });

  assert.equal(result.approximate, true);
  assert.deepEqual(result.matchedValues.shortAbove, {
    requested: 52,
    values: [50, 55],
    exact: false
  });
  assert.deepEqual(result.rows.map((row) => row.type), ["match", "match", "average", "median"]);
  assert.deepEqual(result.rows.slice(0, 2).map((row) => row.shortAbove), [50, 55]);
});

test("strategy query adds average and median rows for approximate matches", () => {
  const rows = parseStrategyQueryCsv(sampleCsv);

  const result = queryStrategyRows(rows, {
    interval: "5s",
    persistMs: 500,
    longBelow: 40,
    shortAbove: 52,
    tp: 1,
    sl: 2,
    mode: "single"
  });

  const average = result.rows.find((row) => row.type === "average");
  const median = result.rows.find((row) => row.type === "median");

  assert.equal(average?.entries, 15);
  assert.equal(average?.wins, 9.5);
  assert.equal(average?.winRate, 0.65);
  assert.equal(average?.finalEquity, 600);
  assert.equal(average?.maxDrawdownPct, 0.15);
  assert.equal(median?.entries, 15);
  assert.equal(median?.wins, 9.5);
  assert.equal(median?.winRate, 0.65);
  assert.equal(median?.finalEquity, 600);
});

test("strategy query parser normalizes query string filters", () => {
  const parsed = parseStrategyQueryFilters({
    interval: "5s",
    persistMs: "500",
    longBelow: "40",
    shortAbove: "52",
    tp: "1",
    sl: "2",
    mode: "single",
    limit: "25"
  });

  assert.deepEqual(parsed.filters, {
    interval: "5s",
    persistMs: 500,
    longBelow: 40,
    shortAbove: 52,
    tp: 1,
    sl: 2,
    mode: "single"
  });
  assert.deepEqual(parsed.resultFilters, {});
  assert.equal(parsed.limit, 25);
});

test("strategy query parser rejects invalid numeric filters", () => {
  assert.throws(
    () => parseStrategyQueryFilters({ shortAbove: "abc" }),
    /shortAbove must be a number/
  );
});

test("strategy query exposes tested values for quick selection", () => {
  const rows = parseStrategyQueryCsv(sampleCsv);

  assert.deepEqual(strategyQueryOptions(rows), {
    intervals: ["5s", "15s"],
    modes: ["single", "independent"],
    persistMs: [500],
    longBelow: [40, 45],
    shortAbove: [50, 55],
    tp: [1],
    sl: [2]
  });
});

test("strategy query filters by result thresholds", () => {
  const rows = parseStrategyQueryCsv(sampleCsv);

  const result = queryStrategyRows(rows, {}, {
    resultFilters: {
      finalEquityMin: 600,
      winRateMin: 0.7,
      maxDrawdownPctMax: 0.16,
      entriesMin: 10
    }
  });

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => row.finalEquity), [620, 660]);
});

test("strategy query parser normalizes result percentage filters", () => {
  const parsed = parseStrategyQueryFilters({
    finalEquityMin: "1000",
    winRateMin: "65",
    maxDrawdownPctMax: "20",
    tradeSharpeMin: "0.5",
    entriesMin: "100"
  });

  assert.deepEqual(parsed.resultFilters, {
    finalEquityMin: 1000,
    winRateMin: 0.65,
    maxDrawdownPctMax: 0.2,
    tradeSharpeMin: 0.5,
    entriesMin: 100
  });
});
