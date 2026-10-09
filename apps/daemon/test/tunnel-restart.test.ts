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
  };
}

const notReached = (name: string): never =>
  (() => {
    throw new Error(`${name} should not be reached by the tunnel restart route`);
  }) as never;

async function harness(t: { after(fn: () => Promise<void> | void): void }) {
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
