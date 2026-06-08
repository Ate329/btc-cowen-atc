import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import modelConfig from "../src/data/model-config.json";
import App from "../src/App";
import { estimateQuantilePrices } from "../src/lib/quantileModel";
import type { BtcAtcDataset, PriceRow, QuantileRow } from "../src/lib/types";

describe("App model switch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("switches the coefficient table through all five model modes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => dataset,
      })),
    );

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<App />);
    });

    expect(host.textContent).toContain("Paper ATC Coefficients");

    for (const mode of [
      { button: "Linear QR", heading: "Linear QR Coefficients", parameter: "beta_tau" },
      { button: "Sym Quad", heading: "Symmetric Quadratic QR Coefficients", parameter: "b_tau" },
      { button: "Stretch Exp", heading: "Stretched-Exponential QR Coefficients", parameter: "d_tau" },
      { button: "ATC Refit", heading: "ATC Refit Coefficients", parameter: "b_group" },
    ]) {
      const button = [...host.querySelectorAll("button")].find((item) => item.textContent === mode.button);
      expect(button).toBeTruthy();

      await act(async () => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      expect(host.textContent).toContain(mode.heading);
      expect(host.textContent).toContain(mode.parameter);
    }

    await act(async () => {
      root.unmount();
    });
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

const quantiles: QuantileRow[] = ["2012-01-01", "2021-01-01", "2051-12-31"].map((date) => ({
  date,
  time: Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000),
  ...estimateQuantilePrices(date),
}));

const dataset: BtcAtcDataset = {
  metadata: {
    generatedAt: "2026-06-08T00:00:00.000Z",
    source: "test",
    sourceUrl: "https://example.com",
    startDate: modelConfig.startDate,
    latestCloseDate: "2021-01-01",
    projectionEndDate: modelConfig.projectionEndDate,
    priceRows: prices.length,
    quantileRows: quantiles.length,
    model: modelConfig,
    warnings: [],
  },
  prices,
  quantiles,
};

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
