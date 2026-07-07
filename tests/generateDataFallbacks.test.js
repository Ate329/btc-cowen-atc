import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendCurrentDaySnapshot,
  fetchIncrementalAdditions,
} from "../scripts/generate-data.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("BTC data generator fallbacks", () => {
  it("falls through CryptoCompare and Coinbase failures to Binance daily klines", async () => {
    const fetchMock = vi.fn(async (url) => {
      const href = String(url);

      if (href.includes("cryptocompare")) {
        return jsonResponse({ Response: "Error", Message: "Unauthorized" });
      }

      if (href.includes("coinbase.com/products/BTC-USD/candles")) {
        return jsonResponse({ message: "forbidden" }, 403, "Forbidden");
      }

      if (href.includes("binance.com/api/v3/klines")) {
        return jsonResponse([
          binanceRow("2026-07-02", 101, 103, 100, 102.4),
          binanceRow("2026-07-03", 102.4, 104, 101, 103.7),
        ]);
      }

      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchIncrementalAdditions("2026-07-01", "2026-07-03", 2);

    expect(result.additions.map((row) => row.date)).toEqual(["2026-07-02", "2026-07-03"]);
    expect(result.additions.at(-1)?.close).toBe(103.7);
    expect(result.fallbackSourceUrl).toContain("binance.com");
    expect(result.usedFallback).toBe(true);
    expect(result.warnings.join(" ")).toContain("Coinbase Exchange BTC-USD daily candles daily fallback failed");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("coinbase.com/products/BTC-USD/candles"))).toHaveLength(2);
  });

  it("retries Binance server errors and then uses Bitstamp daily OHLC", async () => {
    const fetchMock = vi.fn(async (url) => {
      const href = String(url);

      if (href.includes("cryptocompare")) {
        return jsonResponse({ Response: "Error", Message: "Unauthorized" });
      }

      if (href.includes("coinbase.com/products/BTC-USD/candles")) {
        return jsonResponse({ message: "not found" }, 404, "Not Found");
      }

      if (href.includes("binance.com/api/v3/klines")) {
        return jsonResponse({ message: "temporarily unavailable" }, 500, "Internal Server Error");
      }

      if (href.includes("bitstamp.net/api/v2/ohlc/btcusd")) {
        return jsonResponse({
          data: {
            ohlc: [
              {
                timestamp: String(unixSeconds("2026-07-02")),
                open: "201",
                high: "205",
                low: "199",
                close: "204",
                volume: "2",
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchIncrementalAdditions("2026-07-01", "2026-07-02", 1);

    expect(result.additions).toMatchObject([{ date: "2026-07-02", open: 201, close: 204 }]);
    expect(result.fallbackSourceUrl).toContain("bitstamp.net");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("binance.com/api/v3/klines"))).toHaveLength(3);
  });

  it("uses Kraken daily OHLC after earlier free sources fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);

      if (href.includes("cryptocompare")) {
        return jsonResponse({ Response: "Error", Message: "Unauthorized" });
      }

      if (
        href.includes("coinbase.com/products/BTC-USD/candles") ||
        href.includes("binance.com/api/v3/klines") ||
        href.includes("bitstamp.net/api/v2/ohlc/btcusd")
      ) {
        return jsonResponse({ message: "not found" }, 404, "Not Found");
      }

      if (href.includes("kraken.com/0/public/OHLC")) {
        return jsonResponse({
          error: [],
          result: {
            XXBTZUSD: [[unixSeconds("2026-07-02"), "301", "305", "299", "304", "302", "3", 10]],
            last: unixSeconds("2026-07-02"),
          },
        });
      }

      throw new Error(`Unexpected URL: ${href}`);
    }));

    const result = await fetchIncrementalAdditions("2026-07-01", "2026-07-02", 1);

    expect(result.additions).toMatchObject([{ date: "2026-07-02", high: 305, low: 299, close: 304 }]);
    expect(result.fallbackSourceUrl).toContain("kraken.com");
  });

  it("uses CoinGecko close-only rows with an approximation warning", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);

      if (href.includes("cryptocompare")) {
        return jsonResponse({ Response: "Error", Message: "Unauthorized" });
      }

      if (
        href.includes("coinbase.com/products/BTC-USD/candles") ||
        href.includes("binance.com/api/v3/klines") ||
        href.includes("bitstamp.net/api/v2/ohlc/btcusd") ||
        href.includes("kraken.com/0/public/OHLC") ||
        href.includes("kucoin.com/api/v1/market/candles")
      ) {
        return jsonResponse({ message: "not found" }, 404, "Not Found");
      }

      if (href.includes("coingecko.com/api/v3/coins/bitcoin/market_chart/range")) {
        return jsonResponse({
          prices: [
            [unixMilliseconds("2026-07-02"), 401],
            [unixMilliseconds("2026-07-03"), 399],
          ],
          total_volumes: [
            [unixMilliseconds("2026-07-02"), 4010],
            [unixMilliseconds("2026-07-03"), 3990],
          ],
        });
      }

      throw new Error(`Unexpected URL: ${href}`);
    }));

    const result = await fetchIncrementalAdditions("2026-07-01", "2026-07-03", 2);

    expect(result.additions.map((row) => row.close)).toEqual([401, 399]);
    expect(result.additions[1]).toMatchObject({ open: 401, high: 401, low: 399 });
    expect(result.warnings.join(" ")).toContain("open/high/low were approximated");
    expect(result.fallbackSourceUrl).toContain("coingecko.com");
  });

  it("throws only after all free daily sources fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);

      if (href.includes("cryptocompare")) {
        return jsonResponse({ Response: "Error", Message: "Unauthorized" });
      }

      return jsonResponse({ message: "not found" }, 404, "Not Found");
    }));

    await expect(fetchIncrementalAdditions("2026-07-01", "2026-07-02", 1)).rejects.toThrow(
      "All daily BTC fallback sources failed",
    );
  });

  it("falls from current-day Coinbase candles to ticker sources", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);

      if (href.includes("coinbase.com/products/BTC-USD/candles")) {
        return jsonResponse({ message: "forbidden" }, 403, "Forbidden");
      }

      if (href.includes("coinbase.com/products/BTC-USD/ticker")) {
        return jsonResponse({ price: "503", volume: "4" });
      }

      throw new Error(`Unexpected URL: ${href}`);
    }));

    const result = await appendCurrentDaySnapshot({
      rows: [priceRow("2026-07-06", 500)],
      warnings: [],
    });

    expect(result.rows.at(-1)).toMatchObject({ date: "2026-07-07", open: 500, close: 503 });
    expect(result.currentPriceSource).toBe("Coinbase Exchange BTC-USD ticker");
    expect(result.warnings.join(" ")).toContain("trying ticker fallbacks");
  });
});

function jsonResponse(body, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

function binanceRow(date, open, high, low, close) {
  const openTime = unixMilliseconds(date);

  return [
    openTime,
    String(open),
    String(high),
    String(low),
    String(close),
    "1",
    openTime + 86_400_000 - 1,
    String(close),
    1,
    "0",
    "0",
    "0",
  ];
}

function priceRow(date, close) {
  return {
    date,
    time: unixSeconds(date),
    open: close,
    high: close,
    low: close,
    close,
    volumeFrom: 1,
    volumeTo: close,
  };
}

function unixSeconds(date) {
  return Math.floor(unixMilliseconds(date) / 1000);
}

function unixMilliseconds(date) {
  return Date.parse(`${date}T00:00:00.000Z`);
}
