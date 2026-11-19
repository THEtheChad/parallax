// `--format`: how a command prints its report on stdout. text for a terminal; md (GitHub-flavoured
// Markdown) for a PR comment or $GITHUB_STEP_SUMMARY, the same content as text; json, the summary
// object itself (the machine contract: README); csv, one row per figure. Every rendering is a pure
// function of the summary.

import type { Summary } from "../diff/compare.ts";
import type { Calibration } from "../timing/calibration.ts";
import type { LspBenchSummary } from "../timing/lspSummary.ts";
import type { BenchSummary } from "../timing/summary.ts";
import { benchCsv, benchReport } from "./bench.ts";
import { calibrationCsv, calibrationReport } from "./calibration.ts";
import { lspBenchCsv, lspBenchReport } from "./lspBench.ts";
import { toMarkdown, toText, type Report } from "./model.ts";
import type { Paint } from "../style.ts";
import { summaryCsv, summaryReport } from "./summary.ts";

export const FORMATS = ["text", "md", "json", "csv"] as const;
export type Format = (typeof FORMATS)[number];

export function parseFormat(v: string | undefined): Format {
  if (v === undefined) return "text";
  if ((FORMATS as readonly string[]).includes(v)) return v as Format;
  throw new Error(`--format wants ${FORMATS.join(", ")} (got ${JSON.stringify(v)})`);
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

// `paint` colours text output only (src/style.ts); md, json and csv are never painted.
function render(format: Format, value: unknown, report: () => Report, csv: () => string, paint?: Paint): string {
  if (format === "json") return json(value);
  if (format === "csv") return csv();
  return format === "md" ? toMarkdown(report()) : toText(report(), paint);
}

export const formatBench = (s: BenchSummary, f: Format, paint?: Paint): string => render(f, s, () => benchReport(s), () => benchCsv(s), paint);
export const formatLspBench = (s: LspBenchSummary, f: Format, paint?: Paint): string => render(f, s, () => lspBenchReport(s), () => lspBenchCsv(s), paint);
export const formatSummary = (s: Summary, f: Format, paint?: Paint): string => render(f, s, () => summaryReport(s), () => summaryCsv(s), paint);
// json: the calibration as stored (calibration.json); where it was kept goes to the log.
export const formatCalibration = (c: Calibration, file: string | null, f: Format, paint?: Paint): string =>
  render(f, c, () => calibrationReport(c, file), () => calibrationCsv(c), paint);
