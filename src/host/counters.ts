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
// PARALLAX_PERF names the perf program (default: `perf` on PATH); PARALLAX_COUNTERS=none|perf forces
// a backend.

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
const EVENTS = ["instructions:u", "cycles:u", "task-clock", "page-faults"];

const perfProgram = (): string => process.env.PARALLAX_PERF || "perf";

// `perf stat -x,` output: value,unit,event,run time,percentage,... per line; "<not counted>" or
// "<not supported>" for a value the kernel would not give. perf may add a ":u" to the event name.
export function parsePerfStat(text: string): Counters | null {
  const values = new Map<string, number | null>();
  for (const line of text.split("\n")) {
    const f = line.split(",");
    if (f.length < 3 || line.startsWith("#")) continue;
    const event = f[2]!.trim().replace(/:[ukh]+$/, "");
    const v = Number(f[0]);
    values.set(event, f[0]!.startsWith("<") || !Number.isFinite(v) ? null : v);
  }
  if (!values.size) return null;
  const get = (k: string): number | null => values.get(k) ?? null;
  return {
    instructions: get("instructions"),
    cycles: get("cycles"),
    taskClockMs: get("task-clock"),
    pageFaults: get("page-faults"),
  };
}

let cached: CounterBackend | undefined;

// The first backend that works here: perf counts instructions of a trivial command.
export function counterBackend(): CounterBackend {
  if (cached) return cached;
  const forced = process.env.PARALLAX_COUNTERS;
  if (forced === "none") return (cached = "none");
  if (platform() !== "linux" && forced !== "perf") return (cached = "none");
  const r = spawnSync(perfProgram(), ["stat", "-x,", "-e", "instructions:u", "--", process.execPath, "-e", "0"], { encoding: "utf8", timeout: 15_000 });
  const works = r.status === 0 && (parsePerfStat(r.stderr ?? "")?.instructions ?? 0) > 0;
  return (cached = works ? "perf" : "none");
}

export interface CountedRun {
  exit: { code: number | null; signal: string | null };
  timedOut: boolean;
  counters: Counters | null;
}

// Runs `command` under perf stat (its threads and child processes are counted too) and returns the
// counts. Output is discarded: the timed runs already checked it.
export async function countCommand(opts: { command: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<CountedRun> {
  const scratch = mkdtempSync(join(tmpdir(), "parallax-counters-"));
  const report = join(scratch, "perf.csv");
  const child = spawn(perfProgram(), ["stat", "-x,", "-o", report, "-e", EVENTS.join(","), "--", ...opts.command], {
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
  const counters = existsSync(report) ? parsePerfStat(readFileSync(report, "utf8")) : null;
  rmSync(scratch, { recursive: true, force: true });
  return { exit, timedOut, counters };
}
