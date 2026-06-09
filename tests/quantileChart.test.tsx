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
