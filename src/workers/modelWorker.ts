import { estimateModel } from "../lib/quantileModel";
import type { ModelWorkerRequest, ModelWorkerResponse } from "../lib/modelWorkerTypes";

self.onmessage = (event: MessageEvent<ModelWorkerRequest>) => {
  const { cacheKey, mode, prices, startDate, endDate } = event.data;

  try {
    const model = estimateModel(mode, prices, startDate, endDate, []);
    self.postMessage({ cacheKey, mode, model } satisfies ModelWorkerResponse);
  } catch (error) {
    self.postMessage({
      cacheKey,
      mode,
      error: error instanceof Error ? error.message : "Could not estimate model",
    } satisfies ModelWorkerResponse);
  }
};

export {};
