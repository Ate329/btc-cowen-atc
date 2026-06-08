const DAY_MS = 86_400_000;

export function parseUtcDate(date: string | Date): Date {
  if (date instanceof Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  return new Date(`${date}T00:00:00.000Z`);
}

export function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(parseUtcDate(date).getTime() + days * DAY_MS);
}

export function daysBetweenUtc(start: string | Date, end: string | Date): number {
  return Math.round((parseUtcDate(end).getTime() - parseUtcDate(start).getTime()) / DAY_MS);
}

export function unixSeconds(date: string | Date): number {
  return Math.floor(parseUtcDate(date).getTime() / 1000);
}

export function previousCompleteUtcDay(now = new Date()): Date {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return addUtcDays(today, -1);
}
