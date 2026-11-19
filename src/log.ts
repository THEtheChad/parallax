// The log: progress and warnings on stderr (stdout is the report).
//
//   progress  `log(msg)`: what the harness is doing; silenced by --quiet
//   warnings  `log.warn(msg)`: something that may make a result wrong or a run fail; always shown
//
// Commands take a `LogFn`: any plain `(msg) => void` works (tests pass one), and `warn(log, msg)`
// falls back to writing "warning: msg" through it when it has no warn channel of its own.

export type LogFn = ((msg: string) => void) & { warn?: (msg: string) => void };

export interface Log {
  (msg: string): void;
  warn(msg: string): void;
}

export function warn(log: LogFn | undefined, msg: string): void {
  if (!log) return;
  if (log.warn) log.warn(msg);
  else log(`warning: ${msg}`);
}

export interface LogOptions {
  // Progress lines are dropped; warnings still go out.
  quiet?: boolean;
  // Every line starts with the time since the log was made ("[41:02] "): for runs that take minutes
  // or hours, so a line says when it happened and how long a step took.
  elapsed?: boolean;
  write?: (line: string) => void;
  now?: () => number;
}

export function createLog(o: LogOptions = {}): Log {
  const write = o.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = o.now ?? (() => performance.now());
  const t0 = now();
  const emit = (msg: string): void => {
    const stamp = o.elapsed ? `[${fmtElapsed(now() - t0)}] ` : "";
    // Each line of a multi-line message gets its own stamp; blank lines (section breaks) stay blank.
    for (const line of msg.split("\n")) write(line && stamp + line);
  };
  const log = ((msg: string) => {
    if (!o.quiet) emit(msg);
  }) as Log;
  log.warn = (msg: string) => emit(`warning: ${msg}`);
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
