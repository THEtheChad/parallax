// Colour and the status line: painting never moves a column or changes a character; tones land on the
// cells and verdicts they mean; piped output carries no escape codes unless FORCE_COLOR asks; the
// status line is rewritten in place on a terminal and never written anywhere else.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLog } from "../src/log.ts";
import { formatBench, formatLspBench } from "../src/report/render.ts";
import { cellTone } from "../src/report/model.ts";
import type { Paint } from "../src/style.ts";
import type { LspBenchSummary } from "../src/timing/lspSummary.ts";
import type { BenchSummary } from "../src/timing/summary.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../src/cli.ts");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(here, "fixtures/summaries", `${name}.json`), "utf8")) as T;
const bench = fixture<BenchSummary>("bench");
const lsp = fixture<LspBenchSummary>("lsp-bench");

// Marks instead of escape codes, so a test can see what was painted how.
const mark: Paint = (tone, text) => `{${tone}:${text}}`;
const unmark = (s: string): string => s.replace(/\{(?:good|bad|warn|dim|strong):([^}]*)\}/g, "$1");

test("painting changes no character and moves no column", () => {
  for (const [plain, painted] of [
    [formatBench(bench, "text"), formatBench(bench, "text", mark)],
    [formatLspBench(lsp, "text"), formatLspBench(lsp, "text", mark)],
  ] as const) {
    assert.notEqual(painted, plain);
    assert.equal(unmark(painted), plain);
  }
  // md, json and csv are never painted.
  assert.equal(formatBench(bench, "md", mark), formatBench(bench, "md"));
  assert.equal(formatBench(bench, "csv", mark), formatBench(bench, "csv"));
});

test("tones: calls, states, outputs and verdicts", () => {
  const out = formatBench(bench, "text", mark);
  assert.match(out, /\{good:faster\}/);
  assert.match(out, /\{bad:DIFFERENT\}/);
  assert.match(out, /\{warn:warnings:\}/);
  // The fixture is measured, not settled, with an output that differs: a caveat, not clean.
  assert.match(out.split("\n").at(-1)!, /^\{warn:MEASURED \(not settled/);
  assert.match(formatLspBench(lsp, "text", mark), /\{good:lower\}/);
  assert.equal(cellTone("call", "slower"), "bad");
  assert.equal(cellTone("call", "higher"), "bad");
  assert.equal(cellTone("call", "same (within 1 ms)"), null);
  assert.equal(cellTone("call", "too few rounds"), "warn");
  assert.equal(cellTone("state", "failed"), "bad");
  assert.equal(cellTone("A/A call", "faster"), "bad", "an A/A bench has nothing to find");
  assert.equal(cellTone("differ", "3"), "bad");
  assert.equal(cellTone("differ", "0"), null);
  assert.equal(cellTone("ratio", "faster"), null, "only the columns that hold calls");
});

test("piped output has no escape codes; FORCE_COLOR colours it; NO_COLOR wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "parallax-style-"));
  writeFileSync(join(dir, "summary.json"), readFileSync(join(here, "fixtures/summaries/lsp-diff.json")));
  const run = (env: Record<string, string | undefined>, ...args: string[]) =>
    spawnSync(process.execPath, [cli, "summary", dir, ...args], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined, ...env } });
  const ESC = /\x1b\[/;
  assert.doesNotMatch(run({}).stdout, ESC);
  assert.match(run({ FORCE_COLOR: "1" }).stdout, ESC);
  assert.doesNotMatch(run({ FORCE_COLOR: "1" }, "--format", "json").stdout, ESC, "json is data");
  assert.doesNotMatch(run({ FORCE_COLOR: "1" }, "--format", "md").stdout, ESC);
  assert.doesNotMatch(run({ NO_COLOR: "1" }).stdout, ESC);
  // Errors on stderr follow stderr's own terminal.
  const err = spawnSync(process.execPath, [cli, "summary", join(dir, "nope")], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: undefined } });
  assert.match(err.stderr, /\x1b\[31merror:/);
});

test("the status line: rewritten in place around log lines, cleared, never without a terminal or with --quiet", () => {
  const out: string[] = [];
  const write = (line: string) => out.push(`${line}\n`);
  const raw = (s: string) => out.push(s);
  const log = createLog({ write, status: { raw, columns: () => 40 } });
  log.status("round 1.1 · tsrs (1 of 2)");
  log("  tsrs  105 ms");
  log.warn("a side failed");
  log.status("round 1.1 · a label long enough to need cutting at forty columns");
  log.status(null);
  const ERASE = "\r\x1b[2K";
  assert.deepEqual(out, [
    "round 1.1 · tsrs (1 of 2)",
    ERASE, "  tsrs  105 ms\n", "round 1.1 · tsrs (1 of 2)",
    ERASE, "warning: a side failed\n", "round 1.1 · tsrs (1 of 2)",
    ERASE, "round 1.1 · a label long enough to nee…",
    ERASE,
  ]);
  assert.ok(out.every((s) => s.length <= 40 || s.endsWith("\n")), "a status line never wraps");

  const quiet: string[] = [];
  const q = createLog({ quiet: true, write: (l) => quiet.push(l), status: { raw: (s) => quiet.push(s), columns: () => 80 } });
  q.status("round 1.1");
  q.warn("kept");
  assert.deepEqual(quiet, ["warning: kept"]);

  const file: string[] = [];
  const f = createLog({ write: (l) => file.push(l) });
  f.status("round 1.1");
  f("a line");
  assert.deepEqual(file, ["a line"], "no terminal: no status line at all");
});
