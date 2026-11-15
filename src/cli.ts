#!/usr/bin/env node
// parallax: parity and performance harness for TypeScript compilers and language servers.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readBundle, writeJsonAtomic } from "./bundle/bundle.ts";
import { bench, readBenchBundle, summarizeBenchBundle } from "./commands/bench.ts";
import { importLspdiff } from "./commands/importLspdiff.ts";
import { lspDiff } from "./commands/lspDiff.ts";
import { compareBundle, type Summary } from "./diff/compare.ts";
import { renderBenchSummary } from "./report/bench.ts";
import { renderSummary } from "./report/summary.ts";
import type { BenchSummary } from "./timing/summary.ts";

const USAGE = `usage:
  parallax lsp-diff --project <dir> --ref <profile>=<bin> --cand [<label>:]<profile>=<bin> [--cand ...] --out <bundle-dir>
                    [--files 6] [--file <rel>]... [--positions 4] [--ref-runs 2] [--cand-runs 1] [--request-timeout-ms 600000]
                    [--ref-evidence <bundle-dir>]...
  parallax compare <bundle-dir> [--ref-evidence <bundle-dir>]...
                                         recompute verdicts.jsonl, summary.json and differences/ from runs/;
                                         reference answers in compatible evidence bundles count as reference variants
  parallax summary <bundle-dir>          print summary.json
  parallax bench --project <dir> --ref <profile>=<bin> --cand [<label>:]<profile>=<bin> [--cand ...] --out <bundle-dir>
                 [--config tsconfig.json] [--runs 5] [--min-runs 3] [--warmup 1] [--attempts 3] [--timeout-ms 600000]
                 [--max-busy-cores 1.5] [--idle-timeout-s 300] [--boot-settle-s 300]
                 [--max-outside-cores 1] [--max-canary-drift 0.1]
                                         time each side's check command in alternating rounds; candidates are
                                         compared by their per-round ratio to the reference
  parallax bench-summary <bundle-dir> [--max-outside-cores N] [--max-canary-drift F]
                                         recompute summary.json from samples.jsonl (optionally with other gates)
  parallax import-lspdiff --from <old-out-dir> --project <dir> --ref <profile>=<bin> --cand <profile>=<bin> --out <bundle-dir>

Profiles are names in profiles/ (tsc7, tsrs, tsc-rs-fork) or paths to profile JSON files.
Exit status: 0 clean, 1 differences, unclean sessions or a bench not measured cleanly, 2 usage or harness error.`;

const log = (msg: string): void => console.error(msg);

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  if (command === "bench" || command === "bench-summary") return benchCommand(command, rest);
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
      },
    });
    if (!o.project || !o.out || !o.ref || !o.cand?.length) throw new UsageError("lsp-diff needs --project, --out, --ref and --cand");
    const r = await lspDiff({
      project: o.project,
      out: o.out,
      ref: o.ref,
      cands: o.cand,
      files: Number(o.files),
      ...(o.file ? { file: o.file } : {}),
      positions: Number(o.positions),
      refRuns: Number(o["ref-runs"]),
      candRuns: Number(o["cand-runs"]),
      requestTimeoutMs: Number(o["request-timeout-ms"]),
      refEvidence: (o["ref-evidence"] ?? []).map((d) => resolve(d)),
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
    if (!rest[0]) throw new UsageError("summary needs a bundle directory");
    summary = JSON.parse(readFileSync(join(resolve(rest[0]), "summary.json"), "utf8")) as Summary;
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

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

async function benchCommand(command: string, rest: string[]): Promise<number> {
  let summary: BenchSummary;
  if (command === "bench") {
    const { values: o } = parseArgs({
      args: rest,
      options: {
        project: { type: "string" },
        out: { type: "string" },
        ref: { type: "string" },
        cand: { type: "string", multiple: true },
        config: { type: "string" },
        runs: { type: "string" },
        "min-runs": { type: "string" },
        warmup: { type: "string" },
        attempts: { type: "string" },
        "timeout-ms": { type: "string" },
        "max-busy-cores": { type: "string" },
        "idle-timeout-s": { type: "string" },
        "boot-settle-s": { type: "string" },
        "max-outside-cores": { type: "string" },
        "max-canary-drift": { type: "string" },
      },
    });
    if (!o.project || !o.out || !o.ref || !o.cand?.length) throw new UsageError("bench needs --project, --out, --ref and --cand");
    const idleTimeout = num(o, "idle-timeout-s");
    const r = await bench({
      project: o.project,
      out: o.out,
      ref: o.ref,
      cands: o.cand,
      ...defined({
        config: o.config,
        runs: num(o, "runs"),
        minRounds: num(o, "min-runs"),
        warmup: num(o, "warmup"),
        attempts: num(o, "attempts"),
        timeoutMs: num(o, "timeout-ms"),
      }),
      idle: defined({
        maxBusyCores: num(o, "max-busy-cores"),
        timeoutMs: idleTimeout === undefined ? undefined : idleTimeout * 1000,
        bootSettleS: num(o, "boot-settle-s"),
      }),
      gates: defined({ maxOutsideCores: num(o, "max-outside-cores"), maxCanaryDrift: num(o, "max-canary-drift") }),
      log,
    });
    summary = r.summary;
    log(`bundle ${r.dir}`);
  } else {
    const { values: o, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { "max-outside-cores": { type: "string" }, "max-canary-drift": { type: "string" } },
    });
    if (positionals.length !== 1) throw new UsageError("bench-summary needs one bundle directory");
    const dir = resolve(positionals[0]!);
    const bundle = readBenchBundle(dir);
    const gates = { ...bundle.settings.gates, ...defined({ maxOutsideCores: num(o, "max-outside-cores"), maxCanaryDrift: num(o, "max-canary-drift") }) };
    summary = summarizeBenchBundle(dir, bundle, gates);
  }
  console.log(renderBenchSummary(summary));
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
