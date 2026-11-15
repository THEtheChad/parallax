import assert from "node:assert/strict";
import { test } from "node:test";
import { crashSignals, loadProfile, resolveEnv, validateProfile } from "../src/profile/profile.ts";

test("built-in profiles load and validate", () => {
  for (const name of ["tsc7", "tsrs", "tsc-rs-fork"]) assert.equal(loadProfile(name).profile.name, name);
});

test("env: clear patterns remove matching names, set adds; cleared values are not recorded", () => {
  const { profile } = loadProfile("tsrs");
  const r = resolveEnv(profile, { TSRS_FAST: "1", TSRS_FLOW_MEMO: "0", GOMAXPROCS: "1", PATH: "/bin", XTSRS_KEEP: "y" });
  assert.deepEqual(r.cleared, ["GOMAXPROCS", "TSRS_FAST", "TSRS_FLOW_MEMO"]);
  assert.equal(r.env.TSRS_FAST, undefined);
  assert.equal(r.env.XTSRS_KEEP, "y");
  assert.equal(r.env.PATH, "/bin");
});

test("validation names the broken field", () => {
  assert.throws(() => validateProfile({ schema: "parallax.profile/1", name: "x", lsp: { command: [] } }, "t"), /lsp.command/);
  assert.throws(
    () => validateProfile({ schema: "parallax.profile/1", name: "x", lsp: { command: ["a"] }, libraryFiles: { dir: "a", uriPrefix: "b" } }, "t"),
    /exactly one/,
  );
});

test("side specs: a label before the profile, never a Windows drive letter", async () => {
  const { bindSide } = await import("../src/profile/profile.ts");
  const bin = process.execPath;
  assert.equal((await bindSide(`tsc7=${bin}`, "ref")).label, "tsc7");
  assert.equal((await bindSide(`go:tsc7=${bin}`, "ref")).label, "go");
  const path = loadProfile("tsc7").path;
  assert.equal((await bindSide(`${path}=${bin}`, "ref")).label, "tsc7");
  // A drive-letter path is a path, not label "C" (rejected only because the file does not exist).
  await assert.rejects(bindSide(`C:\\no\\such.json=${bin}`, "ref"), /no profile/);
  await assert.rejects(bindSide(`C:/no/such.json=${bin}`, "ref"), /no profile/);
});

test("crash signatures from exit code and stderr", () => {
  const { profile } = loadProfile("tsc-rs-fork");
  assert.deepEqual(crashSignals(profile, 0, "fine\n"), []);
  assert.equal(crashSignals(profile, 70, "thread 'main' panicked at src/x.rs:1:1:\n").length, 3);
});
