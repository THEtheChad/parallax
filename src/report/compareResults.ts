// Rendering of a comparison of two runs (commands/compareResults.ts) as text, Markdown or CSV, on the
// report model (model.ts). A pure function of the comparison.

import type { Comparison, CompareRow } from "../commands/compareResults.ts";
import { renderDecision } from "../timing/policy.ts";
import { mib, ms, ratio } from "./common.ts";
import { line, toCsv, toMarkdown, toText, type Block, type Report } from "./model.ts";

// Rounded down: a 99.17% interval is not a 99.2% one.
const percent = (c: number): string => `${Math.floor(c * 1000 + 1e-9) / 10}%`;
const figure = (v: number, unit: string): string => (unit === "ms" ? ms(v) : unit === "bytes" ? mib(v) : unit === "x" ? ratio(v) : String(v));

// "same" widened by the ms floor reads as the floor ("same (within 1 ms)"), not the percent it works
// out to over a fast request.
const callText = (r: CompareRow, c: Comparison): string => {
  if (!r.call) return r.state === "compared" ? "-" : `not compared: ${r.state}`;
  if (r.call !== "same" || r.sameWithin === null) return r.call;
  if (r.unit === "ms" && c.resolution.floorMs > 0 && r.sameWithin > c.resolution.relative + 1e-9) return `same (within ${c.resolution.floorMs} ms)`;
  return `same ±${Math.round(r.sameWithin * 100)}%`;
};

function describe(c: Comparison, which: "old" | "new"): string {
  const r = c[which];
  const what = r.form === "result" ? `result ${r.id?.slice(0, 8) ?? "?"}` : "bundle";
  return `${which}: ${r.source} (${what}, ${r.createdAt.slice(0, 10)}, machine ${r.machine?.slice(0, 8) ?? "unknown"}, harness ${r.harnessCommit?.slice(0, 12) ?? "unknown"})`;
}

export function comparisonReport(c: Comparison): Report {
  const p = c.project;
  const at = p.repository ? ` (${p.repository}@${p.commit?.slice(0, 12) ?? "?"})` : p.commit ? ` (commit ${p.commit.slice(0, 12)})` : "";
  const blocks: Block[] = [];
  const head = [
    line(`compare-results: ${c.kind} of ${p.name}${at}`),
    line(describe(c, "old"), 1),
    line(describe(c, "new"), 1),
    line(
      `new / old of each candidate's per-round ratio to its reference: Hodges-Lehmann estimate and two-sample interval; calls at ${percent(c.confidence)} for the whole report${
        c.comparisons > 1 ? ` (Bonferroni over ${c.comparisons} comparisons: ${percent(c.perComparison)} each)` : ""
      }; "same" is within ±${Math.round(c.resolution.relative * 100)}% (or ${c.resolution.floorMs} ms)`,
    ),
  ];
  if (c.onlyOld.length) head.push(line(`only in old (not compared): ${c.onlyOld.join(", ")}`));
  if (c.onlyNew.length) head.push(line(`only in new (not compared): ${c.onlyNew.join(", ")}`));
  blocks.push({ kind: "lines", lines: head });
  if (c.warnings.length) blocks.push({ kind: "warnings", notes: c.warnings });

  const abs = c.sameMachine === true;
  const columns = ["n old/new", "old ratio", "new ratio", `new/old (${percent(c.perComparison)} interval)`, "call", "ref old -> new", ...(abs ? ["own new/old (same machine)"] : [])];
  const cells = (r: CompareRow): string[] => [
    r.old && r.new ? `${r.old.rounds}/${r.new.rounds}` : "-",
    r.old ? ratio(r.old.ratio) : "-",
    r.new ? ratio(r.new.ratio) : "-",
    r.shift ? `${ratio(r.shift.estimate)} (${ratio(r.shift.low)}..${ratio(r.shift.high)})` : "-",
    callText(r, c),
    r.old && r.new ? `${figure(r.old.refMedian, r.unit)} -> ${figure(r.new.refMedian, r.unit)}` : "-",
    ...(abs ? [r.absolute ? `${ratio(r.absolute.estimate)} (${ratio(r.absolute.low)}..${ratio(r.absolute.high)})` : "-"] : []),
  ];
  const refName = (ref: CompareRow["ref"], sep: string): string => (ref.old === ref.new ? ref.new : `${ref.old}${sep}${ref.new}`);

  if (c.kind === "cli-bench") {
    blocks.push({ kind: "table", header: ["candidate", "vs", ...columns], rows: c.rows.map((r) => [r.label, refName(r.ref, " / "), ...cells(r)]) });
  } else {
    for (const label of new Set(c.rows.map((r) => r.label))) {
      const rows = c.rows.filter((r) => r.label === label);
      blocks.push({ kind: "heading", text: `${label} vs ${refName(rows[0]!.ref, " (old) / ")}${rows[0]!.ref.old === rows[0]!.ref.new ? "" : " (new)"}` });
      blocks.push({ kind: "table", header: ["metric", ...columns], rows: rows.map((r) => [r.metricLabel, ...cells(r)]) });
    }
  }
  const order = ["worse", "better", "same", "unresolved", "too few rounds"] as const;
  const counts = order.filter((k) => c.counts[k]).map((k) => `${c.counts[k]} ${k}`);
  const skipped = c.rows.filter((r) => !r.call).length;
  blocks.push({ kind: "verdict", text: `${counts.join(", ") || "nothing compared"}${skipped ? `; ${skipped} not compared` : ""}` });
  if (c.policy) blocks.push({ kind: "lines", lines: renderDecision(c.policy).split("\n").map((t) => line(t)) });
  return { title: `compare-results: ${p.name} (${c.kind})`, blocks };
}

export const renderComparison = (c: Comparison): string => toText(comparisonReport(c));
export const comparisonMarkdown = (c: Comparison): string => toMarkdown(comparisonReport(c));

// One row per compared figure; raw numbers and the stored call.
export function comparisonCsv(c: Comparison): string {
  const header = ["candidate", "mode", "ref_old", "ref_new", "metric", "unit", "state", "rounds_old", "rounds_new", "ratio_old", "ratio_new", "shift", "shift_low", "shift_high", "confidence", "call", "same_within"];
  return toCsv(
    header,
    c.rows.map((r) => [
      r.label,
      r.mode,
      r.ref.old,
      r.ref.new,
      r.metric,
      r.unit,
      r.state,
      r.old?.rounds ?? null,
      r.new?.rounds ?? null,
      r.old?.ratio ?? null,
      r.new?.ratio ?? null,
      r.shift?.estimate ?? null,
      r.shift?.low ?? null,
      r.shift?.high ?? null,
      c.perComparison,
      r.call,
      r.sameWithin,
    ]),
  );
}
