// Rendering of a comparison of two runs (commands/compareResults.ts) as text, Markdown or CSV, on the
// report model (model.ts). A pure function of the comparison.

import { basename } from "node:path";
import type { Comparison, CompareRow } from "../commands/compareResults.ts";
import { renderDecision } from "../timing/policy.ts";
import { mib, ms, ratio } from "./common.ts";
import { line, toCsv, toMarkdown, toText, type Block, type Report } from "./model.ts";
import type { Paint } from "../style.ts";

// Rounded down: a 99.17% interval is not a 99.2% one.
const percent = (c: number): string => `${Math.floor(c * 1000 + 1e-9) / 10}%`;
const figure = (v: number, unit: string): string => (unit === "ms" ? ms(v) : unit === "bytes" ? mib(v) : unit === "x" ? ratio(v) : String(v));

// "same" widened by the ms floor reads as the floor ("same (within 1 ms)"), not the percent it works
// out to over a fast request.
// A call against a changed reference says so: the ratio of ratios then mixes the two changes.
const callText = (r: CompareRow, c: Comparison): string => {
  if (!r.call) return r.state === "compared" ? "-" : `not compared: ${r.state}`;
  const changed = r.refChanged && r.call !== "unresolved" && r.call !== "too few rounds" ? " (ref changed)" : "";
  if (r.call !== "same" || r.sameWithin === null) return `${r.call}${changed}`;
  if (r.unit === "ms" && c.resolution.floorMs > 0 && r.sameWithin > c.resolution.relative + 1e-9) return `same (within ${c.resolution.floorMs} ms)${changed}`;
  return `same ±${Math.round(r.sameWithin * 100)}%${changed}`;
};

// The interval column, headed by the coverage the intervals really have (the exact Mann-Whitney
// distribution covers in steps, at or above the confidence asked for), as bench's columns are; per
// cell when the rows differ (different round counts).
function shiftColumn(c: Comparison): { header: string; cell: (r: CompareRow) => string } {
  const cover = new Set(c.rows.flatMap((r) => (r.shift ? [percent(r.shift.confidence)] : [])));
  const shared = cover.size === 1 ? [...cover][0]! : null;
  return {
    header: shared ? `new/old (${shared} interval)` : "new/old (interval, coverage)",
    cell: (r) => (r.shift ? `${ratio(r.shift.estimate)} (${ratio(r.shift.low)}..${ratio(r.shift.high)}${shared ? "" : `, ${percent(r.shift.confidence)}`})` : "-"),
  };
}

function describe(c: Comparison, which: "old" | "new"): string {
  const r = c[which];
  const what = r.form === "result" ? `result ${r.id?.slice(0, 8) ?? "?"}` : "bundle";
  // The file or directory's name: the full path is machine-local (it is in --format json).
  return `${which}: ${basename(r.source)} (${what}, ${r.createdAt.slice(0, 10)}, machine ${r.machine?.slice(0, 8) ?? "unknown"}, harness ${r.harnessCommit?.slice(0, 12) ?? "unknown"})`;
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
      `new / old of each candidate's per-round ratio to its reference: Hodges-Lehmann estimate and two-sample interval; ${
        // Summaries from before --family-wise were always family-wise.
        c.familyWise !== false
          ? `calls at ${percent(c.confidence)} for the whole report${c.comparisons > 1 ? ` (Bonferroni over ${c.comparisons} comparisons: ${percent(c.perComparison)} each)` : ""}`
          : `calls at ${percent(c.confidence)} each${c.comparisons > 1 ? ` (${c.comparisons} comparisons; --family-wise makes it ${percent(c.confidence)} for the whole report)` : ""}`
      }; "same" is within ±${Math.round(c.resolution.relative * 100)}% (or ${c.resolution.floorMs} ms)`,
    ),
  ];
  if (c.onlyOld.length) head.push(line(`only in old (not compared): ${c.onlyOld.join(", ")}`));
  if (c.onlyNew.length) head.push(line(`only in new (not compared): ${c.onlyNew.join(", ")}`));
  blocks.push({ kind: "lines", lines: head });
  if (c.warnings.length) blocks.push({ kind: "warnings", notes: c.warnings });

  const abs = c.sameMachine === true;
  const shift = shiftColumn(c);
  // The called figures only, to keep the table narrow; the references' times and (same machine) the
  // candidates' own times are context, in a table of their own for a CLI bench and in json/csv for an
  // lsp-bench's hundred rows.
  const columns = ["n old/new", "old ratio", "new ratio", shift.header, "call"];
  const cells = (r: CompareRow): string[] => [
    r.old && r.new ? `${r.old.rounds}/${r.new.rounds}` : "-",
    r.old ? ratio(r.old.ratio) : "-",
    r.new ? ratio(r.new.ratio) : "-",
    shift.cell(r),
    callText(r, c),
  ];
  const span = (a: number, b: number, unit: string): string => `${figure(a, unit)} → ${figure(b, unit)}`;
  const refName = (ref: CompareRow["ref"], sep: string): string => (ref.old === ref.new ? ref.new : `${ref.old}${sep}${ref.new}`);

  if (c.kind === "cli-bench") {
    blocks.push({ kind: "table", header: ["candidate", "vs", ...columns], rows: c.rows.map((r) => [r.label, refName(r.ref, " / "), ...cells(r)]) });
    const context = c.rows.filter((r) => r.old && r.new);
    if (context.length)
      blocks.push({
        kind: "table",
        caption: abs ? "context, not called: wall medians old → new, and each candidate's own time new/old (same machine)" : "context, not called: wall medians old → new",
        header: ["candidate", "reference", "candidate time", ...(abs ? ["own new/old"] : [])],
        rows: context.map((r) => [
          r.label,
          span(r.old!.refMedian, r.new!.refMedian, r.unit),
          span(r.old!.candMedian, r.new!.candMedian, r.unit),
          ...(abs ? [r.absolute ? `${ratio(r.absolute.estimate)} (${ratio(r.absolute.low)}..${ratio(r.absolute.high)})` : "-"] : []),
        ]),
      });
  } else {
    for (const label of new Set(c.rows.map((r) => r.label))) {
      const rows = c.rows.filter((r) => r.label === label);
      blocks.push({ kind: "heading", text: `${label} vs ${refName(rows[0]!.ref, " (old) / ")}${rows[0]!.ref.old === rows[0]!.ref.new ? "" : " (new)"}` });
      blocks.push({ kind: "table", header: ["metric", ...columns], rows: rows.map((r) => [r.metricLabel, ...cells(r)]) });
    }
    blocks.push({ kind: "lines", lines: [line(`each metric's reference and candidate medians, old and new${abs ? ", and the candidates' own new/old" : ""}: --format json or csv`)] });
  }
  const order = ["worse", "better", "same", "unresolved", "too few rounds"] as const;
  const counts = order.filter((k) => c.counts[k]).map((k) => `${c.counts[k]} ${k}`);
  const skipped = c.rows.filter((r) => !r.call).length;
  blocks.push({
    kind: "verdict",
    text: `${counts.join(", ") || "nothing compared"}${skipped ? `; ${skipped} not compared` : ""}`,
    tone: c.counts.worse ? "bad" : c.counts.unresolved || c.counts["too few rounds"] || skipped || !counts.length ? "warn" : "good",
  });
  if (c.policy) blocks.push({ kind: "lines", lines: renderDecision(c.policy).split("\n").map((t) => line(t)) });
  return { title: `compare-results: ${p.name} (${c.kind})`, blocks };
}

export const renderComparison = (c: Comparison, paint?: Paint): string => toText(comparisonReport(c), paint);
export const comparisonMarkdown = (c: Comparison): string => toMarkdown(comparisonReport(c));

// One row per compared figure; raw numbers and the stored call.
export function comparisonCsv(c: Comparison): string {
  const header = ["candidate", "mode", "ref_old", "ref_new", "metric", "unit", "state", "rounds_old", "rounds_new", "ratio_old", "ratio_new", "shift", "shift_low", "shift_high", "coverage", "call", "same_within", "ref_changed", "ref_median_old", "ref_median_new", "cand_median_old", "cand_median_new", "own_shift", "own_low", "own_high"];
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
      r.shift?.confidence ?? null,
      r.call,
      r.sameWithin,
      r.refChanged ? "true" : "false",
      r.old?.refMedian ?? null,
      r.new?.refMedian ?? null,
      r.old?.candMedian ?? null,
      r.new?.candMedian ?? null,
      r.absolute?.estimate ?? null,
      r.absolute?.low ?? null,
      r.absolute?.high ?? null,
    ]),
  );
}
