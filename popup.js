const $ = (id) => document.querySelector(id);
const fields = ["apiKey", "apiSecret", "baseUrl", "quoteAmount", "leverage", "offsetTicks", "exitChaseRetries", "autoSettlementEnabled", "autoSettlementRoiPct", "slOrderEnabled", "slOrderRoiPct", "dryRun", "autoReduceOnly", "replaceReduceOnly"];

function getEl(id) {
  const el = $("#" + id);
  if (!el) throw new Error(`Missing popup element: #${id}`);
  return el;
}

chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (res) => {
  if (!res?.ok) return setStatus(res?.error || "Cannot load config");
  const c = res.config;
  getEl("apiKey").value = c.apiKey || "";
  getEl("apiSecret").value = c.apiSecret || "";
  getEl("baseUrl").value = c.baseUrl || "https://fapi.binance.com";
  getEl("quoteAmount").value = c.quoteAmount || "100";
  getEl("leverage").value = c.leverage || 20;
  getEl("offsetTicks").value = c.offsetTicks ?? 0;
  getEl("exitChaseRetries").value = c.exitChaseRetries ?? 2;
  getEl("autoSettlementEnabled").checked = Boolean(c.autoSettlementEnabled);
  getEl("autoSettlementRoiPct").value = c.autoSettlementRoiPct ?? "1";
  getEl("slOrderEnabled").checked = Boolean(c.slOrderEnabled);
  getEl("slOrderRoiPct").value = c.slOrderRoiPct ?? "1";
  getEl("dryRun").checked = Boolean(c.dryRun);
  getEl("autoReduceOnly").checked = Boolean(c.autoReduceOnly);
  getEl("replaceReduceOnly").checked = Boolean(c.replaceReduceOnly);
  setStatus(`Loaded. API ${c.apiKeyMasked || "未設定"}`);
});


const pasteApiKeyBtn = $("#pasteApiKey");
const pasteApiSecretBtn = $("#pasteApiSecret");
if (pasteApiKeyBtn) pasteApiKeyBtn.addEventListener("click", () => pasteClipboardInto("#apiKey", "API Key"));
if (pasteApiSecretBtn) pasteApiSecretBtn.addEventListener("click", () => pasteClipboardInto("#apiSecret", "API Secret"));

async function pasteClipboardInto(selector, label) {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      setStatus(`Clipboard is empty. ${label} unchanged.`);
      return;
    }
    $(selector).value = text.trim();
    setStatus(`${label} pasted. Remember to save settings.`);
  } catch (err) {
    setStatus(`Paste failed: ${err?.message || err}`);
  }
}

$("#save").addEventListener("click", () => {
  const config = {};
  for (const f of fields) {
    const el = getEl(f);
    config[f] = el.type === "checkbox" ? el.checked : el.value;
  }
  chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config }, (res) => {
    if (!res?.ok) return setStatus(res?.error || "Save failed");
    setStatus("Saved");
  });
});

function setStatus(text) {
  $("#status").textContent = text;
}
