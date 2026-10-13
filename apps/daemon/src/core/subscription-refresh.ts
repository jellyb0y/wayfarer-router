/**
 * Refreshing the active profile's subscriptions on their own schedule.
 *
 * ## The symptom it exists for
 *
 * Measured on the bench board, 2026-10-13: neither subscription of the active profile had a
 * `lastRefresh` — `refreshHours` was 24 and 12, and nothing in the daemon read it. `refreshSubscription`
 * existed and was called by its tests alone. Fetched by hand the same evening, the `cryptocat` feed no
 * longer offered `82.22.50.101:8080`, the node the profile's `france` tunnel was built from, and offered
 * `82.21.117.116:8080` instead; the device had no way to know.
 *
 * ## What a round does, and what it refuses to do
 *
 * The rules of the edit itself are `core/subscriptions.ts`'s; this file decides **when** and **whether
 * it lands**. Each refusal below exists because the edit happens with nobody watching.
 *
 * * **Nothing without a trusted clock.** "Due" is a wall-clock comparison against `lastRefresh.at`, and
 *   this board has no RTC battery: after a power cut its clock resumes days behind until NTP answers. A
 *   refresh stamped then would be stamped with a wrong time, and the next due date with it.
 * * **A feed that fails, or offers nothing this device can run, changes no tunnel.** Only `lastRefresh`
 *   records it. An empty answer is what a provider's outage looks like, and treating it as "the feed has
 *   no nodes now" would delete every derived tunnel nothing names.
 * * **New nodes arrive disabled** — unless a tunnel in use lost its node in the same refresh, in which
 *   case that tunnel moves to the new node (rule 2 in `core/subscriptions.ts`). A node nothing needs does
 *   not start running because a feed grew; it appears in the profile, off.
 * * **Only `hot` and `service` changes are applied** (`refreshMayApply`), and with the caller's classes
 *   narrowed, so no confirmation window is ever opened by a timer. A refresh that needs more is not
 *   stored at all: the event names what it would have changed.
 * * **Not on top of edits that are not applied yet.** Applying the active profile applies all of it, and
 *   a refresh must not be the thing that puts somebody's half-finished edit on the device.
 * * **Not while a transaction is open**, and not if the profile was edited while the round was planning:
 *   the round ends without stamping, so the subscription is still due and the next round tries again.
 * * **A refresh that stored a change and then failed to apply puts the previous document back**, so the
 *   stored profile is again what the device runs and the next round is not blocked by its own leftover.
 */

import { nodeIdentity, nodeName, parseSubscription, type ParsedNode } from '@wayfarer/protocols';
import type { ProfileDocument, Tunnel } from '@wayfarer/schemas';
import type { FetchTextResult } from '../platform/http.ts';
import type { ProfileStore } from '../state/profiles.ts';
import type { Store } from '../state/store.ts';
import { applyDocument, type ApplyDeps, type ApplyOutcome } from './apply.ts';
import { secretText } from './catalogue/values.ts';
import type { ObserverRegistry } from './observers.ts';
import { planDocument, type PlannedDocument } from './pipeline.ts';
import { refreshMayApply, refreshSubscription, type RefreshOutcome } from './subscriptions.ts';

/** How often the round asks what is due. A refresh itself happens no more than `refreshHours` allows. */
export const SUBSCRIPTION_CHECK_MS = 10 * 60_000;
/**
 * After a failed fetch, the next attempt is due this much later rather than after the full
 * `refreshHours`: a feed that was down for a minute should not leave the device a day behind.
 */
export const SUBSCRIPTION_RETRY_MS = 60 * 60_000;
/** `lastRefresh.detail`'s schema limit. */
const DETAIL_MAX = 200;

type Subscription = NonNullable<ProfileDocument['subscriptions']>[number];
type LastRefresh = { at: string; ok: boolean; detail: string; nodeCount: number };
type RecordEvent = (event: { level: 'info' | 'warn' | 'error'; kind: string; summary: string; detail?: unknown }) => void;

export interface SubscriptionRefresher {
  /** Look now, outside the cadence. Returns when the round is done. */
  check(): Promise<void>;
  stop(): void;
}

/**
 * Whether a subscription is due, and why not when it is not.
 *
 * `null` means due. A failed last attempt is due again after {@link SUBSCRIPTION_RETRY_MS} or the full
 * interval, whichever is shorter. A stamp in the future is read as due: it can only have been written
 * under a clock that was wrong, and waiting for that instant could mean waiting days.
 */
export function notDueReason(subscription: Subscription, nowMs: number): string | null {
  if (!subscription.enabled) return 'disabled';
  if (subscription.refreshHours === 0) return 'refreshed only on request';
  const last = subscription.lastRefresh;
  if (last === undefined) return null;
  const at = Date.parse(last.at);
  if (Number.isNaN(at) || at > nowMs) return null;
  const interval = subscription.refreshHours * 3_600_000;
  const wait = last.ok ? interval : Math.min(interval, SUBSCRIPTION_RETRY_MS);
  const remaining = at + wait - nowMs;
  return remaining > 0 ? `next in ${String(Math.ceil(remaining / 60_000))} min` : null;
}

/**
 * A parsed node as a tunnel.
 *
 * An existing tunnel keeps everything a person decided — id, name, role, what it carries, whether it is
 * on — and takes its configuration from the feed. The configuration is the feed's: a person's edit to a
 * derived tunnel's configuration does not survive a refresh, and that is the price of a refresh being
 * able to deliver a changed credential at all (see `VlessConfig` in `@wayfarer/schemas`).
 */
export function tunnelFromNode(node: ParsedNode, existing: Tunnel | undefined, subscriptionId: string, taken: Set<string>): Tunnel {
  if (existing !== undefined) return { ...existing, protocol: node.protocol, config: node.config } as Tunnel;
  let n = 1;
  while (taken.has(`${subscriptionId}-${String(n)}`.slice(0, 63))) n += 1;
  const id = `${subscriptionId}-${String(n)}`.slice(0, 63);
  taken.add(id);
  return {
    id,
    name: nodeName(node).slice(0, 64),
    role: 'alternative',
    onUnavailable: 'block',
    enabled: false,
    protocol: node.protocol,
    config: node.config,
  } as Tunnel;
}

/**
 * The document with every `lastRefresh` removed, keys sorted: what "the same configuration" is compared
 * on. Sorted because the applied copy and the stored one are written by different statements and
 * nothing promises they keep one key order.
 */
function withoutObservations(document: unknown): string {
  const doc = document as { subscriptions?: Record<string, unknown>[] } | null;
  if (doc === null) return 'null';
  return JSON.stringify(sorted({
    ...doc,
    subscriptions: (doc.subscriptions ?? []).map(({ lastRefresh: _ignored, ...rest }) => rest),
  }));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sorted(record[key])]));
}

function clip(text: string): string {
  return text.length <= DETAIL_MAX ? text : `${text.slice(0, DETAIL_MAX - 1)}…`;
}

function describeChange(outcome: RefreshOutcome): string {
  const parts: string[] = [];
  if (outcome.added.length > 0) parts.push(`added ${outcome.added.join(', ')} (disabled)`);
  if (outcome.updated.length > 0) parts.push(`updated ${outcome.updated.join(', ')}`);
  if (outcome.removed.length > 0) parts.push(`removed ${outcome.removed.join(', ')}`);
  for (const move of outcome.repointed) parts.push(`${move.id} moved from ${move.from} to ${move.to}`);
  if (outcome.keptBecauseReferenced.length > 0) parts.push(`no longer offered but still in use: ${outcome.keptBecauseReferenced.join(', ')}`);
  return parts.join('; ');
}

export function refreshSubscriptions(input: {
  store: Store;
  profiles: ProfileStore;
  applyDeps: ApplyDeps;
  observers: ObserverRegistry;
  fetchText: (url: string) => Promise<FetchTextResult>;
  clockSynchronized: () => Promise<boolean | null>;
  record: RecordEvent;
  checkMs?: number;
  now?: () => Date;
  /** For a test that is about the refresh's decisions rather than the planner; production passes neither. */
  plan?: (document: ProfileDocument) => Promise<PlannedDocument>;
  apply?: (profileId: string, document: ProfileDocument) => Promise<ApplyOutcome>;
}): SubscriptionRefresher {
  const { store, profiles } = input;
  const checkMs = input.checkMs ?? SUBSCRIPTION_CHECK_MS;
  const now = input.now ?? ((): Date => new Date());
  const plan = input.plan ?? (async (document: ProfileDocument) => await planDocument(input.applyDeps.pipeline, document));
  const apply =
    input.apply ??
    (async (profileId: string, document: ProfileDocument) =>
      await applyDocument(input.applyDeps, {
        profileId,
        document,
        // Never a class that opens a confirmation window: there is nobody to confirm it.
        classes: ['hot', 'service'],
        openedBy: null,
      }));
  const observer = input.observers.register({
    name: 'subscription-refresh',
    watches: "whether each of the active profile's subscriptions is refreshed as often as its refreshHours says",
    everyMs: checkMs,
  });

  const openTransaction = (): boolean =>
    profiles.recentTransactions(10).some((row) => row.state === 'applying' || row.state === 'awaiting-confirm' || row.state === 'reverting');

  /** One subscription. Returns what the observer should say about it. */
  const refreshOne = async (profileId: string, subscription: Subscription): Promise<string> => {
    const fetched = await input.fetchText(secretText(subscription.url));
    const at = now().toISOString();
    const stamp = (lastRefresh: LastRefresh): void => {
      profiles.recordSubscriptionRefresh(profileId, subscription.id, { ...lastRefresh, detail: clip(lastRefresh.detail) });
    };

    if (!fetched.ok) {
      stamp({ at, ok: false, detail: fetched.reason, nodeCount: 0 });
      input.record({
        level: 'warn',
        kind: 'subscription.fetch-failed',
        summary: `subscription "${subscription.name}" could not be fetched: ${fetched.reason}; no tunnel was changed`,
        detail: { subscription: subscription.id, reason: fetched.reason },
      });
      return `${subscription.id}: fetch failed (${fetched.reason})`;
    }

    const parsed = parseSubscription(fetched.text);
    const refusedLines = parsed.failures.map((failure) => `line ${String(failure.line)} ${failure.scheme}: ${failure.reason}`);
    if (parsed.nodes.length === 0) {
      const reason = `the feed offered no node this device can run (${String(parsed.failures.length)} line(s) refused)`;
      stamp({ at, ok: false, detail: reason, nodeCount: 0 });
      input.record({
        level: 'warn',
        kind: 'subscription.fetch-failed',
        summary: `subscription "${subscription.name}": ${reason}; no tunnel was changed`,
        detail: { subscription: subscription.id, refused: refusedLines },
      });
      return `${subscription.id}: empty feed`;
    }

    /*
     * Read the profile again **after** the fetch and compute from that, with no wait in between: the
     * fetch took seconds, and a document read before it may be one a person has since replaced.
     */
    const row = profiles.get(profileId);
    if (row === null) return `${subscription.id}: the profile went away during the fetch`;
    const document = row.document as ProfileDocument;
    const taken = new Set(document.tunnels.map((tunnel) => tunnel.id));
    const outcome = refreshSubscription({
      document,
      subscriptionId: subscription.id,
      nodes: parsed.nodes,
      toTunnel: (node, existing) => tunnelFromNode(node, existing, subscription.id, taken),
    });
    const changed = outcome.added.length + outcome.updated.length + outcome.removed.length + outcome.repointed.length > 0;
    const offered = `${String(parsed.nodes.length)} node(s) offered`;
    const kept = outcome.keptBecauseReferenced;

    if (kept.length > 0) {
      input.record({
        level: 'warn',
        kind: 'subscription.node-withdrawn',
        summary:
          `subscription "${subscription.name}" no longer offers the node behind ${kept.join(', ')}, and ` +
          'has no free node to move it to; the old definition is kept because the policy or a rule names it',
        detail: { subscription: subscription.id, kept, notes: outcome.notes },
      });
    }

    if (!changed) {
      stamp({ at, ok: true, detail: kept.length > 0 ? `${offered}; no longer offered but still in use: ${kept.join(', ')}` : `${offered}; nothing changed`, nodeCount: parsed.nodes.length });
      return `${subscription.id}: ${offered}, nothing changed`;
    }

    const change = describeChange(outcome);
    const refuse = (why: string, level: 'warn' | 'error', detail: Record<string, unknown> = {}): string => {
      // `ok: false`: the device is not running what the feed says, so the next attempt is due in an hour
      // rather than a day. A hold is usually transient — an edit about to be applied, an open window.
      stamp({ at, ok: false, detail: `${offered}; not applied: ${why}`, nodeCount: parsed.nodes.length });
      input.record({
        level,
        kind: 'subscription.refresh-held',
        summary: `subscription "${subscription.name}" has changes that were not applied (${change}): ${why}`,
        detail: { subscription: subscription.id, added: outcome.added, updated: outcome.updated, removed: outcome.removed, ...detail },
      });
      return `${subscription.id}: changes held (${why})`;
    };

    if (withoutObservations(document) !== withoutObservations(profiles.lastAppliedDocument())) {
      return refuse('the active profile has edits that are not applied yet, and applying the refresh would apply them too', 'warn');
    }

    const revision = profiles.profileRevision(profileId);
    const planned = await plan(outcome.document);
    if (!planned.plan.usable) {
      const first = planned.plan.findings.find((finding) => finding.severity === 'error');
      return refuse(`the refreshed profile does not plan: ${first?.message ?? 'unknown error'}`, 'error');
    }
    if (!refreshMayApply(planned.classified.blastRadius)) {
      return refuse(`it needs a ${planned.classified.blastRadius} change, which waits for a person`, 'warn', {
        blastRadius: planned.classified.blastRadius,
        humanDiff: planned.classified.humanDiff,
      });
    }
    if (profiles.profileRevision(profileId) !== revision || openTransaction()) {
      // Not stamped: still due, so the next round recomputes against whatever is there now.
      return `${subscription.id}: the profile changed while planning; retried next round`;
    }

    const before = row.document;
    profiles.replace(profileId, outcome.document);
    const applied = await apply(profileId, profiles.get(profileId)!.document as ProfileDocument);
    if (!applied.ok) {
      profiles.replace(profileId, before);
      const why = applied.error?.message ?? 'the apply failed';
      stamp({ at, ok: false, detail: `${offered}; apply failed, previous profile restored: ${why}`, nodeCount: parsed.nodes.length });
      input.record({
        level: 'error',
        kind: 'subscription.refresh-failed',
        summary: `subscription "${subscription.name}": applying ${change} failed, and the previous profile was put back: ${why}`,
        detail: { subscription: subscription.id, error: applied.error },
      });
      return `${subscription.id}: apply failed`;
    }

    stamp({ at, ok: true, detail: `${offered}; ${change}`, nodeCount: parsed.nodes.length });
    input.record({
      level: 'info',
      kind: 'subscription.refreshed',
      summary: `subscription "${subscription.name}" refreshed: ${change}`,
      detail: {
        subscription: subscription.id,
        added: outcome.added,
        updated: outcome.updated,
        removed: outcome.removed,
        repointed: outcome.repointed,
        kept,
        refused: refusedLines,
        transaction: applied.transaction?.id,
      },
    });
    observer.acted(`refreshed ${subscription.id}: ${change}`);
    return `${subscription.id}: ${change}`;
  };

  const look = async (): Promise<void> => {
    const profileId = store.device().activeProfileId;
    const row = profileId === null ? null : profiles.get(profileId);
    if (profileId === null || row === null) {
      observer.looked('no active profile');
      return;
    }
    const subscriptions = (row.document as ProfileDocument).subscriptions ?? [];
    if (subscriptions.length === 0) {
      observer.looked('the active profile has no subscriptions');
      observer.failing(null);
      return;
    }
    if ((await input.clockSynchronized()) !== true) {
      observer.looked('the clock is not synchronised, so what is due cannot be told; nothing was fetched');
      return;
    }
    if (openTransaction()) {
      observer.looked('a transaction is open; nothing was fetched');
      return;
    }

    const said: string[] = [];
    const nowMs = now().getTime();
    for (const subscription of subscriptions) {
      const why = notDueReason(subscription, nowMs);
      said.push(why === null ? await refreshOne(profileId, subscription) : `${subscription.id}: ${why}`);
    }
    observer.looked(said.join('; '));

    // Failing while any enabled feed's last attempt failed: the device is running on a list it could not
    // check, and that should be visible without opening the profile.
    const latest = ((profiles.get(profileId)?.document as ProfileDocument | undefined)?.subscriptions ?? []).filter(
      (subscription) => subscription.enabled && subscription.refreshHours > 0 && subscription.lastRefresh?.ok === false,
    );
    observer.failing(
      latest.length === 0 ? null : latest.map((subscription) => `${subscription.id}: ${subscription.lastRefresh!.detail}`).join('; '),
    );
  };

  let running: Promise<void> | null = null;
  const check = (): Promise<void> => {
    running ??= look()
      .catch((error: unknown) => observer.looked(`the round failed: ${String(error)}`))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const timer = setInterval(() => void check(), checkMs);
  timer.unref();
  observer.armed();
  void check();

  return {
    check,
    stop(): void {
      clearInterval(timer);
    },
  };
}
