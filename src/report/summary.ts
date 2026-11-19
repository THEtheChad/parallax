// The report of an lsp-diff bundle's summary.json. A pure function of the summary, built as a report
// model (model.ts) and rendered as text or Markdown, or written as CSV.

import { ATTENTION, VERDICTS, type Summary, type Verdict } from "../diff/compare.ts";
import { line, toCsv, toText, type Block, type Line, type Report } from "./model.ts";

export function summaryReport(s: Summary, { attentionLimit = 30 } = {}): Report {
  const head: Line[] = [line(`${s.requests} requests; reference runs ${s.refRuns.join(", ")}; ${s.refUnstable} reference-unstable`)];
  for (const e of s.refEvidence ?? []) head.push(line(`reference evidence ${e.bundle}: ${e.accepted ? `${e.refRuns.length} reference runs` : `rejected (${e.reason})`}`));
  if (s.refEvidence?.some((e) => e.accepted)) head.push(line(`${s.refUnstableFromEvidence} requests reference-unstable only with the evidence`));
  head.push(line(`normalization ${s.normalization.version} (${s.normalization.rules.join(", ")})`));
  const blocks: Block[] = [
    { kind: "lines", lines: head },
    {
      kind: "table",
      header: ["session", "role", "outcome", "answers", "note"],
      rows: s.sessions.map((x) => [
        x.run,
        x.role,
        x.outcome,
        String(x.answers),
        [x.error, x.crashSignals?.join("; "), x.shutdownClean === false && "unclean shutdown", x.orderBreak && `order: ${x.orderBreak}`].filter(Boolean).join("; "),
      ]),
    },
  ];
  for (const c of s.candidates) {
    const used = VERDICTS.filter((v) => c.totals[v] > 0);
    const cols: Verdict[] = used.length ? used : ["match"];
    const t = c.totals;
    const compared = t.match + t.normalized + t.differ;
    blocks.push({
      kind: "heading",
      text:
        `${c.label}: ${t.match} match, ${t.normalized} normalized, ${t.differ} differ of ${compared} reference-stable answers; ` +
        `${t["ref-unstable"]} reference-unstable (equal to a reference variant on ${c.refUnstableMatchingARefRun})` +
        (t["only-ref"] + t["only-cand"] + t["not-reached"] + t["cand-unstable"]
          ? `; only-ref ${t["only-ref"]}, only-cand ${t["only-cand"]}, not-reached ${t["not-reached"]}, cand-unstable ${t["cand-unstable"]}`
          : ""),
    });
    const methods = Object.keys(c.byMethod);
    blocks.push({ kind: "table", header: ["method", ...cols], rows: [...methods.map((m) => [m, ...cols.map((v) => String(c.byMethod[m]![v] ?? 0))]), ["total", ...cols.map((v) => String(t[v]))]] });
    const attn = c.attention.filter((a) => ATTENTION.has(a.verdict));
    const items = attn.slice(0, attentionLimit).map((a) => line(`${a.verdict}: ${a.step}  -> ${a.detail}`, 1));
    if (attn.length > attentionLimit) items.push(line(`… ${attn.length - attentionLimit} more in summary.json`, 1));
    if (items.length) blocks.push({ kind: "lines", lines: items });
  }
  blocks.push({ kind: "verdict", text: s.clean ? "CLEAN: no difference needs attention and every session ended cleanly" : "ATTENTION: see the differences above" });
  return { title: "parallax lsp-diff", blocks };
}

export const renderSummary = (s: Summary, opts: { attentionLimit?: number } = {}): string => toText(summaryReport(s, opts));

// One row per candidate, method and verdict with a count (verdicts with none are left out), plus a
// "total" method row per verdict.
export function summaryCsv(s: Summary): string {
  const rows: (string | number)[][] = [];
  for (const c of s.candidates) {
    for (const [method, counts] of Object.entries(c.byMethod)) for (const v of VERDICTS) if (counts[v]) rows.push([c.label, method, v, counts[v]!]);
    for (const v of VERDICTS) if (c.totals[v]) rows.push([c.label, "total", v, c.totals[v]]);
  }
  return toCsv(["candidate", "method", "verdict", "count"], rows);
}
