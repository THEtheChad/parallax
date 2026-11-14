# parallax

Parity, performance and gating harness for TypeScript compilers and language servers.

Parallax checks a candidate compiler or language server against a reference (today: tsc 7, the Go
port) for identical output, then measures speed. It is binary-agnostic: everything specific to one
product lives in a profile, and every result is an evidence bundle that reports are rendered from.

Status: early and private. What exists is the language-server answer diff (`lsp-diff`).

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

## Profiles

`profiles/tsc7.json`, `profiles/tsrs.json`, `profiles/tsc-rs-fork.json`. A profile declares the
language-server command (`{bin}` is the bound binary), environment variables to clear or set, the
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
