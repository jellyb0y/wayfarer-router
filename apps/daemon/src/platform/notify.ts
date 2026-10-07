/**
 * Readiness and watchdog notifications to systemd.
 *
 * The protocol is a datagram on an `AF_UNIX` socket named by `$NOTIFY_SOCKET`. **This runtime
 * cannot open a Unix datagram socket**: `dgram` supports UDP only, and `net` supports
 * `SOCK_STREAM` only. The same limitation is the reason wpa_supplicant is driven over D-Bus
 * rather than through its control socket, and the ready-made native wrappers for it are
 * abandoned — and this project ships no native modules.
 *
 * So notifications are sent by running `systemd-notify`, which does own such a socket. Two
 * consequences, both of which belong in the unit file rather than in a comment nobody reads:
 *
 * * `NotifyAccess=all` is required, because the datagram then comes from a helper process
 *   rather than from the main one. With the default `NotifyAccess=main` systemd ignores it and
 *   the unit is killed at `TimeoutStartSec` with no explanation.
 * * The watchdog interval is deliberately generous and pinged at a third of it, because each
 *   ping costs a process. Measured on the bench board, `systemd-notify` takes roughly 10 ms of
 *   wall time, so a 20-second interval is about 0.05 % of one core.
 *
 * If the runtime ever gains Unix datagram support this module is the only place that changes.
 */

import { run } from './exec.ts';

export interface Notifier {
  /** Tells systemd the daemon is up and serving. Required by `Type=notify`. */
  ready(): Promise<void>;
  /** Keeps `WatchdogSec` satisfied. A wedged event loop simply stops calling this. */
  alive(): Promise<void>;
  status(text: string): Promise<void>;
  /** True when systemd is expecting notifications at all. */
  readonly enabled: boolean;
  /** Starts pinging the watchdog, returning a stop function. */
  startWatchdog(): () => void;
}

export function createNotifier(systemdNotifyPath = '/usr/bin/systemd-notify'): Notifier {
  // Absent when the daemon is started by hand, which is a normal development case.
  const socket = process.env['NOTIFY_SOCKET'];
  const enabled = typeof socket === 'string' && socket !== '';

  // systemd sets this to the microseconds it expects between pings.
  const watchdogUsec = Number(process.env['WATCHDOG_USEC'] ?? '0');
  const watchdogIntervalMs =
    Number.isFinite(watchdogUsec) && watchdogUsec > 0 ? Math.max(Math.floor(watchdogUsec / 1000 / 3), 1000) : 0;

  const notify = async (args: string[]): Promise<void> => {
    if (!enabled) return;
    try {
      await run(systemdNotifyPath, args, { timeoutMs: 5000 });
    } catch {
      // A failed notification must never take the daemon down: at worst systemd restarts it,
      // which is a better outcome than exiting on the way up.
    }
  };

  return {
    enabled,
    async ready() {
      await notify(['--ready']);
    },
    async alive() {
      await notify(['WATCHDOG=1']);
    },
    async status(text) {
      await notify([`--status=${text}`]);
    },
    startWatchdog() {
      if (!enabled || watchdogIntervalMs === 0) return () => undefined;
      const timer = setInterval(() => {
        void (async () => {
          await notify(['WATCHDOG=1']);
        })();
      }, watchdogIntervalMs);
      // Deliberately *not* unref'd: the ping is part of staying alive, and a process whose
      // only remaining work is unref'd exits.
      return () => clearInterval(timer);
    },
  };
}
