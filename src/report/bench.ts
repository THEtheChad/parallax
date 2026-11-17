// Plain-text rendering of a bench summary. A pure function of summary.json.

import type { BenchSummary } from "../timing/summary.ts";
import type { Call, Interval } from "../timing/stats.ts";

export function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

export const ms = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 1 : 0)} ms`);
export const withInterval = (i: Interval | null, f: (v: number) => string, showConfidence = false): string =>
  i ? `${f(i.estimate)} (${f(i.low)}..${f(i.high)}${showConfidence ? `, ${percent(i.confidence)}` : ""})` : "-";
// Rounded down: a 93.75% interval is not a 94% one.
const percent = (c: number): string => `${Math.floor(c * 100)}%`;

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
export const ratio = (v: number): string => `${v.toFixed(2)}x`;

// The call, with the resolution that "same" was judged at.
export const callText = (call: Call | null | undefined, sameWithin: number | undefined): string =>
  !call ? "-" : call === "same" && sameWithin !== undefined ? `same ±${Math.round(sameWithin * 100)}%` : call;

// "rounds: 9 accepted of 6..15 planned (...)", then how sure the calls are and whether more rounds
// would change one. Summaries from before sequential rounds have neither.
export function roundsLines(s: {
  rounds: { planned: number; max?: number; attempts: number; accepted: number; rejected: number; failed: number };
  minRounds: number;
  confidence?: number;
  resolution?: { relative: number; floorMs: number };
  settled?: boolean;
  rejections: Record<string, number>;
}): string[] {
  const r = s.rounds;
  const planned = r.max !== undefined && r.max > r.planned ? `${r.planned}..${r.max}` : `${r.planned}`;
  const out = [`rounds: ${r.accepted} accepted of ${planned} planned (${r.attempts} attempts, ${r.rejected} rejected, ${r.failed} failed); need ${s.minRounds}`];
  for (const [why, n] of Object.entries(s.rejections)) out.push(`  rejected ${n}x: ${why}`);
  if (s.confidence !== undefined && s.resolution)
    out.push(
      `calls at ${percent(s.confidence)} confidence; "same" is within ±${Math.round(s.resolution.relative * 100)}% (or ${s.resolution.floorMs} ms)${s.settled === false ? "; NOT SETTLED: some calls could change with more rounds" : ""}`,
    );
  return out;
}

export function renderBenchSummary(s: BenchSummary): string {
  const out: string[] = [];
  out.push(...roundsLines(s));
  out.push(`canary ${s.canaryBaselineMs === null ? "-" : `${s.canaryBaselineMs.toFixed(1)} ms`}; accounting ${s.accounting}`);
  out.push("");
  const wall = intervalColumn("wall median", s.sides.map((x) => x.wallMs), ms);
  out.push(
    table(
      ["side", "n", wall.header, "CPU", "peak RSS", "exit", "output"],
      s.sides.map((x, i) => [
        x.label,
        String(x.samples),
        wall.cells[i]!,
        x.cpuMs ? ms(x.cpuMs.estimate) : "-",
        x.maxRssBytes === null ? "-" : `${Math.round(x.maxRssBytes / 2 ** 20)} MB`,
        x.exitCodes.join(","),
        !x.outputStable ? `UNSTABLE (${x.outputs})` : x.outputMatchesRef === null ? "ref" : x.outputMatchesRef ? "same" : "DIFFERENT",
      ]),
    ),
  );
  out.push("");
  const vsRef = intervalColumn("wall vs ref", s.candidates.map((c) => c.wallRatio), ratio);
  out.push(
    table(
      ["candidate", "vs", "state", vsRef.header, "CPU vs ref", "call"],
      // `ref` is absent in summaries from before thread modes: there was one reference.
      s.candidates.map((c, i) => [c.label, c.ref ?? "ref", c.state, vsRef.cells[i]!, c.cpuRatio ? ratio(c.cpuRatio.estimate) : "-", callText(c.call, c.sameWithin)]),
    ),
  );
  if (s.speedups?.length) {
    const sp = intervalColumn("single-threaded / default wall", s.speedups.map((x) => x.ratio), ratio);
    out.push("");
    out.push(table(["parallel speedup", sp.header], s.speedups.map((x, i) => [x.base, sp.cells[i]!])));
  }
  out.push("");
  out.push(s.clean ? "MEASURED" : "NOT MEASURED CLEANLY: see the states above");
  return out.join("\n");
}
