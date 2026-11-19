// A small model of a report: blocks of lines, tables, warnings and a closing verdict, built once from
// a summary and rendered to plain text (the terminal) or GitHub-flavoured Markdown (a PR comment or
// $GITHUB_STEP_SUMMARY). Both renderings show the same content, so the row building lives in one
// place per report and only the layout differs here. Text output can be painted for a terminal
// (src/style.ts): what a cell or verdict means picks its tone here, the painter picks the colour.

import { plain, type Paint, type Tone } from "../style.ts";

export interface Line {
  text: string;
  // Nesting under the line before (text: two spaces each; Markdown: a nested list item).
  indent?: number;
}

export type Block =
  // A line naming what follows ("tsrs vs tsc7: measured"); text puts no blank line after it.
  | { kind: "heading"; text: string }
  | { kind: "lines"; lines: Line[] }
  // The first column is left-aligned, the others right-aligned (numbers). A caption goes right above.
  | { kind: "table"; caption?: string; header: string[]; rows: string[][] }
  | { kind: "warnings"; notes: string[] }
  // `tone`: how the verdict reads at a glance (clean, a caveat, a problem); colour only.
  | { kind: "verdict"; text: string; tone?: Tone };

export interface Report {
  // Markdown only: the report's own heading (text output has always started with the figures).
  title: string;
  blocks: Block[];
}

export const line = (text: string, indent = 0): Line => (indent ? { text, indent } : { text });

// The tone of a table cell, from its column and its words: calls (faster green, slower red, unresolved
// yellow), a candidate's state, an output that differs, answer-diff counts that need attention.
export function cellTone(header: string, text: string): Tone | null {
  const h = header.toLowerCase();
  const first = text.split(/[ (]/)[0]!;
  if (h === "call") {
    if (["faster", "lower", "better"].includes(first)) return "good";
    if (["slower", "higher", "worse"].includes(first)) return "bad";
    if (first === "unresolved" || text.startsWith("too few") || text.startsWith("not compared")) return "warn";
    return null;
  }
  // An A/A calibration has nothing to find: any direction is a false call.
  if (h === "a/a call") return ["faster", "slower", "lower", "higher"].includes(first) ? "bad" : null;
  if (h === "state") return text === "failed" ? "bad" : text === "noisy" ? "warn" : null;
  if (h === "output") return text === "DIFFERENT" || text.startsWith("UNSTABLE") ? "bad" : null;
  if (text !== "0" && /^\d+$/.test(text)) {
    if (h === "differ" || h === "not-reached") return "bad";
    if (h.endsWith("-unstable") || h === "only-ref" || h === "only-cand") return "warn";
  }
  return null;
}

export function textTable(header: string[], rows: string[][], paint: Paint = plain): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  // Padded first, painted after: escape codes take no columns on screen but count in a string's length.
  const pad = (c: string, i: number): [string, string] => {
    const gap = " ".repeat(widths[i]! - c.length);
    return i === 0 ? [c, gap] : [gap, c];
  };
  const row = (cells: string[], toneOf: (c: string, i: number) => Tone | null): string =>
    cells
      .map((c, i) => {
        const [a, b] = pad(c, i);
        const tone = toneOf(c, i);
        return i === 0 ? (tone ? paint(tone, a) : a) + b : a + (tone ? paint(tone, b) : b);
      })
      .join("  ");
  return [
    row(header, () => "strong"),
    paint("dim", widths.map((w) => "-".repeat(w)).join("  ")),
    ...rows.map((r) => row(r, (c, i) => cellTone(header[i]!, c))),
  ].join("\n");
}

// Text lines wrap at this width, on spaces, continuing two spaces further in: prose (the rounds line,
// the confidence legend, warnings) stays readable in a terminal. Tables are never wrapped.
export const TEXT_WIDTH = 100;

export function wrap(text: string, indent: string, width = TEXT_WIDTH): string[] {
  const out: string[] = [];
  let cur = indent;
  let lead = indent;
  for (const word of text.split(" ")) {
    if (cur.length > lead.length && cur.length + 1 + word.length > width) {
      out.push(cur);
      lead = `${indent}  `;
      cur = lead + word;
    } else cur = cur.length > lead.length ? `${cur} ${word}` : cur + word;
  }
  out.push(cur);
  return out;
}

export function toText(r: Report, paint: Paint = plain): string {
  const out: string[] = [];
  r.blocks.forEach((b, i) => {
    // Blocks are separated by a blank line, except after a heading, which belongs to what follows.
    if (i > 0 && r.blocks[i - 1]!.kind !== "heading") out.push("");
    if (b.kind === "heading") out.push(paint("strong", b.text));
    else if (b.kind === "verdict") out.push(paint(b.tone ?? "strong", b.text));
    else if (b.kind === "lines") for (const l of b.lines) out.push(...wrap(l.text, "  ".repeat(l.indent ?? 0)));
    else if (b.kind === "warnings") out.push(paint("warn", "warnings:"), ...b.notes.flatMap((n) => wrap(`- ${n}`, "  ")));
    else {
      if (b.caption) out.push(paint("dim", b.caption));
      out.push(textTable(b.header, b.rows, paint));
    }
  });
  return out.join("\n");
}

// Characters Markdown would read as formatting, HTML or a table cell's end.
export const escapeMd = (s: string): string => s.replace(/[\\`*_<>|[\]~]/g, (c) => `\\${c}`);

// A column is right-aligned when every filled cell is a figure ("336 ms", "0.352x (..)", "6/6",
// "±3.1%"), left-aligned when any is words (a call, a state, a role).
const FIGURE = /^[-+±<~(]?\d|^-$/;

export function markdownTable(header: string[], rows: string[][]): string {
  const row = (cells: string[]): string => `| ${cells.map((c) => escapeMd(c)).join(" | ")} |`;
  const numeric = header.map((_, i) => i > 0 && rows.every((r) => !r[i] || FIGURE.test(r[i]!)));
  return [row(header), `| ${numeric.map((n) => (n ? "---:" : ":---")).join(" | ")} |`, ...rows.map(row)].join("\n");
}

export function toMarkdown(r: Report): string {
  const out: string[] = [`## ${escapeMd(r.title)}`];
  for (const b of r.blocks) {
    out.push("");
    if (b.kind === "heading") out.push(`### ${escapeMd(b.text)}`);
    else if (b.kind === "verdict") out.push(`**${escapeMd(b.text)}**`);
    else if (b.kind === "lines") for (const l of b.lines) out.push(`${"  ".repeat(l.indent ?? 0)}- ${escapeMd(l.text)}`);
    else if (b.kind === "warnings") out.push("> **warnings**", ">", ...b.notes.map((n) => `> - ${escapeMd(n)}`));
    else {
      if (b.caption) out.push(escapeMd(b.caption), "");
      out.push(markdownTable(b.header, b.rows));
    }
  }
  return out.join("\n");
}

// RFC 4180 quoting: a field with a comma, quote or line break is quoted, quotes doubled; null is empty.
// Lines end in LF, not the RFC's CRLF, as most tools write and every CSV reader accepts.
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const field = (v: string | number | null): string => {
    const s = v === null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(field).join(",")).join("\n");
}
