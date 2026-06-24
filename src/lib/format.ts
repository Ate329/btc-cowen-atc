const currencyFormatter = {
  zeroDecimals: new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }),
  twoDecimals: new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }),
  fourDecimals: new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }),
};

const compactCurrencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});
const numberFormatterByDigits = new Map<number, Intl.NumberFormat>();

function getNumberFormatter(maximumFractionDigits: number): Intl.NumberFormat {
  if (maximumFractionDigits === 2) return numberFormatter;

  const cached = numberFormatterByDigits.get(maximumFractionDigits);
  if (cached) return cached;

  const next = new Intl.NumberFormat("en-US", { maximumFractionDigits });
  numberFormatterByDigits.set(maximumFractionDigits, next);
  return next;
}

const dateLabelFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const snapshotDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
  timeZoneName: "short",
});

export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return "n/a";

  if (value >= 100) return currencyFormatter.zeroDecimals.format(value);
  if (value >= 1) return currencyFormatter.twoDecimals.format(value);
  return currencyFormatter.fourDecimals.format(value);
}

export function formatCompactCurrency(value: number): string {
  if (!Number.isFinite(value)) return "n/a";

  return compactCurrencyFormatter.format(value);
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "n/a";

  return percentFormatter.format(value);
}

export function formatNumber(value: number, maximumFractionDigits = 2): string {
  if (!Number.isFinite(value)) return "n/a";

  return getNumberFormatter(maximumFractionDigits).format(value);
}

export function formatDateLabel(date: string): string {
  return dateLabelFormatter.format(new Date(`${date}T00:00:00.000Z`));
}

export function formatSnapshotDateTimeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return snapshotDateTimeFormatter.format(date);
}
