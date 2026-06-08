import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ExternalLink,
  LineChart,
  RefreshCw,
  Sigma,
} from "lucide-react";
import modelConfig from "./data/model-config.json";
import { QuantileChart } from "./components/QuantileChart";
import { RangeBrush, type BrushWindow } from "./components/RangeBrush";
import { useBtcData } from "./lib/useBtcData";
import {
  classifyPriceBand,
  distanceToLevel,
  estimateModel,
  quantileKeys,
} from "./lib/quantileModel";
import {
  formatCurrency,
  formatDateLabel,
  formatNumber,
  formatPercent,
} from "./lib/format";
import type {
  ModelMode,
  ModelParameter,
  PriceRow,
  QuantileKey,
  QuantileModelResult,
  QuantileRow,
  QuantileValues,
} from "./lib/types";

type RangeKey = "all" | "10y" | "5y" | "2y";

const projectionOptions = [
  { years: 0, label: "None" },
  { years: 5, label: "5Y" },
  { years: 10, label: "10Y" },
  { years: 15, label: "15Y" },
  { years: 20, label: "20Y" },
  { years: 25, label: "25Y" },
];

const ranges: Array<{ key: RangeKey; label: string; years: number | null }> = [
  { key: "all", label: "All", years: null },
  { key: "10y", label: "10Y", years: 10 },
  { key: "5y", label: "5Y", years: 5 },
  { key: "2y", label: "2Y", years: 2 },
];

const modelModes: Array<{ key: ModelMode; label: string }> = [
  { key: "paper", label: "Paper ATC" },
  { key: "asymmetricRefit", label: "ATC Refit" },
  { key: "linearRegression", label: "Linear QR" },
  { key: "symmetricQuadratic", label: "Sym Quad" },
  { key: "stretchedExponential", label: "Stretch Exp" },
];

const defaultVisibleQuantiles = quantileKeys.reduce(
  (state, key) => ({ ...state, [key]: true }),
  {} as Record<QuantileKey, boolean>,
);

function App() {
  const dataState = useBtcData();
  const modelCacheRef = useRef(new Map<string, QuantileModelResult>());
  const [modelMode, setModelMode] = useState<ModelMode>("paper");
  const [range, setRange] = useState<RangeKey>("all");
  const [projectionYears, setProjectionYears] = useState(0);
  const [brushWindow, setBrushWindow] = useState<BrushWindow | null>(null);
  const [visibleQuantiles, setVisibleQuantiles] = useState(
    defaultVisibleQuantiles,
  );
  const [, startBrushTransition] = useTransition();

  const activeModel = useMemo(() => {
    if (dataState.status !== "ready") return null;

    const cacheKey = [
      modelMode,
      dataState.data.metadata.latestCloseDate,
      dataState.data.prices.length,
      dataState.data.quantiles.length,
    ].join(":");
    const cached = modelCacheRef.current.get(cacheKey);

    if (cached) {
      return cached;
    }

    const model = estimateModel(
      modelMode,
      dataState.data.prices,
      dataState.data.metadata.startDate,
      dataState.data.metadata.projectionEndDate,
      dataState.data.quantiles,
    );
    modelCacheRef.current.set(cacheKey, model);
    return model;
  }, [dataState, modelMode]);

  const baseChartData = useMemo(() => {
    if (dataState.status !== "ready" || !activeModel) return null;

    const latestDate = dataState.data.metadata.latestCloseDate;
    const startDate = getRangeStart(latestDate, range);
    const endDate = getProjectionEndDate(
      latestDate,
      projectionYears,
      dataState.data.metadata.projectionEndDate,
    );

    return {
      startDate,
      endDate,
      latestDate,
      prices: filterRows(dataState.data.prices, startDate, latestDate),
      quantiles: filterRows(activeModel.quantiles, startDate, endDate),
    };
  }, [activeModel, dataState, range, projectionYears]);

  const chartData = useMemo(() => {
    if (!baseChartData) return null;

    const startDate = brushWindow?.startDate ?? baseChartData.startDate;
    const endDate = brushWindow?.endDate ?? baseChartData.endDate;

    return {
      prices: filterRows(
        baseChartData.prices,
        startDate,
        minDate(endDate, baseChartData.latestDate),
      ),
      quantiles: filterRows(baseChartData.quantiles, startDate, endDate),
    };
  }, [baseChartData, brushWindow]);

  const latest = useMemo(() => {
    if (dataState.status !== "ready" || !activeModel) return null;

    const latestPrice = dataState.data.prices.at(-1);
    if (!latestPrice) return null;

    const latestQuantile = activeModel.quantiles.find(
      (row) => row.date === latestPrice.date,
    );
    if (!latestQuantile) return null;

    const values = toQuantileValues(latestQuantile);
    return {
      price: latestPrice,
      quantiles: values,
      band: classifyPriceBand(latestPrice.close, values),
    };
  }, [activeModel, dataState]);

  function toggleQuantile(key: QuantileKey) {
    setVisibleQuantiles((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }

  const handleBrushChange = useCallback(
    (value: BrushWindow | null) => {
      startBrushTransition(() => {
        setBrushWindow(value);
      });
    },
    [startBrushTransition],
  );

  return (
    <div className="app">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="BTC Cowen ATC home">
          <LineChart size={22} />
          <span>BTC Cowen ATC</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#model">Model</a>
          <a href="#evidence">Evidence</a>
          <a href="#paper">Paper</a>
          <a href="#caveats">Caveats</a>
          <a className="nav-button-link" href="/?page=about">About</a>
        </nav>
      </header>

      <main id="top">
        <section className="hero-section">
          <div className="hero-copy">
            <h1>Bitcoin price through asymmetric quantile bands</h1>
            <p>
              A visual reading of lower-tail support and upper-tail compression
              from Cowen's 2026 working paper.
            </p>
          </div>

          <div className="stat-ribbon" aria-label="Model curvature summary">
            {activeModel
              ? activeModel.metrics.map((metric, index) => (
                <Metric
                  key={metric.label}
                  icon={index === 1 ? <Activity size={17} /> : <Sigma size={17} />}
                  label={metric.label}
                  value={metric.value}
                />
              ))
              : null}
            {dataState.status === "ready" ? (
              <Metric
                icon={<RefreshCw size={17} />}
                label="Snapshot"
                value={formatDateLabel(dataState.data.metadata.latestCloseDate)}
              />
            ) : null}
          </div>

          <div className="dashboard-strip">
            {latest ? (
              <>
                <DashboardTile
                  label="Latest close"
                  value={formatCurrency(latest.price.close)}
                  detail={formatDateLabel(latest.price.date)}
                />
                <DashboardTile
                  label="Current band"
                  value={latest.band}
                  detail="Observed close vs model quantiles"
                />
                <DashboardTile
                  label="Distance to Q1"
                  value={formatPercent(
                    distanceToLevel(latest.price.close, latest.quantiles.q1),
                  )}
                  detail={formatCurrency(latest.quantiles.q1)}
                />
                <DashboardTile
                  label="Distance to Q50"
                  value={formatPercent(
                    distanceToLevel(latest.price.close, latest.quantiles.q50),
                  )}
                  detail={formatCurrency(latest.quantiles.q50)}
                />
                <DashboardTile
                  label="Distance to Q99"
                  value={formatPercent(
                    distanceToLevel(latest.price.close, latest.quantiles.q99),
                  )}
                  detail={formatCurrency(latest.quantiles.q99)}
                />
              </>
            ) : (
              <DashboardTile
                label="Loading"
                value="BTC history"
                detail="Preparing chart data"
              />
            )}
          </div>

          <section
            className="chart-panel"
            aria-label="BTC asymmetric quantile chart"
          >
            <div className="chart-toolbar">
              <div className="toolbar-left">
                <div className="segmented-control" aria-label="Model mode">
                  {modelModes.map((item) => (
                    <button
                      key={item.key}
                      className={modelMode === item.key ? "active" : ""}
                      type="button"
                      aria-pressed={modelMode === item.key}
                      onClick={() => {
                        setModelMode(item.key);
                        setBrushWindow(null);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <div className="segmented-control" aria-label="Date range">
                  {ranges.map((item) => (
                    <button
                      key={item.key}
                      className={range === item.key ? "active" : ""}
                      type="button"
                      onClick={() => {
                        setRange(item.key);
                        setBrushWindow(null);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="chart-action-group">
                <div
                  className="projection-control"
                  aria-label="Projection horizon"
                >
                  <span className="projection-label">
                    <CalendarDays size={17} />
                    <span>Projection</span>
                  </span>
                  <div
                    className="projection-options"
                    role="radiogroup"
                    aria-label="Projection horizon"
                  >
                    {projectionOptions.map((option) => (
                      <button
                        key={option.years}
                        type="button"
                        className={
                          projectionYears === option.years ? "active" : ""
                        }
                        aria-pressed={projectionYears === option.years}
                        onClick={() => {
                          setProjectionYears(option.years);
                          setBrushWindow(null);
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="quantile-toggles" aria-label="Quantile visibility">
              {(activeModel?.coefficients ?? modelConfig.coefficients).map(
                (coefficient) => (
                  <button
                    key={coefficient.key}
                    className={
                      visibleQuantiles[coefficient.key as QuantileKey]
                        ? "active"
                        : ""
                    }
                    type="button"
                    onClick={() =>
                      toggleQuantile(coefficient.key as QuantileKey)
                    }
                  >
                    {coefficient.label}
                  </button>
                ),
              )}
            </div>

            <div className="chart-frame">
              {dataState.status === "ready" && chartData ? (
                <QuantileChart
                  prices={chartData.prices}
                  quantiles={chartData.quantiles}
                  visibleQuantiles={visibleQuantiles}
                />
              ) : dataState.status === "error" ? (
                <div className="chart-state error-state">
                  <AlertTriangle size={28} />
                  <strong>Data snapshot unavailable</strong>
                  <span>{dataState.error}</span>
                </div>
              ) : (
                <div className="chart-state">
                  <RefreshCw className="spin" size={28} />
                  <strong>Loading BTC quantile snapshot</strong>
                </div>
              )}
            </div>

            {dataState.status === "ready" && baseChartData ? (
              <RangeBrush
                prices={baseChartData.prices}
                quantiles={baseChartData.quantiles}
                domainStartDate={baseChartData.startDate}
                domainEndDate={baseChartData.endDate}
                value={brushWindow}
                onChange={handleBrushChange}
              />
            ) : null}
          </section>
        </section>

        <section id="model" className="content-section model-section">
          <div>
            <h2>Model</h2>
            <p>
              Cowen's report asks whether Bitcoin's upper and lower price tails
              have changed differently across market cycles. The core finding is
              asymmetric curvature: the upper tail bends inward over time, while
              the lower tail remains close to a straight-line power law.
            </p>
          </div>
          <div className="formula-box" aria-label="Model formula">
            <code>{activeModel?.formula ?? "log10(P_tau(t)) = c_tau + a_tau x + b_tau x^2"}</code>
            <span>{activeModel?.note ?? "x = ln(days since genesis) - 7.9914"}</span>
          </div>
        </section>

        <section className="content-section paper-use-section">
          <div>
            <h2>How this site uses the paper</h2>
            <p>
              The default view is a visual companion, not a re-estimation
              engine. It takes the published Table 3 parameters as fixed inputs,
              computes each quantile band by date, and overlays those bands on
              BTC/USD daily closes starting in 2012. The comparison modes fit
              Cowen-related model forms on the same site snapshot.
            </p>
          </div>
          <div className="paper-use-list">
            <p>
              Historical price rows come from the daily BTC/USD data snapshot
              generated for this site. The model rows in paper mode come from
              the report's centered quadratic equation, using the January 1,
              2009 genesis anchor and the centering value 7.9914. The fitted
              modes reuse the paper's log10 close response, log-time variables,
              quantile levels, check-loss fitting where applicable, and
              monotone rearrangement.
            </p>
            <p>
              After the seven raw quantile estimates are computed for a date,
              they are sorted into monotone order so the plotted Q1 through Q99
              bands do not cross on the chart grid.
            </p>
          </div>
        </section>

        <section id="evidence" className="content-section evidence-section">
          <div>
            <h2>Evidence</h2>
            <p>
              The visual contrast is the paper's central claim: lower-tail
              curvature is near linear, while upper-tail curvature bends
              downward more strongly as BTC's market scale grows.
            </p>
          </div>
          <div className="evidence-grid">
            <EvidencePoint
              label="Lower tail"
              value="-0.0241"
              detail="bLO, not statistically distinguishable from zero in the paper's bootstrap table."
            />
            <EvidencePoint
              label="Upper tail"
              value="-0.3259"
              detail="bHI, significantly negative in the paper's block-bootstrap result."
            />
            <EvidencePoint
              label="Asymmetry"
              value="-0.3018"
              detail="Delta b = bHI - bLO, reported as significantly negative."
            />
          </div>
        </section>

        <section id="paper" className="content-section coefficients-section">
          <div className="section-heading-row">
            <div>
              <h2>
                {activeModel ? `${activeModel.label} Coefficients` : "Model Coefficients"}
              </h2>
              <p>
                {activeModel?.note ??
                  "Table 3 coefficients are used directly; the default site mode does not refit the regression."}
              </p>
            </div>
            <a
              className="paper-link"
              href="https://benjamincowen.com/reports/asymmetric-tail-curvature-in-bitcoin-price-quantiles"
              target="_blank"
              rel="noreferrer"
            >
              Read the paper
              <ExternalLink size={16} />
            </a>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Quantile</th>
                  {(activeModel?.coefficients[0]?.parameters ?? []).map((parameter) => (
                    <th key={parameter.label}>{parameter.label}</th>
                  ))}
                  <th>Pseudo-R2</th>
                </tr>
              </thead>
              <tbody>
                {(activeModel?.coefficients ?? []).map(
                  (coefficient) => (
                    <tr key={coefficient.key}>
                      <td>{coefficient.label}</td>
                      {coefficient.parameters.map((parameter) => (
                        <td key={parameter.label}>{formatParameter(parameter)}</td>
                      ))}
                      <td>{formatNumber(coefficient.pseudoR2, 3)}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section id="caveats" className="content-section caveat-section">
          <div className="caveat-heading">
            <AlertTriangle size={22} />
            <h2>Limits to keep in mind</h2>
          </div>
          <div className="caveat-copy">
            <p>
              These bands describe the conditional distribution of BTC price
              level given time. They are useful for reading long-run structure,
              but they should stay in that lane.
            </p>
            <div className="caveat-items" aria-label="Model caveats">
              <span>Not a trading signal</span>
              <span>Not a guaranteed floor</span>
              <span>Not portfolio loss risk</span>
              <span>Projection is descriptive</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="metric-chip">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DashboardTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="dashboard-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function EvidencePoint({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="evidence-point">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function formatParameter(parameter: ModelParameter): string {
  if (typeof parameter.value === "string") return parameter.value;
  return formatNumber(parameter.value, parameter.precision ?? 3);
}

function filterRows<T extends PriceRow | QuantileRow>(
  rows: T[],
  startDate: string,
  endDate: string,
): T[] {
  if (rows.length === 0 || endDate < startDate) return [];

  const startIndex = lowerBoundDate(rows, startDate);
  const endIndex = upperBoundDate(rows, endDate);
  return rows.slice(startIndex, endIndex);
}

function lowerBoundDate<T extends PriceRow | QuantileRow>(
  rows: T[],
  date: string,
): number {
  let low = 0;
  let high = rows.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (rows[mid].date < date) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function upperBoundDate<T extends PriceRow | QuantileRow>(
  rows: T[],
  date: string,
): number {
  let low = 0;
  let high = rows.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (rows[mid].date <= date) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function getRangeStart(latestDate: string, range: RangeKey): string {
  const definition = ranges.find((item) => item.key === range);
  if (!definition?.years) return modelConfig.startDate;

  const latest = new Date(`${latestDate}T00:00:00.000Z`);
  return new Date(
    Date.UTC(
      latest.getUTCFullYear() - definition.years,
      latest.getUTCMonth(),
      latest.getUTCDate(),
    ),
  )
    .toISOString()
    .slice(0, 10);
}

function getProjectionEndDate(
  latestDate: string,
  years: number,
  maxProjectionDate: string,
): string {
  if (years === 0) return latestDate;

  const latest = new Date(`${latestDate}T00:00:00.000Z`);
  const projected = new Date(
    Date.UTC(
      latest.getUTCFullYear() + years,
      latest.getUTCMonth(),
      latest.getUTCDate(),
    ),
  )
    .toISOString()
    .slice(0, 10);

  return minDate(projected, maxProjectionDate);
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

function minDate(first: string, second: string): string {
  return first < second ? first : second;
}

export default App;
