// `parallax calibrate`: an A/A bench. One side is benched against itself (the same profile and binary
// under a second label, "<label>.aa"), for a fixed number of rounds, with `bench` or `lsp-bench`. Any
// difference found is this machine's noise; timing/calibration.ts turns it into a noise floor per
// metric and keeps the latest one per kind in the config directory, where later benches on the same
// host setup find it.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeJsonAtomic } from "../bundle/bundle.ts";
import { loadProfile } from "../profile/profile.ts";
import { CALIBRATION_SCHEMA, floorsOf, hostKey, saveCalibration, type AaComparison, type Calibration, type CalibrationKind } from "../timing/calibration.ts";
import { METRICS, sessionFailed, type LspBenchSummary, type SessionRecord } from "../timing/lspSummary.ts";
import { acceptRounds, refFor, sampleFailed, type BenchSummary, type RoundRecord, type SampleRecord } from "../timing/summary.ts";
import { bench, type BenchBundle, type BenchOptions } from "./bench.ts";
import { lspBench, type LspBenchBundle, type LspBenchOptions } from "./lspBench.ts";
import { warn } from "../log.ts";
import { InputError } from "../errors.ts";

export const DEFAULT_CALIBRATION_RUNS = 9;

type Shared = Omit<BenchOptions & LspBenchOptions, "ref" | "cands" | "maxRuns">;

export interface CalibrateOptions extends Shared {
  kind: CalibrationKind;
  side: string;
  // Keep the result in the config directory (default true).
  save?: boolean;
}

// The A/A twin of a side spec: the same profile and binary under the label "<label>.aa".
export function twinSpec(spec: string): string {
  const eq = spec.indexOf("=");
  if (eq < 1) throw new InputError(`side ${JSON.stringify(spec)}: want <profile>=<binary> or <label>:<profile>=<binary>`);
  const left = spec.slice(0, eq);
  const labelled = /^[A-Za-z]:[\\/]/.test(left) ? null : /^([\w.-]+):(.+)$/.exec(left);
  if (labelled) return `${labelled[1]}.aa:${labelled[2]}${spec.slice(eq)}`;
  return `${loadProfile(left).profile.name}.aa:${spec}`;
}

export async function calibrate(opts: CalibrateOptions): Promise<{ dir: string; calibration: Calibration; file: string | null }> {
  const { kind, side, save = true, ...rest } = opts;
  const runs = rest.runs ?? DEFAULT_CALIBRATION_RUNS;
  // A fixed number of rounds: the floor is the interval's width at that many, not a stopping rule.
  const common = { ...rest, runs, maxRuns: runs, ref: side, cands: [twinSpec(side)] };
  opts.log(`calibrating: ${side} against itself, ${runs} rounds (${kind})`);
  const r = kind === "cli-bench" ? await bench(common) : await lspBench(common);
  const records = readFileSync(join(r.dir, "samples.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SampleRecord | SessionRecord | RoundRecord);
  const result =
    r.summary.schema === "parallax.bench-summary/1"
      ? benchComparisons(r.bundle as BenchBundle, r.summary, records)
      : lspComparisons(r.bundle as LspBenchBundle, r.summary, records);
  const { floors, falseCalls, falseCallsExpected, excessFalseCalls } = floorsOf(result.comparisons, result.instructions);
  const ref = r.bundle.sides.find((s) => s.role === "ref")!;
  const calibration: Calibration = {
    schema: CALIBRATION_SCHEMA,
    kind,
    createdAt: new Date().toISOString(),
    host: hostKey(r.bundle.host, r.bundle.settings.pin?.cpus ?? null),
    side: { profile: ref.profile, binSha256: ref.binSha256, version: ref.version },
    project: { name: basename(r.bundle.corpus.root), commit: r.bundle.corpus.gitCommit },
    rounds: { planned: runs, accepted: r.summary.rounds.accepted, rejected: r.summary.rounds.rejected },
    floors,
    falseCalls,
    falseCallsExpected,
    excessFalseCalls,
  };
  writeJsonAtomic(join(r.dir, "calibration.json"), calibration);
  // A calibration whose bench was not measured cleanly (too few rounds, a crash) says nothing reliable.
  const file = save && r.summary.clean ? saveCalibration(calibration) : null;
  if (save && !r.summary.clean) warn(opts.log, "the A/A bench was not measured cleanly; the calibration is in the bundle but not kept for later benches");
  return { dir: r.dir, calibration, file };
}

type Rec = SampleRecord | SessionRecord | RoundRecord;

// Per twin, per accepted round, the reference's and the twin's wall time and CPU; and the instruction
// floor from the counted runs.
function benchComparisons(bundle: BenchBundle, summary: BenchSummary, records: Rec[]): { comparisons: AaComparison[]; instructions: { mode: "default" | "single"; floor: number }[] } {
  const rounds = records.filter((x): x is RoundRecord => x.type === "round");
  const samples = records.filter((x): x is SampleRecord => x.type === "sample" && !x.warmup);
  const { accepted } = acceptRounds(rounds, samples, bundle.sides.length, sampleFailed, bundle.settings.gates);
  const sides = bundle.sides.map((x) => ({ label: x.label, role: x.role, mode: x.mode, base: x.base }));
  const comparisons: AaComparison[] = [];
  const instructions: { mode: "default" | "single"; floor: number }[] = [];
  for (const c of summary.candidates) {
    const ref = refFor(sides, { mode: c.mode }).label;
    const pair = (f: (s: SampleRecord) => number | null) => accepted.map((ss) => [f(ss.find((s) => s.side === ref)!), f(ss.find((s) => s.side === c.label)!)] as [number | null, number | null]);
    comparisons.push({
      mode: c.mode,
      metrics: [
        { metric: "wallMs", ms: true, pairs: pair((s) => s.wallMs), call: c.call, coverage: c.wallRatio?.confidence ?? null },
        { metric: "cpuMs", ms: true, pairs: pair((s) => s.cpuMs), call: null, coverage: null },
      ],
    });
    const counted = summary.counters?.sides ?? [];
    const a = counted.find((x) => x.label === ref)?.instructions;
    const b = counted.find((x) => x.label === c.label)?.instructions;
    if (a && b && a.median > 0) instructions.push({ mode: c.mode, floor: Math.max(Math.abs(b.median / a.median - 1), a.spread / 2, b.spread / 2) });
  }
  return { comparisons, instructions };
}

// Per twin, per accepted round, each compared metric of the reference's and the twin's session.
function lspComparisons(bundle: LspBenchBundle, summary: LspBenchSummary, records: Rec[]): { comparisons: AaComparison[]; instructions: [] } {
  const rounds = records.filter((x): x is RoundRecord => x.type === "round");
  const sessions = records.filter((x): x is SessionRecord => x.type === "session" && !x.warmup);
  const { accepted } = acceptRounds(rounds, sessions, bundle.sides.length, sessionFailed, bundle.settings.gates);
  const sides = bundle.sides.map((x) => ({ label: x.label, role: x.role, mode: x.mode, base: x.base }));
  const comparisons = summary.candidates.map((c): AaComparison => {
    const ref = refFor(sides, { mode: c.mode }).label;
    return {
      mode: c.mode,
      metrics: METRICS.filter((m) => m.compare !== false && c.metrics[m.key]).map((m) => ({
        metric: m.key,
        ms: m.unit === "ms",
        pairs: accepted.map((ss) => [ss.find((s) => s.side === ref)!.metrics[m.key] ?? null, ss.find((s) => s.side === c.label)!.metrics[m.key] ?? null] as [number | null, number | null]),
        call: c.metrics[m.key]?.call ?? null,
        coverage: c.metrics[m.key]?.ratio?.confidence ?? null,
      })),
    };
  });
  return { comparisons, instructions: [] };
}
