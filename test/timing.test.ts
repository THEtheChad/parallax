import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAccounting } from "../src/host/accounting.ts";
import { cpuWindow, outsideCores, priorityNote, type CpuSnapshot, type HostLoad, type IdleWait } from "../src/host/machine.ts";
import { countCpuList, machineState, machineStateNotes, parsePmsetBatt, parsePmsetLowPower, parsePowercfgScheme } from "../src/host/machineState.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeepingJsonlWriter } from "../src/bundle/lines.ts";
import { runRounds } from "../src/timing/rounds.ts";
import { callOf, lookConfidence, lookPoints, median, medianInterval, quantile, sameWithin } from "../src/timing/stats.ts";
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
  const rule = { confidence: 0.9, same: 0.05 };
  assert.equal(callOf(a, rule), "faster");
  assert.equal(callOf({ ...a, estimate: 1, low: 0.9, high: 1.08 }, rule), "unresolved");
  assert.equal(callOf({ ...a, estimate: 1, low: 0.97, high: 1.04 }, rule), "same", "within the resolution");
  assert.equal(callOf({ ...a, estimate: 1.2, low: 1.1, high: 1.3 }, rule), "slower");
  assert.equal(callOf({ ...a, estimate: 1.0005, low: 1.0001, high: 1.001 }, rule), "same", "too small to matter");
  assert.equal(medianInterval([]), null);
});

test("calls need enough rounds: fewer cannot rule out luck", () => {
  // 3 of 3 rounds below 1 happens by chance 1 time in 4; 5 of 5, 1 in 16.
  const single = { confidence: lookConfidence(5, { runs: 5, maxRuns: 5 }), same: 0.005 };
  assert.ok(Math.abs(single.confidence - 0.9) < 1e-12, "one look: the whole 10% budget");
  const three = medianInterval([0.97, 0.98, 0.99], single.confidence)!;
  assert.equal(three.confidence, 0.75);
  assert.equal(callOf(three, single), "too few rounds");
  assert.equal(callOf(medianInterval([0.5])!, single), "too few rounds");
  const five = medianInterval([0.97, 0.98, 0.99, 0.96, 0.98], single.confidence)!;
  assert.equal(five.confidence, 0.9375);
  assert.equal(callOf(five, single), "faster");
  assert.equal(callOf(medianInterval([0.97, 0.98, 1.01, 0.96, 0.98], single.confidence)!, single), "unresolved", "one round on the other side");
});

test("sequential looks: the false-call budget is split in advance", () => {
  const plan = { runs: 6, maxRuns: 15 };
  assert.deepEqual(lookPoints(plan), [6, 9, 12, 15]);
  assert.deepEqual(lookPoints({ runs: 6, maxRuns: 7 }), [6, 7]);
  assert.deepEqual(lookPoints({ runs: 5, maxRuns: 5 }), [5]);
  // Half of 10% at the first look, the other half shared by three later looks.
  assert.ok(Math.abs(lookConfidence(6, plan) - 0.95) < 1e-12);
  assert.ok(Math.abs(lookConfidence(9, plan) - (1 - 0.05 / 3)) < 1e-12);
  assert.equal(lookConfidence(10, plan), lookConfidence(12, plan), "between looks: the stricter, later look's");
  // 6 of 6 on one side reaches 95% (96.9%); 5 of 5 does not (93.75%).
  assert.equal(callOf(medianInterval([0.9, 0.91, 0.92, 0.93, 0.94, 0.95], 0.95)!, { confidence: 0.95, same: 0.05 }), "faster");
  assert.equal(callOf(medianInterval([0.9, 0.91, 0.92, 0.93, 0.94], 0.95)!, { confidence: 0.95, same: 0.05 }), "too few rounds");
  // "same" widens to the absolute floor for tiny figures: 1 ms over a 0.3 ms reference.
  assert.equal(sameWithin(0.05, 1, 0.3), 1 / 0.3);
  assert.equal(sameWithin(0.05, 1, 300), 0.05);
  assert.equal(sameWithin(0.05, 0, null), 0.05);
});

test("rounds go on past --runs only while unsettled, up to --max-runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parallax-rounds-"));
  const count = async (stop: () => boolean, file: string): Promise<number> => {
    const writer = new KeepingJsonlWriter(join(dir, file));
    let runs = 0;
    await runRounds({
      sides: [{ label: "a" }, { label: "b" }],
      runs: 3,
      maxRuns: 9,
      stop,
      attempts: 1,
      idle: { maxBusyCores: Infinity, windowMs: 1, timeoutMs: 1, bootSettleS: 0 },
      gates: { maxOutsideCores: null, maxCanaryDrift: null },
      writer,
      log: () => {},
      run: async () => {
        runs++;
        return { cpuMs: null, failed: false, brief: "" };
      },
    });
    await writer.close();
    return runs / 2;
  };
  assert.equal(await count(() => true, "settled.jsonl"), 3);
  assert.equal(await count(() => false, "never.jsonl"), 9);
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

test("machine state: power and CPU-frequency probes parse what each OS prints", () => {
  assert.equal(countCpuList("0-3,8,10-11"), 7);
  assert.equal(parsePmsetBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t85%; discharging"), "battery");
  assert.equal(parsePmsetBatt("Now drawing from 'AC Power'"), "ac");
  assert.equal(parsePmsetLowPower("System-wide power settings:\nCurrently in use:\n lowpowermode         1\n sleep 1"), true);
  assert.equal(parsePmsetLowPower(" powermode            0\n"), false);
  assert.equal(parsePowercfgScheme("Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)\r\n"), "Balanced");
  const quiet = { governors: null, boost: null, smt: null, affinity: null, power: null, lowPowerMode: null, powerPlan: null };
  assert.deepEqual(machineStateNotes(quiet, 8), []);
  assert.equal(machineStateNotes({ ...quiet, power: "battery", lowPowerMode: true, affinity: { list: "0-3", cores: 4 } }, 8).length, 3);
  const here = machineState();
  assert.ok(typeof here === "object" && "governors" in here);
});

test("thread modes: each candidate is compared with the reference in its own mode; speedup per implementation", () => {
  const records: (SampleRecord | RoundRecord)[] = [];
  // Default mode: ref 100, cand 50 (0.5x). Single-threaded: ref 400, cand 100 (0.25x): the
  // candidate gains less from threads (2x) than the reference (4x).
  const walls: Record<string, number> = { ref: 100, cand: 50, "ref@1t": 400, "cand@1t": 100 };
  for (let round = 1; round <= 5; round++) {
    const jitter = 1 + round / 100;
    for (const [side, wall] of Object.entries(walls)) {
      records.push({
        type: "sample", side, role: side.startsWith("ref") ? "ref" : "cand", round, attempt: 1, warmup: false, startedAt: "",
        wallMs: wall * jitter, drainMs: wall, exit: { code: 0, signal: null }, timedOut: false, crashSignals: [], stdoutSha256: "same",
        stderrSha256: "", outputLines: 0, cpuMs: wall, userMs: wall, sysMs: 0, adoptedCpuMs: null, adopted: null, maxRssBytes: 1, window: win, outsideCores: 0,
      });
    }
    records.push({ type: "round", round, attempt: 1, order: Object.keys(walls), idle: idle(), canaryBeforeMs: 20, canaryAfterMs: 20, window: win, outsideCores: 0, rejected: [] });
  }
  const s = summarizeBench({
    records,
    sides: [
      { label: "ref", role: "ref", mode: "default", base: "ref" },
      { label: "cand", role: "cand", mode: "default", base: "cand" },
      { label: "ref@1t", role: "ref", mode: "single", base: "ref" },
      { label: "cand@1t", role: "cand", mode: "single", base: "cand" },
    ],
    plannedRounds: 5,
    minRounds: 3,
    gates: DEFAULT_GATES,
    accounting: "gnu-time",
  });
  const byLabel = Object.fromEntries(s.candidates.map((c) => [c.label, c]));
  assert.equal(byLabel.cand!.ref, "ref");
  assert.ok(Math.abs(byLabel.cand!.wallRatio!.estimate - 0.5) < 1e-9);
  assert.equal(byLabel["cand@1t"]!.ref, "ref@1t");
  assert.ok(Math.abs(byLabel["cand@1t"]!.wallRatio!.estimate - 0.25) < 1e-9);
  const speedup = Object.fromEntries(s.speedups.map((x) => [x.base, x.ratio!.estimate]));
  assert.ok(Math.abs(speedup.ref! - 4) < 1e-9 && Math.abs(speedup.cand! - 2) < 1e-9);
  assert.equal(s.sides.find((x) => x.label === "ref@1t")!.outputMatchesRef, true, "a single-threaded run must give the reference's output too");
  assert.equal(s.clean, true);
});
