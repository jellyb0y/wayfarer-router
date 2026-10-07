/**
 * Keep the core asking the resolver each peer actually pushed — **level-triggered**, not edge-triggered.
 *
 * ## What failed, established from the code (2026-09-23)
 *
 * On the bench board on 2026-09-22 the hq tunnel was switched from an obfuscated transport to
 * plain OpenVPN at 23:03. The apply wrote `/etc/wayfarer/core/config.json` at 23:03:39 naming
 * `10.184.40.5`; the tunnel it had just restarted came up and the up-script wrote `10.184.48.5` to
 * `/run/wayfarer/tunnel/hq.dns` at 23:03:49. Ten hours later the configuration still named
 * `10.184.40.5`. Three separate things let that happen, and each is in this file's predecessor, the
 * closure in `index.ts`:
 *
 * 1. **Every outcome other than success was terminal.** The follower was woken by exactly two
 *    things — a file-system event, and one comparison at start-up — and acted on that wake-up once.
 *    If the attempt was refused because another transaction held its confirmation window
 *    (`applyDocument` answers `confirmation_pending`, and an apply that restarts a tunnel is very
 *    often the apply holding a window), or was throttled because a re-derive had run in the last
 *    minute (the old code said "leaving it for now" and meant *for ever*), or failed, then one line
 *    was written to the event ring and **nothing ever looked again**: not when the window closed,
 *    not a minute later, not ever, until the next capture or the next daemon restart. The capture
 *    changes *during* an apply precisely because the apply restarts the tunnel, so the ordinary case
 *    was the terminal one.
 * 2. **It said so only to the database.** Every line it wrote went to the event ring and none to the
 *    journal, so `journalctl -u wayfarer | grep resolver` finds nothing whether it ran or not.
 * 3. **The generation used a capture from the previous connection.** `hq.dns` is written when a
 *    tunnel comes up and removed by nothing, so at 23:03:39 — with the tunnel being replaced — it
 *    still held what the *previous* connection's peer pushed, and the planner used it. That value is
 *    only ever a guess until the new connection writes its own; what makes a guess harmless is that
 *    the follower corrects it within a minute, which is exactly what (1) prevented.
 *
 * ## What it does instead
 *
 * It compares, on a fixed monotonic cadence as well as on every capture event, **what the peers
 * pushed** with **what the core's configuration on disk names**. While they differ it keeps trying,
 * and every reason it is not acting right now is a stated, recorded state rather than a dropped call:
 *
 * * a transaction is open (an apply in progress, a window counting down, a revert under way) —
 *   *deferred*, retried on the next round, and the transaction is named;
 * * a re-derive ran less than a minute ago — *throttled*, retried when the minute is up;
 * * the last re-derive for this exact divergence failed — *held*, retried after a longer back-off or
 *   as soon as anything in the divergence changes, so a device cannot fail an apply every minute and
 *   walk itself into safe mode on the strength of a resolver.
 *
 * Every change of answer is written to the event ring **and** the journal, and every round is
 * recorded on its observer (`core/observers.ts`), so a follower that is running and has nothing to
 * do is visibly different from one that is not running.
 *
 * ## A second subject, 2026-09-23
 *
 * The same rounds also ask whether every network a peer handed one of our tunnel interfaces is in the
 * core's exclusion list (`FollowerVerification.networks`, read by `core/device-follower.ts`). A tunnel
 * that came up with a network while its resolver stayed the same woke nothing before — see
 * `core/followed-networks.ts` for the incident and for why a network is added promptly and removed lazily.
 *
 * ## Which document it applies
 *
 * The **last applied** document, never the active profile. The active profile can hold a staged edit
 * nobody ordered, and an automatic re-derive that applied it is `docs/13-plan.md` row G3. The start-up
 * path already used the last applied document for that reason; the event path did not, and now there
 * is one path.
 */

import type { ProfileDocument } from '@wayfarer/schemas';
import type { ApplyOutcome } from './apply.ts';
import { describeDivergence, type ResolverDivergence } from './resolver-convergence.ts';
import { resolverReconvergeEvent, type ReconvergeVerification } from '../api/resolver-reconverge.ts';
import type { ObserverHandle } from './observers.ts';
import type { FollowedNetworkReading } from './followed-networks.ts';
import { PATHS } from './desired-state.ts';

export interface FollowerVerification extends ReconvergeVerification {
  captured: Map<string, string>;
  /**
   * The follower's second subject: are the networks the peers handed our tunnel interfaces in the running
   * fence? Absent when the caller does not follow networks (a test of the resolver half alone).
   */
  networks?: FollowedNetworkReading;
}

export interface FollowerEvent {
  level: 'info' | 'warn';
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface ResolverFollowerDeps {
  /** The document this device last ran. See the note above on why not the active profile. */
  document: () => ProfileDocument | null;
  profileId: () => string | null;
  /** Captures against the core configuration **as it is on disk**, read fresh every time. */
  verify: (document: ProfileDocument) => Promise<FollowerVerification>;
  /** An apply narrowed to `hot` and `service`, opened by nobody. */
  apply: (input: { profileId: string; document: ProfileDocument }) => Promise<ApplyOutcome>;
  /** The transaction open right now, if any: applying, awaiting confirmation, or reverting. */
  openTransaction: () => { id: string; state: string } | null;
  record: (event: FollowerEvent) => void;
  log: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string) => void;
  observer: ObserverHandle;
  monotonicMs?: () => number;
  /** How often the comparison runs with nothing prompting it. */
  everyMs?: number;
  /** The least time between two re-derives. */
  minApplyIntervalMs?: number;
  /** How long an identical divergence whose re-derive failed is left before trying again. */
  failedRetryMs?: number;
  /** How long an `applying` or `reverting` transaction is waited for before it is treated as abandoned. */
  abandonedAfterMs?: number;
}

/** What one round concluded. Returned so a test can reach every branch without a timer. */
export type FollowerOutcome =
  | { kind: 'nothing-applied' }
  | { kind: 'converged'; inUse: { tunnelId: string; address: string }[] }
  | { kind: 'deferred'; transaction: string; state: string; divergent: ResolverDivergence[]; missing?: MissingNetwork[] }
  | { kind: 'throttled'; retryInMs: number; divergent: ResolverDivergence[]; missing?: MissingNetwork[] }
  | { kind: 'held'; retryInMs: number; divergent: ResolverDivergence[]; missing?: MissingNetwork[] }
  | { kind: 'attempted'; event: FollowerEvent; divergent: ResolverDivergence[]; missing?: MissingNetwork[]; events?: FollowerEvent[] };

export type MissingNetwork = FollowedNetworkReading['missing'][number];

function describeMissing(missing: MissingNetwork[]): string {
  return missing.map((entry) => `${entry.network} on ${entry.interface} is not in the core's exclusion list`).join('; ');
}

/** What the fence half saw, for a look: in both directions, so a follower that agrees is visibly looking. */
function networkSaw(networks: FollowedNetworkReading | undefined): string | null {
  if (networks === undefined) return null;
  if (!networks.readable) return `${PATHS.coreConfig} could not be read, so whether the fence holds the tunnel networks is not known`;
  const held =
    networks.followed.length === 0
      ? 'no tunnel interface holds a network right now'
      : `every tunnel network is in the fence: ${networks.followed.map((entry) => `${entry.interface} ${entry.network}`).join(', ')}`;
  return networks.retained.length === 0 ? held : `${held}; kept while absent: ${networks.retained.join(', ')}`;
}

/**
 * The fence half's verdict after an attempt, read back from the file — the same discipline as
 * `resolverReconvergeEvent`: nothing refused is not the same as the network being there.
 */
export function fenceFollowEvent(outcome: ApplyOutcome, before: MissingNetwork[], after: FollowedNetworkReading | undefined): FollowerEvent {
  const transaction = outcome.transaction?.id ?? null;
  const wanted = before.map((entry) => `${entry.network} (${entry.interface})`).join(', ');
  // Refused before a transaction existed: everything the plan needed was of a class the follower may
  // not apply (`applyDocument`, `nothing_permitted`). A refusal, said as one — not a failure.
  if (!outcome.ok && outcome.error?.code === 'nothing_permitted') {
    const refused = (outcome.error.detail as { refused?: { what: string; blastRadius: string }[] } | undefined)?.refused ?? [];
    return {
      level: 'warn',
      kind: 'fence.follow-refused',
      summary:
        `a tunnel network appeared (${wanted}), but everything re-deriving needed is of a class the follower ` +
        "does not apply (it applies only 'hot' and 'service'), so nothing was changed and no transaction was " +
        `opened: ${refused.map((entry) => `${entry.what} (${entry.blastRadius})`).join('; ')}`,
      detail: { transaction: null, refused },
    };
  }
  if (!outcome.ok) {
    return {
      level: 'warn',
      kind: 'fence.follow-failed',
      summary: `a tunnel network appeared (${wanted}) and re-deriving the core configuration failed: ${outcome.error?.message ?? 'no reason was reported'}`,
      detail: { transaction, error: outcome.error ?? null },
    };
  }
  const refused = outcome.result?.refused ?? [];
  if (refused.some((entry) => entry.what.includes(PATHS.coreConfig))) {
    return {
      level: 'warn',
      kind: 'fence.follow-refused',
      summary:
        `a tunnel network appeared (${wanted}), but ${PATHS.coreConfig} was refused — the follower applies only ` +
        "the 'hot' and 'service' classes — so it is NOT in the fence: " +
        refused.map((entry) => `${entry.what} (${entry.blastRadius})`).join('; '),
      detail: { transaction, refused },
    };
  }
  const still = after === undefined || !after.readable ? before : after.missing;
  if (still.length > 0) {
    return {
      level: 'warn',
      kind: 'fence.follow-unverified',
      summary: `a tunnel network appeared and re-deriving refused nothing, but ${PATHS.coreConfig} still does not exclude it: ${describeMissing(still)}`,
      detail: { transaction, missing: still },
    };
  }
  return {
    level: 'info',
    kind: 'fence.followed',
    summary: `the core's exclusion list now holds the tunnel network(s) that appeared: ${wanted}`,
    detail: { transaction, state: outcome.transaction?.state ?? null, blastRadius: outcome.transaction?.blastRadius ?? null, added: before },
  };
}

/**
 * Sixty seconds. The fastest this device's own peers move it — measured on the bench board on
 * 2026-09-21, six reconnections in forty minutes — is about seven minutes apart, so a minute keeps a
 * wrong resolver from outliving a reconnection by more than a minute, and costs one file read and one
 * directory listing per round.
 */
export const RESOLVER_FOLLOW_INTERVAL_MS = 60_000;

export interface ResolverFollower {
  /** One comparison, and an attempt if one is due. Never throws. Overlapping calls share one round. */
  check(reason: string): Promise<FollowerOutcome>;
  start(): void;
  stop(): void;
}

export function createResolverFollower(deps: ResolverFollowerDeps): ResolverFollower {
  const monotonic = deps.monotonicMs ?? ((): number => performance.now());
  const everyMs = deps.everyMs ?? RESOLVER_FOLLOW_INTERVAL_MS;
  const minApplyIntervalMs = deps.minApplyIntervalMs ?? 60_000;
  const failedRetryMs = deps.failedRetryMs ?? 15 * 60_000;
  const abandonedAfterMs = deps.abandonedAfterMs ?? 10 * 60_000;

  let lastApplyAtMs: number | null = null;
  let lastFailure: { signature: string; atMs: number } | null = null;
  /** The last thing said, so a steady state is said once and a change of answer every time. */
  let lastAnnounced: string | null = null;
  /** When each open transaction was first seen blocking, so one left behind by a crash does not block for ever. */
  const blockingSince = new Map<string, number>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<FollowerOutcome> | null = null;
  let again: string | null = null;

  const announce = (key: string, event: FollowerEvent): void => {
    if (key === lastAnnounced) return;
    deps.record(event);
    deps.log(event.level, { kind: event.kind, ...event.detail }, event.summary);
    // After the write, not before: an event that failed to be written must be tried again next round.
    lastAnnounced = key;
  };

  const scheduleRetry = (delayMs: number): void => {
    if (retry !== null || interval === null) return;
    retry = setTimeout(() => {
      retry = null;
      void check('retry');
    }, Math.max(1000, delayMs));
    retry.unref?.();
  };

  const round = async (reason: string): Promise<FollowerOutcome> => {
    const document = deps.document();
    const profileId = deps.profileId();
    if (document === null || profileId === null) {
      deps.observer.looked('nothing has been applied on this device, so there is no configuration to compare');
      announce('nothing-applied', {
        level: 'info',
        kind: 'resolver.convergence-checked',
        summary: 'nothing has been applied on this device yet, so there is no configuration to compare',
        detail: { reason },
      });
      return { kind: 'nothing-applied' };
    }

    const verification = await deps.verify(document);
    const { divergent } = verification;
    const missing = verification.networks?.missing ?? [];

    if (divergent.length === 0 && missing.length === 0) {
      const resolverSaw =
        verification.captured.size === 0
          ? 'no resolver has been captured from a peer yet; nothing to converge on'
          : verification.inUse.length === 0
            ? 'no enabled tunnel takes its resolver from its peer, so nothing captured is in use'
            : 'every captured resolver is the one the core is configured with: ' +
              verification.inUse.map((entry) => `${entry.tunnelId} -> ${entry.address}`).join('; ');
      const fenceSaw = networkSaw(verification.networks);
      const saw = fenceSaw === null ? resolverSaw : `${resolverSaw}; ${fenceSaw}`;
      deps.observer.looked(saw);
      lastFailure = null;
      blockingSince.clear();
      announce(`converged:${JSON.stringify(verification.inUse)}:${JSON.stringify(verification.networks?.followed ?? null)}`, {
        level: 'info',
        kind: 'resolver.convergence-checked',
        summary: saw,
        detail: {
          reason,
          readable: verification.readable,
          inUse: verification.inUse,
          captured: [...verification.captured.entries()].map(([tunnelId, address]) => ({ tunnelId, address })),
          ...(verification.networks === undefined
            ? {}
            : { followedNetworks: verification.networks.followed, retainedNetworks: verification.networks.retained }),
        },
      });
      return { kind: 'converged', inUse: verification.inUse };
    }

    // Which subject woke it decides the words and the event kinds. A network missing from the fence is
    // the fence's; a resolver alone is the resolver's, exactly as before this follower had two subjects.
    const subject = missing.length > 0 ? 'fence' : 'resolver';
    const described = [
      divergent.length === 0 ? null : describeDivergence(divergent),
      missing.length === 0 ? null : describeMissing(missing),
    ]
      .filter((part): part is string => part !== null)
      .join('; ');
    const signature = JSON.stringify([
      divergent.map((entry) => [entry.tunnelId, entry.captured, entry.inCore]),
      missing.map((entry) => [entry.interface, entry.network]),
    ]);
    const extra = missing.length === 0 ? {} : { missing };
    deps.observer.looked(`not converged: ${described}`);
    const now = monotonic();

    const open = deps.openTransaction();
    if (open !== null) {
      const since = blockingSince.get(open.id) ?? now;
      blockingSince.set(open.id, since);
      // A window counting down is always waited for: the apply would refuse anyway, and it must.
      // Anything else that has been "in progress" for ten minutes is a row a crash left behind.
      const abandoned = open.state !== 'awaiting-confirm' && now - since > abandonedAfterMs;
      if (!abandoned) {
        announce(`deferred:${signature}:${open.id}`, {
          level: 'warn',
          kind: subject === 'fence' ? 'fence.follow-deferred' : 'resolver.reconverge-deferred',
          summary:
            (subject === 'fence'
              ? `a tunnel network is not in the core's exclusion list (${described}); `
              : `a resolver captured from a peer is not the one the core is configured with (${described}); `) +
            `transaction ${open.id} is ${open.state}, so re-deriving waits for it and is retried every ` +
            `${Math.round(everyMs / 1000)}s until it can run`,
          detail: { reason, transaction: open.id, state: open.state, divergent, ...extra },
        });
        return { kind: 'deferred', transaction: open.id, state: open.state, divergent, ...extra };
      }
    }

    if (lastFailure !== null && lastFailure.signature === signature && now - lastFailure.atMs < failedRetryMs) {
      const retryInMs = failedRetryMs - (now - lastFailure.atMs);
      announce(`held:${signature}`, {
        level: 'warn',
        kind: subject === 'fence' ? 'fence.follow-held' : 'resolver.reconverge-held',
        summary:
          (subject === 'fence'
            ? `a tunnel network is still not in the core's exclusion list (${described})`
            : `the captured resolver is still not in use (${described})`) +
          ` and the last re-derive for exactly this failed; trying again in ${Math.round(retryInMs / 1000)}s, ` +
          'or at once if anything changes',
        detail: { reason, divergent, retryInMs, ...extra },
      });
      return { kind: 'held', retryInMs, divergent, ...extra };
    }

    /*
     * The rate limit on this follower's restarts. An attempt restarts `wf-core` whenever the core's
     * configuration changes, and that interrupts every connection through the core. Two things bound it:
     * this spacing — at most one re-derive per `minApplyIntervalMs`, whatever woke it and however often —
     * and, for networks, that a network the fence already holds is never a divergence again: it is
     * retained while its tunnel is down (`core/followed-networks.ts`). A tunnel that flaps with one
     * network costs one restart in all; one that alternates between k networks costs k.
     */
    if (lastApplyAtMs !== null && now - lastApplyAtMs < minApplyIntervalMs) {
      const retryInMs = minApplyIntervalMs - (now - lastApplyAtMs);
      announce(`throttled:${signature}`, {
        level: 'info',
        kind: subject === 'fence' ? 'fence.follow-throttled' : 'resolver.change-throttled',
        summary:
          `${subject === 'fence' ? 'a tunnel network appeared' : 'a peer pushed a different resolver'} again ` +
          `${Math.round((now - lastApplyAtMs) / 1000)}s after the last re-derive; re-deriving again in ` +
          `${Math.round(retryInMs / 1000)}s (${described})`,
        detail: { reason, divergent, retryInMs, intervalMs: minApplyIntervalMs, ...extra },
      });
      scheduleRetry(retryInMs);
      return { kind: 'throttled', retryInMs, divergent, ...extra };
    }

    lastApplyAtMs = now;
    const events: FollowerEvent[] = [];
    let after: FollowerVerification | null = null;
    try {
      const outcome = await deps.apply({ profileId, document });
      // Read back from disk after the apply: an apply that refused nothing and wrote nothing looks
      // exactly like one that worked when only its outcome is consulted.
      after = await deps.verify(document);
      if (divergent.length > 0) events.push(resolverReconvergeEvent(outcome, after));
      if (missing.length > 0) events.push(fenceFollowEvent(outcome, missing, after.networks));
    } catch (error) {
      events.push({
        level: 'warn',
        kind: subject === 'fence' ? 'fence.follow-failed' : 'resolver.reconverge-failed',
        summary:
          subject === 'fence'
            ? `could not re-derive after a tunnel network appeared (${described}): ${String(error)}`
            : `could not re-derive after a peer pushed a different resolver: ${String(error)}`,
        detail: {},
      });
    }
    for (const [index, raw] of events.entries()) {
      const event: FollowerEvent = { ...raw, detail: { ...raw.detail, reason, before: divergent, ...extra } };
      events[index] = event;
      // Always recorded: an attempt is an act, and every act is said, whether or not it matches the last.
      deps.record(event);
      deps.log(event.level, { kind: event.kind, reason, transaction: event.detail['transaction'] ?? null }, event.summary);
      deps.observer.acted(`${event.kind}: ${event.summary}`);
    }
    /*
     * And a look **after** the act, of what the device now is. With only the look taken before acting,
     * the observer went on describing the moment before the change until the next round — measured on
     * the bench board, 2026-09-23, for 84 s after the follower had fixed hq's resolver
     * (`docs/13-plan.md` G14).
     */
    if (after !== null) {
      const remaining = [
        after.divergent.length === 0 ? null : describeDivergence(after.divergent),
        (after.networks?.missing.length ?? 0) === 0 ? null : describeMissing(after.networks?.missing ?? []),
      ]
        .filter((part): part is string => part !== null)
        .join('; ');
      const fenceNow = networkSaw(after.networks);
      deps.observer.looked(
        remaining === ''
          ? `after re-deriving: converged${fenceNow === null ? '' : `; ${fenceNow}`}`
          : `after re-deriving, still not converged: ${remaining}`,
      );
    }

    const succeeded =
      events.length > 0 && events.every((event) => event.kind === 'resolver.reconverged' || event.kind === 'fence.followed');
    if (succeeded) {
      lastFailure = null;
      lastAnnounced = null;
    } else {
      lastFailure = { signature, atMs: now };
      lastAnnounced = `attempted:${signature}`;
    }
    return { kind: 'attempted', event: events[0]!, events, divergent, ...extra };
  };

  const check = async (reason: string): Promise<FollowerOutcome> => {
    // One round at a time. Two overlapping rounds could each start a re-derive, and the second would
    // be an apply opened against a transaction the first had just created.
    if (inFlight !== null) {
      again = reason;
      return await inFlight;
    }
    inFlight = (async () => {
      try {
        return await round(reason);
      } catch (error) {
        // A round that throws is a round that did not look, and it says so rather than going quiet.
        deps.log('error', { reason, error: String(error) }, 'the resolver follower could not complete a round');
        deps.observer.looked(`could not complete a round: ${String(error)}`);
        return { kind: 'nothing-applied' } as FollowerOutcome;
      }
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
      if (again !== null) {
        const next = again;
        again = null;
        void check(next);
      }
    }
  };

  return {
    check,
    start() {
      if (interval !== null) return;
      // `setInterval` counts on a monotonic clock, and this board's wall clock can step by days.
      interval = setInterval(() => void check('periodic'), everyMs);
      interval.unref?.();
      deps.observer.armed();
    },
    stop() {
      if (interval !== null) clearInterval(interval);
      if (retry !== null) clearTimeout(retry);
      interval = null;
      retry = null;
      deps.observer.notRunning('stopped');
    },
  };
}
