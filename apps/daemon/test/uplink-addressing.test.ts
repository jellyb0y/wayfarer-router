/**
 * "Get the address automatically", on both kinds of uplink.
 *
 * The flag was not ignored, which would merely have disappointed. It was **contradicted**: on a
 * wireless uplink the generator wrote automatic addressing whatever the flag said, and the failover
 * metric lived inside the block the flag would have suppressed — so turning it off gave no static
 * address *and* silently dropped that uplink's failover priority. Nothing asked for the second thing
 * and nothing reported it.
 *
 * Underneath it, a third: `profile.ts` said an address and a gateway were required when the flag is
 * off and that the invariant checks enforced it. No such check existed. An ethernet uplink with the
 * flag off and no address generated an interface with `DHCP=no`, no address and no route.
 *
 * Every assertion below is made **after an anchor on the same fixture**, because a fixture that
 * silently fails to be what the test thinks it is reports exactly what a working guard reports. The
 * baseline is asserted, then mutated, then asserted again.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { emptyProfile, ProfileDocument } from '@wayfarer/schemas';
import { checkInvariants } from '../src/core/invariants.ts';
import { generateNetworkd } from '../src/core/generate/networkd.ts';

const WIFI_PRIORITY = 20;
const ETHERNET_PRIORITY = 10;
/** 100 + priority, the rule the generator states. Written out so a change to it has to be deliberate. */
const WIFI_METRIC = 100 + WIFI_PRIORITY;

function wifiUplink(config: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'uplink-wifi',
    kind: 'wifi-sta',
    priority: WIFI_PRIORITY,
    bind: { by: 'phy-builtin' },
    config: { ssid: 'Bench', ...config },
  };
}

function ethernetUplink(config: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'uplink-wired',
    kind: 'ethernet',
    priority: ETHERNET_PRIORITY,
    bind: { by: 'mac', value: 'aa:bb:cc:dd:ee:ff' },
    config: { dhcp: true, ...config },
  };
}

function profileWith(...uplinks: Record<string, unknown>[]): Record<string, unknown> {
  const base = emptyProfile({ name: 'Bench' }) as unknown as Record<string, unknown>;
  return { ...base, uplinks };
}

/** The whole invariant pass, on a device where nothing else is happening. */
function findingsFor(document: Record<string, unknown>) {
  return checkInvariants({
    profile: document as never,
    bindings: new Map(),
    inventory: { interfaces: [], radios: [], binaries: [] } as never,
    facts: {
      foreignCores: [],
      interfaceClaims: [],
      managementInterfaces: [],
      binaries: [],
      uplinkNetworks: [],
    } as never,
  });
}

const addressingFindings = (document: Record<string, unknown>) =>
  findingsFor(document).filter((entry) => entry.code.startsWith('uplink_static_without_'));

/** The `.network` file for one uplink, as the reconciler would receive it. */
function uplinkFile(document: Record<string, unknown>, id: string, interfaceName: string): string {
  const files = generateNetworkd({
    profile: document as never,
    lanInterface: null,
    uplinkInterfaces: new Map([[id, interfaceName]]),
  });
  const file = files.find((entry) => entry.path.endsWith(`-${id}.network`));
  assert.ok(file, `expected a .network file for "${id}"; got ${files.map((entry) => entry.path).join(', ')}`);
  return file.content;
}

/* ── the missing check ───────────────────────────────────────────────────────────────────── */

test('the flag off with an address and a gateway is accepted, on both kinds of uplink', () => {
  /*
   * The anchor for everything below. If this fixture were refused, every refusal asserted later
   * would pass for the wrong reason — the mutation would not be what produced it.
   */
  for (const uplink of [
    wifiUplink({ dhcp: false, address: '192.168.1.50/24', gateway: '192.168.1.1' }),
    ethernetUplink({ dhcp: false, address: '192.168.1.51/24', gateway: '192.168.1.1' }),
  ]) {
    const document = profileWith(uplink);
    assert.ok(
      Value.Check(ProfileDocument, document),
      `a statically addressed ${(uplink as { kind: string }).kind} uplink must be a valid profile; ` +
        'the wireless one was not until the three fields were added to it',
    );
    assert.deepEqual(
      addressingFindings(document).map((entry) => entry.code),
      [],
      'a fully stated static uplink is not a finding',
    );
  }
});

test('the flag off with no address is refused, and the refusal says the link would reach nothing', () => {
  for (const kind of ['wifi-sta', 'ethernet'] as const) {
    const make = kind === 'wifi-sta' ? wifiUplink : ethernetUplink;

    // Anchor: with the address, nothing is reported. The mutation below is then the only difference.
    const complete = profileWith(make({ dhcp: false, address: '192.168.1.50/24', gateway: '192.168.1.1' }));
    assert.deepEqual(addressingFindings(complete).map((entry) => entry.code), [], `${kind}: anchor`);

    const without = profileWith(make({ dhcp: false, gateway: '192.168.1.1' }));
    const found = addressingFindings(without).find((entry) => entry.code === 'uplink_static_without_address');
    assert.ok(found, `${kind}: an uplink configured by hand with no address must be refused`);
    assert.equal(found.severity, 'error');
    assert.equal(found.pointer, '/uplinks/0/config/address');
    // The consequence, not the field name: an operator who is told "address is required" learns
    // nothing they could not see, and an operator told the link reaches nothing goes and fixes it.
    assert.match(`${found.message} ${found.hint}`, /reach nothing/);
  }
});

test('the flag off with an address but no gateway is refused too, because half-working is the worse half', () => {
  const complete = profileWith(wifiUplink({ dhcp: false, address: '192.168.1.50/24', gateway: '192.168.1.1' }));
  assert.deepEqual(addressingFindings(complete).map((entry) => entry.code), [], 'anchor');

  const without = profileWith(wifiUplink({ dhcp: false, address: '192.168.1.50/24' }));
  const found = addressingFindings(without).find((entry) => entry.code === 'uplink_static_without_gateway');
  assert.ok(found, 'an uplink with an address and no gateway must be refused');
  assert.equal(found.severity, 'error');
  assert.equal(found.pointer, '/uplinks/0/config/gateway');
  assert.match(`${found.message} ${found.hint}`, /nothing past it|own network/);
});

test('an empty string is as absent as absent, because the interface treats it the same way', () => {
  const document = profileWith(wifiUplink({ dhcp: false, address: '', gateway: '' }));
  assert.deepEqual(
    addressingFindings(document).map((entry) => entry.code).sort(),
    ['uplink_static_without_address', 'uplink_static_without_gateway'],
    'a field cleared to empty text must not pass as a stated address',
  );
});

test('an uplink that is switched off is not refused for how it is configured', () => {
  const document = profileWith({ ...wifiUplink({ dhcp: false }), enabled: false });
  assert.deepEqual(
    addressingFindings(document).map((entry) => entry.code),
    [],
    'refusing activation over something that is switched off makes the switch useless',
  );
});

/* ── what it reports when given nothing ──────────────────────────────────────────────────── */

test('asked about nothing, the check reports nothing — and for the right reason', () => {
  // No uplinks at all. A device with no uplink is a valid, expected state.
  assert.deepEqual(addressingFindings(profileWith()).map((entry) => entry.code), []);

  /*
   * An uplink with no addressing stated at all. Silence here is not an oversight: absent means the
   * schema's `default: true`, which is automatic addressing, which needs no address. The two kinds
   * spell that default differently and must still agree, so both are asked.
   */
  assert.deepEqual(addressingFindings(profileWith(wifiUplink())).map((entry) => entry.code), []);
  assert.deepEqual(
    addressingFindings(profileWith({ ...ethernetUplink(), config: {} })).map((entry) => entry.code),
    [],
  );
});

/* ── the metric, which is the consequence nobody would look for ──────────────────────────── */

test('a wireless uplink with the flag off gets static addressing and keeps its failover metric', () => {
  /*
   * The anchor, and it is the load-bearing one: with automatic addressing the metric is present, in
   * the DHCP block. A test that only asserted the static output would pass while the metric stayed
   * lost — which is exactly how this survived.
   */
  const automatic = uplinkFile(profileWith(wifiUplink({ dhcp: true })), 'uplink-wifi', 'wlan0');
  assert.match(automatic, /^DHCP=ipv4$/m, 'anchor: the flag on means automatic addressing');
  assert.match(automatic, new RegExp(`^RouteMetric=${WIFI_METRIC}$`, 'm'), 'anchor: the priority is carried');

  const stated = uplinkFile(
    profileWith(wifiUplink({ dhcp: false, address: '192.168.1.50/24', gateway: '192.168.1.1' })),
    'uplink-wifi',
    'wlan0',
  );
  assert.match(stated, /^DHCP=no$/m, 'the flag off must mean the address is not taken from the network');
  assert.match(stated, /^Address=192\.168\.1\.50\/24$/m, 'the stated address must reach the interface');
  assert.match(stated, /^Gateway=192\.168\.1\.1$/m);
  assert.ok(!/^DHCP=ipv4$/m.test(stated), 'the flag must not be contradicted');

  // The point of the whole test. Failover priority is not addressing, and must not move with it.
  assert.match(stated, /^\[Route\]$/m, 'the route section carries the metric when there is no DHCP block');
  assert.match(
    stated,
    new RegExp(`^Metric=${WIFI_METRIC}$`, 'm'),
    'a static address must not cost this uplink its failover priority',
  );
});

test('the metric survives a static uplink with no gateway, so failover does not follow a second field', () => {
  /*
   * The gateway is missing here, which the invariant refuses — but the generator must not be the
   * place that decides. A `[Route]` section emitted only alongside a gateway is a metric that
   * disappears with a field nobody connected to failover.
   */
  const stated = uplinkFile(
    profileWith(wifiUplink({ dhcp: false, address: '192.168.1.50/24' })),
    'uplink-wifi',
    'wlan0',
  );
  assert.match(stated, /^Address=192\.168\.1\.50\/24$/m, 'anchor: the address is stated');
  assert.match(stated, new RegExp(`^Metric=${WIFI_METRIC}$`, 'm'));
});

test('the wired uplink reads the flag the same way, and the two produce the same shape', () => {
  const wired = uplinkFile(
    profileWith(ethernetUplink({ dhcp: false, address: '192.168.1.51/24', gateway: '192.168.1.1' })),
    'uplink-wired',
    'eth0',
  );
  assert.match(wired, /^DHCP=no$/m);
  assert.match(wired, new RegExp(`^Metric=${100 + ETHERNET_PRIORITY}$`, 'm'));

  /*
   * The two differ only in the metric and in the addresses given. Asserted as a comparison rather
   * than as two lists of lines, because the defect being pinned was precisely a difference between
   * the two branches that nobody had a reason to look at.
   */
  const wireless = uplinkFile(
    profileWith(wifiUplink({ dhcp: false, address: '192.168.1.51/24', gateway: '192.168.1.1' })),
    'uplink-wifi',
    'eth0',
  );
  const normalise = (text: string) =>
    text.replace(/^Metric=\d+$/m, 'Metric=N').replace(/^# .*$/gm, '').replace(/\n+/g, '\n');
  assert.equal(normalise(wireless), normalise(wired), 'one network layer, one addressing block');
});
