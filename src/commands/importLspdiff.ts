// `parallax import-lspdiff`: turns the logs of the tsc-rs fork's scripts/lspdiff `diff` mode (go.jsonl,
// go2.jsonl, rs.jsonl: one `{step, method, params, result, error, ms}` per line, aligned by index) into
// a bundle, so Parallax's comparison can be checked against results that tool produced. The sides are
// bound to binaries given now; the bundle notes that their hashes are of today's files, not proven to
// be the ones that ran.

import { existsSync, readFileSync, statSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE_SCHEMA, corpusInfo, harnessInfo, hostInfo, sha256, sideRecord, writeJsonAtomic, type Bundle, type RunRecord } from "../bundle/bundle.ts";
import { JsonlWriter, readLines } from "../bundle/lines.ts";
import { compareBundle, type Summary } from "../diff/compare.ts";
import { NORMALIZE_RULES, NORMALIZE_VERSION } from "../diff/normalize.ts";
import { bindSide, type Side } from "../profile/profile.ts";
import { initializeParams } from "../session/initialize.ts";
import { pickFiles, rel } from "../session/picker.ts";
import { TYPED } from "../session/script.ts";
import { prepareBundleDir } from "./lspDiff.ts";

export interface ImportOptions {
  from: string;
  project: string;
  out: string;
  ref: string;
  cand: string;
  log: (msg: string) => void;
}

async function convert(src: string, dest: string, id: string, side: Side): Promise<number> {
  const w = new JsonlWriter(dest);
  await w.write({ type: "start", run: id, side: side.label, importedFrom: src });
  let seq = 0;
  for await (const line of readLines(src)) {
    const e = JSON.parse(line.text) as { step: string; method: string; params: unknown; result?: unknown; error?: unknown; ms?: number };
    seq++;
    const response = JSON.stringify({ jsonrpc: "2.0", id: seq, ...(e.error !== undefined ? { error: e.error } : { result: e.result ?? null }) });
    await w.writeWithRaw({ type: "answer", seq, step: e.step, method: e.method, params: e.params, ms: e.ms ?? null }, "response", response);
  }
  await w.write({ type: "end", outcome: "imported", answers: seq });
  await w.close();
  return seq;
}

export async function importLspdiff(opts: ImportOptions): Promise<{ dir: string; bundle: Bundle; summary: Summary }> {
  const from = resolve(opts.from);
  const root = resolve(opts.project);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`no project directory at ${root}`);
  for (const name of ["go.jsonl", "go2.jsonl", "rs.jsonl"])
    if (!existsSync(join(from, name))) throw new Error(`${from} has no ${name}: not a scripts/lspdiff diff output`);
  const ref = await bindSide(opts.ref, "ref");
  const cand = await bindSide(opts.cand, "cand");
  const dir = prepareBundleDir(opts.out);
  const oldSummary = join(from, "summary.json");
  const files = existsSync(oldSummary)
    ? (JSON.parse(readFileSync(oldSummary, "utf8")) as { files: string[] }).files
    : pickFiles(root, 6).map((f) => rel(root, f));
  const bundle: Bundle = {
    schema: BUNDLE_SCHEMA,
    kind: "lsp-answer-diff",
    status: "running",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    harness: harnessInfo(),
    host: hostInfo(),
    corpus: corpusInfo(root),
    session: { script: "lspdiff-v1", files, positions: 4, typed: TYPED, initializeSha256: sha256(JSON.stringify(initializeParams("<root>"))), requestTimeoutMs: null },
    normalization: { version: NORMALIZE_VERSION, rules: NORMALIZE_RULES },
    sides: [sideRecord(ref), sideRecord(cand)],
    runs: [],
    notes: [
      `imported from ${from} (the tsc-rs fork's scripts/lspdiff diff mode); binary hashes are of the files bound at import time`,
      ...(existsSync(oldSummary) ? [] : ["the old run wrote no summary.json; files were re-picked with the same picker"]),
    ],
  };
  const plan: [string, Side, number][] = [
    ["go.jsonl", ref, 1],
    ["go2.jsonl", ref, 2],
    ["rs.jsonl", cand, 1],
  ];
  for (const [name, side, n] of plan) {
    const id = `${side.label}.${n}`;
    const file = join("runs", `${id}.jsonl`);
    const answers = await convert(join(from, name), join(dir, file), id, side);
    const run: RunRecord = { id, side: side.label, role: side.role, n, file, stderrFile: null, startedAt: null, durationMs: null, outcome: "imported", answers, importedFrom: join(from, name) };
    bundle.runs.push(run);
    opts.log(`imported ${name} as ${id}: ${answers} answers`);
  }
  bundle.host.loadAfter = loadavg();
  writeJsonAtomic(join(dir, "bundle.json"), bundle);
  const summary = await compareBundle(dir, bundle, { log: opts.log });
  bundle.status = "complete";
  bundle.finishedAt = new Date().toISOString();
  writeJsonAtomic(join(dir, "bundle.json"), bundle);
  return { dir, bundle, summary };
}
