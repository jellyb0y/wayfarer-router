/**
 * Wireless client state and events through **our own** wpa_supplicant control socket.
 *
 * ## Why not D-Bus
 *
 * `fi.w1.wpa_supplicant1` has exactly one owner on a system. Measured on the bench board,
 * 2026-09-20: the distribution's `wpa_supplicant.service` held it, our `-u` instance died on
 * `dbus: Could not request service name: already registered`, and systemd restarted it twenty times
 * without the start limit ever firing.
 *
 * A name with one owner is a namespace, and this project does not share a namespace — it takes its
 * own. So the supplicant runs without `-u`, writes its control socket under `/run/wayfarer`, and this
 * module reads it. Nothing foreign is stopped, masked or contended for, and a distribution that ships
 * a supplicant and one that does not behave identically.
 *
 * ## Why `wpa_cli` rather than the socket directly
 *
 * The control socket is a Unix **datagram** socket, which this runtime cannot open without a native
 * module, and this project has none by design. `wpa_cli` speaks that protocol, exactly as
 * `hostapd_cli` does for the access point. The shape below is deliberately the same as `ap.ts`,
 * including the four details that were expensive to learn there:
 *
 * * **an empty interface argument hangs forever** instead of failing, so it is refused before
 *   anything is spawned, and every call carries a timeout as a second line of defence;
 * * **the socket directory must be passed with `-p`**, or the tool looks in its own default and every
 *   call fails with "No such file or directory" while the radio works perfectly;
 * * **stdin must be held open** for the interactive attach, or the process prints its banner and
 *   exits within milliseconds;
 * * **the first line is a prompt or banner, not an event**, and is ignored by the event parser rather
 *   than by counting lines.
 */

import { run, streamLines, type StreamHandle } from './exec.ts';
import {
  parseSupplicantCliEvent,
  parseSupplicantStatus,
  type SupplicantCliEvent,
  type SupplicantStatus,
} from './parse/supplicant-cli.ts';

export type { SupplicantCliEvent, SupplicantStatus };

const WPA_CLI = '/usr/sbin/wpa_cli';

/**
 * Where the generated supplicant configuration puts its control socket, and therefore where every
 * call here must look for it.
 *
 * It lives in this module and the generator imports it. Two copies is how the access point's pair
 * came to disagree, silently.
 *
 * Not the distribution's `/run/wpa_supplicant`: a socket in a shared directory is one another
 * supplicant instance can collide with, and the collision looks like a working radio with no state.
 * The cost is that `wpa_cli` run by hand needs `-p /run/wayfarer/supplicant`, which is worth saying
 * wherever somebody is told to run it.
 */
export const SUPPLICANT_CONTROL_DIR = '/run/wayfarer/supplicant';

export class EmptySupplicantInterfaceError extends Error {
  constructor() {
    super(
      'wpa_cli was called with an empty interface name. It hangs forever in that case rather than ' +
        'failing, so the call is refused here instead.',
    );
    this.name = 'EmptySupplicantInterfaceError';
  }
}

export type WpaCall = (
  interfaceName: string,
  command: string[],
  timeoutMs?: number,
) => Promise<{ code: number | null; stdout: string }>;

export interface SupplicantCliOptions {
  wpaCliPath?: string;
  controlDir?: string;
  call?: WpaCall;
}

export interface SupplicantCliController {
  /** Association state, or `null` when the socket cannot be reached at all. */
  status(interfaceName: string): Promise<SupplicantStatus | null>;
  /** Subscribe to unsolicited events. The subscriber is restarted if it exits. */
  watch(interfaceName: string, onEvent: (event: SupplicantCliEvent) => void): StreamHandle;
}

/**
 * The argument list for one `wpa_cli` invocation.
 *
 * Extracted so a test can assert the real one. A test that substitutes the whole call and then
 * inspects the arguments its own substitute built proves nothing — the mistake this function exists
 * to make impossible to repeat, and the same reason `hostapdArgs` exists.
 */
export function wpaCliArgs(controlDir: string, interfaceName: string, command: string[]): string[] {
  // `-p` before `-i`: the socket directory is ours, not the tool's default.
  return ['-p', controlDir, '-i', interfaceName, ...command];
}

export function createSupplicantCliController(options: SupplicantCliOptions = {}): SupplicantCliController {
  const wpaCliPath = options.wpaCliPath ?? WPA_CLI;
  const controlDir = options.controlDir ?? SUPPLICANT_CONTROL_DIR;

  const cli: WpaCall =
    options.call ??
    (async (interfaceName, command, timeoutMs = 5000) => {
      requireInterface(interfaceName);
      return await run(wpaCliPath, wpaCliArgs(controlDir, interfaceName, command), { timeoutMs });
    });

  return {
    async status(interfaceName) {
      const result = await cli(interfaceName, ['status']);
      if (result.code !== 0 || result.stdout.trim() === '') return null;
      return parseSupplicantStatus(result.stdout);
    },

    watch(interfaceName, onEvent) {
      requireInterface(interfaceName);
      let stopped = false;
      let handle: StreamHandle = start();

      function start(): StreamHandle {
        return streamLines(wpaCliPath, wpaCliArgs(controlDir, interfaceName, []), {
          keepStdinOpen: true,
          onLine: (line) => {
            const event = parseSupplicantCliEvent(line);
            if (event) onEvent(event);
          },
          onExit: () => {
            if (stopped) return;
            // The supplicant restarting takes its control socket with it; reconnect rather than going
            // quiet, because a dead event source looks exactly like an idle one.
            setTimeout(() => {
              if (!stopped) handle = start();
            }, 2000).unref();
          },
        });
      }

      return {
        stop(): void {
          stopped = true;
          handle.stop();
        },
      };
    },
  };
}

function requireInterface(interfaceName: string): void {
  if (interfaceName.trim() === '') throw new EmptySupplicantInterfaceError();
}
