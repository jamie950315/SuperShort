#!/usr/bin/env node
const {
  loadJsonl,
  dedupeBarFinalSamples,
  calculateRsv,
  leastSquaresAffine2
} = require("./flash-point-model");

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node CrossingFetch/analysis/fit-recurrence.js <file.jsonl> [more.jsonl]");
  process.exit(1);
}

const rows = files.flatMap(loadJsonl);
const samples = dedupeBarFinalSamples(rows);
const bars = samples.map((row) => row.bar);
const c1 = samples.map((row) => Number(row.flashPoint.c1));
const c2 = samples.map((row) => Number(row.flashPoint.c2));

const sources = ["close", "hlc3", "hl2", "ohlc4"];
const c1Models = [];
for (const sourceName of sources) {
  for (let rsvPeriod = 2; rsvPeriod <= 30; rsvPeriod += 1) {
    const rsv = calculateRsv(bars, rsvPeriod, sourceName);
    const inputs = [];
    const outputs = [];
    for (let i = 1; i < samples.length; i += 1) {
      inputs.push([rsv[i], c1[i - 1]]);
      outputs.push(c1[i]);
    }
    const model = leastSquaresAffine2(inputs.slice(200), outputs.slice(200));
    c1Models.push({
      sourceName,
      rsvPeriod,
      coefficients: model.coefficients,
      count: model.count,
      rmse: affineRmse(inputs, outputs, model.coefficients, 200)
    });
  }
}
c1Models.sort((a, b) => a.rmse - b.rmse);

const c2Inputs = [
  { name: "c1", values: c1 },
  { name: "rsv-close-5", values: calculateRsv(bars, 5, "close") },
  { name: "rsv-hlc3-5", values: calculateRsv(bars, 5, "hlc3") }
];
const c2Models = c2Inputs.map((candidate) => {
  const inputs = [];
  const outputs = [];
  for (let i = 1; i < samples.length; i += 1) {
    inputs.push([candidate.values[i], c2[i - 1]]);
    outputs.push(c2[i]);
  }
  const model = leastSquaresAffine2(inputs.slice(200), outputs.slice(200));
  return {
    input: candidate.name,
    coefficients: model.coefficients,
    count: model.count,
    rmse: affineRmse(inputs, outputs, model.coefficients, 200)
  };
}).sort((a, b) => a.rmse - b.rmse);

console.log(JSON.stringify({
  files: files.map((file) => file.split("/").pop()),
  samples: samples.length,
  c1Top: c1Models.slice(0, 10),
  c2Top: c2Models
}, null, 2));

function affineRmse(inputs, outputs, coefficients, startIndex) {
  let error = 0;
  let count = 0;
  for (let i = startIndex; i < Math.min(inputs.length, outputs.length); i += 1) {
    const row = inputs[i];
    const y = outputs[i];
    const predicted = coefficients[0] * row[0] + coefficients[1] * row[1] + coefficients[2];
    const diff = predicted - y;
    if (!Number.isFinite(diff)) continue;
    error += diff * diff;
    count += 1;
  }
  return count ? Math.sqrt(error / count) : Infinity;
}
