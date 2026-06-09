export function sampleRowsByCount<T>(rows: readonly T[], targetCount: number): T[] {
  const boundedTarget = Math.max(2, Math.floor(targetCount));

  if (rows.length <= boundedTarget) {
    return rows.slice();
  }

  const stride = Math.max(1, Math.ceil((rows.length - 1) / (boundedTarget - 1)));
  const sampled: T[] = [];

  for (let index = 0; index < rows.length; index += stride) {
    sampled.push(rows[index]);
  }

  const lastRow = rows.at(-1);
  if (lastRow && sampled.at(-1) !== lastRow) {
    sampled.push(lastRow);
  }

  return sampled;
}

type BucketPoint<T> = {
  index: number;
  row: T;
  value: number;
};

type Bucket<T> = {
  first: BucketPoint<T>;
  last: BucketPoint<T>;
  min: BucketPoint<T> | null;
  max: BucketPoint<T> | null;
};

export function sampleExtremaRowsByXBucket<T>(
  rows: readonly T[],
  getX: (row: T) => number,
  getValue: (row: T) => number,
  bucketCount: number,
): T[] {
  const boundedBucketCount = Math.max(1, Math.floor(bucketCount));

  if (rows.length <= boundedBucketCount) {
    return rows.slice();
  }

  const buckets = new Map<number, Bucket<T>>();

  rows.forEach((row, index) => {
    const x = getX(row);
    if (!Number.isFinite(x)) return;

    const value = getValue(row);
    const point: BucketPoint<T> = { index, row, value };
    const bucketIndex = clamp(Math.floor(x), 0, boundedBucketCount - 1);
    const bucket = buckets.get(bucketIndex);

    if (!bucket) {
      buckets.set(bucketIndex, {
        first: point,
        last: point,
        min: Number.isFinite(value) ? point : null,
        max: Number.isFinite(value) ? point : null,
      });
      return;
    }

    bucket.last = point;

    if (Number.isFinite(value)) {
      if (!bucket.min || value < bucket.min.value) bucket.min = point;
      if (!bucket.max || value > bucket.max.value) bucket.max = point;
    }
  });

  const sampled: BucketPoint<T>[] = [];

  [...buckets.entries()]
    .sort(([firstBucket], [secondBucket]) => firstBucket - secondBucket)
    .forEach(([, bucket]) => {
      const candidates = [bucket.first, bucket.min, bucket.max, bucket.last]
        .filter((point): point is BucketPoint<T> => Boolean(point))
        .sort((first, second) => first.index - second.index);

      for (const point of candidates) {
        if (sampled.at(-1)?.index !== point.index) {
          sampled.push(point);
        }
      }
    });

  return sampled.map((point) => point.row);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
