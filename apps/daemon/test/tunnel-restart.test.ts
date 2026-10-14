/**
 * `POST /api/tunnels/:id/restart`: restart one running tunnel's units, by hand.
 *
 * The guards are about what must **not** be restarted: a unit name taken from the request rather than
 * from the plan, a core-carried tunnel served by restarting the core, a restart racing an apply. The
 * answer is about not calling a job result a restart: a unit read back as not active is a failure
 * whatever systemd said about the job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer, type ServerContext } from '../src/api/server.ts';
import type { Platform } from '../src/platform/index.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore, type Store } from '../src/state/store.ts';
import { createProfileStore } from '../src/state/profiles.ts';
import { createSecretPlan } from '../src/state/secret-plan.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';

interface Calls {
  restarted: string[];
  /** Units that come back from the restart not active. */
  deadAfter: Set<string>;
}

function fakePlatform(calls: Calls): Platform {
  const unitState = (unit: string) => ({
    unit,
    activeState: calls.deadAfter.has(unit) ? 'failed' : 'active',
    subState: null,
    unitFileState: null,
    loadState: 'loaded',
    isActive: !calls.deadAfter.has(unit),
    isEnabled: true,
    known: true,
  });
  return {
    systemd: {
      state: async (unit: string) => unitState(unit),
      restart: async (unit: string) => {
        calls.restarted.push(unit);
        return { result: 'done', unit, jobPath: '/job/1', waitedMs: 1 };
      },
    } as unknown as Platform['systemd'],
    net: { addresses: async () => [], links: async () => [], routes: async () => [], snapshot: async () => ({ links: [], addresses: [], routes: [], at: Date.now() }), watch: () => ({ stop: () => undefined }) } as unknown as Platform['net'],
    wifi: { phys: async () => [], interfaces: async () => [], regulatory: async () => ({ global: null, perPhy: {} }) } as unknown as Platform['wifi'],
    supplicant: {} as Platform['supplicant'],
    ap: {} as Platform['ap'],
    nft: {} as Platform['nft'],
    files: {} as Platform['files'],
    sysctl: {} as Platform['sysctl'],
    clock: { status: async () => ({ timezone: null, ntpEnabled: null, synchronized: false, localRtc: null, timeUsec: null, rtcTimeUsec: null }) } as unknown as Platform['clock'],
    host: { boardModel: async () => null, uptimeSeconds: async () => 4000 } as unknown as Platform['host'],
    binaries: { detect: async () => null, coreSchema: async () => null, checkCoreConfig: async () => null },
    journal: {
      read: async () => ({ entries: [], nextCursor: null, currentBootId: 'boot', containsEarlierBoots: false, hasMore: false, incomplete: false, incompleteReason: null, skippedLines: 0 }),
      currentBootId: async () => 'boot',
    },
    http: { fetchText: async () => ({ ok: false as const, reason: 'no network in this test' }) },
    dns: { resolveWith: async () => ({ ok: false, detail: 'no network in this test' }) },
    scoped: {} as Platform['scoped'],
    install: {} as Platform['install'],
    close: () => undefined,
  };
}

function fakeTelemetry(): ServerContext['telemetry'] {
  return {
    snapshot: () => ({
      at: new Date().toISOString(),
      network: null,
      units: {},
      accessPoints: {},
      links: {},
      clock: null,
      tunnels: null,
      poller: { polls: 1, skipped: 0, failures: 0, lastDurationMs: 4, lastPollAt: null, lastSkipAt: null, startedAtMs: null },
    }),
    stationHistory: () => [],
    subscribe: () => () => undefined,
    start: async () => async () => undefined,
    pollNow: async () => false,
    watchUnits: () => undefined,
    watchAccessPoints: () => undefined,
    watchLinks: () => undefined,
    watchTunnels: () => undefined,
    recordLog: () => undefined,
    publishTransaction: () => undefined,
  };
}

const notReached = (name: string): never =>
  (() => {
    throw new Error(`${name} should not be reached by the tunnel restart route`);
  }) as never;

async function harness(
  t: { after(fn: () => Promise<void> | void): void },
  extra: Partial<ServerContext> | ((base: ServerContext) => Partial<ServerContext>) = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-tunnel-restart-'));
  const database = openDatabase({ path: join(directory, 'state.db') });
  const store = createStore(database);
  await store.setAdminPassword('a-long-enough-password');
  store.setApiEnabled(true);
  store.setTunnelUnits([
    { id: 'office', units: ['wf-openvpn@office.service'], interfaces: ['wfvpnoff'] },
    { id: 'corp', units: ['wf-transport@corp.service', 'wf-openvpn@corp.service'], interfaces: ['wfvpncrp'] },
    { id: 'relay', units: [], interfaces: [] },
  ]);
  const profiles = createProfileStore(database, createSecretPlan());
  const calls: Calls = { restarted: [], deadAfter: new Set() };
  const platform = fakePlatform(calls);

  const context: ServerContext = {
    config: { ...DEFAULT_CONFIG, uiDir: null, stateDir: directory, cacheDir: join(directory, 'cache') },
    platform,
    store,
    telemetry: fakeTelemetry(),
    startedAt: new Date(),
    version: 'test',
    buildAt: null,
    ruleSetAges: async () => ({ profileId: null, sets: [] }),
    observers: () => [],
    unresolvedInterfaces: [],
    boundAddresses: ['127.0.0.1'],
    configWarnings: [],
    setLogLevel: () => ({ level: 'info', revertsAt: null }),
    currentLogLevel: () => 'info',
    profileRoutes: {
      store,
      profiles,
      platform,
      inventory: notReached('inventory'),
      facts: notReached('facts'),
      reality: notReached('reality'),
      managementPort: 8088,
      timePorts: [123],
      timeSyncUnit: 'systemd-timesyncd.service',
      upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      pipeline: {} as never,
      applyDeps: {} as never,
    },
  };
  Object.assign(context, typeof extra === 'function' ? extra(context) : extra);

  const app = await buildServer(context);
  // Removed whether the test passed or not: nothing this file creates outlives it.
  t.after(async () => {
    await app.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, store, profiles, calls };
}

const bearer = (store: Store, scopes: ('read' | 'apply' | 'admin')[]): Record<string, string> => ({
  authorization: `Bearer ${store.createToken('ops', scopes).token}`,
});

test('tunnel restart: restarts exactly the units the plan recorded, in order, and records who asked', async (t) => {
  const { app, store, calls } = await harness(t);
  const response = await app.inject({ method: 'POST', url: '/api/tunnels/corp/restart', headers: bearer(store, ['apply']) });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.restarted, true);
  assert.deepEqual(calls.restarted, ['wf-transport@corp.service', 'wf-openvpn@corp.service']);
  assert.deepEqual(body.units.map((unit: { active: boolean }) => unit.active), [true, true]);
  const events = store.events({ kind: 'tunnel.restarted' });
  assert.equal(events.length, 1);
  assert.match(events[0]!.summary, /token "ops"/);
});

test('tunnel restart: a unit that does not come back running is a failure, whatever the job result said', async (t) => {
  const { app, store, calls } = await harness(t);
  calls.deadAfter.add('wf-openvpn@office.service');
  const response = await app.inject({ method: 'POST', url: '/api/tunnels/office/restart', headers: bearer(store, ['apply']) });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().restarted, false);
  assert.equal(store.events({ kind: 'tunnel.restarted' }).length, 0);
  assert.equal(store.events({ kind: 'tunnel.restart-failed' }).length, 1);
});

test('tunnel restart: a tunnel the running plan does not have is refused, and no unit name is built from the request', async (t) => {
  const { app, store, calls } = await harness(t);
  for (const id of ['nope', '..', 'office.service', 'office%20']) {
    const response = await app.inject({ method: 'POST', url: `/api/tunnels/${id}/restart`, headers: bearer(store, ['apply']) });
    assert.equal(response.statusCode, 404, id);
    // `..` is normalised away by the router before this route sees it, so it is the router's 404.
    if (id !== '..') assert.equal(response.json().error.code, 'tunnel_not_running', id);
  }
  assert.deepEqual(calls.restarted, []);
});

test('tunnel restart: a tunnel carried inside the core is refused rather than restarting the core', async (t) => {
  const { app, store, calls } = await harness(t);
  const response = await app.inject({ method: 'POST', url: '/api/tunnels/relay/restart', headers: bearer(store, ['apply']) });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'tunnel_has_no_units');
  assert.deepEqual(calls.restarted, []);
});

test('tunnel restart: needs the apply scope', async (t) => {
  const { app, store, calls } = await harness(t);
  const response = await app.inject({ method: 'POST', url: '/api/tunnels/office/restart', headers: bearer(store, ['read']) });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(calls.restarted, []);
});

/* ── the group refresh route: the same kind of request-a-thing-now, with its own refusals ─── */

test('group refresh: answers with what the refresh did, and records who asked', async (t) => {
  const asked: string[] = [];
  const { app, store } = await harness(t, {
    refreshGroup: async (id) => {
      asked.push(id);
      return {
        report: {
          group: id,
          ok: true,
          said: `${id}: added cryptocat-3`,
          nodeCount: 3,
          added: ['cryptocat-3'],
          updated: [],
          removed: [],
          ignoredParams: [{ node: 'FR', params: ['spx'] }],
        },
      };
    },
  });
  const response = await app.inject({ method: 'POST', url: '/api/groups/cryptocat/refresh', headers: bearer(store, ['apply']) });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(asked, ['cryptocat']);
  assert.deepEqual(response.json().ignoredParams, [{ node: 'FR', params: ['spx'] }]);
  assert.match(store.events({ kind: 'subscription.refresh-requested' })[0]!.summary, /token "ops"/);
});

test('group refresh: a missing group is 404, an open transaction 409, and a read token is refused', async (t) => {
  const answers = [{ refused: 'not_found' as const }, { refused: 'transaction_open' as const }];
  const { app, store } = await harness(t, { refreshGroup: async () => answers.shift()! });
  const headers = bearer(store, ['apply']);
  assert.equal((await app.inject({ method: 'POST', url: '/api/groups/nope/refresh', headers })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/groups/feed/refresh', headers })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/groups/feed/refresh', headers: bearer(store, ['read']) })).statusCode, 403);
});

/* ── routing diagnostics: the readings a shell was needed for ────────────────────────────── */

test('routing diagnostics: names each missing bypass rule, flags a tunnel server reached through a tunnel, and reads the selectors', async (t) => {
  const { app, store, profiles } = await harness(t, (base) => ({
    platform: {
      ...base.platform,
      net: {
        ...base.platform.net,
        // The core's capture is there and the device's own bypass is not: the state of 2026-10-11 21:15.
        rules: async () => [
          { priority: 9000, table: '2022', iif: null, uidStart: null, uidEnd: null, ipproto: null, dport: null, inverted: false },
        ],
        routeTo: async (address: string) => ({ device: address === '5.39.255.51' ? 'tun0' : 'end0', source: null }),
      },
      systemd: { ...base.platform.systemd, state: async (unit: string) => ({ unit, activeState: 'active', isActive: true, isEnabled: true, known: true }) },
    } as typeof base.platform,
    coreApi: () =>
      ({
        proxies: async () => [
          { name: 'wf-selector', type: 'Selector', now: 'cryptocat', all: ['cryptocat', 'block'] },
          { name: 'cryptocat', type: 'Selector', now: 'block', all: ['germany', 'france'] },
          { name: 'germany', type: 'Socks', now: null, all: null },
        ],
      }) as never,
  }));
  const id = profiles.create({
    ...emptyProfile({ name: 'D' }),
    tunnels: [
      { id: 'germany', name: 'DE', enabled: true, onUnavailable: 'block', protocol: 'vless', config: { server: '5.39.255.51', port: 8080, id: 'x', network: 'tcp', security: 'none' } },
      { id: 'france', name: 'FR', enabled: true, onUnavailable: 'block', protocol: 'vless', config: { server: '82.21.117.116', port: 8080, id: 'y', network: 'tcp', security: 'none' } },
    ],
  } as ProfileDocument).id;
  store.setActiveProfileId(id);

  const response = await app.inject({ method: 'GET', url: '/api/diagnostics/routing', headers: bearer(store, ['read']) });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body.rules.bypass.map((rule: { priority: number; present: boolean }) => [rule.priority, rule.present]), [
    [8000, false],
    [8001, false],
    [8002, false],
  ]);
  assert.equal(body.rules.coreCaptureMissing, false);
  assert.match(body.rules.summary, /own bypass is missing/);
  const byId = Object.fromEntries(body.servers.map((entry: { id: string; throughTunnel: boolean }) => [entry.id, entry.throughTunnel]));
  assert.deepEqual(byId, { germany: true, france: false });
  assert.deepEqual(body.selectors.map((selector: { name: string; now: string }) => [selector.name, selector.now]), [
    ['wf-selector', 'cryptocat'],
    ['cryptocat', 'block'],
  ]);
});
