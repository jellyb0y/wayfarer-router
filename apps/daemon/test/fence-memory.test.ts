/**
 * The fence may only narrow through a window — whatever the uplink happens to be doing at plan time.
 *
 * `classifyContentChange` softens a change to the core's exclusion list (the "fence") to `service`
 * when the only networks moving are ones the device **follows** — a subnet a peer handed one of our
 * tunnel interfaces. That is right, and it did the right thing on the bench board on 2026-09-22
 * (`10.164.0.0/20` → `10.164.96.0/20` on `wfvpnhq`). But which networks are **defended** was read from
 * live interface state at plan time. Reproduced by the acceptance tester on the board's own
 * configuration (`cls.mts`): if the uplink has no address at that moment — which is exactly the moment
 * an uplink flaps — its network is on neither list, and the fence dropping it was also `service`: no
 * window, no revert timer, and the core's return path to the network the board is reached through
 * gone. The bench board was saved only because `end0` also held an address on the same network.
 *
 * The rule now: a network **leaving** the running fence must be one that fence itself recorded as
 * followed when it was written (`PATHS.coreFence`, written beside it). Anything else leaves only
 * through a `network`-class change, whatever today's reading says.
 *
 * Everything here goes through the real planner and the real differ, against a reality that is the
 * previous plan applied — the shape the board runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { plan } from '../src/core/planner.ts';
import { diff, type Plan2, type Reality } from '../src/core/differ.ts';
import { PATHS } from '../src/core/desired-state.ts';
import { cleanFacts, oneBuiltInRadio } from './helpers/synthetic-inventory.ts';

function benchProfile(): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' }) as unknown as ProfileDocument;
  return {
    ...base,
    tunnels: [
      {
        id: 'hq',
        name: 'HQ',
        role: 'resource',
        enabled: true,
        protocol: 'openvpn',
        onUnavailable: 'block',
        config: { profile: 'client\ndev tun\n', interfaceSuffix: '0' },
      } as ProfileDocument['tunnels'][number],
    ],
  };
}

const UPLINK = { interface: 'end0', cidr: '192.0.2.5/24' };
const HQ_OLD = { interface: 'wfvpn0', cidr: '10.164.5.67/20' };
const HQ_NEW = { interface: 'wfvpn0', cidr: '10.164.101.9/20' };

function planned(networks: { interface: string; cidr: string }[]) {
  return plan({
    profile: benchProfile(),
    inventory: oneBuiltInRadio(),
    facts: { ...cleanFacts(), uplinkNetworks: networks },
    emissions: new Map([
      ['hq', { target: 'outbounds' as const, object: { type: 'direct', bind_interface: 'wfvpn0' }, interfaces: ['wfvpn0'] }],
    ]),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
  });
}

function applied(desired: ReturnType<typeof plan>['desired'], options: { withoutFence?: boolean } = {}): Reality {
  const sysctl: Record<string, string> = {};
  for (const setting of desired.sysctl) sysctl[setting.key] = setting.value;
  return {
    files: [...desired.files, ...desired.networkFiles]
      .filter((file) => !(options.withoutFence === true && file.path === PATHS.coreFence))
      .map((file) => ({ path: file.path, content: file.content, mode: file.mode })),
    units: desired.units.map((unit) => {
      const template = unit.name.includes('@.');
      return { name: unit.name, active: template ? false : unit.active, enabled: template ? false : unit.enabled, known: !template };
    }),
    interfaces: oneBuiltInRadio().interfaces.map((entry) => ({ name: entry.name, mac: entry.mac })),
    managementInterfaces: ['end0'],
    sysctl,
  };
}

function coreChange(result: Plan2): string {
  const change = result.fileChanges.find((entry) => entry.path === PATHS.coreConfig);
  assert.ok(change, 'the fixture must change the core configuration, or the assertion after it is vacuous');
  return change.blastRadius;
}

function fence(desired: ReturnType<typeof plan>['desired']): string[] {
  const core = JSON.parse(desired.files.find((file) => file.path === PATHS.coreConfig)!.content) as {
    inbounds: { route_exclude_address: string[] }[];
  };
  return core.inbounds[0]!.route_exclude_address;
}

test('the flap: the uplink has no address at plan time, and the fence would drop its network — network', () => {
  const before = planned([UPLINK, HQ_OLD]);
  const after = planned([HQ_OLD]);
  // The guard: the fence really would lose the uplink's network.
  assert.ok(fence(before.desired).includes('192.0.2.0/24'));
  assert.ok(!fence(after.desired).includes('192.0.2.0/24'), 'the fixture no longer drops the uplink network');

  // Mutation: in `onlyFollowedNetworksMoved`, go back to `departed.every((cidr) => !defended.has(cidr))`
  // and this goes red with `service` — the tester's reproduction.
  assert.equal(coreChange(diff({ desired: after.desired, reality: applied(before.desired) })), 'network');
});

test('the flap and a follower move together — still network', () => {
  const before = planned([UPLINK, HQ_OLD]);
  const after = planned([HQ_NEW]);
  assert.equal(coreChange(diff({ desired: after.desired, reality: applied(before.desired) })), 'network');
});

test('a follower move on its own is still service, because the running fence recorded it as followed', () => {
  // The other half, which must keep working: the board's 10.164.0.0/20 → 10.164.96.0/20.
  const before = planned([UPLINK, HQ_OLD]);
  const after = planned([UPLINK, HQ_NEW]);
  const result = diff({ desired: after.desired, reality: applied(before.desired) });
  assert.equal(coreChange(result), 'service');
  // The record travels with the fence: it is written by the same change, in the same class, so a
  // narrowed apply that is refused the fence is refused the record too.
  const record = result.fileChanges.find((entry) => entry.path === PATHS.coreFence);
  assert.ok(record, 'the fence record did not change with the fence');
  assert.equal(record.blastRadius, coreChange(result));
});

test('a follower move with no record of the running fence is network — absent memory is not permission', () => {
  const before = planned([UPLINK, HQ_OLD]);
  const after = planned([UPLINK, HQ_NEW]);
  // A device upgraded from before the record existed: the fence is on disk, its record is not.
  const result = diff({ desired: after.desired, reality: applied(before.desired, { withoutFence: true }) });
  assert.equal(coreChange(result), 'network');
  // And the record being created takes the fence's class, so a narrowed (hot/service) apply that is
  // refused the fence cannot write a record describing a fence that was never written. Mutation: class
  // the record by its path alone (`service`) and this goes red.
  assert.equal(result.fileChanges.find((entry) => entry.path === PATHS.coreFence)?.blastRadius, 'network');
});

test('a record that cannot be read is no record', () => {
  const before = planned([UPLINK, HQ_OLD]);
  const after = planned([UPLINK, HQ_NEW]);
  const reality = applied(before.desired);
  reality.files = reality.files.map((file) => (file.path === PATHS.coreFence ? { ...file, content: '{not json' } : file));
  assert.equal(coreChange(diff({ desired: after.desired, reality })), 'network');
});

test('the record names the followed networks and the interface each was read from', () => {
  const record = JSON.parse(planned([UPLINK, HQ_OLD]).desired.files.find((file) => file.path === PATHS.coreFence)!.content) as {
    followed: { network: string; interface: string }[];
  };
  assert.deepEqual(record.followed, [{ network: '10.164.0.0/20', interface: 'wfvpn0' }]);
});
