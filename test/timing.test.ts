import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAccounting } from "../src/host/accounting.ts";
import { cpuWindow, outsideCores, priorityNote, type CpuSnapshot, type HostLoad, type IdleWait } from "../src/host/machine.ts";
import { medianInterval, callOf, median, quantile } from "../src/timing/stats.ts";
import { DEFAULT_GATES, judgeRound, summarizeBench, type RoundRecord, type SampleRecord } from "../src/timing/summary.ts";

test("quantiles interpolate; the median interval comes from order statistics", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  const xs = [0.51, 0.49, 0.5, 0.55, 0.48, 0.5, 0.52];
  const a = medianInterval(xs)!;
  assert.equal(a.estimate, 0.5);
  // n = 7: only the whole range reaches 95% (it covers 1 - 2/128).
  assert.deepEqual([a.low, a.high, a.n], [0.48, 0.55, 7]);
  assert.ok(Math.abs(a.confidence - (1 - 2 / 128)) < 1e-12);
  // n = 20: the 95% interval is the 6th to the 15th value (it covers 95.9%).
  const b = medianInterval(Array.from({ length: 20 }, (_, i) => 20 - i))!;
  assert.deepEqual([b.low, b.high], [6, 15]);
  assert.ok(b.confidence >= 0.95 && b.confidence < 0.96);
  assert.equal(callOf(a), "faster");
  assert.equal(callOf({ ...a, low: 0.9, high: 1.05 }), "indistinguishable");
  assert.equal(callOf({ ...a, estimate: 1.2, low: 1.1, high: 1.3 }), "slower");
  assert.equal(callOf({ ...a, estimate: 1.0005, low: 1.0001, high: 1.001 }), "indistinguishable", "too small to matter");
  assert.equal(medianInterval([]), null);
});

test("calls need 5 rounds: fewer cannot rule out luck", () => {
  // 3 of 3 rounds below 1 happens by chance 1 time in 4; 5 of 5, 1 in 16.
  const three = medianInterval([0.97, 0.98, 0.99])!;
  assert.equal(three.confidence, 0.75);
  assert.equal(callOf(three), "too few rounds");
  assert.equal(callOf(medianInterval([0.5])!), "too few rounds");
  const five = medianInterval([0.97, 0.98, 0.99, 0.96, 0.98])!;
  assert.equal(five.confidence, 0.9375);
  assert.equal(callOf(five), "faster");
  assert.equal(callOf(medianInterval([0.97, 0.98, 1.01, 0.96, 0.98])!), "indistinguishable", "one round on the other side");
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
      adoptedCpuMs: null,
      adopted: null,
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
    { ref: 104, cand: 52, canary: 20 },
    { ref: 98, cand: 49, canary: 20 },
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

test("a lowered priority is named the way the OS names it", () => {
  const at = (priority: number | null) => ({ priority }) as HostLoad;
  assert.equal(priorityNote(at(0), "linux"), null);
  assert.equal(priorityNote(at(null), "win32"), null);
  assert.match(priorityNote(at(10), "linux")!, /\(nice 10\)/);
  assert.match(priorityNote(at(10), "win32")!, /\(below normal priority class\)/);
  assert.match(priorityNote(at(19), "win32")!, /\(idle priority class\)/);
});
