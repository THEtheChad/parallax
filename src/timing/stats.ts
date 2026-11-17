// Statistics for timing samples. Everything here is deterministic (the bootstrap uses a seeded
// generator), so a summary stays a pure function of the samples in a bundle.

export function quantile(values: readonly number[], q: number): number {
  if (!values.length) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const median = (values: readonly number[]): number => quantile(values, 0.5);

// mulberry32: small, fast, good enough for resampling.
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
  confidence: number;
  n: number;
}

// Percentile-bootstrap interval for the median. With fewer than 2 values the interval is the value
// itself; callers decide whether n is enough to make a claim.
export function bootstrapMedian(
  values: readonly number[],
  { iterations = 4000, confidence = 0.95, seed = 0x5eed } = {},
): Interval | null {
  const n = values.length;
  if (!n) return null;
  const estimate = median(values);
  if (n < 2) return { estimate, low: estimate, high: estimate, confidence, n };
  const rand = seededRandom(seed);
  const medians = new Float64Array(iterations);
  const resample = new Array<number>(n);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < n; j++) resample[j] = values[Math.floor(rand() * n)]!;
    medians[i] = median(resample);
  }
  const tail = (1 - confidence) / 2;
  const sorted = Array.from(medians);
  return { estimate, low: quantile(sorted, tail), high: quantile(sorted, 1 - tail), confidence, n };
}

// How a candidate compares with the reference, from the interval of paired ratios (candidate time /
// reference time): a claim needs the whole interval on one side of 1.
export type Call = "faster" | "slower" | "indistinguishable";

// Faster or slower only when the whole interval is on one side of 1 and the estimate differs from 1 by
// at least `minEffect` (1%): a difference too small to print is no difference.
export const MIN_EFFECT = 0.01;
export const callOf = (ratio: Interval, minEffect = MIN_EFFECT): Call =>
  ratio.high < 1 && ratio.estimate <= 1 - minEffect ? "faster" : ratio.low > 1 && ratio.estimate >= 1 + minEffect ? "slower" : "indistinguishable";
