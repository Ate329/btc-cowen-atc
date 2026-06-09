import { describe, expect, it } from "vitest";
import { sampleExtremaRowsByXBucket, sampleRowsByCount } from "../src/lib/chartSampling";

type Row = {
  date: string;
  close: number;
  x: number;
};

describe("chart sampling", () => {
  it("samples rows by count while preserving endpoints and date order", () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(index, index, index));
    const sampled = sampleRowsByCount(rows, 12);

    expect(sampled.length).toBeLessThanOrEqual(13);
    expect(sampled[0]).toBe(rows[0]);
    expect(sampled.at(-1)).toBe(rows.at(-1));
    expect(isOrdered(sampled)).toBe(true);
  });

  it("keeps first, last, min, and max rows inside each x bucket", () => {
    const rows = [
      row(0, 10, 0.1),
      row(1, 2, 0.2),
      row(2, 20, 0.3),
      row(3, 12, 0.4),
      row(4, 5, 1.1),
    ];

    const sampled = sampleExtremaRowsByXBucket(rows, (item) => item.x, (item) => item.close, 2);

    expect(sampled).toEqual(rows);
  });

  it("bounds extrema sampling output while preserving visible spikes", () => {
    const rows = Array.from({ length: 120 }, (_, index) => row(index, index, index / 12));
    rows[23].close = -100;
    rows[28].close = 200;

    const sampled = sampleExtremaRowsByXBucket(rows, (item) => item.x, (item) => item.close, 10);

    expect(sampled.length).toBeLessThanOrEqual(40);
    expect(sampled).toContain(rows[23]);
    expect(sampled).toContain(rows[28]);
    expect(sampled[0]).toBe(rows[0]);
    expect(sampled.at(-1)).toBe(rows.at(-1));
    expect(isOrdered(sampled)).toBe(true);
  });
});

function row(index: number, close: number, x: number): Row {
  return {
    date: `row-${String(index).padStart(4, "0")}`,
    close,
    x,
  };
}

function isOrdered(rows: Row[]) {
  return rows.every((item, index) => index === 0 || rows[index - 1].date < item.date);
}
