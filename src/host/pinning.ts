// Pinning measured commands to chosen cores (Linux, through taskset). Off by default: the scheduler's
// own placement is what users get, and a pinned default-mode run measures a different machine (fewer
// cores). Pinning helps where it removes noise the bench cannot otherwise control: keeping every side
// on the same physical cores of a hybrid CPU (performance vs efficiency cores), or off cores that
// interrupts or other work favour. Every side, the counted runs and the language servers are pinned
// to the same list, and the list is recorded in the bundle.
//
// The harness itself (and its canary) is not pinned: it is mostly idle while a command runs.

import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { countCpuList } from "./machineState.ts";

export interface Pinning {
  // Kernel cpu list ("2-5", "0,2,4,6").
  cpus: string;
  cores: number;
}

// "0-3,8" -> [0, 1, 2, 3, 8]; throws on anything else.
export function expandCpuList(list: string): number[] {
  const out: number[] = [];
  for (const part of list.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`--pin: ${JSON.stringify(list)} is not a cpu list like 0-3,8`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) throw new Error(`--pin: ${part} runs backwards`);
    for (let c = lo; c <= hi; c++) out.push(c);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Validates a --pin value against this machine: Linux with taskset, and only cores this process may
// run on (`allowed`, the kernel's list from /proc/self/status, when known).
export function parsePinning(list: string, allowed: string | null, os: NodeJS.Platform = platform()): Pinning {
  if (os !== "linux") throw new Error("--pin needs Linux (taskset)");
  const cpus = expandCpuList(list);
  if (allowed !== null) {
    const ok = new Set(expandCpuList(allowed));
    const outside = cpus.filter((c) => !ok.has(c));
    if (outside.length) throw new Error(`--pin: cores ${outside.join(",")} are not ones this process may run on (${allowed})`);
  }
  const probe = spawnSync("taskset", ["-c", list, "true"], { encoding: "utf8", timeout: 10_000 });
  if (probe.error || probe.status !== 0) throw new Error(`--pin: taskset did not work here (${probe.error?.message ?? probe.stderr.trim()})`);
  return { cpus: list, cores: countCpuList(list) };
}

export const pinCommand = (command: string[], pin: Pinning | null): string[] => (pin ? ["taskset", "-c", pin.cpus, ...command] : command);
