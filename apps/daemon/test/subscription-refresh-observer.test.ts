/**
 * The round that refreshes subscriptions unasked: when it fetches, and whether what it found lands.
 *
 * The edit rules are `subscriptions-refresh.test.ts`'s. These tests are about the timer's half — every
 * one of them is a way an unattended refresh could change the device when it should not.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile, type ProfileDocument, type Tunnel } from '@wayfarer/schemas';
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

const tunnel = (id: string, server: string, uuid: string): Tunnel =>
  ({
    id,
    name: id,
    role: 'alternative',
    onUnavailable: 'block',
    enabled: true,
    protocol: 'vless',
    config: { server, port: 8080, id: uuid, network: 'tcp', security: 'none' },
    derivedFrom: { subscription: 'feed', node: `vless://${server}:8080` },
  }) as Tunnel;

function profileWith(tunnels: Tunnel[], lastRefresh?: { at: string; ok: boolean; detail: string; nodeCount: number }): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' }) as unknown as ProfileDocument;
  return {
    ...base,
    tunnels,
    policy: { ...base.policy, priority: tunnels.map((entry) => entry.id) },
    subscriptions: [
      {
        id: 'feed',
        name: 'Feed',
        enabled: true,
        url: 'https://feed.example/sub/token',
        refreshHours: 24,
        ...(lastRefresh === undefined ? {} : { lastRefresh }),
      },
    ],
  } as ProfileDocument;
}

interface Bench {
  run(): Promise<void>;
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
  const base = profileWith([]).subscriptions![0]!;
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
  const b = bench({ profile: profileWith([tunnel('de', '5.39.255.51', 'u-1')]), answer: { ok: true, text: feed(link('5.39.255.51', 'u-1', 'DE')) } });
  try {
    const revision = b.revision();
    await b.run();
    assert.deepEqual(b.fetched, ['https://feed.example/sub/token']);
    assert.equal(b.applied.length, 0);
    assert.equal(b.revision(), revision);
    const last = b.document().subscriptions![0]!.lastRefresh!;
    assert.equal(last.ok, true);
    assert.equal(last.nodeCount, 1);
    assert.equal(last.at, NOW.toISOString());
    assert.equal(b.document().tunnels.length, 1);
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

test('a failed fetch changes no tunnel and records why, without the URL', async () => {
  const b = bench({ profile: profileWith([tunnel('de', '5.39.255.51', 'u-1')]), answer: { ok: false, reason: 'the server answered HTTP 502' } });
  try {
    await b.run();
    const last = b.document().subscriptions![0]!.lastRefresh!;
    assert.equal(last.ok, false);
    assert.equal(last.detail, 'the server answered HTTP 502');
    assert.equal(b.document().tunnels.length, 1);
    assert.equal(b.applied.length, 0);
    assert.ok(b.events.some((event) => event.kind === 'subscription.fetch-failed'));
    assert.ok(b.events.every((event) => !event.summary.includes('feed.example')));
  } finally {
    b.close();
  }
});

test('an empty feed is a failure, not "every node is gone": no tunnel is removed', async () => {
  // Nothing names `spare`, so a refresh that believed the feed would delete it.
  const spare = { ...tunnel('spare', '9.9.9.9', 'u-9') };
  const profile = profileWith([tunnel('de', '5.39.255.51', 'u-1'), spare]);
  profile.policy.priority = ['de'];
  const b = bench({ profile, answer: { ok: true, text: '<html>maintenance</html>' } });
  try {
    await b.run();
    assert.deepEqual(b.document().tunnels.map((entry) => entry.id), ['de', 'spare']);
    assert.equal(b.document().subscriptions![0]!.lastRefresh!.ok, false);
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
    assert.equal(b.document().subscriptions![0]!.lastRefresh, undefined);
  } finally {
    b.close();
  }
});

test('a withdrawn node in use moves to the node that replaced it, and the change is applied', () => {
  return (async () => {
    // The bench board on 2026-10-13: the feed dropped the node behind `fr` and offered another.
    const b = bench({
      profile: profileWith([tunnel('de', '5.39.255.51', 'u-1'), tunnel('fr', '82.22.50.101', 'u-2')]),
      answer: { ok: true, text: feed(link('5.39.255.51', 'u-1', 'DE'), link('82.21.117.116', 'u-3', 'Germany 2')) },
    });
    try {
      const revision = b.revision()!;
      await b.run();
      const tunnels = b.document().tunnels;
      assert.deepEqual(tunnels.map((entry) => entry.id), ['de', 'fr']);
      const fr = tunnels[1]!;
      assert.equal((fr.config as { server: string }).server, '82.21.117.116');
      assert.equal(secretOf((fr.config as { id: unknown }).id), 'u-3');
      assert.equal(fr.name, 'Germany 2');
      assert.equal(fr.enabled, true);
      assert.deepEqual(b.document().policy.priority, ['de', 'fr']);
      assert.equal(b.applied.length, 1);
      assert.ok(b.revision()! > revision, 'a change of tunnels is an edit');
      assert.ok(b.events.some((event) => event.kind === 'subscription.refreshed' && event.summary.includes('fr moved')));
    } finally {
      b.close();
    }
  })();
});

test('a new node nothing needs arrives disabled', async () => {
  const b = bench({
    profile: profileWith([tunnel('de', '5.39.255.51', 'u-1')]),
    answer: { ok: true, text: feed(link('5.39.255.51', 'u-1', 'DE'), link('82.21.117.116', 'u-3', 'New')) },
  });
  try {
    await b.run();
    const added = b.document().tunnels.find((entry) => entry.id === 'feed-1')!;
    assert.equal(added.enabled, false);
    assert.equal(added.name, 'New');
    assert.deepEqual(b.document().policy.priority, ['de']);
  } finally {
    b.close();
  }
});

test('a changed credential replaces the configuration and keeps what a person decided', async () => {
  const mine: Tunnel = { ...tunnel('de', '5.39.255.51', 'u-1'), name: 'Germany', enabled: false };
  const b = bench({ profile: profileWith([mine]), answer: { ok: true, text: feed(link('5.39.255.51', 'u-new', 'DE renamed')) } });
  try {
    await b.run();
    const after = b.document().tunnels[0]!;
    assert.equal(secretOf((after.config as { id: unknown }).id), 'u-new');
    assert.equal(after.name, 'Germany');
    assert.equal(after.enabled, false);
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
    assert.equal(secretOf((b.document().tunnels[0]!.config as { id: unknown }).id), 'u-1');
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
    assert.equal(secretOf((b.document().tunnels[0]!.config as { id: unknown }).id), 'u-1');
    assert.match(b.document().subscriptions![0]!.lastRefresh!.detail, /not applied/);
    // Held is not done: retried in an hour, not in a day.
    assert.equal(b.document().subscriptions![0]!.lastRefresh!.ok, false);
  } finally {
    b.close();
  }
});

test('a refresh whose apply fails puts the previous profile back', async () => {
  const b = bench({ profile: profileWith([tunnel('de', '5.39.255.51', 'u-1')]), answer: { ok: true, text: feed(link('5.39.255.51', 'u-new', 'DE')) }, applyOk: false });
  try {
    await b.run();
    assert.equal(b.applied.length, 1);
    assert.equal(secretOf((b.document().tunnels[0]!.config as { id: unknown }).id), 'u-1');
    assert.ok(b.events.some((event) => event.kind === 'subscription.refresh-failed'));
  } finally {
    b.close();
  }
});
