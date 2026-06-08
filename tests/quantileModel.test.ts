import { describe, expect, it } from "vitest";
import modelConfig from "../src/data/model-config.json";
import {
  centeredLogTime,
  classifyPriceBand,
  daysSinceGenesis,
  distanceToLevel,
  estimateLog10Price,
  estimateQuantilePrices,
  quantileKeys,
} from "../src/lib/quantileModel";

describe("quantile model", () => {
  it("anchors dates to days since January 1, 2009", () => {
    expect(daysSinceGenesis("2012-01-01")).toBe(1095);
    expect(centeredLogTime("2012-01-01")).toBeCloseTo(Math.log(1095) - modelConfig.mu, 10);
  });

  it("uses the Table 3 centered quadratic equation", () => {
    const x = centeredLogTime("2026-05-21");
    const q50 = modelConfig.coefficients.find((coefficient) => coefficient.key === "q50")!;
    const expected = q50.c + q50.a * x + q50.b * x * x;

    expect(estimateLog10Price("2026-05-21", "q50")).toBeCloseTo(expected, 10);
  });

  it("returns monotone rearranged quantiles", () => {
    const values = estimateQuantilePrices("2035-12-31");
    const ordered = quantileKeys.map((key) => values[key]);

    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]).toBeGreaterThanOrEqual(ordered[index - 1]);
    }
  });

  it("classifies price bands and distance consistently", () => {
    const values = estimateQuantilePrices("2026-05-21");
    const price = values.q50 * 1.1;

    expect(classifyPriceBand(price, values)).toMatch(/Q50-Q75|Q75-Q95|Q95-Q99|above Q99/);
    expect(distanceToLevel(110, 100)).toBeCloseTo(0.1, 10);
  });
});
