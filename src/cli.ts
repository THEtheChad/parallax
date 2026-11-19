#!/usr/bin/env node
// parallax: parity and performance harness for TypeScript compilers and language servers.
//
// Every command is one entry in COMMANDS: its name, a one-line summary for the overview, its usage
// and help text, its options (each documented once: the parser and `--help` are both made from
// them) and its handler. Adding a command is adding an entry; adding an option is adding an `Opt` to
// one of its groups and reading it in the handler.
//
// stdout is the report, stderr the log. Exit status: 0 clean, 1 a finding (differences, a bench not
// measured cleanly), 2 a usage or harness error.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { harnessInfo, readBundle, writeJsonAtomic } from "./bundle/bundle.ts";
import { bench, readBenchBundle, summarizeBenchBundle } from "./commands/bench.ts";
import { importLspdiff } from "./commands/importLspdiff.ts";
import { lspBench, readLspBenchBundle, summarizeLspBenchBundle } from "./commands/lspBench.ts";
import { lspDiff } from "./commands/lspDiff.ts";
import { publish, verifyResult } from "./commands/publish.ts";
import { calibrate, DEFAULT_CALIBRATION_RUNS } from "./commands/calibrate.ts";
import { parseEnvMode, type EnvPolicy } from "./host/sealedEnv.ts";
import { expandCpuList } from "./host/pinning.ts";
import { suiteRun } from "./commands/suiteRun.ts";
import { parseSideSpec, parseThreadModes, type ThreadMode } from "./profile/profile.ts";
import { fetchProject, loadSuite, selectProjects } from "./suite/suite.ts";
import { compareBundle, type Summary } from "./diff/compare.ts";
import { formatBench, formatCalibration, formatLspBench, formatSummary, FORMATS, parseFormat, type Format } from "./report/render.ts";
import { createLog, fmtElapsed, type Log } from "./log.ts";
import { paintFor, type Paint } from "./style.ts";
import { InputError, readJsonFile } from "./errors.ts";
import { CompareError, compareResults } from "./commands/compareResults.ts";
import { comparisonCsv, comparisonMarkdown, renderComparison } from "./report/compareResults.ts";
import { evaluateBenchPolicy, evaluateLspPolicy, exitStatus, parseMetricKeys, parsePolicy, PolicyError, renderDecision, type Policy, type PolicyDecision } from "./timing/policy.ts";

// ---------------------------------------------------------------------------------------------
// Options and commands

interface Opt {
  name: string;
  short?: string;
  // The value's placeholder in help ("<n>"); absent for a flag. It also says what checkValues takes:
  // <n> a whole number; <ms>, <s>, <cores>, <fraction>, <p> a number; a|b|c one of those words;
  // ...=<bin> a side. Whatever it is, it may not be empty.
  value?: string;
  // <n>: the least whole number that means anything (1 for counts of rounds or files).
  min?: number;
  // A time limit: more than 0 (0 would mean no limit).
  positive?: boolean;
  multiple?: boolean;
  // Shown in help only: the commands apply their own defaults.
  default?: string;
  required?: boolean;
  help: string;
}

interface OptGroup {
  title: string;
  opts: Opt[];
}

type Values = Record<string, string | boolean | string[] | undefined>;

interface Run {
  values: Values;
  positionals: string[];
  log: Log;
}

interface Command {
  // One word, or "suite run" for a subcommand.
  name: string;
  summary: string;
  // What follows "parallax " in the synopsis.
  usage: string;
  // A paragraph or two: what the command does and what it prints.
  about: string;
  options: OptGroup[];
  positionals?: boolean;
  // Runs for minutes or hours: log lines carry the elapsed time, and --quiet is offered.
  longRunning?: boolean;
  examples: string[];
  // When the command's exit status means more than the usual 0 / 1 / 2.
  exit?: string;
  run: (r: Run) => Promise<number>;
}

const SIDE = "[<label>:]<profile>=<bin>";

const REF: Opt = { name: "ref", value: "<profile>=<bin>", required: true, help: "the reference: a profile (profiles/ name or JSON path) bound to a binary" };
const CAND: Opt = { name: "cand", value: SIDE, multiple: true, required: true, help: "a candidate; repeat for more; the label names it in reports, by default the profile's name" };
const PROJECT: Opt = { name: "project", value: "<dir>", required: true, help: "the project to run on" };
const OUT: Opt = { name: "out", value: "<dir>", required: true, help: "the bundle directory to write (must not exist, or be empty)" };

const ENV: Opt[] = [
  { name: "env", value: "sealed|inherit", default: "sealed", help: "the measured commands' environment: sealed (a fixed minimal one: PATH, HOME, ... plus LANG/LC_ALL and TZ=UTC) or inherit (the harness's own, minus the profile's env.clear)" },
  { name: "pass-env", value: "NAME", multiple: true, help: "also pass this variable from the harness's environment into the sealed one; repeat for more" },
];
const PIN: Opt = { name: "pin", value: "<cpu-list>", help: "pin every measured command to these cores, a kernel cpu list such as 2-5 (Linux, taskset); off by default" };

const ROUNDS: OptGroup = {
  title: "rounds and calls",
  opts: [
    { name: "threads", value: "both|default|single", default: "both", help: "thread modes each side runs in: as it chooses (default), single-threaded (single), or both; candidates are compared with the reference in the same mode" },
    { name: "runs", value: "<n>", min: 1, default: "6", help: "rounds before the first look at the calls" },
    { name: "max-runs", value: "<n>", default: "the larger of 15 and --runs", help: "the most rounds while some call is unsettled (looks every 3 rounds after --runs)" },
    { name: "min-runs", value: "<n>", min: 1, default: "3", help: "the fewest accepted rounds a call needs; with fewer, a candidate is 'too few rounds'" },
    { name: "resolution", value: "<fraction>", default: "0.05", help: "'same' means within this fraction of the reference..." },
    { name: "resolution-ms", value: "<ms>", default: "1", help: "...or within this many milliseconds, where that is larger" },
    { name: "warmup", value: "<n>", default: "1", help: "untimed runs per side before the rounds" },
    { name: "attempts", value: "<n>", min: 1, default: "3", help: "tries per round when a round is disturbed (a round in which a side failed is not retried)" },
  ],
};

const MACHINE: OptGroup = {
  title: "machine gates",
  opts: [
    { name: "max-busy-cores", value: "<cores>", default: "1.5", help: "before each round, wait until other programs use at most this many cores" },
    { name: "idle-timeout-s", value: "<s>", default: "300", help: "stop waiting for idle after this long; the round then runs and is rejected" },
    { name: "boot-settle-s", value: "<s>", default: "300", help: "wait until the machine has been up this long (the first minutes after boot run slow)" },
    { name: "max-outside-cores", value: "<cores>", default: "1", help: "reject a round in which other programs used more than this many cores" },
    { name: "max-canary-drift", value: "<fraction>", default: "0.1", help: "reject a round whose canary ran this much slower than the fastest canary (the machine changed speed)" },
  ],
};

const ENVIRONMENT: OptGroup = { title: "environment", opts: [...ENV, PIN] };

// --fail-on: a CI policy judged on the summary, apart from whether the measurement was clean
// (timing/policy.ts). Exit 3 when it fails.
const FAIL_THRESHOLD: Opt = { name: "fail-threshold", value: "<ratio>", help: "fail slower/worse only when the whole interval is above this ratio (1.10: more than 10% slower)" };
const POLICY = (kind: "bench" | "lsp-bench" | "both"): OptGroup => ({
  title: "CI policy (exit 3 when it fails)",
  opts: [
    {
      name: "fail-on",
      value: "<list>",
      help:
        kind === "bench"
          ? "comma list: slower (a call slower), output (an output DIFFERENT from the reference's, or UNSTABLE), unresolved (a call unresolved or too few rounds; the bench not settled)"
          : kind === "lsp-bench"
            ? "comma list: slower (a compared metric slower or higher), unresolved (a call unresolved or too few rounds; the bench not settled)"
            : "comma list: slower, output (bench bundles only), unresolved; see bench --help and lsp-bench --help",
    },
    FAIL_THRESHOLD,
    ...(kind === "bench" ? [] : [{ name: "fail-metrics", value: "<key,...>", help: "lsp-bench: judge only these metrics (keys as in summary.json, e.g. typing.completionP95Ms)" }]),
  ],
});

// How the report on stdout is written: text for a terminal, md for a PR comment or
// $GITHUB_STEP_SUMMARY, json (the summary itself: README has the contract), csv (one row per figure).
const FORMAT: Opt = { name: "format", value: FORMATS.join("|"), default: "text", help: "how the report on stdout is written: text, md (GitHub Markdown), json (the summary object), csv (one row per figure)" };
const REPORT: OptGroup = { title: "report", opts: [FORMAT] };

const CHECK: Opt[] = [
  { name: "config", value: "<file>", default: "tsconfig.json", help: "the tsconfig the check command builds ({config} in the profile), relative to --project; not a Parallax configuration file" },
  { name: "timeout-ms", value: "<ms>", positive: true, default: "600000", help: "a check that runs longer is killed, and its round fails" },
  { name: "counter-runs", value: "<n>", default: "3", help: "runs per side under perf stat after the timed rounds, counting instructions and cycles (where perf works; 0: none)" },
];

const SESSION: OptGroup = {
  title: "editor session (0 skips a phase)",
  opts: [
    { name: "files", value: "<n>", min: 1, default: "6", help: "files to open, picked from the project as for lsp-diff; the first is edited" },
    { name: "file", value: "<rel>", multiple: true, help: "a file to open, relative to the project (instead of picking); repeat; the first is edited" },
    { name: "edits", value: "<n>", default: "20", help: "edit phase: one-character edits, each followed by a hover in another file and the diagnostics" },
    { name: "interval-ms", value: "<ms>", positive: true, default: "120", help: "typing phase: time between keys" },
    { name: "lines", value: "<n>", default: "4", help: "typing phase (open loop): lines typed on schedule; latency counts from when each key was due" },
    { name: "service-lines", value: "<n>", default: "1", help: "service phase (closed loop): lines typed one request at a time" },
    { name: "paused-lines", value: "<n>", default: "1", help: "paused phase: lines typed with a pause before each key" },
    { name: "pause-ms", value: "<ms>", default: "300", help: "paused phase: the quiet before each key" },
    { name: "errfixes", value: "<n>", default: "5", help: "errfix phase: a type error added and removed, timing its diagnostics" },
    { name: "imports", value: "<n>", default: "3", help: "imports phase: names from other files completed and fixed with the add-import action" },
    { name: "long-edits", value: "<n>", default: "60", help: "long phase: edits in a row, for drift and memory growth per edit" },
    { name: "request-timeout-ms", value: "<ms>", positive: true, default: "120000", help: "a request unanswered this long ends the session as timed out" },
  ],
};

const COMMANDS: Command[] = [
  {
    name: "lsp-diff",
    summary: "run one editor session against each server and compare every answer",
    usage: `lsp-diff --project <dir> --ref <profile>=<bin> --cand ${SIDE} [--cand ...] --out <dir> [options]`,
    about:
      "Runs one scripted editor session (diagnostics, tokens, hints, symbols, folding; hover, definition, references, rename and more at picked positions; completions while typing) against the reference twice and each candidate once, one server at a time, and compares every answer. Prints the verdicts per candidate and method.",
    longRunning: true,
    options: [
      { title: "sides and project", opts: [PROJECT, REF, CAND, OUT] },
      {
        title: "session",
        opts: [
          { name: "files", value: "<n>", min: 1, default: "6", help: "files the session opens, picked from the project" },
          { name: "file", value: "<rel>", multiple: true, help: "a file to open, relative to the project (instead of picking); repeat for more" },
          { name: "positions", value: "<n>", default: "4", help: "positions per file for hover, definition, references, rename and the rest" },
          { name: "ref-runs", value: "<n>", min: 1, default: "2", help: "reference runs: answers where the reference disagrees with itself are ref-unstable and never blamed on a candidate" },
          { name: "cand-runs", value: "<n>", min: 1, default: "1", help: "runs per candidate; 2 also checks the candidates' stability" },
          { name: "request-timeout-ms", value: "<ms>", positive: true, default: "600000", help: "a request unanswered this long ends the session as timed out" },
          { name: "ref-evidence", value: "<dir>", multiple: true, help: "a compatible earlier bundle whose reference answers count as reference variants; repeat for more" },
        ],
      },
      { title: "environment", opts: ENV },
      REPORT,
    ],
    examples: ["parallax lsp-diff --project ~/src/hono --ref tsc7=$TSGO --cand tsrs=$TSRS --out /tmp/hono-diff"],
    exit: "0 every answer matches and every session is clean, 1 differences or an unclean session, 2 usage or harness error",
    run: async ({ values: o, log }) => {
      const format = formatOption(o);
      const t0 = performance.now();
      const r = await lspDiff({
        project: o.project as string,
        out: o.out as string,
        ref: o.ref as string,
        cands: o.cand as string[],
        files: int(o, "files", 1) ?? 6,
        ...(Array.isArray(o.file) ? { file: o.file } : {}),
        positions: int(o, "positions") ?? 4,
        refRuns: int(o, "ref-runs", 1) ?? 2,
        candRuns: int(o, "cand-runs", 1) ?? 1,
        requestTimeoutMs: positive(o, "request-timeout-ms") ?? 600_000,
        refEvidence: strings(o, "ref-evidence").map((d) => resolve(d)),
        ...defined({ env: envOption(o) }),
        log,
      });
      log(`done in ${fmtElapsed(performance.now() - t0)}: bundle ${r.dir}`);
      return printSummary(r.summary, format);
    },
  },
  {
    name: "compare",
    summary: "recompute an answer-diff bundle's verdicts from its raw answers",
    usage: "compare <bundle-dir> [--ref-evidence <dir>]...",
    about: "Recomputes verdicts.jsonl, summary.json and differences/ from the bundle's runs/, then prints the summary as lsp-diff does.",
    positionals: true,
    options: [{ title: "options", opts: [{ name: "ref-evidence", value: "<dir>", multiple: true, help: "a compatible bundle whose reference answers count as reference variants; repeat for more" }] }, REPORT],
    examples: ["parallax compare /tmp/hono-diff --ref-evidence /tmp/hono-diff-yesterday"],
    exit: "0 clean, 1 differences or an unclean session, 2 usage or harness error",
    run: async ({ values: o, positionals, log }) => {
      const format = formatOption(o);
      const dir = oneBundle("compare", positionals, "bundle.json");
      const bundle = readBundle(dir);
      const summary = await compareBundle(dir, bundle, { log, refEvidence: strings(o, "ref-evidence").map((d) => resolve(d)) });
      bundle.normalization = summary.normalization;
      writeJsonAtomic(join(dir, "bundle.json"), bundle);
      return printSummary(summary, format);
    },
  },
  {
    name: "summary",
    summary: "print an answer-diff bundle's summary again",
    usage: "summary <bundle-dir> [--format text|md|json|csv]",
    about: "Prints the summary.json of an lsp-diff bundle as lsp-diff did.",
    positionals: true,
    options: [REPORT],
    examples: ["parallax summary /tmp/hono-diff", "parallax summary /tmp/hono-diff --format md >> $GITHUB_STEP_SUMMARY"],
    exit: "0 clean, 1 differences or an unclean session, 2 usage or harness error",
    run: async ({ values: o, positionals }) => {
      const format = formatOption(o);
      const dir = oneBundle("summary", positionals, "summary.json");
      const summary = readJsonFile(join(dir, "summary.json")) as Summary & { schema?: string };
      // summary and bench-summary are the easiest pair to mix up: name the right one.
      if (summary.schema === "parallax.bench-summary/1" || summary.schema === "parallax.lsp-bench-summary/1")
        throw new UsageError(`${dir} is a ${summary.schema === "parallax.bench-summary/1" ? "bench" : "lsp-bench"} bundle: its report is \`parallax bench-summary ${positionals[0]}\``);
      return printSummary(summary, format);
    },
  },
  {
    name: "bench",
    summary: "time each side's check command in alternating rounds",
    usage: `bench --project <dir> --ref <profile>=<bin> --cand ${SIDE} [--cand ...] --out <dir> [options]`,
    about:
      "Times each side's check command (from its profile) on one project in rounds: wait for an idle machine, time a canary, run every side once in alternating order, time the canary again, and reject the round if other programs used the CPU or the machine changed speed. Candidates are compared with the reference by their per-round time ratio. After --runs rounds it looks at the calls, and goes on (looking every 3 rounds) while any is unsettled, up to --max-runs. Prints a table of sides and one of candidates (ratio, interval, call); progress goes to stderr. docs/measurement.md is the method.",
    longRunning: true,
    options: [
      { title: "sides and project", opts: [PROJECT, REF, CAND, OUT, ...CHECK] },
      ROUNDS,
      MACHINE,
      ENVIRONMENT,
      POLICY("bench"),
      REPORT,
    ],
    examples: [
      "parallax bench --project ~/src/hono --config tsconfig.build.json --ref tsc7=$TSGO --cand tsrs=$TSRS --out /tmp/hono-bench",
      "parallax bench ... --threads default --runs 9 --max-runs 21 --resolution 0.02",
    ],
    exit: "0 measured cleanly (and the --fail-on policy passed), 1 not measured cleanly (too few rounds, a side failed), 2 usage or harness error, 3 measured cleanly but the --fail-on policy failed",
    run: async ({ values: o, log }) => {
      const format = formatOption(o);
      const policy = policyOption(o, "cli-bench");
      const t0 = performance.now();
      const r = await bench({
        project: o.project as string,
        out: o.out as string,
        ref: o.ref as string,
        cands: o.cand as string[],
        ...defined({ config: o.config as string | undefined, timeoutMs: positive(o, "timeout-ms"), counterRuns: int(o, "counter-runs") }),
        ...roundOptions(o),
        log,
      });
      log(`done in ${fmtElapsed(performance.now() - t0)}: bundle ${r.dir}`);
      console.log(formatBench(r.summary, format, outPaint(format)));
      return decide(r.summary.clean, policy && evaluateBenchPolicy(r.summary, policy));
    },
  },
  {
    name: "lsp-bench",
    summary: "time each side's language server through scripted editor sessions",
    usage: `lsp-bench --project <dir> --ref <profile>=<bin> --cand ${SIDE} [--cand ...] --out <dir> [options]`,
    about:
      "Times each side's language server in the same rounds as bench, through one editor session per side per round: open (time to first diagnostics), edit (first request after an edit, CPU per edit), typing (latency from when each key was due, CPU per key), service (closed loop: the server's own time per request), paused (keys after quiet), errfix (an error shown and cleared), imports (cross-file completion and the add-import fix), long (drift and memory growth per edit). Every request of every session is kept in the bundle.",
    longRunning: true,
    options: [{ title: "sides and project", opts: [PROJECT, REF, CAND, OUT] }, SESSION, ROUNDS, MACHINE, ENVIRONMENT, POLICY("lsp-bench"), REPORT],
    examples: [
      "parallax lsp-bench --project ~/src/umami --ref tsc7=$TSGO --cand tsrs=$TSRS --out /tmp/umami-lsp",
      "parallax lsp-bench ... --threads default --long-edits 0 --imports 0",
    ],
    exit: "0 measured cleanly (and the --fail-on policy passed), 1 not measured cleanly (too few rounds, a session failed), 2 usage or harness error, 3 measured cleanly but the --fail-on policy failed",
    run: async ({ values: o, log }) => {
      const format = formatOption(o);
      const policy = policyOption(o, "lsp-bench");
      const t0 = performance.now();
      const r = await lspBench({
        project: o.project as string,
        out: o.out as string,
        ref: o.ref as string,
        cands: o.cand as string[],
        ...lspSessionOptions(o),
        ...roundOptions(o),
        log,
      });
      log(`done in ${fmtElapsed(performance.now() - t0)}: bundle ${r.dir}`);
      console.log(formatLspBench(r.summary, format, outPaint(format)));
      return decide(r.summary.clean, policy && evaluateLspPolicy(r.summary, policy));
    },
  },
  {
    name: "calibrate",
    summary: "bench one binary against itself: this machine's noise floor",
    usage: `calibrate --kind bench|lsp-bench --project <dir> --side ${SIDE} --out <dir> [options of that kind]`,
    about:
      "An A/A bench: one side against itself (the same profile and binary as <label>.aa) for a fixed number of rounds. Any difference found is this machine's noise; the noise floor per metric is kept in the config directory, and later benches on the same host setup warn when their --resolution is below it. Takes the options of its kind (bench or lsp-bench) except --max-runs.",
    longRunning: true,
    options: [
      {
        title: "calibration",
        opts: [
          { name: "kind", value: "bench|lsp-bench", required: true, help: "which bench to calibrate" },
          PROJECT,
          { name: "side", value: SIDE, required: true, help: "the binary to bench against itself" },
          OUT,
          { name: "no-save", help: "keep the calibration in the bundle only, not for later benches" },
        ],
      },
      { title: "bench only", opts: CHECK },
      { title: "lsp-bench only (0 skips a phase)", opts: SESSION.opts },
      { title: ROUNDS.title, opts: ROUNDS.opts.filter((x) => x.name !== "max-runs").map((x) => (x.name === "runs" ? { ...x, default: String(DEFAULT_CALIBRATION_RUNS), help: "rounds (a fixed number)" } : x)) },
      MACHINE,
      ENVIRONMENT,
      REPORT,
    ],
    examples: ["parallax calibrate --kind bench --project ~/src/hono --side tsc7=$TSGO --out /tmp/hono-aa"],
    exit: "0 the calibration was kept (or --no-save), 1 the A/A bench was not measured cleanly and nothing was kept, 2 usage or harness error",
    run: async ({ values: o, log }) => {
      if (o.kind !== "bench" && o.kind !== "lsp-bench") throw new UsageError("calibrate needs --kind bench or --kind lsp-bench");
      // Options of the other kind would be ignored: refuse them rather than calibrate another workload.
      const foreign = (o.kind === "bench" ? SESSION.opts : CHECK).map((x) => x.name).filter((k) => o[k] !== undefined);
      if (foreign.length) throw new UsageError(`calibrate --kind ${o.kind} does not take ${foreign.map((k) => `--${k}`).join(", ")}`);
      const format = formatOption(o);
      const t0 = performance.now();
      const r = await calibrate({
        kind: o.kind === "bench" ? "cli-bench" : "lsp-bench",
        side: o.side as string,
        project: o.project as string,
        out: o.out as string,
        save: o["no-save"] !== true,
        ...defined({ config: o.config as string | undefined, timeoutMs: positive(o, "timeout-ms"), counterRuns: int(o, "counter-runs") }),
        ...lspSessionOptions(o),
        ...roundOptions(o),
        log,
      });
      log(`done in ${fmtElapsed(performance.now() - t0)}: bundle ${r.dir}`);
      // The other formats carry the calibration alone; text and md say where it was kept.
      if (r.file && (format === "json" || format === "csv")) log(`kept for later benches on this host setup: ${r.file}`);
      console.log(formatCalibration(r.calibration, r.file, format, outPaint(format)));
      return r.file || o["no-save"] ? 0 : 1;
    },
  },
  {
    name: "bench-summary",
    summary: "recompute a bench or lsp-bench bundle's summary, optionally with other gates",
    usage: "bench-summary <bundle-dir> [--max-outside-cores <cores>] [--max-canary-drift <fraction>] [--fail-on <list>] [--format text|md|json|csv]",
    about: "Recomputes summary.json of a bench or lsp-bench bundle from samples.jsonl, which keeps every sample and round, rejected ones included, and prints the report again. Other gates can be tried after the fact.",
    positionals: true,
    options: [{ title: "gates", opts: MACHINE.opts.filter((x) => x.name.startsWith("max-") && x.name !== "max-busy-cores").map((x) => ({ ...x, default: "the bundle's" })) }, POLICY("both"), REPORT],
    examples: ["parallax bench-summary /tmp/hono-bench --max-outside-cores 0.5"],
    exit: "0 measured cleanly (and the --fail-on policy passed), 1 not measured cleanly, 2 usage or harness error, 3 measured cleanly but the --fail-on policy failed",
    run: async ({ values: o, positionals }) => {
      const format = formatOption(o);
      const dir = oneBundle("bench-summary", positionals, "bundle.json");
      const kind = (readJsonFile(join(dir, "bundle.json")) as { kind?: string }).kind;
      if (kind === "lsp-answer-diff") throw new UsageError(`${dir} is an lsp-diff bundle: its report is \`parallax summary ${positionals[0]}\` (or \`parallax compare\` to recompute it)`);
      const policy = policyOption(o, kind === "lsp-bench" ? "lsp-bench" : "cli-bench");
      if (kind === "lsp-bench") {
        const bundle = readLspBenchBundle(dir);
        const summary = summarizeLspBenchBundle(dir, bundle, { ...bundle.settings.gates, ...gateOptions(o) });
        console.log(formatLspBench(summary, format, outPaint(format)));
        return decide(summary.clean, policy && evaluateLspPolicy(summary, policy));
      }
      const bundle = readBenchBundle(dir);
      const summary = summarizeBenchBundle(dir, bundle, { ...bundle.settings.gates, ...gateOptions(o) });
      console.log(formatBench(summary, format, outPaint(format)));
      return decide(summary.clean, policy && evaluateBenchPolicy(summary, policy));
    },
  },
  {
    name: "compare-results",
    summary: "compare two saved runs of the same project: did the candidates get faster or slower?",
    usage: "compare-results <old> <new> [options]",
    about:
      "Compares two saved runs (published result files, or bench / lsp-bench bundle directories) of the same project: for each candidate (and lsp-bench metric), its per-round ratios to the reference in the new run against those in the old. The runs are independent, so this is a two-sample comparison (Hodges-Lehmann shift of the log ratios, with a Mann-Whitney interval), each row at --confidence, as bench calls each comparison (--family-wise: Bonferroni over every row, so it holds for the whole report). Ratios to the in-run reference cancel most of a difference in machine speed; absolute times are shown only when both runs come from the same machine. docs/measurement.md, \"Comparing two runs\", is the method.",
    positionals: true,
    options: [
      {
        title: "comparison",
        opts: [
          { name: "resolution", value: "<fraction>", default: "0.05", help: "new/old within this fraction is the same" },
          { name: "resolution-ms", value: "<ms>", default: "1", help: "or within this many milliseconds of the old candidate's time, where that is wider" },
          { name: "confidence", value: "<p>", default: "0.95", help: "for each row; with --family-wise, for the whole report" },
          { name: "family-wise", help: "split the confidence over every row (Bonferroni): any false call anywhere at most 1 - confidence; wider intervals, so runs need more rounds" },
          { name: "metrics", value: "<key,...>", help: "lsp-bench: compare only these metrics (narrows the report, the policy and any --family-wise correction)" },
          { name: "allow-project-change", help: "compare runs of different project commits" },
        ],
      },
      { title: "CI policy (exit 3 when it fails)", opts: [{ name: "fail-on", value: "<list>", help: "comma list: worse (a call worse), unresolved (a call unresolved or too few rounds, or a candidate noisy or failed in either run)" }, FAIL_THRESHOLD] },
      { title: "report", opts: [{ ...FORMAT, help: "text, md (GitHub Markdown), json (the comparison object, with the policy decision), csv (one row per comparison)" }] },
    ],
    examples: ["parallax compare-results results/main.json results/branch.json --fail-on worse", "parallax compare-results /tmp/hono-bench-main /tmp/hono-bench-pr --format json"],
    exit: "0 compared (and the --fail-on policy passed), 2 usage error or runs that cannot be compared, 3 the --fail-on policy failed",
    run: async ({ values: o, positionals }) => {
      if (positionals.length !== 2) throw new UsageError("compare-results needs two runs: <old> <new> (result files or bundle directories)");
      const format = formatOption(o);
      const confidence = num(o, "confidence");
      if (confidence !== undefined && !(confidence > 0 && confidence < 1)) throw new UsageError("--confidence wants a number between 0 and 1 (0.95)");
      let policy: Policy | null;
      let metrics: string[] | null = null;
      try {
        // The kind is not known until the runs are read; a CLI bench refuses --metrics there.
        policy = parsePolicy({ failOn: str(o, "fail-on"), threshold: str(o, "fail-threshold") }, "compare-lsp-bench");
        if (typeof o.metrics === "string") metrics = parseMetricKeys(o.metrics, "--metrics");
      } catch (e) {
        throw e instanceof PolicyError ? new UsageError(e.message) : e;
      }
      for (const p of positionals) if (!existsSync(p)) throw new NotFoundError(`no run at ${resolve(p)}`);
      const resolution = num(o, "resolution");
      const resolutionMs = num(o, "resolution-ms");
      let c;
      try {
        c = compareResults(positionals[0]!, positionals[1]!, {
          ...(resolution !== undefined || resolutionMs !== undefined ? { resolution: { relative: resolution ?? 0.05, floorMs: resolutionMs ?? 1 } } : {}),
          ...defined({ confidence }),
          familyWise: o["family-wise"] === true,
          metrics,
          allowProjectChange: o["allow-project-change"] === true,
          policy,
        });
      } catch (e) {
        if (!(e instanceof CompareError)) throw e;
        console.error(`${errPaint()("bad", "error:")} compare-results: ${e.message}`);
        return 2;
      }
      console.log(format === "json" ? JSON.stringify(c, null, 2) : format === "md" ? comparisonMarkdown(c) : format === "csv" ? comparisonCsv(c) : renderComparison(c, outPaint(format)));
      // CSV has no place for the decision (json carries it as a field; text and md print it): it goes to
      // stderr, as for bench.
      if (format === "csv" && c.policy) console.error(paintDecision(renderDecision(c.policy), c.policy.passed));
      return exitStatus(true, c.policy);
    },
  },
  {
    name: "publish",
    summary: "write a bench or lsp-bench bundle as one result file fit to publish",
    usage: "publish <bundle-dir> --out <results-dir> [--allow-dirty]",
    about:
      "Writes the bundle as one result file under <results-dir>/<kind>/<project>/: the per-round records, the summary and provenance (harness commit, binaries' sha256 and versions, the project's repository and commit, the machine). No hostname, absolute paths, outputs or per-request logs. Prints the file's path.",
    positionals: true,
    options: [
      {
        title: "options",
        opts: [
          { name: "out", value: "<results-dir>", required: true, help: "the results collection to write into" },
          { name: "allow-dirty", help: "publish a bundle made by a harness with uncommitted changes (its result cannot be verified)" },
        ],
      },
    ],
    examples: ["parallax publish /tmp/hono-bench --out ~/src/parallax-results"],
    run: async ({ values: o, positionals, log }) => {
      const dir = oneBundle("publish", positionals, "bundle.json");
      const { file, result } = publish({ bundleDir: dir, out: o.out as string, allowDirty: o["allow-dirty"] === true, log });
      console.log(`${file}\n${result.kind} of ${result.project.name}, ${result.sides.length} sides, ${result.records.length} records`);
      return 0;
    },
  },
  {
    name: "verify-result",
    summary: "check published result files",
    usage: "verify-result <result.json>...",
    about: "Checks each result's id and that its summary is what its records give.",
    positionals: true,
    options: [],
    examples: ["parallax verify-result ~/src/parallax-results/cli-bench/hono/*.json"],
    exit: "0 every result checks out, 1 some did not, 2 usage or harness error",
    run: async ({ positionals }) => {
      if (!positionals.length) throw new UsageError("verify-result needs result files");
      let bad = 0;
      for (const f of positionals) {
        const v = verifyResult(f);
        if (!v.ok) bad++;
        console.log(`${v.ok ? "ok" : "FAILED"} ${f}${v.harnessDiffers ? " (made by another harness commit)" : ""}${v.problems.map((p) => `\n  ${p}`).join("")}`);
      }
      return bad ? 1 : 0;
    },
  },
  {
    name: "suite list",
    summary: "list the suite's projects (suite.json)",
    usage: "suite list",
    about: "Lists the projects in suite.json with their repository, commit and what is benched on each.",
    options: [],
    examples: ["parallax suite list"],
    run: async () => {
      for (const p of loadSuite().projects)
        console.log(`${p.name.padEnd(10)} ${p.repository}@${p.commit.slice(0, 12)}  ${[p.bench ? `bench ${p.bench.config}` : "", p.lspBench ? "lsp-bench" : ""].filter(Boolean).join(", ")}`);
      return 0;
    },
  },
  {
    name: "suite fetch",
    summary: "fetch suite projects at their commits and install them",
    usage: "suite fetch [<project>...]",
    about: "Clones each suite project (or those named) at its pinned commit into the suite cache (PARALLAX_SUITE_DIR, else the OS's cache directory) and installs it with its own package manager, install scripts skipped. Prints each project's directory.",
    positionals: true,
    options: [],
    examples: ["parallax suite fetch hono"],
    run: async ({ positionals, log }) => {
      for (const p of selectProjects(loadSuite(), positionals)) console.log(`${p.name}: ${fetchProject(p, log)}`);
      return 0;
    },
  },
  {
    name: "suite run",
    summary: "bench every suite project (or those named) with the suite's settings",
    usage: `suite run --ref <profile>=<bin> --cand ${SIDE} [--cand ...] --out <dir> [options] [<project>...]`,
    about:
      "Fetches each suite project and runs its bench and lsp-bench with the suite's settings (config, files), so results from different machines measure the same thing. Bundles go to <out>/<project>-bench and <out>/<project>-lsp-bench; prints one line per bundle.",
    positionals: true,
    longRunning: true,
    options: [
      {
        title: "sides and output",
        opts: [
          REF,
          CAND,
          { name: "out", value: "<dir>", required: true, help: "the directory the bundles go into" },
          { name: "only", value: "bench|lsp-bench", help: "run only this kind of bench" },
          { name: "publish", value: "<results-dir>", help: "publish each bundle into this results collection" },
        ],
      },
      ROUNDS,
      MACHINE,
      ENVIRONMENT,
    ],
    examples: ["parallax suite run --ref tsc7=$TSGO --cand tsrs=$TSRS --out /tmp/suite --publish ~/src/parallax-results"],
    exit: "0 every bench measured cleanly, 1 some did not, 2 usage or harness error",
    run: async ({ values: o, positionals, log }) => {
      if (o.only !== undefined && o.only !== "bench" && o.only !== "lsp-bench") throw new UsageError("--only wants bench or lsp-bench");
      const t0 = performance.now();
      const outcomes = await suiteRun({
        ref: o.ref as string,
        cands: o.cand as string[],
        out: o.out as string,
        projects: positionals,
        ...(o.only ? { only: o.only as "bench" | "lsp-bench" } : {}),
        ...(typeof o.publish === "string" ? { publishTo: o.publish } : {}),
        ...roundOptions(o),
        log,
      });
      log(`done in ${fmtElapsed(performance.now() - t0)}`);
      for (const x of outcomes) console.log(`${x.project} ${x.kind}: ${x.clean ? "measured" : "NOT MEASURED CLEANLY"} ${x.dir}${x.published ? ` -> ${x.published}` : ""}`);
      return outcomes.every((x) => x.clean) ? 0 : 1;
    },
  },
  {
    name: "import-lspdiff",
    summary: "turn an old lspdiff tool's logs into an answer-diff bundle",
    usage: "import-lspdiff --from <old-out-dir> --project <dir> --ref <profile>=<bin> --cand <profile>=<bin> --out <dir>",
    about: "Turns the go.jsonl, go2.jsonl and rs.jsonl written by the tsc-rs fork's `scripts/lspdiff diff` into a bundle and compares it, to check results against that tool's.",
    options: [
      {
        title: "options",
        opts: [
          { name: "from", value: "<old-out-dir>", required: true, help: "the lspdiff output directory (<out>/<project>-diff)" },
          PROJECT,
          { ...REF },
          { ...CAND, multiple: false, value: "<profile>=<bin>", help: "the candidate the logs came from" },
          OUT,
        ],
      },
      REPORT,
    ],
    examples: ["parallax import-lspdiff --from out/hono-diff --project ~/src/hono --ref tsc7=$TSGO --cand tsrs=$TSRS --out /tmp/hono-import"],
    exit: "0 clean, 1 differences, 2 usage or harness error",
    run: async ({ values: o, log }) => {
      const format = formatOption(o);
      const r = await importLspdiff({ from: o.from as string, project: o.project as string, out: o.out as string, ref: o.ref as string, cand: o.cand as string, log });
      log(`bundle ${r.dir}`);
      return printSummary(r.summary, format);
    },
  },
];

function printSummary(summary: Summary, format: Format): number {
  console.log(formatSummary(summary, format, outPaint(format)));
  return summary.clean ? 0 : 1;
}

const str = (o: Values, k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : undefined);

function policyOption(o: Values, kind: "cli-bench" | "lsp-bench"): Policy | null {
  try {
    return parsePolicy({ failOn: str(o, "fail-on"), threshold: str(o, "fail-threshold"), metrics: str(o, "fail-metrics") }, kind);
  } catch (e) {
    throw e instanceof PolicyError ? new UsageError(e.message) : e;
  }
}

// The policy's decision goes to stderr after the report, even with --quiet: CI logs show it, and
// stdout stays the report alone (a --format json consumer reads stdout).
function decide(clean: boolean, decision: PolicyDecision | null): number {
  if (decision) console.error(paintDecision(renderDecision(decision, clean), decision.passed));
  return exitStatus(clean, decision);
}

// Colour for the terminal (src/style.ts): stdout for the text report, stderr for the log, errors and
// the policy's decision. Each is plain unless its own stream is a terminal that takes colour.
const outPaint = (format: Format): Paint | undefined => (format === "text" ? paintFor(process.stdout) : undefined);
let stderrPaint: Paint | undefined;
const errPaint = (): Paint => (stderrPaint ??= paintFor(process.stderr));
// The decision's first line names the outcome ("passed" / "FAILED (2 failures)"): that word in colour.
const paintDecision = (text: string, passed: boolean): string =>
  text.replace(/: (passed|FAILED \([^)]*\))/, (_m, w: string) => `: ${errPaint()(passed ? "good" : "bad", w)}`);

function formatOption(o: Values): Format {
  try {
    return parseFormat(typeof o.format === "string" ? o.format : undefined);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

// ---------------------------------------------------------------------------------------------
// Help

const GENERAL: Opt[] = [{ name: "help", short: "h", help: "this help" }];
const QUIET: Opt = { name: "quiet", short: "q", help: "no progress lines; warnings and errors are still shown" };

const generalOpts = (c: Command): Opt[] => (c.longRunning ? [QUIET, ...GENERAL] : GENERAL);

const EXIT_STATUS = `exit status:
  0  clean: no differences, every session clean, every bench measured cleanly
  1  a finding: differences, an unclean session, or a bench not measured cleanly
  2  usage or harness error (compare-results: runs that cannot be compared)
  3  measured cleanly, but the --fail-on policy failed (bench, lsp-bench, bench-summary, compare-results)`;

const OVERVIEW_EXAMPLES = [
  "parallax bench --project ~/src/hono --ref tsc7=$TSGO --cand tsrs=$TSRS --out /tmp/hono-bench",
  "parallax lsp-diff --project ~/src/hono --ref tsc7=$TSGO --cand tsrs=$TSRS --out /tmp/hono-diff",
  "parallax bench-summary /tmp/hono-bench --max-outside-cores 0.5",
];

function overview(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    "parallax: parity and performance harness for TypeScript compilers and language servers",
    "",
    "usage: parallax <command> [options]",
    "       parallax <command> --help     that command's options, with defaults and an example",
    "       parallax --version",
    "",
    "commands:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "examples:",
    ...OVERVIEW_EXAMPLES.map((e) => `  ${e}`),
    "",
    EXIT_STATUS,
    "",
    `A side is ${SIDE}: a profile (a name in profiles/: tsc7, tsrs, tsc-rs-fork; or a`,
    "path to a profile JSON file) bound to a binary. The report goes to stdout; progress and warnings go",
    "to stderr. PARALLAX_DEBUG=1 shows the stack of a harness error.",
    "More: README.md and docs/measurement.md in the parallax repository.",
  ].join("\n");
}

function commandHelp(c: Command): string {
  const groups = [...c.options, { title: "general", opts: generalOpts(c) }].filter((g) => g.opts.length);
  const left = (x: Opt): string => `${x.short ? `-${x.short}, ` : "    "}--${x.name}${x.value ? ` ${x.value}` : ""}`;
  const col = Math.min(34, Math.max(...groups.flatMap((g) => g.opts.map((x) => left(x).length))) + 4);
  const lines = [`usage: parallax ${c.usage}`, "", ...wrap(c.about, 100), ""];
  for (const g of groups) {
    lines.push(`${g.title}:`);
    for (const x of g.opts) {
      const notes = [x.required ? "required" : "", x.multiple ? "repeatable" : "", x.default ? `default ${x.default}` : ""].filter(Boolean);
      const text = `${x.help}${notes.length ? ` (${notes.join("; ")})` : ""}`;
      const head = `  ${left(x)}`;
      const body = wrap(text, 100 - col);
      if (head.length + 2 > col) lines.push(head, ...body.map((l) => " ".repeat(col) + l));
      else lines.push(head.padEnd(col) + body[0], ...body.slice(1).map((l) => " ".repeat(col) + l));
    }
    lines.push("");
  }
  lines.push(c.examples.length > 1 ? "examples:" : "example:", ...c.examples.map((e) => `  ${e}`), "");
  lines.push(`exit status: ${c.exit ?? "0 success, 2 usage or harness error"}`);
  return lines.join("\n");
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

// The short form printed with a usage error: the synopsis and where the rest is.
const usageHint = (c: Command): string => `usage: parallax ${c.usage}\nmore: parallax ${c.name} --help`;

function versionText(): string {
  const h = harnessInfo();
  const commit = h.gitCommit ? `${h.gitCommit}${h.gitDirty ? " (uncommitted changes)" : ""}` : "unknown";
  return `parallax ${h.version}\ncommit ${commit}\nnode ${h.node}`;
}

// ---------------------------------------------------------------------------------------------
// Dispatch

class UsageError extends Error {
  command: Command | undefined;
  constructor(message: string, command?: Command) {
    super(message);
    this.command = command;
  }
}

// A missing bundle or file: one line, no stack, whatever PARALLAX_DEBUG says.
class NotFoundError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (!first) {
    console.error(overview());
    return 2;
  }
  if (first === "--help" || first === "-h") {
    console.log(overview());
    return 0;
  }
  if (first === "--version" || first === "-V") {
    console.log(versionText());
    return 0;
  }
  if (first === "help") {
    if (!rest.length) {
      console.log(overview());
      return 0;
    }
    const { command } = findCommand(rest);
    console.log(command ? commandHelp(command) : groupHelp(rest[0]!));
    return 0;
  }
  const { command, args } = findCommand(argv);
  if (!command) {
    if (isGroup(first)) {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(groupHelp(first));
        return 0;
      }
      throw new UsageError(`${first} wants ${list(COMMANDS.filter((c) => c.name.startsWith(`${first} `)).map((c) => c.name.split(" ")[1]!), "or")}${args[0] ? `, not ${JSON.stringify(args[0])}` : ""}\n\n${groupHelp(first)}`);
    }
    throw new UsageError(`unknown command ${JSON.stringify(first)}${didYouMean(first, [...COMMANDS.map((c) => c.name.split(" ")[0]!), "help"])}\nparallax --help lists the commands`);
  }
  return runCommand(command, args);
}

function findCommand(argv: string[]): { command: Command | undefined; args: string[] } {
  const two = argv.slice(0, 2).join(" ");
  const sub = COMMANDS.find((c) => c.name === two);
  if (sub) return { command: sub, args: argv.slice(2) };
  return { command: COMMANDS.find((c) => c.name === argv[0]), args: argv.slice(1) };
}

const isGroup = (name: string): boolean => COMMANDS.some((c) => c.name.startsWith(`${name} `));

function groupHelp(name: string): string {
  const subs = COMMANDS.filter((c) => c.name.startsWith(`${name} `));
  if (!subs.length) throw new UsageError(`unknown command ${JSON.stringify(name)}\nparallax --help lists the commands`);
  const width = Math.max(...subs.map((c) => c.name.length));
  return [`usage: parallax ${name} <${subs.map((c) => c.name.split(" ")[1]).join("|")}> ...`, "", ...subs.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`), "", `more: parallax ${subs[0]!.name} --help`].join("\n");
}

async function runCommand(c: Command, args: string[]): Promise<number> {
  const all = [...c.options.flatMap((g) => g.opts), ...generalOpts(c)];
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: c.positionals === true,
      options: Object.fromEntries(
        all.map((x) => [x.name, { type: x.value ? "string" : "boolean", ...(x.multiple ? { multiple: true } : {}), ...(x.short ? { short: x.short } : {}) }] as const),
      ),
    }) as { values: Values; positionals: string[] });
  } catch (e) {
    // Help wins over a bad option elsewhere on the line.
    if (args.includes("--help") || args.includes("-h")) {
      console.log(commandHelp(c));
      return 0;
    }
    throw new UsageError(parseError(e, all), c);
  }
  if (values.help) {
    console.log(commandHelp(c));
    return 0;
  }
  try {
    if (positionals.some((p) => !p.trim())) throw new UsageError("an argument is empty (an unset shell variable?)");
    checkValues(c, values, all);
  } catch (e) {
    if (e instanceof UsageError) e.command = c;
    throw e;
  }
  const missing = all.filter((x) => x.required && (values[x.name] === undefined || (Array.isArray(values[x.name]) && !(values[x.name] as string[]).length)));
  if (missing.length) throw new UsageError(`${c.name} needs ${list(missing.map((x) => `--${x.name}`))}`, c);
  const log = createLog({
    quiet: values.quiet === true,
    elapsed: c.longRunning === true,
    paint: errPaint(),
    // A status line only where someone watches: stderr a terminal that can erase a line (not
    // TERM=dumb), and a command that runs for a while.
    ...(c.longRunning && process.stderr.isTTY && process.env.TERM !== "dumb" ? { status: { raw: (s: string) => void process.stderr.write(s), columns: () => process.stderr.columns || 80 } } : {}),
  });
  try {
    return await c.run({ values, positionals, log });
  } catch (e) {
    if (e instanceof UsageError && !e.command) e.command = c;
    throw e;
  }
}

// Every option value the line gives, checked before the missing options are reported and before any
// file is touched: told only that --project is missing, a user who also wrote `--runs abc` would learn
// of that on the next try. The handlers check again and stay the authority, so this must never refuse
// a value a handler takes; it uses their functions and messages where it can.
function checkValues(c: Command, values: Values, opts: Opt[]): void {
  for (const x of opts) {
    const v = values[x.name];
    if (!x.value || v === undefined || typeof v === "boolean") continue;
    // An unset shell variable (`--out "$OUT"`, `--warmup=$N`) gives an empty value, which would
    // otherwise be read as 0 or as the working directory.
    for (const one of Array.isArray(v) ? v : [v]) {
      if (!one.trim()) throw new UsageError(`--${x.name} is empty; it wants ${x.value} (an unset shell variable?)`);
      if (x.value.endsWith("=<bin>")) parseSideSpec(one);
    }
    if (typeof v !== "string") continue;
    if (x.name === "threads") roundThreads(values);
    else if (x.name === "env") envOption(values);
    else if (x.name === "pin") pinOption(v);
    else if (x.value === "<n>") int(values, x.name, x.min ?? 0);
    else if (x.value === "<p>") probability(values, x.name, x.default);
    else if (["<ms>", "<s>", "<cores>", "<fraction>"].includes(x.value)) (x.positive ? positive : num)(values, x.name);
    else if (x.value === "<key,...>") policyText(() => parseMetricKeys(v, `--${x.name}`));
    else if (/^[\w-]+(\|[\w-]+)+$/.test(x.value)) {
      const words = x.value.split("|");
      if (!words.includes(v)) throw new UsageError(`--${x.name} wants ${list(words, "or")} (got ${JSON.stringify(v)})`);
    }
  }
  const kinds = POLICY_KINDS[c.name];
  if (!kinds) return;
  // --fail-threshold's own value first: parsed without --fail-on, it would be told only that.
  const threshold = str(values, "fail-threshold");
  if (threshold !== undefined) policyText(() => parsePolicy({ failOn: "slower", threshold }, "cli-bench"));
  // bench-summary learns the bundle's kind only from the bundle: a policy either kind takes may do.
  const text = { failOn: str(values, "fail-on"), threshold, metrics: str(values, "fail-metrics") };
  const errors: PolicyError[] = [];
  for (const k of kinds) {
    try {
      parsePolicy(text, k);
      return;
    } catch (e) {
      if (!(e instanceof PolicyError)) throw e;
      errors.push(e);
    }
  }
  // With --fail-metrics the policy is for an lsp-bench bundle: that kind's complaint is the one to show.
  throw new UsageError(errors[text.metrics !== undefined ? errors.length - 1 : 0]!.message);
}

// The kinds of report each command's --fail-on is parsed for (as its handler parses it).
const POLICY_KINDS: Record<string, Parameters<typeof parsePolicy>[1][]> = {
  bench: ["cli-bench"],
  "lsp-bench": ["lsp-bench"],
  "bench-summary": ["cli-bench", "lsp-bench"],
  "compare-results": ["compare-lsp-bench"],
};

// A PolicyError is a usage error.
function policyText<T>(parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    throw e instanceof PolicyError ? new UsageError(e.message) : e;
  }
}

const list = (xs: string[], and = "and"): string => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} ${and} ${xs.at(-1)}` : (xs[0] ?? ""));

// parseArgs's messages, in this CLI's words.
function parseError(e: unknown, opts: Opt[]): string {
  const err = e as Error & { code?: string };
  // Node names an option with a short alias as '-q, --quiet': take the long name.
  const name = /'(?:-[^-' ,], )?(-[^' ,]+)/.exec(err.message)?.[1];
  if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && name) return `unknown option ${name}${didYouMean(name.replace(/^-+/, ""), opts.map((x) => x.name), "--")}`;
  if (err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && name) {
    const opt = opts.find((x) => `--${x.name}` === name || (x.short && `-${x.short}` === name));
    return opt?.value ? `${name} wants a value: ${opt.value}` : `${name} takes no value`;
  }
  if (err.code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") return `unexpected argument ${/'([^']*)'/.exec(err.message)?.[1] ?? ""}: this command takes no positional arguments`;
  return err.message;
}

// " (did you mean --max-runs?)" for a near miss.
function didYouMean(word: string, names: string[], prefix = ""): string {
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of new Set(names)) {
    const d = n.startsWith(word) && word.length >= 3 ? 0 : editDistance(word, n);
    if (d < bestD) [best, bestD] = [n, d];
  }
  return best !== null && bestD <= Math.max(1, Math.round(word.length / 3)) ? ` (did you mean ${prefix}${best}?)` : "";
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

// The one bundle directory a command takes, with the file it reads first.
function oneBundle(command: string, positionals: string[], file: string): string {
  if (positionals.length !== 1) throw new UsageError(`${command} needs one bundle directory`);
  const dir = resolve(positionals[0]!);
  if (!existsSync(join(dir, file))) throw new NotFoundError(`no bundle at ${dir}: ${file} not found`);
  return dir;
}

// ---------------------------------------------------------------------------------------------
// Option values

function num(o: Values, name: string): number | undefined {
  const v = o[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isFinite(n) || n < 0) throw new UsageError(`--${name} wants a non-negative number`);
  return n;
}

// A whole number (counts of runs, edits, files): `min` 1 where 0 would mean nothing at all to do.
function int(o: Values, name: string, min = 0): number | undefined {
  const v = o[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isInteger(n) || n < min) throw new UsageError(`--${name} wants a whole number${min ? ` of at least ${min}` : ""}`);
  return n;
}

// A time limit: more than 0 (0 would mean no limit, and a server that never answers would hang).
function positive(o: Values, name: string): number | undefined {
  const n = num(o, name);
  if (n !== undefined && !(n > 0)) throw new UsageError(`--${name} wants a number more than 0`);
  return n;
}

// A probability, strictly between 0 and 1 (--confidence).
function probability(o: Values, name: string, example?: string): number | undefined {
  const n = num(o, name);
  if (n !== undefined && !(n > 0 && n < 1)) throw new UsageError(`--${name} wants a number between 0 and 1${example ? ` (${example})` : ""}`);
  return n;
}

const strings = (o: Values, name: string): string[] => (Array.isArray(o[name]) ? (o[name] as string[]) : []);

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

function lspSessionOptions(o: Values) {
  return {
    ...(Array.isArray(o.file) ? { file: o.file } : {}),
    ...defined({
      files: int(o, "files", 1),
      edits: int(o, "edits"),
      intervalMs: positive(o, "interval-ms"),
      lines: int(o, "lines"),
      serviceLines: int(o, "service-lines"),
      pausedLines: int(o, "paused-lines"),
      pauseMs: num(o, "pause-ms"),
      errfixes: int(o, "errfixes"),
      imports: int(o, "imports"),
      longEdits: int(o, "long-edits"),
      requestTimeoutMs: positive(o, "request-timeout-ms"),
    }),
  };
}

function roundOptions(o: Values) {
  const idleTimeout = num(o, "idle-timeout-s");
  const env = envOption(o);
  return {
    ...defined({
      threads: roundThreads(o),
      env,
      pin: typeof o.pin === "string" ? pinOption(o.pin) : undefined,
      runs: int(o, "runs", 1),
      maxRuns: int(o, "max-runs"),
      minRounds: int(o, "min-runs", 1),
      resolution: num(o, "resolution"),
      resolutionMs: num(o, "resolution-ms"),
      warmup: int(o, "warmup"),
      attempts: int(o, "attempts", 1),
    }),
    idle: defined({
      maxBusyCores: num(o, "max-busy-cores"),
      timeoutMs: idleTimeout === undefined ? undefined : idleTimeout * 1000,
      bootSettleS: num(o, "boot-settle-s"),
    }),
    gates: gateOptions(o),
  };
}

// --threads: one mode, a comma list of them, or both.
function roundThreads(o: Values): ThreadMode[] | undefined {
  if (typeof o.threads !== "string") return undefined;
  try {
    return parseThreadModes(o.threads);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

// Checked here, before anything runs (a suite run would otherwise fetch a project first); the
// commands check it again against the cores this process may use.
function pinOption(list: string): string {
  try {
    if (process.platform !== "linux") throw new Error("--pin needs Linux (taskset)");
    expandCpuList(list);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  return list;
}

function envOption(o: Values): EnvPolicy | undefined {
  if (typeof o.env !== "string" && !Array.isArray(o["pass-env"])) return undefined;
  let env: EnvPolicy;
  try {
    env = { mode: typeof o.env === "string" ? parseEnvMode(o.env) : "sealed", pass: Array.isArray(o["pass-env"]) ? o["pass-env"] : [] };
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (env.mode === "inherit" && env.pass.length) throw new UsageError("--pass-env only applies to --env sealed");
  return env;
}

const gateOptions = (o: Values) => defined({ maxOutsideCores: num(o, "max-outside-cores"), maxCanaryDrift: num(o, "max-canary-drift") });

// ---------------------------------------------------------------------------------------------
// Errors

function report(e: unknown): void {
  if (e instanceof UsageError) {
    const c = e.command;
    console.error(`${errPaint()("bad", "error:")} ${e.message}${c ? `\n\n${usageHint(c)}` : ""}`);
    return;
  }
  if (e instanceof NotFoundError) {
    console.error(`${errPaint()("bad", "error:")} ${e.message}`);
    return;
  }
  // A mistake in what the user gave: the message is the whole story, so no hint to look at a stack.
  if (e instanceof InputError) {
    console.error(`${errPaint()("bad", "error:")} ${process.env.PARALLAX_DEBUG === "1" ? (e.stack ?? e.message) : e.message}`);
    return;
  }
  const err = e instanceof Error ? e : new Error(String(e));
  // A file named on the command line that is not there: one line, as for a missing bundle.
  const code = (err as NodeJS.ErrnoException).code;
  const path = (err as NodeJS.ErrnoException).path;
  if (code === "ENOENT" && path && process.env.PARALLAX_DEBUG !== "1") {
    console.error(`${errPaint()("bad", "error:")} ${path} not found`);
    return;
  }
  if (process.env.PARALLAX_DEBUG === "1") console.error(`${errPaint()("bad", "error:")} ${err.stack ?? err.message}`);
  else console.error(`${errPaint()("bad", "error:")} ${err.message} (PARALLAX_DEBUG=1 shows the stack)`);
}

// Exit once stdout and stderr have been written out. process.exit right after console.log drops
// whatever a pipe has not taken yet (a JSON report over 64 KiB reached a pipe truncated, exit 0); a
// write's callback runs after every earlier write on that stream, so waiting on an empty one is enough.
// It still exits rather than waiting for the event loop to empty: a server or timer left behind must
// not keep the harness running.
function exitAfterFlush(code: number): void {
  let pending = 2;
  const done = (): void => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

main(process.argv.slice(2)).then(
  (code) => exitAfterFlush(code),
  (e: unknown) => {
    report(e);
    exitAfterFlush(2);
  },
);
