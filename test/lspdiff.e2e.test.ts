// End to end: the session driver against the fake server, through profiles, into a bundle, compared.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readBundle, writeJsonAtomic } from "../src/bundle/bundle.ts";
import { lspDiff } from "../src/commands/lspDiff.ts";
import { compareBundle } from "../src/diff/compare.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fixtures/fake-server.ts");
const profile = (name: string): string => join(here, "fixtures/profiles", `${name}.json`);
const side = (name: string): string => `${profile(name)}=${fake}`;
const quiet = (): void => {};

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "parallax-proj-"));
  mkdirSync(join(root, "src"));
  const body = (n: number): string =>
    `export interface Thing${n} { name: string; size: number }\n` +
    Array.from({ length: 12 }, (_, i) => `export const value${n}_${i} = (t: Thing${n}) => t.name.length + t.size * ${i};\n`).join("") +
    `console.log(value${n}_1({ name: "x", size: 2 }).toFixed(1));\n`;
  writeFileSync(join(root, "src/a.ts"), body(1));
  writeFileSync(join(root, "src/b.tsx"), body(2));
  return root;
}

const readJsonl = (path: string): Record<string, any>[] =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("one bundle, four candidates: match, normalized, differ/only-ref, crash/not-reached", async () => {
  const root = makeProject();
  const out = join(mkdtempSync(join(tmpdir(), "parallax-bundle-")), "b");
  const { dir, bundle, summary } = await lspDiff({
    project: root,
    out,
    ref: side("fake-ref"),
    cands: [side("fake-same"), side("fake-lib"), side("fake-diff"), side("fake-crash")],
    files: 6,
    positions: 2,
    refRuns: 2,
    candRuns: 1,
    requestTimeoutMs: 20000,
    log: quiet,
  });
  assert.equal(bundle.status, "complete");
  assert.deepEqual(bundle.session.files, ["src/a.ts", "src/b.tsx"]);
  assert.deepEqual(
    bundle.runs.map((r) => r.id),
    ["fake-ref.1", "fake-same.1", "fake-lib.1", "fake-diff.1", "fake-crash.1", "fake-ref.2"],
  );
  assert.match(bundle.sides[0]!.binSha256, /^[0-9a-f]{64}$/);

  const byLabel = Object.fromEntries(summary.candidates.map((c) => [c.label, c]));
  const same = byLabel["fake-same"]!;
  assert.equal(same.totals.match, summary.requests);
  assert.equal(same.attention.length, 0);

  const lib = byLabel["fake-lib"]!;
  // definition + typeDefinition at every position point into the library.
  assert.ok(lib.byMethod["textDocument/definition"]!.normalized! > 0);
  assert.equal(lib.totals.differ, 0);
  assert.equal(lib.attention.length, 0);

  const diff = byLabel["fake-diff"]!;
  assert.equal(diff.totals.differ, 3, "the second hover, and prepareRename answering null in each file");
  assert.equal(diff.totals["only-ref"], 2, "one rename per file it never asked");
  const hover = diff.attention.find((a) => a.method === "textDocument/hover")!;
  const detail = JSON.parse(readFileSync(join(dir, hover.detail!), "utf8"));
  assert.equal(detail.paths.diffs[0].path, "$.result.contents.value");
  assert.equal(detail.paths.diffs[0].cand, "something else");
  assert.match(detail.paths.diffs[0].ref, /in file:\/\/<root>\/src\/a\.ts$/);

  const crash = byLabel["fake-crash"]!;
  assert.equal(crash.totals.match, 10);
  assert.equal(crash.totals["not-reached"], summary.requests - 10);
  const crashSession = summary.sessions.find((s) => s.run === "fake-crash.1")!;
  assert.equal(crashSession.outcome, "crash");
  assert.equal(summary.sessions.find((s) => s.run === "fake-ref.1")!.shutdownClean, true);
  assert.ok(crashSession.crashSignals!.some((s) => s.includes("panicked at")));
  assert.equal(summary.clean, false);

  // Run logs: start, initialize, one line per answer, end with the counts.
  const ref1 = readJsonl(join(dir, "runs/fake-ref.1.jsonl"));
  assert.deepEqual([ref1[0]!.type, ref1[1]!.type, ref1.at(-1)!.type], ["start", "initialize", "end"]);
  const end = ref1.at(-1)!;
  assert.equal(end.outcome, "clean");
  assert.equal(end.shutdownClean, true);
  assert.equal(end.serverRequests["workspace/configuration"], 1);
  assert.equal(end.notifications["textDocument/publishDiagnostics"], 2);
  assert.equal(ref1.filter((r) => r.type === "answer").length, summary.requests);

  // compare is a pure function of the bundle: rerunning it gives the same verdicts.
  const before = readFileSync(join(dir, "verdicts.jsonl"), "utf8");
  const again = await compareBundle(dir, readBundle(dir));
  assert.equal(readFileSync(join(dir, "verdicts.jsonl"), "utf8"), before);
  assert.deepEqual(again, summary);
});

test("reference instability is its own verdict, never a candidate difference", async () => {
  const root = makeProject();
  const out = join(mkdtempSync(join(tmpdir(), "parallax-bundle-")), "b");
  const { summary } = await lspDiff({
    project: root,
    out,
    ref: `ref:${profile("fake-unstable")}=${fake}`,
    cands: [`cand:${profile("fake-unstable")}=${fake}`],
    files: 6,
    positions: 2,
    refRuns: 2,
    candRuns: 1,
    log: quiet,
  });
  const c = summary.candidates[0]!;
  assert.equal(c.byMethod["textDocument/documentHighlight"]!["ref-unstable"], 4);
  assert.equal(c.totals.differ, 0);
  assert.equal(summary.refUnstable, 4);
});

test("huge answers stream to disk and compare without holding logs in memory", async () => {
  const root = makeProject();
  const out = join(mkdtempSync(join(tmpdir(), "parallax-bundle-")), "b");
  const { dir, summary } = await lspDiff({
    project: root,
    out,
    ref: `ref:${profile("fake-huge")}=${fake}`,
    cands: [`cand:${profile("fake-huge")}=${fake}`],
    files: 1,
    positions: 1,
    refRuns: 1,
    candRuns: 1,
    log: quiet,
  });
  // One ~25 MB completion answer, items in run-dependent order: still a match.
  const c = summary.candidates[0]!;
  assert.equal(c.totals.match, summary.requests);
  assert.ok(statSync(join(dir, "runs/ref.1.jsonl")).size > 20e6);
});

test("non-canonical numbers are differences (1.0 vs 1)", async () => {
  const base = mkdtempSync(join(tmpdir(), "parallax-bundle-"));
  const root = makeProject();
  const { dir } = await lspDiff({ project: root, out: join(base, "b"), ref: side("fake-ref"), cands: [side("fake-same")], files: 1, positions: 1, refRuns: 1, candRuns: 1, log: quiet });
  // Rewrite one candidate answer's number text by hand, then compare again.
  const runFile = join(dir, "runs/fake-same.1.jsonl");
  const lines = readFileSync(runFile, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes('"method":"textDocument/semanticTokens/full"'));
  assert.ok(i > 0 && lines[i]!.includes('"at":{"line":0,"character":0}'));
  lines[i] = lines[i]!.replace('"at":{"line":0,"character":0}', '"at":{"line":0,"character":0.0}');
  writeFileSync(runFile, lines.join("\n"));
  const s = await compareBundle(dir, readBundle(dir));
  assert.equal(s.candidates[0]!.totals.differ, 1);
});

test("CLI: exit 0 when clean, 1 with differences, 2 on usage errors", () => {
  const root = makeProject();
  const base = mkdtempSync(join(tmpdir(), "parallax-cli-"));
  const cli = join(here, "../src/cli.ts");
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  const common = ["--project", root, "--files", "1", "--positions", "1", "--ref", side("fake-ref")];
  const ok = run(["lsp-diff", ...common, "--cand", side("fake-same"), "--out", join(base, "ok")]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /CLEAN/);
  const bad = run(["lsp-diff", ...common, "--cand", side("fake-diff"), "--out", join(base, "bad")]);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stdout, /differ: src\/b\.tsx:\d+:\d+ prepareRename/);
  assert.equal(run(["summary", join(base, "bad")]).status, 1);
  assert.equal(run(["lsp-diff", "--project", root]).status, 2);
  assert.equal(run(["lsp-diff", ...common, "--cand", side("fake-same"), "--out", join(base, "ok")]).status, 2, "refuses a non-empty bundle dir");
  // A bundle records what compare needs; bundle.json stays valid JSON after compare rewrites it.
  const b = readBundle(join(base, "ok"));
  writeJsonAtomic(join(base, "ok", "bundle.json"), b);
  assert.ok(readdirSync(join(base, "ok", "runs")).includes("fake-same.1.stderr.log"));
});

test("reference evidence: an answer the same reference gave in a compatible bundle is a reference variant", async () => {
  const root = makeProject();
  const base = mkdtempSync(join(tmpdir(), "parallax-ev-"));
  const run = (out: string) =>
    lspDiff({ project: root, out: join(base, out), ref: side("fake-ref"), cands: [side("fake-diff")], files: 1, positions: 1, refRuns: 1, candRuns: 1, log: quiet });
  const { dir, summary } = await run("live");
  assert.equal(summary.candidates[0]!.totals.differ, 2);
  // Evidence: a second bundle in which the reference answered as the candidate did.
  const ev = (await run("ev")).dir;
  writeFileSync(join(ev, "runs/fake-ref.1.jsonl"), readFileSync(join(ev, "runs/fake-diff.1.jsonl")));
  const s = await compareBundle(dir, readBundle(dir), { refEvidence: [ev] });
  assert.deepEqual(s.refEvidence.map((e) => e.accepted), [true]);
  const c = s.candidates[0]!;
  assert.equal(c.totals.differ, 0);
  assert.equal(c.totals["ref-unstable"], 2);
  assert.equal(c.refUnstableMatchingARefRun, 2);
  assert.equal(s.refUnstableFromEvidence, 2);
  // Another reference binary: rejected, nothing changes.
  const b = readBundle(ev);
  b.sides[0]!.binSha256 = "0".repeat(64);
  writeJsonAtomic(join(ev, "bundle.json"), b);
  const r = await compareBundle(dir, readBundle(dir), { refEvidence: [ev] });
  assert.deepEqual(r.refEvidence.map((e) => e.reason), ["another reference binary"]);
  assert.equal(r.candidates[0]!.totals.differ, 2);
});

test("import-lspdiff refuses a project directory that does not exist", () => {
  const cli = join(here, "../src/cli.ts");
  const r = spawnSync(process.execPath, [cli, "import-lspdiff", "--from", here, "--project", join(here, "no-such-dir"), "--ref", side("fake-ref"), "--cand", side("fake-same"), "--out", join(mkdtempSync(join(tmpdir(), "parallax-imp-")), "b")], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no project directory/);
});
