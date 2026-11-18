// Linux only: track the measured command's process group through /proc, to account for processes
// that `time` cannot see. getrusage counts a descendant only when its parent waits for it; a launcher
// that exits without waiting for its worker (the tsc-rs fork does) leaves the worker to be adopted and
// reaped outside the group, so its CPU and memory vanish from the report and show up as "other
// programs" in the machine total.
//
// The tracker scans /proc every few tens of milliseconds and remembers each group member's last CPU
// and peak memory. A member that was ever seen with a parent outside the group (adopted), or that is
// still alive when the command's top process exits, was never waited for inside the group: its CPU is
// added to `time`'s figures. Members that vanish while their parent is in the group were waited for
// and are already counted. The final interval of an adopted process (up to one scan period) is lost,
// so adopted CPU is a slight undercount; the record says how many processes were adopted.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { platform } from "node:os";

interface Member {
  ppid: number;
  // utime + stime + cutime + cstime of this process, in clock ticks.
  ticks: number;
  hwmBytes: number;
  adopted: boolean;
}

export interface GroupUsage {
  // CPU and peak memory of the members nobody in the group waited for.
  adoptedCpuMs: number;
  adopted: number;
  // Largest peak resident memory of any member seen (VmHWM).
  maxHwmBytes: number;
  members: number;
  scans: number;
}

let clockTicks: number | undefined;
export const ticksPerSecond = (): number => {
  if (clockTicks === undefined) {
    const r = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
    const n = Number(r.stdout?.trim());
    clockTicks = r.status === 0 && n > 0 ? n : 100;
  }
  return clockTicks;
};

export const groupTrackingAvailable = (): boolean => platform() === "linux" && existsSync("/proc/self/stat");

export function readStat(pid: string): { ppid: number; pgrp: number; ticks: number } | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the command name, which may itself contain spaces and parentheses.
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(f[1]), pgrp: Number(f[2]), ticks: Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]) };
  } catch {
    return null;
  }
}

export function readHwm(pid: string): number {
  try {
    const m = /^VmHWM:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

export function readRss(pid: string): number {
  try {
    const m = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

export class GroupTracker {
  readonly #pgid: number;
  readonly #members = new Map<number, Member>();
  #timer: NodeJS.Timeout | undefined;
  #scans = 0;

  constructor(pgid: number, intervalMs = 25) {
    this.#pgid = pgid;
    this.scan();
    this.#timer = setInterval(() => this.scan(), intervalMs);
  }

  scan(): void {
    this.#scans++;
    const seen = new Map<number, { ppid: number; ticks: number; pid: string }>();
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return;
    }
    for (const d of entries) {
      if (d.charCodeAt(0) < 48 || d.charCodeAt(0) > 57) continue;
      const st = readStat(d);
      if (st && st.pgrp === this.#pgid) seen.set(Number(d), { ...st, pid: d });
    }
    for (const [pid, st] of seen) {
      const prev = this.#members.get(pid);
      // The group leader is the `time` (or command) process the harness spawned; its parent is us.
      const adopted = (prev?.adopted ?? false) || (pid !== this.#pgid && !seen.has(st.ppid) && !this.#members.has(st.ppid));
      this.#members.set(pid, { ppid: st.ppid, ticks: Math.max(st.ticks, prev?.ticks ?? 0), hwmBytes: Math.max(readHwm(st.pid), prev?.hwmBytes ?? 0), adopted });
    }
  }

  // Call when the top process has exited, before anything left in the group is killed.
  finish(): GroupUsage {
    clearInterval(this.#timer);
    // Members still alive now were not waited for by the (finished) top process.
    const before = new Set(this.#members.keys());
    this.scan();
    const alive = new Set<number>();
    for (const d of readdirSync("/proc")) {
      const st = /^\d+$/.test(d) ? readStat(d) : null;
      if (st?.pgrp === this.#pgid) alive.add(Number(d));
    }
    let adoptedTicks = 0;
    let adopted = 0;
    let maxHwm = 0;
    for (const [pid, m] of this.#members) {
      maxHwm = Math.max(maxHwm, m.hwmBytes);
      if (pid === this.#pgid) continue;
      if (m.adopted || (alive.has(pid) && before.has(pid))) {
        adoptedTicks += m.ticks;
        adopted++;
      }
    }
    return {
      adoptedCpuMs: (adoptedTicks / ticksPerSecond()) * 1000,
      adopted,
      maxHwmBytes: maxHwm,
      members: this.#members.size,
      scans: this.#scans,
    };
  }
}
