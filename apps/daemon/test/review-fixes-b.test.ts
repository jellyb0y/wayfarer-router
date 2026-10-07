/**
 * The four properties the review found missing, each asserted where it broke.
 *
 * Every one of these describes a fault that every existing test was happy with, which is the reason
 * they are worth having and the reason each carries the shape of the mistake rather than only the
 * expected value.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { emptyProfile, generateRoutingRules, isStoredSecret, type ProfileDocument } from '@wayfarer/schemas';
import { emitTunnels, validateTunnelConfigs } from '../src/core/emit.ts';
import { createSecretPlan } from '../src/state/secret-plan.ts';
import { createValidatorCache } from '@wayfarer/protocols';
import { bandCapabilities } from '../src/core/radio-capabilities.ts';
import { plan as computePlan } from '../src/core/planner.ts';
import { PATHS as WAYFARER_PATHS } from '../src/core/desired-state.ts';

const UNIT_DIR = WAYFARER_PATHS.unitDir;
import { diff, type Reality } from '../src/core/differ.ts';
import { reconcile } from '../src/core/reconciler.ts';
import { INVENTORIES, cleanFacts, dualBandRadio } from './helpers/synthetic-inventory.ts';
import type { Platform } from '../src/platform/index.ts';

/**
 * A device that knows nothing about its core and has every binary.
 *
 * Both halves matter. Nothing known about the core means every catalogue entry offers itself, which is
 * the state a device is in before the schema fetch finishes — and the state in which a configuration
 * must still be writable. Every binary present keeps these tests about the properties they are named
 * for rather than about what is installed.
 */
const DEVICE = {
  core: { known: false, outboundTypes: new Set<string>() },
  installed: new Set(['sing-box', 'hostapd', 'dnsmasq', 'nft', 'openvpn', 'ck-client', 'xray']),
};

function profileWithTunnel(config: Record<string, unknown>, protocol = 'vless'): ProfileDocument {
  const base = emptyProfile({ name: 'T', now: () => '2026-09-20T00:00:00.000Z' });
  return {
    ...base,
    tunnels: [
      {
        id: 'alt-a',
        name: 'Warsaw',
        role: 'alternative',
        onUnavailable: 'block' as const,
        enabled: true,
        protocol,
        config,
      },
    ] as ProfileDocument['tunnels'],
  };
}

const VLESS = { server: '198.51.100.7', port: 443, id: 'an-account', network: 'tcp', security: 'tls' };

/* ── 1. secrets inside a tunnel configuration ────────────────────────────────────────────── */

/*
 * These three tests are **the same defect twice, from opposite sides**, and keeping both readings is
 * the point of the section.
 *
 * The original fault: matchers came from the static profile schema, `Tunnel.config` was an opaque
 * record, and so nothing ever covered `/tunnels/-/config/*`. A VLESS account id was stored bare,
 * returned by `GET` and exported in clear. The fix at the time was to consult the provider registry,
 * and the rule written down with it was that the static matchers must never be used on their own.
 *
 * Schema version 7 removes the premise: a tunnel's configuration is a typed catalogue entry, so every
 * credential is declared here with `Secret()`. The coverage is static again, and the rule that
 * insisted otherwise had turned into a device that could not save a profile because a binary was
 * missing. What is asserted below is therefore the *behaviour* — this pointer is covered, that kind is
 * right — and never which half of the system produced it.
 */

test('the account credential of a catalogue tunnel is covered, with the kind its schema declares', () => {
  const matchers = createSecretPlan().forDocument(profileWithTunnel(VLESS));

  assert.ok(matchers.has('/tunnels/-/config/id'), [...matchers.keys()].join(', '));
  // `uuid`, not the generic `secret`: the kind comes from the declaration, and the import checklist
  // uses it to tell a person what to go and find.
  assert.equal(matchers.get('/tunnels/-/config/id'), 'uuid');
  // And the fields this project has always declared are still covered.
  assert.ok(matchers.has('/accessPoint/passphrase'));
});

test('the credential inside an obfuscation entry point is covered, which is the one that leaked', () => {
  const matchers = createSecretPlan().forDocument(profileWithTunnel({}, 'cloak-openvpn'));

  /*
   * Measured on a redacted export of the bench profile, 2026-09-21: five of these left in clear,
   * because the value lived inside an unmarked `configFile` string and nothing walked the entry points
   * at all. The list is an array, so the matcher names any element — a matcher naming index 2 would be
   * wrong for every other entry point.
   */
  assert.ok(matchers.has('/tunnels/-/config/entryPoints/-/uid'), [...matchers.keys()].join(', '));
  assert.equal(matchers.get('/tunnels/-/config/entryPoints/-/uid'), 'token');
});

test('the encryption parameter is covered as key material, because that is what it is', () => {
  const matchers = createSecretPlan().forDocument(profileWithTunnel(VLESS));
  // 1.6 KiB of it on the bench, not a mode name. A field marked `secret` would still be protected;
  // marking it `private-key` is what makes the checklist say the right thing.
  assert.equal(matchers.get('/tunnels/-/config/encryption'), 'private-key');
});

/* ── 3. tunnel configurations are validated before they are embedded ─────────────────────── */

test('a wrong field type in a tunnel configuration is a finding with a pointer', () => {
  const issues = validateTunnelConfigs({
    profile: profileWithTunnel({ ...VLESS, port: 'four-four-three' }),
    validators: createValidatorCache(),
  });
  const issue = issues.find((entry) => entry.pointer === '/tunnels/0/config/port');
  assert.ok(issue, JSON.stringify(issues));
});

test('an unknown field is caught here rather than by a unit that will not start', () => {
  const issues = validateTunnelConfigs({
    profile: profileWithTunnel({ ...VLESS, not_a_real_field: 1 }),
    validators: createValidatorCache(),
  });
  assert.ok(issues.some((entry) => entry.pointer.startsWith('/tunnels/0/config')), JSON.stringify(issues));
});

test('a valid configuration produces no issues, including one with secrets still wrapped', () => {
  const issues = validateTunnelConfigs({
    profile: profileWithTunnel({ ...VLESS, id: { $secret: '00000000-0000-4000-8000-000000000000' } }),
    validators: createValidatorCache(),
  });
  // The stored wrapper is removed before validating; a validator shown `{ $secret: … }` would reject
  // every stored profile.
  assert.deepEqual(issues, []);
});

test('the check needs no core at all, which is the whole reason it moved off the binary schema', () => {
  // A device whose core has not been unpacked could not validate — and, worse, could not *store* — a
  // tunnel configuration. The schemas are this repository's now, so there is nothing to wait for.
  const issues = validateTunnelConfigs({
    profile: profileWithTunnel({ ...VLESS, security: 'not-a-security' }),
    validators: createValidatorCache(),
  });
  assert.ok(issues.some((entry) => entry.pointer === '/tunnels/0/config/security'), JSON.stringify(issues));
});

/* ── 3. the core check consumes a result, and cannot report a success it did not get ─────── */

function platformFor(coreCheck: { ok: boolean; message: string } | null): { platform: Platform; calls: string[] } {
  const calls: string[] = [];
  const units = new Map<string, { isActive: boolean; isEnabled: boolean }>();
  const platform = {
    systemd: {
      state: async (unit: string) => ({
        unit,
        isActive: units.get(unit)?.isActive ?? false,
        isEnabled: units.get(unit)?.isEnabled ?? false,
        known: units.has(unit),
      }),
      enable: async (unit: string) => {
        units.set(unit, { ...(units.get(unit) ?? { isActive: false, isEnabled: false }), isEnabled: true });
      },
      disable: async () => undefined,
      start: async (unit: string) => {
        units.set(unit, { ...(units.get(unit) ?? { isActive: false, isEnabled: false }), isActive: true });
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      restart: async (unit: string) => {
        units.set(unit, { ...(units.get(unit) ?? { isActive: false, isEnabled: false }), isActive: true });
        return { result: 'done', unit, jobPath: '', waitedMs: 1 };
      },
      stop: async (unit: string) => ({ result: 'done', unit, jobPath: '', waitedMs: 1 }),
      daemonReload: async () => undefined,
    },
    nft: { check: async () => ({ ok: true, message: '' }) },
    files: {
      writeAtomic: async (path: string) => {
        calls.push(`write:${path}`);
        return { path, bytes: 1, changed: true };
      },
    },
    binaries: {
      detect: async () => null,
      coreSchema: async () => null,
      checkCoreConfig: async (configPath: string) => {
        calls.push(`core-check:${configPath}`);
        return coreCheck;
      },
    },
  } as unknown as Platform;
  return { platform, calls };
}

function serviceStateWithCore(): ReturnType<typeof import('../src/core/desired-state.ts').emptyDesiredState> {
  const desired = {
    files: [
      {
        path: '/etc/wayfarer/core/config.json',
        content: '{}\n',
        mode: 0o600,
        purpose: 'the proxy core configuration',
      },
    ],
    units: [
      { name: 'wf-core.service', enabled: true, active: true, purpose: 'the core', content: '[Unit]\n' },
      { name: `${UNIT_DIR}/wf-core.service`, enabled: false, active: false, purpose: 'x' },
    ],
    networkFiles: [],
    checks: [
      { kind: 'nft-check' as const, ruleset: 'table inet wayfarer {}\n' },
      { kind: 'core-check' as const, configPath: '/etc/wayfarer/core/config.json' },
      { kind: 'unit-not-foreign' as const, units: ['wf-core.service'] },
    ],
    interfaces: [],
    sysctl: [],
    notes: [],
  };
  desired.units = desired.units.filter((unit) => unit.name.startsWith('wf-'));
  desired.files.push({
    // From `PATHS`, not spelled out: this fixture said `/etc/systemd/system` and kept saying it after
    // generated units moved, so it was describing a device this project no longer builds.
    path: `${UNIT_DIR}/wf-core.service`,
    content: '[Unit]\n',
    mode: 0o644,
    purpose: 'the unit definition for wf-core.service',
  });
  return desired as never;
}

const bareReality: Reality = {
  files: [],
  units: [],
  interfaces: [{ name: 'end0', mac: '02:81:5a:11:22:33' }],
  managementInterfaces: ['end0'],
  sysctl: {},
};

test('a core configuration the binary rejects stops the apply, with the core’s own message', async () => {
  // The defect: this step called the firewall checker on an empty ruleset, discarded the result, and
  // reported ok unconditionally — so a malformed configuration reached the disk with "validate: core
  // configuration … ok" in the log, and the truth arrived later as a generic unit failure.
  const { platform, calls } = platformFor({
    ok: false,
    message: 'FATAL outbound DNS rule item is deprecated in sing-box 1.12.0',
  });
  const desired = serviceStateWithCore();
  const classified = diff({ desired, reality: bareReality });

  const result = await reconcile({ platform, desired, plan: classified, timeSyncUnit: 'systemd-timesyncd.service' });

  assert.equal(result.applied, false);
  assert.equal(result.error?.code, 'core_config_invalid');
  // Verbatim: the core names the field, and paraphrasing loses the part that identifies the fault.
  assert.ok(/deprecated in sing-box 1\.12\.0/.test(result.error!.message));

  // It actually ran the check, against the file that was written.
  assert.ok(calls.includes('core-check:/etc/wayfarer/core/config.json'));

  // And it stopped before starting anything.
  assert.equal(
    result.steps.some((step) => step.step.startsWith('start ') || step.step.startsWith('restart ')),
    false,
  );

  // The step is recorded as failed, not as a success next to a failure.
  const step = result.steps.find((entry) => entry.step === 'validate: core configuration');
  assert.equal(step?.ok, false);
});

test('a missing core is reported as a missing core, not as an invalid configuration', async () => {
  // Two different answers that must not be confused: reporting "not installed" as a failed validation
  // sends somebody to look at a configuration that is fine.
  const { platform } = platformFor(null);
  const desired = serviceStateWithCore();
  const classified = diff({ desired, reality: bareReality });

  const result = await reconcile({ platform, desired, plan: classified, timeSyncUnit: 'systemd-timesyncd.service' });
  assert.equal(result.applied, false);
  assert.ok(/no proxy core is installed/.test(result.error!.message));
});

test('every recorded step got its outcome from a tool', async () => {
  const { platform } = platformFor({ ok: true, message: '' });
  const desired = serviceStateWithCore();
  const classified = diff({ desired, reality: bareReality });

  const result = await reconcile({ platform, desired, plan: classified, timeSyncUnit: 'systemd-timesyncd.service' });
  assert.equal(result.applied, true, JSON.stringify(result.error));

  // The validation step reports what the core said rather than a sentence about deferring to a check
  // that would happen later.
  const step = result.steps.find((entry) => entry.step === 'validate: core configuration');
  assert.equal(step?.ok, true);
  assert.equal(step?.detail, 'accepted');
});

/* ── 5. the capability lookup follows the configured band ────────────────────────────────── */

test('a dual-band radio reports the capabilities of the band in use', () => {
  const radio = dualBandRadio().radios[0]!;

  const twoFour = bandCapabilities(radio, '2.4GHz');
  const five = bandCapabilities(radio, '5GHz');

  assert.ok(twoFour, 'the 2.4 GHz band should resolve');
  assert.ok(five, 'the 5 GHz band should resolve');

  // The distinction the old lookup lost: taking the first band with frequencies returned the 2.4 GHz
  // report for a 5 GHz access point, concluding it had no VHT and therefore could not do 80 MHz.
  assert.equal(twoFour.vhtCapabilitiesHex, null);
  assert.equal(five.vhtCapabilitiesHex, '0x01b07031');
  assert.notEqual(twoFour.index, five.index);
});

test('a band the radio does not offer resolves to nothing rather than to another band', () => {
  const radio = dualBandRadio().radios[0]!;
  assert.equal(bandCapabilities(radio, '6GHz'), null);
});

test('an 80 MHz access point on the 5 GHz band of a dual-band radio is not refused', () => {
  // End to end through the planner: with the old lookup this produced a `width_unsupported` error,
  // because the 2.4 GHz report has no VHT.
  const inventory = dualBandRadio();
  const base = emptyProfile({ name: 'Dual', now: () => '2026-09-20T00:00:00.000Z' });
  const profile: ProfileDocument = {
    ...base,
    accessPoint: {
      bind: { by: 'phy-usb', value: '0b05:1234' },
      radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
      ssid: 'Dual',
      passphrase: { $secret: 'a-passphrase' } as unknown as string,
      acceptChannelFollowsUplink: false,
    },
  };

  const result = computePlan({
    profile,
    inventory,
    facts: cleanFacts(),
    emissions: new Map(),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
  });

  assert.equal(
    result.findings.some((finding) => finding.code === 'width_unsupported'),
    false,
    JSON.stringify(result.findings.filter((f) => f.severity === 'error')),
  );
});

/* ── 6. the collision check sees every port, including allocated ones ────────────────────── */

test('two obfuscation entry points never share a port, however many there are', () => {
  const base = emptyProfile({ name: 'P', now: () => '2026-09-20T00:00:00.000Z' });
  const entryPoints = ['front-a', 'front-b', 'front-c', 'front-d'].map((id, index) => ({
    id,
    host: `198.51.100.${index + 1}`,
    port: 443,
    uid: 'an-identifier',
    publicKey: 'a-public-key',
    proxyMethod: 'openvpn',
    encryptionMethod: 'aes-gcm',
    serverName: `${id}.example.com`,
    browserSignature: 'chrome',
    transport: 'direct',
  }));

  const emitted = emitTunnels({
    profile: {
      ...base,
      tunnels: [
        {
          id: 'a',
          name: 'A',
          role: 'alternative',
          onUnavailable: 'block' as const,
          enabled: true,
          protocol: 'cloak-openvpn',
          config: { profile: 'client\ndev tun\n', entryPoints },
        },
      ] as ProfileDocument['tunnels'],
    },
    ...DEVICE,
    allocatedPorts: new Set(),
  });

  /*
   * Four entry points at four sites is a normal configuration and the bench has exactly that. The
   * property being asserted is not "the allocator works" but that **a port can no longer be stated**:
   * there is no field for one, so the class of collision that used to be found when the second client
   * failed to bind cannot be expressed.
   */
  assert.equal(emitted.ports.length, 4);
  assert.equal(new Set(emitted.ports.map((claim) => claim.port)).size, 4);
});

test('an allocated port that collides with the core control API is caught, naming both claimants', () => {
  const base = emptyProfile({ name: 'P', now: () => '2026-09-20T00:00:00.000Z' });

  /*
   * The path that still reaches the collision check now that no profile can state a tunnel's port.
   * The control API's address *is* a field an owner fills, and nothing stops him putting it inside the
   * range this daemon allocates from — so the two can claim the same number, and the check is the only
   * thing that notices. Its other arm, two tunnels stating one port, is unreachable by construction
   * since the field it needed no longer exists; this is the arm that is left, and it is real.
   */
  const profile: ProfileDocument = {
    ...base,
    services: { ...base.services, clashApi: { ...base.services.clashApi, bind: '127.0.0.1:10800' } },
    tunnels: [
      {
        id: 'sub',
        name: 'Subscription',
        role: 'alternative',
        onUnavailable: 'block' as const,
        enabled: true,
        protocol: 'vless',
        // An encryption parameter forces the external carrier, which is what allocates a port.
        config: { ...VLESS, encryption: 'mlkem768x25519plus.native.0rtt.KEYMATERIAL' },
      },
    ] as ProfileDocument['tunnels'],
  };

  const emitted = emitTunnels({ profile, ...DEVICE, allocatedPorts: new Set() });
  assert.equal(emitted.ports[0]!.port, 10800, 'the first allocation must be the first port in the range');

  const result = computePlan({
    profile,
    inventory: INVENTORIES['no-radio']!(),
    facts: cleanFacts(),
    emissions: emitted.emissions,
    ports: emitted.ports,
    refusals: emitted.refusals,
    carriers: emitted.carriers,
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
  });

  const collision = result.findings.find((finding) => finding.code === 'port_collision');
  assert.ok(collision, JSON.stringify(result.findings));
  assert.match(collision.message, /10800/);
  assert.match(collision.message, /control API/);
});

/* ── 8. an unbound uplink points at its own entry ────────────────────────────────────────── */

test('an unbound uplink finding points at that uplink, not at the first one', () => {
  const base = emptyProfile({ name: 'U', now: () => '2026-09-20T00:00:00.000Z' });
  const profile: ProfileDocument = {
    ...base,
    uplinks: [
      { id: 'wan-eth', kind: 'ethernet', priority: 10, enabled: true, bind: { by: 'any-ethernet' }, config: { dhcp: true } },
      {
        id: 'wan-usb',
        kind: 'wifi-sta',
        priority: 20,
        enabled: true,
        // Not present on this inventory, so this one is unbound.
        bind: { by: 'phy-usb', value: 'dead:beef' },
        config: { ssid: 'Nope' },
      },
    ],
  };

  const result = computePlan({
    profile,
    inventory: INVENTORIES['one-built-in-radio']!(),
    facts: cleanFacts(),
    emissions: new Map(),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
  });

  const unbound = result.findings.find((finding) => finding.code === 'role_unbound');
  assert.ok(unbound, JSON.stringify(result.findings));
  // Index 1, not 0. Parsing an index out of an id produced NaN and fell back to zero, so every one of
  // these pointed at the first uplink — sending somebody to fix a configuration that was never broken.
  assert.equal(unbound.pointer, '/uplinks/1/bind');
});

/* ── 4. a blocked endpoint is never dropped without a word ───────────────────────────────── */

test('an IPv6 blocked endpoint is explained rather than silently filtered', () => {
  const base = emptyProfile({ name: 'B', now: () => '2026-09-20T00:00:00.000Z' });
  const result = computePlan({
    profile: {
      ...base,
      firewall: {
        ...base.firewall,
        blockedEndpoints: [{ ipCidr: '2001:db8::/32', note: 'address discovery' }],
      },
    },
    inventory: INVENTORIES['no-radio']!(),
    facts: cleanFacts(),
    emissions: new Map(),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
  });

  const finding = result.findings.find((entry) => entry.code === 'blocked_endpoint_ipv6_redundant');
  assert.ok(finding, JSON.stringify(result.findings));
  assert.equal(finding.pointer, '/firewall/blockedEndpoints/0/ipCidr');
  // A warning: the entry is unnecessary rather than wrong, and the operator is entitled to know which.
  assert.equal(finding.severity, 'warning');
  assert.ok(/redundant|unnecessary|no client can reach/i.test(`${finding.message} ${finding.hint}`));
});

test('a blocked endpoint that is not an address at all is an error', () => {
  const base = emptyProfile({ name: 'B', now: () => '2026-09-20T00:00:00.000Z' });
  const result = computePlan({
    profile: {
      ...base,
      firewall: { ...base.firewall, blockedEndpoints: [{ ipCidr: '999.999.999.999' }] },
    },
    inventory: INVENTORIES['no-radio']!(),
    facts: cleanFacts(),
    emissions: new Map(),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
  });

  assert.ok(
    result.findings.some((finding) => finding.code === 'blocked_endpoint_unparseable'),
    JSON.stringify(result.findings),
  );
});

/*
 * `a stored secret is unwrapped for the core exactly as it was stored` was here, and it is **deleted
 * rather than rewritten**, because the thing it asserted no longer exists to be asserted.
 *
 * It checked that a `string[]` secret — a PEM key entered as several lines — reached the generated core
 * object neither joined nor split, because the generic emitter copied a stored value through untouched
 * and changing its shape would have changed what the operator typed. There is no generic emitter now.
 * Each catalogue entry reads a secret through one function that yields text, and every secret the three
 * entries hold is text by nature: an account id, a password, an `.ovpn` file, an account identifier, an
 * encryption parameter. A multi-line value at any of those positions is one value with newlines in it,
 * and joining is the correct reading rather than a loss.
 *
 * Recorded here rather than dropped silently, because "this property used to be checked" is the
 * question somebody will ask of this file, and the answer is that its subject went.
 */

/* ── the exclusion that keeps the device reachable from the network it is plugged into ────── */

test('the network the uplink is on is excluded from the tunnel, in both places it has to be', () => {
  // The defect that locked the bench board out. With `auto_route` on and only the served LAN excluded,
  // replies to inbound connections from the uplink's own network were captured by the tunnel, and the
  // board disappeared from the only network that could reach it. `docs/12` had claimed this exclusion
  // existed for some time; it did not — and the line that was supposed to add it read
  // `[lanCidr, ...(parsed ? [] : [])]`, a conditional whose branches were both empty.
  const inventory = INVENTORIES['one-built-in-radio']!();
  const profile: ProfileDocument = {
    ...emptyProfile({ name: 'Uplink protection', now: () => '2026-09-20T00:00:00.000Z' }),
    network: { cidr: '10.44.0.1/24', dhcp: { enabled: true, from: '10.44.0.100', to: '10.44.0.200', leaseHours: 12 } },
    uplinks: [
      { id: 'wan-eth', kind: 'ethernet', priority: 10, enabled: true, bind: { by: 'any-ethernet' }, config: { dhcp: true } },
    ],
  };

  const result = computePlan({
    profile,
    inventory,
    facts: {
      ...cleanFacts(),
      // A reading of the device, not a profile field — which is exactly why the gap was invisible to every
      // schema, invariant and golden file: nothing in the profile was missing.
      uplinkNetworks: [{ interface: 'end0', cidr: '192.168.1.0/24' }],
    },
    emissions: new Map(),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
  });

  const coreConfig = result.desired.files.find((file) => file.path.endsWith('/core/config.json'));
  assert.ok(coreConfig !== undefined, 'no core configuration was generated');
  const config = JSON.parse(coreConfig.content) as {
    inbounds: { route_exclude_address: string[] }[];
    route: { rules: Record<string, unknown>[] };
  };

  // 1. The tun inbound's own exclusion list.
  const excluded = config.inbounds[0]!.route_exclude_address;
  assert.ok(excluded.includes('192.168.1.0/24'), `the uplink network is not excluded: ${excluded.join(', ')}`);
  // And in **network** form: `10.44.0.1/24` is the device's own address with a prefix, not a network, and
  // relying on a consumer to read it as the containing network is being right by luck.
  assert.ok(excluded.includes('10.44.0.0/24'), `the LAN is not in network form: ${excluded.join(', ')}`);
  assert.equal(excluded.includes('10.44.0.1/24'), false, 'the host form is still being emitted');

  // 2. A routing rule sending it direct, which is the half that governs forwarded traffic.
  const directRules = config.route.rules.filter((rule) => rule['outbound'] === 'direct');
  assert.ok(
    directRules.some((rule) => Array.isArray(rule['ip_cidr']) && (rule['ip_cidr'] as string[]).includes('192.168.1.0/24')),
    `no routing rule sends the uplink network direct: ${JSON.stringify(config.route.rules)}`,
  );
});

test('the uplink exclusion is not part of the movable anchor', () => {
  // Deliberately separate. The anchor covers the network this device *serves* and stays movable, because
  // sending one's own LAN through a tunnel is a legitimate if unusual choice. The network the uplink is
  // *on* is different: losing the return path to it does not route the device differently, it makes the
  // device unmanageable from the only direction anybody can reach it. A switch whose sole effect is to
  // make a device unreachable with no way to undo it is not a choice worth offering.
  const profile: ProfileDocument = {
    ...emptyProfile({ name: 'No anchor at all', now: () => '2026-09-20T00:00:00.000Z' }),
    // The anchor is removed entirely, so anything still emitted is not coming from it.
    routing: { rules: [], ruleSets: [] },
  };

  const rules = generateRoutingRules(profile, {
    uplinkInterfaces: ['end0'],
    uplinkNetworks: ['192.168.1.0/24'],
  });

  const uplinkRule = rules.find(
    (entry) => Array.isArray((entry.rule as { ip_cidr?: string[] }).ip_cidr) &&
      ((entry.rule as { ip_cidr: string[] }).ip_cidr).includes('192.168.1.0/24'),
  );
  assert.ok(uplinkRule !== undefined, 'the exclusion vanished with the anchor, so it was part of it');
  // `fromIndex: null` is what marks a rule as ours rather than the profile's, so the interface shows it as
  // fixed and does not offer to move it.
  assert.equal(uplinkRule.fromIndex, null, 'the exclusion is attributed to a profile rule and so is movable');
});

/* ── a permission decided by a domain the apply itself establishes ───────────────────────── */

/**
 * After a reboot the device could not bring its own access point back up on 5 GHz.
 *
 * Measured on the bench board, 2026-09-21: `iw reg get` reported `country 00: DFS-UNSET` with every
 * 5 GHz band marked `PASSIVE-SCAN`, and the apply for a profile asking `country DE, channel 36` was
 * refused with `channel_no_initiating_radiation`. The access point had been serving clients on that
 * exact channel before the reboot.
 *
 * `00` is the kernel saying no country has been established — a question still open, not an answer of
 * "forbidden". hostapd establishes it from `country_code` when it starts, and hostapd is started by
 * the apply that was refused. So the check decided a question against the only action that could
 * answer it, and the device locked itself out of its own radio. From a client's side that is simply a
 * network that stopped existing.
 */
test('a no-IR channel is not refused while no country has been established', async () => {
  const { restrictedRegulatoryDomain, cleanFacts } = await import('./helpers/synthetic-inventory.ts');
  const { checkInvariants } = await import('../src/core/invariants.ts');

  const inventory = restrictedRegulatoryDomain();
  const radio = inventory.radios[0];
  assert.ok(radio, 'fixture must publish a radio');
  assert.equal(radio.reported.regulatory.country, '00', 'fixture must model an unestablished domain');

  /*
   * Mark channel 36 the way the board does under the world domain. Applied here rather than in the
   * shared fixture so the existing golden cases keep asserting what they were written for — and
   * asserted afterwards, because a test that silently stops modelling the fault is the failure mode
   * this whole file exists to catch.
   */
  const channel36 = radio.derived.channels.find((e) => e.channel === 36 && e.band === '5GHz');
  assert.ok(channel36, 'fixture must offer channel 36');
  Object.assign(channel36, { noInitiatingRadiation: true, flags: ['no-ir', 'passive-scan'] });
  assert.equal(channel36.noInitiatingRadiation, true, 'the fault must actually be modelled');

  const profile = emptyProfile() as ProfileDocument;
  profile.accessPoint = {
    ...(profile.accessPoint ?? ({} as never)),
    ssid: 'Bench',
    passphrase: { $secret: 'bench-only-not-a-secret' },
    bind: { by: 'phy-builtin' },
    radio: { band: '5GHz', channel: 36, width: 20, country: 'DE', hidden: false },
  } as never;

  const findings = checkInvariants({
    profile,
    bindings: new Map([['access-point', { state: 'bound', phy: 'phy0', interfaceName: 'wlan0' } as never]]),
    inventory: inventory as never,
    facts: cleanFacts() as never,
  });

  const blocking = findings.filter(
    (f) => f.severity === 'error' && (f.code === 'channel_no_initiating_radiation' || f.code === 'channel_disabled'),
  );
  assert.deepEqual(blocking, [], 'an unestablished domain must not refuse the apply that would establish it');

  // Reported, not hidden: if the access point does fail to start, this is the line that explains it.
  const noted = findings.find((f) => f.code === 'channel_no_initiating_radiation');
  if (noted !== undefined) {
    assert.equal(noted.severity, 'warning');
    assert.match(noted.message, /no country has been established|world regulatory domain/);
  }
});

/** The same channel, once a country *is* established, is a genuine refusal and must stay one. */
test('a no-IR channel is still refused once a country has been established', async () => {
  const { restrictedRegulatoryDomain, cleanFacts } = await import('./helpers/synthetic-inventory.ts');
  const { checkInvariants } = await import('../src/core/invariants.ts');

  const inventory = restrictedRegulatoryDomain();
  const radio = inventory.radios[0];
  assert.ok(radio, 'fixture must publish a radio');
  radio.reported.regulatory = { source: 'own', country: 'DE', dfsRegion: 'ETSI', rules: [] } as never;

  const profile = emptyProfile() as ProfileDocument;
  profile.accessPoint = {
    ...(profile.accessPoint ?? ({} as never)),
    ssid: 'Bench',
    passphrase: { $secret: 'bench-only-not-a-secret' },
    bind: { by: 'phy-builtin' },
    radio: { band: '5GHz', channel: 52, width: 20, country: 'DE', hidden: false },
  } as never;

  const findings = checkInvariants({
    profile,
    bindings: new Map([['access-point', { state: 'bound', phy: 'phy0', interfaceName: 'wlan0' } as never]]),
    inventory: inventory as never,
    facts: cleanFacts() as never,
  });

  const refused = findings.find((f) => f.code === 'channel_disabled');
  assert.ok(refused, 'channel 52 is disabled in this fixture');
  assert.equal(refused.severity, 'error', 'with a country established the refusal is real');
});

/* ── a request and a result are two different facts ──────────────────────────────────────── */

/**
 * The profile asked for 80 MHz and the radio ran 40, and nothing said so.
 *
 * Measured on the bench board, 2026-09-21: `channel 36 (5180 MHz), width: 40 MHz` on the live interface
 * while the profile stated 80. The apply succeeded and the access point worked, so no error was ever
 * going to appear — which is exactly why the operator was left believing something untrue.
 *
 * The rule is the one already reached for the channel: the profile states a **request**, the device
 * reports what **happened**, and both stay visible. Reconciling them by rewriting the profile would
 * destroy the stated intention and make the next driver that honours 80 MHz silently different.
 */
test('the width the radio chose is reported beside the width that was asked for', async () => {
  const { dualBandRadio: dualBand } = await import('./helpers/synthetic-inventory.ts');
  const { checkInvariants } = await import('../src/core/invariants.ts');
  const { cleanFacts: facts } = await import('./helpers/synthetic-inventory.ts');

  const inventory = dualBand();
  const radio = inventory.radios[0];
  assert.ok(radio, 'fixture must publish a radio');
  // The live interface is running the requested channel at a narrower width than requested.
  radio.reported.interfaces = [
    { name: 'wlanap', type: 'AP', mac: null, ssid: 'Bench', channel: 36, widthMhz: 40, txPowerDbm: null },
  ];

  const profile = emptyProfile() as ProfileDocument;
  profile.accessPoint = {
    ...(profile.accessPoint ?? ({} as never)),
    ssid: 'Bench',
    passphrase: { $secret: 'bench-only-not-a-secret' },
    bind: { by: 'phy-builtin' },
    radio: { band: '5GHz', channel: 36, width: 80, country: 'DE', hidden: false },
  } as never;

  const findings = checkInvariants({
    profile,
    bindings: new Map([['access-point', { state: 'bound', phy: radio.phy, interfaceName: 'wlanap' } as never]]),
    inventory: inventory as never,
    facts: facts() as never,
  });

  const noted = findings.find((f) => f.code === 'width_not_honoured');
  assert.ok(noted, 'a width the radio did not honour must be reported');
  // A warning, not an error: nothing is broken and nothing needs changing.
  assert.equal(noted.severity, 'warning');
  assert.equal(noted.pointer, '/accessPoint/radio/width');
  // Both quantities, and whose decision it was.
  assert.match(noted.message, /asked for 80 MHz/);
  assert.match(noted.message, /running 40 MHz/);
  assert.match(noted.message, /decision, not this device's/);
  assert.deepEqual(
    { requested: noted.detail?.['requested'], effective: noted.detail?.['effective'] },
    { requested: 80, effective: 40 },
  );

  // And the profile is untouched: the request survives being unmet.
  assert.equal((profile.accessPoint as { radio: { width: number } }).radio.width, 80);
});

test('a live reading of some other channel says nothing about the requested width', async () => {
  // The live interface describes whatever is running now, which during an edit is the PREVIOUS profile.
  // Attributing that difference to the radio would be a second wrong claim about the same fact.
  const { dualBandRadio: dualBand, cleanFacts: facts } = await import('./helpers/synthetic-inventory.ts');
  const { checkInvariants } = await import('../src/core/invariants.ts');

  const inventory = dualBand();
  const radio = inventory.radios[0];
  assert.ok(radio);
  radio.reported.interfaces = [
    { name: 'wlanap', type: 'AP', mac: null, ssid: 'Bench', channel: 40, widthMhz: 40, txPowerDbm: null },
  ];

  const profile = emptyProfile() as ProfileDocument;
  profile.accessPoint = {
    ...(profile.accessPoint ?? ({} as never)),
    ssid: 'Bench',
    passphrase: { $secret: 'bench-only-not-a-secret' },
    bind: { by: 'phy-builtin' },
    radio: { band: '5GHz', channel: 36, width: 80, country: 'DE', hidden: false },
  } as never;

  const findings = checkInvariants({
    profile,
    bindings: new Map([['access-point', { state: 'bound', phy: radio.phy, interfaceName: 'wlanap' } as never]]),
    inventory: inventory as never,
    facts: facts() as never,
  });
  assert.equal(findings.find((f) => f.code === 'width_not_honoured'), undefined);
});
