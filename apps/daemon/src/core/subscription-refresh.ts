/**
 * Refreshing the active profile's groups from their subscriptions, on their own schedule.
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
 * * **A feed that fails, or offers nothing this device can run, changes no member.** Only `lastRefresh`
 *   records it. An empty answer is what a provider's outage looks like, and treating it as "the feed has
 *   no nodes now" would empty the group the device's traffic goes through.
 * * Otherwise the group's members become what the feed offers (`core/subscriptions.ts`), and the watchdog
 *   chooses among them on its next round.
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

import { nodeName, parseSubscription } from '@wayfarer/protocols';
import type { Group, ProfileDocument } from '@wayfarer/schemas';
import type { FetchTextResult } from '../platform/http.ts';
import type { ProfileStore } from '../state/profiles.ts';
import type { Store } from '../state/store.ts';
import { applyDocument, applyInFlight, type ApplyDeps, type ApplyOutcome } from './apply.ts';
import { secretText } from './catalogue/values.ts';
import type { ObserverRegistry } from './observers.ts';
import { planDocument, type PlannedDocument } from './pipeline.ts';
import { refreshGroup, refreshMayApply, type RefreshOutcome } from './subscriptions.ts';

/** How often the round asks what is due. A refresh itself happens no more than `refreshHours` allows. */
export const SUBSCRIPTION_CHECK_MS = 10 * 60_000;
/**
 * After a failed fetch, the next attempt is due this much later rather than after the full
 * `refreshHours`: a feed that was down for a minute should not leave the device a day behind.
 */
export const SUBSCRIPTION_RETRY_MS = 60 * 60_000;
/** `lastRefresh.detail`'s schema limit. */
const DETAIL_MAX = 200;

type Subscription = Group;
type LastRefresh = { at: string; ok: boolean; detail: string; nodeCount: number };
type RecordEvent = (event: { level: 'info' | 'warn' | 'error'; kind: string; summary: string; detail?: unknown }) => void;

export interface SubscriptionRefresher {
  /** Look now, outside the cadence. Returns when the round is done. */
  check(): Promise<void>;
  /**
   * Refresh one group of the active profile now, whatever its `refreshHours` says — a person asked. Every
   * other rule of a round still holds: a feed that fails changes nothing, a change wider than `service` is
   * held, unapplied edits hold it, and a failed apply puts the previous profile back.
   */
  refreshNow(groupId: string): Promise<RefreshNowResult>;
  stop(): void;
}

/** What one group's refresh did. `ok` means the device now runs what the feed offers. */
export interface RefreshReport {
  group: string;
  ok: boolean;
  said: string;
  nodeCount: number;
  added: string[];
  updated: string[];
  removed: string[];
  /** Per node, the link parameters nothing read. See `ParsedNode.ignoredParams`. */
  ignoredParams: { node: string; params: string[] }[];
  transaction?: string;
}

export type RefreshNowResult =
  | { report: RefreshReport }
  | { refused: 'no_active_profile' | 'not_found' | 'group_disabled' | 'transaction_open' };

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
 * The document with every `lastRefresh` removed, keys sorted: what "the same configuration" is compared
 * on. Sorted because the applied copy and the stored one are written by different statements and
 * nothing promises they keep one key order.
 */
function withoutObservations(document: unknown): string {
  const doc = document as { groups?: Record<string, unknown>[] } | null;
  if (doc === null) return 'null';
  return JSON.stringify(sorted({
    ...doc,
    groups: (doc.groups ?? []).map(({ lastRefresh: _ignored, ...rest }) => rest),
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

/** A short mention for `lastRefresh.detail`, whose 200 characters cannot hold the full list. */
function ignoredNote(ignored: RefreshReport['ignoredParams']): string {
  if (ignored.length === 0) return '';
  return ` (${String(ignored.length)} with unread link parameters)`;
}

function describeChange(outcome: RefreshOutcome): string {
  const parts: string[] = [];
  if (outcome.added.length > 0) parts.push(`added ${outcome.added.join(', ')}`);
  if (outcome.updated.length > 0) parts.push(`updated ${outcome.updated.join(', ')}`);
  if (outcome.removed.length > 0) parts.push(`removed ${outcome.removed.join(', ')}`);
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
    watches: "whether each of the active profile's groups is refreshed from its subscription as often as its refreshHours says",
    everyMs: checkMs,
  });

  const openTransaction = (): boolean =>
    applyInFlight(profiles) ||
    profiles.recentTransactions(10).some((row) => row.state === 'awaiting-confirm' || row.state === 'reverting');

  /** The ignored-parameter set last reported per group, so the event marks a change rather than every round. */
  const reportedIgnored = new Map<string, string>();

  /** One subscription. The report's `said` is what the observer should say about it. */
  const refreshOne = async (profileId: string, subscription: Subscription): Promise<RefreshReport> => {
    const report: RefreshReport = {
      group: subscription.id,
      ok: false,
      said: '',
      nodeCount: 0,
      added: [],
      updated: [],
      removed: [],
      ignoredParams: [],
    };
    const done = (ok: boolean, said: string): RefreshReport => Object.assign(report, { ok, said: `${subscription.id}: ${said}` });

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
        summary: `subscription "${subscription.name}" could not be fetched: ${fetched.reason}; no member was changed`,
        detail: { subscription: subscription.id, reason: fetched.reason },
      });
      return done(false, `fetch failed (${fetched.reason})`);
    }

    const parsed = parseSubscription(fetched.text);
    report.nodeCount = parsed.nodes.length;
    report.ignoredParams = parsed.nodes
      .filter((node) => node.ignoredParams !== undefined)
      .map((node) => ({ node: nodeName(node), params: node.ignoredParams! }));
    noteIgnored(subscription, report.ignoredParams);
    const refusedLines = parsed.failures.map((failure) => `line ${String(failure.line)} ${failure.scheme}: ${failure.reason}`);
    if (parsed.nodes.length === 0) {
      const reason = `the feed offered no node this device can run (${String(parsed.failures.length)} line(s) refused)`;
      stamp({ at, ok: false, detail: reason, nodeCount: 0 });
      input.record({
        level: 'warn',
        kind: 'subscription.fetch-failed',
        summary: `subscription "${subscription.name}": ${reason}; no member was changed`,
        detail: { subscription: subscription.id, refused: refusedLines },
      });
      return done(false, 'empty feed');
    }

    /*
     * Read the profile again **after** the fetch and compute from that, with no wait in between: the
     * fetch took seconds, and a document read before it may be one a person has since replaced.
     */
    const row = profiles.get(profileId);
    if (row === null) return done(false, 'the profile went away during the fetch');
    const document = row.document as ProfileDocument;
    const outcome = refreshGroup({ document, groupId: subscription.id, nodes: parsed.nodes });
    report.added = outcome.added;
    report.updated = outcome.updated;
    report.removed = outcome.removed;
    const changed = outcome.added.length + outcome.updated.length + outcome.removed.length > 0;
    const offered = `${String(parsed.nodes.length)} node(s) offered${ignoredNote(report.ignoredParams)}`;

    if (!changed) {
      stamp({ at, ok: true, detail: `${offered}; nothing changed`, nodeCount: parsed.nodes.length });
      return done(true, `${offered}, nothing changed`);
    }

    const change = describeChange(outcome);
    const refuse = (why: string, level: 'warn' | 'error', detail: Record<string, unknown> = {}): RefreshReport => {
      // `ok: false`: the device is not running what the feed says, so the next attempt is due in an hour
      // rather than a day. A hold is usually transient — an edit about to be applied, an open window.
      stamp({ at, ok: false, detail: `${offered}; not applied: ${why}`, nodeCount: parsed.nodes.length });
      input.record({
        level,
        kind: 'subscription.refresh-held',
        summary: `subscription "${subscription.name}" has changes that were not applied (${change}): ${why}`,
        detail: { subscription: subscription.id, added: outcome.added, updated: outcome.updated, removed: outcome.removed, ...detail },
      });
      return done(false, `changes held (${why})`);
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
      return done(false, 'the profile changed while planning; retried next round');
    }

    const before = row.document;
    profiles.replace(profileId, outcome.document);
    const applied = await apply(profileId, profiles.get(profileId)!.document as ProfileDocument);
    if (applied.transaction !== undefined) report.transaction = applied.transaction.id;
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
      return done(false, 'apply failed');
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
        notes: outcome.notes,
        refused: refusedLines,
        transaction: applied.transaction?.id,
      },
    });
    observer.acted(`refreshed ${subscription.id}: ${change}`);
    return done(true, change);
  };

  /**
   * One event when the set of parameters the feed's links carry and nothing reads **changes**, not one per
   * round: the set is a property of the feed, and repeating it hourly would bury every other event.
   */
  const noteIgnored = (subscription: Subscription, ignored: RefreshReport['ignoredParams']): void => {
    const key = JSON.stringify(ignored);
    if ((reportedIgnored.get(subscription.id) ?? '[]') === key) return;
    reportedIgnored.set(subscription.id, key);
    if (ignored.length === 0) return;
    input.record({
      level: 'warn',
      kind: 'subscription.params-ignored',
      summary:
        `subscription "${subscription.name}": ${String(ignored.length)} node(s) carry link parameters nothing here reads ` +
        `(${[...new Set(ignored.flatMap((entry) => entry.params))].sort().join(', ')}); a server that depends on one will not connect`,
      detail: { subscription: subscription.id, nodes: ignored },
    });
  };

  const look = async (): Promise<void> => {
    const profileId = store.device().activeProfileId;
    const row = profileId === null ? null : profiles.get(profileId);
    if (profileId === null || row === null) {
      observer.looked('no active profile');
      return;
    }
    const subscriptions = (row.document as ProfileDocument).groups ?? [];
    if (subscriptions.length === 0) {
      observer.looked('the active profile has no groups');
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
      said.push(why === null ? (await refreshOne(profileId, subscription)).said : `${subscription.id}: ${why}`);
    }
    observer.looked(said.join('; '));

    // Failing while any enabled feed's last attempt failed: the device is running on a list it could not
    // check, and that should be visible without opening the profile.
    const latest = ((profiles.get(profileId)?.document as ProfileDocument | undefined)?.groups ?? []).filter(
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

  /*
   * A person's "refresh now" runs inside the same single-flight as the timer's round: two refreshes of one
   * group computing against the same document would each store their own merge, and the second would
   * overwrite the first's stamp.
   */
  const refreshNow = async (groupId: string): Promise<RefreshNowResult> => {
    while (running !== null) await running;
    const profileId = store.device().activeProfileId;
    const row = profileId === null ? null : profiles.get(profileId);
    if (profileId === null || row === null) return { refused: 'no_active_profile' };
    const group = ((row.document as ProfileDocument).groups ?? []).find((candidate) => candidate.id === groupId);
    if (group === undefined) return { refused: 'not_found' };
    if (!group.enabled) return { refused: 'group_disabled' };
    if (openTransaction()) return { refused: 'transaction_open' };
    let result: RefreshNowResult = { refused: 'not_found' };
    running = refreshOne(profileId, group)
      .then((report) => {
        result = { report };
        observer.looked(`on request: ${report.said}`);
      })
      .finally(() => {
        running = null;
      });
    await running;
    return result;
  };

  const timer = setInterval(() => void check(), checkMs);
  timer.unref();
  observer.armed();
  void check();

  return {
    check,
    refreshNow,
    stop(): void {
      clearInterval(timer);
    },
  };
}
