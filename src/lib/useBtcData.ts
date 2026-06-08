import { useEffect, useState } from "react";
import type { BtcAtcDataset } from "./types";

type DataState =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: BtcAtcDataset; error: null }
  | { status: "error"; data: null; error: string };

export function useBtcData(): DataState {
  const [state, setState] = useState<DataState>({ status: "loading", data: null, error: null });

  useEffect(() => {
    const controller = new AbortController();

    async function loadData() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}data/btc-atc.json`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Could not load BTC data (${response.status})`);
        }

        const data = (await response.json()) as BtcAtcDataset;
        setState({ status: "ready", data, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          data: null,
          error: error instanceof Error ? error.message : "Could not load BTC data",
        });
      }
    }

    void loadData();

    return () => controller.abort();
  }, []);

  return state;
}
