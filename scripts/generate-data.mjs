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
const COINBASE_MAX_DAILY_CANDLES = 300;

const model = JSON.parse(await readFile(configPath, "utf8"));
const isOffline = process.argv.includes("--offline");
const forceRefresh = process.argv.includes("--force-refresh");
const cryptoCompareApiKey = process.env.CRYPTOCOMPARE_API_KEY ?? process.env.COINDESK_API_KEY ?? "";

if (isOffline) {
  await assertExistingSnapshot();
  process.exit(0);
}

try {
  const { rows: prices, warnings, usedCoinbaseFallback = false } = await buildPriceRows();
  const quantiles = generateQuantiles(model.startDate, model.projectionEndDate);

  if (prices.length === 0) {
    throw new Error("CryptoCompare returned no BTC price rows.");
  }

  const payload = {
    metadata: {
      generatedAt: new Date().toISOString(),
      source: usedCoinbaseFallback
        ? "CryptoCompare/CoinDesk legacy histoday BTC/USD daily OHLCV, with Coinbase Exchange BTC-USD fallback rows"
        : "CryptoCompare/CoinDesk legacy histoday BTC/USD daily OHLCV",
      sourceUrl: HISTODAY_URL,
      fallbackSourceUrl: usedCoinbaseFallback ? COINBASE_CANDLES_URL : undefined,
      startDate: model.startDate,
      latestCloseDate: prices.at(-1).date,
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

async function shouldFailStaleRefresh() {
  if (process.env.GITHUB_ACTIONS !== "true" && process.env.CI !== "true") {
    return false;
  }

  const snapshot = await readExistingSnapshot();
  const latestDate = snapshot?.metadata?.latestCloseDate ?? snapshot?.prices?.at(-1)?.date;

  return typeof latestDate === "string" && latestDate < formatUtcDate(previousCompleteUtcDay());
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
    (warning.includes("Coinbase Exchange") || warning.includes("CryptoCompare/CoinDesk refresh failed"))
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll("\\", "/");
}
