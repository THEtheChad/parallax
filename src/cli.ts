#!/usr/bin/env node
// parallax: parity and performance harness for TypeScript compilers and language servers.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readBundle, writeJsonAtomic } from "./bundle/bundle.ts";
import { bench, readBenchBundle, summarizeBenchBundle } from "./commands/bench.ts";
import { importLspdiff } from "./commands/importLspdiff.ts";
import { lspBench, readLspBenchBundle, summarizeLspBenchBundle } from "./commands/lspBench.ts";
import { lspDiff } from "./commands/lspDiff.ts";
import { publish, verifyResult } from "./commands/publish.ts";
import { calibrate } from "./commands/calibrate.ts";
import { parseEnvMode, type EnvPolicy } from "./host/sealedEnv.ts";
import { expandCpuList } from "./host/pinning.ts";
import { suiteRun } from "./commands/suiteRun.ts";
import { parseThreadModes, type ThreadMode } from "./profile/profile.ts";
import { fetchProject, loadSuite, selectProjects } from "./suite/suite.ts";
import { compareBundle, type Summary } from "./diff/compare.ts";
import { renderSummary } from "./report/summary.ts";
import { formatBench, formatCalibration, formatLspBench, formatSummary, parseFormat, type Format } from "./report/render.ts";

const USAGE = `usage:
  parallax lsp-diff --project <dir> --ref <profile>=<bin> --cand [<label>:]<profile>=<bin> [--cand ...] --out <bundle-dir>
                    [--files 6] [--file <rel>]... [--positions 4] [--ref-runs 2] [--cand-runs 1] [--request-timeout-ms 600000]
                    [--ref-evidence <bundle-dir>]... [--env sealed|inherit] [--pass-env NAME]...
  parallax compare <bundle-dir> [--ref-evidence <bundle-dir>]...
                                         recompute verdicts.jsonl, summary.json and differences/ from runs/;
                                         reference answers in compatible evidence bundles count as reference variants
  parallax summary <bundle-dir>          print summary.json
  parallax bench --project <dir> --ref <profile>=<bin> --cand [<label>:]<profile>=<bin> [--cand ...] --out <bundle-dir>
                 [--config tsconfig.json] [--threads both|default|single] [--runs 6] [--max-runs 15] [--min-runs 3]
                 [--resolution 0.05] [--resolution-ms 1] [--warmup 1] [--attempts 3] [--timeout-ms 600000]
                 [--counter-runs 3] [--env sealed|inherit] [--pass-env NAME]... [--pin <cpu-list>]
                 [--max-busy-cores 1.5] [--idle-timeout-s 300] [--boot-settle-s 300]
                 [--max-outside-cores 1] [--max-canary-drift 0.1]
                                         time each side's check command in alternating rounds; candidates are
                                         compared by their per-round ratio to the reference
  parallax lsp-bench --project <dir> --ref <profile>=<bin> --cand [<label>:]<profile>=<bin> [--cand ...] --out <bundle-dir>
                     [--files 6] [--file <rel>]... [--edits 20] [--interval-ms 120] [--lines 4] [--service-lines 1]
                     [--paused-lines 1] [--pause-ms 300] [--errfixes 5] [--imports 3] [--long-edits 60] [--request-timeout-ms 120000]
                     [--threads both|default|single] [round, resolution, environment, pinning, idle and gate options as for bench]
                                         time each side's language server through one editor session per round:
                                         open (time to first diagnostics), edit (first request after an edit, CPU
                                         per edit), typing (latency from when each key was due, CPU per key),
                                         service (closed loop: the server's own time per request), paused (keys
                                         after quiet), errfix (an error shown and cleared), imports (cross-file
                                         completion and the add-import fix), long (drift and memory growth per edit)
  parallax calibrate --kind bench|lsp-bench --project <dir> --side [<label>:]<profile>=<bin> --out <bundle-dir>
                     [--runs 9] [--no-save] [the options of that kind]
                                         an A/A bench of one binary against itself: this machine's noise floor per
                                         metric, kept for later benches on the same host setup, which warn when
                                         their --resolution is below it
  parallax bench-summary <bundle-dir> [--max-outside-cores N] [--max-canary-drift F]
                                         recompute summary.json of a bench or lsp-bench bundle from samples.jsonl
                                         (optionally with other gates)
  parallax publish <bundle-dir> --out <results-dir> [--allow-dirty]
                                         write a bench or lsp-bench bundle as one result file fit to publish:
                                         records, summary and provenance; no hostname, paths or outputs
  parallax verify-result <result.json>...
                                         check each result's id and that its summary is what its records give
  parallax suite list
  parallax suite fetch [<project>...]    fetch suite projects (suite.json) at their commits and install them
  parallax suite run --ref <profile>=<bin> --cand ... --out <dir> [--only bench|lsp-bench]
                     [--publish <results-dir>] [round, resolution, idle and gate options] [<project>...]
                                         bench every suite project (or those named) with the suite's settings
  parallax import-lspdiff --from <old-out-dir> --project <dir> --ref <profile>=<bin> --cand <profile>=<bin> --out <bundle-dir>

Reports (bench, lsp-bench, calibrate, bench-summary, summary) take --format text|md|json|csv (default text).
Profiles are names in profiles/ (tsc7, tsrs, tsc-rs-fork) or paths to profile JSON files.
Exit status: 0 clean, 1 differences, unclean sessions or a bench not measured cleanly, 2 usage or harness error.`;

const log = (msg: string): void => console.error(msg);

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  if (command === "bench" || command === "lsp-bench" || command === "bench-summary" || command === "calibrate") return benchCommand(command, rest);
  if (command === "publish" || command === "verify-result" || command === "suite") return resultsCommand(command, rest);
  let summary: Summary;
  if (command === "lsp-diff") {
    const { values: o } = parseArgs({
      args: rest,
      options: {
        project: { type: "string" },
        out: { type: "string" },
        ref: { type: "string" },
        cand: { type: "string", multiple: true },
        files: { type: "string", default: "6" },
        file: { type: "string", multiple: true },
        positions: { type: "string", default: "4" },
        "ref-runs": { type: "string", default: "2" },
        "cand-runs": { type: "string", default: "1" },
        "request-timeout-ms": { type: "string", default: "600000" },
        "ref-evidence": { type: "string", multiple: true },
        env: { type: "string" },
        "pass-env": { type: "string", multiple: true },
      },
    });
    if (!o.project || !o.out || !o.ref || !o.cand?.length) throw new UsageError("lsp-diff needs --project, --out, --ref and --cand");
    const r = await lspDiff({
      project: o.project,
      out: o.out,
      ref: o.ref,
      cands: o.cand,
      files: int(o, "files", 1)!,
      ...(o.file ? { file: o.file } : {}),
      positions: int(o, "positions")!,
      refRuns: int(o, "ref-runs", 1)!,
      candRuns: int(o, "cand-runs", 1)!,
      requestTimeoutMs: positive(o, "request-timeout-ms")!,
      refEvidence: (o["ref-evidence"] ?? []).map((d) => resolve(d)),
      ...defined({ env: envOption(o) }),
      log,
    });
    summary = r.summary;
    log(`bundle ${r.dir}`);
  } else if (command === "import-lspdiff") {
    const { values: o } = parseArgs({
      args: rest,
      options: { from: { type: "string" }, project: { type: "string" }, out: { type: "string" }, ref: { type: "string" }, cand: { type: "string" } },
    });
    if (!o.from || !o.project || !o.out || !o.ref || !o.cand) throw new UsageError("import-lspdiff needs --from, --project, --out, --ref and --cand");
    const r = await importLspdiff({ from: o.from, project: o.project, out: o.out, ref: o.ref, cand: o.cand, log });
    summary = r.summary;
    log(`bundle ${r.dir}`);
  } else if (command === "compare") {
    const { values: o, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { "ref-evidence": { type: "string", multiple: true } } });
    if (positionals.length !== 1) throw new UsageError("compare needs one bundle directory");
    const dir = resolve(positionals[0]!);
    const bundle = readBundle(dir);
    summary = await compareBundle(dir, bundle, { log, refEvidence: (o["ref-evidence"] ?? []).map((d) => resolve(d)) });
    bundle.normalization = summary.normalization;
    writeJsonAtomic(join(dir, "bundle.json"), bundle);
  } else if (command === "summary") {
    const { values: o, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { format: { type: "string" } } });
    if (positionals.length !== 1) throw new UsageError("summary needs a bundle directory");
    const format = formatOption(o);
    summary = JSON.parse(readFileSync(join(resolve(positionals[0]!), "summary.json"), "utf8")) as Summary;
    console.log(formatSummary(summary, format));
    return summary.clean ? 0 : 1;
  } else {
    throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
  console.log(renderSummary(summary));
  return summary.clean ? 0 : 1;
}

function num(o: Record<string, string | boolean | string[] | undefined>, name: string): number | undefined {
  const v = o[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isFinite(n) || n < 0) throw new UsageError(`--${name} wants a non-negative number`);
  return n;
}

// A whole number (counts of runs, edits, files): `min` 1 where 0 would mean nothing at all to do.
function int(o: Record<string, string | boolean | string[] | undefined>, name: string, min = 0): number | undefined {
  const n = num(o, name);
  if (n !== undefined && (!Number.isInteger(n) || n < min)) throw new UsageError(`--${name} wants a whole number${min ? ` of at least ${min}` : ""}`);
  return n;
}

// A time limit: more than 0 (0 would mean no limit, and a server that never answers would hang).
function positive(o: Record<string, string | boolean | string[] | undefined>, name: string): number | undefined {
  const n = num(o, name);
  if (n !== undefined && !(n > 0)) throw new UsageError(`--${name} wants a number more than 0`);
  return n;
}

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const ROUND_OPTIONS = {
  threads: { type: "string" },
  runs: { type: "string" },
  "max-runs": { type: "string" },
  "min-runs": { type: "string" },
  resolution: { type: "string" },
  "resolution-ms": { type: "string" },
  warmup: { type: "string" },
  attempts: { type: "string" },
  "max-busy-cores": { type: "string" },
  "idle-timeout-s": { type: "string" },
  "boot-settle-s": { type: "string" },
  "max-outside-cores": { type: "string" },
  "max-canary-drift": { type: "string" },
  env: { type: "string" },
  "pass-env": { type: "string", multiple: true },
  pin: { type: "string" },
} as const;

const LSP_SESSION_OPTIONS = {
  files: { type: "string" },
  file: { type: "string", multiple: true },
  edits: { type: "string" },
  "interval-ms": { type: "string" },
  lines: { type: "string" },
  "service-lines": { type: "string" },
  "paused-lines": { type: "string" },
  "pause-ms": { type: "string" },
  errfixes: { type: "string" },
  imports: { type: "string" },
  "long-edits": { type: "string" },
  "request-timeout-ms": { type: "string" },
} as const;

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

type Values = Record<string, string | boolean | string[] | undefined>;

function roundOptions(o: Values) {
  const idleTimeout = num(o, "idle-timeout-s");
  let threads: ThreadMode[] | undefined;
  if (typeof o.threads === "string") {
    try {
      threads = parseThreadModes(o.threads);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  }
  const env = envOption(o);
  return {
    ...defined({
      threads,
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

function formatOption(o: Values): Format {
  try {
    return parseFormat(typeof o.format === "string" ? o.format : undefined);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

const gateOptions = (o: Values) => defined({ maxOutsideCores: num(o, "max-outside-cores"), maxCanaryDrift: num(o, "max-canary-drift") });

async function resultsCommand(command: string, rest: string[]): Promise<number> {
  if (command === "publish") {
    const { values: o, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { out: { type: "string" }, "allow-dirty": { type: "boolean" } } });
    if (positionals.length !== 1 || !o.out) throw new UsageError("publish needs one bundle directory and --out");
    const { file, result } = publish({ bundleDir: positionals[0]!, out: o.out, allowDirty: o["allow-dirty"] === true, log });
    console.log(`${file}\n${result.kind} of ${result.project.name}, ${result.sides.length} sides, ${result.records.length} records`);
    return 0;
  }
  if (command === "verify-result") {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
    if (!positionals.length) throw new UsageError("verify-result needs result files");
    let bad = 0;
    for (const f of positionals) {
      const v = verifyResult(f);
      if (!v.ok) bad++;
      console.log(`${v.ok ? "ok" : "FAILED"} ${f}${v.harnessDiffers ? " (made by another harness commit)" : ""}${v.problems.map((p) => `\n  ${p}`).join("")}`);
    }
    return bad ? 1 : 0;
  }
  // suite
  const [sub, ...args] = rest;
  if (sub === "list") {
    for (const p of loadSuite().projects)
      console.log(`${p.name.padEnd(10)} ${p.repository}@${p.commit.slice(0, 12)}  ${[p.bench ? `bench ${p.bench.config}` : "", p.lspBench ? "lsp-bench" : ""].filter(Boolean).join(", ")}`);
    return 0;
  }
  if (sub === "fetch") {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
    for (const p of selectProjects(loadSuite(), positionals)) console.log(`${p.name}: ${fetchProject(p, log)}`);
    return 0;
  }
  if (sub === "run") {
    const { values: o, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { out: { type: "string" }, ref: { type: "string" }, cand: { type: "string", multiple: true }, only: { type: "string" }, publish: { type: "string" }, ...ROUND_OPTIONS },
    });
    if (!o.out || !o.ref || !o.cand?.length) throw new UsageError("suite run needs --out, --ref and --cand");
    if (o.only !== undefined && o.only !== "bench" && o.only !== "lsp-bench") throw new UsageError("--only wants bench or lsp-bench");
    const outcomes = await suiteRun({
      ref: o.ref,
      cands: o.cand,
      out: o.out,
      projects: positionals,
      ...(o.only ? { only: o.only as "bench" | "lsp-bench" } : {}),
      ...(o.publish ? { publishTo: o.publish } : {}),
      ...roundOptions(o),
      log,
    });
    for (const x of outcomes) console.log(`${x.project} ${x.kind}: ${x.clean ? "measured" : "NOT MEASURED CLEANLY"} ${x.dir}${x.published ? ` -> ${x.published}` : ""}`);
    return outcomes.every((x) => x.clean) ? 0 : 1;
  }
  throw new UsageError("suite wants list, fetch or run");
}

async function benchCommand(command: string, rest: string[]): Promise<number> {
  if (command === "bench") {
    const { values: o } = parseArgs({
      args: rest,
      options: {
        project: { type: "string" },
        out: { type: "string" },
        ref: { type: "string" },
        cand: { type: "string", multiple: true },
        config: { type: "string" },
        "counter-runs": { type: "string" },
        "timeout-ms": { type: "string" },
        format: { type: "string" },
        ...ROUND_OPTIONS,
      },
    });
    if (!o.project || !o.out || !o.ref || !o.cand?.length) throw new UsageError("bench needs --project, --out, --ref and --cand");
    const format = formatOption(o);
    const r = await bench({
      project: o.project,
      out: o.out,
      ref: o.ref,
      cands: o.cand,
      ...defined({ config: o.config, timeoutMs: positive(o, "timeout-ms"), counterRuns: int(o, "counter-runs") }),
      ...roundOptions(o),
      log,
    });
    log(`bundle ${r.dir}`);
    console.log(formatBench(r.summary, format));
    return r.summary.clean ? 0 : 1;
  }
  if (command === "lsp-bench") {
    const { values: o } = parseArgs({
      args: rest,
      options: {
        project: { type: "string" },
        out: { type: "string" },
        ref: { type: "string" },
        cand: { type: "string", multiple: true },
        format: { type: "string" },
        ...LSP_SESSION_OPTIONS,
        ...ROUND_OPTIONS,
      },
    });
    if (!o.project || !o.out || !o.ref || !o.cand?.length) throw new UsageError("lsp-bench needs --project, --out, --ref and --cand");
    const format = formatOption(o);
    const r = await lspBench({
      project: o.project,
      out: o.out,
      ref: o.ref,
      cands: o.cand,
      ...lspSessionOptions(o),
      ...roundOptions(o),
      log,
    });
    log(`bundle ${r.dir}`);
    console.log(formatLspBench(r.summary, format));
    return r.summary.clean ? 0 : 1;
  }
  if (command === "calibrate") {
    const { values: o } = parseArgs({
      args: rest,
      options: {
        kind: { type: "string" },
        project: { type: "string" },
        out: { type: "string" },
        side: { type: "string" },
        "no-save": { type: "boolean" },
        format: { type: "string" },
        config: { type: "string" },
        "counter-runs": { type: "string" },
        "timeout-ms": { type: "string" },
        ...LSP_SESSION_OPTIONS,
        ...ROUND_OPTIONS,
      },
    });
    if (o.kind !== "bench" && o.kind !== "lsp-bench") throw new UsageError("calibrate needs --kind bench or --kind lsp-bench");
    if (!o.project || !o.out || !o.side) throw new UsageError("calibrate needs --project, --out and --side");
    const format = formatOption(o);
    if (o["max-runs"] !== undefined) throw new UsageError("calibrate runs a fixed number of rounds: use --runs, not --max-runs");
    // Options of the other kind would be ignored: refuse them rather than calibrate another workload.
    const foreign = (o.kind === "bench" ? Object.keys(LSP_SESSION_OPTIONS) : ["config", "counter-runs", "timeout-ms"]).filter((k) => (o as Values)[k] !== undefined);
    if (foreign.length) throw new UsageError(`calibrate --kind ${o.kind} does not take ${foreign.map((k) => `--${k}`).join(", ")}`);
    const r = await calibrate({
      kind: o.kind === "bench" ? "cli-bench" : "lsp-bench",
      side: o.side,
      project: o.project,
      out: o.out,
      save: o["no-save"] !== true,
      ...defined({ config: o.config, timeoutMs: positive(o, "timeout-ms"), counterRuns: int(o, "counter-runs") }),
      ...lspSessionOptions(o),
      ...roundOptions(o),
      log,
    });
    log(`bundle ${r.dir}`);
    // The other formats carry the calibration alone; text and md say where it was kept.
    if (r.file && (format === "json" || format === "csv")) log(`kept for later benches on this host setup: ${r.file}`);
    console.log(formatCalibration(r.calibration, r.file, format));
    return r.file || o["no-save"] ? 0 : 1;
  }
  // bench-summary: either kind of timing bundle.
  const { values: o, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { "max-outside-cores": { type: "string" }, "max-canary-drift": { type: "string" }, format: { type: "string" } },
  });
  if (positionals.length !== 1) throw new UsageError("bench-summary needs one bundle directory");
  const format = formatOption(o);
  const dir = resolve(positionals[0]!);
  const kind = (JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")) as { kind?: string }).kind;
  if (kind === "lsp-bench") {
    const bundle = readLspBenchBundle(dir);
    const summary = summarizeLspBenchBundle(dir, bundle, { ...bundle.settings.gates, ...gateOptions(o) });
    console.log(formatLspBench(summary, format));
    return summary.clean ? 0 : 1;
  }
  const bundle = readBenchBundle(dir);
  const summary = summarizeBenchBundle(dir, bundle, { ...bundle.settings.gates, ...gateOptions(o) });
  console.log(formatBench(summary, format));
  return summary.clean ? 0 : 1;
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof UsageError ? `${e.message}\n\n${USAGE}` : e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(2);
  },
);
