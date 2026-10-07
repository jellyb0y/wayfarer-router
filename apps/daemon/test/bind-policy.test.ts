/**
 * Where the management surface may listen: both halves of the owner's requirement, separately.
 *
 * The two halves fail with different messages on purpose. "The wire is not bound" and "a tunnel is
 * bound" are opposite defects with opposite fixes, and a single assertion covering both would tell
 * whoever reads the failure the one thing they already knew — that something is wrong.
 *
 * The negative half is written so it can actually fail. It is not enough to hand the policy a
 * correctly classified tunnel and observe that nothing binds it: that passes just as well with no
 * refusal in the code at all, because the positive half would never have chosen it. So the case
 * below hands the policy a tunnel **that the classifier got wrong** — labelled `wired` — and
 * requires it to be refused anyway. Delete the final filter in `bind-policy.ts` and that test binds
 * `wfvpnprt`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideManagementInterfaces,
  localChannelsFor,
  managementSurfacesChanged,
  refusalSummary,
  refuseNonLocal,
  managementChannels,
  type ClassifiedInterface,
} from '../src/api/bind-policy.ts';
import type { NetLink } from '../src/platform/parse/ip-json.ts';

/**
 * The bench board as measured on 2026-09-21, interface for interface.
 *
 * Real names and real classes rather than `eth0`/`tun0` placeholders, because the defect this
 * replaces was invisible precisely to a test written against a tidy imaginary device: the wire is
 * the interface no plan touches, so it is the one an invented fixture forgets to include.
 */
const BENCH: ClassifiedInterface[] = [
  { name: 'lo', class: 'loopback', why: 'the loopback device' },
  { name: 'end0', class: 'wired', why: 'ether, no virtual kind' },
  { name: 'wlx90de8047b4b4', class: 'accessPoint', why: 'the access point recorded by the last apply' },
  { name: 'wfwan0', class: 'wirelessUplink', why: 'the uplink recorded by the last apply' },
  { name: 'wfvpnprt', class: 'tunnel', why: 'kind=tun' },
  { name: 'wfvpncrp', class: 'tunnel', why: 'kind=tun' },
  { name: 'wfvpnhq', class: 'tunnel', why: 'kind=wireguard' },
  { name: 'tun0', class: 'tunnel', why: 'kind=tun, created by nothing this device manages' },
];

const BENCH_TUNNELS = ['wfvpnprt', 'wfvpncrp', 'wfvpnhq', 'tun0'];

// ------------------------------------------------------- the positive half

test('every local channel is bound: the wire, the access point and the wireless uplink', () => {
  const decision = decideManagementInterfaces({
    classified: BENCH,
    onUplinkNetwork: true,
    tunnelInterfaces: BENCH_TUNNELS,
  });

  // Named one by one rather than by count. `end0` is the one this whole change exists for: it was
  // absent for months while the set looked full, because the bind set was built from what an apply
  // had recorded and no plan records the lifeline.
  assert.ok(decision.bind.includes('end0'), 'the wire is not bound — the panel is unreachable over Ethernet');
  assert.ok(decision.bind.includes('wlx90de8047b4b4'), 'the access point is not bound');
  assert.ok(decision.bind.includes('wfwan0'), 'the wireless uplink is not bound');
  assert.deepEqual(decision.refused, []);
});

test('the uplink is withheld when the operator turns that surface off, and nothing else changes', () => {
  const decision = decideManagementInterfaces({
    classified: BENCH,
    onUplinkNetwork: false,
    tunnelInterfaces: BENCH_TUNNELS,
  });

  assert.ok(!decision.bind.includes('wfwan0'), 'the uplink is bound although the profile turns it off');
  assert.deepEqual(
    decision.withheld.map((entry) => entry.name),
    ['wfwan0'],
  );
  // Withheld is not refused: the difference is a setting versus a prohibition, and collapsing them
  // would make an operator's preference look like a safety refusal in the log.
  assert.deepEqual(decision.refused, []);
  assert.ok(decision.bind.includes('end0'), 'turning the uplink surface off also lost the wire');
  assert.ok(decision.bind.includes('wlx90de8047b4b4'), 'turning the uplink surface off also lost the access point');
});

// ------------------------------------------------------- the negative half

test('no tunnel interface is ever bound, and the four on the bench board are named', () => {
  const decision = decideManagementInterfaces({
    classified: BENCH,
    onUplinkNetwork: true,
    tunnelInterfaces: BENCH_TUNNELS,
  });

  for (const tunnel of BENCH_TUNNELS) {
    assert.ok(
      !decision.bind.includes(tunnel),
      `the management surface would listen inside the tunnel ${tunnel}, which is prohibited`,
    );
  }
  // The fixture has to contain tunnels for the assertion above to mean anything. A device with no
  // tunnels passes it without the policy doing a thing.
  assert.equal(BENCH.filter((entry) => entry.class === 'tunnel').length, 4);
});

test('a tunnel the classifier got wrong is still refused, and reported as a defect', () => {
  // This is the case the previous test cannot produce. `wfvpnprt` is handed over labelled `wired`,
  // so the positive half accepts it — and the final refusal has to disagree with the verdict that
  // chose it. With the refusal removed, this binds a corporate tunnel.
  const misclassified: ClassifiedInterface[] = BENCH.map((entry) =>
    entry.name === 'wfvpnprt' ? { ...entry, class: 'wired', why: 'misread as ether' } : entry,
  );

  const decision = decideManagementInterfaces({
    classified: misclassified,
    onUplinkNetwork: true,
    tunnelInterfaces: BENCH_TUNNELS,
  });

  assert.ok(
    !decision.bind.includes('wfvpnprt'),
    'a tunnel classified as a wire was bound: the refusal is not independent of the classification',
  );
  assert.deepEqual(
    decision.refused.map((entry) => entry.name),
    ['wfvpnprt'],
    'the refusal removed the interface without reporting it, so nobody would learn of the defect',
  );
  assert.match(refusalSummary(decision.refused), /wfvpnprt/);
  assert.match(refusalSummary(decision.refused), /defect/);
  // The rest of the decision is unharmed: a refusal is not a reason to fall back to loopback.
  assert.ok(decision.bind.includes('end0'));
  assert.ok(decision.bind.includes('wlx90de8047b4b4'));
});

test('an interface the classifier could not decide is never bound', () => {
  const decision = decideManagementInterfaces({
    classified: [...BENCH, { name: 'enx0018', class: 'unknown', why: 'ip reported no kind and no link type' }],
    onUplinkNetwork: true,
    tunnelInterfaces: BENCH_TUNNELS,
  });

  // Fail closed. An interface that cannot be shown to be local is treated as one that might not be,
  // which is the same discipline the rest of this codebase applies to a failed read.
  //
  // Stated honestly: this passes with the final refusal deleted, because the positive half does not
  // choose `unknown` either. It is a test of the positive half's restraint, not of the refusal —
  // the refusal is proved by the misclassification case above, which is the only one that can.
  assert.ok(!decision.bind.includes('enx0018'), 'an unclassifiable interface was bound');
  // And it is not reported as a refused tunnel: "we could not tell" and "we know this is a tunnel"
  // are different facts, and an operator acts on them differently.
  assert.deepEqual(decision.refused, []);
});

/*
 * The gate, reached directly, because through `decideManagementInterfaces` it cannot be reached at all.
 *
 * Measured by mutation on 2026-09-21 against this file as it then stood: deleting `tunnels.has(name)`
 * from the gate turned a test red; deleting `entry.class === 'tunnel'` did not, and neither did
 * deleting `entry.class === 'unknown'`. Both survived every case here.
 *
 * Not for want of an assertion — for want of reachability. The positive half only ever puts `wired`,
 * `accessPoint` and `wirelessUplink` into the chosen list, so no input to `decideManagementInterfaces`
 * can put a `tunnel` in front of those two clauses. They were a guarantee nothing reached, inside the
 * function written to delete exactly that shape from the bind path.
 *
 * The clauses are what keeps the gate standing if somebody widens `ALWAYS_LOCAL`, so they stay. The
 * two cases below hand the gate its input directly, which is the only way to make them do work. Each
 * passes an **empty name list**, so `tunnels.has` cannot cover for the clause under test: break the
 * clause and the case goes red on its own.
 */
test('the gate refuses a tunnel on its class alone, with no name list to fall back on', () => {
  const { bind, refused } = refuseNonLocal(
    [
      { name: 'end0', class: 'wired', why: 'ether, no virtual kind' },
      { name: 'tun0', class: 'tunnel', why: 'kind=tun, created by nothing this device manages' },
    ],
    // Empty on purpose. A tunnel this device did not create is in nobody's list, and the owner's
    // prohibition covers it identically — so the class has to be enough by itself.
    [],
  );

  assert.deepEqual(bind, ['end0'], 'a tunnel reached the bind list on class alone');
  assert.deepEqual(
    refused.map((entry) => entry.name),
    ['tun0'],
    'the tunnel was dropped without being reported, so nobody would learn the positive half had widened',
  );
  assert.match(refusalSummary(refused), /defect/);
});

test('the gate refuses an interface it could not classify, and says which fact it acted on', () => {
  const { bind, refused } = refuseNonLocal(
    [
      { name: 'end0', class: 'wired', why: 'ether, no virtual kind' },
      { name: 'enx0018', class: 'unknown', why: 'ip reported no kind and no link type' },
    ],
    [],
  );

  // Fail closed: what cannot be shown to be local is treated as possibly not local.
  assert.deepEqual(bind, ['end0'], 'an unclassifiable interface reached the bind list');
  assert.deepEqual(
    refused.map((entry) => entry.class),
    ['unknown'],
    'the class is carried into the refusal: "we could not tell" and "we know this is a tunnel" are different reports',
  );
});

test('the gate opens each name once, however many entries carry it', () => {
  // The bind list is a list of sockets to open. A name twice is a second bind on the same address,
  // which surfaces as a port conflict at start-up rather than as an obvious duplicate.
  const { bind } = refuseNonLocal(
    [
      { name: 'end0', class: 'wired', why: 'ether, no virtual kind' },
      { name: 'end0', class: 'accessPoint', why: 'the same name reached the gate from a second source' },
    ],
    [],
  );

  assert.deepEqual(bind, ['end0']);
});

test('a device with nothing configured yet still binds its wire', () => {
  // Before the first apply there is no recorded access point and no recorded uplink. That used to
  // mean loopback only — which is the state the bench board was actually found in.
  const decision = decideManagementInterfaces({
    classified: [
      { name: 'lo', class: 'loopback', why: 'the loopback device' },
      { name: 'end0', class: 'wired', why: 'ether, no virtual kind' },
    ],
    onUplinkNetwork: true,
    tunnelInterfaces: [],
  });

  assert.deepEqual(decision.bind, ['end0']);
});

// ------------------------------------------------------- the seam

/**
 * The join between classification and policy, against links shaped like the ones `ip -d link show`
 * printed on the bench board.
 *
 * The two halves above are separately correct and were separately correct while the wire was
 * unreachable for months. The defect was in neither: it was in the join, which built its list from a
 * source that could not contain `end0`. So the join is exercised here with kernel-shaped input, not
 * with `ClassifiedInterface` values that assume the answer.
 */
function link(name: string, over: Partial<NetLink> = {}): NetLink {
  return {
    ifindex: 1,
    name,
    flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'],
    mtu: 1500,
    operstate: 'UP',
    linkType: 'ether',
    mac: '00:11:22:33:44:55',
    altNames: [],
    kind: null,
    ...over,
  };
}

const BENCH_LINKS: NetLink[] = [
  link('lo', { linkType: 'loopback', flags: ['LOOPBACK', 'UP'] }),
  link('end0'),
  link('wlx90de8047b4b4'),
  link('wfwan0'),
  link('wfvpnprt', { linkType: 'none', kind: null, mac: null }),
  link('wfvpncrp', { linkType: 'none', kind: null, mac: null }),
  link('wfvpnhq', { linkType: 'none', kind: 'wireguard', mac: null }),
  link('tun0', { linkType: 'none', kind: null, mac: null }),
];

const BENCH_RECORDED = { accessPoint: 'wlx90de8047b4b4', uplinks: ['wfwan0'], tunnels: [] };
const BENCH_RADIOS = ['wlx90de8047b4b4', 'wfwan0'];

test('the seam: the bench board binds its wire, its access point and its uplink, and no tunnel', () => {
  const decision = localChannelsFor({
    links: BENCH_LINKS,
    radios: BENCH_RADIOS,
    managementSurfaces: BENCH_RECORDED,
    profileTunnelInterfaces: [],
    onUplinkNetwork: true,
  });

  // This is the assertion the board would have failed on 2026-09-21, from `ip link` input alone.
  assert.deepEqual(decision.bind.slice().sort(), ['end0', 'wfwan0', 'wlx90de8047b4b4']);
  for (const tunnel of BENCH_TUNNELS) {
    assert.ok(!decision.bind.includes(tunnel), `${tunnel} would be listened on`);
  }
});

test('the seam: before the first apply the wire is still bound', () => {
  // `managementSurfaces: null` is a device that has never applied anything. This used to resolve to
  // loopback only, which is the state the bench board was found in.
  const decision = localChannelsFor({
    links: [link('lo', { linkType: 'loopback' }), link('end0')],
    radios: [],
    managementSurfaces: null,
    profileTunnelInterfaces: [],
    onUplinkNetwork: true,
  });

  assert.deepEqual(decision.bind, ['end0']);
});

test('the seam: with no radio list, an ether link is not guessed to be a wire', () => {
  // `radios: null` means nobody could ask the driver — a failed read, not an empty answer. A wire
  // and a radio look identical from a link alone, so nothing is bound rather than something being
  // bound on a guess. The cost is a device reachable on loopback until `iw` answers; the cost of the
  // other choice is the panel appearing on a radio nobody meant to expose it on.
  const decision = localChannelsFor({
    links: [link('lo', { linkType: 'loopback' }), link('end0'), link('wlx90de8047b4b4')],
    radios: null,
    managementSurfaces: BENCH_RECORDED,
    profileTunnelInterfaces: [],
    onUplinkNetwork: true,
  });

  assert.ok(!decision.bind.includes('end0'), 'a wire was assumed without the radio list to rule it out');
  // The access point is still bound: the profile names it, so it needs no guessing.
  assert.ok(decision.bind.includes('wlx90de8047b4b4'));
});

test('the seam: the profile catches a tunnel the link shape cannot show', () => {
  /*
   * `wfvpnplain` is a tunnel that looks like an ordinary wire: `ether`, no kind, a MAC. The
   * classifier decides by shape and therefore cannot see it — nothing in the kernel's report
   * distinguishes it from `end0`. Only the plan knows, because the plan made it.
   *
   * This test used to assert the opposite half. It was written while the daemon still passed an
   * empty list, and it stated that fact out loud — that such an interface *was* bound — so that it
   * would fail the day the gap closed. It did. This is the updated assertion, and the pair below is
   * what keeps it honest: the same links, twice, differing only in what the profile was able to say.
   */
  const ordinary = [...BENCH_LINKS, link('wfvpnplain')];
  const args = {
    links: ordinary,
    radios: BENCH_RADIOS,
    managementSurfaces: BENCH_RECORDED,
    onUplinkNetwork: true,
  };

  const told = localChannelsFor({ ...args, profileTunnelInterfaces: ['wfvpnplain'] });
  assert.ok(!told.bind.includes('wfvpnplain'), 'the profile said this was a tunnel and it was bound anyway');
  assert.deepEqual(told.bind.slice().sort(), ['end0', 'wfwan0', 'wlx90de8047b4b4']);
  /*
   * And it is excluded by being *classified*, not by being caught at the gate.
   *
   * The difference is not cosmetic: `refused` means "something upstream called a tunnel a local
   * channel", and `refusalSummary` phrases it as a defect to investigate. A profile's own tunnel
   * arriving there would be a standing false alarm — and the day a real misclassification happened,
   * it would be one more line in a log that already cries wolf every boot.
   *
   * Measured: stop passing `profileTunnelInterfaces` to the classifier inside `localChannelsFor` and
   * every other assertion in this file still passes, because the union at the gate catches the name
   * anyway. This is the assertion that notices.
   */
  assert.deepEqual(told.refused, [], 'a tunnel the profile named reached the gate instead of the classifier');

  /*
   * The control, and the reason the assertion above can fail rather than merely pass.
   *
   * Without the profile's list the same interface *is* bound, which proves the shape check alone
   * does not catch it — so the first assertion is exercising the second source and not something
   * else that happens to exclude it.
   *
   * Measured, because the obvious claim would have been wrong: the path this covers is the list
   * reaching the **classifier**, which marks the name a tunnel. Deleting the profile list from the
   * union inside `decideManagementInterfaces` changes nothing here, and no test in this file turns
   * red. That redundancy is deliberate and is described where it lives; it is not covered, and
   * saying so is worth more than a test that would appear to cover it.
   */
  const blind = localChannelsFor({ ...args, profileTunnelInterfaces: [] });
  assert.ok(
    blind.bind.includes('wfvpnplain'),
    'the link shape alone now excludes this, so the case no longer exercises the profile list',
  );
});

test('the seam: an empty tunnel list means no tunnels, and the shape check still holds', () => {
  // The reading that makes an empty list safe, asserted rather than left in a comment: a plan that
  // created no tunnels is not a plan that knows nothing. Every tunnel whose shape gives it away is
  // still refused with the list empty — which is the condition under which "empty means none" costs
  // nothing.
  const decision = localChannelsFor({
    links: BENCH_LINKS,
    radios: BENCH_RADIOS,
    managementSurfaces: { ...BENCH_RECORDED, tunnels: [] },
    profileTunnelInterfaces: [],
    onUplinkNetwork: true,
  });
  for (const tunnel of BENCH_TUNNELS) {
    assert.ok(!decision.bind.includes(tunnel), `${tunnel} was bound with an empty profile tunnel list`);
  }
  assert.ok(decision.bind.includes('end0'));
});

// ------------------------------------------------------- the record itself

test('a changed tunnel list counts as a change, so the record is not left stale', () => {
  const stored = { accessPoint: 'wlx90de8047b4b4', uplinks: ['wfwan0'], tunnels: ['wfvpnprt'] };

  // The omission this guards. `tunnels` was added to the record and to its reader while the writer's
  // change check still compared only the other two fields — it typechecked and every test passed,
  // and the effect would have been a plan with new tunnel names never being written at all.
  assert.equal(managementSurfacesChanged(stored, { ...stored, tunnels: ['wfvpncrp'] }), true);
  assert.equal(managementSurfacesChanged(stored, { ...stored, tunnels: [] }), true);
  assert.equal(managementSurfacesChanged(stored, { ...stored, tunnels: ['wfvpnprt', 'wfvpncrp'] }), true);

  // Order is part of the value, not an accident of it: these names are positional in the plan.
  assert.equal(managementSurfacesChanged({ ...stored, tunnels: ['a', 'b'] }, { ...stored, tunnels: ['b', 'a'] }), true);

  // And the other members still count, so this did not become a tunnel-only check.
  assert.equal(managementSurfacesChanged(stored, { ...stored, accessPoint: 'wlan1' }), true);
  assert.equal(managementSurfacesChanged(stored, { ...stored, uplinks: [] }), true);

  // Unchanged is unchanged: a write per plan would be a write per look at the review screen.
  assert.equal(managementSurfacesChanged(stored, { ...stored }), false);
  // Nothing recorded yet is a change, not a match against an absence.
  assert.equal(managementSurfacesChanged(null, stored), true);
});

// ------------------------------------------------------- carrying the decision to a person

/*
 * `refused` and `withheld` were computed and discarded: nothing put them on the wire, so the only
 * screen that could have shown a refusal could not mention one. These cases are about the report
 * being able to *say* the bad thing, which is the part that was missing — not about the decision,
 * which was already right.
 */
const BENCH_ADDRESSES = [
  { name: 'lo', address: '127.0.0.1', family: 'inet' },
  { name: 'end0', address: '192.168.77.7', family: 'inet' },
  { name: 'wlx90de8047b4b4', address: '10.44.0.1', family: 'inet' },
  { name: 'wfwan0', address: '192.168.77.8', family: 'inet' },
  { name: 'wfvpnprt', address: '10.136.0.6', family: 'inet' },
  { name: 'tun0', address: '172.19.0.1', family: 'inet' },
];

test('a channel named in the decision but bound to nothing reports as silent, not as absent', () => {
  // The bench board on 2026-09-21, exactly: `ss -tln` answered on loopback, the access point and the
  // uplink, and `end0` answered nothing while being in the list. A view drawing only chosen names
  // renders that identically to a working wire, which is how it survived months.
  const report = managementChannels({
    classified: BENCH,
    decision: decideManagementInterfaces({ classified: BENCH, onUplinkNetwork: true, tunnelInterfaces: BENCH_TUNNELS }),
    addresses: BENCH_ADDRESSES,
    boundAddresses: ['127.0.0.1', '10.44.0.1', '192.168.77.8'],
  });

  const wire = report.channels.find((entry) => entry.interface === 'end0');
  assert.ok(wire !== undefined, 'the wire vanished from the report instead of being shown as silent');
  assert.deepEqual(wire.addresses, ['192.168.77.7'], 'the address it has is reported even though nothing answers');
  assert.equal(wire.listening, false, 'a named-but-unbound interface was reported as listening');

  // And the ones that do answer say so, or the field above proves nothing.
  assert.equal(report.channels.find((entry) => entry.interface === 'wfwan0')?.listening, true);
  assert.equal(report.channels.find((entry) => entry.interface === 'wlx90de8047b4b4')?.listening, true);
});

test('the class travels on the wire, for every interface including the tunnels', () => {
  const report = managementChannels({
    classified: BENCH,
    decision: decideManagementInterfaces({ classified: BENCH, onUplinkNetwork: true, tunnelInterfaces: BENCH_TUNNELS }),
    addresses: BENCH_ADDRESSES,
    boundAddresses: ['127.0.0.1'],
  });

  // A client must not have to decide this: the kernel reports `ether` for a radio exactly as for a
  // wire, so a browser-side classifier would be a second source of truth about the one question this
  // module answers.
  assert.equal(report.channels.find((entry) => entry.interface === 'end0')?.class, 'wired');
  assert.equal(report.channels.find((entry) => entry.interface === 'wfwan0')?.class, 'wirelessUplink');
  assert.equal(report.channels.find((entry) => entry.interface === 'tun0')?.class, 'tunnel');
  // Tunnels are reported, not hidden. An operator asking why the panel is not on a tunnel is owed
  // the answer that it is a tunnel, rather than a list the interface is missing from.
  assert.equal(report.channels.length, BENCH.length);
});

test('a refusal reaches the report, carrying the classifier words rather than a code', () => {
  const misclassified: ClassifiedInterface[] = BENCH.map((entry) =>
    entry.name === 'wfvpnprt' ? { ...entry, class: 'wired', why: 'misread as ether' } : entry,
  );
  const report = managementChannels({
    classified: misclassified,
    decision: decideManagementInterfaces({
      classified: misclassified,
      onUplinkNetwork: true,
      tunnelInterfaces: BENCH_TUNNELS,
    }),
    addresses: BENCH_ADDRESSES,
    boundAddresses: ['127.0.0.1'],
  });

  assert.deepEqual(report.refused, [{ interface: 'wfvpnprt', class: 'wired', reason: 'misread as ether' }]);
  // The reason is the sentence, not an enumeration: it is read by somebody whose panel did not open.
  assert.equal(report.refused[0]?.reason, 'misread as ether');
});

test('withheld is reported separately from refused, because a setting is not a prohibition', () => {
  const report = managementChannels({
    classified: BENCH,
    decision: decideManagementInterfaces({ classified: BENCH, onUplinkNetwork: false, tunnelInterfaces: BENCH_TUNNELS }),
    addresses: BENCH_ADDRESSES,
    boundAddresses: ['127.0.0.1'],
  });

  assert.deepEqual(report.withheld.map((entry) => entry.interface), ['wfwan0']);
  assert.equal(report.withheld[0]?.reason, 'the uplink recorded by the last apply');
  // Collapsing the two would make an operator's own preference look like a safety refusal.
  assert.deepEqual(report.refused, []);
});

test('an interface with no address is reported with an empty list, not omitted', () => {
  // "No address yet" is a state a person needs to see: it is the difference between a misconfigured
  // interface and one whose lease has not arrived.
  const report = managementChannels({
    classified: BENCH,
    decision: decideManagementInterfaces({ classified: BENCH, onUplinkNetwork: true, tunnelInterfaces: BENCH_TUNNELS }),
    addresses: BENCH_ADDRESSES.filter((entry) => entry.name !== 'end0'),
    boundAddresses: ['127.0.0.1'],
  });

  const wire = report.channels.find((entry) => entry.interface === 'end0');
  assert.deepEqual(wire?.addresses, []);
  assert.equal(wire?.listening, false);
});
