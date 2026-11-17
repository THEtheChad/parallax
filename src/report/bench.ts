// Plain-text rendering of a bench summary. A pure function of summary.json.

import type { BenchSummary } from "../timing/summary.ts";
import type { Interval } from "../timing/stats.ts";

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

export function renderBenchSummary(s: BenchSummary): string {
  const out: string[] = [];
  const r = s.rounds;
  out.push(`rounds: ${r.accepted} accepted of ${r.planned} planned (${r.attempts} attempts, ${r.rejected} rejected, ${r.failed} failed); need ${s.minRounds}`);
  for (const [why, n] of Object.entries(s.rejections)) out.push(`  rejected ${n}x: ${why}`);
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
      s.candidates.map((c, i) => [c.label, c.ref ?? "ref", c.state, vsRef.cells[i]!, c.cpuRatio ? ratio(c.cpuRatio.estimate) : "-", c.call ?? "-"]),
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
