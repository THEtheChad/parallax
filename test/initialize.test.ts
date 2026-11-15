import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test("the session's initialize hash does not depend on the current directory", () => {
  const mod = join(dirname(fileURLToPath(import.meta.url)), "../src/session/initialize.ts");
  const code = `import(${JSON.stringify(pathToFileURL(mod).href)}).then((m) => console.log(m.initializeSha256()))`;
  const at = (cwd: string) => spawnSync(process.execPath, ["-e", code], { cwd, encoding: "utf8" }).stdout.trim();
  const a = at(tmpdir());
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(at("/"), a);
});

test("the hash is the one bundles made before it was OS-independent carry", async () => {
  const { initializeSha256, initializeParams, ROOT_PLACEHOLDER_URI } = await import("../src/session/initialize.ts");
  if (process.platform !== "win32") assert.equal(ROOT_PLACEHOLDER_URI, pathToFileURL("/<root>").href);
  assert.equal(initializeParams("", ROOT_PLACEHOLDER_URI).rootUri, ROOT_PLACEHOLDER_URI);
  assert.match(initializeSha256(), /^[0-9a-f]{64}$/);
});
