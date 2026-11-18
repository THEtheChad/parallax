// Plain-text rendering of an lsp-bench summary: one table per candidate, a row per metric. A pure
// function of summary.json.

import type { LspBenchSummary } from "../timing/lspSummary.ts";
import { METRICS } from "../timing/lspSummary.ts";
import type { Interval } from "../timing/stats.ts";
import { callText, intervalColumn, ms, ratio, roundsLines, table } from "./bench.ts";

const mb = (v: number): string => `${Math.round(v / 2 ** 20)} MB`;
const perEdit = (v: number): string => `${(v / 1024).toFixed(Math.abs(v) < 10 * 1024 ? 1 : 0)} KB/edit`;
const times = (v: number): string => `${v.toFixed(2)}x`;
const formatter = (unit: string): ((v: number) => string) => (unit === "bytes" ? mb : unit === "bytes/edit" ? perEdit : unit === "x" ? times : ms);

export function renderLspBenchSummary(s: LspBenchSummary): string {
  const out: string[] = [];
  out.push(...roundsLines(s));
  const memory = s.memory === "peak" ? "peak memory" : s.memory === "current" ? "memory at the end of the session" : "no memory";
  out.push(`canary ${s.canaryBaselineMs === null ? "-" : `${s.canaryBaselineMs.toFixed(1)} ms`}; server usage ${s.usage} (${memory})`);
  if (s.harnessLagP95Ms !== null) out.push(`harness key lag p95 ${s.harnessLagP95Ms.toFixed(1)} ms`);
  for (const side of s.sides) {
    const outcomes = Object.entries(side.outcomes).map(([k, n]) => `${n} ${k}`).join(", ");
    const missed = [side.errfixMissed ? `${side.errfixMissed} inserted errors not reported` : "", side.importsMissed ? `${side.importsMissed} missing names not reported` : ""].filter(Boolean);
    out.push(
      `${side.label}: ${side.sessions} sessions measured, ${side.requests} requests (${side.cancelled} cancelled, ${side.errors} errors${missed.length ? `; ${missed.join(", ")}` : ""}); every session, warm-ups included: ${outcomes}`,
    );
  }
  for (const c of s.candidates) {
    // `ref` is absent in summaries from before thread modes: there was one reference.
    const ref = s.sides.find((x) => x.label === c.ref) ?? s.sides.find((x) => x.role === "ref")!;
    const cand = s.sides.find((x) => x.label === c.label)!;
    out.push("");
    out.push(`${c.label} vs ${ref.label}: ${c.state}`);
    const shown = METRICS.filter(({ key }) => ref.metrics[key] || cand.metrics[key]);
    const ratios = intervalColumn("ratio", shown.map(({ key }) => c.metrics[key]?.ratio ?? null), ratio);
    const rows = shown.map(({ key, label, unit, compare }, i) => {
      const f = formatter(unit);
      const median = (x: Interval | null | undefined): string => (x ? f(x.estimate) : "-");
      const call = compare === false ? "not compared" : callText(c.metrics[key]?.call, c.metrics[key]?.sameWithin);
      return [label, median(ref.metrics[key]), median(cand.metrics[key]), ratios.cells[i]!, call];
    });
    out.push(table(["metric", ref.label, c.label, ratios.header, "call"], rows));
  }
  out.push("");
  out.push(s.clean ? "MEASURED" : "NOT MEASURED CLEANLY: see the states above");
  return out.join("\n");
}
