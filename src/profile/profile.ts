// Server profiles: everything specific to one compiler / language server, as data. The harness reads
// a profile and never branches on a product name. A profile names no binary path; a side binds a
// profile to a binary at run time (`--ref tsc7=<bin>`).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseEnv, DEFAULT_ENV_POLICY, type BaseEnv, type EnvMode, type EnvPolicy } from "../host/sealedEnv.ts";
import { InputError, readJsonFile } from "../errors.ts";

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
  // How to run the server single-threaded: arguments appended to the command and environment
  // variables set (after `env.clear`), separately for the CLI check and the language server.
  singleThreaded?: { check?: ThreadSetting; lsp?: ThreadSetting };
}

export interface ThreadSetting {
  args?: string[];
  env?: Record<string, string>;
}

// "default": however the implementation chooses to use the machine's cores. "single": one thread of
// work, as the profile's `singleThreaded` says, which separates the algorithm's cost from how well it
// uses cores and is far less noisy.
export type ThreadMode = "default" | "single";
export const THREAD_MODES: readonly ThreadMode[] = ["default", "single"];
// Label suffix of a side's single-threaded variant ("tsrs@1t").
export const SINGLE_SUFFIX = "@1t";

export const BUILTIN_PROFILE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../profiles");

function fail(where: string, msg: string): never {
  throw new InputError(`profile ${where}: ${msg}`);
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
  const single = p.singleThreaded as Record<string, unknown> | undefined;
  if (single !== undefined) {
    if (typeof single !== "object") fail(where, "singleThreaded must be an object");
    for (const k of ["check", "lsp"] as const) {
      const t = single[k] as Record<string, unknown> | undefined;
      if (t === undefined) continue;
      if (t.args !== undefined && !isStringArray(t.args)) fail(where, `singleThreaded.${k}.args must be a string array`);
      if (t.env !== undefined && (typeof t.env !== "object" || !Object.values(t.env as object).every((v) => typeof v === "string")))
        fail(where, `singleThreaded.${k}.env must map names to strings`);
    }
  }
  return p as unknown as Profile;
}

// The built-in profiles' names (profiles/<name>.json).
export function builtinProfiles(): string[] {
  try {
    return readdirSync(BUILTIN_PROFILE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

// A profile by built-in name (profiles/<name>.json) or by path.
export function loadProfile(nameOrPath: string): { profile: Profile; path: string } {
  const byPath = nameOrPath.endsWith(".json") || /[\\/]/.test(nameOrPath) || isAbsolute(nameOrPath);
  const path = byPath ? resolve(nameOrPath) : join(BUILTIN_PROFILE_DIR, `${nameOrPath}.json`);
  if (!existsSync(path)) {
    // A name rather than a path: the likely mistake is the name, so say which ones there are.
    const known = byPath ? [] : builtinProfiles();
    throw new InputError(`no profile ${JSON.stringify(nameOrPath)} (looked for ${path})${known.length ? `; the profiles are ${known.join(", ")}, or give a profile's path` : ""}`);
  }
  return { profile: validateProfile(readJsonFile(path), path), path };
}

export interface Vars {
  bin: string;
  binDir: string;
  [k: string]: string;
}

export function expand(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new InputError(`unknown placeholder ${m} in ${JSON.stringify(template)}`);
    return v;
  });
}

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

export interface ResolvedEnv {
  env: NodeJS.ProcessEnv;
  // How the environment started (host/sealedEnv.ts); absent: inherited (bundles from before sealing).
  mode?: EnvMode;
  // Sealed: names passed from the harness's environment (values never recorded), and the fixed ones.
  passed?: string[];
  fixed?: Record<string, string>;
  // Names removed because a clear pattern matched them (values are never recorded).
  cleared: string[];
  // Names set by the profile or the side (values recorded: they are configuration).
  set: Record<string, string>;
}

// A plain environment is taken whole (inherit).
export function resolveEnv(profile: Profile, base: BaseEnv | NodeJS.ProcessEnv, extra: Record<string, string> = {}): ResolvedEnv {
  const b: BaseEnv = isBaseEnv(base) ? base : { env: base, mode: "inherit", passed: [], fixed: {} };
  const env = { ...b.env };
  const patterns = (profile.env?.clear ?? []).map(globToRegExp);
  const cleared = Object.keys(env)
    .filter((k) => patterns.some((re) => re.test(k)))
    .sort();
  for (const k of cleared) delete env[k];
  const set = { ...(profile.env?.set ?? {}), ...extra };
  Object.assign(env, set);
  return { env, mode: b.mode, passed: b.passed, fixed: b.fixed, cleared, set };
}

const isBaseEnv = (v: BaseEnv | NodeJS.ProcessEnv): v is BaseEnv =>
  typeof (v as BaseEnv).mode === "string" && typeof (v as BaseEnv).env === "object" && Array.isArray((v as BaseEnv).passed);

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
  // Extra arguments for the CLI check command (single-threaded mode).
  checkArgs: string[];
  env: ResolvedEnv;
  lib: { uriPrefix?: string; dir?: string } | undefined;
  mode: ThreadMode;
  // The side's label without the thread-mode suffix.
  base: string;
  // How the side's environment was built, kept so a thread-mode variant builds its own the same way.
  envPolicy: EnvPolicy;
}

// Every side in every mode: all sides in the first mode, then all in the next, so a round runs one
// mode's sides together.
export function sidesInModes(sides: Side[], modes: readonly ThreadMode[], use: "check" | "lsp"): Side[] {
  if (!modes.length) throw new InputError("--threads needs at least one mode");
  return modes.flatMap((m) => sides.map((s) => withThreads(s, m, use)));
}

export function parseThreadModes(value: string): ThreadMode[] {
  if (value === "both") return [...THREAD_MODES];
  const modes = value.split(",").map((v) => v.trim());
  for (const m of modes) if (!THREAD_MODES.includes(m as ThreadMode)) throw new InputError(`--threads: want default, single or both (got ${JSON.stringify(m)})`);
  return [...new Set(modes as ThreadMode[])];
}

// A side in the given thread mode, for the check command (`bench`) or the language server
// (`lsp-bench`). The default mode is the side as bound.
export function withThreads(side: Side, mode: ThreadMode, use: "check" | "lsp"): Side {
  if (mode === "default") return side;
  const t = side.profile.singleThreaded?.[use];
  if (!t)
    throw new InputError(
      `profile ${side.profile.name} does not say how to run its ${use === "check" ? "check command" : "language server"} single-threaded (singleThreaded.${use}); use --threads default`,
    );
  return {
    ...side,
    label: `${side.label}${SINGLE_SUFFIX}`,
    mode,
    base: side.label,
    lspCommand: use === "lsp" ? [...side.lspCommand, ...(t.args ?? [])] : side.lspCommand,
    checkArgs: use === "check" ? [...(t.args ?? [])] : [],
    env: resolveEnv(side.profile, baseEnv(side.envPolicy), { ...side.env.set, ...(t.env ?? {}) }),
  };
}

export interface BindOptions {
  extraEnv?: Record<string, string>;
  // Sealed by default (host/sealedEnv.ts).
  env?: EnvPolicy;
}

export interface SideSpec {
  label: string | undefined;
  profileName: string;
  bin: string;
}

// The syntax of `profile=bin` (or `label:profile=bin`), touching no file: the CLI checks every side
// with it before running anything, and bindSide parses with it.
export function parseSideSpec(spec: string): SideSpec {
  const eq = spec.indexOf("=");
  if (eq < 1) throw new InputError(`side ${JSON.stringify(spec)}: want <profile>=<binary> or <label>:<profile>=<binary>`);
  const left = spec.slice(0, eq);
  // "label:profile", except that a single letter before ":\" or ":/" is a Windows drive
  // ("C:\p\x.json"), not a label (so a one-letter label cannot precede an absolute path).
  const labelled = /^[A-Za-z]:[\\/]/.test(left) ? null : /^([\w.-]+):(.+)$/.exec(left);
  const [label, profileName] = labelled ? [labelled[1], labelled[2]!] : [undefined, left];
  const bin = spec.slice(eq + 1);
  // Empty most often means an unset shell variable (`tsc7=$TSGO`), which would otherwise resolve to
  // the working directory and fail later with EISDIR.
  if (!bin.trim()) throw new InputError(`side ${JSON.stringify(spec)}: no binary path after "=" (an unset shell variable?)`);
  return { label, profileName, bin };
}

// Binds `profile=bin` (or `label:profile=bin`) into a side. The label defaults to the profile name.
export async function bindSide(spec: string, role: Role, opts: BindOptions = {}): Promise<Side> {
  const envPolicy = opts.env ?? DEFAULT_ENV_POLICY;
  const { label, profileName, bin: given } = parseSideSpec(spec);
  const { profile, path: profilePath } = loadProfile(profileName);
  const bin = resolve(given);
  if (!existsSync(bin)) throw new InputError(`side ${JSON.stringify(spec)}: no binary at ${bin}`);
  if (statSync(bin).isDirectory()) throw new InputError(`side ${JSON.stringify(spec)}: ${bin} is a directory, not a binary`);
  const binReal = realpathSync(bin);
  const vars: Vars = { bin: isAbsolute(bin) ? bin : resolve(bin), binDir: dirname(binReal) };
  const env = resolveEnv(profile, baseEnv(envPolicy), opts.extraEnv ?? {});
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
    checkArgs: [],
    env,
    lib,
    mode: "default",
    base: label ?? profile.name,
    envPolicy,
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
