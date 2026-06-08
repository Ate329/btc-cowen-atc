import type modelConfig from "../data/model-config.json";

export type QuantileKey = "q1" | "q10" | "q25" | "q50" | "q75" | "q95" | "q99";

export type QuantileValues = Record<QuantileKey, number>;

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
    warnings: string[];
  };
  prices: PriceRow[];
  quantiles: QuantileRow[];
};
