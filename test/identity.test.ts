import assert from "node:assert/strict";
import { test } from "node:test";
import { IdentityCounter, mergeOrder, orderBreak } from "../src/diff/identity.ts";

test("identity: step + method + canonical params + occurrence", () => {
  const c = new IdentityCounter([["/root", "<root>"]]);
  const a = c.next("s", "m", { b: 1, a: "/root/x" });
  const b = c.next("s", "m", { a: "/root/x", b: 1 });
  assert.notEqual(a, b);
  assert.equal(a.split(":")[1], b.split(":")[1]);
  assert.deepEqual([a.split(":")[0], b.split(":")[0]], ["0", "1"]);
  const other = new IdentityCounter([["/elsewhere", "<root>"]]).next("s", "m", { a: "/elsewhere/x", b: 1 });
  assert.equal(other, a);
});

test("mergeOrder places a request only one run asked after its predecessor in that run", () => {
  // Run 2 asked `rename` after prepareRename (run 1 got null there and skipped it).
  const order = mergeOrder([
    ["init", "prep", "action", "end"],
    ["init", "prep", "rename", "action", "end"],
    ["init", "late"],
  ]);
  assert.deepEqual(order, ["init", "late", "prep", "rename", "action", "end"]);
});

test("orderBreak finds a run that asked shared requests in another order", () => {
  const order = ["a", "b", "c"];
  assert.equal(orderBreak(order, ["a", "c"], (k) => k), null);
  assert.match(orderBreak(order, ["a", "c", "b"], (k) => k)!, /asked "b" after "c"/);
});
