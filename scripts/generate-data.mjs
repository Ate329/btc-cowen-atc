import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "src", "data", "model-config.json");
const outputPath = path.join(root, "public", "data", "btc-atc.json");

const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;
const HISTODAY_URL = "https://min-api.cryptocompare.com/data/v2/histoday";
const COINBASE_CANDLES_URL = "https://api.exchange.coinbase.com/products/BTC-USD/candles";
const COINBASE_TICKER_URL = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";
const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const KRAKEN_TICKER_URL = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD";
const BITSTAMP_TICKER_URL = "https://www.bitstamp.net/api/v2/ticker/btcusd/";
const COINGECKO_TICKER_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true&precision=full";
const COINBASE_MAX_DAILY_CANDLES = 300;
const CURRENT_PRICE_TIMEOUT_MS = 8_000;

const model = JSON.parse(await readFile(configPath, "utf8"));
const isOffline = process.argv.includes("--offline");
const forceRefresh = process.argv.includes("--force-refresh");
const cryptoCompareApiKey = process.env.CRYPTOCOMPARE_API_KEY ?? process.env.COINDESK_API_KEY ?? "";

if (isOffline) {
  await assertExistingSnapshot();
  process.exit(0);
}

try {
  const {
    rows: prices,
    warnings,
    usedCoinbaseFallback = false,
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
      source: usedCoinbaseFallback || currentPriceSource
        ? "CryptoCompare/CoinDesk legacy histoday BTC/USD daily OHLCV, with fallback BTC/USD market data rows"
        : "CryptoCompare/CoinDesk legacy histoday BTC/USD daily OHLCV",
      sourceUrl: HISTODAY_URL,
      fallbackSourceUrl: usedCoinbaseFallback ? COINBASE_CANDLES_URL : undefined,
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
        usedCoinbaseFallback: snapshotUsedCoinbaseFallback(existing),
      };
    }

    if (latestExistingDate) {
      const refreshFromDate =
        forceRefresh && latestExistingDate >= endDate ? formatUtcDate(addUtcDays(endDate, -7)) : latestExistingDate;
      const missingDays = Math.ceil((unixSeconds(endDate) - unixSeconds(refreshFromDate)) / DAY_SECONDS);

      if (missingDays > 0) {
        const { additions, warnings, usedCoinbaseFallback } = await fetchIncrementalAdditions(
          refreshFromDate,
          endDate,
          missingDays,
        );
        const merged = dedupeAndSort([...existingRows, ...additions]);

        return {
          rows: merged,
          warnings,
          usedCoinbaseFallback,
        };
      }
    }
  }

  return fetchFullHistoricalPrices();
}

async function appendCurrentDaySnapshot({ rows, warnings, usedCoinbaseFallback = false }) {
  const today = formatUtcDate(currentUtcDay());
  const latestCompleteRow = rows.at(-1);

  if (!latestCompleteRow || latestCompleteRow.date >= today) {
    return { rows, warnings, usedCoinbaseFallback };
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
      usedCoinbaseFallback: true,
      currentPriceSource: currentDay.source,
      currentPriceSourceUrl: currentDay.sourceUrl,
    };
  } catch (error) {
    return {
      rows,
      warnings: [...warnings, `Coinbase Exchange current-day snapshot failed (${errorMessage(error)}).`],
      usedCoinbaseFallback,
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

      if (additions.length) {
        return {
          additions,
          warnings: [`Loaded ${additions.length} daily BTC rows after ${latestExistingDate} from CryptoCompare/CoinDesk.`],
          usedCoinbaseFallback: false,
        };
      }

      warnings.push(`CryptoCompare/CoinDesk returned no newer BTC rows after ${latestExistingDate}.`);
    } catch (error) {
      warnings.push(`CryptoCompare/CoinDesk refresh failed (${errorMessage(error)}); using Coinbase Exchange fallback.`);
    }
  } else {
    warnings.push(`Skipping CryptoCompare/CoinDesk append because ${missingDays} missing days exceeds its request limit.`);
  }

  try {
    const additions = await fetchCoinbaseAdditions(latestExistingDate, endDate);

    return {
      additions,
      warnings: additions.length
        ? [...warnings, `Loaded ${additions.length} daily BTC rows after ${latestExistingDate} from Coinbase Exchange BTC-USD candles.`]
        : [...warnings, `No newer BTC rows available after ${latestExistingDate}.`],
      usedCoinbaseFallback: additions.length > 0,
    };
  } catch (error) {
    throw new Error(`Coinbase Exchange fallback failed: ${errorMessage(error)}`);
  }
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

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CryptoCompare request failed with ${response.status}: ${response.statusText}`);
  }

  const json = await response.json();
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

  const response = await fetch(url, {
    headers: {
      "User-Agent": "btc-atc-github-pages",
    },
  });

  if (!response.ok) {
    throw new Error(`Coinbase request failed with ${response.status}: ${response.statusText}`);
  }

  const json = await response.json();
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CURRENT_PRICE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "btc-atc-github-pages",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${sourceName} request failed with ${response.status}: ${response.statusText}`);
    }

    return response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${sourceName} request timed out after ${CURRENT_PRICE_TIMEOUT_MS}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

  const response = await fetch(url, {
    headers: {
      "User-Agent": "btc-atc-github-pages",
    },
  });

  if (!response.ok) {
    throw new Error(`Coinbase request failed with ${response.status}: ${response.statusText}`);
  }

  const json = await response.json();
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

function dedupeAndSort(rows) {
  return [...new Map(rows.map((row) => [row.time, row])).values()].sort((a, b) => a.time - b.time);
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

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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

function snapshotUsedCoinbaseFallback(snapshot) {
  return Boolean(
    snapshot?.metadata?.fallbackSourceUrl ||
      snapshot?.metadata?.source?.includes("Coinbase Exchange") ||
      snapshot?.metadata?.warnings?.some(isSourceWarning),
  );
}

function isSourceWarning(warning) {
  return (
    typeof warning === "string" &&
    warning.includes("CryptoCompare/CoinDesk refresh failed")
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll("\\", "/");
}
