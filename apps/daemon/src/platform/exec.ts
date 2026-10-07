/**
 * The only place in this project that starts a process.
 *
 * Everything here exists because of a specific failure mode seen on this class of
 * hardware, not as general defensive programming:
 *
 * * **No shell, ever.** Arguments are passed as an array. A shell would make every
 *   value that reaches a command — an SSID, an interface name — a place where quoting
 *   decides whether the device stays reachable.
 * * **Every call has a timeout and is killed when it expires.** `hostapd_cli` called
 *   with an empty interface argument hangs forever instead of failing, and a daemon
 *   that must stay reachable cannot afford a wedged child.
 * * **No argument may be empty or whitespace.** This is the guard for the same trap,
 *   one level below the caller: an unset interface name becomes an empty string long
 *   before anyone notices, and the command then waits for a socket that never appears.
 * * **Output is capped, in bytes.** `journalctl` can produce more text than this board has RAM.
 *   The cap counts bytes rather than string length: a string's `length` is UTF-16 code units, so a
 *   cap applied to it lets non-ASCII output — an SSID, a log line in any language — occupy several
 *   times the intended budget before anything stops it. Chunks are therefore kept as buffers and
 *   decoded once at the end, which also removes the question of a multi-byte character split across
 *   two chunks.
 */

import { spawn } from 'node:child_process';

export interface RunOptions {
  timeoutMs?: number;
  /** Bytes of stdout kept — actual bytes, not string length. Beyond it output is dropped and `truncated` is set. */
  maxOutputBytes?: number;
  /** Written to the child's stdin and then closed. */
  stdin?: string;
  env?: Record<string, string>;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /** Wall time, useful when a command is slower than it should be. */
  durationMs: number;
}

export class EmptyArgumentError extends Error {
  constructor(command: string, index: number) {
    super(
      `${command}: argument ${index} is empty. An empty argument is never intentional here — ` +
        'hostapd_cli with an empty interface hangs forever rather than failing.',
    );
    this.name = 'EmptyArgumentError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

export async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  args.forEach((arg, index) => {
    if (arg.trim() === '') throw new EmptyArgumentError(command, index);
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const startedAt = Date.now();

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first; a child that ignores it is killed when the process group goes.
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) return;
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes = maxOutputBytes;
        truncated = true;
        child.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 64 * 1024) return;
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        // Decoded once, at the end: a character split across two chunks is then never a question.
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export class CommandFailedError extends Error {
  // Fields are declared and assigned separately rather than as constructor parameter
  // properties: the runtime's type stripping is erase-only and rejects parameter
  // properties outright ("TypeScript parameter property is not supported in strip-only
  // mode"), so the tests cannot run against source that uses them.
  readonly command: string;
  readonly args: string[];
  readonly result: RunResult;

  constructor(command: string, args: string[], result: RunResult) {
    super(
      `${command} ${args.join(' ')} failed (code ${String(result.code)}${
        result.timedOut ? ', timed out' : ''
      }): ${result.stderr.trim() || result.stdout.trim()}`,
    );
    this.name = 'CommandFailedError';
    this.command = command;
    this.args = args;
    this.result = result;
  }
}

/** Same as `run`, but a non-zero exit is an error. For commands that must succeed. */
export async function runOk(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new CommandFailedError(command, args, result);
  return result;
}

/**
 * The outcome of a bounded line read, as **one** discriminated value.
 *
 * It is a union rather than a record of flags on purpose. The first version returned
 * `{ lines, hasMore, timedOut }`, and the caller read `hasMore` and never looked at `timedOut` — so
 * a read cut short by its own timeout was reported as a complete page, and a log viewer paging
 * through that answer walked straight across a hole without noticing. The bug the rewrite existed
 * to remove came back through a different door.
 *
 * A single `kind` makes that shape impossible: there is no field to read while ignoring the other,
 * and adding a new way for a read to end forces every caller to be re-examined by the compiler.
 */
export type LineReadOutcome =
  | { kind: 'complete'; lines: string[] }
  /** The page filled and at least one more line exists behind it. */
  | { kind: 'more'; lines: string[] }
  /** The read was abandoned before the page filled: these lines are a fragment, not a page. */
  | { kind: 'cut-short'; lines: string[]; reason: 'timeout' };

/**
 * Runs a command and keeps only the first `maxLines` lines of its output, stopping the child as soon
 * as one more line proves there is more to come.
 *
 * This exists for forward paging: `journalctl -n N` is tail-anchored, so asking for "N lines after
 * this cursor" with `-n` returns the *newest* N of the matching entries and silently drops
 * everything between the cursor and them. Reading forward and stopping early is the only way to get
 * a page that is contiguous from where the last one ended.
 */
export async function runLines(
  command: string,
  args: string[],
  options: RunOptions & { maxLines: number },
): Promise<LineReadOutcome> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const lines: string[] = [];
    let sawMore = false;
    let timedOut = false;

    const handle = streamLines(command, args, {
      onLine: (line) => {
        if (lines.length < options.maxLines) {
          lines.push(line);
          return;
        }
        // One line past the page is all it takes to know there is more; nothing beyond it is read.
        sawMore = true;
        handle.stop();
      },
      onExit: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Order matters: a read that timed out is cut short even if it had already seen enough to
        // know more exists, because the lines it did collect may stop short of the page.
        if (timedOut) resolve({ kind: 'cut-short', lines, reason: 'timeout' });
        else if (sawMore) resolve({ kind: 'more', lines });
        else resolve({ kind: 'complete', lines });
      },
      onError: (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      handle.stop();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();
  });
}

export interface StreamHandle {
  /** Stop the process. Safe to call more than once. */
  stop(): void;
}

/**
 * A long-lived child whose stdout is read line by line: `ip monitor` and a subscribed
 * `hostapd_cli`. These are event sources, so they are restarted by the caller when
 * they exit — a dead event source must not silently mean "nothing is happening".
 */
export function streamLines(
  command: string,
  args: string[],
  handlers: {
    onLine: (line: string) => void;
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
    onError?: (error: Error) => void;
    /**
     * Keep an open pipe on the child's stdin and never write to it.
     *
     * Needed for `hostapd_cli`: measured on the bench board, it prints its banner and exits
     * immediately when stdin is closed, and only stays attached — printing unsolicited events — as
     * long as stdin is open. With `stdio: 'ignore'` the subscriber dies a millisecond after it
     * starts and the absence of events looks exactly like an idle access point.
     */
    keepStdinOpen?: boolean;
  },
): StreamHandle {
  args.forEach((arg, index) => {
    if (arg.trim() === '') throw new EmptyArgumentError(command, index);
  });

  // Detached, so the child gets its own process group and `stop()` can signal the whole group.
  // Killing only the direct child leaves any grandchild alive holding the stdout pipe open, and the
  // reader then waits for a process it has already killed — measured while testing the timeout
  // path: a 300 ms read took 30 s, because the child's `sleep` outlived the child.
  const child = spawn(command, args, {
    stdio: [handlers.keepStdinOpen === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let buffer = '';

  // With a variable stdio tuple the types no longer prove stdout exists, and a stream that is
  // genuinely missing means the child could not be started — reported rather than crashed on.
  const stdout = child.stdout;
  if (stdout === null) {
    handlers.onError?.(new Error(`${command}: no stdout to read`));
    return { stop: () => child.kill('SIGTERM') };
  }

  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') handlers.onLine(line);
      index = buffer.indexOf('\n');
    }
    // A line longer than this is not a line; drop the buffer rather than grow forever.
    if (buffer.length > 1024 * 1024) buffer = '';
  });
  child.stderr?.on('data', () => {
    /* Diagnostics only: these tools write routine notices to stderr. */
  });
  child.on('error', (error) => handlers.onError?.(error));

  // Whichever comes first. `close` waits for every pipe to be closed, which a surviving grandchild
  // can hold open indefinitely; `exit` says the child itself is gone, which is what a caller waiting
  // to stop is waiting for.
  let ended = false;
  const end = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (ended) return;
    ended = true;
    handlers.onExit?.(code, signal);
  };
  child.on('close', end);
  child.on('exit', end);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      killGroup(child.pid, 'SIGTERM');
      // A child that ignores SIGTERM is not allowed to keep a daemon waiting.
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 2000).unref();
    },
  };
}

/**
 * Signals the child's whole process group, falling back to the child alone.
 *
 * The group is what matters: a tool that spawns a helper leaves that helper holding the pipes, and
 * the negative pid is the only way to reach it. Both calls are allowed to fail — by the time a kill
 * is attempted the process is often already gone, and that is the outcome being asked for.
 */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* Already gone. */
    }
  }
}
