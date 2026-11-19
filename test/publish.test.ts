// Publishing results and the benchmark suite: a published result carries no hostname or paths,
// recomputes to its own summary, and fails verification once edited.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { publicRemote } from "../src/bundle/bundle.ts";
import { bench } from "../src/commands/bench.ts";
import { publish, scrub, verifyResult } from "../src/commands/publish.ts";
import { loadSuite, selectProjects, suiteProjectFor, validateSuite } from "../src/suite/suite.ts";

const here = dirname(fileURLToPath(import.meta.url));
// The machine id and any calibration live in a scratch config directory, not the user's.
process.env.PARALLAX_CONFIG_DIR = mkdtempSync(join(tmpdir(), "parallax-config-"));
const fake = join(here, "fixtures/fake-check.ts");
const side = (name: string): string => `${join(here, "fixtures/profiles", `${name}.json`)}=${fake}`;
const open = { idle: { maxBusyCores: Infinity, bootSettleS: 0, windowMs: 100 }, gates: { maxOutsideCores: Infinity, maxCanaryDrift: Infinity } };

test("suite.json is valid, and a bundle's corpus is matched to its suite project by commit", () => {
  const suite = loadSuite();
  assert.ok(suite.projects.length >= 3);
  assert.deepEqual(selectProjects(suite, ["umami"]).map((p) => p.name), ["umami"]);
  assert.throws(() => selectProjects(suite, ["nope"]), /no project "nope"/);
  const umami = suite.projects.find((p) => p.name === "umami")!;
  assert.equal(suiteProjectFor(suite, { repository: "https://github.com/umami-software/umami.git", gitCommit: umami.commit })?.name, "umami");
  assert.equal(suiteProjectFor(suite, { repository: null, gitCommit: umami.commit })?.name, "umami", "a full commit hash is enough");
  assert.equal(suiteProjectFor(suite, { repository: "https://github.com/someone/fork", gitCommit: umami.commit }), null, "a remote that disagrees");
  assert.throws(() => validateSuite({ schema: "parallax.suite/1", projects: [{ name: "x", repository: "https://e/x", commit: "abc", install: ["true"], bench: { config: "t" } }] }, "t"), /full 40-character hash/);
});

test("remote URLs are published without credentials", () => {
  assert.equal(publicRemote("https://user:token@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(publicRemote("git@github.com:o/r.git"), "https://github.com/o/r.git");
  assert.equal(publicRemote("/home/me/repos/r"), null);
  assert.equal(publicRemote(null), null);
});

test("scrub replaces paths inside any string, longest first", () => {
  const out = scrub({ a: ["/home/u/p/src/x.ts", { b: "/home/u/bin/tsc -p /home/u/p" }], n: 3 }, [["/home/u", "~"], ["/home/u/p", "<project>"]]);
  assert.deepEqual(out, { a: ["<project>/src/x.ts", { b: "~/bin/tsc -p <project>" }], n: 3 });
});

test("publish: no hostname or paths; the summary recomputes; an edited result fails verification", async () => {
  const project = mkdtempSync(join(tmpdir(), "parallax-publish-proj-"));
  writeFileSync(join(project, "tsconfig.json"), "{}\n");
  const { dir } = await bench({
    project,
    out: join(mkdtempSync(join(tmpdir(), "parallax-publish-")), "b"),
    ref: side("fake-check-ref"),
    cands: [side("fake-check-fast")],
    threads: ["default"],
    runs: 3,
    maxRuns: 3,
    minRounds: 3,
    warmup: 0,
    attempts: 1,
    counterRuns: 0,
    log: () => {},
    ...open,
  });
  const out = mkdtempSync(join(tmpdir(), "parallax-results-"));
  // The working tree under test may have uncommitted changes.
  const { file, result } = publish({ bundleDir: dir, out, allowDirty: true, log: () => {} });
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(project), "the project's path");
  assert.ok(!text.includes(homedir()), "the home directory");
  assert.ok(!text.includes(here), "the binaries' paths");
  assert.ok(!("hostname" in result.host));
  assert.equal(result.records.length > 0, true);
  assert.ok(file.startsWith(join(out, "cli-bench")));

  assert.deepEqual(verifyResult(file).problems, []);
  const edited = JSON.parse(text);
  edited.summary.candidates[0].call = "slower";
  writeFileSync(file, JSON.stringify(edited));
  assert.match(verifyResult(file).problems.join("; "), /edited after publishing/);
  const forged = { ...edited };
  delete forged.id;
  const { createHash } = await import("node:crypto");
  forged.id = createHash("sha256").update(JSON.stringify(forged)).digest("hex").slice(0, 16);
  writeFileSync(file, JSON.stringify(forged));
  assert.deepEqual(verifyResult(file).problems, ["the summary is not what the records give"], "a re-hashed forgery is still caught");

  // A result published before summaries carried the notes still verifies; one whose notes were
  // edited does not.
  const rehash = (r: Record<string, unknown>): void => {
    delete r.id;
    r.id = createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 16);
    writeFileSync(file, JSON.stringify(r));
  };
  const older = JSON.parse(text);
  assert.ok(Array.isArray(older.summary.notes));
  delete older.summary.notes;
  rehash(older);
  assert.deepEqual(verifyResult(file).problems, []);
  const renoted = JSON.parse(text);
  renoted.summary.notes = ["all is well"];
  rehash(renoted);
  assert.deepEqual(verifyResult(file).problems, ["the summary is not what the records give"]);
});
