/**
 * A device for the apply path: the real `applyDocument`, transaction store and planner, against a stand-in
 * platform whose uplink has **no carrier** and a fresh disk, so every apply with an ethernet uplink is a
 * `network` change that opens a confirmation window.
 *
 * Moved here from `window-deadline.test.ts` (2026-10-14) so the traffic-check, lock and activation tests
 * run against the same device rather than a second copy of it.
 */

import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { recordWindowFinding, type ApplyDeps } from '../../src/core/apply.ts';
import { createWindowWatch } from '../../src/core/window-watch.ts';
import { createDriftMonitor } from '../../src/core/drift.ts';
import type { PipelineContext } from '../../src/core/pipeline.ts';
import { openDatabase } from '../../src/state/db.ts';
import { createStore } from '../../src/state/store.ts';
import { createProfileStore } from '../../src/state/profiles.ts';
import { createSecretPlan } from '../../src/state/secret-plan.ts';
import type { Platform } from '../../src/platform/index.ts';
import { builtInAndDongle, cleanFacts } from './synthetic-inventory.ts';
import { allPolicyRules } from './policy-rules.ts';

const CORE_SCHEMA = readFileSync(
  `${dirname(fileURLToPath(import.meta.url))}/../../../../packages/protocols/test/fixtures/core-schema-sing-box-1.14.0.json`,
  'utf8',
);

/** What the stand-in reports for every link: `ip -j` on the bench board for a cable with no carrier. */
const NO_CARRIER = { operstate: 'DOWN', flags: ['NO-CARRIER', 'BROADCAST', 'MULTICAST', 'UP'] };

function fakePlatform(clock: { uptime: number }) {
  const armed: { unit: string; withinSeconds: number }[] = [];
  const stopped: string[] = [];
  const units = new Map<string, boolean>();
  const inventory = builtInAndDongle();

  const platform = {
    systemd: {
      state: async (unit: string) => ({
        unit,
        activeState: units.get(unit) === true ? 'active' : 'inactive',
        isActive: units.get(unit) ?? false,
        isEnabled: true,
        known: units.has(unit),
      }),
      enable: async () => undefined,
      disable: async () => undefined,
      start: async (unit: string) => {
        units.set(unit, true);
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      restart: async (unit: string) => {
        units.set(unit, true);
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      stop: async (unit: string) => {
        units.set(unit, false);
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      daemonReload: async () => undefined,
      // The boot-relative deadline, exactly as the real platform hands it to `OnBootSec`.
      runTransient: async (transient: { unit: string; withinSeconds: number }) => {
        armed.push({ unit: transient.unit, withinSeconds: transient.withinSeconds });
        return { ok: true, message: '', firesAtUptimeSeconds: Math.floor(clock.uptime + transient.withinSeconds) };
      },
      stopTransient: async (unit: string) => {
        stopped.push(unit);
        return { ok: true, message: '' };
      },
    },
    net: {
      // Every interface the inventory has, with no carrier and no address — the uplink is really down.
      snapshot: async () => ({
        links: inventory.interfaces.map((entry) => ({ name: entry.name, ...NO_CARRIER })),
        addresses: [],
        routes: [],
        at: 0,
      }),
      reload: async () => ({ ok: true, message: '' }),
      reconfigure: async () => ({ ok: true, message: '' }),
      rules: async () => allPolicyRules(),
      waitForSettle: async (interfaces: { name: string; expect: string }[]) => ({
        settled: false,
        perInterface: interfaces.map((entry) => ({ ...entry, carrier: false, address: null, ok: false })),
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
      writeAtomic: async (path: string) => ({ path, bytes: 1, changed: true }),
      readManaged: async () => null,
      fileMode: async () => null,
      moveAside: async (path: string) => ({ from: path, to: `${path}.aside`, moved: true }),
      restoreAside: async (entry: { from: string; to: string }) => ({ ...entry, outcome: 'restored' as const }),
      directoryWritable: async () => ({ writable: true, reason: 'writable' }),
    },
    clock: { status: async () => ({ timezone: null, ntpEnabled: null, synchronized: null, localRtc: null, timeUsec: null, rtcTimeUsec: null }) },
    host: { boardModel: async () => null, uptimeSeconds: async () => clock.uptime },
    binaries: {
      detect: async () => null,
      coreSchema: async () => ({ schema: CORE_SCHEMA, cacheKey: 'test', fromCache: true }),
      checkCoreConfig: async () => ({ ok: true, message: '' }),
    },
    journal: { read: async () => ({ entries: [] }), currentBootId: async () => 'boot' },
    close: () => undefined,
  } as unknown as Platform;

  return { platform, inventory, armed, stopped };
}

export async function device(options: { recovery?: boolean } = {}) {
  const clock = { uptime: 4000 };
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-g13-'));
  const database = openDatabase({ path: join(directory, 'state.db') });
  const store = createStore(database);
  const profiles = createProfileStore(database, createSecretPlan());
  const { platform, inventory, armed, stopped } = fakePlatform(clock);

  const pipeline: PipelineContext = {
    platform,
    inventory: async () => inventory,
    facts: async () => cleanFacts(),
    // A fresh device: nothing of ours on it, so every networkd file is created and the change acts on
    // the uplink by construction.
    reality: async (paths, unitNames) => ({
      files: paths.map((path) => ({ path, content: null, mode: null })),
      units: unitNames.map((name) => ({ name, active: false, enabled: false, known: false })),
      interfaces: inventory.interfaces.map((entry) => ({ name: entry.name, mac: entry.mac })),
      managementInterfaces: ['end0'],
      sysctl: {},
    }),
    managementPort: 8088,
    timePorts: [123],
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
  };

  const deps: ApplyDeps = {
    platform,
    profiles,
    store,
    pipeline,
    drift: createDriftMonitor({ profiles, store, pipeline }),
    timeSyncUnit: 'systemd-timesyncd.service',
    wayBinary: '/usr/local/bin/way',
    log: () => undefined,
    // With a recovery document the revert really re-applies something, which is the ordinary path.
    recoveryDocument: async () => (options.recovery === true ? (emptyProfile({ name: 'Recovery' }) as ProfileDocument) : null),
  };
  // Wired exactly as `index.ts` wires it: a finding goes through `recordWindowFinding` and nowhere else.
  deps.windowWatch = createWindowWatch({
    platform,
    log: () => undefined,
    stillOpen: (id) => profiles.transaction(id)?.state === 'awaiting-confirm',
    onFinding: (id, finding) => recordWindowFinding(deps, id, finding),
    // Every allowance already elapsed and ticks every few milliseconds: the check is as eager as it can
    // possibly be, so if it can end the window at all it does it here.
    thresholds: { intervalMs: 5, uplinkSettleMs: 0, accessPointEnabledMs: 0 },
  });

  const profile: ProfileDocument = {
    ...emptyProfile({ name: 'G13' }),
    uplinks: [{ id: 'wan-eth', kind: 'ethernet', priority: 10, enabled: true, bind: { by: 'any-ethernet' }, config: { dhcp: true } }],
  } as ProfileDocument;
  return {
    clock,
    deps,
    profiles,
    store,
    armed,
    stopped,
    profile,
    close: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

