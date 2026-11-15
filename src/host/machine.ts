// Machine-wide CPU use, from what Node offers on every OS: os.cpus() per-core times (Linux, macOS,
// Windows) and the harness's own CPU from process.cpuUsage(). Subtracting the harness and the measured
// command from the machine total gives the CPU other programs used while we measured, in cores.
//
// Optional extra where the OS has it: Linux's system-wide CPU pressure (/proc/pressure/cpu, kernel
// 4.20+), the time runnable tasks waited for a CPU. Load average is recorded for the record only; it
// lags by a minute, counts our own processes, and is always 0 on Windows.

import { readFileSync } from "node:fs";
import { cpus, loadavg, platform, uptime } from "node:os";

export interface CpuSnapshot {
  // performance.now() at the snapshot.
  t: number;
  // Sum over all cores, ms: busy = user + nice + sys + irq.
  busyMs: number;
  idleMs: number;
  // The harness process's own CPU (user + system), ms.
  selfMs: number;
  // /proc/pressure/cpu "some" total, µs; null where unavailable.
  pressureUs: number | null;
}

const PRESSURE = "/proc/pressure/cpu";

export function readPressureUs(): number | null {
  if (platform() !== "linux") return null;
  try {
    const m = /^some .*total=(\d+)/m.exec(readFileSync(PRESSURE, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function cpuSnapshot(): CpuSnapshot {
  let busy = 0;
  let idle = 0;
  for (const c of cpus()) {
    busy += c.times.user + c.times.nice + c.times.sys + c.times.irq;
    idle += c.times.idle;
  }
  const self = process.cpuUsage();
  return { t: performance.now(), busyMs: busy, idleMs: idle, selfMs: (self.user + self.system) / 1000, pressureUs: readPressureUs() };
}

export interface CpuWindow {
  wallMs: number;
  // CPU time used on the whole machine over the window, ms, and as average busy cores.
  machineCpuMs: number;
  machineCores: number;
  // The harness's own share.
  selfCpuMs: number;
  // Share of the window during which some runnable task waited for a CPU (0..1), where available.
  pressure: number | null;
}

export function cpuWindow(a: CpuSnapshot, b: CpuSnapshot): CpuWindow {
  const wallMs = Math.max(b.t - a.t, 1e-6);
  const machineCpuMs = Math.max(0, b.busyMs - a.busyMs);
  return {
    wallMs,
    machineCpuMs,
    machineCores: machineCpuMs / wallMs,
    selfCpuMs: Math.max(0, b.selfMs - a.selfMs),
    pressure: a.pressureUs === null || b.pressureUs === null ? null : (b.pressureUs - a.pressureUs) / 1000 / wallMs,
  };
}

// CPU other programs used over a window, in average cores: the machine total minus the harness and
// the measured commands' CPU. Null when the commands' CPU is unknown (no accounting on this OS).
// os.cpus() counts in 10 ms ticks on Linux, so windows much shorter than a second are coarse.
export function outsideCores(w: CpuWindow, commandsCpuMs: number | null): number | null {
  if (commandsCpuMs === null) return null;
  return Math.max(0, w.machineCpuMs - w.selfCpuMs - commandsCpuMs) / w.wallMs;
}

export interface HostLoad {
  loadavg: number[] | null;
  uptimeS: number;
  pressureAvailable: boolean;
}

export function hostLoad(): HostLoad {
  return { loadavg: platform() === "win32" ? null : loadavg(), uptimeS: Math.round(uptime()), pressureAvailable: readPressureUs() !== null };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Average busy cores over the next windowMs, with nothing of ours running.
export async function busyCores(windowMs = 1000): Promise<CpuWindow> {
  const a = cpuSnapshot();
  await sleep(windowMs);
  return cpuWindow(a, cpuSnapshot());
}

export interface IdleWait {
  waitedMs: number;
  // Busy cores over the last window checked.
  busyCores: number;
  pressure: number | null;
  timedOut: boolean;
  uptimeS: number;
  bootSettleWaitedMs: number;
}

export interface IdleGate {
  // Wait until other programs use at most this many cores (averaged over windowMs).
  maxBusyCores: number;
  windowMs: number;
  timeoutMs: number;
  // Wait until the machine has been up this long (first minutes after boot run slow).
  bootSettleS: number;
}

export const DEFAULT_IDLE_GATE: IdleGate = { maxBusyCores: 1.5, windowMs: 1000, timeoutMs: 300_000, bootSettleS: 300 };

export async function waitForIdle(gate: IdleGate, log?: (msg: string) => void): Promise<IdleWait> {
  const t0 = performance.now();
  let bootSettleWaitedMs = 0;
  const settle = gate.bootSettleS - uptime();
  if (settle > 0) {
    log?.(`machine up ${Math.round(uptime())} s; waiting ${Math.ceil(settle)} s to settle after boot`);
    await sleep(settle * 1000);
    bootSettleWaitedMs = performance.now() - t0;
  }
  let w = await busyCores(gate.windowMs);
  let said = false;
  while (w.machineCores - w.selfCpuMs / w.wallMs > gate.maxBusyCores && performance.now() - t0 < gate.timeoutMs) {
    if (!said) log?.(`waiting for the machine to go idle (${w.machineCores.toFixed(2)} cores busy, limit ${gate.maxBusyCores})`);
    said = true;
    w = await busyCores(gate.windowMs);
  }
  const busy = w.machineCores - w.selfCpuMs / w.wallMs;
  return {
    waitedMs: performance.now() - t0,
    busyCores: busy,
    pressure: w.pressure,
    timedOut: busy > gate.maxBusyCores,
    uptimeS: Math.round(uptime()),
    bootSettleWaitedMs,
  };
}
