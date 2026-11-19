// `parallax lsp-diff`: run the scripted session against the reference (several times) and each
// candidate, streaming every answer into a bundle, then compare.
//
// Runs are interleaved by round (ref.1, each candidate's run 1, ref.2, ...), so the reference's
// repeat is spread over the job and time-dependent drift shows up as reference instability. One server
// runs at a time.

import type { EnvPolicy } from "../host/sealedEnv.ts";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import {
  BUNDLE_SCHEMA,
  corpusInfo,
  corpusState,
  harnessInfo,
  hostInfo,
  sha256,
  sideRecord,
  writeJsonAtomic,
  type Bundle,
} from "../bundle/bundle.ts";
import { compareBundle, type Summary } from "../diff/compare.ts";
import { NORMALIZE_RULES, NORMALIZE_VERSION } from "../diff/normalize.ts";
import { runServer } from "../lsp/run.ts";
import { bindSide, type Side } from "../profile/profile.ts";
import { initializeSha256 } from "../session/initialize.ts";
import { pickFiles, rel } from "../session/picker.ts";
import { SCRIPT_ID, TYPED, type ScriptSpec } from "../session/script.ts";
import { InputError } from "../errors.ts";

export interface LspDiffOptions {
  project: string;
  out: string;
  ref: string;
  cands: string[];
  files: number;
  file?: string[];
  positions: number;
  refRuns: number;
  candRuns: number;
  requestTimeoutMs?: number;
  refEvidence?: string[];
  // How each server's environment is built (default sealed; host/sealedEnv.ts).
  env?: EnvPolicy;
  log: (msg: string) => void;
}

export function prepareBundleDir(out: string): string {
  const dir = resolve(out);
  if (existsSync(dir) && readdirSync(dir).length) throw new InputError(`bundle directory ${dir} exists and is not empty`);
  mkdirSync(join(dir, "runs"), { recursive: true });
  return dir;
}

export async function lspDiff(opts: LspDiffOptions): Promise<{ dir: string; bundle: Bundle; summary: Summary }> {
  const root = resolve(opts.project);
  if (!existsSync(root)) throw new InputError(`no project at ${root}`);
  if (!opts.cands.length) throw new InputError("at least one --cand is needed");
  const ref = await bindSide(opts.ref, "ref", opts.env ? { env: opts.env } : {});
  const cands: Side[] = [];
  for (const c of opts.cands) cands.push(await bindSide(c, "cand", opts.env ? { env: opts.env } : {}));
  const labels = [ref, ...cands].map((s) => s.label);
  if (new Set(labels).size !== labels.length) throw new InputError(`side labels must be unique (got ${labels.join(", ")}); use <label>:<profile>=<bin>`);

  const dir = prepareBundleDir(opts.out);
  const files = pickFiles(root, opts.files, opts.file);
  const spec: ScriptSpec = { root, files, positions: opts.positions, typed: TYPED };
  const bundle: Bundle = {
    schema: BUNDLE_SCHEMA,
    kind: "lsp-answer-diff",
    status: "running",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    harness: harnessInfo(),
    host: hostInfo(),
    corpus: corpusInfo(root),
    session: {
      script: SCRIPT_ID,
      files: files.map((f) => rel(root, f)),
      positions: opts.positions,
      typed: TYPED,
      initializeSha256: initializeSha256(),
      requestTimeoutMs: opts.requestTimeoutMs ?? null,
    },
    normalization: { version: NORMALIZE_VERSION, rules: NORMALIZE_RULES },
    sides: [ref, ...cands].map(sideRecord),
    runs: [],
    notes: [],
  };
  const save = (): void => writeJsonAtomic(join(dir, "bundle.json"), bundle);
  save();
  opts.log(`bundle ${dir}\nproject ${root}\nfiles: ${bundle.session.files.join(", ")}`);

  const schedule: { side: Side; n: number }[] = [];
  for (let i = 1; i <= Math.max(opts.refRuns, opts.candRuns); i++) {
    if (i <= opts.refRuns) schedule.push({ side: ref, n: i });
    for (const c of cands) if (i <= opts.candRuns) schedule.push({ side: c, n: i });
  }
  for (const { side, n } of schedule) {
    const id = `${side.label}.${n}`;
    opts.log(`run ${id} (load ${loadavg()[0]!.toFixed(2)})`);
    const run = await runServer({
      bundleDir: dir,
      id,
      n,
      side,
      spec,
      log: opts.log,
      ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    });
    bundle.runs.push(run);
    save();
    opts.log(`run ${id}: ${run.outcome}, ${run.answers} answers in ${((run.durationMs ?? 0) / 1000).toFixed(1)} s`);
  }

  const after = corpusState(root);
  bundle.corpus.statusSha256After = after.status === null ? null : sha256(after.status);
  bundle.corpus.changedDuringRun = bundle.corpus.statusSha256Before === null ? null : bundle.corpus.statusSha256Before !== bundle.corpus.statusSha256After;
  if (bundle.corpus.changedDuringRun) bundle.notes.push("the corpus's git status changed during the run");
  bundle.host.loadAfter = loadavg();
  save();
  const summary = await compareBundle(dir, bundle, { log: opts.log, refEvidence: opts.refEvidence ?? [] });
  bundle.status = "complete";
  bundle.finishedAt = new Date().toISOString();
  save();
  return { dir, bundle, summary };
}
