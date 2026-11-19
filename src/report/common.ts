// Formatting shared by the timing reports (bench, lsp-bench, calibration): numbers, intervals, calls
// and the lines about rounds. Pure functions of summary fields.

import type { Call, Interval } from "../timing/stats.ts";
import type { Resolution } from "../timing/summary.ts";
import { line, toCsv, type Line } from "./model.ts";
import type { Tone } from "../style.ts";

// A timing verdict at a glance: not measured cleanly is a problem; measured with a caveat (unsettled
// calls, outputs that differ) is a warning; measured is clean.
export const verdictTone = (text: string): Tone => (text.startsWith("NOT ") ? "bad" : text === "MEASURED" ? "good" : "warn");

// Under 1 ms two decimals: 0.26 ms and 0.33 ms must not both read 0.3 ms beside a call between them.
export const ms = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0)} ms`);
// Binary units: the figures are divided by 2^20 and 1024.
export const mib = (v: number): string => `${Math.round(v / 2 ** 20)} MiB`;
export const kibPerEdit = (v: number): string => `${(v / 1024).toFixed(Math.abs(v) < 10 * 1024 ? 1 : 0)} KiB/edit`;

// Three significant figures (0.352, 1.08, 16.8, 188): a ratio's interval is rarely narrower than
// that, so more digits would claim a precision the rounds do not have.
export const sig3 = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(3));
export const ratio = (v: number): string => `${sig3(v)}x`;

// Rounded down: a 93.75% interval is not a 94% one.
export const percent = (c: number): string => `${Math.floor(c * 100)}%`;

// Half the range of a counter over its runs, as a percent of the median. Below 0.01% the digits are
// noise in the last place of the count: say so instead of printing ±0.000%.
export function spreadText(spread: number): string {
  const half = spread * 50;
  if (half === 0) return "±0%";
  if (half < 0.01) return "±<0.01%";
  return `±${half.toFixed(half < 0.1 ? 2 : 1)}%`;
}

export const withInterval = (i: Interval | null, f: (v: number) => string, showConfidence = false): string =>
  i ? `${f(i.estimate)} (${f(i.low)}..${f(i.high)}${showConfidence ? `, ${percent(i.confidence)}` : ""})` : "-";

// An interval column: its confidence goes in the header when every row shares it (the usual case, as
// every row has one value per accepted round), else in each cell.
export function intervalColumn(name: string, intervals: (Interval | null)[], f: (v: number) => string): { header: string; cells: string[] } {
  const confidences = new Set(intervals.flatMap((i) => (i ? [percent(i.confidence)] : [])));
  if (!confidences.size) return { header: name, cells: intervals.map(() => "-") };
  const shared = confidences.size === 1 ? [...confidences][0]! : null;
  return {
    header: shared ? `${name} (${shared} interval)` : `${name} (interval, confidence)`,
    cells: intervals.map((i) => withInterval(i, f, shared === null)),
  };
}

// What a metric measures decides how a call reads: a time is faster or slower; CPU time and memory
// are lower or higher (the server is not "faster" for using less memory). The stored call stays
// "faster"/"slower" for every metric; only the wording changes.
export type Measure = "time" | "cpu" | "memory";

export interface CallContext {
  measure?: Measure;
  // The bench's resolution and whether the metric is in ms (where "same" widens to the ms floor).
  resolution?: Resolution;
  ms?: boolean;
}

export function callText(call: Call | null | undefined, sameWithin: number | undefined, ctx: CallContext = {}): string {
  if (!call) return "-";
  const measure = ctx.measure ?? "time";
  if (call === "faster") return measure === "time" ? "faster" : "lower";
  if (call === "slower") return measure === "time" ? "slower" : "higher";
  if (call !== "same" || sameWithin === undefined) return call;
  // The ms floor governed (a 0.3 ms request is "same" within 1 ms, which is ±300% of it): say the
  // floor, not the percent it works out to.
  if (ctx.ms && ctx.resolution && ctx.resolution.floorMs > 0 && sameWithin > ctx.resolution.relative + 1e-9) return `same (within ${ctx.resolution.floorMs} ms)`;
  return `same ±${Math.round(sameWithin * 100)}%`;
}

export interface RoundsInfo {
  rounds: { planned: number; max?: number; attempts: number; accepted: number; rejected: number; failed: number };
  minRounds: number;
  confidence?: number;
  resolution?: Resolution;
  settled?: boolean;
  rejections: Record<string, number>;
}

// "rounds: 9 accepted of 6..15 planned (...)", then how sure the calls are, what an interval's own
// percent means, and whether more rounds would change a call. Summaries from before sequential rounds
// have no confidence or resolution.
export function roundsLines(s: RoundsInfo): Line[] {
  const r = s.rounds;
  const planned = r.max !== undefined && r.max > r.planned ? `${r.planned}..${r.max}` : `${r.planned}`;
  const out = [
    line(`rounds: ${r.accepted} accepted of ${planned} planned (${r.attempts} attempts, ${r.rejected} rejected, ${r.failed} failed); a comparison needs at least ${s.minRounds} accepted (--min-runs)`),
  ];
  for (const [why, n] of Object.entries(s.rejections)) out.push(line(`rejected ${n}x: ${why}`, 1));
  if (s.confidence !== undefined && s.resolution) {
    const floor = s.resolution.floorMs > 0 ? `, or within ${s.resolution.floorMs} ms where that is wider` : "";
    out.push(
      line(
        `calls at ${percent(s.confidence)} confidence, what this look needs; "same" is within ±${Math.round(s.resolution.relative * 100)}%${floor}${s.settled === false ? "; NOT SETTLED: some calls could change with more rounds" : ""}`,
      ),
    );
    out.push(
      line(
        `the % in an interval's header is the coverage it really has: order statistics cover in steps, so at or above the ${percent(s.confidence)} a call needs`,
        1,
      ),
    );
  }
  return out;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// The CSV of a timing report (bench, lsp-bench), long format: one row per figure, the same columns
// for every kind of row, empty where a column does not apply. README describes the kinds.
export const TIMING_CSV_COLUMNS = [
  "kind",
  "label",
  "vs",
  "metric",
  "unit",
  "n",
  "value",
  "low",
  "high",
  "ref_value",
  "ratio",
  "ratio_low",
  "ratio_high",
  "confidence",
  "call",
  "same_within",
  "state",
  "spread",
] as const;

export type TimingCsvRow = Partial<Record<(typeof TIMING_CSV_COLUMNS)[number], string | number | null>>;

export const timingCsv = (rows: TimingCsvRow[]): string => toCsv([...TIMING_CSV_COLUMNS], rows.map((r) => TIMING_CSV_COLUMNS.map((k) => r[k] ?? null)));

// An interval's fields under a prefix ("" for a figure, "ratio" for a ratio).
export const intervalFields = (i: Interval | null | undefined, as: "value" | "ratio"): TimingCsvRow =>
  !i
    ? {}
    : as === "value"
      ? { n: i.n, value: i.estimate, low: i.low, high: i.high, confidence: i.confidence }
      : { n: i.n, ratio: i.estimate, ratio_low: i.low, ratio_high: i.high, confidence: i.confidence };
