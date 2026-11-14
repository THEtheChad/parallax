// A deterministic fake language server for tests. Behaviour comes from the environment (set through
// test profiles' env.set, so profiles are exercised too):
//   FAKE_LIB=bundled|file     where library-file locations point (bundled:///libs/ or beside this file)
//   FAKE_DIFF=1               the second hover answers differently; prepareRename answers null
//   FAKE_CRASH_AFTER=<n>      after n answered requests, print a panic line and exit 70
//   FAKE_UNSTABLE=1           documentHighlight answers vary from run to run
//   FAKE_HUGE=<items>         the first completion list carries this many items (one huge answer)

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FrameReader, encodeFrame } from "../../src/lsp/framing.ts";

const env = process.env;
const libPrefix =
  env.FAKE_LIB === "file"
    ? `file://${dirname(fileURLToPath(import.meta.url)).split("/").map(encodeURIComponent).join("/")}/`
    : "bundled:///libs/";
let answered = 0;
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
      return { kind: "full", items: [0, 1].map((i) => ({ range: range(i, 0), message: `problem ${i} in ${uri}`, severity: 1, code: 2300 + i })) };
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

const reader = new FrameReader();
process.stdin.on("data", (chunk: Buffer) => {
  for (const { body } of reader.push(chunk)) {
    const msg = JSON.parse(body) as { id?: number; method?: string; params?: any; result?: unknown };
    if (msg.method === undefined) continue; // an answer to our server-to-client request
    if (msg.method === "exit") process.exit(0);
    if (msg.id === undefined) {
      if (msg.method === "initialized") send({ id: "cfg-1", method: "workspace/configuration", params: { items: [{ section: "typescript" }] } });
      if (msg.method === "textDocument/didOpen") send({ method: "textDocument/publishDiagnostics", params: { uri: msg.params.textDocument.uri, diagnostics: [] } });
      continue;
    }
    if (msg.method === "initialize") {
      send({ id: msg.id, result: { capabilities: { hoverProvider: true }, serverInfo: { name: "fake" } } });
      continue;
    }
    if (msg.method === "shutdown") {
      send({ id: msg.id, result: null });
      continue;
    }
    if (env.FAKE_CRASH_AFTER && answered >= Number(env.FAKE_CRASH_AFTER)) {
      process.stderr.write("thread 'main' panicked at src/fake.rs:1:1:\nboom\n");
      process.exit(70);
    }
    answered++;
    const result = answer(msg.method, msg.params);
    send({ id: msg.id, result });
  }
});
