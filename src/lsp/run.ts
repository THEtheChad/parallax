// One server run of the scripted session, streamed to runs/<id>.jsonl as it goes:
//
//   {"type":"start", run, side, startedAt, command}
//   {"type":"initialize", ms, bytes, response: <raw body>}
//   {"type":"answer", seq, step, method, params, ms, bytes, response: <raw body>}   one per request
//   {"type":"end", outcome, error?, exit, shutdownClean, crashSignals, answers, notifications, ...}
//
// A crash or timeout ends the run with the answers given so far, all already on disk.

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import type { Outcome, RunRecord } from "../bundle/bundle.ts";
import { JsonlWriter } from "../bundle/lines.ts";
import { crashSignals, type Side } from "../profile/profile.ts";
import { initializeParams } from "../session/initialize.ts";
import { runScript, type ScriptSpec } from "../session/script.ts";
import { LspClient, RequestTimeout, ServerExited } from "./client.ts";

export interface RunOptions {
  bundleDir: string;
  id: string;
  n: number;
  side: Side;
  spec: ScriptSpec;
  requestTimeoutMs?: number;
  log?: (msg: string) => void;
}

async function tail(path: string, bytes: number): Promise<string> {
  const size = (await stat(path)).size;
  const fh = await open(path, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

export async function runServer(opts: RunOptions): Promise<RunRecord> {
  const { bundleDir, id, side, spec } = opts;
  const file = join("runs", `${id}.jsonl`);
  const stderrFile = join("runs", `${id}.stderr.log`);
  const writer = new JsonlWriter(join(bundleDir, file));
  const stderr = createWriteStream(join(bundleDir, stderrFile), { flags: "wx" });
  const startedAt = new Date().toISOString();
  const loadBefore = loadavg();
  const t0 = performance.now();
  await writer.write({ type: "start", run: id, side: side.label, startedAt, command: side.lspCommand });

  const client = new LspClient(side.lspCommand, {
    cwd: spec.root,
    env: side.env.env,
    stderr,
    ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  });
  let seq = 0;
  let outcome: Outcome = "clean";
  let error: string | undefined;
  try {
    const init = await client.request("initialize", initializeParams(spec.root));
    await writer.writeWithRaw({ type: "initialize", ms: init.ms, bytes: init.bytes }, "response", init.raw);
    if (init.error !== undefined) throw new Error(`initialize failed: ${JSON.stringify(init.error).slice(0, 300)}`);
    client.notify("initialized", {});
    await runScript(client, spec, async (step, method, params) => {
      const a = await client.request(method, params);
      await writer.writeWithRaw({ type: "answer", seq: ++seq, step, method, params, ms: a.ms, bytes: a.bytes }, "response", a.raw);
      return a;
    });
  } catch (e) {
    outcome = e instanceof ServerExited ? "crash" : e instanceof RequestTimeout ? "timeout" : "error";
    error = (e as Error).message;
    opts.log?.(`${id}: ${outcome}: ${error}`);
  }
  const { exit, clean } = await client.shutdown();
  stderr.end();
  await once(stderr, "finish");
  const signals = crashSignals(side.profile, exit.code, await tail(join(bundleDir, stderrFile), 1 << 16));
  if (outcome === "clean" && signals.length) outcome = "crash";
  const durationMs = performance.now() - t0;
  const loadAfter = loadavg();
  const end = {
    type: "end",
    outcome,
    ...(error !== undefined ? { error } : {}),
    exit,
    shutdownClean: clean,
    crashSignals: signals,
    answers: seq,
    notifications: client.notificationCounts,
    serverRequests: client.serverRequestCounts,
    protocolErrors: client.protocolErrors,
    durationMs,
  };
  await writer.write(end);
  await writer.close();
  return {
    id,
    side: side.label,
    role: side.role,
    n: opts.n,
    file,
    stderrFile,
    startedAt,
    durationMs,
    outcome,
    ...(error !== undefined ? { error } : {}),
    answers: seq,
    exit,
    shutdownClean: clean,
    crashSignals: signals,
    loadBefore,
    loadAfter,
  };
}
