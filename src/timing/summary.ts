// Judging rounds and summarizing a bench: pure functions of the records in samples.jsonl, so
// `bench-summary` can recompute everything from a bundle.
//
// A round runs every side once, back to back, between two canaries. Candidates are compared with the
// reference by the ratio of their times within the same round, so load that is steady over a round
// cancels out. A round is rejected when the machine was busy before it, when other programs used more
// than the allowed cores during it, or when the canary ran slower than the fastest canary of the whole
// bench (the machine's speed changed). Rejected rounds stay in the bundle but never enter a statistic.

import type { CpuWindow, IdleWait } from "../host/machine.ts";
import type { Counters } from "../host/counters.ts";
import type { ThreadMode } from "../profile/profile.ts";
import { callOf, DEFAULT_RESOLUTION, DEFAULT_RESOLUTION_MS, lookConfidence, median, medianInterval, sameWithin, SETTLED, type Call, type Interval, type LookPlan } from "./stats.ts";

export interface SampleRecord {
  type: "sample";
  side: string;
  role: "ref" | "cand";
  round: number;
  attempt: number;
  warmup: boolean;
  startedAt: string;
  wallMs: number;
  drainMs: number;
  exit: { code: number | null; signal: string | null };
  timedOut: boolean;
  crashSignals: string[];
  stdoutSha256: string;
  stderrSha256: string;
  outputLines: number;
  cpuMs: number | null;
  userMs: number | null;
  sysMs: number | null;
  // Linux: CPU of processes nobody in the group waited for (included in cpuMs), and how many.
  adoptedCpuMs: number | null;
  adopted: number | null;
  maxRssBytes: number | null;
  window: CpuWindow;
  outsideCores: number | null;
}

export interface RoundRecord {
  type: "round";
  round: number;
  attempt: number;
  order: string[];
  idle: IdleWait;
  canaryBeforeMs: number;
  canaryAfterMs: number;
  window: CpuWindow;
  outsideCores: number | null;
  // Reasons seen while running (retry decisions used the fastest canary so far).
  rejected: string[];
}

// One run under the counter backend (host/counters.ts), after the timed rounds: never timed, so its
// overhead cannot touch a wall time.
export interface CounterRecord {
  type: "counters";
  side: string;
  run: number;
  exit: { code: number | null; signal: string | null };
  timedOut: boolean;
  counters: Counters | null;
}

// A counter over a side's counted runs: the median, and the spread (max - min) / median, which says how
// deterministic the figure is for this implementation and mode.
export interface CounterFigure {
  median: number;
  spread: number;
}

export interface CounterSummary {
  label: string;
  runs: number;
  instructions: CounterFigure | null;
  cycles: CounterFigure | null;
  // Instructions per cycle (medians).
  ipc: number | null;
  taskClockMs: CounterFigure | null;
  pageFaults: CounterFigure | null;
}

// null (or Infinity, which JSON stores as null) turns a gate off.
export interface Gates {
  maxOutsideCores: number | null;
  // Allowed slowdown of a round's canary over the fastest canary seen, as a fraction (0.1 = 10%).
  maxCanaryDrift: number | null;
}

export const DEFAULT_GATES: Gates = { maxOutsideCores: 1, maxCanaryDrift: 0.1 };

export function judgeRound(r: Pick<RoundRecord, "idle" | "outsideCores" | "canaryBeforeMs" | "canaryAfterMs">, baselineMs: number, gates: Gates): string[] {
  const reasons: string[] = [];
  if (r.idle.timedOut) reasons.push("machine busy before the round");
  const maxOutside = gates.maxOutsideCores ?? Infinity;
  const maxDrift = gates.maxCanaryDrift ?? Infinity;
  if (r.outsideCores !== null && r.outsideCores > maxOutside) reasons.push("other programs used CPU during the round");
  if (Math.max(r.canaryBeforeMs, r.canaryAfterMs) > baselineMs * (1 + maxDrift)) reasons.push("canary slower than the fastest canary");
  return reasons;
}

const failed = (s: SampleRecord): boolean => s.timedOut || s.exit.signal !== null || s.crashSignals.length > 0;

export type CandidateState = "measured" | "noisy" | "failed";

export interface SideSummary {
  label: string;
  role: "ref" | "cand";
  mode: ThreadMode;
  samples: number;
  wallMs: Interval | null;
  cpuMs: Interval | null;
  maxRssBytes: number | null;
  failures: number;
  // Distinct exit codes and outputs over every run of this side, warm-ups included.
  exitCodes: (number | null)[];
  outputs: number;
  outputStable: boolean;
  outputMatchesRef: boolean | null;
}

export interface CandidateSummary {
  label: string;
  // The reference it is compared with: the one running in the same thread mode.
  ref: string;
  mode: ThreadMode;
  state: CandidateState;
  // Candidate / reference within each accepted round.
  wallRatio: Interval | null;
  cpuRatio: Interval | null;
  call: Call | null;
  // Half-width of "same" for this comparison (the resolution, or the floor over the reference's time).
  sameWithin: number;
}

export interface BenchSummary {
  schema: "parallax.bench-summary/1";
  canaryBaselineMs: number | null;
  rounds: { planned: number; max: number; attempts: number; accepted: number; rejected: number; failed: number };
  minRounds: number;
  // The confidence calls needed at this many accepted rounds (stats.ts lookConfidence).
  confidence: number;
  resolution: Resolution;
  gates: Gates;
  rejections: Record<string, number>;
  accounting: string;
  sides: SideSummary[];
  candidates: CandidateSummary[];
  // Per implementation run in both modes: single-threaded wall time / default wall time, paired within
  // each round (2x: the default mode's parallelism halves the time).
  speedups: { base: string; ratio: Interval | null }[];
  // Every comparison has a call more rounds would not change (or failed): a sequential bench stops.
  settled: boolean;
  // Counted runs per side, where a counter backend worked (absent in older summaries).
  counters?: { backend: string; sides: CounterSummary[] } | null;
  clean: boolean;
}

// What counts as "same": within `relative` of the reference, or within `floorMs` where that is larger.
export interface Resolution {
  relative: number;
  floorMs: number;
}

export const DEFAULT_RESOLUTION_SETTING: Resolution = { relative: DEFAULT_RESOLUTION, floorMs: DEFAULT_RESOLUTION_MS };

// The look plan of a bench: bundles from before sequential rounds ran a fixed number of rounds.
export const planOf = (runs: number, maxRuns: number | undefined): LookPlan => ({ runs, maxRuns: Math.max(runs, maxRuns ?? runs) });

export interface SideInfo {
  label: string;
  role: "ref" | "cand";
  // Absent in bundles from before thread modes: "default", and the label is the base.
  mode?: ThreadMode;
  base?: string;
}

export const modeOf = (s: SideInfo): ThreadMode => s.mode ?? "default";
const baseOf = (s: SideInfo): string => s.base ?? s.label;

// The reference a side is compared with: the reference running in the same thread mode (or the only
// reference there is).
export function refFor(sides: SideInfo[], side: Pick<SideInfo, "mode">): SideInfo {
  const refs = sides.filter((s) => s.role === "ref");
  return refs.find((r) => modeOf(r) === (side.mode ?? "default")) ?? refs[0]!;
}

// Each implementation that ran in both modes, as [default label, single label].
export function modePairs(sides: SideInfo[]): { base: string; multi: string; single: string }[] {
  const out: { base: string; multi: string; single: string }[] = [];
  for (const s of sides.filter((x) => modeOf(x) === "default")) {
    const single = sides.find((x) => modeOf(x) === "single" && baseOf(x) === baseOf(s));
    if (single) out.push({ base: baseOf(s), multi: s.label, single: single.label });
  }
  return out;
}

export interface SummarizeInput {
  records: (SampleRecord | RoundRecord | CounterRecord)[];
  sides: SideInfo[];
  plannedRounds: number;
  // Absent: a fixed number of rounds (plannedRounds).
  maxRounds?: number;
  minRounds: number;
  resolution?: Resolution;
  gates: Gates;
  accounting: string;
  // The counter backend the bench used ("none": no counted runs).
  counters?: string;
}

const figure = (xs: number[]): CounterFigure | null => {
  if (!xs.length) return null;
  const m = median(xs);
  return { median: m, spread: m > 0 ? (Math.max(...xs) - Math.min(...xs)) / m : 0 };
};

export function summarizeCounters(records: CounterRecord[], labels: string[]): CounterSummary[] {
  return labels.map((label) => {
    const runs = records.filter((r) => r.side === label && r.counters && !r.timedOut && r.exit.signal === null).map((r) => r.counters!);
    const pick = (k: keyof Counters): number[] => runs.map((c) => c[k]).filter((x): x is number => x !== null);
    const instructions = figure(pick("instructions"));
    const cycles = figure(pick("cycles"));
    return {
      label,
      runs: runs.length,
      instructions,
      cycles,
      ipc: instructions && cycles && cycles.median > 0 ? instructions.median / cycles.median : null,
      taskClockMs: figure(pick("taskClockMs")),
      pageFaults: figure(pick("pageFaults")),
    };
  });
}

export interface AcceptedRounds<T> {
  // The fastest canary of the bench: the baseline every round is judged against.
  baseline: number | null;
  // One entry per accepted round: its measured samples, one per side.
  accepted: T[][];
  attempts: number;
  failed: number;
  rejected: number;
  rejections: Record<string, number>;
}

// Sorts rounds into accepted, rejected (disturbed) and failed (a side failed, or a sample is missing),
// judging each against the fastest canary of the whole bench. Warm-up samples are left out by the caller.
export function acceptRounds<T extends { round: number; attempt: number }>(
  rounds: RoundRecord[],
  samples: T[],
  sides: number,
  failed: (s: T) => boolean,
  gates: Gates,
): AcceptedRounds<T> {
  const canaries = rounds.flatMap((r) => [r.canaryBeforeMs, r.canaryAfterMs]);
  const baseline = canaries.length ? Math.min(...canaries) : null;
  const key = (round: number, attempt: number): string => `${round}.${attempt}`;
  const byRound = new Map<string, T[]>();
  for (const s of samples) byRound.set(key(s.round, s.attempt), [...(byRound.get(key(s.round, s.attempt)) ?? []), s]);
  const rejections: Record<string, number> = {};
  const accepted: T[][] = [];
  let failedRounds = 0;
  for (const r of rounds) {
    const ss = byRound.get(key(r.round, r.attempt)) ?? [];
    if (ss.some(failed) || ss.length < sides) {
      failedRounds++;
      continue;
    }
    const reasons = judgeRound(r, baseline ?? r.canaryBeforeMs, gates);
    for (const why of reasons) rejections[why] = (rejections[why] ?? 0) + 1;
    if (!reasons.length) accepted.push(ss);
  }
  return { baseline, accepted, attempts: rounds.length, failed: failedRounds, rejected: rounds.length - accepted.length - failedRounds, rejections };
}

export function summarizeBench(input: SummarizeInput): BenchSummary {
  const rounds = input.records.filter((r): r is RoundRecord => r.type === "round");
  const samples = input.records.filter((r): r is SampleRecord => r.type === "sample");
  const { baseline, accepted, ...counts } = acceptRounds(rounds, samples.filter((s) => !s.warmup), input.sides.length, failed, input.gates);
  const plan = planOf(input.plannedRounds, input.maxRounds);
  const confidence = lookConfidence(accepted.length, plan);
  const resolution = input.resolution ?? DEFAULT_RESOLUTION_SETTING;
  const interval = (xs: number[]): Interval | null => medianInterval(xs, confidence);
  // Every side's output is compared with the default-mode reference's: a single-threaded run must
  // give the same output too.
  const canonical = refFor(input.sides, { mode: "default" });
  const refOutputs = new Set(samples.filter((s) => s.side === canonical.label).map((s) => `${s.exit.code}:${s.stdoutSha256}`));

  const sides: SideSummary[] = input.sides.map((info) => {
    const { label, role } = info;
    const all = samples.filter((s) => s.side === label);
    const mine = accepted.map((ss) => ss.find((s) => s.side === label)!);
    const cpu = mine.map((s) => s.cpuMs).filter((x): x is number => x !== null);
    const rss = mine.map((s) => s.maxRssBytes).filter((x): x is number => x !== null);
    const outputs = new Set(all.map((s) => `${s.exit.code}:${s.stdoutSha256}`));
    return {
      label,
      role,
      mode: modeOf(info),
      samples: mine.length,
      wallMs: interval(mine.map((s) => s.wallMs)),
      cpuMs: cpu.length === mine.length ? interval(cpu) : null,
      maxRssBytes: rss.length ? median(rss) : null,
      failures: all.filter(failed).length,
      exitCodes: [...new Set(all.map((s) => s.exit.code))],
      outputs: outputs.size,
      outputStable: outputs.size <= 1,
      outputMatchesRef: label === canonical.label ? null : outputs.size === 1 && refOutputs.size === 1 ? [...outputs][0] === [...refOutputs][0] : false,
    };
  });

  const candidates: CandidateSummary[] = input.sides
    .filter((s) => s.role === "cand")
    .map((info) => {
      const { label } = info;
      const ref = refFor(input.sides, info);
      const pairs = accepted.map((ss) => ({ ref: ss.find((s) => s.side === ref.label)!, cand: ss.find((s) => s.side === label)! }));
      const wallRatio = interval(pairs.map((p) => p.cand.wallMs / p.ref.wallMs));
      const cpuPairs = pairs.filter((p) => p.ref.cpuMs && p.cand.cpuMs !== null);
      const cpuRatio = cpuPairs.length === pairs.length ? interval(cpuPairs.map((p) => p.cand.cpuMs! / p.ref.cpuMs!)) : null;
      const anyFailed = samples.some((s) => (s.side === label || s.side === ref.label) && failed(s));
      const state: CandidateState = anyFailed ? "failed" : pairs.length < input.minRounds ? "noisy" : "measured";
      const refWall = pairs.length ? median(pairs.map((p) => p.ref.wallMs)) : null;
      const same = sameWithin(resolution.relative, resolution.floorMs, refWall);
      const call = state === "measured" && wallRatio ? callOf(wallRatio, { confidence, same }) : null;
      return { label, ref: ref.label, mode: modeOf(info), state, wallRatio, cpuRatio, call, sameWithin: same };
    });

  const speedups = modePairs(input.sides).map(({ base, multi, single }) => ({
    base,
    ratio: interval(accepted.map((ss) => ss.find((s) => s.side === single)!.wallMs / ss.find((s) => s.side === multi)!.wallMs)),
  }));

  return {
    schema: "parallax.bench-summary/1",
    canaryBaselineMs: baseline,
    rounds: { planned: plan.runs, max: plan.maxRuns, attempts: counts.attempts, accepted: accepted.length, rejected: counts.rejected, failed: counts.failed },
    minRounds: input.minRounds,
    confidence,
    resolution,
    gates: input.gates,
    rejections: counts.rejections,
    accounting: input.accounting,
    sides,
    candidates,
    speedups,
    settled: candidates.every((c) => c.state === "failed" || (c.call !== null && SETTLED.includes(c.call))),
    counters:
      input.counters && input.counters !== "none"
        ? {
            backend: input.counters,
            sides: summarizeCounters(
              input.records.filter((r): r is CounterRecord => r.type === "counters"),
              input.sides.map((x) => x.label),
            ),
          }
        : null,
    clean: candidates.every((c) => c.state === "measured") && sides.every((s) => s.outputStable),
  };
}
