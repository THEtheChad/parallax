// The reports: every format of every summary kind, from fixture summaries (test/fixtures/summaries)
// that hold the cases the wording has to get right. Pure functions of the summary, so no runs here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Summary } from "../src/diff/compare.ts";
import type { Calibration } from "../src/timing/calibration.ts";
import type { LspBenchSummary } from "../src/timing/lspSummary.ts";
import type { BenchSummary } from "../src/timing/summary.ts";
import { benchVerdict } from "../src/report/bench.ts";
import { callText, ratio, spreadText } from "../src/report/common.ts";
import { escapeMd, toCsv } from "../src/report/model.ts";
import { FORMATS, formatBench, formatCalibration, formatLspBench, formatSummary, parseFormat } from "../src/report/render.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(here, "fixtures/summaries", `${name}.json`), "utf8")) as T;
const bench = fixture<BenchSummary>("bench");
const lsp = fixture<LspBenchSummary>("lsp-bench");
const diff = fixture<Summary>("lsp-diff");
const calibration = fixture<Calibration>("calibration");
const lines = (s: string): string[] => s.split("\n");

test("ratios have three significant figures; tiny counter spreads say so", () => {
  assert.equal(ratio(187.53), "188x");
  assert.equal(ratio(0.35243), "0.352x");
  assert.equal(ratio(1.0834), "1.08x");
  assert.equal(ratio(16.8), "16.8x");
  assert.equal(ratio(0.04), "0.0400x");
  assert.equal(spreadText(0.00012), "±<0.01%");
  assert.equal(spreadText(0), "±0%");
  assert.equal(spreadText(0.0011), "±0.06%");
  assert.equal(spreadText(0.062), "±3.1%");
});

test("calls read by what the metric measures; a governing ms floor is said in ms", () => {
  const resolution = { relative: 0.05, floorMs: 1 };
  assert.equal(callText("faster", 0.05, { measure: "time" }), "faster");
  assert.equal(callText("faster", 0.05, { measure: "memory" }), "lower");
  assert.equal(callText("slower", 0.05, { measure: "cpu" }), "higher");
  assert.equal(callText("same", 3.01, { ms: true, resolution }), "same (within 1 ms)");
  assert.equal(callText("same", 0.05, { ms: true, resolution }), "same ±5%");
  // Memory has no ms floor, and summaries from before resolutions were kept have none to compare with.
  assert.equal(callText("same", 0.08, { ms: false, resolution }), "same ±8%");
  assert.equal(callText("same", 3.01), "same ±301%");
  assert.equal(callText("unresolved", 0.05), "unresolved");
  assert.equal(callText(null, 0.05), "-");
});

test("bench text: warnings first, units, legend, and a verdict that says what is true", () => {
  const out = formatBench(bench, "text");
  const l = lines(out);
  assert.equal(l[0], "warnings:");
  assert.match(l[1]!, /^ {2}- this machine has no noise calibration/);
  // Prose wraps at 100 columns, continuing further in; tables never wrap.
  assert.ok(l.find((x) => x.startsWith("rounds:"))!.length <= 100, "prose wraps at 100");
  const prose = out.replace(/\n +/g, " ");
  assert.match(prose, /a comparison needs at least 3 accepted \(--min-runs\)/);
  assert.doesNotMatch(out, /; need 3/);
  assert.match(prose, /the % in an interval's header is the coverage it really has/);
  assert.match(out, /336 MiB/);
  assert.doesNotMatch(out, / MB\b/);
  assert.match(out, /0\.352x \(0\.338x\.\.0\.362x\)/);
  assert.match(out, /same \(within 1 ms\)/);
  assert.doesNotMatch(out, /±300%/);
  assert.match(out, /2\.971G ±<0\.01%/);
  assert.equal(
    l.at(-1),
    "MEASURED (not settled: 1 call could change with more rounds): timing only; output differs from the reference for fast (see the output column; parity is lsp-diff's job)",
  );
});

test("bench verdict: plain MEASURED when settled and every output matches; unclean stays unclean", () => {
  const settled: BenchSummary = {
    ...bench,
    settled: true,
    sides: bench.sides.map((s) => ({ ...s, outputMatchesRef: s.role === "ref" ? null : true })),
  };
  assert.equal(benchVerdict(settled), "MEASURED");
  assert.equal(benchVerdict({ ...bench, clean: false }), "NOT MEASURED CLEANLY: see the states above");
  // The fixture predates exitMatchesRef: its exit codes are shown bare, with no ≠.
  assert.doesNotMatch(formatBench(bench, "text"), /≠/);
  // An older summary without notes renders without a warnings block.
  const { notes: _, ...old } = bench;
  assert.doesNotMatch(formatBench(old as BenchSummary, "text"), /warnings:/);
});

test("bench exit column: the code itself, ≠ the reference's where it differs; its own note in the verdict", () => {
  // As the Rust ports on umami: the reference's diagnostics, exit 2 where tsc 7 exits 1.
  const s: BenchSummary = {
    ...bench,
    settled: true,
    sides: bench.sides.map((x) =>
      x.role === "ref"
        ? { ...x, exitCodes: [1], exitMatchesRef: null }
        : x.label === "fast"
          ? { ...x, exitCodes: [2], outputMatchesRef: true, exitMatchesRef: false }
          : x.label === "odd"
            ? { ...x, exitCodes: [1, 2], outputMatchesRef: true, exitMatchesRef: false }
            : { ...x, exitCodes: [1], outputMatchesRef: true, exitMatchesRef: true },
    ),
  };
  const out = formatBench(s, "text");
  const row = (label: string): string => lines(out).find((l) => l.startsWith(`${label} `))!;
  assert.match(row("ref"), / 1 +ref$/);
  assert.match(row("fast"), / 2 ≠1 +same$/);
  assert.match(row("twin"), / 1 +same$/);
  assert.match(row("odd"), / 1,2 UNSTABLE +same$/);
  // The verdict of a clean run (an unstable exit code would make it unclean): odd exits 1 every time.
  const clean = { ...s, sides: s.sides.map((x) => (x.label === "odd" ? { ...x, exitCodes: [1], exitMatchesRef: true } : x)) };
  assert.equal(benchVerdict(clean), "MEASURED: exit code differs from the reference's for fast (see the exit column)");
  // With an output that differs too, both notes.
  const both = { ...clean, sides: clean.sides.map((x) => (x.label === "twin" ? { ...x, outputMatchesRef: false } : x)) };
  assert.match(benchVerdict(both), /: timing only; output differs from the reference for twin \(.*\); exit code differs from the reference's for fast \(see the exit column\)$/);
});

test("lsp-bench text: CPU and memory are lower/higher, labels are finished, side counts have a key", () => {
  const out = formatLspBench(lsp, "text");
  assert.equal(lines(out)[0], "warnings:");
  const row = (label: string): string => lines(out).find((x) => x.startsWith(label))!;
  assert.match(row("session: memory"), /1108 MiB +692 MiB +0\.625x .* lower$/);
  assert.match(row("open: server CPU"), /lower$/);
  assert.match(row("open: first diagnostics"), /faster$/);
  assert.match(row("typing: hover p50"), /188x \(178x\.\.197x\) +slower$/);
  assert.match(row("edit: first request after an edit"), /unresolved$/);
  assert.match(row("edit: second request after an edit"), /same \(within 1 ms\)$/);
  assert.match(row("long: memory growth per edit"), /KiB\/edit .*not compared$/);
  assert.match(out, /^side +sessions +requests +cancelled +errors/m);
  assert.match(out, /^cancelled: typing requests still unanswered/m);
  assert.doesNotMatch(out, /every session, warm-ups included/);
  assert.equal(lines(out).at(-1), "MEASURED (not settled: 1 call could change with more rounds)");
});

test("markdown has the same content as text, as GFM tables", () => {
  const md = formatLspBench(lsp, "md");
  assert.match(md, /^## parallax lsp-bench$/m);
  assert.match(md, /^> \*\*warnings\*\*$/m);
  assert.match(md, /^> - the harness sent keys up to 40 ms late/m);
  assert.match(md, /^### cand vs ref: measured$/m);
  assert.match(md, /^\| metric \| ref \| cand \| ratio \(99% interval\) \| call \|$/m);
  // Figures right-aligned, words (the call) left-aligned.
  assert.match(md, /^\| :--- \| ---: \| ---: \| ---: \| :--- \|$/m);
  assert.match(md, /^\| session: memory \| 1108 MiB \| 692 MiB \| 0\.625x \(0\.594x\.\.0\.657x\) \| lower \|$/m);
  assert.equal(lines(md).at(-1), "**MEASURED (not settled: 1 call could change with more rounds)**");
  const bmd = formatBench(bench, "md");
  assert.match(bmd, /^\| fast \| ref \| measured \| 0\.352x \(0\.338x\.\.0\.362x\) \| 0\.198x \| faster \|$/m);
  assert.match(bmd, /\| 2\.971G ±\\<0\.01% \|/);
  // Text in a cell or line cannot break the table or turn into HTML.
  assert.equal(escapeMd("Array<T> | x_y"), "Array\\<T\\> \\| x\\_y");
  assert.match(formatSummary(diff, "md"), /contents: Array\\<T\\> \\\| string/);
});

test("json is the summary object itself", () => {
  assert.deepEqual(JSON.parse(formatBench(bench, "json")), bench);
  assert.deepEqual(JSON.parse(formatLspBench(lsp, "json")), lsp);
  assert.deepEqual(JSON.parse(formatSummary(diff, "json")), diff);
  assert.deepEqual(JSON.parse(formatCalibration(calibration, null, "json")), calibration);
});

const parseCsv = (s: string): Record<string, string>[] => {
  const [head, ...rows] = lines(s).map((l) => l.split(","));
  return rows.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ""])));
};

test("bench csv: one row per figure, raw numbers and stored calls", () => {
  const rows = parseCsv(formatBench(bench, "csv"));
  const wall = rows.find((r) => r.kind === "comparison" && r.label === "fast" && r.metric === "wall")!;
  assert.equal(wall.vs, "ref");
  assert.equal(Number(wall.ratio), 0.35243);
  assert.equal(Number(wall.ratio_low), 0.3381);
  assert.equal(Number(wall.ref_value), 336.4);
  assert.equal(Number(wall.value), 118.97);
  assert.equal(wall.call, "faster");
  assert.equal(wall.state, "measured");
  assert.equal(wall.unit, "ms");
  assert.equal(rows.filter((r) => r.kind === "side").length, bench.sides.length * 3);
  const instr = rows.find((r) => r.kind === "counter" && r.metric === "instructions")!;
  assert.equal(Number(instr.value), 2.971e9);
  assert.equal(Number(instr.spread), 0.00012);
});

test("lsp-bench csv: stored calls, not report wording; uncompared metrics say so", () => {
  const rows = parseCsv(formatLspBench(lsp, "csv"));
  const mem = rows.find((r) => r.kind === "comparison" && r.metric === "session.memoryBytes")!;
  assert.equal(mem.call, "faster");
  assert.equal(mem.unit, "bytes");
  assert.equal(Number(mem.ref_value), 1161822208);
  assert.equal(rows.find((r) => r.kind === "comparison" && r.metric === "long.latencyDrift")!.call, "not compared");
  assert.equal(rows.filter((r) => r.kind === "side" && r.label === "ref").length, Object.keys(lsp.sides[0]!.metrics).length);
});

test("lsp-diff and calibration reports in every format", () => {
  for (const f of FORMATS) {
    assert.ok(formatSummary(diff, f).length > 0);
    assert.ok(formatCalibration(calibration, "/x/lsp-bench.json", f).length > 0);
  }
  const text = formatSummary(diff, "text");
  assert.match(text, /^ {2}differ: hover a\.ts:3:4 {2}-> contents/m);
  assert.equal(lines(text).at(-1), "ATTENTION: see the differences above");
  assert.deepEqual(parseCsv(formatSummary(diff, "csv")).find((r) => r.method === "total" && r.verdict === "differ"), { candidate: "cand", method: "total", verdict: "differ", count: "1" });
  const cal = formatCalibration(calibration, null, "text");
  assert.match(cal, /^session: memory +default +12\.0% +12\.0% +higher$/m);
  assert.match(cal, /^open: first diagnostics +default .* same$/m);
  assert.equal(parseCsv(formatCalibration(calibration, null, "csv"))[1]!.call, "slower");
});

test("csv quoting and --format parsing", () => {
  assert.equal(toCsv(["a", "b"], [['x,"y"', null], [1, "z"]]), 'a,b\n"x,""y""",\n1,z');
  assert.equal(parseFormat(undefined), "text");
  assert.equal(parseFormat("md"), "md");
  assert.throws(() => parseFormat("xml"), /--format wants text, md, json, csv/);
});
