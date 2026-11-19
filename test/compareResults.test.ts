// Comparing two saved runs (compare-results) and the --fail-on policy: the two-sample statistics on
// values whose answer is known, runs built from synthetic records, and one real-shaped result made
// by bench and publish.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bench } from "../src/commands/bench.ts";
import { CompareError, compareResults, type Comparison } from "../src/commands/compareResults.ts";
import { publish } from "../src/commands/publish.ts";
import { renderComparison } from "../src/report/compareResults.ts";
import type { LspBenchSummary } from "../src/timing/lspSummary.ts";
import { evaluateBenchPolicy, evaluateLspPolicy, exitStatus, parsePolicy, PolicyError, renderDecision } from "../src/timing/policy.ts";
import { mannWhitneyCdf, ratioShift, shiftInterval } from "../src/timing/shift.ts";
import { DEFAULT_GATES, summarizeBench, type RoundRecord, type SampleRecord } from "../src/timing/summary.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../src/cli.ts");
process.env.PARALLAX_CONFIG_DIR = mkdtempSync(join(tmpdir(), "parallax-config-"));
const scratch = mkdtempSync(join(tmpdir(), "parallax-compare-"));

// Every assignment of m old and n new values to ranks, counted: the exact distribution, the slow way.
function bruteCdf(m: number, n: number): number[] {
  const counts = new Array<number>(m * n + 1).fill(0);
  const total = m + n;
  for (let mask = 0; mask < 1 << total; mask++) {
    let ones = 0;
    for (let b = 0; b < total; b++) if (mask & (1 << b)) ones++;
    if (ones !== m) continue;
    // U: pairs (old at rank i, new at rank j) with the new one smaller.
    let u = 0;
    let news = 0;
    for (let b = 0; b < total; b++) {
      if (mask & (1 << b)) u += news;
      else news++;
    }
    counts[u]!++;
  }
  const all = counts.reduce((a, b) => a + b, 0);
  let sum = 0;
  return counts.map((c) => (sum += c) / all);
}

test("the Mann-Whitney distribution is exact", () => {
  assert.deepEqual(mannWhitneyCdf(2, 2).map((x) => x * 6), [1, 2, 4, 5, 6]);
  for (const [m, n] of [[3, 3], [4, 5], [6, 6], [2, 7]] as const) {
    const fast = mannWhitneyCdf(m, n);
    const slow = bruteCdf(m, n);
    assert.equal(fast.length, slow.length);
    fast.forEach((x, i) => assert.ok(Math.abs(x - slow[i]!) < 1e-12, `${m}x${n} at ${i}: ${x} vs ${slow[i]}`));
  }
  // Large samples stay finite and end at 1.
  const big = mannWhitneyCdf(40, 40);
  assert.ok(Math.abs(big.at(-1)! - 1) < 1e-12 && big[0]! > 0 && big[0]! < 1e-20);
});

test("Hodges-Lehmann shift: identical samples, a known shift, and too few values", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const same = shiftInterval(xs, xs)!;
  assert.equal(same.estimate, 0);
  assert.ok(same.low < 0 && same.high > 0);
  assert.ok(same.confidence >= 0.95);
  const moved = shiftInterval(xs, xs.map((x) => x + 20))!;
  assert.equal(moved.estimate, 20);
  assert.ok(moved.low > 0, "a shift larger than the spread excludes 0");
  // 3 against 3: the whole range covers 1 - 2/20 = 90%, short of 95%.
  const few = shiftInterval([1, 2, 3], [1, 2, 3])!;
  assert.equal(few.confidence, 0.9);
  assert.equal(few.low, -2);
  assert.equal(few.high, 2);
  // On ratios, a factor: 1.2x the old ratios is a ratio of ratios of 1.2.
  const r = ratioShift([0.5, 0.51, 0.49, 0.5, 0.505, 0.495], [0.6, 0.612, 0.588, 0.6, 0.606, 0.594])!;
  assert.ok(Math.abs(r.estimate - 1.2) < 1e-9);
  assert.equal(ratioShift([0.5, 0], [0.5, 0.5]), null, "a zero ratio has no log");
});

// A result file (parallax.result/1) from synthetic rounds: per round, the reference's and the
// candidate's wall time.
interface Fake {
  rounds: { ref: number; cand: number }[];
  machine?: string;
  commit?: string;
  candSha?: string;
  candLabel?: string;
  harness?: string;
}
let files = 0;
function resultFile(f: Fake): string {
  const win = { wallMs: 100, machineCpuMs: 100, machineCores: 1, selfCpuMs: 0, pressure: null };
  const candLabel = f.candLabel ?? "cand";
  const records: (SampleRecord | RoundRecord)[] = [];
  const sample = (side: string, role: "ref" | "cand", round: number, wallMs: number): SampleRecord => ({
    type: "sample",
    side,
    role,
    round,
    attempt: 1,
    warmup: false,
    startedAt: "",
    wallMs,
    drainMs: wallMs,
    exit: { code: 0, signal: null },
    timedOut: false,
    crashSignals: [],
    stdoutSha256: "same",
    stderrSha256: "",
    outputLines: 0,
    cpuMs: null,
    userMs: null,
    sysMs: null,
    adoptedCpuMs: null,
    adopted: null,
    maxRssBytes: null,
    window: win,
    outsideCores: 0,
  });
  f.rounds.forEach((r, i) => {
    records.push(sample("ref", "ref", i + 1, r.ref), sample(candLabel, "cand", i + 1, r.cand));
    records.push({ type: "round", round: i + 1, attempt: 1, order: ["ref", candLabel], idle: { timedOut: false } as RoundRecord["idle"], canaryBeforeMs: 20, canaryAfterMs: 20, window: win, outsideCores: 0, rejected: [] });
  });
  const side = (label: string, role: "ref" | "cand", sha: string) => ({ label, role, mode: "default", base: label, binSha256: sha, version: `${label} 1.0`, profile: label });
  const result = {
    schema: "parallax.result/1",
    kind: "cli-bench",
    id: `fake${files}`,
    publishedAt: "2026-11-18T00:00:00.000Z",
    machine: { id: f.machine ?? "machine-a" },
    project: { name: "proj", suite: true, repository: "https://example.com/proj", commit: f.commit ?? "a".repeat(40), clean: true },
    harness: { name: "parallax", version: "0.0.0", gitCommit: f.harness ?? "h".repeat(40), gitDirty: false, node: "v24" },
    host: { cpuModel: "Test CPU", accounting: "none" },
    corpus: {},
    settings: { config: "tsconfig.json", threads: ["default"], runs: f.rounds.length, maxRuns: f.rounds.length, minRounds: 3, resolution: 0.05, resolutionMs: 1, gates: DEFAULT_GATES },
    canary: { version: "1", size: 1 },
    sides: [side("ref", "ref", "r".repeat(64)), side(candLabel, "cand", f.candSha ?? "c".repeat(64))],
    notes: [],
    createdAt: "2026-11-18T00:00:00.000Z",
    finishedAt: "2026-11-18T00:01:00.000Z",
    records,
    summary: null,
  };
  const file = join(scratch, `result-${files++}.json`);
  writeFileSync(file, JSON.stringify(result));
  return file;
}

// Ratios near 0.5 with ±0.4% spread, a reference near 200 ms that drifts between rounds (the in-run
// ratio cancels it).
const steady = (n: number, factor = 1, refScale = 1): { ref: number; cand: number }[] =>
  Array.from({ length: n }, (_, i) => {
    const ref = (200 + ((i * 7) % 5) * 3) * refScale;
    return { ref, cand: ref * 0.5 * factor * (1 + (((i * 3) % 5) - 2) * 0.002) };
  });

test("compare-results: identical runs are the same; a 20% slowdown is worse; three rounds are too few", () => {
  const old = resultFile({ rounds: steady(9) });
  const same = compareResults(old, resultFile({ rounds: steady(9, 1, 1.3) }));
  assert.equal(same.rows.length, 1);
  assert.equal(same.rows[0]!.call, "same");
  assert.ok(Math.abs(same.rows[0]!.shift!.estimate - 1) < 0.005, "a machine 30% slower overall does not move the ratio");
  assert.equal(same.sameMachine, true);
  assert.ok(Math.abs(same.rows[0]!.absolute!.estimate - 1.3) < 0.02, "the absolute figure does move, and is shown on the same machine");
  assert.deepEqual(same.warnings, []);

  const worse = compareResults(old, resultFile({ rounds: steady(9, 1.2) }), { policy: parsePolicy({ failOn: "worse" }, "compare-cli-bench") });
  const row = worse.rows[0]!;
  assert.equal(row.call, "worse");
  assert.ok(Math.abs(row.shift!.estimate - 1.2) < 0.01 && row.shift!.low > 1.15, `${row.shift!.estimate} (${row.shift!.low}..${row.shift!.high})`);
  assert.equal(worse.policy!.passed, false);
  assert.equal(exitStatus(true, worse.policy), 3);
  assert.match(renderComparison(worse), /worse/);
  assert.match(renderDecision(worse.policy!), /worse +cand: wall worse: 1\.20x/);

  const better = compareResults(old, resultFile({ rounds: steady(9, 0.8) }));
  assert.equal(better.rows[0]!.call, "better");

  const few = compareResults(resultFile({ rounds: steady(3) }), resultFile({ rounds: steady(3) }), { policy: parsePolicy({ failOn: "worse,unresolved" }, "compare-cli-bench") });
  assert.equal(few.rows[0]!.call, "too few rounds");
  assert.equal(few.rows[0]!.shift!.confidence, 0.9);
  assert.equal(few.policy!.failures[0]!.condition, "unresolved");

  // A threshold: a sure 20% slowdown fails at 1.10, not at 1.30.
  assert.equal(compareResults(old, resultFile({ rounds: steady(9, 1.2) }), { policy: parsePolicy({ failOn: "worse", threshold: "1.10" }, "compare-cli-bench") }).policy!.passed, false);
  assert.equal(compareResults(old, resultFile({ rounds: steady(9, 1.2) }), { policy: parsePolicy({ failOn: "worse", threshold: "1.30" }, "compare-cli-bench") }).policy!.passed, true);
});

test("compare-results: refuses another project, warns on another machine, harness or binary, lists unmatched sides", () => {
  const old = resultFile({ rounds: steady(9) });
  assert.throws(() => compareResults(old, resultFile({ rounds: steady(9), commit: "b".repeat(40) })), (e: unknown) => e instanceof CompareError && /different projects.*--allow-project-change/.test(e.message));
  const allowed = compareResults(old, resultFile({ rounds: steady(9), commit: "b".repeat(40) }), { allowProjectChange: true });
  assert.match(allowed.warnings.join("\n"), /different projects/);

  const other = compareResults(old, resultFile({ rounds: steady(9), machine: "machine-b", harness: "g".repeat(40), candSha: "d".repeat(64) }));
  assert.equal(other.sameMachine, false);
  assert.equal(other.rows[0]!.absolute, null, "no absolute times across machines");
  const w = other.warnings.join("\n");
  assert.match(w, /different machines/);
  assert.match(w, /different harness commits/);
  assert.match(w, /candidate cand binary changed \(sha256 cccccccccccc -> dddddddddddd\)/);
  assert.doesNotMatch(renderComparison(other), /same machine\)/);

  assert.throws(() => compareResults(old, resultFile({ rounds: steady(9), candLabel: "renamed" })), /no candidate in common/);
});

test("compare-results: a real-shaped result (bench, then publish) against itself and against its bundle", async () => {
  const project = mkdtempSync(join(tmpdir(), "parallax-compare-proj-"));
  writeFileSync(join(project, "tsconfig.json"), "{}\n");
  const fake = join(here, "fixtures/fake-check.ts");
  const side = (name: string): string => `${join(here, "fixtures/profiles", `${name}.json`)}=${fake}`;
  const { dir } = await bench({
    project,
    out: join(scratch, "bundle"),
    ref: side("fake-check-ref"),
    cands: [side("fake-check-fast"), side("fake-check-other")],
    threads: ["default"],
    runs: 4,
    maxRuns: 4,
    minRounds: 3,
    warmup: 0,
    attempts: 1,
    counterRuns: 0,
    idle: { maxBusyCores: Infinity, bootSettleS: 0, windowMs: 100 },
    gates: { maxOutsideCores: Infinity, maxCanaryDrift: Infinity },
    log: () => {},
  });
  const { file } = publish({ bundleDir: dir, out: join(scratch, "results"), allowDirty: true, log: () => {} });
  const c: Comparison = compareResults(file, file);
  assert.equal(c.kind, "cli-bench");
  assert.deepEqual(c.rows.map((r) => r.label), ["fake-check-fast", "fake-check-other"]);
  assert.equal(c.comparisons, 2);
  assert.ok(Math.abs(c.perComparison - 0.975) < 1e-12, "Bonferroni over two comparisons");
  for (const r of c.rows) assert.equal(r.shift!.estimate, 1);
  // The bundle and its result hold the same rounds.
  const mixed = compareResults(dir, file);
  assert.deepEqual(mixed.rows.map((r) => r.shift!.estimate), [1, 1]);
  assert.equal(mixed.sameMachine, null);

  // Through the CLI: JSON on stdout, exit 0; a refused pair exits 2.
  const json = spawnSync(process.execPath, [cli, "compare-results", file, dir, "--format", "json", "--fail-on", "worse"], { encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout) as Comparison;
  assert.equal(parsed.schema, "parallax.comparison/1");
  assert.equal(parsed.policy!.passed, true);
  const refused = spawnSync(process.execPath, [cli, "compare-results", file, resultFile({ rounds: steady(9), commit: "b".repeat(40) })], { encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /cli-bench|different projects/);
  const csv = spawnSync(process.execPath, [cli, "compare-results", file, file, "--format", "csv"], { encoding: "utf8" });
  assert.equal(csv.status, 0, csv.stderr);
  assert.match(csv.stdout.split("\n")[0]!, /^candidate,mode,ref_old,ref_new,metric,unit,state,/);
  assert.equal(csv.stdout.trim().split("\n").length, 3, "a header and one row per candidate");
  const md = spawnSync(process.execPath, [cli, "compare-results", file, file, "--format", "md"], { encoding: "utf8" });
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /^## compare-results: /);
  assert.match(md.stdout, /\| candidate \| vs \|/);
  assert.equal(spawnSync(process.execPath, [cli, "compare-results", file, file, "--format", "html"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [cli, "compare-results", file, file, "--metrics", "edit.diagnosticsMs"], { encoding: "utf8" }).status, 2, "a CLI bench has no lsp metrics");

  // --fail-on through bench-summary: fake-check-other's output differs from the reference's.
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "bench-summary", dir, ...args], { encoding: "utf8" });
  assert.equal(run().status, 0, "without a policy nothing changes");
  const output = run("--fail-on", "output");
  assert.equal(output.status, 3);
  assert.match(output.stderr, /output +fake-check-other: output DIFFERENT/);
  assert.doesNotMatch(output.stdout, /policy/, "the decision goes to stderr; stdout stays the report");
  assert.equal(run("--fail-on", "slower").status, 0, "both candidates are faster");
  assert.equal(run("--fail-on", "nope").status, 2);
  assert.equal(run("--fail-metrics", "edit.diagnosticsMs").status, 2, "--fail-metrics needs --fail-on (and lsp-bench)");
});

// A bench summary from rounds of (reference, candidate) wall times, as timing.test.ts builds them.
function benchSummary(rounds: { ref: number; cand: number; output?: string }[]) {
  const records: (SampleRecord | RoundRecord)[] = [];
  const win = { wallMs: 100, machineCpuMs: 100, machineCores: 1, selfCpuMs: 0, pressure: null };
  rounds.forEach((r, i) => {
    for (const [side, role, wallMs] of [["ref", "ref", r.ref], ["cand", "cand", r.cand]] as const)
      records.push({ type: "sample", side, role, round: i + 1, attempt: 1, warmup: false, startedAt: "", wallMs, drainMs: wallMs, exit: { code: 0, signal: null }, timedOut: false, crashSignals: [], stdoutSha256: side === "cand" && r.output ? r.output : "same", stderrSha256: "", outputLines: 0, cpuMs: null, userMs: null, sysMs: null, adoptedCpuMs: null, adopted: null, maxRssBytes: null, window: win, outsideCores: 0 });
    records.push({ type: "round", round: i + 1, attempt: 1, order: ["ref", "cand"], idle: { timedOut: false } as RoundRecord["idle"], canaryBeforeMs: 20, canaryAfterMs: 20, window: win, outsideCores: 0, rejected: [] });
  });
  return summarizeBench({ records, sides: [{ label: "ref", role: "ref" }, { label: "cand", role: "cand" }], plannedRounds: rounds.length, minRounds: 3, gates: DEFAULT_GATES, accounting: "none" });
}

test("--fail-on for a bench: slower (with a threshold), output, unresolved; the exit matrix", () => {
  const slower = benchSummary(Array.from({ length: 6 }, (_, i) => ({ ref: 100, cand: 115 + i })));
  assert.equal(slower.candidates[0]!.call, "slower");
  assert.equal(slower.clean, true);
  const failOn = (text: string, threshold?: string) => parsePolicy({ failOn: text, threshold }, "cli-bench")!;
  assert.equal(evaluateBenchPolicy(slower, failOn("slower")).passed, false);
  assert.equal(evaluateBenchPolicy(slower, failOn("slower", "1.10")).passed, false, "115%..120%: all above 1.10");
  assert.equal(evaluateBenchPolicy(slower, failOn("slower", "1.20")).passed, true, "not all above 1.20");
  assert.equal(evaluateBenchPolicy(slower, failOn("output")).passed, true);

  const different = benchSummary(Array.from({ length: 6 }, () => ({ ref: 100, cand: 50, output: "other" })));
  assert.equal(different.clean, true, "a different output is measured cleanly");
  const d = evaluateBenchPolicy(different, failOn("output,slower"));
  assert.deepEqual(d.failures.map((f) => [f.condition, f.candidate]), [["output", "cand"]]);

  const noisy = benchSummary([{ ref: 100, cand: 50 }, { ref: 100, cand: 50 }]);
  assert.equal(noisy.clean, false);
  const unresolved = benchSummary(Array.from({ length: 6 }, (_, i) => ({ ref: 100, cand: i % 2 ? 90 : 110 })));
  assert.equal(unresolved.candidates[0]!.call, "unresolved");
  const u = evaluateBenchPolicy(unresolved, failOn("unresolved"));
  assert.equal(u.failures[0]!.condition, "unresolved");

  // 0 passed, 3 failed, 1 not clean whatever the policy says; no policy: as before.
  assert.equal(exitStatus(true, evaluateBenchPolicy(slower, failOn("output"))), 0);
  assert.equal(exitStatus(true, u), 3);
  assert.equal(exitStatus(false, evaluateBenchPolicy(noisy, failOn("unresolved"))), 1);
  assert.match(renderDecision(evaluateBenchPolicy(noisy, failOn("unresolved")), false), /exit 1/);
  assert.equal(exitStatus(true, null), 0);
  assert.equal(exitStatus(false, null), 1);
});

test("--fail-on for an lsp-bench: metrics narrowed and validated; output refused", () => {
  const iv = (estimate: number, low: number, high: number) => ({ estimate, low, high, confidence: 0.95, n: 6 });
  const summary = {
    candidates: [
      {
        label: "cand",
        ref: "ref",
        mode: "default",
        state: "measured",
        metrics: {
          "edit.diagnosticsMs": { ratio: iv(1.3, 1.2, 1.4), call: "slower", sameWithin: 0.05 },
          "typing.completionP50Ms": { ratio: iv(0.9, 0.8, 1.1), call: "unresolved", sameWithin: 0.05 },
        },
      },
    ],
  } as unknown as LspBenchSummary;
  const policy = (failOn: string, metrics?: string) => parsePolicy({ failOn, metrics }, "lsp-bench")!;
  assert.deepEqual(evaluateLspPolicy(summary, policy("slower,unresolved")).failures.map((f) => f.metric), ["edit.diagnosticsMs", "typing.completionP50Ms"]);
  assert.equal(evaluateLspPolicy(summary, policy("slower", "typing.completionP50Ms")).passed, true);
  assert.throws(() => parsePolicy({ failOn: "output" }, "lsp-bench"), (e: unknown) => e instanceof PolicyError && /lsp-diff/.test(e.message));
  assert.throws(() => parsePolicy({ failOn: "slower", metrics: "long.latencyDrift" }, "lsp-bench"), /uncompared metric "long.latencyDrift"/);
  assert.throws(() => parsePolicy({ failOn: "unresolved", threshold: "1.1" }, "lsp-bench"), /applies to --fail-on slower/);
  assert.throws(() => parsePolicy({ failOn: "slower", threshold: "0.9" }, "lsp-bench"), /at least 1/);
  assert.equal(parsePolicy({}, "lsp-bench"), null);
});

test("compare-results on lsp-bench runs: one row per metric, --metrics narrows the report and its family", () => {
  const win = { wallMs: 100, machineCpuMs: 100, machineCores: 1, selfCpuMs: 0, pressure: null };
  const lspFile = (diagnosticsFactor: number, rounds = 9): string => {
    const records: unknown[] = [];
    for (let i = 1; i <= rounds; i++) {
      const jitter = 1 + ((i % 3) - 1) * 0.003;
      for (const [side, role, f] of [["ref", "ref", 1], ["cand", "cand", 0.5 * jitter]] as const) {
        const diag = role === "cand" ? 40 * f * diagnosticsFactor : 40;
        records.push({ type: "session", side, role, round: i, attempt: 1, warmup: false, startedAt: "", outcome: "clean", exit: { code: 0, signal: null }, shutdownClean: true, crashSignals: [], durationMs: 1000, cpuMs: null,
          metrics: { "open.firstDiagnosticsMs": 300 * f, "edit.diagnosticsMs": diag, "long.latencyDrift": 1 }, counts: { requests: 10, errors: 0, cancelled: 0, lagP95Ms: null }, file: "" });
      }
      records.push({ type: "round", round: i, attempt: 1, order: ["ref", "cand"], idle: { timedOut: false }, canaryBeforeMs: 20, canaryAfterMs: 20, window: win, outsideCores: 0, rejected: [] });
    }
    const side = (label: string, role: string) => ({ label, role, mode: "default", base: label, binSha256: label, version: null, profile: label });
    const file = join(scratch, `lsp-${files++}.json`);
    writeFileSync(file, JSON.stringify({
      schema: "parallax.result/1", kind: "lsp-bench", id: "lsp", machine: { id: "m" },
      project: { name: "proj", suite: true, repository: "https://example.com/proj", commit: "a".repeat(40), clean: true },
      harness: { gitCommit: "h", gitDirty: false }, host: { usage: "none", memory: null, cpuModel: "x" }, corpus: {},
      settings: { threads: ["default"], runs: rounds, maxRuns: rounds, minRounds: 3, resolution: 0.05, resolutionMs: 1, gates: DEFAULT_GATES },
      session: { files: ["a.ts"], typed: "x" }, sides: [side("ref", "ref"), side("cand", "cand")], notes: [], createdAt: "2026-11-18T00:00:00Z", records,
    }));
    return file;
  };
  const old = lspFile(1);
  const c = compareResults(old, lspFile(1.25));
  // long.latencyDrift is never compared by ratio.
  assert.deepEqual(c.rows.map((r) => [r.metric, r.call]), [["open.firstDiagnosticsMs", "same"], ["edit.diagnosticsMs", "worse"]]);
  assert.equal(c.comparisons, 2);
  const narrow = compareResults(old, lspFile(1.25), { metrics: ["open.firstDiagnosticsMs"], policy: parsePolicy({ failOn: "worse" }, "compare-lsp-bench") });
  assert.deepEqual(narrow.rows.map((r) => r.metric), ["open.firstDiagnosticsMs"]);
  assert.equal(narrow.perComparison, 0.95, "one comparison: no correction");
  assert.equal(narrow.policy!.passed, true, "the slower metric is not in the report");
  assert.match(renderComparison(c), /cand vs ref\nmetric/);
});
