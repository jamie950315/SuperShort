import type { StrategyConfig } from "./types.js";

type StrategyField = {
  key: keyof StrategyConfig;
  label: string;
  format: (value: StrategyConfig[keyof StrategyConfig]) => string;
};

const modeLabel = {
  independent: "允許多筆",
  single: "同時一筆"
} as const;

const enabledLabel = {
  true: "啟用",
  false: "停用"
} as const;

function formatSlLadder(value: StrategyConfig[keyof StrategyConfig]): string {
  if (!Array.isArray(value)) return "尚無";
  return value
    .map((level) => {
      const item = level as { triggerOffset?: number; limitOffset?: number; quantityPct?: number };
      return `${Number(item.triggerOffset)}→${Number(item.limitOffset)}:${Math.round(Number(item.quantityPct) * 100)}%`;
    })
    .join(", ");
}

function sameValue(previous: StrategyConfig[keyof StrategyConfig], current: StrategyConfig[keyof StrategyConfig]): boolean {
  if (Array.isArray(previous) || Array.isArray(current)) return JSON.stringify(previous) === JSON.stringify(current);
  return previous === current;
}

const fields: StrategyField[] = [
  { key: "enabled", label: "啟用", format: (value) => enabledLabel[String(Boolean(value)) as "true" | "false"] },
  { key: "interval", label: "Time Window", format: (value) => String(value) },
  { key: "persistMs", label: "Persist", format: (value) => `${Number(value)}ms` },
  { key: "longBelow", label: "Long C1", format: (value) => `<${Number(value)}` },
  { key: "shortAbove", label: "Short C1", format: (value) => `>${Number(value)}` },
  { key: "tp", label: "TP", format: (value) => String(Number(value)) },
  { key: "slEnabled", label: "SL System", format: (value) => enabledLabel[String(Boolean(value)) as "true" | "false"] },
  { key: "entryTtlMs", label: "GTX TTL", format: (value) => `${Number(value)}ms` },
  { key: "makerSlRetryMs", label: "Maker SL retry", format: (value) => `${Number(value)}ms` },
  { key: "emergencySl", label: "Emergency SL", format: (value) => `${Number(value)} USDC` },
  { key: "slLadder", label: "SL Ladder", format: formatSlLadder },
  { key: "priceVelocityWindowMs", label: "Velocity Window", format: (value) => `${Number(value)}ms` },
  { key: "maxPriceVelocityUsdPerSec", label: "Max Velocity", format: (value) => `${Number(value)} USDC/s` },
  { key: "capital", label: "本金", format: (value) => `${Number(value)} USDC` },
  { key: "leverage", label: "槓桿", format: (value) => `${Number(value)}x` },
  { key: "compoundRate", label: "Compound", format: (value) => `${Math.round(Number(value) * 100)}%` },
  { key: "mode", label: "模式", format: (value) => modeLabel[value as keyof typeof modeLabel] ?? String(value) },
  { key: "makerOffsetTicks", label: "Maker Offset", format: (value) => `${Number(value)} ticks` }
];

function changedFields(previous: StrategyConfig | null, current: StrategyConfig): string[] {
  if (!previous) return [];
  return fields
    .filter((field) => !sameValue(previous[field.key], current[field.key]))
    .map((field) => `${field.label} ${field.format(previous[field.key])} → ${field.format(current[field.key])}`);
}

function strategyLines(config: StrategyConfig): string[] {
  return fields.map((field) => `${field.label}: ${field.format(config[field.key])}`);
}

export function strategyDiffTitle(previous: StrategyConfig | null, current: StrategyConfig): string {
  if (!previous) return "尚無上一版策略";
  const diffs = changedFields(previous, current);
  if (diffs.length === 0) return "策略無變更";
  const visible = diffs.slice(0, 3).join("、");
  return diffs.length > 3 ? `${visible}、等 ${diffs.length} 項` : visible;
}

export function strategyDiffTooltip(previous: StrategyConfig | null, current: StrategyConfig): string {
  if (!previous) return `新版 v${current.version}\n${strategyLines(current).join("\n")}`;
  return [
    `上一版 v${previous.version}`,
    ...strategyLines(previous),
    "",
    `新版 v${current.version}`,
    ...strategyLines(current)
  ].join("\n");
}
