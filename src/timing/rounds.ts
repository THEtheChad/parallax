// The round loop shared by `bench` and `lsp-bench`.
//
//   rounds    wait for an idle machine, canary, every side once, canary; the order alternates
//             (ref, A, B / B, A, ref / ...) so no side always runs first or after the same neighbour
//   retries   a disturbed round (see summary.ts) is run again, up to `attempts` times; a round in which
//             a side failed is not retried (a crash is a result, not noise)
//   more      after `runs` rounds, `stop` decides after each round whether the bench is done (it looks
//             only at its look points; stats.ts lookPoints); otherwise rounds go on up to `maxRuns`
//
// Every round goes to the writer as it happens, rejected ones included; the samples are written by
// `run` itself.
//
// Progress: a line when a round starts, one indented line per side as it finishes, and one with the
// canaries, outside load and verdict. The per-side lines are written between sides, inside the
// round's CPU window: a line costs the harness microseconds of its own CPU, which the window already
// counts as the harness's (outsideCores subtracts it), and nothing runs while a side is timed.

import type { JsonlWriter } from "../bundle/lines.ts";
import { cpuSnapshot, cpuWindow, outsideCores, waitForIdle, type IdleGate } from "../host/machine.ts";
import { fmtDuration, fmtDurationRange, status, warn, type LogFn } from "../log.ts";
import { runCanary } from "./canary.ts";
import { lookPoints, type LookPlan } from "./stats.ts";
import { judgeRound, type Gates, type RoundRecord } from "./summary.ts";

export interface SideRun {
  // CPU of everything the side ran during the round; null when unknown (outside load is then unknown).
  cpuMs: number | null;
  failed: boolean;
  // A few words for the progress log.
  brief: string;
}

// Where the loop is, for `stop`: rounds finished so far and the time they took (retries and idle
// waits included).
export interface RoundsProgress {
  done: number;
  elapsedMs: number;
}

export interface RoundsOptions<S extends { label: string }> {
  sides: S[];
  runs: number;
  // Rounds may go on past `runs` up to this many while `stop` says no (default: runs).
  maxRuns?: number;
  stop?: (progress: RoundsProgress) => boolean;
  attempts: number;
  idle: IdleGate;
  gates: Gates;
  writer: JsonlWriter;
  log: LogFn;
  run: (side: S, round: number, attempt: number) => Promise<SideRun>;
}

export async function runRounds<S extends { label: string }>(o: RoundsOptions<S>): Promise<void> {
  runCanary(); // warm the canary's code before its first timed use
  let fastestCanary = Infinity;
  const maxRuns = Math.max(o.runs, o.maxRuns ?? o.runs);
  const plan: LookPlan = { runs: o.runs, maxRuns };
  const width = Math.max(...o.sides.map((s) => s.label.length));
  const need = maxRuns > o.runs ? `${o.runs}..${maxRuns}` : `${o.runs}`;
  // Accepted as judged now, against the fastest canary so far; the summary judges every round
  // against the bench's fastest canary, so it can only accept fewer.
  let accepted = 0;
  const t0 = performance.now();
  try {
    await rounds();
  } finally {
    status(o.log, null);
  }

  async function rounds(): Promise<void> {
    for (let round = 1; round <= maxRuns; round++) {
      if (round > o.runs && o.stop?.({ done: round - 1, elapsedMs: performance.now() - t0 })) break;
      const order = round % 2 ? o.sides : [...o.sides].reverse();
      for (let attempt = 1; attempt <= o.attempts; attempt++) {
        o.log(`round ${round}.${attempt} (${accepted} accepted, need ${need})${attempt > 1 ? ": again, the last try was disturbed" : ""}`);
        const idle = await waitForIdle(o.idle, o.log);
        const before = cpuSnapshot();
        const canaryBeforeMs = runCanary().ms;
        const results: { side: S; r: SideRun }[] = [];
        // What runs now and what is left, under the log on a terminal (written here, between sides, so
        // nothing redraws while a side is timed).
        const left = round > 1 ? ` · ${describeLeft(roundsLeft(plan, round - 1, accepted, Boolean(o.stop)), performance.now() - t0, round - 1)}` : "";
        for (const [i, side] of order.entries()) {
          status(o.log, `round ${round}.${attempt} · ${side.label} (${i + 1} of ${order.length}) · ${accepted} accepted, need ${need}${left}`);
          const r = await o.run(side, round, attempt);
          results.push({ side, r });
          o.log(`  ${side.label.padEnd(width)}  ${r.brief}`);
        }
        const canaryAfterMs = runCanary().ms;
        const window = cpuWindow(before, cpuSnapshot());
        const cpu = results.every(({ r }) => r.cpuMs !== null) ? results.reduce((t, { r }) => t + r.cpuMs!, 0) : null;
        fastestCanary = Math.min(fastestCanary, canaryBeforeMs, canaryAfterMs);
        const partial = { idle, outsideCores: outsideCores(window, cpu), canaryBeforeMs, canaryAfterMs };
        const rejected = judgeRound(partial, fastestCanary, o.gates);
        const rec: RoundRecord = { type: "round", round, attempt, order: order.map((s) => s.label), window, ...partial, rejected };
        await o.writer.write(rec);
        const failed = results.filter(({ r }) => r.failed);
        const other = partial.outsideCores === null ? "" : `, other programs ${partial.outsideCores.toFixed(2)} cores`;
        const verdict = failed.length ? "failed" : rejected.length ? `rejected: ${rejected.join("; ")}` : "accepted";
        o.log(`  canary ${canaryBeforeMs.toFixed(1)}/${canaryAfterMs.toFixed(1)} ms${other}: ${verdict}`);
        if (failed.length) {
          warn(o.log, `round ${round}: ${failed.map(({ side }) => side.label).join(", ")} failed; not retried`);
          break;
        }
        if (!rejected.length) {
          accepted++;
          break;
        }
      }
      // One early estimate, so a long run says how long it will be before its first look.
      if (round === 1 && maxRuns > 1) {
        const left = roundsLeft(plan, 1, accepted, Boolean(o.stop));
        o.log(`a round takes about ${fmtDuration(performance.now() - t0)}; ${describeLeft(left, performance.now() - t0)}`);
      }
    }
  }
}

// How many more rounds a bench may run, after `done` rounds with `accepted` of them accepted. With a
// stopping rule the least is the rounds to its next look point (if every one is accepted and every call
// settles there); the most is the rounds up to `maxRuns`. Sequential stopping makes this a range, not
// a number.
export function roundsLeft(plan: LookPlan, done: number, accepted: number, sequential: boolean): { min: number; max: number } {
  const max = Math.max(0, plan.maxRuns - done);
  if (!sequential) return { min: max, max };
  const next = lookPoints(plan).find((n) => n > accepted) ?? plan.maxRuns;
  return { min: Math.min(max, Math.max(plan.runs - done, next - accepted, 0)), max };
}

// "up to 9 more rounds (3 if every call settles at the next look), about 4-12 min left", with the time
// from the mean round so far (retries and idle waits included).
export function describeLeft(left: { min: number; max: number }, elapsedMs: number, done = 1): string {
  if (left.max === 0) return "no rounds left";
  const per = elapsedMs / Math.max(1, done);
  const rounds = left.min === left.max ? `${left.max} more round${left.max === 1 ? "" : "s"}` : `up to ${left.max} more rounds (${left.min} if every call settles at the next look)`;
  return `${rounds}, about ${fmtDurationRange(left.min * per, left.max * per)} left`;
}

// The `stop` rule of a sequential bench: done when the accepted rounds are at one of the plan's look
// points and every call is settled. Between look points it never stops, so the false-call budget
// split across the looks (stats.ts lookConfidence) holds.
export function settledAtLook(
  s: { rounds: { accepted: number }; settled: boolean; candidates: { state: string }[] },
  plan: LookPlan,
  log: LogFn,
  progress?: RoundsProgress,
): boolean {
  // Nothing left to measure: no call is made, so stopping costs no false-call budget.
  if (s.candidates.every((c) => c.state === "failed")) return true;
  const n = s.rounds.accepted;
  if (!lookPoints(plan).includes(n)) return false;
  if (s.settled) {
    log(`look at ${n} accepted rounds: every call settled, stopping`);
    return true;
  }
  const left = progress ? `; ${describeLeft(roundsLeft(plan, progress.done, n, true), progress.elapsedMs, progress.done)}` : ` (up to ${plan.maxRuns} rounds)`;
  log(`look at ${n} accepted rounds: unsettled calls remain, going on${left}`);
  return false;
}
