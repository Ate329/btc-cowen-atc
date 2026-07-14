import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuantileChart } from "../src/components/QuantileChart";
import type { PriceRow, QuantileKey, QuantileRow } from "../src/lib/types";

const visibleQuantiles = {
  q1: true,
  q10: true,
  q25: true,
  q50: true,
  q75: true,
  q95: true,
  q99: true,
} satisfies Record<QuantileKey, boolean>;

describe("QuantileChart", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("does not schedule duplicate tooltip work for repeated pointer moves on the same row", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <QuantileChart
          prices={prices}
          quantiles={quantiles}
          visibleQuantiles={visibleQuantiles}
        />,
      );
    });

    const svg = host.querySelector(".quantile-chart") as SVGSVGElement;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1040, height: 488, right: 1040, bottom: 488, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    act(() => {
      svg.dispatchEvent(pointerEvent("pointermove", { clientX: 120, clientY: 80 }));
      svg.dispatchEvent(pointerEvent("pointermove", { clientX: 120, clientY: 80 }));
    });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      frameCallbacks[0]?.(0);
    });

    expect(host.querySelector(".tooltip-layer")?.getAttribute("visibility")).toBe("visible");
    expect(host.querySelector(".tooltip-value")?.textContent).toContain("Close");

    act(() => {
      svg.dispatchEvent(pointerEvent("pointermove", { clientX: 120, clientY: 80 }));
    });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("shows historical halvings and clearly distinguishes future four-year guides", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <QuantileChart
          prices={[priceRow("2011-01-01", 10), priceRow("2026-01-01", 20)]}
          quantiles={[
            quantileRow("2011-01-01", 10),
            quantileRow("2030-01-01", 30),
          ]}
          visibleQuantiles={visibleQuantiles}
        />,
      );
    });

    const halvingLabels = Array.from(
      host.querySelectorAll(".cycle-marker-halving .cycle-marker-label"),
    ).map((node) => node.textContent);
    const guideLabels = Array.from(
      host.querySelectorAll(".cycle-marker-guide .cycle-marker-label"),
    ).map((node) => node.textContent);

    expect(halvingLabels).toEqual([
      "HALVING \u00b7 2012",
      "HALVING \u00b7 2016",
      "HALVING \u00b7 2020",
      "HALVING \u00b7 2024",
    ]);
    expect(guideLabels).toEqual(["4Y GUIDE \u00b7 2028"]);
    expect(
      host.querySelector(".cycle-marker-guide")?.getAttribute("aria-label"),
    ).toContain("future halving dates depend on block production");

    act(() => {
      root.unmount();
    });
  });
});

const prices: PriceRow[] = [
  priceRow("2020-01-01", 10),
  priceRow("2020-01-02", 20),
  priceRow("2020-01-03", 30),
];

const quantiles: QuantileRow[] = [
  quantileRow("2020-01-01", 10),
  quantileRow("2020-01-02", 20),
  quantileRow("2020-01-03", 30),
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

function quantileRow(date: string, base: number): QuantileRow {
  return {
    date,
    time: Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000),
    q1: base * 0.5,
    q10: base * 0.7,
    q25: base * 0.85,
    q50: base,
    q75: base * 1.15,
    q95: base * 1.3,
    q99: base * 1.5,
  };
}

function pointerEvent(type: string, init: { clientX: number; clientY: number }): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  });

  Object.defineProperties(event, {
    buttons: { value: 0 },
    pointerId: { value: 1 },
  });

  return event as PointerEvent;
}
