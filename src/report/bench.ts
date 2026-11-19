// The report of a bench summary: a pure function of summary.json, built as a report model (model.ts)
// and rendered as text or Markdown, or written as CSV.

import { SETTLED } from "../timing/stats.ts";
import type { BenchSummary } from "../timing/summary.ts";
import { verdictTone, callText, intervalColumn, intervalFields, mib, ms, plural, ratio, roundsLines, spreadText, timingCsv, type TimingCsvRow } from "./common.ts";
import { line, toText, type Block, type Report } from "./model.ts";
import type { Paint } from "../style.ts";

const outputText = (x: BenchSummary["sides"][number]): string =>
  !x.outputStable ? `UNSTABLE (${x.outputs})` : x.outputMatchesRef === null ? "ref" : x.outputMatchesRef ? "same" : "DIFFERENT";

// The closing line. `clean` decides it, as it decides the exit status; when clean, it also says what
// the header and tables already show and a bare "MEASURED" would hide: calls that could still change,
// and candidates whose output is not the reference's (their times are of different work).
export function benchVerdict(s: BenchSummary): string {
  if (!s.clean) return "NOT MEASURED CLEANLY: see the states above";
  const unsettled = s.settled === false ? s.candidates.filter((c) => c.state !== "failed" && !(c.call !== null && SETTLED.includes(c.call))).length : 0;
  const differs = s.sides.filter((x) => x.outputMatchesRef === false).map((x) => x.label);
  let out = "MEASURED";
  if (unsettled) out += ` (not settled: ${plural(unsettled, "call")} could change with more rounds)`;
  if (differs.length) out += `: timing only; output differs from the reference for ${differs.join(", ")} (see the output column; parity is lsp-diff's job)`;
  return out;
}

export function benchReport(s: BenchSummary): Report {
  const blocks: Block[] = [];
  if (s.notes?.length) blocks.push({ kind: "warnings", notes: s.notes });
  blocks.push({
    kind: "lines",
    lines: [...roundsLines(s), line(`canary ${s.canaryBaselineMs === null ? "-" : `${s.canaryBaselineMs.toFixed(1)} ms`}; accounting ${s.accounting}`)],
  });
  const wall = intervalColumn("wall median", s.sides.map((x) => x.wallMs), ms);
  blocks.push({
    kind: "table",
    header: ["side", "n", wall.header, "CPU", "peak RSS", "exit", "output"],
    rows: s.sides.map((x, i) => [
      x.label,
      String(x.samples),
      wall.cells[i]!,
      x.cpuMs ? ms(x.cpuMs.estimate) : "-",
      x.maxRssBytes === null ? "-" : mib(x.maxRssBytes),
      x.exitCodes.join(","),
      outputText(x),
    ]),
  });
  const vsRef = intervalColumn("wall vs ref", s.candidates.map((c) => c.wallRatio), ratio);
  blocks.push({
    kind: "table",
    header: ["candidate", "vs", "state", vsRef.header, "CPU vs ref", "call"],
    // `ref` is absent in summaries from before thread modes: there was one reference.
    rows: s.candidates.map((c, i) => [
      c.label,
      c.ref ?? "ref",
      c.state,
      vsRef.cells[i]!,
      c.cpuRatio ? ratio(c.cpuRatio.estimate) : "-",
      callText(c.call, c.sameWithin, { measure: "time", ms: true, ...(s.resolution ? { resolution: s.resolution } : {}) }),
    ]),
  });
  if (s.counters?.sides.length) {
    const big = (v: number): string => (v >= 1e9 ? `${(v / 1e9).toFixed(3)}G` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v)}`);
    const fig = (f: { median: number; spread: number } | null, fmt: (v: number) => string): string => (f ? `${fmt(f.median)} ${spreadText(f.spread)}` : "-");
    blocks.push({
      kind: "table",
      caption: `counters (${s.counters.backend}; separate untimed runs; median ±half the range): compare a side with itself, not with another implementation`,
      header: ["side", "runs", "instructions", "cycles", "IPC", "task clock", "page faults"],
      rows: s.counters.sides.map((c) => [
        c.label,
        String(c.runs),
        fig(c.instructions, big),
        fig(c.cycles, big),
        c.ipc === null ? "-" : c.ipc.toFixed(2),
        fig(c.taskClockMs, ms),
        fig(c.pageFaults, big),
      ]),
    });
  }
  if (s.speedups?.length) {
    const sp = intervalColumn("single-threaded / default wall", s.speedups.map((x) => x.ratio), ratio);
    blocks.push({ kind: "table", header: ["parallel speedup", sp.header], rows: s.speedups.map((x, i) => [x.base, sp.cells[i]!]) });
  }
  blocks.push({ kind: "verdict", text: benchVerdict(s), tone: verdictTone(benchVerdict(s)) });
  return { title: "parallax bench", blocks };
}

export const renderBenchSummary = (s: BenchSummary, paint?: Paint): string => toText(benchReport(s), paint);

// One CSV, long format, a row per figure (README lists the kinds): `side` (each side's median wall and
// CPU with their interval, and peak RSS), `comparison` (a candidate against its reference: both
// medians, the ratio interval, call and state), `speedup` (single-threaded / default wall per
// implementation) and `counter` (the median of a counted run, with its spread).
export function benchCsv(s: BenchSummary): string {
  const rows: TimingCsvRow[] = [];
  for (const x of s.sides) {
    rows.push({ kind: "side", label: x.label, metric: "wall", unit: "ms", ...intervalFields(x.wallMs, "value") });
    rows.push({ kind: "side", label: x.label, metric: "cpu", unit: "ms", ...intervalFields(x.cpuMs, "value") });
    rows.push({ kind: "side", label: x.label, metric: "peak_rss", unit: "bytes", value: x.maxRssBytes });
  }
  const side = (label: string | undefined) => s.sides.find((x) => x.label === label);
  for (const c of s.candidates) {
    // `ref` is absent in summaries from before thread modes: there was one reference.
    const ref = side(c.ref) ?? s.sides.find((x) => x.role === "ref");
    const cand = side(c.label);
    const common = { kind: "comparison", label: c.label, vs: ref?.label ?? null, unit: "ms", state: c.state };
    rows.push({ ...common, metric: "wall", ...intervalFields(c.wallRatio, "ratio"), value: cand?.wallMs?.estimate ?? null, ref_value: ref?.wallMs?.estimate ?? null, call: c.call, same_within: c.sameWithin });
    rows.push({ ...common, metric: "cpu", ...intervalFields(c.cpuRatio, "ratio"), value: cand?.cpuMs?.estimate ?? null, ref_value: ref?.cpuMs?.estimate ?? null });
  }
  for (const x of s.speedups ?? []) rows.push({ kind: "speedup", label: x.base, metric: "wall", unit: "x", ...intervalFields(x.ratio, "ratio") });
  const counters = [["instructions", "count"], ["cycles", "count"], ["taskClockMs", "ms"], ["pageFaults", "count"]] as const;
  for (const c of s.counters?.sides ?? [])
    for (const [k, unit] of counters) {
      const f = c[k];
      if (f) rows.push({ kind: "counter", label: c.label, metric: k, unit, n: c.runs, value: f.median, spread: f.spread });
    }
  return timingCsv(rows);
}
