/**
 * Notices an access point whose radio has gone silent, and brings it back.
 *
 * The symptom it exists for (bench board, 2026-10-16): an mt7921u adapter's firmware hung at 02:13 — the
 * kernel logged `Message 00020003 (seq 7) timeout` and `timed out waiting for pending tx`, and the driver
 * reset the firmware in place. Clients rejoined until 03:15; after that the interface moved no packets for
 * six hours while hostapd reported `ENABLED`, its unit was `active`, and nothing in this daemon said a
 * word. `systemctl restart` of the access point brought it back in seconds. A layer that reads only what
 * the layers above the radio report cannot see this, so this reads the radio.
 *
 * ## What counts as silent
 *
 * * **An error from the radio's own device in the kernel log** — priority `err` or worse, naming the
 *   device the radio reports (`2-1:1.0` for that adapter). No driver is named here: the device comes from
 *   the radio's own report, and a driver logs its device errors at `err` (`dev_err`). That the two lines
 *   above were logged at `err` is an assumption: the journal of that night had rotated away by the time
 *   this was written.
 * * **hostapd not `ENABLED`** for two looks in a row while its unit is enabled.
 * * **Clients listed and fewer than {@link MIN_RX_PACKETS_PER_WINDOW} packets in over {@link SILENT_WITH_CLIENTS_MS}.** Without clients an access
 *   point's counters honestly stand still, so silence alone proves nothing. Only the receive side is
 *   judged: on 2026-10-22 the same adapter received nothing from 19:28:50 while hostapd still handed it
 *   about one frame a second to send, so `tx_packets` kept moving and a rule that wanted both counters
 *   still never fired. The kernel said nothing either until 19:34:10, when hostapd dropped a client for
 *   inactivity and the driver's first command to the firmware in five minutes timed out — the radio was
 *   down 5 min 40 s, nearly all of it spent waiting. The minute is from 13 h of per-second counters
 *   (2026-10-21 11:25 to 2026-10-22 00:44, five to six clients): received packets never stood still for
 *   even 10 s while a client was listed. Those hours always had an awake client — one of them was the
 *   machine recording the counters — so that a quieter night stays above a minute is an assumption.
 * * **After a repair, none of the clients that were listed when it began has come back** by the time the
 *   rung has settled. A radio nobody can join has no clients, and no clients is otherwise not a fault — so
 *   without this rule the first rung always looked like a recovery. Measured on the bench board,
 *   2026-10-31: the restart at 16:01:08 left the adapter hung (`rx_packets` stood at 5348665 for three
 *   minutes, no station listed), the watch reported `enabled, 0 client(s)`, reset its ladder and never
 *   reached the USB rung; unbinding and binding the device by hand at 16:03:58 brought two clients back
 *   and 283 received packets in the next 20 s.
 *
 * ## What it does
 *
 * One rung at a time, each recorded, with {@link REPAIR_SETTLE_MS} between them for the rung to take:
 * restart the access point's unit; then, for a USB radio, unbind the device from its driver and bind it
 * again — the reset a reboot gave, without the reboot — and start the unit; then stop and say so. It never
 * reboots: a reboot loop on a device carrying tunnels costs more than an access point that is down, and
 * that trade is the owner's to change.
 *
 * It never acts while an apply runs or a confirmation window is open — those own the access point and
 * judge it themselves — and it touches nothing but the access point: not the core, not the tunnels, not
 * the routing rules.
 */

import type { Platform } from '../platform/index.ts';
import type { ObserverRegistry } from './observers.ts';

export const RADIO_WATCH_CHECK_MS = 30_000;
export const SILENT_WITH_CLIENTS_MS = 60_000;
/**
 * Fewer packets than this received over {@link SILENT_WITH_CLIENTS_MS}, with clients listed, is silence.
 *
 * Not zero. Measured on the bench board, 2026-10-30 14:35–14:42: the adapter hung with three clients
 * listed and received 17 packets in about 250 s — one every 10 to 30 s — while it sent no beacons and
 * the network vanished from every client's list. The rule was "no packet at all for a minute", and each
 * stray packet reset it, so the watch never acted and the radio stayed down until restarted by hand.
 * Six is the floor the 13 h of per-second counters above set: received packets never stood still for
 * 10 s while a client was listed, so a working radio receives at least six a minute.
 */
export const MIN_RX_PACKETS_PER_WINDOW = 6;
/** How long a rung is given before it is judged — and before the kernel log is believed again. */
export const REPAIR_SETTLE_MS = 2 * 60_000;
/** Between one climb of the ladder and the next. */
export const LADDER_MIN_INTERVAL_MS = 10 * 60_000;

const UNIT_PREFIX = 'wf-hostapd@';

export interface RadioWatch {
  check(): Promise<void>;
  stop(): void;
}

type Event = { level: 'info' | 'warn' | 'error'; kind: string; summary: string; detail?: unknown };

interface Target {
  unit: string;
  iface: string;
  /** The radio's device, remembered: a radio that has gone silent may no longer be listed with its interface. */
  devicePath: string | null;
  bus: string | null;
  /** Where the kernel log was last read up to. */
  cursor: string | null;
  counters: { txPackets: number; rxPackets: number } | null;
  /** Received-packet readings while clients are listed, oldest first, back to just over one window. */
  rxHistory: Array<{ at: number; rx: number }>;
  notEnabledLooks: number;
  rung: 0 | 1 | 2;
  /** Clients listed when the ladder's last rung was taken: the ones a working radio gets back. */
  clientsAtRepair: number;
  lastRepairAt: number | null;
  ladderStartedAt: number | null;
  gaveUp: boolean;
}

export function watchAccessPointRadio(input: {
  observers: ObserverRegistry;
  platform: Platform;
  /** An apply is running. */
  applying: () => boolean;
  /** A confirmation window is open. */
  windowOpen: () => boolean;
  record: (event: Event) => void;
  checkMs?: number;
  /** Monotonic milliseconds; injected so the timings can be tested without waiting. */
  now?: () => number;
  /** Starts the timer; off in tests, which call `check` themselves. */
  start?: boolean;
}): RadioWatch {
  const checkMs = input.checkMs ?? RADIO_WATCH_CHECK_MS;
  const now = input.now ?? (() => performance.now());
  const observer = input.observers.register({
    name: 'access-point-radio',
    watches: 'whether the access point radio still moves frames, not only whether hostapd says it is up',
    everyMs: checkMs,
  });
  const targets = new Map<string, Target>();
  const { platform } = input;

  const kernelTail = async (): Promise<string | null> =>
    (await platform.journal.read({ kernel: true, limit: 1 }).catch(() => null))?.nextCursor ?? null;

  const lookAt = async (target: Target, radios: Awaited<ReturnType<Platform['wifi']['phys']>>): Promise<string> => {
    const radio = radios.find((entry) => entry.interfaces.some((iface) => iface.name === target.iface));
    if (radio !== undefined) {
      target.devicePath = radio.devicePath;
      target.bus = radio.bus;
    }
    const at = now();
    const settling = target.lastRepairAt !== null && at - target.lastRepairAt < REPAIR_SETTLE_MS;

    // The kernel log, from where it was last read. What is read while a rung settles is dropped below:
    // the repair itself makes the driver complain — the restart at 09:41 that fixed the radio logged
    // `timed out waiting for pending tx` on its way down.
    const errors: string[] = [];
    if (target.cursor === null) {
      target.cursor = (await kernelTail()) ?? target.cursor;
    } else {
      const page = await platform.journal.read({ kernel: true, maxPriority: 3, afterCursor: target.cursor, limit: 500 }).catch(() => null);
      const device = target.devicePath === null ? null : target.devicePath.split('/').pop() ?? null;
      for (const entry of page?.entries ?? []) {
        if (device !== null && entry.message.includes(device)) errors.push(entry.message);
      }
      target.cursor = page?.nextCursor ?? (await kernelTail()) ?? target.cursor;
    }

    const status = await platform.ap.status(target.iface).catch(() => null);
    const enabled = status?.state === 'ENABLED';
    // An unreadable status is not a disabled one — `hostapd_cli` can fail while the access point serves —
    // so it counts only when the unit itself is not running.
    const down = status === null ? !(await platform.systemd.state(target.unit)).isActive : !enabled;
    target.notEnabledLooks = down ? target.notEnabledLooks + 1 : 0;
    const stations = (status?.bss ?? []).reduce((sum, bss) => sum + (bss.stationCount ?? 0), 0);

    const counters = await platform.radio.counters(target.iface);
    target.counters = counters;
    if (!enabled || stations === 0 || counters === null) target.rxHistory = [];
    else {
      target.rxHistory.push({ at, rx: counters.rxPackets });
      // Keep the newest reading that is at least a window old, and everything after it.
      while (target.rxHistory.length > 1 && at - target.rxHistory[1]!.at >= SILENT_WITH_CLIENTS_MS) target.rxHistory.shift();
    }
    const oldest = target.rxHistory[0];
    const received = oldest === undefined || counters === null ? null : counters.rxPackets - oldest.rx;
    const silentFor =
      oldest !== undefined && received !== null && received >= 0 && received < MIN_RX_PACKETS_PER_WINDOW && at - oldest.at >= SILENT_WITH_CLIENTS_MS
        ? at - oldest.at
        : null;

    if (settling) return `${target.iface}: a repair is settling`;

    const abandoned = target.rung > 0 && target.clientsAtRepair > 0 && enabled && stations === 0;

    const why =
      errors.length > 0
        ? `the kernel logged ${String(errors.length)} error(s) from its device: ${errors[errors.length - 1]!.slice(0, 160)}`
        : target.notEnabledLooks >= 2
          ? status === null
            ? `${target.unit} is not running`
            : `hostapd reports ${status.state ?? 'no state'} rather than ENABLED`
          : silentFor !== null
            ? `${String(stations)} client(s) listed and ${String(received)} packet(s) received in ${String(Math.round(silentFor / 1_000))} s`
            : abandoned
              ? `none of the ${String(target.clientsAtRepair)} client(s) listed before the repair came back within ${String(Math.round(REPAIR_SETTLE_MS / 1_000))} s`
              : null;

    // Not yet judged down, and not up either: neither a fault nor a recovery. Declaring recovery here
    // would reset the ladder every time hostapd stayed down for less than two looks after a repair.
    if (why === null && down) return `${target.iface}: hostapd is not enabled yet`;
    if (why === null) {
      if (target.rung > 0) {
        input.record({
          level: 'info',
          kind: 'radio.recovered',
          summary: `the access point on ${target.iface} moves frames again`,
          detail: { iface: target.iface, afterRung: target.rung },
        });
      }
      target.rung = 0;
      target.gaveUp = false;
      return `${target.iface}: ${enabled ? 'enabled' : (status?.state ?? 'unreadable')}, ${String(stations)} client(s)`;
    }

    if (target.gaveUp) return `${target.iface}: ${why}; nothing more is tried until it recovers`;
    if (input.applying() || input.windowOpen()) return `${target.iface}: ${why}; an apply or a confirmation window owns it, so nothing was done`;
    if (target.rung === 0 && target.ladderStartedAt !== null && at - target.ladderStartedAt < LADDER_MIN_INTERVAL_MS) {
      return `${target.iface}: ${why}; the last repair was under ${String(LADDER_MIN_INTERVAL_MS / 60_000)} min ago`;
    }

    target.lastRepairAt = at;
    // The first rung counts the clients that were there; a later one keeps that count, since by then the
    // hung radio has lost them all.
    if (target.rung === 0) target.clientsAtRepair = stations;
    target.rxHistory = [];
    target.notEnabledLooks = 0;

    if (target.rung === 0) {
      target.ladderStartedAt = at;
      target.rung = 1;
      await platform.systemd.resetFailed(target.unit).catch(() => undefined);
      const job = await platform.systemd.restart(target.unit);
      observer.acted(`restarted ${target.unit}`);
      input.record({
        level: 'warn',
        kind: 'radio.restarted',
        summary: `the access point on ${target.iface} had gone silent (${why}); restarted ${target.unit}`,
        detail: { iface: target.iface, why, job },
      });
      return `${target.iface}: ${why}; restarted`;
    }

    if (target.rung === 1 && target.bus === 'usb' && target.devicePath !== null) {
      target.rung = 2;
      const outcome = await platform.radio.rebindUsb(target.devicePath);
      await platform.systemd.resetFailed(target.unit).catch(() => undefined);
      const job = await platform.systemd.restart(target.unit);
      observer.acted(outcome.ok ? `rebound ${outcome.device} to ${outcome.driver}` : `could not rebind: ${outcome.reason}`);
      input.record({
        level: outcome.ok ? 'warn' : 'error',
        kind: 'radio.usb-rebound',
        summary: outcome.ok
          ? `restarting did not bring the access point on ${target.iface} back (${why}); the USB radio was unbound from ${outcome.driver} and bound again`
          : `restarting did not bring the access point on ${target.iface} back (${why}), and the USB radio could not be rebound: ${outcome.reason}`,
        detail: { iface: target.iface, why, outcome, job },
      });
      return `${target.iface}: ${why}; USB radio rebound`;
    }

    target.gaveUp = true;
    input.record({
      level: 'error',
      kind: 'radio.unrecoverable',
      summary: `the access point on ${target.iface} is still silent after every repair this device makes on its own (${why}); a reboot or re-plugging the radio is what is left`,
      detail: { iface: target.iface, why, bus: target.bus },
    });
    return `${target.iface}: ${why}; gave up`;
  };

  const look = async (): Promise<void> => {
    const units = await platform.systemd.listOwnedUnits(UNIT_PREFIX);
    const wanted: string[] = [];
    for (const unit of units) {
      if (unit.endsWith('@.service')) continue;
      if ((await platform.systemd.state(unit)).isEnabled) wanted.push(unit);
    }
    for (const unit of [...targets.keys()]) if (!wanted.includes(unit)) targets.delete(unit);
    if (wanted.length === 0) {
      observer.looked('no access point is configured');
      observer.failing(null);
      return;
    }
    const radios = await platform.wifi.phys().catch(() => []);
    const said: string[] = [];
    for (const unit of wanted) {
      let target = targets.get(unit);
      if (target === undefined) {
        target = {
          unit,
          iface: unit.slice(UNIT_PREFIX.length, -'.service'.length),
          devicePath: null,
          bus: null,
          cursor: null,
          counters: null,
          rxHistory: [],
          notEnabledLooks: 0,
          rung: 0,
          clientsAtRepair: 0,
          lastRepairAt: null,
          ladderStartedAt: null,
          gaveUp: false,
        };
        targets.set(unit, target);
      }
      said.push(await lookAt(target, radios));
    }
    observer.looked(said.join('; '));
    const failing = [...targets.values()].filter((target) => target.gaveUp).map((target) => target.iface);
    observer.failing(failing.length === 0 ? null : `the access point on ${failing.join(', ')} could not be brought back`);
  };

  let running: Promise<void> | null = null;
  const check = (): Promise<void> => {
    running ??= look()
      .catch((error: unknown) => observer.looked(`the check failed: ${String(error)}`))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const timer = input.start === false ? null : setInterval(() => void check(), checkMs);
  timer?.unref();
  observer.armed();
  if (input.start !== false) void check();

  return {
    check,
    stop(): void {
      if (timer !== null) clearInterval(timer);
    },
  };
}
