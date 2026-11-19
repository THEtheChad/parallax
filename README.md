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

## Command line

`parallax --help` lists the commands; `parallax <command> --help` (or `parallax help <command>`)
prints one command's options with their defaults and an example. `parallax --version` prints the
package version, the harness commit and the Node version.

The report goes to stdout and the log to stderr, so `parallax bench ... > report.txt` keeps the
report clean. The long-running commands (`lsp-diff`, `bench`, `lsp-bench`, `calibrate`, `suite run`)
stamp each log line with the time since the start (`[41:02]`), log a line when each round starts and
one per side as it finishes, and after each look say how much is left as a range: a sequential bench
stops at the first look where every call is settled, so it may end at the next look or run to
`--max-runs`. `--quiet` (`-q`) drops the progress and keeps warnings and errors.

| exit status | meaning |
| --- | --- |
| 0 | clean: no differences, every session clean, every bench measured cleanly |
| 1 | a finding: differences, an unclean session, a bench not measured cleanly (each command's `--help` says what it means there) |
| 2 | a usage error (the message and the command's synopsis) or a harness error (one line; `PARALLAX_DEBUG=1` adds the stack) |

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

The output has a table of sides (wall time, CPU, peak memory, exit code, whether the output matches
the reference), a table of candidates (ratio, interval, call: `faster`, `slower`, `same ±r`,
`unresolved` or `too few rounds`), each implementation's parallel speedup, and the counters.

**[docs/measurement.md](docs/measurement.md) is the method**: what disturbs a measurement and how
each disturbance is handled, the statistics behind a call, what the counters are for, and what works
on which OS.

`parallax bench-summary <bundle-dir>` recomputes the summary from `samples.jsonl`, which keeps every
sample and round, rejected ones included; other gates can be tried after the fact.

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
