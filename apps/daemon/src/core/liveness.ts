/**
 * Whether a tunnel is alive, asked of the tunnel — never of anything it carries.
 *
 * ## Why this exists
 *
 * Measured on the bench board, 2026-09-24: `partner` (OpenVPN, `onUnavailable: block`) was judged by
 * fetching `http://172.30.0.212/`, one of its own **resources**, written into the profile because the
 * field's documentation advised giving a destination tunnel "something that exists behind it". Overnight
 * that server stopped answering on port 80 (it still answered 443 with `202`). The guard read the tunnel
 * as dead and refused everything it carried, while the tunnel itself was healthy: its pushed
 * `route-gateway` `10.136.0.1` answered pings over `wfvpnprt` in 95 ms with no loss. One closed port on one
 * server became an outage of every destination behind the tunnel.
 *
 * The replacement that had been added the day before for tunnels without a probe — an echo to the
 * resolver the peer pushed — was no better for `partner`: its peer pushes `77.88.8.8` and `8.8.8.8`,
 * public resolvers that say nothing about the tunnel.
 *
 * So liveness is a property of the tunnel, and **the catalogue entry says how its own protocol can be
 * asked** (`CatalogueEntry.liveness`). This module performs what the entry named and returns one of three
 * answers. It is given nothing about what a tunnel carries — no resources, no rules, no names behind it —
 * and has no way to ask for them.
 *
 * ## Three answers, and the third is never the second
 *
 * `alive`, `dead`, or `unmeasurable`. A reading that could not be taken — no status file yet, a gateway
 * that has never answered an echo, a core that does not know the outbound — is `unmeasurable` and says
 * why. It is never counted as `dead`: a missing reading is not evidence about the tunnel.
 *
 * ## The clock
 *
 * Every age here is a difference of readings of `now`, which is `performance.now()` in production and
 * monotonic from process start. This board has no RTC battery; a wall-clock step of days is ordinary, and
 * an age computed across one would be a number that never happened.
 */

import type { PingOutcome } from '../platform/net.ts';

/* ── what an entry names ─────────────────────────────────────────────────────────────────── */

/**
 * How a tunnel's liveness is asked, as its catalogue entry states it.
 *
 * * `peer-keepalive` — a protocol with a session and a keepalive of its own (OpenVPN, and OpenVPN inside
 *   Cloak). Primary: time since the last packet from the peer. Confirming: an echo to the gateway the
 *   peer pushed, over the tunnel's own interface.
 * * `through-outbound` — a protocol with **no session** (VLESS, the proxy entry). Nothing can be asked
 *   while it is idle, so: bytes arriving back through its outbound if traffic is flowing, and only when
 *   it is idle a request through the outbound to neutral connectivity checks.
 * * `none` — the entry cannot say, and the reason.
 *
 * WireGuard (plan row F2) adds its own kind here — the age of the last handshake, which the kernel
 * reports per peer — and a branch in `measureRound`. Nothing about the guard changes when it does.
 */
export type LivenessMethod =
  | { kind: 'peer-keepalive'; interfaceName: string }
  | { kind: 'through-outbound'; outbound: string }
  | { kind: 'none'; why: string };

/** What was measured, for the panel and the API. */
export type LivenessBasis = 'keepalive' | 'gateway-echo' | 'traffic' | 'neutral-endpoints' | 'none';

export interface Liveness {
  state: 'alive' | 'dead' | 'unmeasurable';
  /** The reading the answer rests on. */
  basis: LivenessBasis;
  /** The reading, in a sentence a person reads. */
  why: string;
}

/* ── the constants, each with its reason ─────────────────────────────────────────────────── */

/**
 * How long without a packet from an OpenVPN peer before the tunnel reads dead **when the keepalive the
 * peer pushed is not known**, in seconds. When it is known the limit is three of its intervals — see
 * `silenceLimit` in `createLivenessMeter`.
 *
 * From the peers this device has, read from the journal on 2026-09-24: `partner` pushes `ping 15` and
 * `ping-restart 120`, `corp` pushes `ping 10` and `ping-restart 120`. A peer with a keepalive sends
 * something at least every ping interval, so sixty seconds is four missed pings at the longest interval
 * measured, and half of the peers' own restart timeout — the tunnel reads dead well before OpenVPN gives
 * up on it itself, and never on one late packet.
 */
export const KEEPALIVE_SILENCE_SECONDS = 60;

/**
 * How often OpenVPN rewrites its status file (`status <path> 5`, written by `catalogue/ovpn.ts`), and so
 * how often the counter is worth sampling. `index.ts` samples at this cadence between rounds: sampled
 * only per round, the silence clock started when a round *noticed* the counter had stopped, which on the
 * board added a whole 30 s round to every detection (measured 2026-09-24: ~115 s from a stopped
 * transport to a dead reading).
 */
export const KEEPALIVE_STATUS_SECONDS = 5;

/**
 * The neutral connectivity checks a session-less tunnel is asked through when it is idle.
 *
 * Three unrelated operators, so a majority means something: one of them having a bad day is one lost
 * answer, not a dead tunnel. Each is a tiny response that exists for exactly this. None of them is, or
 * can be, anything a tunnel carries — which is the whole rule this module is built on.
 *
 * **HTTPS, and it has to be.** Measured against sing-box 1.14.1, 2026-09-24
 * (`test/fixtures/core-api/delay-*.txt`): the core's delay test silently replaces any `http://` URL
 * with its own default and dials `www.gstatic.com:443` instead — for `http://cp.cloudflare.com/...`, for
 * a blackhole address, and with no URL at all. Only an `https://` URL is dialled as given. So three
 * `http://` checks would have been three requests to one Google host, and a majority of one.
 *
 * Each was measured through a working outbound that day: Cloudflare `200` in 76 ms, Google `200` in
 * 458 ms, Mozilla `200` in 222 ms. `https://www.msftconnecttest.com/connecttest.txt` was measured and
 * **rejected**: that host serves no valid certificate, and the delay test answered `503`.
 */
export const NEUTRAL_CHECKS: readonly string[] = [
  'https://cp.cloudflare.com/generate_204',
  'https://connectivitycheck.gstatic.com/generate_204',
  'https://detectportal.firefox.com/success.txt',
];

/* ── what the meter is given ─────────────────────────────────────────────────────────────── */

/** The link-level receive counter an OpenVPN client reports, or why it could not be read. */
export type KeepaliveReading =
  | { kind: 'read'; linkReadBytes: number }
  | { kind: 'absent'; why: string }
  | { kind: 'unreadable'; why: string };

/** The gateway a peer pushed on its last connect, and an identity that changes on every connect. */
export interface GatewayCapture {
  address: string;
  /** Changes when the up-script writes the capture again — that is, on every connect. */
  connection: string;
}

/** One connection the core is carrying, as its control interface reports it. */
export interface CoreConnection {
  id: string;
  /** Outbound tags, the one that carries the bytes first. */
  chains: string[];
  /** Bytes received back through the chain since the connection opened. */
  download: number;
}

/** A request through one outbound, three ways — see `platform/core-api.ts` for how each is read. */
export type CheckOutcome = { kind: 'answered'; ms: number } | { kind: 'lost'; why: string } | { kind: 'error'; why: string };

export interface LivenessReaders {
  /** Monotonic milliseconds. */
  now: () => number;
  keepalive: (tunnelId: string) => Promise<KeepaliveReading>;
  /** The `ping N` the peer pushed on its last connect, in seconds, or null when it is not known. */
  pushedKeepalive: (tunnelId: string) => Promise<number | null>;
  gateway: (tunnelId: string) => Promise<GatewayCapture | null>;
  ping: (interfaceName: string, address: string, timeoutMs: number) => Promise<PingOutcome>;
  /** Every connection the core is carrying, or null when that could not be read. */
  connections: () => Promise<CoreConnection[] | null>;
  check: (outbound: string, url: string, timeoutMs: number) => Promise<CheckOutcome>;
}

export interface LivenessSubject {
  tunnelId: string;
  method: LivenessMethod;
}

/* ── the meter ───────────────────────────────────────────────────────────────────────────── */

interface KeepaliveMemory {
  /** The counter at the last sample. */
  bytes: number;
  /** When a sample first saw the counter at a new value; null while it has not risen since this process began. */
  roseAt: number | null;
  /** When this tunnel's counter was first sampled by this process. */
  firstAt: number;
  /** Whether the last sample was `silent`, so a sample that changes that can be reported. */
  silent: boolean;
}

interface TrafficSample {
  at: number;
  /** Download per connection id, attributed to the outbound that carries it. */
  byConnection: Map<string, { outbound: string; download: number }>;
}

/**
 * The meter, which keeps what one reading needs from the last: the counters, which gateways have
 * answered since their connect, the keepalive interval each peer pushed, and the previous connection
 * sample.
 *
 * One instance for the life of the daemon, built by `index.ts` and handed to the watchdog; `index.ts`
 * also calls `sampleKeepalives` every `KEEPALIVE_SAMPLE_SECONDS`, between rounds.
 */
export function createLivenessMeter(readers: LivenessReaders): {
  measureRound: (subjects: LivenessSubject[], options: { echoes: number; timeoutMs: number }) => Promise<Map<string, Liveness>>;
  /**
   * Read each counter now. Returns the tunnels whose keepalive standing changed with this sample —
   * fell silent, or started arriving again — so the caller can measure them at once rather than at the
   * next round.
   */
  sampleKeepalives: (tunnelIds: string[]) => Promise<string[]>;
} {
  const keepalives = new Map<string, KeepaliveMemory>();
  /** Connection identities (`GatewayCapture.connection`) whose gateway has answered at least once. */
  const answeredSince = new Set<string>();
  let previousTraffic: TrafficSample | null = null;
  /** The keepalive interval each peer pushed, per connection; see `silenceLimit`. */
  const pushed = new Map<string, { connection: string | null; fetchedAt: number; pingSeconds: number | null }>();

  /* ── OpenVPN: the peer's own keepalive, and its gateway ──────────────────────────────── */

  /**
   * How long without a packet before the peer reads silent: three of its own keepalive intervals.
   *
   * The peer sends something at least every `ping N` it pushed (read from the client's journal line —
   * `partner` pushes `ping 15`, `corp` `ping 10`), so three missed keepalives is 30–45 s on this
   * board. Three rather than two because one late keepalive plus the five-second status write plus the
   * five-second sample must never read as silence on its own. When the interval is not known — the
   * journal line is gone or the peer pushed none — `KEEPALIVE_SILENCE_SECONDS` stands, and the reading
   * says so.
   *
   * Re-read on every new connection (the gateway capture's identity changes) and otherwise at most every
   * ten minutes: a peer's keepalive is fixed for a connection, and the journal is not free to query.
   */
  const silenceLimit = async (tunnelId: string): Promise<{ seconds: number; source: string }> => {
    const connection = (await readers.gateway(tunnelId).catch(() => null))?.connection ?? null;
    const known = pushed.get(tunnelId);
    const now = readers.now();
    let pingSeconds: number | null;
    if (known !== undefined && known.connection === connection && now - known.fetchedAt < 10 * 60_000) {
      pingSeconds = known.pingSeconds;
    } else {
      pingSeconds = await readers.pushedKeepalive(tunnelId).catch(() => null);
      pushed.set(tunnelId, { connection, fetchedAt: now, pingSeconds });
    }
    return pingSeconds === null
      ? { seconds: KEEPALIVE_SILENCE_SECONDS, source: 'its peer’s keepalive interval is not known' }
      : { seconds: 3 * pingSeconds, source: `three of the ${String(pingSeconds)} s keepalives its peer pushed` };
  };

  /** Read one counter and fold it into the memory. `null` when it could not be read. */
  const sampleOne = async (tunnelId: string): Promise<{ memory: KeepaliveMemory; now: number } | { why: string }> => {
    const reading = await readers.keepalive(tunnelId).catch(
      (error: unknown): KeepaliveReading => ({ kind: 'unreadable', why: String(error) }),
    );
    const now = readers.now();
    if (reading.kind !== 'read') return { why: reading.why };
    const memory = keepalives.get(tunnelId);
    if (memory === undefined) {
      const fresh: KeepaliveMemory = { bytes: reading.linkReadBytes, roseAt: null, firstAt: now, silent: false };
      keepalives.set(tunnelId, fresh);
      return { memory: fresh, now };
    }
    /*
     * A rise is a packet from the peer. A fall is the client restarting — its counters start again from
     * zero — and a fall to a non-zero value means packets have arrived since that restart, which is also
     * a packet from the peer. A fall to zero says only that the client restarted.
     */
    const rose = reading.linkReadBytes > memory.bytes || (reading.linkReadBytes < memory.bytes && reading.linkReadBytes > 0);
    memory.bytes = reading.linkReadBytes;
    if (rose) memory.roseAt = now;
    return { memory, now };
  };

  /** Seconds since the counter was last seen to rise, or since it was first read if it never has. */
  const quietSeconds = (memory: KeepaliveMemory, now: number): number =>
    Math.floor((now - (memory.roseAt ?? memory.firstAt)) / 1000);

  const judgeKeepalive = (
    memory: KeepaliveMemory,
    now: number,
    limit: { seconds: number; source: string },
  ): { standing: 'recent' | 'silent' | 'unknown'; quiet: number; sentence: string } => {
    const quiet = quietSeconds(memory, now);
    if (quiet >= limit.seconds) {
      return {
        standing: 'silent',
        quiet,
        sentence: `nothing has arrived from the peer for at least ${String(quiet)} s (limit ${String(limit.seconds)} s: ${limit.source})`,
      };
    }
    if (memory.roseAt === null) {
      return {
        standing: 'unknown',
        quiet,
        sentence: `the counter has not moved in the ${String(quiet)} s it has been read, which is under the ${String(limit.seconds)} s limit`,
      };
    }
    return {
      standing: 'recent',
      quiet,
      sentence: `the peer's packets were last seen arriving ${String(quiet)} s ago, under the ${String(limit.seconds)} s limit`,
    };
  };

  const echoGateway = async (
    tunnelId: string,
    interfaceName: string,
    options: { echoes: number; timeoutMs: number },
  ): Promise<{ standing: 'answered' | 'lost' | 'unknown'; sentence: string }> => {
    const gateway = await readers.gateway(tunnelId).catch(() => null);
    if (gateway === null) {
      return { standing: 'unknown', sentence: 'its peer has pushed no gateway since this device started, so there is nothing to echo' };
    }
    const what = `${gateway.address}, the gateway its peer pushed, over ${interfaceName}`;
    let lost: string | null = null;
    let error: string | null = null;
    for (let attempt = 0; attempt < Math.max(1, options.echoes); attempt += 1) {
      const outcome = await readers.ping(interfaceName, gateway.address, options.timeoutMs);
      if (outcome.kind === 'answered') {
        answeredSince.add(gateway.connection);
        return { standing: 'answered', sentence: `${what} answered in ${String(outcome.ms)} ms` };
      }
      if (outcome.kind === 'lost') lost = outcome.why;
      else error = outcome.why;
    }
    if (lost === null) {
      return { standing: 'unknown', sentence: `the echo to ${what} could not be sent: ${error ?? 'no reason given'}` };
    }
    /*
     * A gateway that has never answered is one that does not answer echoes — plenty of servers drop
     * ICMP — and its silence now says nothing. Only a gateway that answered on this connection and has
     * stopped is evidence.
     */
    if (!answeredSince.has(gateway.connection)) {
      return {
        standing: 'unknown',
        sentence: `${what} did not answer, and it has not answered since this connection was made, so its silence says nothing`,
      };
    }
    return { standing: 'lost', sentence: `${what} answered earlier on this connection and has stopped (${lost})` };
  };

  const measureKeepalive = async (
    tunnelId: string,
    interfaceName: string,
    options: { echoes: number; timeoutMs: number },
  ): Promise<Liveness> => {
    // The echo first and the counter after it, so the sample includes whatever the echo's reply
    // brought — a gateway that answered late is a counter that rose, never a flat one.
    const echo = await echoGateway(tunnelId, interfaceName, options);
    const sampled = await sampleOne(tunnelId);
    const limit = await silenceLimit(tunnelId);
    const keepalive =
      'why' in sampled
        ? { standing: 'unknown' as const, quiet: 0, sentence: `the client's own counters could not be read (${sampled.why})` }
        : judgeKeepalive(sampled.memory, sampled.now, limit);
    if ('memory' in sampled) sampled.memory.silent = keepalive.standing === 'silent';

    /*
     * The confirming signal confirms. A gateway that answered on this connection and has stopped, **and**
     * a counter that has not moved across two status writes, is a peer that has stopped: the echo would
     * have brought a reply that moved the counter. Neither alone is — an idle peer's counter is flat
     * between keepalives, and one echo can be lost on a working path.
     *
     * Measured on the bench board, 2026-09-24: `corp`'s transport stopped at 08:39:27; the echo said
     * "stopped" at the next round while the keepalive alone still read alive for a minute more, and the
     * first dead reading came at 08:41:22.
     */
    if (echo.standing === 'lost' && 'memory' in sampled && keepalive.quiet >= 2 * KEEPALIVE_STATUS_SECONDS) {
      return { state: 'dead', basis: 'gateway-echo', why: `${echo.sentence}, and ${keepalive.sentence}` };
    }
    if (keepalive.standing === 'recent') {
      return { state: 'alive', basis: 'keepalive', why: `${keepalive.sentence}; ${echo.sentence}` };
    }
    if (echo.standing === 'answered') {
      return { state: 'alive', basis: 'gateway-echo', why: `${echo.sentence}; ${keepalive.sentence}` };
    }
    if (keepalive.standing === 'silent') {
      return { state: 'dead', basis: 'keepalive', why: `${keepalive.sentence}; ${echo.sentence}` };
    }
    return { state: 'unmeasurable', basis: 'none', why: `${keepalive.sentence}; ${echo.sentence}` };
  };

  const sampleKeepalives = async (tunnelIds: string[]): Promise<string[]> => {
    const changed: string[] = [];
    for (const tunnelId of tunnelIds) {
      const sampled = await sampleOne(tunnelId);
      if ('why' in sampled) continue;
      const limit = await silenceLimit(tunnelId);
      const silent = judgeKeepalive(sampled.memory, sampled.now, limit).standing === 'silent';
      if (silent !== sampled.memory.silent) changed.push(tunnelId);
      sampled.memory.silent = silent;
    }
    return changed;
  };

  /* ── a session-less tunnel: its traffic, or neutral checks when it is idle ───────────── */

  /**
   * Bytes that came **back** through each outbound since the previous sample.
   *
   * Only the growth counts. A connection opened before the path died keeps the bytes it received while
   * the path worked, and its cumulative counter would read as alive for as long as it stays open. A
   * connection present in both samples contributes the difference; one that opened since the previous
   * sample contributes everything it has, since all of it arrived after that sample; one that has gone
   * contributes nothing. Uploaded bytes are never evidence: a dead path accepts whatever is sent into it.
   */
  const sampleTraffic = (connections: CoreConnection[] | null, now: number): Map<string, { bytes: number; seconds: number }> | null => {
    if (connections === null) return null;
    const current: TrafficSample = { at: now, byConnection: new Map() };
    for (const connection of connections) {
      const outbound = connection.chains[0];
      if (outbound === undefined) continue;
      current.byConnection.set(connection.id, { outbound, download: connection.download });
    }
    const previous = previousTraffic;
    previousTraffic = current;
    if (previous === null) return null;
    const growth = new Map<string, { bytes: number; seconds: number }>();
    const seconds = Math.max(1, Math.round((now - previous.at) / 1000));
    for (const [id, entry] of current.byConnection) {
      const before = previous.byConnection.get(id);
      const added = before === undefined ? entry.download : Math.max(0, entry.download - before.download);
      const sum = growth.get(entry.outbound) ?? { bytes: 0, seconds };
      sum.bytes += added;
      growth.set(entry.outbound, sum);
    }
    return growth;
  };

  const measureOutbound = async (
    outbound: string,
    growth: Map<string, { bytes: number; seconds: number }> | null,
    options: { timeoutMs: number },
  ): Promise<Liveness> => {
    const received = growth?.get(outbound);
    if (received !== undefined && received.bytes > 0) {
      return {
        state: 'alive',
        basis: 'traffic',
        why: `alive: ${formatBytes(received.bytes)} received through it in the last ${String(received.seconds)} s, so no check was sent`,
      };
    }
    let answered = 0;
    let lost = 0;
    const errors: string[] = [];
    for (const url of NEUTRAL_CHECKS) {
      const outcome = await readers.check(outbound, url, options.timeoutMs).catch(
        (error: unknown): CheckOutcome => ({ kind: 'error', why: String(error) }),
      );
      if (outcome.kind === 'answered') answered += 1;
      else if (outcome.kind === 'lost') lost += 1;
      else errors.push(outcome.why);
    }
    const total = NEUTRAL_CHECKS.length;
    const idle =
      growth === null
        ? 'its traffic could not be compared with a previous reading'
        : 'idle';
    const tally = `${String(answered)} of ${String(total)} connectivity checks answered through it`;
    // A majority of all the checks, not of the ones that ran: two checks that could not be sent and one
    // that answered are not a verdict in either direction.
    if (answered * 2 > total) return { state: 'alive', basis: 'neutral-endpoints', why: `${idle}; ${tally}` };
    if (lost * 2 > total) return { state: 'dead', basis: 'neutral-endpoints', why: `${idle}; ${tally}` };
    return {
      state: 'unmeasurable',
      basis: 'none',
      why: `${idle}; ${tally}, which is no majority either way${errors.length === 0 ? '' : ` (${errors[0]!})`}`,
    };
  };

  return {
    sampleKeepalives,
    async measureRound(subjects, options) {
      const results = new Map<string, Liveness>();
      // One sample of the core's connections per round, shared by every session-less tunnel in it, so
      // the interval each growth is measured over is the same for all of them.
      const wantsTraffic = subjects.some((subject) => subject.method.kind === 'through-outbound');
      const growth = wantsTraffic
        ? sampleTraffic(await readers.connections().catch(() => null), readers.now())
        : null;
      for (const subject of subjects) {
        const method = subject.method;
        if (method.kind === 'none') {
          results.set(subject.tunnelId, { state: 'unmeasurable', basis: 'none', why: method.why });
        } else if (method.kind === 'peer-keepalive') {
          results.set(subject.tunnelId, await measureKeepalive(subject.tunnelId, method.interfaceName, options));
        } else {
          results.set(subject.tunnelId, await measureOutbound(method.outbound, growth, options));
        }
      }
      return results;
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
