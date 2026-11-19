// Plain-text rendering of a comparison of two runs (commands/compareResults.ts). A pure function of
// the comparison.

import type { Comparison, CompareRow } from "../commands/compareResults.ts";
import { renderDecision } from "../timing/policy.ts";
import { ms, table } from "./bench.ts";

const x2 = (v: number): string => `${v.toFixed(2)}x`;
// Rounded down: a 99.17% interval is not a 99.2% one.
const percent = (c: number): string => `${Math.floor(c * 1000 + 1e-9) / 10}%`;
const figure = (v: number, unit: string): string =>
  unit === "ms" ? ms(v) : unit === "bytes" ? `${Math.round(v / 2 ** 20)} MB` : unit === "x" ? x2(v) : String(v);

const callText = (r: CompareRow): string =>
  r.call ? (r.call === "same" && r.sameWithin !== null ? `same ±${Math.round(r.sameWithin * 100)}%` : r.call) : r.state === "compared" ? "-" : `not compared: ${r.state}`;

function describe(c: Comparison, which: "old" | "new"): string {
  const r = c[which];
  const what = r.form === "result" ? `result ${r.id?.slice(0, 8) ?? "?"}` : "bundle";
  return `  ${which}: ${r.source} (${what}, ${r.createdAt.slice(0, 10)}, machine ${r.machine?.slice(0, 8) ?? "unknown"}, harness ${r.harnessCommit?.slice(0, 12) ?? "unknown"})`;
}

export function renderComparison(c: Comparison): string {
  const out: string[] = [];
  const p = c.project;
  const at = p.repository ? ` (${p.repository}@${p.commit?.slice(0, 12) ?? "?"})` : p.commit ? ` (commit ${p.commit.slice(0, 12)})` : "";
  out.push(`compare-results: ${c.kind} of ${p.name}${at}`);
  out.push(describe(c, "old"), describe(c, "new"));
  out.push(
    `new / old of each candidate's per-round ratio to its reference: Hodges-Lehmann estimate and two-sample interval; calls at ${percent(c.confidence)} for the whole report${
      c.comparisons > 1 ? ` (Bonferroni over ${c.comparisons} comparisons: ${percent(c.perComparison)} each)` : ""
    }; "same" is within ±${Math.round(c.resolution.relative * 100)}% (or ${c.resolution.floorMs} ms)`,
  );
  for (const w of c.warnings) out.push(`warning: ${w}`);
  if (c.onlyOld.length) out.push(`only in old (not compared): ${c.onlyOld.join(", ")}`);
  if (c.onlyNew.length) out.push(`only in new (not compared): ${c.onlyNew.join(", ")}`);

  const abs = c.sameMachine === true;
  const header = (first: string): string[] => [
    first,
    "n old/new",
    "old ratio",
    "new ratio",
    `new/old (${percent(c.perComparison)} interval)`,
    "call",
    "ref old -> new",
    ...(abs ? ["own new/old (same machine)"] : []),
  ];
  const cells = (r: CompareRow): string[] => [
    r.old && r.new ? `${r.old.rounds}/${r.new.rounds}` : "-",
    r.old ? x2(r.old.ratio) : "-",
    r.new ? x2(r.new.ratio) : "-",
    r.shift ? `${x2(r.shift.estimate)} (${x2(r.shift.low)}..${x2(r.shift.high)})` : "-",
    callText(r),
    r.old && r.new ? `${figure(r.old.refMedian, r.unit)} -> ${figure(r.new.refMedian, r.unit)}` : "-",
    ...(abs ? [r.absolute ? `${x2(r.absolute.estimate)} (${x2(r.absolute.low)}..${x2(r.absolute.high)})` : "-"] : []),
  ];

  out.push("");
  if (c.kind === "cli-bench") {
    out.push(table(["candidate", "vs", ...header("").slice(1)], c.rows.map((r) => [r.label, r.ref.old === r.ref.new ? r.ref.new : `${r.ref.old} / ${r.ref.new}`, ...cells(r)])));
  } else {
    const labels = [...new Set(c.rows.map((r) => r.label))];
    labels.forEach((label, i) => {
      const rows = c.rows.filter((r) => r.label === label);
      const ref = rows[0]!.ref;
      if (i) out.push("");
      out.push(`${label} vs ${ref.old === ref.new ? ref.new : `${ref.old} (old) / ${ref.new} (new)`}`);
      out.push(table(header("metric"), rows.map((r) => [r.metricLabel, ...cells(r)])));
    });
  }
  out.push("");
  const order = ["worse", "better", "same", "unresolved", "too few rounds"] as const;
  const counts = order.filter((k) => c.counts[k]).map((k) => `${c.counts[k]} ${k}`);
  const skipped = c.rows.filter((r) => !r.call).length;
  out.push(`${counts.join(", ") || "nothing compared"}${skipped ? `; ${skipped} not compared` : ""}`);
  if (c.policy) out.push(renderDecision(c.policy));
  return out.join("\n");
}
