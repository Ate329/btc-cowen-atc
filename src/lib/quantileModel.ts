import modelConfig from "../data/model-config.json";
import { daysBetweenUtc, parseUtcDate } from "./date";
import type { QuantileKey, QuantileValues } from "./types";

export const quantileKeys = modelConfig.coefficients.map((coefficient) => coefficient.key) as QuantileKey[];

export function daysSinceGenesis(date: string | Date): number {
  return daysBetweenUtc(modelConfig.anchorDate, date);
}

export function centeredLogTime(date: string | Date): number {
  const days = daysSinceGenesis(date);

  if (days <= 0) {
    throw new Error(`Model date must be after ${modelConfig.anchorDate}`);
  }

  return Math.log(days) - modelConfig.mu;
}

export function estimateLog10Price(date: string | Date, key: QuantileKey): number {
  const x = centeredLogTime(date);
  const coefficient = modelConfig.coefficients.find((item) => item.key === key);

  if (!coefficient) {
    throw new Error(`Unknown quantile key: ${key}`);
  }

  return coefficient.c + coefficient.a * x + coefficient.b * x * x;
}

export function estimateQuantilePrices(date: string | Date): QuantileValues {
  parseUtcDate(date);

  const raw = modelConfig.coefficients.map((coefficient) => ({
    key: coefficient.key as QuantileKey,
    value: 10 ** estimateLog10Price(date, coefficient.key as QuantileKey),
  }));

  const rearranged = [...raw].map((item) => item.value).sort((a, b) => a - b);

  return raw.reduce((values, item, index) => {
    values[item.key] = roundPrice(rearranged[index]);
    return values;
  }, {} as QuantileValues);
}

export function distanceToLevel(price: number, level: number): number {
  return price / level - 1;
}

export function classifyPriceBand(price: number, quantiles: QuantileValues): string {
  if (price < quantiles.q1) return "below Q1";
  if (price < quantiles.q10) return "Q1-Q10";
  if (price < quantiles.q25) return "Q10-Q25";
  if (price < quantiles.q50) return "Q25-Q50";
  if (price < quantiles.q75) return "Q50-Q75";
  if (price < quantiles.q95) return "Q75-Q95";
  if (price < quantiles.q99) return "Q95-Q99";
  return "above Q99";
}

function roundPrice(value: number): number {
  if (value < 1) return Number(value.toFixed(5));
  if (value < 100) return Number(value.toFixed(3));
  return Number(value.toFixed(2));
}
