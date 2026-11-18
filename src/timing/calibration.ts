// A/A calibration: what this machine's noise looks like when nothing differs. `parallax calibrate`
// benches one binary against itself (the same profile, binary and thread modes under two labels), so
// any difference it finds is noise. From its accepted rounds it keeps, per metric and thread mode, the
// per-round A/A ratios, and from them:
//
//   floor       the half-width a bench's ratio interval will have when nothing differs, at that
//               bench's round count and the confidence its calls need: the 90th percentile over
//               resamples of that many A/A ratios of max(1 - low, high - 1). One A/A interval is a
//               single draw of a random width; the percentile says how wide it gets nine times in
//               ten. Reported at a default bench's first look (6 rounds, 95%), and recomputed for
//               each later bench at its own first look.
//   suggested   the floor rounded up to the next half percent (at least 1%)
//   falseCalls  A/A comparisons called faster or slower. Some are expected: each comparison may make
//               a false call with probability up to 1 - its coverage, the budget the calls are
//               designed with. The calibration says the machine lets noise through only when there
//               are more than chance explains (above the 95th percentile of that binomial).
//
// Instruction counts (where counters work) get a floor too, from the counted runs: the relative
// difference of the two sides' medians, or half of either side's spread if larger.
//
// The latest calibration of each kind is kept in the config directory with the host's description;
// later benches on a matching host record it and warn when their resolution (widened by the
// millisecond floor, as their calls are) is below a floor.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic, type HostInfo } from "../bundle/bundle.ts";
import { configDir } from "../host/config.ts";
import { expandCpuList } from "../host/pinning.ts";
import type { ThreadMode } from "../profile/profile.ts";
import { lookConfidence, medianInterval, quantile, sameWithin, seededRandom, type Call } from "./stats.ts";
import { planOf } from "./summary.ts";

export const CALIBRATION_SCHEMA = "parallax.calibration/2";

export type CalibrationKind = "cli-bench" | "lsp-bench";

// The look plan floors are reported at: a default bench's first look.
export const DEFAULT_PLAN = { runs: 6, maxRuns: 15 };

export interface MetricFloor {
  metric: string;
  mode: ThreadMode;
  // Candidate / reference per accepted A/A round (empty for instructions, which come from counted runs).
  ratios: number[];
  // The reference's median, for metrics in ms (where a bench's "same" widens to its ms floor).
  refMedianMs: number | null;
  // At DEFAULT_PLAN's first look (instructions: from the counted runs).
  floor: number;
  suggested: number;
  // The A/A call, and its interval's real coverage.
  call: Call | null;
  coverage: number | null;
}

// What must match for one machine's calibration to speak for a later bench.
export interface HostKey {
  platform: string;
  arch: string;
  kernel: string;
  cpuModel: string;
  cpus: number;
  // Cores the commands were pinned to, normalized ("2,3,4,5"); null: not pinned.
  pin: string | null;
  // Cores the harness itself may run on (a taskset or cgroup around it), normalized; null: unknown.
  affinity: string | null;
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
  // A/A comparisons called faster or slower ("metric@mode"); how many chance explains (95th
  // percentile); and whether there were more.
  falseCalls: string[];
  falseCallsExpected: number;
  excessFalseCalls: boolean;
}

const normalizePin = (pin: string | null): string | null => (pin === null ? null : expandCpuList(pin).join(","));

export const hostKey = (h: Pick<HostInfo, "platform" | "arch" | "kernel" | "cpuModel" | "cpus"> & { state?: HostInfo["state"] }, pin: string | null): HostKey => ({
  platform: h.platform,
  arch: h.arch,
  kernel: h.kernel,
  cpuModel: h.cpuModel,
  cpus: h.cpus,
  pin: normalizePin(pin),
  affinity: normalizePin(h.state?.affinity?.list ?? null),
});

export const sameHost = (a: HostKey, b: HostKey): boolean =>
  a.platform === b.platform && a.arch === b.arch && a.kernel === b.kernel && a.cpuModel === b.cpuModel && a.cpus === b.cpus && a.pin === b.pin && a.affinity === b.affinity;

export const suggestResolution = (floor: number): number => Math.max(0.01, Math.ceil(floor * 200 - 1e-9) / 200);

const RESAMPLES = 400;

// The 90th percentile of the ratio interval's half-width over resamples of n A/A ratios, at the
// confidence a call needs: how wide "nothing differs" gets at n rounds. Deterministic (seeded).
export function expectedHalfWidth(ratios: readonly number[], n: number, confidence: number): number | null {
  if (!ratios.length || n < 1) return null;
  const rand = seededRandom(0x5eed + n);
  const widths: number[] = [];
  for (let b = 0; b < RESAMPLES; b++) {
    const sample = Array.from({ length: n }, () => ratios[Math.floor(rand() * ratios.length)]!);
    const iv = medianInterval(sample, confidence)!;
    widths.push(Math.max(1 - iv.low, iv.high - 1, 0));
  }
  return quantile(widths, 0.9);
}

// The smallest x with P(Binomial(m, p) <= x) >= q.
export function binomialQuantile(m: number, p: number, q: number): number {
  let term = Math.pow(1 - p, m);
  let sum = term;
  let x = 0;
  while (sum < q && x < m) {
    term = (term * (m - x) * p) / ((x + 1) * (1 - p));
    sum += term;
    x++;
  }
  return x;
}

// One comparison of an A/A bench: the twin's label, its reference's, the mode, and per accepted round
// the pair of values for each metric.
export interface AaComparison {
  mode: ThreadMode;
  metrics: { metric: string; ms: boolean; pairs: [ref: number | null, cand: number | null][]; call: Call | null; coverage: number | null }[];
}

export function floorsOf(comparisons: AaComparison[], instructions: { mode: ThreadMode; floor: number }[] = []): Pick<Calibration, "floors" | "falseCalls" | "falseCallsExpected" | "excessFalseCalls"> {
  const confidence = lookConfidence(DEFAULT_PLAN.runs, planOf(DEFAULT_PLAN.runs, DEFAULT_PLAN.maxRuns));
  const floors: MetricFloor[] = [];
  for (const c of comparisons)
    for (const m of c.metrics) {
      const ok = m.pairs.length > 0 && m.pairs.every(([r, x]) => r !== null && r > 0 && x !== null);
      if (!ok) continue;
      const ratios = m.pairs.map(([r, x]) => x! / r!);
      const floor = expectedHalfWidth(ratios, DEFAULT_PLAN.runs, confidence)!;
      const refs = m.pairs.map(([r]) => r!).sort((a, b) => a - b);
      floors.push({
        metric: m.metric,
        mode: c.mode,
        ratios,
        refMedianMs: m.ms ? quantile(refs, 0.5) : null,
        floor,
        suggested: suggestResolution(floor),
        call: m.call,
        coverage: m.coverage,
      });
    }
  for (const i of instructions)
    floors.push({ metric: "instructions", mode: i.mode, ratios: [], refMedianMs: null, floor: i.floor, suggested: suggestResolution(i.floor), call: null, coverage: null });
  const called = floors.filter((f) => f.call !== null && f.coverage !== null);
  const falseCalls = called.filter((f) => f.call === "faster" || f.call === "slower").map((f) => `${f.metric}@${f.mode}`);
  const p = called.length ? called.reduce((t, f) => t + (1 - f.coverage!), 0) / called.length : 0;
  const falseCallsExpected = called.length ? binomialQuantile(called.length, Math.min(Math.max(p, 1e-9), 1 - 1e-9), 0.95) : 0;
  return { floors, falseCalls, falseCallsExpected, excessFalseCalls: falseCalls.length > falseCallsExpected };
}

const storeFile = (kind: CalibrationKind): string => join(configDir(), "calibration", `${kind}.json`);

export function saveCalibration(c: Calibration): string {
  const file = storeFile(c.kind);
  mkdirSync(join(configDir(), "calibration"), { recursive: true });
  writeJsonAtomic(file, c);
  return file;
}

// The stored calibration of a kind, or null (none, unreadable, or an older schema).
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

// What a bench records about the calibration it found: when and what, and each floor recomputed at
// the bench's own first look against the "same" its calls would use.
export interface CalibrationRef {
  createdAt: string;
  project: string;
  side: string;
  rounds: number;
  confidence: number;
  floors: { metric: string; mode: ThreadMode; floor: number; same: number }[];
  excessFalseCalls: boolean;
}

export interface CalibrationCheck {
  ref: CalibrationRef | null;
  notes: string[];
}

const pct = (x: number): string => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

export interface BenchPlan {
  resolution: number;
  resolutionMs: number;
  runs: number;
  maxRuns: number;
  modes: readonly ThreadMode[];
  // Metrics to check (all when absent).
  metrics?: readonly string[];
}

// Compares a bench's plan with the stored calibration for this host.
export function checkCalibration(c: Calibration | null, here: HostKey, bench: BenchPlan): CalibrationCheck {
  if (!c) return { ref: null, notes: ["this machine has no noise calibration: `parallax calibrate` measures the smallest difference it can resolve"] };
  if (!sameHost(c.host, here)) return { ref: null, notes: ["the stored noise calibration is from another host setup (CPU, kernel, pinning or the cores available): run `parallax calibrate` again"] };
  const confidence = lookConfidence(bench.runs, planOf(bench.runs, bench.maxRuns));
  const floors: CalibrationRef["floors"] = [];
  for (const f of c.floors) {
    if (!bench.modes.includes(f.mode) || (bench.metrics && !bench.metrics.includes(f.metric)) || !f.ratios.length) continue;
    const floor = expectedHalfWidth(f.ratios, bench.runs, confidence)!;
    const same = sameWithin(bench.resolution, f.refMedianMs !== null ? bench.resolutionMs : 0, f.refMedianMs);
    floors.push({ metric: f.metric, mode: f.mode, floor, same });
  }
  const ref: CalibrationRef = { createdAt: c.createdAt, project: c.project.name, side: c.side.profile, rounds: bench.runs, confidence, floors, excessFalseCalls: c.excessFalseCalls };
  const notes: string[] = [];
  const when = c.createdAt.slice(0, 10);
  if (c.excessFalseCalls)
    notes.push(
      `the noise calibration of ${when} called a binary different from itself more often than chance explains (${c.falseCalls.length} calls, ${c.falseCallsExpected} expected at most: ${c.falseCalls.join(", ")}): this machine lets noise through as differences`,
    );
  const below = floors.filter((f) => f.floor > f.same);
  if (below.length) {
    const worst = below.reduce((a, b) => (b.floor > a.floor ? b : a));
    const list = below.map((f) => `${f.metric}@${f.mode} ${pct(f.floor)}`).slice(0, 6).join(", ");
    notes.push(
      `at ${bench.runs} rounds this machine's A/A noise reaches ${list}${below.length > 6 ? ", ..." : ""} (nine times in ten; calibrated ${when} on ${c.project.name}), more than "same" allows at resolution ${pct(bench.resolution)}: those metrics may not settle; --resolution ${suggestResolution(worst.floor)} or more rounds would help`,
    );
  }
  return { ref, notes };
}
