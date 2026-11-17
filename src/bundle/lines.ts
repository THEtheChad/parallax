// JSON-lines I/O that never holds a whole log in memory.
//
// readLines yields each line with its byte offset and length, so a later pass can fetch one record with
// a single positioned read (readRange) instead of keeping answers around. JsonlWriter awaits drain, so a
// fast producer cannot buffer an unbounded amount, and can embed a raw JSON text (a server's answer
// body) into a record without parsing and re-serializing it.

import { once } from "node:events";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";

export interface Line {
  text: string;
  offset: number;
  length: number;
  // 1-based.
  number: number;
}

export async function* readLines(path: string): AsyncGenerator<Line> {
  let parts: Buffer[] = [];
  let partsLength = 0;
  let lineStart = 0;
  let pos = 0;
  let number = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(10, from);
      if (nl < 0) break;
      const piece = chunk.subarray(from, nl);
      const buf = partsLength ? Buffer.concat([...parts, piece], partsLength + piece.length) : piece;
      parts = [];
      partsLength = 0;
      const length = pos + nl - lineStart;
      number++;
      if (buf.length) yield { text: buf.toString("utf8"), offset: lineStart, length, number };
      lineStart = pos + nl + 1;
      from = nl + 1;
    }
    if (from < chunk.length) {
      // Copy: the stream may reuse its chunk buffers.
      const rest = Buffer.from(chunk.subarray(from));
      parts.push(rest);
      partsLength += rest.length;
    }
    pos += chunk.length;
  }
  if (partsLength) {
    number++;
    yield { text: Buffer.concat(parts, partsLength).toString("utf8"), offset: lineStart, length: partsLength, number };
  }
}

export async function readRange(path: string, offset: number, length: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, offset + got);
      if (!bytesRead) throw new Error(`${path}: short read at ${offset + got}`);
      got += bytesRead;
    }
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

export class JsonlWriter {
  readonly path: string;
  #stream: WriteStream;
  #lines = 0;

  constructor(path: string) {
    this.path = path;
    this.#stream = createWriteStream(path, { flags: "wx" });
  }

  get lines(): number {
    return this.#lines;
  }

  async #write(text: string): Promise<void> {
    this.#lines++;
    if (!this.#stream.write(text)) await once(this.#stream, "drain");
  }

  // One record.
  write(record: object): Promise<void> {
    return this.#write(`${JSON.stringify(record)}\n`);
  }

  // One record with `field` set to the JSON text `raw`, written verbatim. `raw` must be one valid JSON
  // text without line breaks (client.ts guarantees both for answer bodies).
  writeWithRaw(record: object, field: string, raw: string): Promise<void> {
    const head = JSON.stringify(record);
    const sep = head === "{}" ? "" : ",";
    return this.#write(`${head.slice(0, -1)}${sep}${JSON.stringify(field)}:${raw}}\n`);
  }

  async close(): Promise<void> {
    this.#stream.end();
    await once(this.#stream, "finish");
  }
}

// A JsonlWriter that also keeps every record it wrote, for a command that summarizes as it goes.
export class KeepingJsonlWriter extends JsonlWriter {
  readonly records: object[] = [];

  override write(record: object): Promise<void> {
    this.records.push(record);
    return super.write(record);
  }
}
