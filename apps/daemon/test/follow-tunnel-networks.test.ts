/**
 * The device follows a tunnel's network into the fence — once, and not once per flap.
 *
 * Measured on the bench board, 2026-09-23. `corp` (Cloak + OpenVPN) was down from at least 22:15 to
 * 07:32:27. `fence.json` and the core's `route_exclude_address` had been written around 23:00 while it
 * was down and listed only the networks of `wfvpnhq` and `wfvpnprt`. At 07:32:27 its peer pushed
 * `ifconfig 10.122.0.2 255.255.255.0`, `wfvpncrp` has held `10.122.0.2/24` since, and nothing re-derived:
 * the drift check read `diverged`, eight findings, and would have stayed red until somebody applied.
 *
 * Everything here runs through the functions `index.ts` calls: `followDevice` builds the follower, the
 * real `applyDocument` plans through the real `planDocument`, planner and differ and reconciles through
 * the real reconciler, and the drift check is the real monitor. The device underneath is a stand-in
 * that keeps files in memory, counts unit restarts, and holds the addresses the kernel would report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { applyDocument, confirmTransaction, type ApplyDeps } from '../src/core/apply.ts';
import { createDriftMonitor } from '../src/core/drift.ts';
import { followDevice } from '../src/core/device-follower.ts';
import { observeAddresses } from '../src/core/address-watch.ts';
import type { NetSnapshot } from '../src/platform/net.ts';
import { createObserverRegistry } from '../src/core/observers.ts';
import { PATHS } from '../src/core/desired-state.ts';
import { withRetainedFollowed } from '../src/core/followed-networks.ts';
import type { PipelineContext } from '../src/core/pipeline.ts';
import type { FollowerEvent } from '../src/core/resolver-follower.ts';
import { interfaceNetworks } from '../src/platform/facts.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore } from '../src/state/store.ts';
import { createProfileStore } from '../src/state/profiles.ts';
import { createSecretPlan } from '../src/state/secret-plan.ts';
import type { Platform } from '../src/platform/index.ts';
import { builtInAndDongle, cleanFacts } from './helpers/synthetic-inventory.ts';

const CORE_SCHEMA = readFileSync(
  `${dirname(fileURLToPath(import.meta.url))}/../../../packages/protocols/test/fixtures/core-schema-sing-box-1.14.0.json`,
  'utf8',
);

type Address = { name: string; address: string; prefixLength: number };

/** The addresses on the board at 07:32:27, less `corp`'s. */
const UPLINK: Address = { name: 'end0', address: '192.168.77.8', prefixLength: 24 };
const HQ: Address = { name: 'wfvpnhq', address: '10.165.1.20', prefixLength: 20 };
const ODD: Address = { name: 'wfvpnprt', address: '10.61.0.2', prefixLength: 24 };
const CORP: Address = { name: 'wfvpncrp', address: '10.122.0.2', prefixLength: 24 };

function benchProfile(): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' }) as unknown as ProfileDocument;
  const openvpn = (id: string, suffix: string) => ({
    id,
    name: id,
    role: 'resource',
    onUnavailable: 'block',
    enabled: true,
    protocol: 'openvpn',
    config: { profile: `client\ndev tun\nremote ${id}.example.net 1194\n`, interfaceSuffix: suffix },
  });
  return {
    ...base,
    uplinks: [{ id: 'wan-eth', kind: 'ethernet', priority: 10, enabled: true, bind: { by: 'any-ethernet' }, config: { dhcp: true } }],
    tunnels: [
      openvpn('hq', 'hq'),
      openvpn('partner', 'prt'),
      {
        id: 'corp',
        name: 'corp',
        role: 'resource',
        onUnavailable: 'block',
        enabled: true,
        protocol: 'cloak-openvpn',
        // The board's shape, which the first version of this fixture left out and which is why these
        // tests passed while the board refused itself (2026-09-23 09:07:52): `corp`'s own resource rule
        // names the very network its peer hands it, so the address is in the routing before the fence.
        resources: { domainSuffix: ['corp.internal'], ipCidr: ['10.148.0.0/16', '10.122.0.0/24'] },
        config: {
          profile: 'client\ndev tun\nremote corp.example.net 1194\n',
          interfaceSuffix: 'crp',
          entryPoints: [
            {
              id: 'front',
              host: '198.51.100.170',
              port: 443,
              uid: 'a-placeholder-identifier',
              publicKey: 'a-placeholder-public-key',
              proxyMethod: 'openvpn',
              encryptionMethod: 'aes-gcm',
              serverName: 'www.example.com',
              browserSignature: 'chrome',
              transport: 'direct',
            },
          ],
        },
      },
      {
        id: 'relay',
        name: 'relay',
        role: 'resource',
        onUnavailable: 'block',
        enabled: true,
        protocol: 'vless',
        config: { server: '198.51.100.7', port: 443, id: 'a-placeholder-account', network: 'tcp', security: 'tls' },
      },
    ],
  } as unknown as ProfileDocument;
}

async function device() {
  const clock = { uptime: 4000, monotonic: 0 };
  const files = new Map<string, { content: string; mode: number }>();
  const units = new Map<string, boolean>();
  const enabled = new Set<string>();
  const restarts: string[] = [];
  const addresses: Address[] = [UPLINK, HQ, ODD];
  const inventory = builtInAndDongle();
  inventory.binaries.push({ name: 'xray', present: true, path: '/usr/local/bin/xray', version: '25.1.1', features: [], neededFor: 'VLESS' } as never);

  const netAddresses = () =>
    addresses.map((entry, index) => ({
      ifindex: index + 2,
      name: entry.name,
      family: 'inet',
      address: entry.address,
      prefixLength: entry.prefixLength,
      scope: 'global',
      dynamic: false,
    }));

  const platform = {
    systemd: {
      state: async (unit: string) => ({ unit, activeState: units.get(unit) ? 'active' : 'inactive', isActive: units.get(unit) ?? false, isEnabled: enabled.has(unit), known: units.has(unit) || enabled.has(unit) }),
      enable: async (unit: string) => {
        enabled.add(unit);
      },
      disable: async (unit: string) => {
        enabled.delete(unit);
      },
      start: async (unit: string) => {
        units.set(unit, true);
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      restart: async (unit: string) => {
        units.set(unit, true);
        restarts.push(unit);
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      stop: async (unit: string) => {
        units.set(unit, false);
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      daemonReload: async () => undefined,
      runTransient: async (transient: { unit: string; withinSeconds: number }) => ({
        ok: true,
        message: '',
        firesAtUptimeSeconds: Math.floor(clock.uptime + transient.withinSeconds),
      }),
      stopTransient: async () => ({ ok: true, message: '' }),
    },
    net: {
      addresses: async () => netAddresses(),
      snapshot: async () => ({
        links: inventory.interfaces.map((entry) => ({ name: entry.name, operstate: 'UP', flags: ['LOWER_UP', 'UP'] })),
        addresses: netAddresses(),
        routes: [],
        at: 0,
      }),
      reload: async () => ({ ok: true, message: '' }),
      reconfigure: async () => ({ ok: true, message: '' }),
      waitForSettle: async (interfaces: { name: string; expect: string }[]) => ({
        settled: true,
        perInterface: interfaces.map((entry) => ({ ...entry, carrier: true, address: '192.168.77.8', ok: true })),
      }),
    },
    sysctl: (() => {
      const values = new Map<string, string>();
      return {
        read: async (key: string) => values.get(key) ?? null,
        write: async (key: string, value: string) => {
          values.set(key, value);
        },
      };
    })(),
    wifi: { phys: async () => [], interfaces: async () => [], regulatory: async () => ({ global: null, perPhy: {} }) },
    supplicant: {},
    ap: { status: async () => ({ state: 'ENABLED' }) },
    nft: { check: async () => ({ ok: true, message: '' }) },
    files: {
      writeAtomic: async (path: string, content: string, options: { mode?: number } = {}) => {
        const changed = files.get(path)?.content !== content;
        files.set(path, { content: String(content), mode: options.mode ?? 0o600 });
        return { path, bytes: String(content).length, changed };
      },
      readManaged: async (path: string) => files.get(path)?.content ?? null,
      fileMode: async (path: string) => files.get(path)?.mode ?? null,
      moveAside: async (path: string) => ({ from: path, to: `${path}.aside`, moved: false }),
      restoreAside: async (entry: { from: string; to: string }) => ({ ...entry, outcome: 'restored' as const }),
      directoryWritable: async () => ({ writable: true, reason: 'writable' }),
      removePath: async () => ({ removed: false }),
      createDirectory: async () => undefined,
      removeMatchingEntries: async () => [],
      findMovedAside: async () => [],
    },
    clock: { status: async () => ({ timezone: null, ntpEnabled: null, synchronized: true, localRtc: null, timeUsec: null, rtcTimeUsec: null }) },
    host: {
      boardModel: async () => null,
      uptimeSeconds: async () => clock.uptime,
      reloadForeignManager: async () => ({ ok: true, message: '' }),
    },
    binaries: {
      detect: async () => null,
      coreSchema: async () => ({ schema: CORE_SCHEMA, cacheKey: 'test', fromCache: true }),
      checkCoreConfig: async () => ({ ok: true, message: '' }),
    },
    journal: { read: async () => ({ entries: [] }), currentBootId: async () => 'boot' },
    close: () => undefined,
  } as unknown as Platform;

  const pipeline: PipelineContext = {
    platform,
    inventory: async () => inventory,
    // The reading `collectFacts` gives the planner, through the function it uses.
    facts: async () => ({ ...cleanFacts(), uplinkNetworks: interfaceNetworks(netAddresses()) }),
    reality: async (paths, unitNames, sysctlKeys) => ({
      files: paths.map((path) => ({ path, content: files.get(path)?.content ?? null, mode: files.get(path)?.mode ?? null })),
      units: unitNames.map((name) => ({ name, active: units.get(name) ?? false, enabled: enabled.has(name), known: units.has(name) || enabled.has(name) })),
      interfaces: inventory.interfaces.map((entry) => ({ name: entry.name, mac: entry.mac })),
      managementInterfaces: ['end0'],
      sysctl: Object.fromEntries(await Promise.all(sysctlKeys.map(async (key) => [key, (await platform.sysctl.read(key)) ?? '']))),
    }),
    managementPort: 8088,
    timePorts: [123],
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
    capturedResolvers: async () => new Map(),
  };

  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-follow-net-'));
  const database = openDatabase({ path: join(directory, 'state.db') });
  const store = createStore(database);
  const profiles = createProfileStore(database, createSecretPlan());
  // What `index.ts`'s pipeline hooks do on every plan.
  pipeline.onManagementSurfaces = (surfaces) => store.setManagementSurfaces(surfaces);
  pipeline.onTunnelUnits = (tunnelUnits) => store.setTunnelUnits(tunnelUnits);

  const drift = createDriftMonitor({ profiles, store, pipeline });
  const applyDeps: ApplyDeps = {
    platform,
    profiles,
    store,
    pipeline,
    drift,
    timeSyncUnit: 'systemd-timesyncd.service',
    wayBinary: '/usr/local/bin/way',
    log: () => undefined,
    recoveryDocument: async () => null,
  };

  const events: FollowerEvent[] = [];
  const observers = createObserverRegistry();
  const follower = followDevice({
    platform,
    store,
    profiles,
    applyDeps,
    observers,
    record: (event) => events.push(event),
    log: () => undefined,
    capturedResolvers: async () => new Map(),
    timing: { monotonicMs: () => clock.monotonic },
  });

  const profile = benchProfile();
  const profileId = profiles.create(profile).id;
  store.setActiveProfileId(profileId);

  const fence = (): string[] => {
    const core = JSON.parse(files.get(PATHS.coreConfig)!.content) as { inbounds: { route_exclude_address?: string[] }[] };
    return core.inbounds.flatMap((inbound) => inbound.route_exclude_address ?? []);
  };
  const record = (): string[] =>
    (JSON.parse(files.get(PATHS.coreFence)!.content) as { followed: { network: string }[] }).followed.map((entry) => entry.network);
  const coreRestarts = (): number => restarts.filter((unit) => unit === 'wf-core.service').length;

  return { clock, files, addresses, restarts, coreRestarts, store, profiles, applyDeps, drift, follower, events, observers, profile, profileId, fence, record, close: () => database.close() };
}

/** The operator's apply, confirmed if it opened a window: the state the board was in at 23:00. */
async function operatorApply(bench: Awaited<ReturnType<typeof device>>, document: ProfileDocument): Promise<void> {
  const outcome = await applyDocument(bench.applyDeps, { profileId: bench.profileId, document, openedBy: 'operator' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  if (outcome.transaction?.state === 'awaiting-confirm') {
    const confirmed = await confirmTransaction(bench.applyDeps, outcome.transaction.id);
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed.error));
  }
}

test('the board at 07:32:27: corp comes up with 10.122.0.0/24, and the follower adds it to the fence with a service-class change and no window', async (t) => {
  const bench = await device();
  t.after(bench.close);
  await operatorApply(bench, bench.profile);
  // 23:00: written while corp was down.
  assert.ok(!bench.fence().includes('10.122.0.0/24'));
  assert.deepEqual(bench.record().sort(), ['10.165.0.0/20', '10.61.0.0/24']);
  const before = bench.coreRestarts();

  // 07:32:27.
  bench.addresses.push(CORP);
  assert.equal((await bench.drift.run('periodic')).state, 'diverged', 'the fixture does not reproduce the red drift');

  const outcome = await bench.follower.check('addresses-changed');
  // Before this change: `converged` — the follower compared resolvers only, and nothing moved.
  assert.equal(outcome.kind, 'attempted', JSON.stringify(outcome));
  const followed = bench.events.find((event) => event.kind === 'fence.followed');
  assert.ok(followed, `no fence.followed event: ${JSON.stringify(bench.events.map((event) => [event.kind, event.summary]))}`);
  assert.ok(bench.fence().includes('10.122.0.0/24'));
  assert.ok(bench.record().includes('10.122.0.0/24'));
  // The observer describes the device after the act, not the moment before it (G14's shape). Mutation:
  // drop the look after re-deriving and this reads "not converged: 10.122.0.0/24 on wfvpncrp …".
  const afterAct = bench.observers.report().find((entry) => entry.name === 'resolver-follower')!;
  assert.match(afterAct.lastLooked?.what ?? '', /^after re-deriving: converged; every tunnel network is in the fence/);

  // The same classification an ordinary follower move gets: service, so no window and no revert timer.
  const transaction = bench.profiles.recentTransactions(1)[0]!;
  assert.equal(transaction.blastRadius, 'service');
  assert.equal(transaction.deadlineAt, null);
  assert.notEqual(transaction.state, 'awaiting-confirm');
  assert.equal(bench.coreRestarts(), before + 1, 'adding a network is worth exactly one core restart');

  // And the device is in step with itself: drift and the follower give one answer.
  const settled = await bench.drift.run('periodic');
  assert.equal(settled.state, 'converged', JSON.stringify(settled.findings?.map((f: { subject: string; pointer: string | null; stored: string | null; running: string | null }) => [f.subject, f.pointer, f.stored, f.running])));
  assert.equal((await bench.follower.check('periodic')).kind, 'converged');
  const look = bench.observers.report().find((entry) => entry.name === 'resolver-follower')!;
  assert.match(look.lastLooked?.what ?? '', /every tunnel network is in the fence: .*wfvpncrp 10\.122\.0\.0\/24/);
});

test('the flap: corp going down and up twelve times costs no restart after the first, and drift stays converged throughout', async (t) => {
  const bench = await device();
  t.after(bench.close);
  await operatorApply(bench, bench.profile);
  bench.addresses.push(CORP);
  await bench.follower.check('addresses-changed');
  const afterAdd = bench.coreRestarts();

  for (let flap = 0; flap < 12; flap += 1) {
    // Down: the tunnel client removes the address. The follower looks, on the address event.
    bench.addresses.splice(bench.addresses.indexOf(CORP), 1);
    bench.clock.monotonic += 30_000;
    assert.equal((await bench.follower.check('addresses-changed')).kind, 'converged');
    // Mutation: in `planDocument`, drop the retained record (`planWith(undefined)` always) and this goes
    // red — drift reads the fence as about to lose 10.122.0.0/24 while corp is down.
    assert.equal((await bench.drift.run('periodic')).state, 'converged', `drift went red with corp down (flap ${String(flap)})`);
    assert.ok(bench.fence().includes('10.122.0.0/24'), 'the network was removed while its tunnel was down');
    // Up, with the same network.
    bench.addresses.push(CORP);
    bench.clock.monotonic += 30_000;
    assert.equal((await bench.follower.check('addresses-changed')).kind, 'converged');
  }
  assert.equal(bench.coreRestarts(), afterAdd, 'a flap restarted the core');
});

test('hq alternating between two networks costs one restart per distinct network, not one per connect', async (t) => {
  const bench = await device();
  t.after(bench.close);
  await operatorApply(bench, bench.profile);
  const start = bench.coreRestarts();
  const OTHER: Address = { name: 'wfvpnhq', address: '10.164.96.9', prefixLength: 20 };
  const alternate = async (to: Address, from: Address): Promise<void> => {
    bench.addresses.splice(bench.addresses.indexOf(from), 1, to);
    bench.clock.monotonic += 10 * 60_000;
    await bench.follower.check('addresses-changed');
  };
  await alternate(OTHER, HQ); // 10.164.96.0/20 is new: one restart
  await alternate(HQ, OTHER); // 10.165.0.0/20 was retained: none
  await alternate(OTHER, HQ);
  await alternate(HQ, OTHER);
  assert.equal(bench.coreRestarts(), start + 1);
  assert.ok(bench.fence().includes('10.164.96.0/20') && bench.fence().includes('10.165.0.0/20'));
});

test('two new networks inside a minute: one restart, then the second waits for the rate limit', async (t) => {
  const bench = await device();
  t.after(bench.close);
  await operatorApply(bench, bench.profile);
  const start = bench.coreRestarts();
  bench.addresses.push(CORP);
  assert.equal((await bench.follower.check('addresses-changed')).kind, 'attempted');
  bench.addresses.splice(bench.addresses.indexOf(CORP), 1, { ...CORP, address: '10.251.0.2' });
  bench.clock.monotonic += 20_000;
  // Mutation: set `minApplyIntervalMs` to 0 in `createResolverFollower` and this reads `attempted`.
  assert.equal((await bench.follower.check('addresses-changed')).kind, 'throttled');
  assert.equal(bench.coreRestarts(), start + 1);
  bench.clock.monotonic += 60_000;
  assert.equal((await bench.follower.check('retry')).kind, 'attempted');
  assert.equal(bench.coreRestarts(), start + 2);
});

test('a retained network leaves only when the core is rewritten for another reason', async (t) => {
  const bench = await device();
  t.after(bench.close);
  await operatorApply(bench, bench.profile);
  bench.addresses.push(CORP);
  await bench.follower.check('addresses-changed');
  // corp goes down and stays down.
  bench.addresses.splice(bench.addresses.indexOf(CORP), 1);
  const start = bench.coreRestarts();

  // An operator apply that changes nothing in the core: the stale network is kept, and no restart.
  await operatorApply(bench, bench.profile);
  assert.ok(bench.fence().includes('10.122.0.0/24'));
  assert.equal(bench.coreRestarts(), start, 'an apply with nothing for the core restarted it to drop a stale network');

  // An operator apply that does rewrite the core: the stale network goes with it, at no extra cost.
  const changed = structuredClone(bench.profile);
  changed.tunnels = changed.tunnels.filter((tunnel) => tunnel.id !== 'partner');
  await operatorApply(bench, changed);
  assert.ok(!bench.fence().includes('10.122.0.0/24'), 'the stale network outlived a core rewrite');
  assert.ok(!bench.record().includes('10.122.0.0/24'));
});

test('drift still reports a network in the fence that the record does not call followed', async (t) => {
  const bench = await device();
  t.after(bench.close);
  await operatorApply(bench, bench.profile);
  // Somebody edits the core configuration by hand and adds a network nothing followed.
  const core = JSON.parse(bench.files.get(PATHS.coreConfig)!.content) as { inbounds: { route_exclude_address?: string[] }[] };
  for (const inbound of core.inbounds) inbound.route_exclude_address?.push('10.99.0.0/16');
  bench.files.set(PATHS.coreConfig, { content: `${JSON.stringify(core, null, 2)}\n`, mode: 0o600 });
  assert.equal((await bench.drift.run('periodic')).state, 'diverged');
});

test('a follower attempt whose every change is network opens no transaction, and says it was refused', async (t) => {
  // The board at 09:07:46: the follower's start-up attempt opened `a36badb1d45169a9` — `apply`, blast
  // `network`, committed with no deadline, opened by nobody — and wrote nothing.
  const bench = await device();
  t.after(bench.close);
  await operatorApply(bench, bench.profile);
  // A follower move with no record of the running fence: `network` by the fence rule, so the follower
  // (hot and service only) may do none of it.
  bench.files.delete(PATHS.coreFence);
  bench.addresses.splice(bench.addresses.indexOf(HQ), 1, { name: 'wfvpnhq', address: '10.164.96.9', prefixLength: 20 });
  const before = bench.profiles.recentTransactions(50).length;
  const config = bench.files.get(PATHS.coreConfig)!.content;

  const outcome = await bench.follower.check('start-up');
  assert.equal(outcome.kind, 'attempted');
  // Mutation: remove the `nothing_permitted` return in `applyDocument` and this goes red — a committed
  // `network` transaction with no deadline appears, exactly as on the board.
  assert.equal(bench.profiles.recentTransactions(50).length, before, 'a transaction was opened for an apply that could do nothing');
  assert.ok(
    !bench.profiles.recentTransactions(50).some((row) => row.blastRadius === 'network' && row.deadlineAt === null && row.state === 'committed' && row.openedBy === null),
    'a network transaction was committed without a window',
  );
  assert.equal(bench.files.get(PATHS.coreConfig)!.content, config);
  const refused = bench.events.find((event) => event.kind === 'fence.follow-refused');
  assert.ok(refused, JSON.stringify(bench.events.map((event) => event.kind)));
  assert.match(refused.summary, /no transaction was opened: .*\/etc\/wayfarer\/core\/config\.json \(network\)/);
});

test('a narrowed apply records the class of what it performs, not of the whole plan', async (t) => {
  const bench = await device();
  t.after(bench.close);
  // A fresh device, applied with only the classes the follower uses: the networkd files are refused,
  // the core and its units are written.
  const outcome = await applyDocument(bench.applyDeps, { profileId: bench.profileId, document: bench.profile, classes: ['hot', 'service'], openedBy: null });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.ok((outcome.result?.refused ?? []).some((entry) => entry.blastRadius === 'network'), 'the fixture has no refused network change, so this proves nothing');
  // Mutation: record `classified.blastRadius` again and this reads `network`.
  assert.equal(outcome.transaction?.blastRadius, 'service');
  assert.equal(bench.profiles.recentTransactions(1)[0]!.blastRadius, 'service');
  assert.equal(outcome.transaction?.deadlineAt, null);
});

test('only what the running fence recorded as followed, on an interface that is still a tunnel of this plan, and absent now, is retained', () => {
  const reading = [{ interface: 'end0', cidr: '192.168.77.0/24' }];
  const retained = withRetainedFollowed(reading, ['wfvpncrp', 'wfvpnhq'], [
    { network: '10.122.0.0/24', interface: 'wfvpncrp' },
    // The tunnel this was read from is no longer in the profile: it is not ours to keep.
    { network: '10.61.0.0/24', interface: 'wfvpnprt' },
    // On an interface now, so it is read, and classified, like any other network.
    { network: '192.168.77.0/24', interface: 'wfvpnhq' },
  ]);
  // Mutation: drop the `tunnels.has(entry.interface)` condition and 10.61.0.0/24 is kept for a tunnel
  // that no longer exists — the planner would then call it defended, and it could never leave.
  assert.deepEqual(retained, [...reading, { interface: 'wfvpncrp', cidr: '10.122.0.0/24' }]);
});

test('the address watch that re-binds the management interface is what wakes the follower when corp gets its address', async (t) => {
  const bench = await device();
  t.after(bench.close);
  await operatorApply(bench, bench.profile);
  let fire: ((snapshot: NetSnapshot) => void) | null = null;
  const rebinds: number[] = [];
  const handle = observeAddresses({
    observers: bench.observers,
    // The kernel's event stream, reduced to the callback `index.ts` hands it.
    net: {
      watch: (onChange) => {
        fire = onChange;
        return { stop: () => undefined } as never;
      },
    },
    rebind: async () => {
      rebinds.push(1);
      return ['192.168.77.8'];
    },
    follower: bench.follower,
    log: () => undefined,
  });
  t.after(() => handle.stop());

  bench.addresses.push(CORP);
  assert.ok(fire !== null);
  (fire as (snapshot: NetSnapshot) => void)({ addresses: [], links: [], routes: [], at: 0 });
  const deadline = Date.now() + 3000;
  while (!bench.events.some((event) => event.kind === 'fence.followed')) {
    if (Date.now() > deadline) throw new Error(`the follower was not woken: ${JSON.stringify(bench.events.map((event) => event.kind))}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Mutation: drop `input.follower.check(...)` from `observeAddresses` and the loop above times out.
  assert.ok(bench.fence().includes('10.122.0.0/24'));
  assert.equal(rebinds.length, 1, 'the watch stopped re-binding the management interface');
  assert.equal(bench.observers.report().find((entry) => entry.name === 'address-watch')?.state, 'ok');
});
