// Server profiles: everything specific to one compiler / language server, as data. The harness reads
// a profile and never branches on a product name. A profile names no binary path; a side binds a
// profile to a binary at run time (`--ref tsc7=<bin>`).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROFILE_SCHEMA = "parallax.profile/1";

export interface Profile {
  schema: typeof PROFILE_SCHEMA;
  name: string;
  description?: string;
  lsp: { command: string[] };
  check?: { command: string[] };
  version?: { command: string[] };
  env?: { clear?: string[]; set?: Record<string, string> };
  processModel?: "single" | "launcher+worker";
  // Where the server's bundled library files (lib.*.d.ts) live in its answers. Both sides' forms map to
  // `<lib>/<file>` before comparing; an answer equal only after that mapping is verdict `normalized`.
  libraryFiles?: { uriPrefix?: string; dir?: string };
  crash?: { exitCodes?: number[]; stderr?: string[] };
  // Exit codes of an orderly shutdown + exit (default [0]; tsc 7 exits 1 with "context canceled").
  shutdown?: { exitCodes?: number[] };
  knownGaps?: string[];
}

export const BUILTIN_PROFILE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../profiles");

function fail(where: string, msg: string): never {
  throw new Error(`profile ${where}: ${msg}`);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function validateProfile(value: unknown, where: string): Profile {
  if (!value || typeof value !== "object") fail(where, "not an object");
  const p = value as Record<string, unknown>;
  if (p.schema !== PROFILE_SCHEMA) fail(where, `schema must be ${JSON.stringify(PROFILE_SCHEMA)}`);
  if (typeof p.name !== "string" || !/^[\w.-]+$/.test(p.name)) fail(where, "name must be a word ([A-Za-z0-9_.-])");
  const lsp = p.lsp as Record<string, unknown> | undefined;
  if (!lsp || !isStringArray(lsp.command) || !lsp.command.length) fail(where, "lsp.command must be a non-empty string array");
  for (const k of ["check", "version"] as const) {
    const c = p[k] as Record<string, unknown> | undefined;
    if (c !== undefined && (!isStringArray(c.command) || !c.command.length)) fail(where, `${k}.command must be a non-empty string array`);
  }
  const env = p.env as Record<string, unknown> | undefined;
  if (env !== undefined) {
    if (env.clear !== undefined && !isStringArray(env.clear)) fail(where, "env.clear must be a string array");
    if (env.set !== undefined && (typeof env.set !== "object" || !Object.values(env.set as object).every((v) => typeof v === "string")))
      fail(where, "env.set must map names to strings");
  }
  if (p.processModel !== undefined && p.processModel !== "single" && p.processModel !== "launcher+worker")
    fail(where, 'processModel must be "single" or "launcher+worker"');
  const lib = p.libraryFiles as Record<string, unknown> | undefined;
  if (lib !== undefined) {
    if (lib.uriPrefix !== undefined && typeof lib.uriPrefix !== "string") fail(where, "libraryFiles.uriPrefix must be a string");
    if (lib.dir !== undefined && typeof lib.dir !== "string") fail(where, "libraryFiles.dir must be a string");
    if ((lib.uriPrefix === undefined) === (lib.dir === undefined)) fail(where, "libraryFiles needs exactly one of uriPrefix, dir");
  }
  const crash = p.crash as Record<string, unknown> | undefined;
  if (crash !== undefined) {
    if (crash.exitCodes !== undefined && !(Array.isArray(crash.exitCodes) && crash.exitCodes.every(Number.isInteger)))
      fail(where, "crash.exitCodes must be integers");
    if (crash.stderr !== undefined) {
      if (!isStringArray(crash.stderr)) fail(where, "crash.stderr must be a string array (regular expressions)");
      for (const re of crash.stderr) new RegExp(re, "m");
    }
  }
  const shutdown = p.shutdown as Record<string, unknown> | undefined;
  if (shutdown?.exitCodes !== undefined && !(Array.isArray(shutdown.exitCodes) && shutdown.exitCodes.every(Number.isInteger)))
    fail(where, "shutdown.exitCodes must be integers");
  if (p.knownGaps !== undefined && !isStringArray(p.knownGaps)) fail(where, "knownGaps must be a string array");
  return p as unknown as Profile;
}

// A profile by built-in name (profiles/<name>.json) or by path.
export function loadProfile(nameOrPath: string): { profile: Profile; path: string } {
  const path =
    nameOrPath.endsWith(".json") || nameOrPath.includes("/") ? resolve(nameOrPath) : join(BUILTIN_PROFILE_DIR, `${nameOrPath}.json`);
  if (!existsSync(path)) throw new Error(`no profile ${JSON.stringify(nameOrPath)} (looked for ${path})`);
  return { profile: validateProfile(JSON.parse(readFileSync(path, "utf8")), path), path };
}

export interface Vars {
  bin: string;
  binDir: string;
  [k: string]: string;
}

export function expand(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`unknown placeholder ${m} in ${JSON.stringify(template)}`);
    return v;
  });
}

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

export interface ResolvedEnv {
  env: NodeJS.ProcessEnv;
  // Names removed because a clear pattern matched them (values are never recorded).
  cleared: string[];
  // Names set by the profile or the side (values recorded: they are configuration).
  set: Record<string, string>;
}

export function resolveEnv(profile: Profile, base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): ResolvedEnv {
  const env = { ...base };
  const patterns = (profile.env?.clear ?? []).map(globToRegExp);
  const cleared = Object.keys(env)
    .filter((k) => patterns.some((re) => re.test(k)))
    .sort();
  for (const k of cleared) delete env[k];
  const set = { ...(profile.env?.set ?? {}), ...extra };
  Object.assign(env, set);
  return { env, cleared, set };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type Role = "ref" | "cand";

export interface Side {
  label: string;
  role: Role;
  profile: Profile;
  profilePath: string;
  profileSha256: string;
  bin: string;
  binReal: string;
  binSha256: string;
  version: string | null;
  vars: Vars;
  lspCommand: string[];
  env: ResolvedEnv;
  lib: { uriPrefix?: string; dir?: string } | undefined;
}

// Binds `profile=bin` (or `label:profile=bin`) into a side. The label defaults to the profile name.
export async function bindSide(spec: string, role: Role, extraEnv: Record<string, string> = {}): Promise<Side> {
  const eq = spec.indexOf("=");
  if (eq < 1) throw new Error(`side ${JSON.stringify(spec)}: want <profile>=<binary> or <label>:<profile>=<binary>`);
  const left = spec.slice(0, eq);
  const colon = left.indexOf(":");
  const [label, profileName] = colon >= 0 ? [left.slice(0, colon), left.slice(colon + 1)] : [undefined, left];
  const { profile, path: profilePath } = loadProfile(profileName);
  const bin = resolve(spec.slice(eq + 1));
  if (!existsSync(bin)) throw new Error(`side ${JSON.stringify(spec)}: no binary at ${bin}`);
  const binReal = realpathSync(bin);
  const vars: Vars = { bin: isAbsolute(bin) ? bin : resolve(bin), binDir: dirname(binReal) };
  const env = resolveEnv(profile, process.env, extraEnv);
  const version = probeVersion(profile, vars, env.env);
  const lib = profile.libraryFiles && {
    ...(profile.libraryFiles.uriPrefix !== undefined ? { uriPrefix: expand(profile.libraryFiles.uriPrefix, vars) } : {}),
    ...(profile.libraryFiles.dir !== undefined ? { dir: expand(profile.libraryFiles.dir, vars) } : {}),
  };
  return {
    label: label ?? profile.name,
    role,
    profile,
    profilePath,
    profileSha256: createHash("sha256").update(readFileSync(profilePath)).digest("hex"),
    bin,
    binReal,
    binSha256: await sha256File(binReal),
    version,
    vars,
    lspCommand: profile.lsp.command.map((t) => expand(t, vars)),
    env,
    lib,
  };
}

function probeVersion(profile: Profile, vars: Vars, env: NodeJS.ProcessEnv): string | null {
  if (!profile.version) return null;
  const [cmd, ...args] = profile.version.command.map((t) => expand(t, vars));
  const r = spawnSync(cmd!, args, { env, encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) return null;
  return (r.stdout || r.stderr).trim().slice(0, 500) || null;
}

// The crash signature lines found in a server's stderr text, per the profile.
export function crashSignals(profile: Profile, exitCode: number | null, stderrTail: string): string[] {
  const found: string[] = [];
  if (exitCode !== null && profile.crash?.exitCodes?.includes(exitCode)) found.push(`exit code ${exitCode}`);
  for (const re of profile.crash?.stderr ?? []) {
    const m = new RegExp(re, "m").exec(stderrTail);
    if (m) found.push(`stderr: ${m[0].slice(0, 200)}`);
  }
  return found;
}
