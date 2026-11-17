// Child-process accounting: the CPU (user, system) and peak memory of a measured command, including
// worker processes it waits for. Node exposes none of this for children, so it comes from a
// `time` program that waits for the command and writes its resource usage to a file:
//
//   gnu-time  GNU time (`/usr/bin/time -f ... -o <file>`), common on Linux
//   bsd-time  BSD time (`/usr/bin/time -l -o <file>`), built into macOS and the BSDs
//   none      neither works (Windows, minimal containers): wall time and machine load only
//
// The backend is chosen by running it on a trivial command and parsing the report, so a `time` that
// prints another format is never trusted. Resolution is 10 ms of CPU; peak memory is the largest
// single process's (getrusage ru_maxrss), not the sum over a launcher and its worker.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AccountingKind = "gnu-time" | "bsd-time" | "none";

export interface ChildUsage {
  userMs: number;
  sysMs: number;
  maxRssBytes: number;
}

export interface Accounting {
  kind: AccountingKind;
  // The command line that runs `command` and writes its usage to reportFile.
  wrap(command: string[], reportFile: string): string[];
  parse(report: string): ChildUsage | null;
}

const TIME = "/usr/bin/time";
const GNU_FORMAT = "parallax-usage %U %S %M";

const gnu: Accounting = {
  kind: "gnu-time",
  wrap: (command, reportFile) => [TIME, "-f", GNU_FORMAT, "-o", reportFile, "--", ...command],
  parse(report) {
    // GNU time writes "Command exited with non-zero status N" (or "Command terminated by signal")
    // before the format line when the command fails.
    const m = /^parallax-usage (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+)$/m.exec(report);
    return m ? { userMs: Number(m[1]) * 1000, sysMs: Number(m[2]) * 1000, maxRssBytes: Number(m[3]) * 1024 } : null;
  },
};

const bsd: Accounting = {
  kind: "bsd-time",
  wrap: (command, reportFile) => [TIME, "-l", "-o", reportFile, "--", ...command],
  parse(report) {
    // "        0.01 real         0.00 user         0.00 sys" then "  1234567  maximum resident set size"
    const t = /([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(report);
    const rss = /^\s*(\d+)\s+maximum resident set size/m.exec(report);
    return t && rss ? { userMs: Number(t[2]) * 1000, sysMs: Number(t[3]) * 1000, maxRssBytes: Number(rss[1]) } : null;
  },
};

const none: Accounting = { kind: "none", wrap: (command) => command, parse: () => null };

function works(a: Accounting): boolean {
  const dir = mkdtempSync(join(tmpdir(), "parallax-acct-"));
  try {
    const report = join(dir, "usage");
    const [cmd, ...args] = a.wrap([process.execPath, "-e", "0"], report);
    const r = spawnSync(cmd!, args, { stdio: "ignore", timeout: 15000 });
    if (r.status !== 0 || !existsSync(report)) return false;
    const u = a.parse(readFileSync(report, "utf8"));
    return u !== null && u.maxRssBytes > 0;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let detected: Accounting | undefined;

// The first backend that works on this machine. PARALLAX_ACCOUNTING=none|gnu-time|bsd-time forces one.
export function detectAccounting(): Accounting {
  if (detected) return detected;
  const forced = process.env.PARALLAX_ACCOUNTING;
  const all = [gnu, bsd, none];
  if (forced) {
    const a = all.find((x) => x.kind === forced);
    if (!a) throw new Error(`PARALLAX_ACCOUNTING=${forced}: want one of ${all.map((x) => x.kind).join(", ")}`);
    if (a !== none && !works(a)) throw new Error(`PARALLAX_ACCOUNTING=${forced} does not work on this machine`);
    return (detected = a);
  }
  detected = !existsSync(TIME) ? none : works(gnu) ? gnu : works(bsd) ? bsd : none;
  return detected;
}
