type Direction = "long" | "short";
type OrderMarkerKind = "entry" | "exit";
type OrderMarkerPosition = "aboveBar" | "belowBar";
type OrderOverlayKind = "entry" | "tp" | "sl";

export const CHART_RIGHT_SCALE_WIDTH = 82;

interface CandleLike {
  openTime: number;
  closeTime: number;
}

interface OrderLike {
  id: string;
  direction: Direction;
  filledAt?: number | null;
  settledAt?: number | null;
  entryFillPrice?: number | null;
  exitFillPrice?: number | null;
  reason?: string | null;
  quantity: number;
  filledQuantity?: number | null;
  audit?: Record<string, unknown>;
}

interface ExitFillLike {
  time?: number;
  price?: number;
  quantity?: number;
  reason?: string;
}

export interface OrderOverlayItem {
  id: string;
  time: number;
  price: number;
  direction: Direction;
  kind: OrderOverlayKind;
  quantity: number;
}

export function displayVolumeValue(volume: number, maxVolume: number, minVisibleRatio = 0.05): number {
  if (!Number.isFinite(volume) || volume <= 0) return 0;
  const compressed = Math.sqrt(volume);
  const maxCompressed = Number.isFinite(maxVolume) && maxVolume > 0 ? Math.sqrt(maxVolume) : compressed;
  return Math.max(compressed, maxCompressed * minVisibleRatio);
}

export function orderMarkerPosition(direction: Direction, kind: OrderMarkerKind): OrderMarkerPosition {
  if (kind === "entry") return direction === "long" ? "belowBar" : "aboveBar";
  return direction === "long" ? "aboveBar" : "belowBar";
}

export function candleMarkerTime(time: number | null | undefined, candles: CandleLike[]): number | null {
  if (!time || candles.length === 0) return null;
  const candle = candles.find((bar) => time >= bar.openTime && time <= bar.closeTime);
  return candle ? Math.floor(candle.openTime / 1000) : null;
}

export function orderOverlayItems(orders: OrderLike[], candles: CandleLike[], limit: number | null): OrderOverlayItem[] {
  const visibleOrders = limit === null ? orders : orders.slice(-limit);
  return visibleOrders.flatMap((order) => {
    const items: OrderOverlayItem[] = [];
    const quantity = order.filledQuantity || order.quantity;
    const entryTime = candleMarkerTime(order.filledAt, candles);
    if (entryTime !== null && order.entryFillPrice !== null && order.entryFillPrice !== undefined) {
      items.push({
        id: `${order.id}-entry`,
        time: entryTime,
        price: order.entryFillPrice,
        direction: order.direction,
        kind: "entry",
        quantity
      });
    }

    const exitFills = Array.isArray(order.audit?.exitFills) ? order.audit.exitFills as ExitFillLike[] : [];
    for (const fill of exitFills) {
      const fillTime = candleMarkerTime(fill.time, candles);
      if (fillTime === null || fill.price === null || fill.price === undefined) continue;
      items.push({
        id: `${order.id}-exit-${fill.time}-${fill.price}`,
        time: fillTime,
        price: fill.price,
        direction: order.direction,
        kind: fill.reason === "tp_reduce_only" ? "tp" : "sl",
        quantity: fill.quantity ?? quantity
      });
    }
    if (exitFills.length > 0) return items;

    const exitTime = candleMarkerTime(order.settledAt, candles);
    if (exitTime !== null && order.exitFillPrice !== null && order.exitFillPrice !== undefined) {
      items.push({
        id: `${order.id}-exit`,
        time: exitTime,
        price: order.exitFillPrice,
        direction: order.direction,
        kind: order.reason === "tp_reduce_only" ? "tp" : "sl",
        quantity
      });
    }
    return items;
  });
}
