// The round loop shared by `bench` and `lsp-bench`.
//
//   rounds    wait for an idle machine, canary, every side once, canary; the order alternates
//             (ref, A, B / B, A, ref / ...) so no side always runs first or after the same neighbour
//   retries   a disturbed round (see summary.ts) is run again, up to `attempts` times; a round in which
//             a side failed is not retried (a crash is a result, not noise)
//
// Every round goes to the writer as it happens, rejected ones included; the samples are written by
// `run` itself.

import type { JsonlWriter } from "../bundle/lines.ts";
import { cpuSnapshot, cpuWindow, outsideCores, waitForIdle, type IdleGate } from "../host/machine.ts";
import { runCanary } from "./canary.ts";
import { judgeRound, type Gates, type RoundRecord } from "./summary.ts";

export interface SideRun {
  // CPU of everything the side ran during the round; null when unknown (outside load is then unknown).
  cpuMs: number | null;
  failed: boolean;
  // A few words for the progress log.
  brief: string;
}

export interface RoundsOptions<S extends { label: string }> {
  sides: S[];
  runs: number;
  attempts: number;
  idle: IdleGate;
  gates: Gates;
  writer: JsonlWriter;
  log: (msg: string) => void;
  run: (side: S, round: number, attempt: number) => Promise<SideRun>;
}

export async function runRounds<S extends { label: string }>(o: RoundsOptions<S>): Promise<void> {
  runCanary(); // warm the canary's code before its first timed use
  let fastestCanary = Infinity;
  for (let round = 1; round <= o.runs; round++) {
    const order = round % 2 ? o.sides : [...o.sides].reverse();
    for (let attempt = 1; attempt <= o.attempts; attempt++) {
      const idle = await waitForIdle(o.idle, o.log);
      const before = cpuSnapshot();
      const canaryBeforeMs = runCanary().ms;
      const results: { side: S; r: SideRun }[] = [];
      for (const side of order) results.push({ side, r: await o.run(side, round, attempt) });
      const canaryAfterMs = runCanary().ms;
      const window = cpuWindow(before, cpuSnapshot());
      const cpu = results.every(({ r }) => r.cpuMs !== null) ? results.reduce((t, { r }) => t + r.cpuMs!, 0) : null;
      fastestCanary = Math.min(fastestCanary, canaryBeforeMs, canaryAfterMs);
      const partial = { idle, outsideCores: outsideCores(window, cpu), canaryBeforeMs, canaryAfterMs };
      const rejected = judgeRound(partial, fastestCanary, o.gates);
      const rec: RoundRecord = { type: "round", round, attempt, order: order.map((s) => s.label), window, ...partial, rejected };
      await o.writer.write(rec);
      const briefs = results.map(({ side, r }) => `${side.label} ${r.brief}`).join(", ");
      const other = partial.outsideCores === null ? "" : `, other ${partial.outsideCores.toFixed(2)} cores`;
      o.log(`round ${round}.${attempt}: ${briefs} (canary ${canaryBeforeMs.toFixed(1)}/${canaryAfterMs.toFixed(1)} ms${other})${rejected.length ? ` rejected: ${rejected.join("; ")}` : ""}`);
      const failed = results.filter(({ r }) => r.failed);
      if (failed.length) {
        o.log(`round ${round}: ${failed.map(({ side }) => side.label).join(", ")} failed; not retried`);
        break;
      }
      if (!rejected.length) break;
    }
  }
}
