/**
 * The round that refreshes groups from their subscriptions unasked: when it fetches, and whether what it
 * found lands.
 *
 * The edit rules are `subscriptions-refresh.test.ts`'s. These tests are about the timer's half — every
 * one of them is a way an unattended refresh could change the device when it should not.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile, type Group, type ProfileDocument } from '@wayfarer/schemas';

type Member = Group['members'][number];
import type { ApplyDeps, ApplyOutcome } from '../src/core/apply.ts';
import { createObserverRegistry } from '../src/core/observers.ts';
import type { PlannedDocument } from '../src/core/pipeline.ts';
import { notDueReason, refreshSubscriptions } from '../src/core/subscription-refresh.ts';
import type { FetchTextResult } from '../src/platform/http.ts';
import { openDatabase } from '../src/state/db.ts';
import { createProfileStore } from '../src/state/profiles.ts';
import { createSecretPlan } from '../src/state/secret-plan.ts';
import { createStore } from '../src/state/store.ts';

const NOW = new Date('2026-10-14T10:00:00.000Z');

const link = (server: string, uuid: string, label: string): string =>
  `vless://${uuid}@${server}:8080?type=tcp&security=none#${encodeURIComponent(label)}`;
const feed = (...links: string[]): string => Buffer.from(links.join('\n')).toString('base64');

/** A group member as the feed's link above would produce it; `name` is the link's label. */
const tunnel = (id: string, server: string, uuid: string, name = id): Member => ({
  id,
  name,
  node: `vless://${server}:8080`,
  protocol: 'vless',
  config: { server, port: 8080, id: uuid, network: 'tcp', security: 'none' },
});

function profileWith(members: Member[], lastRefresh?: { at: string; ok: boolean; detail: string; nodeCount: number }): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' });
  return {
    ...base,
    policy: { ...base.policy, egress: 'feed' },
    groups: [
      {
        id: 'feed',
        name: 'Feed',
        enabled: true,
        url: 'https://feed.example/sub/token',
        refreshHours: 24,
        onUnavailable: 'block',
        members,
        ...(lastRefresh === undefined ? {} : { lastRefresh }),
      },
    ],
  };
}

interface Bench {
  run(): Promise<void>;
  refreshNow: ReturnType<typeof refreshSubscriptions>['refreshNow'];
  document(): ProfileDocument;
  revision(): number | null;
  events: { level: string; kind: string; summary: string }[];
  fetched: string[];
  applied: ProfileDocument[];
  close(): void;
}

function bench(input: {
  profile: ProfileDocument;
  answer: FetchTextResult;
  /** Whether the stored profile is also the one last applied. Default: yes. */
  applied?: boolean;
  blastRadius?: 'hot' | 'service' | 'network' | 'boot';
  applyOk?: boolean;
  clock?: boolean | null;
}): Bench {
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  const profiles = createProfileStore(database, createSecretPlan());
  const profileId = profiles.create(input.profile).id;
  store.setActiveProfileId(profileId);
  if (input.applied ?? true) {
    const transaction = profiles.createTransaction({
      profileId,
      documentBefore: null,
      documentAfter: profiles.get(profileId)!.document,
      kind: 'apply',
      blastRadius: 'service',
      plan: {},
    });
    profiles.setTransactionState(transaction.id, 'applying');
    profiles.setTransactionState(transaction.id, 'committed');
  }

  const events: Bench['events'] = [];
  const fetched: string[] = [];
  const applied: ProfileDocument[] = [];
  const refresher = refreshSubscriptions({
    store,
    profiles,
    applyDeps: {} as ApplyDeps,
    observers: createObserverRegistry(),
    fetchText: async (url) => {
      fetched.push(url);
      return input.answer;
    },
    clockSynchronized: async () => input.clock ?? true,
    record: (event) => events.push(event),
    checkMs: 3_600_000,
    now: () => NOW,
    plan: async () =>
      ({
        plan: { usable: true, findings: [] },
        classified: { blastRadius: input.blastRadius ?? 'service', humanDiff: [] },
      }) as unknown as PlannedDocument,
    apply: async (_id, document): Promise<ApplyOutcome> => {
      applied.push(document);
      return input.applyOk === false
        ? { ok: false, error: { code: 'x', message: 'the core refused it', hint: '', status: 500 } }
        : { ok: true };
    },
  });

  return {
    // The constructor starts a round of its own; wait for it, then for the one asked for.
    run: async () => {
      await refresher.check();
    },
    refreshNow: async (groupId) => await refresher.refreshNow(groupId),
    document: () => profiles.get(profileId)!.document as ProfileDocument,
    revision: () => profiles.profileRevision(profileId),
    events,
    fetched,
    applied,
    close: () => {
      refresher.stop();
      database.close();
    },
  };
}

const secretOf = (value: unknown): unknown => (value as { $secret?: unknown }).$secret ?? value;

test('due: never refreshed, past the interval, a failure after an hour, and a stamp from a wrong clock', () => {
  const base = profileWith([]).groups[0]!;
  const at = (iso: string, ok = true) => ({ ...base, lastRefresh: { at: iso, ok, detail: '', nodeCount: 1 } });
  assert.equal(notDueReason(base, NOW.getTime()), null);
  assert.equal(notDueReason(at('2026-10-13T09:00:00Z'), NOW.getTime()), null);
  assert.match(notDueReason(at('2026-10-14T09:00:00Z'), NOW.getTime()) ?? '', /next in 1380 min/);
  // A failure is retried after an hour, not after the full day.
  assert.equal(notDueReason(at('2026-10-14T08:59:00Z', false), NOW.getTime()), null);
  assert.match(notDueReason(at('2026-10-14T09:30:00Z', false), NOW.getTime()) ?? '', /next in 30 min/);
  // Stamped in the future: only a clock that was wrong could have written it.
  assert.equal(notDueReason(at('2026-10-20T00:00:00Z'), NOW.getTime()), null);
  assert.equal(notDueReason({ ...base, refreshHours: 0 }, NOW.getTime()), 'refreshed only on request');
  assert.equal(notDueReason({ ...base, enabled: false }, NOW.getTime()), 'disabled');
});

test('an unchanged feed stamps lastRefresh, applies nothing, and is not counted as an edit', async () => {
  // Stored wrapped, parsed in clear: the comparison must not read that as a change.
  const b = bench({ profile: profileWith([tunnel('de', '5.39.255.51', 'u-1', 'DE')]), answer: { ok: true, text: feed(link('5.39.255.51', 'u-1', 'DE')) } });
  try {
    const revision = b.revision();
    await b.run();
    assert.deepEqual(b.fetched, ['https://feed.example/sub/token']);
    assert.equal(b.applied.length, 0);
    assert.equal(b.revision(), revision);
    const last = b.document().groups[0]!.lastRefresh!;
    assert.equal(last.ok, true);
    assert.equal(last.nodeCount, 1);
    assert.equal(last.at, NOW.toISOString());
    assert.equal(b.document().groups[0]!.members.length, 1);
  } finally {
    b.close();
  }
});

test('the next round inside the interval does not fetch again', async () => {
  const b = bench({ profile: profileWith([tunnel('de', '5.39.255.51', 'u-1')]), answer: { ok: true, text: feed(link('5.39.255.51', 'u-1', 'DE')) } });
  try {
    await b.run();
    await b.run();
    assert.equal(b.fetched.length, 1);
  } finally {
    b.close();
  }
});

test('a failed fetch changes no member and records why, without the URL', async () => {
  const b = bench({ profile: profileWith([tunnel('de', '5.39.255.51', 'u-1')]), answer: { ok: false, reason: 'the server answered HTTP 502' } });
  try {
    await b.run();
    const last = b.document().groups[0]!.lastRefresh!;
    assert.equal(last.ok, false);
    assert.equal(last.detail, 'the server answered HTTP 502');
    assert.equal(b.document().groups[0]!.members.length, 1);
    assert.equal(b.applied.length, 0);
    assert.ok(b.events.some((event) => event.kind === 'subscription.fetch-failed'));
    assert.ok(b.events.every((event) => !event.summary.includes('feed.example')));
  } finally {
    b.close();
  }
});

test('an empty feed is a failure, not "every node is gone": no member is removed', async () => {
  // A refresh that believed the feed would empty the group the device's traffic goes through.
  const profile = profileWith([tunnel('de', '5.39.255.51', 'u-1'), tunnel('spare', '9.9.9.9', 'u-9')]);
  const b = bench({ profile, answer: { ok: true, text: '<html>maintenance</html>' } });
  try {
    await b.run();
    assert.deepEqual(b.document().groups[0]!.members.map((entry) => entry.id), ['de', 'spare']);
    assert.equal(b.document().groups[0]!.lastRefresh!.ok, false);
    assert.equal(b.applied.length, 0);
  } finally {
    b.close();
  }
});

test('nothing is fetched while the clock is not synchronised', async () => {
  const b = bench({ profile: profileWith([]), answer: { ok: true, text: feed() }, clock: false });
  try {
    await b.run();
    assert.equal(b.fetched.length, 0);
    assert.equal(b.document().groups[0]!.lastRefresh, undefined);
  } finally {
    b.close();
  }
});

test('the members become what the feed offers: a withdrawn node leaves, a new one joins, and it is applied', async () => {
  // The bench board on 2026-10-13: the feed dropped the node behind `fr` and offered another.
  const b = bench({
    profile: profileWith([tunnel('de', '5.39.255.51', 'u-1', 'DE'), tunnel('fr', '82.22.50.101', 'u-2')]),
    answer: { ok: true, text: feed(link('5.39.255.51', 'u-1', 'DE'), link('82.21.117.116', 'u-3', 'Germany 2')) },
  });
  try {
    const revision = b.revision()!;
    await b.run();
    const members = b.document().groups[0]!.members;
    assert.deepEqual(members.map((entry) => entry.id), ['de', 'feed-1']);
    assert.equal(members[1]!.config.server, '82.21.117.116');
    assert.equal(secretOf(members[1]!.config.id), 'u-3');
    assert.equal(members[1]!.name, 'Germany 2');
    // The egress names the group; nothing outside it moved.
    assert.equal(b.document().policy.egress, 'feed');
    assert.equal(b.applied.length, 1);
    assert.ok(b.revision()! > revision, 'a change of members is an edit');
    const refreshed = b.events.find((event) => event.kind === 'subscription.refreshed');
    assert.match(refreshed?.summary ?? '', /added feed-1; removed fr/);
  } finally {
    b.close();
  }
});

test('a changed credential replaces the member configuration, and its name follows the feed', async () => {
  const b = bench({ profile: profileWith([tunnel('de', '5.39.255.51', 'u-1', 'Germany')]), answer: { ok: true, text: feed(link('5.39.255.51', 'u-new', 'DE renamed')) } });
  try {
    await b.run();
    const after = b.document().groups[0]!.members[0]!;
    assert.equal(after.id, 'de', 'the id is the outbound tag and stays');
    assert.equal(secretOf(after.config.id), 'u-new');
    assert.equal(after.name, 'DE renamed');
    assert.equal(b.applied.length, 1);
  } finally {
    b.close();
  }
});

test('a change that needs a confirmation window is not stored and not applied', async () => {
  const profile = profileWith([tunnel('de', '5.39.255.51', 'u-1')]);
  const b = bench({ profile, answer: { ok: true, text: feed(link('5.39.255.51', 'u-new', 'DE')) }, blastRadius: 'network' });
  try {
    await b.run();
    assert.equal(secretOf(b.document().groups[0]!.members[0]!.config.id), 'u-1');
    assert.equal(b.applied.length, 0);
    assert.ok(b.events.some((event) => event.kind === 'subscription.refresh-held'));
  } finally {
    b.close();
  }
});

test("a refresh does not ride on a person's edit that is not applied yet", async () => {
  const b = bench({
    profile: profileWith([tunnel('de', '5.39.255.51', 'u-1')]),
    answer: { ok: true, text: feed(link('5.39.255.51', 'u-new', 'DE')) },
    applied: false,
  });
  try {
    await b.run();
    assert.equal(b.applied.length, 0);
    assert.equal(secretOf(b.document().groups[0]!.members[0]!.config.id), 'u-1');
    assert.match(b.document().groups[0]!.lastRefresh!.detail, /not applied/);
    // Held is not done: retried in an hour, not in a day.
    assert.equal(b.document().groups[0]!.lastRefresh!.ok, false);
  } finally {
    b.close();
  }
});

test('a refresh whose apply fails puts the previous profile back', async () => {
  const b = bench({ profile: profileWith([tunnel('de', '5.39.255.51', 'u-1')]), answer: { ok: true, text: feed(link('5.39.255.51', 'u-new', 'DE')) }, applyOk: false });
  try {
    await b.run();
    assert.equal(b.applied.length, 1);
    assert.equal(secretOf(b.document().groups[0]!.members[0]!.config.id), 'u-1');
    assert.ok(b.events.some((event) => event.kind === 'subscription.refresh-failed'));
  } finally {
    b.close();
  }
});

test('a refresh asked for now runs on a group that is not due, and reports what each link carried unread', async () => {
  const fresh = { at: NOW.toISOString(), ok: true, detail: '', nodeCount: 1 };
  const odd = `vless://u-2@82.21.117.116:8080?type=tcp&security=none&spx=%2F&pqv=Z#FR`;
  const b = bench({
    profile: profileWith([tunnel('de', '5.39.255.51', 'u-1', 'DE')], fresh),
    answer: { ok: true, text: feed(link('5.39.255.51', 'u-1', 'DE'), odd) },
  });
  try {
    await b.run();
    assert.deepEqual(b.fetched, [], 'the timer must not fetch a group refreshed a moment ago');

    const result = await b.refreshNow('feed');
    assert.ok('report' in result);
    assert.equal(result.report.ok, true);
    assert.equal(result.report.nodeCount, 2);
    assert.equal(result.report.added.length, 1);
    assert.deepEqual(result.report.ignoredParams, [{ node: 'FR', params: ['pqv', 'spx'] }]);
    assert.equal(b.applied.length, 1);
    assert.match(b.document().groups[0]!.lastRefresh!.detail, /unread link parameters/);

    // The same set again is the same fact about the feed: one event, not one per refresh.
    await b.refreshNow('feed');
    assert.equal(b.events.filter((event) => event.kind === 'subscription.params-ignored').length, 1);
  } finally {
    b.close();
  }
});

test('a refresh asked for now is refused for a group that does not exist or is turned off', async () => {
  const profile = profileWith([]);
  profile.groups[0]!.enabled = false;
  const b = bench({ profile, answer: { ok: true, text: feed(link('5.39.255.51', 'u-1', 'DE')) } });
  try {
    await b.run();
    assert.deepEqual(await b.refreshNow('nope'), { refused: 'not_found' });
    assert.deepEqual(await b.refreshNow('feed'), { refused: 'group_disabled' });
    assert.deepEqual(b.fetched, []);
  } finally {
    b.close();
  }
});
