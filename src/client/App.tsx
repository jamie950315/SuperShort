import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time
} from "lightweight-charts";
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  History,
  LogOut,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Wifi
} from "lucide-react";
import { CHART_RIGHT_SCALE_WIDTH, displayVolumeValue, orderOverlayItems, type OrderOverlayItem } from "./chartDisplay";
import { sortStrategyQueryRows, type StrategyQuerySort, type StrategyQuerySortKey } from "../shared/strategyQueryTable";
import { strategyDiffTitle, strategyDiffTooltip } from "../shared/strategyDiff";
import type {
  Candle,
  DashboardPayload,
  FlashPointState,
  IntervalName,
  PaperOrder,
  PaperTrade,
  SlLadderLevel,
  StrategyConfig,
  StrategyQueryFilter,
  StrategyQueryResultFilter,
  StrategyQueryResult,
  StrategyQueryRow
} from "../shared/types";

type Page = "chart" | "history" | "portfolio" | "strategyQuery" | "settings" | "status";

const intervals: IntervalName[] = ["1s", "5s", "15s", "30s", "1m"];

const queryColumns: { key: StrategyQuerySortKey; label: string; digits?: number; percent?: boolean; seconds?: boolean; signed?: boolean }[] = [
  { key: "type", label: "類型" },
  { key: "interval", label: "Window" },
  { key: "persistMs", label: "Persist", digits: 0 },
  { key: "longBelow", label: "Long C1 <", digits: 2 },
  { key: "shortAbove", label: "Short C1 >", digits: 2 },
  { key: "tp", label: "TP", digits: 2 },
  { key: "sl", label: "SL", digits: 2 },
  { key: "mode", label: "模式" },
  { key: "entries", label: "Entries", digits: 0 },
  { key: "wins", label: "Wins", digits: 2 },
  { key: "losses", label: "Losses", digits: 2 },
  { key: "winRate", label: "勝率", percent: true },
  { key: "within30s", label: "30s 內", percent: true },
  { key: "p90HoldSeconds", label: "P90 Hold", digits: 2, seconds: true },
  { key: "p99HoldSeconds", label: "P99 Hold", digits: 2, seconds: true },
  { key: "maxHoldSeconds", label: "Max Hold", digits: 2, seconds: true },
  { key: "totalUsdcPnl", label: "Total PnL", digits: 2, signed: true },
  { key: "expectancyPrice", label: "Expectancy", digits: 4, signed: true },
  { key: "meanUsdPerTrade", label: "Mean / Trade", digits: 4, signed: true },
  { key: "stdUsdPerTrade", label: "Std / Trade", digits: 4 },
  { key: "tradeSharpe", label: "Trade Sharpe", digits: 4, signed: true },
  { key: "cumulativeTradeSharpe", label: "Cumulative Sharpe", digits: 4, signed: true },
  { key: "finalEquity", label: "Final Equity", digits: 2, signed: true },
  { key: "maxDrawdownPct", label: "Max DD", percent: true }
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as T;
}

function fmt(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "尚無資料";
  return value.toLocaleString("zh-TW", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "尚無資料";
  return `${(value * 100).toFixed(2)}%`;
}

function formatSlLadderInput(levels: SlLadderLevel[] | undefined): string {
  return (levels ?? [])
    .map((level) => `${level.triggerOffset}/${level.limitOffset}/${Math.round(level.quantityPct * 100)}`)
    .join(", ");
}

function parseSlLadderInput(value: string): SlLadderLevel[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [triggerOffset, limitOffset, quantityPct] = part.split("/").map((item) => Number(item.trim()));
      return { triggerOffset, limitOffset, quantityPct: quantityPct / 100 };
    })
    .filter((level) => (
      Number.isFinite(level.triggerOffset)
      && Number.isFinite(level.limitOffset)
      && Number.isFinite(level.quantityPct)
      && level.triggerOffset > 0
      && level.limitOffset >= level.triggerOffset
      && level.quantityPct > 0
    ));
}

function chartTime(ms: number): Time {
  return Math.floor(ms / 1000) as Time;
}

function ema(current: number, previous: number | null | undefined, length: number): number {
  if (previous === null || previous === undefined) return current;
  const alpha = 2 / (length + 1);
  return alpha * current + (1 - alpha) * previous;
}

interface FlashPointPoint extends FlashPointState {
  time: Time;
  openTime: number;
}

function flashPointSeries(candles: Candle[]): FlashPointPoint[] {
  const points: FlashPointPoint[] = [];
  let previous: FlashPointState | null = null;
  for (let index = 0; index < candles.length; index += 1) {
    const current = candles[index];
    const window = candles.slice(Math.max(0, index - 4), index + 1);
    const highWindow = window.slice(-4);
    const periodHighest = Math.max(...highWindow.map((bar) => bar.high));
    const periodLowest = Math.min(...window.slice(-5).map((bar) => bar.low));
    const typicalPrice = (2 * current.close + current.high + current.low) / 4;
    const range = periodHighest - periodLowest;
    const rsv = Math.abs(range) < 1e-12 ? 0 : ((typicalPrice - periodLowest) / range) * 100;
    const c1 = ema(rsv, previous?.c1, 4);
    const slowDBase: number = 0.667 * (previous?.c1 ?? 0) + 0.333 * c1;
    const c2 = ema(slowDBase, previous?.c2, 2);
    let crossing: FlashPointState["crossing"] = null;
    if (previous) {
      const previousDiff = previous.c1 - previous.c2;
      const currentDiff = c1 - c2;
      if (previousDiff <= 0 && currentDiff > 0) crossing = "up";
      if (previousDiff >= 0 && currentDiff < 0) crossing = "down";
    }
    const point: FlashPointPoint = { rsv, c1, c2, slowDBase, crossing, time: chartTime(current.openTime), openTime: current.openTime };
    points.push(point);
    previous = point;
  }
  return points;
}

function overlayText(item: OrderOverlayItem): string {
  if (item.kind === "entry") return `${item.direction === "long" ? "開多" : "開空"} ${fmt(item.quantity, 3)} @ ${fmt(item.price, 1)}`;
  return `${item.kind === "tp" ? "TP" : "SL"} ${fmt(item.quantity, 3)} @ ${fmt(item.price, 1)}`;
}

interface HistoryRow {
  id: string;
  direction: PaperTrade["direction"];
  status: PaperTrade["status"];
  eventType?: PaperTrade["eventType"];
  title?: string;
  details?: string;
  entryTime: number;
  exitTime: number | null;
  holdMs: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number;
  pnlUsdc: number;
  reason: PaperTrade["reason"];
  rowType: "trade" | "ongoing";
}

function historyDirectionLabel(row: HistoryRow): string {
  if (row.eventType === "portfolio_reset") return "重設";
  return row.direction === "long" ? "多" : "空";
}

function historyStatusLabel(row: HistoryRow): string {
  if (row.eventType === "portfolio_reset") return "完成";
  if (row.rowType === "ongoing") return "持倉中";
  return row.status;
}

function timeLabel(time: number | null | undefined): string {
  if (time === null || time === undefined || Number.isNaN(time)) return "尚無";
  return new Date(time).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function holdLabel(holdMs: number | null | undefined): string {
  if (!holdMs) return "尚無";
  return `${(holdMs / 1000).toFixed(2)}s`;
}

function isOngoingPosition(order: PaperOrder): boolean {
  return ["partial", "filled", "open"].includes(order.status)
    && order.entryFillPrice !== null
    && order.filledAt !== null
    && order.settledAt === null;
}

function historyRows(payload: DashboardPayload): HistoryRow[] {
  const tradeRows: HistoryRow[] = payload.trades.map((trade) => ({ ...trade, rowType: "trade" }));
  const ongoingRows: HistoryRow[] = payload.paperOrders
    .filter(isOngoingPosition)
    .map((order) => {
      const entryTime = order.filledAt ?? order.createdAt;
      return {
        id: `ongoing-${order.id}`,
        direction: order.direction,
        status: order.status,
        entryTime,
        exitTime: null,
        holdMs: Math.max(0, payload.health.now - entryTime),
        entryPrice: order.entryFillPrice,
        exitPrice: null,
        quantity: order.filledQuantity || order.quantity,
        pnlUsdc: order.pnlUsdc,
        reason: order.reason,
        rowType: "ongoing"
      };
    });

  return [...ongoingRows, ...tradeRows].sort((left, right) => right.entryTime - left.entryTime);
}

function queryRowTypeLabel(type: StrategyQueryRow["type"]): string {
  if (type === "average") return "平均";
  if (type === "median") return "中位數";
  return "策略資料";
}

function displayCell(value: string | number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return fmt(value, digits);
  return value;
}

function signedClass(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value >= 0 ? "green" : "red";
}

function queryCell(row: StrategyQueryRow, column: typeof queryColumns[number]): { text: string; className: string } {
  if (column.key === "type") return { text: queryRowTypeLabel(row.type), className: "" };
  if (column.key === "mode") {
    return { text: row.mode === "single" ? "同時一筆" : row.mode === "independent" ? "允許多筆" : "—", className: "" };
  }
  const value = row[column.key];
  const numericValue = typeof value === "number" ? value : null;
  const text = column.percent
    ? pct(numericValue)
    : `${displayCell(value as string | number | null, column.digits ?? 2)}${column.seconds ? "s" : ""}`;
  const signedValue = column.key === "finalEquity" && numericValue !== null ? numericValue - 500 : numericValue;
  return { text, className: column.signed ? signedClass(signedValue) : "" };
}

function renderOrderOverlay(
  overlay: HTMLDivElement,
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  items: OrderOverlayItem[]
): void {
  overlay.replaceChildren();
  const chartRect = overlay.getBoundingClientRect();
  const width = chartRect.width;
  const height = chartRect.height;
  for (const item of items) {
    const x = chart.timeScale().timeToCoordinate(item.time as Time);
    const y = series.priceToCoordinate(item.price);
    if (x === null || y === null) continue;
    if (x < -40 || x > width + 40 || y < -40 || y > height + 40) continue;

    const label = document.createElement("div");
    label.className = `order-overlay-label ${item.direction} ${item.kind}`;
    label.textContent = overlayText(item);
    label.style.left = `${Math.min(Math.max(x, 6), width - 6)}px`;
    label.style.top = `${Math.min(Math.max(y, 18), height - 24)}px`;
    overlay.appendChild(label);
  }
}

function numericTime(time: Time | undefined): number | null {
  return typeof time === "number" ? time : null;
}

function ChartPanel({ payload, interval, onInterval }: { payload: DashboardPayload; interval: IntervalName; onInterval: (value: IntervalName) => void }) {
  const priceRef = useRef<HTMLDivElement | null>(null);
  const fpRef = useRef<HTMLDivElement | null>(null);
  const priceChartRef = useRef<IChartApi | null>(null);
  const fpChartRef = useRef<IChartApi | null>(null);
  const visibleRangeRef = useRef<LogicalRange | null>(null);
  const lastIntervalRef = useRef<IntervalName>(interval);
  const latest = payload.candles.at(-1);
  const previous = payload.candles.at(-2);
  const delta = latest && previous ? latest.close - previous.close : 0;
  const deltaPct = previous ? delta / previous.close : 0;
    const flash = useMemo(() => flashPointSeries(payload.candles), [payload.candles]);
  const latestFlash = flash.at(-1);

  useEffect(() => {
    if (!priceRef.current || !fpRef.current) return;
    const restoreRange = lastIntervalRef.current === interval ? visibleRangeRef.current : null;
    lastIntervalRef.current = interval;
    priceRef.current.innerHTML = "";
    fpRef.current.innerHTML = "";

    const sharedLayout = {
      layout: {
        background: { color: "#0b0c0e" },
        textColor: "#9aa0a8",
        fontFamily: "Noto Sans TC, PingFang TC, Microsoft JhengHei, sans-serif",
        fontSize: 12
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.045)" },
        horzLines: { color: "rgba(255,255,255,0.055)" }
      },
      rightPriceScale: {
        borderColor: "#344044",
        minimumWidth: CHART_RIGHT_SCALE_WIDTH,
        scaleMargins: { top: 0.08, bottom: 0.12 }
      },
      timeScale: {
        borderColor: "#344044",
        timeVisible: true,
        secondsVisible: interval === "1s" || interval === "5s" || interval === "15s",
        rightOffset: 8,
        barSpacing: 8,
        fixLeftEdge: false,
        fixRightEdge: false
      },
      crosshair: {
        vertLine: { color: "rgba(255,255,255,0.38)", labelBackgroundColor: "#1f2933", width: 1 },
        horzLine: { color: "rgba(255,255,255,0.28)", labelBackgroundColor: "#1f2933" }
      }
    } as const;

    const compactMarkers = priceRef.current.clientWidth < 720;
    const markerLimit = compactMarkers ? 80 : null;
    const priceHeight = Math.max(320, priceRef.current.clientHeight || Math.round(window.innerHeight * 0.58));
    const fpHeight = Math.max(220, fpRef.current.clientHeight || Math.round(window.innerHeight * 0.32));
    const maxVolume = Math.max(0, ...payload.candles.map((bar) => bar.volume));
    const overlay = document.createElement("div");
    overlay.className = "order-overlay";
    overlay.style.right = `${CHART_RIGHT_SCALE_WIDTH}px`;
    priceRef.current.appendChild(overlay);

    const priceChart = createChart(priceRef.current, {
      ...sharedLayout,
      height: priceHeight,
      handleScroll: true,
      handleScale: true
    });
    priceChartRef.current = priceChart;
    const candleSeries = priceChart.addSeries(CandlestickSeries, {
      upColor: "#00b894",
      downColor: "#ff3b4f",
      borderVisible: false,
      wickUpColor: "#008f76",
      wickDownColor: "#b82e3c",
      priceLineColor: "#ff4261",
      priceLineWidth: 1,
      lastValueVisible: true
    });
    candleSeries.setData(payload.candles.map((bar) => ({
      time: Math.floor(bar.openTime / 1000) as never,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close
    })));

    const volumeSeries = priceChart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      color: "#184f4d",
      lastValueVisible: false,
      priceLineVisible: false
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.74, bottom: 0 } });
    volumeSeries.setData(payload.candles.map((bar) => ({
      time: chartTime(bar.openTime),
      value: displayVolumeValue(bar.volume, maxVolume),
      color: bar.close >= bar.open ? "rgba(0,184,148,0.48)" : "rgba(255,59,79,0.48)"
    })));

    const overlayItems = orderOverlayItems(
      payload.paperOrders,
      payload.candles,
      markerLimit
    );
    const candleCloseByTime = new Map(payload.candles.map((bar) => [chartTime(bar.openTime) as number, bar.close]));
    const flashC1ByTime = new Map(flash.map((point) => [point.time as number, point.c1]));

    const fpChart = createChart(fpRef.current, {
      ...sharedLayout,
      height: fpHeight,
      rightPriceScale: {
        borderColor: "#344044",
        minimumWidth: CHART_RIGHT_SCALE_WIDTH,
        scaleMargins: { top: 0.08, bottom: 0.12 },
        autoScale: false,
        mode: 0
      }
    });
    fpChartRef.current = fpChart;
    const c1 = fpChart.addSeries(LineSeries, {
      color: "#ff00ff",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "C1快線"
    });
    const c2 = fpChart.addSeries(LineSeries, {
      color: "#ffffff",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "C2慢線"
    });
    c1.setData(flash.map((point) => ({ time: point.time, value: point.c1 })));
    c2.setData(flash.map((point) => ({ time: point.time, value: point.c2 })));
    createSeriesMarkers(c1, flash
      .filter((point) => point.crossing === "up")
      .map((point) => ({
        time: point.time,
        position: "atPriceMiddle",
        price: point.c1,
        color: "#ff5757",
        shape: "arrowUp",
        text: point.c1 < payload.config.longBelow ? "買" : "加倉"
      })), { zOrder: "top" });
    createSeriesMarkers(c2, flash
      .filter((point) => point.crossing === "down")
      .map((point) => ({
        time: point.time,
        position: "atPriceMiddle",
        price: point.c2,
        color: "#22c55e",
        shape: "arrowDown",
        text: point.c1 > payload.config.shortAbove ? "賣" : "賣"
      })), { zOrder: "top" });

    let syncing = false;
    const syncRange = (source: IChartApi, target: IChartApi) => (range: LogicalRange | null) => {
      if (!range || syncing) return;
      visibleRangeRef.current = range;
      syncing = true;
      target.timeScale().setVisibleLogicalRange(range);
      syncing = false;
      renderOrderOverlay(overlay, priceChart, candleSeries, overlayItems);
    };
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(priceChart, fpChart));
    fpChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(fpChart, priceChart));
    let syncingCrosshair = false;
    const syncCrosshairTo = (
      targetChart: IChartApi,
      targetSeries: ISeriesApi<"Candlestick"> | ISeriesApi<"Line">,
      priceByTime: Map<number, number>
    ) => (param: MouseEventParams<Time>) => {
      if (syncingCrosshair) return;
      const time = numericTime(param.time);
      if (time === null || !param.point) {
        targetChart.clearCrosshairPosition();
        return;
      }
      const price = priceByTime.get(time);
      if (price === undefined) {
        targetChart.clearCrosshairPosition();
        return;
      }
      syncingCrosshair = true;
      targetChart.setCrosshairPosition(price, time as Time, targetSeries);
      syncingCrosshair = false;
    };
    priceChart.subscribeCrosshairMove(syncCrosshairTo(fpChart, c1, flashC1ByTime));
    fpChart.subscribeCrosshairMove(syncCrosshairTo(priceChart, candleSeries, candleCloseByTime));
    if (restoreRange) {
      priceChart.timeScale().setVisibleLogicalRange(restoreRange);
      fpChart.timeScale().setVisibleLogicalRange(restoreRange);
    } else {
      priceChart.timeScale().fitContent();
      fpChart.timeScale().fitContent();
    }
    renderOrderOverlay(overlay, priceChart, candleSeries, overlayItems);

    const resize = () => {
      priceChart.applyOptions({
        width: priceRef.current?.clientWidth ?? 900,
        height: Math.max(320, priceRef.current?.clientHeight ?? priceHeight)
      });
      fpChart.applyOptions({
        width: fpRef.current?.clientWidth ?? 900,
        height: Math.max(220, fpRef.current?.clientHeight ?? fpHeight)
      });
      renderOrderOverlay(overlay, priceChart, candleSeries, overlayItems);
    };
    resize();
    window.addEventListener("resize", resize);
    return () => {
      visibleRangeRef.current = priceChart.timeScale().getVisibleLogicalRange() ?? visibleRangeRef.current;
      window.removeEventListener("resize", resize);
      priceChart.remove();
      fpChart.remove();
    };
  }, [payload.candles, payload.signals, payload.paperOrders, payload.trades, payload.config.longBelow, payload.config.shortAbove, interval, flash]);

  return (
    <section className="trading-page">
      <div className="trading-toolbar">
        <div className="symbol-strip">
          <span className="coin-dot">₿</span>
          <strong>{payload.config.symbol}.P</strong>
          <span>· {interval} · Binance</span>
          <span className="live-dot" />
          {latest && (
            <span className={delta >= 0 ? "ohlc up" : "ohlc down"}>
              開={fmt(latest.open, 1)} 高={fmt(latest.high, 1)} 低={fmt(latest.low, 1)} 收={fmt(latest.close, 1)}
              {" "}{delta >= 0 ? "+" : ""}{fmt(delta, 1)} ({deltaPct >= 0 ? "+" : ""}{pct(deltaPct)})
            </span>
          )}
        </div>
        <div className="chart-actions">
          <div className="segmented compact">
            {intervals.map((item) => (
              <button key={item} className={item === interval ? "active" : ""} onClick={() => onInterval(item)}>{item}</button>
            ))}
          </div>
          <span className="currency-pill">USDC</span>
        </div>
      </div>
      <div className="chart-stage">
        <div ref={priceRef} className="price-chart" />
        <div className="chart-divider" />
        <div className="indicator-wrap">
          <div className="fp-legend">
            <span className="c1">C1 {fmt(latestFlash?.c1, 2)}</span>
            <span className="c2">C2 {fmt(latestFlash?.c2, 2)}</span>
          </div>
          <div ref={fpRef} className="fp-chart" />
        </div>
      </div>
    </section>
  );
}

function HistoryPage({ payload }: { payload: DashboardPayload }) {
  const rows = historyRows(payload);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>交易紀錄</h2>
          <p>最多顯示最近 1000 筆 paper trade，包含 GTX 模擬原因</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>方向</th>
              <th>狀態</th>
              <th>進場時間</th>
              <th>出場時間</th>
              <th>進場</th>
              <th>出場</th>
              <th>持倉</th>
              <th>數量</th>
              <th>PnL</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.eventType === "portfolio_reset" ? "reset-row" : ""}>
                <td className={row.eventType === "portfolio_reset" ? "muted" : row.direction === "long" ? "green" : "red"}>{historyDirectionLabel(row)}</td>
                <td>{historyStatusLabel(row)}</td>
                <td>{timeLabel(row.entryTime)}</td>
                <td>{timeLabel(row.exitTime)}</td>
                <td>{fmt(row.entryPrice, 1)}</td>
                <td>{fmt(row.exitPrice, 1)}</td>
                <td>{holdLabel(row.holdMs)}</td>
                <td>{fmt(row.quantity, 6)}</td>
                <td className={row.pnlUsdc >= 0 ? "green" : "red"}>{fmt(row.pnlUsdc, 4)}</td>
                <td title={row.details}>{row.title ?? row.reason ?? "尚無"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ClearPortfolioButton({ onReset }: { onReset: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="danger" disabled={busy} onClick={async () => {
      if (!window.confirm("確定要清空 paper portfolio？所有未結束 paper deals 會強制結清，資金會回到 500 USDC。")) return;
      setBusy(true);
      try {
        await onReset();
      } finally {
        setBusy(false);
      }
    }}>
      <Trash2 size={16} />{busy ? "清空中..." : "清空 Portfolio"}
    </button>
  );
}

function PortfolioPage({ payload, onReset }: { payload: DashboardPayload; onReset: () => Promise<void> }) {
  const p = payload.portfolio;
  return (
    <div className="grid two">
      <section className="panel">
        <h2>Real Binance Account</h2>
        <p className="muted">只讀顯示，不會下單、不會取消訂單。</p>
        <div className="metrics">
          <Metric label="Wallet Balance" value={`${fmt(p?.realWalletBalance)} USDC`} />
          <Metric label="Available Balance" value={`${fmt(p?.realAvailableBalance)} USDC`} />
          <Metric label="Unrealized PnL" value={`${fmt(p?.realUnrealizedPnl)} USDC`} />
        </div>
      </section>
      <section className="panel paper">
        <div className="panel-head">
          <div>
            <h2>Paper Strategy</h2>
            <p className="muted">使用真實偏保守 GTX maker 模型。</p>
          </div>
          <ClearPortfolioButton onReset={onReset} />
        </div>
        <div className="metrics">
          <Metric label="Paper Equity" value={`${fmt(p?.paperEquity)} USDC`} />
          <Metric label="Realized PnL" value={`${fmt(p?.paperRealizedPnl)} USDC`} />
          <Metric label="Open Positions" value={String(p?.openPaperPositions ?? 0)} />
        </div>
      </section>
    </div>
  );
}

function StrategyQueryPage({ payload }: { payload: DashboardPayload }) {
  const [queryMode, setQueryMode] = useState<"limit" | "result">("limit");
  const [form, setForm] = useState<Record<keyof StrategyQueryFilter | "limit", string>>({
    interval: payload.config.interval,
    persistMs: String(payload.config.persistMs),
    longBelow: String(payload.config.longBelow),
    shortAbove: String(payload.config.shortAbove),
    tp: String(payload.config.tp),
    sl: payload.config.slEnabled ? String(payload.config.sl) : "",
    mode: payload.config.mode,
    limit: "100"
  });
  const [resultForm, setResultForm] = useState<Record<keyof StrategyQueryResultFilter, string>>({
    finalEquityMin: "",
    winRateMin: "",
    maxDrawdownPctMax: "",
    tradeSharpeMin: "",
    entriesMin: ""
  });
  const [result, setResult] = useState<StrategyQueryResult | null>(null);
  const [sort, setSort] = useState<StrategyQuerySort | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const update = (key: keyof typeof form, value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const updateResult = (key: keyof typeof resultForm, value: string) => setResultForm((prev) => ({ ...prev, [key]: value }));
  const optionValues = (key: keyof Pick<StrategyQueryResult["options"], "persistMs" | "longBelow" | "shortAbove" | "tp" | "sl">) => result?.options[key] ?? [];
  const sortedRows = useMemo(() => sortStrategyQueryRows(result?.rows ?? [], sort), [result?.rows, sort]);
  const changeSort = (key: StrategyQuerySortKey) => setSort((current) => {
    if (current?.key !== key) return { key, direction: "desc" };
    return { key, direction: current.direction === "desc" ? "asc" : "desc" };
  });

  const search = async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("limit", form.limit);
      if (queryMode === "limit") {
        for (const [key, value] of Object.entries(form)) {
          if (key !== "limit" && value.trim()) params.set(key, value.trim());
        }
      } else {
        for (const [key, value] of Object.entries(resultForm)) {
          if (value.trim()) params.set(key, value.trim());
        }
      }
      const data = await api<StrategyQueryResult>(`/api/strategy-query?${params.toString()}`);
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void search();
  }, []);

  const approximateFields = result
    ? Object.entries(result.matchedValues)
      .filter(([, match]) => match && !match.exact)
      .map(([field, match]) => `${field}: ${match?.requested} → ${match?.values.join(" / ")}`)
    : [];

  return (
    <section className="panel strategy-query">
      <div className="panel-head">
        <div>
          <h2>策略查詢</h2>
          <p>查詢 CSV 回測排名資料；找不到精準數值時顯示最接近的上下策略與彙總列。</p>
        </div>
        <button className="primary" onClick={search} disabled={loading}>
          <Search size={16} />{loading ? "查詢中..." : "查詢"}
        </button>
      </div>
      <div className="query-tabs" role="tablist" aria-label="策略查詢模式">
        <button type="button" role="tab" aria-selected={queryMode === "limit"} className={queryMode === "limit" ? "active" : ""} onClick={() => setQueryMode("limit")}>用條件查</button>
        <button type="button" role="tab" aria-selected={queryMode === "result"} className={queryMode === "result" ? "active" : ""} onClick={() => setQueryMode("result")}>用結果查</button>
      </div>
      <div className="query-form">
        {queryMode === "limit" ? (
          <>
            <label>Time Window<select value={form.interval} onChange={(event) => update("interval", event.target.value)}>
              <option value="">全部</option>
              {(result?.options.intervals ?? intervals).map((item) => <option key={item}>{item}</option>)}
            </select></label>
            <label>Persist ms<input list="strategy-persist-options" type="number" value={form.persistMs} onChange={(event) => update("persistMs", event.target.value)} /></label>
            <label>Long C1 &lt;<input list="strategy-long-options" type="number" value={form.longBelow} onChange={(event) => update("longBelow", event.target.value)} /></label>
            <label>Short C1 &gt;<input list="strategy-short-options" type="number" value={form.shortAbove} onChange={(event) => update("shortAbove", event.target.value)} /></label>
            <label>TP<input list="strategy-tp-options" type="number" step="0.1" value={form.tp} onChange={(event) => update("tp", event.target.value)} /></label>
            <label>SL<input list="strategy-sl-options" type="number" step="0.1" value={form.sl} onChange={(event) => update("sl", event.target.value)} /></label>
            <label>模式<select value={form.mode} onChange={(event) => update("mode", event.target.value)}>
              <option value="">全部</option>
              {(result?.options.modes ?? ["single", "independent"]).map((item) => <option key={item} value={item}>{item === "single" ? "同時一筆" : "允許多筆"}</option>)}
            </select></label>
          </>
        ) : (
          <>
            <label>Final Equity ≥<input type="number" value={resultForm.finalEquityMin} onChange={(event) => updateResult("finalEquityMin", event.target.value)} placeholder="例：10000" /></label>
            <label>勝率 ≥ %<input type="number" step="0.01" value={resultForm.winRateMin} onChange={(event) => updateResult("winRateMin", event.target.value)} placeholder="例：65" /></label>
            <label>Max DD ≤ %<input type="number" step="0.01" value={resultForm.maxDrawdownPctMax} onChange={(event) => updateResult("maxDrawdownPctMax", event.target.value)} placeholder="例：20" /></label>
            <label>Trade Sharpe ≥<input type="number" step="0.01" value={resultForm.tradeSharpeMin} onChange={(event) => updateResult("tradeSharpeMin", event.target.value)} placeholder="例：0.5" /></label>
            <label>Entries ≥<input type="number" value={resultForm.entriesMin} onChange={(event) => updateResult("entriesMin", event.target.value)} placeholder="例：100" /></label>
          </>
        )}
        <label>筆數上限<input type="number" min="1" max="1000" value={form.limit} onChange={(event) => update("limit", event.target.value)} /></label>
        <datalist id="strategy-persist-options">{optionValues("persistMs").map((item) => <option key={item} value={item} />)}</datalist>
        <datalist id="strategy-long-options">{optionValues("longBelow").map((item) => <option key={item} value={item} />)}</datalist>
        <datalist id="strategy-short-options">{optionValues("shortAbove").map((item) => <option key={item} value={item} />)}</datalist>
        <datalist id="strategy-tp-options">{optionValues("tp").map((item) => <option key={item} value={item} />)}</datalist>
        <datalist id="strategy-sl-options">{optionValues("sl").map((item) => <option key={item} value={item} />)}</datalist>
      </div>
      {error && <p className="error">{error}</p>}
      {result?.approximate && (
        <p className="notice">沒有完全相同的數值，已使用最接近組合：{approximateFields.join("、")}</p>
      )}
      {result && (
        <>
          <p className="source-note">資料列數：{result.source.rowCount.toLocaleString("zh-TW")} · 顯示：{result.rows.length.toLocaleString("zh-TW")} · {result.source.path}</p>
          <div className="table-wrap query-table">
            <table>
              <thead>
                <tr>
                  {queryColumns.map((column) => (
                    <th key={column.key}>
                      <button className="sort-header" type="button" onClick={() => changeSort(column.key)}>
                        {column.label}{sort?.key === column.key ? (sort.direction === "desc" ? " ↓" : " ↑") : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, index) => (
                  <tr key={`${row.type}-${index}`} className={row.type !== "match" ? "summary-row" : ""}>
                    {queryColumns.map((column) => {
                      const cell = queryCell(row, column);
                      return <td key={column.key} className={cell.className}>{cell.text}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function SettingsPage({
  payload,
  onSaved,
  onReset,
  onOpenStrategyQuery
}: {
  payload: DashboardPayload;
  onSaved: (config: StrategyConfig) => void;
  onReset: () => Promise<void>;
  onOpenStrategyQuery: () => void;
}) {
  const [form, setForm] = useState(payload.config);
  const [slLadderText, setSlLadderText] = useState(formatSlLadderInput(payload.config.slLadder));
  const [message, setMessage] = useState("");
  useEffect(() => {
    setForm(payload.config);
    setSlLadderText(formatSlLadderInput(payload.config.slLadder));
  }, [payload.config.version]);
  const update = (key: keyof StrategyConfig, value: string | number | boolean) => setForm((prev) => ({ ...prev, [key]: value } as StrategyConfig));
  const save = async () => {
    const slLadder = parseSlLadderInput(slLadderText);
    if (form.slEnabled && slLadder.length === 0) {
      setMessage("SL Ladder 格式錯誤，請使用 1/1.5/50, 3/3.5/30 這種格式。");
      return;
    }
    const saved = await api<StrategyConfig>("/api/config", { method: "POST", body: JSON.stringify({ ...form, slLadder: slLadder.length ? slLadder : form.slLadder }) });
    onSaved(saved);
    setMessage(`已儲存 version ${saved.version}`);
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>策略設定</h2>
          <p title={strategyDiffTooltip(payload.previousConfig, payload.config)}>v{payload.config.version} · {strategyDiffTitle(payload.previousConfig, payload.config)}</p>
        </div>
        <div className="action-row">
          <button className="primary" type="button" onClick={onOpenStrategyQuery}>
            <Search size={16} />查詢策略結果
          </button>
          <ClearPortfolioButton onReset={onReset} />
          <button className="primary" onClick={save}>儲存設定</button>
        </div>
      </div>
      {message && <p className="notice">{message}</p>}
      <div className="form-grid">
        <label>啟用<select value={String(form.enabled)} onChange={(event) => update("enabled", event.target.value === "true")}><option value="true">啟用</option><option value="false">停用</option></select></label>
        <label>Time Window<select value={form.interval} onChange={(event) => update("interval", event.target.value)}>{intervals.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Persist ms<input type="number" value={form.persistMs} onChange={(event) => update("persistMs", Number(event.target.value))} /></label>
        <label>Long C1 &lt;<input type="number" value={form.longBelow} onChange={(event) => update("longBelow", Number(event.target.value))} /></label>
        <label>Short C1 &gt;<input type="number" value={form.shortAbove} onChange={(event) => update("shortAbove", Number(event.target.value))} /></label>
        <label>TP<input type="number" step="0.1" value={form.tp} onChange={(event) => update("tp", Number(event.target.value))} /></label>
        <label>GTX TTL ms<input type="number" min="0" value={form.entryTtlMs} onChange={(event) => update("entryTtlMs", Number(event.target.value))} /></label>
        <div className="toggle-control">
          <span>SL 系統</span>
          <button
            type="button"
            className={`switch ${form.slEnabled ? "on" : ""}`}
            aria-pressed={form.slEnabled}
            onClick={() => update("slEnabled", !form.slEnabled)}
          >
            <span className="switch-track"><span className="switch-thumb" /></span>
            <strong>{form.slEnabled ? "啟用" : "停用"}</strong>
          </button>
        </div>
        {form.slEnabled && (
          <>
            <label>Maker SL retry ms<input type="number" min="0" value={form.makerSlRetryMs} onChange={(event) => update("makerSlRetryMs", Number(event.target.value))} /></label>
            <label>Emergency SL<input type="number" step="0.1" min="0" value={form.emergencySl} onChange={(event) => update("emergencySl", Number(event.target.value))} /></label>
            <label className="wide">SL Ladder trigger/limit/%<textarea value={slLadderText} onChange={(event) => setSlLadderText(event.target.value)} /></label>
          </>
        )}
        <label>Velocity Window ms<input type="number" min="0" value={form.priceVelocityWindowMs} onChange={(event) => update("priceVelocityWindowMs", Number(event.target.value))} /></label>
        <label>Max Velocity USDC/s<input type="number" step="0.1" min="0" value={form.maxPriceVelocityUsdPerSec} onChange={(event) => update("maxPriceVelocityUsdPerSec", Number(event.target.value))} /></label>
        <label>本金 USDC<input type="number" value={form.capital} onChange={(event) => update("capital", Number(event.target.value))} /></label>
        <label>槓桿<input type="number" value={form.leverage} onChange={(event) => update("leverage", Number(event.target.value))} /></label>
        <label>Compound %<input type="number" value={form.compoundRate * 100} onChange={(event) => update("compoundRate", Number(event.target.value) / 100)} /></label>
        <label>模式<select value={form.mode} onChange={(event) => update("mode", event.target.value)}><option value="independent">允許多筆</option><option value="single">同時一筆</option></select></label>
        <label>Maker Offset Ticks<input type="number" value={form.makerOffsetTicks} onChange={(event) => update("makerOffsetTicks", Number(event.target.value))} /></label>
      </div>
    </section>
  );
}

function StatusPage({ payload }: { payload: DashboardPayload }) {
  const h = payload.health;
  return (
    <div className="grid two">
      <section className="panel">
        <h2>系統狀態</h2>
        <div className="metrics">
          <Metric label="Worker" value={h.worker.running ? "運行中" : "未連線"} />
          <Metric label="最後事件" value={h.worker.lastEventAt ? new Date(h.worker.lastEventAt).toLocaleString("zh-TW") : "尚無"} />
          <Metric label="Reconnects" value={String(h.worker.reconnects)} />
          <Metric label="訊息" value={h.worker.message} />
        </div>
      </section>
      <section className="panel">
        <h2>Binance / Storage</h2>
        <div className="metrics">
          <Metric label="WS" value={h.binance.wsConnected ? "已連線" : "未連線"} />
          <Metric label="REST" value={h.binance.restOk ? "正常" : "尚無資料"} />
          <Metric label="WS p90" value={`${fmt(h.binance.wsDelayP90, 0)} ms`} />
          <Metric label="REST p90" value={`${fmt(h.binance.restP90, 0)} ms`} />
          <Metric label="SQLite" value={`${fmt((h.storage.sqliteBytes ?? 0) / 1024 / 1024, 2)} MB`} />
          <Metric label="Storage limit" value={`${fmt(h.storage.storageMaxBytes / 1024 / 1024 / 1024, 0)} GB`} />
          <Metric label="Raw retention" value={`${h.storage.rawRetentionDays} 天`} />
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("jamie");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <main className="login">
      <form onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
          onDone();
        } catch (err) {
          setError((err as Error).message.includes("ADMIN_PASSWORD_HASH") ? "尚未在後端設定 ADMIN_PASSWORD_HASH" : "登入失敗");
        }
      }}>
        <ShieldCheck size={36} />
        <h1>SuperShort 實盤監控</h1>
        <p>Live data + paper trading dashboard</p>
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="使用者" />
        <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="密碼" />
        <button className="primary">登入</button>
        {error && <div className="error">{error}</div>}
      </form>
    </main>
  );
}

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [page, setPage] = useState<Page>("chart");
  const [interval, setIntervalValue] = useState<IntervalName>("5s");
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const nav = useMemo(() => [
    ["chart", "即時圖表", BarChart3],
    ["history", "交易紀錄", History],
    ["portfolio", "Portfolio", CircleDollarSign],
    ["strategyQuery", "策略查詢", Search],
    ["settings", "策略設定", Settings],
    ["status", "系統狀態", Activity]
  ] as const, []);

  const refresh = async () => {
    const data = await api<DashboardPayload>(`/api/dashboard?interval=${interval}`);
    setPayload(data);
  };

  const resetPortfolio = async () => {
    const data = await api<DashboardPayload>(`/api/portfolio/reset?interval=${interval}`, { method: "POST" });
    setPayload(data);
  };

  useEffect(() => {
    api<{ authenticated: boolean }>("/api/auth/me").then((value) => setAuthenticated(value.authenticated)).catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [authenticated, interval]);

  if (authenticated === null) return <div className="loading">載入中...</div>;
  if (!authenticated) return <Login onDone={() => setAuthenticated(true)} />;
  if (!payload) return <div className="loading">載入 Dashboard...</div>;

  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><Wifi size={22} /><div><strong>SuperShort</strong><span>Paper Live</span></div></div>
        <nav>
          {nav.map(([key, label, Icon]) => (
            <button key={key} className={page === key ? "active" : ""} onClick={() => setPage(key)}>
              <Icon size={18} />{label}
            </button>
          ))}
        </nav>
        <button className="logout" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setAuthenticated(false); }}>
          <LogOut size={18} />登出
        </button>
      </aside>
      <main className={page === "chart" ? "chart-main" : ""}>
        <header className={page === "chart" ? "trading-header" : ""}>
          <div>
            <h1>{nav.find(([key]) => key === page)?.[1]}</h1>
            <p title={strategyDiffTooltip(payload.previousConfig, payload.config)}>
              {payload.config.symbol} · v{payload.config.version} · {strategyDiffTitle(payload.previousConfig, payload.config)} · {payload.config.enabled ? "策略啟用" : "策略停用"}
            </p>
          </div>
          <div className="status-pill">{payload.health.binance.wsConnected ? "Binance WS 已連線" : "等待 Binance WS"}</div>
        </header>
        {page === "chart" && <ChartPanel payload={payload} interval={interval} onInterval={setIntervalValue} />}
        {page === "history" && <HistoryPage payload={payload} />}
        {page === "portfolio" && <PortfolioPage payload={payload} onReset={resetPortfolio} />}
        {page === "strategyQuery" && <StrategyQueryPage payload={payload} />}
        {page === "settings" && <SettingsPage payload={payload} onReset={resetPortfolio} onOpenStrategyQuery={() => setPage("strategyQuery")} onSaved={(config) => setPayload({ ...payload, previousConfig: payload.config, config })} />}
        {page === "status" && <StatusPage payload={payload} />}
      </main>
    </div>
  );
}
