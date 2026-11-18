// Hardware and software event counters of a command, where the OS offers them without root: Linux's
// perf_event_open, through the `perf stat` program (Node cannot make the system call itself). Node
// alone has nothing like it on any OS, so this is optional and recorded, like `time`:
//
//   perf  `perf stat -x,` on Linux, when kernel.perf_event_paranoid allows user-space counting (<= 2)
//         and, in a VM, the hypervisor exposes the CPU's counters (WSL2 does)
//   none  everywhere else (macOS needs root for its counters; Windows has no ordinary way)
//
// User-space instructions retired are close to deterministic for single-threaded work without a
// garbage collector (0.008% spread for tsrs --singleThreaded on hono), and far noisier with threads or
// a GC (4.5% for tsc 7 by default). They measure work, not time: two implementations do different
// work per cycle, so instructions compare an implementation with itself (across commits, or between
// thread modes), never one implementation with another.
//
// Counters are checked before they are trusted. Each event is first counted alone on a trivial command;
// one that is not supported, or reads 0 (some virtual machines expose a counter that never counts), is
// left out and recorded as unavailable. Then the working events are counted together; if any of them
// stops counting or is multiplexed there (a Zen 5 guest counts only the first hardware event of a
// set), each hardware event gets a counted run of its own. The plan is recorded in the bundle, and
// every counted run still drops a zero or a scaled (multiplexed) count instead of reporting it.
//
// PARALLAX_PERF names the perf program (default: `perf` on PATH); PARALLAX_COUNTERS=none|perf forces
// a backend, and PARALLAX_COUNTERS=split forces one run per hardware event.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { killTree, treeSpawnOptions } from "./processTree.ts";

export type CounterBackend = "perf" | "none";

export interface Counters {
  // User-space instructions retired and core cycles (null when the CPU's counters are not available).
  instructions: number | null;
  cycles: number | null;
  // CPU time the command's threads ran (perf's task-clock), ms.
  taskClockMs: number | null;
  // Page faults taken in user space (memory touched for the first time, mostly).
  pageFaults: number | null;
}

// User space only: without root, perf_event_paranoid 2 allows nothing else, so kernel-side events
// (context switches, CPU migrations) would always read 0 and are not asked for.
export const EVENTS = ["instructions:u", "cycles:u", "task-clock", "page-faults"] as const;
const HARDWARE = new Set<string>(["instructions:u", "cycles:u"]);

const perfProgram = (): string => process.env.PARALLAX_PERF || "perf";

const FIELD: Record<string, keyof Counters> = { instructions: "instructions", cycles: "cycles", "task-clock": "taskClockMs", "page-faults": "pageFaults" };

export interface PerfStat {
  counters: Counters;
  // Events perf counted only part of the time and scaled up (multiplexed): their values are dropped.
  scaled: string[];
  // Events that read 0 or were not counted: their values are null.
  missing: string[];
}

// `perf stat -x,` output: value,unit,event,run time,percentage,... per line; "<not counted>" or
// "<not supported>" for a value the kernel would not give. perf may add a ":u" to the event name. The
// percentage is the share of the run the counter was running; below 100 perf scaled the value up.
export function parsePerfStatDetail(text: string): PerfStat | null {
  const counters: Counters = { instructions: null, cycles: null, taskClockMs: null, pageFaults: null };
  const scaled: string[] = [];
  const missing: string[] = [];
  let seen = 0;
  for (const line of text.split("\n")) {
    const f = line.split(",");
    if (f.length < 3 || line.startsWith("#")) continue;
    const event = f[2]!.trim().replace(/:[ukh]+$/, "");
    const key = FIELD[event];
    if (!key) continue;
    seen++;
    const v = Number(f[0]);
    const pct = f[4] === undefined || f[4].trim() === "" ? 100 : Number(f[4]);
    if (f[0]!.startsWith("<") || !Number.isFinite(v) || v <= 0) {
      missing.push(event);
      continue;
    }
    // perf prints 100.00 for a counter that ran the whole time; anything less was scaled.
    if (!Number.isFinite(pct) || pct < 100) {
      scaled.push(event);
      continue;
    }
    counters[key] = v;
  }
  return seen ? { counters, scaled, missing } : null;
}

export function parsePerfStat(text: string): Counters | null {
  return parsePerfStatDetail(text)?.counters ?? null;
}

export interface CounterPlan {
  backend: CounterBackend;
  // Event sets, each counted in a run of its own; one set when the CPU counts them all together.
  groups: string[][];
  // Events this machine will not count (not supported, or always 0).
  unavailable: string[];
}

const probe = (events: readonly string[]): PerfStat | null => {
  const r = spawnSync(perfProgram(), ["stat", "-x,", "-e", events.join(","), "--", process.execPath, "-e", "0"], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0 ? parsePerfStatDetail(r.stderr ?? "") : null;
};

const eventName = (e: string): string => e.replace(/:[ukh]+$/, "");

// Groups the working events: together when they all count together, else one hardware event per run
// (software events ride along with the first).
export function planGroups(working: string[], together: PerfStat | null, forceSplit = false): string[][] {
  if (!working.length) return [];
  const ok = together !== null && !together.missing.length && !together.scaled.length;
  if (ok && !forceSplit) return [working];
  const hw = working.filter((e) => HARDWARE.has(e));
  const sw = working.filter((e) => !HARDWARE.has(e));
  if (!hw.length) return [sw];
  return hw.map((e, i) => (i === 0 ? [e, ...sw] : [e]));
}

let cached: CounterPlan | undefined;

// What this machine can count, checked once per process (see the top of the file).
export function counterPlan(): CounterPlan {
  if (cached) return cached;
  const forced = process.env.PARALLAX_COUNTERS;
  const none: CounterPlan = { backend: "none", groups: [], unavailable: [] };
  if (forced === "none") return (cached = none);
  if (platform() !== "linux" && forced !== "perf" && forced !== "split") return (cached = none);
  const alone = EVENTS.map((e) => ({ e, r: probe([e]) }));
  const working = alone.filter(({ e, r }) => r !== null && !r.missing.includes(eventName(e))).map(({ e }) => e);
  // Instructions are what counters are for: without them the backend is not worth its runs.
  if (!working.includes("instructions:u")) return (cached = none);
  const groups = planGroups(working, probe(working), forced === "split");
  return (cached = { backend: "perf", groups, unavailable: EVENTS.filter((e) => !working.includes(e)) });
}

export const counterBackend = (): CounterBackend => counterPlan().backend;

export interface CountedRun {
  exit: { code: number | null; signal: string | null };
  timedOut: boolean;
  counters: Counters | null;
  // Runs it took (one per event group), and events dropped as multiplexed or not counted.
  runs?: number;
  scaled?: string[];
  missing?: string[];
}

async function countOnce(opts: { command: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }, events: string[]): Promise<CountedRun & { stat: PerfStat | null }> {
  const scratch = mkdtempSync(join(tmpdir(), "parallax-counters-"));
  const report = join(scratch, "perf.csv");
  const child = spawn(perfProgram(), ["stat", "-x,", "-o", report, "-e", events.join(","), "--", ...opts.command], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "ignore", "ignore"],
    ...treeSpawnOptions(),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, opts.timeoutMs);
  const exit = await new Promise<CountedRun["exit"]>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  killTree(child.pid);
  const stat = existsSync(report) ? parsePerfStatDetail(readFileSync(report, "utf8")) : null;
  rmSync(scratch, { recursive: true, force: true });
  return { exit, timedOut, counters: stat?.counters ?? null, stat };
}

// Runs `command` under perf stat once per event group (its threads and child processes are counted
// too) and merges the counts. Output is discarded: the timed runs already checked it.
export async function countCommand(opts: { command: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; groups?: string[][] }): Promise<CountedRun> {
  const groups = opts.groups?.length ? opts.groups : [[...EVENTS]];
  const merged: Counters = { instructions: null, cycles: null, taskClockMs: null, pageFaults: null };
  const scaled: string[] = [];
  const missing: string[] = [];
  let any = false;
  let last: CountedRun["exit"] = { code: null, signal: null };
  for (const events of groups) {
    const r = await countOnce(opts, events);
    last = r.exit;
    if (r.timedOut || r.exit.signal !== null) return { exit: r.exit, timedOut: r.timedOut, counters: null, runs: groups.length, scaled, missing };
    if (!r.stat) continue;
    any = true;
    for (const k of Object.keys(merged) as (keyof Counters)[]) merged[k] ??= r.stat.counters[k];
    scaled.push(...r.stat.scaled);
    missing.push(...r.stat.missing);
  }
  return { exit: last, timedOut: false, counters: any ? merged : null, runs: groups.length, scaled, missing };
}
