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
import { median, quantile } from "./stats.ts";

export const LSP_SESSION_ID = "parallax.lsp-timing/2";
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

type Phase = "open" | "warmup" | "edit" | "typing" | "service";

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

  const t0 = performance.now();
  await writer.write({ type: "start", run: id, side: side.label, startedAt: new Date().toISOString(), command: side.lspCommand, session: LSP_SESSION_ID });
  const client = new LspClient(side.lspCommand, { cwd: spec.root, env: side.env.env, stderr, requestTimeoutMs: spec.requestTimeoutMs });
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
