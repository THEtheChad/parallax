// JSON without lossy numbers. JSON.parse turns `1e999` into Infinity (which JSON.stringify writes as
// null), and loses the text of `-0`, `1.0`, `1E2` and integers above 2^53. A number whose text is not
// what JSON.stringify writes for its value is kept as that exact text with JSON.rawJSON, so it stays a
// difference wherever the other side wrote another text.
//
// A reviver on every value makes a parse several times slower, so `scan` tokenizes the text once (strings,
// brackets, the commas before keys, and only the number tokens that can be non-canonical), and the
// reviver runs only when some number is not canonical. Ported from the tsc-rs fork's vendored lspdiff
// json.mjs.

declare global {
  interface JSON {
    rawJSON(text: string): unknown;
    isRawJSON(value: unknown): boolean;
  }
}

interface ReviverContext {
  source?: string;
}

const keepNumbers = (_key: string, value: unknown, context?: ReviverContext): unknown =>
  typeof value === "number" && context?.source !== undefined && JSON.stringify(value) !== context.source
    ? JSON.rawJSON(context.source)
    : value;

export const parseKeep = (text: string): unknown =>
  JSON.parse(text, keepNumbers as (this: unknown, key: string, value: unknown) => unknown);

// A plain integer of up to 15 digits is always canonical and is not a token here, so the long integer
// arrays of semantic tokens cost nothing.
const SCAN = /"(?:[^"\\]|\\.)*"|[{}[\]]|,(?=[ \t\r\n]*")|-?\d+\.\d+(?:[eE][+-]?\d+)?|-?\d+[eE][+-]?\d+|-0(?![.\deE])|-?\d{16,}/g;

export interface ScanResult {
  // The first key that some object of the text has twice, or null.
  dup: string | null;
  // Every number's text is the one JSON.stringify writes for its value.
  exact: boolean;
}

export function scan(text: string): ScanResult {
  const stack: (Set<string> | null)[] = [];
  let prev = "";
  let exact = true;
  for (const [tok] of text.matchAll(SCAN)) {
    const c = tok[0];
    if (c === "{") stack.push(new Set());
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      const keys = stack[stack.length - 1];
      if (keys && (prev === "{" || prev === ",")) {
        const k = JSON.parse(tok) as string;
        if (keys.has(k)) return { dup: k, exact };
        keys.add(k);
      }
    } else if (c !== ",") {
      if (exact && JSON.stringify(Number(tok)) !== tok) exact = false;
      prev = "n";
      continue;
    }
    prev = c;
  }
  return { dup: null, exact };
}

// One JSON text, strictly: no duplicate key, every number's text kept. Throws with the reason.
export function parseStrict(text: string): { value: unknown; exact: boolean } {
  const { dup, exact } = scan(text);
  let value: unknown;
  try {
    value = exact ? JSON.parse(text) : parseKeep(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message.slice(0, 120)}`);
  }
  if (dup !== null) throw new Error(`duplicate key ${JSON.stringify(dup).slice(0, 80)}`);
  return { value, exact };
}

// Parses with kept numbers only when the text needs it.
export function parseExact(text: string): unknown {
  return scan(text).exact ? JSON.parse(text) : parseKeep(text);
}
