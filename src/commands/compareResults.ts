// `parallax compare-results <old> <new>`: did a candidate get better or worse between two saved runs?
//
// Each run compares candidates with a reference by per-round ratios. Comparing two runs compares those
// ratios: for each candidate (and, for lsp-bench, each metric), the old run's per-round ratios against
// the new run's. The reference in each run cancels most of what differs between runs (the machine's
// speed that day, a slower disk), which absolute times would not. The two runs' rounds are
// independent samples, not pairs, so the interval is a two-sample one (timing/shift.ts), and the
// answer is a ratio of ratios: new / old 1.07x means the candidate is 7% slower against the reference
// than it was.
//
// Inputs are published results (parallax.result/1) or bench and lsp-bench bundle directories; either
// gives the same per-round records, judged with the run's own gates as its own summary was.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ThreadMode } from "../profile/profile.ts";
import { evaluateComparePolicy, type Policy, type PolicyDecision } from "../timing/policy.ts";
import { ratioShift, type ShiftInterval } from "../timing/shift.ts";
import { callOf, median, sameWithin } from "../timing/stats.ts";
import { METRICS, sessionFailed, type SessionRecord } from "../timing/lspSummary.ts";
import type { MetricKey } from "../timing/lspSession.ts";
import { acceptRounds, DEFAULT_RESOLUTION_SETTING, sampleFailed, type CandidateState, type Resolution, type RoundRecord, type SampleRecord } from "../timing/summary.ts";
import { readBenchBundle, summarizeBenchRecords, type BenchBundle, type Records as BenchRecords } from "./bench.ts";
import { readLspBenchBundle, summarizeLspBenchRecords, type LspBenchBundle, type Records as LspRecords } from "./lspBench.ts";
import { RESULT_SCHEMA, type PublishedResult } from "./publish.ts";

export const COMPARISON_SCHEMA = "parallax.comparison/1";

type Kind = "cli-bench" | "lsp-bench";

// A pair that cannot be compared, or an input that is not a run: exit 2, with this message.
export class CompareError extends Error {}

export interface Run {
  source: string;
  form: "result" | "bundle";
  kind: Kind;
  // A result's id; null for a bundle.
  id: string | null;
  // A result's random machine id; a bundle has the hostname instead.
  machine: { id: string | null; hostname: string | null; cpuModel: string | null };
  project: { name: string; repository: string | null; commit: string | null; clean: boolean | null };
  harness: { commit: string | null; dirty: boolean | null };
  createdAt: string;
  // The fields the summary functions read, under the bundle's names (a result keeps them).
  bundle: BenchBundle | LspBenchBundle;
  records: unknown[];
}

const parseJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (e) {
    throw new CompareError(`${file}: not JSON (${(e as Error).message})`);
  }
};

const readJsonl = (file: string): unknown[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);

// A result file, a bundle directory, or a bundle's bundle.json.
export function loadRun(path: string): Run {
  const p = resolve(path);
  if (!existsSync(p)) throw new CompareError(`${path}: no such file or directory`);
  const dir = statSync(p).isDirectory() ? p : basename(p) === "bundle.json" ? dirname(p) : null;
  if (dir) {
    if (!existsSync(join(dir, "bundle.json"))) throw new CompareError(`${path}: not a bundle (no bundle.json)`);
    const raw = parseJson(join(dir, "bundle.json")) as { kind?: string };
    if (raw.kind !== "cli-bench" && raw.kind !== "lsp-bench") throw new CompareError(`${path}: a ${raw.kind ?? "unknown"} bundle; compare-results compares bench and lsp-bench runs`);
    const bundle = raw.kind === "lsp-bench" ? readLspBenchBundle(dir) : readBenchBundle(dir);
    if (bundle.status !== "complete") throw new CompareError(`${path}: the bench did not complete (status ${bundle.status})`);
    const status = bundle.corpus.gitStatus;
    return {
      source: path,
      form: "bundle",
      kind: bundle.kind,
      id: null,
      machine: { id: null, hostname: bundle.host.hostname, cpuModel: bundle.host.cpuModel ?? null },
      project: {
        name: basename(bundle.corpus.root),
        repository: bundle.corpus.repository ?? null,
        commit: bundle.corpus.gitCommit,
        clean: status === null ? null : status.length === 0 && bundle.corpus.changedDuringRun !== true,
      },
      harness: { commit: bundle.harness.gitCommit, dirty: bundle.harness.gitDirty },
      createdAt: bundle.createdAt,
      bundle,
      records: readJsonl(join(dir, "samples.jsonl")),
    };
  }
  const r = parseJson(p) as PublishedResult;
  if (r?.schema !== RESULT_SCHEMA) throw new CompareError(`${path}: neither a bench bundle directory nor a ${RESULT_SCHEMA} result`);
  if (r.kind !== "cli-bench" && r.kind !== "lsp-bench") throw new CompareError(`${path}: unknown kind ${JSON.stringify(r.kind)}`);
  if (!Array.isArray(r.records) || !r.records.length) throw new CompareError(`${path}: no records`);
  return {
    source: path,
    form: "result",
    kind: r.kind,
    id: r.id,
    machine: { id: r.machine?.id ?? null, hostname: null, cpuModel: (r.host?.cpuModel as string | undefined) ?? null },
    project: { name: r.project.name, repository: r.project.repository, commit: r.project.commit, clean: r.project.clean },
    harness: { commit: r.harness.gitCommit, dirty: r.harness.gitDirty },
    createdAt: r.createdAt,
    bundle: r as unknown as BenchBundle | LspBenchBundle,
    records: r.records,
  };
}

// One candidate of one run: its state as its own summary has it, and per metric its values and its
// reference's in each accepted round (null: not measured in every round, as the summary has it).
interface Series {
  label: string;
  ref: string;
  mode: ThreadMode;
  state: CandidateState;
  rounds: number;
  metrics: Map<string, { ref: number[]; cand: number[] } | null>;
}

interface MetricDef {
  key: MetricKey | "wall" | "*";
  label: string;
  unit: string;
}

const WALL: MetricDef = { key: "wall", label: "wall", unit: "ms" };
const LSP_METRICS: MetricDef[] = METRICS.filter((m) => m.compare !== false);

function seriesOf(run: Run): Series[] {
  const gates = run.bundle.settings.gates;
  const sides = run.bundle.sides;
  const rounds = run.records.filter((r): r is RoundRecord => (r as { type?: string }).type === "round");
  if (run.kind === "cli-bench") {
    const summary = summarizeBenchRecords(run.bundle as BenchBundle, run.records as BenchRecords);
    const samples = run.records.filter((r): r is SampleRecord => (r as { type?: string }).type === "sample" && !(r as SampleRecord).warmup);
    const { accepted } = acceptRounds(rounds, samples, sides.length, sampleFailed, gates);
    return summary.candidates.map((c) => {
      const ref = c.ref ?? sides.find((s) => s.role === "ref")!.label;
      const pairs = accepted.map((ss) => [ss.find((s) => s.side === ref)!.wallMs, ss.find((s) => s.side === c.label)!.wallMs] as const);
      return { label: c.label, ref, mode: c.mode ?? "default", state: c.state, rounds: pairs.length, metrics: new Map([["wall", { ref: pairs.map((p) => p[0]), cand: pairs.map((p) => p[1]) }]]) };
    });
  }
  const summary = summarizeLspBenchRecords(run.bundle as LspBenchBundle, run.records as LspRecords);
  const sessions = run.records.filter((r): r is SessionRecord => (r as { type?: string }).type === "session" && !(r as SessionRecord).warmup);
  const { accepted } = acceptRounds(rounds, sessions, sides.length, sessionFailed, gates);
  return summary.candidates.map((c) => {
    const ref = c.ref ?? sides.find((s) => s.role === "ref")!.label;
    const metrics = new Map<string, { ref: number[]; cand: number[] } | null>();
    for (const { key } of METRICS.filter((m) => m.compare !== false)) {
      // As the summary: a metric is compared only when every accepted round has it on both sides.
      const pairs = accepted.map((ss) => [ss.find((s) => s.side === ref)!.metrics[key] ?? null, ss.find((s) => s.side === c.label)!.metrics[key] ?? null] as const);
      const ok = pairs.length > 0 && pairs.every(([r, x]) => r !== null && r > 0 && x !== null);
      metrics.set(key, ok ? { ref: pairs.map((p) => p[0]!), cand: pairs.map((p) => p[1]!) } : null);
    }
    return { label: c.label, ref, mode: c.mode ?? "default", state: c.state, rounds: accepted.length, metrics };
  });
}

export type CompareCall = "better" | "worse" | "same" | "unresolved" | "too few rounds";

// One run's figures for one row: medians over its accepted rounds.
export interface RunFigures {
  rounds: number;
  // Median of the per-round candidate / reference ratios (the run's own figure).
  ratio: number;
  refMedian: number;
  candMedian: number;
}

export interface CompareRow {
  label: string;
  mode: ThreadMode;
  // The reference the candidate was compared with in each run (normally the same label).
  ref: { old: string; new: string };
  metric: string;
  metricLabel: string;
  unit: string;
  // "compared", or why not: "noisy in old", "failed in new", "not measured in old" ...
  state: string;
  old: RunFigures | null;
  new: RunFigures | null;
  // new / old of the per-round ratios: Hodges-Lehmann estimate and interval (timing/shift.ts).
  shift: ShiftInterval | null;
  call: CompareCall | null;
  // Half-width of "same" for this row (the resolution, or the ms floor over the old candidate's figure).
  sameWithin: number | null;
  // The reference is another label or binary in the new run: the ratio of ratios mixes a change in the
  // candidate with one in the reference.
  refChanged: boolean;
  // The candidate's own figure new / old, only when both runs are from the same machine; never called.
  absolute: ShiftInterval | null;
}

export interface RunInfo {
  source: string;
  form: "result" | "bundle";
  id: string | null;
  machine: string | null;
  createdAt: string;
  harnessCommit: string | null;
}

export interface Comparison {
  schema: typeof COMPARISON_SCHEMA;
  kind: Kind;
  project: Run["project"];
  old: RunInfo;
  new: RunInfo;
  // true: the same machine id (results) or hostname and CPU (bundles); null: cannot tell.
  sameMachine: boolean | null;
  // Each row's (default), or with familyWise the whole report's (Bonferroni over the comparisons: each
  // interval is then at `perComparison`).
  confidence: number;
  familyWise: boolean;
  comparisons: number;
  perComparison: number;
  resolution: Resolution;
  warnings: string[];
  // Side labels present in only one run.
  onlyOld: string[];
  onlyNew: string[];
  rows: CompareRow[];
  counts: Partial<Record<CompareCall, number>>;
  policy: PolicyDecision | null;
}

export interface CompareOptions {
  resolution?: Resolution;
  // For each row (default 0.95), or with familyWise for the whole report.
  confidence?: number;
  familyWise?: boolean;
  // lsp-bench metric keys to compare (default: every compared metric).
  metrics?: string[] | null;
  allowProjectChange?: boolean;
  policy?: Policy | null;
}

const short = (s: string | null, n = 12): string => (s === null ? "unknown" : s.slice(0, n));
const sameRepo = (a: string, b: string): boolean => a.replace(/\.git$/, "").toLowerCase() === b.replace(/\.git$/, "").toLowerCase();

// Refuses what cannot be compared; returns warnings for what can, but differs.
function compatibility(a: Run, b: Run, allowProjectChange: boolean): { warnings: string[]; sameMachine: boolean | null } {
  if (a.kind !== b.kind) throw new CompareError(`cannot compare a ${a.kind} run with a ${b.kind} run`);
  const warnings: string[] = [];
  const pa = a.project;
  const pb = b.project;
  const projectDiffers: string[] = [];
  if (pa.repository && pb.repository && !sameRepo(pa.repository, pb.repository)) projectDiffers.push(`repository ${pa.repository} vs ${pb.repository}`);
  if (pa.commit && pb.commit && pa.commit !== pb.commit) projectDiffers.push(`commit ${short(pa.commit)} vs ${short(pb.commit)}`);
  // Without both commits, the name is all there is to go on.
  if ((!pa.commit || !pb.commit) && pa.name !== pb.name) projectDiffers.push(`project ${pa.name} vs ${pb.name}`);
  if (projectDiffers.length) {
    const what = `the runs measured different projects (${projectDiffers.join("; ")})`;
    if (!allowProjectChange) throw new CompareError(`${what}: a change in the project shows up as a change in the candidate; pass --allow-project-change to compare them anyway`);
    warnings.push(`${what}: differences may come from the project, not the candidate`);
  } else if (!pa.commit || !pb.commit) warnings.push("cannot tell whether both runs measured the same project commit");
  for (const [which, r] of [["old", a], ["new", b]] as const) if (r.project.clean === false) warnings.push(`the ${which} run's project had local changes, or changed during the run`);

  let sameMachine: boolean | null = null;
  if (a.machine.id && b.machine.id) sameMachine = a.machine.id === b.machine.id;
  else if (a.machine.hostname && b.machine.hostname) sameMachine = a.machine.hostname === b.machine.hostname && a.machine.cpuModel === b.machine.cpuModel;
  if (sameMachine === false)
    warnings.push(
      `different machines${a.machine.cpuModel !== b.machine.cpuModel ? ` (${a.machine.cpuModel ?? "?"} vs ${b.machine.cpuModel ?? "?"})` : ""}: ratios to each run's reference carry over between machines far better than times, but not fully (a CPU can favour one implementation); absolute times are not compared`,
    );
  else if (sameMachine === null) warnings.push("cannot tell whether both runs are from the same machine (compare two results, or two bundles); absolute times are not compared");

  if (a.harness.commit !== b.harness.commit)
    warnings.push(`made by different harness commits (${short(a.harness.commit)} vs ${short(b.harness.commit)}): a change in how Parallax measures shows up here too`);
  for (const [which, r] of [["old", a], ["new", b]] as const) if (r.harness.dirty !== false) warnings.push(`the ${which} run's harness ${r.harness.dirty ? "had uncommitted changes" : "was not a git checkout"}`);

  // Settings that change what is measured. Older bundles lack some fields: they ran the default.
  const sa = a.bundle.settings as unknown as Record<string, unknown>;
  const sb = b.bundle.settings as unknown as Record<string, unknown>;
  const keys = a.kind === "cli-bench" ? ["config", "threads", "pin", "env"] : ["threads", "pin", "env", "files", "edits", "intervalMs", "lines", "serviceLines", "pausedLines", "pauseMs", "errfixes", "imports", "longEdits"];
  const defaults: Record<string, unknown> = { threads: ["default"], pin: null, env: { mode: "inherit" } };
  const text = (v: unknown): string => {
    const env = v as { mode?: string; pass?: string[] } | null;
    return env && typeof env === "object" && typeof env.mode === "string" ? `${env.mode}${env.pass?.length ? ` +${env.pass.join(",")}` : ""}` : JSON.stringify(v);
  };
  for (const k of keys) {
    const va = sa[k] ?? defaults[k] ?? null;
    const vb = sb[k] ?? defaults[k] ?? null;
    if (!isDeepStrictEqual(va, vb)) warnings.push(`setting ${k} differs: ${text(va)} vs ${text(vb)}`);
  }
  if (a.kind === "lsp-bench") {
    const fa = (a.bundle as LspBenchBundle).session;
    const fb = (b.bundle as LspBenchBundle).session;
    if (fa && fb && (!isDeepStrictEqual(fa.files, fb.files) || fa.typed !== fb.typed)) warnings.push("the editor sessions differ (other files opened, or other text typed)");
  }

  // Binaries, once per implementation (both thread modes run the same binary).
  const binaries = (r: Run): Map<string, { role: string; sha: string; version: string | null }> => {
    const m = new Map<string, { role: string; sha: string; version: string | null }>();
    for (const s of r.bundle.sides) {
      const base = s.base ?? s.label;
      if (!m.has(base)) m.set(base, { role: s.role, sha: s.binSha256, version: s.version });
    }
    return m;
  };
  const ba = binaries(a);
  const bb = binaries(b);
  for (const [base, x] of ba) {
    const y = bb.get(base);
    if (!y || x.sha === y.sha) continue;
    const version = x.version !== y.version ? `; version ${JSON.stringify(x.version)} -> ${JSON.stringify(y.version)}` : "";
    warnings.push(
      x.role === "ref"
        ? `reference ${base} binary changed (sha256 ${short(x.sha)} -> ${short(y.sha)}${version}): every ratio in the new run is to another reference binary`
        : `candidate ${base} binary changed (sha256 ${short(x.sha)} -> ${short(y.sha)}${version})`,
    );
  }
  return { warnings, sameMachine };
}

const runInfo = (r: Run): RunInfo => ({ source: r.source, form: r.form, id: r.id, machine: r.machine.id ?? r.machine.hostname, createdAt: r.createdAt, harnessCommit: r.harness.commit });

function figures(v: { ref: number[]; cand: number[] }): RunFigures {
  return { rounds: v.ref.length, ratio: median(v.cand.map((c, i) => c / v.ref[i]!)), refMedian: median(v.ref), candMedian: median(v.cand) };
}

export function compareRuns(a: Run, b: Run, opts: CompareOptions = {}): Comparison {
  const { warnings, sameMachine } = compatibility(a, b, opts.allowProjectChange === true);
  const confidence = opts.confidence ?? 0.95;
  const resolution = opts.resolution ?? DEFAULT_RESOLUTION_SETTING;
  if (opts.metrics && a.kind === "cli-bench") throw new CompareError("--metrics applies to lsp-bench runs (a CLI bench has one metric, wall time)");
  const defs = a.kind === "cli-bench" ? [WALL] : LSP_METRICS.filter((m) => !opts.metrics || opts.metrics.includes(m.key));

  const labelsA = a.bundle.sides.map((s) => s.label);
  const labelsB = b.bundle.sides.map((s) => s.label);
  const onlyOld = labelsA.filter((l) => !labelsB.includes(l));
  const onlyNew = labelsB.filter((l) => !labelsA.includes(l));
  const seriesA = seriesOf(a);
  const seriesB = new Map(seriesOf(b).map((s) => [s.label, s]));
  const pairs = seriesA.flatMap((x) => {
    const y = seriesB.get(x.label);
    return y ? [[x, y] as const] : [];
  });
  if (!pairs.length) throw new CompareError(`the runs have no candidate in common (old: ${seriesA.map((s) => s.label).join(", ")}; new: ${[...seriesB.keys()].join(", ")})`);
  for (const [x, y] of pairs) if (x.ref !== y.ref) warnings.push(`${x.label} is compared with ${x.ref} in the old run and ${y.ref} in the new one`);

  // Rows first, without intervals: how many comparisons there are sets each one's confidence.
  type Pending = Omit<CompareRow, "shift" | "call" | "sameWithin" | "absolute" | "refChanged"> & { values?: { old: { ref: number[]; cand: number[] }; new: { ref: number[]; cand: number[] } } };
  const pending: Pending[] = [];
  for (const [x, y] of pairs) {
    const base = { label: x.label, mode: x.mode, ref: { old: x.ref, new: y.ref } };
    const notMeasured = x.state !== "measured" ? `${x.state} in old` : y.state !== "measured" ? `${y.state} in new` : null;
    if (notMeasured) {
      const def = defs.length === 1 ? defs[0]! : { key: "*", label: "every metric", unit: "" };
      pending.push({ ...base, metric: def.key, metricLabel: def.label, unit: def.unit, state: notMeasured, old: null, new: null });
      continue;
    }
    for (const def of defs) {
      const va = x.metrics.get(def.key) ?? null;
      const vb = y.metrics.get(def.key) ?? null;
      // A metric neither run has (a phase skipped, or from before it existed) is no row at all.
      if (!va && !vb) continue;
      const row = { ...base, metric: def.key, metricLabel: def.label, unit: def.unit, old: va && figures(va), new: vb && figures(vb) };
      if (!va || !vb) pending.push({ ...row, state: `not measured in ${va ? "new" : "old"}` });
      else pending.push({ ...row, state: "compared", values: { old: va, new: vb } });
    }
  }
  const comparisons = pending.filter((r) => r.state === "compared").length;
  const familyWise = opts.familyWise === true;
  const perComparison = familyWise && comparisons > 1 ? 1 - (1 - confidence) / comparisons : confidence;
  const shaOf = (r: Run, label: string): string | null => r.bundle.sides.find((s) => s.label === label)?.binSha256 ?? null;
  const refChanged = (ref: CompareRow["ref"]): boolean => ref.old !== ref.new || shaOf(a, ref.old) !== shaOf(b, ref.new);
  // Many rows at 95% each: a gate on them would trip on chance alone.
  if (opts.policy && !familyWise && comparisons > 10)
    warnings.push(`--fail-on judges ${comparisons} comparisons at ${Math.round(confidence * 100)}% each: about ${Math.round(comparisons * (1 - confidence))} false calls are expected between identical runs; narrow them with --metrics, or use --family-wise`);

  const rows: CompareRow[] = pending.map(({ values, ...r }) => {
    if (!values) return { ...r, shift: null, call: null, sameWithin: null, absolute: null, refChanged: refChanged(r.ref) };
    const ratios = (v: { ref: number[]; cand: number[] }): number[] => v.cand.map((c, i) => c / v.ref[i]!);
    const shift = ratioShift(ratios(values.old), ratios(values.new), perComparison);
    // The floor in ms is over the old candidate's figure: a change of F ms in the candidate moves the
    // ratio of ratios by about F / (its old time), as a change in a bench moves its ratio by F / (the
    // reference's time).
    const same = sameWithin(resolution.relative, r.unit === "ms" ? resolution.floorMs : 0, r.old!.candMedian);
    const raw = shift ? callOf(shift, { confidence: perComparison, same, sameFirst: same > resolution.relative + 1e-12 }) : null;
    const call: CompareCall | null = raw === "faster" ? "better" : raw === "slower" ? "worse" : raw;
    const absolute = sameMachine === true ? ratioShift(values.old.cand, values.new.cand, perComparison) : null;
    return { ...r, state: shift ? "compared" : "a ratio is 0", shift, call, sameWithin: same, absolute, refChanged: refChanged(r.ref) };
  });

  const counts: Partial<Record<CompareCall, number>> = {};
  for (const r of rows) if (r.call) counts[r.call] = (counts[r.call] ?? 0) + 1;
  const policy = opts.policy ? evaluateComparePolicy(rows, opts.policy) : null;
  return {
    schema: COMPARISON_SCHEMA,
    kind: a.kind,
    project: b.project,
    old: runInfo(a),
    new: runInfo(b),
    sameMachine,
    confidence,
    familyWise,
    comparisons,
    perComparison,
    resolution,
    warnings,
    onlyOld,
    onlyNew,
    rows,
    counts,
    policy,
  };
}

export function compareResults(oldPath: string, newPath: string, opts: CompareOptions = {}): Comparison {
  return compareRuns(loadRun(oldPath), loadRun(newPath), opts);
}
