(function () {
  if (window.__bmwPanelInjected) return;
  window.__bmwPanelInjected = true;

  const PANEL_LAYOUT_KEY = "bmwPanelLayoutV2";
  const SNAPSHOT_INTERVAL_MS = 5000;
  const MARKET_TICKER_INTERVAL_MS = 250;
  const SYMBOL_AUTO_DETECT_DELAY_MS = 200;
  const SYMBOL_QUOTES = ["FDUSD", "USDC", "USDT", "BUSD", "USD"];
  let snapshotTimer = null;
  let marketTickerTimer = null;
  let snapshotInFlight = false;
  let marketTickerInFlight = false;
  let layoutSaveTimer = null;
  let symbolDetectTimer = null;
  let symbolObserver = null;
  let symbolAutoDetectActive = false;
  let symbolManuallyLocked = false;
  let suppressLayoutSave = false;
  let extensionAlive = true;

  function isRuntimeReady() {
    try {
      return extensionAlive && typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  function handleRuntimeError(error, fallbackMessage = "Extension context invalidated. Reload this page after reloading the extension.") {
    const message = String(error?.message || error || fallbackMessage);
    if (/Extension context invalidated/i.test(message) || !isRuntimeReady()) {
      extensionAlive = false;
      if (snapshotTimer) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
      }
      if (marketTickerTimer) {
        clearInterval(marketTickerTimer);
        marketTickerTimer = null;
      }
      snapshotInFlight = false;
      marketTickerInFlight = false;
      if (layoutSaveTimer) {
        clearTimeout(layoutSaveTimer);
        layoutSaveTimer = null;
      }
      setStatus(fallbackMessage);
      for (const button of panel.querySelectorAll("button")) button.disabled = true;
      return true;
    }
    return false;
  }

  function sendRuntimeMessage(payload, callback) {
    if (!isRuntimeReady()) {
      handleRuntimeError(new Error("Extension context invalidated"));
      if (callback) callback({ ok: false, error: "Extension context invalidated. Reload this page after reloading the extension." });
      return false;
    }

    try {
      chrome.runtime.sendMessage(payload, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          handleRuntimeError(err);
          if (callback) callback({ ok: false, error: err.message || String(err) });
          return;
        }
        if (callback) callback(res);
      });
      return true;
    } catch (error) {
      handleRuntimeError(error);
      if (callback) callback({ ok: false, error: error?.message || String(error) });
      return false;
    }
  }

  function storageGet(keys, callback) {
    if (!isRuntimeReady()) {
      handleRuntimeError(new Error("Extension context invalidated"));
      return;
    }
    try {
      chrome.storage.local.get(keys, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          handleRuntimeError(err);
          return;
        }
        callback(res);
      });
    } catch (error) {
      handleRuntimeError(error);
    }
  }

  function storageSet(items) {
    if (!isRuntimeReady()) {
      handleRuntimeError(new Error("Extension context invalidated"));
      return;
    }
    try {
      chrome.storage.local.set(items, () => {
        const err = chrome.runtime.lastError;
        if (err) handleRuntimeError(err);
      });
    } catch (error) {
      handleRuntimeError(error);
    }
  }

  const panel = document.createElement("div");
  panel.id = "bmw-panel";
  panel.innerHTML = `
    <div class="bmw-title" id="bmw-drag-handle">
      <span>SuperShort</span>
      <button id="bmw-close" title="Hide">×</button>
    </div>
    <label>Symbol</label>
    <input id="bmw-symbol" value="${guessSymbol() || ""}" spellcheck="false" />
    <label>本金金額（未乘槓桿，USDT/USDC）</label>
    <input id="bmw-amount" type="number" min="0" step="1" />
    <label>Leverage</label>
    <input id="bmw-leverage" type="number" min="1" max="125" step="1" />
    <div class="bmw-leverage-limit" id="bmw-leverage-limit">可開本金上限 --</div>
    <label>Maker offset ticks</label>
    <input id="bmw-offset" type="number" min="0" step="1" />
    <label>平倉 GTX 重試次數</label>
    <input id="bmw-exit-chase" type="number" min="0" max="5" step="1" />
    <div class="bmw-small">
      <input id="bmw-auto-settle" type="checkbox" />
      <span>自動結算</span>
    </div>
    <div class="bmw-small">
      <input id="bmw-profit-only-settle" type="checkbox" />
      <span>Profit only settlement</span>
    </div>
    <label>自動結算收益率 %（槓桿後）</label>
    <input id="bmw-auto-roi" type="number" min="0.001" max="100" step="0.001" />
    <div class="bmw-small">
      <input id="bmw-sl-order" type="checkbox" />
      <span>SL order</span>
    </div>
    <label>SL order %（槓桿後）</label>
    <input id="bmw-sl-roi" type="number" min="0.001" max="100" step="0.001" />
    <div class="bmw-auto-preview" id="bmw-auto-preview">Auto settle off</div>
    <div class="bmw-ws-status" id="bmw-ws-status">WS: --</div>
    <div class="bmw-small">
      <input id="bmw-dry" type="checkbox" />
      <span>Dry run 預覽</span>
    </div>
    <div class="bmw-small">
      <input id="bmw-reduce" type="checkbox" />
      <span>反向時自動 reduce-only</span>
    </div>
    <div class="bmw-small">
      <input id="bmw-replace" type="checkbox" />
      <span>平倉時替換舊 exit 單</span>
    </div>
    <div class="bmw-market">
      <span>Current</span>
      <strong id="bmw-current-price">--</strong>
    </div>
    <div class="bmw-row">
      <button class="bmw-buy" id="bmw-buy">
        <span class="bmw-btn-line"><span id="bmw-buy-label">買入/做多</span><span id="bmw-buy-pnl" class="bmw-pnl"></span></span>
        <span id="bmw-buy-sub" class="bmw-btn-sub"></span>
      </button>
      <button class="bmw-sell" id="bmw-sell">
        <span class="bmw-btn-line"><span id="bmw-sell-label">賣出/做空</span><span id="bmw-sell-pnl" class="bmw-pnl"></span></span>
        <span id="bmw-sell-sub" class="bmw-btn-sub"></span>
      </button>
    </div>
    <div class="bmw-status" id="bmw-status">Loading...</div>
  `;
  document.documentElement.appendChild(panel);

  const $ = (id) => panel.querySelector(id);
  const status = $("#bmw-status");
  const symbol = $("#bmw-symbol");
  const amount = $("#bmw-amount");
  const leverage = $("#bmw-leverage");
  const leverageLimit = $("#bmw-leverage-limit");
  const offset = $("#bmw-offset");
  const exitChase = $("#bmw-exit-chase");
  const autoSettle = $("#bmw-auto-settle");
  const profitOnlySettle = $("#bmw-profit-only-settle");
  const autoRoi = $("#bmw-auto-roi");
  const slOrder = $("#bmw-sl-order");
  const slRoi = $("#bmw-sl-roi");
  const autoPreview = $("#bmw-auto-preview");
  const wsStatus = $("#bmw-ws-status");
  const dry = $("#bmw-dry");
  const reduce = $("#bmw-reduce");
  const replace = $("#bmw-replace");
  const currentPrice = $("#bmw-current-price");
  const buyPnl = $("#bmw-buy-pnl");
  const sellPnl = $("#bmw-sell-pnl");
  const buySub = $("#bmw-buy-sub");
  const sellSub = $("#bmw-sell-sub");

  loadPanelLayout();
  enableDragAndResize();

  sendRuntimeMessage({ type: "GET_CONFIG" }, (res) => {
    if (!res?.ok) return setStatus(res?.error || "Cannot load config");
    amount.value = res.config.quoteAmount || "100";
    leverage.value = res.config.leverage || 20;
    offset.value = res.config.offsetTicks ?? 0;
    exitChase.value = res.config.exitChaseRetries ?? 2;
    autoSettle.checked = Boolean(res.config.autoSettlementEnabled);
    profitOnlySettle.checked = Boolean(res.config.profitOnlySettlementEnabled);
    autoRoi.value = res.config.autoSettlementRoiPct ?? "1";
    slOrder.checked = Boolean(res.config.slOrderEnabled);
    slRoi.value = res.config.slOrderRoiPct ?? "1";
    dry.checked = Boolean(res.config.dryRun);
    reduce.checked = Boolean(res.config.autoReduceOnly);
    replace.checked = Boolean(res.config.replaceReduceOnly);
    const normalized = normalizeSymbolInput(symbol.value || guessSymbol());
    if (normalized) {
      symbol.value = normalized;
      sendRuntimeMessage({ type: "WARMUP_SYMBOL", symbol: normalized });
    }
    setStatus(`Ready. API ${res.config.apiKeyMasked || "未設定"}`);
    refreshSnapshot();
    refreshMarketTicker(true);
    startSnapshotLoop();
    startMarketTickerLoop();
  });

  $("#bmw-close").addEventListener("click", () => {
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (marketTickerTimer) clearInterval(marketTickerTimer);
    if (symbolDetectTimer) clearTimeout(symbolDetectTimer);
    if (symbolObserver) symbolObserver.disconnect();
    symbolAutoDetectActive = false;
    panel.remove();
  });
  $("#bmw-buy").addEventListener("click", () => place("BUY"));
  $("#bmw-sell").addEventListener("click", () => place("SELL"));
  symbol.addEventListener("change", () => {
    symbolManuallyLocked = true;
    setActiveSymbol(symbol.value || guessSymbol(), { refresh: true, force: true });
  });
  installSymbolAutoDetect();

  for (const el of [amount, leverage, offset, exitChase, autoSettle, profitOnlySettle, autoRoi, slOrder, slRoi, dry, reduce, replace]) {
    el.addEventListener("change", saveLocalConfig);
  }

  function saveLocalConfig() {
    if (!isRuntimeReady()) return handleRuntimeError(new Error("Extension context invalidated"));
    sendRuntimeMessage({
      type: "SAVE_CONFIG",
      config: {
        quoteAmount: amount.value,
        leverage: leverage.value,
        offsetTicks: offset.value,
        exitChaseRetries: exitChase.value,
        autoSettlementEnabled: autoSettle.checked,
        profitOnlySettlementEnabled: profitOnlySettle.checked,
        autoSettlementRoiPct: autoRoi.value,
        slOrderEnabled: slOrder.checked,
        slOrderRoiPct: slRoi.value,
        dryRun: dry.checked,
        autoReduceOnly: reduce.checked,
        replaceReduceOnly: replace.checked
      }
    });
  }

  function place(side) {
    if (!isRuntimeReady()) {
      handleRuntimeError(new Error("Extension context invalidated"));
      return;
    }
    const normalizedSymbol = currentSymbolForRequest();
    if (!normalizedSymbol) {
      setStatus("Symbol not detected. Enter a symbol before sending.");
      return;
    }
    symbol.value = normalizedSymbol;
    setStatus(`${side} sending...`);
    sendRuntimeMessage({
      type: "PLACE_MAKER_ORDER",
      side,
      symbol: normalizedSymbol,
      quoteAmount: amount.value,
      leverage: leverage.value,
      offsetTicks: offset.value,
      exitChaseRetries: exitChase.value,
      autoSettlementEnabled: autoSettle.checked,
      autoSettlementRoiPct: autoRoi.value,
      slOrderEnabled: slOrder.checked,
      slOrderRoiPct: slRoi.value,
      profitOnlySettlementEnabled: profitOnlySettle.checked,
      autoReduceOnly: reduce.checked,
      replaceReduceOnly: replace.checked,
      dryRun: dry.checked
    }, (res) => {
      if (!res?.ok) return setStatus(`Error: ${res?.error || "Unknown error"}`);
      const o = res.result.order;
      const amountLine = o.sizingMode === "FULL_POSITION_EXIT"
        ? `exit full position, input ${o.originalAmount} × ${o.leverage}x ignored for close`
        : `amount ${o.originalAmount} × ${o.leverage}x = ${o.quoteAmount}`;
      const lines = [
        `${res.result.dryRun ? "DRY RUN" : "ORDER SENT"}`,
        `${o.symbol} ${o.side} ${o.quantity} @ ${o.price}`,
        amountLine,
        `actualNotional=${o.actualNotional}`,
        `bid ${o.bid} / ask ${o.ask}, offsetTicks=${o.offsetTicks}, makerTicks=${o.makerTicks}`,
        `exitChaseRetries=${o.exitChaseRetries}, exitChaseAttempts=${o.exitChaseAttempts}`,
        `GTX post-only, reduceOnly=${o.reduceOnly}, sizing=${o.sizingMode || "INPUT_NOTIONAL"}`,
        `profitOnlySettlement=${o.profitOnlySettlementEnabled}${o.profitOnlySettlementAdjusted ? `, protectedPrice=${o.profitOnlySettlementAveragePrice}` : ""}`,
        `replaceExit=${o.replaceReduceOnly}, cancelBeforeReplace=${o.cancelBeforeReplaceCount}`,
        `positionAmt=${o.detectedPositionAmt}`
      ];
      if (o.autoSettlement?.enabled) {
        lines.push(`autoSettle ${o.autoSettlement.exitSide} @ ${o.autoSettlement.settlementPrice}, expectedProfit=${o.autoSettlement.expectedProfit}, actualRoi=${o.autoSettlement.actualRoiPct}%`);
      }
      if (o.slOrder?.enabled) {
        lines.push(`SL ${o.slOrder.exitSide} stop ${o.slOrder.triggerPrice} → ${o.slOrder.slPrice}, expectedLoss=${o.slOrder.expectedLoss}`);
      }
      if (o.positionSource) {
        lines.push(`positionSource=${o.positionSource}${Number.isFinite(Number(o.positionAgeMs)) ? ` age=${Math.round(Number(o.positionAgeMs))}ms` : ""}`);
      }
      if (res.result.leverageResponse) {
        lines.push(res.result.leverageResponse.skipped ? `leverage unchanged=${res.result.leverageResponse.leverage}x` : `leverage=${res.result.leverageResponse.leverage}x`);
      }
      if (res.result.cancelResponses?.length) lines.push(`cancelledOldExit=${res.result.cancelResponses.length}`);
      if (res.result.autoSettlementResult) {
        const a = res.result.autoSettlementResult;
        lines.push(a.ok ? `autoSettleStatus=${a.status || "pending"} placedNow=${a.placedNow || "0"}` : `autoSettlePending=${a.pending ? "true" : "false"} error=${a.error || "none"}`);
      }
      if (res.result.response) lines.push(`status=${res.result.response.status || "ACK"}`);
      setStatus(lines.join("\n"));
      refreshSnapshot(true);
    });
  }

  function startSnapshotLoop() {
    if (snapshotTimer) clearInterval(snapshotTimer);
    snapshotTimer = setInterval(() => refreshSnapshot(false), SNAPSHOT_INTERVAL_MS);
  }

  function startMarketTickerLoop() {
    if (marketTickerTimer) clearInterval(marketTickerTimer);
    marketTickerTimer = setInterval(() => refreshMarketTicker(false), MARKET_TICKER_INTERVAL_MS);
  }

  function setActiveSymbol(value, options = {}) {
    const normalized = normalizeSymbolInput(value || guessSymbol());
    if (!normalized) return null;
    const current = normalizeSymbolInput(symbol.value);
    if (!options.force && current === normalized) return normalized;
    symbol.value = normalized;
    sendRuntimeMessage({ type: "WARMUP_SYMBOL", symbol: normalized });
    if (options.refresh) {
      refreshSnapshot(true);
      refreshMarketTicker(true);
    }
    return normalized;
  }

  function applyDetectedSymbol(force = false, options = {}) {
    if (symbolManuallyLocked && !force) return null;
    if (!force && document.activeElement === symbol) return null;
    const detected = guessSymbol();
    if (!detected) return null;
    return setActiveSymbol(detected, { refresh: options.refresh !== false, force });
  }

  function scheduleSymbolAutoDetect() {
    if (!symbolAutoDetectActive || !panel.isConnected) return;
    symbolManuallyLocked = false;
    symbol.value = "";
    currentPrice.textContent = "--";
    resetPositionUi();
    setStatus("Detecting symbol after navigation...");
    clearTimeout(symbolDetectTimer);
    symbolDetectTimer = setTimeout(() => applyDetectedSymbol(false, { refresh: true }), SYMBOL_AUTO_DETECT_DELAY_MS);
  }

  function installSymbolAutoDetect() {
    symbolAutoDetectActive = true;
    window.addEventListener("popstate", scheduleSymbolAutoDetect);
    window.addEventListener("hashchange", scheduleSymbolAutoDetect);
    window.addEventListener("bmw-locationchange", scheduleSymbolAutoDetect);

    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      if (typeof original !== "function" || original.__bmwPatched) continue;
      history[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event("bmw-locationchange"));
        return result;
      };
      history[method].__bmwPatched = true;
    }

  }

  function refreshMarketTicker(force) {
    if (!isRuntimeReady()) {
      handleRuntimeError(new Error("Extension context invalidated"));
      return;
    }
    if (marketTickerInFlight && !force) return;
    const normalizedSymbol = currentSymbolForRequest();
    if (!normalizedSymbol) return;
    marketTickerInFlight = true;
    sendRuntimeMessage({ type: "GET_MARKET_TICKER", symbol: normalizedSymbol }, (res) => {
      marketTickerInFlight = false;
      if (!res?.ok) return;
      if (res.result?.position) updateMarketUi(res.result);
      else updateCurrentPriceUi(res.result);
    });
  }

  function refreshSnapshot(force) {
    if (!isRuntimeReady()) {
      handleRuntimeError(new Error("Extension context invalidated"));
      return;
    }
    if (snapshotInFlight && !force) return;
    const normalizedSymbol = currentSymbolForRequest();
    if (!normalizedSymbol) return;
    snapshotInFlight = true;
    sendRuntimeMessage({ type: "GET_TRADING_SNAPSHOT", symbol: normalizedSymbol }, (res) => {
      snapshotInFlight = false;
      if (!res?.ok) {
        currentPrice.textContent = "--";
        resetPositionUi();
        return;
      }
      updateMarketUi(res.result);
    });
  }

  function updateMarketUi(data) {
    updateCurrentPriceUi(data);

    const p = data?.position || {};
    const positionAmt = Number(p.positionAmt || 0);
    const entry = Number(p.entryPrice || p.breakEvenPrice || 0);
    const pnl = Number(p.unrealizedProfit);
    resetPositionUi();

    if (positionAmt > 0) {
      buySub.textContent = entry > 0 ? `Avg ${formatPrice(entry)}` : "Long";
      setPnlBadge(sellPnl, pnl);
    } else if (positionAmt < 0) {
      sellSub.textContent = entry > 0 ? `Avg ${formatPrice(entry)}` : "Short";
      setPnlBadge(buyPnl, pnl);
    }
    if ("autoSettlementPreview" in (data || {})) {
      updateAutoSettlementPreview(data.autoSettlementPreview);
    }
    if ("userStreamStatus" in (data || {})) {
      updateUserStreamStatus(data.userStreamStatus);
    }
    if ("leverageLimit" in (data || {})) {
      updateLeverageLimit(data.leverageLimit);
    }
  }

  function updateCurrentPriceUi(data) {
    const price = Number(data?.currentPrice);
    if (!Number.isFinite(price) || price <= 0) return;
    currentPrice.textContent = formatPrice(price);
    const age = Number(data?.ageMs ?? data?.priceAgeMs);
    currentPrice.title = data?.source || data?.priceSource
      ? `source=${data.source || data.priceSource}${Number.isFinite(age) ? ` age=${Math.round(age)}ms` : ""}`
      : "";
  }

  function updateAutoSettlementPreview(preview) {
    if (!preview?.enabled) {
      autoPreview.textContent = "Auto settle off";
      return;
    }
    const longPrice = preview.long?.settlementPrice || "--";
    const shortPrice = preview.short?.settlementPrice || "--";
    const profit = preview.expectedProfit || "--";
    const longRoi = preview.long?.actualRoiPct || "--";
    const shortRoi = preview.short?.actualRoiPct || "--";
    autoPreview.textContent = `自動結算 ${preview.roiPct}%｜預期收益 ≈ ${profit}｜Long→Sell ${longPrice} (${longRoi}%)｜Short→Buy ${shortPrice} (${shortRoi}%)`;
  }

  function updateUserStreamStatus(userStream) {
    const mode = userStream?.mode || "rest";
    const statusText = userStream?.status || "idle";
    if (mode === "websocket" && userStream?.connected) {
      wsStatus.textContent = "WS: connected";
      wsStatus.classList.remove("fallback", "dry");
      wsStatus.classList.add("connected");
      return;
    }
    if (mode === "dry-run") {
      wsStatus.textContent = "WS: dry run";
      wsStatus.classList.remove("connected", "fallback");
      wsStatus.classList.add("dry");
      return;
    }
    const reason = userStream?.fallbackReason ? ` (${userStream.fallbackReason})` : "";
    wsStatus.textContent = `WS: ${statusText || "fallback REST"}${reason}`;
    wsStatus.classList.remove("connected", "dry");
    wsStatus.classList.add("fallback");
  }

  function updateLeverageLimit(limit) {
    const maxOriginalQuote = Number(limit?.maxOriginalQuote);
    const limitLeverage = Number(limit?.leverage);
    const quote = getQuoteAsset(symbol.value) || "USDT/USDC";
    if (Number.isFinite(maxOriginalQuote) && maxOriginalQuote > 0) {
      leverageLimit.textContent = `可開本金上限 ${formatMoney(maxOriginalQuote)} ${quote}${Number.isFinite(limitLeverage) && limitLeverage > 0 ? ` @ ${limitLeverage}x` : ""}`;
      leverageLimit.title = "以未乘槓桿的原始本金顯示";
      return;
    }
    leverageLimit.textContent = "可開本金上限 --";
    leverageLimit.title = limit?.error ? "目前無法取得槓桿級距" : "";
  }

  function resetPositionUi() {
    buySub.textContent = "";
    sellSub.textContent = "";
    for (const el of [buyPnl, sellPnl]) {
      el.textContent = "";
      el.classList.remove("positive", "negative");
    }
  }

  function setPnlBadge(el, pnl) {
    if (!Number.isFinite(pnl)) return;
    el.textContent = `${pnl >= 0 ? "+" : ""}${formatMoney(pnl)}`;
    el.classList.toggle("positive", pnl >= 0);
    el.classList.toggle("negative", pnl < 0);
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function enableDragAndResize() {
    const handle = $("#bmw-drag-handle");
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.classList.add("dragging");
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const rect = panel.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      const nextLeft = clamp(startLeft + event.clientX - startX, 0, maxLeft);
      const nextTop = clamp(startTop + event.clientY - startY, 0, maxTop);
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
    });

    handle.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("dragging");
      try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
      savePanelLayoutSoon();
    });

    const observer = new ResizeObserver(() => {
      if (suppressLayoutSave || dragging) return;
      savePanelLayoutSoon();
    });
    observer.observe(panel);

    window.addEventListener("resize", () => clampPanelIntoViewport());
  }

  function loadPanelLayout() {
    suppressLayoutSave = true;
    storageGet([PANEL_LAYOUT_KEY], (res) => {
      const layout = res?.[PANEL_LAYOUT_KEY];
      if (layout && typeof layout === "object") {
        if (Number.isFinite(Number(layout.width))) panel.style.width = `${clamp(Number(layout.width), 240, 520)}px`;
        if (Number.isFinite(Number(layout.height))) panel.style.height = `${clamp(Number(layout.height), 250, 720)}px`;
        if (Number.isFinite(Number(layout.left)) && Number.isFinite(Number(layout.top))) {
          panel.style.left = `${Math.max(0, Number(layout.left))}px`;
          panel.style.top = `${Math.max(0, Number(layout.top))}px`;
          panel.style.right = "auto";
          panel.style.bottom = "auto";
        }
      }
      requestAnimationFrame(() => {
        clampPanelIntoViewport();
        suppressLayoutSave = false;
      });
    });
  }

  function savePanelLayoutSoon() {
    clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(savePanelLayout, 250);
  }

  function savePanelLayout() {
    if (!panel.isConnected || !isRuntimeReady()) return;
    const rect = panel.getBoundingClientRect();
    storageSet({
      [PANEL_LAYOUT_KEY]: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });
  }

  function clampPanelIntoViewport() {
    const rect = panel.getBoundingClientRect();
    const left = clamp(rect.left, 0, Math.max(0, window.innerWidth - rect.width));
    const top = clamp(rect.top, 0, Math.max(0, window.innerHeight - rect.height));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function guessSymbol() {
    const fromBinance = location.pathname.match(/\/futures\/([A-Za-z0-9_]+)/);
    if (fromBinance?.[1]) return normalizeSymbolInput(fromBinance[1]);

    const fromQuery = new URLSearchParams(location.search).get("symbol");
    if (fromQuery) return normalizeSymbolInput(fromQuery);

    const fromHashQuery = location.hash.match(/[?&]symbol=([^&]+)/i);
    if (fromHashQuery?.[1]) return normalizeSymbolInput(decodeURIComponent(fromHashQuery[1]));

    const fromTvSymbolPage = location.pathname.match(/\/symbols\/([A-Za-z0-9_.:-]+)/i);
    if (fromTvSymbolPage?.[1]) return normalizeSymbolInput(fromTvSymbolPage[1]);

    const fromDom = findSymbolCandidateFromDocument();
    if (fromDom) return fromDom;

    const titleCandidates = [document.title, document.querySelector('meta[property="og:title"]')?.content || ""];
    for (const t of titleCandidates) {
      const m = t.match(/(?:BINANCE[:：])?([A-Z0-9]{3,20}(?:USDT|USDC|BUSD)(?:\.P)?)/i);
      if (m?.[1]) return normalizeSymbolInput(m[1]);
    }

    return null;
  }

  function currentSymbolForRequest() {
    const normalized = normalizeSymbolInput(symbol.value);
    if (normalized) return normalized;
    setStatus("Symbol not detected. Enter a symbol or navigate to a supported chart.");
    return null;
  }

  function findSymbolCandidateFromDocument() {
    const selectors = [
      '[data-testid*="symbol"]',
      '[class*="symbol"]',
      '[class*="Symbol"]',
      '[aria-label*="symbol" i]',
      '[title*="USDT"]',
      '[title*="USDC"]'
    ];
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(selector)].slice(0, 30);
      } catch (_) {
        nodes = [];
      }
      for (const node of nodes) {
        const value = node.value || node.textContent || node.getAttribute?.("title") || node.getAttribute?.("aria-label") || "";
        const candidate = findSymbolCandidateFromText(value);
        if (candidate) return candidate;
      }
    }
    return null;
  }

  function findSymbolCandidateFromText(value) {
    const text = String(value || "").toUpperCase();
    const matches = text.match(/[A-Z0-9]+(?:[:：/_.-][A-Z0-9]+)*/g) || [];
    for (const raw of matches) {
      const candidate = coerceSymbolCandidate(raw);
      if (candidate) return candidate;
    }
    return null;
  }

  function coerceSymbolCandidate(value) {
    let s = String(value || "").toUpperCase().trim();
    try { s = decodeURIComponent(s); } catch (_) {}
    s = s.replace(/^.*[:：]/, "");
    s = s.replace(/\.P$/, "");
    s = s.replace(/PERP$/, "");
    s = s.replace(/[^A-Z0-9]/g, "");
    for (const quote of SYMBOL_QUOTES) {
      if (s.endsWith(quote) && s.length > quote.length) return s;
    }
    return null;
  }

  function getQuoteAsset(value) {
    const s = normalizeSymbolInput(value);
    for (const quote of SYMBOL_QUOTES) {
      if (s.endsWith(quote) && s.length > quote.length) return quote;
    }
    return "";
  }

  function normalizeSymbolInput(value) {
    let s = String(value || "").toUpperCase().trim();
    try { s = decodeURIComponent(s); } catch (_) {}
    const candidate = findSymbolCandidateFromText(s);
    if (candidate) return candidate;
    s = s.replace(/^.*[:：]/, "");
    s = s.replace(/\.P$/, "");
    s = s.replace(/PERP$/, "");
    s = s.replace(/[^A-Z0-9_]/g, "");
    return s || "";
  }

  function formatPrice(value) {
    if (!Number.isFinite(value)) return "--";
    if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (Math.abs(value) >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
    return value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
  }

  function formatMoney(value) {
    if (!Number.isFinite(value)) return "--";
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
