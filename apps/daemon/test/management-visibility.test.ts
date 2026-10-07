/**
 * What `GET /api/system` says about the management channels, on the wire.
 *
 * ## The trap this file is built around
 *
 * The daemon computed the refusals and the withholdings and they died in the process. Then the
 * handler was written to report them — and the fields did not appear in the response, because a
 * Fastify response schema is a *serializer*: a key the schema does not declare is dropped, with no
 * error, no warning and no log line. A handler that returns the right object and a handler that
 * returns nothing are indistinguishable from the client, which is the shape that hid the absence in
 * the first place.
 *
 * So every assertion here goes through `app.inject` rather than calling the reporting function. A
 * unit test of `managementChannels()` — there is one, in `bind-policy.test.ts` — proves the report
 * is right and says nothing about whether it leaves the process.
 *
 * ## Null is not an empty list
 *
 * The three fields are `null` until the bind policy has run. An empty list is a reassuring answer —
 * *nothing was refused* — delivered in exactly the case where nobody has looked yet, so the two
 * states are kept distinguishable on the wire and both directions are asserted below: null before,
 * `[]` after a run that refused nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer, type ServerContext } from '../src/api/server.ts';
import type { ManagementChannels } from '../src/api/bind-policy.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore, type Store } from '../src/state/store.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Platform } from '../src/platform/index.ts';

/** Answers nothing interesting: these tests are about what reaches the wire, not what the kernel says. */
function fakePlatform(): Platform {
  const notCalled = (name: string) => (): never => {
    throw new Error(`${name} should not be reached in a visibility test`);
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

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  store: Store;
  close: () => void;
}

/**
 * `channels` left out is the state of a device that has never applied anything: nothing has bound,
 * so the daemon has no decision to report. It is passed explicitly as `undefined` rather than
 * omitted from this signature, because "the policy has not run" is the case the null exists for and
 * it has to be constructible on purpose.
 */
async function harness(channels?: () => ManagementChannels | null): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-visibility-'));
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
    ...(channels === undefined ? {} : { managementChannels: channels }),
  };

  const app = await buildServer(context);
  return { app, store, close: () => database.close() };
}

async function system(app: Harness['app'], store: Store): Promise<Record<string, unknown>> {
  const token = store.createToken('visibility-read', ['read']).token;
  const response = await app.inject({
    method: 'GET',
    url: '/api/system',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, `/api/system answered ${response.statusCode}`);
  return response.json<Record<string, unknown>>();
}

/**
 * The first question asked of a device that has never applied anything.
 *
 * The keys must be **present and null**. Present, because an absent key is the serializer having
 * dropped it and is what this whole file is about; null, because the alternative an implementation
 * drifts towards — `[]` — tells the operator that nothing was refused, which is a claim nobody is
 * in a position to make before the policy has run once.
 *
 * `Object.hasOwn` rather than a truthiness check: `undefined` and `null` are the two answers this
 * test has to tell apart, and every loose comparison treats them as the same.
 */
test('a device that has never applied anything reports null channels, not empty lists', async (t) => {
  const { app, store, close } = await harness();
  t.after(close);

  const body = await system(app, store);

  for (const key of ['channels', 'refused', 'withheld']) {
    assert.ok(
      Object.hasOwn(body, key),
      `${key} is not in the response at all. A Fastify response schema is a serializer: a key the ` +
        'schema does not declare is dropped silently, so an absent key here means `SystemResponse` ' +
        'in `packages/schemas` stopped carrying it — not that the handler stopped returning it.',
    );
    assert.equal(
      body[key],
      null,
      `${key} came back as ${JSON.stringify(body[key])} on a device whose bind policy has never ` +
        'run. An empty list here says "nothing was refused", which is the reassuring answer given ' +
        'in exactly the case where nobody has looked.',
    );
  }
});

/**
 * And the other direction, which is what makes the null above mean anything.
 *
 * A null that is also returned after a successful run is not a signal, it is a field nobody filled.
 * So the same three keys are asserted against a policy that *has* run: `channels` carries the
 * interfaces, and `refused` is `[]` — an empty list that now genuinely means nothing was refused.
 *
 * The class travels verbatim. `wirelessUplink` is the classifier's own word and it is asserted on
 * the wire rather than translated at the boundary: a second vocabulary for one fact is a place for
 * the two to disagree about a device, and the translation is written by whoever is least sure what
 * the classifier meant.
 */
test('once the policy has run, an empty refusal list is an answer rather than an absence', async (t) => {
  const report: ManagementChannels = {
    channels: [
      { interface: 'lo', class: 'loopback', addresses: ['127.0.0.1'], listening: true },
      { interface: 'end0', class: 'wired', addresses: ['192.168.1.2'], listening: false },
      { interface: 'wlan1', class: 'wirelessUplink', addresses: ['10.0.0.5'], listening: true },
    ],
    refused: [],
    withheld: [{ interface: 'wlan2', class: 'wirelessUplink', reason: 'the operator turned the uplink off' }],
  };
  const { app, store, close } = await harness(() => report);
  t.after(close);

  const body = await system(app, store);

  assert.deepEqual(body['refused'], [], 'a policy that refused nothing reports an empty list, not null');
  assert.deepEqual(body['withheld'], [
    { interface: 'wlan2', class: 'wirelessUplink', reason: 'the operator turned the uplink off' },
  ]);
  assert.deepEqual(body['channels'], report.channels);

  /*
   * `end0` is named, has an address and is not listening. That is the defect measured on the bench
   * board: an interface the configuration chose and nothing bound. It has to survive to the client
   * as `listening: false` rather than as absence from a list of names, because a view drawing
   * chosen names renders "named and silent" identically to "working".
   */
  const wire = (body['channels'] as { interface: string; listening: boolean }[]).find(
    (entry) => entry.interface === 'end0',
  );
  assert.equal(wire?.listening, false, 'a chosen interface that bound nothing must reach the client as silent');
});

/**
 * A refusal reaches the wire whole, with the classifier's sentence.
 *
 * Asserted separately from the empty case because the two are opposite failures. A refusal means the
 * positive half of the policy offered a **tunnel** as a management channel — a defect upstream, not
 * a lucky save — and the only screen a person could see it on reports what arrives in this field.
 *
 * `reason` is asserted as the classifier's own text rather than a code. A test that accepted any
 * non-empty string would pass against `TUNNEL_EXCLUDED`, which tells its reader that we have a
 * constant for the situation and nothing about the situation.
 */
test('a refusal arrives with the interface, the class and the reason in words', async (t) => {
  const report: ManagementChannels = {
    channels: [{ interface: 'wg0', class: 'tunnel', addresses: ['10.136.0.1'], listening: false }],
    refused: [{ interface: 'wg0', class: 'tunnel', reason: 'ip reports kind=wireguard: a tunnel is never a management channel' }],
    withheld: [],
  };
  const { app, store, close } = await harness(() => report);
  t.after(close);

  const body = await system(app, store);

  assert.deepEqual(body['refused'], [
    { interface: 'wg0', class: 'tunnel', reason: 'ip reports kind=wireguard: a tunnel is never a management channel' },
  ]);
  assert.deepEqual(body['withheld'], [], 'a withholding is a choice and a refusal is a defect; they do not share a list');
});
