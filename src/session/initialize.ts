// The initialize request every session sends: VS Code-like client capabilities, and user preferences
// as initializationOptions so no server needs a workspace/configuration round trip. Identical to the
// tsc-rs fork's scripts/lspdiff/client.mjs, so answers compare with today's runs.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const fileUri = (path: string): string => pathToFileURL(path).href;

// Inlay hints and auto-import completions are off by default; on here so those requests have
// something to compare.
export const userPreferences = {
  unstable: {
    includeInlayParameterNameHints: "all",
    includeInlayParameterNameHintsWhenArgumentMatchesName: true,
    includeInlayFunctionParameterTypeHints: true,
    includeInlayVariableTypeHints: true,
    includeInlayPropertyDeclarationTypeHints: true,
    includeInlayFunctionLikeReturnTypeHints: true,
    includeInlayEnumMemberValueHints: true,
    includeCompletionsForModuleExports: true,
    includeCompletionsWithInsertText: true,
  },
};

export function initializeParams(rootDir: string): Record<string, unknown> {
  return {
    processId: null,
    rootUri: fileUri(rootDir),
    workspaceFolders: [{ uri: fileUri(rootDir), name: "root" }],
    initializationOptions: { userPreferences },
    capabilities: {
      general: { positionEncodings: ["utf-16"] },
      workspace: { workspaceFolders: true, applyEdit: true, workspaceEdit: { documentChanges: true } },
      textDocument: {
        synchronization: { didSave: true, dynamicRegistration: false },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
        completion: {
          completionItem: {
            snippetSupport: true,
            commitCharactersSupport: true,
            documentationFormat: ["markdown", "plaintext"],
            labelDetailsSupport: true,
            insertReplaceSupport: true,
            resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
          },
          completionList: { itemDefaults: ["commitCharacters", "editRange", "insertTextFormat", "data"] },
        },
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: { linkSupport: true },
        references: {},
        rename: { prepareSupport: true },
        signatureHelp: {
          signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } },
        },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        codeAction: {
          codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "source", "source.organizeImports"] } },
          resolveSupport: { properties: ["edit"] },
          dataSupport: true,
        },
        semanticTokens: {
          requests: { full: true, range: true },
          tokenTypes: [
            "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property",
            "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp",
            "operator", "decorator",
          ],
          tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
          formats: ["relative"],
          multilineTokenSupport: false,
          overlappingTokenSupport: false,
        },
        inlayHint: { resolveSupport: { properties: [] } },
      },
      window: { workDoneProgress: false },
    },
  };
}

// The session definition's initialize request, independent of the project root and of the current
// directory (an absolute placeholder root, so pathToFileURL does not resolve it against the cwd).
export const initializeSha256 = (): string =>
  createHash("sha256").update(JSON.stringify(initializeParams("/<root>"))).digest("hex");
