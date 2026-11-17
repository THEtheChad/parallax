// LSP base protocol framing: `Content-Length: N\r\n\r\n` followed by N bytes of UTF-8 JSON.
// A body is decoded only once it is complete, so a multi-byte character split across chunks is safe,
// and a large body's chunks are concatenated once rather than once per chunk.

export interface Frame {
  body: string;
  bytes: number;
}

const HEADER_END = Buffer.from("\r\n\r\n");

export class FrameReader {
  #buf: Buffer = Buffer.alloc(0);
  #parts: Buffer[] = [];
  #partsLength = 0;
  #need: number | undefined;

  // Feeds one chunk; returns every frame it completes.
  push(chunk: Buffer): Frame[] {
    if (this.#need !== undefined) {
      this.#parts.push(chunk);
      this.#partsLength += chunk.length;
      if (this.#partsLength < this.#need) return [];
      this.#buf = Buffer.concat(this.#parts, this.#partsLength);
      this.#parts = [];
      this.#partsLength = 0;
      this.#need = undefined;
    } else {
      this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    }
    const frames: Frame[] = [];
    for (;;) {
      const headerEnd = this.#buf.indexOf(HEADER_END);
      if (headerEnd < 0) return frames;
      const header = this.#buf.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length: *(\d+)/i.exec(header);
      if (!match) throw new Error(`frame header without Content-Length: ${JSON.stringify(header.slice(0, 200))}`);
      const length = Number(match[1]);
      const total = headerEnd + HEADER_END.length + length;
      if (this.#buf.length < total) {
        this.#need = total;
        this.#parts = [this.#buf];
        this.#partsLength = this.#buf.length;
        this.#buf = Buffer.alloc(0);
        return frames;
      }
      const body = this.#buf.subarray(headerEnd + HEADER_END.length, total).toString("utf8");
      this.#buf = this.#buf.subarray(total);
      frames.push({ body, bytes: length });
    }
  }

  // Bytes received that do not yet form a complete frame.
  get pendingBytes(): number {
    return this.#need !== undefined ? this.#partsLength : this.#buf.length;
  }
}

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}
