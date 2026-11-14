// Plain-text rendering of a bundle's summary.json. A pure function of the summary.

import { ATTENTION, VERDICTS, type Summary, type Verdict } from "../diff/compare.ts";

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

export function renderSummary(s: Summary, { attentionLimit = 30 } = {}): string {
  const out: string[] = [];
  out.push(`${s.requests} requests; reference runs ${s.refRuns.join(", ")}; ${s.refUnstable} reference-unstable`);
  out.push(`normalization ${s.normalization.version} (${s.normalization.rules.join(", ")})`);
  out.push("");
  out.push(
    table(
      ["session", "role", "outcome", "answers", "note"],
      s.sessions.map((x) => [x.run, x.role, x.outcome, String(x.answers), [x.error, x.crashSignals?.join("; "), x.orderBreak && `order: ${x.orderBreak}`].filter(Boolean).join("; ")]),
    ),
  );
  for (const c of s.candidates) {
    const used = VERDICTS.filter((v) => c.totals[v] > 0);
    const cols: Verdict[] = used.length ? used : ["match"];
    out.push("");
    const t = c.totals;
    const compared = t.match + t.normalized + t.differ;
    out.push(
      `${c.label}: ${t.match} match, ${t.normalized} normalized, ${t.differ} differ of ${compared} reference-stable answers; ` +
        `${t["ref-unstable"]} reference-unstable (equal to one reference run on ${c.refUnstableMatchingARefRun})` +
        (t["only-ref"] + t["only-cand"] + t["not-reached"] + t["cand-unstable"]
          ? `; only-ref ${t["only-ref"]}, only-cand ${t["only-cand"]}, not-reached ${t["not-reached"]}, cand-unstable ${t["cand-unstable"]}`
          : ""),
    );
    const methods = Object.keys(c.byMethod);
    out.push(table(["method", ...cols], [...methods.map((m) => [m, ...cols.map((v) => String(c.byMethod[m]![v] ?? 0))]), ["total", ...cols.map((v) => String(t[v]))]]));
    const attn = c.attention.filter((a) => ATTENTION.has(a.verdict));
    for (const a of attn.slice(0, attentionLimit)) out.push(`  ${a.verdict}: ${a.step}  -> ${a.detail}`);
    if (attn.length > attentionLimit) out.push(`  … ${attn.length - attentionLimit} more in summary.json`);
  }
  out.push("");
  out.push(s.clean ? "CLEAN: no difference needs attention and every session ended cleanly" : "ATTENTION: see the differences above");
  return out.join("\n");
}
