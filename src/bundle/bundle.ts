// Evidence bundles: one directory per run of the harness. bundle.json describes everything needed to
// trust or re-render the results (binaries by hash, profiles, corpus commit, host state, session
// definition, normalization rules, every server run and how it ended); runs/ holds the raw answers as
// JSON lines; verdicts.jsonl, summary.json and differences/ are derived from runs/ by `compare` and
// can be recomputed at any time.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus, hostname, loadavg, platform, release, arch, totalmem, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { machineState, type MachineState } from "../host/machineState.ts";
import type { Role, Side, ThreadMode } from "../profile/profile.ts";

export const BUNDLE_SCHEMA = "parallax.bundle/1";

export interface SideRecord {
  label: string;
  role: Role;
  profile: string;
  profilePath: string;
  profileSha256: string;
  bin: string;
  binReal: string;
  binSha256: string;
  version: string | null;
  lspCommand: string[];
  env: { cleared: string[]; set: Record<string, string> };
  lib: { uriPrefix?: string; dir?: string } | null;
  processModel: string;
  knownGaps: string[];
  // Thread mode ("default" when absent: bundles from before modes existed) and the label without it.
  mode?: ThreadMode;
  base?: string;
}

export type Outcome = "clean" | "crash" | "timeout" | "error" | "imported";

export interface RunRecord {
  id: string;
  side: string;
  role: Role;
  // 1-based repeat of this side.
  n: number;
  file: string;
  stderrFile: string | null;
  startedAt: string | null;
  durationMs: number | null;
  outcome: Outcome | null;
  error?: string;
  answers?: number;
  exit?: { code: number | null; signal: string | null } | null;
  shutdownClean?: boolean;
  crashSignals?: string[];
  loadBefore?: number[];
  loadAfter?: number[];
  importedFrom?: string;
}

export interface Bundle {
  schema: typeof BUNDLE_SCHEMA;
  kind: "lsp-answer-diff";
  status: "running" | "complete" | "failed";
  createdAt: string;
  finishedAt: string | null;
  harness: { name: "parallax"; version: string; gitCommit: string | null; gitDirty: boolean | null; node: string };
  host: HostInfo;
  corpus: CorpusInfo;
  session: { script: string; files: string[]; positions: number; typed: string; initializeSha256: string; requestTimeoutMs: number | null };
  normalization: { version: string; rules: readonly string[] };
  sides: SideRecord[];
  runs: RunRecord[];
  notes: string[];
}

export interface HostInfo {
  hostname: string;
  platform: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpus: number;
  memTotalBytes: number;
  uptimeS: number;
  loadBefore: number[];
  loadAfter: number[] | null;
  // Power and CPU-frequency state at the start (host/machineState.ts).
  state: MachineState;
}

export interface CorpusInfo {
  root: string;
  gitCommit: string | null;
  // `git status --porcelain` lines (first 200) and the hash of the whole output, before and after.
  gitStatus: string[] | null;
  statusSha256Before: string | null;
  statusSha256After: string | null;
  changedDuringRun: boolean | null;
}

const git = (cwd: string, args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
};

export function corpusState(root: string): { commit: string | null; status: string | null } {
  const commit = git(root, ["rev-parse", "HEAD"])?.trim() ?? null;
  const status = commit ? git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) : null;
  return { commit, status };
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function corpusInfo(root: string): CorpusInfo {
  const { commit, status } = corpusState(root);
  return {
    root,
    gitCommit: commit,
    gitStatus: status === null ? null : status.split("\n").filter(Boolean).slice(0, 200),
    statusSha256Before: status === null ? null : sha256(status),
    statusSha256After: null,
    changedDuringRun: null,
  };
}

export function hostInfo(): HostInfo {
  return {
    hostname: hostname(),
    platform: platform(),
    kernel: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpus: cpus().length,
    memTotalBytes: totalmem(),
    uptimeS: Math.round(uptime()),
    loadBefore: loadavg(),
    loadAfter: null,
    state: machineState(),
  };
}

const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function harnessInfo(): Bundle["harness"] {
  const pkg = JSON.parse(readFileSync(join(HARNESS_ROOT, "package.json"), "utf8")) as { version: string };
  const commit = git(HARNESS_ROOT, ["rev-parse", "HEAD"])?.trim() ?? null;
  const dirty = commit ? (git(HARNESS_ROOT, ["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "" : null;
  return { name: "parallax", version: pkg.version, gitCommit: commit, gitDirty: dirty, node: process.version };
}

export function sideRecord(s: Side): SideRecord {
  return {
    label: s.label,
    role: s.role,
    profile: s.profile.name,
    profilePath: s.profilePath,
    profileSha256: s.profileSha256,
    bin: s.bin,
    binReal: s.binReal,
    binSha256: s.binSha256,
    version: s.version,
    lspCommand: s.lspCommand,
    env: { cleared: s.env.cleared, set: s.env.set },
    lib: s.lib ?? null,
    processModel: s.profile.processModel ?? "single",
    knownGaps: s.profile.knownGaps ?? [],
    mode: s.mode,
    base: s.base,
  };
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readBundle(dir: string): Bundle {
  const b = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")) as Bundle;
  if (b.schema !== BUNDLE_SCHEMA) throw new Error(`${dir}: not a ${BUNDLE_SCHEMA} bundle (schema ${JSON.stringify(b.schema)})`);
  if (b.kind !== "lsp-answer-diff") throw new Error(`${dir}: unsupported bundle kind ${JSON.stringify(b.kind)}`);
  return b;
}
