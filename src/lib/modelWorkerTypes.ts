import type { ModelMode, PriceRow, QuantileModelResult } from "./types";

export type ModelWorkerMode = Exclude<ModelMode, "paper">;

export type ModelWorkerRequest = {
  cacheKey: string;
  mode: ModelWorkerMode;
  prices: PriceRow[];
  startDate: string;
  endDate: string;
};

export type ModelWorkerResponse = {
  cacheKey: string;
  mode: ModelWorkerMode;
  model?: QuantileModelResult;
  error?: string;
};
