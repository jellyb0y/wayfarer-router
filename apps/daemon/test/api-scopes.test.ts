/**
 * Scope enforcement, tested through the HTTP surface.
 *
 * The bug this file exists for: the global authentication hook proved only that *some* credential
 * authenticated, and no read route asked for a scope — so a token issued with `['apply']` could read
 * the inventory, the live status and both log surfaces. `docs/07-api.md` says otherwise and
 * `docs/10-security.md` counts scopes as the mitigation for a leaked token, which makes the gap
 * worse than a missing feature: someone relies on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PASSWORD, buildServer, type ServerContext } from '../src/api/server.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore, type Store, type TokenScope } from '../src/state/store.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Platform } from '../src/platform/index.ts';

/** A platform that answers nothing interesting: these tests are about who may ask, not the answers. */
function fakePlatform(): Platform {
  const notCalled = (name: string) => (): never => {
    throw new Error(`${name} should not be reached in a scope test`);
  };
  return {
    systemd: { state: async () => ({ unit: 'x', activeState: null, subState: null, unitFileState: null, loadState: null, isActive: false, isEnabled: false, known: false }) } as unknown as Platform['systemd'],
    net: { addresses: async () => [], links: async () => [], routes: async () => [], snapshot: async () => ({ links: [], addresses: [], routes: [], at: Date.now() }), watch: () => ({ stop: () => undefined }) } as unknown as Platform['net'],
    wifi: { phys: async () => [], interfaces: async () => [], regulatory: async () => ({ global: null, perPhy: {} }), link: notCalled('wifi.link'), stations: notCalled('wifi.stations') } as unknown as Platform['wifi'],
    supplicant: {} as Platform['supplicant'],
    ap: {} as Platform['ap'],
    nft: {} as Platform['nft'],
    files: {} as Platform['files'],
    // Present so the shape is complete, and both members throw: a scope test that reached a kernel
    // tunable would be testing something other than who may ask.
    sysctl: { read: notCalled('sysctl.read'), write: notCalled('sysctl.write') } as unknown as Platform['sysctl'],
    clock: { status: async () => ({ timezone: null, ntpEnabled: null, synchronized: null, localRtc: null, timeUsec: null, rtcTimeUsec: null }), resync: notCalled('clock.resync') } as unknown as Platform['clock'],
    host: {
      boardModel: async () => null,
      uptimeSeconds: async () => 4000,
      // Both throw: a scope test that reached a foreign manager's reload, or a reboot, would be testing
      // something other than who may ask.
      reloadForeignManager: notCalled('host.reloadForeignManager'),
      reboot: notCalled('host.reboot'),
    } as unknown as Platform['host'],
    binaries: { detect: async () => null, coreSchema: async () => null, checkCoreConfig: async () => null },
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

async function harness(
  overrides: Partial<ServerContext> = {},
): Promise<{ app: Awaited<ReturnType<typeof buildServer>>; store: Store; close: () => void }> {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-api-'));
  const database = openDatabase({ path: join(directory, 'state.db') });
  const store = createStore(database);
  await store.setAdminPassword('a-long-enough-password');
  store.setApiEnabled(true);

  const context: ServerContext = {
    config: { ...DEFAULT_CONFIG, uiDir: null, stateDir: directory, cacheDir: join(directory, 'cache') },
    platform: fakePlatform(),
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
    ...overrides,
  };

  const app = await buildServer(context);
  return { app, store, close: () => database.close() };
}

const READ_SURFACES = ['/api/system', '/api/status', '/api/logs', '/api/eventlog', '/api/inventory', '/api/events'];
const ADMIN_SURFACES = ['/api/tokens'];

async function tokenWith(store: Store, scopes: TokenScope[]): Promise<string> {
  return store.createToken(`scopes-${scopes.join('-')}`, scopes).token;
}

test('a token without "read" is refused on every read surface', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['apply']);

  for (const url of READ_SURFACES) {
    const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 403, `${url} answered ${response.statusCode} to a token with only "apply"`);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'insufficient_scope');
  }
});

test('a token with "read" reaches the read surfaces', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['read']);

  for (const url of ['/api/system', '/api/status', '/api/logs', '/api/eventlog']) {
    const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 200, `${url} answered ${response.statusCode} to a token with "read"`);
  }
});

test('a token with "read" is refused on the admin surfaces', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['read']);

  for (const url of ADMIN_SURFACES) {
    const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 403, `${url} answered ${response.statusCode} to a token with only "read"`);
  }
  const created = await app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'escalation', scopes: ['admin'] },
  });
  // A token must not be able to mint itself a better one.
  assert.equal(created.statusCode, 403);

  const debug = await app.inject({
    method: 'POST',
    url: '/api/debug/log-level',
    headers: { authorization: `Bearer ${token}` },
    payload: { level: 'debug', minutes: 5 },
  });
  assert.equal(debug.statusCode, 403);
});

test('a valid token is refused entirely while the machine API is off', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['read', 'apply', 'admin']);
  store.setApiEnabled(false);

  const response = await app.inject({ method: 'GET', url: '/api/system', headers: { authorization: `Bearer ${token}` } });
  // A fresh device cannot be driven remotely until a human enables it, whatever tokens exist. Still
  // refused; since F8 the refusal names the switch rather than telling the holder to log in.
  assert.equal(response.statusCode, 403);
  assert.equal(response.json<{ error: { code: string } }>().error.code, 'machine_access_off');
});

/**
 * `docs/13-plan.md` row F8. The refusal stands; what it says changed.
 *
 * It answered `unauthenticated, "log in first"` to a valid, correctly scoped token, which sends the
 * holder to the one action that cannot help. The refusal must name the obstacle — the device's
 * machine-access switch — and where it is turned on, and must not tell anybody that a token which is
 * not valid is valid.
 */
test('a valid token refused only because machine access is off is told so, and told where the switch is', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['read']);
  store.setApiEnabled(false);

  const response = await app.inject({ method: 'GET', url: '/api/system', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 403);
  const error = response.json<{ error: { code: string; message: string; hint: string } }>().error;
  assert.equal(error.code, 'machine_access_off');
  assert.match(error.message, /machine access/);
  assert.doesNotMatch(error.message, /^log in first$/);
  assert.match(error.hint, /way machine-api on/, 'the refusal must name where the switch is turned on');

  // A token that is not valid is not told it is valid: the old answer stands for it.
  const unknown = await app.inject({ method: 'GET', url: '/api/system', headers: { authorization: 'Bearer not-a-token' } });
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.json<{ error: { code: string } }>().error.code, 'unauthenticated');

  // Refused tokens do not look used: "last used" moves only when a request was actually served.
  const listed = store.tokens().find((entry) => entry.name === 'scopes-read');
  assert.equal(listed?.lastUsedAt ?? null, null, 'a token shown at a closed door must not be recorded as used');
});

test('turning machine access on with the command the refusal names lets the same token through', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['read']);
  store.setApiEnabled(false);
  const { machineAccess } = await import('../src/core/machine-access.ts');

  assert.match(machineAccess(store, ['status']).text, /OFF/);
  const turned = machineAccess(store, ['on']);
  assert.equal(turned.code, 0);
  assert.match(turned.text, /ON/);
  const response = await app.inject({ method: 'GET', url: '/api/system', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);

  assert.equal(machineAccess(store, ['off']).code, 0);
  assert.equal(store.device().apiEnabled, false);
  assert.equal(machineAccess(store, ['sideways']).code, 2);
});

/**
 * `GET /api/events?limit=25` from a laptop did not return in 120 s on the bench board, 2026-09-22.
 * Nothing was stuck: it is the live stream, which never ends by design and ignored `limit`. A request
 * that is plainly asking for a list is now told where the list is, at once.
 */
test('a request for a list at the event stream is refused at once and pointed at the event log', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['read']);
  const headers = { authorization: `Bearer ${token}` };

  const withQuery = await app.inject({ method: 'GET', url: '/api/events?limit=25', headers: { ...headers, accept: 'text/event-stream' } });
  assert.equal(withQuery.statusCode, 400);
  const error = withQuery.json<{ error: { code: string; message: string; hint: string } }>().error;
  assert.equal(error.code, 'stream_not_list');
  assert.match(error.message, /\/api\/eventlog/);
  assert.match(error.message, /limit/);

  const plainCurl = await app.inject({ method: 'GET', url: '/api/events', headers: { ...headers, accept: '*/*' } });
  assert.equal(plainCurl.statusCode, 406);
  assert.match(plainCurl.json<{ error: { hint: string } }>().error.hint, /\/api\/eventlog\?limit=25/);
});

test('the event stream still streams to a client that asks for one', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['read']);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === 'object');
  const { request } = await import('node:http');

  // A real socket, because an injected request waits for an end this response never has.
  const first = await new Promise<{ status: number; type: string; chunk: string }>((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port: address.port, path: '/api/events', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } },
      (response) => {
        response.once('data', (chunk: Buffer) => {
          resolve({ status: response.statusCode ?? 0, type: String(response.headers['content-type']), chunk: chunk.toString('utf8') });
          outgoing.destroy();
        });
      },
    );
    outgoing.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    outgoing.end();
  });
  assert.equal(first.status, 200);
  assert.match(first.type, /text\/event-stream/);
  assert.match(first.chunk, /event: hello/);
});

test('a browser session carries every scope, because the operator is the operator', async (t) => {
  const { app, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'a-long-enough-password' } });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies[0]!;

  for (const url of ['/api/system', '/api/tokens']) {
    const response = await app.inject({ method: 'GET', url, cookies: { [cookie.name]: cookie.value } });
    assert.equal(response.statusCode, 200, `${url} refused a session`);
  }
});

test('an unauthenticated request is refused before any scope question', async (t) => {
  const { app, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const response = await app.inject({ method: 'GET', url: '/api/inventory' });
  assert.equal(response.statusCode, 401);
  // Health stays reachable: it is what a deploy script checks before anything else exists.
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
});

/**
 * The forced-credential-change gate is gone, and this test is what holds it gone.
 *
 * It used to assert the opposite: a session on a device still carrying the shipped password was refused
 * `403 setup_incomplete` everywhere but login, logout, the password change and health. The owner removed
 * the forced change — the default password is short on purpose — so the gate went with it.
 *
 * The assertion is inverted rather than deleted, because deleting it would leave nothing that notices a
 * gate coming back. `setupComplete` still exists and is still reported; the whole risk is that somebody
 * reads that field as a permission again, six months from now, and reinstates the refusal. The `200`
 * below is the line that fails when they do.
 */
test('a device still on the default password is not gated, and the password change still revokes sessions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-gate-'));
  const database = openDatabase({ path: join(directory, 'state.db') });
  const store = createStore(database);
  // Deliberately NOT setting a password: a device with the shipped default in place. The value is
  // imported rather than typed here — a test carrying its own copy of the default silently stops
  // testing the product the day the product's default changes, which is exactly what happened to the
  // literal this line used to hold.
  const context: ServerContext = {
    config: { ...DEFAULT_CONFIG, uiDir: null, stateDir: directory, cacheDir: join(directory, 'cache') },
    platform: fakePlatform(),
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
    boundAddresses: [],
    configWarnings: [],
    setLogLevel: () => ({ level: 'info', revertsAt: null }),
    currentLogLevel: () => 'info',
  };
  const app = await buildServer(context);
  t.after(() => {
    void app.close();
    database.close();
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: DEFAULT_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies[0]!;

  const onDefault = await app.inject({ method: 'GET', url: '/api/system', cookies: { [cookie.name]: cookie.value } });
  assert.equal(onDefault.statusCode, 200, 'the default password must not refuse an authenticated request');
  // The fact is still reported. That is the whole of what replaced the gate: something an operator can
  // see, that refuses nothing.
  assert.equal(onDefault.json<{ setupComplete: boolean }>().setupComplete, false);

  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    cookies: { [cookie.name]: cookie.value },
    payload: { currentPassword: DEFAULT_PASSWORD, newPassword: 'a-new-long-password' },
  });
  assert.equal(changed.statusCode, 200);

  /*
   * The old cookie is dead, including the one that made the change.
   *
   * A password change revokes every session, and that is now the only thing bounding a session's life —
   * sessions have no absolute expiry, because on a board with no clock battery a wall-clock expiry is
   * unenforceable and was the last reader of a model the authorisation path had abandoned. Revocation needs
   * no clock at all.
   *
   * Signing the operator out of the tab they just used is the correct cost: the alternative is a session
   * created under a password they have deliberately retired, which is the one case where "it was valid when
   * it was issued" is not good enough.
   */
  const withOldCookie = await app.inject({
    method: 'GET',
    url: '/api/system',
    cookies: { [cookie.name]: cookie.value },
  });
  assert.equal(withOldCookie.statusCode, 401, 'the password change ended every session, including this one');

  const again = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'a-new-long-password' },
  });
  assert.equal(again.statusCode, 200);
  const fresh = again.cookies[0]!;

  const allowed = await app.inject({ method: 'GET', url: '/api/system', cookies: { [fresh.name]: fresh.value } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(
    allowed.json<{ setupComplete: boolean }>().setupComplete,
    true,
    'changing the password is what makes this true, and it is the only thing that does',
  );
});

test('the observers route serves every observer whole, and counts the ones that are not ok', async (t) => {
  const { createObserverRegistry } = await import('../src/core/observers.ts');
  const observers = createObserverRegistry();
  observers.register({ name: 'drift', watches: 'files', everyMs: 60_000 }).armed();
  observers.register({ name: 'resolver-watch', watches: '/run/wayfarer/tunnel', everyMs: null }).notRunning('ENOENT');
  const { app, store, close } = await harness({ observers: () => observers.report() });
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['read']);
  const response = await app.inject({ method: 'GET', url: '/api/observers', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  const body = response.json<{ problems: number; observers: { name: string; state: string; problem: string | null }[] }>();
  assert.equal(body.problems, 1);
  const watch = body.observers.find((entry) => entry.name === 'resolver-watch');
  // Through the response serializer: a key it does not declare would vanish here without an error.
  assert.equal(watch?.state, 'not-running');
  assert.match(watch?.problem ?? '', /ENOENT/);
});

/**
 * G30 round 2, found on the device: the watchdog produced `method`, `action` and `tone` for each tunnel,
 * and `GET /api/observers` served only `subject`, `state` and `note`. The response schema listed three
 * fields, and Fastify's serialiser dropped the rest without a word. The earlier tests built the observer
 * and read the registry directly, so they never met the serialiser.
 *
 * So this goes from the watchdog's own reading, through the observer the daemon wires, through the
 * running server's response: every field the watchdog produced must arrive, whole.
 */
test('every field of a watchdog item survives the observers route, as the watchdog produced it', async (t) => {
  const { createObserverRegistry } = await import('../src/core/observers.ts');
  const { observeWatchdog } = await import('../src/core/watchdog.ts');
  const observers = createObserverRegistry();
  const handle = observers.register({ name: 'tunnel-watchdog', watches: 'tunnels', everyMs: 30_000 });
  handle.armed();
  observeWatchdog(handle).onRound({
    health: [],
    selected: null,
    changed: false,
    reason: 'no tunnel to probe',
    guards: [
      {
        tunnelId: 'corp',
        selector: 'wf-guard-corp',
        onUnavailable: 'block',
        liveness: { state: 'dead', basis: 'keepalive', why: 'nothing has arrived from the peer for at least 40 s' },
        streak: 2,
        action: 'its traffic is NOT being blocked by the guard: its outbound is bound to wfvpncrp',
        changed: false,
        blocked: false,
      },
    ],
  });
  const produced = observers.report().find((entry) => entry.name === 'tunnel-watchdog')!.lastLooked!.items!;
  assert.deepEqual(Object.keys(produced[0]!).sort(), ['action', 'method', 'note', 'state', 'subject', 'tone']);

  const { app, store, close } = await harness({ observers: () => observers.report() });
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['read']);
  const response = await app.inject({ method: 'GET', url: '/api/observers', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  const served = response
    .json<{ observers: { name: string; lastLooked: { items: unknown[] } }[] }>()
    .observers.find((entry) => entry.name === 'tunnel-watchdog')!.lastLooked.items;
  assert.deepEqual(served, produced);
});

/**
 * G31: a fall-through tunnel whose traffic is leaving outside it carries `fallingThroughSeconds`, and the
 * panel's "since" is built from it. A field the response schema does not declare is dropped without a
 * word (and is a 500 under `WAYFARER_SERIALISER_CHECK=1`, which the test script sets) — so it goes
 * through the running server, from the watchdog's own reading.
 */
test('a falling-through tunnel’s duration survives the observers route, as a monotonic count of seconds', async (t) => {
  const { createObserverRegistry } = await import('../src/core/observers.ts');
  const { observeWatchdog } = await import('../src/core/watchdog.ts');
  const observers = createObserverRegistry();
  const handle = observers.register({ name: 'tunnel-watchdog', watches: 'tunnels', everyMs: 30_000 });
  handle.armed();
  observeWatchdog(handle).onRound({
    health: [],
    selected: null,
    changed: false,
    reason: 'no tunnel to probe',
    guards: [
      {
        tunnelId: 'corp',
        selector: 'wf-fall-corp',
        onUnavailable: 'fall-through',
        liveness: { state: 'dead', basis: 'gateway-echo', why: '10.122.0.1 answered earlier on this connection and has stopped' },
        streak: 3,
        action: 'its traffic is leaving OUTSIDE the tunnel by the ordinary route',
        changed: false,
        blocked: false,
        fallingThrough: { forSeconds: 42 },
      },
    ],
  });
  const produced = observers.report().find((entry) => entry.name === 'tunnel-watchdog')!.lastLooked!.items!;
  assert.equal(produced[0]!.fallingThroughSeconds, 42);
  assert.equal(produced[0]!.state, 'FALLING THROUGH');

  const { app, store, close } = await harness({ observers: () => observers.report() });
  t.after(() => {
    void app.close();
    close();
  });
  const token = await tokenWith(store, ['read']);
  const response = await app.inject({ method: 'GET', url: '/api/observers', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  const body = response.json<{ observers: { name: string; problem: string | null; lastLooked: { items: unknown[] } }[] }>();
  const watchdog = body.observers.find((entry) => entry.name === 'tunnel-watchdog')!;
  assert.deepEqual(watchdog.lastLooked.items, produced);
  assert.match(watchdog.problem ?? '', /corp \(42 s\) is leaving OUTSIDE the VPN/);
});
