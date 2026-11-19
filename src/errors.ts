// Errors in what the user gave the harness, as against faults in the harness itself.
//
// A profile name that is not there, a project without its tsconfig, a bundle directory already in
// use, option values that do not fit together: the message says all there is to say, so the command
// line prints it as one line without the hint that PARALLAX_DEBUG=1 shows a stack (cli.ts report()).
// Anything else that escapes a command is taken for a harness fault and gets the hint.

import { readFileSync } from "node:fs";

export class InputError extends Error {}

// A JSON file the user named (a bundle's bundle.json or summary.json, a profile). A
// file that is not JSON at all is the wrong file, not a harness fault: say so and name it.
export function readJsonFile(file: string): unknown {
  const text = readFileSync(file, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new InputError(`${file}: ${notJson(e)}`);
  }
}

// JSON.parse's complaint, kept to one line: V8 quotes the start of the text, newlines and all.
export const notJson = (e: unknown): string => `not JSON (${(e as Error).message.replace(/\n/g, "\\n")})`;
