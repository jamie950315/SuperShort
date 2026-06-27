import type { SignalEvent } from "../shared/types.js";

interface PendingSignal {
  key: string;
  startTime: number;
  latest: SignalEvent;
}

export class PersistentSignalGate {
  private pending: PendingSignal | null = null;
  private readonly fired = new Set<string>();

  constructor(private readonly persistMs: number) {}

  update(signal: SignalEvent | null, now: number): SignalEvent | null {
    if (!signal) {
      this.pending = null;
      return null;
    }

    const key = this.signalKey(signal);
    if (this.fired.has(key)) return null;

    if (!this.pending || this.pending.key !== key) {
      this.pending = { key, startTime: now, latest: signal };
    } else {
      this.pending.latest = signal;
    }

    if (now - this.pending.startTime < this.persistMs) return null;

    this.fired.add(key);
    return this.pending.latest;
  }

  private signalKey(signal: SignalEvent): string {
    return `${signal.configVersion}:${signal.interval}:${signal.bucket}:${signal.direction}`;
  }
}
