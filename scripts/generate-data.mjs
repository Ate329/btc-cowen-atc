import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const __dirname = path.dirname(modulePath);
const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "src", "data", "model-config.json");
const outputPath = path.join(root, "public", "data", "btc-atc.json");

const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;
const HISTODAY_URL = "https://min-api.cryptocompare.com/data/v2/histoday";
const COINBASE_CANDLES_URL = "https://api.exchange.coinbase.com/products/BTC-USD/candles";
const COINBASE_TICKER_URL = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";
const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";
const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const KRAKEN_TICKER_URL = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD";
const KRAKEN_OHLC_URL = "https://api.kraken.com/0/public/OHLC";
const BITSTAMP_OHLC_URL = "https://www.bitstamp.net/api/v2/ohlc/btcusd/";
const BITSTAMP_TICKER_URL = "https://www.bitstamp.net/api/v2/ticker/btcusd/";
const KUCOIN_CANDLES_URL = "https://api.kucoin.com/api/v1/market/candles";
const COINGECKO_TICKER_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true&precision=full";
const COINGECKO_MARKET_CHART_URL = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range";
const COINBASE_MAX_DAILY_CANDLES = 300;
const HTTP_TIMEOUT_MS = 8_000;
const HTTP_MAX_ATTEMPTS = 3;
const HTTP_RETRY_DELAYS_MS = process.env.NODE_ENV === "test" || process.env.VITEST ? [0, 0] : [500, 1_500];

const model = JSON.parse(await readFile(configPath, "utf8"));
const forceRefresh = process.argv.includes("--force-refresh");
const cryptoCompareApiKey = process.env.CRYPTOCOMPARE_API_KEY ?? process.env.COINDESK_API_KEY ?? "";

if (isCliEntrypoint()) {
  await main();
}

async function main() {
  const isOffline = process.argv.includes("--offline");

  if (isOffline) {
    await assertExistingSnapshot();
    process.exit(0);
  }

  try {
    const {
      rows: prices,
      warnings,
      usedFallback = false,
      fallbackSourceUrl,
      currentPriceSource,
      currentPriceSourceUrl,
    } = await buildPriceRows();
    const quantiles = generateQuantiles(model.startDate, model.projectionEndDate);

    if (prices.length === 0) {
      throw new Error("CryptoCompare returned no BTC price rows.");
    }

    const latestPrice = prices.at(-1);
    const latestPriceIsIntraday = latestPrice?.date === formatUtcDate(currentUtcDay());

    if (latestPrice && (await shouldFailStaleRefresh(latestPrice.date))) {
      console.error("Existing BTC data snapshot is stale in CI; refusing to publish an old snapshot.");
      process.exit(1);
    }

    const payload = {
      metadata: {
        generatedAt: new Date().toISOString(),
        source: usedFallback || currentPriceSource
          ? "CryptoCompare/CoinDesk legacy histoday BTC/USD daily OHLCV, with fallback BTC/USD market data rows"
          : "CryptoCompare/CoinDesk legacy histoday BTC/USD daily OHLCV",
        sourceUrl: HISTODAY_URL,
        fallbackSourceUrl,
        currentPriceSource,
        currentPriceSourceUrl,
        startDate: model.startDate,
        latestCloseDate: latestPrice.date,
        latestPriceIsIntraday,
        projectionEndDate: model.projectionEndDate,
        priceRows: prices.length,
        quantileRows: quantiles.length,
        model,
        warnings,
      },
      prices,
      quantiles,
    };

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
    console.log(`Generated ${relative(outputPath)} with ${prices.length} prices and ${quantiles.length} model rows.`);
  } catch (error) {
    if (existsSync(outputPath)) {
      console.warn(`Data refresh failed; keeping existing ${relative(outputPath)}.`);
      console.warn(error instanceof Error ? error.message : error);

      if (await shouldFailStaleRefresh()) {
        console.error("Existing BTC data snapshot is stale in CI; refusing to publish an old snapshot.");
        process.exit(1);
      }

      process.exit(0);
    }

    throw error;
  }
}

async function buildPriceRows() {
  const completeRows = await buildCompletePriceRows();
  return appendCurrentDaySnapshot(completeRows);
}

async function buildCompletePriceRows() {
  const existing = await readExistingSnapshot();
  const endDate = formatUtcDate(previousCompleteUtcDay());

  if (existing?.prices?.length) {
    const existingRows = existing.prices.filter((row) => row.date >= model.startDate && row.date <= endDate);
    const latestExistingDate = existingRows.at(-1)?.date;

    if (latestExistingDate && latestExistingDate >= endDate && !forceRefresh) {
      return {
        rows: existingRows,
        warnings: currentSnapshotWarnings(existing, latestExistingDate),
        usedFallback: snapshotUsedFallback(existing),
        fallbackSourceUrl: snapshotFallbackSourceUrl(existing),
      };
    }

    if (latestExistingDate) {
      const refreshFromDate =
        forceRefresh && latestExistingDate >= endDate ? formatUtcDate(addUtcDays(endDate, -7)) : latestExistingDate;
      const missingDays = Math.ceil((unixSeconds(endDate) - unixSeconds(refreshFromDate)) / DAY_SECONDS);

      if (missingDays > 0) {
        const { additions, warnings, usedFallback, fallbackSourceUrl } = await fetchIncrementalAdditions(
          refreshFromDate,
          endDate,
          missingDays,
        );
        const merged = dedupeAndSort([...existingRows, ...additions]);

        return {
          rows: merged,
          warnings,
          usedFallback,
          fallbackSourceUrl,
        };
      }
    }
  }

  return fetchFullHistoricalPrices();
}

async function appendCurrentDaySnapshot({ rows, warnings, usedFallback = false, fallbackSourceUrl }) {
  const today = formatUtcDate(currentUtcDay());
  const latestCompleteRow = rows.at(-1);

  if (!latestCompleteRow || latestCompleteRow.date >= today) {
    return { rows, warnings, usedFallback, fallbackSourceUrl };
  }

  try {
    const currentDay = await fetchCoinbaseCurrentDaySnapshot(today, latestCompleteRow);

    return {
      rows: dedupeAndSort([...rows.filter((row) => row.date < today), currentDay.row]),
      warnings: [
        ...warnings,
        ...currentDay.warnings,
        `Loaded current-day BTC snapshot for ${today} from ${currentDay.source}.`,
      ],
      usedFallback: true,
      fallbackSourceUrl,
      currentPriceSource: currentDay.source,
      currentPriceSourceUrl: currentDay.sourceUrl,
    };
  } catch (error) {
    return {
      rows,
      warnings: [...warnings, `Coinbase Exchange current-day snapshot failed (${errorMessage(error)}).`],
      usedFallback,
      fallbackSourceUrl,
    };
  }
}

async function fetchFullHistoricalPrices() {
  const warnings = [];
  const startTs = unixSeconds(model.startDate);
  const endTs = unixSeconds(previousCompleteUtcDay());
  const byTime = new Map();
  let cursor = endTs;
  let attempts = 0;

  while (cursor >= startTs) {
    attempts += 1;

    if (attempts > 12) {
      throw new Error("Aborting BTC history fetch after 12 pagination attempts.");
    }

    const batch = await fetchBatch(cursor, 2000);

    if (batch.length === 0) {
      warnings.push(`Empty batch at toTs=${cursor}.`);
      break;
    }

    for (const row of batch) {
      if (row.time >= startTs && row.time <= endTs) {
        byTime.set(row.time, normalizePriceRow(row));
      }
    }

    const earliest = batch[0].time;
    if (earliest <= startTs) break;
    cursor = earliest - DAY_SECONDS;
  }

  const rows = dedupeAndSort([...byTime.values()]);
  const expectedMinimum = Math.floor((endTs - startTs) / DAY_SECONDS) - 10;

  if (rows.length < expectedMinimum) {
    warnings.push(`Expected roughly ${expectedMinimum} daily rows but received ${rows.length}.`);
  }

  return { rows, warnings };
}

async function fetchIncrementalAdditions(latestExistingDate, endDate, missingDays) {
  const warnings = [];

  if (missingDays <= 2000) {
    try {
      const batch = await fetchBatch(unixSeconds(endDate), Math.min(2000, missingDays + 5));
      const additions = batch
        .filter((row) => row.time > unixSeconds(latestExistingDate) && row.time <= unixSeconds(endDate))
        .map(normalizePriceRow);

      if (additionsCoverEndDate(additions, endDate)) {
        return {
          additions,
          warnings: [`Loaded ${additions.length} daily BTC rows after ${latestExistingDate} from CryptoCompare/CoinDesk.`],
          usedFallback: false,
        };
      }

      const latestCryptoCompareDate = additions.at(-1)?.date ?? "no rows";
      warnings.push(`CryptoCompare/CoinDesk returned ${additions.length} newer BTC rows but only through ${latestCryptoCompareDate}.`);
    } catch (error) {
      warnings.push(`CryptoCompare/CoinDesk refresh failed (${errorMessage(error)}); trying free daily fallback sources.`);
    }
  } else {
    warnings.push(`Skipping CryptoCompare/CoinDesk append because ${missingDays} missing days exceeds its request limit.`);
  }

  const fallbackFailures = [];

  for (const source of dailyFallbackSources()) {
    try {
      const result = await source.fetchAdditions(latestExistingDate, endDate);
      const additions = result.rows.filter((row) => row.date > latestExistingDate && row.date <= endDate);

      if (additionsCoverEndDate(additions, endDate)) {
        return {
          additions,
          warnings: [
            ...warnings,
            ...result.warnings,
            `Loaded ${additions.length} daily BTC rows after ${latestExistingDate} from ${source.label}.`,
          ],
          usedFallback: true,
          fallbackSourceUrl: source.sourceUrl,
        };
      }

      const latestFallbackDate = additions.at(-1)?.date ?? "no rows";
      warnings.push(`${source.label} returned ${additions.length} newer BTC rows but only through ${latestFallbackDate}; trying next fallback.`);
    } catch (error) {
      const message = `${source.label} daily fallback failed (${errorMessage(error)}).`;
      warnings.push(message);
      fallbackFailures.push(message);
    }
  }

  throw new Error(`All daily BTC fallback sources failed: ${fallbackFailures.join(" ")}`);
}

async function fetchBatch(toTs, limit) {
  const url = new URL(HISTODAY_URL);
  url.searchParams.set("fsym", "BTC");
  url.searchParams.set("tsym", "USD");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("toTs", String(toTs));
  url.searchParams.set("extraParams", "btc-atc-github-pages");
  if (cryptoCompareApiKey) {
    url.searchParams.set("api_key", cryptoCompareApiKey);
  }

  const json = await fetchJson(url, "CryptoCompare");
  if (json.Response !== "Success") {
    throw new Error(json.Message || "CryptoCompare response was not successful.");
  }

  return json.Data?.Data ?? [];
}

async function fetchCoinbaseAdditions(latestExistingDate, endDate) {
  const rows = [];
  let cursor = addUtcDays(latestExistingDate, 1);
  const end = parseUtcDate(endDate);

  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + (COINBASE_MAX_DAILY_CANDLES - 1) * DAY_MS));
    const batch = await fetchCoinbaseBatch(formatUtcDate(cursor), formatUtcDate(chunkEnd));
    rows.push(...batch.map(normalizeCoinbaseRow));
    cursor = new Date(chunkEnd.getTime() + DAY_MS);
  }

  return dedupeAndSort(rows).filter((row) => row.date > latestExistingDate && row.date <= endDate);
}

function dailyFallbackSources() {
  return [
    {
      label: "Coinbase Exchange BTC-USD daily candles",
      sourceUrl: COINBASE_CANDLES_URL,
      fetchAdditions: async (latestExistingDate, endDate) => ({
        rows: await fetchCoinbaseAdditions(latestExistingDate, endDate),
        warnings: [],
      }),
    },
    {
      label: "Binance BTCUSDT daily klines",
      sourceUrl: BINANCE_KLINES_URL,
      fetchAdditions: async (latestExistingDate, endDate) => ({
        rows: await fetchBinanceAdditions(latestExistingDate, endDate),
        warnings: [],
      }),
    },
    {
      label: "Bitstamp BTC/USD daily OHLC",
      sourceUrl: BITSTAMP_OHLC_URL,
      fetchAdditions: async (latestExistingDate, endDate) => ({
        rows: await fetchBitstampAdditions(latestExistingDate, endDate),
        warnings: [],
      }),
    },
    {
      label: "Kraken XBTUSD daily OHLC",
      sourceUrl: KRAKEN_OHLC_URL,
      fetchAdditions: async (latestExistingDate, endDate) => ({
        rows: await fetchKrakenAdditions(latestExistingDate, endDate),
        warnings: [],
      }),
    },
    {
      label: "KuCoin BTC-USDT daily klines",
      sourceUrl: KUCOIN_CANDLES_URL,
      fetchAdditions: async (latestExistingDate, endDate) => ({
        rows: await fetchKuCoinAdditions(latestExistingDate, endDate),
        warnings: [],
      }),
    },
    {
      label: "CoinGecko Bitcoin daily market chart",
      sourceUrl: COINGECKO_MARKET_CHART_URL,
      fetchAdditions: async (latestExistingDate, endDate) => ({
        rows: await fetchCoinGeckoAdditions(latestExistingDate, endDate),
        warnings: ["CoinGecko market chart rows include daily close and volume only; open/high/low were approximated from adjacent closes."],
      }),
    },
  ];
}

async function fetchBinanceAdditions(latestExistingDate, endDate) {
  const rows = [];
  let cursor = addUtcDays(latestExistingDate, 1);
  const end = parseUtcDate(endDate);
  const maxRows = 1000;

  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + (maxRows - 1) * DAY_MS));
    const url = new URL(BINANCE_KLINES_URL);
    url.searchParams.set("symbol", "BTCUSDT");
    url.searchParams.set("interval", "1d");
    url.searchParams.set("startTime", String(cursor.getTime()));
    url.searchParams.set("endTime", String(chunkEnd.getTime() + DAY_MS - 1));
    url.searchParams.set("limit", String(maxRows));

    const batch = await fetchJson(url, "Binance klines");
    if (!Array.isArray(batch)) {
      throw new Error("Binance response was not a kline array.");
    }

    rows.push(...batch.map(normalizeBinanceRow));
    cursor = new Date(chunkEnd.getTime() + DAY_MS);
  }

  return filterValidPriceRows(rows, "Binance");
}

async function fetchBitstampAdditions(latestExistingDate, endDate) {
  const rows = [];
  let cursor = addUtcDays(latestExistingDate, 1);
  const end = parseUtcDate(endDate);
  const maxRows = 1000;

  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + (maxRows - 1) * DAY_MS));
    const url = new URL(BITSTAMP_OHLC_URL);
    url.searchParams.set("step", String(DAY_SECONDS));
    url.searchParams.set("limit", String(maxRows));
    url.searchParams.set("start", String(unixSeconds(cursor)));
    url.searchParams.set("end", String(unixSeconds(chunkEnd)));
    url.searchParams.set("exclude_current_candle", "true");

    const json = await fetchJson(url, "Bitstamp OHLC");
    const batch = json.data?.ohlc;
    if (!Array.isArray(batch)) {
      throw new Error("Bitstamp response did not include OHLC rows.");
    }

    rows.push(...batch.map(normalizeBitstampRow));
    cursor = new Date(chunkEnd.getTime() + DAY_MS);
  }

  return filterValidPriceRows(rows, "Bitstamp");
}

async function fetchKrakenAdditions(latestExistingDate, endDate) {
  const url = new URL(KRAKEN_OHLC_URL);
  url.searchParams.set("pair", "XBTUSD");
  url.searchParams.set("interval", "1440");
  url.searchParams.set("since", String(unixSeconds(addUtcDays(latestExistingDate, 1))));

  const json = await fetchJson(url, "Kraken OHLC");
  if (Array.isArray(json.error) && json.error.length) {
    throw new Error(json.error.join("; "));
  }

  const result = json.result && Object.entries(json.result).find(([key]) => key !== "last")?.[1];
  if (!Array.isArray(result)) {
    throw new Error("Kraken response did not include OHLC rows.");
  }

  return filterValidPriceRows(result.map(normalizeKrakenRow), "Kraken").filter((row) => row.date <= endDate);
}

async function fetchKuCoinAdditions(latestExistingDate, endDate) {
  const rows = [];
  let cursor = addUtcDays(latestExistingDate, 1);
  const end = parseUtcDate(endDate);
  const maxRows = 1500;

  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + (maxRows - 1) * DAY_MS));
    const url = new URL(KUCOIN_CANDLES_URL);
    url.searchParams.set("symbol", "BTC-USDT");
    url.searchParams.set("type", "1day");
    url.searchParams.set("startAt", String(unixSeconds(cursor)));
    url.searchParams.set("endAt", String(unixSeconds(chunkEnd)));

    const json = await fetchJson(url, "KuCoin candles");
    if (json.code !== "200000" || !Array.isArray(json.data)) {
      throw new Error(json.msg || "KuCoin response did not include candle rows.");
    }

    rows.push(...json.data.map(normalizeKuCoinRow));
    cursor = new Date(chunkEnd.getTime() + DAY_MS);
  }

  return filterValidPriceRows(rows, "KuCoin");
}

async function fetchCoinGeckoAdditions(latestExistingDate, endDate) {
  const url = new URL(COINGECKO_MARKET_CHART_URL);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("from", String(unixSeconds(addUtcDays(latestExistingDate, 1))));
  url.searchParams.set("to", String(unixSeconds(addUtcDays(endDate, 1))));
  url.searchParams.set("interval", "daily");
  url.searchParams.set("precision", "full");

  const json = await fetchJson(url, "CoinGecko market chart");
  if (!Array.isArray(json.prices)) {
    throw new Error("CoinGecko response did not include price rows.");
  }

  const volumeByDate = new Map(
    Array.isArray(json.total_volumes)
      ? json.total_volumes.map(([timestamp, volume]) => [dateFromUnixMilliseconds(timestamp), finiteNumber(volume)])
      : [],
  );
  let previousClose = await previousCloseForDate(latestExistingDate);
  const rows = [];

  for (const [timestamp, price] of json.prices) {
    const date = dateFromUnixMilliseconds(timestamp);
    const close = finiteNumber(price);
    if (close <= 0) continue;

    const open = previousClose > 0 ? previousClose : close;
    const volumeTo = finiteNumber(volumeByDate.get(date));
    rows.push({
      date,
      time: unixSeconds(date),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volumeFrom: close > 0 ? volumeTo / close : 0,
      volumeTo,
    });
    previousClose = close;
  }

  return filterValidPriceRows(rows, "CoinGecko");
}

async function fetchCoinbaseCurrentDaySnapshot(date, latestCompleteRow) {
  try {
    const candle = await fetchCoinbaseCurrentDayCandle(date);

    if (candle) {
      return {
        row: {
          ...normalizeCoinbaseRow(candle),
          date,
          time: unixSeconds(date),
        },
        source: "Coinbase Exchange BTC-USD candles",
        sourceUrl: COINBASE_CANDLES_URL,
        warnings: [],
      };
    }
  } catch (error) {
    return fetchCurrentTickerSnapshot(date, latestCompleteRow, [
      `Coinbase Exchange current-day candle failed (${errorMessage(error)}); trying ticker fallbacks.`,
    ]);
  }

  return fetchCurrentTickerSnapshot(date, latestCompleteRow, [
    "Coinbase Exchange current-day candle returned no current UTC-day row; trying ticker fallbacks.",
  ]);
}

async function fetchCoinbaseCurrentDayCandle(date) {
  const now = new Date();
  const today = `${date}T00:00:00Z`;
  const url = new URL(COINBASE_CANDLES_URL);
  url.searchParams.set("granularity", String(DAY_SECONDS));
  url.searchParams.set("start", today);
  url.searchParams.set("end", now.toISOString());

  const json = await fetchJson(url, "Coinbase current-day candle");
  if (!Array.isArray(json)) {
    throw new Error("Coinbase response was not a candle array.");
  }

  return json
    .filter((row) => Array.isArray(row) && dateFromUnixSeconds(row[0]) === date)
    .sort((a, b) => a[0] - b[0])
    .at(-1);
}

async function fetchCurrentTickerSnapshot(date, latestCompleteRow, warnings = []) {
  const failures = [];

  for (const source of currentPriceSources()) {
    try {
      const quote = await source.fetchPrice();
      const row = tickerQuoteToPriceRow(date, latestCompleteRow, quote);

      return {
        row,
        source: quote.source,
        sourceUrl: quote.sourceUrl,
        warnings: [...warnings, ...failures],
      };
    } catch (error) {
      failures.push(`${source.label} failed (${errorMessage(error)}).`);
    }
  }

  throw new Error(`All current BTC price sources failed: ${failures.join(" ")}`);
}

function currentPriceSources() {
  return [
    {
      label: "Coinbase Exchange BTC-USD ticker",
      fetchPrice: fetchCoinbaseTickerPrice,
    },
    {
      label: "Binance BTCUSDT ticker",
      fetchPrice: fetchBinanceTickerPrice,
    },
    {
      label: "Kraken XBTUSD ticker",
      fetchPrice: fetchKrakenTickerPrice,
    },
    {
      label: "Bitstamp BTC/USD ticker",
      fetchPrice: fetchBitstampTickerPrice,
    },
    {
      label: "CoinGecko Bitcoin simple price",
      fetchPrice: fetchCoinGeckoTickerPrice,
    },
  ];
}

async function fetchCoinbaseTickerPrice() {
  const json = await fetchJson(COINBASE_TICKER_URL, "Coinbase Exchange ticker");

  return buildTickerQuote({
    source: "Coinbase Exchange BTC-USD ticker",
    sourceUrl: COINBASE_TICKER_URL,
    price: json.price,
    volumeFrom: json.volume,
  });
}

async function fetchBinanceTickerPrice() {
  const json = await fetchJson(BINANCE_TICKER_URL, "Binance ticker");

  return buildTickerQuote({
    source: "Binance BTCUSDT ticker",
    sourceUrl: BINANCE_TICKER_URL,
    price: json.price,
  });
}

async function fetchKrakenTickerPrice() {
  const json = await fetchJson(KRAKEN_TICKER_URL, "Kraken ticker");
  if (Array.isArray(json.error) && json.error.length) {
    throw new Error(json.error.join("; "));
  }

  const result = json.result && Object.values(json.result)[0];
  if (!result) {
    throw new Error("Kraken response did not include ticker data.");
  }

  return buildTickerQuote({
    source: "Kraken XBTUSD ticker",
    sourceUrl: KRAKEN_TICKER_URL,
    price: result.c?.[0],
    volumeFrom: result.v?.[1],
  });
}

async function fetchBitstampTickerPrice() {
  const json = await fetchJson(BITSTAMP_TICKER_URL, "Bitstamp ticker");

  return buildTickerQuote({
    source: "Bitstamp BTC/USD ticker",
    sourceUrl: BITSTAMP_TICKER_URL,
    price: json.last,
    volumeFrom: json.volume,
  });
}

async function fetchCoinGeckoTickerPrice() {
  const json = await fetchJson(COINGECKO_TICKER_URL, "CoinGecko ticker");
  const bitcoin = json.bitcoin;
  const price = finiteNumber(bitcoin?.usd);
  const volumeTo = finiteNumber(bitcoin?.usd_24h_vol);

  return buildTickerQuote({
    source: "CoinGecko Bitcoin simple price",
    sourceUrl: COINGECKO_TICKER_URL,
    price,
    volumeFrom: price > 0 ? volumeTo / price : 0,
    volumeTo,
  });
}

async function fetchJson(url, sourceName) {
  const response = await fetchWithRetry(url, sourceName);

  return response.json();
}

async function fetchWithRetry(url, sourceName, options = {}) {
  const maxAttempts = options.maxAttempts ?? HTTP_MAX_ATTEMPTS;
  const retryDelays = options.retryDelays ?? HTTP_RETRY_DELAYS_MS;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "btc-atc-github-pages",
          ...options.headers,
        },
        signal: controller.signal,
      });

      if (response.ok) {
        return response;
      }

      const error = new Error(`${sourceName} request failed with ${response.status}: ${response.statusText}`);
      error.status = response.status;
      lastError = error;

      if (!shouldRetryHttpStatus(response.status, attempt, maxAttempts)) {
        throw error;
      }
    } catch (error) {
      lastError = error instanceof Error && error.name === "AbortError"
        ? new Error(`${sourceName} request timed out after ${options.timeoutMs ?? HTTP_TIMEOUT_MS}ms.`)
        : error;

      if (typeof lastError?.status === "number" && !shouldRetryHttpStatus(lastError.status, attempt, maxAttempts)) {
        if (attempt > 0 && isRetryableError(lastError)) {
          throw new Error(`${errorMessage(lastError)} after ${attempt + 1} attempts.`);
        }

        throw lastError;
      }

      if (!isRetryableError(lastError) || attempt >= maxAttempts - 1) {
        if (attempt >= maxAttempts - 1 && isRetryableError(lastError)) {
          throw new Error(`${errorMessage(lastError)} after ${attempt + 1} attempts.`);
        }

        throw lastError;
      }
    } finally {
      clearTimeout(timeout);
    }

    await delay(retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 0);
  }

  throw lastError ?? new Error(`${sourceName} request failed.`);
}

function buildTickerQuote({ source, sourceUrl, price, volumeFrom = 0, volumeTo }) {
  const close = finiteNumber(price);
  if (close <= 0) {
    throw new Error(`${source} did not include a valid BTC price.`);
  }

  const normalizedVolumeFrom = finiteNumber(volumeFrom);
  const normalizedVolumeTo = finiteNumber(volumeTo);

  return {
    source,
    sourceUrl,
    close,
    volumeFrom: normalizedVolumeFrom,
    volumeTo: normalizedVolumeTo > 0 ? normalizedVolumeTo : Number((normalizedVolumeFrom * close).toFixed(2)),
  };
}

function tickerQuoteToPriceRow(date, latestCompleteRow, quote) {
  const open = latestCompleteRow.close;

  return {
    date,
    time: unixSeconds(date),
    open,
    high: Math.max(open, quote.close),
    low: Math.min(open, quote.close),
    close: quote.close,
    volumeFrom: quote.volumeFrom,
    volumeTo: quote.volumeTo,
  };
}

async function fetchCoinbaseBatch(startDate, endDate) {
  const url = new URL(COINBASE_CANDLES_URL);
  url.searchParams.set("granularity", String(DAY_SECONDS));
  url.searchParams.set("start", `${startDate}T00:00:00Z`);
  url.searchParams.set("end", `${endDate}T00:00:00Z`);

  const json = await fetchJson(url, "Coinbase candles");
  if (!Array.isArray(json)) {
    throw new Error("Coinbase response was not a candle array.");
  }

  return json;
}

function normalizePriceRow(row) {
  return {
    date: dateFromUnixSeconds(row.time),
    time: row.time,
    open: finiteNumber(row.open),
    high: finiteNumber(row.high),
    low: finiteNumber(row.low),
    close: finiteNumber(row.close),
    volumeFrom: finiteNumber(row.volumefrom),
    volumeTo: finiteNumber(row.volumeto),
  };
}

function normalizeCoinbaseRow(row) {
  const [time, low, high, open, close, volume] = row;
  const closeValue = finiteNumber(close);
  const volumeFrom = finiteNumber(volume);

  return {
    date: dateFromUnixSeconds(time),
    time: finiteNumber(time),
    open: finiteNumber(open),
    high: finiteNumber(high),
    low: finiteNumber(low),
    close: closeValue,
    volumeFrom,
    volumeTo: Number((volumeFrom * closeValue).toFixed(2)),
  };
}

function normalizeBinanceRow(row) {
  const open = finiteNumber(row[1]);
  const high = finiteNumber(row[2]);
  const low = finiteNumber(row[3]);
  const close = finiteNumber(row[4]);
  const volumeFrom = finiteNumber(row[5]);
  const volumeTo = finiteNumber(row[7]);

  return {
    date: dateFromUnixMilliseconds(row[0]),
    time: Math.floor(finiteNumber(row[0]) / 1000),
    open,
    high,
    low,
    close,
    volumeFrom,
    volumeTo: volumeTo > 0 ? volumeTo : Number((volumeFrom * close).toFixed(2)),
  };
}

function normalizeBitstampRow(row) {
  const close = finiteNumber(row.close);
  const volumeFrom = finiteNumber(row.volume);

  return {
    date: dateFromUnixSeconds(row.timestamp),
    time: finiteNumber(row.timestamp),
    open: finiteNumber(row.open),
    high: finiteNumber(row.high),
    low: finiteNumber(row.low),
    close,
    volumeFrom,
    volumeTo: Number((volumeFrom * close).toFixed(2)),
  };
}

function normalizeKrakenRow(row) {
  const [time, open, high, low, close, , volume] = row;
  const closeValue = finiteNumber(close);
  const volumeFrom = finiteNumber(volume);

  return {
    date: dateFromUnixSeconds(time),
    time: finiteNumber(time),
    open: finiteNumber(open),
    high: finiteNumber(high),
    low: finiteNumber(low),
    close: closeValue,
    volumeFrom,
    volumeTo: Number((volumeFrom * closeValue).toFixed(2)),
  };
}

function normalizeKuCoinRow(row) {
  const [time, open, close, high, low, volume, turnover] = row;
  const closeValue = finiteNumber(close);
  const volumeFrom = finiteNumber(volume);
  const volumeTo = finiteNumber(turnover);

  return {
    date: dateFromUnixSeconds(time),
    time: finiteNumber(time),
    open: finiteNumber(open),
    high: finiteNumber(high),
    low: finiteNumber(low),
    close: closeValue,
    volumeFrom,
    volumeTo: volumeTo > 0 ? volumeTo : Number((volumeFrom * closeValue).toFixed(2)),
  };
}

function dedupeAndSort(rows) {
  return [...new Map(rows.map((row) => [row.time, row])).values()].sort((a, b) => a.time - b.time);
}

function filterValidPriceRows(rows, sourceName) {
  return dedupeAndSort(rows).filter((row) => {
    const isValid = (
      typeof row.date === "string" &&
      Number.isFinite(row.time) &&
      row.open > 0 &&
      row.high > 0 &&
      row.low > 0 &&
      row.close > 0 &&
      row.high >= row.low
    );

    if (!isValid) {
      console.warn(`${sourceName} returned an invalid BTC row for ${row.date ?? "unknown date"}; skipping it.`);
    }

    return isValid;
  });
}

function additionsCoverEndDate(additions, endDate) {
  return additions.some((row) => row.date === endDate);
}

function generateQuantiles(startDate, endDate) {
  const rows = [];
  let cursor = parseUtcDate(startDate);
  const end = parseUtcDate(endDate);

  while (cursor <= end) {
    const date = formatUtcDate(cursor);
    rows.push({
      date,
      time: unixSeconds(date),
      ...estimateQuantiles(date),
    });
    cursor = new Date(cursor.getTime() + DAY_MS);
  }

  return rows;
}

function estimateQuantiles(date) {
  const x = Math.log(daysSinceGenesis(date)) - model.mu;
  const raw = model.coefficients.map((coefficient) => ({
    key: coefficient.key,
    value: 10 ** (coefficient.c + coefficient.a * x + coefficient.b * x * x),
  }));
  const rearranged = raw.map((item) => item.value).sort((a, b) => a - b);

  return raw.reduce((values, item, index) => {
    values[item.key] = roundPrice(rearranged[index]);
    return values;
  }, {});
}

function daysSinceGenesis(date) {
  return Math.round((parseUtcDate(date).getTime() - parseUtcDate(model.anchorDate).getTime()) / DAY_MS);
}

function previousCompleteUtcDay(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(today.getTime() - DAY_MS);
}

function currentUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function parseUtcDate(date) {
  if (date instanceof Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  return new Date(`${date}T00:00:00.000Z`);
}

function addUtcDays(date, days) {
  return new Date(parseUtcDate(date).getTime() + days * DAY_MS);
}

function formatUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function unixSeconds(date) {
  return Math.floor(parseUtcDate(date).getTime() / 1000);
}

function dateFromUnixSeconds(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function dateFromUnixMilliseconds(milliseconds) {
  return new Date(finiteNumber(milliseconds)).toISOString().slice(0, 10);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function shouldRetryHttpStatus(status, attempt, maxAttempts) {
  if (attempt >= maxAttempts - 1) return false;
  if (status === 403) return attempt === 0;

  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error) {
  const status = error?.status;
  if (typeof status === "number") {
    return status === 408 || status === 429 || status >= 500 || status === 403;
  }

  return error instanceof TypeError || String(error?.message ?? error).includes("timed out");
}

async function delay(milliseconds) {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function roundPrice(value) {
  if (value < 1) return Number(value.toFixed(5));
  if (value < 100) return Number(value.toFixed(3));
  return Number(value.toFixed(2));
}

async function assertExistingSnapshot() {
  if (!existsSync(outputPath)) {
    throw new Error(`Missing offline data snapshot: ${relative(outputPath)}`);
  }

  const payload = JSON.parse(await readFile(outputPath, "utf8"));
  if (!Array.isArray(payload.prices) || payload.prices.length === 0) {
    throw new Error(`Offline data snapshot has no price rows: ${relative(outputPath)}`);
  }
}

async function readExistingSnapshot() {
  if (!existsSync(outputPath)) return null;

  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    return null;
  }
}

async function previousCloseForDate(date) {
  const snapshot = await readExistingSnapshot();
  const row = snapshot?.prices?.find((item) => item.date === date);

  return finiteNumber(row?.close);
}

async function shouldFailStaleRefresh(latestDateOverride) {
  if (process.env.GITHUB_ACTIONS !== "true" && process.env.CI !== "true") {
    return false;
  }

  const snapshot = await readExistingSnapshot();
  const latestDate = latestDateOverride ?? snapshot?.metadata?.latestCloseDate ?? snapshot?.prices?.at(-1)?.date;

  return typeof latestDate === "string" && latestDate < formatUtcDate(currentUtcDay());
}

function currentSnapshotWarnings(snapshot, latestDate) {
  const retainedWarnings = Array.isArray(snapshot?.metadata?.warnings)
    ? snapshot.metadata.warnings.filter(isSourceWarning)
    : [];

  return [...retainedWarnings, `Existing snapshot already current through ${latestDate}.`];
}

function snapshotUsedFallback(snapshot) {
  return Boolean(
    snapshot?.metadata?.fallbackSourceUrl ||
      snapshot?.metadata?.source?.includes("fallback BTC/USD market data rows") ||
      snapshot?.metadata?.warnings?.some(isSourceWarning),
  );
}

function snapshotFallbackSourceUrl(snapshot) {
  return snapshot?.metadata?.fallbackSourceUrl;
}

function isSourceWarning(warning) {
  return (
    typeof warning === "string" &&
    (
      warning.includes("CryptoCompare/CoinDesk refresh failed") ||
      warning.includes("daily fallback failed") ||
      warning.includes("Loaded") && warning.includes("daily BTC rows")
    )
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

function isCliEntrypoint() {
  return process.argv[1] ? path.resolve(process.argv[1]) === modulePath : false;
}

export {
  appendCurrentDaySnapshot,
  fetchIncrementalAdditions,
  fetchWithRetry,
  normalizeBinanceRow,
  normalizeBitstampRow,
  normalizeCoinbaseRow,
  normalizeKrakenRow,
  normalizeKuCoinRow,
};
