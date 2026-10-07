/**
 * Access-point state and events through the hostapd control interface.
 *
 * hostapd has no D-Bus interface — the D-Bus support in that source tree is built only
 * for wpa_supplicant — and there is no usable library, so `hostapd_cli` is it.
 *
 * Three measured facts shape this module:
 *
 * * **`hostapd_cli` with an empty interface argument hangs forever** instead of failing.
 *   Every entry point here refuses an empty or whitespace interface name before spawning
 *   anything, and every call has a timeout as a second line of defence.
 * * **The `all_sta` reply is truncated near 4 KB, silently.** With enough clients the caller gets a
 *   short list that looks complete, so truncation is detected and the station table is rebuilt one
 *   station at a time instead.
 * * **The configuration must define a control interface path** or none of this works;
 *   `available()` reports that as a state rather than throwing at the first status call.
 */

import { run, streamLines, type StreamHandle } from './exec.ts';
import {
  parseHostapdEvent,
  parseHostapdStations,
  parseHostapdStatus,
  stationListLooksTruncated,
  type HostapdEvent,
  type HostapdStation,
  type HostapdStatus,
} from './parse/hostapd.ts';

/**
 * One reading of an access point's station table, and whether it is the whole table.
 *
 * **`complete` is its own field, and there is no boolean here for a caller to guess the meaning of.**
 * This used to return `{ stations, iterated }`, where `iterated` meant "the reply was truncated, so
 * the table was rebuilt one station at a time". The status snapshot carried it on as
 * `stationsIterated`, and the Clients screen read that as "the daemon got through the whole list" —
 * the opposite question with the same word. Every complete, untruncated reply, which is every reply on
 * an access point with fewer than about twenty clients, therefore printed "This access point did not
 * finish listing its clients". Measured on the bench board, 2026-09-23: `all_sta` answered in 7 ms,
 * exit 0, 1755 bytes, two stations, identical to `iw station dump` and `list_sta` — and the screen
 * said the list was unfinished.
 *
 * When the table genuinely is not whole, `reason` says why in a sentence a person can act on, because
 * "some may be missing" with no cause is a warning nobody can do anything with.
 */
export type StationListing =
  | { complete: true; stations: HostapdStation[]; /** Rebuilt with `list_sta` + `sta <mac>`. */ iterated: boolean }
  | { complete: false; stations: HostapdStation[]; iterated: boolean; reason: string };

export interface ApController {
  status(interfaceName: string): Promise<HostapdStatus | null>;
  stations(interfaceName: string): Promise<StationListing>;
  /** Subscribe to unsolicited events. The subscriber is restarted if it exits. */
  watch(interfaceName: string, onEvent: (event: HostapdEvent) => void): StreamHandle;
}

const HOSTAPD_CLI = '/usr/sbin/hostapd_cli';

/**
 * Where the generated hostapd configuration puts its control socket, and therefore where every call
 * here must look for it.
 *
 * **It lives in this module and the generator imports it**, rather than the other way round or in two
 * places. That is the fix for a defect found on the bench board: the generator wrote
 * `ctrl_interface=/run/wayfarer/hostapd` while every `hostapd_cli` call here omitted `-p`, so the
 * calls looked in the tool's default `/var/run/hostapd` and failed with:
 *
 * ```
 * $ hostapd_cli -i <ap> status
 * Failed to connect to hostapd - wpa_ctrl_open: No such file or directory
 * ```
 *
 * The consequence is the one already recorded for a `PrivateTmp` sandbox, arriving through a different
 * door: the access point reports no state and no clients while the radio is working perfectly, and the
 * interface shows an empty access point next to a healthy link.
 *
 * Not the shared `/var/run/hostapd`, because this project does not share a namespace: a socket in a
 * shared directory is one another hostapd instance can collide with. The cost is that `hostapd_cli`
 * run by hand needs `-p /run/wayfarer/hostapd`, and that is worth stating wherever somebody is told to
 * run it.
 */
export const HOSTAPD_CONTROL_DIR = '/run/wayfarer/hostapd';

export class EmptyInterfaceError extends Error {
  constructor() {
    super(
      'hostapd_cli was called with an empty interface name. It hangs forever in that ' +
        'case rather than failing, so the call is refused here instead.',
    );
    this.name = 'EmptyInterfaceError';
  }
}

/** The shape of one control-interface call, so tests can substitute it. */
export type HostapdCall = (
  interfaceName: string,
  command: string[],
  timeoutMs?: number,
) => Promise<{ code: number | null; stdout: string; stderr?: string; timedOut?: boolean }>;

export interface ApOptions {
  hostapdCliPath?: string;
  /** Overridable only so a test can point at a socket it created. */
  controlDir?: string;
  /**
   * Replaces the call to `hostapd_cli`. The station-iteration path is the one piece of
   * logic here that cannot be exercised on a bench with no associated clients, so it is
   * made substitutable rather than left untested.
   */
  call?: HostapdCall;
}

/**
 * The argument list for one `hostapd_cli` invocation.
 *
 * Extracted so it can be asserted directly. A test that substitutes the whole call and then inspects
 * the arguments its own substitute built proves nothing about the real one — and that is the mistake
 * this function exists to make impossible to repeat.
 */
export function hostapdArgs(controlDir: string, interfaceName: string, command: string[]): string[] {
  // `-p` before `-i`: the socket directory is ours, not the tool's default. Without it every call
  // fails with "No such file or directory" and the access point looks empty while the radio works.
  return ['-p', controlDir, '-i', interfaceName, ...command];
}

export function createApController(options: ApOptions | string = {}): ApController {
  const resolved: ApOptions = typeof options === 'string' ? { hostapdCliPath: options } : options;
  const hostapdCliPath = resolved.hostapdCliPath ?? HOSTAPD_CLI;
  const controlDir = resolved.controlDir ?? HOSTAPD_CONTROL_DIR;

  const cli: HostapdCall =
    resolved.call ??
    (async (interfaceName, command, timeoutMs = 5000) => {
      requireInterface(interfaceName);
      return await run(hostapdCliPath, hostapdArgs(controlDir, interfaceName, command), { timeoutMs });
    });

  return {
    async status(interfaceName) {
      const result = await cli(interfaceName, ['status']);
      if (result.code !== 0 || result.stdout.trim() === '') return null;
      return parseHostapdStatus(result.stdout);
    },

    async stations(interfaceName) {
      const all = await cli(interfaceName, ['all_sta'], 8000);
      if (all.code !== 0) {
        return { complete: false, stations: [], iterated: false, reason: callFailure('all_sta', all) };
      }
      if (!stationListLooksTruncated(all.stdout)) {
        return { complete: true, stations: parseHostapdStations(all.stdout), iterated: false };
      }
      // Truncated: the parsed list is discarded rather than repaired. A reply cut inside a value
      // parses cleanly and is simply wrong, and a repaired record is a guess presented as a
      // measurement.
      return await iterateStations(interfaceName, cli);
    },

    watch(interfaceName, onEvent) {
      requireInterface(interfaceName);
      let stopped = false;
      let handle: StreamHandle = start();

      function start(): StreamHandle {
        // A long-lived subscriber turns client arrival and departure into events instead of a poll.
        //
        // Interactive attach, with stdin held open, and NOT action mode (`-a <script>`). Measured on
        // the bench board with hostapd_cli 2.10: in action mode nothing at all reaches stdout — the
        // events go to the script — while an interactive attach prints them. And with stdin closed
        // the process prints its banner and exits within milliseconds, which is why
        // `keepStdinOpen` exists.
        return streamLines(hostapdCliPath, hostapdArgs(controlDir, interfaceName, []), {
          keepStdinOpen: true,
          onLine: (line) => {
            const event = parseHostapdEvent(line);
            if (event) onEvent(event);
          },
          onExit: () => {
            if (stopped) return;
            // hostapd restarting takes its control socket with it; reconnect rather than
            // going quiet, because a dead event source looks exactly like an idle one.
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

/**
 * Rebuilds the station table one station at a time: `list_sta` for the addresses, then `sta <mac>`
 * for each.
 *
 * **Not `sta_first` / `sta_next`.** Those are control-interface commands, not `hostapd_cli`
 * commands, and the tool rejects them locally before anything reaches the socket — measured on the
 * bench board with hostapd_cli 2.10:
 *
 * ```
 * $ hostapd_cli -i <ap> sta_first
 * Unknown command 'sta_first'
 * $ hostapd_cli -i <ap> help | grep sta
 *   sta <addr> = get MIB variables for one station
 *   all_sta = get MIB variables for all stations
 *   list_sta = list all stations
 * ```
 *
 * So the fallback for a truncated `all_sta` would itself have failed, leaving an access point with
 * many clients reporting no clients at all — the one case the fallback exists for.
 *
 * `list_sta` is the right entry point for a second reason: it returns one address per line, so the
 * reply that decides how many stations there are is the one reply that cannot overflow the ~4 KB
 * limit in a way that loses a station silently.
 *
 * Bounded at 512 stations, because a driver that keeps answering would otherwise loop forever.
 */
async function iterateStations(interfaceName: string, cli: HostapdCall): Promise<StationListing> {
  const listed = await cli(interfaceName, ['list_sta'], 8000);
  if (listed.code !== 0) {
    return {
      complete: false,
      stations: [],
      iterated: true,
      reason: `the full list was too long for one reply, and ${callFailure('list_sta', listed)}`,
    };
  }

  const every = listed.stdout
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(line));
  const addresses = every.slice(0, STATION_READ_LIMIT);

  const stations: HostapdStation[] = [];
  for (const mac of addresses) {
    const reply = await cli(interfaceName, ['sta', mac]);
    if (reply.code !== 0) continue;
    const parsed = parseHostapdStations(reply.stdout);
    // A station can leave between the listing and the read; that is one station missing from this
    // sample, not a failure of the sample.
    if (parsed[0]) stations.push(parsed[0]);
  }

  if (every.length > addresses.length) {
    return {
      complete: false,
      stations,
      iterated: true,
      reason: `hostapd listed ${every.length} stations and only the first ${STATION_READ_LIMIT} were read`,
    };
  }
  return { complete: true, stations, iterated: true };
}

const STATION_READ_LIMIT = 512;

/** Why one control-interface call gave no answer, in words: the exit status and what the tool said. */
function callFailure(
  command: string,
  result: { code: number | null; stdout: string; stderr?: string; timedOut?: boolean },
): string {
  const said = `${result.stderr ?? ''}\n${result.stdout}`.trim().split('\n')[0]?.trim().slice(0, 160) ?? '';
  const status = result.timedOut
    ? 'did not answer in time'
    : result.code === null
      ? 'was stopped before it finished'
      : `exited with status ${result.code}`;
  return `hostapd_cli ${command} ${status}${said === '' ? '' : `: ${said}`}`;
}

function requireInterface(interfaceName: string): void {
  if (interfaceName.trim() === '') throw new EmptyInterfaceError();
}
