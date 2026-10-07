/**
 * Network state: `ip -j` for reading, `ip monitor` as a change trigger.
 *
 * `ip monitor` output is deliberately **not** parsed. It is used only as a signal that
 * something changed, debounced, after which the full state is re-read with `ip -j`.
 * Two reasons: the monitor format is not stable across versions, and a full re-read is
 * cheap at this scale — which also makes the code idempotent against missed events,
 * the failure that a parsed event stream cannot recover from.
 */

import { run, streamLines, type StreamHandle } from './exec.ts';
import {
  linkCarrier,
  parseIpAddresses,
  parseIpLinks,
  parseIpRoutes,
  parseRouteGet,
  type NetAddress,
  type NetLink,
  type NetRoute,
} from './parse/ip-json.ts';

export interface NetSnapshot {
  links: NetLink[];
  addresses: NetAddress[];
  routes: NetRoute[];
  at: number;
}

export interface NetReader {
  links(): Promise<NetLink[]>;
  addresses(): Promise<NetAddress[]>;
  routes(): Promise<NetRoute[]>;
  /**
   * How this device would actually send to `address`, policy rules and all.
   *
   * `ip route get` resolves the whole decision rather than reading one table, which is the right
   * question: a tunnel captures traffic with policy rules, so a device that reads only the main
   * table would miss precisely the case this exists to catch.
   *
   * `null` when the question could not be answered — a third value, not a "no".
   */
  routeTo(address: string): Promise<{ device: string | null; source: string | null } | null>;
  snapshot(): Promise<NetSnapshot>;
  /**
   * Calls `onChange` with a fresh snapshot after the monitor goes quiet for
   * `debounceMs`. A burst — an interface coming up brings link, address and route
   * events within milliseconds — becomes one re-read.
   */
  watch(onChange: (snapshot: NetSnapshot) => void, debounceMs?: number): StreamHandle;
  /**
   * One ICMP echo to `address`, sent **bound to `interfaceName`**, and what came of it.
   *
   * Bound to the interface rather than routed, because the question is whether *this tunnel* carries
   * packets. An unbound echo is routed by policy, and on this device root-owned traffic takes the main
   * table (`wf-firewall`'s uid rules): with the tunnel down, an echo to its peer's address would leave by
   * the default route instead, and a host answering there would read as a live tunnel. `ping -I` binds
   * with `SO_BINDTODEVICE`, which skips the routing decision — measured on the bench board, 2026-09-21,
   * see `core/generate/units.ts`.
   *
   * Three outcomes, not two. `lost` is evidence about the tunnel: nothing answered, the interface is
   * gone, or it has no address — a dead tunnel looks like each of these. `error` is not: the probe
   * could not be run at all (no `ping`, no permission), and a caller that counted it as `lost` would
   * refuse a tunnel's traffic because of a missing binary.
   */
  ping(interfaceName: string, address: string, timeoutMs: number): Promise<PingOutcome>;

  /**
   * Makes `systemd-networkd` read the configuration files again.
   *
   * `networkctl reload` rather than restarting the service, because a restart takes every managed
   * link down and back up — including the one carrying the management session, which is the single
   * thing this design works hardest to avoid. Reload applies new and changed files to links that
   * stay up.
   *
   * Reload alone is not always enough, which is why `reconfigure` exists below: a file whose
   * *addressing* changed needs the link re-evaluated, and reload only notices the file.
   */
  reload(): Promise<{ ok: boolean; message: string }>;
  /**
   * Re-applies configuration to specific links, after a reload has been told about the files.
   *
   * Named links rather than all of them. `networkctl reconfigure` on everything would touch
   * interfaces this device does not manage, which is the same boundary violation as acting on a unit
   * we did not generate.
   */
  reconfigure(interfaces: string[]): Promise<{ ok: boolean; message: string }>;
  /**
   * Waits until every named interface has a carrier and an address, or the timeout expires.
   *
   * Returns what was observed rather than a boolean, because "settled" and "we stopped waiting" are
   * different outcomes and the caller's next decision depends on which it was. A caller that reads a
   * bare `false` cannot tell a dead link from a slow one.
   */
  waitForSettle(
    interfaces: { name: string; expect: 'address' | 'carrier-and-address' }[],
    timeoutMs: number,
  ): Promise<{
    settled: boolean;
    perInterface: { name: string; expect: string; carrier: boolean; address: string | null; ok: boolean }[];
  }>;
}

export type PingOutcome =
  | { kind: 'answered'; ms: number }
  | { kind: 'lost'; why: string }
  | { kind: 'error'; why: string };

/**
 * `ping`'s exit status 2 covers both a tunnel that is not there and a probe that could not run. These
 * are the messages of the first kind, from iputils: the interface does not exist (the tunnel client has
 * removed it), it holds no address to send from, or the kernel has no way out of it. Anything else with
 * status 2 is the second kind.
 */
const TUNNEL_ABSENT = /no such device|network is unreachable|cannot assign requested address|destination host unreachable/i;

/** Pure, so every branch is reachable from a test without a network. */
export function pingOutcome(result: { code: number | null; stdout: string; stderr: string; timedOut: boolean }): PingOutcome {
  if (result.code === 0) {
    const match = /time[=<]([0-9.]+)\s*ms/.exec(result.stdout);
    return { kind: 'answered', ms: match === null ? 0 : Math.max(0, Math.round(Number(match[1]))) };
  }
  if (result.code === 1 || result.timedOut) return { kind: 'lost', why: 'no echo reply' };
  const text = `${result.stderr} ${result.stdout}`.trim().replace(/\s+/g, ' ');
  if (TUNNEL_ABSENT.test(text)) return { kind: 'lost', why: text.slice(0, 160) };
  return { kind: 'error', why: text === '' ? `ping exited with status ${String(result.code)}` : text.slice(0, 160) };
}

const IP = '/usr/sbin/ip';
const PING = '/usr/bin/ping';
const NETWORKCTL = '/usr/bin/networkctl';

export function createNetReader(ipPath = IP, networkctlPath = NETWORKCTL, pingPath = PING): NetReader {
  const readJson = async (args: string[]): Promise<string> => {
    const result = await run(ipPath, ['-j', ...args], { timeoutMs: 5000 });
    // A non-zero exit still leaves whatever JSON was produced; the parsers tolerate
    // an empty or partial document by returning an empty list, and a status view must
    // show what it has rather than nothing.
    return result.stdout;
  };

  const reader: NetReader = {
    async links() {
      return parseIpLinks(await readJson(['link', 'show']));
    },
    async addresses() {
      return parseIpAddresses(await readJson(['addr', 'show']));
    },
    async routes() {
      // The IPv4 table; the family is stated rather than inferred, because the command is what
      // decides it.
      return parseIpRoutes(await readJson(['route', 'show']), 'inet');
    },
    async routeTo(address) {
      if (address.trim() === '') return null;
      try {
        return parseRouteGet(await readJson(['route', 'get', address]));
      } catch {
        // An unreachable destination makes `ip` exit non-zero, and so does a malformed address. Both
        // are "could not read", which the caller must treat as unknown rather than as a pass.
        return null;
      }
    },

    async snapshot() {
      const [links, addresses, routes] = await Promise.all([
        reader.links(),
        reader.addresses(),
        reader.routes(),
      ]);
      return { links, addresses, routes, at: Date.now() };
    },
    watch(onChange, debounceMs = 250) {
      let timer: NodeJS.Timeout | undefined;
      let stopped = false;

      const trigger = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (stopped) return;
          void reader
            .snapshot()
            .then(onChange)
            .catch(() => undefined);
        }, debounceMs);
        timer.unref();
      };

      let handle: StreamHandle = startMonitor();

      function startMonitor(): StreamHandle {
        return streamLines(ipPath, ['monitor', 'link', 'address', 'route'], {
          onLine: trigger,
          onExit: () => {
            // An event source that has died must not look like a quiet network.
            if (stopped) return;
            setTimeout(() => {
              if (!stopped) handle = startMonitor();
            }, 1000).unref();
          },
        });
      }

      // The first snapshot is pushed immediately: a client connecting must not wait for
      // the network to change before it sees anything.
      trigger();

      return {
        stop(): void {
          stopped = true;
          if (timer) clearTimeout(timer);
          handle.stop();
        },
      };
    },

    async reload() {
      const result = await run(networkctlPath, ['reload'], { timeoutMs: 30_000 });
      return { ok: result.code === 0, message: (result.stderr + result.stdout).trim() };
    },

    async reconfigure(interfaces) {
      const named = interfaces.filter((name) => name.trim() !== '');
      // Nothing to do is a success, not an error. A profile with no uplink and no access point is a
      // valid, expected state, and making that path fail would make the default profile un-appliable.
      if (named.length === 0) return { ok: true, message: 'no interfaces to reconfigure' };
      const result = await run(networkctlPath, ['reconfigure', ...named], { timeoutMs: 60_000 });
      return { ok: result.code === 0, message: (result.stderr + result.stdout).trim() };
    },

    async waitForSettle(interfaces, timeoutMs) {
      const named = interfaces.filter((entry) => entry.name.trim() !== '');
      if (named.length === 0) return { settled: true, perInterface: [] };

      const deadline = Date.now() + timeoutMs;
      let perInterface: { name: string; expect: string; carrier: boolean; address: string | null; ok: boolean }[] = [];

      for (;;) {
        const snapshot = await reader.snapshot().catch(() => null);
        if (snapshot !== null) {
          perInterface = named.map((entry) => {
            const link = snapshot.links.find((candidate) => candidate.name === entry.name);
            const address = snapshot.addresses.find(
              (candidate) => candidate.name === entry.name && candidate.family === 'inet',
            );
            // `linkCarrier`, not a comparison with a literal: `ip` prints `operstate` in upper case, and
            // the lower-case comparison that stood here read every real link as carrier-less, so this
            // wait ran out its whole timeout on every network apply. A driver that reports nothing
            // either way (`null`) counts as carrier — the same absent-is-not-zero rule as everywhere
            // else here, and this wait is informational, never a gate.
            const carrier = link !== undefined && linkCarrier(link) !== false;
            const hasAddress = address?.address !== undefined;
            return {
              name: entry.name,
              expect: entry.expect,
              carrier,
              address: address?.address ?? null,
              // What "settled" means for *this* interface. An access point has no carrier until the
              // radio is hosting, and that happens later in the apply order, so demanding one here
              // waits out the whole timeout and then calls a healthy interface broken.
              ok: entry.expect === 'address' ? hasAddress : carrier && hasAddress,
            };
          });
          if (perInterface.every((entry) => entry.ok)) return { settled: true, perInterface };
        }
        if (Date.now() >= deadline) return { settled: false, perInterface };
        // 500 ms: an address arriving is an event on a timescale of seconds, and a tighter poll buys
        // nothing but child processes on a four-core board.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },

    async ping(interfaceName, address, timeoutMs) {
      // `-W` is whole seconds in iputils; at least one, or a sub-second budget becomes "wait for ever".
      const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
      try {
        const result = await run(pingPath, ['-n', '-q', '-c', '1', '-W', seconds, '-I', interfaceName, address], {
          timeoutMs: timeoutMs + 2000,
        });
        // `-q` still prints the summary line; the per-reply `time=` is gone, so read the rtt line too.
        const rtt = /= [0-9.]+\/([0-9.]+)\//.exec(result.stdout);
        const outcome = pingOutcome(result);
        return outcome.kind === 'answered' && rtt !== null ? { kind: 'answered', ms: Math.round(Number(rtt[1])) } : outcome;
      } catch (error) {
        return { kind: 'error', why: String(error) };
      }
    },
  };

  return reader;
}
