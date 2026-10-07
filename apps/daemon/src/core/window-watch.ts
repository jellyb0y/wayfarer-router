/**
 * Watching a confirmation window, and saying what it finds — with what it read.
 *
 * Cheap checks run during the window: the access point, the uplink, the units this change started, the
 * core. What they conclude is a **finding about the change**, recorded on the transaction and shown to
 * whoever is deciding whether to keep it. It is not an action.
 *
 * ## Three rules
 *
 * **These checks never confirm.** A working uplink does not prove the configuration is the one the
 * operator wanted — a change can restore their own path while breaking everyone else's. Confirmation
 * stays a human act.
 *
 * **A finding comes only from a positively observed failure, never from absent data.** A read that
 * timed out, a source that is unavailable, an interface that is not in the snapshot: none of those is
 * evidence that anything is wrong. The three-valued `Observation` type in `transactions.ts` is what
 * makes that rule structural instead of remembered: there is no way to write "I could not read it" as
 * `false`.
 *
 * **These checks never end the window.** This module used to revert on a conclusive reading, which
 * gave the device two deadlines — the one it reported and the one this check enforced — and the
 * enforced one was reached on a *false* reading four times on the bench board (see
 * `platform/parse/ip-json.ts#linkCarrier` for why it was false). The window now ends at the deadline
 * the device reported, by the transient timer outside this process, or earlier only when a person asks.
 * The structural guarantee is that `WindowWatchDeps` has no way to revert: the only thing this module
 * can do with a verdict is hand it to `onFinding`.
 */

import type { Platform } from '../platform/index.ts';
import { linkCarrier } from '../platform/parse/ip-json.ts';
import { PATHS } from './desired-state.ts';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  observed,
  unknown,
  windowVerdict,
  type HealthReading,
  type HealthThresholds,
  type Observation,
  type WindowScope,
} from './transactions.ts';

export interface WindowSubject {
  transactionId: string;
  /** Which components this plan expects to be running, so an absent one is not read as a failure. */
  expects: { accessPoint: boolean; uplink: boolean; core: boolean };
  /** Which components this change acted on. Only those are judged. See `WindowScope`. */
  scope: WindowScope;
  /** The access-point interface, for its hostapd state. */
  accessPointInterface: string | null;
  /** Uplink interfaces. Any one of them being up is enough: they are a failover group. */
  uplinkInterfaces: string[];
  /** Units this plan started, which are the only ones whose failure is this plan's fault. */
  startedUnits: string[];
}

/** A failing verdict, as handed to `onFinding`: what was concluded and what was read to conclude it. */
export interface WindowFinding {
  code: string;
  reason: string;
  evidence: string[];
  /** Milliseconds since the window opened, from the monotonic clock. */
  elapsedMs: number;
}

export interface WindowWatchDeps {
  platform: Platform;
  /**
   * Called when the verdict **changes**: with a finding when the change is observed failing, and with
   * `null` when a finding that was recorded no longer holds. Not called on every tick, so the record
   * and the event ring carry transitions rather than a heartbeat.
   */
  onFinding: (transactionId: string, finding: WindowFinding | null) => Promise<void>;
  /** True while the transaction is still inside its window. Read each tick rather than assumed. */
  stillOpen: (transactionId: string) => boolean;
  log: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string) => void;
  thresholds?: HealthThresholds;
  /**
   * A **monotonic** millisecond reading, used only for elapsed time. Injectable for tests.
   *
   * Not the wall clock, and this is not a precaution: the apply that opened the window **restarts
   * `systemd-timesyncd`**, so the single most likely moment for this device's wall clock to step by
   * days is inside the window whose elapsed time is being measured. `performance.now()` is monotonic
   * from process start, and only differences of it are ever taken here.
   */
  now?: () => number;
}

export interface WindowWatchController {
  start(subject: WindowSubject): void;
  stop(transactionId: string): void;
  /** For tests and diagnostics: one reading, without scheduling anything. */
  readOnce(subject: WindowSubject, elapsedMs: number): Promise<HealthReading>;
}

/**
 * Reads one value, turning **any** failure into "unknown" rather than into a negative.
 *
 * One function rather than a try/catch at each site: a single missed catch would turn a transient read
 * error into a finding.
 */
async function read<T>(what: string, readValue: () => Promise<T>): Promise<Observation<T>> {
  try {
    return observed(await readValue());
  } catch (error) {
    return unknown(`${what}: ${String(error)}`);
  }
}

/**
 * The uplink group's state, and what was read for each member.
 *
 * `true` when any member has carrier and an IPv4 address; `false` only when **every** member was found
 * and positively read as lacking one of them; unknown otherwise. An interface missing from the snapshot
 * is unknown, not down: a name resolved before a rename, or a snapshot taken while `ip` returned
 * nothing, are both "could not tell". The old reader turned both into "no" — `link?.operstate === 'up'`
 * is `false` for a missing link exactly as for a dead one — alongside the case defect that turned every
 * present link into "no" as well.
 */
export function readUplinks(
  snapshot: { links: { name: string; flags?: string[]; operstate: string | null }[]; addresses: { name: string; family: string; address: string; prefixLength?: number }[] },
  names: string[],
): { up: Observation<boolean>; evidence: string[] } {
  const evidence: string[] = [];
  let anyUp = false;
  let anyUnknown = false;

  for (const name of names) {
    const link = snapshot.links.find((entry) => entry.name === name);
    const inet = snapshot.addresses
      .filter((entry) => entry.name === name && entry.family === 'inet')
      .map((entry) => (entry.prefixLength === undefined ? entry.address : `${entry.address}/${entry.prefixLength}`));

    if (link === undefined) {
      anyUnknown = true;
      const present = snapshot.links.map((entry) => entry.name).join(', ') || 'none';
      evidence.push(`${name}: not in \`ip link\` (present: ${present})`);
      continue;
    }

    const carrier = linkCarrier({ flags: link.flags ?? [], operstate: link.operstate });
    evidence.push(
      `${name}: operstate ${link.operstate ?? 'absent'}, flags ${(link.flags ?? []).join(',') || 'none'}, ` +
        `inet ${inet.length > 0 ? inet.join(' ') : 'none'}`,
    );
    if (carrier === true && inet.length > 0) anyUp = true;
    else if (carrier === null) anyUnknown = true;
  }

  if (anyUp) return { up: observed(true), evidence };
  if (anyUnknown) return { up: unknown(`uplink carrier unreadable — ${evidence.join(' | ')}`), evidence };
  return { up: observed(false), evidence };
}

/**
 * What a plan acts on, as far as the window's checks are concerned — derived from the change set, the
 * same one the reconciler executes.
 *
 * Counted as acting on **both** the uplink and the access point: any rewritten `systemd-networkd`
 * file and any takeover, because the reconciler then runs `networkctl reconfigure` over every managed
 * link (`reconciler.ts`, step 3b), and any rename. Counted as acting on the uplink alone: the wireless
 * client's configuration and unit. On the access point alone: hostapd's configuration and unit.
 *
 * Deliberately **not** counted: the core's configuration and `wf-core`, the firewall, the DHCP
 * server, the tunnels and the sysctl keys. None of them moves a link's carrier or its address — a
 * firewall can stop traffic *through* an uplink, which is the core and unit checks' business and a
 * person's, but it cannot take the carrier or the lease away inside a three-minute window. If one of
 * them ever does, it belongs in this list with the measurement that showed it.
 */
export function windowScopeOf(
  plan: {
    fileChanges: { path: string }[];
    unitChanges: { name: string; action: string }[];
    interfaceRenames: { from: string; to: string }[];
  },
  takeovers: string[],
): WindowScope {
  const uplink: string[] = [];
  const accessPoint: string[] = [];

  for (const change of plan.fileChanges) {
    if (change.path.startsWith(`${PATHS.networkdDir}/`)) {
      const why = `rewrites ${change.path}, and every managed link is reconfigured`;
      uplink.push(why);
      accessPoint.push(why);
    } else if (change.path.startsWith(`${PATHS.supplicantDir}/`)) {
      uplink.push(`rewrites ${change.path}`);
    } else if (change.path.startsWith(`${PATHS.hostapdDir}/`)) {
      accessPoint.push(`rewrites ${change.path}`);
    }
  }
  for (const change of plan.unitChanges) {
    if (change.action !== 'start' && change.action !== 'restart' && change.action !== 'stop') continue;
    if (change.name.startsWith('wf-supplicant@')) uplink.push(`${change.action}s ${change.name}`);
    if (change.name.startsWith('wf-hostapd@')) accessPoint.push(`${change.action}s ${change.name}`);
  }
  for (const name of takeovers) {
    const why = `takes ${name} over from another manager`;
    uplink.push(why);
    accessPoint.push(why);
  }
  for (const rename of plan.interfaceRenames) {
    const why = `renames ${rename.from} to ${rename.to}`;
    uplink.push(why);
    accessPoint.push(why);
  }

  return { uplink, accessPoint };
}

export function createWindowWatch(deps: WindowWatchDeps): WindowWatchController {
  const thresholds = deps.thresholds ?? DEFAULT_HEALTH_THRESHOLDS;
  const now = deps.now ?? ((): number => performance.now());
  const running = new Map<string, { timer: NodeJS.Timeout; startedAt: number; lastCode: string | null }>();

  const controller: WindowWatchController = {
    async readOnce(subject, elapsedMs) {
      const accessPointEnabled: Observation<boolean> =
        subject.expects.accessPoint && subject.accessPointInterface !== null
          ? await read('access point state', async () => {
              const status = await deps.platform.ap.status(subject.accessPointInterface!);
              // A null status is "could not read", not "not enabled". hostapd_cli returns nothing when
              // the control socket is not there yet, which is a normal state moments after a restart.
              if (status === null) throw new Error('hostapd returned no status');
              return status.state === 'ENABLED';
            })
          : unknown('this plan expects no access point');

      let uplinkEvidence: string[] = [];
      const uplinkUp: Observation<boolean> =
        subject.expects.uplink && subject.uplinkInterfaces.length > 0
          ? await (async () => {
              const snapshot = await read('uplink state', () => deps.platform.net.snapshot());
              if (!snapshot.known) return unknown<boolean>(snapshot.why);
              const uplinks = readUplinks(snapshot.value, subject.uplinkInterfaces);
              uplinkEvidence = uplinks.evidence;
              return uplinks.up;
            })()
          : unknown('this plan expects no uplink');

      const failedUnits: Observation<string[]> = await read('unit states', async () => {
        const failed: string[] = [];
        for (const unit of subject.startedUnits) {
          // One unreadable unit must not be reported as an empty list of failures, so a throw here
          // propagates and the whole observation becomes unknown.
          const state = await deps.platform.systemd.state(unit);
          if (state.activeState === 'failed') failed.push(unit);
        }
        return failed;
      });

      const coreRunning: Observation<boolean> = subject.expects.core
        ? await read('core state', async () => {
            const state = await deps.platform.systemd.state('wf-core.service');
            return state.isActive === true;
          })
        : unknown('this plan expects no proxy core');

      return {
        elapsedMs,
        accessPointEnabled,
        uplinkUp,
        uplinkEvidence,
        failedUnits,
        coreRunning,
        expects: subject.expects,
        scope: subject.scope,
      };
    },

    start(subject) {
      // Idempotent by transaction id: a second watch would double the polling and the findings.
      if (running.has(subject.transactionId)) return;

      const startedAt = now();
      const tick = async (): Promise<void> => {
        const entry = running.get(subject.transactionId);
        if (entry === undefined) return;
        if (!deps.stillOpen(subject.transactionId)) {
          controller.stop(subject.transactionId);
          return;
        }

        const elapsedMs = now() - startedAt;
        const reading = await controller.readOnce(subject, elapsedMs);
        const verdict = windowVerdict(reading, thresholds);
        const code = verdict.action === 'failing' ? verdict.code : null;

        if (verdict.action === 'wait') {
          deps.log('info', { transaction: subject.transactionId, reason: verdict.reason }, 'window health check');
        } else {
          deps.log(
            'warn',
            { transaction: subject.transactionId, code: verdict.code, evidence: verdict.evidence },
            `window health check found: ${verdict.reason}`,
          );
        }

        // Only transitions are reported. The code, not the reason, is the key: the reason carries what
        // was read, which moves from tick to tick without the verdict changing.
        if (code === entry.lastCode) return;
        entry.lastCode = code;
        await deps.onFinding(
          subject.transactionId,
          verdict.action === 'failing'
            ? { code: verdict.code, reason: verdict.reason, evidence: verdict.evidence, elapsedMs }
            : null,
        );
      };

      const timer = setInterval(() => {
        // Errors are swallowed into the log rather than allowed to kill the interval: a watcher that
        // dies on one bad tick is a window with no checks, which looks identical to a healthy one.
        void tick().catch((error: unknown) => {
          deps.log('error', { transaction: subject.transactionId, error: String(error) }, 'a window health check threw');
        });
      }, thresholds.intervalMs);
      // Unreferenced so a pending window cannot hold the process open at shutdown.
      timer.unref();
      running.set(subject.transactionId, { timer, startedAt, lastCode: null });
    },

    stop(transactionId) {
      const entry = running.get(transactionId);
      if (entry === undefined) return;
      clearInterval(entry.timer);
      running.delete(transactionId);
    },
  };

  return controller;
}
