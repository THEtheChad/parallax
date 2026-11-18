// `parallax publish`: turn a bench or lsp-bench bundle into one result file fit to publish, and
// `parallax verify-result`: check that a result's summary is what its records give.
//
// A result keeps what a reader needs to trust and reproduce it: the per-round records (so anyone can
// recompute the summary), the summary, and provenance (harness commit, each binary's sha256 and
// version, the project's repository and commit, the machine's OS, CPU, state and priority). It leaves
// out what identifies the machine or its owner, or is too big: the hostname (a random machine id
// stands in, so one machine's results group), absolute paths, the commands' outputs (they quote the
// project's source) and the per-request logs.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { configDir } from "../host/config.ts";
import { harnessInfo, type CorpusInfo, type HostInfo, type SideRecord } from "../bundle/bundle.ts";
import { loadSuite, suiteProjectFor } from "../suite/suite.ts";
import { readBenchBundle, summarizeBenchRecords, type BenchBundle, type Records as BenchRecords } from "./bench.ts";
import { readLspBenchBundle, summarizeLspBenchRecords, type LspBenchBundle, type Records as LspRecords } from "./lspBench.ts";

export const RESULT_SCHEMA = "parallax.result/1";

type Kind = "cli-bench" | "lsp-bench";

export interface PublishedResult {
  schema: typeof RESULT_SCHEMA;
  kind: Kind;
  // sha256 of the result without this field (16 hex digits).
  id: string;
  publishedAt: string;
  machine: { id: string };
  project: { name: string; suite: boolean; repository: string | null; commit: string | null; clean: boolean };
  // The bundle's own fields, with paths and the hostname removed (same names, so the summary
  // functions read a result as they read a bundle).
  harness: BenchBundle["harness"];
  host: Omit<HostInfo, "hostname"> & Record<string, unknown>;
  corpus: Omit<CorpusInfo, "root">;
  settings: BenchBundle["settings"] | LspBenchBundle["settings"];
  session?: LspBenchBundle["session"];
  canary: BenchBundle["canary"];
  sides: Omit<SideRecord, "bin" | "binReal" | "profilePath">[];
  notes: string[];
  createdAt: string;
  finishedAt: string | null;
  records: unknown[];
  summary: unknown;
}

// A random id for this machine, made once and kept in the config directory.
export function machineId(): string {
  const file = join(configDir(), "machine.json");
  if (existsSync(file)) return (JSON.parse(readFileSync(file, "utf8")) as { id: string }).id;
  const id = randomUUID();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ id, note: "A random id that groups this machine's published Parallax results. Delete it to get a new one." }, null, 2)}\n`);
  return id;
}

// Every string in `value` with each `from` replaced by its `to` (longest first, so a path inside
// another is replaced as a whole).
export function scrub<T>(value: T, replacements: [from: string, to: string][]): T {
  const pairs = replacements.filter(([from]) => from.length > 1).sort((a, b) => b[0].length - a[0].length);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return pairs.reduce((s, [from, to]) => s.split(from).join(to), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

const readRecords = (dir: string): unknown[] =>
  readFileSync(join(dir, "samples.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);

function summarizeResult(r: Pick<PublishedResult, "kind" | "records">): unknown {
  return r.kind === "cli-bench"
    ? summarizeBenchRecords(r as unknown as BenchBundle, r.records as BenchRecords)
    : summarizeLspBenchRecords(r as unknown as LspBenchBundle, r.records as LspRecords);
}

const normalize = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const resultId = (r: Omit<PublishedResult, "id">): string => createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 16);

export interface PublishOptions {
  bundleDir: string;
  // Directory of the results collection; the file goes to <out>/<kind>/<project>/.
  out: string;
  // Publish a bundle made by a harness with uncommitted changes (its summary cannot be checked).
  allowDirty?: boolean;
  log: (msg: string) => void;
}

export function publish(opts: PublishOptions): { file: string; result: PublishedResult } {
  const raw = JSON.parse(readFileSync(join(opts.bundleDir, "bundle.json"), "utf8")) as { kind?: string };
  const bundle: BenchBundle | LspBenchBundle = raw.kind === "lsp-bench" ? readLspBenchBundle(opts.bundleDir) : readBenchBundle(opts.bundleDir);
  if (bundle.status !== "complete") throw new Error(`${opts.bundleDir}: the bench did not complete (status ${bundle.status})`);
  if (!bundle.harness.gitCommit || bundle.harness.gitDirty) {
    const why = bundle.harness.gitCommit ? "had uncommitted changes" : "was not a git checkout";
    if (!opts.allowDirty) throw new Error(`the harness that made this bundle ${why}, so no one can recompute its summary; pass --allow-dirty to publish it anyway`);
    opts.log(`warning: the harness ${why}; the result cannot be verified`);
  }
  const records = readRecords(opts.bundleDir);
  const { hostname: _hostname, ...host } = bundle.host;
  const { root, ...corpus } = bundle.corpus;
  const suiteProject = suiteProjectFor(loadSuite(), bundle.corpus);
  const name = suiteProject?.name ?? root.split(/[\\/]/).filter(Boolean).at(-1) ?? "project";
  const replacements: [string, string][] = [[root, "<project>"]];
  for (const s of bundle.sides) for (const p of [s.bin, s.binReal]) replacements.push([p, `<${s.base ?? s.label} binary>`], [dirname(p), `<${s.base ?? s.label} dir>`]);
  replacements.push([homedir(), "~"], [tmpdir(), "<tmp>"]);
  const sides = bundle.sides.map(({ bin: _b, binReal: _r, profilePath: _p, ...s }) => s);
  const partial: Omit<PublishedResult, "id" | "summary"> = scrub(
    {
      schema: RESULT_SCHEMA,
      kind: bundle.kind,
      publishedAt: new Date().toISOString(),
      machine: { id: machineId() },
      project: {
        name,
        suite: suiteProject !== null,
        repository: corpus.repository ?? null,
        commit: corpus.gitCommit,
        clean: (corpus.gitStatus?.length ?? 1) === 0 && corpus.changedDuringRun === false,
      },
      harness: bundle.harness,
      host,
      corpus,
      settings: bundle.settings,
      ...("session" in bundle ? { session: bundle.session } : {}),
      canary: bundle.canary,
      sides,
      notes: bundle.notes,
      createdAt: bundle.createdAt,
      finishedAt: bundle.finishedAt,
      records,
    },
    replacements,
  );
  const withSummary = { ...partial, summary: normalize(summarizeResult(partial as unknown as PublishedResult)) };
  const result: PublishedResult = { ...withSummary, id: resultId(withSummary) } as PublishedResult;
  const date = (bundle.finishedAt ?? bundle.createdAt).slice(0, 10);
  const file = join(opts.out, bundle.kind, name, `${date}-${result.machine.id.slice(0, 8)}-${result.id.slice(0, 8)}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 1)}\n`);
  if (!result.project.suite) opts.log(`note: ${name} is not a suite project (suite.json), so this result compares only with others on the same repository and commit`);
  if (!result.project.clean) opts.log("note: the project had local changes, or changed during the run");
  return { file, result };
}

export interface Verification {
  ok: boolean;
  problems: string[];
  // The harness that made the result is not the one verifying it: a mismatch may be a change in the
  // statistics, not a bad result. The results repository verifies with the result's own commit.
  harnessDiffers: boolean;
}

export function verifyResult(file: string): Verification {
  const problems: string[] = [];
  const r = JSON.parse(readFileSync(file, "utf8")) as PublishedResult;
  if (r.schema !== RESULT_SCHEMA) return { ok: false, problems: [`schema is ${JSON.stringify(r.schema)}, not ${RESULT_SCHEMA}`], harnessDiffers: false };
  if (r.kind !== "cli-bench" && r.kind !== "lsp-bench") problems.push(`unknown kind ${JSON.stringify(r.kind)}`);
  const { id, ...rest } = r;
  if (resultId(rest) !== id) problems.push("the id is not the hash of the result: it was edited after publishing");
  if (!Array.isArray(r.records) || !r.records.length) problems.push("no records");
  if (!problems.length && !isDeepStrictEqual(normalize(summarizeResult(r as unknown as PublishedResult)), normalize(r.summary)))
    problems.push("the summary is not what the records give");
  if ("hostname" in (r.host ?? {})) problems.push("the host's name is in the result");
  const harnessDiffers = r.harness?.gitCommit !== harnessInfo().gitCommit;
  return { ok: !problems.length, problems, harnessDiffers };
}
