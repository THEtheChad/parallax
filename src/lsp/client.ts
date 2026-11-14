// A minimal LSP client over stdio. No dependencies.
//
// Unlike the fork's lspdiff clients it keeps no message history: notifications are counted per method,
// and each answer is handed back with its raw body text so a log can store the server's exact bytes
// without re-serializing them. The server runs in its own process group, so a launcher and its worker
// (one profile's process model) are stopped together.

import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { FrameReader, encodeFrame } from "./framing.ts";

export interface Answer {
  id: number;
  method: string;
  // The response body with line breaks outside strings turned into spaces (JSON allows none inside).
  raw: string;
  result?: unknown;
  error?: unknown;
  // Send to last byte received, in ms.
  ms: number;
  start: number;
  end: number;
  bytes: number;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class ServerExited extends Error {
  readonly exit: ExitInfo;
  readonly during: string | undefined;
  constructor(exit: ExitInfo, during?: string) {
    super(`server exited (${exit.code ?? exit.signal})${during ? ` during ${during}` : ""}`);
    this.exit = exit;
    this.during = during;
  }
}

export class RequestTimeout extends Error {
  readonly method: string;
  readonly ms: number;
  constructor(method: string, ms: number) {
    super(`${method} got no answer in ${ms} ms`);
    this.method = method;
    this.ms = ms;
  }
}

// What to answer a server-to-client request with. The default answers null to everything, as the
// fork's lspdiff did, so answers stay comparable with today's runs.
export type ServerRequestHandler = (method: string, params: unknown) => unknown;

export interface ClientOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stderr?: Writable;
  requestTimeoutMs?: number;
  onServerRequest?: ServerRequestHandler;
}

interface Pending {
  method: string;
  start: number;
  resolve: (a: Answer) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export class LspClient {
  readonly proc: ChildProcess;
  readonly exited: Promise<ExitInfo>;
  readonly notificationCounts: Record<string, number> = {};
  serverRequestCounts: Record<string, number> = {};
  #exit: ExitInfo | undefined;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #reader = new FrameReader();
  #opts: ClientOptions;
  #protocolErrors: string[] = [];

  constructor(command: string[], opts: ClientOptions) {
    const [bin, ...args] = command;
    if (!bin) throw new Error("empty server command");
    this.#opts = opts;
    this.proc = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", (code, signal) => {
        this.#exit = { code, signal };
        for (const [id, p] of this.#pending) {
          clearTimeout(p.timer);
          p.reject(new ServerExited(this.#exit, `${p.method} (id ${id})`));
        }
        this.#pending.clear();
        resolve(this.#exit);
      });
      // spawn failure (ENOENT, EACCES): no exit event follows.
      this.proc.on("error", (err) => {
        if (this.#exit) return;
        this.#exit = { code: null, signal: null };
        this.#protocolErrors.push(`spawn: ${err.message}`);
        for (const p of this.#pending.values()) p.reject(err);
        this.#pending.clear();
        resolve(this.#exit);
      });
    });
    this.proc.stdin!.on("error", () => {}); // EPIPE after the server died: the exit handler reports it.
    this.proc.stdout!.on("data", (chunk: Buffer) => this.#onData(chunk));
    if (opts.stderr) this.proc.stderr!.pipe(opts.stderr, { end: false });
    else this.proc.stderr!.resume();
  }

  get exitInfo(): ExitInfo | undefined {
    return this.#exit;
  }

  get protocolErrors(): readonly string[] {
    return this.#protocolErrors;
  }

  #onData(chunk: Buffer): void {
    const now = performance.now();
    let frames;
    try {
      frames = this.#reader.push(chunk);
    } catch (e) {
      this.#protocolErrors.push((e as Error).message);
      this.kill();
      return;
    }
    for (const frame of frames) {
      let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(frame.body);
      } catch (e) {
        this.#protocolErrors.push(`unparsable message: ${(e as Error).message.slice(0, 120)}`);
        continue;
      }
      if (msg.id !== undefined && msg.method !== undefined) {
        this.#onServerRequest(msg.id, msg.method, msg.params);
        continue;
      }
      if (msg.id === undefined) {
        const m = msg.method ?? "<no method>";
        this.notificationCounts[m] = (this.notificationCounts[m] ?? 0) + 1;
        continue;
      }
      const p = typeof msg.id === "number" ? this.#pending.get(msg.id) : undefined;
      if (!p) {
        this.#protocolErrors.push(`answer to unknown id ${JSON.stringify(msg.id)}`);
        continue;
      }
      this.#pending.delete(msg.id as number);
      clearTimeout(p.timer);
      const raw = /[\r\n]/.test(frame.body) ? frame.body.replace(/[\r\n]/g, " ") : frame.body;
      p.resolve({
        id: msg.id as number,
        method: p.method,
        raw,
        result: msg.result,
        error: msg.error,
        ms: now - p.start,
        start: p.start,
        end: now,
        bytes: frame.bytes,
      });
    }
  }

  #onServerRequest(id: number | string, method: string, params: unknown): void {
    this.serverRequestCounts[method] = (this.serverRequestCounts[method] ?? 0) + 1;
    const result = this.#opts.onServerRequest ? this.#opts.onServerRequest(method, params) : null;
    this.#write({ jsonrpc: "2.0", id, result: result ?? null });
  }

  #write(msg: unknown): void {
    if (this.#exit || !this.proc.stdin!.writable) return;
    this.proc.stdin!.write(encodeFrame(msg));
  }

  // `params` undefined: the message carries no params member (shutdown and exit take none, and
  // tsc 7 rejects `params: null` for them).
  request(method: string, params: unknown, timeoutMs = this.#opts.requestTimeoutMs): Promise<Answer> {
    if (this.#exit) return Promise.reject(new ServerExited(this.#exit, method));
    const id = this.#nextId++;
    const start = performance.now();
    const promise = new Promise<Answer>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(new RequestTimeout(method, timeoutMs));
          }, timeoutMs)
        : undefined;
      this.#pending.set(id, { method, start, resolve, reject, timer });
    });
    this.#write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  // Kills the server's whole process group.
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (this.proc.pid === undefined) return;
    try {
      process.kill(-this.proc.pid, signal);
    } catch {
      try {
        this.proc.kill(signal);
      } catch {}
    }
  }

  // shutdown, exit, then a kill of the process group if it has not exited after `graceMs`.
  // clean: the server answered shutdown without an error, then exited on its own with one of
  // `exitCodes` (a profile's shutdown.exitCodes).
  async shutdown({ graceMs = 5000, exitCodes = [0] }: { graceMs?: number; exitCodes?: number[] } = {}): Promise<{ exit: ExitInfo; clean: boolean }> {
    let answered = false;
    if (!this.#exit) {
      try {
        const r = await this.request("shutdown", undefined, graceMs);
        answered = r.error === undefined;
      } catch {}
      this.notify("exit", undefined);
      // Let the server act on exit before it reads end of input: tsc 7 exits 1 on exit but 0 on EOF,
      // so closing stdin at once makes its exit code a race.
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, Math.min(graceMs, 2000)))]);
      this.proc.stdin!.end();
    }
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      this.kill();
    }, graceMs);
    const exit = await this.exited;
    clearTimeout(timer);
    // A worker left behind in the group (launcher process model).
    this.kill();
    return { exit, clean: answered && !killed && exit.code !== null && exitCodes.includes(exit.code) };
  }
}
