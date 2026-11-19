// The log: progress and warnings on stderr (stdout is the report).
//
//   progress  `log(msg)`: what the harness is doing; silenced by --quiet
//   warnings  `log.warn(msg)`: something that may make a result wrong or a run fail; always shown
//
//   status    `log.status(text)`: one line under the log saying what runs now ("round 7.2 · tsrs (3 of
//             8) · about 4-40 min left"), rewritten in place; only on a terminal, never in a file or
//             a CI log, and only when the harness calls it (between sides: no timer, so nothing
//             redraws while a side is timed)
//
// Commands take a `LogFn`: any plain `(msg) => void` works (tests pass one), and `warn(log, msg)`
// falls back to writing "warning: msg" through it when it has no warn channel of its own.

import { plain, type Paint } from "./style.ts";

export type LogFn = ((msg: string) => void) & { warn?: (msg: string) => void; status?: (text: string | null) => void };

export interface Log {
  (msg: string): void;
  warn(msg: string): void;
  status(text: string | null): void;
}

export function warn(log: LogFn | undefined, msg: string): void {
  if (!log) return;
  if (log.warn) log.warn(msg);
  else log(`warning: ${msg}`);
}

// Sets (or with null clears) the status line, where the log has one.
export function status(log: LogFn | undefined, text: string | null): void {
  log?.status?.(text);
}

export interface LogOptions {
  // Progress lines are dropped; warnings still go out.
  quiet?: boolean;
  // Every line starts with the time since the log was made ("[41:02] "): for runs that take minutes
  // or hours, so a line says when it happened and how long a step took.
  elapsed?: boolean;
  // With `elapsed`, false leaves a stamp off (blank, so the text stays aligned) where it would repeat
  // the line above's: for a terminal, where a run of "[0:21]" says nothing new. On by default, so a
  // file or CI log keeps one on every line for grep.
  repeatStamps?: boolean;
  write?: (line: string) => void;
  now?: () => number;
  // Colours for a terminal (style.ts paintFor(process.stderr)); plain by default.
  paint?: Paint;
  // A status line (only where stderr is a terminal): `raw` writes without a newline, `columns` is the
  // terminal's width (the line is cut to fit, so it never wraps and can be rewritten in place).
  status?: { raw: (s: string) => void; columns: () => number };
}

// Back to the start of the line and erase it.
const ERASE = "\r\x1b[2K";

export function createLog(o: LogOptions = {}): Log {
  const write = o.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = o.now ?? (() => performance.now());
  const paint = o.paint ?? plain;
  const t0 = now();
  // The status line on screen, painted, or null.
  let shown: string | null = null;
  // The clock reading on the last stamped line, for repeatStamps: false.
  let lastClock: string | null = null;
  const emit = (msg: string, warning = false): void => {
    if (shown !== null) o.status!.raw(ERASE);
    const clock = `[${fmtElapsed(now() - t0)}]`;
    const lines = msg.split("\n");
    if (warning) lines[0] = `${paint("warn", "warning:")} ${lines[0]}`;
    // Each line of a multi-line message gets its own stamp; blank lines (section breaks) stay blank.
    for (const line of lines) {
      if (!line || !o.elapsed) {
        // A blank line starts a section, which shows its time again.
        if (!line) lastClock = null;
        write(line);
        continue;
      }
      const repeat = o.repeatStamps === false && clock === lastClock;
      write(`${repeat ? " ".repeat(clock.length) : paint("dim", clock)} ${line}`);
      lastClock = clock;
    }
    if (shown !== null) o.status!.raw(shown);
  };
  const log = ((msg: string) => {
    if (!o.quiet) emit(msg);
  }) as Log;
  log.warn = (msg: string) => emit(msg, true);
  log.status = (text: string | null) => {
    if (!o.status || o.quiet) return;
    if (shown !== null) o.status.raw(ERASE);
    const stamp = o.elapsed ? `[${fmtElapsed(now() - t0)}] ` : "";
    const full = text === null ? null : stamp + text;
    const width = Math.max(20, o.status.columns() - 1);
    shown = full === null ? null : paint("dim", full.length > width ? `${full.slice(0, width - 1)}…` : full);
    if (shown !== null) o.status.raw(shown);
  };
  return log;
}

// A clock reading: "4:07", "41:02", "1:41:02".
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// A rough duration for estimates: "40 s", "12 min", "1.6 h".
export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

// "4-40 min", "40 s-12 min", "12 min": a range whose ends share a unit where they can.
export function fmtDurationRange(loMs: number, hiMs: number): string {
  const lo = fmtDuration(loMs);
  const hi = fmtDuration(hiMs);
  if (lo === hi) return lo;
  const [loN, loUnit] = lo.split(" ");
  const [hiN, hiUnit] = hi.split(" ");
  return loUnit === hiUnit ? `${loN}-${hiN} ${hiUnit}` : `${lo}-${hi}`;
}
