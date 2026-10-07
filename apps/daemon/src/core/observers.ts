/**
 * Every mechanism in this daemon that watches or waits for something in the world, and what each
 * last did.
 *
 * ## Why this exists
 *
 * On 2026-09-22 the hq tunnel's peer pushed a new resolver ten seconds after the core's
 * configuration was written, and the mechanism built that same day to follow exactly that did
 * nothing for more than ten hours. Nothing on the device said so. It could not have: the resolver
 * follower spoke only when it acted, and a follower that has stopped acting — because it was never
 * asked, because its one attempt was refused, because its timer was never set — produces precisely
 * the same output as one that is running and has nothing to do. **A mechanism that is silent while
 * idle cannot be told apart from a dead one.**
 *
 * So every observer reports three things, in one shape, whether or not anything is wrong:
 *
 * * **when it last looked, and what it saw** — the reading, so "idle" is a statement with content;
 * * **when it last acted, and what it did** — so a person can see the last time it mattered;
 * * **whether it is running at all** — and when it is not, that is a *problem* with a reason, never
 *   an absence. A watch that failed to arm and a timer never scheduled are the two ways this project
 *   has already lost a mechanism without a sound (`docs/16-implementation-notes.md`, *What wakes this
 *   mechanism, and in which ordinary states will nothing ever wake it?*).
 *
 * And one derived verdict: an observer with a cadence that has not looked within it is **stale**.
 *
 * ## The clock
 *
 * This board has no RTC battery, and its wall clock can step by days while the daemon runs. Every
 * age here is a difference of `performance.now()` readings, which is monotonic from process start.
 * The ISO instant stored beside each reading is for a person and is never subtracted from anything —
 * the same rule `core/drift.ts` states for its report and `platform/clock.ts` explains the reason for.
 *
 * ## Deliberately small
 *
 * A handle with four calls and a report. No scheduling, no retries, no policy: each mechanism keeps
 * its own loop, and this only records what the loop did. A framework that owned the loops would be a
 * second place for the loop's logic to live, and the two would disagree the first time one changed.
 */

/** What a mechanism tells the registry. Every call is cheap and none of them can throw. */
export interface ObserverHandle {
  /** The mechanism is running: its watch is established or its timer is set. */
  armed(detail?: string): void;
  /** The mechanism is **not** running, and why. Shown as a problem until `armed` is called again. */
  notRunning(reason: string): void;
  /**
   * It looked at the world, and this is what it saw. Called when idle too — that is the point.
   *
   * `items` is the reading **one subject at a time** — one per guard, for the watchdog — and every
   * item is kept. The summary is bounded; the list of subjects is not truncated, because a reading
   * that drops a subject hides it: measured on the bench board, 2026-09-23, the watchdog's one-string
   * reading was cut at 300 characters and the fourth guard never appeared.
   */
  looked(saw: string, items?: ObserverItem[]): void;
  /** It changed something, or recorded something for a person, and this is what. */
  acted(did: string): void;
  /**
   * What it watches is failing, in a sentence — or `null` when it no longer is.
   *
   * Separate from `looked`, because a watcher that is running and looking is `ok` by every measure
   * of itself while the thing it watches may be down. Measured 2026-09-23: the tunnel watchdog read
   * `ok` while a guard it probes had blocked a tunnel's traffic.
   */
  failing(problem: string | null): void;
}

export interface ObserverSpec {
  /** A stable identifier, used by the API and by tests. */
  name: string;
  /** What in the world it watches, in the words a person would use. */
  watches: string;
  /**
   * The longest it should go without looking, in milliseconds, or `null` for a mechanism that looks
   * only when an event arrives. A `null` observer is never stale — a quiet network produces no event,
   * and calling that stale would be an alarm about nothing — so it can only go red by not running.
   *
   * A function when the cadence is a setting a profile can change, so the verdict follows the setting
   * rather than the value it had when the daemon started.
   */
  everyMs: number | null | (() => number | null);
}

/**
 * The verdict for one observer.
 *
 * * `ok` — running, and it has looked within its cadence (or has no cadence).
 * * `stale` — running by its own account, and it has not looked for longer than its cadence allows.
 * * `not-running` — its watch is not established, its timer is not set, or it was never started.
 * * `failing` — running and looking, and what it looked at is failing. Its own words say what.
 */
export type ObserverState = 'ok' | 'stale' | 'not-running' | 'failing';

/** One subject of a reading: a guard, a tunnel. Each field is bounded; the list is not. */
export interface ObserverItem {
  subject: string;
  state: string;
  note: string | null;
  /** How the subject was measured — for a guarded tunnel: keepalive, gateway echo, traffic, neutral endpoints. */
  method?: string;
  /** What the mechanism did about this reading, including nothing and why. */
  action?: string;
  /**
   * How the subject itself reads: `bad` is red on the panel. A tunnel that reads dead is `bad` even when
   * nothing acted on it — that is the case the panel exists to show.
   */
  tone?: 'ok' | 'warn' | 'bad';
  /**
   * For a tunnel whose traffic is leaving outside it (`fall-through`, G31): whole seconds, on the
   * daemon's monotonic clock, from when this daemon first saw it so until this reading. A client adds the
   * reading's `ageSeconds` and subtracts from its own clock to say "since"; this board has no RTC.
   */
  fallingThroughSeconds?: number;
}

export interface ObserverReading {
  /** For a person. Never used in arithmetic. */
  at: string;
  /** Seconds ago, from the monotonic clock. */
  ageSeconds: number;
  what: string;
  /** Present when the observer reported per subject. */
  items?: ObserverItem[];
}

export interface ObserverReport {
  name: string;
  watches: string;
  everySeconds: number | null;
  state: ObserverState;
  /** Why the state is not `ok`, in a sentence. `null` exactly when the state is `ok`. */
  problem: string | null;
  lastLooked: ObserverReading | null;
  lastActed: ObserverReading | null;
}

/**
 * How far past its cadence an observer may be before it is stale.
 *
 * Half as much again. A timer fires at its interval and then spends time doing its work, and a check
 * that flickers red on every round that took a second is a check people learn to ignore. Half an
 * interval is more slack than any round here takes, and much less than the gap that matters: a
 * fifteen-minute monitor is stale after twenty-two and a half minutes, not after an hour.
 */
export const STALE_AFTER = 1.5;

interface Entry {
  spec: ObserverSpec;
  running: boolean;
  /** Why it is not running. `null` with `running` false means it was never started. */
  reason: string | null;
  armedAtMs: number | null;
  looked: { atMs: number; at: string; what: string; items?: ObserverItem[] } | null;
  acted: { atMs: number; at: string; what: string } | null;
  failing: string | null;
}

export interface ObserverRegistry {
  register(spec: ObserverSpec): ObserverHandle;
  report(): ObserverReport[];
}

export function createObserverRegistry(options: { monotonicMs?: () => number; wallClock?: () => Date } = {}): ObserverRegistry {
  const monotonic = options.monotonicMs ?? ((): number => performance.now());
  const wall = options.wallClock ?? ((): Date => new Date());
  const entries = new Map<string, Entry>();

  const stamp = (what: string): { atMs: number; at: string; what: string } => ({
    atMs: monotonic(),
    at: wall().toISOString(),
    // Bounded: a reading is a sentence, and an observer that pastes a whole document into one would
    // make the Status screen the place that document is published.
    what: what.length <= 300 ? what : `${what.slice(0, 300)}…`,
  });

  const bound = (value: string, limit: number): string => (value.length <= limit ? value : `${value.slice(0, limit)}…`);

  const reading = (value: Entry['looked'], now: number): ObserverReading | null =>
    value === null
      ? null
      : {
          at: value.at,
          ageSeconds: Math.max(0, Math.round((now - value.atMs) / 1000)),
          what: value.what,
          ...(value.items === undefined ? {} : { items: value.items }),
        };

  return {
    register(spec) {
      const entry: Entry = { spec, running: false, reason: null, armedAtMs: null, looked: null, acted: null, failing: null };
      entries.set(spec.name, entry);
      return {
        armed() {
          if (!entry.running) entry.armedAtMs = monotonic();
          entry.running = true;
          entry.reason = null;
        },
        notRunning(reason) {
          entry.running = false;
          entry.reason = reason;
        },
        looked(saw, items) {
          entry.looked = {
            ...stamp(saw),
            ...(items === undefined
              ? {}
              : {
                  items: items.map((item) => ({
                    subject: bound(item.subject, 80),
                    state: bound(item.state, 60),
                    // 400, not 160: a tunnel's reading carries two measurements — its keepalive and its
                    // gateway echo — and cut at 160 the second one, which is the confirming half, was
                    // the one that disappeared.
                    note: item.note === null ? null : bound(item.note, 400),
                    ...(item.method === undefined ? {} : { method: bound(item.method, 60) }),
                    ...(item.action === undefined ? {} : { action: bound(item.action, 300) }),
                    ...(item.tone === undefined ? {} : { tone: item.tone }),
                    // Copied by name like every field here: a field this list does not name never
                    // reaches the API, with no error — the same silence as the response schema's.
                    ...(item.fallingThroughSeconds === undefined ? {} : { fallingThroughSeconds: item.fallingThroughSeconds }),
                  })),
                }),
          };
        },
        acted(did) {
          entry.acted = stamp(did);
        },
        failing(problem) {
          entry.failing = problem;
        },
      };
    },

    report() {
      const now = monotonic();
      return [...entries.values()].map((entry): ObserverReport => {
        const { spec } = entry;
        const everyMs = cadenceOf(spec);
        const base = {
          name: spec.name,
          watches: spec.watches,
          everySeconds: everyMs === null ? null : Math.round(everyMs / 1000),
          lastLooked: reading(entry.looked, now),
          lastActed: reading(entry.acted, now),
        };

        if (!entry.running) {
          return {
            ...base,
            state: 'not-running',
            problem:
              entry.reason === null
                ? `${spec.name} was never started: nothing is watching ${spec.watches}`
                : `${spec.name} is not running, so nothing is watching ${spec.watches}: ${entry.reason}`,
          };
        }

        if (everyMs !== null) {
          // Measured from the last look, or from arming when it has never looked: a loop that was set
          // up and never went round is the timer-never-scheduled case wearing a different coat.
          const since = entry.looked?.atMs ?? entry.armedAtMs ?? now;
          const idleMs = now - since;
          if (idleMs > everyMs * STALE_AFTER) {
            return {
              ...base,
              state: 'stale',
              problem:
                `${spec.name} is supposed to look every ${describe(everyMs)} and has not ` +
                `${entry.looked === null ? 'looked once since it started' : 'looked'} for ${describe(idleMs)}`,
            };
          }
        }

        if (entry.failing !== null) {
          return { ...base, state: 'failing', problem: entry.failing };
        }

        return { ...base, state: 'ok', problem: null };
      });
    },
  };
}

/**
 * The cadence now. A setting that cannot be read gives no cadence rather than an exception: the report
 * is how a person learns something is wrong, and it must not be the thing that fails.
 */
function cadenceOf(spec: ObserverSpec): number | null {
  if (typeof spec.everyMs !== 'function') return spec.everyMs;
  try {
    return spec.everyMs();
  } catch {
    return null;
  }
}

function describe(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${String(minutes)} min` : `${String(Math.round(minutes / 60))} h`;
}

/** A handle that records nothing, for callers — mostly tests — that have no registry. */
export const UNOBSERVED: ObserverHandle = {
  armed: () => undefined,
  notRunning: () => undefined,
  looked: () => undefined,
  acted: () => undefined,
  failing: () => undefined,
};
