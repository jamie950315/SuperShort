export interface PriceVelocityGuardOptions {
  windowMs: number;
  maxUsdPerSec: number;
}

export interface PriceVelocityState {
  velocityUsdPerSec: number;
  tooFast: boolean;
}

interface PriceSample {
  price: number;
  time: number;
}

export class PriceVelocityGuard {
  private samples: PriceSample[] = [];

  constructor(private options: PriceVelocityGuardOptions = { windowMs: 3000, maxUsdPerSec: 5 }) {}

  update(price: number, time: number, options?: Partial<PriceVelocityGuardOptions>): PriceVelocityState {
    this.options = { ...this.options, ...options };
    const windowMs = Math.max(1, this.options.windowMs);
    this.samples.push({ price, time });
    const cutoff = time - windowMs;
    this.samples = this.samples.filter((sample) => sample.time >= cutoff);

    const oldest = this.samples[0];
    if (!oldest || oldest.time === time) {
      return { velocityUsdPerSec: 0, tooFast: false };
    }

    const elapsedSec = Math.max(0.001, (time - oldest.time) / 1000);
    const velocityUsdPerSec = Math.abs(price - oldest.price) / elapsedSec;
    return {
      velocityUsdPerSec,
      tooFast: this.options.maxUsdPerSec > 0 && velocityUsdPerSec >= this.options.maxUsdPerSec
    };
  }
}
