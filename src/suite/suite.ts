// The benchmark suite (suite.json at the repository root): the projects everyone benches, each pinned
// to a commit and installed the same way, so results from different machines compare.
//
// A project is fetched into the suite cache (PARALLAX_SUITE_DIR, else the OS's cache directory) as a
// shallow clone of exactly its commit, then installed with its own package manager, install scripts
// skipped. The fetch is recorded inside .git, so the working tree stays as the commit has it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SUITE_SCHEMA = "parallax.suite/1";
export const SUITE_FILE = join(dirname(fileURLToPath(import.meta.url)), "../../suite.json");

export interface SuiteProject {
  name: string;
  repository: string;
  commit: string;
  // The install command, run in the project's directory.
  install: string[];
  // Present when the project is benched on the CLI, with the tsconfig to check.
  bench?: { config: string };
  // Present when the project's language server is benched; `file` fixes the files (the first is
  // edited), else they are picked as lsp-bench picks them.
  lspBench?: { file?: string[]; files?: number };
}

export interface Suite {
  schema: typeof SUITE_SCHEMA;
  description?: string;
  projects: SuiteProject[];
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function validateSuite(value: unknown, where: string): Suite {
  const fail = (msg: string): never => {
    throw new Error(`suite ${where}: ${msg}`);
  };
  const s = value as Record<string, unknown>;
  if (!s || s.schema !== SUITE_SCHEMA) fail(`schema must be ${JSON.stringify(SUITE_SCHEMA)}`);
  if (!Array.isArray(s.projects) || !s.projects.length) fail("projects must be a non-empty array");
  const names = new Set<string>();
  for (const p of s.projects as Record<string, unknown>[]) {
    const at = `project ${JSON.stringify(p?.name)}`;
    if (typeof p.name !== "string" || !/^[\w.-]+$/.test(p.name)) fail(`${at}: name must be a word ([A-Za-z0-9_.-])`);
    if (names.has(p.name as string)) fail(`${at}: duplicate name`);
    names.add(p.name as string);
    if (typeof p.repository !== "string" || !/^https:\/\//.test(p.repository)) fail(`${at}: repository must be an https URL`);
    if (typeof p.commit !== "string" || !/^[0-9a-f]{40}$/.test(p.commit)) fail(`${at}: commit must be a full 40-character hash`);
    if (!isStrings(p.install) || !p.install.length) fail(`${at}: install must be a non-empty string array`);
    const bench = p.bench as Record<string, unknown> | undefined;
    if (bench !== undefined && typeof bench.config !== "string") fail(`${at}: bench.config must be a string`);
    const lsp = p.lspBench as Record<string, unknown> | undefined;
    if (lsp !== undefined && lsp.file !== undefined && !isStrings(lsp.file)) fail(`${at}: lspBench.file must be a string array`);
    if (!bench && !lsp) fail(`${at}: needs bench, lspBench or both`);
  }
  return value as Suite;
}

export function loadSuite(path = SUITE_FILE): Suite {
  return validateSuite(JSON.parse(readFileSync(path, "utf8")), path);
}

// The projects named, in suite order; all of them when none are named.
export function selectProjects(suite: Suite, names: string[]): SuiteProject[] {
  for (const n of names) if (!suite.projects.some((p) => p.name === n)) throw new Error(`no project ${JSON.stringify(n)} in the suite (${suite.projects.map((p) => p.name).join(", ")})`);
  return names.length ? suite.projects.filter((p) => names.includes(p.name)) : suite.projects;
}

export function suiteCacheDir(): string {
  if (process.env.PARALLAX_SUITE_DIR) return process.env.PARALLAX_SUITE_DIR;
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "parallax", "suite");
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "parallax", "suite");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "parallax", "suite");
}

interface FetchMarker {
  repository: string;
  commit: string;
  install: string[];
  installedAt: string;
}

const run = (cmd: string, args: string[], cwd: string, log: (msg: string) => void): void => {
  log(`$ ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"], shell: platform() === "win32" });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${[cmd, ...args].join(" ")} exited ${r.status ?? r.signal}`);
};

// The project's directory, fetched at its commit and installed (again only when the suite entry
// changed or the last fetch did not finish).
export function fetchProject(p: SuiteProject, log: (msg: string) => void, cache = suiteCacheDir()): string {
  const dir = join(cache, p.name);
  const markerFile = join(dir, ".git", "parallax-suite.json");
  if (existsSync(markerFile)) {
    const m = JSON.parse(readFileSync(markerFile, "utf8")) as FetchMarker;
    if (m.repository === p.repository && m.commit === p.commit && JSON.stringify(m.install) === JSON.stringify(p.install)) return dir;
  }
  log(`fetching ${p.name} at ${p.commit.slice(0, 12)} into ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  run("git", ["init", "-q"], dir, log);
  run("git", ["remote", "add", "origin", p.repository], dir, log);
  run("git", ["fetch", "-q", "--depth", "1", "origin", p.commit], dir, log);
  run("git", ["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD"], dir, log);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  if (head !== p.commit) throw new Error(`${p.name}: fetched ${head}, expected ${p.commit}`);
  const [cmd, ...args] = p.install;
  run(cmd!, args, dir, log);
  const marker: FetchMarker = { repository: p.repository, commit: p.commit, install: p.install, installedAt: new Date().toISOString() };
  writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
  return dir;
}

// The suite project a bundle's corpus is, by repository and commit; null when it is none of them.
export function suiteProjectFor(suite: Suite, corpus: { repository?: string | null; gitCommit: string | null }): SuiteProject | null {
  const norm = (u: string): string => u.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  // A full commit hash identifies the project on its own; a recorded remote must agree with it.
  return suite.projects.find((p) => corpus.gitCommit === p.commit && (!corpus.repository || norm(corpus.repository) === norm(p.repository))) ?? null;
}
