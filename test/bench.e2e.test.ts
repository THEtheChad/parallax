// End to end: `bench` against the fake checker, through profiles, into a bundle.
//
// Gates are opened wide here: tests share the machine with other work, and what is under test is the
// bench's bookkeeping, not this machine's quietness. The pure tests in timing.test.ts cover the gates.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bench, readBenchBundle, summarizeBenchBundle } from "../src/commands/bench.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fixtures/fake-check.ts");
const side = (name: string, label?: string): string => `${label ? `${label}:` : ""}${join(here, "fixtures/profiles", `${name}.json`)}=${fake}`;
const quiet = (): void => {};
const open = { idle: { maxBusyCores: Infinity, bootSettleS: 0, windowMs: 100 }, gates: { maxOutsideCores: Infinity, maxCanaryDrift: Infinity } };

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "parallax-bench-proj-"));
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  return root;
}

test("bench: alternating rounds, paired ratios, outputs compared, every sample kept", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "parallax-bench-")), "b");
  const { dir, bundle, summary } = await bench({
    project: makeProject(),
    out,
    ref: side("fake-check-ref"),
    cands: [side("fake-check-fast"), side("fake-check-other")],
    runs: 3,
    minRounds: 3,
    warmup: 1,
    attempts: 1,
    log: quiet,
    ...open,
  });
  assert.equal(bundle.status, "complete");
  assert.deepEqual(bundle.sides.map((s) => s.checkCommand.slice(-2)), [["-p", "tsconfig.json"], ["-p", "tsconfig.json"], ["-p", "tsconfig.json"]]);
  const records = readFileSync(join(dir, "samples.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const rounds = records.filter((r) => r.type === "round");
  assert.deepEqual(rounds.map((r) => r.order[0]), ["fake-check-ref", "fake-check-other", "fake-check-ref"], "order alternates");
  assert.equal(records.filter((r) => r.type === "sample" && r.warmup).length, 3);

  assert.equal(summary.rounds.accepted, 3);
  const [fast, other] = summary.candidates;
  assert.equal(fast!.state, "measured");
  // 20 ms of work against 200 ms, plus Node's start-up on both sides.
  assert.ok(fast!.wallRatio!.estimate < 0.8, `ratio ${fast!.wallRatio!.estimate}`);
  assert.equal(fast!.call, "faster");
  const sides = Object.fromEntries(summary.sides.map((s) => [s.label, s]));
  assert.equal(sides["fake-check-fast"]!.outputMatchesRef, true);
  assert.equal(sides["fake-check-other"]!.outputMatchesRef, false);
  assert.deepEqual(sides["fake-check-ref"]!.exitCodes, [2], "a checker's error exit is not a failure");
  if (!bundle.host.accounting.startsWith("none")) {
    assert.ok(sides["fake-check-ref"]!.cpuMs!.estimate >= 150, "CPU of the child is accounted");
    assert.ok(sides["fake-check-ref"]!.maxRssBytes! > 1 << 20);
    assert.ok(other!.cpuRatio !== null);
  }
  // Every distinct output is kept once.
  assert.ok(readdirSync(join(dir, "outputs")).length >= 2);

  // The summary is a pure function of samples.jsonl; other gates can be applied afterwards.
  assert.deepEqual(summarizeBenchBundle(dir, readBenchBundle(dir)), summary);
  const strict = summarizeBenchBundle(dir, readBenchBundle(dir), { maxOutsideCores: Infinity, maxCanaryDrift: -1 });
  assert.equal(strict.rounds.accepted, 0);
  assert.equal(strict.candidates[0]!.state, "noisy");
});

test("bench: a worker its launcher never waits for is still accounted", async () => {
  const { bundle, summary } = await bench({
    project: makeProject(),
    out: join(mkdtempSync(join(tmpdir(), "parallax-bench-")), "b"),
    ref: side("fake-check-ref"),
    cands: [side("fake-check-launcher")],
    runs: 1,
    minRounds: 1,
    warmup: 0,
    attempts: 1,
    log: quiet,
    ...open,
  });
  const launcher = summary.sides.find((s) => s.label === "fake-check-launcher")!;
  if (bundle.host.accounting === "gnu-time+proc") {
    // `time` alone sees only the launcher's few milliseconds; the worker spun for 300 ms.
    assert.ok(launcher.cpuMs!.estimate >= 250, `cpu ${launcher.cpuMs!.estimate}`);
    assert.ok(launcher.maxRssBytes! > 20 << 20, "the worker's memory, not just the launcher's");
  } else {
    assert.equal(launcher.cpuMs, null, "unknown rather than the launcher's share alone");
  }
  assert.equal(launcher.outputMatchesRef, true);
});

test("bench: a crashing candidate is failed, and the CLI exits 1", () => {
  const cli = join(here, "../src/cli.ts");
  const out = join(mkdtempSync(join(tmpdir(), "parallax-bench-")), "b");
  const r = spawnSync(
    process.execPath,
    [cli, "bench", "--project", makeProject(), "--ref", side("fake-check-ref"), "--cand", side("fake-check-crash"), "--out", out,
      "--runs", "1", "--min-runs", "1", "--warmup", "0", "--boot-settle-s", "0", "--max-busy-cores", "1000", "--max-outside-cores", "1000", "--max-canary-drift", "1000"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /fake-check-crash\s+failed/);
  assert.equal(spawnSync(process.execPath, [cli, "bench-summary", out], { encoding: "utf8" }).status, 1);
  assert.equal(spawnSync(process.execPath, [cli, "bench", "--project", makeProject()], { encoding: "utf8" }).status, 2);
});
