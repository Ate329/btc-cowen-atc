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

const model = JSON.parse(await readFile(configPath, "utf8"));
const isOffline = process.argv.includes("--offline");

if (isOffline) {
  await assertExistingSnapshot();
  process.exit(0);
}

try {
  const { rows: prices, warnings } = await buildPriceRows();
  const quantiles = generateQuantiles(model.startDate, model.projectionEndDate);

  if (prices.length === 0) {
    throw new Error("CryptoCompare returned no BTC price rows.");
  }

  const payload = {
    metadata: {
      generatedAt: new Date().toISOString(),
      source: "CryptoCompare/CoinDesk legacy histoday BTC/USD daily OHLCV",
      sourceUrl: HISTODAY_URL,
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

    if (latestExistingDate && latestExistingDate >= endDate) {
      return {
        rows: existingRows,
        warnings: [`Existing snapshot already current through ${latestExistingDate}.`],
      };
    }

    if (latestExistingDate) {
      const missingDays = Math.ceil((unixSeconds(endDate) - unixSeconds(latestExistingDate)) / DAY_SECONDS);

      if (missingDays > 0 && missingDays <= 2000) {
        const batch = await fetchBatch(unixSeconds(endDate), Math.min(2000, missingDays + 5));
        const additions = batch
          .filter((row) => row.time > unixSeconds(latestExistingDate) && row.time <= unixSeconds(endDate))
          .map(normalizePriceRow);

        const merged = dedupeAndSort([...existingRows, ...additions]);

        return {
          rows: merged,
          warnings: additions.length
            ? [`Appended ${additions.length} daily BTC rows after ${latestExistingDate}.`]
            : [`No newer BTC rows available after ${latestExistingDate}.`],
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

async function fetchBatch(toTs, limit) {
  const url = new URL(HISTODAY_URL);
  url.searchParams.set("fsym", "BTC");
  url.searchParams.set("tsym", "USD");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("toTs", String(toTs));
  url.searchParams.set("extraParams", "btc-atc-github-pages");

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

function relative(filePath) {
  return path.relative(root, filePath).replaceAll("\\", "/");
}
