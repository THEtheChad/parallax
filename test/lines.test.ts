import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlWriter, readLines, readRange } from "../src/bundle/lines.ts";

test("lines with offsets survive chunk boundaries and multi-byte text; readRange gets one back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parallax-lines-"));
  const path = join(dir, "x.jsonl");
  const w = new JsonlWriter(path);
  const big = "é".repeat(3 << 20); // a 6 MB line, longer than the 1 MB read chunk
  await w.write({ n: 1, s: "a" });
  await w.writeWithRaw({ n: 2 }, "response", JSON.stringify({ s: big }));
  await w.writeWithRaw({}, "response", '{"x":1.0}');
  await w.close();
  const lines = [];
  for await (const l of readLines(path)) lines.push(l);
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[1]!.text).response.s.length, big.length);
  assert.equal(lines[2]!.text, '{"response":{"x":1.0}}');
  assert.equal(await readRange(path, lines[1]!.offset, lines[1]!.length), lines[1]!.text);
  assert.equal(await readRange(path, lines[2]!.offset, lines[2]!.length), lines[2]!.text);
});

test("a final line without a newline is still read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parallax-lines-"));
  const path = join(dir, "y.jsonl");
  writeFileSync(path, '{"a":1}\n{"b":2}');
  const texts = [];
  for await (const l of readLines(path)) texts.push(l.text);
  assert.deepEqual(texts, ['{"a":1}', '{"b":2}']);
});
