// Colour for a terminal, and nothing anywhere else. Node's own util.styleText decides: it styles only
// when the stream is a terminal that takes colour, and follows NO_COLOR, NODE_DISABLE_COLORS and
// FORCE_COLOR (FORCE_COLOR=1 colours a CI log that renders it). Piped output, files and every
// --format but text are byte-for-byte what they would be without this module.

import { styleText } from "node:util";

// What a piece of text means, not how it looks: the report model and the log say "bad", this module
// says red.
export type Tone = "good" | "bad" | "warn" | "dim" | "strong";

export type Paint = (tone: Tone, text: string) => string;

export const plain: Paint = (_tone, text) => text;

const FORMAT: Record<Tone, Parameters<typeof styleText>[0]> = {
  good: "green",
  bad: "red",
  warn: "yellow",
  dim: "dim",
  strong: "bold",
};

// A painter for one stream (stdout for the report, stderr for the log), or `plain` when that stream
// would not show colour.
export function paintFor(stream: NodeJS.WriteStream): Paint {
  if (styleText("red", "x", { stream }) === "x") return plain;
  return (tone, text) => (text ? styleText(FORMAT[tone], text, { stream, validateStream: false }) : text);
}
