/**
 * Interface classification, tested against the composition the bench board actually has.
 *
 * ## The standard these tests are held to
 *
 * A test that asserts the right answer on a set where nothing could go wrong proves nothing. That was
 * demonstrated here rather than argued: deleting the binding filter outright left the obvious test —
 * *no tunnel is ever listened on* — still passing, because the fixture it ran against contained nothing
 * that could expose the deletion. It would have been cited as evidence and was worth zero.
 *
 * So every test below is built to change its verdict when the classification breaks, and the two that
 * matter most come in a pair pointing opposite ways: one fails if the link-shape rules are removed, the
 * other fails if they are widened to swallow everything. A guard that can only fail in one direction is
 * half a guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyInterfaces, type ChannelClass } from '../src/core/interface-class.ts';
import type { NetLink } from '../src/platform/parse/ip-json.ts';

function link(partial: Partial<NetLink> & { name: string }): NetLink {
  return {
    ifindex: 1,
    flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'],
    mtu: 1500,
    operstate: 'UP',
    linkType: 'ether',
    mac: '00:00:00:00:00:00',
    altNames: [],
    kind: null,
    ...partial,
  };
}

/**
 * The bench board as measured on 2026-09-21.
 *
 * Six interfaces, three of them ours, one of them somebody else's. The composition is the fixture
 * because a composed one would have been composed by the same understanding that writes the classifier,
 * and the interesting interface — a tunnel this profile did not create — is exactly the one nobody
 * thinks to invent.
 */
const BENCH_LINKS: NetLink[] = [
  link({ name: 'lo', ifindex: 1, linkType: 'loopback', flags: ['LOOPBACK', 'UP', 'LOWER_UP'] }),
  link({ name: 'end0', ifindex: 2, mac: '02:81:1f:3a:44:10' }),
  link({ name: 'wlx90de8047b4b4', ifindex: 3, mac: '90:de:80:47:b4:b4' }),
  link({ name: 'wfwan0', ifindex: 4, mac: '5c:f2:86:11:22:33' }),
  // OpenVPN's devices: the kernel reports no link layer for these at all.
  link({ name: 'wfvpnprt', ifindex: 5, linkType: 'none', mac: null, kind: 'tun' }),
  link({ name: 'wfvpncrp', ifindex: 6, linkType: 'none', mac: null, kind: 'tun' }),
  link({ name: 'wfvpnhq', ifindex: 7, linkType: 'none', mac: null, kind: 'tun' }),
  // Not created by this profile. Carries 172.19.0.1/30.
  link({ name: 'tun0', ifindex: 8, linkType: 'none', mac: null, kind: 'tun' }),
];

const BENCH_SURFACES = { accessPoint: 'wlx90de8047b4b4', uplinks: ['wfwan0'] };
const OUR_TUNNELS = ['wfvpnprt', 'wfvpncrp', 'wfvpnhq'];
const BENCH_RADIOS = ['wlx90de8047b4b4', 'wfwan0'];

function classesOf(result: { name: string; class: ChannelClass }[]): Record<string, ChannelClass> {
  return Object.fromEntries(result.map((entry) => [entry.name, entry.class]));
}

test('the measured bench composition classifies the way the operator describes it', () => {
  const classes = classesOf(
    classifyInterfaces({
      links: BENCH_LINKS,
      managementSurfaces: BENCH_SURFACES,
      tunnelInterfaces: OUR_TUNNELS,
      wirelessInterfaces: BENCH_RADIOS,
    }),
  );

  assert.deepEqual(classes, {
    lo: 'loopback',
    end0: 'wired',
    wlx90de8047b4b4: 'accessPoint',
    wfwan0: 'wirelessUplink',
    wfvpnprt: 'tunnel',
    wfvpncrp: 'tunnel',
    wfvpnhq: 'tunnel',
    tun0: 'tunnel',
  });
});

test('a tunnel this profile did not create is still a tunnel, and the reason says so', () => {
  // The fixture can express the defect, which is the precondition for this test meaning anything: the
  // foreign interface is deliberately absent from the profile's own list, so an implementation that
  // consulted only that list would have to get this wrong.
  assert.equal(OUR_TUNNELS.includes('tun0'), false, 'the fixture must not hand the answer to the classifier');

  const result = classifyInterfaces({
    links: BENCH_LINKS,
    managementSurfaces: BENCH_SURFACES,
    tunnelInterfaces: OUR_TUNNELS,
    wirelessInterfaces: BENCH_RADIOS,
  });
  const foreign = result.find((entry) => entry.name === 'tun0');

  assert.equal(foreign?.class, 'tunnel');
  // The verdict must come from the kernel's description, not from a profile that never mentioned it.
  assert.match(foreign?.why ?? '', /kernel/);
  assert.doesNotMatch(foreign?.why ?? '', /profile/);
});

test('the shape rules decide nothing they were not given evidence for', () => {
  /*
   * The other half of the pair above.
   *
   * That test fails if the link-shape rules are deleted. This one fails if they are widened until
   * everything looks like a tunnel — which is the cheap way to make that test pass and would refuse the
   * wire the owner is trying to reach the device on. Same interface, evidence removed: `tun0` with an
   * ordinary Ethernet link layer and no kind is not something this function may call a tunnel.
   */
  const scrubbed = BENCH_LINKS.map((entry) =>
    entry.name === 'tun0' ? link({ name: 'tun0', ifindex: 8, linkType: 'ether', kind: null }) : entry,
  );

  const result = classifyInterfaces({
    links: scrubbed,
    managementSurfaces: BENCH_SURFACES,
    tunnelInterfaces: OUR_TUNNELS,
    wirelessInterfaces: BENCH_RADIOS,
  });

  assert.notEqual(result.find((entry) => entry.name === 'tun0')?.class, 'tunnel');
});

test('a wire cannot be told from a radio without the radio list, and says which question is open', () => {
  const result = classifyInterfaces({
    links: BENCH_LINKS,
    managementSurfaces: BENCH_SURFACES,
    tunnelInterfaces: OUR_TUNNELS,
    // Nobody asked the driver. This is a real state, not a test convenience: it is what the daemon has
    // before the platform layer has enumerated the radios.
    wirelessInterfaces: null,
  });
  const classes = classesOf(result);

  assert.equal(classes['end0'], 'unknown', 'an Ethernet link layer alone does not make something a wire');
  // The profile names this an uplink, which still is not enough: a wireless uplink is its own class and
  // a wired one is just `wired`, so without the radio list naming either would be a guess.
  assert.equal(classes['wfwan0'], 'unknown', 'knowing it is an uplink does not say whether it is a radio');
  assert.match(
    result.find((entry) => entry.name === 'wfwan0')?.why ?? '',
    /uplink/,
    'and the reason must still say what the profile does know, or this reads as a bug',
  );
  assert.equal(classes['wlx90de8047b4b4'], 'accessPoint', 'the access point it serves is named outright');
  // The tunnels do not depend on the radio list at all, so losing it must not blur them.
  assert.equal(classes['tun0'], 'tunnel');

  const why = result.find((entry) => entry.name === 'end0')?.why ?? '';
  assert.match(why, /radios/, 'the refusal has to name the question nobody answered');
});

test('unknown is not a synonym for tunnel: both refuse a binding and they are different answers', () => {
  const result = classifyInterfaces({
    links: [
      link({ name: 'end0', ifindex: 2 }),
      link({ name: 'tun0', ifindex: 8, linkType: 'none', mac: null, kind: 'tun' }),
    ],
    managementSurfaces: null,
    tunnelInterfaces: [],
    wirelessInterfaces: null,
  });

  const unresolved = result.find((entry) => entry.name === 'end0');
  const tunnel = result.find((entry) => entry.name === 'tun0');

  assert.equal(unresolved?.class, 'unknown');
  assert.equal(tunnel?.class, 'tunnel');
  assert.notEqual(
    unresolved?.why,
    tunnel?.why,
    'the two produce the same outcome and must not produce the same log line',
  );
});

test('with no active profile nothing is invented about what the interfaces are for', () => {
  const classes = classesOf(
    classifyInterfaces({
      links: BENCH_LINKS,
      managementSurfaces: null,
      tunnelInterfaces: [],
      wirelessInterfaces: BENCH_RADIOS,
    }),
  );

  // Still true without a profile, because the kernel said so.
  assert.equal(classes['lo'], 'loopback');
  assert.equal(classes['tun0'], 'tunnel');
  assert.equal(classes['wfvpnhq'], 'tunnel');
  assert.equal(classes['end0'], 'wired');
  // These two are only an access point and an uplink *because a profile says so*. With no profile there
  // is no such claim to read, and a radio serving nothing identified is not something to guess about.
  assert.equal(classes['wlx90de8047b4b4'], 'unknown');
  assert.equal(classes['wfwan0'], 'unknown');
});
