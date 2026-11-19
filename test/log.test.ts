// The log plumbing and the progress it carries: levels, elapsed-time stamps, the estimate of what is
// left of a bench, and the idle wait's periodic lines.

import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForIdle } from "../src/host/machine.ts";
import { createLog, fmtDurationRange, fmtElapsed, warn } from "../src/log.ts";
import { describeLeft, roundsLeft } from "../src/timing/rounds.ts";

test("log levels: --quiet drops progress and keeps warnings; a plain function gets warnings prefixed", () => {
  const lines: string[] = [];
  const loud = createLog({ write: (l) => lines.push(l) });
  loud("round 1.1");
  warn(loud, "slow disk");
  const quiet = createLog({ quiet: true, write: (l) => lines.push(l) });
  quiet("round 1.1");
  quiet.warn("slow disk");
  assert.deepEqual(lines, ["round 1.1", "warning: slow disk", "warning: slow disk"]);
  const plain: string[] = [];
  warn((m) => plain.push(m), "slow disk");
  assert.deepEqual(plain, ["warning: slow disk"]);
});

test("elapsed stamps: on every line of a message, not on blank ones", () => {
  let now = 0;
  const lines: string[] = [];
  const log = createLog({ elapsed: true, now: () => now, write: (l) => lines.push(l) });
  now = 61_500;
  log("bundle /x\nproject /y");
  now = 3_725_000;
  log("\n== hono: bench");
  assert.deepEqual(lines, ["[1:01] bundle /x", "[1:01] project /y", "", "[1:02:05] == hono: bench"]);
  assert.equal(fmtElapsed(0), "0:00");
  assert.equal(fmtElapsed(41 * 60_000 + 2_000), "41:02");
});

test("what is left of a bench is a range: to the next look if every call settles, else to --max-runs", () => {
  const plan = { runs: 6, maxRuns: 15 };
  // After round 1: at least the 5 rounds to the first look, at most 14.
  assert.deepEqual(roundsLeft(plan, 1, 1, true), { min: 5, max: 14 });
  // An unsettled look at 6 of 6: the next look is at 9.
  assert.deepEqual(roundsLeft(plan, 6, 6, true), { min: 3, max: 9 });
  // Rejected rounds: 8 rounds run, 6 accepted; the next look still needs 3 more accepted.
  assert.deepEqual(roundsLeft(plan, 8, 6, true), { min: 3, max: 7 });
  // No stopping rule (calibrate): a fixed number.
  assert.deepEqual(roundsLeft({ runs: 9, maxRuns: 9 }, 2, 2, false), { min: 7, max: 7 });
  // 6 rounds in 36 minutes: 6 min a round.
  assert.equal(describeLeft({ min: 3, max: 9 }, 36 * 60_000, 6), "up to 9 more rounds (3 if every call settles at the next look), about 18-54 min left");
  assert.equal(describeLeft({ min: 7, max: 7 }, 20_000, 2), "7 more rounds, about 70 s left");
  assert.equal(fmtDurationRange(40_000, 12 * 60_000), "40 s-12 min");
});

test("idle wait: a line when it starts, one per period, a warning when it gives up", async () => {
  const lines: string[] = [];
  const log = createLog({ write: (l) => lines.push(l) });
  // Never idle: a negative limit.
  const w = await waitForIdle({ maxBusyCores: -1, windowMs: 20, timeoutMs: 300, bootSettleS: 0 }, log, 100);
  assert.equal(w.timedOut, true);
  assert.match(lines[0]!, /^waiting for the machine to go idle \(.* cores busy, limit -1; gives up after 0 s\)$/);
  assert.ok(lines.some((l) => /^ {2}still waiting for idle: .* cores busy \(limit -1\), 0 of 0 s$/.test(l)), lines.join("\n"));
  assert.match(lines.at(-1)!, /^warning: the machine stayed busy/);
});
