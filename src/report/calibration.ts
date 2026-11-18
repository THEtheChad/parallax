// Plain-text rendering of a calibration: one row per metric and thread mode.

import type { Calibration } from "../timing/calibration.ts";
import { table } from "./bench.ts";

const pct = (x: number): string => `${(x * 100).toFixed(x < 0.1 ? 2 : 1)}%`;

export function renderCalibration(c: Calibration, file: string | null): string {
  const out: string[] = [];
  out.push(`A/A calibration (${c.kind}) of ${c.side.profile}${c.side.version ? ` ${c.side.version.split("\n")[0]}` : ""} on ${c.project.name}`);
  out.push(`${c.rounds.accepted} of ${c.rounds.planned} rounds accepted (${c.rounds.rejected} rejected); ${c.host.cpuModel}, ${c.host.cpus} cores${c.host.pin ? `, pinned to ${c.host.pin}` : ""}`);
  out.push(
    table(
      ["metric", "mode", "noise floor", "smallest resolution", "A/A call"],
      c.floors.map((f) => [f.metric, f.mode, pct(f.floor), pct(f.suggested), f.call ?? "-"]),
    ),
  );
  out.push("");
  out.push("noise floor: half-width of the A/A ratio interval (instructions: the two sides' difference or half a spread)");
  if (c.falseCalls.length) out.push(`WARNING: the A/A bench called a binary different from itself: ${c.falseCalls.join(", ")}`);
  out.push(file ? `kept for later benches on this host setup: ${file}` : "not kept for later benches");
  return out.join("\n");
}
