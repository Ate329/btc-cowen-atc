import { memo, useEffect, useMemo, useRef, type PointerEvent } from "react";
import * as d3 from "d3";
import {
  sampleExtremaRowsByXBucket,
  sampleRowsByCount,
} from "../lib/chartSampling";
import { withPathDigits } from "../lib/d3Path";
import { classifyPriceBand } from "../lib/quantileModel";
import {
  formatCompactCurrency,
  formatCurrency,
  formatDateLabel,
} from "../lib/format";
import type {
  PriceRow,
  QuantileKey,
  QuantileRow,
  QuantileValues,
} from "../lib/types";

type ChartProps = {
  prices: PriceRow[];
  quantiles: QuantileRow[];
  visibleQuantiles: Record<QuantileKey, boolean>;
};

type ParsedPrice = PriceRow & { dateValue: Date };
type ParsedQuantile = QuantileRow & { dateValue: Date };

type TooltipState = {
  x: number;
  y: number;
  date: string;
  close: number | null;
  quantile: ParsedQuantile;
  isProjected: boolean;
  index: number;
};

type QuantileLinePath = { key: QuantileKey; d: string };
type LatestPoint = { x: number; y: number };

const width = 1040;
const height = 488;
const margin = { top: 22, right: 82, bottom: 48, left: 74 };
const chartWidth = width - margin.left - margin.right;
const chartHeight = height - margin.top - margin.bottom;
const pathDigits = 1;
const quantileRenderDensity = 1.5;

const quantileColors: Record<QuantileKey, string> = {
  q1: "var(--quantile-q1)",
  q10: "var(--quantile-q10)",
  q25: "var(--quantile-q25)",
  q50: "var(--quantile-q50)",
  q75: "var(--quantile-q75)",
  q95: "var(--quantile-q95)",
  q99: "var(--quantile-q99)",
};

const bands: Array<{
  lower: QuantileKey;
  upper: QuantileKey;
  className: string;
}> = [
  { lower: "q1", upper: "q10", className: "band band-green-1" },
  { lower: "q10", upper: "q25", className: "band band-green-2" },
  { lower: "q25", upper: "q50", className: "band band-amber-1" },
  { lower: "q50", upper: "q75", className: "band band-amber-2" },
  { lower: "q75", upper: "q95", className: "band band-red-1" },
  { lower: "q95", upper: "q99", className: "band band-red-2" },
];

const quantileLabelRows: Array<{ key: QuantileKey; label: string }> = [
  { key: "q1", label: "Q1" },
  { key: "q10", label: "Q10" },
  { key: "q25", label: "Q25" },
  { key: "q50", label: "Q50" },
  { key: "q75", label: "Q75" },
  { key: "q95", label: "Q95" },
  { key: "q99", label: "Q99" },
];

const tooltipLayout = {
  width: 190,
  height: 196,
  titleY: 24,
  closeY: 52,
  bandY: 75,
  rowStartY: 96,
  rowGap: 15,
};

type BandPath = (typeof bands)[number] & { d: string };

export const QuantileChart = memo(function QuantileChart({
  prices,
  quantiles,
  visibleQuantiles,
}: ChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const tooltipLayerRef = useRef<SVGGElement | null>(null);
  const tooltipBoxGroupRef = useRef<SVGGElement | null>(null);
  const hoverDotRef = useRef<SVGCircleElement | null>(null);
  const tooltipTitleRef = useRef<SVGTextElement | null>(null);
  const tooltipValueRef = useRef<SVGTextElement | null>(null);
  const tooltipBandRef = useRef<SVGTextElement | null>(null);
  const tooltipQuantileRefs = useRef<Array<SVGTextElement | null>>([]);
  const tooltipRafRef = useRef<number | null>(null);
  const pendingTooltipRef = useRef<TooltipState | null>(null);
  const lastTooltipDateRef = useRef("");
  const lastTooltipIndexRef = useRef(-1);
  const pendingTooltipIndexRef = useRef(-1);

  useEffect(() => {
    return () => {
      if (tooltipRafRef.current !== null) {
        window.cancelAnimationFrame(tooltipRafRef.current);
      }
      pendingTooltipRef.current = null;
      lastTooltipDateRef.current = "";
      lastTooltipIndexRef.current = -1;
      pendingTooltipIndexRef.current = -1;
    };
  }, []);

  const parsedPrices = useMemo(
    () =>
      prices.map((price) => ({ ...price, dateValue: parseDate(price.date) })),
    [prices],
  );

  const parsedQuantiles = useMemo(
    () => quantiles.map((row) => ({ ...row, dateValue: parseDate(row.date) })),
    [quantiles],
  );

  const quantileTimes = useMemo(
    () => parsedQuantiles.map((row) => row.dateValue.getTime()),
    [parsedQuantiles],
  );

  const closeByDate = useMemo(() => {
    const map = new Map<string, ParsedPrice>();
    parsedPrices.forEach((price) => map.set(price.date, price));
    return map;
  }, [parsedPrices]);

  const xDomain = useMemo<[Date, Date]>(() => {
    const first =
      parsedQuantiles[0]?.dateValue ?? parsedPrices[0]?.dateValue ?? new Date();
    const last =
      parsedQuantiles.at(-1)?.dateValue ??
      parsedPrices.at(-1)?.dateValue ??
      new Date();
    return [first, last];
  }, [parsedPrices, parsedQuantiles]);

  const yDomain = useMemo<[number, number]>(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const visibleKeys = Object.keys(visibleQuantiles) as QuantileKey[];

    for (const price of parsedPrices) {
      if (Number.isFinite(price.close) && price.close > 0) {
        min = Math.min(min, price.close);
        max = Math.max(max, price.close);
      }
    }

    for (const row of parsedQuantiles) {
      for (const key of visibleKeys) {
        if (!visibleQuantiles[key]) continue;

        const value = row[key];
        if (Number.isFinite(value) && value > 0) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 1;
      max = 100_000;
    }

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

  const xDomainMs = useMemo<[number, number]>(
    () => [xDomain[0].getTime(), xDomain[1].getTime()],
    [xDomain],
  );

  const hoverPoints = useMemo<TooltipState[]>(() => {
    return parsedQuantiles.map((quantile, index) => {
      const observedPrice = closeByDate.get(quantile.date);
      const isProjected = !observedPrice;
      const close = observedPrice?.close ?? null;

      return {
        x: xScale(quantile.dateValue),
        y: yScale(close ?? quantile.q50),
        date: quantile.date,
        close,
        quantile,
        isProjected,
        index,
      };
    });
  }, [closeByDate, parsedQuantiles, xScale, yScale]);

  useEffect(() => {
    hideTooltip();
  }, [hoverPoints]);

  const xTicks = useMemo(() => xScale.ticks(7), [xScale]);
  const yTicks = useMemo(() => {
    const [min, max] = yDomain;
    return [
      0.01, 0.1, 1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000,
    ].filter((tick) => tick >= min && tick <= max);
  }, [yDomain]);

  const renderPrices = useMemo(
    () =>
      sampleExtremaRowsByXBucket(
        parsedPrices,
        (row) => xScale(row.dateValue),
        (row) => row.close,
        Math.ceil(chartWidth),
      ),
    [parsedPrices, xScale],
  );

  const renderQuantiles = useMemo(
    () =>
      sampleRowsByCount(
        parsedQuantiles,
        Math.ceil(chartWidth * quantileRenderDensity),
      ),
    [parsedQuantiles],
  );

  const pricePath = useMemo(() => {
    const line = withPathDigits(
      d3
        .line<ParsedPrice>()
        .defined((d) => Number.isFinite(d.close) && d.close > 0)
        .x((d) => xScale(d.dateValue))
        .y((d) => yScale(d.close))
        .curve(d3.curveMonotoneX),
      pathDigits,
    );

    return line(renderPrices) ?? "";
  }, [renderPrices, xScale, yScale]);

  const quantilePaths = useMemo(() => {
    return (Object.keys(visibleQuantiles) as QuantileKey[]).map((key) => {
      if (!visibleQuantiles[key]) return { key, d: "" };

      const line = withPathDigits(
        d3
          .line<ParsedQuantile>()
          .x((d) => xScale(d.dateValue))
          .y((d) => yScale(d[key]))
          .curve(d3.curveMonotoneX),
        pathDigits,
      );

      return { key, d: line(renderQuantiles) ?? "" };
    });
  }, [renderQuantiles, visibleQuantiles, xScale, yScale]);

  const bandPaths = useMemo(() => {
    return bands.map((band) => {
      if (!visibleQuantiles[band.lower] || !visibleQuantiles[band.upper]) {
        return { ...band, d: "" };
      }

      const area = withPathDigits(
        d3
          .area<ParsedQuantile>()
          .x((d) => xScale(d.dateValue))
          .y0((d) => yScale(d[band.lower]))
          .y1((d) => yScale(d[band.upper]))
          .curve(d3.curveMonotoneX),
        pathDigits,
      );

      return { ...band, d: area(renderQuantiles) ?? "" };
    });
  }, [renderQuantiles, visibleQuantiles, xScale, yScale]);

  const latestPrice = parsedPrices.at(-1);
  const latestPoint = useMemo<LatestPoint | null>(
    () =>
      latestPrice
        ? { x: xScale(latestPrice.dateValue), y: yScale(latestPrice.close) }
        : null,
    [latestPrice, xScale, yScale],
  );

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!svgRef.current || hoverPoints.length === 0) return;

    const [rawX, rawY] = d3.pointer(event, svgRef.current);
    const localX = rawX - margin.left;
    const localY = rawY - margin.top;

    if (
      localX < 0 ||
      localX > chartWidth ||
      localY < 0 ||
      localY > chartHeight
    ) {
      return;
    }

    const [startTime, endTime] = xDomainMs;
    const hoveredTime =
      startTime + (localX / chartWidth) * (endTime - startTime);
    const index = d3.bisectCenter(quantileTimes, hoveredTime);
    const clampedIndex = Math.max(0, Math.min(index, hoverPoints.length - 1));

    if (
      clampedIndex === lastTooltipIndexRef.current ||
      clampedIndex === pendingTooltipIndexRef.current
    ) {
      return;
    }

    scheduleTooltip(hoverPoints[clampedIndex]);
  }

  function scheduleTooltip(nextTooltip: TooltipState) {
    if (
      lastTooltipIndexRef.current === nextTooltip.index ||
      pendingTooltipIndexRef.current === nextTooltip.index
    ) {
      return;
    }

    pendingTooltipRef.current = nextTooltip;
    pendingTooltipIndexRef.current = nextTooltip.index;

    if (tooltipRafRef.current !== null) return;

    tooltipRafRef.current = window.requestAnimationFrame(() => {
      tooltipRafRef.current = null;

      const pendingTooltip = pendingTooltipRef.current;
      pendingTooltipRef.current = null;
      pendingTooltipIndexRef.current = -1;

      if (
        !pendingTooltip ||
        lastTooltipIndexRef.current === pendingTooltip.index
      )
        return;

      lastTooltipIndexRef.current = pendingTooltip.index;
      lastTooltipDateRef.current = pendingTooltip.date;
      renderTooltip(pendingTooltip);
    });
  }

  function handlePointerLeave() {
    hideTooltip();
  }

  function hideTooltip() {
    if (tooltipRafRef.current !== null) {
      window.cancelAnimationFrame(tooltipRafRef.current);
      tooltipRafRef.current = null;
    }

    pendingTooltipRef.current = null;
    lastTooltipDateRef.current = "";
    lastTooltipIndexRef.current = -1;
    pendingTooltipIndexRef.current = -1;
    tooltipLayerRef.current?.setAttribute("visibility", "hidden");
  }

  function renderTooltip(nextTooltip: TooltipState) {
    const tooltipLayer = tooltipLayerRef.current;
    const tooltipBoxGroup = tooltipBoxGroupRef.current;
    const hoverDot = hoverDotRef.current;
    const title = tooltipTitleRef.current;
    const value = tooltipValueRef.current;
    const band = tooltipBandRef.current;

    if (
      !tooltipLayer ||
      !tooltipBoxGroup ||
      !hoverDot ||
      !title ||
      !value ||
      !band
    )
      return;

    const boxX =
      Math.min(nextTooltip.x + 14, chartWidth - tooltipLayout.width) -
      nextTooltip.x;
    const boxY = Math.max(
      8,
      Math.min(
        nextTooltip.y - tooltipLayout.height / 2,
        chartHeight - tooltipLayout.height - 8,
      ),
    );

    tooltipLayer.setAttribute("visibility", "visible");
    tooltipLayer.setAttribute("transform", `translate(${nextTooltip.x},0)`);
    hoverDot.setAttribute("cy", String(nextTooltip.y));
    tooltipBoxGroup.setAttribute("transform", `translate(${boxX},${boxY})`);

    const quantileValues = toQuantileValues(nextTooltip.quantile);
    const close = nextTooltip.close ?? quantileValues.q50;

    title.textContent = formatDateLabel(nextTooltip.date);
    value.textContent = `Close ${formatCurrency(close)}${nextTooltip.isProjected ? " (est.)" : ""}`;
    band.textContent = nextTooltip.isProjected
      ? "Band N/A (projection)"
      : classifyPriceBand(close, quantileValues);

    quantileLabelRows.forEach((quantileRow, index) => {
      const row = tooltipQuantileRefs.current[index];
      if (row)
        row.textContent = `${quantileRow.label} ${formatCurrency(quantileValues[quantileRow.key])}`;
    });
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
          <stop offset="0%" stopColor="var(--price-stroke-start)" />
          <stop offset="100%" stopColor="var(--price-stroke-end)" />
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

        <g
          ref={tooltipLayerRef}
          className="tooltip-layer"
          visibility="hidden"
          transform="translate(0,0)"
        >
          <line className="crosshair" y1="0" y2={chartHeight} />
          <circle ref={hoverDotRef} className="hover-dot" cy="0" r="5" />
          <g ref={tooltipBoxGroupRef} transform="translate(0,0)">
            <rect
              className="tooltip-box"
              width={tooltipLayout.width}
              height={tooltipLayout.height}
              rx="4"
            />
            <text
              ref={tooltipTitleRef}
              className="tooltip-title"
              x="14"
              y={tooltipLayout.titleY}
            />
            <text
              ref={tooltipValueRef}
              className="tooltip-value"
              x="14"
              y={tooltipLayout.closeY}
            />
            <text
              ref={tooltipBandRef}
              className="tooltip-copy"
              x="14"
              y={tooltipLayout.bandY}
            />
            {quantileLabelRows.map((row, index) => (
              <text
                className="tooltip-copy"
                key={row.key}
                ref={(node) => {
                  tooltipQuantileRefs.current[index] = node;
                }}
                x="14"
                y={tooltipLayout.rowStartY + index * tooltipLayout.rowGap}
              />
            ))}
          </g>
        </g>
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
      <rect
        className="plot-bg"
        width={chartWidth}
        height={chartHeight}
        rx="6"
      />

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
          <text
            className="axis-label x-label"
            y={chartHeight + 30}
            textAnchor="middle"
          >
            {d3.utcFormat("%Y")(tick)}
          </text>
        </g>
      ))}

      {bandPaths.map((band) =>
        band.d ? (
          <path
            key={`${band.lower}-${band.upper}`}
            className={band.className}
            d={band.d}
          />
        ) : null,
      )}

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
