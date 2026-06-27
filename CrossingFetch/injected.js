(function () {
  if (window.__crossingFetchInjected) return;
  window.__crossingFetchInjected = true;

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== "function") return;

  function mirrorMessage(data, url) {
    if (typeof data !== "string") return;
    if (!data.includes("~m~") && !data.includes("timescale_update")) return;
    window.postMessage({
      source: "CrossingFetch",
      type: "TRADINGVIEW_SOCKET_MESSAGE",
      url: String(url || ""),
      data
    }, window.location.origin);
  }

  function CrossingFetchWebSocket(url, protocols) {
    const socket = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);

    socket.addEventListener("message", (event) => {
      mirrorMessage(event.data, url);
    });

    return socket;
  }

  CrossingFetchWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(CrossingFetchWebSocket, NativeWebSocket);
  Object.defineProperty(CrossingFetchWebSocket, "name", { value: "WebSocket" });
  window.WebSocket = CrossingFetchWebSocket;
})();
