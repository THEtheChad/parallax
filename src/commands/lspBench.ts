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
import { KeepingJsonlWriter } from "../bundle/lines.ts";
import { DEFAULT_IDLE_GATE, hostLoad, priorityNote, type HostLoad, type IdleGate } from "../host/machine.ts";
import { machineStateNotes } from "../host/machineState.ts";
import { memoryKind, usageBackend } from "../host/serverUsage.ts";
import { bindSide, sidesInModes, THREAD_MODES, type Side, type ThreadMode } from "../profile/profile.ts";
import { pickFiles, readText, rel } from "../session/picker.ts";
import { TYPED } from "../session/script.ts";
import { CANARY_SIZE, CANARY_VERSION } from "../timing/canary.ts";
import { DEBOUNCE_MS, HOVER_EVERY, importCandidates, LSP_SESSION_ID, runLspTiming, type LspTimingSpec } from "../timing/lspSession.ts";
import { summarizeLspBench, type LspBenchSummary, type SessionRecord } from "../timing/lspSummary.ts";
import { runRounds, settledAtLook } from "../timing/rounds.ts";
import { DEFAULT_RESOLUTION, DEFAULT_RESOLUTION_MS } from "../timing/stats.ts";
import { DEFAULT_GATES, type Gates, type RoundRecord } from "../timing/summary.ts";
import { prepareBundleDir } from "./lspDiff.ts";
import { warn as warnLog, type LogFn } from "../log.ts";
import { parsePinning, type Pinning } from "../host/pinning.ts";
import { DEFAULT_ENV_POLICY, type EnvPolicy } from "../host/sealedEnv.ts";
import { checkCalibration, hostKey, loadCalibration, type CalibrationRef } from "../timing/calibration.ts";
import { InputError, readJsonFile } from "../errors.ts";

export interface LspBenchSettings {
  // Thread modes each server runs in (absent in bundles from before modes: default only).
  threads: ThreadMode[];
  files: number;
  edits: number;
  intervalMs: number;
  lines: number;
  serviceLines: number;
  // The paused, errfix, imports and long phases (timing/lspSession.ts; absent in older bundles: not run).
  pausedLines?: number;
  pauseMs?: number;
  errfixes?: number;
  imports?: number;
  longEdits?: number;
  // Rounds before the first look, and the most rounds a bench runs while some call is unsettled
  // (stats.ts lookPoints; absent in bundles from before sequential rounds: runs).
  runs: number;
  maxRuns: number;
  minRounds: number;
  // "same" means within this fraction of the reference, or within resolutionMs where that is larger.
  resolution: number;
  resolutionMs: number;
  warmup: number;
  attempts: number;
  requestTimeoutMs: number;
  idle: IdleGate;
  gates: Gates;
  // How each server's environment is built (host/sealedEnv.ts; absent in older bundles: inherited).
  env?: EnvPolicy;
  // Cores every server is pinned to (host/pinning.ts); null: not pinned.
  pin?: Pinning | null;
}

export interface LspBenchBundle {
  schema: typeof BUNDLE_SCHEMA;
  kind: "lsp-bench";
  status: "running" | "complete" | "failed";
  createdAt: string;
  finishedAt: string | null;
  harness: ReturnType<typeof harnessInfo>;
  host: HostInfo & { load: HostLoad; usage: string; memory: "peak" | "current" | null; calibration?: CalibrationRef | null };
  corpus: CorpusInfo;
  settings: LspBenchSettings;
  session: { id: string; files: string[]; typed: string; debounceMs: number; hoverEvery: number };
  canary: { version: string; size: number };
  sides: SideRecord[];
  notes: string[];
}

export interface LspBenchOptions extends Partial<Omit<LspBenchSettings, "idle" | "gates" | "pin">> {
  // A kernel cpu list ("2-5") to pin every server to.
  pin?: string;
  project: string;
  out: string;
  ref: string;
  cands: string[];
  // Files (relative to the project) to open; the first is edited. Default: picked like lsp-diff.
  file?: string[];
  idle?: Partial<IdleGate>;
  gates?: Partial<Gates>;
  log: LogFn;
}

const fmtMs = (ms: number | null): string => (ms === null ? "-" : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 1 : 0)} ms`);

const offIfUnlimited = (g: Gates): Gates => ({
  maxOutsideCores: g.maxOutsideCores !== null && Number.isFinite(g.maxOutsideCores) ? g.maxOutsideCores : null,
  maxCanaryDrift: g.maxCanaryDrift !== null && Number.isFinite(g.maxCanaryDrift) ? g.maxCanaryDrift : null,
});

export async function lspBench(opts: LspBenchOptions): Promise<{ dir: string; bundle: LspBenchBundle; summary: LspBenchSummary }> {
  const root = resolve(opts.project);
  if (!existsSync(root)) throw new InputError(`no project at ${root}`);
  const settings: LspBenchSettings = {
    threads: opts.threads ?? [...THREAD_MODES],
    files: opts.files ?? 6,
    edits: opts.edits ?? 20,
    intervalMs: opts.intervalMs ?? 120,
    lines: opts.lines ?? 4,
    serviceLines: opts.serviceLines ?? 1,
    pausedLines: opts.pausedLines ?? 1,
    pauseMs: opts.pauseMs ?? 300,
    errfixes: opts.errfixes ?? 5,
    imports: opts.imports ?? 3,
    longEdits: opts.longEdits ?? 60,
    runs: opts.runs ?? 6,
    maxRuns: opts.maxRuns ?? Math.max(15, opts.runs ?? 6),
    minRounds: opts.minRounds ?? 3,
    resolution: opts.resolution ?? DEFAULT_RESOLUTION,
    resolutionMs: opts.resolutionMs ?? DEFAULT_RESOLUTION_MS,
    warmup: opts.warmup ?? 1,
    attempts: opts.attempts ?? 3,
    requestTimeoutMs: opts.requestTimeoutMs ?? 120_000,
    idle: { ...DEFAULT_IDLE_GATE, ...opts.idle },
    gates: offIfUnlimited({ ...DEFAULT_GATES, ...opts.gates }),
    env: opts.env ?? DEFAULT_ENV_POLICY,
    pin: null,
  };
  const host = hostInfo();
  if (opts.pin !== undefined) settings.pin = parsePinning(opts.pin, host.state.affinity?.list ?? null);
  if (settings.minRounds > settings.runs) throw new InputError(`--min-runs ${settings.minRounds} is more than --runs ${settings.runs}`);
  if (settings.maxRuns < settings.runs) throw new InputError(`--max-runs ${settings.maxRuns} is less than --runs ${settings.runs}`);
  if (!(settings.intervalMs > 0)) throw new InputError("--interval-ms must be more than 0");
  const bound: Side[] = [await bindSide(opts.ref, "ref", { env: settings.env! })];
  for (const c of opts.cands) bound.push(await bindSide(c, "cand", { env: settings.env! }));
  const sides = sidesInModes(bound, settings.threads, "lsp");
  const labels = sides.map((s) => s.label);
  if (new Set(labels).size !== labels.length) throw new InputError(`side labels must be unique (got ${labels.join(", ")})`);

  const files = pickFiles(root, settings.files, opts.file);
  if (!files.length) throw new InputError(`no TypeScript files found in ${root}`);
  const spec: LspTimingSpec = {
    root,
    files,
    edits: settings.edits,
    intervalMs: settings.intervalMs,
    lines: settings.lines,
    serviceLines: settings.serviceLines,
    pausedLines: settings.pausedLines!,
    pauseMs: settings.pauseMs!,
    errfixes: settings.errfixes!,
    imports: settings.imports!,
    longEdits: settings.longEdits!,
    pin: settings.pin ?? null,
    requestTimeoutMs: settings.requestTimeoutMs,
  };
  const dir = prepareBundleDir(opts.out);
  const usage = usageBackend();
  const bundle: LspBenchBundle = {
    schema: BUNDLE_SCHEMA,
    kind: "lsp-bench",
    status: "running",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    harness: harnessInfo(),
    host: { ...host, load: hostLoad(), usage, memory: memoryKind(usage) },
    corpus: corpusInfo(root),
    settings,
    session: { id: LSP_SESSION_ID, files: files.map((f) => rel(root, f)), typed: TYPED, debounceMs: DEBOUNCE_MS, hoverEvery: HOVER_EVERY },
    canary: { version: CANARY_VERSION, size: CANARY_SIZE },
    sides: sides.map(sideRecord),
    notes: [],
  };
  const warn = (note: string): void => {
    bundle.notes.push(note);
    warnLog(opts.log, note);
  };
  if (settings.imports! > 0) {
    const names = importCandidates(readText(files[0]!), files.slice(1).map(readText), settings.imports!);
    if (names.length < settings.imports!)
      warn(
        names.length
          ? `the imports phase found ${names.length} of ${settings.imports} names (the other files export few declarations not already used in the edited file)`
          : "the imports phase has nothing to ask: the other files export no declarations the edited file does not already use",
      );
  }
  const calibration = checkCalibration(loadCalibration("lsp-bench"), hostKey(host, settings.pin?.cpus ?? null), {
    resolution: settings.resolution,
    resolutionMs: settings.resolutionMs,
    runs: settings.runs,
    maxRuns: settings.maxRuns,
    modes: settings.threads,
  });
  bundle.host.calibration = calibration.ref;
  for (const note of calibration.notes) warn(note);
  if (usage === "none") warn("no way to read a running server's CPU and memory on this machine: those figures and outside load are blank");
  for (const note of [priorityNote(bundle.host.load), ...machineStateNotes(bundle.host.state)]) if (note) warn(note);
  if (process.platform === "linux" && /microsoft/i.test(bundle.host.kernel) && /^\/mnt\/[a-z]\//.test(root))
    warn("the project is on the Windows disk, read from WSL through a slow file share: times include the share");
  const save = (): void => writeJsonAtomic(join(dir, "bundle.json"), bundle);
  save();
  opts.log(`bundle ${dir}\nproject ${root}; files: ${bundle.session.files.join(", ")} (editing ${bundle.session.files[0]}); server usage ${usage}; environment ${settings.env!.mode}${settings.pin ? `; pinned to cores ${settings.pin.cpus}` : ""}`);

  const writer = new KeepingJsonlWriter(join(dir, "samples.jsonl"));
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
    maxRuns: settings.maxRuns,
    stop: (progress) => settledAtLook(summarizeLspBenchRecords(bundle, writer.records as Records), settings, opts.log, progress),
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
  let summary = summarizeLspBenchBundle(dir, bundle);
  if (summary.harnessLagP95Ms !== null && summary.harnessLagP95Ms > settings.intervalMs / 4) {
    warn(`the harness sent keys up to ${summary.harnessLagP95Ms.toFixed(0)} ms late (p95): the client machine was too busy for a ${settings.intervalMs} ms typing interval`);
    // Again, so the summary carries the warning its own figures raised.
    summary = summarizeLspBenchBundle(dir, bundle);
  }
  bundle.status = "complete";
  bundle.finishedAt = new Date().toISOString();
  save();
  return { dir, bundle, summary };
}

export function readLspBenchBundle(dir: string): LspBenchBundle {
  const b = readJsonFile(join(dir, "bundle.json")) as LspBenchBundle;
  if (b.schema !== BUNDLE_SCHEMA || b.kind !== "lsp-bench") throw new InputError(`${dir}: not a ${BUNDLE_SCHEMA} lsp-bench bundle`);
  return b;
}

export type Records = (SessionRecord | RoundRecord)[];

// The summary of a bundle from its records (a pure function: `bench-summary` and published results
// recompute it).
export function summarizeLspBenchRecords(bundle: LspBenchBundle, records: Records, gates: Gates = bundle.settings.gates): LspBenchSummary {
  const st = bundle.settings;
  return summarizeLspBench({
    records,
    sides: bundle.sides.map((s) => ({ label: s.label, role: s.role, mode: s.mode, base: s.base })),
    plannedRounds: st.runs,
    maxRounds: st.maxRuns,
    minRounds: st.minRounds,
    ...(st.resolution !== undefined ? { resolution: { relative: st.resolution, floorMs: st.resolutionMs } } : {}),
    gates,
    usage: bundle.host.usage,
    memory: bundle.host.memory,
    // Copied, so the summary does not change when the bundle's notes grow later.
    notes: [...(bundle.notes ?? [])],
  });
}

export function summarizeLspBenchBundle(dir: string, bundle: LspBenchBundle, gates: Gates = bundle.settings.gates): LspBenchSummary {
  const records = readFileSync(join(dir, "samples.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SessionRecord | RoundRecord);
  const summary = summarizeLspBenchRecords(bundle, records, gates);
  writeJsonAtomic(join(dir, "summary.json"), summary);
  return summary;
}
