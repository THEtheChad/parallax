import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNormalizer, normalizeValue } from "../src/diff/normalize.ts";

const root = "/home/u/proj";

test("root masked in values and keys, plain and URI-encoded; keys sorted", () => {
  const n = makeNormalizer(root, undefined);
  const v = normalizeValue({ z: 1, a: `file://${root}/a.ts`, changes: { [`file://${root}/b.ts`]: [] } }, n.base);
  assert.equal(JSON.stringify(v), '{"a":"file://<root>/a.ts","changes":{"file://<root>/b.ts":[]},"z":1}');
});

test("completion items compare as a set; other arrays keep their order", () => {
  const n = makeNormalizer(root, undefined);
  const a = normalizeValue({ result: { items: [{ label: "b" }, { label: "a" }] } }, n.base, "textDocument/completion");
  const b = normalizeValue({ result: { items: [{ label: "a" }, { label: "b" }] } }, n.base, "textDocument/completion");
  assert.deepEqual(a, b);
  const arr = normalizeValue({ result: [{ label: "b" }, { label: "a" }] }, n.base, "textDocument/completion");
  assert.deepEqual(arr, { result: [{ label: "a" }, { label: "b" }] });
  const hl = normalizeValue({ result: [2, 1] }, n.base, "textDocument/documentHighlight");
  assert.deepEqual(hl, { result: [2, 1] });
});

test("library locations: a URI prefix and a directory (with any percent-encoding) both map to <lib>/", () => {
  const go = makeNormalizer(root, { uriPrefix: "bundled:///libs/" });
  const dir = "/opt/pkg/@tsrs+linux-x64-gnu/bin";
  const rs = makeNormalizer(root, { dir });
  const goV = normalizeValue({ uri: "bundled:///libs/lib.dom.d.ts" }, [...go.lib, ...go.base]);
  for (const href of [`file://${dir}/lib.dom.d.ts`, "file:///opt/pkg/%40tsrs%2Blinux-x64-gnu/bin/lib.dom.d.ts"]) {
    assert.deepEqual(normalizeValue({ uri: href }, [...rs.lib, ...rs.base]), goV, href);
  }
  // Only with the lib rules: base normalization keeps the forms apart.
  assert.notDeepEqual(normalizeValue({ uri: "bundled:///libs/lib.dom.d.ts" }, go.base), normalizeValue({ uri: `file://${dir}/lib.dom.d.ts` }, rs.base));
});

test("reference locations compare as a set", () => {
  const n = makeNormalizer(root, undefined);
  const a = normalizeValue({ result: [{ uri: "b", line: 1 }, { uri: "a", line: 2 }] }, n.base, "textDocument/references");
  const b = normalizeValue({ result: [{ uri: "a", line: 2 }, { uri: "b", line: 1 }] }, n.base, "textDocument/references");
  assert.deepEqual(a, b);
});
