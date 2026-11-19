# parallax

Parity, performance and gating harness for TypeScript compilers and language servers.

Parallax checks a candidate compiler or language server against a reference (today: tsc 7, the Go
port) for identical output, then measures speed. It is binary-agnostic: everything specific to one
product lives in a profile, and every result is an evidence bundle that reports are rendered from.

Status: early. What exists is the language-server answer diff (`lsp-diff`), the command-line check
timer (`bench`) and the language-server timer (`lsp-bench`).

## Setup

Node 24 (see `.node-version`; `fnm use`), pnpm (pinned in `package.json`):

```sh
pnpm install
pnpm check        # type-check and tests
```

Node runs the TypeScript sources directly (type stripping); there is no build step.

## Answer diff

```sh
pnpm parallax lsp-diff --project <dir> \
  --ref tsc7=<tsc7-binary> \
  --cand tsrs=<tsrs-binary> --cand tsc-rs-fork=<fork-binary> \
  --out <bundle-dir>
```

Runs one scripted editor session (open files; diagnostics, tokens, hints, symbols, folding; hover,
definition, references, rename and more at picked positions; completions while typing a line) against
the reference twice and each candidate once, one server at a time, and compares every answer.

- `--files 6 --positions 4` pick how much of the project the session covers; `--file <rel>` picks files.
- `--ref-runs 2` reference runs: answers where the reference disagrees with itself are
  `ref-unstable` and never blamed on a candidate. `--cand-runs 2` also checks candidate stability.
- Exit status 0 when clean, 1 with differences or an unclean session, 2 on errors.

`parallax compare <bundle>` recomputes the verdicts from the raw answers; `parallax summary <bundle>`
prints them again.

### Verdicts

| verdict | meaning |
| --- | --- |
| `match` | equal to the reference |
| `normalized` | equal once library-file locations are mapped (`bundled:///libs/` vs a `file://` path) |
| `differ` | a candidate difference to triage |
| `ref-unstable` | the reference runs disagree with each other |
| `cand-unstable` | the candidate's runs disagree with each other |
| `only-ref` / `only-cand` | one side asked a request the other never did (scripts branch on answers) |
| `not-reached` | the candidate run ended (crash, timeout) before this request |

Comparison ignores only what must differ between runs: the project root path, object key order,
completion item order, and (as `normalized`) library-file locations. Numbers keep their exact text.

### Bundles

```
bundle.json        sides (profile, binary path and sha256, version, env changes), host and load,
                   corpus commit and git status, session definition, normalization rules, runs
runs/<run>.jsonl   one line per answer as it arrived (the server's exact response), plus start,
                   initialize and end (outcome, exit, crash signatures, notification counts)
verdicts.jsonl     one line per request: verdict per candidate, answer hash per run
summary.json       counts per candidate, method and verdict; sessions; items needing attention
differences/       one file per difference: completion items only on one side, or the JSON paths
                   that differ (with both answers when small)
```

Answers are streamed to disk and compared by hash, so a session's size is bounded by the disk, not
by memory.

## Timing checks

```sh
pnpm parallax bench --project <dir> --config tsconfig.json \
  --ref tsc7=<tsc7-binary> --cand tsrs=<tsrs-binary> --cand tsc-rs-fork=<fork-binary> \
  --out <bundle-dir>
```

Times each side's `check` command (from its profile) on one project, in rounds: wait for an idle
machine, time a canary, run every side once in alternating order, time the canary again, and reject
the round if other programs used the CPU or the machine changed speed. Each side runs as it chooses
and single-threaded (`--threads both|default|single`); candidates are compared with the reference
in the same mode by their per-round time ratio, with distribution-free intervals. The bench runs
`--runs` (6) rounds, then more while any call is unsettled, up to `--max-runs` (15). Where `perf`
works it also counts instructions and cycles in separate untimed runs, after checking that each event
really counts. Commands run in a sealed environment (`--env sealed`, the default; `--pass-env NAME`
adds a variable), optionally pinned to cores (`--pin 2-5`, Linux).

`parallax calibrate --kind bench --side tsc7=<tsc7-binary> --project <dir> --out <bundle-dir>`
benches one binary against itself to measure this machine's noise floor; later benches on the same
setup warn when `--resolution` is below it.

The output starts with any warnings about the run (no noise calibration, on battery, a lowered
priority...; kept in the bundle's notes), then a table of sides (wall time, CPU, peak memory in MiB,
exit code, whether the output matches the reference), a table of candidates (ratio, interval, call:
`faster`, `slower`, `same ±r`, `same (within 1 ms)` where the millisecond floor decided it,
`unresolved` or `too few rounds`), each implementation's parallel speedup, and the counters. The
last line is the verdict: `MEASURED`, with what it does not cover (calls that could still change
with more rounds; candidates whose output differs from the reference, so their times are of other
work), or `NOT MEASURED CLEANLY`. `lsp-bench` calls a CPU or memory metric `lower` or `higher`, a
time `faster` or `slower`.

**[docs/measurement.md](docs/measurement.md) is the method**: what disturbs a measurement and how
each disturbance is handled, the statistics behind a call, what the counters are for, and what works
on which OS.

`parallax bench-summary <bundle-dir>` recomputes the summary from `samples.jsonl`, which keeps every
sample and round, rejected ones included; other gates can be tried after the fact.

### Report formats

`bench`, `lsp-bench`, `calibrate`, `bench-summary` and `summary` take `--format`:

| format | stdout |
| --- | --- |
| `text` (default) | the report for a terminal |
| `md` | the same content as GitHub-flavoured Markdown (headings, tables, warnings as a blockquote), for a PR comment or `$GITHUB_STEP_SUMMARY` |
| `json` | the summary object itself (`calibrate`: the calibration), as in `summary.json` |
| `csv` | one row per figure (below) |

The log (progress, the bundle's path) always goes to stderr, so `--format json > summary.json` or
`--format md >> "$GITHUB_STEP_SUMMARY"` captures only the report.

**CSV.** A bench or lsp-bench CSV is long-format: every row has the columns `kind, label, vs, metric,
unit, n, value, low, high, ref_value, ratio, ratio_low, ratio_high, confidence, call, same_within,
state, spread`, empty where one does not apply. Numbers are raw (ms, bytes, counts; fractions, not
percents), calls are the stored ones (`faster`/`slower` for every metric). Kinds:

- `side`: a side's median of a metric (`value`, interval `low`..`high`, its `confidence`, `n`
  rounds); bench metrics `wall`, `cpu`, `peak_rss`, lsp-bench metrics by key (`open.firstDiagnosticsMs`).
- `comparison`: a candidate (`label`) against its reference (`vs`) on a metric: both medians
  (`value`, `ref_value`), the ratio interval, `call`, `same_within` (the half-width of "same") and the
  candidate's `state`. A metric never compared by ratio has the call `not compared`.
- `speedup` (bench): an implementation's single-threaded / default wall ratio.
- `counter` (bench): a counted run's median (`value`) over `n` runs and its `spread` ((max - min) / median).

`summary` (lsp-diff) writes `candidate, method, verdict, count`, with a `total` method per verdict;
`calibrate` writes `metric, mode, floor, suggested_resolution, call, coverage, ref_median_ms, rounds`.

### summary.json

`summary.json` (and `--format json`) is the machine-readable result, and a contract: fields are only
ever added, never renamed or removed, so a reader written today keeps working (new fields are
optional for readers of older bundles). Each summary names its kind in `schema`:
`parallax.bench-summary/1` or `parallax.lsp-bench-summary/1`. Top-level fields of both:

| field | what |
| --- | --- |
| `canaryBaselineMs` | the fastest canary of the bench, the baseline rounds are judged against |
| `rounds` | `planned`, `max`, `attempts`, `accepted`, `rejected`, `failed` |
| `minRounds` | accepted rounds a comparison needs (`--min-runs`), else `noisy` |
| `confidence` | the confidence a call needed at the last look |
| `resolution` | what "same" means: `relative` (fraction) and `floorMs` |
| `gates`, `rejections` | the round gates, and how many rounds each reason rejected |
| `sides` | per side: its medians with intervals (`estimate`, `low`, `high`, `confidence`, `n`) and counts |
| `candidates` | per candidate: `ref`, `mode`, `state` (`measured`, `noisy`, `failed`), ratio intervals and calls (`sameWithin`: the half-width of "same") |
| `settled` | every call is one more rounds would not change |
| `notes` | the run's warnings, as the report shows them |
| `clean` | every candidate measured (bench: and every output stable): the exit status |

A bench adds `accounting`, `speedups` and `counters`; an lsp-bench adds `usage`, `memory` and
`harnessLagP95Ms`, and its `sides[].metrics` and `candidates[].metrics` are keyed by metric
(`open.firstDiagnosticsMs`, ...; units in `src/timing/lspSummary.ts`, `METRICS`). An lsp-diff
bundle's `summary.json` (no `schema` field) has `requests`, `refRuns`, `sessions`, `candidates`
(`totals` and `byMethod` per verdict, `attention`) and `clean`, under the same rule.

## Timing language servers

```sh
pnpm parallax lsp-bench --project <dir> \
  --ref tsc7=<tsc7-binary> --cand tsrs=<tsrs-binary> --cand tsc-rs-fork=<fork-binary> \
  --out <bundle-dir>
```

Times what someone using an editor waits for, in the same rounds as `bench`. Each round starts every
side's server once and runs one session: **open** (time to first diagnostics), **edit** (the first
request after an edit, which pays for the server's update; CPU per edit), **typing** (open loop: keys
on a fixed schedule, latency from when each key was due, what a user feels), **service** (closed
loop: one request at a time, the server's own time per request), **paused** (keys after quiet, where
background work shows), **errfix** (an error shown and cleared), **imports** (cross-file completion
and the add-import fix) and **long** (a long run of edits: slowdown and memory growth per edit). The files are picked as for
`lsp-diff` (`--files 6`, or `--file <rel>` repeated; the first is edited). Every request of every
session is kept in `runs/<side>.<round>.<attempt>.jsonl`.

## The suite and published results

`suite.json` pins the projects everyone benches, each to a commit, with its install command
(install scripts skipped), so results from different machines measure the same thing.

```sh
pnpm parallax suite list
pnpm parallax suite fetch                # clone and install every project into the suite cache
pnpm parallax suite run --ref tsc7=<tsc7-binary> --cand tsrs=<tsrs-binary> \
  --out <bundles-dir> --publish <results-dir>
```

Fetching needs git, and each project's own package manager: bun for hono, pnpm through corepack for
the others. The cache is `PARALLAX_SUITE_DIR`, else the OS's cache directory.

`parallax publish <bundle-dir> --out <results-dir>` writes a bundle as one result file to publish:
the per-round records, the summary, and provenance (harness commit, each binary's sha256 and version,
the project's repository and commit, the machine's OS, CPU, power state and priority). It leaves out
the hostname (a random machine id, kept in the config directory, groups one machine's results), all
absolute paths, the commands' outputs and the per-request logs. A harness with uncommitted changes
cannot be verified, so publishing from one needs `--allow-dirty`.

`parallax verify-result <file>...` checks that a result is unedited and that its summary is what its
records give.

## Profiles

`profiles/tsc7.json`, `profiles/tsrs.json`, `profiles/tsc-rs-fork.json`. A profile declares the
language-server command (`{bin}` is the bound binary), the check command for `bench` (`{config}` is
`--config`), environment variables to clear or set, how to run it single-threaded
(`singleThreaded`: arguments and environment, for the check and the server separately), the
process model, where bundled library files appear in answers, and crash signatures. Bind one to a
binary on the command line with `<profile>=<binary>` (or `<label>:<profile>=<binary>` to use one
profile twice); a profile can also be a path to a JSON file.

## Importing lspdiff logs

`parallax import-lspdiff --from <out>/<project>-diff --project <dir> --ref tsc7=<bin> --cand <profile>=<bin> --out <bundle>`
turns the `go.jsonl`, `go2.jsonl` and `rs.jsonl` written by the tsc-rs fork's `scripts/lspdiff diff`
into a bundle, to check results against that tool's.

## Contributing

Conventional Commits (`feat(lsp): …`, `fix(diff): …`). No default exports. pnpm only.

## License

Apache-2.0
