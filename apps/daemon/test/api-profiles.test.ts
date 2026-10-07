/**
 * The profile surface, through HTTP.
 *
 * The last test in this file is the epic's definition of done, asserted as one sequence: a profile
 * built from nothing, exported with secrets redacted, imported on a second device, and that device
 * listing exactly which secrets are missing. It is one test on purpose — the value is in the round
 * trip, and four separate tests would each pass while the sequence failed.
 */

import { test } from 'node:test';
import { CONFIRMATION_WINDOW_MS } from '../src/core/transactions.ts';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer, type ServerContext } from '../src/api/server.ts';
import type { PipelineContext } from '../src/core/pipeline.ts';
import type { ApplyDeps } from '../src/core/apply.ts';
import { createDriftMonitor } from '../src/core/drift.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore, type Store } from '../src/state/store.ts';
import { createProfileStore } from '../src/state/profiles.ts';
import { createSecretPlan } from '../src/state/secret-plan.ts';
import { parseForeignSchema } from '@wayfarer/protocols';
import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Platform } from '../src/platform/index.ts';
import { builtInAndDongle, cleanFacts } from './helpers/synthetic-inventory.ts';
import { resolveBranch } from '@wayfarer/protocols/resolver';
import { resolveRef } from '@wayfarer/protocols/json';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The real schema from the bench board, served by the stand-in exactly as the binary would.
 *
 * Returning null here — which an earlier version did — makes every schema route answer 404 and every
 * assertion about a served schema pass by skipping. A test that proves nothing is worse than a missing
 * one, because it reports that the thing is covered.
 */
const CORE_SCHEMA = readFileSync(
  `${dirname(fileURLToPath(import.meta.url))}/../../../packages/protocols/test/fixtures/core-schema-sing-box-1.14.0.json`,
  'utf8',
);

/** A transient unit the stand-in was asked to arm, so ordering and arguments can be asserted. */
interface ArmedTransient {
  unit: string;
  withinSeconds: number;
  argv: string[];
}

function fakePlatform(options: { transientFails?: boolean; unwritable?: string[] } = {}): {
  platform: Platform;
  armed: () => ArmedTransient[];
  stopped: () => string[];
  trace: () => string[];
} {
  /**
   * Unit state has to be *remembered*, not answered as a constant.
   *
   * A stand-in that always reports inactive makes every apply fail verification, which looks like a
   * reconciler fault and is a harness fault. Verification is the step that reads back what the
   * previous steps did, so a stand-in that does not record them cannot exercise it at all.
   */
  const armed: ArmedTransient[] = [];
  const stopped: string[] = [];
  /** Every side effect in order, so the apply sequence can be asserted rather than assumed. */
  const trace: string[] = [];
  const sysctl = new Map<string, string>();
  const asideMoves: { from: string; to: string }[] = [];
  const units = new Map<string, { isActive: boolean; isEnabled: boolean }>();
  const mark = (unit: string, patch: { isActive?: boolean; isEnabled?: boolean }): void => {
    units.set(unit, { ...(units.get(unit) ?? { isActive: false, isEnabled: false }), ...patch });
  };

  const platform = {
    systemd: {
      state: async (unit: string) => ({
        unit,
        activeState: null,
        subState: null,
        unitFileState: null,
        loadState: null,
        isActive: units.get(unit)?.isActive ?? false,
        isEnabled: units.get(unit)?.isEnabled ?? false,
        known: units.has(unit),
      }),
      enable: async (unit: string) => {
        mark(unit, { isEnabled: true });
      },
      disable: async (unit: string) => {
        mark(unit, { isEnabled: false });
      },
      start: async (unit: string) => {
        mark(unit, { isActive: true });
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      restart: async (unit: string) => {
        mark(unit, { isActive: true });
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      stop: async (unit: string) => {
        mark(unit, { isActive: false });
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      daemonReload: async () => undefined,
      /**
       * Records what would have been armed, and can refuse.
       *
       * Refusing is what makes the "never applied without the way back" branch reachable. A stand-in
       * that always succeeded would leave that path untested while reporting coverage of it, which is
       * the shape of failure this project has already paid for twice.
       */
      runTransient: async (transient: ArmedTransient) => {
        if (options.transientFails === true) {
          return { ok: false, message: 'the stand-in was told to refuse' };
        }
        armed.push({ unit: transient.unit, withinSeconds: transient.withinSeconds, argv: transient.argv });
        return { ok: true, message: '' };
      },
      stopTransient: async (unit: string) => {
        stopped.push(unit);
        return { ok: true, message: '' };
      },
    } as unknown as Platform['systemd'],
    net: {
      snapshot: async () => ({ links: [], addresses: [], routes: [], at: Date.now() }),
      addresses: async () => [],
      links: async () => [],
      routes: async () => [],
      watch: () => ({ stop: () => undefined }),
      reload: async () => {
        trace.push('net:reload');
        return { ok: true, message: '' };
      },
      reconfigure: async (interfaces: string[]) => {
        trace.push(`net:reconfigure ${interfaces.join(',')}`);
        return { ok: true, message: '' };
      },
      /**
       * Reports **not settled**, immediately, with no addresses.
       *
       * Deliberately the awkward answer. A stand-in that reported everything up would make the settle
       * step unable to fail and the "an unsettled link is not an apply failure" rule untested — and that
       * rule is the one standing between a slow DHCP server and a device that refuses to configure
       * itself. The timeout is not waited out because the stand-in has no clock to wait on.
       */
      waitForSettle: async (interfaces: { name: string; expect: string }[]) => {
        trace.push(`net:wait ${interfaces.map((entry) => `${entry.name}/${entry.expect}`).join(',')}`);
        return {
          settled: false,
          perInterface: interfaces.map((entry) => ({
            name: entry.name,
            expect: entry.expect,
            carrier: false,
            address: null,
            ok: false,
          })),
        };
      },
    } as unknown as Platform['net'],
    sysctl: {
      read: async (key: string) => sysctl.get(key) ?? null,
      write: async (key: string, value: string) => {
        trace.push(`sysctl:${key}=${value}`);
        sysctl.set(key, value);
      },
    } as unknown as Platform['sysctl'],
    wifi: {
      phys: async () => [],
      interfaces: async () => [],
      regulatory: async () => ({ global: null, perPhy: {} }),
    } as unknown as Platform['wifi'],
    supplicant: {} as Platform['supplicant'],
    ap: {} as Platform['ap'],
    nft: { check: async () => ({ ok: true, message: '' }) } as unknown as Platform['nft'],
    files: {
      writeAtomic: async (path: string) => {
        trace.push(`write:${path}`);
        return { path, bytes: 1, changed: true };
      },
      readManaged: async () => null,
      fileMode: async () => null,
      moveAside: async (path: string) => {
        const to = `${path}.disabled-by-wayfarer`;
        trace.push(`aside:${path}`);
        asideMoves.push({ from: path, to });
        return { from: path, to, moved: true };
      },
      restoreAside: async (entry: { from: string; to: string }) => {
        trace.push(`restore:${entry.from}`);
        return { ...entry, outcome: 'restored' as const };
      },
      /**
       * Writable unless the test says otherwise.
       *
       * The refusing case is what makes the "nothing is attempted when a directory cannot be written"
       * branch reachable at all — a stand-in that always said yes would leave that path untested while
       * reporting coverage of it, which is the failure this project has already paid for twice.
       */
      directoryWritable: async (directory: string) => {
        trace.push(`writable?:${directory}`);
        if (options.unwritable?.includes(directory) === true) return { writable: false, reason: 'EROFS' };
        return { writable: true, reason: 'writable' };
      },
    } as unknown as Platform['files'],
    clock: {
      status: async () => ({
        timezone: null,
        ntpEnabled: null,
        synchronized: null,
        localRtc: null,
        timeUsec: null,
        rtcTimeUsec: null,
      }),
    } as unknown as Platform['clock'],
    host: {
      boardModel: async () => null,
      // A fixed, plausible uptime. The confirmation countdown is derived from this rather than from a
      // wall clock, so a stand-in that omits it makes every windowed test fail loudly — which is the
      // behaviour wanted from a stand-in that cannot answer.
      uptimeSeconds: async () => 4000,
    },
    binaries: {
      detect: async () => null,
      coreSchema: async () => ({ schema: CORE_SCHEMA, cacheKey: 'test', fromCache: true }),
      // A stand-in that accepts. The step that consumes this is exercised for real on the board; what
      // matters here is that the reconciler *reads* the answer, which the failure case below proves.
      checkCoreConfig: async () => ({ ok: true, message: '' }),
    },
    journal: {
      read: async () => ({
        entries: [],
        nextCursor: null,
        currentBootId: 'boot',
        containsEarlierBoots: false,
        hasMore: false,
        incomplete: false,
        incompleteReason: null,
        skippedLines: 0,
      }),
      currentBootId: async () => 'boot',
    },
    close: () => undefined,
  } as unknown as Platform;

  return { platform, armed: () => armed, stopped: () => stopped, trace: () => trace };
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
      poller: { polls: 1, skipped: 0, failures: 0, lastDurationMs: 1, lastPollAt: null, lastSkipAt: null, startedAtMs: null },
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

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  store: Store;
  /**
   * The database itself, for the one thing a test cannot reach through the API: writing a row that
   * an *earlier* build could store and this one cannot read. Prior state is not something a current
   * route can produce, so a test that could only go through the API could never exercise it.
   */
  database: ReturnType<typeof openDatabase>;
  close: () => void;
  headers: Record<string, string>;
  /** Transient units the stand-in was asked to arm, so ordering and arguments can be asserted. */
  armed: () => ArmedTransient[];
  stopped: () => string[];
  /** Every side effect in order. The apply sequence is a claim only a transcript can settle. */
  trace: () => string[];
  profiles: ReturnType<typeof createProfileStore>;
}

/** A device with the machinery wired, standing in for a real one. */
async function device(
  label: string,
  options: { transientFails?: boolean; unwritable?: string[]; transactionEnded?: ApplyDeps['transactionEnded'] } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), `wayfarer-${label}-`));
  const database = openDatabase({ path: join(directory, 'state.db') });
  const store = createStore(database);
  // The secret plan, built from the real schema, exactly as the daemon builds it. Constructing the
  // store without one is impossible, which is the point of the chokepoint.
  const secretPlan = createSecretPlan();
  const profiles = createProfileStore(database, secretPlan);
  await store.setAdminPassword('a-long-enough-password');
  store.setApiEnabled(true);

  const { platform, armed, stopped, trace } = fakePlatform(options);
  // Two radios: the arrangement a driver actually permits for an access point plus a Wi-Fi client.
  // One radio would make the round-trip profile below invalid for a reason that has nothing to do with
  // what these tests are about.
  const inventory = builtInAndDongle();

  // The pipeline and the transaction layer the routes delegate to. Built here from the same stand-ins
  // the routes used to be handed directly, so these tests keep testing the HTTP surface rather than the
  // orchestration — and so the orchestration has exactly one construction site in production code.
  const pipeline: PipelineContext = {
    platform,
    inventory: async () => inventory,
    facts: async () => cleanFacts(),
    reality: async (paths, units) => ({
      files: paths.map((path) => ({ path, content: null, mode: null })),
      units: units.map((name) => ({ name, active: false, enabled: false, known: false })),
      interfaces: inventory.interfaces.map((entry) => ({ name: entry.name, mac: entry.mac })),
      managementInterfaces: ['end0'],
      sysctl: {},
    }),
    managementPort: 8088,
    timePorts: [123],
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
  };

  const driftMonitor = createDriftMonitor({ profiles, store, pipeline });

  const applyDeps: ApplyDeps = {
    platform,
    profiles,
    store,
    pipeline,
    // The real monitor over this test's own store and pipeline, not a stub. A stub here would make
    // this suite the place where the post-revert comparison is *declared* to be wired rather than
    // exercised, which is the shape the catalogue records under "a test that bypasses the wiring
    // cannot see that the wiring is missing".
    drift: driftMonitor,
    ...(options.transactionEnded === undefined ? {} : { transactionEnded: options.transactionEnded }),
    timeSyncUnit: 'systemd-timesyncd.service',
    wayBinary: '/usr/local/bin/way',
    log: () => undefined,
    // No recovery document in these tests: they never revert a first apply, and returning one would
    // hide the case where there is genuinely nothing to go back to.
    recoveryDocument: async () => null,
  };

  const context: ServerContext = {
    config: { ...DEFAULT_CONFIG, uiDir: null, stateDir: directory, cacheDir: join(directory, 'cache') },
    // The same monitor the transaction layer was given, read at request time. Two instances would let
    // the endpoint and the event ring describe different devices.
    drift: () => ({ report: driftMonitor.last(), ageSeconds: driftMonitor.ageSeconds() }),
    platform,
    store,
    telemetry: fakeTelemetry(),
    startedAt: new Date(),
    version: 'test',
    buildAt: null,
    // Required rather than optional: a dependency defaulting to an empty list is a panel that shows
    // nothing and reports no error, which is indistinguishable from a device with no rule sets.
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
      inventory: async () => inventory,
      facts: async () => cleanFacts(),
      reality: async (paths, units) => ({
        files: paths.map((path) => ({ path, content: null, mode: null })),
        units: units.map((name) => ({ name, active: false, enabled: false, known: false })),
        interfaces: inventory.interfaces.map((entry) => ({ name: entry.name, mac: entry.mac })),
        managementInterfaces: ['end0'],
        sysctl: {},
      }),
      managementPort: 8088,
      timePorts: [123],
      timeSyncUnit: 'systemd-timesyncd.service',
      upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      pipeline,
      applyDeps,
    },
  };

  const app = await buildServer(context);
  const token = store.createToken('admin', ['read', 'apply', 'admin']).token;
  return {
    app,
    store,
    database,
    close: () => database.close(),
    headers: { authorization: `Bearer ${token}` },
    armed,
    stopped,
    trace,
    profiles,
  };
}

/* ── scope guards on the new surface ─────────────────────────────────────────────────────── */

test('every new route carries a scope guard, or the server refuses to build', async (t) => {
  // `buildServer` throws at construction when a route under /api/ has no guard. The harness above
  // building at all is that assertion; this test states it so the reason is not lost, and checks the
  // scopes are the ones documented rather than merely present.
  const { app, store, close } = await device('scopes');
  t.after(() => {
    void app.close();
    close();
  });

  const readOnly = store.createToken('read-only', ['read']).token;
  const headers = { authorization: `Bearer ${readOnly}` };

  for (const url of ['/api/profiles', '/api/plan', '/api/protocols', '/api/schemas/profile', '/api/transactions']) {
    const response = await app.inject({ method: 'GET', url, headers });
    assert.notEqual(response.statusCode, 403, `${url} refused a token with "read": ${response.body}`);
    // `notEqual(403)` is satisfied by a 404, so this loop would pass just as happily against a route
    // that does not exist — which is what it did while `/api/protocols` was still `/api/providers`.
    // A scope test that a deleted route satisfies is a scope test about nothing.
    assert.notEqual(response.statusCode, 404, `${url} is not a route: ${response.body}`);
  }

  // Writing needs `apply`.
  const write = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: {} });
  assert.equal(write.statusCode, 403);
  assert.equal(write.json<{ error: { code: string } }>().error.code, 'insufficient_scope');
});

test('a full export needs admin, and a redacted one does not', async (t) => {
  const { app, store, close, headers } = await device('export-scope');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'X' } });
  const id = created.json<{ id: string }>().id;

  const readOnly = { authorization: `Bearer ${store.createToken('r', ['read']).token}` };
  const redacted = await app.inject({ method: 'GET', url: `/api/profiles/${id}/export`, headers: readOnly });
  assert.equal(redacted.statusCode, 200);

  const full = await app.inject({
    method: 'GET',
    url: `/api/profiles/${id}/export?secrets=include`,
    headers: readOnly,
  });
  assert.equal(full.statusCode, 403);
  assert.equal(full.json<{ error: { code: string } }>().error.code, 'insufficient_scope');
});

/* ── the empty profile ───────────────────────────────────────────────────────────────────── */

test('a profile created from nothing is complete, and has nothing in it', async (t) => {
  const { app, close, headers } = await device('empty');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Fresh' } });
  assert.equal(created.statusCode, 201);
  const id = created.json<{ id: string }>().id;

  const fetched = await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers });
  const document = fetched.json<{ document: Record<string, unknown> }>().document;

  // Every absence here is a decision: no uplink because guessing is wrong for somebody, no access
  // point because a board may have no radio, kill-switch off because a device with no tunnel and a
  // kill-switch on looks broken.
  assert.deepEqual(document['uplinks'], []);
  assert.equal(document['accessPoint'], null);
  assert.equal((document['firewall'] as { killSwitch: boolean }).killSwitch, false);
  assert.equal((document['firewall'] as { ipv6: string }).ipv6, 'block');
  assert.equal((document['firewall'] as { ntpBypass: boolean }).ntpBypass, true);
  // The protect anchor is present from the first moment, so the dangerous arrangement has to be
  // created deliberately rather than being the starting point.
  assert.equal((document['routing'] as { rules: { kind: string }[] }).rules[0]?.kind, 'protect-own-networks');
});

/* ── secrets never come back ─────────────────────────────────────────────────────────────── */

test('a read never returns a secret, only whether one is set', async (t) => {
  const { app, close, headers } = await device('read-secret');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'S' } });
  const id = created.json<{ id: string }>().id;
  const current = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  const written = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...current,
      accessPoint: {
        bind: { by: 'phy-builtin' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
        ssid: 'Wayfarer',
        passphrase: 'a-real-passphrase',
        acceptChannelFollowsUplink: false,
      },
    },
  });
  assert.equal(written.statusCode, 200, written.body);

  const readBack = await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers });
  const body = readBack.body;
  assert.equal(body.includes('a-real-passphrase'), false, 'the passphrase came back from a GET');
  const document = readBack.json<{ document: { accessPoint: { passphrase: unknown } } }>().document;
  assert.deepEqual(document.accessPoint.passphrase, { $set: true });
});

test('$keep leaves the stored secret alone, which is what stops a form blanking it', async (t) => {
  const { app, close, headers } = await device('keep');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'K' } });
  const id = created.json<{ id: string }>().id;
  const current = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...current,
      accessPoint: {
        bind: { by: 'phy-builtin' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
        ssid: 'Wayfarer',
        passphrase: 'original',
        acceptChannelFollowsUplink: false,
      },
    },
  });

  // The interface received `{ $set: true }`, so this is what a save of an unrelated field sends back.
  const second = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...current,
      accessPoint: {
        bind: { by: 'phy-builtin' },
        radio: { band: '5GHz', channel: 40, width: 80, country: 'US', hidden: false },
        ssid: 'Wayfarer',
        passphrase: { $keep: true },
        acceptChannelFollowsUplink: false,
      },
    },
  });
  assert.equal(second.statusCode, 200, second.body);

  const exported = await app.inject({
    method: 'GET',
    url: `/api/profiles/${id}/export?secrets=include`,
    headers,
  });
  // The value survived a save that did not mention it.
  assert.ok(exported.body.includes('original'), 'the stored secret was lost by a $keep write');
});

test('a read-shaped value in a write is refused with its pointer', async (t) => {
  const { app, close, headers } = await device('read-shape');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'R' } });
  const id = created.json<{ id: string }>().id;
  const current = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  const response = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...current,
      accessPoint: {
        bind: { by: 'phy-builtin' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
        ssid: 'Wayfarer',
        // Exactly what a GET returned. It must never reach storage.
        passphrase: { $set: true },
        acceptChannelFollowsUplink: false,
      },
    },
  });
  assert.equal(response.statusCode, 400);
  const error = response.json<{ error: { code: string; pointer: string } }>().error;
  assert.equal(error.code, 'invalid_secret_write');
  assert.equal(error.pointer, '/accessPoint/passphrase');
});

/* ── plan review ─────────────────────────────────────────────────────────────────────────── */

test('a plan review never contains a generated file', async (t) => {
  const { app, store, close, headers } = await device('plan');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'P' } });
  const id = created.json<{ id: string }>().id;
  const current = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...current,
      accessPoint: {
        bind: { by: 'phy-builtin' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
        ssid: 'Wayfarer',
        passphrase: 'a-real-passphrase',
        acceptChannelFollowsUplink: false,
      },
    },
  });
  store.setActiveProfileId(id);

  const review = await app.inject({ method: 'GET', url: '/api/plan', headers });
  assert.equal(review.statusCode, 200, review.body);
  const body = review.json<{ files: { path: string; purpose: string }[]; humanDiff: string[] }>();

  // Paths and purposes, never contents. A plan review that printed the generated core configuration
  // would defeat redaction completely while looking like a safety feature.
  //
  // `wlan0`, not `wfap0`: this profile did not ask for its interface to be pinned, and an unpinned
  // role keeps the name the kernel already gave it. Asserting the generated name here would be
  // asserting a rename nobody requested.
  assert.ok(
    body.files.some((file) => file.path.endsWith('/hostapd/wlan0.conf')),
    `expected a hostapd file named after the existing interface, got ${body.files.map((f) => f.path).join(', ')}`,
  );
  assert.equal(review.body.includes('a-real-passphrase'), false, 'a secret reached the plan review');
  assert.equal(review.body.includes('wpa_passphrase'), false, 'a generated file reached the plan review');
  assert.ok(body.humanDiff.length > 0);
});

test('an apply narrowed to the safe classes applies that part and names what it did not', async (t) => {
  const { app, store, close, headers, armed } = await device('apply-refuse');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'A' } });
  const id = created.json<{ id: string }>().id;
  const current = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...current,
      accessPoint: {
        bind: { by: 'phy-builtin' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
        ssid: 'Wayfarer',
        passphrase: 'a-real-passphrase',
        acceptChannelFollowsUplink: false,
      },
    },
  });
  store.setActiveProfileId(id);

  // Narrowed on purpose. The network class is implemented now, so an unnarrowed apply would arm a
  // window and attempt it — this asserts the other half of the contract: a caller that asks for only
  // the safe classes gets the safe part and a named list of what it did not get.
  const applied = await app.inject({
    method: 'POST',
    url: '/api/apply',
    headers,
    payload: { classes: ['hot', 'service'] },
  });
  // It **succeeds**, and that is the contract rather than a surprise: asking for the safe classes is
  // asking for the safe part, and the answer lists what was left out. Epic B refused such a plan whole
  // because the network class could not be applied at all; now it can, so refusing would mean a caller
  // who wants only the safe half has no way to get it.
  assert.equal(applied.statusCode, 200, applied.body);
  const body = applied.json<{
    transaction: { state: string; deadlineAt: string | null };
    refused: { what: string; needs: string }[];
  }>();

  // Committed, with no window: nothing that can cost access was performed, so there is nothing to
  // confirm — and arming a countdown here would mean an unconfirmed revert undoing the safe part that
  // *did* apply.
  assert.equal(body.transaction.state, 'committed');
  assert.equal(body.transaction.deadlineAt, null);
  assert.equal(armed().length, 0, 'a window was armed for a change that was refused');

  // Actionable: every refused change, and what each one needs.
  assert.ok(body.refused.length > 0);
  assert.ok(body.refused.every((entry) => entry.needs.length > 0));
  assert.ok(
    body.refused.some((entry) => /nftables\.conf/.test(entry.what)),
    'the firewall is a network change and must appear in the refusals',
  );
});

test('a network apply is never attempted without the way back already armed', async (t) => {
  // The property that matters more than the window itself. If the revert timer cannot be armed, the
  // change does **not** happen — because the interval a window protects includes the apply, and an
  // apply performed with nothing watching is exactly the situation the whole design exists to prevent.
  //
  // The stand-in refuses to arm, which is why this is reachable at all: a fake that always succeeded
  // would make this branch unreachable and the test would be about nothing.
  const { app, store, close, headers } = await device('apply-no-timer', { transientFails: true });
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'N' } });
  const id = created.json<{ id: string }>().id;
  store.setActiveProfileId(id);

  const applied = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  assert.equal(applied.statusCode, 503, applied.body);
  assert.equal(applied.json<{ error: { code: string } }>().error.code, 'revert_timer_unavailable');
  // And nothing reached the system: no write step, no unit action.
  assert.equal(store.events({ kind: 'apply.refused' }).length, 1);
});

/**
 * A revert asks whether the device still matches its stored profile, and says so where a person looks.
 *
 * The comparison is a **required** dependency of the transaction layer rather than an optional one, so
 * this suite could not construct an apply path without it — but a type is not a wire. This test goes
 * through the HTTP undo and reads the event ring, because the failure it guards against is exactly the
 * one the catalogue records: an argument that is accepted, never supplied, and whose absence is the
 * permissive answer.
 *
 * Why the reason string matters: the profile pointer is deliberately left where it is, so afterwards
 * the stored document routinely describes something the device is no longer doing. On 2026-09-22 six
 * blocked endpoints stood in the stored profile while the running core configuration held none, and
 * nothing said so.
 */
test('undoing a transaction compares the device with its stored profile, and the result reaches the event ring', async (t) => {
  const { app, store, close, headers } = await device('revert-drift');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'R' } });
  const id = created.json<{ id: string }>().id;
  store.setActiveProfileId(id);

  // Applied and confirmed once, so that there is a previous document to go back to. Without it the
  // undo has nothing to restore and takes an earlier path, which is a different thing to test.
  const first = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  assert.equal(first.statusCode, 200, first.body);
  const firstId = first.json<{ transaction: { id: string } }>().transaction.id;
  const confirmed = await app.inject({ method: 'POST', url: `/api/transactions/${firstId}/confirm`, headers, payload: {} });
  assert.equal(confirmed.statusCode, 200, confirmed.body);

  const applied = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  assert.equal(applied.statusCode, 200, applied.body);
  const transaction = applied.json<{ transaction: { id: string } }>().transaction;

  /*
   * Since 2026-09-23 every apply and every confirm is followed by a comparison too, so "nothing has
   * compared this device yet" is no longer the starting point. What the undo must do is unchanged:
   * leave a comparison behind that says it was made because of the undo — now asserted on the report
   * `GET /api/drift` serves as well as on the ring, because the served report is what went stale.
   */
  const servedBefore = await app.inject({ method: 'GET', url: '/api/drift', headers });
  assert.notEqual(servedBefore.json<{ report: { reason: string } | null }>().report?.reason, 'after-revert');

  const undone = await app.inject({
    method: 'POST',
    url: `/api/transactions/${transaction.id}/revert`,
    headers,
    payload: {},
  });
  assert.equal(undone.statusCode, 200, undone.body);

  const served = await app.inject({ method: 'GET', url: '/api/drift', headers });
  assert.equal(
    served.json<{ report: { reason: string } | null }>().report?.reason,
    'after-revert',
    'an undo must leave a comparison behind, and it must say what it happened because of',
  );
  const comparisons = store.events({}).filter((event) => event.kind.startsWith('config.'));
  assert.ok(comparisons.length >= 1, 'and the ring holds the answer, whatever its verdict');
});

/**
 * Measured on the bench board, 2026-09-23: the resolver follower fixed the core's resolver 4 s after
 * start-up, and `GET /api/drift` went on serving the boot-time red for fifteen minutes. A comparison
 * now follows every apply and every confirm, so the served report is never older than the last change.
 */
test('an apply, and a confirm, are each followed by a comparison the drift endpoint serves', async (t) => {
  const { app, store, close, headers } = await device('apply-drift');
  t.after(() => {
    void app.close();
    close();
  });
  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'A' } });
  store.setActiveProfileId(created.json<{ id: string }>().id);

  const applied = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  assert.equal(applied.statusCode, 200, applied.body);
  let served = await app.inject({ method: 'GET', url: '/api/drift', headers });
  assert.equal(served.json<{ report: { reason: string } | null }>().report?.reason, 'after-apply');

  const transaction = applied.json<{ transaction: { id: string; state: string } }>().transaction;
  if (transaction.state === 'awaiting-confirm') {
    const confirmed = await app.inject({ method: 'POST', url: `/api/transactions/${transaction.id}/confirm`, headers, payload: {} });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    served = await app.inject({ method: 'GET', url: '/api/drift', headers });
    assert.equal(served.json<{ report: { reason: string } | null }>().report?.reason, 'after-confirm');
  } else {
    assert.fail(`this profile's first apply was expected to open a window, and was ${transaction.state}; the confirm half proved nothing`);
  }
});

/**
 * The endpoint that answers the question, including before anybody has asked it.
 *
 * `report: null` has to survive the response schema and reach the client as null. A schema is a
 * serializer here: a key it does not declare is dropped from the body with no error and no log line,
 * and the reassuring reading of a missing key is "nothing diverged" — which is the silence this whole
 * mechanism exists to end.
 */
test('the drift endpoint says nobody has looked yet, and never that nothing diverged', async (t) => {
  const { app, close, headers } = await device('drift-endpoint');
  t.after(() => {
    void app.close();
    close();
  });

  const fresh = await app.inject({ method: 'GET', url: '/api/drift', headers });
  assert.equal(fresh.statusCode, 200, fresh.body);
  const body = fresh.json<{ report: unknown; ageSeconds: number | null; summary: string }>();
  assert.equal(body.report, null);
  assert.equal(body.ageSeconds, null);
  assert.match(body.summary, /has not yet been compared/);
  assert.doesNotMatch(body.summary, /matches its stored profile/);
});

/** And once a comparison has been made, every field of it reaches the client rather than most of them. */
test('a comparison that has been made is served whole, with both values on every finding', async (t) => {
  const { app, store, close, headers } = await device('drift-endpoint-full');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'D' } });
  store.setActiveProfileId(created.json<{ id: string }>().id);

  // Nothing has been written to this stand-in device, so every generated file is missing — which is a
  // divergence, and gives the endpoint a populated report to serialise.
  const applied = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  assert.equal(applied.statusCode, 200, applied.body);
  const firstId = applied.json<{ transaction: { id: string } }>().transaction.id;
  await app.inject({ method: 'POST', url: `/api/transactions/${firstId}/confirm`, headers, payload: {} });
  const second = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  const secondId = second.json<{ transaction: { id: string } }>().transaction.id;
  await app.inject({ method: 'POST', url: `/api/transactions/${secondId}/revert`, headers, payload: {} });

  const served = await app.inject({ method: 'GET', url: '/api/drift', headers });
  assert.equal(served.statusCode, 200, served.body);
  const body = served.json<{
    report: { state: string; reason: string; findings: { subject: string; pointer: string | null; stored: string | null; running: string | null; hint: string }[]; checked: { files: number } } | null;
    ageSeconds: number | null;
  }>();
  assert.ok(body.report !== null, 'the undo ran a comparison, so the endpoint must have one to serve');
  assert.equal(body.report.reason, 'after-revert');
  assert.equal(body.report.state, 'diverged');
  assert.ok(body.report.checked.files > 0);
  assert.ok(typeof body.ageSeconds === 'number');
  for (const finding of body.report.findings) {
    assert.ok(finding.subject.length > 0, 'a finding that names nothing is a log line with extra steps');
    assert.ok(finding.hint.length > 0);
    assert.ok('pointer' in finding && 'stored' in finding && 'running' in finding, 'both values must survive the schema');
  }
});

test('a committed transaction has no countdown — in the list, in the view and in the confirm, the same null', async (t) => {
  /*
   * Measured on the bench board, 2026-09-23: the confirm answered `secondsRemaining: null`, and
   * `GET /api/transactions` went on counting the same transaction down, because the row keeps the
   * deadline it had and the list derived a countdown from any row carrying one. A committed transaction
   * has no deadline, and one number reported two ways is the shape of G13.
   *
   * Mutation: in `windowCountdown`, drop the `state !== 'awaiting-confirm'` guard and this goes red
   * with a positive count in the list.
   */
  const { app, store, close, headers } = await device('committed-countdown');
  t.after(() => {
    void app.close();
    close();
  });
  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'C' } });
  store.setActiveProfileId(created.json<{ id: string }>().id);

  const applied = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  const id = applied.json<{ transaction: { id: string; state: string } }>().transaction.id;
  assert.equal(applied.json<{ transaction: { state: string } }>().transaction.state, 'awaiting-confirm');

  const confirmed = await app.inject({ method: 'POST', url: `/api/transactions/${id}/confirm`, headers });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json<{ transaction: { secondsRemaining: number | null } }>().transaction.secondsRemaining, null);

  const list = await app.inject({ method: 'GET', url: '/api/transactions', headers });
  const row = list.json<{ transactions: { id: string; state: string; secondsRemaining: number | null }[] }>().transactions.find((entry) => entry.id === id)!;
  assert.equal(row.state, 'committed');
  assert.equal(row.secondsRemaining, null, `the list counts a committed transaction down: ${row.secondsRemaining}`);

  const view = await app.inject({ method: 'GET', url: `/api/transactions/${id}`, headers });
  assert.equal(view.json<{ secondsRemaining: number | null }>().secondsRemaining, null);
});

test('a network apply arms a window, and the countdown is visible before anything is confirmed', async (t) => {
  const { app, store, close, headers, armed } = await device('apply-window');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'W' } });
  const id = created.json<{ id: string }>().id;
  store.setActiveProfileId(id);

  const applied = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  assert.equal(applied.statusCode, 200, applied.body);
  const transaction = applied.json<{
    transaction: { id: string; state: string; blastRadius: string; deadlineAt: string | null; secondsRemaining: number | null };
  }>().transaction;

  assert.equal(transaction.state, 'awaiting-confirm');
  assert.equal(transaction.blastRadius, 'network');
  assert.ok(transaction.deadlineAt !== null, 'a window with no deadline is not a window');
  /*
   * Most of the window still to run, expressed against the window rather than a literal — the literal
   * was `> 150`, which silently became "the whole window" when the window was derived down to 150s.
   */
  assert.ok(
    (transaction.secondsRemaining ?? 0) > (CONFIRMATION_WINDOW_MS / 1000) * 0.8,
    `countdown was ${transaction.secondsRemaining}`,
  );

  // Armed outside this process, with the command a fresh process would run. The unit name is stored
  // rather than recomputed, because a name computed twice can be computed differently twice and the
  // failure mode of that is a revert timer nothing can cancel.
  assert.equal(armed().length, 1);
  assert.match(armed()[0]!.unit, /^wayfarer-revert[@-]/);
  assert.deepEqual(armed()[0]!.argv, ['/usr/local/bin/way', 'revert', '--txn', transaction.id]);
  // Derived from the promise, not written down here: the timer must fire at the window, and the
  // window is the promise minus the allowance the revert itself needs.
  assert.equal(armed()[0]!.withinSeconds, CONFIRMATION_WINDOW_MS / 1000);

  // A second apply while one window is open is refused, naming the transaction and the time left. Two
  // armed timers mean the second fires against a document the operator already abandoned.
  const second = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json<{ error: { code: string } }>().error.code, 'confirmation_pending');

  // The countdown is on the transaction view too, so a client that reconnects mid-window picks it up
  // rather than discovering with seconds left that a deadline existed.
  const view = await app.inject({ method: 'GET', url: `/api/transactions/${transaction.id}`, headers });
  assert.ok((view.json<{ secondsRemaining: number | null }>().secondsRemaining ?? 0) > 100);
  // Neither document is returned: each is a whole profile with its secrets wrapped.
  assert.equal('documentBefore' in view.json<Record<string, unknown>>(), false);
  assert.equal('documentAfter' in view.json<Record<string, unknown>>(), false);

  // Confirming stops the timer and commits. Confirmation is a human act; nothing else produces it.
  const confirmed = await app.inject({ method: 'POST', url: `/api/transactions/${transaction.id}/confirm`, headers });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json<{ transaction: { state: string } }>().transaction.state, 'committed');
  assert.equal(store.events({ kind: 'apply.confirmed' }).length, 1);

  // And confirming twice is refused rather than silently accepted: the second caller is working from a
  // stale view and is entitled to know.
  const again = await app.inject({ method: 'POST', url: `/api/transactions/${transaction.id}/confirm`, headers });
  assert.equal(again.statusCode, 409, again.body);
});

test('a dry run is the normal path with the last step omitted', async (t) => {
  const { app, store, close, headers } = await device('dry-run');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'D' } });
  const id = created.json<{ id: string }>().id;
  store.setActiveProfileId(id);

  const dry = await app.inject({ method: 'POST', url: '/api/apply?dryRun=1', headers, payload: {} });
  assert.equal(dry.statusCode, 200, dry.body);
  assert.equal(dry.json<{ dryRun: boolean }>().dryRun, true);
  // Nothing was recorded as an apply, because nothing was applied.
  assert.equal(store.events({ kind: 'apply.started' }).length, 0);
});

/* ── the definition of done ──────────────────────────────────────────────────────────────── */

test('built from nothing, applied, exported redacted, imported elsewhere, gaps listed', async (t) => {
  const first = await device('done-a');
  const second = await device('done-b');
  t.after(() => {
    void first.app.close();
    first.close();
    void second.app.close();
    second.close();
  });

  /* 1. Built in the interface from nothing. */
  const created = await first.app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: first.headers,
    payload: { name: 'Shared' },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json<{ id: string }>().id;

  const blank = (
    await first.app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers: first.headers })
  ).json<{ document: Record<string, unknown> }>().document;

  const filled = await first.app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers: first.headers,
    payload: {
      ...blank,
      accessPoint: {
        // The access point on the dongle and the client on the built-in radio: the only arrangement
        // this hardware permits, since managed and AP share a budget of one on each radio.
        bind: { by: 'phy-usb', value: '0e8d:7961' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
        ssid: 'Wayfarer',
        passphrase: 'the-access-point-passphrase',
        acceptChannelFollowsUplink: false,
      },
      uplinks: [
        {
          id: 'wan-wifi',
          kind: 'wifi-sta',
          priority: 10,
          enabled: true,
          bind: { by: 'phy-builtin' },
          config: { ssid: 'Upstream', psk: 'the-upstream-passphrase' },
        },
      ],
    },
  });
  assert.equal(filled.statusCode, 200, filled.body);

  /* 2. Applied. This profile contains a network change, so it goes through the confirmation window. */
  first.store.setActiveProfileId(id);
  const applied = await first.app.inject({ method: 'POST', url: '/api/apply', headers: first.headers, payload: {} });
  assert.equal(applied.statusCode, 200, applied.body);
  const appliedBody = applied.json<{ transaction: { id: string; state: string; secondsRemaining: number | null } }>();
  assert.equal(appliedBody.transaction.state, 'awaiting-confirm');
  // Against the window, not a literal: `> 150` was most of a 180s window and is more than all of a
  // derived 150s one, so it became unsatisfiable the moment the window followed the promise. The
  // failure then looked like a hang rather than an assertion, because the armed window watcher was
  // still polling when the test threw.
  assert.ok((appliedBody.transaction.secondsRemaining ?? 0) > (CONFIRMATION_WINDOW_MS / 1000) * 0.8);

  // Confirmed, because this is the definition-of-done walk and an unconfirmed change would revert.
  const confirmed = await first.app.inject({
    method: 'POST',
    url: `/api/transactions/${appliedBody.transaction.id}/confirm`,
    headers: first.headers,
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);

  // The safe part on its own, asked for explicitly, applies and reports what it left out.
  const safePart = await first.app.inject({
    method: 'POST',
    url: '/api/apply',
    headers: first.headers,
    payload: { classes: ['hot', 'service'] },
  });
  assert.equal(safePart.statusCode, 200, safePart.body);
  const safeBody = safePart.json<{ transaction: { state: string }; refused: unknown[] }>();
  // hot and service go straight to committed: no confirmation window, because neither can cost access.
  assert.equal(safeBody.transaction.state, 'committed');

  /* 3. Exported with secrets redacted. */
  const exported = await first.app.inject({
    method: 'GET',
    url: `/api/profiles/${id}/export`,
    headers: first.headers,
  });
  assert.equal(exported.statusCode, 200);
  const shared = exported.json<{ document: Record<string, unknown>; secretsIncluded: boolean }>();
  assert.equal(shared.secretsIncluded, false);
  assert.equal(exported.body.includes('the-access-point-passphrase'), false);
  assert.equal(exported.body.includes('the-upstream-passphrase'), false);
  // The redaction carries what a person must go and find, not free text.
  assert.deepEqual((shared.document['accessPoint'] as { passphrase: unknown }).passphrase, { $redacted: 'psk' });

  /* 4. Imported on a second device, which lists exactly what is missing. */
  const imported = await second.app.inject({
    method: 'POST',
    url: '/api/profiles/import',
    headers: second.headers,
    payload: { document: shared.document },
  });
  assert.equal(imported.statusCode, 201, imported.body);
  const report = imported.json<{
    id: string;
    missingSecrets: { pointer: string; kind: string }[];
    activatable: boolean;
  }>();

  assert.deepEqual(
    report.missingSecrets.map((entry) => entry.pointer).sort(),
    ['/accessPoint/passphrase', '/uplinks/0/config/psk'],
    'the second device must list exactly which secrets are missing',
  );
  assert.equal(report.missingSecrets.every((entry) => entry.kind === 'psk'), true);
  assert.equal(report.activatable, false);

  /* 5. And it refuses to activate until they are filled, naming them rather than failing later. */
  const activate = await second.app.inject({
    method: 'POST',
    url: `/api/profiles/${report.id}/activate`,
    headers: second.headers,
  });
  assert.equal(activate.statusCode, 422, activate.body);
  const refusal = activate.json<{ error: { code: string; pointer: string; detail: { missingSecrets: unknown[] } } }>();
  assert.equal(refusal.error.code, 'secrets_missing');
  assert.equal(refusal.error.detail.missingSecrets.length, 2);

  /* 6. The structure transferred, which is the point of importing rather than rejecting. */
  const onSecond = (
    await second.app.inject({ method: 'GET', url: `/api/profiles/${report.id}`, headers: second.headers })
  ).json<{ document: Record<string, unknown> }>().document;
  assert.equal((onSecond['accessPoint'] as { ssid: string }).ssid, 'Wayfarer');
  assert.equal((onSecond['uplinks'] as { config: { ssid: string } }[])[0]?.config.ssid, 'Upstream');
});

test('a document from a newer version is refused with both version numbers', async (t) => {
  const { app, close, headers } = await device('future');
  t.after(() => {
    void app.close();
    close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/profiles/import',
    headers,
    payload: { document: { schemaVersion: 99, meta: { name: 'x' } } },
  });
  assert.equal(response.statusCode, 400);
  const error = response.json<{ error: { code: string; detail: { found: number; supported: number } } }>().error;
  assert.equal(error.code, 'schema_version_unsupported');
  assert.equal(error.detail.found, 99);
  // Refused rather than accepted with the unknown parts dropped: a dropped routing rule sends traffic
  // somewhere nobody intended.
  assert.ok(error.detail.supported < 99);
});

/* ── the schema a form was built from, and the route that served it ──────────────────────── */

/*
 * Two tests were here, and they are **deleted with the thing they tested**.
 *
 * `a served provider schema is self-contained` and `every protocol the device offers resolves to a form
 * from the served schema alone` both exercised `GET /api/schemas/tunnel/:provider` — the route that fed
 * the generic renderer. They were good tests of a real defect: the route once returned `$defs.Outbound`
 * on its own, its branches full of `#/$defs/Duration` references that resolved against a root nobody
 * sent, and the interface showed a resolver error in place of every form. No unit test caught it because
 * the resolver takes the root and the union as two arguments while the API has one thing to return.
 *
 * The renderer is gone and so is the route. What replaces the tests is the assertion below, which is
 * about the deletion rather than about the schema: a path that 404s cannot quietly come back.
 */

test('there is no per-protocol schema route, because there is no generic renderer to feed', async (t) => {
  const { app, close, headers } = await device('no-schema-route');
  t.after(() => {
    void app.close();
    close();
  });

  for (const path of ['/api/schemas/tunnel/vless', '/api/schemas/tunnel/singbox-outbound', '/api/schemas/tunnel/raw']) {
    const response = await app.inject({ method: 'GET', url: path, headers });
    assert.equal(response.statusCode, 404, `${path} answered ${response.statusCode}`);
  }

  // The document schema stays. It describes what a profile *is*, which is not a way around the
  // catalogue — and with the catalogue typed into it, it is where a screen's fields come from.
  const profileSchema = await app.inject({ method: 'GET', url: '/api/schemas/profile', headers });
  assert.equal(profileSchema.statusCode, 200);
});

/* ── a tunnel credential, all the way round ──────────────────────────────────────────────── */

test('a tunnel secret is stored wrapped, never returned, and redacted on export', async (t) => {
  // The critical defect this covers: matchers came from the static profile schema, and a tunnel's
  // `config` is an opaque record — so nothing covered `/tunnels/*/config/*`. A VLESS uuid was stored
  // bare, returned by GET, and shipped in clear by the export that exists to be shared.
  //
  // The existing tests only ever exercised `accessPoint.passphrase`, which the static schema does
  // declare, so all of them passed while every tunnel credential leaked.
  const { app, close, headers } = await device('tunnel-secret');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Tunnelled' } });
  const id = created.json<{ id: string }>().id;
  const blank = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  const saved = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...blank,
      tunnels: [
        {
          id: 'alt-a',
          name: 'Warsaw',
          role: 'alternative',
          onUnavailable: 'block',
          enabled: true,
          protocol: 'vless',
          config: {
            server: '198.51.100.7',
            port: 443,
            id: 'the-tunnel-credential',
            network: 'tcp',
            security: 'tls',
          },
        },
      ],
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);

  /* A read never carries it. */
  const read = await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers });
  assert.equal(read.body.includes('the-tunnel-credential'), false, 'a tunnel credential came back from a GET');
  const document = read.json<{ document: { tunnels: { config: { id: unknown } }[] } }>().document;
  assert.deepEqual(document.tunnels[0]!.config.id, { $set: true });

  /* A redacted export never carries it, and names what is missing. */
  const exported = await app.inject({ method: 'GET', url: `/api/profiles/${id}/export`, headers });
  assert.equal(exported.body.includes('the-tunnel-credential'), false, 'a tunnel credential was exported in clear');
  const shared = exported.json<{
    document: { tunnels: { config: { id: unknown } }[] };
    leavingInClear: { pointer: string }[];
  }>();
  // `uuid`, the kind the catalogue's own schema declares — not the generic `secret` a name rule gave it
  // when the configuration was opaque. The import checklist reads this to say what to go and find.
  assert.deepEqual(shared.document.tunnels[0]!.config.id, { $redacted: 'uuid' });
  assert.deepEqual(
    shared.leavingInClear.filter((entry) => entry.pointer.endsWith('/config/id')),
    [],
  );

  /* A full export does carry it — that is what it is for — and says so before producing the file. */
  const full = await app.inject({ method: 'GET', url: `/api/profiles/${id}/export?secrets=include`, headers });
  assert.ok(full.body.includes('the-tunnel-credential'));

  /* And $keep survives a save that does not mention it. */
  const again = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...blank,
      tunnels: [
        {
          id: 'alt-a',
          name: 'Warsaw renamed',
          role: 'alternative',
          onUnavailable: 'block',
          enabled: true,
          protocol: 'vless',
          config: {
            server: '198.51.100.7',
            port: 443,
            id: { $keep: true },
            network: 'tcp',
            security: 'tls',
          },
        },
      ],
    },
  });
  assert.equal(again.statusCode, 200, again.body);
  const stillThere = await app.inject({ method: 'GET', url: `/api/profiles/${id}/export?secrets=include`, headers });
  assert.ok(stillThere.body.includes('the-tunnel-credential'), 'the stored tunnel secret was lost by a $keep write');

  /*
   * And a write that simply **leaves the secret out** is refused rather than accepted without it.
   *
   * This is the failure that happened, on the owner's live profile, on 2026-09-21: six stored secrets
   * were dropped by one API write, five of them the `uid` of an obfuscation entry point. The sequence
   * was ordinary — a client read the document, found `{"$set": …}` where a value should be, learned
   * that `{"$keep": true}` was refused at that pointer, and did the only remaining thing. Nothing said
   * a word, and the stored document was wrong from that moment on.
   *
   * `$keep` now resolves at that pointer, so the immediate cause is gone. This asserts the floor
   * underneath it: omission is not a way to delete a credential by accident.
   */
  const omitted = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...blank,
      tunnels: [
        {
          id: 'alt-a',
          name: 'Warsaw',
          role: 'alternative',
          onUnavailable: 'block',
          enabled: true,
          protocol: 'vless',
          config: { server: '198.51.100.7', port: 443, network: 'tcp', security: 'tls' },
        },
      ],
    },
  });
  assert.equal(omitted.statusCode, 400, omitted.body);
  const refusal = omitted.json<{ error: { code: string; pointer: string; detail: { errors: unknown[] } } }>().error;
  assert.equal(refusal.code, 'invalid_secret_write');
  assert.equal(refusal.pointer, '/tunnels/0/config/id');

  // And the stored value is still there, because a refused write changes nothing.
  const survived = await app.inject({ method: 'GET', url: `/api/profiles/${id}/export?secrets=include`, headers });
  assert.ok(survived.body.includes('the-tunnel-credential'), 'a refused write must leave the stored document alone');
});

/*
 * Reversed on 2026-09-24 (G30 round 2). This asserted that an unmarked `server` value is reported,
 * "because the detector cannot know that a value nobody marked is safe". Since the catalogue, every
 * field is typed and every secret is marked, so an unmarked string is an ordinary field — and reporting
 * every one of them made the board log a redaction warning on every export, twenty host names and method
 * names at a time. The detector now reports what reads as a secret; the case it must catch is proved in
 * "the check reports what would really leave".
 */
test('an ordinary unmarked value in a tunnel configuration is not reported as leaving in clear', async (t) => {
  // Defence in depth for the whole secret design: detection can be incomplete — a protocol nobody has
  // annotated, a schema that would not resolve — and every one of those shows up here rather than
  // leaking. The first version of this check listed values that were already *wrapped*, so it warned
  // about the safe ones and stayed silent about the dangerous ones.
  const { app, close, headers } = await device('unwrapped-warning');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Raw' } });
  const id = created.json<{ id: string }>().id;
  const blank = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...blank,
      tunnels: [
        {
          id: 'alt-a',
          name: 'Warsaw',
          role: 'alternative',
          onUnavailable: 'block',
          enabled: true,
          /*
           * A catalogue tunnel, and it has to be: this fixture was `provider: 'singbox-outbound'`
           * with a proxy-core outbound as its `config` — the version-6 shape, which the profile
           * schema has had no branch for since E3. Nothing refused it only because nothing applied
           * the schema on a write, so the scenario this test measured was one no client could
           * actually reach. What it asserts is unchanged: `server` is not a secret and is not
           * wrapped, which is correct, and it is exactly what the detector reports — it cannot know
           * that a value nobody marked is safe.
           */
          protocol: 'vless',
          config: { server: '198.51.100.7', port: 443, id: 'an-account', network: 'tcp', security: 'tls' },
        },
      ],
    },
  });

  const exported = await app.inject({ method: 'GET', url: `/api/profiles/${id}/export`, headers });
  const leaving = exported.json<{ leavingInClear: { pointer: string; field: string }[] }>().leavingInClear;
  assert.deepEqual(leaving, [], `an ordinary field was reported as a leak: ${JSON.stringify(leaving)}`);
});

/* ── the apply order, asserted from a transcript ──────────────────────────────────────────── */

test('the network apply order holds: claims, then addressing, then sysctl, then firewall, then time', async (t) => {
  // Every entry in this order earned its position from a failure that is silent when the order is
  // wrong, and none of them is visible in the result — only in the sequence. So this asserts the
  // sequence. Reading the reconciler and believing the comments is how the ordering rots.
  const { app, store, close, headers, trace } = await device('order');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'O' } });
  const id = created.json<{ id: string }>().id;
  const current = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...current,
      accessPoint: {
        bind: { by: 'phy-usb', value: '0e8d:7961' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
        ssid: 'Wayfarer',
        passphrase: 'a-real-passphrase',
        acceptChannelFollowsUplink: false,
      },
    },
  });
  store.setActiveProfileId(id);

  const applied = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  assert.equal(applied.statusCode, 200, applied.body);

  const steps = applied.json<{ steps: { step: string }[] }>().steps.map((entry) => entry.step);
  const at = (pattern: RegExp): number => steps.findIndex((step) => pattern.test(step));

  const validated = at(/^validate: firewall ruleset/);
  const wroteRuleset = at(/^write \/etc\/wayfarer\/nftables\.conf/);
  const reloaded = at(/^reload network configuration/);
  const settled = at(/^wait for addressing to settle/);
  const forwarding = at(/^set net\.ipv4\.ip_forward/);
  const loadedRuleset = at(/^load the firewall ruleset/);
  const ready = at(/^mark the firewall ready/);
  const timeSync = at(/^restart systemd-timesyncd/);
  const accessPoint = at(/^start wf-hostapd@/);

  for (const [name, index] of Object.entries({ validated, wroteRuleset, reloaded, settled, forwarding, loadedRuleset, ready, timeSync, accessPoint })) {
    assert.ok(index >= 0, `step "${name}" never ran:\n${steps.join('\n')}`);
  }

  // Validation before any write: a ruleset that will not parse must fail before anything is touched.
  assert.ok(validated < wroteRuleset, 'the ruleset was written before it was checked');
  // Addressing settles before the units that bind to it start: hostapd binding an interface with no
  // address fails permanently, and the restart policy then papers over it noisily.
  assert.ok(reloaded < settled && settled < accessPoint, 'the access point started before addressing settled');
  // Forwarding before the ruleset loads: a rule whose premise is not yet true drops the first packets.
  assert.ok(forwarding < loadedRuleset, 'the firewall loaded before forwarding was enabled');
  // **Time after the firewall, never before.** The bypass that lets a time query out is a firewall
  // rule, so without it the first query goes into the tunnel and is lost — and a wrong clock makes
  // every timestamp-authenticated transport fail while direct connections work normally, which reads
  // as broken tunnels rather than as a broken clock.
  assert.ok(loadedRuleset < timeSync, 'time synchronisation was restarted before the firewall was loaded');
  assert.ok(ready < accessPoint, 'the access point started before the firewall was marked ready');
});

test('an unsettled link is reported and is not an apply failure', async (t) => {
  // The stand-in always reports "not settled". An uplink that is simply absent — no cable, an access
  // point out of range — is a valid state, and treating a slow lease as a failed apply would make the
  // outcome depend on the weather. The window is where a link that never comes up is caught, by a
  // check that knows the difference between "not yet" and "not at all".
  const { app, store, close, headers } = await device('unsettled');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'U' } });
  const id = created.json<{ id: string }>().id;
  const current = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;
  // An access point, because that is what produces a `.network` file and therefore an interface whose
  // addressing has to settle. The emptiest profile generates none, so the settle step is correctly
  // skipped for it — which is itself worth knowing and is why this test says which profile it needs.
  await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...current,
      accessPoint: {
        bind: { by: 'phy-usb', value: '0e8d:7961' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
        ssid: 'Wayfarer',
        passphrase: 'a-real-passphrase',
        acceptChannelFollowsUplink: false,
      },
    },
  });
  store.setActiveProfileId(id);

  const applied = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  assert.equal(applied.statusCode, 200, applied.body);
  const step = applied.json<{ steps: { step: string; ok: boolean; detail: string }[] }>().steps.find((entry) =>
    /wait for addressing/.test(entry.step),
  );
  assert.ok(step !== undefined);
  // Recorded as succeeded, with the truth in the detail. A step that failed here would abort an apply
  // for something that is not a fault.
  assert.equal(step.ok, true);
  assert.match(step.detail, /not settled in time/);
});

test('an access-point interface is not asked for a carrier it cannot have yet', async (t) => {
  // Measured on the bench board: the first network apply spent the full twenty-second settle timeout
  // and then reported `carrier=false address=10.44.0.1` for a perfectly healthy access-point
  // interface. An access point has **no carrier until hostapd starts**, and hostapd starts later in
  // the apply order — so demanding one there can never succeed, wastes twenty seconds on every apply,
  // and calls a working interface broken. The `.network` file already says `RequiredForOnline=no` for
  // exactly this reason.
  const { app, store, close, headers, trace } = await device('settle-expectations');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'S' } });
  const id = created.json<{ id: string }>().id;
  const current = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...current,
      accessPoint: {
        bind: { by: 'phy-usb', value: '0e8d:7961' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
        ssid: 'Wayfarer',
        passphrase: 'a-real-passphrase',
        acceptChannelFollowsUplink: false,
      },
      uplinks: [
        { id: 'wan-eth', kind: 'ethernet', priority: 10, enabled: true, bind: { by: 'any-ethernet' }, config: { dhcp: true } },
      ],
    },
  });
  store.setActiveProfileId(id);

  await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });

  const waited = trace().find((line) => line.startsWith('net:wait'));
  assert.ok(waited !== undefined, `the settle step never ran:\n${trace().join('\n')}`);
  // The access point needs an address only; the DHCP uplink has to be genuinely connected to be useful,
  // so it needs both. One definition of "up" is wrong for half of them.
  assert.match(waited, /wlan1\/address/);
  assert.match(waited, /end0\/carrier-and-address/);
});

/* ── subscriptions ───────────────────────────────────────────────────────────────────────── */

test('parsing a subscription returns tunnel drafts and stores nothing', async (t) => {
  // Parsing is not importing. The caller reviews what came back, names the tunnels and decides which to
  // keep; only a profile write stores anything, which is also where the secret wrapper goes on. Storing
  // here would put credentials in the database on the strength of a paste nobody had looked at.
  const { app, close, headers } = await device('subscriptions');
  t.after(() => {
    void app.close();
    close();
  });

  const body = [
    'vless://11111111-2222-3333-4444-555555555555@vless.example.com:443?security=tls&sni=vless.example.com&type=ws&path=%2Fws#First',
    'socks5://someone@proxy.example.com:1080#Unhandled',
  ].join('\n');

  const response = await app.inject({
    method: 'POST',
    url: '/api/subscriptions/parse',
    headers,
    payload: { text: body },
  });
  assert.equal(response.statusCode, 200, response.body);

  const parsed = response.json<{
    nodes: { protocol: string; name: string; scheme: string; config: Record<string, unknown> }[];
    failures: { line: number; scheme: string | null; reason: string; excerpt: string }[];
  }>();

  assert.equal(parsed.nodes.length, 1);
  /*
   * A draft is `{ protocol, config }` — the pair a stored tunnel is made of.
   *
   * It used to be `{ provider: 'singbox-outbound', config: <a proxy-core outbound> }`, and schema 7 has
   * no branch for that, so every draft this route returned could only be refused at the write. The route
   * that turns a paste into tunnels produced tunnels nothing could store: "outside the catalogue there
   * is nothing", broken from the other end. So this assertion is the fix, not a rename.
   */
  assert.equal(parsed.nodes[0]!.protocol, 'vless');
  assert.equal(parsed.nodes[0]!.name, 'First');
  assert.equal(parsed.nodes[0]!.config['server'], 'vless.example.com');
  assert.equal(parsed.nodes[0]!.config['network'], 'ws');
  assert.equal('provider' in parsed.nodes[0]!, false, 'a provider id is not part of a tunnel any more');


  // Reported, not skipped, with its position — and the refusal names what this product does run, because
  // a refusal naming only what it rejected is a riddle.
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0]!.scheme, 'socks5');
  assert.equal(parsed.failures[0]!.line, 2);
  assert.match(parsed.failures[0]!.reason, /OpenVPN, Cloak \+ OpenVPN, VLESS/);

  // And nothing was stored: the profile list is untouched.
  const profiles = await app.inject({ method: 'GET', url: '/api/profiles', headers });
  assert.equal(profiles.json<{ profiles: unknown[] }>().profiles.length, 0);

  // And the draft is one a profile write accepts: proven by storing it, rather than by inspecting it.
  const write = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers,
    payload: {
      name: 'from-a-subscription',
      document: {
        ...emptyProfile(),
        tunnels: [
          {
            id: 'from-link',
            name: parsed.nodes[0]!.name,
            role: 'alternative',
            onUnavailable: 'block',
            enabled: true,
            protocol: parsed.nodes[0]!.protocol,
            config: parsed.nodes[0]!.config,
          },
        ],
      },
    },
  });
  assert.equal(write.statusCode, 201, `a parsed draft must be storable: ${write.body}`);
});

test('a read-only token cannot parse a subscription', async (t) => {
  // The body is a credential-bearing blob and the response contains those credentials in clear, which is
  // unavoidable — it is what the caller pasted and what they need in order to check it. So the route needs
  // `apply`, and a read token has no business there.
  const { app, store, close } = await device('subscriptions-scope');
  t.after(() => {
    void app.close();
    close();
  });

  const readOnly = store.createToken('reader', ['read']).token;
  const response = await app.inject({
    method: 'POST',
    url: '/api/subscriptions/parse',
    headers: { authorization: `Bearer ${readOnly}` },
    payload: { text: 'vless://u@h:443#x' },
  });
  assert.equal(response.statusCode, 403, response.body);
});

test('a directory this plan cannot write to stops it before anything is attempted', async (t) => {
  // The defect this replaces got much further than a refused write. A `network` apply was planned,
  // accepted, given a transaction, given a confirmation window and a revert timer, and *then* failed with
  // EROFS on a directory the sandbox had never allowed — a permission knowable before anything moved.
  //
  // The general form is the fix: a sandbox's writable set and a planner's intentions are two descriptions
  // of what we may touch, and they drift. So the plan names every directory it needs and this is proven
  // first.
  const { app, store, close, headers, armed, trace } = await device('unwritable', {
    unwritable: ['/etc/wayfarer/hostapd'],
  });
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'W' } });
  const id = created.json<{ id: string }>().id;
  const current = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;
  await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...current,
      accessPoint: {
        bind: { by: 'phy-usb', value: '0e8d:7961' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'DE', hidden: false },
        ssid: 'Wayfarer',
        passphrase: 'a-real-passphrase',
        acceptChannelFollowsUplink: false,
      },
    },
  });
  store.setActiveProfileId(id);

  const applied = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
  assert.equal(applied.statusCode, 500, applied.body);
  const error = applied.json<{ error: { code: string; message: string; hint: string } }>().error;
  assert.equal(error.code, 'path_not_writable');
  // The directory, the reason and what it was needed for — because EROFS and EACCES need different fixes
  // and a message that flattened them would send somebody to the wrong one.
  assert.match(error.message, /\/etc\/wayfarer\/hostapd/);
  assert.match(error.message, /EROFS/);
  assert.match(error.hint, /ReadWritePaths/);

  // Nothing was written, and no revert timer was consumed finding out.
  assert.equal(
    trace().some((line) => line.startsWith('write:')),
    false,
    `something was written despite the refusal:\n${trace().join('\n')}`,
  );
  assert.equal(armed().length, 0, 'a revert timer was armed for an apply that never started');
});

/**
 * `/api/protocols` answers, and its body speaks the same word as its path.
 *
 * The route was `/api/providers` until 2026-09-21, named after a registry deleted in E4. Renaming it
 * without renaming the response key would have split one fact across two vocabularies, which is the
 * thing the rename was for, so both are asserted and either one reverted turns this red.
 *
 * It is a test of its own rather than three lines inside the scope test, for the reason that
 * motivated the rename: a check should be named for what it asserts.
 */
test('/api/protocols answers, and its body is not still called providers', async (t) => {
  const { app, store, close } = await device('protocols-route');
  t.after(() => {
    void app.close();
    close();
  });

  const headers = { authorization: `Bearer ${store.createToken('read-only', ['read']).token}` };
  const response = await app.inject({ method: 'GET', url: '/api/protocols', headers });

  assert.equal(response.statusCode, 200, response.body);
  const listed = response.json<{ protocols?: unknown[]; providers?: unknown[] }>();
  assert.ok(
    Array.isArray(listed.protocols) && listed.protocols.length > 0,
    `the catalogue walk returned nothing, so this would pass against a device that runs no ` +
      `protocol at all: ${response.body}`,
  );
  assert.equal(
    listed.providers,
    undefined,
    'the body still speaks the vocabulary the route stopped using',
  );
});

/* ── a stored document this build cannot bring forward ───────────────────────────────────── */

/**
 * Writes a row an earlier build could store and this one cannot read.
 *
 * Version 6's `provider` was an open string, so a tunnel naming anything is **ordinary prior
 * state**. Migration is lazy-on-read, so nothing announces it at boot; the first symptom is a read.
 */
function storeUnreadableRow(database: ReturnType<typeof openDatabase>, id: string, name: string): void {
  const document = {
    schemaVersion: 6,
    meta: { name },
    tunnels: [
      {
        id: 'legacy',
        name: 'A tunnel from before',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        provider: 'wireguard',
        config: { privateKey: { $secret: 'not-a-real-key' } },
      },
    ],
  };
  const at = new Date().toISOString();
  database.raw
    .prepare(
      'INSERT INTO profiles (id, name, document, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, name, JSON.stringify(document), 6, at, at);
}

/**
 * One row this build cannot migrate must not take the list with it.
 *
 * The defect this asserts against: `toRow` ran `migrateProfile` with nothing around it, on every
 * read, so a single v6 tunnel naming a provider outside the catalogue made `GET /api/profiles`
 * answer 500 **for every profile on the device** — and since `delete` is the one path that does not
 * read the document, the operator could not learn which id to delete either.
 */
test('one unreadable profile does not take the list down, and says which one it is', async (t) => {
  const { app, store, database, close, headers } = await device('unreadable-list');
  t.after(() => {
    void app.close();
    close();
  });

  const good = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Readable' } });
  assert.equal(good.statusCode, 201, good.body);
  storeUnreadableRow(database, 'legacy-row', 'From before');

  const listed = await app.inject({ method: 'GET', url: '/api/profiles', headers });
  assert.equal(listed.statusCode, 200, `the list answered ${listed.statusCode}: ${listed.body}`);

  const profiles = listed.json<{
    profiles: { id: string; name: string; fault?: { code: string; message: string; hint: string } }[];
  }>().profiles;
  assert.equal(profiles.length, 2, `the readable row went missing with the unreadable one: ${listed.body}`);

  const broken = profiles.find((entry) => entry.id === 'legacy-row');
  assert.ok(broken, 'the unreadable row is not in the list, so its id cannot be seen');
  assert.equal(broken.fault?.code, 'profile_catalogue_unsupported');
  assert.match(broken.fault?.message ?? '', /wireguard/, 'the refusal does not name what the tunnel named');
  assert.match(broken.fault?.hint ?? '', /DELETE \/api\/profiles/, 'the refusal does not say what can be done');

  const readable = profiles.find((entry) => entry.id !== 'legacy-row');
  assert.equal(readable?.fault, undefined, 'a readable row was marked faulty');
});

/** Reading the one profile is a refusal that names it, not a 500 with nothing in it. */
test('reading an unreadable profile refuses by name rather than failing', async (t) => {
  const { app, database, close, headers } = await device('unreadable-get');
  t.after(() => {
    void app.close();
    close();
  });

  storeUnreadableRow(database, 'legacy-row', 'From before');

  const response = await app.inject({ method: 'GET', url: '/api/profiles/legacy-row', headers });
  assert.equal(response.statusCode, 409, `expected a refusal, got ${response.statusCode}: ${response.body}`);
  const body = response.json<{ error: { code: string; hint?: string; detail?: { profileId?: string } } }>();
  assert.equal(body.error.code, 'profile_catalogue_unsupported');
  assert.equal(body.error.detail?.profileId, 'legacy-row');
  assert.match(body.error.hint ?? '', /Nothing has stopped/);
});

/** The way out has to work, and it is the only path that never reads the document. */
test('an unreadable profile can still be deleted', async (t) => {
  const { app, database, close, headers } = await device('unreadable-delete');
  t.after(() => {
    void app.close();
    close();
  });

  storeUnreadableRow(database, 'legacy-row', 'From before');
  const deleted = await app.inject({ method: 'DELETE', url: '/api/profiles/legacy-row', headers });
  assert.equal(deleted.statusCode, 200, deleted.body);

  const listed = await app.inject({ method: 'GET', url: '/api/profiles', headers });
  assert.equal(listed.json<{ profiles: unknown[] }>().profiles.length, 0);
});

/* ── the catalogue, enforced on the way in (E5) ──────────────────────────────────────────── */

/**
 * E5 is *"import and storage refuse a profile naming anything outside the catalogue, saying which
 * tunnel and which protocol"*, and it was unimplemented at the only layer that matters.
 *
 * All three write routes declared `body: Type.Unknown()`; the only check between a request and the
 * database was a four-key structural one whose own comment said Fastify was compiling the union for
 * request bodies. Measured over HTTP before the fix: this `PUT` answered **200** and the import
 * below answered **201 with `activatable: true`**, for documents the planner refuses at
 * `/tunnels/0/protocol`.
 *
 * Asserted over HTTP rather than against the validator, because the validator existing and the
 * validator being reached are exactly the two things this defect could tell apart.
 */
for (const protocol of ['wireguard', 'shadowsocks']) {
  test(`PUT refuses a tunnel naming "${protocol}", and says what it does run`, async (t) => {
    const { app, close, headers } = await device(`put-${protocol}`);
    t.after(() => {
      void app.close();
      close();
    });

    const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'P' } });
    const id = created.json<{ id: string }>().id;
    const blank = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
      document: Record<string, unknown>;
    }>().document;

    const written = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${id}`,
      headers,
      payload: {
        ...blank,
        tunnels: [
          {
            id: 'alt-a',
            name: 'Elsewhere',
            role: 'alternative',
            onUnavailable: 'block',
            enabled: true,
            protocol,
            config: { server: '198.51.100.7', port: 443 },
          },
        ],
      },
    });

    assert.equal(written.statusCode, 400, `the union was not enforced: ${written.body}`);
    const error = written.json<{ error: { code: string; message: string; pointer: string } }>().error;
    assert.equal(error.code, 'tunnel_protocol_unknown');
    assert.equal(error.pointer, '/tunnels/0/protocol', 'the refusal does not say which tunnel');
    assert.match(error.message, new RegExp(protocol), 'the refusal does not say which protocol');
    // A refusal naming only what was rejected is a riddle. The accepted half is derived from the
    // catalogue, so the two cannot drift.
    assert.match(error.message, /OpenVPN/, 'the refusal does not say what is accepted');
  });
}

/**
 * The import route, and the claim that made its answer a false statement.
 *
 * `activatable` answered `missingSecrets.length === 0` — "every secret is present" — under a name
 * that says "this will run". It is now the planner's own verdict on the stored document.
 */
test('import refuses a protocol outside the catalogue rather than reporting it activatable', async (t) => {
  const { app, close, headers } = await device('import-unknown');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Source' } });
  const id = created.json<{ id: string }>().id;
  const exported = (await app.inject({ method: 'GET', url: `/api/profiles/${id}/export`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  const response = await app.inject({
    method: 'POST',
    url: '/api/profiles/import',
    headers,
    payload: {
      document: {
        ...exported,
        tunnels: [
          {
            id: 'alt-a',
            name: 'Elsewhere',
            role: 'alternative',
            onUnavailable: 'block',
            enabled: true,
            protocol: 'wireguard',
            config: { server: '198.51.100.7', port: 51820 },
          },
        ],
      },
    },
  });

  assert.equal(response.statusCode, 400, `the import stored a protocol this device does not run: ${response.body}`);
  const error = response.json<{ error: { code: string; pointer: string } }>().error;
  assert.equal(error.code, 'tunnel_protocol_unknown');
  assert.equal(error.pointer, '/tunnels/0/protocol');
});

/**
 * A configuration the catalogue entry cannot accept, on the tunnel the entry crashes on.
 *
 * `cloak-openvpn` with `config: {}` reached the entry's planner and raised an uncaught `TypeError`
 * — a stack trace in the journal instead of a refusal carrying a pointer. The write is the right
 * place to stop it: an entry that must defend itself against a document the schema already
 * describes is a second copy of the schema.
 */
test('a configuration its own catalogue entry cannot accept is refused at the write', async (t) => {
  const { app, close, headers } = await device('empty-config');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'C' } });
  const id = created.json<{ id: string }>().id;
  const blank = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  const written = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...blank,
      tunnels: [
        {
          id: 'alt-a',
          name: 'Berlin',
          role: 'alternative',
          onUnavailable: 'block',
          enabled: true,
          protocol: 'cloak-openvpn',
          config: {},
        },
      ],
    },
  });

  assert.equal(written.statusCode, 400, `an empty configuration was stored: ${written.body}`);
  const error = written.json<{ error: { code: string; pointer: string } }>().error;
  assert.equal(error.code, 'tunnel_invalid');
  assert.match(error.pointer, /^\/tunnels\/0\/config\//, `the refusal does not name a field: ${written.body}`);
});

/**
 * A profile that is genuinely a profile still goes in, and the import's claim is the planner's.
 *
 * The anchor. Without it, every assertion above is satisfied by a gate that refuses everything —
 * which is the cheapest way to make a validation suite green and the least useful.
 */
test('a valid catalogue tunnel is still accepted', async (t) => {
  const { app, close, headers } = await device('valid-write');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Good' } });
  const id = created.json<{ id: string }>().id;
  const blank = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  const written = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...blank,
      tunnels: [
        {
          id: 'alt-a',
          name: 'Warsaw',
          role: 'alternative',
          onUnavailable: 'block',
          enabled: true,
          protocol: 'vless',
          config: { server: '198.51.100.7', port: 443, id: 'an-account', network: 'tcp', security: 'tls' },
        },
      ],
    },
  });
  assert.equal(written.statusCode, 200, written.body);
});

/**
 * `activatable` is the planner's verdict, not a count of secrets.
 *
 * The import below carries a contradiction the planner refuses — the kill-switch on, and traffic
 * told to leave directly when every tunnel is down — with every secret present and every field
 * valid. Under the old rule that is `activatable: true`, which is the false statement this asserts
 * against. A pure-document refusal on purpose, so the test says something about the *claim* rather
 * than about this harness's hardware.
 */
test('an import the planner will refuse is not reported as activatable', async (t) => {
  const { app, close, headers } = await device('activatable-claim');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Source' } });
  const id = created.json<{ id: string }>().id;
  const exported = (await app.inject({ method: 'GET', url: `/api/profiles/${id}/export`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;

  const response = await app.inject({
    method: 'POST',
    url: '/api/profiles/import',
    headers,
    payload: {
      document: {
        ...exported,
        firewall: { ...(exported['firewall'] as Record<string, unknown>), killSwitch: true },
        policy: { ...(exported['policy'] as Record<string, unknown>), onAllDown: 'direct' },
      },
    },
  });

  assert.equal(response.statusCode, 201, response.body);
  const body = response.json<{
    missingSecrets: unknown[];
    activatable: boolean;
    refusals: { code: string; pointer: string }[];
  }>();
  assert.deepEqual(body.missingSecrets, [], 'this document must have every secret, or it proves nothing');
  assert.equal(body.activatable, false, `the import claimed a document the planner refuses is runnable`);
  assert.ok(body.refusals.length > 0, 'the claim is a bare boolean with nothing behind it');
});


/**
 * The resolver follower is woken by a transaction ending, not by its next round.
 *
 * Measured on the bench board, 2026-09-23: the follower deferred a resolver change while a window was
 * open, and caught up 47 s after the confirm; `hq.lan` did not resolve for about 80 s. The wiring
 * here is the daemon's: `ApplyDeps.transactionEnded` runs the follower's ordinary check, and the
 * follower's view of "is a transaction open" is the real transaction table.
 */
async function followerOn(profiles: ReturnType<typeof createProfileStore>) {
  const { createResolverFollower } = await import('../src/core/resolver-follower.ts');
  const { createObserverRegistry } = await import('../src/core/observers.ts');
  const inCore = { value: '10.184.40.5' };
  const attempts: number[] = [];
  const document = {
    ...(emptyProfile({ name: 'F' }) as ProfileDocument),
    tunnels: [{ id: 'hq', name: 'HQ', enabled: true, dns: { server: '10.184.100.5', dynamic: true } }],
  } as unknown as ProfileDocument;
  const follower = createResolverFollower({
    document: () => document,
    profileId: () => 'p',
    verify: async () => {
      const divergent =
        inCore.value === '10.184.48.5'
          ? []
          : [{ tunnelId: 'hq', tunnelName: 'HQ', captured: '10.184.48.5', inCore: inCore.value }];
      return { readable: true, divergent, inUse: [{ tunnelId: 'hq', address: inCore.value }], captured: new Map([['hq', '10.184.48.5']]) };
    },
    apply: async () => {
      attempts.push(performance.now());
      inCore.value = '10.184.48.5';
      return { ok: true, transaction: { id: 'f', state: 'committed', blastRadius: 'service', deadlineAt: null, secondsRemaining: null }, result: { refused: [] } as never };
    },
    openTransaction: () => {
      const open = profiles.recentTransactions(10).find((row) => row.state === 'awaiting-confirm' || row.state === 'applying' || row.state === 'reverting');
      return open === undefined ? null : { id: open.id, state: open.state };
    },
    record: () => undefined,
    log: () => undefined,
    observer: createObserverRegistry().register({ name: 'f', watches: 'x', everyMs: 60_000 }),
  });
  return { follower, attempts };
}

for (const how of ['confirm', 'revert'] as const) {
  test(`the resolver follower runs within a second of a ${how}, not at its next round`, async (t) => {
    let wake: (() => void) | null = null;
    const { app, store, close, headers, profiles } = await device(`follower-${how}`, {
      transactionEnded: () => wake?.(),
    });
    t.after(() => {
      void app.close();
      close();
    });
    const { follower, attempts } = await followerOn(profiles);

    const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'W' } });
    store.setActiveProfileId(created.json<{ id: string }>().id);
    // A first apply to go back to, confirmed, so the revert case has a target.
    const first = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
    const firstId = first.json<{ transaction: { id: string } }>().transaction.id;
    await app.inject({ method: 'POST', url: `/api/transactions/${firstId}/confirm`, headers, payload: {} });

    const opened = await app.inject({ method: 'POST', url: '/api/apply', headers, payload: {} });
    const windowed = opened.json<{ transaction: { id: string; state: string } }>().transaction;
    assert.equal(windowed.state, 'awaiting-confirm', 'the test needs an open window, or it proves nothing');

    // Wired now, so the set-up's own confirm above does not already converge the fake resolver.
    wake = () => void follower.check('transaction-ended');
    // The capture moves while the window is open: the follower waits, as it must.
    const during = await follower.check('capture-changed');
    assert.equal(during.kind, 'deferred');
    const attemptsBefore = attempts.length;

    const endedAt = performance.now();
    const ended = await app.inject({
      method: 'POST',
      url: `/api/transactions/${windowed.id}/${how === 'confirm' ? 'confirm' : 'revert'}`,
      headers,
      payload: {},
    });
    assert.equal(ended.statusCode, 200, ended.body);

    const deadline = performance.now() + 1000;
    while (attempts.length === attemptsBefore && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(attempts.length > attemptsBefore, `the follower did not run within a second of the ${how}`);
    assert.ok(attempts[attempts.length - 1]! - endedAt < 1000);
  });
}

/**
 * Plan row G30: `tunnels[].probe` left the schema at version 8. A row stored at 7 with a probe — the
 * board's `partner` carried one of its own resources there — comes back migrated through the route every
 * reader uses, and a document that still names a probe is refused by name at the door every write uses.
 */
test('a stored probe is migrated away on read, and a PUT that names one is refused with the reason', async (t) => {
  const { app, database, close, headers } = await device('probe-removed');
  t.after(() => {
    void app.close();
    close();
  });

  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Bench' } });
  const id = created.json<{ id: string }>().id;
  const current = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: Record<string, unknown>;
  }>().document;
  const partner = {
    id: 'partner',
    name: 'Partner',
    role: 'resource',
    enabled: true,
    onUnavailable: 'block',
    protocol: 'openvpn',
    config: { interfaceSuffix: 'prt', profile: { $secret: 'client\ndev tun\nremote vpn.example.invalid 1194\n' } },
    resources: { ipCidr: ['172.30.0.212/32'] },
  };
  // The row as the build before this one stored it: version 7, with the probe.
  database.raw
    .prepare('UPDATE profiles SET document = ?, schema_version = 7 WHERE id = ?')
    .run(
      JSON.stringify({ ...current, schemaVersion: 7, tunnels: [{ ...partner, probe: { endpoints: ['http://172.30.0.212/'] } }] }),
      id,
    );

  const read = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{
    document: { schemaVersion: number; tunnels: Record<string, unknown>[] };
  }>().document;
  assert.equal(read.schemaVersion, 8);
  assert.equal('probe' in read.tunnels[0]!, false);
  assert.deepEqual(read.tunnels[0]!['resources'], { ipCidr: ['172.30.0.212/32'] });

  const refused = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    headers,
    payload: {
      ...read,
      tunnels: [
        {
          ...read.tunnels[0]!,
          config: { interfaceSuffix: 'prt', profile: { $keep: true } },
          probe: { endpoints: ['http://172.30.0.212/'] },
        },
      ],
    },
  });
  assert.equal(refused.statusCode, 400, refused.body);
  const body = JSON.stringify(refused.json());
  assert.match(body, /tunnel_field_removed/);
  assert.match(body, /no longer takes/);
  assert.match(body, /\/tunnels\/0\/probe/);
});

/* ── G30 round 2: the redacted export, and the warning it logged on every export ─────────── */

/**
 * On the bench board every redacted export logged `profile.export-incomplete-redaction`: "20 unwrapped
 * value(s) in tunnel configurations". The check reported **every** non-empty string in a tunnel's
 * configuration that was not wrapped — host names, interface suffixes, Cloak's public key and method
 * names, VLESS's `network` and `security` — which after the catalogue made every field typed and every
 * secret marked is every ordinary field. A warning logged on every export is one nobody reads.
 *
 * So this establishes both halves through the real routes. A sentinel goes into **every secret position
 * the schema has** — the OpenVPN profile with an inline `<key>` and `<tls-crypt>`, the auth password,
 * each Cloak UID, the VLESS account and encryption, the proxy password and a subscription URL — on the
 * board's tunnel shapes. The redacted export must carry none
 * of them, and must report nothing; the full export must carry all of them, which proves they were
 * stored.
 */
const SENTINEL = 'SENTINEL-G30';

function everySecretProfile(blank: Record<string, unknown>): Record<string, unknown> {
  const ovpn = (name: string): string =>
    'client\ndev tun\nremote vpn.example.invalid 1194\n' +
    `<key>\n-----BEGIN PRIVATE KEY-----\n${SENTINEL}-${name}-key\n-----END PRIVATE KEY-----\n</key>\n` +
    `<tls-crypt>\n-----BEGIN OpenVPN Static key V1-----\n${SENTINEL}-${name}-tlscrypt\n-----END OpenVPN Static key V1-----\n</tls-crypt>\n`;
  const entryPoint = (id: string) => ({
    id,
    host: `${id}.example.invalid`,
    port: 443,
    uid: `${SENTINEL}-uid-${id}`,
    publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=',
    proxyMethod: 'openvpn',
    encryptionMethod: 'aes-gcm',
    serverName: 'www.example.invalid',
    browserSignature: 'chrome',
    transport: 'direct',
  });
  return {
    ...blank,
    subscriptions: [
      { id: 'feed', name: 'Feed', url: `https://feed.example.invalid/${SENTINEL}-subscription`, refreshHours: 24, enabled: true },
    ],
    tunnels: [
      {
        id: 'partner', name: 'Partner', role: 'resource', onUnavailable: 'block', enabled: true, protocol: 'openvpn',
        config: { profile: ovpn('partner'), interfaceSuffix: 'prt', auth: { username: 'someone', password: `${SENTINEL}-partner-password` } },
        resources: { ipCidr: ['172.30.0.212/32'] },
      },
      {
        id: 'hq', name: 'HQ', role: 'resource', onUnavailable: 'block', enabled: true, protocol: 'cloak-openvpn',
        config: {
          profile: ovpn('hq'),
          interfaceSuffix: 'hq',
          auth: { username: 'someone', password: `${SENTINEL}-hq-password` },
          entryPoints: [entryPoint('war1'), entryPoint('war2'), entryPoint('msk1'), entryPoint('msk2')],
        },
      },
      {
        id: 'corp', name: 'Corp', role: 'resource', onUnavailable: 'block', enabled: true, protocol: 'cloak-openvpn',
        config: { profile: ovpn('corp'), interfaceSuffix: 'crp', entryPoints: [entryPoint('corpsg')] },
      },
      {
        id: 'relay', name: 'Relay', role: 'resource', onUnavailable: 'block', enabled: true, protocol: 'vless',
        config: { server: '198.51.100.7', port: 443, id: `${SENTINEL}-vless-account`, encryption: `${SENTINEL}-vless-encryption`, network: 'ws', security: 'tls', serverName: '198.51.100.7', fingerprint: 'chrome', path: '/' },
      },
      {
        id: 'spare', name: 'Spare', role: 'alternative', onUnavailable: 'block', enabled: true, protocol: 'proxy',
        config: { type: 'socks', server: '198.51.100.20', port: 1080, auth: { username: 'someone', password: `${SENTINEL}-proxy-password` } },
      },
    ],
  };
}

test('a redacted export of the board’s tunnel shapes carries no secret, and reports nothing leaving in clear', async (t) => {
  const { app, close, headers } = await device('export-sentinels');
  t.after(() => {
    void app.close();
    close();
  });
  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Sentinels' } });
  const id = created.json<{ id: string }>().id;
  const blank = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{ document: Record<string, unknown> }>().document;
  const document = everySecretProfile(blank);
  const saved = await app.inject({ method: 'PUT', url: `/api/profiles/${id}`, headers, payload: document });
  assert.equal(saved.statusCode, 200, saved.body);

  const full = await app.inject({ method: 'GET', url: `/api/profiles/${id}/export?secrets=include`, headers });
  const planted = full.body.match(new RegExp(`${SENTINEL}[-a-z0-9]*`, 'g')) ?? [];
  // Every sentinel was stored: 3 profiles × 2 blocks, 2 OpenVPN passwords, 5 UIDs, the VLESS account and
  // encryption, the proxy password, the subscription URL.
  assert.equal(new Set(planted).size, 17, JSON.stringify([...new Set(planted)]));

  const redacted = await app.inject({ method: 'GET', url: `/api/profiles/${id}/export`, headers });
  assert.equal(redacted.statusCode, 200);
  assert.equal(redacted.body.includes(SENTINEL), false, `a secret left in a redacted export: ${String(redacted.body.match(new RegExp(`${SENTINEL}[-a-z0-9]*`, 'g')))}`);
  assert.deepEqual(redacted.json<{ leavingInClear: unknown[] }>().leavingInClear, []);
});

test('the check reports what would really leave: key material or a secret-named field outside a marked position', async (t) => {
  const { app, close, headers } = await device('export-real-leak');
  t.after(() => {
    void app.close();
    close();
  });
  const created = await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { name: 'Leak' } });
  const id = created.json<{ id: string }>().id;
  const blank = (await app.inject({ method: 'GET', url: `/api/profiles/${id}`, headers })).json<{ document: Record<string, unknown> }>().document;
  const document = everySecretProfile(blank);
  // A private key pasted into a field nobody marked: the path of a VLESS WebSocket.
  const relay = (document['tunnels'] as { id: string; config: Record<string, unknown> }[]).find((entry) => entry.id === 'relay')!;
  relay.config['path'] = '/-----BEGIN PRIVATE KEY-----MIIE';
  const saved = await app.inject({ method: 'PUT', url: `/api/profiles/${id}`, headers, payload: document });
  assert.equal(saved.statusCode, 200, saved.body);
  const leaving = (await app.inject({ method: 'GET', url: `/api/profiles/${id}/export`, headers })).json<{
    leavingInClear: { pointer: string; field: string; why: string }[];
  }>().leavingInClear;
  assert.deepEqual(leaving.map((entry) => entry.pointer), ['/tunnels/3/config/path']);
  assert.match(leaving[0]!.why, /key material/);
});

test('each of the three readings is reported on its own, and a redaction marker is not', async () => {
  const { unwrappedOpaqueValues } = await import('../src/api/profiles-routes.ts');
  const found = unwrappedOpaqueValues({
    tunnels: [
      // The machinery failing: a marked position in clear.
      { config: { entryPoints: [{ uid: 'in-clear', host: 'a.example.invalid' }] } },
      // An annotation gap: a field named like a secret nobody marked.
      { config: { api_token: 'in-clear', serverName: 'b.example.invalid' } },
      // Already redacted, and a public key: neither is a leak.
      { config: { profile: { $redacted: 'config-blob' }, publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=' } },
    ],
  });
  assert.deepEqual(
    found.map((entry) => [entry.pointer, entry.why]),
    [
      ['/tunnels/0/config/entryPoints/0/uid', 'a position marked secret holds a value in clear'],
      ['/tunnels/1/config/api_token', 'named like a secret, and not marked as one'],
    ],
  );
});
