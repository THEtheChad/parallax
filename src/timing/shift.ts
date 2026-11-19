// Two independent samples: how far the second is shifted from the first, with a distribution-free
// interval. `compare-results` uses it on the per-round log ratios of two runs.
//
// Within one bench, rounds pair a candidate with the reference, and stats.ts's median interval works
// on those paired ratios. Two benches are different runs: round 3 of one has nothing to do with round
// 3 of the other, so their ratios are two independent samples, not pairs, and need a two-sample method.
// The Hodges-Lehmann estimate (the median of every difference y - x between the samples) with the
// interval from the Mann-Whitney statistic is the two-sample counterpart of the median interval: it
// assumes only that the two samples have the same shape, one shifted from the other, and nothing
// about what that shape is.

import type { Interval } from "./stats.ts";

// P(U <= u) for u = 0..m·n, where U is the Mann-Whitney count of pairs (x_i, y_j) with y_j < x_i, for
// samples of m and n values with no ties and no shift. Exact: the counts of U are the coefficients of
// the Gaussian binomial coefficient [m+n choose m]_q = prod_{i=1..m} (1 - q^(n+i)) / (1 - q^i), built
// one factor at a time (each step is again a polynomial with whole coefficients).
export function mannWhitneyCdf(m: number, n: number): number[] {
  const size = m * n + 1;
  const a = new Float64Array(size);
  a[0] = 1;
  for (let i = 1; i <= m; i++) {
    const up = n + i;
    for (let u = size - 1; u >= up; u--) a[u] = a[u]! - a[u - up]!;
    for (let u = i; u < size; u++) a[u] = a[u]! + a[u - i]!;
  }
  let total = 0;
  for (const c of a) total += c;
  const cdf: number[] = [];
  let sum = 0;
  for (const c of a) {
    sum += c;
    cdf.push(Math.min(1, sum / total));
  }
  return cdf;
}

export interface ShiftInterval extends Interval {
  // Sizes of the two samples (`n` is their sum).
  nOld: number;
  nNew: number;
}

// The shift of `y` from `x` (y - x): the Hodges-Lehmann estimate and the interval [d(k), d(N+1-k)] of
// the N = m·n sorted pairwise differences, with the largest k whose coverage, 1 - 2·P(U <= k-1), is at
// least `target`. As in medianInterval, when no k reaches the target (3 values each at 95%: the most
// a 3-against-3 interval can cover is 90%), the interval is the whole range of differences and
// `confidence` is what that range really covers; a call then says "too few rounds".
//
// Ties (identical values) are rare in timings; with ties the coverage is approximately, not exactly,
// what is stated.
export function shiftInterval(x: readonly number[], y: readonly number[], target = 0.95): ShiftInterval | null {
  const m = x.length;
  const n = y.length;
  if (!m || !n) return null;
  const d: number[] = [];
  for (const a of x) for (const b of y) d.push(b - a);
  d.sort((p, q) => p - q);
  const N = d.length;
  const cdf = mannWhitneyCdf(m, n);
  const coverage = (k: number): number => Math.max(0, 1 - 2 * cdf[k - 1]!);
  let k = 1;
  while (k + 1 <= Math.ceil(N / 2) && coverage(k + 1) >= target) k++;
  const mid = (N - 1) / 2;
  const estimate = (d[Math.floor(mid)]! + d[Math.ceil(mid)]!) / 2;
  return { estimate, low: d[k - 1]!, high: d[N - k]!, confidence: coverage(k), n: m + n, nOld: m, nNew: n };
}

// The same on ratios, as a ratio of ratios: the shift is found on log ratios (a slowdown by a factor
// is a shift in logs, whatever the ratio's size) and turned back into a factor, new / old.
export function ratioShift(oldRatios: readonly number[], newRatios: readonly number[], target = 0.95): ShiftInterval | null {
  if (![...oldRatios, ...newRatios].every((r) => r > 0 && Number.isFinite(r))) return null;
  const s = shiftInterval(oldRatios.map(Math.log), newRatios.map(Math.log), target);
  return s && { ...s, estimate: Math.exp(s.estimate), low: Math.exp(s.low), high: Math.exp(s.high) };
}
