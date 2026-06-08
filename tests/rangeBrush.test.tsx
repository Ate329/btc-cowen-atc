import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RangeBrush, type BrushWindow } from "../src/components/RangeBrush";
import type { PriceRow, QuantileRow } from "../src/lib/types";

const prices: PriceRow[] = [
  { date: "2012-01-01", time: 1325376000, open: 5, high: 6, low: 4, close: 5, volumeFrom: 1, volumeTo: 5 },
  { date: "2014-01-01", time: 1388534400, open: 700, high: 800, low: 600, close: 750, volumeFrom: 1, volumeTo: 750 },
  { date: "2016-01-01", time: 1451606400, open: 430, high: 470, low: 400, close: 440, volumeFrom: 1, volumeTo: 440 },
];

const quantiles: QuantileRow[] = [
  { date: "2012-01-01", time: 1325376000, q1: 2, q10: 3, q25: 4, q50: 5, q75: 8, q95: 10, q99: 12 },
  { date: "2014-01-01", time: 1388534400, q1: 80, q10: 110, q25: 180, q50: 300, q75: 600, q95: 900, q99: 1200 },
  { date: "2016-01-01", time: 1451606400, q1: 180, q10: 220, q25: 280, q50: 400, q75: 700, q95: 1000, q99: 1400 },
];

describe("RangeBrush", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits live range changes while a handle is moving", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    SVGSVGElement.prototype.setPointerCapture = vi.fn();
    SVGSVGElement.prototype.releasePointerCapture = vi.fn();
    SVGSVGElement.prototype.hasPointerCapture = vi.fn(() => true);

    const host = document.createElement("div");
    document.body.append(host);

    const changes: Array<BrushWindow | null> = [];
    const root = createRoot(host);

    act(() => {
      root.render(
        <RangeBrush
          prices={prices}
          quantiles={quantiles}
          domainStartDate="2012-01-01"
          domainEndDate="2016-01-01"
          value={null}
          onChange={(value) => changes.push(value)}
        />,
      );
    });

    const svg = host.querySelector(".range-brush") as SVGSVGElement;
    const startHandle = host.querySelector(".range-brush-handle") as SVGGElement;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1040, height: 64, right: 1040, bottom: 64, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    act(() => {
      startHandle.dispatchEvent(pointerEvent("pointerdown", { clientX: 14, clientY: 32, buttons: 1 }));
      svg.dispatchEvent(pointerEvent("pointermove", { clientX: 300, clientY: 32, buttons: 1 }));
    });

    expect(changes.at(-1)).toEqual(expect.objectContaining({ endDate: "2016-01-01" }));
    expect(changes.at(-1)?.startDate).not.toBe("2012-01-01");

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});

function pointerEvent(type: string, init: { clientX: number; clientY: number; buttons: number }): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  });

  Object.defineProperties(event, {
    buttons: { value: init.buttons },
    pointerId: { value: 1 },
  });

  return event as PointerEvent;
}
