// `parallax bench`: time each side's check command (the profile's `check`) on one project.
//
//   warm-up   each side runs `warmup` times; recorded, never measured
//   rounds    wait for an idle machine, canary, every side once, canary; the order alternates
//             (ref, A, B / B, A, ref / ...) so no side always runs first or after the same neighbour
//   retries   a disturbed round (see timing/summary.ts) is run again, up to `attempts` times
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
import { JsonlWriter } from "../bundle/lines.ts";
import { detectAccounting } from "../host/accounting.ts";
import { groupTrackingAvailable } from "../host/procGroup.ts";
import { cpuSnapshot, cpuWindow, DEFAULT_IDLE_GATE, hostLoad, outsideCores, waitForIdle, type HostLoad, type IdleGate } from "../host/machine.ts";
import { bindSide, crashSignals, expand, type Side } from "../profile/profile.ts";
import { CANARY_SIZE, CANARY_VERSION, runCanary } from "../timing/canary.ts";
import { runCommand } from "../timing/runCommand.ts";
import { DEFAULT_GATES, judgeRound, summarizeBench, type BenchSummary, type Gates, type RoundRecord, type SampleRecord } from "../timing/summary.ts";
import { prepareBundleDir } from "./lspDiff.ts";

export interface BenchSettings {
  config: string;
  runs: number;
  minRounds: number;
  warmup: number;
  attempts: number;
  timeoutMs: number;
  idle: IdleGate;
  gates: Gates;
}

export interface BenchBundle {
  schema: typeof BUNDLE_SCHEMA;
  kind: "cli-bench";
  status: "running" | "complete" | "failed";
  createdAt: string;
  finishedAt: string | null;
  harness: ReturnType<typeof harnessInfo>;
  host: HostInfo & { load: HostLoad; accounting: string };
  corpus: CorpusInfo;
  settings: BenchSettings;
  canary: { version: string; size: number };
  sides: (SideRecord & { checkCommand: string[] })[];
  notes: string[];
}

export interface BenchOptions extends Partial<Omit<BenchSettings, "idle" | "gates">> {
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
  return side.profile.check.command.map((t) => expand(t, { ...side.vars, config, project }));
}

export async function bench(opts: BenchOptions): Promise<{ dir: string; bundle: BenchBundle; summary: BenchSummary }> {
  const root = resolve(opts.project);
  if (!existsSync(root)) throw new Error(`no project at ${root}`);
  const settings: BenchSettings = {
    config: opts.config ?? "tsconfig.json",
    runs: opts.runs ?? 5,
    minRounds: opts.minRounds ?? 3,
    warmup: opts.warmup ?? 1,
    attempts: opts.attempts ?? 3,
    timeoutMs: opts.timeoutMs ?? 600_000,
    idle: { ...DEFAULT_IDLE_GATE, ...opts.idle },
    gates: offIfUnlimited({ ...DEFAULT_GATES, ...opts.gates }),
  };
  if (!existsSync(resolve(root, settings.config))) throw new Error(`no ${settings.config} in ${root}`);
  if (settings.minRounds > settings.runs) throw new Error(`--min-runs ${settings.minRounds} is more than --runs ${settings.runs}`);
  const sides: Side[] = [await bindSide(opts.ref, "ref")];
  for (const c of opts.cands) sides.push(await bindSide(c, "cand"));
  const labels = sides.map((s) => s.label);
  if (new Set(labels).size !== labels.length) throw new Error(`side labels must be unique (got ${labels.join(", ")})`);
  const commands = new Map(sides.map((s) => [s.label, checkCommand(s, settings.config, root)]));

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
    host: { ...hostInfo(), load: hostLoad(), accounting },
    corpus: corpusInfo(root),
    settings,
    canary: { version: CANARY_VERSION, size: CANARY_SIZE },
    sides: sides.map((s) => ({ ...sideRecord(s), checkCommand: commands.get(s.label)! })),
    notes: [],
  };
  if (accounting.startsWith("none")) bundle.notes.push("no child-process accounting on this machine: no CPU, memory or outside-load figures");
  const save = (): void => writeJsonAtomic(join(dir, "bundle.json"), bundle);
  save();
  opts.log(`bundle ${dir}\nproject ${root} (${settings.config}); accounting ${accounting}`);

  const writer = new JsonlWriter(join(dir, "samples.jsonl"));
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

  runCanary(); // warm the canary's code before its first timed use
  let fastestCanary = Infinity;
  for (let w = 1; w <= settings.warmup; w++) for (const s of sides) await sample(s, 0, w, true);

  for (let round = 1; round <= settings.runs; round++) {
    const order = round % 2 ? sides : [...sides].reverse();
    for (let attempt = 1; attempt <= settings.attempts; attempt++) {
      const idle = await waitForIdle(settings.idle, opts.log);
      const before = cpuSnapshot();
      const canaryBeforeMs = runCanary().ms;
      const ss: SampleRecord[] = [];
      for (const s of order) ss.push(await sample(s, round, attempt, false));
      const canaryAfterMs = runCanary().ms;
      const window = cpuWindow(before, cpuSnapshot());
      const cpu = ss.every((s) => s.cpuMs !== null) ? ss.reduce((t, s) => t + s.cpuMs!, 0) : null;
      fastestCanary = Math.min(fastestCanary, canaryBeforeMs, canaryAfterMs);
      const partial = { idle, outsideCores: outsideCores(window, cpu), canaryBeforeMs, canaryAfterMs };
      const rejected = judgeRound(partial, fastestCanary, settings.gates);
      const failed = ss.filter((s) => s.timedOut || s.exit.signal !== null || s.crashSignals.length);
      const rec: RoundRecord = { type: "round", round, attempt, order: order.map((s) => s.label), window, ...partial, rejected };
      await writer.write(rec);
      const times = ss.map((s) => `${s.side} ${fmtMs(s.wallMs)}`).join(", ");
      const other = partial.outsideCores === null ? "" : `, other ${partial.outsideCores.toFixed(2)} cores`;
      opts.log(`round ${round}.${attempt}: ${times} (canary ${canaryBeforeMs.toFixed(1)}/${canaryAfterMs.toFixed(1)} ms${other})${rejected.length ? ` rejected: ${rejected.join("; ")}` : ""}`);
      if (failed.length) {
        opts.log(`round ${round}: ${failed.map((s) => s.side).join(", ")} failed; not retried`);
        break;
      }
      if (!rejected.length) break;
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

// Recomputes summary.json from samples.jsonl.
export function summarizeBenchBundle(dir: string, bundle: BenchBundle, gates: Gates = bundle.settings.gates): BenchSummary {
  const records = readFileSync(join(dir, "samples.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SampleRecord | RoundRecord);
  const summary = summarizeBench({
    records,
    sides: bundle.sides.map((s) => ({ label: s.label, role: s.role })),
    plannedRounds: bundle.settings.runs,
    minRounds: bundle.settings.minRounds,
    gates,
    accounting: bundle.host.accounting,
  });
  writeJsonAtomic(join(dir, "summary.json"), summary);
  return summary;
}
