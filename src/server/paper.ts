import { randomUUID } from "node:crypto";
import type {
  AggTradeEvent,
  BookTickerEvent,
  Direction,
  LatencyStats,
  PaperOrder,
  PaperTrade,
  SignalEvent,
  SlLadderLevel,
  StrategyConfig
} from "../shared/types.js";

export interface PaperExecutorOptions {
  symbol: string;
  tickSize?: number;
  referencePrice?: number;
}

export interface PaperTradeContext {
  typicalPrice?: number;
}

type ExitDecision =
  | { price: number; reason: "tp_reduce_only" | "sl_reduce_only" | "sl_timeout_gtx" | "emergency_stop_market"; quantity?: number; levelIndex?: number }
  | { updated: true };

type SlLadderOrderStatus = "waiting" | "triggered" | "armed" | "timeout" | "filled";

interface SlLadderOrder {
  index: number;
  triggerOffset: number;
  limitOffset: number;
  quantityPct: number;
  quantity: number;
  triggerPrice: number;
  limitPrice: number;
  status: SlLadderOrderStatus;
  triggeredAt?: number;
  triggeredPrice?: number;
  armedAt?: number;
  armedPrice?: number;
  timeoutGtxPrice?: number;
  timeoutGtxPlacedAt?: number;
  filledAt?: number;
  filledPrice?: number;
}

interface ExitFillRecord {
  index: number;
  time: number;
  price: number;
  quantity: number;
  pnlUsdc: number;
  reason: "tp_reduce_only" | "sl_reduce_only" | "sl_timeout_gtx" | "emergency_stop_market";
  levelIndex?: number;
}

export class PaperGtxExecutor {
  private orders = new Map<string, PaperOrder>();
  private lastBook: BookTickerEvent | null = null;

  constructor(private readonly options: PaperExecutorOptions) {}

  loadOrder(order: PaperOrder): void {
    if (["pending", "resting", "partial", "filled", "open"].includes(order.status)) {
      this.orders.set(order.id, order);
    }
  }

  clearOrders(): void {
    this.orders.clear();
  }

  setBook(book: BookTickerEvent): void {
    this.lastBook = book;
  }

  createOrder(signal: SignalEvent, config: StrategyConfig, latency: LatencyStats): PaperOrder | null {
    if (!config.enabled || !this.lastBook) return null;
    if (config.mode === "single" && this.openOrders().length > 0) return null;
    if (config.capital <= 0) return null;
    const quantity = (config.capital * config.leverage) / (this.options.referencePrice ?? signal.price);
    const tickSize = this.options.tickSize ?? 0.1;
    const makerTicks = config.makerOffsetTicks + 1;
    const entryIntentPrice = signal.direction === "long"
      ? this.lastBook.askPrice - tickSize * makerTicks
      : this.lastBook.bidPrice + tickSize * makerTicks;
    const activeAt = signal.time + Math.max(0, latency.orderActivationDelayMs);
    const tpPrice = signal.direction === "long" ? entryIntentPrice + config.tp : entryIntentPrice - config.tp;
    const slPrice = signal.direction === "long" ? entryIntentPrice - config.sl : entryIntentPrice + config.sl;
    const slTriggerPrice = this.slStopTriggerPrice(signal.direction, entryIntentPrice, config.sl, config.slTriggerOffset);
    const slSystemEnabled = config.slEnabled !== false;
    const slLadder = slSystemEnabled ? this.normalizedSlLadder(config) : [];
    const order: PaperOrder = {
      id: `paper_${randomUUID()}`,
      symbol: signal.symbol,
      signalId: signal.id,
      configVersion: config.version,
      direction: signal.direction,
      status: "pending",
      entryIntentPrice,
      entryFillPrice: null,
      quantity,
      filledQuantity: 0,
      createdAt: signal.time,
      activeAt,
      filledAt: null,
      settledAt: null,
      tpPrice,
      slPrice,
      exitFillPrice: null,
      pnlUsdc: 0,
      reason: null,
      audit: {
        latency,
        signalPrice: signal.price,
        fillStrictness: config.fillStrictness,
        entryTtlMs: config.entryTtlMs,
        slSystemEnabled,
        tpReduceOnlyPrice: tpPrice,
        slTriggerOffset: this.normalizedSlTriggerOffset(config.slTriggerOffset, config.sl),
        slStopTriggerPrice: slTriggerPrice,
        slStopLimitPrice: slPrice,
        makerSlRetryMs: config.makerSlRetryMs,
        emergencySl: config.emergencySl,
        slLadderConfig: slLadder
      }
    };

    this.orders.set(order.id, order);
    return order;
  }

  processBook(book: BookTickerEvent): PaperOrder[] {
    this.lastBook = book;
    const changed: PaperOrder[] = this.expireEntryOrders(book.eventTime);
    for (const order of this.orders.values()) {
      if (order.status !== "pending" || book.eventTime < order.activeAt) continue;
      const wouldCross = this.wouldCross(order.direction, order.entryIntentPrice, book);
      if (wouldCross) {
        order.status = "rejected";
        order.reason = "gtx_reject";
        order.audit = { ...order.audit, rejectBook: book };
      } else {
        order.status = "resting";
      }
      changed.push(order);
    }
    return changed;
  }

  processTrade(trade: AggTradeEvent, context: PaperTradeContext = {}): { orders: PaperOrder[]; trades: PaperTrade[] } {
    const changed: PaperOrder[] = this.expireEntryOrders(trade.tradeTime);
    const trades: PaperTrade[] = [];

    for (const order of this.orders.values()) {
      if (order.symbol !== trade.symbol) continue;
      if (order.status === "resting" || order.status === "partial") {
        if (this.canFillEntry(order, trade)) {
          const fillRatio = this.fillRatio(order, trade);
          order.filledQuantity = Math.min(order.quantity, order.filledQuantity + order.quantity * fillRatio);
          order.entryFillPrice = order.entryIntentPrice;
          order.filledAt ??= trade.tradeTime;
          order.reason = fillRatio >= 1 ? "trade_through" : "partial_queue";
          order.status = order.filledQuantity >= order.quantity * 0.999 ? "filled" : "partial";
          if (order.status === "filled" && typeof order.audit.settlementActiveAt !== "number") {
            this.activateSettlementOrders(order, trade.tradeTime);
          }
          changed.push(order);
        }
      }

      if (order.status === "filled") {
        const exit = this.checkExit(order, trade, context);
        if (exit) {
          if ("updated" in exit) {
            changed.push(order);
            continue;
          }
          order.status = "settled";
          order.settledAt = trade.tradeTime;
          order.exitFillPrice = exit.price;
          order.reason = exit.reason;
          const exitQuantity = Math.min(exit.quantity ?? this.remainingQuantity(order), this.remainingQuantity(order));
          const pnlUsdc = this.calculatePnl(order, exit.price, exitQuantity);
          order.pnlUsdc += pnlUsdc;
          const remainingQuantity = Math.max(0, this.remainingQuantity(order) - exitQuantity);
          const exitFill = this.recordExitFill(order, trade.tradeTime, exit.price, exitQuantity, pnlUsdc, exit.reason, exit.levelIndex);
          order.audit = {
            ...order.audit,
            remainingQuantity,
            exitFills: [...this.exitFills(order), exitFill]
          };
          if (exit.levelIndex !== undefined) this.markSlLevelFilled(order, exit.levelIndex, trade.tradeTime, exit.price);
          if (remainingQuantity > this.quantityEpsilon(order)) {
            order.status = "filled";
            order.settledAt = trade.tradeTime;
          }
          changed.push(order);
          trades.push(this.toTrade(order, exitFill));
        }
      }
    }

    return { orders: changed, trades };
  }

  openOrders(): PaperOrder[] {
    return [...this.orders.values()].filter((order) => ["pending", "resting", "partial", "filled"].includes(order.status));
  }

  private wouldCross(direction: Direction, price: number, book: BookTickerEvent): boolean {
    return direction === "long" ? price >= book.askPrice : price <= book.bidPrice;
  }

  private normalizedSlTriggerOffset(offset: number | undefined, sl: number): number {
    if (typeof offset === "number" && Number.isFinite(offset) && offset > 0 && offset < sl) return offset;
    return sl / 2;
  }

  private slStopTriggerPrice(direction: Direction, entryPrice: number, sl: number, offset: number | undefined): number {
    const triggerOffset = this.normalizedSlTriggerOffset(offset, sl);
    return direction === "long" ? entryPrice - triggerOffset : entryPrice + triggerOffset;
  }

  private normalizedSlLadder(config: StrategyConfig): SlLadderLevel[] {
    const raw = Array.isArray(config.slLadder) && config.slLadder.length > 0
      ? config.slLadder
      : [{ triggerOffset: this.normalizedSlTriggerOffset(config.slTriggerOffset, config.sl), limitOffset: config.sl, quantityPct: 1 }];
    const filtered = raw
      .map((level) => ({
        triggerOffset: Number(level.triggerOffset),
        limitOffset: Number(level.limitOffset),
        quantityPct: Number(level.quantityPct)
      }))
      .filter((level) => (
        Number.isFinite(level.triggerOffset)
        && Number.isFinite(level.limitOffset)
        && Number.isFinite(level.quantityPct)
        && level.triggerOffset > 0
        && level.limitOffset > 0
        && level.limitOffset >= level.triggerOffset
        && level.quantityPct > 0
      ))
      .sort((a, b) => a.limitOffset - b.limitOffset);
    const usable = filtered.length > 0
      ? filtered
      : [{ triggerOffset: this.normalizedSlTriggerOffset(config.slTriggerOffset, config.sl), limitOffset: config.sl, quantityPct: 1 }];
    const totalPct = usable.reduce((sum, level) => sum + level.quantityPct, 0);
    return usable.map((level) => ({ ...level, quantityPct: level.quantityPct / totalPct }));
  }

  private activateSettlementOrders(order: PaperOrder, time: number): void {
    const latency = order.audit.latency as LatencyStats | undefined;
    const settlementActiveAt = time + Math.max(0, latency?.orderActivationDelayMs ?? 0);
    const slSystemEnabled = order.audit.slSystemEnabled !== false;
    const ladderConfig = slSystemEnabled ? this.auditSlLadderConfig(order) : [];
    const slLadderOrders = slSystemEnabled ? this.createSlLadderOrders(order, ladderConfig) : [];
    order.audit = {
      ...order.audit,
      settlementActiveAt,
      tpReduceOnlyPlacedAt: settlementActiveAt,
      slStopPlacedAt: settlementActiveAt,
      remainingQuantity: order.filledQuantity,
      slLadderOrders
    };
  }

  private auditSlLadderConfig(order: PaperOrder): SlLadderLevel[] {
    const levels = order.audit.slLadderConfig as SlLadderLevel[] | undefined;
    if (Array.isArray(levels) && levels.length > 0) return levels;
    const triggerOffset = typeof order.audit.slTriggerOffset === "number"
      ? order.audit.slTriggerOffset
      : Math.abs((order.entryFillPrice ?? order.entryIntentPrice) - order.slPrice) / 2;
    const limitOffset = Math.abs((order.entryFillPrice ?? order.entryIntentPrice) - order.slPrice);
    return [{ triggerOffset, limitOffset, quantityPct: 1 }];
  }

  private createSlLadderOrders(order: PaperOrder, levels: SlLadderLevel[]): SlLadderOrder[] {
    const entry = order.entryFillPrice ?? order.entryIntentPrice;
    let allocated = 0;
    return levels.map((level, index) => {
      const isLast = index === levels.length - 1;
      const quantity = isLast
        ? Math.max(0, order.filledQuantity - allocated)
        : order.filledQuantity * level.quantityPct;
      allocated += quantity;
      return {
        index,
        triggerOffset: level.triggerOffset,
        limitOffset: level.limitOffset,
        quantityPct: level.quantityPct,
        quantity,
        triggerPrice: order.direction === "long" ? entry - level.triggerOffset : entry + level.triggerOffset,
        limitPrice: order.direction === "long" ? entry - level.limitOffset : entry + level.limitOffset,
        status: "waiting"
      };
    });
  }

  private canFillEntry(order: PaperOrder, trade: AggTradeEvent): boolean {
    if (trade.tradeTime < order.activeAt) return false;
    if (order.direction === "long") return trade.price < order.entryIntentPrice;
    return trade.price > order.entryIntentPrice;
  }

  private fillRatio(order: PaperOrder, trade: AggTradeEvent): number {
    const queueConfidence = Math.min(1, Math.max(0.25, trade.quantity / Math.max(order.quantity * 3, 0.000001)));
    const remaining = 1 - order.filledQuantity / order.quantity;
    return Math.min(remaining, queueConfidence);
  }

  private expireEntryOrders(time: number): PaperOrder[] {
    const changed: PaperOrder[] = [];
    for (const order of this.orders.values()) {
      if (!["pending", "resting", "partial"].includes(order.status)) continue;
      const ttlMs = typeof order.audit.entryTtlMs === "number" ? order.audit.entryTtlMs : 3000;
      if (ttlMs <= 0 || time < order.createdAt + ttlMs) continue;

      if (order.filledQuantity > 0 && order.entryFillPrice !== null && order.filledAt !== null) {
        order.status = "filled";
        order.reason = "entry_ttl_cancel";
        order.audit = {
          ...order.audit,
          entryTtlCanceledAt: time,
          originalQuantity: order.quantity,
          canceledQuantity: Math.max(0, order.quantity - order.filledQuantity)
        };
        this.activateSettlementOrders(order, time);
      } else {
        order.status = "canceled";
        order.reason = "entry_ttl_cancel";
        order.settledAt = time;
        order.audit = { ...order.audit, entryTtlCanceledAt: time };
      }
      changed.push(order);
    }
    return changed;
  }

  private checkExit(order: PaperOrder, trade: AggTradeEvent, context: PaperTradeContext): ExitDecision | null {
    const settlementActiveAt = typeof order.audit.settlementActiveAt === "number"
      ? order.audit.settlementActiveAt
      : order.filledAt ?? order.activeAt;
    if (trade.tradeTime < settlementActiveAt) return null;
    if (order.entryFillPrice === null) return null;

    if (order.direction === "long" && trade.price > order.tpPrice) {
      return { price: order.tpPrice, reason: "tp_reduce_only", quantity: this.remainingQuantity(order) };
    }
    if (order.direction === "short" && trade.price < order.tpPrice) {
      return { price: order.tpPrice, reason: "tp_reduce_only", quantity: this.remainingQuantity(order) };
    }

    if (order.audit.slSystemEnabled === false) return null;

    const emergencySl = typeof order.audit.emergencySl === "number" ? order.audit.emergencySl : 15;
    if (emergencySl > 0) {
      if (order.direction === "long" && trade.price <= order.entryFillPrice - emergencySl) {
        return { price: trade.price, reason: "emergency_stop_market", quantity: this.remainingQuantity(order) };
      }
      if (order.direction === "short" && trade.price >= order.entryFillPrice + emergencySl) {
        return { price: trade.price, reason: "emergency_stop_market", quantity: this.remainingQuantity(order) };
      }
    }

    const ladderExit = this.checkSlLadderExit(order, trade, context);
    if (ladderExit) return ladderExit;
    if (this.slLadderOrders(order).length > 0) return null;

    const slStopTriggeredAt = typeof order.audit.slStopTriggeredAt === "number" ? order.audit.slStopTriggeredAt : null;
    const slArmedAt = typeof order.audit.slArmedAt === "number" ? order.audit.slArmedAt : null;

    if (slArmedAt !== null) {
      if (trade.tradeTime <= slArmedAt) return null;
      if (order.direction === "long" && trade.price > order.slPrice) return { price: order.slPrice, reason: "sl_reduce_only" };
      if (order.direction === "short" && trade.price < order.slPrice) return { price: order.slPrice, reason: "sl_reduce_only" };
      const timeoutGtxPrice = typeof order.audit.slTimeoutGtxPrice === "number" ? order.audit.slTimeoutGtxPrice : null;
      if (timeoutGtxPrice !== null) {
        if (order.direction === "long" && trade.price > timeoutGtxPrice) return { price: timeoutGtxPrice, reason: "sl_timeout_gtx" };
        if (order.direction === "short" && trade.price < timeoutGtxPrice) return { price: timeoutGtxPrice, reason: "sl_timeout_gtx" };
        return null;
      }
      const makerSlRetryMs = typeof order.audit.makerSlRetryMs === "number" ? order.audit.makerSlRetryMs : 3000;
      if (makerSlRetryMs > 0 && trade.tradeTime - slArmedAt >= makerSlRetryMs) {
        order.audit = {
          ...order.audit,
          slTimeoutGtxPrice: context.typicalPrice ?? trade.price,
          slTimeoutGtxPlacedAt: trade.tradeTime
        };
        return { updated: true };
      }
      return null;
    }

    if (order.direction === "long") {
      const slStopTriggerPrice = typeof order.audit.slStopTriggerPrice === "number"
        ? order.audit.slStopTriggerPrice
        : (order.entryFillPrice - (order.entryFillPrice - order.slPrice) / 2);
      if (slStopTriggeredAt === null && trade.price < slStopTriggerPrice) {
        order.audit = {
          ...order.audit,
          slStopTriggeredAt: trade.tradeTime,
          slStopTriggeredPrice: trade.price
        };
        if (trade.price >= order.slPrice) return { updated: true };
      }
      if (trade.price < order.slPrice) {
        order.audit = { ...order.audit, slArmedAt: trade.tradeTime, slArmedPrice: order.slPrice, slTriggerPrice: trade.price };
        return { updated: true };
      }
    } else {
      const slStopTriggerPrice = typeof order.audit.slStopTriggerPrice === "number"
        ? order.audit.slStopTriggerPrice
        : (order.entryFillPrice + (order.slPrice - order.entryFillPrice) / 2);
      if (slStopTriggeredAt === null && trade.price > slStopTriggerPrice) {
        order.audit = {
          ...order.audit,
          slStopTriggeredAt: trade.tradeTime,
          slStopTriggeredPrice: trade.price
        };
        if (trade.price <= order.slPrice) return { updated: true };
      }
      if (trade.price > order.slPrice) {
        order.audit = { ...order.audit, slArmedAt: trade.tradeTime, slArmedPrice: order.slPrice, slTriggerPrice: trade.price };
        return { updated: true };
      }
    }
    return null;
  }

  private checkSlLadderExit(order: PaperOrder, trade: AggTradeEvent, context: PaperTradeContext): ExitDecision | null {
    const levels = this.slLadderOrders(order);
    if (!levels.length) return null;
    let updated = false;
    for (const level of levels) {
      if (level.status === "filled" || level.quantity <= 0) continue;
      const timeoutPrice = typeof level.timeoutGtxPrice === "number" ? level.timeoutGtxPrice : null;
      if (timeoutPrice !== null) {
        if (order.direction === "long" && trade.price > timeoutPrice) return { price: timeoutPrice, reason: "sl_timeout_gtx", quantity: level.quantity, levelIndex: level.index };
        if (order.direction === "short" && trade.price < timeoutPrice) return { price: timeoutPrice, reason: "sl_timeout_gtx", quantity: level.quantity, levelIndex: level.index };
        continue;
      }

      if (level.status === "armed") {
        if (trade.tradeTime <= (level.armedAt ?? 0)) continue;
        if (order.direction === "long" && trade.price > level.limitPrice) return { price: level.limitPrice, reason: "sl_reduce_only", quantity: level.quantity, levelIndex: level.index };
        if (order.direction === "short" && trade.price < level.limitPrice) return { price: level.limitPrice, reason: "sl_reduce_only", quantity: level.quantity, levelIndex: level.index };
        const makerSlRetryMs = typeof order.audit.makerSlRetryMs === "number" ? order.audit.makerSlRetryMs : 3000;
        if (makerSlRetryMs > 0 && level.armedAt !== undefined && trade.tradeTime - level.armedAt >= makerSlRetryMs) {
          level.timeoutGtxPrice = context.typicalPrice ?? trade.price;
          level.timeoutGtxPlacedAt = trade.tradeTime;
          level.status = "timeout";
          updated = true;
        }
        continue;
      }

      if (order.direction === "long") {
        if (level.status === "waiting" && trade.price < level.triggerPrice) {
          level.status = "triggered";
          level.triggeredAt = trade.tradeTime;
          level.triggeredPrice = trade.price;
          updated = true;
        }
        if (level.status !== "timeout" && trade.price < level.limitPrice) {
          level.status = "armed";
          level.armedAt = trade.tradeTime;
          level.armedPrice = level.limitPrice;
          updated = true;
        }
      } else {
        if (level.status === "waiting" && trade.price > level.triggerPrice) {
          level.status = "triggered";
          level.triggeredAt = trade.tradeTime;
          level.triggeredPrice = trade.price;
          updated = true;
        }
        if (level.status !== "timeout" && trade.price > level.limitPrice) {
          level.status = "armed";
          level.armedAt = trade.tradeTime;
          level.armedPrice = level.limitPrice;
          updated = true;
        }
      }
    }
    if (updated) {
      order.audit = { ...order.audit, slLadderOrders: levels };
      return { updated: true };
    }
    return null;
  }

  private slLadderOrders(order: PaperOrder): SlLadderOrder[] {
    const levels = order.audit.slLadderOrders as SlLadderOrder[] | undefined;
    return Array.isArray(levels) ? levels : [];
  }

  private markSlLevelFilled(order: PaperOrder, levelIndex: number, time: number, price: number): void {
    const levels = this.slLadderOrders(order);
    const level = levels.find((item) => item.index === levelIndex);
    if (!level) return;
    level.status = "filled";
    level.filledAt = time;
    level.filledPrice = price;
    order.audit = { ...order.audit, slLadderOrders: levels };
  }

  private remainingQuantity(order: PaperOrder): number {
    const remaining = order.audit.remainingQuantity;
    return typeof remaining === "number" ? remaining : order.filledQuantity;
  }

  private quantityEpsilon(order: PaperOrder): number {
    return Math.max(order.filledQuantity * 0.000001, 0.00000001);
  }

  private exitFills(order: PaperOrder): ExitFillRecord[] {
    const fills = order.audit.exitFills as ExitFillRecord[] | undefined;
    return Array.isArray(fills) ? fills : [];
  }

  private recordExitFill(
    order: PaperOrder,
    time: number,
    price: number,
    quantity: number,
    pnlUsdc: number,
    reason: ExitFillRecord["reason"],
    levelIndex?: number
  ): ExitFillRecord {
    return {
      index: this.exitFills(order).length + 1,
      time,
      price,
      quantity,
      pnlUsdc,
      reason,
      levelIndex
    };
  }

  private calculatePnl(order: PaperOrder, exitPrice: number, quantity: number): number {
    if (order.entryFillPrice === null) return 0;
    const move = order.direction === "long"
      ? exitPrice - order.entryFillPrice
      : order.entryFillPrice - exitPrice;
    return move * quantity;
  }

  private toTrade(order: PaperOrder, exitFill: ExitFillRecord): PaperTrade {
    return {
      id: `trade_${order.id}_${exitFill.index}`,
      orderId: order.id,
      symbol: order.symbol,
      direction: order.direction,
      status: order.status,
      entryTime: order.createdAt,
      exitTime: exitFill.time,
      holdMs: order.filledAt ? exitFill.time - order.filledAt : null,
      entryPrice: order.entryFillPrice,
      exitPrice: exitFill.price,
      quantity: exitFill.quantity,
      pnlUsdc: exitFill.pnlUsdc,
      reason: exitFill.reason,
      configVersion: order.configVersion
    };
  }
}
