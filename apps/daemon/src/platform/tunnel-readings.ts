/**
 * What a tunnel client says about its own session, read off the files it and its up-script write.
 *
 * Two readings, both for the OpenVPN entries (`core/liveness.ts` explains what each is evidence of):
 *
 * * **the client's link receive counter**, from its `--status` file. OpenVPN rewrites that file every
 *   few seconds (`status <path> 5`, written by `catalogue/ovpn.ts`), and `TCP/UDP read bytes` counts every
 *   byte read from the link — the peer's keepalive pings included, which arrive whether or not anything
 *   is using the tunnel. The tun interface's own counters are not this: a keepalive ping is a transport
 *   packet and never reaches the tun, so an idle healthy tunnel and a dead one read the same there.
 * * **the gateway the peer pushed**, captured by `tunnel-up` into `<id>.gateway` on every connect.
 *
 * Why the status file and not the management interface: the management socket takes one client at a
 * time and has to be held open for its real-time byte counts, which makes this daemon a long-lived
 * client of every tunnel and the only one that can look. The status file is written by the client
 * whatever anyone does, read in one call, and is also what a person on the board can `cat`.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GatewayCapture, KeepaliveReading, LivenessReaders } from '../core/liveness.ts';
import type { CoreLivenessApi } from './core-api.ts';
import type { PingOutcome } from './net.ts';
import type { JournalReader } from './journal-reader.ts';
import { CAPTURED_RESOLVER_DIR } from './captured-resolvers.ts';

/**
 * `TCP/UDP read bytes` from an OpenVPN client status file, or null when the text is not one.
 *
 * The client writes the statistics block regardless of `--status-version`, which applies to a server's
 * client list. A file caught between the client's truncate and its write is empty, and reads as null —
 * one missed reading, not a zero that would look like a restart.
 */
export function parseOpenVpnStatus(text: string): number | null {
  if (!text.startsWith('OpenVPN STATISTICS')) return null;
  const line = /^TCP\/UDP read bytes,([0-9]+)\s*$/m.exec(text);
  if (line === null) return null;
  const value = Number(line[1]);
  return Number.isSafeInteger(value) ? value : null;
}

export async function readOpenVpnCounter(directory: string, tunnelId: string): Promise<KeepaliveReading> {
  const path = join(directory, `${tunnelId}.status`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { kind: 'absent', why: `${path} does not exist: the client has not written its status since it started` }
      : { kind: 'unreadable', why: `${path}: ${String(error)}` };
  }
  const bytes = parseOpenVpnStatus(text);
  return bytes === null
    ? { kind: 'unreadable', why: `${path} holds no "TCP/UDP read bytes" line` }
    : { kind: 'read', linkReadBytes: bytes };
}

/**
 * The gateway a peer pushed on its last connect, from the up-script's capture.
 *
 * `connection` is the capture's device and inode. The up-script writes a temporary file and renames it
 * over the capture on every connect, so a new connection is a new inode — which is how "has this
 * gateway answered since the tunnel connected" is kept per connection without a clock.
 */
export async function readCapturedGateway(tunnelId: string, directory = CAPTURED_RESOLVER_DIR): Promise<GatewayCapture | null> {
  const path = join(directory, `${tunnelId}.gateway`);
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const address = text.split('\n').map((line) => line.trim()).find((line) => line !== '');
    // The up-script already filters to a dotted quad; checked again because this names a ping target.
    if (address === undefined || !/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(address)) return null;
    return { address, connection: `${String(info.dev)}:${String(info.ino)}` };
  } catch {
    return null;
  }
}

/**
 * The `ping N` a peer pushed, from the client's own log line of the PUSH_REPLY, or null.
 *
 * The up-script cannot see it: measured with OpenVPN 2.6.14, 2026-09-24, the pushed `ping` and
 * `ping-restart` appear in no environment variable (`test/fixtures/openvpn/up-env-*.txt`), only in the
 * client's `PUSH: Received control message: 'PUSH_REPLY,…,ping 15,ping-restart 120,…'` line
 * (`push-reply-subnet.txt`). Matched as a whole comma-separated option, so `ping-restart` is never read
 * as `ping`.
 */
export function parsePushedKeepalive(message: string): number | null {
  const reply = /PUSH_REPLY,([^']*)/.exec(message)?.[1];
  if (reply === undefined) return null;
  for (const option of reply.split(',')) {
    const match = /^ping ([0-9]{1,4})$/.exec(option.trim());
    if (match !== null) {
      const seconds = Number(match[1]);
      return seconds > 0 ? seconds : null;
    }
  }
  return null;
}

/** The newest PUSH_REPLY line of a tunnel's client unit, parsed. Null when there is none or it cannot be read. */
export async function readPushedKeepalive(journal: JournalReader, unit: string): Promise<number | null> {
  try {
    const page = await journal.read({ unit, grep: 'PUSH: Received control message', limit: 1 });
    const newest = page.entries[page.entries.length - 1];
    return newest === undefined ? null : parsePushedKeepalive(newest.message);
  } catch {
    return null;
  }
}

/**
 * The readers the liveness meter is given on the device, assembled in one place so `index.ts` and the
 * tests that prove the guard build the same thing — a test that assembles its own readers tests its own
 * readers (`docs/16-implementation-notes.md`).
 */
export function deviceLivenessReaders(input: {
  core: CoreLivenessApi;
  ping: (interfaceName: string, address: string, timeoutMs: number) => Promise<PingOutcome>;
  statusDirectory: string;
  captureDirectory?: string;
  journal: JournalReader;
  /** The client unit of a tunnel, whose log carries the PUSH_REPLY. The catalogue's name, not a guess. */
  clientUnit: (tunnelId: string) => string;
  /** Monotonic milliseconds; `performance.now()` unless a test steps it. */
  now?: () => number;
}): LivenessReaders {
  return {
    now: input.now ?? ((): number => performance.now()),
    keepalive: (tunnelId) => readOpenVpnCounter(input.statusDirectory, tunnelId),
    pushedKeepalive: (tunnelId) => readPushedKeepalive(input.journal, input.clientUnit(tunnelId)),
    gateway: (tunnelId) => readCapturedGateway(tunnelId, input.captureDirectory),
    ping: input.ping,
    connections: () => input.core.connections(),
    check: (outbound, url, timeoutMs) => input.core.check(outbound, url, timeoutMs),
  };
}
