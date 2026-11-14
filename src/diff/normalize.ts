// Answer normalization before comparing. Only what must differ between two runs of the same input:
//
//   base (verdict `match` when equal):
//     root      the project root path (plain and file-URI-encoded) becomes <root>
//     keys      object keys are compared in sorted order (key order means nothing in LSP)
//     items     completion items are compared as a set: sorted by canonical text (servers emit items
//               with equal sort keys in map order; editors sort by sortText anyway)
//   lib (verdict `normalized` when equal only with it):
//     lib       each side's bundled library location (profile libraryFiles) becomes <lib>/
//
// Rules are versioned: a bundle records the version it was compared with.

import { pathToFileURL } from "node:url";

export const NORMALIZE_VERSION = "parallax.normalize/1";
export const NORMALIZE_RULES = ["root", "keys", "items", "lib"] as const;

export interface LibLocation {
  uriPrefix?: string;
  dir?: string;
}

export interface Normalizer {
  // Strings to replace with their substitutes, longest first.
  base: [string, string][];
  lib: [string, string][];
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

export function makeNormalizer(root: string, lib: LibLocation | undefined): Normalizer {
  const rootForms = unique([root, pathToFileURL(root).pathname, root.split("/").map(encodeURIComponent).join("/")]);
  const base = rootForms.map((f): [string, string] => [f, "<root>"]);
  const libForms: string[] = [];
  if (lib?.uriPrefix) libForms.push(lib.uriPrefix.endsWith("/") ? lib.uriPrefix : `${lib.uriPrefix}/`);
  if (lib?.dir) {
    const dir = lib.dir.replace(/\/+$/, "");
    // Servers percent-encode file URIs differently (tsrs encodes @ and +, Node's pathToFileURL does not).
    for (const href of unique([pathToFileURL(dir).href, `file://${dir.split("/").map(encodeURIComponent).join("/")}`, `file://${dir}`]))
      libForms.push(`${href}/`);
  }
  const byLength = (a: [string, string], b: [string, string]): number => b[0].length - a[0].length;
  return { base: base.sort(byLength), lib: unique(libForms).map((f): [string, string] => [f, "<lib>/"]).sort(byLength) };
}

function mapString(s: string, subs: [string, string][]): string {
  for (const [from, to] of subs) if (s.includes(from)) s = s.replaceAll(from, to);
  return s;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// A normalized copy of `value`: strings mapped, object keys sorted, completion items sorted.
export function normalizeValue(value: unknown, subs: [string, string][], method?: string): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return mapString(v, subs);
    if (v === null || typeof v !== "object") return v;
    if (JSON.isRawJSON(v)) return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    const entries = Object.entries(v as Record<string, unknown>).map(([k, x]): [string, unknown] => [mapString(k, subs), x]);
    entries.sort(([a], [b]) => compareText(a, b));
    for (const [k, x] of entries) out[k] = walk(x);
    return out;
  };
  const n = walk(value);
  if (method === "textDocument/completion") return sortCompletionItems(n);
  return n;
}

const sortByText = (items: unknown[]): unknown[] =>
  items
    .map((i): [string, unknown] => [JSON.stringify(i), i])
    .sort(([a], [b]) => compareText(a, b))
    .map(([, i]) => i);

// Completion answers are `CompletionItem[]` or `CompletionList`; either way, inside { result }.
function sortCompletionItems(n: unknown): unknown {
  const r = n as { result?: unknown } | null;
  if (!r || typeof r !== "object") return n;
  if (Array.isArray(r.result)) return { ...r, result: sortByText(r.result) };
  const list = r.result as { items?: unknown } | null;
  if (list && typeof list === "object" && Array.isArray(list.items)) return { ...r, result: { ...list, items: sortByText(list.items) } };
  return n;
}

// The comparable part of a response: { result } or { error }, nothing else of the envelope.
export function answerOf(response: { result?: unknown; error?: unknown } | undefined): unknown {
  if (!response) return { missing: true };
  return response.error !== undefined ? { error: response.error } : { result: response.result ?? null };
}

export function lookFor(subs: [string, string][], text: string): boolean {
  return subs.some(([from]) => text.includes(from));
}
