// The calibration canary: a fixed single-threaded workload the harness times in its own process
// before and after every round. The work never changes, so a change in its time means the machine
// changed speed (other load, clock boost or thermal limits, a host the OS cannot see, such as the
// Windows side of WSL or a cloud VM's neighbours). It allocates, hashes strings into a Map and sorts,
// roughly like a compiler's mix, rather than spinning in registers.
//
// Its time is used to reject rounds, not to scale results: how much a slowdown of the canary slows a
// many-threaded compiler is not a constant.

import { seededRandom } from "./stats.ts";

export const CANARY_VERSION = "parallax.canary/1";

interface Item {
  key: string;
  value: number;
  next: Item | null;
}

function work(size: number): number {
  const rand = seededRandom(42);
  const items: Item[] = [];
  let prev: Item | null = null;
  for (let i = 0; i < size; i++) {
    const item: Item = { key: `k${Math.floor(rand() * size * 4).toString(36)}`, value: rand(), next: prev };
    items.push(item);
    prev = item;
  }
  const byKey = new Map<string, number>();
  for (const it of items) byKey.set(it.key, (byKey.get(it.key) ?? 0) + it.value);
  items.sort((a, b) => a.value - b.value);
  let sum = 0;
  for (let it: Item | null = items[items.length - 1]!; it; it = it.next) sum += it.value;
  return sum + byKey.size;
}

export interface CanaryResult {
  // The fastest repetition: the least disturbed estimate of the machine's speed right now.
  ms: number;
  samples: number[];
}

export const CANARY_SIZE = 60_000;

export function runCanary({ reps = 5, size = CANARY_SIZE } = {}): CanaryResult {
  work(size); // warm-up: compile before timing
  const samples: number[] = [];
  let sink = 0;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    sink += work(size);
    samples.push(performance.now() - t0);
  }
  if (Number.isNaN(sink)) throw new Error("canary workload broke");
  return { ms: Math.min(...samples), samples };
}
