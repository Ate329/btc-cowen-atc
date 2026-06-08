import modelConfig from "../data/model-config.json";
import { daysBetweenUtc, parseUtcDate } from "./date";
import type {
  LinearRegressionCoefficient,
  ModelCoefficient,
  ModelMode,
  PriceRow,
  QuantileKey,
  QuantileModelResult,
  QuantileRow,
  QuantileValues,
} from "./types";

const DAY_MS = 86_400_000;

export const quantileKeys = modelConfig.coefficients.map((coefficient) => coefficient.key) as QuantileKey[];

type PaperCoefficient = (typeof modelConfig.coefficients)[number];
type RegressionSample = { logTime: number; centeredLogTime: number; days: number; y: number };
type OptimizedPoint = { params: number[]; loss: number };

export function daysSinceGenesis(date: string | Date): number {
  return daysBetweenUtc(modelConfig.anchorDate, date);
}

export function centeredLogTime(date: string | Date): number {
  const days = daysSinceGenesis(date);

  if (days <= 0) {
    throw new Error(`Model date must be after ${modelConfig.anchorDate}`);
  }

  return Math.log(days) - modelConfig.mu;
}

export function estimateLog10Price(date: string | Date, key: QuantileKey): number {
  const x = centeredLogTime(date);
  const coefficient = modelConfig.coefficients.find((item) => item.key === key);

  if (!coefficient) {
    throw new Error(`Unknown quantile key: ${key}`);
  }

  return coefficient.c + coefficient.a * x + coefficient.b * x * x;
}

export function estimateQuantilePrices(date: string | Date): QuantileValues {
  parseUtcDate(date);

  const raw = modelConfig.coefficients.map((coefficient) => ({
    key: coefficient.key as QuantileKey,
    value: 10 ** estimateLog10Price(date, coefficient.key as QuantileKey),
  }));

  return rearrangeAndRound(raw);
}

export function estimateModel(
  mode: ModelMode,
  prices: PriceRow[],
  startDate: string,
  endDate: string,
  paperQuantiles: QuantileRow[],
): QuantileModelResult {
  if (mode === "paper") {
    return buildPaperModelResult(paperQuantiles);
  }

  if (mode === "linearRegression") {
    const { coefficients, quantiles } = estimateLinearRegressionQuantileRows(prices, startDate, endDate);
    return buildLinearRegressionModelResult(coefficients, quantiles);
  }

  if (mode === "symmetricQuadratic") {
    return estimateSymmetricQuadraticModel(prices, startDate, endDate);
  }

  if (mode === "stretchedExponential") {
    return estimateStretchedExponentialModel(prices, startDate, endDate);
  }

  return estimateAsymmetricRefitModel(prices, startDate, endDate);
}

export function estimateLinearRegressionQuantilePrices(
  date: string | Date,
  coefficients: LinearRegressionCoefficient[],
): QuantileValues {
  parseUtcDate(date);

  const logTime = logTimeSinceGenesis(date);
  const raw = coefficients.map((coefficient) => ({
    key: coefficient.key,
    value: 10 ** (coefficient.intercept + coefficient.slope * logTime),
  }));

  return rearrangeAndRound(raw);
}

export function estimateLinearRegressionQuantileRows(
  prices: PriceRow[],
  startDate: string,
  endDate: string,
): { coefficients: LinearRegressionCoefficient[]; quantiles: QuantileRow[] } {
  const coefficients = estimateLinearRegressionCoefficients(prices);
  const quantiles = generateQuantileRows(startDate, endDate, (date, key) => {
    const coefficient = coefficients.find((item) => item.key === key);
    if (!coefficient) throw new Error(`Missing linear QR coefficient for ${key}`);
    return coefficient.intercept + coefficient.slope * logTimeSinceGenesis(date);
  });

  return { coefficients, quantiles };
}

export function estimateLinearRegressionCoefficients(prices: PriceRow[]): LinearRegressionCoefficient[] {
  const samples = buildSamples(prices);

  if (samples.length < 3) {
    throw new Error("At least three positive price rows are required to estimate quantile regression.");
  }

  return modelConfig.coefficients.map((coefficient) => {
    const fit = fitLinearQuantileRegression(samples, coefficient.tau);

    return {
      key: coefficient.key as QuantileKey,
      tau: coefficient.tau,
      label: coefficient.label,
      intercept: fit.intercept,
      slope: fit.slope,
      pseudoR2: pseudoR2(samples, coefficient.tau, fit.modelLoss),
    };
  });
}

export function estimateSymmetricQuadraticModel(
  prices: PriceRow[],
  startDate: string,
  endDate: string,
): QuantileModelResult {
  const samples = buildSamples(prices);
  const coefficients = modelConfig.coefficients.map((coefficient) => {
    const fit = fitSymmetricQuadraticQuantileRegression(samples, coefficient);
    return {
      key: coefficient.key as QuantileKey,
      tau: coefficient.tau,
      label: coefficient.label,
      pseudoR2: pseudoR2(samples, coefficient.tau, fit.loss),
      parameters: [
        { label: "c_tau", value: fit.params[0], precision: 3 },
        { label: "a_tau", value: fit.params[1], precision: 3 },
        { label: "b_tau", value: fit.params[2], precision: 4 },
      ],
    };
  });
  const byKey = new Map(coefficients.map((coefficient) => [coefficient.key, coefficient]));
  const quantiles = generateQuantileRows(startDate, endDate, (date, key) => {
    const coefficient = byKey.get(key);
    if (!coefficient) throw new Error(`Missing symmetric quadratic coefficient for ${key}`);
    const c = Number(coefficient.parameters[0].value);
    const a = Number(coefficient.parameters[1].value);
    const b = Number(coefficient.parameters[2].value);
    const x = centeredLogTime(date);
    return c + a * x + b * x * x;
  });

  return {
    mode: "symmetricQuadratic",
    label: "Symmetric Quadratic QR",
    shortLabel: "Sym Quad",
    formula: "Q_tau = c_tau + a_tau x + b_tau x^2",
    note: "Cowen's Model 2, with a separate curvature term fit for each quantile.",
    coefficients,
    quantiles,
    metrics: [
      { label: "Model", value: "Sym quad" },
      { label: "Fit", value: "Check-loss" },
      { label: "Curvature", value: "Per Q" },
    ],
  };
}

export function estimateStretchedExponentialModel(
  prices: PriceRow[],
  startDate: string,
  endDate: string,
): QuantileModelResult {
  const samples = buildSamples(prices);
  const medianDays = sampleQuantile(
    samples.map((sample) => sample.days),
    0.5,
  );
  const coefficients = modelConfig.coefficients.map((coefficient) => {
    const fit = fitStretchedExponentialQuantileRegression(samples, coefficient.tau, medianDays);
    const c = positiveTransform(fit.params[2]);
    const d = positiveTransform(fit.params[3]);

    return {
      key: coefficient.key as QuantileKey,
      tau: coefficient.tau,
      label: coefficient.label,
      pseudoR2: pseudoR2(samples, coefficient.tau, fit.loss),
      parameters: [
        { label: "a_tau", value: fit.params[0], precision: 3 },
        { label: "b_tau", value: fit.params[1], precision: 3 },
        { label: "c_tau", value: c, precision: 4 },
        { label: "d_tau", value: d, precision: 3 },
      ],
    };
  });
  const byKey = new Map(coefficients.map((coefficient) => [coefficient.key, coefficient]));
  const quantiles = generateQuantileRows(startDate, endDate, (date, key) => {
    const coefficient = byKey.get(key);
    if (!coefficient) throw new Error(`Missing stretched-exponential coefficient for ${key}`);
    const a = Number(coefficient.parameters[0].value);
    const b = Number(coefficient.parameters[1].value);
    const c = Number(coefficient.parameters[2].value);
    const d = Number(coefficient.parameters[3].value);
    return predictStretchedExponential(a, b, c, d, daysSinceGenesis(date), medianDays);
  });

  return {
    mode: "stretchedExponential",
    label: "Stretched-Exponential QR",
    shortLabel: "Stretch Exp",
    formula: "Q_tau(t) = a_tau ln(t) + b_tau exp(-c_tau (t/T)^d_tau)",
    note: "Plan C v2-style functional class compared in Cowen Section 14.",
    coefficients,
    quantiles,
    metrics: [
      { label: "Model", value: "Stretch" },
      { label: "Fit", value: "Check-loss" },
      { label: "T", value: "Median t" },
    ],
  };
}

export function estimateAsymmetricRefitModel(
  prices: PriceRow[],
  startDate: string,
  endDate: string,
): QuantileModelResult {
  const samples = buildSamples(prices);
  const lowerCoefficients = modelConfig.coefficients.slice(0, 3);
  const medianCoefficient = modelConfig.coefficients[3];
  const upperCoefficients = modelConfig.coefficients.slice(4);
  const lowerFit = fitSharedCurvatureQuantileGroup(samples, lowerCoefficients, "bLO");
  const medianFit = fitSymmetricQuadraticQuantileRegression(samples, medianCoefficient);
  const upperFit = fitSharedCurvatureQuantileGroup(samples, upperCoefficients, "bHI");
  const medianDisplay: ModelCoefficient = {
    key: medianCoefficient.key as QuantileKey,
    tau: medianCoefficient.tau,
    label: medianCoefficient.label,
    pseudoR2: pseudoR2(samples, medianCoefficient.tau, medianFit.loss),
    parameters: [
      { label: "c_tau", value: medianFit.params[0], precision: 3 },
      { label: "a_tau", value: medianFit.params[1], precision: 3 },
      { label: "b_group", value: medianFit.params[2], precision: 4 },
      { label: "group", value: "MED" },
    ],
  };
  const coefficients = [
    ...lowerFit.coefficients,
    medianDisplay,
    ...upperFit.coefficients,
  ];
  const byKey = new Map(coefficients.map((coefficient) => [coefficient.key, coefficient]));
  const quantiles = generateQuantileRows(startDate, endDate, (date, key) => {
    const coefficient = byKey.get(key);
    if (!coefficient) throw new Error(`Missing ATC refit coefficient for ${key}`);
    const c = Number(coefficient.parameters[0].value);
    const a = Number(coefficient.parameters[1].value);
    const b = Number(coefficient.parameters[2].value);
    const x = centeredLogTime(date);
    return c + a * x + b * x * x;
  });

  return {
    mode: "asymmetricRefit",
    label: "ATC Refit",
    shortLabel: "ATC Refit",
    formula: "Q_tau = c_tau + a_tau x + b(tau) x^2",
    note: "Cowen's proposed asymmetric grouped-curvature specification refit on the current site snapshot.",
    coefficients,
    quantiles,
    metrics: [
      { label: "Model", value: "ATC refit" },
      { label: "Fit", value: "Pooled QR" },
      { label: "Groups", value: "LO/MED/HI" },
    ],
  };
}

export function distanceToLevel(price: number, level: number): number {
  return price / level - 1;
}

export function classifyPriceBand(price: number, quantiles: QuantileValues): string {
  if (price < quantiles.q1) return "below Q1";
  if (price < quantiles.q10) return "Q1-Q10";
  if (price < quantiles.q25) return "Q10-Q25";
  if (price < quantiles.q50) return "Q25-Q50";
  if (price < quantiles.q75) return "Q50-Q75";
  if (price < quantiles.q95) return "Q75-Q95";
  if (price < quantiles.q99) return "Q95-Q99";
  return "above Q99";
}

function buildPaperModelResult(quantiles: QuantileRow[]): QuantileModelResult {
  return {
    mode: "paper",
    label: "Paper ATC",
    shortLabel: "Paper ATC",
    formula: "log10(P_tau(t)) = c_tau + a_tau x + b(tau) x^2",
    note: "Cowen Table 3 published coefficients are used directly.",
    coefficients: modelConfig.coefficients.map((coefficient) => paperCoefficientToDisplay(coefficient)),
    quantiles,
    metrics: [
      { label: "bLO", value: "-0.024" },
      { label: "bHI", value: "-0.326" },
      { label: "Delta b", value: "-0.302" },
    ],
  };
}

function buildLinearRegressionModelResult(
  coefficients: LinearRegressionCoefficient[],
  quantiles: QuantileRow[],
): QuantileModelResult {
  return {
    mode: "linearRegression",
    label: "Linear QR",
    shortLabel: "Linear QR",
    formula: "Q_tau = beta_tau + alpha_tau ln(t)",
    note: "Cowen's Model 1 and Plan C v1-style linear quantile power-law baseline.",
    coefficients: coefficients.map((coefficient) => ({
      key: coefficient.key,
      tau: coefficient.tau,
      label: coefficient.label,
      pseudoR2: coefficient.pseudoR2,
      parameters: [
        { label: "beta_tau", value: coefficient.intercept, precision: 3 },
        { label: "alpha_tau", value: coefficient.slope, precision: 3 },
      ],
    })),
    quantiles,
    metrics: [
      { label: "Model", value: "Linear QR" },
      { label: "Fit", value: "Check-loss" },
      { label: "Curvature", value: "None" },
    ],
  };
}

function paperCoefficientToDisplay(coefficient: PaperCoefficient): ModelCoefficient {
  return {
    key: coefficient.key as QuantileKey,
    tau: coefficient.tau,
    label: coefficient.label,
    pseudoR2: coefficient.pseudoR2,
    parameters: [
      { label: "c_tau", value: coefficient.c, precision: 3 },
      { label: "a_tau", value: coefficient.a, precision: 3 },
      { label: "b_tau", value: coefficient.b, precision: 4 },
    ],
  };
}

function buildSamples(prices: PriceRow[]): RegressionSample[] {
  return prices
    .filter((price) => price.close > 0 && daysSinceGenesis(price.date) > 0)
    .map((price) => {
      const days = daysSinceGenesis(price.date);
      return {
        days,
        logTime: Math.log(days),
        centeredLogTime: Math.log(days) - modelConfig.mu,
        y: Math.log10(price.close),
      };
    });
}

function generateQuantileRows(
  startDate: string,
  endDate: string,
  predictLog10Price: (date: string, key: QuantileKey) => number,
): QuantileRow[] {
  const rows: QuantileRow[] = [];
  let cursor = parseUtcDate(startDate);
  const end = parseUtcDate(endDate);

  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const raw = quantileKeys.map((key) => ({
      key,
      value: safePower10(predictLog10Price(date, key)),
    }));

    rows.push({
      date,
      time: Math.floor(cursor.getTime() / 1000),
      ...rearrangeAndRound(raw),
    });
    cursor = new Date(cursor.getTime() + DAY_MS);
  }

  return rows;
}

function fitLinearQuantileRegression(samples: RegressionSample[], tau: number) {
  const start = ordinaryLeastSquares(samples, "logTime");
  const best = nelderMead(
    [start.intercept, start.slope],
    [0.05, 0.05],
    (params) => checkLoss(samples, tau, (sample) => params[0] + params[1] * sample.logTime),
    { maxIterations: 700, tolerance: 1e-9 },
  );

  return {
    intercept: best.params[0],
    slope: best.params[1],
    modelLoss: best.loss,
  };
}

function fitSymmetricQuadraticQuantileRegression(samples: RegressionSample[], coefficient: PaperCoefficient): OptimizedPoint {
  const linearStart = ordinaryLeastSquares(samples, "centeredLogTime");
  const starts = [
    [coefficient.c, coefficient.a, coefficient.b],
    [linearStart.intercept, linearStart.slope, 0],
    [coefficient.c, coefficient.a, 0],
    [coefficient.c, coefficient.a, coefficient.b * 0.5],
  ];

  return bestNelderMead(
    starts,
    [0.05, 0.05, 0.02],
    (params) =>
      checkLoss(samples, coefficient.tau, (sample) => {
        const x = sample.centeredLogTime;
        return params[0] + params[1] * x + params[2] * x * x;
      }),
    { maxIterations: 700, tolerance: 1e-9 },
  );
}

function fitSharedCurvatureQuantileGroup(
  samples: RegressionSample[],
  coefficients: PaperCoefficient[],
  groupLabel: "bLO" | "bHI",
): { coefficients: ModelCoefficient[]; loss: number } {
  const paperB = coefficients[0].b;
  const paperParams = coefficients.flatMap((coefficient) => [coefficient.c, coefficient.a]);
  const starts = [
    [paperB, ...paperParams],
    [0, ...paperParams],
    [paperB * 0.5, ...paperParams],
    [paperB * 1.5, ...paperParams],
  ];
  const steps = [0.02, ...coefficients.flatMap(() => [0.05, 0.05])];
  const fit = bestNelderMead(
    starts,
    steps,
    (params) =>
      coefficients.reduce((loss, coefficient, index) => {
        const c = params[1 + index * 2];
        const a = params[2 + index * 2];
        const b = params[0];

        return (
          loss +
          checkLoss(samples, coefficient.tau, (sample) => {
            const x = sample.centeredLogTime;
            return c + a * x + b * x * x;
          })
        );
      }, 0),
    { maxIterations: 780, tolerance: 1e-8 },
  );
  const b = fit.params[0];

  return {
    loss: fit.loss,
    coefficients: coefficients.map((coefficient, index) => {
      const c = fit.params[1 + index * 2];
      const a = fit.params[2 + index * 2];
      const modelLoss = checkLoss(samples, coefficient.tau, (sample) => {
        const x = sample.centeredLogTime;
        return c + a * x + b * x * x;
      });

      return {
        key: coefficient.key as QuantileKey,
        tau: coefficient.tau,
        label: coefficient.label,
        pseudoR2: pseudoR2(samples, coefficient.tau, modelLoss),
        parameters: [
          { label: "c_tau", value: c, precision: 3 },
          { label: "a_tau", value: a, precision: 3 },
          { label: "b_group", value: b, precision: 4 },
          { label: "group", value: groupLabel === "bLO" ? "LO" : "HI" },
        ],
      };
    }),
  };
}

function fitStretchedExponentialQuantileRegression(
  samples: RegressionSample[],
  tau: number,
  medianDays: number,
): OptimizedPoint {
  const linearFit = fitLinearQuantileRegression(samples, tau);
  const starts = [
    [linearFit.slope, linearFit.intercept, Math.log(0.03), Math.log(1)],
    [linearFit.slope, linearFit.intercept * 0.8, Math.log(0.01), Math.log(0.7)],
    [linearFit.slope, linearFit.intercept * 1.2, Math.log(0.08), Math.log(1.2)],
    [linearFit.slope * 0.95, linearFit.intercept, Math.log(0.15), Math.log(1.5)],
    [linearFit.slope * 1.05, linearFit.intercept, Math.log(0.003), Math.log(0.5)],
  ];

  return bestNelderMead(
    starts,
    [0.04, 0.08, 0.35, 0.25],
    (params) => {
      const c = positiveTransform(params[2]);
      const d = positiveTransform(params[3]);
      return checkLoss(samples, tau, (sample) =>
        predictStretchedExponential(params[0], params[1], c, d, sample.days, medianDays),
      );
    },
    { maxIterations: 420, tolerance: 1e-8 },
  );
}

function predictStretchedExponential(a: number, b: number, c: number, d: number, days: number, medianDays: number): number {
  const exponent = -Math.min(60, c * (days / medianDays) ** d);
  return a * Math.log(days) + b * Math.exp(exponent);
}

function ordinaryLeastSquares(samples: RegressionSample[], field: "logTime" | "centeredLogTime") {
  const xMean = samples.reduce((sum, sample) => sum + sample[field], 0) / samples.length;
  const yMean = samples.reduce((sum, sample) => sum + sample.y, 0) / samples.length;
  const numerator = samples.reduce((sum, sample) => sum + (sample[field] - xMean) * (sample.y - yMean), 0);
  const denominator = samples.reduce((sum, sample) => sum + (sample[field] - xMean) ** 2, 0);
  const slope = denominator === 0 ? 0 : numerator / denominator;

  return {
    intercept: yMean - slope * xMean,
    slope,
  };
}

function checkLoss(samples: RegressionSample[], tau: number, predict: (sample: RegressionSample) => number): number {
  return samples.reduce((sum, sample) => {
    const residual = sample.y - predict(sample);
    return sum + residual * (tau - (residual < 0 ? 1 : 0));
  }, 0);
}

function pseudoR2(samples: RegressionSample[], tau: number, modelLoss: number): number {
  const nullQuantile = sampleQuantile(
    samples.map((sample) => sample.y),
    tau,
  );
  const nullLoss = checkLoss(samples, tau, () => nullQuantile);
  return nullLoss === 0 ? 1 : 1 - modelLoss / nullLoss;
}

function bestNelderMead(
  starts: number[][],
  steps: number[],
  objective: (params: number[]) => number,
  options: { maxIterations: number; tolerance: number },
): OptimizedPoint {
  return starts
    .map((start) => nelderMead(start, steps, objective, options))
    .sort((a, b) => a.loss - b.loss)[0];
}

function nelderMead(
  start: number[],
  steps: number[],
  objective: (params: number[]) => number,
  options: { maxIterations: number; tolerance: number },
): OptimizedPoint {
  let simplex = [
    evaluateParams(start, objective),
    ...start.map((_, index) => {
      const params = [...start];
      params[index] += steps[index] ?? 0.05;
      return evaluateParams(params, objective);
    }),
  ];

  for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
    simplex = simplex.sort((a, b) => a.loss - b.loss);
    const best = simplex[0];
    const worst = simplex.at(-1)!;
    const secondWorst = simplex.at(-2)!;

    if (simplexDiameter(simplex) < options.tolerance) break;

    const centroid = centroidWithoutWorst(simplex);
    const reflected = evaluateParams(
      centroid.map((value, index) => value + (value - worst.params[index])),
      objective,
    );

    if (reflected.loss < best.loss) {
      const expanded = evaluateParams(
        centroid.map((value, index) => value + 2 * (reflected.params[index] - value)),
        objective,
      );
      simplex[simplex.length - 1] = expanded.loss < reflected.loss ? expanded : reflected;
      continue;
    }

    if (reflected.loss < secondWorst.loss) {
      simplex[simplex.length - 1] = reflected;
      continue;
    }

    const contracted = evaluateParams(
      centroid.map((value, index) => value + 0.5 * (worst.params[index] - value)),
      objective,
    );

    if (contracted.loss < worst.loss) {
      simplex[simplex.length - 1] = contracted;
      continue;
    }

    simplex = [
      best,
      ...simplex.slice(1).map((point) =>
        evaluateParams(
          point.params.map((value, index) => best.params[index] + 0.5 * (value - best.params[index])),
          objective,
        ),
      ),
    ];
  }

  return simplex.sort((a, b) => a.loss - b.loss)[0];
}

function evaluateParams(params: number[], objective: (params: number[]) => number): OptimizedPoint {
  const loss = objective(params);
  return {
    params,
    loss: Number.isFinite(loss) ? loss : Number.POSITIVE_INFINITY,
  };
}

function centroidWithoutWorst(simplex: OptimizedPoint[]): number[] {
  const dimension = simplex[0].params.length;
  return Array.from({ length: dimension }, (_, index) => {
    const sum = simplex.slice(0, -1).reduce((total, point) => total + point.params[index], 0);
    return sum / (simplex.length - 1);
  });
}

function simplexDiameter(simplex: OptimizedPoint[]): number {
  const losses = simplex.map((point) => point.loss);
  const lossRange = Math.max(...losses) - Math.min(...losses);
  const paramRange = Math.max(
    ...simplex[0].params.map((_, index) => {
      const values = simplex.map((point) => point.params[index]);
      return Math.max(...values) - Math.min(...values);
    }),
  );

  return Math.max(lossRange, paramRange);
}

function sampleQuantile(values: number[], tau: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(tau * sorted.length) - 1));
  return sorted[index];
}

function rearrangeAndRound(raw: Array<{ key: QuantileKey; value: number }>): QuantileValues {
  const rearranged = raw.map((item) => item.value).sort((a, b) => a - b);

  return raw.reduce((values, item, index) => {
    values[item.key] = roundPrice(rearranged[index]);
    return values;
  }, {} as QuantileValues);
}

function roundPrice(value: number): number {
  if (value < 1) return Number(value.toFixed(5));
  if (value < 100) return Number(value.toFixed(3));
  return Number(value.toFixed(2));
}

function safePower10(log10Value: number): number {
  return 10 ** Math.max(-12, Math.min(12, log10Value));
}

function positiveTransform(value: number): number {
  return Math.exp(Math.max(-20, Math.min(5, value)));
}

function logTimeSinceGenesis(date: string | Date): number {
  return Math.log(daysSinceGenesis(date));
}
