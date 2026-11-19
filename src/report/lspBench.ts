// The report of an lsp-bench summary: the sides, then one table per candidate with a row per metric.
// A pure function of summary.json, built as a report model (model.ts) and rendered as text or
// Markdown, or written as CSV.

import type { LspBenchSummary, MetricInfo } from "../timing/lspSummary.ts";
import { METRICS } from "../timing/lspSummary.ts";
import { SETTLED, type Interval } from "../timing/stats.ts";
import { callText, intervalColumn, intervalFields, kibPerEdit, mib, ms, plural, ratio, roundsLines, timingCsv, type TimingCsvRow } from "./common.ts";
import { line, toText, type Block, type Report } from "./model.ts";

const formatter = (unit: MetricInfo["unit"]): ((v: number) => string) => (unit === "bytes" ? mib : unit === "bytes/edit" ? kibPerEdit : unit === "x" ? ratio : ms);

// Calls (candidate, metric) that more rounds could still change; only counted once the bench says it
// stopped unsettled (summaries from before sequential rounds have no `settled`).
const unsettledCalls = (s: LspBenchSummary): number =>
  s.settled === false
    ? s.candidates
        .filter((c) => c.state !== "failed")
        .flatMap((c) => Object.values(c.metrics))
        .filter((m) => m && m.ratio !== null && !(m.call !== null && SETTLED.includes(m.call))).length
    : 0;

export function lspBenchVerdict(s: LspBenchSummary): string {
  if (!s.clean) return "NOT MEASURED CLEANLY: see the states above";
  const n = unsettledCalls(s);
  return n ? `MEASURED (not settled: ${plural(n, "call")} could change with more rounds)` : "MEASURED";
}

export function lspBenchReport(s: LspBenchSummary): Report {
  const blocks: Block[] = [];
  if (s.notes?.length) blocks.push({ kind: "warnings", notes: s.notes });
  const memory = s.memory === "peak" ? "peak memory" : s.memory === "current" ? "memory at the end of the session" : "no memory";
  const head = [...roundsLines(s), line(`canary ${s.canaryBaselineMs === null ? "-" : `${s.canaryBaselineMs.toFixed(1)} ms`}; server usage ${s.usage} (${memory})`)];
  if (s.harnessLagP95Ms !== null) head.push(line(`harness key lag p95 ${s.harnessLagP95Ms.toFixed(1)} ms`));
  blocks.push({ kind: "lines", lines: head });

  // Missed counts are absent in older summaries: their columns only where some side has them.
  const errfix = s.sides.some((x) => x.errfixMissed !== undefined);
  const imports = s.sides.some((x) => x.importsMissed !== undefined);
  blocks.push({
    kind: "table",
    header: ["side", "sessions", "requests", "cancelled", "errors", ...(errfix ? ["errors not shown"] : []), ...(imports ? ["imports not found"] : []), "every session run"],
    rows: s.sides.map((x) => [
      x.label,
      String(x.sessions),
      String(x.requests),
      String(x.cancelled),
      String(x.errors),
      ...(errfix ? [String(x.errfixMissed ?? 0)] : []),
      ...(imports ? [String(x.importsMissed ?? 0)] : []),
      Object.entries(x.outcomes).map(([k, n]) => `${n} ${k}`).join(", "),
    ]),
  });
  blocks.push({
    kind: "lines",
    lines: [
      line("sessions, requests, cancelled and errors: over accepted rounds; every session run: warm-ups and rejected rounds included"),
      line("cancelled: typing requests still unanswered when a newer one of the same kind replaced them, cancelled as an editor does (counted, not timed; a server that falls behind has more)"),
      ...(errfix ? [line("errors not shown: errors the errfix phase inserted that the diagnostics did not report")] : []),
      ...(imports ? [line("imports not found: names the imports phase used whose missing-name diagnostic did not come")] : []),
    ],
  });

  for (const c of s.candidates) {
    // `ref` is absent in summaries from before thread modes: there was one reference.
    const ref = s.sides.find((x) => x.label === c.ref) ?? s.sides.find((x) => x.role === "ref")!;
    const cand = s.sides.find((x) => x.label === c.label)!;
    const shown = METRICS.filter(({ key }) => ref.metrics[key] || cand.metrics[key]);
    const ratios = intervalColumn("ratio", shown.map(({ key }) => c.metrics[key]?.ratio ?? null), ratio);
    const rows = shown.map(({ key, label, unit, compare, measure }, i) => {
      const f = formatter(unit);
      const median = (x: Interval | null | undefined): string => (x ? f(x.estimate) : "-");
      const m = c.metrics[key];
      const call = compare === false ? "not compared" : callText(m?.call, m?.sameWithin, { measure: measure ?? "time", ms: unit === "ms", ...(s.resolution ? { resolution: s.resolution } : {}) });
      return [label, median(ref.metrics[key]), median(cand.metrics[key]), ratios.cells[i]!, call];
    });
    blocks.push({ kind: "heading", text: `${c.label} vs ${ref.label}: ${c.state}` });
    blocks.push({ kind: "table", header: ["metric", ref.label, c.label, ratios.header, "call"], rows });
  }
  blocks.push({ kind: "verdict", text: lspBenchVerdict(s) });
  return { title: "parallax lsp-bench", blocks };
}

export const renderLspBenchSummary = (s: LspBenchSummary): string => toText(lspBenchReport(s));

// One CSV, long format (README lists the kinds): `side` rows (each side's median per metric with its
// interval) and `comparison` rows (per candidate and metric: both medians, the ratio interval, call
// and state; metrics never compared by ratio have no ratio and the call "not compared").
export function lspBenchCsv(s: LspBenchSummary): string {
  const rows: TimingCsvRow[] = [];
  for (const x of s.sides)
    for (const { key, unit } of METRICS) if (key in x.metrics) rows.push({ kind: "side", label: x.label, metric: key, unit, ...intervalFields(x.metrics[key], "value") });
  for (const c of s.candidates) {
    const ref = s.sides.find((x) => x.label === c.ref) ?? s.sides.find((x) => x.role === "ref")!;
    const cand = s.sides.find((x) => x.label === c.label)!;
    for (const { key, unit, compare } of METRICS) {
      if (!(key in ref.metrics) && !(key in cand.metrics)) continue;
      const m = c.metrics[key];
      rows.push({
        kind: "comparison",
        label: c.label,
        vs: ref.label,
        metric: key,
        unit,
        ...intervalFields(m?.ratio, "ratio"),
        value: cand.metrics[key]?.estimate ?? null,
        ref_value: ref.metrics[key]?.estimate ?? null,
        call: compare === false ? "not compared" : (m?.call ?? null),
        same_within: m?.sameWithin ?? null,
        state: c.state,
      });
    }
  }
  return timingCsv(rows);
}
