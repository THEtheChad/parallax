// Plain-text rendering of an lsp-bench summary: one table per candidate, a row per metric. A pure
// function of summary.json.

import type { LspBenchSummary } from "../timing/lspSummary.ts";
import { METRICS } from "../timing/lspSummary.ts";
import type { Interval } from "../timing/stats.ts";
import { ms, ratio, table, withInterval } from "./bench.ts";

const mb = (v: number): string => `${Math.round(v / 2 ** 20)} MB`;

export function renderLspBenchSummary(s: LspBenchSummary): string {
  const out: string[] = [];
  const r = s.rounds;
  out.push(`rounds: ${r.accepted} accepted of ${r.planned} planned (${r.attempts} attempts, ${r.rejected} rejected, ${r.failed} failed); need ${s.minRounds}`);
  for (const [why, n] of Object.entries(s.rejections)) out.push(`  rejected ${n}x: ${why}`);
  const memory = s.memory === "peak" ? "peak memory" : s.memory === "current" ? "memory at the end of the session" : "no memory";
  out.push(`canary ${s.canaryBaselineMs === null ? "-" : `${s.canaryBaselineMs.toFixed(1)} ms`}; server usage ${s.usage} (${memory})`);
  if (s.harnessLagP95Ms !== null) out.push(`harness key lag p95 ${s.harnessLagP95Ms.toFixed(1)} ms`);
  for (const side of s.sides) {
    const outcomes = Object.entries(side.outcomes).map(([k, n]) => `${n} ${k}`).join(", ");
    out.push(`${side.label}: ${side.sessions} sessions measured, ${side.requests} requests (${side.cancelled} cancelled, ${side.errors} errors); every session, warm-ups included: ${outcomes}`);
  }
  const ref = s.sides.find((x) => x.role === "ref")!;
  for (const c of s.candidates) {
    const cand = s.sides.find((x) => x.label === c.label)!;
    out.push("");
    out.push(`${c.label} vs ${ref.label}: ${c.state}`);
    const rows = METRICS.filter(({ key }) => ref.metrics[key] || cand.metrics[key]).map(({ key, label, unit }) => {
      const f = unit === "bytes" ? mb : ms;
      const median = (i: Interval | null | undefined): string => (i ? f(i.estimate) : "-");
      const m = c.metrics[key];
      return [label, median(ref.metrics[key]), median(cand.metrics[key]), withInterval(m?.ratio ?? null, ratio), m?.call ?? "-"];
    });
    out.push(table(["metric", ref.label, c.label, "ratio (95% interval)", "call"], rows));
  }
  out.push("");
  out.push(s.clean ? "MEASURED" : "NOT MEASURED CLEANLY: see the states above");
  return out.join("\n");
}
