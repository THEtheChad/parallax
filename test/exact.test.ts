import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExact, parseStrict, scan } from "../src/json/exact.ts";

test("canonical numbers parse plainly; non-canonical ones keep their text", () => {
  assert.equal(scan('{"a":[1,2,300000000000000]}').exact, true);
  for (const t of ["1.0", "1e999", "-0", "1E2", "12345678901234567890"]) {
    assert.equal(scan(`[${t}]`).exact, false, t);
    assert.equal(JSON.stringify(parseExact(`[${t}]`)), `[${t}]`, t);
  }
  assert.notEqual(JSON.stringify(parseExact("[1.0]")), JSON.stringify(parseExact("[1]")));
});

test("strings that look like numbers or brackets do not confuse the scan", () => {
  assert.equal(scan('{"a":"1.0 [ { \\" }"}').exact, true);
});

test("parseStrict rejects duplicate keys", () => {
  assert.throws(() => parseStrict('{"a":1,"b":{"c":1,"c":2}}'), /duplicate key "c"/);
  assert.deepEqual(parseStrict('{"a":{"c":1},"b":{"c":2}}').value, { a: { c: 1 }, b: { c: 2 } });
});
