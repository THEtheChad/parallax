// A/A calibration: what this machine's noise looks like when nothing differs. `parallax calibrate`
// benches one binary against itself (the same profile, binary and thread modes under two labels), so
// any difference it finds is noise. From that bench:
//
//   floor       per metric, the half-width of the A/A ratio interval: max(1 - low, high - 1). A
//               comparison at the same number of rounds cannot tell differences smaller than this from
//               noise, so a resolution below it asks for "same" calls this machine cannot give.
//   suggested   the floor rounded up to the next half percent (at least 1%): a resolution that can work
//   falseCalls  A/A comparisons called faster or slower: the machine (or the gates) let noise through
//               as a difference, which no resolution fixes
//
// Instruction counts (where counters work) get a floor too: the relative difference of the two
// sides' medians, or half of either side's spread if larger.
//
// The latest calibration of each kind is kept in the config directory with the host's description;
// later benches on a matching host record it and warn when their resolution is below a floor.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic, type HostInfo } from "../bundle/bundle.ts";
import { configDir } from "../host/config.ts";
import type { ThreadMode } from "../profile/profile.ts";
import { METRICS } from "./lspSummary.ts";
import type { LspBenchSummary } from "./lspSummary.ts";
import type { Call, Interval } from "./stats.ts";
import type { BenchSummary } from "./summary.ts";

export const CALIBRATION_SCHEMA = "parallax.calibration/1";

export type CalibrationKind = "cli-bench" | "lsp-bench";

export interface MetricFloor {
  metric: string;
  mode: ThreadMode;
  floor: number;
  suggested: number;
  call: Call | null;
  rounds: number;
  confidence: number;
}

// What must match for one machine's calibration to speak for a later bench.
export interface HostKey {
  platform: string;
  arch: string;
  kernel: string;
  cpuModel: string;
  cpus: number;
  // Cores the commands were pinned to (null: not pinned).
  pin: string | null;
}

export interface Calibration {
  schema: typeof CALIBRATION_SCHEMA;
  kind: CalibrationKind;
  createdAt: string;
  host: HostKey;
  // What was measured (no paths): the side's profile, binary hash and version, the project's name and commit.
  side: { profile: string; binSha256: string; version: string | null };
  project: { name: string; commit: string | null };
  rounds: { planned: number; accepted: number; rejected: number };
  floors: MetricFloor[];
  // A/A comparisons that came out faster or slower: "metric@mode".
  falseCalls: string[];
}

export const hostKey = (h: Pick<HostInfo, "platform" | "arch" | "kernel" | "cpuModel" | "cpus">, pin: string | null): HostKey => ({
  platform: h.platform,
  arch: h.arch,
  kernel: h.kernel,
  cpuModel: h.cpuModel,
  cpus: h.cpus,
  pin,
});

export const sameHost = (a: HostKey, b: HostKey): boolean =>
  a.platform === b.platform && a.arch === b.arch && a.kernel === b.kernel && a.cpuModel === b.cpuModel && a.cpus === b.cpus && a.pin === b.pin;

const halfWidth = (r: Interval): number => Math.max(1 - r.low, r.high - 1, 0);
export const suggestResolution = (floor: number): number => Math.max(0.01, Math.ceil(floor * 200 - 1e-9) / 200);

const floorOf = (metric: string, mode: ThreadMode, ratio: Interval | null, call: Call | null): MetricFloor | null =>
  ratio ? { metric, mode, floor: halfWidth(ratio), suggested: suggestResolution(halfWidth(ratio)), call, rounds: ratio.n, confidence: ratio.confidence } : null;

const falseCall = (f: MetricFloor): boolean => f.call === "faster" || f.call === "slower";

export function benchFloors(s: BenchSummary): { floors: MetricFloor[]; falseCalls: string[] } {
  const floors: MetricFloor[] = [];
  for (const c of s.candidates) {
    const wall = floorOf("wallMs", c.mode, c.wallRatio, c.call);
    if (wall) floors.push(wall);
    // CPU has no call of its own; its floor still says how far CPU figures can be trusted.
    const cpu = floorOf("cpuMs", c.mode, c.cpuRatio, null);
    if (cpu) floors.push(cpu);
    const counted = s.counters?.sides ?? [];
    const a = counted.find((x) => x.label === c.ref)?.instructions;
    const b = counted.find((x) => x.label === c.label)?.instructions;
    if (a && b && a.median > 0) {
      const floor = Math.max(Math.abs(b.median / a.median - 1), a.spread / 2, b.spread / 2);
      floors.push({ metric: "instructions", mode: c.mode, floor, suggested: suggestResolution(floor), call: null, rounds: 0, confidence: 0 });
    }
  }
  return { floors, falseCalls: floors.filter(falseCall).map((f) => `${f.metric}@${f.mode}`) };
}

export function lspFloors(s: LspBenchSummary): { floors: MetricFloor[]; falseCalls: string[] } {
  const floors: MetricFloor[] = [];
  for (const c of s.candidates)
    for (const { key } of METRICS) {
      const m = c.metrics[key];
      const f = m ? floorOf(key, c.mode, m.ratio, m.call) : null;
      if (f) floors.push(f);
    }
  return { floors, falseCalls: floors.filter(falseCall).map((f) => `${f.metric}@${f.mode}`) };
}

const storeFile = (kind: CalibrationKind): string => join(configDir(), "calibration", `${kind}.json`);

export function saveCalibration(c: Calibration): string {
  const file = storeFile(c.kind);
  mkdirSync(join(configDir(), "calibration"), { recursive: true });
  writeJsonAtomic(file, c);
  return file;
}

export function loadCalibration(kind: CalibrationKind): Calibration | null {
  const file = storeFile(kind);
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as Calibration;
    return c.schema === CALIBRATION_SCHEMA && c.kind === kind ? c : null;
  } catch {
    return null;
  }
}

// What a bench records about the calibration it found: when and what, and the floors it compared
// its resolution with.
export interface CalibrationRef {
  createdAt: string;
  project: string;
  side: string;
  floors: MetricFloor[];
  falseCalls: string[];
}

export interface CalibrationCheck {
  ref: CalibrationRef | null;
  notes: string[];
}

const pct = (x: number): string => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

// Compares a bench's settings with the stored calibration for this host. Metrics named in `metrics`
// are checked (all when absent); modes limit the floors to the thread modes the bench runs.
export function checkCalibration(
  c: Calibration | null,
  here: HostKey,
  bench: { resolution: number; runs: number; modes: readonly ThreadMode[]; metrics?: readonly string[] },
): CalibrationCheck {
  if (!c) return { ref: null, notes: ["this machine has no noise calibration: `parallax calibrate` measures the smallest difference it can resolve"] };
  if (!sameHost(c.host, here)) return { ref: null, notes: ["the stored noise calibration is from another host setup (CPU, kernel or pinning): run `parallax calibrate` again"] };
  const floors = c.floors.filter((f) => bench.modes.includes(f.mode) && (!bench.metrics || bench.metrics.includes(f.metric)));
  // Only the false calls of metrics and modes this bench measures.
  const falseCalls = c.falseCalls.filter((fc) => {
    const at = fc.lastIndexOf("@");
    const metric = fc.slice(0, at);
    return bench.modes.includes(fc.slice(at + 1) as ThreadMode) && (!bench.metrics || bench.metrics.includes(metric));
  });
  const ref: CalibrationRef = { createdAt: c.createdAt, project: c.project.name, side: c.side.profile, floors, falseCalls };
  const notes: string[] = [];
  if (falseCalls.length)
    notes.push(`the noise calibration of ${c.createdAt.slice(0, 10)} called a binary different from itself (${falseCalls.join(", ")}): this machine lets noise through as differences`);
  const below = floors.filter((f) => f.metric !== "instructions" && f.rounds > 0 && f.floor > bench.resolution);
  if (below.length) {
    const worst = below.reduce((a, b) => (b.floor > a.floor ? b : a));
    const list = below.map((f) => `${f.metric}@${f.mode} ${pct(f.floor)}`).slice(0, 6).join(", ");
    const fewer = bench.runs < worst.rounds ? `; this bench looks first at ${bench.runs} rounds, fewer than the calibration's ${worst.rounds}, so its floor is higher still` : "";
    notes.push(
      `resolution ${pct(bench.resolution)} is below this machine's A/A noise floor (${list}${below.length > 6 ? ", ..." : ""}; calibrated ${c.createdAt.slice(0, 10)} on ${c.project.name} at ${worst.rounds} rounds): "same" may be out of reach for those; --resolution ${worst.suggested} would not be${fewer}`,
    );
  }
  return { ref, notes };
}
