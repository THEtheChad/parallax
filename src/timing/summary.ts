// Judging rounds and summarizing a bench: pure functions of the records in samples.jsonl, so
// `bench-summary` can recompute everything from a bundle.
//
// A round runs every side once, back to back, between two canaries. Candidates are compared with the
// reference by the ratio of their times within the same round, so load that is steady over a round
// cancels out. A round is rejected when the machine was busy before it, when other programs used more
// than the allowed cores during it, or when the canary ran slower than the fastest canary of the whole
// bench (the machine's speed changed). Rejected rounds stay in the bundle but never enter a statistic.

import type { CpuWindow, IdleWait } from "../host/machine.ts";
import { medianInterval, callOf, median, type Call, type Interval } from "./stats.ts";

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
  state: CandidateState;
  // Candidate / reference within each accepted round.
  wallRatio: Interval | null;
  cpuRatio: Interval | null;
  call: Call | null;
}

export interface BenchSummary {
  schema: "parallax.bench-summary/1";
  canaryBaselineMs: number | null;
  rounds: { planned: number; attempts: number; accepted: number; rejected: number; failed: number };
  minRounds: number;
  gates: Gates;
  rejections: Record<string, number>;
  accounting: string;
  sides: SideSummary[];
  candidates: CandidateSummary[];
  clean: boolean;
}

export interface SummarizeInput {
  records: (SampleRecord | RoundRecord)[];
  sides: { label: string; role: "ref" | "cand" }[];
  plannedRounds: number;
  minRounds: number;
  gates: Gates;
  accounting: string;
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
  const ref = input.sides.find((s) => s.role === "ref")!;
  const refOutputs = new Set(samples.filter((s) => s.side === ref.label).map((s) => `${s.exit.code}:${s.stdoutSha256}`));

  const sides: SideSummary[] = input.sides.map(({ label, role }) => {
    const all = samples.filter((s) => s.side === label);
    const mine = accepted.map((ss) => ss.find((s) => s.side === label)!);
    const cpu = mine.map((s) => s.cpuMs).filter((x): x is number => x !== null);
    const rss = mine.map((s) => s.maxRssBytes).filter((x): x is number => x !== null);
    const outputs = new Set(all.map((s) => `${s.exit.code}:${s.stdoutSha256}`));
    return {
      label,
      role,
      samples: mine.length,
      wallMs: medianInterval(mine.map((s) => s.wallMs)),
      cpuMs: cpu.length === mine.length ? medianInterval(cpu) : null,
      maxRssBytes: rss.length ? median(rss) : null,
      failures: all.filter(failed).length,
      exitCodes: [...new Set(all.map((s) => s.exit.code))],
      outputs: outputs.size,
      outputStable: outputs.size <= 1,
      outputMatchesRef: role === "ref" ? null : outputs.size === 1 && refOutputs.size === 1 ? [...outputs][0] === [...refOutputs][0] : false,
    };
  });

  const candidates: CandidateSummary[] = input.sides
    .filter((s) => s.role === "cand")
    .map(({ label }) => {
      const pairs = accepted.map((ss) => ({ ref: ss.find((s) => s.side === ref.label)!, cand: ss.find((s) => s.side === label)! }));
      const wallRatio = medianInterval(pairs.map((p) => p.cand.wallMs / p.ref.wallMs));
      const cpuPairs = pairs.filter((p) => p.ref.cpuMs && p.cand.cpuMs !== null);
      const cpuRatio = cpuPairs.length === pairs.length ? medianInterval(cpuPairs.map((p) => p.cand.cpuMs! / p.ref.cpuMs!)) : null;
      const anyFailed = samples.some((s) => (s.side === label || s.side === ref.label) && failed(s));
      const state: CandidateState = anyFailed ? "failed" : pairs.length < input.minRounds ? "noisy" : "measured";
      return { label, state, wallRatio, cpuRatio, call: state === "measured" && wallRatio ? callOf(wallRatio) : null };
    });

  return {
    schema: "parallax.bench-summary/1",
    canaryBaselineMs: baseline,
    rounds: { planned: input.plannedRounds, attempts: counts.attempts, accepted: accepted.length, rejected: counts.rejected, failed: counts.failed },
    minRounds: input.minRounds,
    gates: input.gates,
    rejections: counts.rejections,
    accounting: input.accounting,
    sides,
    candidates,
    clean: candidates.every((c) => c.state === "measured") && sides.every((s) => s.outputStable),
  };
}
