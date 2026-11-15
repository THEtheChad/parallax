// Picks files and positions in a project, the same way for every server. Ported unchanged from the
// tsc-rs fork's scripts/lspdiff/project.mjs, so a session here asks what that tool asked.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Position {
  line: number;
  character: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "out"]);

export function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith(".d.ts")) files.push(path);
    }
  };
  walk(root);
  return files;
}

const spread = <T>(list: T[], count: number): T[] => {
  if (list.length <= count) return list;
  const step = list.length / count;
  return Array.from({ length: count }, (_, i) => list[Math.floor(i * step + step / 2)]!);
};

// `count` files spread evenly over the sorted list, skipping tiny and huge files.
export function pickFiles(root: string, count: number, explicit?: string[]): string[] {
  if (explicit?.length) return explicit.map((f) => join(root, f));
  const files = listSourceFiles(root).filter((f) => {
    const size = statSync(f).size;
    return size > 400 && size < 60000;
  });
  return spread(files, count);
}

export const languageId = (path: string): string => (/x$/.test(path) ? "typescriptreact" : "typescript");

// Blanks comments and string contents (keeping offsets) so identifiers are found in code only.
function maskNonCode(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
}

export function offsetToPosition(text: string, offset: number): Position {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

export const endPosition = (text: string): Position => offsetToPosition(text, text.length);

const KEYWORDS = new Set(
  "abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of package private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield".split(
    " ",
  ),
);

// Identifier positions (middle of the identifier) and member-access positions (just after a dot),
// `count` of each, evenly spread through the file.
export function pickPositions(text: string, count: number): { idents: Position[]; members: Position[] } {
  const code = maskNonCode(text);
  const idents: number[] = [];
  const members: number[] = [];
  const re = /[A-Za-z_$][\w$]*/g;
  for (let m; (m = re.exec(code)); ) {
    if (KEYWORDS.has(m[0])) continue;
    idents.push(m.index + (m[0].length >> 1));
    if (m.index > 0 && code[m.index - 1] === ".") members.push(m.index);
  }
  return {
    idents: spread(idents, count).map((o) => offsetToPosition(text, o)),
    members: spread(members, count).map((o) => offsetToPosition(text, o)),
  };
}

// Project-relative paths as bundles store them: "/"-separated on every OS, so a session defined on
// Windows is the same session as on Linux.
export const rel = (root: string, path: string): string => relative(root, path).split(sep).join("/");
export const readText = (path: string): string => readFileSync(path, "utf8");
