// Sealed environments, pinning, counter sanity, A/A calibration and the editor scenarios' pure parts.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { twinSpec } from "../src/commands/calibrate.ts";
import { parsePerfStatDetail, planGroups } from "../src/host/counters.ts";
import { expandCpuList, parsePinning, pinCommand } from "../src/host/pinning.ts";
import { baseEnv, FIXED_ENV } from "../src/host/sealedEnv.ts";
import { bindSide, loadProfile, resolveEnv, sidesInModes } from "../src/profile/profile.ts";
import {
  benchFloors,
  CALIBRATION_SCHEMA,
  checkCalibration,
  loadCalibration,
  saveCalibration,
  suggestResolution,
  type Calibration,
  type HostKey,
} from "../src/timing/calibration.ts";
import { errorLine, exportedNames, importAction, importCandidates, theilSen } from "../src/timing/lspSession.ts";
import { summarizeLspBench, type SessionRecord } from "../src/timing/lspSummary.ts";
import type { BenchSummary, RoundRecord } from "../src/timing/summary.ts";

test("sealed environment: only the allow-list passes, fixed locale and zone; inherit keeps everything", () => {
  const from = { PATH: "/bin", HOME: "/h", GOGC: "off", RAYON_NUM_THREADS: "3", NODE_OPTIONS: "--x", LANG: "de_DE.UTF-8", KEEP_ME: "1" };
  const sealed = baseEnv({ mode: "sealed", pass: ["KEEP_ME"] }, from, "linux");
  assert.deepEqual(sealed.passed, ["HOME", "KEEP_ME", "PATH"]);
  assert.deepEqual(sealed.env, { PATH: "/bin", HOME: "/h", KEEP_ME: "1", ...FIXED_ENV });
  const inherit = baseEnv({ mode: "inherit", pass: [] }, from, "linux");
  assert.deepEqual(inherit.env, from);
  assert.deepEqual(inherit.passed, []);
  // Windows names match whatever case the OS gave them.
  const win = baseEnv({ mode: "sealed", pass: [] }, { Path: "C:\\w", SYSTEMROOT: "C:\\Windows", GOGC: "1" }, "win32");
  assert.deepEqual(win.passed, ["Path", "SYSTEMROOT"]);
  assert.equal(win.env.GOGC, undefined);
});

test("sealed environment: a side's profile settings and thread mode apply on top, and are recorded", async () => {
  const saved = process.env.PARALLAX_TEST_LEAK;
  process.env.PARALLAX_TEST_LEAK = "leaked";
  try {
    const side = await bindSide(`tsrs=${process.execPath}`, "ref");
    assert.equal(side.env.mode, "sealed");
    assert.equal(side.env.env.PARALLAX_TEST_LEAK, undefined, "a stray variable does not reach the command");
    assert.equal(side.env.env.TZ, "UTC");
    const [single] = sidesInModes([side], ["single"], "lsp");
    assert.equal(single!.env.env.RAYON_NUM_THREADS, "1");
    assert.equal(single!.env.env.PARALLAX_TEST_LEAK, undefined, "the single-threaded variant is sealed the same way");
    const open = await bindSide(`tsrs=${process.execPath}`, "ref", { env: { mode: "inherit", pass: [] } });
    assert.equal(open.env.env.PARALLAX_TEST_LEAK, "leaked");
    // A plain environment passed to resolveEnv is inherited whole (the old behaviour).
    assert.equal(resolveEnv(loadProfile("tsc7").profile, { A: "1" }).mode, "inherit");
  } finally {
    if (saved === undefined) delete process.env.PARALLAX_TEST_LEAK;
    else process.env.PARALLAX_TEST_LEAK = saved;
  }
});

test("pinning: cpu lists, validation against the allowed cores, the taskset prefix", () => {
  assert.deepEqual(expandCpuList("0-2,5,1"), [0, 1, 2, 5]);
  assert.throws(() => expandCpuList("a-b"), /not a cpu list/);
  assert.throws(() => expandCpuList("3-1"), /backwards/);
  assert.throws(() => expandCpuList("9007199254740992"), /beyond any machine/, "a huge number is refused, not looped over");
  assert.throws(() => parsePinning("0", null, "darwin"), /needs Linux/);
  if (process.platform === "linux") {
    assert.throws(() => parsePinning("0,4095", "0-3", "linux"), /not ones this process may run on/);
    assert.deepEqual(parsePinning("0", "0-3", "linux"), { cpus: "0", cores: 1 });
  }
  assert.deepEqual(pinCommand(["tsc", "-p", "."], { cpus: "2-3", cores: 2 }), ["taskset", "-c", "2-3", "tsc", "-p", "."]);
  assert.deepEqual(pinCommand(["tsc"], null), ["tsc"]);
});

test("counters: zero and multiplexed counts are dropped, and a machine that cannot count events together gets one run each", () => {
  const scaled = parsePerfStatDetail("1000,,instructions:u,500,50.00,,\n2000,,cycles:u,1000,100.00,,\n");
  assert.equal(scaled!.counters.instructions, null);
  assert.deepEqual(scaled!.scaled, ["instructions"]);
  assert.equal(scaled!.counters.cycles, 2000);
  assert.deepEqual(parsePerfStatDetail("1000,,instructions:u,996,99.60,,\n")!.scaled, ["instructions"], "even slightly scaled is scaled");
  const zero = parsePerfStatDetail("1000,,instructions:u,1000,100.00,,\n0,,cycles:u,1000,100.00,,\n");
  assert.deepEqual(zero!.missing, ["cycles"], "a counter reading 0 (a VM that exposes but never counts it) is missing, not 0");
  assert.equal(zero!.counters.cycles, null);
  const all = ["instructions:u", "cycles:u", "task-clock", "page-faults"];
  assert.deepEqual(planGroups(all, { counters: zero!.counters, scaled: [], missing: [] }), [all]);
  assert.deepEqual(planGroups(all, zero), [["instructions:u", "task-clock", "page-faults"], ["cycles:u"]]);
  assert.deepEqual(planGroups(all, null, false), [["instructions:u", "task-clock", "page-faults"], ["cycles:u"]]);
  assert.deepEqual(planGroups(["task-clock"], null), [["task-clock"]]);
  assert.deepEqual(planGroups([], null), []);
});

const interval = (low: number, high: number, n = 9) => ({ estimate: (low + high) / 2, low, high, confidence: 0.96, n });

function aaSummary(): BenchSummary {
  return {
    candidates: [
      { label: "tsc7.aa", ref: "tsc7", mode: "default", state: "measured", wallRatio: interval(0.97, 1.04), cpuRatio: interval(0.99, 1.01), call: "same", sameWithin: 0.05 },
      { label: "tsc7.aa@1t", ref: "tsc7@1t", mode: "single", state: "measured", wallRatio: interval(1.02, 1.03), cpuRatio: null, call: "slower", sameWithin: 0.05 },
    ],
    counters: {
      backend: "perf",
      sides: [
        { label: "tsc7@1t", runs: 3, instructions: { median: 1000, spread: 0.0002 }, cycles: null, ipc: null, taskClockMs: null, pageFaults: null },
        { label: "tsc7.aa@1t", runs: 3, instructions: { median: 1001, spread: 0.0004 }, cycles: null, ipc: null, taskClockMs: null, pageFaults: null },
      ],
    },
  } as unknown as BenchSummary;
}

test("calibration: floors from the A/A intervals, false calls named, a resolution below the floor warned about", () => {
  const { floors, falseCalls } = benchFloors(aaSummary());
  const wall = floors.find((f) => f.metric === "wallMs" && f.mode === "default")!;
  assert.ok(Math.abs(wall.floor - 0.04) < 1e-9);
  assert.equal(wall.suggested, 0.04);
  assert.equal(suggestResolution(0.0001), 0.01);
  assert.equal(suggestResolution(0.061), 0.065);
  const instr = floors.find((f) => f.metric === "instructions")!;
  assert.ok(Math.abs(instr.floor - 0.001) < 1e-9);
  assert.deepEqual(falseCalls, ["wallMs@single"]);

  const host: HostKey = { platform: "linux", arch: "x64", kernel: "6", cpuModel: "cpu", cpus: 8, pin: null };
  const cal: Calibration = {
    schema: CALIBRATION_SCHEMA,
    kind: "cli-bench",
    createdAt: "2026-11-18T00:00:00Z",
    host,
    side: { profile: "tsc7", binSha256: "x", version: null },
    project: { name: "hono", commit: null },
    rounds: { planned: 9, accepted: 9, rejected: 0 },
    floors,
    falseCalls,
  };
  const loose = checkCalibration(cal, host, { resolution: 0.05, runs: 6, modes: ["default"], metrics: ["wallMs"] });
  assert.deepEqual(loose.notes.filter((n) => n.includes("noise floor")), []);
  assert.equal(loose.notes.length, 0, "the false call is in single mode, which this bench does not run");
  const tight = checkCalibration(cal, host, { resolution: 0.02, runs: 6, modes: ["default", "single"], metrics: ["wallMs"] });
  assert.ok(tight.notes.some((n) => /below this machine's A\/A noise floor \(wallMs@default 4\.0%/.test(n)), tight.notes.join("\n"));
  assert.ok(tight.notes.some((n) => /called a binary different from itself/.test(n)));
  assert.ok(checkCalibration(cal, { ...host, pin: "0-3" }, { resolution: 0.05, runs: 6, modes: ["default"] }).notes[0]!.includes("another host setup"));
  assert.equal(checkCalibration(null, host, { resolution: 0.05, runs: 6, modes: ["default"] }).ref, null);

  const saved = process.env.PARALLAX_CONFIG_DIR;
  process.env.PARALLAX_CONFIG_DIR = mkdtempSync(join(tmpdir(), "parallax-config-"));
  try {
    assert.equal(loadCalibration("cli-bench"), null);
    saveCalibration(cal);
    assert.deepEqual(loadCalibration("cli-bench"), cal);
    assert.equal(loadCalibration("lsp-bench"), null);
  } finally {
    if (saved === undefined) delete process.env.PARALLAX_CONFIG_DIR;
    else process.env.PARALLAX_CONFIG_DIR = saved;
  }
});

test("calibration: the A/A twin of a side spec", () => {
  assert.equal(twinSpec("go:tsc7=/b/tsc"), "go.aa:tsc7=/b/tsc");
  assert.equal(twinSpec("tsc7=/b/tsc"), "tsc7.aa:tsc7=/b/tsc");
  assert.throws(() => twinSpec("C:\\no\\such.json=C:\\b\\tsc.exe"), /no profile/, "a drive letter is not a label");
});

test("editor scenarios: exported names, import candidates, the error line, Theil-Sen", () => {
  const other = "export interface Thing { a: 1 }\nexport const valueOne = 1;\nexport async function loadAll() {}\nconst hidden = 2;\nexport default 3;\n";
  assert.deepEqual(exportedNames(other), ["Thing", "valueOne", "loadAll"]);
  assert.deepEqual(importCandidates("const x: Thing = 1;", [other, "export class Widget {}\n"], 3), ["valueOne", "Widget", "loadAll"]);
  assert.deepEqual(importCandidates("", [], 3), []);
  assert.match(errorLine(2), /^\nconst parallaxError2: number = "/);
  assert.equal(theilSen([[0, 0], [1, 10], [2, 20], [3, 30], [4, 1000]]), 10, "one outlier moves it little");
  assert.equal(theilSen([[0, 5]]), null);
});

test("lsp summary: sessions from before a metric existed keep their summary shape", () => {
  const idle = { waitedMs: 1000, busyCores: 0.2, pressure: null, timedOut: false, uptimeS: 9999, bootSettleWaitedMs: 0 };
  const win = { wallMs: 1000, machineCpuMs: 0, machineCores: 0, selfCpuMs: 0, pressure: null };
  const records: (SessionRecord | RoundRecord)[] = [];
  for (let round = 1; round <= 3; round++) {
    records.push({ type: "round", round, attempt: 1, order: ["ref", "cand"], idle, canaryBeforeMs: 20, canaryAfterMs: 20, window: win, outsideCores: 0, rejected: [] });
    for (const [side, ms] of [["ref", 10], ["cand", 8]] as const)
      records.push({
        type: "session", side, role: side, round, attempt: 1, warmup: false, startedAt: "", outcome: "clean",
        exit: { code: 0, signal: null }, shutdownClean: true, crashSignals: [], durationMs: 1, cpuMs: null,
        // An old session: two metrics, no errfix or import counts.
        metrics: { "open.firstDiagnosticsMs": ms, "service.keyP50Ms": null } as unknown as SessionRecord["metrics"],
        counts: { requests: 1, errors: 0, cancelled: 0, keys: 0, lagP95Ms: null }, file: "",
      });
  }
  const s = summarizeLspBench({
    records,
    sides: [{ label: "ref", role: "ref" }, { label: "cand", role: "cand" }],
    plannedRounds: 3, minRounds: 3, gates: { maxOutsideCores: null, maxCanaryDrift: null }, usage: "none", memory: null,
  });
  assert.deepEqual(Object.keys(s.sides[0]!.metrics), ["open.firstDiagnosticsMs", "service.keyP50Ms"]);
  assert.deepEqual(Object.keys(s.candidates[0]!.metrics), ["open.firstDiagnosticsMs", "service.keyP50Ms"]);
  assert.equal("errfixMissed" in s.sides[0]!, false);
});

test("imports: only an add-import action counts as the fix", () => {
  const answer = (result: unknown) => ({ id: 1, method: "textDocument/codeAction", raw: "", result, ms: 1, start: 0, end: 1, bytes: 1 });
  assert.equal(importAction(answer([])), null);
  assert.equal(importAction(answer(null)), null);
  assert.equal(importAction(answer([{ title: "Remove unused declaration", kind: "quickfix", edit: {} }])), null);
  assert.equal(importAction(answer([{ title: "Add import", command: "x" }])), null, "a bare command is not an action");
  assert.deepEqual(importAction(answer([{ title: "Ignore" }, { title: 'Add import from "./b"', data: 1 }])), { title: 'Add import from "./b"', data: 1 });
});
