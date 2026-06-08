import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import * as d3 from "d3";
import { classifyPriceBand } from "../lib/quantileModel";
import { formatCompactCurrency, formatCurrency, formatDateLabel } from "../lib/format";
import type { PriceRow, QuantileKey, QuantileRow, QuantileValues } from "../lib/types";

type ChartProps = {
  prices: PriceRow[];
  quantiles: QuantileRow[];
  visibleQuantiles: Record<QuantileKey, boolean>;
};

type ParsedPrice = PriceRow & { dateValue: Date };
type ParsedQuantile = QuantileRow & { dateValue: Date };
type QuantilePathRow = ParsedQuantile & { current: number };

type TooltipState = {
  x: number;
  y: number;
  date: string;
  close: number;
  quantiles: QuantileValues;
  band: string;
};

type QuantileLinePath = { key: QuantileKey; d: string };
type LatestPoint = { x: number; y: number };

const width = 1040;
const height = 488;
const margin = { top: 22, right: 82, bottom: 48, left: 74 };
const chartWidth = width - margin.left - margin.right;
const chartHeight = height - margin.top - margin.bottom;

const quantileColors: Record<QuantileKey, string> = {
  q1: "#087f5b",
  q10: "#2f9e44",
  q25: "#74b816",
  q50: "#c9911f",
  q75: "#e67700",
  q95: "#d9480f",
  q99: "#b42318",
};

const bands: Array<{ lower: QuantileKey; upper: QuantileKey; className: string }> = [
  { lower: "q1", upper: "q10", className: "band band-green-1" },
  { lower: "q10", upper: "q25", className: "band band-green-2" },
  { lower: "q25", upper: "q50", className: "band band-amber-1" },
  { lower: "q50", upper: "q75", className: "band band-amber-2" },
  { lower: "q75", upper: "q95", className: "band band-red-1" },
  { lower: "q95", upper: "q99", className: "band band-red-2" },
];

type BandPath = (typeof bands)[number] & { d: string };

export const QuantileChart = memo(function QuantileChart({ prices, quantiles, visibleQuantiles }: ChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const tooltipRafRef = useRef<number | null>(null);
  const pendingTooltipRef = useRef<TooltipState | null>(null);
  const lastTooltipDateRef = useRef("");
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    return () => {
      if (tooltipRafRef.current !== null) {
        window.cancelAnimationFrame(tooltipRafRef.current);
      }
    };
  }, []);

  const parsedPrices = useMemo(
    () => prices.map((price) => ({ ...price, dateValue: parseDate(price.date) })),
    [prices],
  );

  const parsedQuantiles = useMemo(
    () => quantiles.map((row) => ({ ...row, dateValue: parseDate(row.date) })),
    [quantiles],
  );

  const quantileByDate = useMemo(() => {
    const map = new Map<string, QuantileRow>();
    quantiles.forEach((row) => map.set(row.date, row));
    return map;
  }, [quantiles]);

  const xDomain = useMemo<[Date, Date]>(() => {
    const first = parsedQuantiles[0]?.dateValue ?? parsedPrices[0]?.dateValue ?? new Date();
    const last = parsedQuantiles.at(-1)?.dateValue ?? parsedPrices.at(-1)?.dateValue ?? new Date();
    return [first, last];
  }, [parsedPrices, parsedQuantiles]);

  const yDomain = useMemo<[number, number]>(() => {
    const values = [
      ...parsedPrices.map((price) => price.close),
      ...parsedQuantiles.flatMap((row) =>
        (Object.keys(visibleQuantiles) as QuantileKey[])
          .filter((key) => visibleQuantiles[key])
          .map((key) => row[key]),
      ),
    ].filter((value) => Number.isFinite(value) && value > 0);

    const min = d3.min(values) ?? 1;
    const max = d3.max(values) ?? 100_000;

    return [min * 0.72, max * 1.26];
  }, [parsedPrices, parsedQuantiles, visibleQuantiles]);

  const xScale = useMemo(
    () => d3.scaleUtc().domain(xDomain).range([0, chartWidth]),
    [xDomain],
  );

  const yScale = useMemo(
    () => d3.scaleLog().domain(yDomain).range([chartHeight, 0]).clamp(true),
    [yDomain],
  );

  const xTicks = useMemo(() => xScale.ticks(7), [xScale]);
  const yTicks = useMemo(() => {
    const [min, max] = yDomain;
    return [0.01, 0.1, 1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000].filter(
      (tick) => tick >= min && tick <= max,
    );
  }, [yDomain]);

  const pricePath = useMemo(() => {
    const line = d3
      .line<ParsedPrice>()
      .defined((d) => Number.isFinite(d.close) && d.close > 0)
      .x((d) => xScale(d.dateValue))
      .y((d) => yScale(d.close))
      .curve(d3.curveMonotoneX);

    return line(parsedPrices) ?? "";
  }, [parsedPrices, xScale, yScale]);

  const quantilePaths = useMemo(() => {
    const line = d3
      .line<QuantilePathRow>()
      .x((d) => xScale(d.dateValue))
      .y((d) => yScale(d.current))
      .curve(d3.curveMonotoneX);

    return (Object.keys(visibleQuantiles) as QuantileKey[]).map((key) => {
      const rows = parsedQuantiles.map((row) => ({ ...row, current: row[key] }));
      return { key, d: visibleQuantiles[key] ? line(rows) ?? "" : "" };
    });
  }, [parsedQuantiles, visibleQuantiles, xScale, yScale]);

  const bandPaths = useMemo(() => {
    return bands.map((band) => {
      if (!visibleQuantiles[band.lower] || !visibleQuantiles[band.upper]) {
        return { ...band, d: "" };
      }

      const area = d3
        .area<ParsedQuantile>()
        .x((d) => xScale(d.dateValue))
        .y0((d) => yScale(d[band.lower]))
        .y1((d) => yScale(d[band.upper]))
        .curve(d3.curveMonotoneX);

      return { ...band, d: area(parsedQuantiles) ?? "" };
    });
  }, [parsedQuantiles, visibleQuantiles, xScale, yScale]);

  const latestPrice = parsedPrices.at(-1);
  const latestQuantile = latestPrice ? quantileByDate.get(latestPrice.date) : undefined;
  const latestPoint = useMemo<LatestPoint | null>(
    () => (latestPrice ? { x: xScale(latestPrice.dateValue), y: yScale(latestPrice.close) } : null),
    [latestPrice, xScale, yScale],
  );

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!svgRef.current || parsedPrices.length === 0) return;

    const [rawX, rawY] = d3.pointer(event, svgRef.current);
    const localX = rawX - margin.left;
    const localY = rawY - margin.top;

    if (localX < 0 || localX > chartWidth || localY < 0 || localY > chartHeight) {
      return;
    }

    const date = xScale.invert(localX);
    const bisect = d3.bisector<ParsedPrice, Date>((d) => d.dateValue).center;
    const index = bisect(parsedPrices, date);
    const price = parsedPrices[Math.max(0, Math.min(index, parsedPrices.length - 1))];
    const qRow = quantileByDate.get(price.date) ?? latestQuantile;

    if (!qRow) return;

    const values = toQuantileValues(qRow);
    scheduleTooltip({
      x: xScale(price.dateValue),
      y: yScale(price.close),
      date: price.date,
      close: price.close,
      quantiles: values,
      band: classifyPriceBand(price.close, values),
    });
  }

  function scheduleTooltip(nextTooltip: TooltipState) {
    if (lastTooltipDateRef.current === nextTooltip.date) return;

    pendingTooltipRef.current = nextTooltip;

    if (tooltipRafRef.current !== null) return;

    tooltipRafRef.current = window.requestAnimationFrame(() => {
      tooltipRafRef.current = null;

      const pendingTooltip = pendingTooltipRef.current;
      pendingTooltipRef.current = null;

      if (!pendingTooltip || lastTooltipDateRef.current === pendingTooltip.date) return;

      lastTooltipDateRef.current = pendingTooltip.date;
      setTooltip(pendingTooltip);
    });
  }

  function handlePointerLeave() {
    if (tooltipRafRef.current !== null) {
      window.cancelAnimationFrame(tooltipRafRef.current);
      tooltipRafRef.current = null;
    }

    pendingTooltipRef.current = null;
    lastTooltipDateRef.current = "";
    setTooltip(null);
  }

  return (
    <svg
      ref={svgRef}
      className="quantile-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Log scale Bitcoin price chart with asymmetric quantile model bands."
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <defs>
        <linearGradient id="priceStroke" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#222" />
          <stop offset="100%" stopColor="#8a3f12" />
        </linearGradient>
      </defs>

      <g transform={`translate(${margin.left},${margin.top})`}>
        <StaticChartLayers
          xScale={xScale}
          yScale={yScale}
          xTicks={xTicks}
          yTicks={yTicks}
          bandPaths={bandPaths}
          quantilePaths={quantilePaths}
          pricePath={pricePath}
          latestPoint={latestPoint}
        />

        {tooltip ? (
          <g className="tooltip-layer" transform={`translate(${tooltip.x},0)`}>
            <line className="crosshair" y1="0" y2={chartHeight} />
            <circle className="hover-dot" cy={tooltip.y} r="5" />
            <g transform={`translate(${Math.min(tooltip.x + 14, chartWidth - 210) - tooltip.x},${Math.max(18, tooltip.y - 76)})`}>
              <rect className="tooltip-box" width="198" height="94" rx="6" />
              <text className="tooltip-title" x="12" y="22">
                {formatDateLabel(tooltip.date)}
              </text>
              <text className="tooltip-value" x="12" y="45">
                Close {formatCurrency(tooltip.close)}
              </text>
              <text className="tooltip-copy" x="12" y="66">
                {tooltip.band}
              </text>
              <text className="tooltip-copy" x="12" y="84">
                Q50 {formatCurrency(tooltip.quantiles.q50)}
              </text>
            </g>
          </g>
        ) : null}
      </g>
    </svg>
  );
});

const StaticChartLayers = memo(function StaticChartLayers({
  xScale,
  yScale,
  xTicks,
  yTicks,
  bandPaths,
  quantilePaths,
  pricePath,
  latestPoint,
}: {
  xScale: d3.ScaleTime<number, number>;
  yScale: d3.ScaleLogarithmic<number, number>;
  xTicks: Date[];
  yTicks: number[];
  bandPaths: BandPath[];
  quantilePaths: QuantileLinePath[];
  pricePath: string;
  latestPoint: LatestPoint | null;
}) {
  return (
    <>
      <rect className="plot-bg" width={chartWidth} height={chartHeight} rx="6" />

      {yTicks.map((tick) => (
        <g key={tick} transform={`translate(0,${yScale(tick)})`}>
          <line className="grid-line" x1="0" x2={chartWidth} />
          <text className="axis-label y-label" x="-14" y="4" textAnchor="end">
            {formatCompactCurrency(tick)}
          </text>
        </g>
      ))}

      {xTicks.map((tick) => (
        <g key={tick.toISOString()} transform={`translate(${xScale(tick)},0)`}>
          <line className="x-tick-line" y1={chartHeight} y2={chartHeight + 7} />
          <text className="axis-label x-label" y={chartHeight + 30} textAnchor="middle">
            {d3.utcFormat("%Y")(tick)}
          </text>
        </g>
      ))}

      {bandPaths.map((band) => (band.d ? <path key={`${band.lower}-${band.upper}`} className={band.className} d={band.d} /> : null))}

      {quantilePaths.map(({ key, d }) =>
        d ? (
          <path
            key={key}
            className="quantile-line"
            d={d}
            stroke={quantileColors[key]}
            strokeDasharray={key === "q50" ? "0" : "4 5"}
          />
        ) : null,
      )}

      <path className="price-line" d={pricePath} />

      {latestPoint ? (
        <g transform={`translate(${latestPoint.x},${latestPoint.y})`}>
          <circle className="latest-dot" r="4.5" />
        </g>
      ) : null}
    </>
  );
});

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toQuantileValues(row: QuantileRow): QuantileValues {
  return {
    q1: row.q1,
    q10: row.q10,
    q25: row.q25,
    q50: row.q50,
    q75: row.q75,
    q95: row.q95,
    q99: row.q99,
  };
}
