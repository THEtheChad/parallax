// End to end: `lsp-bench` against the fake server, through profiles, into a bundle.
//
// Gates are opened wide (see bench.e2e.test.ts): what is under test is the session driver and the
// bookkeeping. The fake servers spend CPU per request from a queue, one at a time, so the slow one
// builds a queue while typing and the quick one does not.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lspBench, readLspBenchBundle, summarizeLspBenchBundle } from "../src/commands/lspBench.ts";
import { usageBackend } from "../src/host/serverUsage.ts";

const here = dirname(fileURLToPath(import.meta.url));
// No stored calibration from this machine leaks into the bundles under test.
process.env.PARALLAX_CONFIG_DIR = mkdtempSync(join(tmpdir(), "parallax-config-"));
const fake = join(here, "fixtures/fake-server.ts");
const side = (name: string, label?: string): string => `${label ? `${label}:` : ""}${join(here, "fixtures/profiles", `${name}.json`)}=${fake}`;
const quiet = (): void => {};
const open = { idle: { maxBusyCores: Infinity, bootSettleS: 0, windowMs: 100 }, gates: { maxOutsideCores: Infinity, maxCanaryDrift: Infinity } };

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "parallax-lspbench-proj-"));
  mkdirSync(join(root, "src"));
  const body = (n: number): string =>
    `export interface Thing${n} { name: string; size: number }\n` +
    Array.from({ length: 12 }, (_, i) => `export const value${n}_${i} = (t: Thing${n}) => t.name.length + t.size * ${i};\n`).join("");
  for (const f of ["a.ts", "b.tsx", "c.ts"]) writeFileSync(join(root, "src", f), body(f.length));
  return root;
}

const readJsonl = (path: string): Record<string, any>[] =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("lsp-bench: open, edit and open-loop typing timed per round; a queueing server loses by its queue", async () => {
  const { dir, bundle, summary } = await lspBench({
    project: makeProject(),
    out: join(mkdtempSync(join(tmpdir(), "parallax-lspbench-")), "b"),
    ref: side("fake-lsp-slow", "slow"),
    cands: [side("fake-lsp-quick", "quick")],
    edits: 4,
    lines: 1,
    intervalMs: 30,
    pausedLines: 1,
    pauseMs: 5,
    errfixes: 2,
    imports: 2,
    longEdits: 12,
    threads: ["default"],
    runs: 5,
    maxRuns: 5,
    minRounds: 3,
    warmup: 1,
    attempts: 1,
    log: quiet,
    ...open,
  });
  assert.equal(bundle.status, "complete");
  assert.deepEqual(bundle.session.files, ["src/a.ts", "src/b.tsx", "src/c.ts"]);
  assert.equal(summary.rounds.accepted, 5);

  const records = readJsonl(join(dir, "samples.jsonl"));
  const sessions = records.filter((r) => r.type === "session");
  assert.equal(sessions.length, 12, "a warm-up and five rounds per side");
  assert.deepEqual(records.filter((r) => r.type === "round").map((r) => r.order[0]), ["slow", "quick", "slow", "quick", "slow"], "order alternates");

  // Every request of a session is on disk, typing requests with the time their key was due.
  const log = readJsonl(join(dir, "runs/slow.1.1.jsonl"));
  assert.equal(log[0]!.type, "start");
  assert.equal(log.at(-1)!.type, "end");
  const typing = log.filter((r) => r.type === "request" && r.phase === "typing");
  assert.ok(typing.every((r) => r.answered >= r.due && r.sent >= r.due));
  assert.ok(typing.some((r) => r.cancelled), "the slow server's queue gets requests cancelled");
  assert.equal(log.filter((r) => r.type === "request" && r.phase === "edit").length, 4 * 3);
  // The service phase: one request at a time, nothing cancelled, each sent after the previous answer.
  const service = log.filter((r) => r.type === "request" && r.phase === "service");
  assert.ok(service.length > 0 && service.every((r) => !r.cancelled));
  for (let i = 1; i < service.length; i++) assert.ok(service[i]!.sent >= service[i - 1]!.answered, "closed loop");

  // The editor scenarios: an error shown and cleared, cross-file names completed and fixed, a long run
  // of edits; the paused phase's keys each come after the pause.
  const phase = (p: string) => log.filter((r) => r.type === "request" && r.phase === p);
  assert.equal(phase("errfix").length, 2 * 2);
  assert.deepEqual(phase("imports").map((r) => r.kind), ["completion", "diagnostic", "quickFix", "completion", "diagnostic", "quickFix"]);
  assert.equal(phase("long").filter((r) => r.kind === "diagnostic").length, 12);
  assert.ok(phase("paused").length > 0);
  const end = log.at(-1)!;
  assert.equal(end.counts.errfixMissed, 0, "the fake reports the inserted error");
  assert.deepEqual([end.counts.importNames, end.counts.importsMissed], [2, 0]);

  const [quick] = summary.candidates;
  assert.equal(quick!.state, "measured");
  // 8 ms per request plus 30 ms per update against 1 and 3.
  assert.equal(quick!.metrics["edit.firstRequestMs"]!.call, "faster");
  assert.equal(quick!.metrics["typing.completionP95Ms"]!.call, "faster");
  assert.equal(quick!.metrics["service.keyP50Ms"]!.call, "faster");
  const slow = summary.sides.find((s) => s.label === "slow")!;
  assert.ok(slow.metrics["edit.firstRequestMs"]!.estimate >= 30, "the first request after an edit pays for the update");
  assert.ok(slow.metrics["edit.secondRequestMs"]!.estimate < slow.metrics["edit.firstRequestMs"]!.estimate);
  // A key's requests one after another: the update (30 ms) plus 8 ms per request at least.
  assert.ok(slow.metrics["service.keyP50Ms"]!.estimate >= 38, `service per key ${slow.metrics["service.keyP50Ms"]!.estimate}`);
  if (usageBackend() !== "none") {
    assert.ok(slow.metrics["edit.cpuPerEditMs"]!.estimate >= 25, `cpu per edit ${slow.metrics["edit.cpuPerEditMs"]!.estimate}`);
    assert.ok(slow.metrics["session.memoryBytes"]!.estimate > 1 << 20);
  } else {
    assert.equal(slow.metrics["edit.cpuPerEditMs"], null);
  }
  assert.equal(slow.errors, 0);
  assert.ok(slow.metrics["errfix.errorDiagnosticsMs"]!.estimate > 0);
  assert.ok(slow.metrics["imports.quickFixMs"]!.estimate > 0);
  assert.equal(quick!.metrics["paused.keyP50Ms"]!.call, "faster");
  // Growth and drift are per-server figures, never compared.
  assert.equal(quick!.metrics["long.memoryGrowthPerEditBytes"], undefined);
  assert.ok(slow.metrics["long.latencyDrift"]!.estimate > 0);
  if (usageBackend() !== "none") assert.notEqual(slow.metrics["long.memoryGrowthPerEditBytes"], null);

  // The summary is a pure function of samples.jsonl.
  assert.deepEqual(summarizeLspBenchBundle(dir, readLspBenchBundle(dir)), summary);
});

test("lsp-bench: a server that crashes mid-session fails its candidate", async () => {
  const { summary } = await lspBench({
    project: makeProject(),
    out: join(mkdtempSync(join(tmpdir(), "parallax-lspbench-")), "b"),
    ref: side("fake-lsp-quick", "ref"),
    cands: [side("fake-lsp-crash", "crash")],
    edits: 4,
    lines: 1,
    intervalMs: 20,
    pausedLines: 0,
    errfixes: 0,
    imports: 0,
    longEdits: 0,
    threads: ["default"],
    runs: 1,
    maxRuns: 1,
    minRounds: 1,
    warmup: 0,
    attempts: 1,
    log: quiet,
    ...open,
  });
  assert.equal(summary.candidates[0]!.state, "failed");
  assert.equal(summary.sides.find((s) => s.label === "crash")!.outcomes.crash, 1);
  assert.equal(summary.rounds.failed, 1);
  assert.equal(summary.clean, false);
});

test("lsp-bench: a server that defers the add-import edit to codeAction/resolve pays for the resolve", async () => {
  const { dir, summary } = await lspBench({
    project: makeProject(),
    out: join(mkdtempSync(join(tmpdir(), "parallax-lspbench-")), "b"),
    ref: side("fake-lsp-quick", "eager"),
    cands: [side("fake-lsp-defer", "defer")],
    edits: 0,
    lines: 0,
    serviceLines: 0,
    pausedLines: 0,
    errfixes: 0,
    imports: 2,
    longEdits: 0,
    threads: ["default"],
    runs: 1,
    maxRuns: 1,
    minRounds: 1,
    warmup: 0,
    attempts: 1,
    log: quiet,
    ...open,
  });
  const kinds = (label: string) => readJsonl(join(dir, `runs/${label}.1.1.jsonl`)).filter((r) => r.phase === "imports").map((r) => r.kind);
  assert.deepEqual(kinds("eager"), ["completion", "diagnostic", "quickFix", "completion", "diagnostic", "quickFix"]);
  assert.deepEqual(kinds("defer"), ["completion", "diagnostic", "quickFix", "quickFixResolve", "completion", "diagnostic", "quickFix", "quickFixResolve"]);
  for (const s of summary.sides) {
    assert.equal(s.importsMissed, 0);
    assert.ok(s.metrics["imports.quickFixMs"]!.estimate > 0);
    assert.ok(s.metrics["imports.completionMs"]!.estimate > 0, "the completions offered the names");
  }
});

test("lsp-bench: a server that does not support code actions gets no fix figure, not a fast one", async () => {
  const { summary } = await lspBench({
    project: makeProject(),
    out: join(mkdtempSync(join(tmpdir(), "parallax-lspbench-")), "b"),
    ref: side("fake-lsp-quick", "full"),
    cands: [side("fake-lsp-noactions", "partial")],
    edits: 0,
    lines: 0,
    serviceLines: 0,
    pausedLines: 0,
    errfixes: 0,
    imports: 2,
    longEdits: 0,
    threads: ["default"],
    runs: 1,
    maxRuns: 1,
    minRounds: 1,
    warmup: 0,
    attempts: 1,
    log: quiet,
    ...open,
  });
  const partial = summary.sides.find((s) => s.label === "partial")!;
  assert.equal(partial.importsMissed, 2);
  assert.equal(partial.errors, 2);
  assert.equal(partial.metrics["imports.quickFixMs"], null);
  assert.equal(summary.candidates[0]!.metrics["imports.quickFixMs"]!.ratio, null);
  assert.equal(summary.candidates[0]!.metrics["imports.quickFixMs"]!.call, null);
});
