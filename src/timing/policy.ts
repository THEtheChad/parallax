// `--fail-on`: a CI policy evaluated on a summary after measuring, kept apart from whether the
// measurement itself was clean.
//
// A bench that ran cleanly reports MEASURED and exits 0 whatever it found: a candidate 30% slower, or
// one whose every output differs from the reference's. That is right for a measurement and wrong for a
// gate. A policy names what should fail the build; the exit status then says which of the two failed:
//
//   0  measured cleanly, and the policy (if any) passed
//   1  not measured cleanly (the policy is reported, but a measurement that is not clean decides)
//   2  usage or harness error
//   3  measured cleanly, and the policy failed
//
// A policy only reads the calls a summary already made; it never changes how they are made.

import type { BenchSummary } from "./summary.ts";
import { METRICS, type LspBenchSummary } from "./lspSummary.ts";
import { SETTLED, type Interval } from "./stats.ts";
import { ratio } from "../report/common.ts";

const METRIC_MEASURE = new Map(METRICS.filter((m) => m.measure).map((m) => [m.key as string, m.measure]));

// bench and lsp-bench: `slower`, `output` (bench only), `unresolved`. compare-results: `worse`,
// `unresolved`.
export const BENCH_CONDITIONS = ["slower", "output", "unresolved"] as const;
export const LSP_CONDITIONS = ["slower", "unresolved"] as const;
export const COMPARE_CONDITIONS = ["worse", "unresolved"] as const;
export type Condition = (typeof BENCH_CONDITIONS)[number] | (typeof COMPARE_CONDITIONS)[number];

export interface Policy {
  conditions: Condition[];
  // `slower` / `worse` fail only when the ratio's whole interval is above this (1.10: surely more than
  // 10% slower). null: any slower or worse call fails.
  threshold: number | null;
  // lsp-bench and compare-results: the metric keys `slower`, `worse` and `unresolved` look at. null: all.
  metrics: string[] | null;
}

export interface PolicyFailure {
  condition: Condition;
  candidate: string;
  metric: string | null;
  reason: string;
}

export interface PolicyDecision {
  policy: Policy;
  passed: boolean;
  failures: PolicyFailure[];
}

export const EXIT_POLICY_FAILED = 3;

export class PolicyError extends Error {}

// The keys of metrics lsp-bench compares by ratio (the ones a policy can look at).
export const COMPARED_METRICS: readonly string[] = METRICS.filter((m) => m.compare !== false).map((m) => m.key);

export interface PolicyText {
  failOn?: string | undefined;
  threshold?: string | undefined;
  metrics?: string | undefined;
}

// Parses --fail-on, --fail-threshold and --fail-metrics for one kind of report. Checked before a
// bench runs: a policy that cannot apply should fail at once, not after half an hour of rounds.
export function parsePolicy(t: PolicyText, kind: "cli-bench" | "lsp-bench" | "compare-cli-bench" | "compare-lsp-bench"): Policy | null {
  if (t.failOn === undefined) {
    if (t.threshold !== undefined || t.metrics !== undefined) throw new PolicyError(`${t.threshold !== undefined ? "--fail-threshold" : "--fail-metrics"} needs --fail-on`);
    return null;
  }
  const allowed: readonly string[] = kind === "cli-bench" ? BENCH_CONDITIONS : kind === "lsp-bench" ? LSP_CONDITIONS : COMPARE_CONDITIONS;
  const conditions = [...new Set(t.failOn.split(",").map((x) => x.trim()).filter(Boolean))];
  if (!conditions.length) throw new PolicyError("--fail-on wants a comma-separated list of conditions");
  for (const c of conditions)
    if (!allowed.includes(c)) {
      const why = c === "output" && kind === "lsp-bench" ? " (lsp-bench times servers; lsp-diff compares their answers)" : "";
      throw new PolicyError(`--fail-on ${JSON.stringify(c)} does not apply here${why}: use ${allowed.join(", ")}`);
    }
  let threshold: number | null = null;
  if (t.threshold !== undefined) {
    threshold = Number(t.threshold);
    if (!Number.isFinite(threshold) || threshold < 1) throw new PolicyError("--fail-threshold wants a ratio of at least 1 (1.10: fail only when surely more than 10% slower)");
    if (!conditions.includes("slower") && !conditions.includes("worse")) throw new PolicyError("--fail-threshold applies to --fail-on slower (or worse)");
  }
  let metrics: string[] | null = null;
  if (t.metrics !== undefined) {
    if (kind === "compare-cli-bench" || kind === "compare-lsp-bench") throw new PolicyError("compare-results narrows the metrics it compares, and so the policy, with --metrics");
    if (kind === "cli-bench") throw new PolicyError("--fail-metrics applies to lsp-bench only (a CLI bench calls one metric, wall time)");
    metrics = parseMetricKeys(t.metrics, "--fail-metrics");
  }
  return { conditions: conditions as Condition[], threshold, metrics };
}

// A comma-separated list of compared lsp-bench metric keys.
export function parseMetricKeys(text: string, option: string): string[] {
  const keys = [...new Set(text.split(",").map((x) => x.trim()).filter(Boolean))];
  if (!keys.length) throw new PolicyError(`${option} wants a comma-separated list of metric keys`);
  const unknown = keys.filter((k) => !COMPARED_METRICS.includes(k));
  if (unknown.length) throw new PolicyError(`${option}: unknown or uncompared metric ${unknown.map((k) => JSON.stringify(k)).join(", ")}; metrics compared by ratio: ${COMPARED_METRICS.join(", ")}`);
  return keys;
}

// Calls more rounds would not change (stats.ts SETTLED, and compare-results' names for them).
const DECIDED: ReadonlySet<string> = new Set<string>([...SETTLED, "better", "worse"]);

const ratioText = (i: Interval): string => `${ratio(i.estimate)} (${ratio(i.low)}..${ratio(i.high)})`;
// As the report words it: CPU and memory are higher, not slower.
const callWord = (call: string, metric: string | null): string =>
  call === "slower" && metric !== null && METRIC_MEASURE.get(metric) ? "higher" : call;

// One comparison's call under the policy. `slow` is the condition and `slowCall` the call that means
// slower: `slower` in a bench, `worse` in compare-results.
function judge(
  policy: Policy,
  slow: Condition,
  c: { candidate: string; metric: string | null; metricLabel: string; call: string | null; ratio: Interval | null; state: string },
  slowCall: string,
): PolicyFailure[] {
  const out: PolicyFailure[] = [];
  const at = { candidate: c.candidate, metric: c.metric };
  if (policy.conditions.includes(slow) && c.call === slowCall && c.ratio) {
    const word = callWord(slowCall, c.metric);
    if (policy.threshold === null) out.push({ condition: slow, ...at, reason: `${c.metricLabel} ${word}: ${ratioText(c.ratio)}` });
    else if (c.ratio.low > policy.threshold)
      out.push({ condition: slow, ...at, reason: `${c.metricLabel} ${word}: ${ratioText(c.ratio)}, all of it above ${ratio(policy.threshold)}` });
  }
  if (policy.conditions.includes("unresolved")) {
    if (c.state !== "measured" && c.state !== "failed") out.push({ condition: "unresolved", ...at, reason: `${c.metricLabel}: ${c.state}` });
    else if (c.state === "measured" && c.call !== null && !DECIDED.has(c.call))
      out.push({ condition: "unresolved", ...at, reason: `${c.metricLabel} ${c.call}${c.ratio ? `: ${ratioText(c.ratio)}` : ""}` });
  }
  return out;
}

const decision = (policy: Policy, failures: PolicyFailure[]): PolicyDecision => ({ policy, passed: !failures.length, failures });

export function evaluateBenchPolicy(s: BenchSummary, policy: Policy): PolicyDecision {
  const failures: PolicyFailure[] = [];
  for (const c of s.candidates)
    failures.push(...judge(policy, "slower", { candidate: c.label, metric: null, metricLabel: "wall", call: c.call, ratio: c.wallRatio, state: c.state }, "slower"));
  if (policy.conditions.includes("output")) {
    // The exit code counts as output here, though it is compared on its own: scripts and CI read it.
    const ref = s.sides.find((x) => x.role === "ref" && x.exitMatchesRef === null);
    const codes = (x: { exitCodes: (number | null)[] }): string => x.exitCodes.map((c) => (c === null ? "none" : String(c))).join(", ");
    for (const x of s.sides) {
      const at = { condition: "output" as const, candidate: x.label, metric: null };
      if (!x.outputStable) failures.push({ ...at, reason: `output UNSTABLE: ${x.outputs} different outputs over its runs` });
      else if (x.outputMatchesRef === false) failures.push({ ...at, reason: "output DIFFERENT from the reference's" });
      if (x.exitCodes.length > 1) failures.push({ ...at, reason: `exit code UNSTABLE: ${codes(x)} over its runs` });
      else if (x.exitMatchesRef === false) failures.push({ ...at, reason: `exit code ${codes(x)}${ref ? `, the reference's ${codes(ref)}` : ", not the reference's"}` });
    }
  }
  return decision(policy, failures);
}

export function evaluateLspPolicy(s: LspBenchSummary, policy: Policy): PolicyDecision {
  const failures: PolicyFailure[] = [];
  const keys = policy.metrics ?? COMPARED_METRICS;
  for (const c of s.candidates) {
    // A candidate that is not measured has no calls at all: one failure for it, not one per metric.
    if (c.state !== "measured") {
      failures.push(...judge(policy, "slower", { candidate: c.label, metric: null, metricLabel: "every metric", call: null, ratio: null, state: c.state }, "slower"));
      continue;
    }
    for (const key of keys) {
      const m = c.metrics[key as keyof typeof c.metrics];
      if (!m || !m.ratio) continue;
      const label = METRICS.find((x) => x.key === key)?.label ?? key;
      failures.push(...judge(policy, "slower", { candidate: c.label, metric: key, metricLabel: label, call: m.call, ratio: m.ratio, state: c.state }, "slower"));
    }
  }
  // A gate on a metric this run did not measure (a phase skipped, a bundle from before the metric
  // existed) would pass forever without judging anything: that fails.
  const measured = s.candidates.filter((c) => c.state === "measured");
  if (policy.metrics && measured.length)
    for (const key of policy.metrics)
      if (!measured.some((c) => c.metrics[key as keyof typeof c.metrics]?.ratio))
        failures.push({ condition: policy.conditions[0]!, candidate: "*", metric: key, reason: `--fail-metrics ${key}: not measured in this run, so the gate cannot judge it` });
  return decision(policy, failures);
}

// compare-results: one row per candidate and metric (see commands/compareResults.ts).
export interface ComparedRow {
  label: string;
  metric: string;
  metricLabel: string;
  // "compared", or why not: "noisy in old", "failed in new", ...
  state: string;
  call: string | null;
  shift: Interval | null;
}

export function evaluateComparePolicy(rows: readonly ComparedRow[], policy: Policy): PolicyDecision {
  const failures: PolicyFailure[] = [];
  for (const r of rows) {
    if (policy.metrics && r.metric !== "wall" && !policy.metrics.includes(r.metric)) continue;
    // A candidate that was not measured cleanly in either run could not be compared: that is unresolved.
    // A metric one run did not measure (a phase skipped) is no comparison; anything else not compared
    // (noisy, failed, a ratio of 0) is unresolved.
    const state = r.state === "compared" ? "measured" : r.state.startsWith("not measured") ? "skip" : `not compared (${r.state})`;
    if (state === "skip") continue;
    failures.push(...judge(policy, "worse", { candidate: r.label, metric: r.metric, metricLabel: r.metricLabel, call: r.call, ratio: r.shift, state }, "worse"));
  }
  // Nothing compared (every row a metric one run did not measure): a gate that judged nothing fails.
  if (!rows.some((r) => r.state === "compared")) failures.push({ condition: policy.conditions[0]!, candidate: "*", metric: null, reason: "nothing was compared, so the gate judged nothing" });
  return decision(policy, failures);
}

// The exit status: a measurement that is not clean wins over the policy (1), then the policy (3).
export const exitStatus = (clean: boolean, d: PolicyDecision | null): number => (!clean ? 1 : d && !d.passed ? EXIT_POLICY_FAILED : 0);

// The decision as text: what was asked, the outcome, and each failing candidate and metric with why.
export function renderDecision(d: PolicyDecision, clean = true): string {
  const p = d.policy;
  const asked = `--fail-on ${p.conditions.join(",")}${p.threshold !== null ? ` --fail-threshold ${p.threshold}` : ""}${p.metrics ? ` --fail-metrics ${p.metrics.join(",")}` : ""}`;
  const outcome = d.passed ? "passed" : `FAILED (${d.failures.length} ${d.failures.length === 1 ? "failure" : "failures"})`;
  const exit = !clean ? "; exit 1: not measured cleanly, which decides before the policy" : d.passed ? "" : `; exit ${EXIT_POLICY_FAILED}`;
  const out = [`policy ${asked}: ${outcome}${exit}`];
  for (const f of d.failures) out.push(`  ${f.condition.padEnd(10)} ${f.candidate}: ${f.reason}`);
  return out.join("\n");
}
