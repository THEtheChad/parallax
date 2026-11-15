// One timed run of a command: wall time from spawn to exit (and to the last output byte), the
// command's own CPU and peak memory where the OS can account for them, machine CPU over the run, and
// hashes of what it printed. The command runs in its own process group so a timeout stops a launcher
// and its workers together.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAccounting, type ChildUsage } from "../host/accounting.ts";
import { cpuSnapshot, cpuWindow, outsideCores, type CpuWindow } from "../host/machine.ts";
import { GroupTracker, groupTrackingAvailable, type GroupUsage } from "../host/procGroup.ts";

export interface CommandRun {
  startedAt: string;
  // Spawn to process exit, and spawn to the end of its output.
  wallMs: number;
  drainMs: number;
  exit: { code: number | null; signal: string | null };
  timedOut: boolean;
  stdoutSha256: string;
  stderrSha256: string;
  outputLines: number;
  // From `time`: the top process and every descendant it (transitively) waited for.
  usage: ChildUsage | null;
  // Linux: processes in the group nobody waited for (a launcher's worker), from /proc.
  group: GroupUsage | null;
  // usage + group: the command's whole CPU and largest process, or null when unknown.
  cpuMs: number | null;
  maxRssBytes: number | null;
  window: CpuWindow;
  outsideCores: number | null;
  // The end of stderr, for crash signatures (not stored in records; the whole stderr is in outputs/).
  stderrTail: string;
}

export interface RunCommandOptions {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  // Where to keep each distinct output once, as <dir>/<sha256>.txt.
  outputsDir?: string;
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export async function runCommand(opts: RunCommandOptions): Promise<CommandRun> {
  const accounting = detectAccounting();
  const scratch = mkdtempSync(join(tmpdir(), "parallax-run-"));
  const report = join(scratch, "usage");
  const [cmd, ...args] = accounting.wrap(opts.command, report);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const startedAt = new Date().toISOString();
  const before = cpuSnapshot();
  const t0 = performance.now();
  const child = spawn(cmd!, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", (b: Buffer) => out.push(b));
  child.stderr.on("data", (b: Buffer) => err.push(b));
  const tracker = groupTrackingAvailable() ? new GroupTracker(child.pid!) : null;
  let group: GroupUsage | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }, opts.timeoutMs);
  let wallMs = 0;
  let after = before;
  const exit: CommandRun["exit"] = await new Promise<CommandRun["exit"]>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      wallMs = performance.now() - t0;
      group = tracker?.finish() ?? null;
      after = cpuSnapshot();
      resolve({ code, signal });
    });
  });
  await new Promise<void>((resolve) => (child.stdout.closed && child.stderr.closed ? resolve() : child.once("close", () => resolve())));
  const drainMs = performance.now() - t0;
  clearTimeout(timer);
  // Leftover workers (a launcher that exited without waiting) must not overlap the next run.
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    // none left
  }
  const reportText = existsSync(report) ? readFileSync(report, "utf8") : "";
  const usage = reportText ? accounting.parse(reportText) : null;
  // Through `time`, a command killed by a signal shows up as time's own exit status.
  const killed = /Command terminated by signal (\d+)/.exec(reportText);
  if (killed && exit.signal === null) exit.signal = `signal ${killed[1]}`;
  rmSync(scratch, { recursive: true, force: true });
  const stdout = Buffer.concat(out);
  const stderr = Buffer.concat(err);
  const stdoutSha256 = sha(stdout);
  const stderrSha256 = sha(stderr);
  if (opts.outputsDir) {
    for (const [hash, body] of [[stdoutSha256, stdout], [stderrSha256, stderr]] as const) {
      const file = join(opts.outputsDir, `${hash}.txt`);
      if (!existsSync(file)) writeFileSync(file, body);
    }
  }
  const window = cpuWindow(before, after);
  const g = group as GroupUsage | null;
  const cpuMs = usage ? usage.userMs + usage.sysMs + (g?.adoptedCpuMs ?? 0) : null;
  const maxRssBytes = usage ? Math.max(usage.maxRssBytes, g?.maxHwmBytes ?? 0) : null;
  return {
    startedAt,
    wallMs,
    drainMs,
    exit,
    timedOut,
    stdoutSha256,
    stderrSha256,
    outputLines: stdout.length ? stdout.toString("utf8").split("\n").filter(Boolean).length : 0,
    usage,
    group: g,
    cpuMs,
    maxRssBytes,
    window,
    outsideCores: outsideCores(window, cpuMs),
    stderrTail: stderr.subarray(Math.max(0, stderr.length - (1 << 16))).toString("utf8"),
  };
}
