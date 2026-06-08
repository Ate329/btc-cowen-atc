import type modelConfig from "../data/model-config.json";

export type QuantileKey = "q1" | "q10" | "q25" | "q50" | "q75" | "q95" | "q99";

export type QuantileValues = Record<QuantileKey, number>;

export type ModelMode =
  | "paper"
  | "linearRegression"
  | "symmetricQuadratic"
  | "stretchedExponential"
  | "asymmetricRefit";

export type PriceRow = {
  date: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeFrom: number;
  volumeTo: number;
};

export type QuantileRow = {
  date: string;
  time: number;
} & QuantileValues;

export type LinearRegressionCoefficient = {
  key: QuantileKey;
  tau: number;
  label: string;
  intercept: number;
  slope: number;
  pseudoR2: number;
};

export type ModelParameter = {
  label: string;
  value: number | string;
  precision?: number;
};

export type ModelCoefficient = {
  key: QuantileKey;
  tau: number;
  label: string;
  pseudoR2: number;
  parameters: ModelParameter[];
};

export type QuantileModelResult = {
  mode: ModelMode;
  label: string;
  shortLabel: string;
  formula: string;
  note: string;
  coefficients: ModelCoefficient[];
  quantiles: QuantileRow[];
  metrics: Array<{ label: string; value: string }>;
};

export type BtcAtcDataset = {
  metadata: {
    generatedAt: string;
    source: string;
    sourceUrl: string;
    startDate: string;
    latestCloseDate: string;
    projectionEndDate: string;
    priceRows: number;
    quantileRows: number;
    model: typeof modelConfig;
    linearRegression?: {
      version: string;
      sourceNote: string;
      coefficients: LinearRegressionCoefficient[];
    };
    warnings: string[];
  };
  prices: PriceRow[];
  quantiles: QuantileRow[];
  linearRegressionQuantiles?: QuantileRow[];
};
