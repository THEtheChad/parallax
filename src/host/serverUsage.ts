// CPU and memory of a running server and the processes it started (its process group), read while it
// runs: a language server is timed phase by phase, so its usage is read at phase boundaries rather than
// once at exit as `time` does for a check command.
//
//   proc   Linux: /proc/<pid>/stat and status of every member of the group. CPU is each live member's
//          own time plus the time of the children it waited for; memory is the largest peak resident
//          size (VmHWM) of any member.
//   ps     macOS and other BSDs: `ps -A -o pgid=,time=,rss=`, the group's members summed. CPU has
//          centisecond resolution; memory is resident size now (BSD ps has no peak), so it is read at the
//          end of the session and reported as such.
//   none   Windows (no process groups; a server's start-up children are not attached to it), or when
//          neither works. CPU and memory are then left blank.
//
// PARALLAX_SERVER_USAGE=proc|ps|none forces a backend.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { platform } from "node:os";
import { readHwm, readRss, readStat, ticksPerSecond } from "./procGroup.ts";

export type UsageBackend = "proc" | "ps" | "none";

export interface ServerUsage {
  cpuMs: number;
  // proc: peak resident size so far; ps: resident size now.
  memoryBytes: number;
  // Resident size now, summed over the group (for growth over a session; peaks never shrink).
  residentBytes: number;
  members: number;
}

function procUsage(pgid: number): ServerUsage | null {
  let ticks = 0;
  let hwm = 0;
  let rss = 0;
  let members = 0;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const d of entries) {
    if (d.charCodeAt(0) < 48 || d.charCodeAt(0) > 57) continue;
    const st = readStat(d);
    if (!st || st.pgrp !== pgid) continue;
    members++;
    ticks += st.ticks;
    hwm = Math.max(hwm, readHwm(d));
    rss += readRss(d);
  }
  return members ? { cpuMs: (ticks / ticksPerSecond()) * 1000, memoryBytes: hwm, residentBytes: rss, members } : null;
}

// "[[dd-]hh:]mm:ss[.ff]" (BSD and procps both use subsets of this) to milliseconds.
export function parsePsTime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  const [, days = "0", hours = "0", minutes, seconds] = m;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000;
}

// Lines of `ps -A -o pgid=,time=,rss=`, summed over one group.
export function parsePsGroup(output: string, pgid: number): ServerUsage | null {
  let cpuMs = 0;
  let rss = 0;
  let members = 0;
  for (const line of output.split("\n")) {
    const [g, time, kb] = line.trim().split(/\s+/);
    if (Number(g) !== pgid) continue;
    const ms = parsePsTime(time ?? "");
    if (ms === null) continue;
    members++;
    cpuMs += ms;
    rss += Number(kb) * 1024 || 0;
  }
  return members ? { cpuMs, memoryBytes: rss, residentBytes: rss, members } : null;
}

function psUsage(pgid: number): ServerUsage | null {
  const r = spawnSync("ps", ["-A", "-o", "pgid=,time=,rss="], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? parsePsGroup(r.stdout, pgid) : null;
}

let detected: UsageBackend | undefined;

export function usageBackend(): UsageBackend {
  if (detected) return detected;
  const forced = process.env.PARALLAX_SERVER_USAGE;
  if (forced === "proc" || forced === "ps" || forced === "none") return (detected = forced);
  if (platform() === "linux" && existsSync("/proc/self/stat")) return (detected = "proc");
  if (platform() !== "win32" && psWorks()) return (detected = "ps");
  return (detected = "none");
}

// ps runs and lists at least one process in the format parsePsGroup reads.
function psWorks(): boolean {
  const r = spawnSync("ps", ["-A", "-o", "pgid=,time=,rss="], { encoding: "utf8" });
  return r.status === 0 && r.stdout.split("\n").some((l) => parsePsTime(l.trim().split(/\s+/)[1] ?? "") !== null);
}

export const memoryKind = (backend: UsageBackend): "peak" | "current" | null => (backend === "proc" ? "peak" : backend === "ps" ? "current" : null);

// The usage of the group led by `pgid` (a server spawned with treeSpawnOptions on POSIX). Null when
// unknown: no backend, or the group is gone.
export function serverUsage(pgid: number | undefined): ServerUsage | null {
  if (pgid === undefined) return null;
  const b = usageBackend();
  return b === "proc" ? procUsage(pgid) : b === "ps" ? psUsage(pgid) : null;
}
