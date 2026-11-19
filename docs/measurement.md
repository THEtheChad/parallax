# How Parallax measures

Parallax compares implementations of the TypeScript compiler and language server. This document is
the method: what is measured, what disturbs a measurement and how each disturbance is handled, how
results are turned into calls, and what works on which OS. Each rule here is in the code; the file
named with it is where.

## Principles

1. **Time is the measure.** What a user waits for is time, and implementations differ in the work
   they do per unit of time, so only time compares one implementation with another. Counters
   (instructions, cycles) measure work: they compare an implementation with itself.
2. **Measure the disturbance, do not correct for it.** A shared machine slows some runs down. No
   adjustment factor can say by how much, so Parallax measures the disturbance and leaves disturbed
   rounds out, and keeps them in the bundle so a reader can see what was left out and why.
3. **Compare within a round.** Candidates are compared with the reference by the ratio of their
   times in the same round, so anything steady across a round cancels.
4. **Say how sure a result is, and never more.** Every figure carries an interval with the confidence
   it really has; a call (faster, slower, same) is made only when the evidence supports it.
5. **Record what cannot be controlled.** Power, CPU frequency, priority, the cores available: setting
   them needs root and differs per OS, but every bundle says what they were.
6. **Portable core, optional extras.** Everything that decides a result uses only Node and works on
   Linux, macOS and Windows. What only some systems offer (child-process accounting, counters, CPU
   pressure) is optional, detected by trying it, and recorded as present or absent.
7. **Spend runs where they are needed.** A bench stops as soon as every call is settled and goes on
   only while some call is not.
8. **Know the noise floor.** A machine's own noise sets the smallest difference it can resolve. An
   A/A bench (a binary against itself) measures it, and a bench asked for less is warned.
9. **Give every side the same world.** Commands start from a sealed environment, not from whatever
   the shell exported; what they were given is recorded.

## A round

`bench` (the CLI check) and `lsp-bench` (a scripted editor session) share one round loop
(`src/timing/rounds.ts`):

1. **Idle wait.** Wait until other programs use at most `--max-busy-cores` (1.5) cores, measured from
   the machine's per-core CPU times minus the harness's own.
2. **Canary.** Time a fixed, deterministic workload (`src/timing/canary.ts`).
3. **Every side once,** back to back. The order alternates every round (ref, A, B; then B, A, ref),
   so no side always runs first or after the same neighbour.
4. **Canary again.**
5. **Judge the round** (`src/timing/summary.ts`): reject it when the machine was busy before it,
   when other programs used more than `--max-outside-cores` (1) during it (machine CPU minus the
   harness's and the measured commands' own), or when either canary ran more than
   `--max-canary-drift` (10%) slower than the fastest canary of the whole bench: the machine changed
   speed (clock boost, heat, a VM host's load the guest cannot see). A rejected round is run again,
   up to `--attempts` (3) times. A round in which a side crashed is not retried: a crash is a
   result, not noise.

Before the rounds each side runs `--warmup` (1) times untimed, so the file cache is warm for all.

The progress log (stderr) has a line when a round starts, one per side as it finishes and one with
the canaries, outside load and verdict. The per-side lines are written between sides, never while one
is timed; they fall inside the round's CPU window, where they count as the harness's own CPU, which
outside load already leaves out. The idle wait logs when it starts and every 30 s after, also
outside any timed work.

## Thread modes

Every side runs in two modes (`--threads both`, the default; `src/profile/profile.ts`):

- **default**: however the implementation uses the machine's cores. This is what users get.
- **single** (label suffix `@1t`): one thread of work. This is the algorithm's cost without
  parallelism, and it is much steadier.

A profile says how to make its implementation single-threaded, for the CLI check and for the
language server separately: tsc 7 and the tsc-rs fork take `--singleThreaded` on the CLI and
`GOMAXPROCS=1` for the server (the fork honours `GOMAXPROCS` as Go does); tsrs takes
`--singleThreaded` and `RAYON_NUM_THREADS=1`. Each candidate is compared with the reference in the
same mode, and every output, single-threaded ones included, must match the default-mode reference's.
`bench` also reports each implementation's parallel speedup: single-threaded wall time over default
wall time, paired within each round.

Run-to-run spread on hono (8 runs each, coefficient of variation):

| | instructions | cycles | wall time | CPU time |
| --- | --- | --- | --- | --- |
| tsrs, single-threaded | 0.008% | 1.1% | 0.8% | 3.1% |
| tsrs, default | 0.43% | 1.7% | 10.3% | 3.9% |
| tsc 7, single-threaded | 1.7% | 3.5% | 1.1% | 3.4% |
| tsc 7, default | 4.5% | 6.9% | 6.8% | 7.3% |

Single-threaded wall time is about as steady as a counter. Default-mode figures are what users see,
and need more rounds for the same certainty.

## From rounds to calls

All statistics are pure functions of `samples.jsonl`; `parallax bench-summary` recomputes them, with
other gates if asked.

**Ratios.** For each accepted round, candidate time / reference time (same mode). A figure is the
median over rounds.

**Intervals** (`src/timing/stats.ts`, `medianInterval`). A distribution-free interval for the median,
from the sorted values (order statistics): the narrowest `[x(k), x(n+1-k)]` whose binomial coverage
reaches the confidence wanted, or the whole range with the coverage it really has when none does (75%
at 3 rounds, 93.75% at 5, 96.9% at 6). It assumes nothing about how times are distributed, which a
handful of rounds could not show. (A percentile bootstrap, used before, is far too sure of itself
with few rounds: three rounds that happen to fall on the same side of 1, as happens one time in four,
gave a "95%" interval excluding 1.)

**Calls.**

| call | when |
| --- | --- |
| `faster`, `slower` | the whole interval is on one side of 1, and the median differs from 1 by at least 1% |
| `same ±r` | the whole interval lies within 1 ± r, the resolution: `--resolution` (5%), widened to `--resolution-ms` (1 ms) over the reference's figure where that is larger, so a 0.3 ms request is "same" within 1 ms, not within 5% of 0.3 ms (the report then says `same (within 1 ms)`, not the ±300% it works out to) |
| `unresolved` | none of these; more rounds would tell |
| `too few rounds` | the interval cannot reach the confidence a call needs |

Every metric is lower-is-better, and the stored call is `faster` or `slower` for all of them; the
report words a CPU-time or memory metric's call `lower` or `higher` instead. The report's two
percentages are different things: "calls at 95% confidence" is what this look required of an
interval (see sequential rounds below), and "(96% interval)" in a column header is the coverage the
intervals really have. Order statistics give coverage in discrete steps, so the interval used is the
first step at or above what the call needs (96.9% at 6 rounds for 95%), or the whole range, below it,
when there are too few rounds. Ratios are printed to three significant figures.

**Sequential rounds.** A bench runs `--runs` (6) rounds and looks. If some comparison is unsettled
(`unresolved` or `too few rounds`), it runs 3 more and looks again, up to `--max-runs` (15). Looking
repeatedly and stopping at the first clear answer would make false calls more likely than one fixed
look, so the false-call budget per comparison, 10%, is split in advance (Bonferroni): half for the
first look, the other half shared equally by the later ones. With the defaults the looks are at 6, 9,
12 and 15 accepted rounds, needing 95% at the first and 98.3% at each later one. A bench never stops
between looks. With `--max-runs` equal to `--runs` there is one look with the whole 10%.

Six rounds all on one side of 1 settle a call at the first look (6 of 6 happens by luck 1 time in
32). A real difference of a few percent in a noisy figure needs more rounds; the bench finds out
which it is facing and spends rounds accordingly.

**Noisy and failed.** A candidate with fewer than `--min-runs` (3) accepted rounds is `noisy`, with
no figure. One whose run crashed, was killed or timed out (its own or the reference's) is `failed`.

## The environment

A variable an implementation reads changes what it does: `GOGC`, `GOMAXPROCS`, `RAYON_NUM_THREADS`,
`NODE_OPTIONS`, a locale. Inherited from the shell that started the harness, such a variable would
change a result and nothing in the bundle would show it. So every measured command (check commands,
counted runs, language servers, and `lsp-diff`'s servers) starts from a sealed environment
(`src/host/sealedEnv.ts`, `--env sealed`, the default):

- from the harness's environment, only what a program needs to start and find its files: `PATH`,
  `HOME`, `USER`, `LOGNAME`, `TMPDIR` (on Windows: `PATH`, `PATHEXT`, `SystemRoot`, `TEMP`,
  `USERPROFILE`, `APPDATA` and the other names Windows programs expect), and any `--pass-env NAME`;
- fixed values: `LANG` and `LC_ALL` set to `C.UTF-8` (`en_US.UTF-8` on macOS, which has no
  `C.UTF-8`), and `TZ=UTC`;
- then the profile's `env.set` and the thread mode's variables.

Each side's record in the bundle lists the names passed (never their values: `PATH` and `HOME` are
paths), the fixed values, and what the profile cleared and set. `--env inherit` passes the whole
environment, minus the profile's `env.clear` patterns, as before.

## Pinning

`--pin <cpu-list>` (Linux; `src/host/pinning.ts`) runs every measured command and server under
`taskset -c <list>`: every side, every mode, the counted runs. The list must be cores the harness
may run on. Pinning is off by default, because the scheduler's own placement is what users get, and
a pinned default-mode run has fewer cores than the machine. Pin when placement itself is the noise:
a hybrid CPU whose performance and efficiency cores differ, or cores that interrupts or other work
favour. The list is recorded in the bundle's settings, and a calibration is valid only for the same
pinning.

## A/A calibration

`parallax calibrate --kind bench|lsp-bench --side <profile>=<bin> --project <dir> --out <dir>`
(`src/commands/calibrate.ts`, `src/timing/calibration.ts`) benches one binary against itself: the
same profile and binary under a second label (`<label>.aa`), in both thread modes, for a fixed
`--runs` (9) rounds. Nothing differs, so anything the bench finds is noise:

- **noise floor**, per metric and mode: how wide a bench's ratio interval gets when nothing
  differs. One A/A interval is a single draw of a random width, so the calibration keeps the
  per-round A/A ratios and resamples them: the floor is the 90th percentile of the interval's
  half-width, max(1 - low, high - 1), over resamples of as many ratios as a bench has rounds, at the
  confidence its calls need. The report gives it at a default bench's first look (6 rounds, 95%);
  each later bench recomputes it at its own first look. For instruction counts, the two sides'
  difference or half either side's spread.
- **smallest resolution**: the floor rounded up to the next half percent, at least 1%.
- **false calls**: A/A comparisons called faster or slower. Some are expected: each may make a false
  call with probability up to one minus its interval's coverage, the budget calls are designed with,
  and an `lsp-bench` calibration makes about 50 comparisons. The calibration flags the machine only
  when there are more than chance explains (above the 95th percentile of that binomial).

The result goes to `calibration.json` in the bundle and, when the A/A bench was measured cleanly, to
the config directory (`~/.config/parallax/calibration/<kind>.json`, one per kind). Each later bench on
the same host setup (OS, kernel, CPU model, core count, pinning, the cores the harness may use) records the calibration it found
and warns when, at its first look, a floor is wider than its "same" (the resolution, widened to
`--resolution-ms` over the reference's time as its calls are), or when the calibration had more
false calls than chance explains. Calibrate again after changing the machine's setup, and expect a
floor to differ by workload: a 200 ms check on a quiet machine has a lower relative floor than a
20 ms one.

Theo Browne's tsc-rs tooling (`scripts/goport/perf.sh`) sets its pass bars the same way, from A/A
runs on each host: 1% for single-threaded instructions, 5% for memory, 2% for wall time on a
dedicated quiet machine.

## Counters

Where `perf stat` works (Linux; `src/host/counters.ts`), `bench` runs each side `--counter-runs` (3)
more times after the timed rounds, under perf, and reports user-space instructions, cycles,
instructions per cycle, task clock and page faults, each as the median and its spread. These runs
are separate and untimed, so perf's own start-up never touches a wall time.

What the counters are for:

- **Determinism.** Single-threaded work without a garbage collector repeats almost exactly: on hono,
  the fork single-threaded executes the same instructions to ±0.002%, tsrs to ±0.01%. A 0.1%
  change in such a figure is real after two runs, where wall time would need dozens.
- **Regressions within one implementation,** across its own commits or between its thread modes.
- **Not comparing implementations.** On hono single-threaded, tsrs over tsc 7 is 0.34x by
  instructions, 0.27x by cycles and 0.35x by wall time: the two do different work per cycle (memory
  behaviour, mostly). Threads make it worse: tsc 7 executes 74% more instructions in parallel mode
  than single-threaded, mostly threads looking for work.
- **Not with threads or a GC.** tsc 7 varies by 3-9% even in instructions: Go's garbage collector
  and scheduler run on their own timing.

Counters are checked before they are trusted. Each event is first counted alone on a trivial
command; one that is not supported or reads 0 (some VMs expose a counter that never counts) is left
out and named in the bundle's notes. Then the working events are counted together; if one stops
counting or is multiplexed there (a Zen 5 guest counts only the first hardware event of a set),
each hardware event gets a counted run of its own. The plan (`host.counterPlan`: event groups and
unavailable events) is in the bundle, and every counted run still drops a zero or a scaled count
rather than report it.

Without root, `kernel.perf_event_paranoid` 2 allows user-space events only, so kernel-side events
(context switches, migrations) are not counted. In a VM the hypervisor must expose the CPU's
counters (WSL2 does). `PARALLAX_PERF` names the perf program and `PARALLAX_COUNTERS=none|perf|split`
forces a backend (`split`: one run per hardware event). macOS needs root for its counters and Windows has no ordinary way, so neither has
a backend.

Fully deterministic tools exist (Cachegrind, which CodSpeed builds on, simulates the CPU and runs
threads one at a time), but they are 20-50x slower, Linux-only in practice, poor at Go, and report a
cost model rather than time, so they are no basis for comparing implementations.

## Language servers

`lsp-bench` runs one editor session per side per round (`src/timing/lspSession.ts`):

- **open:** spawn, initialize, open the edited file and pull its diagnostics: time to first
  diagnostics from spawn, and server CPU so far.
- **edit:** `--edits` (20) one-character edits, each followed by a hover in another file (the first
  request after an edit pays for the server's update), a second hover, and the edited file's
  diagnostics. Server CPU per edit.
- **typing (open loop):** a line typed at `--interval-ms` (120) per key, `--lines` (4) times,
  sending what VS Code sends, on schedule whether or not answers have come. Latency counts from when
  the key was due, so a server that falls behind is charged for its queue. A new request in a slot
  cancels the one in flight, as an editor does. This is what a user feels.
- **service (closed loop):** `--service-lines` (1) more lines, each key's requests sent one at a
  time, each after the previous answer, the next key after the last. No queue and no cancellation:
  what is left is the server's own time per request, which varies far less between runs. The first
  request after a key carries the server's update, as in the edit phase.

- **paused:** `--paused-lines` (1) lines typed as in service, with `--pause-ms` (300) of quiet
  before each key. Some servers start background work once the editor goes quiet (tsc-rs warms its
  auto-import data after 50 ms of quiet); the next key then waits on it, and its CPU shows per key.
  Typing at full speed never shows this.
- **errfix:** `--errfixes` (5) times, a line with a type error added to the edited file and its
  diagnostics (which must report one more problem), then the line removed and the diagnostics
  again: the time to show an error and to clear it. A server that misses an inserted error is
  counted in the summary and gets no errfix figures for that session.
- **imports:** `--imports` (3) names exported by the other open files and not yet used in the
  edited one (the bundle notes when fewer are found). The first three letters typed and a completion
  asked, which must offer the name (it searches other files' exports), then the whole name typed: its "cannot find name" diagnostic and the quick fix for it
  (the add-import fix), timed until the fix's edit is in hand: through `codeAction/resolve` when the
  server defers it. Names without a missing-name diagnostic or an add-import action are counted, and
  the fix's figure is left out of a session that missed any.
- **long:** `--long-edits` (60) edits in a row, a character added and then removed so the content
  stays the same, each followed by the edited file's diagnostics (a hover or a completion every few
  edits), with resident memory read after each. Reported per server:
  diagnostics p50, the last quarter's diagnostics over the first quarter's (a server that slows down
  as a session goes on), and memory growth per edit, a Theil-Sen slope over the last three quarters
  (robust to a stray garbage collection). Growth and drift are never compared by ratio: a ratio of
  two slopes near zero means nothing.

In these four phases an answer that is an error (a method the server does not support) or a
cancellation is cheap for the wrong reason: a session with one gets no figure for that metric rather
than a flattering one, and the errors are counted.

Every compared metric must settle before a sequential `lsp-bench` stops, and each comparison has its
own false-call budget, so the more metrics, the more often a bench runs to `--max-runs` and the more
likely one false call somewhere among them. Read a single surprising call among many in that light;
the phase options (0 skips a phase) narrow a bench to what it is for.

The harness records how late it sent keys; when that is more than a quarter of the interval, the
client machine was too busy and the bundle says so.

## What works where

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| wall time, idle wait, canary, rounds, intervals, calls | yes | yes | yes |
| command CPU and peak memory (`bench`) | GNU `time`, plus `/proc` for workers a launcher never waits for | BSD `time`; a `launcher+worker` profile's figures are left blank | none |
| server CPU and memory (`lsp-bench`) | `/proc`, peak memory | `ps`, memory at the end of the session | none |
| outside load gate | yes | yes | no (needs the commands' CPU) |
| CPU pressure | `/proc/pressure/cpu` | no | no |
| counters | `perf stat`, each event checked | no | no |
| sealed environment | yes | yes | yes |
| pinning (`--pin`) | `taskset` | no | no |
| memory growth per edit | `/proc` (resident) | `ps` (resident) | no |
| recorded machine state | governors, boost, SMT, affinity, mains power | power source, Low Power Mode | power plan |

Each optional backend is chosen by trying it on a trivial command, never by OS name alone, and can
be forced with `PARALLAX_ACCOUNTING`, `PARALLAX_SERVER_USAGE` or `PARALLAX_COUNTERS`. CI runs the test
suite and a smoke bench on all three (`.github/workflows/ci.yml`, `scripts/ci-smoke.ts`), checking
that each OS detects the backends it should.

## Machine state and priority

Every bundle records the harness's scheduling priority and the machine's state
(`src/host/machine.ts`, `src/host/machineState.ts`), and warns when they will skew results: a
lowered priority (other programs are served first), battery power, Low Power Mode, a power-saver
plan, or fewer cores available than the machine has.

## Running a good bench

- Plug in a laptop; turn Low Power Mode off; close what you can.
- Calibrate once per machine setup (`parallax calibrate`), on a project like the ones you bench,
  and set `--resolution` no lower than the floor it reports.
- Keep the project on the machine's own disk. From WSL, a project under `/mnt/c` is read through a
  slow file share (a check that takes 230 ms on Windows took 2 s), so the bench times the share.
- Run at normal priority. A batch slice or `nice` makes every other program win the CPU; the bundle
  warns when it happens.
- Expect absolute times to move between days and machines by a few percent; ratios hold far better.
  Compare ratios, and compare absolute times only within one bundle.
- Check the reference itself. A reference that is slow at something makes every candidate look good
  at it: tsc 7.1.0-beta (microsoft/TypeScript@3e9236361fa9) burns 17 times the CPU per key of tsc
  7.0.2 while typing, from a TypeScript change between July and October 2026, not from Go 1.27.
