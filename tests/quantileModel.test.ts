import { describe, expect, it } from "vitest";
import modelConfig from "../src/data/model-config.json";
import {
  centeredLogTime,
  classifyPriceBand,
  daysSinceGenesis,
  distanceToLevel,
  estimateLinearRegressionQuantileRows,
  estimateLog10Price,
  estimateModel,
  estimateQuantilePrices,
  quantileKeys,
} from "../src/lib/quantileModel";
import type { ModelMode, PriceRow, QuantileRow } from "../src/lib/types";

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

  it("estimates the paper's linear quantile power-law baseline and rearranges outputs", () => {
    const { coefficients, quantiles } = estimateLinearRegressionQuantileRows(prices, "2012-01-01", "2012-01-03");

    expect(coefficients).toHaveLength(quantileKeys.length);
    expect(coefficients.every((coefficient) => Number.isFinite(coefficient.slope))).toBe(true);
    expect(quantiles).toHaveLength(3);

    for (const row of quantiles) {
      const ordered = quantileKeys.map((key) => row[key]);

      for (let index = 1; index < ordered.length; index += 1) {
        expect(ordered[index]).toBeGreaterThanOrEqual(ordered[index - 1]);
      }
    }
  });

  it("estimates all Cowen-related comparison model modes with finite monotone bands", () => {
    const modes: ModelMode[] = [
      "paper",
      "linearRegression",
      "symmetricQuadratic",
      "stretchedExponential",
      "asymmetricRefit",
    ];
    const paperQuantiles: QuantileRow[] = ["2012-01-01", "2012-01-02", "2012-01-03"].map((date) => ({
      date,
      time: Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000),
      ...estimateQuantilePrices(date),
    }));

    for (const mode of modes) {
      const model = estimateModel(mode, prices, "2012-01-01", "2012-01-03", paperQuantiles);

      expect(model.coefficients).toHaveLength(quantileKeys.length);
      expect(model.quantiles).toHaveLength(3);
      expect(model.formula.length).toBeGreaterThan(0);

      for (const coefficient of model.coefficients) {
        expect(Number.isFinite(coefficient.pseudoR2)).toBe(true);
        for (const parameter of coefficient.parameters) {
          if (typeof parameter.value === "number") {
            expect(Number.isFinite(parameter.value)).toBe(true);
          }
        }
      }

      for (const row of model.quantiles) {
        const ordered = quantileKeys.map((key) => row[key]);

        expect(ordered.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
        for (let index = 1; index < ordered.length; index += 1) {
          expect(ordered[index]).toBeGreaterThanOrEqual(ordered[index - 1]);
        }
      }
    }
  });
});

const prices: PriceRow[] = [
  priceRow("2012-01-01", 5),
  priceRow("2013-01-01", 13),
  priceRow("2014-01-01", 760),
  priceRow("2015-01-01", 315),
  priceRow("2016-01-01", 430),
  priceRow("2017-01-01", 995),
  priceRow("2018-01-01", 13400),
  priceRow("2019-01-01", 3840),
  priceRow("2020-01-01", 7200),
  priceRow("2021-01-01", 29300),
];

function priceRow(date: string, close: number): PriceRow {
  return {
    date,
    time: Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000),
    open: close,
    high: close,
    low: close,
    close,
    volumeFrom: 1,
    volumeTo: close,
  };
}
