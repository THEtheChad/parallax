// The environment a measured command sees. By default it is sealed: the command starts from a short
// allow-list of the harness's own variables plus a few fixed ones, not from whatever the shell that
// started the harness happened to export. A variable an implementation reads (a GOGC, a
// RAYON_NUM_THREADS, a NODE_OPTIONS, a locale) changes what it does, and nothing in a bundle would
// show it; with a sealed environment two machines, or two runs on one machine, give the commands the
// same environment except for the names recorded in the bundle.
//
//   sealed   only PASS (and --pass-env names) from the harness's environment, then FIXED, then the
//            profile's env.set and the thread mode's variables
//   inherit  the harness's whole environment, minus the profile's env.clear patterns (the old way)
//
// The names passed are recorded in every bundle; their values are not (PATH and HOME are paths).

import { platform } from "node:os";
import { InputError } from "../errors.ts";

export type EnvMode = "sealed" | "inherit";

export interface EnvPolicy {
  mode: EnvMode;
  // Extra names to pass from the harness's environment when sealed.
  pass: string[];
}

export const DEFAULT_ENV_POLICY: EnvPolicy = { mode: "sealed", pass: [] };

// What a program needs to start and find its files on each OS, and nothing about how it should run.
const PASS_POSIX = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR"];
const PASS_WINDOWS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
];

// Set the same everywhere: a locale and a time zone change messages and dates in output. macOS has no
// C.UTF-8 locale; en_US.UTF-8 is its UTF-8 locale that every install has.
export const fixedEnv = (os: NodeJS.Platform = platform()): Record<string, string> => {
  const locale = os === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  return { LANG: locale, LC_ALL: locale, TZ: "UTC" };
};
export const FIXED_ENV = fixedEnv("linux");

export const passList = (policy: EnvPolicy, os: NodeJS.Platform = platform()): string[] => [
  ...new Set([...(os === "win32" ? PASS_WINDOWS : PASS_POSIX), ...policy.pass]),
];

export interface BaseEnv {
  env: NodeJS.ProcessEnv;
  mode: EnvMode;
  // Names taken from the harness's environment (sealed only; values never recorded).
  passed: string[];
  // Fixed names set by the seal.
  fixed: Record<string, string>;
}

// The environment a side starts from, before its profile's clear and set.
export function baseEnv(policy: EnvPolicy, from: NodeJS.ProcessEnv = process.env, os: NodeJS.Platform = platform()): BaseEnv {
  if (policy.mode === "inherit") return { env: { ...from }, mode: "inherit", passed: [], fixed: {} };
  // Windows names are case-insensitive; a spread of process.env keeps whatever case the OS gave.
  const fold = (k: string): string => (os === "win32" ? k.toUpperCase() : k);
  const wanted = new Set(passList(policy, os).map(fold));
  const env: NodeJS.ProcessEnv = {};
  const passed: string[] = [];
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined || !wanted.has(fold(k))) continue;
    env[k] = v;
    passed.push(k);
  }
  const fixed = fixedEnv(os);
  Object.assign(env, fixed);
  return { env, mode: "sealed", passed: passed.sort(), fixed };
}

export function parseEnvMode(value: string): EnvMode {
  if (value !== "sealed" && value !== "inherit") throw new InputError(`--env: want sealed or inherit (got ${JSON.stringify(value)})`);
  return value;
}
