import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import * as d3 from "d3";
import type { PriceRow, QuantileRow } from "../lib/types";

export type BrushWindow = {
  startDate: string;
  endDate: string;
};

type DragMode = "start" | "end" | "move";

type DragState = {
  mode: DragMode;
  pointerMs: number;
  startMs: number;
  endMs: number;
};

type SelectionMs = {
  startMs: number;
  endMs: number;
};

type RangeBrushProps = {
  prices: PriceRow[];
  quantiles: QuantileRow[];
  domainStartDate: string;
  domainEndDate: string;
  value: BrushWindow | null;
  onChange: (value: BrushWindow | null) => void;
};

const width = 1040;
const height = 64;
const margin = { top: 7, right: 14, bottom: 7, left: 14 };
const innerWidth = width - margin.left - margin.right;
const innerHeight = height - margin.top - margin.bottom;
const handleThumbHeight = 40;
const handleThumbY = (innerHeight - handleThumbHeight) / 2;
const dayMs = 86_400_000;
const minWindowMs = 45 * dayMs;
const monthMs = 30 * dayMs;
const yearMs = 365 * dayMs;

export function RangeBrush({
  prices,
  quantiles,
  domainStartDate,
  domainEndDate,
  value,
  onChange,
}: RangeBrushProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const draftSelectionRef = useRef<SelectionMs | null>(null);
  const liveChangeRafRef = useRef<number | null>(null);
  const liveWindowRef = useRef<BrushWindow | null>(value);
  const [isDragging, setIsDragging] = useState(false);
  const [draftWindow, setDraftWindow] = useState<BrushWindow | null>(value);

  const domainStartMs = toMs(domainStartDate);
  const domainEndMs = toMs(domainEndDate);
  const domainSpan = Math.max(minWindowMs, domainEndMs - domainStartMs);
  const activeWindow = isDragging ? draftWindow : draftWindow ?? value;
  const selectedStartMs = clamp(activeWindow ? toMs(activeWindow.startDate) : domainStartMs, domainStartMs, domainEndMs - minWindowMs);
  const selectedEndMs = clamp(activeWindow ? toMs(activeWindow.endDate) : domainEndMs, selectedStartMs + minWindowMs, domainEndMs);

  useEffect(() => {
    if (!isDragging) {
      setDraftWindow(value);
      draftSelectionRef.current = null;
    }
  }, [domainEndDate, domainStartDate, isDragging, value]);

  useEffect(() => {
    return () => {
      if (liveChangeRafRef.current !== null) {
        window.cancelAnimationFrame(liveChangeRafRef.current);
      }
    };
  }, []);

  const xScale = useMemo(
    () => d3.scaleUtc().domain([new Date(domainStartMs), new Date(domainEndMs)]).range([0, innerWidth]),
    [domainStartMs, domainEndMs],
  );

  const overviewRows = useMemo(() => {
    const q50Rows = quantiles.map((row) => ({
      dateValue: toDate(row.date),
      value: row.q50,
      type: "model" as const,
    }));
    const priceRows = prices.map((row) => ({
      dateValue: toDate(row.date),
      value: row.close,
      type: "price" as const,
    }));

    return { q50Rows, priceRows };
  }, [prices, quantiles]);

  const yScale = useMemo(() => {
    const values = [...overviewRows.q50Rows, ...overviewRows.priceRows]
      .map((row) => row.value)
      .filter((item) => Number.isFinite(item) && item > 0);
    const min = d3.min(values) ?? 1;
    const max = d3.max(values) ?? 100_000;

    return d3.scaleLog().domain([min * 0.7, max * 1.25]).range([innerHeight, 0]).clamp(true);
  }, [overviewRows]);

  const q50AreaPath = useMemo(() => {
    const area = d3
      .area<(typeof overviewRows.q50Rows)[number]>()
      .x((row) => xScale(row.dateValue))
      .y0(innerHeight)
      .y1((row) => yScale(row.value))
      .curve(d3.curveMonotoneX);

    return area(overviewRows.q50Rows) ?? "";
  }, [overviewRows, xScale, yScale]);

  const pricePath = useMemo(() => {
    const line = d3
      .line<(typeof overviewRows.priceRows)[number]>()
      .defined((row) => Number.isFinite(row.value) && row.value > 0)
      .x((row) => xScale(row.dateValue))
      .y((row) => yScale(row.value))
      .curve(d3.curveMonotoneX);

    return line(overviewRows.priceRows) ?? "";
  }, [overviewRows, xScale, yScale]);

  const selectedX = xScale(new Date(selectedStartMs));
  const selectedWidth = xScale(new Date(selectedEndMs)) - selectedX;
  const isFullRange = selectedStartMs <= domainStartMs + dayMs && selectedEndMs >= domainEndMs - dayMs;

  function handlePointerDown(event: PointerEvent<SVGElement>, mode: DragMode) {
    event.preventDefault();
    event.stopPropagation();

    const pointerMs = pointerToMs(event);
    dragRef.current = {
      mode,
      pointerMs,
      startMs: selectedStartMs,
      endMs: selectedEndMs,
    };
    draftSelectionRef.current = {
      startMs: selectedStartMs,
      endMs: selectedEndMs,
    };
    setIsDragging(true);
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag) return;

    const pointerMs = pointerToMs(event);

    if (drag.mode === "start") {
      previewWindow(clamp(pointerMs, domainStartMs, drag.endMs - minWindowMs), drag.endMs);
      return;
    }

    if (drag.mode === "end") {
      previewWindow(drag.startMs, clamp(pointerMs, drag.startMs + minWindowMs, domainEndMs));
      return;
    }

    const delta = pointerMs - drag.pointerMs;
    const span = drag.endMs - drag.startMs;
    const nextStart = clamp(drag.startMs + delta, domainStartMs, domainEndMs - span);
    previewWindow(nextStart, nextStart + span);
  }

  function handlePointerUp(event: PointerEvent<SVGSVGElement>) {
    const draft = draftSelectionRef.current;
    dragRef.current = null;
    draftSelectionRef.current = null;
    cancelLiveChange();
    setIsDragging(false);

    if (draft) {
      commitWindow(draft.startMs, draft.endMs);
    }

    if (svgRef.current?.hasPointerCapture(event.pointerId)) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }
  }

  function handleHandleKeyDown(event: KeyboardEvent<SVGGElement>, mode: "start" | "end") {
    const keySteps: Record<string, number> = {
      ArrowLeft: -monthMs,
      ArrowRight: monthMs,
      PageDown: -yearMs,
      PageUp: yearMs,
    };
    const signedStep = keySteps[event.key];

    if (event.key === "Home") {
      event.preventDefault();
      if (mode === "start") {
        commitWindow(domainStartMs, selectedEndMs);
      } else {
        commitWindow(selectedStartMs, selectedStartMs + minWindowMs);
      }
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      if (mode === "start") {
        commitWindow(selectedEndMs - minWindowMs, selectedEndMs);
      } else {
        commitWindow(selectedStartMs, domainEndMs);
      }
      return;
    }

    if (!signedStep) return;

    event.preventDefault();
    const step = event.shiftKey && event.key.startsWith("Arrow") ? Math.sign(signedStep) * yearMs : signedStep;

    if (mode === "start") {
      commitWindow(clamp(selectedStartMs + step, domainStartMs, selectedEndMs - minWindowMs), selectedEndMs);
      return;
    }

    commitWindow(selectedStartMs, clamp(selectedEndMs + step, selectedStartMs + minWindowMs, domainEndMs));
  }

  function previewWindow(startMs: number, endMs: number) {
    const nextWindow = buildWindow(startMs, endMs);
    draftSelectionRef.current = { startMs, endMs };
    setDraftWindow(nextWindow);
    scheduleLiveChange(nextWindow);
  }

  function commitWindow(startMs: number, endMs: number) {
    const nextWindow = buildWindow(startMs, endMs);
    setDraftWindow(nextWindow);
    onChange(nextWindow);
  }

  function scheduleLiveChange(nextWindow: BrushWindow | null) {
    liveWindowRef.current = nextWindow;

    if (liveChangeRafRef.current !== null) return;

    liveChangeRafRef.current = window.requestAnimationFrame(() => {
      liveChangeRafRef.current = null;
      onChange(liveWindowRef.current);
    });
  }

  function cancelLiveChange() {
    if (liveChangeRafRef.current !== null) {
      window.cancelAnimationFrame(liveChangeRafRef.current);
      liveChangeRafRef.current = null;
    }
  }

  function buildWindow(startMs: number, endMs: number): BrushWindow | null {
    if (startMs <= domainStartMs + dayMs && endMs >= domainEndMs - dayMs) {
      return null;
    }

    return {
      startDate: fromMs(startMs),
      endDate: fromMs(endMs),
    };
  }

  function pointerToMs(event: PointerEvent<SVGElement>) {
    if (!svgRef.current) return domainStartMs;

    const rect = svgRef.current.getBoundingClientRect();
    const localX = ((event.clientX - rect.left) / rect.width) * width - margin.left;
    const ratio = clamp(localX / innerWidth, 0, 1);
    return domainStartMs + ratio * domainSpan;
  }

  return (
    <div className={`range-brush-shell ${isDragging ? "dragging" : ""}`}>
      <div className="range-brush-labels" aria-live="polite">
        <div className="range-brush-window">
          <span className="range-brush-kicker">Window</span>
          <span>{formatShortDate(fromMs(selectedStartMs))}</span>
          <span className="range-brush-divider">to</span>
          <span>{formatShortDate(fromMs(selectedEndMs))}</span>
        </div>
        <strong>{isFullRange ? "Full range" : "Custom range"}</strong>
      </div>
      <svg
        ref={svgRef}
        className="range-brush"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="group"
        aria-label="Drag handles to choose chart date range"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <g transform={`translate(${margin.left},${margin.top})`}>
          <rect className="range-brush-bg" width={innerWidth} height={innerHeight} rx="5" />
          <path className="range-brush-area" d={q50AreaPath} />
          <path className="range-brush-line" d={pricePath} />
          <rect className="range-brush-dim" x="0" y="0" width={selectedX} height={innerHeight} />
          <rect
            className="range-brush-dim"
            x={selectedX + selectedWidth}
            y="0"
            width={Math.max(0, innerWidth - selectedX - selectedWidth)}
            height={innerHeight}
          />
          <rect
            className="range-brush-selection"
            x={selectedX}
            y="0"
            width={selectedWidth}
            height={innerHeight}
            rx="4"
            onPointerDown={(event) => handlePointerDown(event, "move")}
          />
          <RangeHandle
            x={selectedX}
            label="Start date range handle"
            valueDate={fromMs(selectedStartMs)}
            minDate={domainStartDate}
            maxDate={fromMs(selectedEndMs - minWindowMs)}
            onKeyDown={(event) => handleHandleKeyDown(event, "start")}
            onPointerDown={(event) => handlePointerDown(event, "start")}
          />
          <RangeHandle
            x={selectedX + selectedWidth}
            label="End date range handle"
            valueDate={fromMs(selectedEndMs)}
            minDate={fromMs(selectedStartMs + minWindowMs)}
            maxDate={domainEndDate}
            onKeyDown={(event) => handleHandleKeyDown(event, "end")}
            onPointerDown={(event) => handlePointerDown(event, "end")}
          />
        </g>
      </svg>
    </div>
  );
}

function RangeHandle({
  x,
  label,
  valueDate,
  minDate,
  maxDate,
  onKeyDown,
  onPointerDown,
}: {
  x: number;
  label: string;
  valueDate: string;
  minDate: string;
  maxDate: string;
  onKeyDown: (event: KeyboardEvent<SVGGElement>) => void;
  onPointerDown: (event: PointerEvent<SVGGElement>) => void;
}) {
  return (
    <g
      className="range-brush-handle"
      transform={`translate(${x},0)`}
      role="slider"
      tabIndex={0}
      focusable="true"
      aria-label={label}
      aria-valuemin={toMs(minDate)}
      aria-valuemax={toMs(maxDate)}
      aria-valuenow={toMs(valueDate)}
      aria-valuetext={formatShortDate(valueDate)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      <rect className="range-brush-handle-hit" x="-13" y="-7" width="26" height={innerHeight + 14} rx="8" />
      <rect className="range-brush-handle-thumb" x="-5" y={handleThumbY} width="10" height={handleThumbHeight} rx="4" />
      <line x1="-1.5" x2="-1.5" y1={handleThumbY + 10} y2={handleThumbY + handleThumbHeight - 10} />
      <line x1="1.5" x2="1.5" y1={handleThumbY + 10} y2={handleThumbY + handleThumbHeight - 10} />
    </g>
  );
}

function toDate(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

function toMs(date: string) {
  return toDate(date).getTime();
}

function fromMs(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatShortDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(toDate(date));
}
