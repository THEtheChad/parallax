// `parallax bench`: time each side's check command (the profile's `check`) on one project.
//
//   warm-up   each side runs `warmup` times; recorded, never measured
//   rounds    see timing/rounds.ts: idle wait, canaries, alternating order, retries of disturbed rounds
//   result    per side: median wall, CPU and peak memory over accepted rounds with intervals; per
//             candidate: the median of its per-round ratio to the reference, with an interval, and
//             "noisy" instead of a number when fewer than `minRounds` rounds were accepted
//
// Every sample and round goes to samples.jsonl as it happens, rejected ones included.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
import { detectAccounting } from "../host/accounting.ts";
import { machineStateNotes } from "../host/machineState.ts";
import { groupTrackingAvailable } from "../host/procGroup.ts";
import { DEFAULT_IDLE_GATE, hostLoad, priorityNote, type HostLoad, type IdleGate } from "../host/machine.ts";
import { bindSide, crashSignals, expand, sidesInModes, THREAD_MODES, type Side, type ThreadMode } from "../profile/profile.ts";
import { CANARY_SIZE, CANARY_VERSION } from "../timing/canary.ts";
import { runRounds, settledAtLook } from "../timing/rounds.ts";
import { DEFAULT_RESOLUTION, DEFAULT_RESOLUTION_MS } from "../timing/stats.ts";
import { runCommand } from "../timing/runCommand.ts";
import { DEFAULT_GATES, summarizeBench, type BenchSummary, type CounterRecord, type Gates, type RoundRecord, type SampleRecord } from "../timing/summary.ts";
import { counterPlan, countCommand, type CounterBackend, type CounterPlan } from "../host/counters.ts";
import { parsePinning, pinCommand, type Pinning } from "../host/pinning.ts";
import { DEFAULT_ENV_POLICY, type EnvPolicy } from "../host/sealedEnv.ts";
import { checkCalibration, hostKey, loadCalibration, type CalibrationRef } from "../timing/calibration.ts";
import { prepareBundleDir } from "./lspDiff.ts";

export interface BenchSettings {
  config: string;
  // Thread modes each side runs in (absent in bundles from before modes: default only).
  threads: ThreadMode[];
  // Rounds before the first look, and the most rounds a bench runs while some call is unsettled
  // (stats.ts lookPoints; absent in bundles from before sequential rounds: runs).
  runs: number;
  maxRuns: number;
  minRounds: number;
  // "same" means within this fraction of the reference, or within resolutionMs where that is larger.
  resolution: number;
  resolutionMs: number;
  // Counted runs per side after the timed rounds, where a counter backend works (host/counters.ts).
  counterRuns: number;
  warmup: number;
  attempts: number;
  timeoutMs: number;
  idle: IdleGate;
  gates: Gates;
  // How each command's environment is built (host/sealedEnv.ts; absent in older bundles: inherited).
  env?: EnvPolicy;
  // Cores every measured command is pinned to (host/pinning.ts); null: not pinned.
  pin?: Pinning | null;
}

export interface BenchBundle {
  schema: typeof BUNDLE_SCHEMA;
  kind: "cli-bench";
  status: "running" | "complete" | "failed";
  createdAt: string;
  finishedAt: string | null;
  harness: ReturnType<typeof harnessInfo>;
  host: HostInfo & {
    load: HostLoad;
    accounting: string;
    counters?: CounterBackend;
    // Which events were counted, in which runs, and which this machine would not count.
    counterPlan?: CounterPlan;
    // The stored A/A calibration this bench was checked against (timing/calibration.ts).
    calibration?: CalibrationRef | null;
  };
  corpus: CorpusInfo;
  settings: BenchSettings;
  canary: { version: string; size: number };
  sides: (SideRecord & { checkCommand: string[] })[];
  notes: string[];
}

export interface BenchOptions extends Partial<Omit<BenchSettings, "idle" | "gates" | "pin">> {
  // A kernel cpu list ("2-5") to pin every measured command to.
  pin?: string;
  project: string;
  out: string;
  ref: string;
  cands: string[];
  idle?: Partial<IdleGate>;
  gates?: Partial<Gates>;
  log: (msg: string) => void;
}

const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 1 : 0)} ms`);

// Infinity means "no limit"; store it as null, which is what JSON would make of it anyway.
const offIfUnlimited = (g: Gates): Gates => ({
  maxOutsideCores: g.maxOutsideCores !== null && Number.isFinite(g.maxOutsideCores) ? g.maxOutsideCores : null,
  maxCanaryDrift: g.maxCanaryDrift !== null && Number.isFinite(g.maxCanaryDrift) ? g.maxCanaryDrift : null,
});

export function checkCommand(side: Side, config: string, project: string): string[] {
  if (!side.profile.check) throw new Error(`profile ${side.profile.name} has no check command`);
  return [...side.profile.check.command.map((t) => expand(t, { ...side.vars, config, project })), ...side.checkArgs];
}

export async function bench(opts: BenchOptions): Promise<{ dir: string; bundle: BenchBundle; summary: BenchSummary }> {
  const root = resolve(opts.project);
  if (!existsSync(root)) throw new Error(`no project at ${root}`);
  const settings: BenchSettings = {
    config: opts.config ?? "tsconfig.json",
    threads: opts.threads ?? [...THREAD_MODES],
    runs: opts.runs ?? 6,
    maxRuns: opts.maxRuns ?? Math.max(15, opts.runs ?? 6),
    minRounds: opts.minRounds ?? 3,
    resolution: opts.resolution ?? DEFAULT_RESOLUTION,
    resolutionMs: opts.resolutionMs ?? DEFAULT_RESOLUTION_MS,
    counterRuns: opts.counterRuns ?? 3,
    warmup: opts.warmup ?? 1,
    attempts: opts.attempts ?? 3,
    timeoutMs: opts.timeoutMs ?? 600_000,
    idle: { ...DEFAULT_IDLE_GATE, ...opts.idle },
    gates: offIfUnlimited({ ...DEFAULT_GATES, ...opts.gates }),
    env: opts.env ?? DEFAULT_ENV_POLICY,
    pin: null,
  };
  const host = hostInfo();
  if (opts.pin !== undefined) settings.pin = parsePinning(opts.pin, host.state.affinity?.list ?? null);
  if (!existsSync(resolve(root, settings.config))) throw new Error(`no ${settings.config} in ${root}`);
  if (settings.minRounds > settings.runs) throw new Error(`--min-runs ${settings.minRounds} is more than --runs ${settings.runs}`);
  if (settings.maxRuns < settings.runs) throw new Error(`--max-runs ${settings.maxRuns} is less than --runs ${settings.runs}`);
  const bound: Side[] = [await bindSide(opts.ref, "ref", { env: settings.env! })];
  for (const c of opts.cands) bound.push(await bindSide(c, "cand", { env: settings.env! }));
  const sides = sidesInModes(bound, settings.threads, "check");
  const labels = sides.map((s) => s.label);
  if (new Set(labels).size !== labels.length) throw new Error(`side labels must be unique (got ${labels.join(", ")})`);
  const commands = new Map(sides.map((s) => [s.label, pinCommand(checkCommand(s, settings.config, root), settings.pin ?? null)]));

  const dir = prepareBundleDir(opts.out);
  const outputsDir = join(dir, "outputs");
  mkdirSync(outputsDir);
  const accounting = `${detectAccounting().kind}${groupTrackingAvailable() ? "+proc" : ""}`;
  const bundle: BenchBundle = {
    schema: BUNDLE_SCHEMA,
    kind: "cli-bench",
    status: "running",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    harness: harnessInfo(),
    host: { ...host, load: hostLoad(), accounting },
    corpus: corpusInfo(root),
    settings,
    canary: { version: CANARY_VERSION, size: CANARY_SIZE },
    sides: sides.map((s) => ({ ...sideRecord(s), checkCommand: commands.get(s.label)! })),
    notes: [],
  };
  const plan = settings.counterRuns > 0 ? counterPlan() : null;
  bundle.host.counters = plan?.backend ?? "none";
  if (plan?.backend === "perf") bundle.host.counterPlan = plan;
  const calibration = checkCalibration(loadCalibration("cli-bench"), hostKey(host, settings.pin?.cpus ?? null), {
    resolution: settings.resolution,
    runs: settings.runs,
    modes: settings.threads,
    metrics: ["wallMs"],
  });
  bundle.host.calibration = calibration.ref;
  if (accounting.startsWith("none")) bundle.notes.push("no child-process accounting on this machine: no CPU, memory or outside-load figures");
  if (plan?.backend === "perf" && plan.unavailable.length) bundle.notes.push(`counters this machine would not count (left out): ${plan.unavailable.join(", ")}`);
  if (plan?.backend === "perf" && plan.groups.length > 1)
    bundle.notes.push(`this machine counts one hardware event at a time: ${plan.groups.length} counted runs per count (${plan.groups.map((g) => g.join("+")).join(" / ")})`);
  for (const note of [priorityNote(bundle.host.load), ...machineStateNotes(bundle.host.state), ...calibration.notes]) {
    if (!note) continue;
    bundle.notes.push(note);
    opts.log(`warning: ${note}`);
  }
  if (process.platform === "linux" && /microsoft/i.test(bundle.host.kernel) && /^\/mnt\/[a-z]\//.test(root)) {
    const note = "the project is on the Windows disk, read from WSL through a slow file share: times include the share";
    bundle.notes.push(note);
    opts.log(`warning: ${note}`);
  }
  const save = (): void => writeJsonAtomic(join(dir, "bundle.json"), bundle);
  save();
  opts.log(`bundle ${dir}\nproject ${root} (${settings.config}); accounting ${accounting}; environment ${settings.env!.mode}${settings.pin ? `; pinned to cores ${settings.pin.cpus}` : ""}`);

  const writer = new KeepingJsonlWriter(join(dir, "samples.jsonl"));
  const sample = async (side: Side, round: number, attempt: number, warmup: boolean): Promise<SampleRecord> => {
    const r = await runCommand({ command: commands.get(side.label)!, cwd: root, env: side.env.env, timeoutMs: settings.timeoutMs, outputsDir });
    const { stderrTail, usage, group, cpuMs, maxRssBytes, ...rest } = r;
    // A launcher that leaves its worker unreaped hides the worker from `time`; without /proc to find
    // it, the CPU and memory figures would be the launcher's alone, so they are unknown instead.
    const blind = side.profile.processModel === "launcher+worker" && group === null;
    const rec: SampleRecord = {
      type: "sample",
      side: side.label,
      role: side.role,
      round,
      attempt,
      warmup,
      ...rest,
      // Exit codes are not crash signs for a checker: tsc exits non-zero when it reports errors.
      crashSignals: crashSignals(side.profile, null, stderrTail),
      cpuMs: blind ? null : cpuMs,
      userMs: blind ? null : (usage?.userMs ?? null),
      sysMs: blind ? null : (usage?.sysMs ?? null),
      adoptedCpuMs: group?.adoptedCpuMs ?? null,
      adopted: group?.adopted ?? null,
      maxRssBytes: blind ? null : maxRssBytes,
    };
    await writer.write(rec);
    return rec;
  };

  for (let w = 1; w <= settings.warmup; w++) for (const s of sides) await sample(s, 0, w, true);
  await runRounds({
    sides,
    runs: settings.runs,
    maxRuns: settings.maxRuns,
    stop: () => settledAtLook(summarizeBenchRecords(bundle, writer.records as Records), settings, opts.log),
    attempts: settings.attempts,
    idle: settings.idle,
    gates: settings.gates,
    writer,
    log: opts.log,
    run: async (side, round, attempt) => {
      const s = await sample(side, round, attempt, false);
      return { cpuMs: s.cpuMs, failed: s.timedOut || s.exit.signal !== null || s.crashSignals.length > 0, brief: fmtMs(s.wallMs) };
    },
  });
  if (plan?.backend === "perf") {
    opts.log(`counting: ${settings.counterRuns} runs per side under perf stat${plan.groups.length > 1 ? `, each as ${plan.groups.length} runs (one per event group)` : ""}`);
    for (let run = 1; run <= settings.counterRuns; run++) {
      const order = run % 2 ? sides : [...sides].reverse();
      for (const side of order) {
        const c = await countCommand({ command: commands.get(side.label)!, cwd: root, env: side.env.env, timeoutMs: settings.timeoutMs, groups: plan!.groups });
        const rec: CounterRecord = { type: "counters", side: side.label, run, ...c };
        await writer.write(rec);
      }
    }
  }
  await writer.close();

  const after = corpusState(root);
  bundle.corpus.statusSha256After = after.status === null ? null : sha256(after.status);
  bundle.corpus.changedDuringRun = bundle.corpus.statusSha256Before === null ? null : bundle.corpus.statusSha256Before !== bundle.corpus.statusSha256After;
  if (bundle.corpus.changedDuringRun) bundle.notes.push("the corpus's git status changed during the run: a check wrote into the project");
  bundle.host.loadAfter = hostLoad().loadavg;
  const summary = summarizeBenchBundle(dir, bundle);
  bundle.status = "complete";
  bundle.finishedAt = new Date().toISOString();
  save();
  return { dir, bundle, summary };
}

export function readBenchBundle(dir: string): BenchBundle {
  const b = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")) as BenchBundle;
  if (b.schema !== BUNDLE_SCHEMA || b.kind !== "cli-bench") throw new Error(`${dir}: not a ${BUNDLE_SCHEMA} cli-bench bundle`);
  return b;
}

export type Records = (SampleRecord | RoundRecord | CounterRecord)[];

// The summary of a bundle from its records (a pure function: `bench-summary` and published results
// recompute it).
export function summarizeBenchRecords(bundle: BenchBundle, records: Records, gates: Gates = bundle.settings.gates): BenchSummary {
  const st = bundle.settings;
  return summarizeBench({
    records,
    sides: bundle.sides.map((s) => ({ label: s.label, role: s.role, mode: s.mode, base: s.base })),
    plannedRounds: st.runs,
    maxRounds: st.maxRuns,
    minRounds: st.minRounds,
    ...(st.resolution !== undefined ? { resolution: { relative: st.resolution, floorMs: st.resolutionMs } } : {}),
    gates,
    accounting: bundle.host.accounting,
    ...(bundle.host.counters ? { counters: bundle.host.counters } : {}),
  });
}

// Recomputes summary.json from samples.jsonl.
export function summarizeBenchBundle(dir: string, bundle: BenchBundle, gates: Gates = bundle.settings.gates): BenchSummary {
  const records = readFileSync(join(dir, "samples.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SampleRecord | RoundRecord | CounterRecord);
  const summary = summarizeBenchRecords(bundle, records, gates);
  writeJsonAtomic(join(dir, "summary.json"), summary);
  return summary;
}
