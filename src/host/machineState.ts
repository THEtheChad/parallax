// The machine's power and CPU-frequency state, recorded with every bundle and never changed: setting
// it needs root and differs per OS, but a reader comparing two bundles needs to know it. Each probe is
// optional; anything the OS will not say is null.
//
//   Linux    cpufreq governors and turbo boost (/sys/devices/system/cpu), SMT, the cores this process
//            may run on (/proc/self/status), mains power (/sys/class/power_supply)
//   macOS    power source and Low Power Mode (pmset)
//   Windows  the active power plan (powercfg)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cpus, platform } from "node:os";
import { join } from "node:path";

export interface MachineState {
  // Distinct cpufreq governors across cores ("performance", "powersave", "schedutil", ...).
  governors: string[] | null;
  // Turbo / boost enabled.
  boost: boolean | null;
  // Simultaneous multithreading: "on", "off", "forceoff", "notsupported", ...
  smt: string | null;
  // Cores this process may run on, as the kernel lists them ("0-31"), and how many.
  affinity: { list: string; cores: number } | null;
  power: "ac" | "battery" | null;
  lowPowerMode: boolean | null;
  // Windows power plan name ("Balanced", "High performance", ...).
  powerPlan: string | null;
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};

const run = (cmd: string, args: string[]): string | null => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return null;
  }
};

// "0-3,8,10-11" -> 7
export function countCpuList(list: string): number {
  let n = 0;
  for (const part of list.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (m) n += m[2] === undefined ? 1 : Number(m[2]) - Number(m[1]) + 1;
  }
  return n;
}

function linuxState(): MachineState {
  const cpuDir = "/sys/devices/system/cpu";
  let governors: string[] | null = null;
  try {
    const found = new Set<string>();
    for (const d of readdirSync(cpuDir)) {
      if (!/^cpu\d+$/.test(d)) continue;
      const g = read(join(cpuDir, d, "cpufreq/scaling_governor"));
      if (g) found.add(g);
    }
    governors = found.size ? [...found].sort() : null;
  } catch {
    governors = null;
  }
  const boostFile = read(join(cpuDir, "cpufreq/boost"));
  const noTurbo = read(join(cpuDir, "intel_pstate/no_turbo"));
  const boost = boostFile !== null ? boostFile === "1" : noTurbo !== null ? noTurbo === "0" : null;
  const allowed = /^Cpus_allowed_list:\s*(\S+)/m.exec(read("/proc/self/status") ?? "")?.[1];
  let power: MachineState["power"] = null;
  try {
    const dir = "/sys/class/power_supply";
    if (existsSync(dir)) {
      const supplies = readdirSync(dir).map((d) => ({ type: read(join(dir, d, "type")), online: read(join(dir, d, "online")) }));
      const mains = supplies.filter((s) => s.type === "Mains");
      // A desktop has no Mains entry at all: left unknown rather than guessed.
      if (mains.length) power = mains.some((s) => s.online === "1") ? "ac" : "battery";
    }
  } catch {
    power = null;
  }
  return {
    governors,
    boost,
    smt: read(join(cpuDir, "smt/control")),
    affinity: allowed ? { list: allowed, cores: countCpuList(allowed) } : null,
    power,
    lowPowerMode: null,
    powerPlan: null,
  };
}

export function parsePmsetBatt(text: string): MachineState["power"] {
  if (/'AC Power'/.test(text)) return "ac";
  if (/'Battery Power'/.test(text)) return "battery";
  return null;
}

export function parsePmsetLowPower(text: string): boolean | null {
  const m = /^\s*(?:lowpowermode|powermode)\s+(\d+)/m.exec(text);
  return m ? m[1] !== "0" : null;
}

export function parsePowercfgScheme(text: string): string | null {
  return /\(([^)]+)\)\s*$/m.exec(text.trim())?.[1] ?? null;
}

const empty: MachineState = { governors: null, boost: null, smt: null, affinity: null, power: null, lowPowerMode: null, powerPlan: null };

export function machineState(): MachineState {
  try {
    switch (platform()) {
      case "linux":
        return linuxState();
      case "darwin": {
        const batt = run("pmset", ["-g", "batt"]);
        const settings = run("pmset", ["-g"]);
        return { ...empty, power: batt === null ? null : parsePmsetBatt(batt), lowPowerMode: settings === null ? null : parsePmsetLowPower(settings) };
      }
      case "win32": {
        const scheme = run("powercfg", ["/getactivescheme"]);
        return { ...empty, powerPlan: scheme === null ? null : parsePowercfgScheme(scheme) };
      }
      default:
        return empty;
    }
  } catch {
    return empty;
  }
}

// Things in the state that slow a run down or make it uneven; each goes into the bundle's notes.
export function machineStateNotes(s: MachineState, machineCores = cpus().length): string[] {
  const notes: string[] = [];
  if (s.power === "battery") notes.push("running on battery: the OS may slow the CPU to save power");
  if (s.lowPowerMode) notes.push("Low Power Mode is on: the CPU runs slower than it can");
  if (s.affinity && s.affinity.cores < machineCores)
    notes.push(`the harness may run on only ${s.affinity.cores} of ${machineCores} cores (${s.affinity.list}), and so may the measured commands`);
  if (s.powerPlan && /saver/i.test(s.powerPlan)) notes.push(`the power plan is "${s.powerPlan}": the CPU may run slower than it can`);
  return notes;
}
