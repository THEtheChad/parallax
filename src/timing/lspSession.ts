// One timed language-server session: start the server, then three phases, each timing what an editor
// user waits for. Every request goes to the session's log (runs/<id>.jsonl) as it is answered; the
// session returns one number per metric.
//
//   open    spawn, initialize, open the edited file, pull its diagnostics: time to first diagnostics
//           (from spawn). The other files are then opened and checked once, untimed (warm-up).
//   edit    closed loop, `edits` times: a one-character edit, then a hover in another file (the first
//           request after an edit pays for the server's update), a second hover (which does not), and
//           the edited file's diagnostics. Server CPU per edit over the loop. The edits are undone after.
//   typing  open loop: a line typed at the end of the edited file at `intervalMs` per key, `lines` times,
//           sending what VS Code sends (below) on a fixed schedule whether or not answers have come.
//           Latency is from the moment the key was due to the answer, so a server that falls behind is
//           charged for the queue it built. A new request in the same slot cancels the one in flight,
//           as an editor does; cancelled requests are counted, not timed. Server CPU per key.
//   service closed loop: `serviceLines` more lines typed the same way, but each key's requests are
//           sent one at a time, in the order the editor sends them, each after the previous answer,
//           and the next key only after the last. No queue and no cancellation: what is left is the
//           server's own time per request, which varies far less from run to run than latency
//           under load. The first request after a key carries the server's update, as in the edit
//           phase. Time per key (all of its requests answered), per completion and per diagnostics
//           request; server CPU per key.
//   paused  the service phase with `pauseMs` of quiet before each key, `pausedLines` lines: a server
//           that starts background work once the editor goes quiet (auto-import indexing, a full
//           check) shows it here, as the next key waiting on that work and as CPU per key
//   errfix  `errfixes` times: a line with a type error added to the edited file, its diagnostics
//           (which must report one more problem), the line removed, its diagnostics again. The time
//           to show an error and to clear it.
//   imports `imports` names exported by the other open files and not yet used in the edited file:
//           the first letters typed (completion, which must search other files' exports), then the
//           whole name (diagnostics report it missing) and the quick fix for it (the add-import fix)
//   long    `longEdits` edits in a row, each followed by the edited file's diagnostics (a hover or a
//           completion every few edits), resident memory read after each: diagnostics p50, how much
//           slower the last quarter's diagnostics are than the first quarter's, and memory growth
//           per edit (a Theil-Sen slope over the last three quarters, robust to a stray collection).
//           Growth and drift are figures of one server, not compared by ratio (a ratio of two
//           slopes near zero means nothing).
//
// What a key sends while typing (the fork's lspdiff bench, after VS Code): didChange; a completion
// after "." and at the start of a word; the edited file's diagnostics; every DEBOUNCE_MS of typing,
// semantic tokens and inlay hints for the edited file and diagnostics for the other open files; every
// HOVER_EVERY keys, a hover in another file (the mouse).

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { join, posix } from "node:path";
import type { Outcome } from "../bundle/bundle.ts";
import { JsonlWriter } from "../bundle/lines.ts";
import { serverUsage, type ServerUsage } from "../host/serverUsage.ts";
import { LspClient, RequestTimeout, ServerExited, type Answer } from "../lsp/client.ts";
import { crashSignals, type Side } from "../profile/profile.ts";
import { fileUri, initializeParams } from "../session/initialize.ts";
import { endPosition, languageId, pickPositions, readText, type Position } from "../session/picker.ts";
import { TYPED } from "../session/script.ts";
import { pinCommand, type Pinning } from "../host/pinning.ts";
import { median, quantile } from "./stats.ts";

export const LSP_SESSION_ID = "parallax.lsp-timing/3";
export const DEBOUNCE_MS = 500;
export const HOVER_EVERY = 8;
const REQUEST_CANCELLED = -32800;

export interface LspTimingSpec {
  root: string;
  // Absolute paths; the first is the edited file.
  files: string[];
  edits: number;
  intervalMs: number;
  lines: number;
  // Lines typed closed loop (the service phase); 0 skips it.
  serviceLines: number;
  // Lines typed closed loop with a pause before each key (the paused phase); 0 skips it.
  pausedLines: number;
  pauseMs: number;
  // Error insert-and-fix cycles, cross-file import names, and edits of the long phase; 0 skips each.
  errfixes: number;
  imports: number;
  longEdits: number;
  // Cores the server is pinned to (null: not pinned).
  pin?: Pinning | null;
  requestTimeoutMs: number;
}

// The metrics of one session, in milliseconds or bytes. null: not measured (no backend for it, or the
// phase did not ask that kind of request).
export interface SessionMetrics {
  "open.initializeMs": number | null;
  "open.firstDiagnosticsMs": number | null;
  "open.cpuMs": number | null;
  "edit.firstRequestMs": number | null;
  "edit.secondRequestMs": number | null;
  "edit.diagnosticsMs": number | null;
  "edit.cpuPerEditMs": number | null;
  "typing.completionP50Ms": number | null;
  "typing.completionP95Ms": number | null;
  "typing.diagnosticP50Ms": number | null;
  "typing.diagnosticP95Ms": number | null;
  "typing.hoverP50Ms": number | null;
  "typing.semanticTokensP50Ms": number | null;
  "typing.inlayHintP50Ms": number | null;
  "typing.cpuPerKeyMs": number | null;
  "service.keyP50Ms": number | null;
  "service.completionP50Ms": number | null;
  "service.diagnosticP50Ms": number | null;
  "service.cpuPerKeyMs": number | null;
  "paused.keyP50Ms": number | null;
  "paused.cpuPerKeyMs": number | null;
  "errfix.errorDiagnosticsMs": number | null;
  "errfix.fixDiagnosticsMs": number | null;
  "imports.completionMs": number | null;
  "imports.quickFixMs": number | null;
  "long.diagnosticP50Ms": number | null;
  "long.latencyDrift": number | null;
  "long.memoryGrowthPerEditBytes": number | null;
  "session.memoryBytes": number | null;
}

export type MetricKey = keyof SessionMetrics;

export interface SessionCounts {
  requests: number;
  // Requests whose answer was an error other than a cancellation.
  errors: number;
  cancelled: number;
  // Keys typed, and how late the harness sent them (p95, ms): a late harness means a loaded client.
  keys: number;
  lagP95Ms: number | null;
  // Inserted errors the diagnostics did not report, import names tried, and missing-name diagnostics
  // not found (no quick fix asked). Absent in sessions from before these phases.
  errfixMissed?: number;
  importNames?: number;
  importsMissed?: number;
}

export interface SessionResult {
  outcome: Outcome;
  error?: string;
  exit: { code: number | null; signal: string | null };
  shutdownClean: boolean;
  crashSignals: string[];
  durationMs: number;
  // Server CPU over the whole session (for the round's outside load); null when unknown.
  cpuMs: number | null;
  metrics: SessionMetrics;
  counts: SessionCounts;
  file: string;
  stderrFile: string;
}

type Phase = "open" | "warmup" | "edit" | "typing" | "service" | "paused" | "errfix" | "imports" | "long";

// The line added by the errfix phase: a type error every TypeScript checker reports.
export const errorLine = (i: number): string => `\nconst parallaxError${i}: number = "not a number";\n`;

// Names exported by `text` (declarations only; re-exports and default exports are skipped).
export function exportedNames(text: string): string[] {
  const re = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm;
  return [...new Set([...text.matchAll(re)].map((m) => m[1]!))];
}

// Up to `count` names exported by the other files and absent from the edited one, taken round-robin
// across files in file order, so every server is asked the same names.
export function importCandidates(edited: string, others: string[], count: number): string[] {
  const lists = others.map((t) => exportedNames(t).filter((n) => n.length >= 4 && !new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(edited)));
  const out: string[] = [];
  for (let i = 0; out.length < count && lists.some((l) => i < l.length); i++)
    for (const l of lists) if (i < l.length && out.length < count && !out.includes(l[i]!)) out.push(l[i]!);
  return out;
}

// Theil-Sen slope of y over x: the median of every pairwise slope. A few outliers (a collection, a
// cache filled once) move it far less than they move a least-squares fit.
export function theilSen(points: readonly (readonly [number, number])[]): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j]![0] - points[i]![0];
      if (dx !== 0) slopes.push((points[j]![1] - points[i]![1]) / dx);
    }
  return slopes.length ? median(slopes) : null;
}

// The first add-import action of a codeAction answer (commands, the older form, are not actions).
export function importAction(a: Answer): { title: string; edit?: unknown; data?: unknown } | null {
  const list = Array.isArray(a.result) ? (a.result as { title?: unknown; command?: unknown; edit?: unknown }[]) : [];
  const found = list.find((x) => x && typeof x.title === "string" && /import/i.test(x.title) && typeof x.command !== "string");
  return (found as { title: string; edit?: unknown; data?: unknown } | undefined) ?? null;
}

const diagnosticItems = (a: Answer): { range?: { start?: { line?: number } } }[] => {
  const r = a.result as { items?: unknown[] } | unknown[] | null | undefined;
  const items = Array.isArray(r) ? r : r && Array.isArray(r.items) ? r.items : [];
  return items as { range?: { start?: { line?: number } } }[];
};

interface Doc {
  uri: string;
  path: string;
  text: string;
  version: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(1, Math.ceil(ms))));
const isIdent = (ch: string | undefined): boolean => /[\w$]/.test(ch ?? "");

function emptyMetrics(): SessionMetrics {
  return {
    "open.initializeMs": null,
    "open.firstDiagnosticsMs": null,
    "open.cpuMs": null,
    "edit.firstRequestMs": null,
    "edit.secondRequestMs": null,
    "edit.diagnosticsMs": null,
    "edit.cpuPerEditMs": null,
    "typing.completionP50Ms": null,
    "typing.completionP95Ms": null,
    "typing.diagnosticP50Ms": null,
    "typing.diagnosticP95Ms": null,
    "typing.hoverP50Ms": null,
    "typing.semanticTokensP50Ms": null,
    "typing.inlayHintP50Ms": null,
    "typing.cpuPerKeyMs": null,
    "service.keyP50Ms": null,
    "service.completionP50Ms": null,
    "service.diagnosticP50Ms": null,
    "service.cpuPerKeyMs": null,
    "paused.keyP50Ms": null,
    "paused.cpuPerKeyMs": null,
    "errfix.errorDiagnosticsMs": null,
    "errfix.fixDiagnosticsMs": null,
    "imports.completionMs": null,
    "imports.quickFixMs": null,
    "long.diagnosticP50Ms": null,
    "long.latencyDrift": null,
    "long.memoryGrowthPerEditBytes": null,
    "session.memoryBytes": null,
  };
}

const orNull = (xs: number[], f: (xs: number[]) => number): number | null => (xs.length ? f(xs) : null);
const cpuDelta = (a: ServerUsage | null, b: ServerUsage | null, per: number): number | null => (a && b && per > 0 ? (b.cpuMs - a.cpuMs) / per : null);

export interface RunLspTimingOptions {
  bundleDir: string;
  id: string;
  side: Side;
  spec: LspTimingSpec;
  log?: (msg: string) => void;
}

export async function runLspTiming(opts: RunLspTimingOptions): Promise<SessionResult> {
  const { bundleDir, id, side, spec } = opts;
  const file = posix.join("runs", `${id}.jsonl`);
  const stderrFile = posix.join("runs", `${id}.stderr.log`);
  const writer = new JsonlWriter(join(bundleDir, file));
  const stderr = createWriteStream(join(bundleDir, stderrFile), { flags: "wx" });
  const stderrChunks: Buffer[] = [];
  const metrics = emptyMetrics();
  const counts: SessionCounts = { requests: 0, errors: 0, cancelled: 0, keys: 0, lagP95Ms: null };

  const command = pinCommand(side.lspCommand, spec.pin ?? null);
  const t0 = performance.now();
  await writer.write({ type: "start", run: id, side: side.label, startedAt: new Date().toISOString(), command, session: LSP_SESSION_ID });
  const client = new LspClient(command, { cwd: spec.root, env: side.env.env, stderr, requestTimeoutMs: spec.requestTimeoutMs });
  client.proc.stderr!.on("data", (c: Buffer) => {
    stderrChunks.push(c);
    if (stderrChunks.length > 64) stderrChunks.shift();
  });
  const usage = (): ServerUsage | null => (process.platform === "win32" ? null : serverUsage(client.proc.pid));
  const at = (t: number): number => Math.round((t - t0) * 1000) / 1000;

  // One request: logged when answered. `due` is when the editor wanted it (typing) or when it was sent.
  const ask = (phase: Phase, kind: string, method: string, params: unknown, due?: number, key?: number) => {
    const sent = client.send(method, params);
    const sentAt = performance.now();
    counts.requests++;
    const answer = sent.answer.then(async (a: Answer) => {
      const err = a.error as { code?: number; message?: string } | undefined;
      const cancelled = err?.code === REQUEST_CANCELLED;
      if (cancelled) counts.cancelled++;
      else if (err) counts.errors++;
      const latencyMs = a.end - (due ?? sentAt);
      await writer.write({
        type: "request",
        phase,
        kind,
        method,
        ...(key !== undefined ? { key } : {}),
        due: at(due ?? sentAt),
        sent: at(sentAt),
        answered: at(a.end),
        ms: a.ms,
        latencyMs,
        bytes: a.bytes,
        ...(cancelled ? { cancelled: true } : {}),
        ...(err && !cancelled ? { error: String(err.message ?? err.code).slice(0, 300) } : {}),
      });
      return { answer: a, latencyMs, cancelled, error: err !== undefined && !cancelled };
    });
    return { id: sent.id, answer };
  };
  const timed = (phase: Phase, kind: string, method: string, params: unknown): Promise<{ answer: Answer; latencyMs: number }> => ask(phase, kind, method, params).answer;

  const docs: Doc[] = spec.files.map((path) => ({ path, uri: fileUri(path), text: readText(path), version: 1 }));
  const edited = docs[0]!;
  const other = docs[1] ?? edited;
  const open = (d: Doc): void =>
    client.notify("textDocument/didOpen", { textDocument: { uri: d.uri, languageId: languageId(d.path), version: d.version, text: d.text } });
  const change = (d: Doc, start: Position, end: Position, text: string, next: string): void => {
    d.text = next;
    d.version++;
    client.notify("textDocument/didChange", { textDocument: { uri: d.uri, version: d.version }, contentChanges: [{ range: { start, end }, text }] });
  };
  const append = (d: Doc, text: string): Position => {
    const end = endPosition(d.text);
    change(d, end, end, text, d.text + text);
    return endPosition(d.text);
  };
  const removeTail = (d: Doc, length: number): void => {
    const keep = d.text.slice(0, d.text.length - length);
    change(d, endPosition(keep), endPosition(d.text), "", keep);
  };
  const diagnostics = (d: Doc) => ["textDocument/diagnostic", { textDocument: { uri: d.uri } }] as const;
  const hoverAt = pickPositions(other.text, 3).idents[1] ?? pickPositions(other.text, 3).idents[0] ?? { line: 0, character: 0 };
  const hover = ["textDocument/hover", { textDocument: { uri: other.uri }, position: hoverAt }] as const;
  const debounceKeys = Math.max(1, Math.round(DEBOUNCE_MS / spec.intervalMs));
  // What the editor sends after typing TYPED[i] (key: keys typed so far in the phase), as
  // [slot, kind, method, params]: a request replaces the one in flight in the same slot.
  const keyRequests = (i: number, key: number, position: Position): [slot: string, kind: string, method: string, params: unknown][] => {
    const td = { uri: edited.uri };
    const ch = TYPED[i]!;
    const sends: [string, string, string, unknown][] = [];
    if (ch === ".") sends.push(["completion", "completion", "textDocument/completion", { textDocument: td, position, context: { triggerKind: 2, triggerCharacter: "." } }]);
    else if (/[A-Za-z_$]/.test(ch) && !isIdent(TYPED[i - 1]) && TYPED[i - 1] !== ".")
      sends.push(["completion", "completion", "textDocument/completion", { textDocument: td, position, context: { triggerKind: 1 } }]);
    if (key % HOVER_EVERY === 0) sends.push(["hover", "hover", ...hover]);
    sends.push([edited.uri, "diagnostic", ...diagnostics(edited)]);
    if (key % debounceKeys === 0) {
      for (const d of docs.slice(1)) sends.push([d.uri, "diagnostic", ...diagnostics(d)]);
      sends.push(["semanticTokens", "semanticTokens", "textDocument/semanticTokens/full", { textDocument: td }]);
      sends.push(["inlayHint", "inlayHint", "textDocument/inlayHint", { textDocument: td, range: { start: { line: 0, character: 0 }, end: endPosition(edited.text) } }]);
    }
    return sends;
  };

  let outcome: Outcome = "clean";
  let error: string | undefined;
  let endUsage: ServerUsage | null = null;
  try {
    // open
    const init = await client.request("initialize", initializeParams(spec.root));
    if (init.error !== undefined) throw new Error(`initialize failed: ${JSON.stringify(init.error).slice(0, 300)}`);
    metrics["open.initializeMs"] = init.end - t0;
    client.notify("initialized", {});
    open(edited);
    const first = await timed("open", "diagnostic", ...diagnostics(edited));
    metrics["open.firstDiagnosticsMs"] = first.answer.end - t0;
    metrics["open.cpuMs"] = usage()?.cpuMs ?? null;

    // warm-up: every other file open and checked once, one hover
    for (const d of docs.slice(1)) open(d);
    for (const d of docs.slice(1)) await timed("warmup", "diagnostic", ...diagnostics(d));
    await timed("warmup", "hover", ...hover);

    // edit
    if (spec.edits > 0) {
      const firsts: number[] = [];
      const seconds: number[] = [];
      const diags: number[] = [];
      const before = usage();
      for (let i = 0; i < spec.edits; i++) {
        append(edited, i % 2 ? " " : "x");
        firsts.push((await timed("edit", "hover", ...hover)).latencyMs);
        seconds.push((await timed("edit", "hover", ...hover)).latencyMs);
        diags.push((await timed("edit", "diagnostic", ...diagnostics(edited))).latencyMs);
      }
      metrics["edit.cpuPerEditMs"] = cpuDelta(before, usage(), spec.edits);
      metrics["edit.firstRequestMs"] = median(firsts);
      metrics["edit.secondRequestMs"] = median(seconds);
      metrics["edit.diagnosticsMs"] = median(diags);
      removeTail(edited, spec.edits);
      await timed("warmup", "diagnostic", ...diagnostics(edited));
    }

    // typing
    if (spec.lines > 0) {
      const latencies = new Map<string, number[]>();
      const lags: number[] = [];
      const inFlight = new Map<string, number>(); // slot -> request id
      const answers: Promise<unknown>[] = [];
      // The first failure (the server exited, a request timed out); the loop stops at the next key.
      let failure: Error | undefined;
      const before = usage();
      let key = 0;
      for (let line = 0; line < spec.lines; line++) {
        const start = performance.now();
        for (let i = 0; i < TYPED.length; i++, key++) {
          const due = start + i * spec.intervalMs;
          // Timers may fire a little early; a key is never sent before it is due.
          while (performance.now() < due) await sleep(due - performance.now());
          if (failure) throw failure;
          lags.push(performance.now() - due);
          const position = append(edited, TYPED[i]!);
          for (const [slot, kind, method, params] of keyRequests(i, key, position)) {
            const previous = inFlight.get(slot);
            if (previous !== undefined) client.cancel(previous);
            const r = ask("typing", kind, method, params, due, key);
            inFlight.set(slot, r.id);
            answers.push(
              r.answer.then(
                (x) => {
                  if (inFlight.get(slot) === r.id) inFlight.delete(slot);
                  if (!x.cancelled && !x.error) latencies.set(kind, [...(latencies.get(kind) ?? []), x.latencyMs]);
                },
                (e: Error) => {
                  failure ??= e;
                },
              ),
            );
          }
        }
        // Let the line's last answers arrive (a failure surfaces here), then delete the line.
        await Promise.all(answers);
        if (failure) throw failure;
        removeTail(edited, TYPED.length);
      }
      counts.keys = key;
      metrics["typing.cpuPerKeyMs"] = cpuDelta(before, usage(), key);
      counts.lagP95Ms = orNull(lags, (xs) => quantile(xs, 0.95));
      const p = (kind: string, q: number): number | null => orNull(latencies.get(kind) ?? [], (xs) => quantile(xs, q));
      metrics["typing.completionP50Ms"] = p("completion", 0.5);
      metrics["typing.completionP95Ms"] = p("completion", 0.95);
      metrics["typing.diagnosticP50Ms"] = p("diagnostic", 0.5);
      metrics["typing.diagnosticP95Ms"] = p("diagnostic", 0.95);
      metrics["typing.hoverP50Ms"] = p("hover", 0.5);
      metrics["typing.semanticTokensP50Ms"] = p("semanticTokens", 0.5);
      metrics["typing.inlayHintP50Ms"] = p("inlayHint", 0.5);
    }

    // service
    if (spec.serviceLines > 0) {
      const perKey: number[] = [];
      const byKind = new Map<string, number[]>();
      const before = usage();
      let key = 0;
      for (let line = 0; line < spec.serviceLines; line++) {
        for (let i = 0; i < TYPED.length; i++, key++) {
          const start = performance.now();
          const position = append(edited, TYPED[i]!);
          for (const [, kind, method, params] of keyRequests(i, key, position)) {
            const x = await ask("service", kind, method, params, undefined, key).answer;
            if (x.cancelled || x.error) continue;
            byKind.set(kind, [...(byKind.get(kind) ?? []), x.latencyMs]);
          }
          perKey.push(performance.now() - start);
        }
        removeTail(edited, TYPED.length);
      }
      metrics["service.cpuPerKeyMs"] = cpuDelta(before, usage(), key);
      metrics["service.keyP50Ms"] = orNull(perKey, median);
      metrics["service.completionP50Ms"] = orNull(byKind.get("completion") ?? [], median);
      metrics["service.diagnosticP50Ms"] = orNull(byKind.get("diagnostic") ?? [], median);
    }
    // paused
    if (spec.pausedLines > 0) {
      const perKey: number[] = [];
      const before = usage();
      let key = 0;
      for (let line = 0; line < spec.pausedLines; line++) {
        for (let i = 0; i < TYPED.length; i++, key++) {
          await sleep(spec.pauseMs);
          const start = performance.now();
          const position = append(edited, TYPED[i]!);
          for (const [, kind, method, params] of keyRequests(i, key, position)) await ask("paused", kind, method, params, undefined, key).answer;
          perKey.push(performance.now() - start);
        }
        removeTail(edited, TYPED.length);
      }
      metrics["paused.cpuPerKeyMs"] = cpuDelta(before, usage(), key);
      metrics["paused.keyP50Ms"] = orNull(perKey, median);
    }

    // errfix
    if (spec.errfixes > 0) {
      const baseline = diagnosticItems((await timed("warmup", "diagnostic", ...diagnostics(edited))).answer).length;
      const shown: number[] = [];
      const cleared: number[] = [];
      let missed = 0;
      for (let i = 0; i < spec.errfixes; i++) {
        const line = errorLine(i);
        append(edited, line);
        const e = await timed("errfix", "diagnostic", ...diagnostics(edited));
        if (diagnosticItems(e.answer).length <= baseline) missed++;
        shown.push(e.latencyMs);
        removeTail(edited, line.length);
        cleared.push((await timed("errfix", "diagnostic", ...diagnostics(edited))).latencyMs);
      }
      counts.errfixMissed = missed;
      metrics["errfix.errorDiagnosticsMs"] = median(shown);
      metrics["errfix.fixDiagnosticsMs"] = median(cleared);
    }

    // imports
    const names = spec.imports > 0 ? importCandidates(edited.text, docs.slice(1).map((d) => d.text), spec.imports) : [];
    if (names.length) {
      const completions: number[] = [];
      const fixes: number[] = [];
      let missed = 0;
      for (const name of names) {
        const prefix = `\n${name.slice(0, 3)}`;
        const at = append(edited, prefix);
        completions.push((await timed("imports", "completion", "textDocument/completion", { textDocument: { uri: edited.uri }, position: at, context: { triggerKind: 1 } })).latencyMs);
        removeTail(edited, prefix.length);
        const named = `\n${name};\n`;
        const line = endPosition(edited.text).line + 1;
        append(edited, named);
        const d = await timed("imports", "diagnostic", ...diagnostics(edited));
        const found = diagnosticItems(d.answer).filter((x) => x.range?.start?.line === line);
        // The fix counts only when an add-import action came back, and its time runs until its edit
        // is in hand: a server that defers the edit to codeAction/resolve pays for the resolve too.
        let fixMs: number | null = null;
        if (found.length) {
          const range = { start: { line, character: 0 }, end: { line, character: name.length } };
          const fix = await timed("imports", "quickFix", "textDocument/codeAction", { textDocument: { uri: edited.uri }, range, context: { diagnostics: found, only: ["quickfix"], triggerKind: 1 } });
          const action = importAction(fix.answer);
          if (action?.edit) fixMs = fix.latencyMs;
          else if (action) {
            const resolved = await timed("imports", "quickFixResolve", "codeAction/resolve", action);
            if ((resolved.answer.result as { edit?: unknown } | null)?.edit) fixMs = fix.latencyMs + resolved.latencyMs;
          }
        }
        if (fixMs === null) missed++;
        else fixes.push(fixMs);
        removeTail(edited, named.length);
      }
      await timed("warmup", "diagnostic", ...diagnostics(edited));
      counts.importNames = names.length;
      counts.importsMissed = missed;
      metrics["imports.completionMs"] = median(completions);
      // Only when every name got its fix: a median over fewer names than the other side's would
      // compare different work.
      metrics["imports.quickFixMs"] = missed === 0 ? median(fixes) : null;
    }

    // long
    if (spec.longEdits > 0) {
      const lat: number[] = [];
      const memory: [number, number][] = [];
      for (let i = 0; i < spec.longEdits; i++) {
        const at = append(edited, i % 2 ? " " : "x");
        if (i % 4 === 1) await timed("long", "hover", ...hover);
        if (i % 4 === 3) await timed("long", "completion", "textDocument/completion", { textDocument: { uri: edited.uri }, position: at, context: { triggerKind: 1 } });
        lat.push((await timed("long", "diagnostic", ...diagnostics(edited))).latencyMs);
        const u = usage();
        if (u) memory.push([i, u.residentBytes]);
      }
      removeTail(edited, spec.longEdits);
      await timed("warmup", "diagnostic", ...diagnostics(edited));
      metrics["long.diagnosticP50Ms"] = median(lat);
      const q = Math.floor(lat.length / 4);
      if (q >= 2) metrics["long.latencyDrift"] = median(lat.slice(-q)) / median(lat.slice(0, q));
      const settled = memory.slice(Math.floor(memory.length / 4));
      if (settled.length >= 4) metrics["long.memoryGrowthPerEditBytes"] = theilSen(settled);
    }

    endUsage = usage();
    metrics["session.memoryBytes"] = endUsage?.memoryBytes ?? null;
  } catch (e) {
    outcome = e instanceof ServerExited ? "crash" : e instanceof RequestTimeout ? "timeout" : "error";
    error = (e as Error).message;
    opts.log?.(`${id}: ${outcome}: ${error}`);
  }
  const { exit, clean } = await client.shutdown({ exitCodes: side.profile.shutdown?.exitCodes ?? [0] });
  stderr.end();
  await once(stderr, "finish");
  const signals = crashSignals(side.profile, exit.code, Buffer.concat(stderrChunks).toString("utf8"));
  if (outcome === "clean" && signals.length) outcome = "crash";
  const durationMs = performance.now() - t0;
  const result: SessionResult = {
    outcome,
    ...(error !== undefined ? { error } : {}),
    exit,
    shutdownClean: clean,
    crashSignals: signals,
    durationMs,
    cpuMs: endUsage?.cpuMs ?? null,
    metrics,
    counts,
    file,
    stderrFile,
  };
  await writer.write({ type: "end", ...result });
  await writer.close();
  return result;
}
