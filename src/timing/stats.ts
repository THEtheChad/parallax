// Statistics for timing samples. Everything here is deterministic, so a summary stays a pure function
// of the samples in a bundle.

export function quantile(values: readonly number[], q: number): number {
  if (!values.length) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const median = (values: readonly number[]): number => quantile(values, 0.5);

// mulberry32: small, fast, good enough for the canary's workload.
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

// Distribution-free interval for the median, from order statistics: [x(k), x(n+1-k)] of the sorted
// values, with the largest k whose coverage, 1 - 2·P(Binomial(n, 1/2) < k), is at least `target`.
// It assumes nothing about the shape of the distribution, which a handful of timing rounds cannot
// show. When no k reaches the target (fewer than 6 values at 95%), the interval is the whole range
// and `confidence` is what that range really covers, 1 - 2^(1-n): 94% at 5 values, 75% at 3.
export function medianInterval(values: readonly number[], target = 0.95): Interval | null {
  const n = values.length;
  if (!n) return null;
  const s = [...values].sort((a, b) => a - b);
  // below[j] = P(Binomial(n, 1/2) < j + 1) = P(B <= j)
  const below: number[] = [];
  let term = Math.pow(0.5, n);
  let sum = 0;
  for (let j = 0; j <= n; j++) {
    sum += term;
    below.push(sum);
    term = (term * (n - j)) / (j + 1);
  }
  const coverage = (k: number): number => Math.max(0, 1 - 2 * below[k - 1]!);
  let k = 1;
  while (k + 1 <= Math.ceil(n / 2) && coverage(k + 1) >= target) k++;
  return { estimate: median(s), low: s[k - 1]!, high: s[n - k]!, confidence: coverage(k), n };
}

// How a candidate compares with the reference, from the interval of paired ratios (candidate time /
// reference time): a claim needs the whole interval on one side of 1.
export type Call = "faster" | "slower" | "indistinguishable" | "too few rounds";

// Faster or slower only when the whole interval is on one side of 1 and the estimate differs from 1 by
// at least `minEffect` (1%): a difference too small to print is no difference. An interval that
// covers less than MIN_CALL_CONFIDENCE (90%) supports no call at all: with the order-statistic
// interval that takes at least 5 rounds, all on the same side of 1 (5 of 5 has a 6% chance by luck).
export const MIN_EFFECT = 0.01;
export const MIN_CALL_CONFIDENCE = 0.9;
export const callOf = (ratio: Interval, minEffect = MIN_EFFECT): Call =>
  ratio.confidence < MIN_CALL_CONFIDENCE
    ? "too few rounds"
    : ratio.high < 1 && ratio.estimate <= 1 - minEffect
      ? "faster"
      : ratio.low > 1 && ratio.estimate >= 1 + minEffect
        ? "slower"
        : "indistinguishable";
