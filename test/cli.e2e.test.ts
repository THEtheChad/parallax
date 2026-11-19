// End to end: the command line's own surface. Help, usage errors, missing bundles, harness errors,
// --version, and what --quiet leaves in the log.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../src/cli.ts");
const fake = join(here, "fixtures/fake-check.ts");
const side = (name: string, label: string): string => `${label}:${join(here, "fixtures/profiles", `${name}.json`)}=${fake}`;
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, PARALLAX_DEBUG: "", ...env } });
// A stack trace's frames, which no ordinary error should print.
const STACK = /^\s+at /m;

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "parallax-cli-proj-"));
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  return root;
}

test("help: a short overview, and each command's options with their defaults", () => {
  const overview = run(["--help"]);
  assert.equal(overview.status, 0);
  for (const c of ["lsp-diff", "bench", "lsp-bench", "calibrate", "bench-summary", "publish", "verify-result", "suite run"]) assert.match(overview.stdout, new RegExp(`^  ${c} `, "m"));
  assert.match(overview.stdout, /exit status:/);
  assert.ok(overview.stdout.split("\n").length < 50, "an overview, not every option");
  // No arguments: the overview on stderr, exit 2.
  const none = run([]);
  assert.equal(none.status, 2);
  assert.equal(none.stdout, "");
  assert.match(none.stderr, /^commands:/m);

  const bench = run(["bench", "--help"]);
  assert.equal(bench.status, 0);
  assert.match(bench.stdout, /^usage: parallax bench /);
  assert.match(bench.stdout, /--runs <n> +rounds before the first look at the calls \(default 6\)/);
  assert.match(bench.stdout, /--config <file>[\s\S]*not a Parallax configuration file/);
  assert.match(bench.stdout, /-q, --quiet/);
  assert.match(bench.stdout, /^example/m);
  for (const opt of ["project", "ref", "cand", "out", "config", "timeout-ms", "counter-runs", "threads", "max-runs", "min-runs", "resolution-ms", "warmup", "attempts", "max-busy-cores", "idle-timeout-s", "boot-settle-s", "max-outside-cores", "max-canary-drift", "env", "pass-env", "pin"])
    assert.match(bench.stdout, new RegExp(`--${opt}\\b`), `--${opt} documented`);
  assert.equal(run(["bench", "-h"]).stdout, bench.stdout);
  assert.equal(run(["help", "bench"]).stdout, bench.stdout);
  // Help wins over a bad option elsewhere on the line.
  assert.equal(run(["bench", "--bogus", "--help"]).status, 0);
  assert.match(run(["help", "suite", "run"]).stdout, /^usage: parallax suite run /);
  // Short commands have no --quiet.
  assert.doesNotMatch(run(["summary", "--help"]).stdout, /--quiet/);
});

test("usage errors: the message and the command's synopsis, no stack, exit 2", () => {
  const unknown = run(["bench", "--bogus"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^error: unknown option --bogus\n\nusage: parallax bench .*\nmore: parallax bench --help\n$/);
  assert.doesNotMatch(unknown.stderr, /TypeError|ERR_PARSE_ARGS/);
  assert.doesNotMatch(unknown.stderr, STACK);
  assert.match(run(["bench", "--max-run", "9"]).stderr, /unknown option --max-run \(did you mean --max-runs\?\)/);
  assert.match(run(["bench", "--runs"]).stderr, /^error: --runs wants a value: <n>/);
  assert.match(run(["bench", "--project", "x"]).stderr, /^error: bench needs --ref, --cand and --out/);
  assert.match(run(["summary", "a", "b"]).stderr, /^error: summary needs one bundle directory/);
  const command = run(["benhc"]);
  assert.equal(command.status, 2);
  assert.match(command.stderr, /^error: unknown command "benhc" \(did you mean bench\?\)/);
  assert.match(run(["suite"]).stderr, /^error: suite wants list, fetch or run/);
});

test("errors: a missing bundle is one line; a harness error is one line, with its stack under PARALLAX_DEBUG=1", () => {
  const dir = join(tmpdir(), "parallax-no-such-bundle");
  for (const [cmd, file] of [["summary", "summary.json"], ["bench-summary", "bundle.json"], ["compare", "bundle.json"]] as const) {
    const r = run([cmd, dir]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `error: no bundle at ${dir}: ${file} not found\n`);
  }
  // A bundle.json cut down to its header: the harness trips over what is not there.
  const cut = mkdtempSync(join(tmpdir(), "parallax-cli-cut-"));
  writeFileSync(join(cut, "bundle.json"), JSON.stringify({ schema: "parallax.bundle/1", kind: "lsp-answer-diff" }));
  const plain = run(["compare", cut]);
  assert.equal(plain.status, 2);
  assert.match(plain.stderr, /^error: .* \(PARALLAX_DEBUG=1 shows the stack\)\n$/);
  const debug = run(["compare", cut], { PARALLAX_DEBUG: "1" });
  assert.equal(debug.status, 2);
  assert.match(debug.stderr, STACK);
});

test("value errors: reported before missing options and before any file is read", () => {
  const cases: [string[], RegExp][] = [
    [["bench", "--runs", "abc"], /^error: --runs wants a whole number of at least 1\n\nusage: parallax bench /],
    [["bench", "--runs", "0"], /^error: --runs wants a whole number of at least 1\n/],
    [["bench", "--format", "yaml"], /^error: --format wants text, md, json or csv \(got "yaml"\)\n/],
    [["bench", "--threads", "many"], /^error: --threads: want default, single or both \(got "many"\)\n/],
    [["bench", "--timeout-ms", "0"], /^error: --timeout-ms wants a number more than 0\n/],
    [["bench", "--env", "inherit", "--pass-env", "X"], /^error: --pass-env only applies to --env sealed\n/],
    [["bench", "--fail-threshold", "0.5"], /^error: --fail-threshold wants a ratio of at least 1 /],
    [["lsp-bench", "--fail-on", "output"], /^error: --fail-on "output" does not apply here/],
    [["calibrate", "--kind", "bogus"], /^error: --kind wants bench or lsp-bench \(got "bogus"\)\n/],
    [["bench-summary", "/nonexistent", "--fail-on", "worse"], /^error: --fail-on "worse" does not apply here: use slower, output, unresolved\n/],
    [["compare-results", "/nonexistent/a", "/nonexistent/b", "--confidence", "2"], /^error: --confidence wants a number between 0 and 1 \(0\.95\)\n/],
  ];
  for (const [args, want] of cases) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, want, args.join(" "));
  }
  // What the handlers take passes: the comma list of thread modes, a condition only one bundle kind has.
  assert.match(run(["bench", "--threads", "default,single", "--format", "md", "--fail-on", "slower", "--fail-threshold", "1.1"]).stderr, /^error: bench needs --project/);
  assert.match(run(["bench-summary", "/nonexistent", "--fail-on", "output"]).stderr, /^error: no bundle at /);
  assert.match(run(["bench-summary", "/nonexistent", "--fail-on", "slower", "--fail-metrics", "typing.completionP95Ms"]).stderr, /^error: no bundle at /);
});

test("input errors: what the user gave is wrong, one line without the PARALLAX_DEBUG hint, exit 2", () => {
  const base = mkdtempSync(join(tmpdir(), "parallax-cli-"));
  const full = join(base, "full");
  mkdirSync(full);
  writeFileSync(join(full, "x"), "");
  const project = makeProject();
  const bench = (...more: string[]) => ["bench", "--project", project, "--ref", side("fake-check-ref", "ref"), "--cand", side("fake-check-fast", "fast"), "--out", join(base, "b"), ...more];
  const cases: [string[], RegExp][] = [
    [["bench", "--project", project, "--ref", `bogusprofile=${fake}`, "--cand", side("fake-check-fast", "fast"), "--out", join(base, "b")], /^error: no profile "bogusprofile" \(looked for .*\); the profiles are .*\btsc7\b.*, or give a profile's path\n$/],
    [["bench", "--project", join(base, "no-such-project"), "--ref", side("fake-check-ref", "ref"), "--cand", side("fake-check-fast", "fast"), "--out", join(base, "b")], /^error: no project at .*\n$/],
    [["bench", "--project", base, "--ref", side("fake-check-ref", "ref"), "--cand", side("fake-check-fast", "fast"), "--out", join(base, "b")], /^error: no tsconfig\.json in .*\n$/],
    [bench("--max-runs", "2"), /^error: --max-runs 2 is less than --runs 6\n$/],
    [["bench", "--project", project, "--ref", "fake-check-ref", "--cand", side("fake-check-fast", "fast"), "--out", join(base, "b")], /^error: side "fake-check-ref": want <profile>=<binary> /],
    [[...bench().slice(0, -2), "--out", full, "--threads", "default"], /^error: bundle directory .* exists and is not empty\n$/],
  ];
  for (const [args, want] of cases) {
    const r = run(args);
    assert.equal(r.status, 2, `${args.join(" ")}\n${r.stderr}`);
    assert.match(r.stderr, want, args.join(" "));
    assert.doesNotMatch(r.stderr, /PARALLAX_DEBUG/);
  }
  // The stack is still there for whoever asks.
  assert.match(run(bench("--max-runs", "2"), { PARALLAX_DEBUG: "1" }).stderr, STACK);
  // A JSON file named on the command line that is not JSON: said so, on one line.
  const bad = join(base, "bad");
  mkdirSync(bad);
  writeFileSync(join(bad, "summary.json"), "kind,label\n1,2\n");
  const summary = run(["summary", bad]);
  assert.equal(summary.status, 2);
  assert.match(summary.stderr, /^error: .*summary\.json: not JSON \(Unexpected token [^\n]*\)\n$/);
});

test("verify-result: a file that is not JSON fails verification, on one line, and the rest are still checked", () => {
  const dir = mkdtempSync(join(tmpdir(), "parallax-cli-verify-"));
  const csv = join(dir, "bench.csv");
  writeFileSync(csv, "kind,label\n1,2\n");
  const r = run(["verify-result", csv, csv]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.match(/^FAILED /gm)?.length, 2);
  assert.match(r.stdout, /^FAILED .*bench\.csv\n {2}not JSON \(Unexpected token [^\n]*\)$/m);
  assert.equal(r.stderr, "");
});

test("--version: the package version, the harness commit and Node's version", () => {
  for (const flag of ["--version", "-V"]) {
    const r = run([flag]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^parallax \d+\.\d+\.\d+\ncommit ([0-9a-f]{40}( \(uncommitted changes\))?|unknown)\nnode v\d+\.\d+\.\d+\n$/);
  }
});

test("progress: stamped round lines with one line per side; --quiet keeps only warnings", () => {
  const base = mkdtempSync(join(tmpdir(), "parallax-cli-"));
  // An empty config directory: no stored calibration, so the bench warns about that.
  const env = { PARALLAX_CONFIG_DIR: mkdtempSync(join(tmpdir(), "parallax-config-")) };
  const args = (out: string, ...more: string[]) => [
    "bench", "--project", makeProject(), "--ref", side("fake-check-ref", "ref"), "--cand", side("fake-check-fast", "fast"), "--out", join(base, out),
    "--threads", "default", "--runs", "2", "--max-runs", "2", "--min-runs", "2", "--warmup", "0", "--attempts", "1", "--counter-runs", "0",
    "--boot-settle-s", "0", "--max-busy-cores", "1000", "--max-outside-cores", "1000", "--max-canary-drift", "1000", ...more,
  ];
  const loud = run(args("loud"), env);
  assert.equal(loud.status, 0, loud.stderr);
  const lines = loud.stderr.trimEnd().split("\n");
  assert.ok(lines.every((l) => /^\[\d+:\d\d\] /.test(l)), loud.stderr);
  assert.match(loud.stderr, /^\[\d+:\d\d\] round 1\.1 \(0 accepted, need 2\)$/m);
  assert.match(loud.stderr, /^\[\d+:\d\d\] {3}ref {3}\d+ ms wall/m);
  assert.match(loud.stderr, /^\[\d+:\d\d\] {3}fast {2}\d+ ms wall/m);
  assert.match(loud.stderr, /^\[\d+:\d\d\] {3}canary .* ms.*: accepted$/m);
  assert.match(loud.stderr, /a round takes about .*; 1 more round, about .* left/);
  assert.equal(lines.filter((l) => /\] (done in .*: )?bundle /.test(l)).length, 2, "at the start, and in the final line");
  assert.match(lines.at(-1)!, /\] done in \d+:\d\d: bundle /);
  assert.match(loud.stderr, /warning: this machine has no noise calibration/);

  const quiet = run(args("quiet", "--quiet"), env);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /round \d/);
  assert.doesNotMatch(quiet.stderr, /bundle /);
  assert.match(quiet.stderr, /warning: this machine has no noise calibration/);
  assert.match(quiet.stdout, /^side /m, "the report is unaffected");
});

test("a report bigger than a pipe's buffer reaches a slow reader whole", { timeout: 30_000 }, async () => {
  // process.exit right after console.log used to drop what the pipe had not taken (64 KiB on Linux):
  // a JSON report arrived cut short, with exit 0.
  const dir = mkdtempSync(join(tmpdir(), "parallax-cli-big-"));
  const pad = "x".repeat(300_000);
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ clean: true, pad }));
  const child = spawn(process.execPath, [cli, "summary", dir, "--format", "json"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pause();
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  // Read only after a while, so the child's writes outrun the pipe.
  await new Promise((r) => setTimeout(r, 300));
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  child.stdout.resume();
  await new Promise((r) => child.stdout.on("end", r));
  assert.equal(await exited, 0);
  const out = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { pad: string };
  assert.equal(out.pad.length, pad.length);
});
