// `parallax lsp-bench`: time each side's language server through one editor session per round (see
// timing/lspSession.ts for the phases and metrics), in the same rounds as `bench`: idle wait, canaries,
// alternating order, disturbed rounds retried, candidates compared by per-round ratio to the reference.
//
// Every request of every session goes to runs/<side>.<round>.<attempt>.jsonl; every session and round
// to samples.jsonl. summary.json is recomputed from samples.jsonl (`bench-summary`).

import { existsSync, readFileSync } from "node:fs";
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
  type CorpusInfo,
  type HostInfo,
  type SideRecord,
} from "../bundle/bundle.ts";
import { JsonlWriter } from "../bundle/lines.ts";
import { DEFAULT_IDLE_GATE, hostLoad, priorityNote, type HostLoad, type IdleGate } from "../host/machine.ts";
import { machineStateNotes } from "../host/machineState.ts";
import { memoryKind, usageBackend } from "../host/serverUsage.ts";
import { bindSide, sidesInModes, THREAD_MODES, type Side, type ThreadMode } from "../profile/profile.ts";
import { pickFiles, rel } from "../session/picker.ts";
import { TYPED } from "../session/script.ts";
import { CANARY_SIZE, CANARY_VERSION } from "../timing/canary.ts";
import { DEBOUNCE_MS, HOVER_EVERY, LSP_SESSION_ID, runLspTiming, type LspTimingSpec } from "../timing/lspSession.ts";
import { summarizeLspBench, type LspBenchSummary, type SessionRecord } from "../timing/lspSummary.ts";
import { runRounds } from "../timing/rounds.ts";
import { DEFAULT_GATES, type Gates, type RoundRecord } from "../timing/summary.ts";
import { prepareBundleDir } from "./lspDiff.ts";

export interface LspBenchSettings {
  // Thread modes each server runs in (absent in bundles from before modes: default only).
  threads: ThreadMode[];
  files: number;
  edits: number;
  intervalMs: number;
  lines: number;
  serviceLines: number;
  runs: number;
  minRounds: number;
  warmup: number;
  attempts: number;
  requestTimeoutMs: number;
  idle: IdleGate;
  gates: Gates;
}

export interface LspBenchBundle {
  schema: typeof BUNDLE_SCHEMA;
  kind: "lsp-bench";
  status: "running" | "complete" | "failed";
  createdAt: string;
  finishedAt: string | null;
  harness: ReturnType<typeof harnessInfo>;
  host: HostInfo & { load: HostLoad; usage: string; memory: "peak" | "current" | null };
  corpus: CorpusInfo;
  settings: LspBenchSettings;
  session: { id: string; files: string[]; typed: string; debounceMs: number; hoverEvery: number };
  canary: { version: string; size: number };
  sides: SideRecord[];
  notes: string[];
}

export interface LspBenchOptions extends Partial<Omit<LspBenchSettings, "idle" | "gates">> {
  project: string;
  out: string;
  ref: string;
  cands: string[];
  // Files (relative to the project) to open; the first is edited. Default: picked like lsp-diff.
  file?: string[];
  idle?: Partial<IdleGate>;
  gates?: Partial<Gates>;
  log: (msg: string) => void;
}

const fmtMs = (ms: number | null): string => (ms === null ? "-" : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 1 : 0)} ms`);

const offIfUnlimited = (g: Gates): Gates => ({
  maxOutsideCores: g.maxOutsideCores !== null && Number.isFinite(g.maxOutsideCores) ? g.maxOutsideCores : null,
  maxCanaryDrift: g.maxCanaryDrift !== null && Number.isFinite(g.maxCanaryDrift) ? g.maxCanaryDrift : null,
});

export async function lspBench(opts: LspBenchOptions): Promise<{ dir: string; bundle: LspBenchBundle; summary: LspBenchSummary }> {
  const root = resolve(opts.project);
  if (!existsSync(root)) throw new Error(`no project at ${root}`);
  const settings: LspBenchSettings = {
    threads: opts.threads ?? [...THREAD_MODES],
    files: opts.files ?? 6,
    edits: opts.edits ?? 20,
    intervalMs: opts.intervalMs ?? 120,
    lines: opts.lines ?? 4,
    serviceLines: opts.serviceLines ?? 1,
    runs: opts.runs ?? 5,
    minRounds: opts.minRounds ?? 3,
    warmup: opts.warmup ?? 1,
    attempts: opts.attempts ?? 3,
    requestTimeoutMs: opts.requestTimeoutMs ?? 120_000,
    idle: { ...DEFAULT_IDLE_GATE, ...opts.idle },
    gates: offIfUnlimited({ ...DEFAULT_GATES, ...opts.gates }),
  };
  if (settings.minRounds > settings.runs) throw new Error(`--min-runs ${settings.minRounds} is more than --runs ${settings.runs}`);
  if (!(settings.intervalMs > 0)) throw new Error("--interval-ms must be more than 0");
  const bound: Side[] = [await bindSide(opts.ref, "ref")];
  for (const c of opts.cands) bound.push(await bindSide(c, "cand"));
  const sides = sidesInModes(bound, settings.threads, "lsp");
  const labels = sides.map((s) => s.label);
  if (new Set(labels).size !== labels.length) throw new Error(`side labels must be unique (got ${labels.join(", ")})`);

  const files = pickFiles(root, settings.files, opts.file);
  if (!files.length) throw new Error(`no TypeScript files found in ${root}`);
  const spec: LspTimingSpec = { root, files, edits: settings.edits, intervalMs: settings.intervalMs, lines: settings.lines, serviceLines: settings.serviceLines, requestTimeoutMs: settings.requestTimeoutMs };
  const dir = prepareBundleDir(opts.out);
  const usage = usageBackend();
  const bundle: LspBenchBundle = {
    schema: BUNDLE_SCHEMA,
    kind: "lsp-bench",
    status: "running",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    harness: harnessInfo(),
    host: { ...hostInfo(), load: hostLoad(), usage, memory: memoryKind(usage) },
    corpus: corpusInfo(root),
    settings,
    session: { id: LSP_SESSION_ID, files: files.map((f) => rel(root, f)), typed: TYPED, debounceMs: DEBOUNCE_MS, hoverEvery: HOVER_EVERY },
    canary: { version: CANARY_VERSION, size: CANARY_SIZE },
    sides: sides.map(sideRecord),
    notes: [],
  };
  const warn = (note: string): void => {
    bundle.notes.push(note);
    opts.log(`warning: ${note}`);
  };
  if (usage === "none") warn("no way to read a running server's CPU and memory on this machine: those figures and outside load are blank");
  for (const note of [priorityNote(bundle.host.load), ...machineStateNotes(bundle.host.state)]) if (note) warn(note);
  if (process.platform === "linux" && /microsoft/i.test(bundle.host.kernel) && /^\/mnt\/[a-z]\//.test(root))
    warn("the project is on the Windows disk, read from WSL through a slow file share: times include the share");
  const save = (): void => writeJsonAtomic(join(dir, "bundle.json"), bundle);
  save();
  opts.log(`bundle ${dir}\nproject ${root}; files: ${bundle.session.files.join(", ")} (editing ${bundle.session.files[0]}); server usage ${usage}`);

  const writer = new JsonlWriter(join(dir, "samples.jsonl"));
  const session = async (side: Side, round: number, attempt: number, warmup: boolean): Promise<SessionRecord> => {
    const id = warmup ? `${side.label}.warmup${attempt}` : `${side.label}.${round}.${attempt}`;
    const startedAt = new Date().toISOString();
    const r = await runLspTiming({ bundleDir: dir, id, side, spec, log: opts.log });
    const rec: SessionRecord = {
      type: "session",
      side: side.label,
      role: side.role,
      round,
      attempt,
      warmup,
      startedAt,
      outcome: r.outcome,
      ...(r.error !== undefined ? { error: r.error } : {}),
      exit: r.exit,
      shutdownClean: r.shutdownClean,
      crashSignals: r.crashSignals,
      durationMs: r.durationMs,
      cpuMs: r.cpuMs,
      metrics: r.metrics,
      counts: r.counts,
      file: r.file,
    };
    await writer.write(rec);
    return rec;
  };

  for (let w = 1; w <= settings.warmup; w++) {
    for (const s of sides) {
      const r = await session(s, 0, w, true);
      opts.log(`warm-up ${s.label}: ${r.outcome}, first diagnostics ${fmtMs(r.metrics["open.firstDiagnosticsMs"])}`);
    }
  }
  await runRounds({
    sides,
    runs: settings.runs,
    attempts: settings.attempts,
    idle: settings.idle,
    gates: settings.gates,
    writer,
    log: opts.log,
    run: async (side, round, attempt) => {
      const s = await session(side, round, attempt, false);
      const brief = s.outcome === "clean" ? `diag ${fmtMs(s.metrics["open.firstDiagnosticsMs"])} / compl p95 ${fmtMs(s.metrics["typing.completionP95Ms"])}` : s.outcome;
      return { cpuMs: s.cpuMs, failed: s.outcome !== "clean", brief };
    },
  });
  await writer.close();

  const after = corpusState(root);
  bundle.corpus.statusSha256After = after.status === null ? null : sha256(after.status);
  bundle.corpus.changedDuringRun = bundle.corpus.statusSha256Before === null ? null : bundle.corpus.statusSha256Before !== bundle.corpus.statusSha256After;
  if (bundle.corpus.changedDuringRun) bundle.notes.push("the corpus's git status changed during the run");
  bundle.host.loadAfter = hostLoad().loadavg;
  const summary = summarizeLspBenchBundle(dir, bundle);
  if (summary.harnessLagP95Ms !== null && summary.harnessLagP95Ms > settings.intervalMs / 4)
    warn(`the harness sent keys up to ${summary.harnessLagP95Ms.toFixed(0)} ms late (p95): the client machine was too busy for a ${settings.intervalMs} ms typing interval`);
  bundle.status = "complete";
  bundle.finishedAt = new Date().toISOString();
  save();
  return { dir, bundle, summary };
}

export function readLspBenchBundle(dir: string): LspBenchBundle {
  const b = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")) as LspBenchBundle;
  if (b.schema !== BUNDLE_SCHEMA || b.kind !== "lsp-bench") throw new Error(`${dir}: not a ${BUNDLE_SCHEMA} lsp-bench bundle`);
  return b;
}

export function summarizeLspBenchBundle(dir: string, bundle: LspBenchBundle, gates: Gates = bundle.settings.gates): LspBenchSummary {
  const records = readFileSync(join(dir, "samples.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SessionRecord | RoundRecord);
  const summary = summarizeLspBench({
    records,
    sides: bundle.sides.map((s) => ({ label: s.label, role: s.role, mode: s.mode, base: s.base })),
    plannedRounds: bundle.settings.runs,
    minRounds: bundle.settings.minRounds,
    gates,
    usage: bundle.host.usage,
    memory: bundle.host.memory,
  });
  writeJsonAtomic(join(dir, "summary.json"), summary);
  return summary;
}
