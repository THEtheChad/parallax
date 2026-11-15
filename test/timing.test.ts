import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAccounting } from "../src/host/accounting.ts";
import { cpuWindow, outsideCores, type CpuSnapshot, type IdleWait } from "../src/host/machine.ts";
import { bootstrapMedian, callOf, median, quantile } from "../src/timing/stats.ts";
import { DEFAULT_GATES, judgeRound, summarizeBench, type RoundRecord, type SampleRecord } from "../src/timing/summary.ts";

test("quantiles interpolate; the bootstrap is deterministic and brackets the median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  const xs = [0.51, 0.49, 0.5, 0.55, 0.48, 0.5, 0.52];
  const a = bootstrapMedian(xs)!;
  assert.deepEqual(bootstrapMedian(xs), a);
  assert.equal(a.estimate, 0.5);
  assert.ok(a.low <= 0.5 && a.high >= 0.5 && a.high < 1);
  assert.equal(callOf(a), "faster");
  assert.equal(callOf({ ...a, low: 0.9, high: 1.05 }), "indistinguishable");
  assert.equal(callOf({ ...a, low: 1.1, high: 1.3 }), "slower");
  assert.equal(bootstrapMedian([]), null);
});

test("outside load: machine CPU minus the harness and the measured commands", () => {
  const snap = (t: number, busyMs: number, selfMs: number): CpuSnapshot => ({ t, busyMs, idleMs: 0, selfMs, pressureUs: null });
  // 1 s window; the machine used 3.5 cores-seconds: harness 0.2 s, commands 2.3 s, so 1 core outside.
  const w = cpuWindow(snap(0, 10_000, 100), snap(1000, 13_500, 300));
  assert.equal(w.machineCores, 3.5);
  assert.equal(outsideCores(w, 2300), 1);
  assert.equal(outsideCores(w, null), null, "unknown without child accounting");
});

test("this machine has child accounting it can verify", () => {
  // Linux CI images and macOS have a working /usr/bin/time; elsewhere "none" is a valid answer.
  assert.ok(["gnu-time", "bsd-time", "none"].includes(detectAccounting().kind));
  if (process.platform === "linux" && detectAccounting().kind === "gnu-time") {
    assert.deepEqual(detectAccounting().parse("Command exited with non-zero status 2\nparallax-usage 1.25 0.10 51200\n"), {
      userMs: 1250,
      sysMs: 100,
      maxRssBytes: 51200 * 1024,
    });
  }
});

const idle = (timedOut = false): IdleWait => ({ waitedMs: 1000, busyCores: 0.2, pressure: null, timedOut, uptimeS: 9999, bootSettleWaitedMs: 0 });
const win = { wallMs: 1000, machineCpuMs: 0, machineCores: 0, selfCpuMs: 0, pressure: null };

test("a round is rejected for a busy start, outside CPU, or a slow canary", () => {
  const ok = { idle: idle(), outsideCores: 0.3, canaryBeforeMs: 20, canaryAfterMs: 21 };
  assert.deepEqual(judgeRound(ok, 20, DEFAULT_GATES), []);
  assert.deepEqual(judgeRound({ ...ok, idle: idle(true) }, 20, DEFAULT_GATES), ["machine busy before the round"]);
  assert.deepEqual(judgeRound({ ...ok, outsideCores: 2 }, 20, DEFAULT_GATES), ["other programs used CPU during the round"]);
  assert.deepEqual(judgeRound({ ...ok, canaryAfterMs: 23 }, 20, DEFAULT_GATES), ["canary slower than the fastest canary"]);
  assert.deepEqual(judgeRound({ ...ok, outsideCores: null }, 20, DEFAULT_GATES), [], "no accounting: the canary still guards");
});

function bench(rounds: { ref: number; cand: number; canary: number; outside?: number; crash?: boolean; output?: string }[]) {
  const records: (SampleRecord | RoundRecord)[] = [];
  rounds.forEach((r, i) => {
    const s = (side: string, role: "ref" | "cand", wallMs: number, extra: Partial<SampleRecord> = {}): SampleRecord => ({
      type: "sample",
      side,
      role,
      round: i + 1,
      attempt: 1,
      warmup: false,
      startedAt: "",
      wallMs,
      drainMs: wallMs,
      exit: { code: 2, signal: null },
      timedOut: false,
      crashSignals: [],
      stdoutSha256: "same",
      stderrSha256: "",
      outputLines: 1,
      cpuMs: wallMs * 4,
      userMs: wallMs * 4,
      sysMs: 0,
      maxRssBytes: 1 << 20,
      window: win,
      outsideCores: 0,
      ...extra,
    });
    records.push(s("ref", "ref", r.ref));
    records.push(s("cand", "cand", r.cand, { ...(r.crash ? { crashSignals: ["stderr: panic: x"] } : {}), ...(r.output ? { stdoutSha256: r.output } : {}) }));
    records.push({ type: "round", round: i + 1, attempt: 1, order: ["ref", "cand"], idle: idle(), canaryBeforeMs: r.canary, canaryAfterMs: r.canary, window: win, outsideCores: r.outside ?? 0, rejected: [] });
  });
  return summarizeBench({ records, sides: [{ label: "ref", role: "ref" }, { label: "cand", role: "cand" }], plannedRounds: rounds.length, minRounds: 3, gates: DEFAULT_GATES, accounting: "gnu-time" });
}

test("paired ratios: load that slows a whole round cancels", () => {
  // Round 3 ran on a machine twice as slow; the per-round ratio stays 0.5.
  const s = bench([
    { ref: 100, cand: 50, canary: 20 },
    { ref: 102, cand: 51, canary: 20 },
    { ref: 200, cand: 100, canary: 21 },
  ]);
  const c = s.candidates[0]!;
  assert.equal(c.state, "measured");
  assert.equal(c.wallRatio!.estimate, 0.5);
  assert.equal(c.wallRatio!.high, 0.5);
  assert.equal(c.call, "faster");
  assert.equal(s.sides[1]!.outputMatchesRef, true);
  assert.equal(s.clean, true);
});

test("rejected rounds never enter a statistic; too few accepted rounds is noisy, not a number", () => {
  const s = bench([
    { ref: 100, cand: 50, canary: 20 },
    { ref: 100, cand: 90, canary: 30 }, // canary 50% slower than the fastest: rejected after the fact
    { ref: 100, cand: 90, canary: 20, outside: 4 },
    { ref: 100, cand: 52, canary: 20 },
  ]);
  assert.equal(s.rounds.accepted, 2);
  assert.deepEqual(s.rejections, { "canary slower than the fastest canary": 1, "other programs used CPU during the round": 1 });
  assert.equal(s.candidates[0]!.state, "noisy");
  assert.equal(s.candidates[0]!.call, null);
  assert.equal(s.clean, false);
});

test("a crash fails the candidate; another output is reported, not hidden", () => {
  const crashed = bench([
    { ref: 100, cand: 50, canary: 20 },
    { ref: 100, cand: 50, canary: 20, crash: true },
    { ref: 100, cand: 50, canary: 20 },
    { ref: 100, cand: 50, canary: 20 },
  ]);
  assert.equal(crashed.candidates[0]!.state, "failed");
  assert.equal(crashed.rounds.failed, 1);
  const other = bench([
    { ref: 100, cand: 50, canary: 20, output: "x" },
    { ref: 100, cand: 50, canary: 20, output: "x" },
    { ref: 100, cand: 50, canary: 20, output: "x" },
  ]);
  assert.equal(other.sides[1]!.outputMatchesRef, false);
  const unstable = bench([
    { ref: 100, cand: 50, canary: 20, output: "x" },
    { ref: 100, cand: 50, canary: 20 },
    { ref: 100, cand: 50, canary: 20 },
  ]);
  assert.equal(unstable.sides[1]!.outputStable, false);
  assert.equal(unstable.clean, false);
});
