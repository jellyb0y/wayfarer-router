/**
 * `GET /api/docs` (E8), the documentation link in every 404 (E9), and the shipped default
 * password with no forced change (E16).
 *
 * Each test here is written so it can actually produce the failure it claims to exclude, which for
 * a documentation endpoint is the whole difficulty: a page that renders is not a page that is
 * right.
 *
 * The load-bearing test is `covers every route the server registers`, and the sentence that used to
 * stand here — *"it derives its expectation from the live route table rather than from a list in
 * this file"* — was **not true**. It derived its expectation from `/api/openapi.json`, which is the
 * same `enrichedOpenapi(app, accessIndex)` call the page itself renders, so both sides of the
 * comparison came from one source and the whole thing proved the renderer drops no rows. The route
 * table is now actually read, through `app.wayfarerRouteAccess`, and the mutation that used to pass
 * — a live route declared `schema: { hide: true }` — now fails it, naming the route.
 *
 * The harness also registers the **whole** route set. It did not, and the server it built served 21
 * operations rather than 38.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer, DEFAULT_PASSWORD, type ServerContext } from '../src/api/server.ts';
import { anchorFor, prose, RouteAccessIndex, typeLabel, propertyRows } from '../src/api/docs.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore, type Store } from '../src/state/store.ts';
import { createProfileStore } from '../src/state/profiles.ts';
import { createSecretPlan } from '../src/state/secret-plan.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Platform } from '../src/platform/index.ts';

/** Answers nothing interesting: these tests are about what the surface says, not what it reports. */
function fakePlatform(): Platform {
  const notCalled = (name: string) => (): never => {
    throw new Error(`${name} should not be reached in a documentation test`);
  };
  return {
    systemd: {
      state: async () => ({
        unit: 'x',
        activeState: null,
        subState: null,
        unitFileState: null,
        loadState: null,
        isActive: false,
        isEnabled: false,
        known: false,
      }),
    } as unknown as Platform['systemd'],
    net: {
      addresses: async () => [],
      links: async () => [],
      routes: async () => [],
      snapshot: async () => ({ links: [], addresses: [], routes: [], at: Date.now() }),
      watch: () => ({ stop: () => undefined }),
    } as unknown as Platform['net'],
    wifi: {
      phys: async () => [],
      interfaces: async () => [],
      regulatory: async () => ({ global: null, perPhy: {} }),
      link: notCalled('wifi.link'),
      stations: notCalled('wifi.stations'),
    } as unknown as Platform['wifi'],
    supplicant: {} as Platform['supplicant'],
    ap: {} as Platform['ap'],
    nft: {} as Platform['nft'],
    files: {} as Platform['files'],
    sysctl: { read: notCalled('sysctl.read'), write: notCalled('sysctl.write') } as unknown as Platform['sysctl'],
    clock: {
      status: async () => ({
        timezone: null,
        ntpEnabled: null,
        synchronized: null,
        localRtc: null,
        timeUsec: null,
        rtcTimeUsec: null,
      }),
      resync: notCalled('clock.resync'),
    } as unknown as Platform['clock'],
    host: {
      boardModel: async () => null,
      uptimeSeconds: async () => 4000,
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
      poller: {
        polls: 1,
        skipped: 0,
        failures: 0,
        lastDurationMs: 4,
        lastPollAt: null,
        lastSkipAt: null,
        startedAtMs: null,
      },
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
  close: () => void;
}

/**
 * `password: null` leaves the device exactly as it ships — no admin password has ever been set —
 * which is the only state in which E16 can be observed at all.
 */
async function harness(options: { password?: string | null } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-docs-'));
  const database = openDatabase({ path: join(directory, 'state.db') });
  const store = createStore(database);
  const password = options.password === undefined ? 'a-long-enough-password' : options.password;
  if (password !== null) await store.setAdminPassword(password);
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
    /*
     * **The profile routes, which this harness used to leave out.**
     *
     * Without them the server built here served 21 operations instead of 38: everything under
     * `/api/profiles`, plus `/api/apply`, `/api/plan`, `/api/transactions*`, `/api/protocols`,
     * `/api/schemas/profile` and `/api/subscriptions/parse` were never registered, so no assertion
     * in this file had ever seen them — and the anti-vacuity floor of `>= 15` passed comfortably on
     * 21. **A floor a broken harness clears is not a floor.**
     *
     * The collaborators are stubs that throw, because these tests ask the surface what it says and
     * never make it do anything. What matters is that the routes are *registered*, which is what
     * puts them in the route table the coverage check reads.
     */
    profileRoutes: {
      store,
      profiles: createProfileStore(database, createSecretPlan()),
      platform: fakePlatform(),
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
  return { app, store, close: () => database.close() };
}

/** A collaborator a documentation test must never need. Throwing says so rather than answering `{}`. */
function notReached(name: string): never & (() => never) {
  return (() => {
    throw new Error(`${name} should not be reached in a documentation test`);
  }) as never & (() => never);
}

/**
 * Every route the server actually registered, from the live route table.
 *
 * The independent second source. `RouteAccessIndex` is filled by the `onRoute` hook, which sees
 * every route whatever its schema says — including one declared `schema: { hide: true }`, which is
 * exactly the route `@fastify/swagger` omits and which proved the old assertion was circular.
 */
function registeredRoutes(app: Awaited<ReturnType<typeof buildServer>>): { method: string; path: string }[] {
  return app.wayfarerRouteAccess.keys().map((entry) => {
    const [method = '', path = ''] = entry.split(' ');
    return { method: method.toLowerCase(), path };
  });
}

async function readToken(store: Store): Promise<string> {
  return store.createToken('docs-read', ['read']).token;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Every operation the generated document contains, as `{ method, path }`. */
function operationsOf(
  document: Record<string, unknown>,
): { method: string; path: string; operation: Record<string, unknown> }[] {
  const paths = document['paths'] as Record<string, Record<string, unknown>>;
  const out: { method: string; path: string; operation: Record<string, unknown> }[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation && typeof operation === 'object') {
        out.push({ method, path, operation: operation as Record<string, unknown> });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- E8

/**
 * The page covers every route **the route table** knows, not every row the page's own generator
 * produced.
 *
 * The previous version of this test fetched `/api/openapi.json` and asserted each operation had an
 * anchor in `/api/docs` — and both sides come from the same `enrichedOpenapi(app, accessIndex)`
 * call. It proved the renderer drops no rows, which nothing had ever suggested, and said nothing
 * about whether the document describes the server. Proved by construction: adding a live
 * `app.get('/api/secret-backdoor', { schema: { hide: true } })` yields a route that answers 200 and
 * appears in neither the document nor the page, **and the assertion, replayed verbatim, passed.**
 *
 * `RouteAccessIndex` is filled by the `onRoute` hook, which sees every route regardless of its
 * schema. That is the independent source, and the comment on `keys()` said so long before anything
 * called it.
 */
test('the documentation page covers every route the server registers', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await readToken(store);
  const headers = { authorization: `Bearer ${token}` };

  const routes = registeredRoutes(app);

  /*
   * The anti-vacuity control, and it is named rather than counted.
   *
   * `>= 15` was the old one, and the harness generated 21 because it had never registered the
   * profile routes — so the floor was cleared by a server missing 17 of its 38 routes. A number
   * cannot tell "the surface is small" from "the harness is incomplete". This can: the profile
   * family is exactly what was missing, and its absence is what the floor failed to notice.
   */
  assert.ok(
    routes.some((route) => route.path.startsWith('/api/profiles')),
    'this harness did not register the profile routes, so everything below is about a partial server',
  );

  const page = await app.inject({ method: 'GET', url: '/api/docs', headers });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  const html = page.body;

  const missing = routes.filter((route) => !html.includes(`id="${anchorFor(route.method, route.path)}"`));
  assert.deepEqual(
    missing.map((route) => `${route.method.toUpperCase()} ${route.path}`),
    [],
    'these routes are registered and answer, and have no entry on /api/docs',
  );
});

/**
 * And the same comparison in the other direction, so the document cannot describe a route that does
 * not exist.
 *
 * Worth its own test because the two failures are different things: a route the page omits is a
 * surface nobody can discover, and an operation with no route behind it is documentation that lies.
 */
test('the generated document describes nothing the server does not serve', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const headers = { authorization: `Bearer ${await readToken(store)}` };

  const spec = await app.inject({ method: 'GET', url: '/api/openapi.json', headers });
  assert.equal(spec.statusCode, 200);
  const operations = operationsOf(spec.json<Record<string, unknown>>());
  const registered = new Set(registeredRoutes(app).map((route) => `${route.method} ${route.path}`));

  assert.deepEqual(
    operations.filter((op) => !registered.has(`${op.method} ${op.path}`)).map((op) => `${op.method} ${op.path}`),
    [],
    'the document describes operations the route table has never heard of',
  );
});

test('the page states the scope each route actually enforces, read from the route table', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await readToken(store);
  const headers = { authorization: `Bearer ${token}` };

  const document = (await app.inject({ method: 'GET', url: '/api/openapi.json', headers })).json<
    Record<string, unknown>
  >();
  const operations = operationsOf(document);

  const undeclared = operations.filter(
    ({ operation }) => (operation['x-wayfarer-access'] as { kind?: string } | undefined)?.kind === 'undeclared',
  );
  assert.deepEqual(
    undeclared.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
    [],
    'these operations are served but the route table gave no access rule for them',
  );

  // The claim is checked against the server's own behaviour, not against itself: a `GET` documented
  // as needing `admin` must actually refuse a credential that carries only `read`. A document that
  // merely agreed with a map built from the same map would prove nothing.
  const adminGets = operations.filter(
    ({ method, operation }) =>
      method === 'get' &&
      (operation['x-wayfarer-access'] as { kind?: string; scope?: string } | undefined)?.scope === 'admin',
  );
  assert.ok(adminGets.length > 0, 'no admin-scoped GET was documented, so this test proved nothing');
  for (const { path } of adminGets) {
    if (path.includes('{')) continue;
    const response = await app.inject({ method: 'GET', url: path, headers });
    assert.equal(
      response.statusCode,
      403,
      `${path} is documented as needing "admin" but answered ${response.statusCode} to a read-only token`,
    );
  }

  // And the other direction: everything documented as `read` is reachable with a read token.
  const readGets = operations.filter(
    ({ method, path, operation }) =>
      method === 'get' &&
      !path.includes('{') &&
      (operation['x-wayfarer-access'] as { scope?: string } | undefined)?.scope === 'read',
  );
  assert.ok(readGets.length > 0, 'no read-scoped GET was documented, so this test proved nothing');
  for (const { path } of readGets) {
    // The event stream never completes, and a status route may depend on machinery this harness
    // does not build. Neither is what this assertion is about.
    if (path === '/api/events') continue;
    const response = await app.inject({ method: 'GET', url: path, headers });
    assert.notEqual(response.statusCode, 403, `${path} is documented as "read" but refused a read token`);
  }
});

test('the page fetches nothing from outside the device', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await readToken(store);
  const page = await app.inject({
    method: 'GET',
    url: '/api/docs',
    headers: { authorization: `Bearer ${token}` },
  });

  // The operator who needs this page is frequently on a network with no route out — often because
  // this device is the reason. A page that pulls its renderer from a CDN is blank exactly then.
  const external = /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//gi;
  const matches = page.body.match(external) ?? [];
  assert.deepEqual(matches, [], 'the documentation page references a resource it cannot reach offline');
  assert.ok(!page.body.includes('<script'), 'the documentation page carries script, which it does not need');
});

test('the page escapes what it interpolates', () => {
  // Reaching the renderer directly, because getting a hostile string into a real schema means
  // editing a package this stream does not own — and the escaping is the part worth proving.
  const index = new RouteAccessIndex();
  index.record('GET', '/api/x', { kind: 'scope', scope: 'read' });
  assert.equal(index.lookup('get', '/api/x')?.kind, 'scope');
  // Fastify writes `/:id`, OpenAPI writes `/{id}`. A join that silently missed would label every
  // parameterised operation "access not declared" while looking entirely healthy.
  index.record('GET', '/api/profiles/:id', { kind: 'scope', scope: 'read' });
  assert.equal(index.lookup('get', '/api/profiles/{id}')?.kind, 'scope');
});

test('the type labels and property rows describe schemas rather than echoing them', () => {
  assert.equal(typeLabel({ $ref: '#/components/schemas/StatusResponse' }), 'StatusResponse');
  assert.equal(typeLabel({ type: 'array', items: { type: 'string' } }), 'array of string');
  assert.equal(typeLabel({ anyOf: [{ type: 'string' }, { type: 'null' }] }), 'string | null');
  assert.equal(typeLabel(undefined), 'any');
  // Not an object schema: null, so the caller prints the type instead of an empty table. An empty
  // table reads as "this takes nothing", which is a different claim from "this is not an object".
  assert.equal(propertyRows({ type: 'string' }), null);
  const rows = propertyRows({
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string' }, b: { type: 'number', description: 'note' } },
  });
  assert.deepEqual(rows, [
    { name: 'a', type: 'string', required: true, description: null },
    { name: 'b', type: 'number', required: false, description: 'note' },
  ]);
});

test('prose escapes before it renders, so a description cannot bring its own markup', () => {
  // Descriptions are Markdown in the source and are rendered with one construct honoured. The order
  // is the whole of the safety: escape, then substitute the tags this file emits. Reversed, a
  // description containing a script tag would be a script tag.
  assert.equal(prose('a `code` span'), 'a <code>code</code> span');
  assert.equal(
    prose('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    'markup in a description reached the page as markup',
  );
  // And the two together: the backticked span is still only ever wrapped in the tag this file
  // wrote, around text that has already lost its angle brackets.
  assert.equal(prose('`<b>x</b>`'), '<code>&lt;b&gt;x&lt;/b&gt;</code>');
  assert.equal(prose('an unclosed ` backtick'), 'an unclosed ` backtick');
});

// ---------------------------------------------------------------------------- E9

test('every 404 on the API names the documentation endpoint as a link', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await readToken(store);
  const admin = store.createToken('docs-admin', ['admin']).token;

  // Two shapes on purpose: the catch-all not-found handler, and a route that answers 404 from
  // inside its own handler. The second is the one a per-route fix would have missed.
  const cases = [
    { url: '/api/no-such-thing', headers: { authorization: `Bearer ${token}` } },
    { url: '/api/tokens/does-not-exist', headers: { authorization: `Bearer ${admin}` } },
  ];

  for (const probe of cases) {
    const response = await app.inject({
      method: probe.url.startsWith('/api/tokens/') ? 'DELETE' : 'GET',
      url: probe.url,
      headers: probe.headers,
    });
    assert.equal(response.statusCode, 404, `${probe.url} answered ${response.statusCode}`);
    const body = response.json<{ error: { code: string; hint?: string; detail?: { documentation?: string } } }>();
    assert.equal(body.error.code, 'not_found');
    const link = body.error.detail?.documentation;
    assert.equal(
      typeof link,
      'string',
      `${probe.url} returned a 404 with no documentation link: ${JSON.stringify(body)}`,
    );
    assert.ok(String(link).endsWith('/api/docs'), `the link does not point at the documentation: ${String(link)}`);
    assert.match(String(link), /^https?:\/\//, 'the documentation link is not a link');
    assert.match(String(body.error.hint), /\/api\/docs/);
  }
});

test('a non-404 response is not rewritten by the 404 hook', async (t) => {
  const { app, store, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });
  const token = await readToken(store);
  const ok = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(ok.statusCode, 200);
  assert.ok(!ok.body.includes('/api/docs'), 'a 200 was given a documentation link it never asked for');

  const forbidden = await app.inject({
    method: 'GET',
    url: '/api/tokens',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(forbidden.statusCode, 403);
  const body = forbidden.json<{ error: { hint: string } }>();
  // A 403 already carries a hint that says which scopes the credential has. The hook must not have
  // replaced it: it only ever fills an absent one, and only on a 404.
  assert.match(body.error.hint, /carries/);
});

// ---------------------------------------------------------------------------- E16

test('a device that has never had its password set signs in with the shipped default', async (t) => {
  const { app, close } = await harness({ password: null });
  t.after(() => {
    void app.close();
    close();
  });

  assert.equal(DEFAULT_PASSWORD, 'adminpass');
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: DEFAULT_PASSWORD },
  });
  assert.equal(response.statusCode, 200, `login with the shipped default answered ${response.statusCode}`);
  const body = response.json<Record<string, unknown>>();
  // Reported, not enforced: false means the default is still in place, and nothing is refused for it.
  assert.equal(body['setupComplete'], false);
  // Removed from the contract, and asserted absent rather than assumed: the serialiser drops an
  // undeclared field silently, so "we stopped sending it" and "it is still computed and dropped"
  // look identical from the outside. This says which one is true.
  assert.ok(!('mustChangePassword' in body), 'mustChangePassword is still in the login reply');

  const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wayfarer' } });
  assert.equal(wrong.statusCode, 401, 'the previous default password is still accepted');
});

test('nothing is refused because the default password is still in place', async (t) => {
  const { app, close } = await harness({ password: null });
  t.after(() => {
    void app.close();
    close();
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: DEFAULT_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.find((entry) => entry.name === 'wayfarer_session');
  assert.ok(cookie, 'no session cookie was set');
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  // The gate this replaces answered 403 `setup_incomplete` on every one of these. If it comes back,
  // by any route, these fail — which is the point of naming the code rather than only the status.
  for (const url of ['/api/system', '/api/inventory', '/api/eventlog', '/api/docs', '/api/openapi.json']) {
    const response = await app.inject({ method: 'GET', url, headers });
    assert.notEqual(response.statusCode, 403, `${url} was refused while the default password was in place`);
    assert.ok(
      !response.body.includes('setup_incomplete'),
      `${url} still refuses with setup_incomplete, so the forced-change gate survived`,
    );
  }
});

test('the shipped default cannot be set as a new password', async (t) => {
  const { app, close } = await harness({ password: null });
  t.after(() => {
    void app.close();
    close();
  });

  // The change-password route is not public: it is reachable by any authenticated credential and
  // no scope, which is what dropping the setup gate left behind. So sign in first — and that is
  // itself the E16 shape, because signing in is now possible without changing anything.
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: DEFAULT_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.find((entry) => entry.name === 'wayfarer_session');
  assert.ok(cookie, 'no session cookie was set');
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  // The one-way valve: leaving the default is easy, returning to it is impossible. `adminpass` is
  // nine characters and the schema requires twelve, so this is refused before the handler's own
  // check — both are correct, and this asserts the outcome rather than which one fired.
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers,
    payload: { currentPassword: DEFAULT_PASSWORD, newPassword: DEFAULT_PASSWORD },
  });
  assert.equal(response.statusCode, 400, `setting the default as the new password answered ${response.statusCode}`);

  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers,
    payload: { currentPassword: DEFAULT_PASSWORD, newPassword: 'a-properly-long-password' },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json<{ setupComplete: boolean }>().setupComplete, true);
});

/**
 * The caller the documentation link was written for could not be given one.
 *
 * The authentication gate is an `onRequest` hook, so it fires **before routing**: an unauthenticated
 * request for a path that does not exist never reaches the not-found handler, and answered
 * `401 {"code":"unauthenticated","hint":"POST /api/auth/login"}` with no link at all. Somebody who
 * has mistyped a path and has not logged in is the most likely reader of a documentation link there
 * is, and they were the only caller excluded from it.
 */
test('an unauthenticated request for a path that does not exist is given the documentation link', async (t) => {
  const { app, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });

  const response = await app.inject({ method: 'GET', url: '/api/no-such-thing' });
  assert.equal(response.statusCode, 401, response.body);
  const body = response.json<{ error: { code: string; hint?: string; detail?: { documentation?: string } } }>();
  assert.equal(body.error.code, 'unauthenticated');
  assert.match(
    String(body.error.detail?.documentation),
    /^https?:\/\/.*\/api\/docs$/,
    `no documentation link: ${response.body}`,
  );
  // The hint it already had is kept. How to log in is still the first thing this reader needs; the
  // link is added to it, not instead of it.
  assert.match(String(body.error.hint), /POST \/api\/auth\/login/);
  assert.match(String(body.error.hint), /\/api\/docs/);
});

/**
 * And the link has to answer.
 *
 * `/api/docs` required the `read` scope, so a caller who followed the link from a 401 got another
 * 401: a wall with a signpost on it. It is public now, and the endpoint's own justification is the
 * argument — "the operator who needs it is often on a network with no route out" is a description of
 * somebody who has not logged in. It describes shapes and never data.
 */
test('the documentation the link points at answers without a credential', async (t) => {
  const { app, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });

  const page = await app.inject({ method: 'GET', url: '/api/docs' });
  assert.equal(page.statusCode, 200, `the documentation link leads to ${page.statusCode}`);
  assert.match(page.headers['content-type'] as string, /text\/html/);

  // The machine-readable form is deliberately not opened with it: nothing links to it from a
  // refusal, and its reader already holds a credential. Asserted so the asymmetry is a decision
  // somebody has to change on purpose rather than something that drifts.
  const spec = await app.inject({ method: 'GET', url: '/api/openapi.json' });
  assert.equal(spec.statusCode, 401, 'the machine-readable document became public without a decision');
});

/**
 * A 404 outside `/api/` got nothing, because the hook returned early on the path.
 *
 * The condition that matters is not where the request went — it is whether the body is already the
 * documented error envelope. A device with no interface installed answers `no_interface` to every
 * unmatched path, and that is precisely the device whose operator has only the API to work with.
 */
test('a 404 outside the API still names the documentation, when it is our own error body', async (t) => {
  const { app, close } = await harness();
  t.after(() => {
    void app.close();
    close();
  });

  const response = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(response.statusCode, 404);
  const body = response.json<{ error: { code: string; detail?: { documentation?: string } } }>();
  assert.equal(body.error.code, 'no_interface');
  assert.match(
    String(body.error.detail?.documentation),
    /^https?:\/\/.*\/api\/docs$/,
    `a 404 with no link: ${response.body}`,
  );
});
