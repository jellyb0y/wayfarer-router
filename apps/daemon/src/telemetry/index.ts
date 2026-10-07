/**
 * Live state: assembled in memory, pushed over one event stream, never written to the card.
 *
 * Deliberately not persisted: interface state, station lists, signal strength, traffic
 * counters, log lines. The memory card is the only part of this device that wears out and
 * telemetry is the one thing guaranteed to be written constantly. The measured baseline write
 * rate for the whole device is 650–750 B/s, and this module must not move that number.
 *
 * Coalescing is part of the design rather than an optimisation: bringing one interface up
 * produces link, address and route events within milliseconds, and a client that receives
 * forty status events for one change is a client that redraws forty times on a phone.
 */

import { EventEmitter } from 'node:events';
import type { Platform } from '../platform/index.ts';
import type { UnitState } from '../platform/systemd.ts';
import type { NetSnapshot } from '../platform/net.ts';
import type { HostapdStation, HostapdStatus } from '../platform/parse/hostapd.ts';
import type { IwLink } from '../platform/parse/iw-dev.ts';
import type { StationListing } from '../platform/ap.ts';
import type { StreamHandle } from '../platform/exec.ts';
import { aggregateTunnelStatus, type TunnelStatus, type TunnelUnitReading } from '../core/tunnel-health.ts';

export type { TunnelStatus };

export interface StationEvent {
  accessPointInterface: string;
  mac: string;
  action: 'connected' | 'disconnected';
  at: string;
}

/**
 * How the poller itself is doing. Part of the status payload because a poll that is being skipped
 * every tick produces a status view that simply stops changing, and nothing else in the interface
 * would say why.
 */
export interface PollerState {
  polls: number;
  skipped: number;
  failures: number;
  lastDurationMs: number | null;
  lastPollAt: string | null;
  lastSkipAt: string | null;
  /** Set while a poll is in flight, so a wedged one can be reported with its age. */
  startedAtMs: number | null;
}

/**
 * One access point as the status snapshot carries it.
 *
 * `stationsComplete` says whether `stations` is the whole table, and `stationsIncomplete` says why
 * not when it is not. The wire used to carry `stationsIterated` — the platform layer's "the reply was
 * truncated and rebuilt one station at a time" — and the screens read it as "the list is complete",
 * so every ordinary, whole reply was drawn as an unfinished one. The field is named for the question
 * the reader asks, not for the mechanism that answered it.
 */
export interface AccessPointReading {
  status: HostapdStatus | null;
  stations: HostapdStation[];
  stationsComplete: boolean;
  /** Why the list is not whole, in a sentence; `null` exactly when `stationsComplete` is true. */
  stationsIncomplete: string | null;
}

export interface LiveStatus {
  at: string;
  /** Interfaces with their addresses and carrier state. */
  network: NetSnapshot | null;
  units: Record<string, UnitState>;
  accessPoints: Record<string, AccessPointReading>;
  links: Record<string, IwLink>;
  clock: { synchronized: boolean | null; ntpEnabled: boolean | null; at: string } | null;
  /**
   * One entry per tunnel of the last recorded plan, or `null` until a reading has been taken.
   *
   * **`null` and `[]` are different answers.** `[]` says this profile has no tunnels; `null` says
   * nobody has looked yet. A client that draws nothing for an empty list would draw exactly the same
   * nothing for a device whose tunnels have never been read, and "no tunnels configured" is the
   * reassuring one of the two — which is the shape of failure this project has now hit four times.
   *
   * Each entry's `service` is an **aggregate over that tunnel's units** and says nothing about
   * whether traffic passes through it. See `core/tunnel-health.ts`.
   */
  tunnels: TunnelStatus[] | null;
  poller: PollerState;
}

export interface TelemetryEvent {
  event: 'status' | 'unit' | 'station' | 'log' | 'hello';
  data: unknown;
  /** Monotonic within a process lifetime; used as the stream's event id. */
  id: number;
}

export interface Telemetry {
  snapshot(): LiveStatus;
  /** Recent station arrivals and departures, newest first. Bounded. */
  stationHistory(): StationEvent[];
  subscribe(listener: (event: TelemetryEvent) => void): () => void;
  /** Wire the platform event sources. Returns a stop function. */
  start(options: StartOptions): Promise<() => Promise<void>>;
  /**
   * Run one poll now, if one is not already running. Returns whether it ran: a caller that asks
   * while a poll is in flight gets `false` and a counted skip rather than a second round of child
   * processes.
   */
  pollNow(): Promise<boolean>;
  /** Units to watch, replacing the current set. */
  watchUnits(units: string[]): void;
  /** Interfaces treated as access points for polling and events. */
  watchAccessPoints(interfaces: string[]): void;
  /** Interfaces to poll for link quality. */
  watchLinks(interfaces: string[]): void;
  /**
   * The tunnels to report on, and **the units each one is made of**, replacing the current set.
   *
   * The units are passed in rather than derived here because they come from per-protocol rules in
   * `core/catalogue/`, and a second copy of a naming rule is the defect this project spends most of
   * its effort avoiding — the same argument, and the same wording, as the tunnel interface names on
   * the recorded management surfaces.
   *
   * Calling this with `[]` is a statement that the profile has no tunnels, and the next reading then
   * publishes `[]`. Not calling it at all leaves the snapshot's `tunnels` at `null`.
   */
  watchTunnels(tunnels: { id: string; units: string[] }[]): void;
  recordLog(entry: { level: string; msg: string; at: string }): void;
}

export interface StartOptions {
  /** How often access-point and link state are polled, in milliseconds. */
  pollIntervalMs?: number;
  /** How long a burst of changes is collected before one status event is emitted. */
  coalesceMs?: number;
}

const STATION_HISTORY_SIZE = 200;
const LOG_RING_SIZE = 200;

/**
 * One unit of a tunnel, read with `systemctl show`.
 *
 * A failed read produces a reading whose every field is `null` rather than a thrown error or a
 * zeroed one, and that shape carries the difference the aggregate turns on: `restarts: null` is "we
 * could not look", and `restarts: 0` is "systemd has restarted this unit no times". Collapsing the
 * first into the second is how a reading becomes reassuring news about a unit nobody could reach.
 */
async function readTunnelUnit(platform: Platform, unit: string): Promise<TunnelUnitReading> {
  const shown = await platform.systemd.show(unit).catch(() => null);
  if (shown === null) {
    return { unit, activeState: null, loadState: null, restarts: null, activeEnterSinceBootSeconds: null };
  }
  const restarts = Number(shown.properties['NRestarts']);
  // Microseconds since boot, per systemd. Zero is what a unit that has never been active reports,
  // and it is filtered by the aggregate rather than here so that this stays a transcription.
  const monotonic = Number(shown.properties['ActiveEnterTimestampMonotonic']);
  return {
    unit,
    activeState: typeof shown.properties['ActiveState'] === 'string' ? shown.properties['ActiveState'] : null,
    loadState: typeof shown.properties['LoadState'] === 'string' ? shown.properties['LoadState'] : null,
    restarts: Number.isFinite(restarts) ? restarts : null,
    activeEnterSinceBootSeconds: Number.isFinite(monotonic) ? monotonic / 1_000_000 : null,
  };
}

export function createTelemetry(platform: Platform): Telemetry {
  const emitter = new EventEmitter();
  // A status event per subscriber per change would be fine; what is not fine is unbounded
  // listeners silently capping at ten, which is the EventEmitter default.
  emitter.setMaxListeners(0);

  let eventId = 0;
  const status: LiveStatus = {
    at: new Date().toISOString(),
    network: null,
    units: {},
    accessPoints: {},
    links: {},
    clock: null,
    // `null`, not `[]`: nothing has been read. See `LiveStatus.tunnels`.
    tunnels: null,
    poller: { polls: 0, skipped: 0, failures: 0, lastDurationMs: null, lastPollAt: null, lastSkipAt: null, startedAtMs: null },
  };
  const stationHistory: StationEvent[] = [];
  const logRing: { level: string; msg: string; at: string }[] = [];
  const pollerState: PollerState = {
    polls: 0,
    skipped: 0,
    failures: 0,
    lastDurationMs: null,
    lastPollAt: null,
    lastSkipAt: null,
    startedAtMs: null,
  };

  let unitsWatched: string[] = [];
  let accessPointsWatched: string[] = [];
  let linksWatched: string[] = [];
  /**
   * `null` until something tells us what the tunnels are; `[]` once something says there are none.
   *
   * The distinction is kept here as well as on the snapshot, so that a device nobody has told about
   * its tunnels never publishes the reassuring empty list — the reading only happens once this is a
   * list, and it is only a list once a caller has made a statement about it.
   */
  let tunnelsWatched: { id: string; units: string[] }[] | null = null;
  /**
   * Set when the watched set changes, so the next poll reads regardless of the cadence.
   *
   * Without it the first reading after an apply is up to six polls away, and the moment somebody
   * most wants to know what a tunnel is doing is the moment just after they changed it. The cadence
   * is about the steady state — six spawns every poll, forever — not about the first answer.
   */
  let tunnelsChanged = false;

  let coalesceTimer: NodeJS.Timeout | undefined;
  let coalesceMs = 200;
  /** Set once the platform event sources are running, so the watched set can be changed later. */
  let resubscribe: (() => void) | null = null;
  /** Set once polling is running, so a caller can ask for a poll without racing the scheduler. */
  let runPollNow: (() => Promise<boolean>) | null = null;

  const emit = (event: TelemetryEvent['event'], data: unknown): void => {
    eventId += 1;
    emitter.emit('event', { event, data, id: eventId } satisfies TelemetryEvent);
  };

  const scheduleStatus = (): void => {
    if (coalesceTimer) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      status.at = new Date().toISOString();
      emit('status', status);
    }, coalesceMs);
    coalesceTimer.unref();
  };

  const telemetry: Telemetry = {
    snapshot() {
      status.poller = pollerState;
      return status;
    },

    stationHistory() {
      return stationHistory;
    },

    subscribe(listener) {
      emitter.on('event', listener);
      return () => emitter.off('event', listener);
    },

    watchUnits(units) {
      const next = [...new Set(units.filter((unit) => unit.trim() !== ''))];
      const changed = next.length !== unitsWatched.length || next.some((unit) => !unitsWatched.includes(unit));
      unitsWatched = next;
      if (changed) resubscribe?.();
    },

    watchAccessPoints(interfaces) {
      accessPointsWatched = [...new Set(interfaces.filter((name) => name.trim() !== ''))];
    },

    watchLinks(interfaces) {
      linksWatched = [...new Set(interfaces.filter((name) => name.trim() !== ''))];
    },

    watchTunnels(tunnels) {
      // A tunnel with no id is dropped rather than reported under an empty name; its unit names are
      // kept exactly as the plan recorded them, because inventing or normalising one here would be
      // the second copy of the naming rule this argument exists to avoid.
      tunnelsWatched = tunnels
        .filter((tunnel) => tunnel.id.trim() !== '')
        .map((tunnel) => ({ id: tunnel.id, units: [...new Set(tunnel.units.filter((unit) => unit.trim() !== ''))] }));
      tunnelsChanged = true;
    },

    async pollNow() {
      if (runPollNow === null) return false;
      return await runPollNow();
    },

    recordLog(entry) {
      logRing.unshift(entry);
      if (logRing.length > LOG_RING_SIZE) logRing.length = LOG_RING_SIZE;
      // Log events are rate-limited by the caller; this stream is for the interface's tail
      // view, not for shipping the journal.
      emit('log', entry);
    },

    async start(options = {}) {
      coalesceMs = options.coalesceMs ?? 200;
      const pollIntervalMs = options.pollIntervalMs ?? 5000;
      const handles: StreamHandle[] = [];
      const stoppers: (() => void)[] = [];

      // Network: `ip monitor` as a debounced trigger, then a full re-read. Idempotent against
      // missed events by construction.
      handles.push(
        platform.net.watch((snapshot) => {
          status.network = snapshot;
          scheduleStatus();
        }),
      );

      // systemd: unit transitions arrive as signals, so a tunnel dropping shows up when it
      // drops rather than at the next poll.
      // The watched set is passed in explicitly. Subscribing to systemd's unit lifecycle signals
      // and reading unit state in the handler is a feedback loop — see the measurement in
      // platform/systemd.ts — so only these units are subscribed to and read.
      let unitWatch: { stop: () => void } | null = null;
      const resubscribeUnits = async (): Promise<void> => {
        unitWatch?.stop();
        unitWatch = await platform.systemd.watch(unitsWatched, (state) => {
          status.units[state.unit] = state;
          emit('unit', state);
          scheduleStatus();
        });
      };
      try {
        await resubscribeUnits();
        stoppers.push(() => unitWatch?.stop());
      } catch (error) {
        // A missing system bus must not take the whole status view down; it is reported and
        // the rest keeps working.
        telemetry.recordLog({
          level: 'warn',
          msg: `systemd events unavailable: ${String(error)}`,
          at: new Date().toISOString(),
        });
      }

      const apWatches = new Map<string, StreamHandle>();
      const syncApWatches = (): void => {
        for (const name of accessPointsWatched) {
          if (apWatches.has(name)) continue;
          try {
            const handle = platform.ap.watch(name, (event) => {
              if (event.kind === 'station-connected' || event.kind === 'station-disconnected') {
                const record: StationEvent = {
                  accessPointInterface: event.interfaceName ?? name,
                  mac: event.mac,
                  action: event.kind === 'station-connected' ? 'connected' : 'disconnected',
                  at: new Date().toISOString(),
                };
                stationHistory.unshift(record);
                if (stationHistory.length > STATION_HISTORY_SIZE) stationHistory.length = STATION_HISTORY_SIZE;
                emit('station', record);
              }
              scheduleStatus();
            });
            apWatches.set(name, handle);
          } catch (error) {
            telemetry.recordLog({
              level: 'warn',
              msg: `access-point events unavailable for ${name}: ${String(error)}`,
              at: new Date().toISOString(),
            });
          }
        }
        for (const [name, handle] of apWatches) {
          if (!accessPointsWatched.includes(name)) {
            handle.stop();
            apWatches.delete(name);
          }
        }
      };

      let pollCount = 0;
      const poll = async (): Promise<void> => {
        syncApWatches();
        pollCount += 1;

        // Every read keeps its own last-good value, and one failure never blanks a neighbour. The
        // first version wrapped an access point's status and its station list in a single `try`, so
        // a station read that timed out also erased a perfectly good `state: ENABLED, channel: 149`
        // — a status view turning "I could not ask" into "there is nothing there" is the same
        // mistake as tearing down a listener on a failed address read, one screen further out.
        const reads: Promise<void>[] = [];

        for (const name of accessPointsWatched) {
          const previous = status.accessPoints[name];
          reads.push(
            (async () => {
              const [apStatus, listing] = await Promise.all([
                platform.ap.status(name).catch(() => (previous ? previous.status : null)),
                platform.ap.stations(name).catch(
                  (error: unknown): StationListing => ({
                    complete: false,
                    // The last list is kept rather than blanked — "I could not ask" is not "nobody
                    // is here" — but it is then an old list, and it is marked as not whole.
                    stations: previous ? previous.stations : [],
                    iterated: false,
                    reason:
                      `the station list could not be read (${error instanceof Error ? error.message : String(error)})` +
                      (previous ? '; the list shown is the last one that was' : ''),
                  }),
                ),
              ]);
              status.accessPoints[name] = {
                status: apStatus,
                stations: listing.stations,
                stationsComplete: listing.complete,
                stationsIncomplete: listing.complete ? null : listing.reason,
              };
            })(),
          );
        }

        for (const name of linksWatched) {
          reads.push(
            platform.wifi
              .link(name)
              .then((link) => {
                status.links[name] = link;
              })
              .catch(() => undefined),
          );
        }

        for (const unit of unitsWatched) {
          reads.push(
            platform.systemd
              .state(unit)
              .then((state) => {
                status.units[unit] = state;
              })
              .catch(() => undefined),
          );
        }

        // The clock is read every sixth poll rather than every one: `timedatectl show` is a process
        // spawn, the answer changes at most once a minute in practice, and on a 4×Cortex-A53 every
        // avoided spawn is visible in the CPU time this unit accumulates.
        if (pollCount % 6 === 1) {
          reads.push(
            platform.clock
              .status()
              .then((clock) => {
                status.clock = {
                  synchronized: clock.synchronized,
                  ntpEnabled: clock.ntpEnabled,
                  at: new Date().toISOString(),
                };
              })
              .catch(() => undefined),
          );
        }

        /*
         * Tunnels, on the clock's reduced cadence and for the clock's reason.
         *
         * A reading is one `systemctl show` **per unit**, each a process spawn, and a tunnel is not
         * one unit — four tunnels, two of them behind a transport, is an ordinary configuration on
         * this board and would be six spawns every poll. Six restarts and a start timestamp do not
         * change between two polls often enough to be worth that on a 4×Cortex-A53.
         *
         * This shares the clock's tick deliberately rather than being offset from it: one tick that
         * does more work is visible in `poller.lastDurationMs`, while two staggered bursts are not
         * visible anywhere. If that duration ever grows enough to start costing skips, the offset is
         * the knob — and the counter that would show it is already on the wire.
         *
         * `UnitState` carries neither the restart count nor the timestamp, so the units already being
         * polled above cannot supply this; `show` returns all of it in one call.
         */
        if (tunnelsWatched !== null && (tunnelsChanged || pollCount % 6 === 1)) {
          const watched = tunnelsWatched;
          // Cleared before the read rather than after it: a read that fails must not re-arm itself
          // into a spawn on every poll until one succeeds, which is the accumulation failure the
          // poller's own one-at-a-time rule exists to prevent, one layer in.
          tunnelsChanged = false;
          reads.push(
            (async () => {
              /*
               * Read once for the whole batch, and read it **before** the unit timestamps.
               *
               * One uptime for every unit in the round keeps the tunnels on one clock with each
               * other as well as with themselves; a per-unit read would date two units of the same
               * tunnel from two moments and produce a `since` ordering that is an artefact of the
               * order the spawns finished in.
               */
              const uptimeSeconds = await platform.host.uptimeSeconds().catch(() => null);
              const nowMs = Date.now();
              const readings = await Promise.all(
                watched.map(async (tunnel) => ({
                  id: tunnel.id,
                  units: await Promise.all(tunnel.units.map(async (unit) => await readTunnelUnit(platform, unit))),
                })),
              );
              status.tunnels = readings.map((tunnel) =>
                aggregateTunnelStatus({ id: tunnel.id, units: tunnel.units, uptimeSeconds, nowMs }),
              );
            })().catch(() => undefined),
          );
        }

        // Run together rather than one after another: these are independent subprocesses and D-Bus
        // calls, and serialising them makes a poll as slow as the sum of its slowest drivers.
        await Promise.all(reads);
        scheduleStatus();
      };

      resubscribe = () => void resubscribeUnits().catch(() => undefined);

      /**
       * One poll at a time, and the interval measured from the **end** of the previous one.
       *
       * A fixed-rate timer over a variable-cost job is the standard way to build an accumulation
       * failure: a poll walks one child process per station and several D-Bus calls, so on a busy
       * access point or a slow driver the next tick starts before the last has finished and each
       * one piles another full round on top. On a 2 GB board that ends in the daemon being killed
       * by its own memory limit, which looks like a leak and is not.
       *
       * Skips are counted rather than silent: a poller that has quietly wedged and a poller with
       * nothing to do look identical from outside, and only the counter tells them apart.
       */
      let polling = false;
      let stopped = false;
      let nextPoll: NodeJS.Timeout | undefined;

      const runPoll = async (): Promise<boolean> => {
        if (polling) {
          pollerState.skipped += 1;
          pollerState.lastSkipAt = new Date().toISOString();
          // Logged once per run of skips, not once per skip: a wedged poll would otherwise fill the
          // journal with the fact that it is wedged.
          if (pollerState.skipped === 1 || pollerState.skipped % 12 === 0) {
            telemetry.recordLog({
              level: 'warn',
              msg: `telemetry poll skipped: the previous one has been running for ${
                performance.now() - (pollerState.startedAtMs ?? performance.now())
              } ms`,
              at: new Date().toISOString(),
            });
          }
          return false;
        }

        polling = true;
        // Monotonic, because this is a duration. Reported in a log line as "running for N ms", and a
        // wall-clock step made that a nonsense figure — which is the sort of number somebody chases.
        pollerState.startedAtMs = performance.now();
        try {
          await poll();
          pollerState.polls += 1;
          pollerState.lastDurationMs = performance.now() - pollerState.startedAtMs;
          pollerState.lastPollAt = new Date().toISOString();
        } catch {
          pollerState.failures += 1;
        } finally {
          polling = false;
          pollerState.startedAtMs = null;
        }
        return true;
      };

      runPollNow = runPoll;

      const scheduleNextPoll = (): void => {
        if (stopped) return;
        nextPoll = setTimeout(() => {
          void runPoll().finally(scheduleNextPoll);
        }, pollIntervalMs);
        nextPoll.unref();
      };

      await runPoll();
      scheduleNextPoll();

      return async () => {
        stopped = true;
        runPollNow = null;
        if (nextPoll) clearTimeout(nextPoll);
        if (coalesceTimer) clearTimeout(coalesceTimer);
        for (const handle of handles) handle.stop();
        for (const handle of apWatches.values()) handle.stop();
        for (const stop of stoppers) stop();
      };
    },
  };

  return telemetry;
}
