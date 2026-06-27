#!/usr/bin/env node
const {
  loadJsonl,
  dedupeBarFinalSamples,
  evaluateCandidate,
  makeFastCandidates
} = require("./flash-point-model");

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node CrossingFetch/analysis/fit-flash-point.js <file.jsonl> [more.jsonl]");
  process.exit(1);
}

const rows = files.flatMap(loadJsonl);
const samples = dedupeBarFinalSamples(rows);
if (samples.length < 200) {
  console.error(`Need at least 200 bar-final samples for fitting; got ${samples.length}.`);
  process.exit(1);
}

const warmup = Math.min(200, Math.floor(samples.length * 0.2));
const candidates = makeFastCandidates();
const results = [];
for (const candidate of candidates) {
  results.push(evaluateCandidate(samples, candidate, warmup));
}
results.sort((a, b) => a.totalRmse - b.totalRmse);

const crossingRows = rows.filter((row) => row.reason === "crossing-event");
const summary = {
  files: files.map((file) => file.split("/").pop()),
  rawRows: rows.length,
  barFinalSamples: samples.length,
  warmup,
  crossingEvents: crossingRows.length,
  top: results.slice(0, 20)
};

console.log(JSON.stringify(summary, null, 2));
