// CI smoke run: `bench` and `lsp-bench` of tsc 7 against itself on this repo, with the OS's own
// accounting. Checks that each OS gets the backends it should and that they fill in CPU and memory.
// It does not judge speed: CI runners are shared, so the idle wait and gates are opened wide.
//
//   node scripts/ci-smoke.ts [out-dir]      (default out/ci; must not exist or be empty)

import { globSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "out/ci");
const exe = process.platform === "win32" ? ".exe" : "";
const tsc = globSync(`node_modules/.pnpm/@typescript+typescript-*/node_modules/@typescript/*/lib/tsc${exe}`)[0];
if (!tsc) throw new Error("no native tsc 7 binary under node_modules/.pnpm (run pnpm install)");

// What each OS should detect (src/host/accounting.ts, src/host/serverUsage.ts).
const expected: Record<string, { accounting: string; usage: string }> = {
  linux: { accounting: "gnu-time+proc", usage: "proc" },
  darwin: { accounting: "bsd-time", usage: "ps" },
  win32: { accounting: "none", usage: "none" },
};
const want = expected[process.platform];
if (!want) throw new Error(`no expectations for ${process.platform}`);

const open = ["--max-busy-cores", "1000", "--boot-settle-s", "0", "--max-outside-cores", "1000", "--max-canary-drift", "100"];
const sides = ["--ref", `tsc7=${tsc}`, "--cand", `again:tsc7=${tsc}`];
const problems: string[] = [];

function parallax(name: string, args: string[], which = sides): string {
  const dir = join(out, name);
  console.log(`\n== parallax ${args[0]} -> ${dir}`);
  const r = spawnSync(process.execPath, ["src/cli.ts", ...args, "--project", ".", ...which, ...open, "--out", dir], { stdio: "inherit" });
  if (r.status !== 0) problems.push(`${args[0]} exited ${r.status ?? r.signal}`);
  return dir;
}
const json = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));

const bench = parallax("bench", ["bench", "--config", "tsconfig.json", "--runs", "3", "--max-runs", "3", "--min-runs", "3"]);
const lsp = parallax("lsp-bench", [
  "lsp-bench",
  ...["--files", "3", "--edits", "5", "--lines", "1", "--paused-lines", "1", "--pause-ms", "20", "--errfixes", "2", "--imports", "2", "--long-edits", "12"],
  ...["--runs", "3", "--max-runs", "3", "--min-runs", "3"],
]);
// An A/A calibration, not kept (a CI runner's noise says nothing about the next one).
const cal = parallax("calibrate", ["calibrate", "--kind", "bench", "--config", "tsconfig.json", "--runs", "3", "--min-runs", "3", "--no-save"], ["--side", `tsc7=${tsc}`]);

const b = json(bench, "summary.json");
if (b.accounting !== want.accounting) problems.push(`bench accounting ${b.accounting}, want ${want.accounting}`);
for (const s of b.sides) {
  const filled = s.cpuMs !== null && s.maxRssBytes !== null;
  if (want.accounting !== "none" && !filled) problems.push(`bench ${s.label}: CPU or peak memory blank`);
}

const l = json(lsp, "summary.json");
if (l.usage !== want.usage) problems.push(`lsp-bench server usage ${l.usage}, want ${want.usage}`);
for (const s of l.sides) {
  const filled = s.metrics["open.cpuMs"] != null && s.metrics["session.memoryBytes"] != null;
  if (want.usage !== "none" && !filled) problems.push(`lsp-bench ${s.label}: server CPU or memory blank`);
}

// Every side ran in a sealed environment.
for (const dir of [bench, lsp]) for (const s of json(dir, "bundle.json").sides) if (s.env.mode !== "sealed") problems.push(`${dir}: ${s.label} environment ${s.env.mode}`);
const c = json(cal, "calibration.json");
if (!c.floors.some((f: { metric: string }) => f.metric === "wallMs")) problems.push("calibration has no wall-time floor");
const errfix = l.sides.every((s: { metrics: Record<string, unknown> }) => s.metrics["errfix.errorDiagnosticsMs"] != null);
if (!errfix) problems.push("lsp-bench: errfix phase left blank");

console.log(`\n${process.platform}: accounting ${b.accounting}, server usage ${l.usage} (${l.memory ?? "no"} memory)`);
if (problems.length) {
  console.error(`smoke run failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("smoke run ok");
