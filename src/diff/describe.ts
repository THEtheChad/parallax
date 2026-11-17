// A difference, described for triage: what is only on one side, not two full answers to eyeball.
// Completion lists are compared as sets of items (with a label and source module per item); any other
// answer as a list of the JSON paths whose values differ. Full answers are included when small.

const FULL_ANSWER_LIMIT = 256 * 1024;
const PATH_LIMIT = 100;
const ITEM_LIMIT = 500;

export interface PathDiff {
  path: string;
  ref: unknown;
  cand: unknown;
}

const clip = (v: unknown): unknown => {
  if (v === undefined) return "<absent>";
  const text = JSON.stringify(v);
  return text.length > 2000 ? `${text.slice(0, 2000)}… (${text.length} chars)` : v;
};

export function jsonDiff(a: unknown, b: unknown, limit = PATH_LIMIT): { diffs: PathDiff[]; total: number } {
  const diffs: PathDiff[] = [];
  let total = 0;
  const push = (path: string, x: unknown, y: unknown): void => {
    total++;
    if (diffs.length < limit) diffs.push({ path, ref: clip(x), cand: clip(y) });
  };
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (x === y) return;
    const isObj = (v: unknown): v is object => v !== null && typeof v === "object" && !JSON.isRawJSON(v);
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) push(`${path}.length`, x.length, y.length);
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${path}[${i}]`);
      return;
    }
    if (isObj(x) && isObj(y) && !Array.isArray(x) && !Array.isArray(y)) {
      const xo = x as Record<string, unknown>;
      const yo = y as Record<string, unknown>;
      for (const k of new Set([...Object.keys(xo), ...Object.keys(yo)])) {
        const p = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`;
        if (!(k in xo) || !(k in yo)) push(p, xo[k], yo[k]);
        else walk(xo[k], yo[k], p);
      }
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) push(path, x, y);
  };
  walk(a, b, "$");
  return { diffs, total };
}

interface CompletionItem {
  label?: string;
  sortText?: string;
  labelDetails?: { description?: string };
  data?: { autoImport?: { moduleSpecifier?: string; fileName?: string } };
  source?: string;
}

function completionParts(answer: unknown): { items: unknown[]; rest: unknown } | null {
  const r = (answer as { result?: unknown } | null)?.result;
  if (Array.isArray(r)) return { items: r, rest: { ...(answer as object), result: "<items>" } };
  if (r && typeof r === "object" && Array.isArray((r as { items?: unknown }).items)) {
    const { items, ...rest } = r as { items: unknown[] };
    return { items, rest: { ...(answer as object), result: { ...rest, items: "<items>" } } };
  }
  return null;
}

// "label  (module)": enough to see an auto-import's source at a glance.
const itemName = (i: CompletionItem): string => {
  const from = i.data?.autoImport?.moduleSpecifier ?? i.labelDetails?.description ?? i.source;
  return from ? `${i.label}  (${from})` : `${i.label}`;
};

export function describeDifference(method: string, ref: unknown, cand: unknown): Record<string, unknown> {
  if (ref === undefined || cand === undefined) {
    const one = ref ?? cand;
    return { only: ref === undefined ? "cand" : "ref", answer: JSON.stringify(one).length <= FULL_ANSWER_LIMIT ? one : "<large, omitted>" };
  }
  if (method === "textDocument/completion") {
    const a = completionParts(ref);
    const b = completionParts(cand);
    if (a && b) {
      const textsA = new Map(a.items.map((i) => [JSON.stringify(i), i]));
      const textsB = new Map(b.items.map((i) => [JSON.stringify(i), i]));
      const onlyRef = [...textsA].filter(([t]) => !textsB.has(t)).map(([, i]) => i as CompletionItem);
      const onlyCand = [...textsB].filter(([t]) => !textsA.has(t)).map(([, i]) => i as CompletionItem);
      return {
        completion: {
          refItems: a.items.length,
          candItems: b.items.length,
          onlyRefCount: onlyRef.length,
          onlyCandCount: onlyCand.length,
          onlyRefNames: onlyRef.map(itemName).sort().slice(0, ITEM_LIMIT),
          onlyCandNames: onlyCand.map(itemName).sort().slice(0, ITEM_LIMIT),
          onlyRef: onlyRef.slice(0, 50),
          onlyCand: onlyCand.slice(0, 50),
          otherFields: jsonDiff(a.rest, b.rest),
        },
      };
    }
  }
  const small = JSON.stringify(ref).length + JSON.stringify(cand).length <= FULL_ANSWER_LIMIT;
  return { paths: jsonDiff(ref, cand), ...(small ? { refAnswer: ref, candAnswer: cand } : {}) };
}
