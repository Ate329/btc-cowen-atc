import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BtcAtcDataset, QuantileKey } from "../src/lib/types";

const dataset = JSON.parse(readFileSync("public/data/btc-atc.json", "utf8")) as BtcAtcDataset;
const quantileKeys: QuantileKey[] = ["q1", "q10", "q25", "q50", "q75", "q95", "q99"];

describe("generated BTC ATC dataset", () => {
  it("contains metadata, prices, and projected quantile rows", () => {
    expect(dataset.metadata.startDate).toBe("2012-01-01");
    expect(dataset.metadata.model.version).toBe("cowen-atc-table-3-2026-05-29");
    expect(dataset.prices.length).toBeGreaterThan(5000);
    expect(dataset.quantiles.length).toBeGreaterThan(dataset.prices.length);
    expect(dataset.prices[0].date).toBe("2012-01-01");
    expect(dataset.quantiles.at(-1)?.date).toBe("2051-12-31");
  });

  it("keeps generated quantiles positive and monotone", () => {
    for (const row of [dataset.quantiles[0], dataset.quantiles[Math.floor(dataset.quantiles.length / 2)], dataset.quantiles.at(-1)!]) {
      const ordered = quantileKeys.map((key) => row[key]);

      expect(ordered.every((value) => value > 0)).toBe(true);
      for (let index = 1; index < ordered.length; index += 1) {
        expect(ordered[index]).toBeGreaterThanOrEqual(ordered[index - 1]);
      }
    }
  });

  it("keeps price rows finite and date sorted", () => {
    for (let index = 1; index < dataset.prices.length; index += 1) {
      expect(dataset.prices[index].date > dataset.prices[index - 1].date).toBe(true);
    }

    const latest = dataset.prices.at(-1)!;
    expect(Number.isFinite(latest.close)).toBe(true);
    expect(latest.close).toBeGreaterThan(0);
  });
});
