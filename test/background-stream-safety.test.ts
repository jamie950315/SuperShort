import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("extension user stream reconnects after websocket errors", () => {
  const source = readFileSync("background.js", "utf8");
  const onerrorStart = source.indexOf("ws.onerror = () =>", source.indexOf("function openUserStreamSocket"));
  const onerrorEnd = source.indexOf("ws.onclose = () =>", onerrorStart);
  const onerror = source.slice(onerrorStart, onerrorEnd);

  assert.match(onerror, /USER_STREAM_STATE\.ws = null/);
  assert.match(onerror, /scheduleUserStreamReconnect\(config\)/);
});

test("extension user stream does not reconnect idle accounts just because no events arrived", () => {
  const source = readFileSync("background.js", "utf8");

  assert.doesNotMatch(source, /USER_STREAM_STALE_TIMEOUT_MS/);
  assert.doesNotMatch(source, /function startUserStreamWatchdog/);
});
