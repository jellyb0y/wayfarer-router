/**
 * `POST /api/system/poweroff`: the one route whose success ends the device answering at all.
 *
 * Everything here is about the paths that must **not** reach the power-off, and about the one that
 * must reach it only after the answer has left. Each guard has a test that names it, so a mutation that
 * removes one turns a named test red rather than a general one:
 *
 * * **the confirmation** — a bare POST, an empty object, a near-miss spelling, a form replayed from a
 *   browser history and a body carrying a key the route does not know are all refused, and none of them
 *   records an event or schedules anything;
 * * **the open window** — a transaction inside its confirmation window would be reverted by the
 *   start-up sweep on the next boot, silently and hours later, so the route refuses and names it;
 * * **the real platform** — this file never loads the module that constructs it. A resolve hook
 *   registered before any source module is imported records every module this process loads, and the
 *   last test asserts that neither `platform/index.ts` nor `platform/systemd.ts` is among them. A route
 *   that reached for its own controller instead of `context.platform` would have to load one of them.
 *
 * The hook has to be registered before the first source import, which is why every import of `src/`
 * below is dynamic: static imports are hoisted above any statement in the module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeModule from 'node:module';

import type { ServerContext } from '../src/api/server.ts';
import type { Platform } from '../src/platform/index.ts';
import type { Store, TokenScope } from '../src/state/store.ts';

const loaded: string[] = [];
const registerHooks = (nodeModule as { registerHooks?: (hooks: unknown) => unknown }).registerHooks;
// Failing rather than skipping: a guard that quietly stops guarding on an older runtime is green forever.
assert.equal(typeof registerHooks, 'function', 'this runtime has no module.registerHooks, so the platform guard below cannot run');
registerHooks!({
  resolve(specifier: string, context: unknown, nextResolve: (specifier: string, context: unknown) => { url: string }) {
    const result = nextResolve(specifier, context);
    loaded.push(result.url);
    return result;
  },
});

const { buildServer } = await import('../src/api/server.ts');
const { openDatabase } = await import('../src/state/db.ts');
const { createStore } = await import('../src/state/store.ts');
const { createProfileStore } = await import('../src/state/profiles.ts');
const { createSecretPlan } = await import('../src/state/secret-plan.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

/** What the fake platform was asked to do. The route must reach `systemd.poweroff` through it or not at all. */
interface Calls {
  poweroff: string[];
  /** When set, the platform reports the power-off as not started, with this message. */
  refuseWith?: string;
}

function fakePlatform(calls: Calls): Platform {
  const notCalled = (name: string) => (): never => {
    throw new Error(`${name} should not be reached by the power-off route`);
  };
  return {
    systemd: {
      state: async () => ({ unit: 'x', activeState: null, subState: null, unitFileState: null, loadState: null, isActive: false, isEnabled: false, known: false }),
      poweroff: async (reason: string) => {
        calls.poweroff.push(reason);
        return calls.refuseWith === undefined ? { ok: true, message: '' } : { ok: false, message: calls.refuseWith };
      },
    } as unknown as Platform['systemd'],
    net: { addresses: async () => [], links: async () => [], routes: async () => [], snapshot: async () => ({ links: [], addresses: [], routes: [], at: Date.now() }), watch: () => ({ stop: () => undefined }) } as unknown as Platform['net'],
    wifi: { phys: async () => [], interfaces: async () => [], regulatory: async () => ({ global: null, perPhy: {} }) } as unknown as Platform['wifi'],
    supplicant: {} as Platform['supplicant'],
    ap: {} as Platform['ap'],
    nft: {} as Platform['nft'],
    files: {} as Platform['files'],
    sysctl: { read: notCalled('sysctl.read'), write: notCalled('sysctl.write') } as unknown as Platform['sysctl'],
    clock: { status: async () => ({ timezone: null, ntpEnabled: null, synchronized: false, localRtc: null, timeUsec: null, rtcTimeUsec: null }), resync: notCalled('clock.resync') } as unknown as Platform['clock'],
    host: {
      boardModel: async () => null,
      uptimeSeconds: async () => 4000,
      reloadForeignManager: notCalled('host.reloadForeignManager'),
      // The other call that ends the process. A power-off route that rebooted instead would be caught here.
      reboot: notCalled('host.reboot'),
    } as unknown as Platform['host'],
    binaries: { detect: async () => null, coreSchema: async () => null, checkCoreConfig: async () => null },
    journal: {
      read: async () => ({ entries: [], nextCursor: null, currentBootId: 'boot', containsEarlierBoots: false, hasMore: false, incomplete: false, incompleteReason: null, skippedLines: 0 }),
      currentBootId: async () => 'boot-7f3a',
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

function notReached(name: string): never & (() => never) {
  return (() => {
    throw new Error(`${name} should not be reached by the power-off route`);
  }) as never & (() => never);
}

/** How long every test waits after the answer before it looks for a power-off: well past the delay. */
const DELAY_MS = 40;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, DELAY_MS * 4));

async function harness(options: { refuseWith?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-poweroff-'));
  const database = openDatabase({ path: join(directory, 'state.db') });
  const store = createStore(database);
  await store.setAdminPassword('a-long-enough-password');
  store.setApiEnabled(true);
  const profiles = createProfileStore(database, createSecretPlan());
  const calls: Calls = { poweroff: [], ...(options.refuseWith === undefined ? {} : { refuseWith: options.refuseWith }) };
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
    powerOffDelayMs: DELAY_MS,
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
  return { app, store, profiles, calls, close: () => database.close() };
}

function tokenWith(store: Store, name: string, scopes: TokenScope[]): string {
  return store.createToken(name, scopes).token;
}

const poweroffEvents = (store: Store) => store.events({ kind: 'system.poweroff' });

test('poweroff guard (confirmation): anything but {"confirm":"poweroff"} is refused, says what to send, and does nothing', async (t) => {
  const { app, store, calls, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const authorization = `Bearer ${tokenWith(store, 'ops', ['read', 'apply', 'admin'])}`;

  const attempts: { name: string; headers?: Record<string, string>; payload?: string }[] = [
    // A script probing routes, or a bare curl -X POST.
    { name: 'no body at all' },
    { name: 'an empty object', headers: { 'content-type': 'application/json' }, payload: '{}' },
    { name: 'the wrong word', headers: { 'content-type': 'application/json' }, payload: '{"confirm":"yes"}' },
    { name: 'a boolean', headers: { 'content-type': 'application/json' }, payload: '{"confirm":true}' },
    { name: 'the word in capitals', headers: { 'content-type': 'application/json' }, payload: '{"confirm":"POWEROFF"}' },
    {
      // Somebody expecting the apply route's dry run. Refused rather than ignored: ignoring it would
      // turn the one request that meant "do not do it" into the one that does it.
      name: 'a key the route does not know',
      headers: { 'content-type': 'application/json' },
      payload: '{"confirm":"poweroff","dryRun":true}',
    },
    { name: 'a JSON array', headers: { 'content-type': 'application/json' }, payload: '["poweroff"]' },
  ];

  for (const attempt of attempts) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/system/poweroff',
      headers: { authorization, ...(attempt.headers ?? {}) },
      ...(attempt.payload === undefined ? {} : { payload: attempt.payload }),
    });
    assert.equal(response.statusCode, 400, `${attempt.name}: answered ${response.statusCode}`);
    const body = response.json<{ error: { code: string; message: string; hint: string } }>();
    assert.equal(body.error.code, 'confirmation_required', `${attempt.name}: ${body.error.code}`);
    // The refusal says what to send, verbatim, so the fix is a copy rather than a guess.
    assert.match(body.error.hint, /\{"confirm":"poweroff"\}/, `${attempt.name}: the hint does not say what to send`);
  }

  // A form replayed from a browser's history. Fastify has no form parser, so it never reaches the handler.
  const form = await app.inject({
    method: 'POST',
    url: '/api/system/poweroff',
    headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'confirm=poweroff',
  });
  assert.ok(form.statusCode >= 400 && form.statusCode < 500, `a form body answered ${form.statusCode}`);

  await settle();
  assert.deepEqual(calls.poweroff, [], 'a refused request reached the power-off');
  assert.deepEqual(poweroffEvents(store), [], 'a refused request recorded a power-off');
});

test('poweroff needs the admin scope', async (t) => {
  const { app, store, calls, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  // `apply` is everything short of device-wide: it can change and confirm a configuration, and it is
  // exactly the credential a script driving applies holds.
  const token = tokenWith(store, 'applier', ['read', 'apply']);
  const response = await app.inject({
    method: 'POST',
    url: '/api/system/poweroff',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: '{"confirm":"poweroff"}',
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json<{ error: { code: string } }>().error.code, 'insufficient_scope');
  await settle();
  assert.deepEqual(calls.poweroff, []);
});

test('poweroff guard (open window): refused while a transaction awaits confirmation, naming it and the sweep', async (t) => {
  const { app, store, profiles, calls, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const row = profiles.createTransaction({
    profileId: null,
    documentBefore: null,
    documentAfter: { marker: 'after' },
    kind: 'apply',
    blastRadius: 'network',
    plan: { humanDiff: [] },
  });
  profiles.setTransactionState(row.id, 'applying');
  // The board's uptime is 4000 in the fake platform, so this window has 95 seconds left.
  profiles.beginConfirmationWindow(row.id, new Date(Date.now() + 95_000).toISOString(), 'wayfarer-revert@x.service', 4095);

  const response = await app.inject({
    method: 'POST',
    url: '/api/system/poweroff',
    headers: { authorization: `Bearer ${tokenWith(store, 'ops', ['admin'])}`, 'content-type': 'application/json' },
    payload: '{"confirm":"poweroff"}',
  });
  assert.equal(response.statusCode, 409);
  const body = response.json<{ error: { code: string; message: string; hint: string; detail: { transaction: string; secondsRemaining: number | null } } }>();
  assert.equal(body.error.code, 'confirmation_pending');
  assert.match(body.error.message, new RegExp(row.id));
  // The consequence a person would otherwise meet hours later, said now.
  assert.match(body.error.message, /reverted .*next (boot|start)/);
  assert.equal(body.error.detail.transaction, row.id);
  assert.equal(body.error.detail.secondsRemaining, 95, 'the countdown did not come from windowCountdown');
  assert.match(body.error.hint, new RegExp(`/api/transactions/${row.id}/confirm`));

  await settle();
  assert.deepEqual(calls.poweroff, [], 'an open window did not stop the power-off');
  assert.deepEqual(poweroffEvents(store), [], 'a refused power-off was recorded as one');

  // And once the window closes, the same request is accepted: the refusal was about the window.
  profiles.confirmTransaction(row.id);
  const after = await app.inject({
    method: 'POST',
    url: '/api/system/poweroff',
    headers: { authorization: `Bearer ${tokenWith(store, 'ops2', ['admin'])}`, 'content-type': 'application/json' },
    payload: '{"confirm":"poweroff"}',
  });
  assert.equal(after.statusCode, 202);
  await settle();
  assert.equal(calls.poweroff.length, 1);
});

test('poweroff records who asked before answering, answers 202, and only then powers off through the platform', async (t) => {
  const { app, store, calls, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = store.createToken('night-shift-script', ['admin']);

  const response = await app.inject({
    method: 'POST',
    url: '/api/system/poweroff',
    headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
    payload: '{"confirm":"poweroff"}',
  });

  assert.equal(response.statusCode, 202);
  const body = response.json<{ accepted: boolean; poweringOffInSeconds: number; message: string }>();
  assert.equal(body.accepted, true);
  assert.ok(body.poweringOffInSeconds >= 0);
  assert.match(body.message, /power is cycled/);

  // The answer has arrived and nothing has been switched off yet: the browser gets its reply, not a
  // dropped connection.
  assert.deepEqual(calls.poweroff, [], 'the power-off ran before the answer was delivered');

  // And the record already exists — written before the answer, not after the fact.
  const events = poweroffEvents(store);
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.match(event.summary, /night-shift-script/);
  assert.match(event.summary, /power is cycled/);
  const detail = event.detail as Record<string, unknown>;
  assert.deepEqual(detail['requestedBy'], { kind: 'token', id: token.row.id, name: 'night-shift-script' });
  // No clock battery: the wall-clock `at` may be days wrong after a power cycle, so the row also carries
  // the frame that is not — this boot and the uptime within it — and says whether the clock was trusted.
  assert.equal(detail['bootId'], 'boot-7f3a');
  assert.equal(detail['uptimeSeconds'], 4000);
  assert.equal(detail['clockSynchronized'], false);

  await settle();
  assert.equal(calls.poweroff.length, 1, 'the power-off never went through the platform layer');
  assert.match(calls.poweroff[0]!, /night-shift-script/);
});

test('a second power-off while one is already under way records nothing new and schedules nothing new', async (t) => {
  const { app, store, calls, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const authorization = `Bearer ${tokenWith(store, 'ops', ['admin'])}`;
  const send = () =>
    app.inject({
      method: 'POST',
      url: '/api/system/poweroff',
      headers: { authorization, 'content-type': 'application/json' },
      payload: '{"confirm":"poweroff"}',
    });

  assert.equal((await send()).statusCode, 202);
  // A double tap, or a retry of a reply the phone did not see.
  assert.equal((await send()).statusCode, 202);
  await settle();
  assert.equal(calls.poweroff.length, 1);
  assert.equal(poweroffEvents(store).length, 1);
});

test('a power-off systemd would not start is recorded as not having happened, and can be asked for again', async (t) => {
  const { app, store, calls, close } = await harness({ refuseWith: 'Access denied' });
  t.after(() => {
    void app.close();
    close();
  });
  const authorization = `Bearer ${tokenWith(store, 'ops', ['admin'])}`;
  const send = () =>
    app.inject({
      method: 'POST',
      url: '/api/system/poweroff',
      headers: { authorization, 'content-type': 'application/json' },
      payload: '{"confirm":"poweroff"}',
    });

  assert.equal((await send()).statusCode, 202);
  await settle();
  // Otherwise the ring says the device was switched off on purpose, beside a device that is running.
  const failed = store.events({ kind: 'system.poweroff-failed' });
  assert.equal(failed.length, 1);
  assert.match(failed[0]!.summary, /Access denied/);

  // Not stuck "under way": a second request is a new attempt, recorded and tried.
  assert.equal((await send()).statusCode, 202);
  await settle();
  assert.equal(calls.poweroff.length, 2);
  assert.equal(poweroffEvents(store).length, 2);
});

test('a browser session is recorded by where it came from, never by its session id', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'a-long-enough-password' },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.find((entry) => entry.name === 'wayfarer_session')!;

  const response = await app.inject({
    method: 'POST',
    url: '/api/system/poweroff',
    cookies: { wayfarer_session: cookie.value },
    headers: { 'content-type': 'application/json' },
    payload: '{"confirm":"poweroff"}',
  });
  assert.equal(response.statusCode, 202);

  const [event] = poweroffEvents(store);
  // The session id *is* the credential: the ring is readable with the read scope, and a row that held
  // it would hand the admin session to anybody holding a peer's read token.
  assert.ok(!JSON.stringify(event).includes(cookie.value), 'the event ring now holds a live session credential');
  const requestedBy = (event!.detail as Record<string, unknown>)['requestedBy'] as Record<string, unknown>;
  assert.equal(requestedBy['kind'], 'session');
  assert.equal(requestedBy['source'], '127.0.0.1');
  await settle();
});

test('poweroff guard (real platform): this file never loaded the module that constructs the real platform', () => {
  // Anti-vacuity first: the hook must have seen the server itself, or the absence below is about nothing.
  assert.ok(
    loaded.some((url) => url.endsWith('/src/api/server.ts')),
    'the resolve hook saw nothing, so it proves nothing',
  );
  const real = loaded.filter((url) => /\/src\/platform\/(index|systemd)\.ts$/.test(url));
  assert.deepEqual(real, [], 'the power-off route loaded the real platform, so a test could reach a real systemctl');
});
