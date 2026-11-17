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
// reference time):
//
//   faster, slower   the whole interval is on one side of 1, and the estimate differs from 1 by at
//                    least `minEffect` (1%): a difference too small to print is no difference
//   same             the whole interval lies within 1 ± `same` (the resolution): any difference is
//                    smaller than the bench cares about
//   unresolved       none of these: more rounds would tell
//   too few rounds   the interval does not reach the confidence a call needs
export type Call = "faster" | "slower" | "same" | "unresolved" | "too few rounds";

// Calls that more rounds would not change: a bench may stop once every call is one of these.
export const SETTLED: readonly Call[] = ["faster", "slower", "same"];

export const MIN_EFFECT = 0.01;

export interface CallRule {
  // The confidence the interval must have (lookConfidence).
  confidence: number;
  // Half-width of "same", as a ratio (0.05: within 5%).
  same: number;
  minEffect?: number;
}

export const DEFAULT_RESOLUTION = 0.05;
export const DEFAULT_RESOLUTION_MS = 1;

export function callOf(ratio: Interval, rule: CallRule): Call {
  const minEffect = rule.minEffect ?? MIN_EFFECT;
  if (ratio.confidence < rule.confidence - 1e-12) return "too few rounds";
  if (ratio.high < 1 && ratio.estimate <= 1 - minEffect) return "faster";
  if (ratio.low > 1 && ratio.estimate >= 1 + minEffect) return "slower";
  if (ratio.low >= 1 - rule.same && ratio.high <= 1 + rule.same) return "same";
  return "unresolved";
}

// The half-width of "same" for one metric: the relative resolution, widened to an absolute floor where
// the reference's figure is so small that the floor is the larger (a 0.3 ms request is "same" within
// 1 ms, not within 5% of 0.3 ms).
export const sameWithin = (relative: number, floor: number, refEstimate: number | null): number =>
  refEstimate !== null && refEstimate > 0 && floor > 0 ? Math.max(relative, floor / refEstimate) : relative;

// Sequential rounds. A bench runs `runs` rounds, then looks; while some call is not settled it runs
// LOOK_STEP more rounds and looks again, up to `maxRuns`. Looking repeatedly and stopping at the first
// clear answer would make false calls more likely than one fixed look, so the false-call budget,
// FALSE_CALL_RATE per comparison, is split in advance (Bonferroni): half for the first look, the other
// half shared equally by the later ones. With a single look (maxRuns = runs) the whole budget is
// the first look's.
export const FALSE_CALL_RATE = 0.1;
export const LOOK_STEP = 3;

export interface LookPlan {
  runs: number;
  maxRuns: number;
}

// The accepted-round counts at which a bench looks.
export function lookPoints(p: LookPlan): number[] {
  const points = [p.runs];
  for (let n = p.runs + LOOK_STEP; n < p.maxRuns; n += LOOK_STEP) points.push(n);
  if (p.maxRuns > p.runs) points.push(p.maxRuns);
  return points;
}

// The confidence a call needs after n accepted rounds. Between looks (rounds were rejected), the later
// look's, which is the stricter.
export function lookConfidence(n: number, p: LookPlan): number {
  const looks = lookPoints(p).length;
  if (looks === 1) return 1 - FALSE_CALL_RATE;
  return n <= p.runs ? 1 - FALSE_CALL_RATE / 2 : 1 - FALSE_CALL_RATE / 2 / (looks - 1);
}
