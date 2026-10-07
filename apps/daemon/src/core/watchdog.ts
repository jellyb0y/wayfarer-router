/**
 * The health watchdog: probe, decide, and tell the core — the loop that makes failover happen.
 *
 * Deliberately thin. Everything that can be decided without talking to anything lives in `health.ts` and
 * is tested there; everything that talks to the core lives in `platform/core-api.ts`. What is left here is
 * the sequencing, the fail-streak bookkeeping, and the rule about what gets written to the event ring.
 *
 * ## What it records, and what it does not
 *
 * A round that changes nothing writes nothing. A watchdog that logged every thirty-second round would
 * fill the ring — the only record that survives a bad boot — with the observation that nothing happened,
 * and push out the entries that say what did. So: a **switch** is recorded, a tunnel **becoming**
 * unhealthy or recovering is recorded, and a steady state is not.
 *
 * ## Why the current selection is read back rather than remembered
 *
 * The core is the authority on what it is doing. An operator can point the selector somewhere by hand,
 * the core can restart and come up on its first member, and a `PUT` can fail. A watchdog that trusted its
 * own memory of the last selection it made would then compare against a fiction — and the failure mode is
 * silent, because both numbers look plausible.
 */

import {
  decideSelection,
  summarise,
  type ProbeThresholds,
  type TunnelHealth,
} from './health.ts';
import type { CoreApi, ProxyEntry } from '../platform/core-api.ts';
import {
  CORE_TAGS,
  FALL_THROUGH_DNS,
  FALL_THROUGH_ORDINARY,
  fallThroughDnsSelectorTag,
  fallThroughSelectorTag,
  guardSelectorTag,
  type ProfileDocument,
} from '@wayfarer/schemas';
import type { ObserverHandle, ObserverItem } from './observers.ts';
import { CATALOGUE, type CatalogueEntry } from './catalogue/index.ts';
import type { Liveness, LivenessBasis, LivenessMethod, LivenessSubject } from './liveness.ts';

export interface WatchdogPolicy {
  priority: string[];
  excluded: string[];
  sticky: boolean;
  onAllDown: 'block' | 'direct';
  /**
   * `intervalSeconds` is here as well as driving the loop's cadence, because the round uses it as its own
   * **budget**: probes are sequential and a round that cannot finish inside the interval stops and reports
   * what it did not measure.
   */
  probes: ProbeThresholds & { count: number; failStreak: number; endpoints: string[]; intervalSeconds: number };
}

export interface WatchdogDeps {
  core: CoreApi;
  /** The selector this project generates. Named rather than discovered, because it is ours. */
  selector: string;
  /** Outbound names that are candidates: the tunnels, never `direct`, `block` or the selector itself. */
  candidates: () => Promise<string[]>;
  /**
   * The destination tunnels, each with how its own protocol is asked whether it is alive — see
   * `guardedTunnels`.
   *
   * Separate from `candidates` because these are not interchangeable and are never selected *into*: the
   * only question about each is whether it is alive, which makes this a different reading with a
   * different consequence for getting it wrong.
   */
  guards: () => Promise<GuardedTunnel[]>;
  policy: () => WatchdogPolicy;
  record: (event: { level: 'info' | 'warn' | 'error'; kind: string; summary: string; detail: unknown }) => void;
  log: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string) => void;
  /**
   * The clock, injectable so the restatement cadence below can be exercised without waiting a quarter of
   * an hour. Monotonic milliseconds; defaults to `performance.now()`, and production passes nothing.
   *
   * It was `Date.now` until 2026-09-24. This board has no RTC battery and its wall clock steps by days
   * when a time source appears, so a restatement due in fifteen minutes could come after a step of
   * minus four days — never — or be skipped by one forwards.
   */
  now?: () => number;
  /**
   * Told after every round, including a round that failed (`null`). A steady round records nothing in
   * the ring by design, so without this a running watchdog and a stopped one look identical — see
   * `core/observers.ts`.
   */
  onRound?: (outcome: RoundOutcome | null) => void;
  /** Told when a round begins. See `observeWatchdog` for why a look is recorded at the start as well. */
  onRoundStart?: () => void;
  /**
   * Asks each guarded tunnel whether it is alive, the way its catalogue entry says — see
   * `core/liveness.ts`. Absent means nothing about any guard can be measured, and each one says so.
   */
  liveness?: {
    measureRound: (subjects: LivenessSubject[], options: { echoes: number; timeoutMs: number }) => Promise<Map<string, Liveness>>;
  };
}

/**
 * How long a guard may sit in an abnormal standing before the ring is told again.
 *
 * A dead tunnel is an **outage** of everything it carries, not a steady state, and the watchdog's usual
 * rule — record transitions, stay quiet otherwise — is exactly wrong for it. Measured 2026-09-21: a guard
 * blocked at 10:08 produced one event and then nothing for three hours, because nothing changed. The
 * record of the longest outage the device had ever had was a single line timestamped at its beginning.
 *
 * Fifteen minutes rather than every round, because this can persist for days and the ring is finite.
 */
export const GUARD_RESTATE_SECONDS = 900;

/**
 * The floor on a guard measurement's timeout, in milliseconds.
 *
 * Not derived from `maxLatencyMs` alone: that value ranks interchangeable tunnels, and at its 500 ms
 * default a `maxLatencyMs * 4` timeout turns any tunnel answering slower than two seconds into a lost
 * echo — a latency threshold deciding an availability question by the back door.
 */
export const GUARD_PROBE_TIMEOUT_FLOOR_MS = 4000;

/**
 * Consecutive **dead** rounds before a fall-through tunnel's traffic is sent outside it (G31).
 *
 * Two, and consecutive in the strict sense: an alive or a not-measurable round in between starts the
 * count again, so a reading that flaps never moves anything and "not measurable" can never be one of the
 * rounds. Not one, because this is the one move in the product that sends traffic outside a tunnel the
 * owner put it in, and a false dead reading here is a leak rather than an outage. Not more, because each
 * dead reading already spans the tunnel's own silence limit: a keepalive verdict is three missed
 * keepalives of the peer's (30 s for `corp`'s `ping 10`, 45 s for `partner`'s `ping 15`), and an echo
 * verdict needs a gateway that answered on this connection and a counter flat across two status writes.
 *
 * Measured on the board (G31 acceptance, 2026-09-24, `corp`): both selectors moved ~45 s after the
 * tunnel's transport was stopped, and back ~60 s after the tunnel returned. See docs/04.
 */
export const FALL_THROUGH_DEAD_ROUNDS = 2;

/**
 * Consecutive **alive** rounds before a fallen-through tunnel is given its traffic back.
 *
 * Three, strict in the same way: a dead or a not-measurable round starts the count again. More than the
 * two it takes to fall, because every switch interrupts every connection it moves, and a tunnel that has
 * just reconnected is the one most likely to drop again within a minute; three alive rounds is 60–90 s
 * of evidence at the default cadence. The cost of the extra round is that traffic leaves outside the
 * tunnel for one round longer than it had to.
 */
export const FALL_THROUGH_ALIVE_ROUNDS = 3;

/**
 * A destination tunnel the watchdog measures, and nothing it carries.
 *
 * There is deliberately no field here for a URL, an address behind the tunnel, or its resources. Until
 * 2026-09-24 there was — `probe.endpoints` — and the guard on `partner` fetched one of that tunnel's own
 * resources, read one closed port as a dead tunnel, and blocked every destination behind it while its
 * gateway answered in 95 ms. A guard that cannot be told what a tunnel carries cannot make that mistake.
 */
export interface GuardedTunnel {
  tunnelId: string;
  onUnavailable: 'block' | 'fall-through';
  /**
   * The selector the generator made in front of this tunnel: `wf-guard-<id>` (tunnel, `block`) under
   * `block`, `wf-fall-<id>` (tunnel, the ordinary route) under `fall-through`. Null only for a caller that
   * built a guard by hand without one.
   */
  selector: string | null;
  /**
   * Under `fall-through` only: the selector its resolver is reached through, `wf-fall-dns-<id>`. Whether
   * the running core has one is read back from the core each round — it exists only when the tunnel has a
   * resolver of its own, which the planner, not the profile, decides.
   */
  dnsSelector?: string | null;
  /** How the tunnel's own protocol is asked, from its catalogue entry. */
  method: LivenessMethod;
  /** Why its traffic cannot leave another way while it is down, from its catalogue entry. */
  failsClosed: string;
}

/**
 * The destination tunnels of a document, each with how its own protocol is asked whether it is alive.
 *
 * Every enabled `resource` tunnel, whatever its `onUnavailable`: the owner is told the liveness of each
 * one. What the watchdog *does* with a reading is decided per tunnel in `runGuards`.
 *
 * Reads the tunnel's id, protocol and `onUnavailable`, and the interfaces its last plan recorded — and
 * nothing else. `resources`, `dns` and `config` are never read here.
 */
export function guardedTunnels(
  document: ProfileDocument | null,
  readings: { interfaces: Map<string, string[]> },
): GuardedTunnel[] {
  return (document?.tunnels ?? [])
    .filter((tunnel) => tunnel.enabled && tunnel.role === 'resource')
    .map((tunnel) => {
      const subject = { tunnelId: tunnel.id, interfaces: readings.interfaces.get(tunnel.id) };
      const entry = CATALOGUE[tunnel.protocol] as CatalogueEntry | undefined;
      return {
        tunnelId: tunnel.id,
        onUnavailable: tunnel.onUnavailable,
        selector: tunnel.onUnavailable === 'block' ? guardSelectorTag(tunnel.id) : fallThroughSelectorTag(tunnel.id),
        dnsSelector: tunnel.onUnavailable === 'block' ? null : fallThroughDnsSelectorTag(tunnel.id),
        method:
          entry === undefined
            ? { kind: 'none', why: `"${String(tunnel.protocol)}" is not in this build's catalogue` }
            : entry.liveness(subject),
        failsClosed: entry === undefined ? 'nothing is known about its outbound' : entry.failsClosed(subject),
      };
    });
}

/**
 * The guards as the daemon reads them each round: the active document and the interfaces the last plan
 * recorded. Built here so a test reads them through the same function.
 */
export function deviceGuards(readers: {
  document: () => ProfileDocument | null;
  tunnelUnits: () => { id: string; interfaces?: string[] }[] | null;
}): () => Promise<GuardedTunnel[]> {
  return async () => {
    const interfaces = new Map<string, string[]>();
    for (const entry of readers.tunnelUnits() ?? []) {
      if (entry.interfaces !== undefined) interfaces.set(entry.id, entry.interfaces);
    }
    return guardedTunnels(readers.document(), { interfaces });
  };
}

export interface GuardOutcome {
  tunnelId: string;
  /** The selector in front of the tunnel — see `GuardedTunnel.selector`. */
  selector: string | null;
  onUnavailable: 'block' | 'fall-through';
  /** Alive, dead or not measurable, what it rests on, and the reading in words. */
  liveness: Liveness;
  /**
   * Consecutive rounds this tunnel has read dead. Reset by an alive round, and **left alone by an
   * unmeasurable one** — the same rule the failover streaks follow, for the same reason.
   */
  streak: number;
  /** What the watchdog did about this reading, in a sentence — including that it did nothing, and why. */
  action: string;
  /** Whether the watchdog moved this tunnel's selector this round. */
  changed: boolean;
  /**
   * Whether the selector is on `block` **after** this round, `null` when there is no selector or it
   * could not be read. Under this design nothing the watchdog does puts it there.
   */
  blocked: boolean | null;
  /**
   * Under `fall-through`: whether its traffic is leaving outside the tunnel **after** this round, and for
   * how long, in whole seconds of the monotonic clock since this process first saw it so. Null when it is
   * not (or the selector could not be read); absent under `block`.
   */
  fallingThrough?: { forSeconds: number } | null;
}

export interface RoundOutcome {
  /** Null when the core could not be reached, which is not the same as nothing being healthy. */
  health: TunnelHealth[] | null;
  selected: string | null;
  changed: boolean;
  reason: string;
  guards?: GuardOutcome[];
}

export function createWatchdog(deps: WatchdogDeps): {
  runOnce: () => Promise<RoundOutcome>;
  start: (intervalSeconds: number | (() => number)) => { stop: () => void; nudge: () => void };
} {
  /** Consecutive failing rounds per tunnel. Reset by a healthy round, not decayed. */
  const failStreaks: Record<string, number> = {};
  /** What each tunnel was last seen as, so a transition can be recorded and a steady state cannot. */
  const lastHealthy: Record<string, boolean> = {};
  /** Consecutive dead readings per guarded tunnel, for the owner to read; nothing acts on them. */
  const guardStreaks: Record<string, number> = {};
  /** What each guarded tunnel last read as, so a transition is recorded and a steady state is not. */
  const lastGuardState: Record<string, Liveness['state']> = {};
  /** When each guard's abnormal standing was last written to the ring. See `GUARD_RESTATE_SECONDS`. */
  const guardStatedAt: Record<string, number> = {};
  const clock = (): number => (deps.now ?? ((): number => performance.now()))();
  /** Strictly consecutive dead rounds per fall-through tunnel. See `FALL_THROUGH_DEAD_ROUNDS`. */
  const fallDeadRounds: Record<string, number> = {};
  /** Strictly consecutive alive rounds per fall-through tunnel. See `FALL_THROUGH_ALIVE_ROUNDS`. */
  const fallAliveRounds: Record<string, number> = {};
  /**
   * When this process first saw each tunnel's traffic leaving outside it — by its own move, or by
   * adopting a position it found while the tunnel read dead. Monotonic milliseconds. A selector found on
   * the ordinary route with no entry here was put there by an earlier run or by hand.
   */
  const fellAt: Record<string, number> = {};
  /**
   * Tunnels whose ordinary-route position this process found rather than made, and has not yet seen a
   * dead reading to confirm. One alive reading puts such a position back; see `runFallThrough`.
   */
  const unconfirmed = new Set<string>();

  const select = async (
    guard: GuardedTunnel,
    selector: string,
    from: string | null,
    to: string,
  ): Promise<boolean> => {
    const result = await deps.core.select(selector, to);
    if (!result.ok) {
      deps.record({
        level: 'error',
        kind: 'guard.switch-failed',
        summary: `could not point ${selector} at ${to}: ${result.message}`,
        detail: { tunnel: guard.tunnelId, selector, from, to },
      });
    }
    return result.ok;
  };

  /**
   * A tunnel on `fall-through`: the one place the guard moves traffic, and the only move in the product
   * that sends traffic outside a tunnel the owner put it in (G31).
   *
   * **Out** after `FALL_THROUGH_DEAD_ROUNDS` strictly consecutive dead readings; **back** after
   * `FALL_THROUGH_ALIVE_ROUNDS` strictly consecutive alive ones. A reading that could not be taken moves
   * nothing in either direction and breaks both counts.
   *
   * **Read back, not remembered.** The core keeps a selector's choice in its cache file across its own
   * restarts, and this process forgets everything across its. So the position is read from the core every
   * round and judged against what this process has itself seen:
   *
   * * on the ordinary route, and this process moved it there (or adopted it while the tunnel read dead) —
   *   it stays until the tunnel reads alive for the full count;
   * * on the ordinary route, and this process has **no** dead reading to justify it — left by an earlier
   *   run, or by hand — it is kept while the tunnel cannot be read, confirmed by a dead reading, and put
   *   back on the tunnel at once by an alive one (corrected 2026-09-24 after the board showed a restart
   *   putting a dead tunnel's traffic back into it for ~60 s: see the branch below);
   * * on the tunnel — whatever this process remembered, the traffic is in the tunnel now, and the count
   *   decides afresh.
   *
   * The resolver selector follows the traffic selector's settled position every round, so the two agree
   * even after either was moved by something else.
   */
  const runFallThrough = async (
    guard: GuardedTunnel,
    liveness: Liveness,
    proxies: ProxyEntry[],
    now: number,
  ): Promise<{ action: string; changed: boolean; settled: string | null; fallingThrough: { forSeconds: number } | null }> => {
    const id = guard.tunnelId;
    const dead = (fallDeadRounds[id] = liveness.state === 'dead' ? (fallDeadRounds[id] ?? 0) + 1 : 0);
    const alive = (fallAliveRounds[id] = liveness.state === 'alive' ? (fallAliveRounds[id] ?? 0) + 1 : 0);
    const selector = guard.selector;
    const entry = selector === null ? undefined : proxies.find((candidate) => candidate.name === selector);
    if (selector === null || entry === undefined) {
      delete fellAt[id];
      unconfirmed.delete(id);
      return {
        action:
          `the running core has no ${selector ?? 'fall-through selector'} for it, so nothing can send its ` +
          'traffic another way; until the profile is applied its traffic fails with the tunnel',
        changed: false,
        settled: null,
        fallingThrough: null,
      };
    }
    const current = entry.now ?? null;
    let settled = current;
    let changed = false;
    let action: string;

    if (current !== FALL_THROUGH_ORDINARY) {
      delete fellAt[id];
      unconfirmed.delete(id);
      if (dead >= FALL_THROUGH_DEAD_ROUNDS) {
        if (await select(guard, selector, current, FALL_THROUGH_ORDINARY)) {
          changed = true;
          settled = FALL_THROUGH_ORDINARY;
          fellAt[id] = now;
          action =
            `its traffic now leaves OUTSIDE the tunnel by the ordinary route: it read dead for ${String(dead)} ` +
            `consecutive rounds; it goes back after ${String(FALL_THROUGH_ALIVE_ROUNDS)} consecutive alive rounds`;
          deps.record({
            level: 'warn',
            kind: 'guard.fell-through',
            summary:
              `${id} read dead for ${String(dead)} consecutive rounds, so its traffic and the lookups for its ` +
              `names now leave OUTSIDE the tunnel by the ordinary route (${liveness.why})`,
            detail: { tunnel: id, selector, from: current, to: FALL_THROUGH_ORDINARY, liveness, deadRounds: dead },
          });
        } else {
          action = `it read dead for ${String(dead)} consecutive rounds and its selector could not be moved; its traffic fails with the tunnel`;
        }
      } else if (liveness.state === 'dead') {
        action =
          `dead ${String(dead)} of the ${String(FALL_THROUGH_DEAD_ROUNDS)} consecutive rounds it takes to send its ` +
          'traffic outside the tunnel; until then it fails with the tunnel';
      } else if (liveness.state === 'alive') {
        action = 'nothing: it carries its traffic';
      } else {
        action = 'nothing: a reading that could not be taken never sends traffic outside the tunnel';
      }
    } else if (fellAt[id] === undefined || unconfirmed.has(id)) {
      /*
       * Found on the ordinary route with no dead reading from this process behind it: left by the process
       * before a restart (the core's cache keeps the choice), or by hand.
       *
       * **A reading that could not be taken moves nothing here either.** The first build put such a
       * position back on the tunnel on *alive or not measurable*. Measured on the board, 2026-09-24 (G31
       * acceptance): `systemctl restart wayfarer` with `corp` dead — the first round of a fresh process
       * has no earlier counter sample, reads not measurable, and both selectors went back to `corp`
       * within 5 s; they stayed there, a dead tunnel swallowing its traffic, for ~60 s until two dead rounds
       * sent them out again. Every daemon restart or deploy made that hole.
       *
       * So the position is kept until a confident reading decides it: dead confirms it (it is then an
       * ordinary fall-through, back after the full alive count); **alive** puts it back at once, because a
       * position this process never justified must not keep traffic outside a tunnel that reads alive.
       */
      const first = fellAt[id] === undefined;
      if (first) {
        fellAt[id] = now;
        unconfirmed.add(id);
      }
      if (liveness.state === 'dead') {
        unconfirmed.delete(id);
        action =
          'found sending its traffic OUTSIDE the tunnel, left by an earlier run or by hand; kept, because the ' +
          `tunnel reads dead now; it goes back after ${String(FALL_THROUGH_ALIVE_ROUNDS)} consecutive alive rounds`;
        deps.record({
          level: 'warn',
          kind: 'guard.fell-through',
          summary: `${id}'s traffic was found leaving outside the tunnel and is kept there: the tunnel reads dead (${liveness.why})`,
          detail: { tunnel: id, selector, from: current, to: current, liveness, adopted: true },
        });
      } else if (liveness.state === 'alive') {
        if (await select(guard, selector, current, id)) {
          changed = true;
          settled = id;
          delete fellAt[id];
          unconfirmed.delete(id);
          action =
            'its selector was on the ordinary route with no dead reading from this watchdog behind it (left by an ' +
            'earlier run or by hand), and the tunnel reads alive, so it was put back on the tunnel';
          deps.record({
            level: 'warn',
            kind: 'guard.fall-through-ended',
            summary:
              `${id}'s traffic was leaving outside the tunnel with no dead reading from this watchdog behind it, ` +
              'and has been put back on the tunnel: it reads alive',
            detail: { tunnel: id, selector, from: current, to: id, liveness, inherited: true },
          });
        } else {
          action = 'its selector is on the ordinary route with no dead reading behind it, and could not be put back on the tunnel';
        }
      } else {
        action =
          'found sending its traffic OUTSIDE the tunnel, left by an earlier run or by hand; kept until the tunnel ' +
          'can be read: a reading that could not be taken moves nothing in either direction';
        if (first) {
          deps.record({
            level: 'warn',
            kind: 'guard.fell-through',
            summary: `${id}'s traffic was found leaving outside the tunnel and is kept there until the tunnel can be read (${liveness.why})`,
            detail: { tunnel: id, selector, from: current, to: current, liveness, adopted: true },
          });
        }
      }
    } else if (alive >= FALL_THROUGH_ALIVE_ROUNDS) {
      const since = fellAt[id];
      if (await select(guard, selector, current, id)) {
        changed = true;
        settled = id;
        delete fellAt[id];
        action = `its traffic is back in the tunnel: it read alive for ${String(alive)} consecutive rounds`;
        deps.record({
          level: 'info',
          kind: 'guard.fall-through-ended',
          summary:
            `${id} read alive for ${String(alive)} consecutive rounds, so its traffic is back in the tunnel after ` +
            `${String(Math.round((now - since) / 1000))} s outside it`,
          detail: { tunnel: id, selector, from: current, to: id, liveness, aliveRounds: alive },
        });
      } else {
        action = `it read alive for ${String(alive)} consecutive rounds and could not be put back on the tunnel; its traffic is still leaving outside it`;
      }
    } else {
      action =
        `its traffic is leaving OUTSIDE the tunnel by the ordinary route; it goes back after ` +
        `${String(FALL_THROUGH_ALIVE_ROUNDS)} consecutive alive rounds (${String(alive)} so far` +
        `${liveness.state === 'unmeasurable' ? '; a reading that could not be taken counts for neither' : ''})`;
    }

    /*
     * The resolver follows the traffic. Checked every round rather than only on a move, so a restart of
     * either side, or a hand on one selector, cannot leave names resolved one way and traffic sent another.
     */
    const dnsSelector = guard.dnsSelector ?? null;
    const dnsEntry = dnsSelector === null ? undefined : proxies.find((candidate) => candidate.name === dnsSelector);
    if (dnsSelector !== null && dnsEntry !== undefined && settled !== null) {
      const want = settled === FALL_THROUGH_ORDINARY ? FALL_THROUGH_DNS.outbound : id;
      if ((dnsEntry.now ?? null) !== want) {
        if (await select(guard, dnsSelector, dnsEntry.now ?? null, want)) changed = true;
        else action += '; its resolver selector could not be moved to match';
      }
    }

    const falling = settled === FALL_THROUGH_ORDINARY;
    return {
      action,
      changed,
      settled,
      fallingThrough: falling ? { forSeconds: Math.max(0, Math.floor((now - (fellAt[id] ?? now)) / 1000)) } : null,
    };
  };


  /**
   * Ask every destination tunnel whether it is alive, report it — and, for a tunnel on `block`, move
   * nothing.
   *
   * ## Why a dead tunnel on `block` is not blocked
   *
   * The owner's decision, 2026-09-24, after one closed port on one server blocked every destination
   * behind `partner` while its gateway answered in 95 ms. Every tunnel outbound this build generates
   * already fails closed on its own: an OpenVPN outbound is bound to the tunnel's interface, and a proxy
   * outbound fails the connection when its server is unreachable (`failsClosed` on each catalogue entry
   * says which, and a test holds each sentence to the outbound `plan` produces). So a dead tunnel cannot
   * leak whether or not its selector is moved. Moving it to `block` bought only a faster error — and it
   * turned every false reading into an outage of everything the tunnel carries. The reading stays, loud
   * and red; the switch is gone.
   *
   * ## The one move that is left
   *
   * A selector found on `block` is put back on its tunnel. Nothing in this build puts it there, so it
   * was left by the build before this one — the core keeps a selector's choice in its cache file across
   * restarts — or by hand, and under this design it is an outage nobody would otherwise ever end. This
   * move only ever un-refuses traffic.
   *
   * ## `fall-through`
   *
   * The one tunnel whose selector the guard does move — out to the ordinary route on consecutive dead
   * readings, back on consecutive alive ones. See `runFallThrough`. Until 2026-09-24 (G31) the generator
   * made no selector for it, and a dead fall-through tunnel failed exactly like a `block` one.
   */
  const runGuards = async (proxies: ProxyEntry[]): Promise<GuardOutcome[]> => {
    const guards = await deps.guards();
    if (guards.length === 0) return [];
    const policy = deps.policy();
    const outcomes: GuardOutcome[] = [];
    const now = clock();
    const timeoutMs = Math.max(policy.probes.maxLatencyMs * 4, GUARD_PROBE_TIMEOUT_FLOOR_MS);

    const readings =
      deps.liveness === undefined
        ? new Map<string, Liveness>()
        : await deps.liveness.measureRound(
            guards.map((guard) => ({ tunnelId: guard.tunnelId, method: guard.method })),
            // At most two echoes per round: the gateway echo confirms, it does not decide alone, and four
            // lost echoes at a 4 s timeout on each of three OpenVPN tunnels would outlast the round.
            { echoes: Math.min(2, policy.probes.count), timeoutMs },
          );

    for (const guard of guards) {
      const liveness: Liveness = readings.get(guard.tunnelId) ?? {
        state: 'unmeasurable',
        basis: 'none',
        why: 'this watchdog was given no way to measure a tunnel',
      };

      /*
       * The streak: consecutive dead readings, for the owner to read. Nothing acts on it. Not advanced
       * by an unmeasurable round, which is not evidence either way.
       */
      if (liveness.state === 'alive') guardStreaks[guard.tunnelId] = 0;
      else if (liveness.state === 'dead') guardStreaks[guard.tunnelId] = (guardStreaks[guard.tunnelId] ?? 0) + 1;
      const streak = guardStreaks[guard.tunnelId] ?? 0;

      const entry = guard.selector === null ? undefined : proxies.find((candidate) => candidate.name === guard.selector);
      const current = entry?.now ?? null;

      let changed = false;
      let settled = current;
      let action: string;
      let fallingThrough: { forSeconds: number } | null | undefined;
      if (guard.onUnavailable === 'fall-through') {
        const result = await runFallThrough(guard, liveness, proxies, now);
        action = result.action;
        changed = result.changed;
        settled = result.settled;
        fallingThrough = result.fallingThrough;
      } else if (guard.selector !== null && current === CORE_TAGS.block) {
        const result = await deps.core.select(guard.selector, guard.tunnelId);
        if (result.ok) {
          changed = true;
          settled = guard.tunnelId;
          action =
            `its selector was on block, which nothing in this build does, so it was put back on the tunnel; ` +
            `a dead tunnel is reported, never blocked, because ${guard.failsClosed}`;
          deps.record({
            level: 'warn',
            kind: 'guard.unparked',
            summary: `${guard.tunnelId}'s selector was on block and has been put back on the tunnel: this build never blocks a tunnel`,
            detail: { tunnel: guard.tunnelId, selector: guard.selector, from: current, to: guard.tunnelId, liveness },
          });
        } else {
          action = `its selector is on block and could not be put back on the tunnel: ${result.message}`;
          deps.record({
            level: 'error',
            kind: 'guard.switch-failed',
            summary: `could not point ${guard.selector} back at ${guard.tunnelId}: ${result.message}`,
            detail: { tunnel: guard.tunnelId, from: current, to: guard.tunnelId },
          });
        }
      } else if (liveness.state === 'dead') {
        action = `its traffic is NOT being blocked by the guard: ${guard.failsClosed}`;
      } else {
        action = 'nothing: the guard reports and never blocks';
      }

      /*
       * Recorded on a transition, and a tunnel that is dead the first time it is seen is a transition:
       * the ring is the only record that survives a bad boot.
       */
      const previous = lastGuardState[guard.tunnelId];
      if (liveness.state !== previous && (liveness.state === 'dead' || previous === 'dead')) {
        deps.record({
          level: liveness.state === 'dead' ? 'warn' : 'info',
          kind: liveness.state === 'dead' ? 'guard.dead' : 'guard.alive',
          summary:
            liveness.state === 'dead'
              ? `${guard.tunnelId} reads dead (${liveness.why}); ${action}`
              : `${guard.tunnelId} reads ${liveness.state === 'alive' ? 'alive' : 'not measurable'} again (${liveness.why})`,
          detail: { tunnel: guard.tunnelId, basis: liveness.basis, streak, onUnavailable: guard.onUnavailable },
        });
        guardStatedAt[guard.tunnelId] = now;
      }
      lastGuardState[guard.tunnelId] = liveness.state;

      /*
       * Restate an abnormal standing periodically. See `GUARD_RESTATE_SECONDS`. A dead tunnel and one
       * nothing can be measured about are both states in which the device cannot say that the traffic
       * assigned to a tunnel is being carried.
       */
      const abnormal = liveness.state !== 'alive';
      if (!abnormal) {
        delete guardStatedAt[guard.tunnelId];
      } else {
        const last = guardStatedAt[guard.tunnelId];
        if (last === undefined || now - last >= GUARD_RESTATE_SECONDS * 1000) {
          const forSeconds = last === undefined ? null : Math.round((now - last) / 1000);
          deps.record({
            level: 'warn',
            kind: liveness.state === 'dead' ? 'guard.still-dead' : 'guard.unmeasurable',
            summary:
              liveness.state === 'dead'
                ? `${guard.tunnelId} still reads dead${forSeconds === null ? '' : `, ${String(forSeconds)} s since this was last said`} (${liveness.why}); ${action}`
                : `nothing can be measured about ${guard.tunnelId}: ${liveness.why}`,
            detail: { tunnel: guard.tunnelId, basis: liveness.basis, streak },
          });
          guardStatedAt[guard.tunnelId] = now;
        }
      }

      outcomes.push({
        tunnelId: guard.tunnelId,
        selector: guard.selector,
        onUnavailable: guard.onUnavailable,
        liveness,
        streak,
        action,
        changed,
        blocked: guard.selector === null || settled === null ? null : settled === CORE_TAGS.block,
        ...(fallingThrough === undefined ? {} : { fallingThrough }),
      });
    }

    return outcomes;
  };

  const runOnce = async (): Promise<RoundOutcome> => {
    if (!(await deps.core.available())) {
      /*
       * The core is not answering. **Nothing is decided.**
       *
       * "I cannot measure" is not "everything is broken": acting on it would switch the selector — or fall
       * back to blocking — on the strength of a failed loopback request, which is the one input that says
       * nothing at all about any tunnel. The same three-valued discipline as the confirmation window.
       */
      return { health: null, selected: null, changed: false, reason: 'the core is not answering; nothing was decided' };
    }

    const policy = deps.policy();
    const candidates = await deps.candidates();
    if (candidates.length === 0) {
      /*
       * No failover group — but guarded destination tunnels still have to be judged.
       *
       * This is the shape of a device that tunnels only named destinations and sends everything else
       * direct, which has no `alternative` tunnels at all. Returning here without running the guards would
       * leave every one of them permitting traffic forever, and the block-when-unavailable requirement
       * would be silently inert on exactly the configuration that asks for it.
       */
      const guardsOnly = await runGuards(await deps.core.proxies());
      return {
        health: [],
        selected: null,
        changed: false,
        reason: 'no tunnel to probe',
        ...(guardsOnly.length > 0 ? { guards: guardsOnly } : {}),
      };
    }

    /*
     * Probes are **sequential**, deliberately, and the round is bounded instead.
     *
     * Concurrency is the obvious answer to a round that takes too long and it is the wrong one here: every
     * probe leaves through the same uplink, so probing in parallel inflates the latency and jitter the
     * probes are measuring. With thresholds this tight — 500 ms median, 250 ms mean deviation — the
     * measurement would start failing tunnels because of the measurement. Sequential probes measure one
     * path at a time, which is the only way the numbers mean what they say.
     *
     * The cost is that a slow round can outlast the interval. Rather than let the cadence stretch silently,
     * the round **stops at the interval** and reports which candidates went unmeasured. Those are left
     * `unknown` — absent from `health` entirely — so nothing decides on them, which is the same rule the
     * confirmation window and the core-unavailable branch already follow. A slow round therefore degrades
     * the watchdog's *coverage*, visibly, instead of degrading its *timing*, invisibly.
     */
    const budgetMs = Math.max(1000, policy.probes.intervalSeconds * 1000);
    const startedAt = performance.now();
    const unmeasured: string[] = [];

    const health: TunnelHealth[] = [];
    for (const outbound of candidates) {
      if (performance.now() - startedAt >= budgetMs) {
        unmeasured.push(outbound);
        continue;
      }
      const latencies: number[] = [];
      for (let attempt = 0; attempt < policy.probes.count; attempt += 1) {
        // The endpoints are rotated across the probes of one round, so one endpoint being unreachable
        // costs a fraction of the samples rather than the whole verdict.
        const endpoint = policy.probes.endpoints[attempt % policy.probes.endpoints.length]!;
        const ms = await deps.core.delay(outbound, endpoint, policy.probes.maxLatencyMs * 4);
        if (ms !== null) latencies.push(ms);
      }
      const entry = summarise({ tunnelId: outbound, latenciesMs: latencies, attempted: policy.probes.count }, policy.probes);
      health.push(entry);

      failStreaks[outbound] = entry.healthy ? 0 : (failStreaks[outbound] ?? 0) + 1;

      /*
       * News only — and a tunnel that is broken the **first** time it is seen is news.
       *
       * The first version recorded only a change from a previous observation, which meant the very first
       * round after a start logged nothing whatever it found: a device that booted with a dead tunnel
       * reported it as silently as one where everything was fine, and the ring — the only record that
       * survives a bad boot — held nothing about the thing that was wrong at boot.
       *
       * A first observation of a *healthy* tunnel is still not recorded. That is the expected state, and
       * saying so on every start is how a ring fills with the absence of problems.
       */
      const firstSighting = lastHealthy[outbound] === undefined;
      const changed = !firstSighting && lastHealthy[outbound] !== entry.healthy;
      if (changed || (firstSighting && !entry.healthy)) {
        deps.record({
          level: entry.healthy ? 'info' : 'warn',
          kind: entry.healthy ? 'health.recovered' : 'health.degraded',
          summary: entry.healthy
            ? `${outbound} is answering within its limits again`
            : `${outbound} failed its health check${firstSighting ? ' on the first round after starting' : ''}: ${entry.failed.join('; ')}`,
          detail: { tunnel: outbound, medianMs: entry.medianMs, jitterMs: entry.jitterMs, lossPercent: entry.lossPercent },
        });
      }
      lastHealthy[outbound] = entry.healthy;
    }

    if (unmeasured.length > 0) {
      /*
       * Recorded every round it happens, not only on a transition.
       *
       * Unlike a tunnel's health, this is not a state with a steady value worth suppressing: it says the
       * watchdog did not manage to do its job this round, and a device where that is the *normal* condition
       * is a device whose interval is set too short for its links. Seeing it repeatedly in the ring is the
       * signal, so the repetition is the point.
       */
      deps.record({
        level: 'warn',
        kind: 'health.round-incomplete',
        summary:
          `the health round reached its ${policy.probes.intervalSeconds}s interval before measuring ` +
          `${unmeasured.join(', ')}, so ${unmeasured.length === 1 ? 'it was' : 'they were'} left unknown ` +
          'rather than judged',
        detail: { unmeasured, intervalSeconds: policy.probes.intervalSeconds, measured: health.map((e) => e.tunnelId) },
      });
      /*
       * A streak is not advanced for a tunnel that was not measured.
       *
       * Leaving it alone is what makes "unknown" mean unknown: incrementing would push an unmeasured tunnel
       * towards being switched away from, and clearing would forgive real failures. Neither is evidence.
       */
    }

    // Read back rather than remembered. See the note at the top.
    const proxies = await deps.core.proxies();
    const guardOutcomes = await runGuards(proxies);
    const selector = proxies.find((entry) => entry.name === deps.selector);
    const current = selector?.now ?? null;

    const decision = decideSelection({
      priority: policy.priority,
      excluded: policy.excluded,
      health,
      current,
      sticky: policy.sticky,
      onAllDown: policy.onAllDown,
      failStreaks,
      failStreak: policy.probes.failStreak,
    });

    if (!decision.change) {
      return { health, selected: current, changed: false, reason: decision.reason, guards: guardOutcomes };
    }

    const result = await deps.core.select(deps.selector, decision.select);
    if (!result.ok) {
      deps.record({
        level: 'error',
        kind: 'health.switch-failed',
        summary: `could not point the selector at ${decision.select}: ${result.message}`,
        detail: { from: current, to: decision.select, reason: decision.reason, considered: decision.considered },
      });
      return {
        health,
        selected: current,
        changed: false,
        reason: `the switch failed: ${result.message}`,
        guards: guardOutcomes,
      };
    }

    deps.record({
      level: 'warn',
      kind: 'health.switched',
      summary: `traffic moved from ${current ?? 'nothing'} to ${decision.select}: ${decision.reason}`,
      // Everything the decision saw, so the ring answers "why did it do that" without a re-run.
      detail: { from: current, to: decision.select, reason: decision.reason, considered: decision.considered },
    });
    deps.log('warn', { from: current, to: decision.select }, decision.reason);

    return { health, selected: decision.select, changed: true, reason: decision.reason, guards: guardOutcomes };
  };

  return {
    runOnce,
    /**
     * `intervalSeconds` is a **function**, re-read before every round.
     *
     * The first version took a number once at start-up, while the policy it probes with was read per
     * round — so changing the interval in a profile had no effect until the daemon restarted, and the two
     * halves of one policy disagreed about when they took effect. Reading it per round needs a
     * self-scheduling timeout rather than `setInterval`, which is the only reason this is not one line.
     */
    start(intervalSeconds) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const nextDelayMs = (): number => {
        const seconds = typeof intervalSeconds === 'function' ? intervalSeconds() : intervalSeconds;
        return Math.max(5, Number.isFinite(seconds) ? seconds : 30) * 1000;
      };

      let running = false;
      let again = false;
      const tick = async (): Promise<void> => {
        if (stopped) return;
        running = true;
        deps.onRoundStart?.();
        // A throw here must not stop the loop: a watchdog that dies on one bad round is a device with no
        // failover and no indication that it has none.
        const outcome = await runOnce().catch((error: unknown) => {
          deps.log('error', { detail: String(error) }, 'a health round failed; the watchdog continues');
          return null;
        });
        deps.onRound?.(outcome);
        if (outcome !== null && rounds === 0) {
          /*
           * One line on the first completed round, and never again.
           *
           * Without it a running watchdog and an absent one look identical in the journal, because a
           * steady round deliberately records nothing — and on the bench board that cost an hour of
           * being unable to tell whether the loop was alive. "It is running and here is what it found"
           * is worth exactly one line.
           */
          deps.log(
            'info',
            {
              tunnels: outcome.health?.length ?? null,
              selected: outcome.selected,
              reason: outcome.reason,
            },
            'the health watchdog completed its first round',
          );
        }
        rounds += 1;
        running = false;
        if (stopped) return;
        if (again) {
          // A nudge arrived during this round: its reading may predate what woke it, so look once more.
          again = false;
          timer = setTimeout(() => void tick(), 0);
          return;
        }
        timer = setTimeout(() => void tick(), nextDelayMs());
      };

      let rounds = 0;
      void tick();
      return {
        /**
         * Run a round now rather than at the end of the interval.
         *
         * Called when a tunnel's keepalive changes standing between rounds (`sampleKeepalives`): the
         * sampler knows within five seconds that a peer has gone silent, and waiting up to a whole
         * interval to say so was a third of the detection time measured on the board.
         */
        nudge() {
          if (stopped) return;
          if (running) {
            again = true;
            return;
          }
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void tick(), 0);
        },
        stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
        },
      };
    },
  };
}


/** The words for how a reading was taken, for the panel and the API. */
const BASIS_WORDS: Record<LivenessBasis, string> = {
  keepalive: 'peer keepalive',
  'gateway-echo': 'gateway echo',
  traffic: 'traffic through it',
  'neutral-endpoints': 'neutral endpoints',
  none: 'not measured',
};

/**
 * What one round saw, and whether it is a problem — for the watchdog's observer.
 *
 * Measured on the bench board, 2026-09-23: all four tunnels are `resource` + `block`, so the failover
 * group is empty, and the observer said "0 of 0 tunnel(s) healthy" every round. That was fixed by naming
 * every guard; the next reading was one string, cut at 300 characters, and ended "guard offi…". So the
 * summary names every guard by id and standing only, which stays short however long the notes are, and
 * each guard travels as its own item: how it was measured, what was found, and what was done about it.
 */
export function watchdogReading(outcome: RoundOutcome | null): {
  saw: string;
  items: ObserverItem[];
  problem: string | null;
} {
  if (outcome === null) return { saw: 'the round failed; see the journal', items: [], problem: 'the last health round failed' };
  if (outcome.health === null) {
    return {
      saw: `the core's control interface could not be reached: ${outcome.reason}`,
      items: [],
      problem: `nothing could be measured: ${outcome.reason}`,
    };
  }
  const items: ObserverItem[] = outcome.health.map((entry) => ({
    subject: entry.tunnelId,
    state: entry.healthy ? 'healthy' : 'unhealthy',
    note: `failover member${outcome.selected === entry.tunnelId ? ', selected' : ''}`,
  }));
  const guards = outcome.guards ?? [];
  const standing = (guard: GuardOutcome): string =>
    guard.blocked === true
      ? 'BLOCKED'
      : isFalling(guard)
        ? 'FALLING THROUGH'
        : guard.liveness.state === 'alive'
        ? 'alive'
        : guard.liveness.state === 'dead'
          ? `DEAD ${String(guard.streak)} round(s)`
          : 'not measurable';
  for (const guard of guards) {
    items.push({
      subject: guard.tunnelId,
      state: standing(guard),
      note: guard.liveness.why,
      method: BASIS_WORDS[guard.liveness.basis],
      action: guard.action,
      // Falling through is red whatever the reading says: traffic is leaving outside the tunnel.
      tone:
        guard.blocked === true || isFalling(guard) || guard.liveness.state === 'dead'
          ? 'bad'
          : guard.liveness.state === 'alive'
            ? 'ok'
            : 'warn',
      ...(isFalling(guard) ? { fallingThroughSeconds: guard.fallingThrough!.forSeconds } : {}),
    });
  }
  const failover =
    outcome.health.length > 0
      ? `failover ${String(outcome.health.filter((entry) => entry.healthy).length)} of ${String(outcome.health.length)} healthy, ` +
        `selected ${outcome.selected ?? 'nothing'}`
      : 'no failover group';
  const guardSummary =
    guards.length === 0
      ? 'no guards'
      : `guards: ${guards.map((guard) => `${guard.tunnelId} ${standing(guard)} (${BASIS_WORDS[guard.liveness.basis]})`).join(', ')}`;
  return {
    saw: `${failover}; ${guardSummary}`,
    items,
    problem: guardProblem(
      guards.filter((guard) => guard.blocked === true),
      guards.filter((guard) => guard.blocked !== true && !isFalling(guard) && guard.liveness.state === 'dead'),
      guards.filter((guard) => isFalling(guard)),
    ),
  };
}

function isFalling(guard: GuardOutcome): boolean {
  return guard.fallingThrough !== undefined && guard.fallingThrough !== null;
}

/**
 * A tunnel that reads dead is a problem the moment it is read, whatever the watchdog does about it; a
 * tunnel whose traffic is leaving outside it is one for as long as that lasts, whatever it reads now.
 */
function guardProblem(blocked: GuardOutcome[], dead: GuardOutcome[], falling: GuardOutcome[] = []): string | null {
  const parts: string[] = [];
  if (blocked.length > 0) {
    parts.push(`traffic for ${blocked.map((guard) => guard.tunnelId).join(', ')} is being refused: its selector is on block`);
  }
  if (falling.length > 0) {
    parts.push(
      `traffic for ${falling.map((guard) => `${guard.tunnelId} (${String(guard.fallingThrough!.forSeconds)} s)`).join(', ')} ` +
        'is leaving OUTSIDE the VPN by the ordinary route: the tunnel read dead and is set to fall through',
    );
  }
  if (dead.length > 0) {
    // Names and streaks only: the reading and what was done about it travel in each tunnel's own item,
    // so this stays short however long a reason is.
    const words = dead.every((guard) => guard.onUnavailable === 'block')
      ? 'the guard does not block it, its traffic fails rather than leaving another way'
      : 'its traffic fails with the tunnel until it has read dead long enough to fall through, if it is set to';
    parts.push(
      `${dead.map((guard) => `${guard.tunnelId} (${String(guard.streak)} round(s))`).join(', ')} ` +
        `read${dead.length === 1 ? 's' : ''} dead; ${words}`,
    );
  }
  return parts.length === 0 ? null : parts.join('; ');
}

/**
 * The watchdog's observer, wired the way the daemon wires it — built here so a test builds the same.
 *
 * **A look is recorded when a round starts, not only when it ends.** Measured on the bench board,
 * 2026-09-23: the observer read `stale` once — 51 s without a look against a 30 s interval — while a
 * probe to an unreachable address was running. Rounds are sequential with the interval *between*
 * them, so the gap between two end-of-round looks is the interval plus the round's own duration; a
 * slow round alone pushes that past one and a half intervals. With a look at the start as well, the
 * longest gap is the longer of the interval and one round, and a round is bounded by the probe budget,
 * which is the interval. The alternative — widening the stale threshold by the probe budget — would
 * also have hidden a round that really hangs for that long; this way a round that never ends still
 * goes stale, one and a half intervals after it started.
 */
export function observeWatchdog(
  observer: ObserverHandle,
  now: () => number = () => performance.now(),
): {
  onRoundStart: () => void;
  onRound: (outcome: RoundOutcome | null) => void;
  recorded: (event: { kind: string; summary: string }) => void;
} {
  let last: { saw: string; items: ObserverItem[]; at: number } | null = null;
  return {
    onRoundStart: () => {
      /*
       * The last round's items are shown again under a fresh look, so a duration in them is advanced by
       * the time since that round: otherwise "falling through for 30 s" would be stamped as read now and
       * the panel's "since" would move forward by a round at every round start.
       */
      const elapsed = last === null ? 0 : Math.max(0, Math.floor((now() - last.at) / 1000));
      observer.looked(
        last === null ? 'the first round is probing' : `a round is probing; the last one saw: ${last.saw}`,
        last?.items.map((item) =>
          item.fallingThroughSeconds === undefined ? item : { ...item, fallingThroughSeconds: item.fallingThroughSeconds + elapsed },
        ),
      );
    },
    onRound: (outcome) => {
      const reading = watchdogReading(outcome);
      last = { saw: reading.saw, items: reading.items, at: now() };
      observer.looked(reading.saw, reading.items);
      observer.failing(reading.problem);
    },
    recorded: (event) => observer.acted(`${event.kind}: ${event.summary}`),
  };
}
