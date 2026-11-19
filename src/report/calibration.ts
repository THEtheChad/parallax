// The report of a calibration: one row per metric and thread mode. Built as a report model (model.ts)
// and rendered as text or Markdown, or written as CSV.

import type { Calibration } from "../timing/calibration.ts";
import { METRICS } from "../timing/lspSummary.ts";
import { callText, type Measure } from "./common.ts";
import { line, toCsv, toText, type Block, type Report } from "./model.ts";
import type { Paint } from "../style.ts";

const pct = (x: number): string => `${(x * 100).toFixed(x < 0.1 ? 2 : 1)}%`;

// Floors are keyed by metric: lsp-bench's METRICS keys, or the bench's wallMs, cpuMs and instructions.
const BENCH_METRICS: Record<string, { label: string; measure: Measure }> = {
  wallMs: { label: "wall", measure: "time" },
  cpuMs: { label: "CPU", measure: "cpu" },
  instructions: { label: "instructions", measure: "cpu" },
};
const metricInfo = (key: string): { label: string; measure: Measure } => {
  const m = METRICS.find((x) => x.key === key);
  return m ? { label: m.label, measure: m.measure ?? "time" } : (BENCH_METRICS[key] ?? { label: key, measure: "time" });
};

export function calibrationReport(c: Calibration, file: string | null): Report {
  const blocks: Block[] = [
    {
      kind: "lines",
      lines: [
        line(`A/A calibration (${c.kind}) of ${c.side.profile}${c.side.version ? ` ${c.side.version.split("\n")[0]}` : ""} on ${c.project.name}`),
        line(`${c.rounds.accepted} of ${c.rounds.planned} rounds accepted (${c.rounds.rejected} rejected); ${c.host.cpuModel}, ${c.host.cpus} cores${c.host.pin ? `, pinned to ${c.host.pin}` : ""}`),
      ],
    },
    {
      kind: "table",
      header: ["metric", "mode", "noise floor at 6 rounds", "smallest resolution", "A/A call"],
      // The A/A call's "same" was judged at the A/A bench's resolution, which the calibration does not keep.
      rows: c.floors.map((f) => {
        const m = metricInfo(f.metric);
        return [m.label, f.mode, pct(f.floor), pct(f.suggested), callText(f.call, undefined, { measure: m.measure })];
      }),
    },
  ];
  const notes = [
    line(
      "noise floor: how wide a ratio interval gets when nothing differs, nine times in ten, at a default bench's first look (6 rounds, 95%); later benches recompute it at their own (instructions: the two sides' difference or half a spread)",
    ),
  ];
  if (c.falseCalls.length)
    notes.push(
      line(
        `${c.excessFalseCalls ? "WARNING: more false calls than chance explains" : "false calls within what chance explains"} (${c.falseCalls.length}, at most ${c.falseCallsExpected} expected): ${c.falseCalls.join(", ")}`,
      ),
    );
  blocks.push({ kind: "lines", lines: notes });
  blocks.push({ kind: "verdict", text: file ? `kept for later benches on this host setup: ${file}` : "not kept for later benches", tone: file ? "good" : "warn" });
  return { title: "parallax calibration", blocks };
}

export const renderCalibration = (c: Calibration, file: string | null, paint?: Paint): string => toText(calibrationReport(c, file), paint);

export function calibrationCsv(c: Calibration): string {
  return toCsv(
    ["metric", "mode", "floor", "suggested_resolution", "call", "coverage", "ref_median_ms", "rounds"],
    c.floors.map((f) => [f.metric, f.mode, f.floor, f.suggested, f.call, f.coverage, f.refMedianMs, f.ratios.length || null]),
  );
}
