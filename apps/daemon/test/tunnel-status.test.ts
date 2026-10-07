/**
 * What `GET /api/status` says about tunnels, and what a tunnel's units add up to.
 *
 * ## Why this file exists at all
 *
 * `LiveStatus` carried interfaces, units, access points, links, the clock and the poller counters —
 * and no tunnels. The endpoint therefore had nothing to report about the four tunnels carrying the
 * owner's traffic, and the report of that absence looked exactly like a healthy device with nothing
 * to say. That is the same silence twice: a value nothing produces, and then a key no schema
 * declares, which a Fastify response schema drops from the body without an error, a warning or a log
 * line.
 *
 * So the source and the schema key land together, and the assertions about the wire go through
 * `app.inject` rather than through the snapshot. A test that reads the snapshot proves the reading
 * is right and says nothing about whether it leaves the process.
 *
 * ## `undefined` and `null` are the two answers this file has to tell apart
 *
 * An absent key is the serializer having dropped it. A `null` is the device saying nobody has looked
 * yet. Every check here uses `Object.hasOwn` **and** a strict comparison, because a test written as
 * `assert.equal(body.tunnels, null)` under the loose `node:assert` would pass with the schema key
 * deleted — it would assert precisely the failure it was written to catch. This file imports
 * `node:assert/strict`; the pairing is kept anyway, because the import is one line away from being
 * changed by somebody who does not know that is what holds it up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer, type ServerContext } from '../src/api/server.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore, type Store } from '../src/state/store.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Platform } from '../src/platform/index.ts';
import { createTelemetry, type LiveStatus } from '../src/telemetry/index.ts';
import { aggregateTunnelStatus, type TunnelUnitReading } from '../src/core/tunnel-health.ts';

/* ── the aggregate over a tunnel's units ─────────────────────────────────────────────────── */

function reading(overrides: Partial<TunnelUnitReading> & { unit: string }): TunnelUnitReading {
  return {
    activeState: 'active',
    loadState: 'loaded',
    restarts: 0,
    activeEnterSinceBootSeconds: 1,
    ...overrides,
  };
}

const AT = { uptimeSeconds: 1000, nowMs: Date.parse('2026-09-21T12:00:00.000Z') };

test('a tunnel whose every unit is active reports running', () => {
  const status = aggregateTunnelStatus({
    id: 'work',
    units: [reading({ unit: 'wf-openvpn@work.service' }), reading({ unit: 'wf-cloak@work.service' })],
    ...AT,
  });
  assert.equal(status.service, 'running');
});

/**
 * The ordering rule, and the direction it was decided in.
 *
 * A component **known** to be down is a stronger fact than one nobody could read, so a tunnel with a
 * dead transport and an unreadable client is `stopped` and not `unknown`. Reporting `unknown` there
 * would hide the one thing worth acting on behind the one thing nobody can act on.
 */
test('stopped outranks unknown, in either order', () => {
  const stopped = reading({ unit: 'a.service', activeState: 'inactive' });
  const unreadable = reading({ unit: 'b.service', activeState: null, loadState: null, restarts: null });

  assert.equal(aggregateTunnelStatus({ id: 't', units: [stopped, unreadable], ...AT }).service, 'stopped');
  assert.equal(aggregateTunnelStatus({ id: 't', units: [unreadable, stopped], ...AT }).service, 'stopped');
});

test('unknown wins over running when nothing is stopped', () => {
  const status = aggregateTunnelStatus({
    id: 't',
    units: [
      reading({ unit: 'a.service' }),
      reading({ unit: 'b.service', activeState: null, loadState: null, restarts: null }),
    ],
    ...AT,
  });
  assert.equal(status.service, 'unknown');
});

/** A unit systemd has never heard of answers `inactive`/`dead`/`not-found`, not an error. */
test('a unit systemd does not have is unknown rather than stopped', () => {
  const status = aggregateTunnelStatus({
    id: 't',
    units: [reading({ unit: 'typo.service', activeState: 'inactive', loadState: 'not-found' })],
    ...AT,
  });
  assert.equal(status.service, 'unknown');
});

/**
 * **What this check prints when it is given nothing.**
 *
 * The question every guard in this repository is now asked of itself. "Every unit is active" over an
 * empty list is vacuously true, so the obvious implementation reports a tunnel with no units at all
 * as `running` — the reassuring answer, produced in the case where nothing has been said.
 */
test('a tunnel with no units is unknown, never running', () => {
  const status = aggregateTunnelStatus({ id: 't', units: [], ...AT });
  assert.equal(status.service, 'unknown');
  assert.equal(status.restarts, null);
  assert.equal(status.since, null);
});

/**
 * The maximum, never the sum, and the number chosen to prove it.
 *
 * A reconnection restarts a transport and the tunnel it carries together, so a sum counts every
 * reconnection twice. Two units at 2 restarts each sum to 4 and max to 2 — either side of the
 * warning threshold of 3, which is the whole practical difference: a device that reconnected twice
 * would be reported as a configuration that is never going to start working.
 */
test('restarts is the maximum across a tunnel units, not their sum', () => {
  const status = aggregateTunnelStatus({
    id: 't',
    units: [reading({ unit: 'a.service', restarts: 2 }), reading({ unit: 'b.service', restarts: 2 })],
    ...AT,
  });
  assert.equal(status.restarts, 2);
});

test('an unreadable restart count is skipped rather than counted as a maximum of zero', () => {
  const status = aggregateTunnelStatus({
    id: 't',
    units: [reading({ unit: 'a.service', restarts: 5 }), reading({ unit: 'b.service', restarts: null })],
    ...AT,
  });
  assert.equal(status.restarts, 5);
});

/** `0` is "never restarted", which is news. `null` is "nobody could look", which is not. */
test('restarts is null, not zero, when no unit could be read', () => {
  const status = aggregateTunnelStatus({
    id: 't',
    units: [reading({ unit: 'a.service', activeState: null, loadState: null, restarts: null })],
    ...AT,
  });
  assert.equal(status.restarts, null);
});

/**
 * `since` is the **most recent** active-enter, and it is derived from two numbers on one clock.
 *
 * Seconds since boot for the unit, seconds since boot for the machine; the difference is an age, and
 * the age is anchored to wall-clock once, here. The wall-clock `ActiveEnterTimestamp` property is not
 * part of `TunnelUnitReading` at all, which is deliberate: this board has no battery-backed clock, a
 * step of years the moment a time source appears is ordinary, and after one that property is in the
 * old frame while `now` is in the new one — so a client subtracting them gets a duration that never
 * happened. Making the wrong value unavailable is stronger than a comment asking for the right one.
 */
test('since is the most recent active-enter, computed from uptime rather than a wall clock', () => {
  const status = aggregateTunnelStatus({
    id: 't',
    units: [
      // 900s before the reading, and 60s before it. The transport that came up a minute ago is what
      // the tunnel's current attempt is worth dating from.
      reading({ unit: 'old.service', activeEnterSinceBootSeconds: 100 }),
      reading({ unit: 'new.service', activeEnterSinceBootSeconds: 940 }),
    ],
    ...AT,
  });
  assert.equal(status.since, new Date(AT.nowMs - 60_000).toISOString());
});

test('since is null when the machine uptime could not be read', () => {
  const status = aggregateTunnelStatus({
    id: 't',
    units: [reading({ unit: 'a.service', activeEnterSinceBootSeconds: 940 })],
    uptimeSeconds: null,
    nowMs: AT.nowMs,
  });
  assert.equal(status.since, null);
});

/** A unit that has never been active reports a monotonic timestamp of zero, which is not a date. */
test('a unit that has never been active contributes no since', () => {
  const status = aggregateTunnelStatus({
    id: 't',
    units: [reading({ unit: 'a.service', activeState: 'inactive', activeEnterSinceBootSeconds: 0 })],
    ...AT,
  });
  assert.equal(status.since, null);
});

/* ── the reading, through telemetry ──────────────────────────────────────────────────────── */

interface ShowCall {
  unit: string;
}

/**
 * A platform that answers only what a tunnel reading asks for, and records what was asked.
 *
 * Everything else throws rather than returning an empty answer, so a reading that starts consulting
 * a second source shows up as a failure here instead of as a plausible number.
 */
function pollingPlatform(calls: ShowCall[], properties: Record<string, Record<string, string>>): Platform {
  const notCalled = (name: string) => (): never => {
    throw new Error(`${name} should not be reached in a tunnel-status test`);
  };
  return {
    systemd: {
      state: async (unit: string) => ({
        unit,
        activeState: null,
        subState: null,
        unitFileState: null,
        loadState: null,
        isActive: false,
        isEnabled: false,
        known: false,
      }),
      show: async (unit: string) => {
        calls.push({ unit });
        const found = properties[unit];
        if (found === undefined) throw new Error(`no such unit: ${unit}`);
        return { properties: found };
      },
    } as unknown as Platform['systemd'],
    net: {
      snapshot: async () => ({ links: [], addresses: [], routes: [], at: Date.now() }),
      watch: () => ({ stop: () => undefined }),
    } as unknown as Platform['net'],
    wifi: { link: notCalled('wifi.link') } as unknown as Platform['wifi'],
    supplicant: {} as Platform['supplicant'],
    ap: {} as Platform['ap'],
    nft: {} as Platform['nft'],
    files: {} as Platform['files'],
    sysctl: {} as Platform['sysctl'],
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
    host: { uptimeSeconds: async () => 1000 } as unknown as Platform['host'],
    binaries: {} as Platform['binaries'],
    journal: { currentBootId: async () => 'boot' } as unknown as Platform['journal'],
    close: () => undefined,
  };
}

const ACTIVE_60S_AGO = {
  ActiveState: 'active',
  LoadState: 'loaded',
  NRestarts: '1',
  // 940s since boot, against a machine uptime of 1000s.
  ActiveEnterTimestampMonotonic: String(940 * 1_000_000),
};

test('the snapshot carries null tunnels until something says what the tunnels are', async (t) => {
  const calls: ShowCall[] = [];
  const telemetry = createTelemetry(pollingPlatform(calls, {}));
  const stop = await telemetry.start({ pollIntervalMs: 3_600_000 });
  t.after(async () => await stop());

  assert.equal(telemetry.snapshot().tunnels, null);
  // A poll that ran while nothing had been declared must not publish the reassuring empty list.
  await telemetry.pollNow();
  assert.equal(telemetry.snapshot().tunnels, null);
  assert.deepEqual(calls, []);
});

test('a profile with no tunnels reports an empty list once it has been read', async (t) => {
  const calls: ShowCall[] = [];
  const telemetry = createTelemetry(pollingPlatform(calls, {}));
  const stop = await telemetry.start({ pollIntervalMs: 3_600_000 });
  t.after(async () => await stop());

  telemetry.watchTunnels([]);
  // The first poll of a process is on the reduced cadence, so one is enough.
  await telemetry.pollNow();
  assert.deepEqual(telemetry.snapshot().tunnels, []);
});

test('a watched tunnel is read through show and aggregated over all of its units', async (t) => {
  const calls: ShowCall[] = [];
  const telemetry = createTelemetry(
    pollingPlatform(calls, {
      'wf-openvpn@work.service': ACTIVE_60S_AGO,
      'wf-cloak@work.service': { ...ACTIVE_60S_AGO, NRestarts: '4', ActiveState: 'inactive' },
    }),
  );
  const stop = await telemetry.start({ pollIntervalMs: 3_600_000 });
  t.after(async () => await stop());

  telemetry.watchTunnels([{ id: 'work', units: ['wf-openvpn@work.service', 'wf-cloak@work.service'] }]);
  await telemetry.pollNow();

  const tunnels = telemetry.snapshot().tunnels;
  assert.equal(tunnels?.length, 1);
  assert.equal(tunnels?.[0]?.id, 'work');
  // The transport is down, so the tunnel is down — whatever the other unit says about itself.
  assert.equal(tunnels?.[0]?.service, 'stopped');
  // Four and one, not five.
  assert.equal(tunnels?.[0]?.restarts, 4);
  assert.equal(calls.length, 2, 'both units of the tunnel are read');
});

/**
 * The cadence, asserted by counting spawns rather than by reading the modulus back.
 *
 * A reading is one `systemctl show` per unit, and a tunnel is not one unit: four tunnels, two of
 * them behind a transport, is an ordinary configuration here and would be six process spawns on
 * every poll of a 4×Cortex-A53. A test that asserted the constant would stay green if the condition
 * were dropped; this one goes red.
 */
test('tunnels are read on a reduced cadence rather than on every poll', async (t) => {
  const calls: ShowCall[] = [];
  const telemetry = createTelemetry(pollingPlatform(calls, { 'a.service': ACTIVE_60S_AGO }));
  const stop = await telemetry.start({ pollIntervalMs: 3_600_000 });
  t.after(async () => await stop());

  telemetry.watchTunnels([{ id: 't', units: ['a.service'] }]);
  for (let poll = 0; poll < 6; poll += 1) await telemetry.pollNow();

  /*
   * Seven polls have run counting `start`'s own. Two of them read: the one just after the watched
   * set changed, and the one that fell on the cadence. Without the cadence condition it is six.
   */
  assert.equal(calls.length, 2, `expected two readings across seven polls, got ${calls.length}`);
});

test('a unit whose show fails leaves the tunnel unknown instead of dropping it', async (t) => {
  const calls: ShowCall[] = [];
  const telemetry = createTelemetry(pollingPlatform(calls, {}));
  const stop = await telemetry.start({ pollIntervalMs: 3_600_000 });
  t.after(async () => await stop());

  telemetry.watchTunnels([{ id: 'work', units: ['missing.service'] }]);
  await telemetry.pollNow();

  const tunnels = telemetry.snapshot().tunnels;
  assert.equal(tunnels?.length, 1, 'the tunnel is still reported');
  assert.equal(tunnels?.[0]?.service, 'unknown');
  assert.equal(tunnels?.[0]?.restarts, null);
});

/* ── the wire ────────────────────────────────────────────────────────────────────────────── */

function fakeTelemetry(tunnels: LiveStatus['tunnels']): ServerContext['telemetry'] {
  return {
    snapshot: () => ({
      at: new Date().toISOString(),
      network: null,
      units: {},
      accessPoints: {},
      links: {},
      clock: null,
      tunnels,
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

async function statusBody(tunnels: LiveStatus['tunnels']): Promise<{
  body: Record<string, unknown>;
  close: () => void;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-tunnel-status-'));
  const database = openDatabase({ path: join(directory, 'state.db') });
  const store: Store = createStore(database);
  await store.setAdminPassword('a-long-enough-password');
  store.setApiEnabled(true);

  const app = await buildServer({
    config: { ...DEFAULT_CONFIG, uiDir: null, stateDir: directory, cacheDir: join(directory, 'cache') },
    platform: pollingPlatform([], {}),
    store,
    telemetry: fakeTelemetry(tunnels),
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
  });

  const token = store.createToken('tunnel-status-read', ['read']).token;
  const response = await app.inject({
    method: 'GET',
    url: '/api/status',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, `/api/status answered ${response.statusCode}: ${response.body}`);
  return { body: response.json<Record<string, unknown>>(), close: () => database.close() };
}

/**
 * The first question asked of a device whose tunnels have never been read: **present, and null.**
 *
 * Present, because an absent key is the response schema having dropped it in silence, and that is
 * indistinguishable from a daemon that computes nothing. Null, because the alternative an
 * implementation drifts towards — `[]` — tells the operator that this device has no tunnels, which
 * is the reassuring reading of the case where nobody has looked.
 */
test('before any reading, status carries tunnels as null rather than an empty list', async (t) => {
  const { body, close } = await statusBody(null);
  t.after(close);

  assert.ok(Object.hasOwn(body, 'tunnels'), 'the response schema dropped the tunnels key');
  assert.equal(body['tunnels'], null);
  assert.notDeepEqual(body['tunnels'], []);
});

test('a profile with no tunnels reaches the wire as an empty list, not as null', async (t) => {
  const { body, close } = await statusBody([]);
  t.after(close);

  assert.ok(Object.hasOwn(body, 'tunnels'), 'the response schema dropped the tunnels key');
  assert.deepEqual(body['tunnels'], []);
  assert.notEqual(body['tunnels'], null);
});

/**
 * The serializer keeps the entries **and their fields**.
 *
 * Asserting only the array's length would pass against a serializer that emitted four empty objects,
 * which is a real shape: a schema declaring `items` as an object with no properties drops every key
 * inside it, by the same rule that drops an undeclared key at the top level.
 */
test('tunnel entries reach the wire with their fields intact', async (t) => {
  const { body, close } = await statusBody([
    { id: 'work', service: 'running', restarts: 2, since: '2026-09-21T12:00:00.000Z' },
    { id: 'home', service: 'unknown', restarts: null, since: null },
  ]);
  t.after(close);

  assert.deepEqual(body['tunnels'], [
    { id: 'work', service: 'running', restarts: 2, since: '2026-09-21T12:00:00.000Z' },
    { id: 'home', service: 'unknown', restarts: null, since: null },
  ]);
});

/* ── what the plan recorded, across a restart ────────────────────────────────────────────── */

/**
 * The distinction has to survive the database, because the daemon reads it at start-up.
 *
 * Telemetry is told what the tunnels are by whatever ran a plan; on a restart nothing has, so the
 * answer comes from here. A column that read back as `[]` when it had never been written would make
 * every freshly started device claim it has no tunnels, on a path where nobody would look again
 * until the next apply.
 */
async function freshStore(): Promise<{
  store: Store;
  database: ReturnType<typeof openDatabase>;
  close: () => void;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-tunnel-store-'));
  const database = openDatabase({ path: join(directory, 'state.db') });
  return { store: createStore(database), database, close: () => database.close() };
}

test('a device no plan has run on reports null tunnel units, not an empty list', async (t) => {
  const { store, close } = await freshStore();
  t.after(close);

  assert.equal(store.device().tunnelUnits, null);
});

test('a recorded absence of tunnels reads back as an empty list, not as null', async (t) => {
  const { store, close } = await freshStore();
  t.after(close);

  store.setTunnelUnits([]);
  assert.deepEqual(store.device().tunnelUnits, []);
});

test('the units a plan recorded survive a re-read with their grouping', async (t) => {
  const { store, close } = await freshStore();
  t.after(close);

  store.setTunnelUnits([
    { id: 'work', units: ['wf-openvpn@work.service', 'wf-cloak@work.service'] },
    { id: 'home', units: ['wf-vless@home.service'] },
  ]);
  assert.deepEqual(store.device().tunnelUnits, [
    { id: 'work', units: ['wf-openvpn@work.service', 'wf-cloak@work.service'] },
    { id: 'home', units: ['wf-vless@home.service'] },
  ]);
});

/**
 * A value that will not parse is "nothing recorded", never "no tunnels".
 *
 * Read on a path that runs at start-up, so it must not throw either. Both halves are asserted: the
 * read survives, and what it survives into is the `null` that keeps the device from claiming it has
 * no tunnels.
 */
test('a malformed recording reads back as null rather than as an empty list', async (t) => {
  const { store, database, close } = await freshStore();
  t.after(close);

  store.setTunnelUnits([{ id: 'work', units: ['a.service'] }]);
  // Written round the store deliberately: this is the shape a partial write or an older version
  // leaves behind, and it can only be constructed from outside the setter.
  database.raw.prepare('UPDATE device SET tunnel_units = ? WHERE id = 1').run('{not json');

  assert.equal(store.device().tunnelUnits, null);
});
