/**
 * G13: the deadline the device reports is the deadline it keeps.
 *
 * Measured 2026-09-22. `POST /api/apply` answered `secondsRemaining: 148`, and transaction
 * `6110779e063cfb9f`, created 19:03:20, was gone at 19:04:10 — undone by the window's health check,
 * which then acted on its own at 45 s. A caller who believed the reported number lost the change; a
 * retry confirmed at t+5 s survived only because it beat a deadline nobody had been told about.
 *
 * The decision (see `windowVerdict`): a health check inside the window records a finding and never
 * ends the window. The only things that end it are the ones the reported number already describes —
 * the timer at the deadline — and a person, by confirming or by asking for the revert.
 *
 * These tests run the real `applyDocument`, the real window watcher wired exactly as `index.ts` wires
 * it (through `recordWindowFinding`), the real transaction store, against a platform whose uplink is
 * **genuinely down** and a change that **did** act on it — the one case where the check has every
 * right to a finding. If anything can still end the window early, this is where it would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import {
  anchoredSecondsRemaining,
  CONFIRMATION_WINDOW_MS,
} from '../src/core/transactions.ts';
import { applyDocument, recordWindowFinding, revertTransaction, type ApplyDeps } from '../src/core/apply.ts';
import { createWindowWatch } from '../src/core/window-watch.ts';
import { REVERT_REASONS, isFailureEvidence } from '../src/core/safe-mode.ts';
import { createDriftMonitor } from '../src/core/drift.ts';
import type { PipelineContext } from '../src/core/pipeline.ts';
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

async function device(options: { recovery?: boolean } = {}) {
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
  return { clock, deps, profiles, store, armed, stopped, profile, close: () => database.close() };
}

test('G13: a window health finding never ends the window before the deadline the device reported', async (t) => {
  const { clock, deps, profiles, armed, stopped, profile, close } = await device();
  t.after(close);

  const outcome = await applyDocument(deps, { profileId: 'p1', document: profile });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  const reported = outcome.transaction!;
  assert.equal(reported.state, 'awaiting-confirm');

  // The reported number and the armed timer are one number: the deadline the timer outside this process
  // fires at, in the frame it fires in.
  assert.equal(armed.length, 1);
  assert.equal(reported.secondsRemaining, armed[0]!.withinSeconds);
  assert.equal(reported.secondsRemaining, CONFIRMATION_WINDOW_MS / 1000);

  // Let the check run many times with every allowance elapsed and the uplink genuinely down.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const row = profiles.transaction(reported.id)!;
  // The check did find it — that half must keep working, and must say what it read.
  assert.match(row.reason ?? '', /uplink_down/, `no finding was recorded: ${row.reason}`);
  assert.match(row.reason ?? '', /operstate DOWN, flags NO-CARRIER/, 'the finding does not carry what was read');

  // And it did not act on it. Mutation: make `recordWindowFinding` call `revertTransaction` and this
  // goes red — the transaction ends 45 s (here: milliseconds) into a window reported as 150 s.
  assert.equal(row.state, 'awaiting-confirm', `the window ended before its reported deadline: state ${row.state}, reason ${row.reason}`);
  assert.deepEqual(stopped, [], 'the revert timer was disarmed, so something other than the deadline ended the window');

  // Nothing about the deadline moved either: what the device reports now is what it reported, less the
  // time that passed in the frame the timer acts on.
  clock.uptime += 100;
  const now = anchoredSecondsRemaining({
    firesAtUptimeSeconds: row.firesAtUptimeSeconds,
    uptimeSeconds: clock.uptime,
    deadlineAt: row.deadlineAt,
    now: new Date(),
  });
  assert.equal(now.secondsRemaining, (reported.secondsRemaining ?? 0) - 100);

  // A person can still keep it: the finding is information, and the decision is theirs.
  deps.windowWatch!.stop(reported.id);
});

test('G5: the revert at the deadline records what the window health check read', async (t) => {
  const { clock, deps, profiles, profile, close } = await device({ recovery: true });
  t.after(close);

  const outcome = await applyDocument(deps, { profileId: 'p1', document: profile });
  const id = outcome.transaction!.id;
  await new Promise((resolve) => setTimeout(resolve, 60));

  // The deadline arrives and the timer's `way revert --txn` runs — the same function.
  clock.uptime += CONFIRMATION_WINDOW_MS / 1000;
  await revertTransaction(deps, id, 'the confirmation deadline passed');

  const row = profiles.transaction(id)!;
  assert.equal(row.state, 'reverted', `state ${row.state}, reason ${row.reason}`);
  // Mutation: drop the `finding` fold in `revertTransaction` and this goes red — the record says only
  // "the deadline passed", and the next person cannot hold the verdict against the device.
  assert.match(row.reason ?? '', /the confirmation deadline passed\. During the window the health check had found: /);
  assert.match(row.reason ?? '', /: operstate DOWN, flags NO-CARRIER,BROADCAST,MULTICAST,UP, inet none/);
});

test('an operator revert after a finding is still a change of mind, not failure evidence', async (t) => {
  // The finding is folded into the revert's reason, and safe mode tells an operator's revert from a
  // failure by that reason. Mutation: compare with `===` in `isFailureEvidence` again and this goes red —
  // three such reverts on a healthy device would switch its tunnels off.
  const { deps, profiles, profile, close } = await device({ recovery: true });
  t.after(close);

  const outcome = await applyDocument(deps, { profileId: 'p1', document: profile });
  const id = outcome.transaction!.id;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await revertTransaction(deps, id, REVERT_REASONS.operatorRequested);

  const row = profiles.transaction(id)!;
  assert.match(row.reason ?? '', /During the window the health check had found/, 'the fixture must carry a finding');
  assert.equal(isFailureEvidence({ at: row.createdAt, state: row.state, reason: row.reason }), false);
});
