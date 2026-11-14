// Request identity: two runs' answers are compared when they answer the same request, never because
// they sit at the same index. A request's identity is its step name, its method and its canonical
// params (root masked, keys sorted), plus its occurrence among equal ones in the same run. A request
// only one run asked (rename after a prepareRename that answered null on the other side; a quick fix
// for a diagnostic only one side reported) has an identity only that run has.

import { createHash } from "node:crypto";
import { normalizeValue } from "./normalize.ts";

export class IdentityCounter {
  #seen = new Map<string, number>();
  #rootSubs: [string, string][];

  constructor(rootSubs: [string, string][]) {
    this.#rootSubs = rootSubs;
  }

  // A short, stable key: `<occurrence>:<sha256 of step, method and canonical params>`.
  next(step: string, method: string, params: unknown): string {
    const id = `${step}\u0000${method}\u0000${JSON.stringify(normalizeValue(params ?? null, this.#rootSubs))}`;
    const digest = createHash("sha256").update(id).digest("hex").slice(0, 24);
    const n = this.#seen.get(digest) ?? 0;
    this.#seen.set(digest, n + 1);
    return `${n}:${digest}`;
  }
}

// The keys of all runs in one order: the first run's, with each key only a later run has placed after
// the key that precedes it in that run.
export function mergeOrder(runs: string[][]): string[] {
  const next = new Map<string, string | null>();
  let head: string | null = null;
  let tail: string | null = null;
  const append = (k: string): void => {
    next.set(k, null);
    if (tail === null) head = k;
    else next.set(tail, k);
    tail = k;
  };
  const insertAfter = (prev: string | null, k: string): void => {
    if (prev === null) {
      next.set(k, head);
      head = k;
      if (tail === null) tail = k;
      return;
    }
    const after = next.get(prev) ?? null;
    next.set(k, after);
    next.set(prev, k);
    if (tail === prev) tail = k;
  };
  for (const [i, keys] of runs.entries()) {
    let prev: string | null = null;
    for (const k of keys) {
      if (!next.has(k)) {
        if (i === 0) append(k);
        else insertAfter(prev, k);
      }
      prev = k;
    }
  }
  const order: string[] = [];
  for (let k: string | null = head; k !== null; k = next.get(k) ?? null) order.push(k);
  return order;
}

// Where a run asks the keys it shares with `order` in another relative order: the first such pair, or
// null. Such a run did not follow the script the same way, and its answers after that point are suspect.
export function orderBreak(order: string[], keys: string[], stepOf: (k: string) => string): string | null {
  const index = new Map(order.map((k, i) => [k, i]));
  let last = -1;
  let lastKey: string | undefined;
  for (const k of keys) {
    const p = index.get(k);
    if (p === undefined) continue;
    if (p < last) return `asked ${JSON.stringify(stepOf(k))} after ${JSON.stringify(stepOf(lastKey!))}`;
    last = p;
    lastKey = k;
  }
  return null;
}
