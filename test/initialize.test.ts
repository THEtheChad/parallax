import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the session's initialize hash does not depend on the current directory", () => {
  const mod = join(dirname(fileURLToPath(import.meta.url)), "../src/session/initialize.ts");
  const code = `import(${JSON.stringify(mod)}).then((m) => console.log(m.initializeSha256()))`;
  const at = (cwd: string) => spawnSync(process.execPath, ["-e", code], { cwd, encoding: "utf8" }).stdout.trim();
  const a = at(tmpdir());
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(at("/"), a);
});
