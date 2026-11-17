// The scripted answer session. Every request runs one at a time, so each server sees the same
// sequence. Step names, order and the typed text are those of the tsc-rs fork's scripts/lspdiff
// session.mjs, so a bundle here compares with today's lspdiff runs (script id "lspdiff-v1").
//
// Two requests depend on earlier answers: rename (only after a prepareRename that gave a result) and
// the quick fixes (for the first 3 diagnostics of a file). Runs therefore need not ask the same
// requests; the comparison aligns them by request identity (identity.ts), never by index.

import type { Answer, LspClient } from "../lsp/client.ts";
import { fileUri } from "./initialize.ts";
import { endPosition, languageId, pickPositions, readText, rel, type Position } from "./picker.ts";

export const SCRIPT_ID = "lspdiff-v1";

// Typed at the end of the first file, one character per didChange, with a completion after each.
export const TYPED = "\nconsole.log(Math.max(1, 2).toFixed(1));\n";

export interface ScriptSpec {
  root: string;
  // Absolute paths.
  files: string[];
  positions: number;
  typed: string;
}

export type Ask = (step: string, method: string, params: unknown) => Promise<Answer>;

interface Doc {
  path: string;
  uri: string;
  text: string;
  version: number;
}

function append(client: LspClient, doc: Doc, text: string): Position {
  const at = endPosition(doc.text);
  doc.text += text;
  doc.version++;
  client.notify("textDocument/didChange", {
    textDocument: { uri: doc.uri, version: doc.version },
    contentChanges: [{ range: { start: at, end: at }, text }],
  });
  return endPosition(doc.text);
}

function removeTail(client: LspClient, doc: Doc, length: number): void {
  const start = endPosition(doc.text.slice(0, doc.text.length - length));
  const end = endPosition(doc.text);
  doc.text = doc.text.slice(0, doc.text.length - length);
  doc.version++;
  client.notify("textDocument/didChange", {
    textDocument: { uri: doc.uri, version: doc.version },
    contentChanges: [{ range: { start, end }, text: "" }],
  });
}

interface DiagnosticItem {
  range: { start: Position; end: Position };
}

// Runs after initialize/initialized. Throws whatever the client throws (a server exit, a timeout).
export async function runScript(client: LspClient, spec: ScriptSpec, ask: Ask): Promise<void> {
  const { root, positions, typed } = spec;
  const docs: Doc[] = spec.files.map((path) => ({ path, uri: fileUri(path), text: readText(path), version: 1 }));
  for (const d of docs) {
    client.notify("textDocument/didOpen", {
      textDocument: { uri: d.uri, languageId: languageId(d.path), version: d.version, text: d.text },
    });
  }
  for (const d of docs) {
    const name = rel(root, d.path);
    const td = { uri: d.uri };
    const diag = await ask(`${name} diagnostic`, "textDocument/diagnostic", { textDocument: td });
    await ask(`${name} semanticTokens`, "textDocument/semanticTokens/full", { textDocument: td });
    await ask(`${name} inlayHint`, "textDocument/inlayHint", {
      textDocument: td,
      range: { start: { line: 0, character: 0 }, end: endPosition(d.text) },
    });
    await ask(`${name} documentSymbol`, "textDocument/documentSymbol", { textDocument: td });
    await ask(`${name} foldingRange`, "textDocument/foldingRange", { textDocument: td });
    const { idents, members } = pickPositions(d.text, positions);
    for (const [i, position] of idents.entries()) {
      const at = `${name}:${position.line + 1}:${position.character + 1}`;
      await ask(`${at} hover`, "textDocument/hover", { textDocument: td, position });
      await ask(`${at} definition`, "textDocument/definition", { textDocument: td, position });
      await ask(`${at} typeDefinition`, "textDocument/typeDefinition", { textDocument: td, position });
      await ask(`${at} references`, "textDocument/references", { textDocument: td, position, context: { includeDeclaration: true } });
      await ask(`${at} documentHighlight`, "textDocument/documentHighlight", { textDocument: td, position });
      await ask(`${at} signatureHelp`, "textDocument/signatureHelp", { textDocument: td, position });
      if (i === 0) {
        const prep = await ask(`${at} prepareRename`, "textDocument/prepareRename", { textDocument: td, position });
        if (prep.result) await ask(`${at} rename`, "textDocument/rename", { textDocument: td, position, newName: "renamedByLspdiff" });
      }
      await ask(`${at} codeAction`, "textDocument/codeAction", {
        textDocument: td,
        range: { start: position, end: position },
        context: { diagnostics: [], triggerKind: 1 },
      });
    }
    for (const position of members) {
      const at = `${name}:${position.line + 1}:${position.character + 1}`;
      await ask(`${at} completion`, "textDocument/completion", {
        textDocument: td,
        position,
        context: { triggerKind: 2, triggerCharacter: "." },
      });
    }
    // Quick fixes for the first few errors, as an editor asks when the cursor is on them.
    const items = ((diag.result as { items?: DiagnosticItem[] } | null)?.items ?? []).slice(0, 3);
    for (const item of items) {
      await ask(`${name}:${item.range.start.line + 1} codeAction(diag)`, "textDocument/codeAction", {
        textDocument: td,
        range: item.range,
        context: { diagnostics: [item], only: ["quickfix"], triggerKind: 1 },
      });
    }
  }
  const d = docs[0];
  if (!d) return;
  const name = rel(root, d.path);
  for (let i = 0; i < typed.length; i++) {
    const ch = typed[i]!;
    const position = append(client, d, ch);
    if (ch === "\n") continue;
    const context = ch === "." ? { triggerKind: 2, triggerCharacter: "." } : { triggerKind: 1 };
    await ask(`${name} typed ${JSON.stringify(typed.slice(1, i + 1))} completion`, "textDocument/completion", {
      textDocument: { uri: d.uri },
      position,
      context,
    });
  }
  await ask(`${name} after typing diagnostic`, "textDocument/diagnostic", { textDocument: { uri: d.uri } });
  const hoverAt = { line: endPosition(d.text).line - 1, character: 9 };
  await ask(`${name} after typing hover`, "textDocument/hover", { textDocument: { uri: d.uri }, position: hoverAt });
  removeTail(client, d, typed.length);
  await ask(`${name} after undo diagnostic`, "textDocument/diagnostic", { textDocument: { uri: d.uri } });
}
