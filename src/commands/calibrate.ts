// `parallax calibrate`: an A/A bench. One side is benched against itself (the same profile and binary
// under a second label, "<label>.aa"), for a fixed number of rounds, with `bench` or `lsp-bench`. Any
// difference found is this machine's noise; timing/calibration.ts turns it into a noise floor per
// metric and keeps the latest one per kind in the config directory, where later benches on the same
// host setup find it.

import { basename, join } from "node:path";
import { writeJsonAtomic } from "../bundle/bundle.ts";
import { loadProfile } from "../profile/profile.ts";
import {
  benchFloors,
  CALIBRATION_SCHEMA,
  hostKey,
  lspFloors,
  saveCalibration,
  type Calibration,
  type CalibrationKind,
} from "../timing/calibration.ts";
import { bench, type BenchOptions } from "./bench.ts";
import { lspBench, type LspBenchOptions } from "./lspBench.ts";

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
  if (eq < 1) throw new Error(`side ${JSON.stringify(spec)}: want <profile>=<binary> or <label>:<profile>=<binary>`);
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
  const { floors, falseCalls } = r.summary.schema === "parallax.bench-summary/1" ? benchFloors(r.summary) : lspFloors(r.summary);
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
  };
  writeJsonAtomic(join(r.dir, "calibration.json"), calibration);
  // A calibration whose bench was not measured cleanly (too few rounds, a crash) says nothing reliable.
  const file = save && r.summary.clean ? saveCalibration(calibration) : null;
  if (save && !r.summary.clean) opts.log("warning: the A/A bench was not measured cleanly; the calibration is in the bundle but not kept for later benches");
  return { dir: r.dir, calibration, file };
}
