/**
 * systemd access: D-Bus for state and events, the CLI for enable and disable.
 *
 * Why not the CLI for everything: it gives no events, so unit state would have to be polled,
 * and `systemctl show` ignores `--output=json` (verified on systemd 257.13), which means parsing
 * key-value text anyway. Events matter because the interface should show a tunnel dropping the
 * moment it drops.
 *
 * Why the CLI for enable and disable: the D-Bus methods for these are awkward — they take file
 * lists and return change records — and these are rare operations where latency is irrelevant.
 *
 * Three traps this module exists to keep away from its callers, all three measured on the bench
 * board rather than read in a manual:
 *
 * 1. **`StartUnit` returns a job, not a result.** The call succeeding means the job was queued.
 *    Whether the unit started arrives later as a `JobRemoved` signal carrying the same job path
 *    and a result string. Code that treats the call's return as success reports a failed start as
 *    a success, every time.
 * 2. **`LoadUnit` plus a `UnitNew` subscription is a feedback loop.** `LoadUnit` makes systemd
 *    load a unit, which emits `UnitNew`; a watcher that reads state on `UnitNew` calls `LoadUnit`
 *    again, for that unit and for every other unit the traffic pulls in. Measured with the first
 *    version of this file: 54 458 `dbus-daemon` warnings — "the maximum number of pending replies
 *    for :1.41 has been reached (max_replies_per_connection=128)" — in about three minutes, the
 *    daemon's own unit state unreadable as a result, and the RAM journal filling with another
 *    service's complaints about us. So: no `UnitNew` subscription, `GetUnit` (which does not
 *    load) on the read path, and `LoadUnit` only when a caller explicitly asks about a unit.
 * 3. **Property reads are cached per object path.** Each `getInterface` costs an introspection
 *    round trip; doing that per poll per unit is how a 4×Cortex-A53 spends its day.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import dbus from 'dbus-native';
import { run } from './exec.ts';
import { parseSystemctlShow, type UnitShow } from './parse/systemctl.ts';
import { createHostReader } from './host.ts';
import {
  normaliseUnitState,
  unitIsHealthy,
  unknownUnitState,
  type UnitState,
} from './parse/unit-state.ts';

// Re-exported so callers keep one import for the systemd surface, while the pure half stays free of
// the D-Bus binding and can be tested on a device with no dependencies installed.
export { normaliseUnitState, unitIsHealthy, unknownUnitState };
export type { UnitState };

const SERVICE = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER_INTERFACE = 'org.freedesktop.systemd1.Manager';
const UNIT_INTERFACE = 'org.freedesktop.systemd1.Unit';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';

export interface JobResult {
  /** systemd's own word: `done`, `failed`, `canceled`, `timeout`, `dependency`, `skipped`. */
  result: string;
  unit: string;
  jobPath: string;
  waitedMs: number;
}

export interface SystemdController {
  start(unit: string): Promise<JobResult>;
  stop(unit: string): Promise<JobResult>;
  restart(unit: string): Promise<JobResult>;
  reload(unit: string): Promise<JobResult>;
  enable(unit: string): Promise<void>;
  disable(unit: string): Promise<void>;
  state(unit: string): Promise<UnitState>;
  show(unit: string): Promise<UnitShow>;
  daemonReload(): Promise<void>;
  /**
   * Arms a transient timer unit that runs a command after a delay, in a process of its own.
   *
   * Driven through `systemd-run` rather than `StartTransientUnit` over D-Bus, and the reason is not
   * convenience: an `--on-active` timer is **two** units, a `.timer` and the `.service` it triggers,
   * and assembling both over D-Bus means reimplementing what `systemd-run` already does correctly.
   * The platform layer is allowed to shell out; a second implementation of a systemd feature is the
   * thing to avoid.
   *
   * The whole point of this call is that the resulting process does **not** share fate with this one.
   * An in-process timer dies with the process, so a daemon that applies a bad change and then crashes
   * would leave the device stranded. See `docs/06-apply-and-rollback.md`.
   */
  runTransient(options: TransientUnitOptions): Promise<TransientResult>;
  /**
   * Stops a transient unit and its timer, and clears a failed state so the same name can be used
   * again.
   *
   * Takes the `.service` name and derives the `.timer`, because that is what `systemd-run --unit`
   * creates. Both are stopped: stopping only the service leaves the timer armed, which is a revert
   * that still fires after being cancelled.
   */
  stopTransient(unit: string): Promise<{ ok: boolean; message: string }>;
  /**
   * Restarts a unit **without waiting for it**, for the one case where waiting is impossible: the caller
   * is running inside the unit it is restarting.
   *
   * Detached and unobserved on purpose. `systemctl restart` on your own unit may kill you before it
   * returns, so a result could never be read; the restart is what matters, and the next command anybody
   * runs shows whether the unit came back. Distinct from `restart` so that this trade-off is a deliberate
   * choice at the call site rather than a silent property of the ordinary path.
   */
  restartDetached(unit: string): void;
  /** Removes a mask, so a unit a rescue took out of the boot path can be installed again. */
  unmask(unit: string): Promise<{ ok: boolean; message: string }>;
  /**
   * Sends a signal to a unit's **main process** only — never its children, which for the daemon
   * would include whatever it spawned. Used by `way revert` to tell the daemon a transaction ended.
   */
  signal(unit: string, signal: 'SIGUSR2'): Promise<{ ok: boolean; message: string }>;
  /**
   * An orderly power-off of the whole machine, asked for by a person.
   *
   * `reason` is not passed to systemd — there is nowhere to put it — and is taken so the call site has
   * to say why; the record that survives the outage is the caller's event, written before this is
   * called. The board has no power button and nothing turns it back on: the next boot is whenever
   * somebody cycles its power.
   */
  poweroff(reason: string): Promise<{ ok: boolean; message: string }>;
  /**
   * Unit names systemd knows about that start with `prefix`, **including instances**.
   *
   * A template does not name its instances, so a caller that acted only on the units it generates would
   * leave every running instance behind — which for a factory reset means a radio still hosting an
   * access point for a configuration that no longer exists.
   */
  listOwnedUnits(prefix: string): Promise<string[]>;
  /**
   * Watch a fixed set of units. The set is explicit rather than "everything systemd reports",
   * because a device with 200 units does not need 200 property reads to draw a status page — and
   * because listening to unit lifecycle signals while reading unit state is the loop described
   * above.
   */
  watch(units: string[], onChange: (state: UnitState) => void): Promise<{ stop: () => void }>;
  close(): void;
}

type Loose = Record<string, unknown> & {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  $subscribe?: (signal: string, listener: (...args: unknown[]) => void) => PromiseLike<void>;
  $unsubscribe?: (signal: string, listener: (...args: unknown[]) => void) => PromiseLike<void>;
  $readAllProps?: () => PromiseLike<Record<string, unknown>>;
  $callMethod?: (name: string, args: unknown[]) => PromiseLike<unknown>;
};

export interface TransientUnitOptions {
  /** The `.service` name. `systemd-run` derives the matching `.timer` from it. */
  unit: string;
  /**
   * How long from now the command must run, in seconds. A **deadline**, not a delay.
   *
   * The distinction is the whole reason this field was renamed. It used to be `onActiveSeconds` and
   * was passed straight to `--on-active`, which expresses the deadline as an interval from the
   * *activation of the timer unit* — and `systemctl daemon-reload` re-bases that interval to the
   * moment of the reload. Measured on systemd 257.13, 2026-09-21.
   *
   * That made it a delay anything could restart rather than a deadline. The reconciler calls
   * `daemonReload()` for every unit it installs, and the revert timer is armed *before* the reconcile
   * runs, so a network apply postponed its own revert by the full confirmation window — the one
   * promise the operator's access depends on. It is now anchored to boot, which nothing re-bases.
   */
  withinSeconds: number;
  /** Shown by `systemctl status`, so a human who finds it knows what it is for. */
  description: string;
  /** The command and its arguments. Never a shell string: no quoting, no word splitting. */
  argv: string[];
}

export interface TransientResult {
  ok: boolean;
  /** `systemd-run`'s own words. It names the unit when the name is already taken. */
  message: string;
  /**
   * Seconds since boot at which the timer will fire — the number systemd itself acts on, returned so
   * a caller that reports a countdown can report *this* rather than a second copy of the deadline
   * maintained alongside it. Absent when the unit was not armed.
   */
  firesAtUptimeSeconds?: number;
}

/** The part of the bus this module uses. `connection` is absent on a stand-in. */
export interface SystemBusLike {
  getInterface: (service: string, path: string, iface: string) => PromiseLike<unknown>;
  connection?: { end: () => void };
}

export interface SystemdOptions {
  systemctlPath?: string;
  systemdRunPath?: string;
  /** How long to wait for a JobRemoved signal before giving up on the job. */
  jobTimeoutMs?: number;
  /**
   * The bus to talk to. Defaults to the system bus.
   *
   * This exists so the job-wait below can be tested, and it exists because the job-wait was wrong
   * in a way no test could have caught while the bus was created in here: the failure depends on
   * the *order* two messages are dispatched in, which only a stand-in bus can arrange on demand.
   */
  bus?: SystemBusLike;
  /**
   * Seconds since boot, injected, because there must be exactly **one** reader of it.
   *
   * This module had a private second copy. That is not a tidiness point here: this codebase already
   * carries a warning about confusing *process* uptime with *machine* uptime — a mistake made once and
   * documented — and with two readers that fix has to be applied twice, in two places nobody would think
   * to compare. `HostReader.uptimeSeconds` is the one, and it explains in its own comment why
   * `process.uptime()` is not it.
   */
  uptimeSeconds?: () => Promise<number | null>;
}

export function createSystemdController(options: SystemdOptions = {}): SystemdController {
  const systemctlPath = options.systemctlPath ?? '/usr/bin/systemctl';
  const systemdRunPath = options.systemdRunPath ?? '/usr/bin/systemd-run';
  const jobTimeoutMs = options.jobTimeoutMs ?? 90_000;
  // The one reader, defaulting to the host reader's. A `null` is never turned into a zero here: zero would
  // anchor a deadline in the distant past and fire the revert the moment a change was made.
  const readUptimeSeconds = options.uptimeSeconds ?? createHostReader().uptimeSeconds;

  const bus: SystemBusLike = options.bus ?? (dbus.systemBus() as unknown as SystemBusLike);
  let manager: Loose | null = null;
  let subscribed = false;
  const unitInterfaces = new Map<string, Loose>();
  const propertyInterfaces = new Map<string, Loose>();
  const unitPaths = new Map<string, string>();
  const pendingJobs = new Map<string, (result: JobResult) => void>();
  const jobStartedAt = new Map<string, number>();
  /**
   * Results for jobs nobody was waiting on *yet*. See `runJob`: the signal can be dispatched before
   * the caller of `StartUnit` has resumed, so a result with no waiter is not necessarily a result
   * for someone else's job. Bounded by age and by count, because most entries really do belong to
   * jobs queued by other software and no one will ever come to collect them.
   */
  const unclaimedJobs = new Map<string, { result: JobResult; at: number }>();
  const UNCLAIMED_TTL_MS = 30_000;
  const UNCLAIMED_MAX = 64;
  let jobListenerInstalled = false;

  const rememberUnclaimed = (jobPath: string, result: JobResult): void => {
    // Monotonic: an elapsed time inside one process, where a wall-clock step would either evict every
    // entry at once or stop evicting any. Bounded by count as well, so a frozen clock cannot make the
    // map grow without limit.
    const now = performance.now();
    for (const [path, entry] of unclaimedJobs) {
      if (now - entry.at > UNCLAIMED_TTL_MS) unclaimedJobs.delete(path);
    }
    unclaimedJobs.set(jobPath, { result, at: now });
    while (unclaimedJobs.size > UNCLAIMED_MAX) {
      const oldest = unclaimedJobs.keys().next();
      if (oldest.done) break;
      unclaimedJobs.delete(oldest.value);
    }
  };

  const getManager = async (): Promise<Loose> => {
    if (manager) return manager;
    manager = (await bus.getInterface(SERVICE, MANAGER_PATH, MANAGER_INTERFACE)) as unknown as Loose;
    if (!subscribed) {
      // Without Subscribe(), systemd only emits signals to clients that asked for them. Skipping
      // it is how a watcher ends up seeing nothing and looking like a quiet system.
      await callMethod(manager, 'Subscribe', []).catch(() => undefined);
      subscribed = true;
    }
    return manager;
  };

  /**
   * Object path for a unit. `GetUnit` first because it does not load anything; `LoadUnit` only
   * when the caller explicitly asked about a unit that is not loaded — "on disk but never loaded"
   * is not the same as "not installed", and the interface has to be able to tell them apart.
   */
  const pathFor = async (unit: string, allowLoad: boolean): Promise<string | null> => {
    const cached = unitPaths.get(unit);
    if (cached !== undefined) return cached;
    const managerInterface = await getManager();
    try {
      const path = String(await callMethod(managerInterface, 'GetUnit', [unit]));
      unitPaths.set(unit, path);
      return path;
    } catch {
      if (!allowLoad) return null;
    }
    try {
      const path = String(await callMethod(managerInterface, 'LoadUnit', [unit]));
      unitPaths.set(unit, path);
      return path;
    } catch {
      return null;
    }
  };

  const unitInterfaceFor = async (path: string): Promise<Loose> => {
    const cached = unitInterfaces.get(path);
    if (cached) return cached;
    const iface = (await bus.getInterface(SERVICE, path, UNIT_INTERFACE)) as unknown as Loose;
    unitInterfaces.set(path, iface);
    return iface;
  };

  const propertyInterfaceFor = async (path: string): Promise<Loose> => {
    const cached = propertyInterfaces.get(path);
    if (cached) return cached;
    const iface = (await bus.getInterface(SERVICE, path, PROPERTIES_INTERFACE)) as unknown as Loose;
    propertyInterfaces.set(path, iface);
    return iface;
  };

  const readState = async (unit: string, allowLoad: boolean): Promise<UnitState> => {
    requireUnitName(unit);
    const path = await pathFor(unit, allowLoad);
    if (path === null) return unknownUnitState(unit);
    try {
      const iface = await unitInterfaceFor(path);
      const properties = iface.$readAllProps ? (plain(await iface.$readAllProps()) as Record<string, unknown>) : {};
      return normaliseUnitState(unit, properties);
    } catch {
      // A unit can be garbage-collected between resolving its path and reading it; the cached
      // path is then stale and the next call re-resolves.
      unitPaths.delete(unit);
      unitInterfaces.delete(path);
      return unknownUnitState(unit);
    }
  };

  const installJobListener = async (): Promise<void> => {
    if (jobListenerInstalled) return;
    const managerInterface = await getManager();
    const onJobRemoved = (...args: unknown[]): void => {
      // JobRemoved(u id, o job, s unit, s result)
      const jobPath = String(args[1] ?? '');
      const unit = String(args[2] ?? '');
      const result = String(args[3] ?? '');
      const finished: JobResult = {
        result,
        unit,
        jobPath,
        waitedMs: Date.now() - (jobStartedAt.get(jobPath) ?? Date.now()),
      };
      const resolve = pendingJobs.get(jobPath);
      if (!resolve) {
        // Not "someone else's job, discard it". A job that finished this fast may belong to a caller
        // who has not resumed from the method reply yet, and dropping the result here is what made an
        // instant `Type=oneshot` look like a 90-second timeout.
        rememberUnclaimed(jobPath, finished);
        return;
      }
      pendingJobs.delete(jobPath);
      resolve(finished);
      jobStartedAt.delete(jobPath);
    };
    if (managerInterface.$subscribe) await managerInterface.$subscribe('JobRemoved', onJobRemoved);
    else managerInterface.on('JobRemoved', onJobRemoved);
    jobListenerInstalled = true;
  };

  /**
   * Queue a job and wait for its completion signal.
   *
   * Two races, both of which have to be handled here because the caller cannot see them:
   *
   * 1. **The signal can arrive before the listener exists**, if the unit starts in under a
   *    millisecond. So the listener is installed before the method is called.
   * 2. **The signal can arrive before the caller knows the job path.** `StartUnit`'s reply and the
   *    `JobRemoved` for that job are two messages on one socket, and a binding dispatches everything
   *    it reads in one synchronous pass: resolving the reply only *queues* this function's
   *    continuation, so the signal is handled first and there is nothing registered for it to
   *    resolve. Installing the listener earlier does not help — the listener runs, finds no waiter,
   *    and used to discard the result. It is now kept in `unclaimedJobs` and collected here.
   *
   * Measured on the bench board, 2026-09-20, fresh image: `wf-firewall.service` — a `Type=oneshot`
   * running two `nft` invocations — finished in the same second it was started, the journal said
   * `Finished`, `systemctl` said `active (exited)`, and the apply refused and reverted on
   * `timeout after 90000 ms`. Every unit that had ever been started here before was slow enough to
   * lose that race, which is why a year of successful applies proved nothing about it.
   *
   * And because a missed signal is otherwise indistinguishable from a unit that never finished, a
   * timeout is not taken at face value: the unit's own state is read before the job is called a
   * failure. A wait has to verify the effect, not the absence of a message.
   */
  const runJob = async (method: string, unit: string, mode = 'replace'): Promise<JobResult> => {
    requireUnitName(unit);
    await installJobListener();
    const managerInterface = await getManager();

    let settle: ((result: JobResult) => void) | undefined;
    const completion = new Promise<JobResult>((resolve) => {
      settle = resolve;
    });

    const queuedAt = Date.now();
    const jobPath = String(await callMethod(managerInterface, method, [unit, mode]));

    const alreadyFinished = unclaimedJobs.get(jobPath);
    if (alreadyFinished) {
      unclaimedJobs.delete(jobPath);
      return { ...alreadyFinished.result, waitedMs: Date.now() - queuedAt };
    }

    jobStartedAt.set(jobPath, queuedAt);
    pendingJobs.set(jobPath, settle!);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<JobResult>((resolve) => {
      timer = setTimeout(() => {
        pendingJobs.delete(jobPath);
        resolve({ result: 'timeout', unit, jobPath, waitedMs: jobTimeoutMs });
      }, jobTimeoutMs);
      timer.unref();
    });

    const raced = await Promise.race([completion, timeout]);
    if (timer) clearTimeout(timer);
    if (raced.result !== 'timeout') return raced;
    return await resultFromUnitState(method, unit, raced);
  };

  /**
   * What a timed-out job actually did, read from the unit rather than inferred from the silence.
   *
   * `done` is only claimed when the unit is in the state the job was asking for. Anything else stays
   * a timeout, with the state named so the report says what was seen instead of what was expected.
   */
  const resultFromUnitState = async (method: string, unit: string, timedOut: JobResult): Promise<JobResult> => {
    const state = await readState(unit, true).catch(() => unknownUnitState(unit));
    const wanted = method === 'StopUnit' ? 'inactive' : 'active';
    const reached = state.activeState === wanted;
    if (!reached) {
      return {
        ...timedOut,
        result: `timeout (unit is ${state.activeState ?? 'unreadable'}/${state.subState ?? 'unreadable'})`,
      };
    }
    return {
      ...timedOut,
      result: 'done',
      // Named so a reader of the step log knows the evidence was the unit, not a completion signal.
      unit: `${unit} (no completion signal; unit read as ${state.activeState}/${state.subState ?? '?'})`,
    };
  };

  const controller: SystemdController = {
    async start(unit) {
      return await runJob('StartUnit', unit);
    },
    async stop(unit) {
      return await runJob('StopUnit', unit);
    },
    async restart(unit) {
      // Restart rather than "enable and start": for a unit that is already running an
      // "enable and start" call does nothing and the new configuration is silently not applied.
      return await runJob('RestartUnit', unit);
    },
    async reload(unit) {
      return await runJob('ReloadOrRestartUnit', unit);
    },

    async enable(unit) {
      requireUnitName(unit);
      // Enable before restart. A failing restart aborts a sequence, and if enable has not happened
      // the unit is left disabled — a fault that appears only after a reboot.
      const result = await run(systemctlPath, ['enable', unit], { timeoutMs: 30_000 });
      if (result.code !== 0) {
        throw new Error(`systemctl enable ${unit} failed: ${(result.stderr + result.stdout).trim()}`);
      }
    },

    async disable(unit) {
      requireUnitName(unit);
      const result = await run(systemctlPath, ['disable', unit], { timeoutMs: 30_000 });
      if (result.code !== 0) {
        throw new Error(`systemctl disable ${unit} failed: ${(result.stderr + result.stdout).trim()}`);
      }
    },

    async state(unit) {
      // An explicit question about one unit may load it: the caller wants to know whether it is
      // installed, and a unit on disk that has never been loaded still answers.
      return await readState(unit, true);
    },

    async show(unit) {
      requireUnitName(unit);
      const result = await run(systemctlPath, ['show', unit], { timeoutMs: 10_000 });
      return parseSystemctlShow(result.stdout);
    },

    async daemonReload() {
      const managerInterface = await getManager();
      await callMethod(managerInterface, 'Reload', []);
      // Every object path can move across a reload; keeping the caches would hand out paths that
      // no longer exist.
      unitPaths.clear();
      unitInterfaces.clear();
      propertyInterfaces.clear();
    },

    async runTransient(transient) {
      requireUnitName(transient.unit);
      if (!Number.isInteger(transient.withinSeconds) || transient.withinSeconds <= 0) {
        throw new Error(
          `refusing to arm ${transient.unit} with a deadline of ${transient.withinSeconds}s: a ` +
            'non-positive deadline either fires immediately or never, and both are silent ways for a ' +
            'confirmation window to not exist',
        );
      }
      if (transient.argv.length === 0) throw new Error('a transient unit needs a command to run');

      /*
       * The deadline is anchored to boot rather than expressed as `--on-active`.
       *
       * `OnActiveSec` counts from the activation of the timer unit, and `systemctl daemon-reload`
       * re-bases it to the moment of the reload. The reconciler reloads once per unit it installs,
       * and this timer is armed before the reconcile begins, so with `--on-active` a network apply
       * postponed its own revert by the whole confirmation window — repeatedly. `OnBootSec` is
       * measured from boot, which does not move: verified on the bench board, unchanged across three
       * reloads.
       *
       * A monotonic clock rather than the wall clock because this board has no clock battery and its
       * wall time can jump by days after a power cycle.
       */
      const uptime = await readUptimeSeconds();
      if (uptime === null) {
        // Refused rather than fallen back to --on-active. This call exists to make a change
        // survivable, and arming a timer whose deadline something else can postpone is the failure
        // that hid for a whole night. The caller treats a refusal as "do not apply", which is the
        // safe direction; a deadline that cannot be anchored is not a deadline.
        return {
          ok: false,
          message:
            'could not read /proc/uptime, so the deadline cannot be anchored to boot. Refusing to ' +
            'arm: an unanchored deadline is an interval that any daemon-reload restarts.',
        };
      }
      /*
       * Floored here, and that is not cosmetic: `transactions.fires_at_uptime_seconds` is an INTEGER column
       * in a STRICT table.
       *
       * This module used to have its own uptime reader which floored. Collapsing the two readers into one was
       * right — this codebase carries a warning about confusing process uptime with machine uptime, and that
       * fix has to be applied in one place — but the two were **not identical**: the survivor returns
       * `/proc/uptime` as the float it is. So the apply began failing with
       * `cannot store REAL value in INTEGER column`, caught by SQLite rather than by us.
       *
       * The reader stays honest and the rounding lives where the integer is required.
       */
      const firesAtUptimeSeconds = Math.floor(uptime) + transient.withinSeconds;

      // A previous run left in a failed state makes systemd-run refuse the same unit name, which
      // would turn "arm the revert timer" into a failure nobody reads at the moment it matters most.
      await run(systemctlPath, ['reset-failed', transient.unit, timerFor(transient.unit)], {
        timeoutMs: 10_000,
      }).catch(() => undefined);

      const result = await run(
        systemdRunPath,
        [
          `--unit=${transient.unit}`,
          `--timer-property=OnBootSec=${firesAtUptimeSeconds}s`,
          // One second rather than systemd's default minute of slack. A three-minute promise that
          // fires up to sixty seconds late is a four-minute promise.
          '--timer-property=AccuracySec=1s',
          `--description=${transient.description}`,
          // Collected once it has run, so a fired revert does not leave a unit behind that makes the
          // next arm of the same name fail.
          '--corp',
          ...transient.argv,
        ],
        { timeoutMs: 20_000 },
      );

      return {
        ok: result.code === 0,
        message: (result.stderr + result.stdout).trim(),
        ...(result.code === 0 ? { firesAtUptimeSeconds } : {}),
      };
    },

    restartDetached(unit) {
      requireUnitName(unit);
      spawn(systemctlPath, ['restart', unit], { detached: true, stdio: 'ignore' }).unref();
    },

    async signal(unit, signal) {
      requireUnitName(unit);
      // `--kill-who` rather than `--kill-whom`: systemd renamed it and kept the old spelling as an alias,
      // so the old one works on both sides of the rename. [assumption: not measured on the bench board]
      const result = await run(systemctlPath, ['kill', '--kill-who=main', `--signal=${signal}`, unit], { timeoutMs: 10_000 });
      return { ok: result.code === 0, message: (result.stderr + result.stdout).trim() };
    },

    async poweroff(reason) {
      void reason;
      // `systemctl poweroff`, never `poweroff -f`: units are stopped and filesystems unmounted, so the
      // card is not cut off mid-write. The call returns once the job is queued; this process is then
      // stopped along with everything else. [assumption: not measured on the bench board — nothing
      // may power it off during development — and it relies on the same privilege path as
      // `host.reboot`, which also asks PID 1 over the bus rather than holding CAP_SYS_BOOT]
      const result = await run(systemctlPath, ['poweroff'], { timeoutMs: 30_000 });
      return { ok: result.code === 0, message: (result.stderr + result.stdout).trim() };
    },

    async unmask(unit) {
      requireUnitName(unit);
      const result = await run(systemctlPath, ['unmask', unit], { timeoutMs: 30_000 });
      const output = (result.stderr + result.stdout).trim();
      return { ok: result.code === 0, message: output };
    },

    async listOwnedUnits(prefix) {
      // `list-units --all` covers loaded units; `list-unit-files` covers those on disk that are not
      // loaded. Both, because a reset has to find an instance that is enabled and stopped just as much
      // as one that is running.
      const names = new Set<string>();
      for (const argv of [
        ['list-units', '--all', '--plain', '--no-legend', '--no-pager', `${prefix}*`],
        ['list-unit-files', '--plain', '--no-legend', '--no-pager', `${prefix}*`],
      ]) {
        const result = await run(systemctlPath, argv, { timeoutMs: 15_000 }).catch(() => null);
        if (result === null || result.code !== 0) continue;
        for (const line of result.stdout.split('\n')) {
          const name = line.trim().split(/\s+/)[0];
          if (name !== undefined && name.startsWith(prefix)) names.add(name);
        }
      }
      return [...names];
    },

    async stopTransient(unit) {
      requireUnitName(unit);
      const timer = timerFor(unit);

      /*
       * **Never stop the unit this process is running inside.**
       *
       * Measured on the bench board, 2026-09-20, and it meant the mechanism built for a dead daemon
       * had never once worked. The revert timer fires, systemd starts
       * `wayfarer-revert@<id>.service`, that service runs `way revert`, and the revert's first act is
       * to disarm its own timer — which stopped the service it was itself running in. The journal
       * reads: service started 22:27:59, "Stopping …" 22:28:01, "Deactivated successfully". Two
       * seconds of work, killed by its own tidying, transaction left `reverting` for ever and the
       * uplink never restored.
       *
       * It was invisible because every revert that had ever been observed ran inside the daemon,
       * where stopping a transient unit the daemon is not in is exactly right.
       */
      const own = await ownUnit();
      const alsoStopService = own !== unit;
      const targets = alsoStopService ? [timer, unit] : [timer];

      // The timer first: stopping the service while the timer is still armed cancels nothing, because
      // the timer starts the service again when it elapses.
      const stopped = await run(systemctlPath, ['stop', ...targets], { timeoutMs: 30_000 });
      await run(systemctlPath, ['reset-failed', ...targets], { timeoutMs: 10_000 }).catch(() => undefined);
      const output = (stopped.stderr + stopped.stdout).trim();

      /*
       * A unit that is **not loaded** is a unit that is not armed, which is the result being asked for.
       *
       * Transient units do not survive a reboot, so after one `systemctl stop` reports "Unit … not
       * loaded" for every timer armed before it. Measured on the bench board, 2026-09-20: the start-up
       * sweep reverted an unconfirmed transaction across a hard reset perfectly, and logged
       * `could not stop the revert timer` at warning level while doing it — a complaint about a
       * condition that is exactly what we wanted. The goal is "no timer armed", and it is met.
       */
      const notLoaded = /not loaded/i.test(output);
      return {
        ok: stopped.code === 0 || notLoaded,
        message:
          (notLoaded ? `already disarmed: ${output}` : output) +
          (alsoStopService ? '' : ` (left ${unit} running: this process is inside it)`),
      };
    },

    async watch(units, onChange) {
      const watched = [...new Set(units.filter((unit) => unit.trim() !== ''))];
      await installJobListener();
      const managerInterface = await getManager();

      // One refresh in flight per unit. Without this, a burst of signals for one unit becomes a
      // burst of D-Bus round trips for the same answer.
      const inFlight = new Set<string>();
      const refresh = (unit: string): void => {
        if (!watched.includes(unit) || inFlight.has(unit)) return;
        inFlight.add(unit);
        void readState(unit, false)
          .then((state) => {
            onChange(state);
          })
          .catch(() => undefined)
          .finally(() => inFlight.delete(unit));
      };

      const onJobRemoved = (...args: unknown[]): void => {
        const unit = String(args[2] ?? '');
        if (unit !== '') refresh(unit);
      };
      if (managerInterface.$subscribe) await managerInterface.$subscribe('JobRemoved', onJobRemoved);
      else managerInterface.on('JobRemoved', onJobRemoved);

      // Per-unit property signals, which is what makes a state change visible without a job — a
      // service that dies on its own produces no job at all.
      const subscribedProperties: Loose[] = [];
      const propertyListeners: ((...args: unknown[]) => void)[] = [];
      for (const unit of watched) {
        const path = await pathFor(unit, true);
        if (path === null) continue;
        try {
          // Cached: each getInterface costs an introspection round trip, and Epic C changes the
          // watched set whenever a profile is applied.
          const properties = await propertyInterfaceFor(path);
          const listener = (...args: unknown[]): void => {
            if (String(args[0] ?? '') !== UNIT_INTERFACE) return;
            refresh(unit);
          };
          if (properties.$subscribe) await properties.$subscribe('PropertiesChanged', listener);
          else properties.on('PropertiesChanged', listener);
          subscribedProperties.push(properties);
          propertyListeners.push(listener);
        } catch {
          // A unit with no object path yet is picked up by the job signal when it first starts.
        }
      }

      // Initial state, so a client connecting before anything changes still sees the truth.
      for (const unit of watched) refresh(unit);

      return {
        stop(): void {
          // Unsubscribe where the binding supports it, so the *bus-side* match rule goes too.
          // Removing only the local listener leaves the rule in place, and a watched set that
          // changes — which is exactly what the next epic does on every apply — then accumulates
          // match rules the daemon no longer reads.
          void managerInterface.$unsubscribe?.('JobRemoved', onJobRemoved);
          managerInterface.removeListener?.('JobRemoved', onJobRemoved);
          subscribedProperties.forEach((iface, index) => {
            const listener = propertyListeners[index]!;
            void iface.$unsubscribe?.('PropertiesChanged', listener);
            iface.removeListener?.('PropertiesChanged', listener);
          });
        },
      };
    },

    close() {
      try {
        bus.connection?.end();
      } catch {
        /* Already gone. */
      }
    },
  };

  return controller;
}

/**
 * The systemd unit this process is running inside, from its own cgroup, or `null`.
 *
 * Read rather than passed, because the caller that most needs it — a revert running from the
 * transient timer — is several layers away from the platform call that would kill it, and a flag
 * threaded through those layers is a flag somebody will forget to pass on the one path that matters.
 */
async function ownUnit(): Promise<string | null> {
  try {
    const text = await readFile('/proc/self/cgroup', 'utf8');
    // `0::/system.slice/system-wayfarer\x2drevert.slice/wayfarer-revert@abc.service`
    const match = /\/([A-Za-z0-9@_.\\-]+\.(?:service|timer))\s*$/m.exec(text.trim());
    if (!match) return null;
    // systemd escapes some characters in cgroup paths; the unit name we compare against is unescaped.
    return match[1]!.replace(/\\x2d/g, '-');
  } catch {
    // Not Linux, no procfs, or unreadable. Unknown, and an unknown must not make us skip the stop —
    // the ordinary case is a daemon that is not inside the unit and does need it stopped.
    return null;
  }
}

function requireUnitName(unit: string): void {
  if (unit.trim() === '') {
    throw new Error('systemd was asked to act on an empty unit name; the caller must resolve it first');
  }
  if (!/\.[a-z]+$/.test(unit)) {
    // systemd accepts a bare name and appends `.service`, which makes a typo in a timer or socket
    // name silently act on a service instead.
    throw new Error(`unit name "${unit}" has no type suffix; pass the full name, e.g. ${unit}.service`);
  }
}

/**
 * The `.timer` that `systemd-run --unit=<name>.service --on-active=…` creates alongside the service.
 *
 * Derived rather than passed in, because the two names are one fact and letting a caller supply both
 * is how they come to disagree — and the way they disagree is a revert timer nobody stops.
 */
function timerFor(unit: string): string {
  return unit.replace(/\.service$/, '.timer');
}

async function callMethod(iface: Loose, name: string, args: unknown[]): Promise<unknown> {
  if (iface.$callMethod) return await iface.$callMethod(name, args);
  const method = iface[name];
  if (typeof method !== 'function') throw new Error(`D-Bus interface has no method ${name}`);
  return await (method as (...callArgs: unknown[]) => PromiseLike<unknown>)(...args);
}

/**
 * Values read from D-Bus arrive wrapped as variants, and the wrapping has changed shape between
 * versions of the binding. `toPlain` is the binding's own forward-compatible unwrapper; reading by
 * index would break on the next change.
 */
function plain(value: unknown): unknown {
  const toPlain = (dbus as unknown as { toPlain?: (v: unknown) => unknown }).toPlain;
  return typeof toPlain === 'function' ? toPlain(value) : value;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const unwrapped = plain(value);
  return typeof unwrapped === 'string' ? unwrapped : null;
}
