// A small model of a report: blocks of lines, tables, warnings and a closing verdict, built once from
// a summary and rendered to plain text (the terminal) or GitHub-flavoured Markdown (a PR comment or
// $GITHUB_STEP_SUMMARY). Both renderings show the same content, so the row building lives in one
// place per report and only the layout differs here.

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
  | { kind: "verdict"; text: string };

export interface Report {
  // Markdown only: the report's own heading (text output has always started with the figures).
  title: string;
  blocks: Block[];
}

export const line = (text: string, indent = 0): Line => (indent ? { text, indent } : { text });

export function textTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const row = (cells: string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [row(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(row)].join("\n");
}

export function toText(r: Report): string {
  const out: string[] = [];
  r.blocks.forEach((b, i) => {
    // Blocks are separated by a blank line, except after a heading, which belongs to what follows.
    if (i > 0 && r.blocks[i - 1]!.kind !== "heading") out.push("");
    if (b.kind === "heading" || b.kind === "verdict") out.push(b.text);
    else if (b.kind === "lines") for (const l of b.lines) out.push(`${"  ".repeat(l.indent ?? 0)}${l.text}`);
    else if (b.kind === "warnings") out.push("warnings:", ...b.notes.map((n) => `  - ${n}`));
    else {
      if (b.caption) out.push(b.caption);
      out.push(textTable(b.header, b.rows));
    }
  });
  return out.join("\n");
}

// Characters Markdown would read as formatting, HTML or a table cell's end.
export const escapeMd = (s: string): string => s.replace(/[\\`*_<>|[\]~]/g, (c) => `\\${c}`);

export function markdownTable(header: string[], rows: string[][]): string {
  const row = (cells: string[]): string => `| ${cells.map((c) => escapeMd(c)).join(" | ")} |`;
  return [row(header), `| ${header.map((_, i) => (i === 0 ? ":---" : "---:")).join(" | ")} |`, ...rows.map(row)].join("\n");
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
