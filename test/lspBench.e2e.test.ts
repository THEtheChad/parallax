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
    threads: ["default"],
    runs: 5,
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
    threads: ["default"],
    runs: 1,
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
