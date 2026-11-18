// A deterministic fake language server for tests. Behaviour comes from the environment (set through
// test profiles' env.set, so profiles are exercised too):
//   FAKE_LIB=bundled|file     where library-file locations point (bundled:///libs/ or beside this file)
//   FAKE_DIFF=1               the second hover answers differently; prepareRename answers null
//   FAKE_CRASH_AFTER=<n>      after n answered requests, print a panic line and exit 70
//   FAKE_UNSTABLE=1           documentHighlight answers vary from run to run
//   FAKE_HUGE=<items>         the first completion list carries this many items (one huge answer)
//   FAKE_WORK_MS=<ms>         each request costs this much CPU (a busy loop), one at a time from a queue,
//                             like a single-threaded server; $/cancelRequest drops a queued request
//                             (answered with RequestCancelled)
//   FAKE_EDIT_WORK_MS=<ms>    the first request after a didChange costs this much more (the update)

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FrameReader, encodeFrame } from "../../src/lsp/framing.ts";

const env = process.env;
const libPrefix =
  env.FAKE_LIB === "file"
    ? `file://${dirname(fileURLToPath(import.meta.url)).split("/").map(encodeURIComponent).join("/")}/`
    : "bundled:///libs/";
let answered = 0;
// Open documents' text, kept up to date from didOpen and didChange, so diagnostics can follow edits.
const docs = new Map<string, string>();
const offsetOf = (text: string, pos: { line: number; character: number }): number => {
  let off = 0;
  for (let l = 0; l < pos.line; l++) {
    const nl = text.indexOf("\n", off);
    if (nl < 0) return text.length;
    off = nl + 1;
  }
  return Math.min(text.length, off + pos.character);
};
// A problem on every line that adds an error the way the bench does, or names something alone.
const editedProblems = (uri: string) =>
  (docs.get(uri) ?? "")
    .split("\n")
    .flatMap((line, i) => (/parallaxError|^[A-Za-z_$][\w$]*;$/.test(line) ? [{ range: range(i, 0), message: `problem on line ${i}`, severity: 1, code: 2304 }] : []));
let hovers = 0;
let completions = 0;

const send = (msg: object): void => {
  process.stdout.write(encodeFrame({ jsonrpc: "2.0", ...msg }));
};

const range = (line: number, character: number) => ({ start: { line, character }, end: { line, character: character + 1 } });

function answer(method: string, params: Record<string, any>): unknown {
  const uri: string = params?.textDocument?.uri ?? "";
  const pos = params?.position ?? { line: 0, character: 0 };
  switch (method) {
    case "textDocument/diagnostic":
      return { kind: "full", items: [...[0, 1].map((i) => ({ range: range(i, 0), message: `problem ${i} in ${uri}`, severity: 1, code: 2300 + i })), ...editedProblems(uri)] };
    case "textDocument/hover":
      hovers++;
      return { contents: { kind: "markdown", value: env.FAKE_DIFF && hovers === 2 ? "something else" : `hover at ${pos.line}:${pos.character} in ${uri}` } };
    case "textDocument/definition":
    case "textDocument/typeDefinition":
      return [{ uri: `${libPrefix}lib.es5.d.ts`, range: range(100, 4) }, { uri, range: range(pos.line, pos.character) }];
    case "textDocument/prepareRename":
      return env.FAKE_DIFF ? null : range(pos.line, pos.character);
    case "textDocument/rename":
      return { changes: { [uri]: [{ range: range(pos.line, pos.character), newText: params.newName }] } };
    case "textDocument/documentHighlight":
      return env.FAKE_UNSTABLE ? [{ range: range(pos.line, Math.floor(Math.random() * 1e6)) }] : [{ range: range(pos.line, pos.character) }];
    case "textDocument/completion": {
      const huge = env.FAKE_HUGE !== undefined && ++completions === 1;
      const n = huge ? Number(env.FAKE_HUGE) : 5;
      // Emitted in an order that depends on the run, as servers do with equal sort keys.
      const items = Array.from({ length: n }, (_, i) => ({ label: `item${i}`, sortText: "11", detail: "x".repeat(huge ? 200 : 1) }));
      if (Math.random() < 0.5) items.reverse();
      return { isIncomplete: false, items };
    }
    case "textDocument/codeAction":
      return params?.context?.diagnostics?.length ? [{ title: "Fix it", kind: "quickfix", diagnostics: params.context.diagnostics }] : [];
    default:
      return { method, at: pos };
  }
}

const workMs = Number(env.FAKE_WORK_MS ?? 0);
const editWorkMs = Number(env.FAKE_EDIT_WORK_MS ?? 0);
let dirty = false;
const queue: { id: number; method: string; params: any }[] = [];
let draining = false;

const spin = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};

function respond(id: number, method: string, params: any): void {
  if (env.FAKE_CRASH_AFTER && answered >= Number(env.FAKE_CRASH_AFTER)) {
    process.stderr.write("thread 'main' panicked at src/fake.rs:1:1:\nboom\n");
    process.exit(70);
  }
  answered++;
  send({ id, result: answer(method, params) });
}

// One queued request per turn of the event loop, so cancellations sent meanwhile are read.
function drain(): void {
  const next = queue.shift();
  if (!next) {
    draining = false;
    return;
  }
  spin(workMs + (dirty ? editWorkMs : 0));
  dirty = false;
  respond(next.id, next.method, next.params);
  setImmediate(drain);
}

const reader = new FrameReader();
process.stdin.on("data", (chunk: Buffer) => {
  for (const { body } of reader.push(chunk)) {
    const msg = JSON.parse(body) as { id?: number; method?: string; params?: any; result?: unknown };
    if (msg.method === undefined) continue; // an answer to our server-to-client request
    if (msg.method === "exit") process.exit(0);
    if (msg.id === undefined) {
      if (msg.method === "initialized") send({ id: "cfg-1", method: "workspace/configuration", params: { items: [{ section: "typescript" }] } });
      if (msg.method === "textDocument/didOpen") docs.set(msg.params.textDocument.uri, msg.params.textDocument.text);
      if (msg.method === "textDocument/didChange") {
        const uri = msg.params.textDocument.uri;
        let text = docs.get(uri) ?? "";
        for (const c of msg.params.contentChanges) {
          if (!c.range) text = c.text;
          else text = text.slice(0, offsetOf(text, c.range.start)) + c.text + text.slice(offsetOf(text, c.range.end));
        }
        docs.set(uri, text);
      }
      if (msg.method === "textDocument/didOpen") send({ method: "textDocument/publishDiagnostics", params: { uri: msg.params.textDocument.uri, diagnostics: [] } });
      if (msg.method === "textDocument/didChange") dirty = true;
      if (msg.method === "$/cancelRequest") {
        const i = queue.findIndex((q) => q.id === msg.params.id);
        if (i >= 0) {
          const [dropped] = queue.splice(i, 1);
          send({ id: dropped!.id, error: { code: -32800, message: "Request cancelled" } });
        }
      }
      continue;
    }
    if (msg.method === "initialize") {
      send({ id: msg.id, result: { capabilities: { hoverProvider: true }, serverInfo: { name: "fake" } } });
      continue;
    }
    if (msg.method === "shutdown") {
      // Like tsc 7: shutdown takes no params, and `params: null` is an error.
      if ("params" in msg) send({ id: msg.id, error: { code: -32602, message: "InvalidParams: expected no params" } });
      else send({ id: msg.id, result: null });
      continue;
    }
    if (!workMs && !editWorkMs) {
      respond(msg.id, msg.method, msg.params);
      continue;
    }
    queue.push({ id: msg.id, method: msg.method, params: msg.params });
    if (!draining) {
      draining = true;
      setImmediate(drain);
    }
  }
});
