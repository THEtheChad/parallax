// Plain-text rendering of a bench summary. A pure function of summary.json.

import type { BenchSummary } from "../timing/summary.ts";
import type { Interval } from "../timing/stats.ts";

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

const ms = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 1 : 0)} ms`);
const withInterval = (i: Interval | null, f: (v: number) => string): string => (i ? `${f(i.estimate)} (${f(i.low)}..${f(i.high)})` : "-");
const ratio = (v: number): string => `${v.toFixed(2)}x`;

export function renderBenchSummary(s: BenchSummary): string {
  const out: string[] = [];
  const r = s.rounds;
  out.push(`rounds: ${r.accepted} accepted of ${r.planned} planned (${r.attempts} attempts, ${r.rejected} rejected, ${r.failed} failed); need ${s.minRounds}`);
  for (const [why, n] of Object.entries(s.rejections)) out.push(`  rejected ${n}x: ${why}`);
  out.push(`canary ${s.canaryBaselineMs === null ? "-" : `${s.canaryBaselineMs.toFixed(1)} ms`}; accounting ${s.accounting}`);
  out.push("");
  out.push(
    table(
      ["side", "n", "wall median (95% interval)", "CPU", "peak RSS", "exit", "output"],
      s.sides.map((x) => [
        x.label,
        String(x.samples),
        withInterval(x.wallMs, ms),
        x.cpuMs ? ms(x.cpuMs.estimate) : "-",
        x.maxRssBytes === null ? "-" : `${Math.round(x.maxRssBytes / 2 ** 20)} MB`,
        x.exitCodes.join(","),
        !x.outputStable ? `UNSTABLE (${x.outputs})` : x.outputMatchesRef === null ? "ref" : x.outputMatchesRef ? "same" : "DIFFERENT",
      ]),
    ),
  );
  out.push("");
  out.push(
    table(
      ["candidate", "state", "wall vs ref (95% interval)", "CPU vs ref", "call"],
      s.candidates.map((c) => [c.label, c.state, withInterval(c.wallRatio, ratio), c.cpuRatio ? ratio(c.cpuRatio.estimate) : "-", c.call ?? "-"]),
    ),
  );
  out.push("");
  out.push(s.clean ? "MEASURED" : "NOT MEASURED CLEANLY: see the states above");
  return out.join("\n");
}
