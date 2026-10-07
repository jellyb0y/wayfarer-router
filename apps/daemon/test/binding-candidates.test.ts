/**
 * The chooser's list: what the device reports, and whether a suggestion actually chooses.
 *
 * The case this file exists for is **two identical dongles**. They share a USB identifier — it names
 * a vendor and a product, not a device — so a suggestion built from that identifier matches both and
 * produces the ambiguous binding the chooser exists to resolve. A fixture with one dongle cannot fail
 * that, in the same way a family of one cannot collide with itself, so every assertion below that
 * matters is made against the two-dongle inventory, and the anchor is asserted before it: that the
 * two really do share an identifier and really do differ by port.
 *
 * Both directions are covered: what a distinguishing suggestion does, and what the surface reports
 * when it is given nothing — no radios, no inventory at all, and a role that bound with no ambiguity.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';

import { BindingCandidate as BindingCandidateWire } from '@wayfarer/schemas';
import { buildServer, type ServerContext } from '../src/api/server.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore } from '../src/state/store.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { bindingCandidates, resolveBinding, type BindingCandidate } from '../src/core/binding.ts';
import type { Inventory, RadioInventory } from '../src/inventory/index.ts';
import {
  COMBINATION_AP_ONE_CHANNEL,
  COMBINATION_CLIENT_ONLY,
  builtInAndDongle,
  noRadio,
  oneBuiltInRadio,
  radio,
  twoIdenticalDongles,
} from './helpers/synthetic-inventory.ts';

const AP = { kind: 'access-point' } as const;

/**
 * A server on a device that reports no hardware at all, for the one question the route has to answer
 * about itself: does the list reach the client.
 *
 * Deliberately the empty device. What is being pinned here is the *serializer*, not the builder —
 * the builder is proved above against real shapes — and an empty pair of lists is the answer that
 * would be indistinguishable from the key having been dropped if the key were not asserted first.
 */
async function inventoryHarness(): Promise<{
  app: Awaited<ReturnType<typeof buildServer>>;
  token: string;
  close: () => void;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-candidates-'));
  const database = openDatabase({ path: join(directory, 'state.db') });
  const store = createStore(database);
  await store.setAdminPassword('a-long-enough-password');
  store.setApiEnabled(true);

  const unreachable = (name: string) => (): never => {
    throw new Error(`${name} should not be reached in a candidates test`);
  };

  const context: ServerContext = {
    config: { ...DEFAULT_CONFIG, uiDir: null, stateDir: directory, cacheDir: join(directory, 'cache') },
    platform: {
      systemd: {} as never,
      net: {
        addresses: async () => [],
        links: async () => [],
        routes: async () => [],
        snapshot: async () => ({ links: [], addresses: [], routes: [], at: Date.now() }),
        watch: () => ({ stop: () => undefined }),
      } as never,
      wifi: {
        phys: async () => [],
        interfaces: async () => [],
        regulatory: async () => ({ global: null, perPhy: {} }),
        link: unreachable('wifi.link'),
        stations: unreachable('wifi.stations'),
      } as never,
      supplicant: {} as never,
      ap: {} as never,
      nft: {} as never,
      files: {} as never,
      sysctl: { read: unreachable('sysctl.read'), write: unreachable('sysctl.write') } as never,
      clock: {
        status: async () => ({
          timezone: null,
          ntpEnabled: null,
          synchronized: null,
          localRtc: null,
          timeUsec: null,
          rtcTimeUsec: null,
        }),
        resync: unreachable('clock.resync'),
      } as never,
      host: {
        boardModel: async () => null,
        uptimeSeconds: async () => 4000,
        reloadForeignManager: unreachable('host.reloadForeignManager'),
        reboot: unreachable('host.reboot'),
      } as never,
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
    } as never,
    store,
    telemetry: {
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
    } as never,
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
  };

  const app = await buildServer(context);
  return { app, token: store.createToken('candidates', ['read']).token, close: () => database.close() };
}

function byPhy(candidates: BindingCandidate[], phy: string): BindingCandidate {
  const found = candidates.find((candidate) => candidate.phy === phy);
  assert.ok(found, `no candidate for ${phy}`);
  return found;
}

/* ── two identical dongles: the mutation that matters ────────────────────────────────────── */

test('two dongles sharing a USB identifier get suggestions that separate them', () => {
  const inventory = twoIdenticalDongles();

  // The anchor. Without this, a fixture that quietly stopped containing two identical radios would
  // let every assertion below pass while proving nothing.
  assert.equal(inventory.radios.length, 2);
  const [first, second] = inventory.radios as [RadioInventory, RadioInventory];
  assert.equal(first.reported.usbId, second.reported.usbId);
  assert.notEqual(first.reported.devicePath, second.reported.devicePath);
  assert.ok(first.reported.devicePath !== null && second.reported.devicePath !== null);

  const candidates = bindingCandidates(inventory, true);
  assert.equal(candidates.length, 2);

  for (const [phy, path] of [
    ['phy0', first.reported.devicePath],
    ['phy1', second.reported.devicePath],
  ] as const) {
    const candidate = byPhy(candidates, phy);
    // The identifier is what the radio reports; it is simply not what the suggestion may be built
    // from here, and the candidate carries both so the screen can say why.
    assert.equal(candidate.usbId, first.reported.usbId);
    assert.deepEqual(candidate.suggestion, { by: 'bus-path', value: path });
    assert.equal(candidate.distinct, true);
    assert.ok(candidate.consequence?.includes('port'), 'the fallback must state that it follows the port');
    assert.ok(candidate.consequence?.includes(first.reported.usbId!), 'and name the identifier it replaced');
  }

  // Distinctness is a claim about resolution, so it is checked by resolving: each suggestion binds to
  // exactly the radio it came from, and neither reports `ambiguous`.
  for (const phy of ['phy0', 'phy1']) {
    const candidate = byPhy(candidates, phy);
    const resolution = resolveBinding({
      binding: candidate.suggestion,
      role: AP,
      inventory,
      wireless: true,
    });
    assert.equal(resolution.state, 'bound');
    assert.equal(resolution.state === 'bound' ? resolution.phy : null, phy);
  }
});

test('the identifier both dongles answer to is what an ambiguous binding is made of', () => {
  const inventory = twoIdenticalDongles();
  const usbId = inventory.radios[0]!.reported.usbId!;
  assert.equal(inventory.radios[1]!.reported.usbId, usbId);

  // The state the suggestion must never lead to, asserted here so that "distinct" has a meaning
  // measured rather than asserted: this is what the other outcome looks like.
  const resolution = resolveBinding({
    binding: { by: 'phy-usb', value: usbId },
    role: AP,
    inventory,
    wireless: true,
  });
  assert.equal(resolution.state, 'ambiguous');
  assert.equal(resolution.candidates.length, 2);
});

/* ── one dongle: the identifier is the right suggestion, and it follows the device ───────── */

test('a dongle nothing else answers to is suggested by its identifier, with no consequence', () => {
  const inventory = builtInAndDongle();

  // The anchor for this case is the opposite of the one above: the identifiers differ.
  assert.equal(inventory.radios.length, 2);
  assert.equal(inventory.radios[0]!.reported.usbId, null);
  assert.equal(inventory.radios[1]!.reported.usbId, '0e8d:7961');

  const candidates = bindingCandidates(inventory, true);
  const dongle = byPhy(candidates, 'phy1');
  assert.deepEqual(dongle.suggestion, { by: 'phy-usb', value: '0e8d:7961' });
  assert.equal(dongle.distinct, true);
  assert.equal(dongle.consequence, undefined);
  assert.equal(dongle.removable, true);
  assert.equal(dongle.currentName, 'wlan1');

  const builtIn = byPhy(candidates, 'phy0');
  assert.deepEqual(builtIn.suggestion, { by: 'phy-builtin' });
  assert.equal(builtIn.distinct, true);
  assert.equal(builtIn.consequence, undefined);
  assert.equal(builtIn.removable, false);
});

/* ── a radio nothing can name ────────────────────────────────────────────────────────────── */

test('a radio that reports no identifier, no bus path and no address is not offered as a choice', () => {
  const nameless = radio({
    phy: 'phy9',
    bus: 'usb',
    combinations: [COMBINATION_CLIENT_ONLY, COMBINATION_AP_ONE_CHANNEL],
    interfaceName: null,
  });
  nameless.reported.usbId = null;
  nameless.reported.devicePath = null;
  nameless.reported.macFromSysfs = null;

  const inventory: Inventory = { ...noRadio(), radios: [nameless] };

  // The anchor: the radio is present in the inventory, so an empty candidate list below is the rule
  // refusing to offer it rather than the fixture having no radio in it.
  assert.equal(inventory.radios.length, 1);
  assert.deepEqual(bindingCandidates(inventory, true), []);
});

/* ── asked with nothing ──────────────────────────────────────────────────────────────────── */

test('a device with no radio reports an empty list: we looked, and there is nothing', () => {
  const inventory = noRadio();
  assert.equal(inventory.radios.length, 0);
  assert.deepEqual(bindingCandidates(inventory, true), []);

  // The wired side of the same device is not empty, which is what makes the empty above an answer
  // about radios rather than about the inventory.
  assert.ok(bindingCandidates(inventory, false).length > 0);
});

test('an inventory with no hardware at all reports empty in both directions', () => {
  const inventory: Inventory = { ...noRadio(), radios: [], interfaces: [] };
  assert.deepEqual(bindingCandidates(inventory, true), []);
  assert.deepEqual(bindingCandidates(inventory, false), []);
});

test('a role that bound with no ambiguity still carries the list', () => {
  const inventory = oneBuiltInRadio();
  const resolution = resolveBinding({
    binding: { by: 'phy-builtin' },
    role: AP,
    inventory,
    wireless: true,
  });

  assert.equal(resolution.state, 'bound');
  // The point of hoisting: the chooser is reachable while the binding is healthy, not only once it
  // has broken.
  assert.equal(resolution.candidates.length, 1);
  assert.equal(resolution.candidates[0]!.phy, 'phy0');
  assert.equal(resolution.candidates[0]!.distinct, true);
});

/* ── wired ───────────────────────────────────────────────────────────────────────────────── */

test('a wired port is suggested by its address, and reports what was not measured as unmeasured', () => {
  const inventory = noRadio();
  const candidates = bindingCandidates(inventory, false);
  assert.equal(candidates.length, 1);

  const port = candidates[0]!;
  assert.equal(port.currentName, 'end0');
  assert.deepEqual(port.suggestion, { by: 'mac', value: port.mac! });
  assert.equal(port.distinct, true);
  // Not false: the interface inventory reports no bus, so removability was never measured here, and
  // a USB Ethernet adapter is exactly the case a confident `false` would get wrong.
  assert.equal(port.removable, null);
  assert.deepEqual(port.bands, []);
});

/* ── the wire: a list nobody can reach is a list that does not exist ─────────────────────── */

/**
 * The list was built and carried on every resolution, and the only way to obtain it was the plan of
 * the **active** profile — a plan review, unavailable while editing the binding of any other
 * profile, which is the moment the chooser is needed. `GET /api/inventory` answers it as what it is:
 * a question about hardware.
 *
 * Two assertions, and the second is the one with teeth. A Fastify response schema is a
 * **serializer**: a key it does not declare is dropped from the reply silently — no error, no log
 * line. So it is not enough that the handler returns candidates; every field of a real candidate has
 * to be named in `InventoryResponse`, or the screen receives a stripped one and nothing says so.
 */
test('the inventory route carries the candidates, and an empty pair is an answer rather than a silence', async () => {
  const { app, token, close } = await inventoryHarness();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/inventory',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { candidates?: { radios: unknown[]; interfaces: unknown[] } };

    // The key survived the serializer at all. This is the whole reason the schema was extended.
    assert.ok(body.candidates, 'the candidates must reach the client; an undeclared key is dropped in silence');
    // We looked and there is nothing, which is not the same as nobody having looked. This device
    // reports no hardware, so both lists are present and empty rather than the key being absent.
    assert.deepEqual(body.candidates.radios, []);
    assert.deepEqual(body.candidates.interfaces, []);
  } finally {
    await app.close();
    close();
  }
});

test('every field a real candidate carries is declared on the wire, in both directions', () => {
  /*
   * The parity that keeps the serializer honest, asserted against a candidate that uses every field
   * — a dongle whose suggestion had to be replaced, so `consequence` is populated too. Both
   * directions name a different defect: a field the candidate has and the schema does not is
   * silently stripped from the reply; a field the schema has and no candidate produces is a promise
   * to a screen that nothing keeps.
   */
  const dongles = bindingCandidates(twoIdenticalDongles(), true);
  const populated = dongles.find((candidate) => candidate.consequence !== undefined);
  assert.ok(populated, 'anchor: the two-dongle fixture must produce a candidate carrying a consequence');

  const wire = new Set(Object.keys(BindingCandidateWire.properties));
  const wired = bindingCandidates(noRadio(), false)[0]!;
  for (const candidate of [populated, wired]) {
    for (const key of Object.keys(candidate)) {
      assert.ok(wire.has(key), `"${key}" is carried by a candidate and would be dropped from the reply`);
    }
  }

  const produced = new Set([...Object.keys(populated), ...Object.keys(wired)]);
  for (const key of wire) {
    assert.ok(produced.has(key), `"${key}" is declared on the wire and no candidate ever produces it`);
  }

  // And the real thing validates, so the declaration is not merely the right set of names.
  assert.ok(Value.Check(BindingCandidateWire, populated), JSON.stringify(populated));
  assert.ok(Value.Check(BindingCandidateWire, wired), JSON.stringify(wired));
});
