(function () {
  if (window.__crossingFetchContent) return;
  window.__crossingFetchContent = true;

  const Core = window.CrossingFetchCore;
  const DB_NAME = "CrossingFetchDB";
  const DB_VERSION = 1;
  const STORE = "samples";
  const DEFAULT_INTERVAL_MS = 1000;
  const FLASH_REFRESH_INTERVAL_MS = 500;
  const NO_BAR_FALLBACK_SAMPLE_MS = 1000;

  let dbPromise = null;
  let recording = false;
  let sessionId = makeSessionId();
  let latestBar = null;
  let latestBarSeries = [];
  let latestBarSeriesByPath = new Map();
  let latestFlash = null;
  let latestIndicatorSeries = [];
  let latestIndicatorSeriesByPath = new Map();
  let latestSocketSnapshot = null;
  let previousFlash = null;
  let previousInstantFlash = null;
  let lastObservedSample = null;
  let liveTimer = null;
  let socketMessages = 0;
  let extractedBars = 0;
  let savedSamples = 0;
  let flashRefreshTimer = null;
  let lastNoBarSampleAt = 0;
  let lastNoBarFlashKey = "";
  let lastCrossingEventKey = "";
  let lastSocketAlignedKey = "";

  createPanel();
  startFlashRefreshLoop();
  window.addEventListener("message", handlePageMessage);

  function handlePageMessage(event) {
    if (event.source !== window || event.data?.source !== "CrossingFetch") return;
    if (event.data.type !== "TRADINGVIEW_SOCKET_MESSAGE") return;
    socketMessages += 1;
    const messages = Core.parseTradingViewFrames(event.data.data);
    const instantBarSeriesEntries = [];
    const instantIndicatorSeriesEntries = [];
    const instantBars = [];
    for (const message of messages) {
      const barSeries = Core.extractBarSeriesFromMessage(message);
      const bars = flattenBarSeries(barSeries);
      const numericSeries = Core.extractNumericSeriesFromMessage(message);
      instantBarSeriesEntries.push(...barSeries);
      instantIndicatorSeriesEntries.push(...numericSeries);
      instantBars.push(...bars);
      if (numericSeries.length) latestIndicatorSeries = rememberNumericSeries(numericSeries);
      if (barSeries.length) latestBarSeries = rememberBarSeries(barSeries);
      if (!bars.length) continue;
      extractedBars += bars.length;
      const newest = bars[bars.length - 1];
      if (!latestBar || newest.time >= latestBar.time) latestBar = newest;
    }
    const socketSnapshot = makeSocketSnapshot({
      barSeries: instantBarSeriesEntries,
      numericSeries: instantIndicatorSeriesEntries,
      bars: instantBars,
      frameCount: messages.length
    });
    if (socketSnapshot) latestSocketSnapshot = socketSnapshot;
    saveSocketAlignedSample(socketSnapshot);
    updateStatus();
  }

  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "crossing-fetch-panel";
    panel.innerHTML = `
      <div class="cf-title">
        <span>CrossingFetch</span>
        <button type="button" id="cf-hide" title="Hide">×</button>
      </div>
      <div class="cf-row">
        <label for="cf-mode">Mode</label>
        <select id="cf-mode">
          <option value="bar">Bar close</option>
          <option value="live">Live interval</option>
        </select>
      </div>
      <div class="cf-row">
        <label for="cf-interval">Interval ms</label>
        <input id="cf-interval" type="number" min="250" step="250" value="1000" />
      </div>
      <div class="cf-actions">
        <button type="button" id="cf-start">Start</button>
        <button type="button" class="secondary" id="cf-stop">Stop</button>
        <button type="button" class="secondary" id="cf-export">Export JSONL</button>
        <button type="button" class="secondary" id="cf-clear">Clear Session</button>
      </div>
      <div class="cf-status" id="cf-status">Ready.</div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector("#cf-hide").addEventListener("click", () => panel.remove());
    panel.querySelector("#cf-start").addEventListener("click", startRecording);
    panel.querySelector("#cf-stop").addEventListener("click", stopRecording);
    panel.querySelector("#cf-export").addEventListener("click", exportJsonl);
    panel.querySelector("#cf-clear").addEventListener("click", clearCurrentSession);
    updateStatus();
  }

  function startRecording() {
    if (recording) return;
    recording = true;
    previousFlash = null;
    previousInstantFlash = null;
    lastObservedSample = null;
    lastNoBarSampleAt = 0;
    lastNoBarFlashKey = "";
    lastCrossingEventKey = "";
    lastSocketAlignedKey = "";
    const interval = getIntervalMs();
    liveTimer = setInterval(tickRecorder, interval);
    tickRecorder();
    updateStatus("Recording started.");
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
    const mode = getMode();
    if (mode === "bar" && lastObservedSample?.bar) {
      saveSample({ ...lastObservedSample, reason: "stop-final-observed" }).catch(showError);
      lastObservedSample = null;
    }
    updateStatus("Recording stopped.");
  }

  function tickRecorder() {
    const mode = getMode();
    const current = makeSample(mode, mode === "live" ? "live-interval" : "observed");
    latestFlash = current.flashPoint;

    if (mode === "live") {
      saveSample(current).catch(showError);
      return;
    }

    saveCrossingEventSample(current);

    if (!current.bar) {
      saveNoBarFallbackSample(current);
      lastObservedSample = current;
      updateStatus();
      return;
    }

    if (lastObservedSample?.bar?.time && current.bar?.time && current.bar.time !== lastObservedSample.bar.time) {
      saveSample({ ...lastObservedSample, reason: "bar-final-observed" }).catch(showError);
    }
    lastObservedSample = current;
    updateStatus();
  }

  function makeSample(mode, reason) {
    const flash = readFlashPointValues();
    const crossing = Core.detectCrossing(previousFlash, flash);
    previousFlash = flash;

    return {
      schema: "crossing-fetch.sample.v1",
      sessionId,
      mode,
      reason,
      recordedAt: new Date().toISOString(),
      page: {
        url: location.href,
        title: document.title
      },
      market: {
        symbol: guessSymbol(),
        timeframe: guessTimeframe()
      },
      bar: latestBar,
      barSeries: latestBarSeries,
      instantBar: latestSocketSnapshot?.bar || null,
      instantBarSeries: latestSocketSnapshot?.barSeries || [],
      instantFlashPoint: latestSocketSnapshot?.instantFlashPoint || null,
      flashPoint: flash,
      indicatorSeries: latestIndicatorSeries,
      instantIndicatorSeries: latestSocketSnapshot?.indicatorSeries || [],
      diagnostics: {
        socketMessages,
        barsSeen: extractedBars,
        hasLatestBar: Boolean(latestBar),
        hasInstantSocketSnapshot: Boolean(latestSocketSnapshot),
        instantSocketReceivedAt: latestSocketSnapshot?.receivedAt || null,
        instantSocketFrameCount: latestSocketSnapshot?.frameCount || 0
      },
      derived: {
        crossing
      }
    };
  }

  function saveNoBarFallbackSample(sample) {
    if (!sample.flashPoint?.readable) return;
    const now = Date.now();
    const flashKey = `${sample.flashPoint.c1}:${sample.flashPoint.c2}:${sample.flashPoint.source}`;
    if (flashKey !== lastNoBarFlashKey) {
      lastNoBarFlashKey = flashKey;
      lastNoBarSampleAt = now;
      saveSample({ ...sample, reason: "no-bar-flash-change" }).catch(showError);
      return;
    }
    if (now - lastNoBarSampleAt >= NO_BAR_FALLBACK_SAMPLE_MS) {
      lastNoBarSampleAt = now;
      saveSample({ ...sample, reason: "no-bar-fallback-interval" }).catch(showError);
    }
  }

  function saveCrossingEventSample(sample) {
    const crossing = sample.derived?.crossing;
    if (crossing !== "up" && crossing !== "down") return;
    const eventKey = `${sample.bar?.time || "no-bar"}:${crossing}:${sample.flashPoint?.c1}:${sample.flashPoint?.c2}`;
    if (eventKey === lastCrossingEventKey) return;
    lastCrossingEventKey = eventKey;
    saveSample({ ...sample, reason: "crossing-event" }).catch(showError);
  }

  function saveSocketAlignedSample(socketSnapshot) {
    if (!recording || !socketSnapshot?.bar || !socketSnapshot?.instantFlashPoint) return;
    const flash = socketSnapshot.instantFlashPoint;
    const bar = socketSnapshot.bar;
    const socketKey = [
      bar.time,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      flash.c1,
      flash.c2
    ].join(":");
    if (socketKey === lastSocketAlignedKey) return;
    lastSocketAlignedKey = socketKey;
    const crossing = Core.detectCrossing(previousInstantFlash, flash);
    previousInstantFlash = flash;
    saveSample({
      schema: "crossing-fetch.sample.v1",
      sessionId,
      mode: getMode(),
      reason: "socket-aligned",
      recordedAt: socketSnapshot.receivedAt,
      page: {
        url: location.href,
        title: document.title
      },
      market: {
        symbol: guessSymbol(),
        timeframe: guessTimeframe()
      },
      bar,
      barSeries: latestBarSeries,
      instantBar: bar,
      instantBarSeries: socketSnapshot.barSeries,
      instantFlashPoint: flash,
      flashPoint: flash,
      indicatorSeries: latestIndicatorSeries,
      instantIndicatorSeries: socketSnapshot.indicatorSeries,
      diagnostics: {
        socketMessages,
        barsSeen: extractedBars,
        hasLatestBar: Boolean(latestBar),
        hasInstantSocketSnapshot: true,
        instantSocketReceivedAt: socketSnapshot.receivedAt,
        instantSocketFrameCount: socketSnapshot.frameCount
      },
      derived: {
        crossing
      }
    }).catch(showError);
  }

  function readFlashPointValues() {
    const fromTextNodes = Core.extractFlashPointFromVisibleTexts(getVisibleTextNodes(), "Flash Point Pro");
    if (fromTextNodes.readable) return fromTextNodes;
    const fromBody = Core.extractFlashPointFromText(document.body?.innerText || "");
    return {
      ...fromBody,
      source: fromBody.readable ? "right-scale-label" : "unreadable"
    };
  }

  function getVisibleTextNodes(root) {
    const start = root || document.body;
    if (!start) return [];
    const nodes = [];
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = String(node.nodeValue || "").trim();
        if (!text) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest("#crossing-fetch-panel")) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) nodes.push(String(walker.currentNode.nodeValue || "").trim());
    return nodes;
  }

  function startFlashRefreshLoop() {
    if (flashRefreshTimer) return;
    flashRefreshTimer = setInterval(refreshFlashDisplay, FLASH_REFRESH_INTERVAL_MS);
    refreshFlashDisplay();
  }

  function refreshFlashDisplay() {
    const next = readFlashPointValues();
    const previousKey = latestFlash ? `${latestFlash.c1}:${latestFlash.c2}:${latestFlash.source}` : "";
    const nextKey = `${next.c1}:${next.c2}:${next.source}`;
    latestFlash = next;
    if (previousKey !== nextKey) updateStatus();
  }

  async function saveSample(sample) {
    const db = await openDb();
    await putRecord(db, sample);
    savedSamples += 1;
    updateStatus();
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  function putRecord(db, record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function readCurrentSession() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const rows = [];
      const tx = db.transaction(STORE, "readonly");
      const index = tx.objectStore(STORE).index("sessionId");
      const request = index.openCursor(IDBKeyRange.only(sessionId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        rows.push(cursor.value);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(rows);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function deleteCurrentSession() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const index = tx.objectStore(STORE).index("sessionId");
      const request = index.openCursor(IDBKeyRange.only(sessionId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function exportJsonl() {
    try {
      const rows = await readCurrentSession();
      const jsonl = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
      const blob = new Blob([jsonl], { type: "application/jsonl;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `crossing-fetch-${sessionId}.jsonl`;
      anchor.click();
      URL.revokeObjectURL(url);
      updateStatus(`Exported ${rows.length} samples.`);
    } catch (error) {
      showError(error);
    }
  }

  async function clearCurrentSession() {
    try {
      await deleteCurrentSession();
      savedSamples = 0;
      sessionId = makeSessionId();
      lastObservedSample = null;
      previousFlash = null;
      previousInstantFlash = null;
      lastNoBarSampleAt = 0;
      lastNoBarFlashKey = "";
      lastCrossingEventKey = "";
      lastSocketAlignedKey = "";
      latestBarSeries = [];
      latestBarSeriesByPath.clear();
      latestIndicatorSeries = [];
      latestIndicatorSeriesByPath.clear();
      latestSocketSnapshot = null;
      updateStatus("Current session cleared.");
    } catch (error) {
      showError(error);
    }
  }

  function getMode() {
    return document.querySelector("#cf-mode")?.value === "live" ? "live" : "bar";
  }

  function getIntervalMs() {
    const value = Number(document.querySelector("#cf-interval")?.value);
    return Math.max(250, Number.isFinite(value) ? Math.floor(value) : DEFAULT_INTERVAL_MS);
  }

  function updateStatus(extra) {
    const status = document.querySelector("#cf-status");
    if (!status) return;
    const flashText = latestFlash?.readable
      ? `C1 ${formatNumber(latestFlash.c1)} / C2 ${formatNumber(latestFlash.c2)} (${latestFlash.source || "unknown"})`
      : "Flash values not readable yet";
    status.innerHTML = [
      extra ? `<strong>${escapeHtml(extra)}</strong>` : "",
      `Recording: ${recording ? "yes" : "no"}`,
      `Session samples: ${savedSamples}`,
      `Socket messages: ${socketMessages}`,
      `Bars seen: ${extractedBars}`,
      `Latest bar: ${latestBar ? new Date(latestBar.time).toISOString() : "--"}`,
      escapeHtml(flashText)
    ].filter(Boolean).join("\n");
  }

  function showError(error) {
    updateStatus(`Error: ${error?.message || error}`);
  }

  function guessSymbol() {
    const pathSymbol = location.pathname.match(/symbols\/([^/?#]+)/i);
    if (pathSymbol) return pathSymbol[1].replace(/[^A-Z0-9._:-]/gi, "").toUpperCase();
    const titleMatch = document.title.match(/\b([A-Z0-9]{2,20}(?:USDT|USD|BTC|ETH))\b/);
    if (titleMatch) return titleMatch[1].toUpperCase();
    return "unknown";
  }

  function guessTimeframe() {
    const text = document.body.innerText || "";
    const match = text.match(/\b(1[smhdwM]?|3m|5m|15m|30m|45m|1h|2h|4h|1D|1W|1M)\b/);
    return match ? match[1] : "unknown";
  }

  function rememberNumericSeries(series) {
    const updatedAt = new Date().toISOString();
    for (const entry of series) {
      const previous = latestIndicatorSeriesByPath.get(entry.path);
      const recentPoints = mergeRecentPoints(previous?.recentPoints || [], entry.points);
      latestIndicatorSeriesByPath.set(entry.path, {
        path: entry.path,
        latest: recentPoints[recentPoints.length - 1],
        recentPoints,
        pointCount: (previous?.pointCount || 0) + entry.points.length,
        updatedAt
      });
    }
    return [...latestIndicatorSeriesByPath.values()]
      .sort((a, b) => rankIndicatorSeries(a) - rankIndicatorSeries(b) || a.path.localeCompare(b.path))
      .slice(0, 50);
  }

  function rememberBarSeries(series) {
    const updatedAt = new Date().toISOString();
    for (const entry of series) {
      const previous = latestBarSeriesByPath.get(entry.path);
      const recentPoints = mergeRecentPoints(previous?.recentPoints || [], entry.points);
      latestBarSeriesByPath.set(entry.path, {
        path: entry.path,
        latest: recentPoints[recentPoints.length - 1],
        recentPoints,
        pointCount: (previous?.pointCount || 0) + entry.points.length,
        updatedAt
      });
    }
    return [...latestBarSeriesByPath.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 50);
  }

  function makeSocketSnapshot({ barSeries, numericSeries, bars, frameCount }) {
    if (!barSeries.length && !numericSeries.length && !bars.length) return null;
    const receivedAt = new Date().toISOString();
    const sortedBars = bars.slice().sort((a, b) => a.time - b.time);
    const bar = sortedBars[sortedBars.length - 1] || null;
    const indicatorSeries = makeInstantSeries(numericSeries, receivedAt, "indicator")
      .sort((a, b) => rankIndicatorSeries(a) - rankIndicatorSeries(b) || a.path.localeCompare(b.path))
      .slice(0, 50);
    return {
      receivedAt,
      frameCount,
      bar,
      barSeries: makeInstantSeries(barSeries, receivedAt, "bar"),
      indicatorSeries,
      instantFlashPoint: extractInstantFlashPoint(indicatorSeries, bar?.time)
    };
  }

  function extractInstantFlashPoint(indicatorSeries, time) {
    if (!Number.isFinite(time)) return null;
    const entry = indicatorSeries.find((item) => String(item.path || "").includes("l9uPDe"));
    const point = entry?.recentPoints?.find((item) => item.time === time);
    const values = point?.values || [];
    if (!Number.isFinite(values[0]) || !Number.isFinite(values[1])) return null;
    return {
      c1: values[0],
      c2: values[1],
      readable: true,
      source: "instant-indicator-series",
      time,
      path: entry.path
    };
  }

  function makeInstantSeries(series, updatedAt, kind) {
    return series
      .map((entry) => {
        const points = dedupePointsByTime(entry.points || []).slice(-20);
        return {
          path: entry.path,
          latest: points[points.length - 1] || null,
          recentPoints: points,
          pointCount: entry.points?.length || 0,
          updatedAt,
          kind
        };
      })
      .filter((entry) => entry.latest)
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 50);
  }

  function mergeRecentPoints(previousPoints, nextPoints) {
    return dedupePointsByTime([...previousPoints, ...nextPoints]).slice(-20);
  }

  function dedupePointsByTime(points) {
    const byTime = new Map();
    for (const point of points) {
      if (!Number.isFinite(point?.time)) continue;
      byTime.set(point.time, point);
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  function flattenBarSeries(series) {
    return series.flatMap((entry) => {
      return entry.points.map((point) => ({
        ...point,
        sourcePath: entry.path
      }));
    }).sort((a, b) => a.time - b.time);
  }

  function rankIndicatorSeries(entry) {
    const values = entry.latest?.values || [];
    const firstTwoLookLikeFlash = values.length >= 2 &&
      values.slice(0, 2).every((value) => Number.isFinite(value) && value >= 0 && value <= 100);
    return firstTwoLookLikeFlash ? 0 : 1;
  }

  function makeSessionId() {
    return `cf_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? String(value) : "--";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[ch]));
  }
})();
