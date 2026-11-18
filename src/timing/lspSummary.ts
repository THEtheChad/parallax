// Summarizing an lsp-bench: a pure function of samples.jsonl (sessions and rounds), like the CLI
// bench's summary. Each accepted round gives one number per metric per side; a side's figure is the
// median over rounds with an order-statistic interval, and a candidate's is the median of its per-round ratio
// to the reference, so load steady over a round cancels.

import { acceptRounds, DEFAULT_RESOLUTION_SETTING, modeOf, planOf, refFor, type Gates, type Resolution, type RoundRecord, type SideInfo } from "./summary.ts";
import type { ThreadMode } from "../profile/profile.ts";
import type { MetricKey, SessionCounts, SessionMetrics } from "./lspSession.ts";
import type { Outcome } from "../bundle/bundle.ts";
import { callOf, lookConfidence, median, medianInterval, sameWithin, SETTLED, type Call, type Interval } from "./stats.ts";

export interface SessionRecord {
  type: "session";
  side: string;
  role: "ref" | "cand";
  round: number;
  attempt: number;
  warmup: boolean;
  startedAt: string;
  outcome: Outcome;
  error?: string;
  exit: { code: number | null; signal: string | null };
  shutdownClean: boolean;
  crashSignals: string[];
  durationMs: number;
  cpuMs: number | null;
  metrics: SessionMetrics;
  counts: SessionCounts;
  file: string;
}

export interface MetricInfo {
  key: MetricKey;
  label: string;
  // "bytes/edit": a growth rate; "x": a ratio within one session.
  unit: "ms" | "bytes" | "bytes/edit" | "x";
  // false: a figure of each server alone, never compared by ratio (it can be zero or negative).
  compare?: false;
}

// Report order. Every metric is lower-is-better.
export const METRICS: MetricInfo[] = [
  { key: "open.firstDiagnosticsMs", label: "open: first diagnostics", unit: "ms" },
  { key: "open.initializeMs", label: "open: initialize", unit: "ms" },
  { key: "open.cpuMs", label: "open: server CPU", unit: "ms" },
  { key: "edit.firstRequestMs", label: "edit: first request after", unit: "ms" },
  { key: "edit.secondRequestMs", label: "edit: second request", unit: "ms" },
  { key: "edit.diagnosticsMs", label: "edit: diagnostics", unit: "ms" },
  { key: "edit.cpuPerEditMs", label: "edit: CPU per edit", unit: "ms" },
  { key: "typing.completionP50Ms", label: "typing: completion p50", unit: "ms" },
  { key: "typing.completionP95Ms", label: "typing: completion p95", unit: "ms" },
  { key: "typing.diagnosticP50Ms", label: "typing: diagnostics p50", unit: "ms" },
  { key: "typing.diagnosticP95Ms", label: "typing: diagnostics p95", unit: "ms" },
  { key: "typing.hoverP50Ms", label: "typing: hover p50", unit: "ms" },
  { key: "typing.semanticTokensP50Ms", label: "typing: semantic tokens p50", unit: "ms" },
  { key: "typing.inlayHintP50Ms", label: "typing: inlay hints p50", unit: "ms" },
  { key: "typing.cpuPerKeyMs", label: "typing: CPU per key", unit: "ms" },
  { key: "service.keyP50Ms", label: "service: per key p50", unit: "ms" },
  { key: "service.completionP50Ms", label: "service: completion p50", unit: "ms" },
  { key: "service.diagnosticP50Ms", label: "service: diagnostics p50", unit: "ms" },
  { key: "service.cpuPerKeyMs", label: "service: CPU per key", unit: "ms" },
  { key: "paused.keyP50Ms", label: "paused: per key p50", unit: "ms" },
  { key: "paused.cpuPerKeyMs", label: "paused: CPU per key", unit: "ms" },
  { key: "errfix.errorDiagnosticsMs", label: "errfix: error shown", unit: "ms" },
  { key: "errfix.fixDiagnosticsMs", label: "errfix: error cleared", unit: "ms" },
  { key: "imports.completionMs", label: "imports: completion", unit: "ms" },
  { key: "imports.quickFixMs", label: "imports: add-import fix", unit: "ms" },
  { key: "long.diagnosticP50Ms", label: "long: diagnostics p50", unit: "ms" },
  { key: "long.latencyDrift", label: "long: last/first quarter", unit: "x", compare: false },
  { key: "long.memoryGrowthPerEditBytes", label: "long: memory growth per edit", unit: "bytes/edit", compare: false },
  { key: "session.memoryBytes", label: "session: memory", unit: "bytes" },
];

export type CandidateState = "measured" | "noisy" | "failed";

export interface LspSideSummary {
  label: string;
  role: "ref" | "cand";
  mode: ThreadMode;
  sessions: number;
  failures: number;
  outcomes: Partial<Record<Outcome, number>>;
  // Over accepted rounds.
  requests: number;
  errors: number;
  cancelled: number;
  // Over accepted rounds: inserted errors the diagnostics missed, and import names whose missing-name
  // diagnostic was not found (absent in older summaries).
  errfixMissed?: number;
  importsMissed?: number;
  metrics: Partial<Record<MetricKey, Interval | null>>;
}

export interface LspCandidateSummary {
  label: string;
  // The reference it is compared with: the one running in the same thread mode.
  ref: string;
  mode: ThreadMode;
  state: CandidateState;
  // sameWithin: the half-width of "same" for that metric (the resolution, or the floor over the
  // reference's figure).
  metrics: Partial<Record<MetricKey, { ratio: Interval | null; call: Call | null; sameWithin: number }>>;
}

export interface LspBenchSummary {
  schema: "parallax.lsp-bench-summary/1";
  canaryBaselineMs: number | null;
  rounds: { planned: number; max: number; attempts: number; accepted: number; rejected: number; failed: number };
  minRounds: number;
  // The confidence calls needed at this many accepted rounds (stats.ts lookConfidence).
  confidence: number;
  resolution: Resolution;
  gates: Gates;
  rejections: Record<string, number>;
  usage: string;
  memory: "peak" | "current" | null;
  // The harness's worst key lag (p95 over sessions, ms) against the typing interval: a late harness
  // means the client, not the server, was slow.
  harnessLagP95Ms: number | null;
  sides: LspSideSummary[];
  candidates: LspCandidateSummary[];
  // Every metric of every comparison has a call more rounds would not change (or the candidate failed).
  settled: boolean;
  clean: boolean;
}

export interface LspSummarizeInput {
  records: (SessionRecord | RoundRecord)[];
  sides: SideInfo[];
  plannedRounds: number;
  // Absent: a fixed number of rounds (plannedRounds).
  maxRounds?: number;
  resolution?: Resolution;
  minRounds: number;
  gates: Gates;
  usage: string;
  memory: "peak" | "current" | null;
}

const failed = (s: SessionRecord): boolean => s.outcome !== "clean";

export function summarizeLspBench(input: LspSummarizeInput): LspBenchSummary {
  const rounds = input.records.filter((r): r is RoundRecord => r.type === "round");
  const sessions = input.records.filter((r): r is SessionRecord => r.type === "session");
  const { baseline, accepted, ...counts } = acceptRounds(rounds, sessions.filter((s) => !s.warmup), input.sides.length, failed, input.gates);
  const plan = planOf(input.plannedRounds, input.maxRounds);
  const confidence = lookConfidence(accepted.length, plan);
  const resolution = input.resolution ?? DEFAULT_RESOLUTION_SETTING;
  // Only the metrics the sessions measured: a bundle or published result from before a metric existed
  // keeps the summary shape it was published with (verify-result compares summaries exactly).
  const measured = sessions.filter((x) => !x.warmup);
  const metricsHere = METRICS.filter(({ key }) => measured.some((x) => key in x.metrics));
  const countsHere = (k: "errfixMissed" | "importsMissed"): boolean => measured.some((x) => x.counts[k] !== undefined);
  const values = (ss: SessionRecord[], key: MetricKey): number[] | null => {
    // Sessions from before a metric existed have no entry for it.
    const xs = ss.map((s) => s.metrics[key] ?? null);
    return xs.length && xs.every((x): x is number => x !== null) ? xs : null;
  };

  const sides: LspSideSummary[] = input.sides.map((info) => {
    const { label, role } = info;
    const all = sessions.filter((s) => s.side === label);
    const mine = accepted.map((ss) => ss.find((s) => s.side === label)!);
    const outcomes: Partial<Record<Outcome, number>> = {};
    for (const s of all) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
    const metrics: Partial<Record<MetricKey, Interval | null>> = {};
    for (const { key } of metricsHere) {
      const xs = values(mine, key);
      metrics[key] = xs ? medianInterval(xs, confidence) : null;
    }
    return {
      label,
      role,
      mode: modeOf(info),
      sessions: mine.length,
      failures: all.filter(failed).length,
      outcomes,
      requests: mine.reduce((t, s) => t + s.counts.requests, 0),
      errors: mine.reduce((t, s) => t + s.counts.errors, 0),
      cancelled: mine.reduce((t, s) => t + s.counts.cancelled, 0),
      ...(countsHere("errfixMissed") ? { errfixMissed: mine.reduce((t, s) => t + (s.counts.errfixMissed ?? 0), 0) } : {}),
      ...(countsHere("importsMissed") ? { importsMissed: mine.reduce((t, s) => t + (s.counts.importsMissed ?? 0), 0) } : {}),
      metrics,
    };
  });

  const candidates: LspCandidateSummary[] = input.sides
    .filter((s) => s.role === "cand")
    .map((info) => {
      const { label } = info;
      const ref = refFor(input.sides, info);
      const anyFailed = sessions.some((s) => (s.side === label || s.side === ref.label) && failed(s));
      const state: CandidateState = anyFailed ? "failed" : accepted.length < input.minRounds ? "noisy" : "measured";
      const metrics: LspCandidateSummary["metrics"] = {};
      for (const { key, unit, compare } of metricsHere) {
        if (compare === false) continue;
        const pairs = accepted.map((ss) => [ss.find((s) => s.side === ref.label)!.metrics[key] ?? null, ss.find((s) => s.side === label)!.metrics[key] ?? null] as const);
        const ok = pairs.length > 0 && pairs.every(([r, c]) => r !== null && r > 0 && c !== null);
        const ratio = ok ? medianInterval(pairs.map(([r, c]) => c! / r!), confidence) : null;
        const same = sameWithin(resolution.relative, unit === "ms" ? resolution.floorMs : 0, ok ? median(pairs.map(([r]) => r!)) : null);
        metrics[key] = { ratio, call: state === "measured" && ratio ? callOf(ratio, { confidence, same }) : null, sameWithin: same };
      }
      return { label, ref: ref.label, mode: modeOf(info), state, metrics };
    });

  const lags = sessions.filter((s) => !s.warmup).map((s) => s.counts.lagP95Ms).filter((x): x is number => x !== null);
  return {
    schema: "parallax.lsp-bench-summary/1",
    canaryBaselineMs: baseline,
    rounds: { planned: plan.runs, max: plan.maxRuns, attempts: counts.attempts, accepted: accepted.length, rejected: counts.rejected, failed: counts.failed },
    minRounds: input.minRounds,
    confidence,
    resolution,
    gates: input.gates,
    rejections: counts.rejections,
    usage: input.usage,
    memory: input.memory,
    harnessLagP95Ms: lags.length ? Math.max(...lags) : null,
    sides,
    candidates,
    settled: candidates.every(
      (c) => c.state === "failed" || Object.values(c.metrics).every((m) => !m || m.ratio === null || (m.call !== null && SETTLED.includes(m.call))),
    ),
    clean: candidates.every((c) => c.state === "measured"),
  };
}
