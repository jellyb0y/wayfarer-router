/**
 * Clock state.
 *
 * This board has no battery-backed clock. After being switched off the clock starts from
 * the last timestamp written before shutdown, which can be days in the past — observed
 * on this class of hardware: 4 days 14 hours behind, with the hardware clock reading
 * 1970. Transports that authenticate on a timestamp reject the session in that state, so
 * **every tunnel using such a transport fails while direct tunnels work normally.** It
 * looks like broken tunnels and it is a broken clock.
 *
 * That is why clock state is surfaced next to tunnel diagnostics, and why this is one
 * call: `timedatectl show` is the first thing to look at.
 */

import { run } from './exec.ts';
import { parseTimedatectlShow, type ClockStatus } from './parse/systemctl.ts';

export interface ClockController {
  status(): Promise<ClockStatus>;
  /**
   * Ask the time synchronisation service to try again.
   *
   * Restarting it is the only lever available, and it must happen **after** the firewall
   * is applied, never before: the bypass that lets a time query out is a firewall rule,
   * and without it the query goes into the tunnel that cannot come up until the clock is
   * right. Ordering is the reconciler's job; this function only performs the restart.
   */
  resync(): Promise<{ ok: boolean; message: string }>;
}

const TIMEDATECTL = '/usr/bin/timedatectl';
const SYSTEMCTL = '/usr/bin/systemctl';

export function createClockController(
  timedatectlPath = TIMEDATECTL,
  systemctlPath = SYSTEMCTL,
  timesyncUnit = 'systemd-timesyncd.service',
): ClockController {
  return {
    async status() {
      const result = await run(timedatectlPath, ['show'], { timeoutMs: 5000 });
      return parseTimedatectlShow(result.stdout);
    },

    async resync() {
      const result = await run(systemctlPath, ['restart', timesyncUnit], { timeoutMs: 30_000 });
      return {
        ok: result.code === 0,
        message: (result.stderr + result.stdout).trim(),
      };
    },
  };
}
