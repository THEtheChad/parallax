// Compares a bundle's runs. A pure function of runs/ and bundle.json: it writes verdicts.jsonl,
// summary.json and differences/, and can be rerun at any time (e.g. after a normalization change).
//
// Memory stays bounded by the number of requests, not the size of answers: pass 1 streams every run
// and keeps two hashes per answer (base normalization; base + library locations); pass 2 re-reads,
// by byte range, only the answers that differ, one pair at a time, to write their details.
//
// Reference evidence: other bundles of the same reference binary (sha256 and env), corpus (commit and
// working-tree status) and session definition. Their reference runs are rescanned with this
// normalizer, and every answer variant they hold counts as a reference variant: a variant seen once
// stays seen. An incompatible bundle is rejected and recorded with the reason.
//
// Verdicts, per request identity and candidate side:
//   match          equal to the (stable) reference under base normalization
//   normalized     equal only once library-file locations are mapped (profile libraryFiles)
//   differ         not equal: a candidate difference to triage
//   ref-unstable   the reference runs disagree with each other (or only some asked it), or the same
//                  reference binary answered otherwise in an evidence bundle (--ref-evidence); never
//                  blamed on the candidate. `refMatch` says whether the candidate equals a reference variant
//   cand-unstable  the candidate's own runs disagree with each other
//   only-ref       the reference asked it and a cleanly finished candidate run did not
//   only-cand      a candidate asked it and no reference run did
//   not-reached    the candidate run ended (crash, timeout) before it

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import type { Bundle, RunRecord, SideRecord } from "../bundle/bundle.ts";
import { readBundle, writeJsonAtomic } from "../bundle/bundle.ts";
import { JsonlWriter, readLines, readRange } from "../bundle/lines.ts";
import { parseExact } from "../json/exact.ts";
import { describeDifference } from "./describe.ts";
import { IdentityCounter, mergeOrder, orderBreak } from "./identity.ts";
import { answerOf, lookFor, makeNormalizer, normalizeValue, NORMALIZE_RULES, NORMALIZE_VERSION, type Normalizer } from "./normalize.ts";

export const VERDICTS = ["match", "normalized", "differ", "ref-unstable", "cand-unstable", "only-ref", "only-cand", "not-reached"] as const;
export type Verdict = (typeof VERDICTS)[number];
// Verdicts that need a person's (or a later referee's) attention.
export const ATTENTION: ReadonlySet<Verdict> = new Set(["differ", "cand-unstable", "only-ref", "only-cand"]);

interface AnswerRef {
  hb: string;
  hl: string;
  offset: number;
  length: number;
  ms: number;
}

interface Entry {
  step: string;
  method: string;
  byRun: Map<string, AnswerRef>;
}

interface EndRecord {
  outcome: string;
  error?: string;
  exit?: unknown;
  crashSignals?: string[];
  answers?: number;
  shutdownClean?: boolean;
}

interface RunScan {
  run: RunRecord;
  keys: string[];
  end: EndRecord | null;
  // The run got through the whole script: absent keys were not asked, rather than not reached.
  finished: boolean;
}

export interface CandidateSummary {
  label: string;
  totals: Record<Verdict, number>;
  byMethod: Record<string, Partial<Record<Verdict, number>>>;
  refUnstableMatchingARefRun: number;
  attention: { key: string; step: string; method: string; verdict: Verdict; detail: string | null }[];
}

export interface EvidenceRecord {
  bundle: string;
  accepted: boolean;
  reason?: string;
  refRuns: string[];
}

export interface CompareOptions {
  log?: (msg: string) => void;
  // Bundle directories whose reference answers count as reference variants.
  refEvidence?: string[];
}

export interface Summary {
  normalization: { version: string; rules: readonly string[] };
  requests: number;
  refRuns: string[];
  refEvidence: EvidenceRecord[];
  refUnstable: number;
  // Of refUnstable: requests the reference answered alike in this bundle but otherwise in evidence.
  refUnstableFromEvidence: number;
  sessions: {
    run: string;
    side: string;
    role: string;
    outcome: string;
    answers: number;
    error?: string;
    crashSignals?: string[];
    // null for imported runs (no shutdown was recorded).
    shutdownClean: boolean | null;
    orderBreak: string | null;
  }[];
  candidates: CandidateSummary[];
  // Attention items across candidates, plus unclean sessions.
  clean: boolean;
}

const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

const libThenBase = (n: Normalizer): [string, string][] => [...n.lib, ...n.base];

async function scanRun(bundleDir: string, run: RunRecord, side: SideRecord, root: string, entries: Map<string, Entry>): Promise<RunScan> {
  const n = makeNormalizer(root, side.lib ?? undefined);
  const both = libThenBase(n);
  const counter = new IdentityCounter(both);
  const keys: string[] = [];
  let end: EndRecord | null = null;
  for await (const line of readLines(join(bundleDir, run.file))) {
    const rec = parseExact(line.text) as { type?: string; step?: string; method?: string; params?: unknown; ms?: number; response?: { result?: unknown; error?: unknown } };
    if (rec.type === "end") {
      end = rec as unknown as EndRecord;
      continue;
    }
    if (rec.type !== "answer") continue;
    const step = rec.step!;
    const method = rec.method!;
    const key = counter.next(step, method, rec.params);
    const ans = answerOf(rec.response);
    const hb = hash(normalizeValue(ans, n.base, method));
    const hl = lookFor(n.lib, line.text) ? hash(normalizeValue(ans, both, method)) : hb;
    let e = entries.get(key);
    if (!e) entries.set(key, (e = { step, method, byRun: new Map() }));
    e.byRun.set(run.id, { hb, hl, offset: line.offset, length: line.length, ms: rec.ms ?? NaN });
    keys.push(key);
  }
  const outcome = end?.outcome ?? run.outcome ?? "error";
  return { run, keys, end, finished: outcome === "clean" || outcome === "imported" };
}

const distinct = (xs: string[]): number => new Set(xs).size;

// Why `other` cannot serve as reference evidence for `b`, or null.
export function evidenceProblem(b: Bundle, other: Bundle): string | null {
  const ref = b.sides.find((s) => s.role === "ref");
  const oref = other.sides.find((s) => s.role === "ref");
  if (!ref || !oref) return "no reference side";
  if (oref.binSha256 !== ref.binSha256) return "another reference binary";
  if (JSON.stringify(oref.env.set) !== JSON.stringify(ref.env.set)) return "another reference environment";
  if (other.corpus.gitCommit !== b.corpus.gitCommit) return "another corpus commit";
  if (other.corpus.statusSha256Before !== b.corpus.statusSha256Before) return "another corpus working tree";
  const [s, o] = [b.session, other.session];
  if (s.script !== o.script || s.positions !== o.positions || s.typed !== o.typed || s.initializeSha256 !== o.initializeSha256 || JSON.stringify(s.files) !== JSON.stringify(o.files))
    return "another session definition";
  return null;
}

interface Variants {
  hb: Set<string>;
  hl: Set<string>;
}

async function loadEvidence(bundle: Bundle, dirs: string[], log: (msg: string) => void): Promise<{ records: EvidenceRecord[]; variants: Map<string, Variants> }> {
  const records: EvidenceRecord[] = [];
  const variants = new Map<string, Variants>();
  for (const dir of dirs) {
    let other: Bundle;
    try {
      other = readBundle(dir);
    } catch (e) {
      records.push({ bundle: dir, accepted: false, reason: (e as Error).message, refRuns: [] });
      continue;
    }
    const problem = evidenceProblem(bundle, other);
    const refRuns = other.runs.filter((r) => r.role === "ref");
    records.push({ bundle: dir, accepted: problem === null, ...(problem ? { reason: problem } : {}), refRuns: refRuns.map((r) => r.id) });
    if (problem) {
      log(`reference evidence ${dir} rejected: ${problem}`);
      continue;
    }
    const side = other.sides.find((s) => s.role === "ref")!;
    const entries = new Map<string, Entry>();
    for (const run of refRuns) await scanRun(dir, run, side, other.corpus.root, entries);
    for (const [key, e] of entries) {
      const v = variants.get(key) ?? { hb: new Set<string>(), hl: new Set<string>() };
      for (const a of e.byRun.values()) {
        v.hb.add(a.hb);
        v.hl.add(a.hl);
      }
      variants.set(key, v);
    }
    log(`reference evidence ${dir}: ${refRuns.length} runs, ${entries.size} requests`);
  }
  return { records, variants };
}

export async function compareBundle(bundleDir: string, bundle: Bundle, opts: CompareOptions = {}): Promise<Summary> {
  const log = opts.log ?? (() => {});
  const root = bundle.corpus.root;
  const sideByLabel = new Map(bundle.sides.map((s) => [s.label, s]));
  const evidence = await loadEvidence(bundle, opts.refEvidence ?? [], log);
  const entries = new Map<string, Entry>();
  const scans: RunScan[] = [];
  // Reference runs first, so the merged order follows the reference.
  const runs = [...bundle.runs].sort((a, b) => (a.role === b.role ? 0 : a.role === "ref" ? -1 : 1));
  for (const run of runs) {
    const side = sideByLabel.get(run.side);
    if (!side) throw new Error(`run ${run.id}: no side ${run.side}`);
    const t0 = performance.now();
    scans.push(await scanRun(bundleDir, run, side, root, entries));
    log(`scanned ${run.id}: ${scans.at(-1)!.keys.length} answers in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  const order = mergeOrder(scans.map((s) => s.keys));
  const stepOf = (k: string): string => entries.get(k)!.step;
  const refScans = scans.filter((s) => s.run.role === "ref");
  const candLabels = bundle.sides.filter((s) => s.role === "cand").map((s) => s.label);
  const candScans = new Map(candLabels.map((l) => [l, scans.filter((s) => s.run.side === l)]));

  const summaries = new Map<string, CandidateSummary>(
    candLabels.map((l) => [
      l,
      { label: l, totals: Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>, byMethod: {}, refUnstableMatchingARefRun: 0, attention: [] },
    ]),
  );
  const detailJobs: { cand: string; key: string; verdict: Verdict; file: string }[] = [];
  let refUnstable = 0;
  let refUnstableFromEvidence = 0;

  rmSync(join(bundleDir, "verdicts.jsonl"), { force: true });
  rmSync(join(bundleDir, "differences"), { recursive: true, force: true });
  const out = new JsonlWriter(join(bundleDir, "verdicts.jsonl"));
  for (const key of order) {
    const e = entries.get(key)!;
    const refPresent = refScans.filter((s) => e.byRun.has(s.run.id));
    const refAbsentFinished = refScans.filter((s) => !e.byRun.has(s.run.id) && s.finished);
    const refHb = refPresent.map((s) => e.byRun.get(s.run.id)!.hb);
    const refHl = new Set(refPresent.map((s) => e.byRun.get(s.run.id)!.hl));
    const ev = refPresent.length ? evidence.variants.get(key) : undefined;
    const evidenceOnly = ev ? [...ev.hb].some((h) => !refHb.includes(h)) : false;
    for (const h of ev?.hl ?? []) refHl.add(h);
    const unstableHere = distinct(refHb) > 1 || refAbsentFinished.length > 0;
    const refState = !refPresent.length ? "none" : unstableHere || evidenceOnly ? "unstable" : "stable";
    if (refState === "unstable") refUnstable++;
    if (refState === "unstable" && !unstableHere) refUnstableFromEvidence++;
    const verdicts: Record<string, Verdict> = {};
    const refMatch: Record<string, boolean> = {};
    for (const label of candLabels) {
      const cs = candScans.get(label)!;
      const present = cs.filter((s) => e.byRun.has(s.run.id));
      let v: Verdict;
      if (!present.length) {
        if (refState === "none") continue; // another candidate's request
        v = refState === "unstable" ? "ref-unstable" : cs.every((s) => !s.finished) ? "not-reached" : "only-ref";
      } else {
        const hb = present.map((s) => e.byRun.get(s.run.id)!.hb);
        const absentFinished = cs.filter((s) => !e.byRun.has(s.run.id) && s.finished);
        const first = e.byRun.get(present[0]!.run.id)!;
        if (distinct(hb) > 1 || absentFinished.length) v = "cand-unstable";
        else if (refState === "none") v = "only-cand";
        else if (refState === "unstable") {
          v = "ref-unstable";
          refMatch[label] = refHl.has(first.hl);
          if (refMatch[label]) summaries.get(label)!.refUnstableMatchingARefRun++;
        } else if (first.hb === refHb[0]) v = "match";
        else if (refHl.has(first.hl)) v = "normalized";
        else v = "differ";
      }
      verdicts[label] = v;
      const sum = summaries.get(label)!;
      sum.totals[v]++;
      const m = (sum.byMethod[e.method] ??= {});
      m[v] = (m[v] ?? 0) + 1;
      if (ATTENTION.has(v)) {
        const file = posix.join("differences", label, `${String(sum.attention.length + 1).padStart(4, "0")}.json`);
        sum.attention.push({ key, step: e.step, method: e.method, verdict: v, detail: file });
        detailJobs.push({ cand: label, key, verdict: v, file });
      }
    }
    const hashes = Object.fromEntries([...e.byRun].map(([run, a]) => [run, a.hb.slice(0, 16)]));
    await out.write({
      key,
      step: e.step,
      method: e.method,
      ref: refState,
      ...(evidenceOnly ? { refEvidence: true } : {}),
      verdicts,
      ...(Object.keys(refMatch).length ? { refMatch } : {}),
      hashes,
    });
  }
  await out.close();

  // Pass 2: details, one pair of answers in memory at a time.
  const runById = new Map(bundle.runs.map((r) => [r.id, r]));
  const read = async (runId: string, a: AnswerRef): Promise<unknown> => {
    const r = runById.get(runId)!;
    const n = makeNormalizer(root, sideByLabel.get(r.side)!.lib ?? undefined);
    const rec = parseExact(await readRange(join(bundleDir, r.file), a.offset, a.length)) as { params?: unknown; response?: { result?: unknown; error?: unknown }; method?: string };
    return { params: normalizeValue(rec.params, libThenBase(n)), answer: normalizeValue(answerOf(rec.response), libThenBase(n), rec.method) };
  };
  for (const job of detailJobs) {
    const e = entries.get(job.key)!;
    const refRun = refScans.map((s) => s.run.id).find((id) => e.byRun.has(id));
    const candRun = candScans.get(job.cand)!.map((s) => s.run.id).find((id) => e.byRun.has(id));
    const ref = refRun ? ((await read(refRun, e.byRun.get(refRun)!)) as { params: unknown; answer: unknown }) : null;
    const cand = candRun ? ((await read(candRun, e.byRun.get(candRun)!)) as { params: unknown; answer: unknown }) : null;
    mkdirSync(join(bundleDir, "differences", job.cand), { recursive: true });
    writeJsonAtomic(join(bundleDir, job.file), {
      key: job.key,
      step: e.step,
      method: e.method,
      verdict: job.verdict,
      params: (ref ?? cand)!.params,
      ref: refRun ? { run: refRun, ms: e.byRun.get(refRun)!.ms } : null,
      cand: candRun ? { run: candRun, ms: e.byRun.get(candRun)!.ms } : null,
      ...describeDifference(e.method, ref?.answer, cand?.answer),
    });
  }

  const sessions = scans.map((s) => ({
    run: s.run.id,
    side: s.run.side,
    role: s.run.role,
    outcome: s.end?.outcome ?? s.run.outcome ?? "error",
    answers: s.keys.length,
    ...(s.end?.error ? { error: s.end.error } : {}),
    ...(s.end?.crashSignals?.length ? { crashSignals: s.end.crashSignals } : {}),
    shutdownClean: s.end?.shutdownClean ?? null,
    orderBreak: orderBreak(order, s.keys, stepOf),
  }));
  const candidates = [...summaries.values()];
  const summary: Summary = {
    normalization: { version: NORMALIZE_VERSION, rules: NORMALIZE_RULES },
    requests: order.length,
    refRuns: refScans.map((s) => s.run.id),
    refEvidence: evidence.records,
    refUnstable,
    refUnstableFromEvidence,
    sessions,
    candidates,
    clean: candidates.every((c) => !c.attention.length) && sessions.every((s) => (s.outcome === "clean" || s.outcome === "imported") && s.shutdownClean !== false && !s.orderBreak),
  };
  writeJsonAtomic(join(bundleDir, "summary.json"), summary);
  return summary;
}
