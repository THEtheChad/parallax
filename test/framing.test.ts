import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameReader, encodeFrame } from "../src/lsp/framing.ts";

test("frames split anywhere, including inside a multi-byte character, decode intact", () => {
  const msgs = [{ a: "héllo — ✓ 𝒳" }, { b: [1, 2, 3] }, { c: "x".repeat(70000) }];
  const wire = Buffer.concat(msgs.map(encodeFrame));
  for (const size of [1, 2, 3, 7, 64, 1000, wire.length]) {
    const r = new FrameReader();
    const got: unknown[] = [];
    for (let i = 0; i < wire.length; i += size) for (const f of r.push(wire.subarray(i, i + size))) got.push(JSON.parse(f.body));
    assert.deepEqual(got, msgs, `chunk size ${size}`);
    assert.equal(r.pendingBytes, 0);
  }
});

test("several frames in one chunk, extra headers, lower-case header name", () => {
  const body = '{"x":1}';
  const wire = Buffer.from(`content-length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}Content-Length: 2\r\n\r\n{}`);
  const frames = new FrameReader().push(wire);
  assert.deepEqual(frames.map((f) => f.body), [body, "{}"]);
});

test("a header without Content-Length is a protocol error", () => {
  assert.throws(() => new FrameReader().push(Buffer.from("X: 1\r\n\r\n{}")), /without Content-Length/);
});
