# parallax

Parity, performance and gating harness for TypeScript compilers and language servers.

Parallax checks a candidate compiler or language server against a reference (today: tsc 7, the Go
port) for identical output, then measures speed. It is binary-agnostic: everything specific to one
product lives in a profile, and every result is an evidence bundle that reports are rendered from.

Status: early and private. What exists is the language-server answer diff (`lsp-diff`), the
command-line check timer (`bench`) and the language-server timer (`lsp-bench`).

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

Times each side's `check` command (from its profile) on one project. Raw times on a shared machine
move with whatever else runs, so the bench does not try to correct them; it measures the disturbance
and keeps only rounds that were not disturbed:

- **Rounds.** Each round runs every side once, back to back, alternating the order (ref, A, B, then
  B, A, ref). Candidates are compared by their time divided by the reference's time *in the same
  round*, so load that is steady across a round cancels. Results are medians with 95% bootstrap
  intervals; a candidate is `faster` or `slower` only when the whole interval is on one side of 1.
- **Idle wait.** Before each round, wait until other programs use at most `--max-busy-cores` (1.5).
- **Outside load.** Machine CPU during the round minus the harness's and the measured commands' own
  CPU. A round where other programs used more than `--max-outside-cores` (1) is rejected and retried.
- **Canary.** A fixed workload timed before and after each round. A round whose canary ran more than
  `--max-canary-drift` (10%) slower than the fastest canary of the bench is rejected: the machine
  changed speed (clock boost, heat, or load the OS cannot see, such as a VM host).
- **Not enough clean rounds** (`--min-runs`, 3) makes a candidate `noisy` instead of giving a number.
  A crash, signal or timeout makes it `failed`. Each side's output must be the same on every run; it is
  also compared with the reference's.

`parallax bench-summary <bundle-dir>` recomputes the summary from `samples.jsonl` (for `lsp-bench` bundles too), which keeps every
sample and round, rejected ones included; other gates can be tried after the fact.

What works where: wall time, the idle wait, the canary and the ratios use only Node and work on any
OS. The commands' own CPU and peak memory (and so outside load) come from `/usr/bin/time` where one
works: GNU time on Linux, BSD time on macOS (it is detected by running it once, and
`PARALLAX_ACCOUNTING=none|gnu-time|bsd-time` forces a choice). On Linux the
measured command's process group is also tracked through `/proc`, so a worker its launcher never
waits for (the tsc-rs fork's model; `time` cannot see it) is still counted. Elsewhere a
`launcher+worker` profile's CPU and memory are left blank rather than reported as the launcher's
alone. Without `time`, CPU and memory are blank,
and the idle wait and canary are the only guards. On Linux the bundle also records system-wide CPU
pressure (`/proc/pressure/cpu`).

Run on a project on the machine's own disk. From WSL, a project under `/mnt/c` is read through a
slow file share (a check that takes 230 ms on Windows took 2 s from WSL), so the bench would time the
share, not the checker.

Windows is checked from WSL with `scripts/windows-check.sh` (the test suite on Windows Node). An A/A
bench there (tsc 7 against itself) gave 1.01x (0.98x..1.02x), "indistinguishable", as it should.

## Timing language servers

```sh
pnpm parallax lsp-bench --project <dir> \
  --ref tsc7=<tsc7-binary> --cand tsrs=<tsrs-binary> --cand tsc-rs-fork=<fork-binary> \
  --out <bundle-dir>
```

Times what someone using an editor waits for. Each round starts every side's server once (same rounds,
idle wait, canary and gates as `bench`, and the same per-round ratio to the reference) and runs one
session in three phases:

- **open:** spawn, initialize, open the edited file and pull its diagnostics: time to first
  diagnostics (from spawn), and the server's CPU so far. The other files are then opened and
  checked once, untimed.
- **edit:** `--edits` (20) one-character edits, each followed by a hover in another file (the first
  request after an edit pays for the server's update), a second hover, and the edited file's
  diagnostics. Server CPU per edit.
- **typing:** a line typed at the end of the edited file at `--interval-ms` (120) per key, `--lines`
  (4) times, sending what VS Code sends: a completion after `.` and at the start of a word, the edited
  file's diagnostics every key, semantic tokens, inlay hints and the other files' diagnostics every
  500 ms, a hover every 8 keys. Keys go out on schedule whether or not answers have come (open loop),
  and latency is counted from when the key was due, so a server that falls behind is charged for its
  queue. A new request in the same slot cancels the one in flight, as an editor does; cancelled
  requests are counted, not timed. Server CPU per key.

The files are picked as for `lsp-diff` (`--files 6`, or `--file <rel>` repeated; the first is edited).
Every request of every session is kept in `runs/<side>.<round>.<attempt>.jsonl` with the times it
was due, sent and answered.

Server CPU and memory are read while the server runs, for its whole process group: through `/proc` on
Linux (peak memory), through `ps` on macOS and other BSDs (memory at the end of the session; BSD
`ps` has no peak), and not at all on Windows, where they are left blank. `PARALLAX_SERVER_USAGE=proc|ps|none`
forces a choice. If the harness itself sends keys late (a busy client machine), the bundle says so.

## Calls

A candidate is `faster` or `slower` only when the whole 95% interval of its ratio is on one side of
1 and the ratio differs from 1 by at least 1%; otherwise it is `indistinguishable`.

## Profiles

`profiles/tsc7.json`, `profiles/tsrs.json`, `profiles/tsc-rs-fork.json`. A profile declares the
language-server command (`{bin}` is the bound binary), the check command for `bench` (`{config}` is
`--config`), environment variables to clear or set, the
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
