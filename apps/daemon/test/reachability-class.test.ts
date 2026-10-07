/**
 * The gate that nothing could ever pass, and the two sides of the fix.
 *
 * Measured on the bench board, 2026-09-21. A corporate OpenVPN tunnel reconnected at 12:41 and the
 * peer handed out a different resolver *and* a different transfer subnet — `10.164.0.0/20` became
 * `10.165.0.0/20`. Reconvergence from a captured value applies with the `hot` and `service` classes
 * only, on purpose, so that a value a peer supplied can never touch the network. But the peer's new
 * subnet lands in the exclusion list under `/inbounds` and in an `ip_cidr` rule, so the class was
 * promoted to `network`, the write was refused, and the core was restarted from a file last written
 * ninety minutes earlier — six times, each recording success.
 *
 * The promotion fired on exactly the event the mechanism exists for: an OpenVPN reconnection that
 * changes the pushed resolver almost always changes the pushed subnet too.
 *
 * ## What each test here is for
 *
 * The first says **which case now passes a gate that used to stop it**. The rest say **which cases
 * still do not**, and they are the more important half: a guard that lets everything through is the
 * failure this repository has found twice in a day.
 *
 * Every one of them was proved by mutation — the thing it exists to catch was broken and exactly
 * that test failed. The mutations are named in each test.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { DEVICE_TUN_ADDRESS, emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { classifyContentChange, diff, type ReachabilityNetworks } from '../src/core/differ.ts';
import { PATHS } from '../src/core/desired-state.ts';
import { plan } from '../src/core/planner.ts';
import { cleanFacts, oneBuiltInRadio } from './helpers/synthetic-inventory.ts';

/**
 * The shape of the generated core configuration, reduced to the parts the classification reads.
 *
 * Hand-built rather than generated, so that a test about classification does not fail for a reason
 * belonging to the generator. The coverage test at the bottom is the one that ties this shape to
 * what the generator really emits.
 */
function coreConfig(input: {
  exclusions: string[];
  directRule: string[];
  autoRoute?: boolean;
  resolver?: string;
}): string {
  return JSON.stringify({
    dns: { servers: [{ type: 'udp', tag: 'dns-hq', server: input.resolver ?? '10.184.40.5' }] },
    inbounds: [
      {
        type: 'tun',
        address: [DEVICE_TUN_ADDRESS],
        auto_route: input.autoRoute ?? true,
        strict_route: true,
        route_exclude_address: input.exclusions,
      },
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: {
      auto_detect_interface: true,
      rules: [{ ip_cidr: input.directRule, outbound: 'direct' }],
    },
  });
}

/** The lists the planner hands the differ for the bench's shape. */
const BENCH: ReachabilityNetworks = {
  // The hq tunnel's own transfer subnet, as the peer assigned it at 12:41.
  followed: ['10.165.0.0/20'],
  // The served LAN, the transfer network we choose, and the network the board is reached through.
  defended: ['192.168.8.0/24', '172.19.0.0/30', '192.0.2.0/24'],
  // What the running fence recorded as followed when it was written: the subnet the peer had handed
  // out before 12:41. Since 2026-09-23 a network may leave the fence without a window only if the
  // fence itself recorded it as followed — see `test/fence-memory.test.ts` for why a live reading
  // cannot grant that.
  previouslyFollowed: ['10.164.0.0/20'],
};

const BEFORE = coreConfig({
  exclusions: ['192.168.8.0/24', '172.19.0.0/30', '192.0.2.0/24', '10.164.0.0/20'],
  directRule: ['172.19.0.0/30', '192.0.2.0/24', '10.164.0.0/20'],
});

/* ── the case that now passes ────────────────────────────────────────────────────────────── */

test('a subnet the peer moved is a network we follow, and no longer vetoes the write', () => {
  // The exact difference the board produced, including the index shift the new value causes: the
  // exclusion list is built from a Set, so one network changing moves every one after it.
  const after = coreConfig({
    exclusions: ['192.168.8.0/24', '172.19.0.0/30', '192.0.2.0/24', '10.165.0.0/20'],
    directRule: ['172.19.0.0/30', '192.0.2.0/24', '10.165.0.0/20'],
    resolver: '10.184.100.5',
  });

  // Mutation: remove the `&& !onlyFollowedNetworksMoved(...)` clause in `classifyContentChange` and
  // only this test fails, with `network` — which is the board's behaviour of 2026-09-21.
  assert.equal(classifyContentChange(PATHS.coreConfig, BEFORE, after, BENCH), 'service');

  // And without the lists — an older stored plan, or a caller that cannot supply them — the
  // conservative answer stands rather than the softened one.
  assert.equal(classifyContentChange(PATHS.coreConfig, BEFORE, after), 'network');
  // Nor without the fence's record: the live lists alone cannot say the departing subnet was followed.
  const { previouslyFollowed: _record, ...live } = BENCH;
  assert.equal(classifyContentChange(PATHS.coreConfig, BEFORE, after, live), 'network');
});

/* ── the cases that still do not ─────────────────────────────────────────────────────────── */

test('the served LAN changing is still a network change', () => {
  // Mutation: make `onlyFollowedNetworksMoved` return true unconditionally, and this fails while
  // the test above still passes — which is how the pair proves something rather than agreeing.
  const after = coreConfig({
    exclusions: ['192.168.9.0/24', '172.19.0.0/30', '192.0.2.0/24', '10.164.0.0/20'],
    directRule: ['172.19.0.0/30', '192.0.2.0/24', '10.164.0.0/20'],
  });
  assert.equal(classifyContentChange(PATHS.coreConfig, BEFORE, after, BENCH), 'network');
});

test('the network the board is reached through changing is still a network change', () => {
  const after = coreConfig({
    exclusions: ['192.168.8.0/24', '172.19.0.0/30', '198.51.100.0/24', '10.164.0.0/20'],
    directRule: ['172.19.0.0/30', '198.51.100.0/24', '10.164.0.0/20'],
  });
  // `192.0.2.0/24` is defended and it departed. Losing that exclusion is what made this board
  // disappear from the network it was plugged into, twice.
  assert.equal(classifyContentChange(PATHS.coreConfig, BEFORE, after, BENCH), 'network');
});

test('an address arriving that we do not follow is still a network change', () => {
  const after = coreConfig({
    exclusions: ['192.168.8.0/24', '172.19.0.0/30', '192.0.2.0/24', '10.164.0.0/20', '10.99.0.0/16'],
    directRule: ['172.19.0.0/30', '192.0.2.0/24', '10.164.0.0/20'],
  });
  // Not on either list. A value being **written down** has to be one we positively follow; "not
  // known to be defended" is not a reason to wave an unrecognised address into the exclusion list.
  assert.equal(classifyContentChange(PATHS.coreConfig, BEFORE, after, BENCH), 'network');
});

test('a structural change to the inbound is still a network change, whatever the addresses say', () => {
  // The addresses move exactly as in the passing case above, and `auto_route` is switched off as
  // well. Softening on the addresses alone would let the one field that decides what the tunnel
  // captures change inside a `service` window.
  const after = coreConfig({
    exclusions: ['192.168.8.0/24', '172.19.0.0/30', '192.0.2.0/24', '10.165.0.0/20'],
    directRule: ['172.19.0.0/30', '192.0.2.0/24', '10.165.0.0/20'],
    autoRoute: false,
  });
  assert.equal(classifyContentChange(PATHS.coreConfig, BEFORE, after, BENCH), 'network');
});

test('a change with no addresses in it at all is classified as it always was', () => {
  // Nothing about reachability differs, so the file softens to `service` by the existing rule. This
  // is here because the new clause must not be able to change an answer that was already right.
  const after = coreConfig({
    exclusions: ['192.168.8.0/24', '172.19.0.0/30', '192.0.2.0/24', '10.164.0.0/20'],
    directRule: ['172.19.0.0/30', '192.0.2.0/24', '10.164.0.0/20'],
    resolver: '10.184.100.5',
  });
  assert.equal(classifyContentChange(PATHS.coreConfig, BEFORE, after, BENCH), 'service');
  assert.equal(classifyContentChange(PATHS.coreConfig, BEFORE, after), 'service');
});

/* ── the two lists must stay total ───────────────────────────────────────────────────────── */

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

test('every address the generator excludes is either followed or defended, and never both', () => {
  // The one way this could fail unsafely is a fourth source of exclusions that reaches neither list:
  // it would be treated as unrecognised and escalate — or worse, if it merely departed, be softened.
  // Asserted against what the generator really emits rather than against the hand-built shape above.
  const facts = {
    ...cleanFacts(),
    uplinkNetworks: [
      { interface: 'end0', cidr: '192.0.2.0/24' },
      // The tunnel's own interface, exactly as the kernel reports it after the peer assigned it.
      { interface: 'wfvpn0', cidr: '10.165.5.67/20' },
    ],
  };

  const result = plan({
    profile: benchProfile(),
    inventory: oneBuiltInRadio(),
    facts,
    emissions: new Map([
      [
        'hq',
        {
          target: 'outbounds' as const,
          object: { type: 'direct', bind_interface: 'wfvpn0' },
          interfaces: ['wfvpn0'],
        },
      ],
    ]),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
  });

  const { followed, defended } = result.desired.reachabilityNetworks;
  assert.ok(followed.includes('10.165.0.0/20'), 'the peer-assigned subnet is followed, not defended');
  for (const cidr of followed) {
    assert.ok(!defended.includes(cidr), `${cidr} is on both lists, which makes the classification ambiguous`);
  }

  const coreFile = result.desired.files.find((file) => file.path === PATHS.coreConfig);
  assert.ok(coreFile, 'the plan generated a core configuration');
  const document = JSON.parse(coreFile.content) as {
    inbounds: { route_exclude_address?: string[] }[];
    route: { rules: { ip_cidr?: string[] }[] };
  };

  const emitted = new Set<string>([
    ...document.inbounds.flatMap((inbound) => inbound.route_exclude_address ?? []),
    ...document.route.rules.flatMap((rule) => rule.ip_cidr ?? []),
  ]);
  // The LAN and loopback appear in a rule about the device's own network rather than about
  // reachability; they are excluded from this assertion by being on the defended list already.
  const known = new Set([...followed, ...defended, '127.0.0.0/8']);
  for (const cidr of emitted) {
    assert.ok(
      known.has(cidr),
      `${cidr} reaches the exclusion list but is neither followed nor defended — the classification ` +
        'would treat it as unrecognised, and a softening decided by a list that is not total is not a decision',
    );
  }
});

test('the differ takes the lists from the plan rather than from a caller', () => {
  // The plumbing, asserted once: `diff` reads `desired.reachabilityNetworks`. A caller that had to
  // remember to pass them is a caller that will one day not.
  const result = plan({
    profile: benchProfile(),
    inventory: oneBuiltInRadio(),
    facts: { ...cleanFacts(), uplinkNetworks: [{ interface: 'wfvpn0', cidr: '10.165.5.67/20' }] },
    emissions: new Map(),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
  });
  assert.deepEqual(result.desired.reachabilityNetworks.followed, []);
  // No tunnel interface was created by this plan, so the network read from `wfvpn0` is not ours to
  // follow and stays defended. An empty `followed` means "this plan made no tunnel interfaces".
  assert.ok(result.desired.reachabilityNetworks.defended.includes('10.165.0.0/20'));

  const classified = diff({
    desired: result.desired,
    reality: { files: [], units: [], interfaces: [], managementInterfaces: [], sysctl: {} },
  });
  assert.ok(classified.fileChanges.length > 0);
});
