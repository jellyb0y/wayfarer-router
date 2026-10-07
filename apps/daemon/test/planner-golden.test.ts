/**
 * Golden files for every generated artefact, across the synthetic inventories.
 *
 * This is the test that makes the planner's purity worth something. Each scenario is a profile and an
 * inventory in, and a checked-in file out containing every generated artefact byte for byte, the
 * findings with their pointers and hints, the classified diff, and the blast radius. A change to any
 * generator is then a diff somebody reads rather than a green tick — which matters most for the files
 * nobody looks at until a device will not come up.
 *
 * Regenerate deliberately:
 *
 *     UPDATE_GOLDEN=1 node --test --experimental-strip-types test/planner-golden.test.ts
 *
 * The rule for reviewing one of those diffs: a line that disappeared from a generated file is a
 * capability or a protection that disappeared with it.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { plan } from '../src/core/planner.ts';
import { emitTunnels } from '../src/core/emit.ts';
import { diff, type Reality } from '../src/core/differ.ts';
import { planDocument } from '../src/core/pipeline.ts';
import type { Platform } from '../src/platform/index.ts';
import { INVENTORIES, cleanFacts } from './helpers/synthetic-inventory.ts';
import type { Inventory } from '../src/inventory/index.ts';
import type { RuntimeFacts } from '../src/core/invariants.ts';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, 'fixtures', 'planner');

/* ── profiles ────────────────────────────────────────────────────────────────────────────── */

const FIXED_TIME = '2026-09-19T12:00:00.000Z';
const now = (): string => FIXED_TIME;

function base(name: string): ProfileDocument {
  return emptyProfile({ name, now });
}

function withAccessPoint(
  profile: ProfileDocument,
  overrides: Partial<NonNullable<ProfileDocument['accessPoint']>> = {},
): ProfileDocument {
  return {
    ...profile,
    accessPoint: {
      bind: { by: 'phy-builtin' },
      radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
      ssid: 'Wayfarer',
      passphrase: 'a-passphrase-for-the-test' as unknown as string,
      acceptChannelFollowsUplink: false,
      ...overrides,
    },
  };
}

const SCENARIOS: { name: string; inventory: keyof typeof INVENTORIES; profile: ProfileDocument; facts?: RuntimeFacts }[] = [
  {
    // The document a device starts from: no uplink, no access point, no tunnel. A valid state, and
    // the one a fresh device is in.
    name: 'empty-profile-no-radio',
    inventory: 'no-radio',
    profile: base('Fresh'),
  },
  {
    name: 'access-point-and-ethernet-uplink',
    inventory: 'one-built-in-radio',
    profile: {
      ...withAccessPoint(base('Home')),
      uplinks: [
        {
          id: 'wan-eth',
          kind: 'ethernet',
          priority: 10,
          enabled: true,
          bind: { by: 'any-ethernet' },
          config: { dhcp: true },
        },
      ],
    },
  },
  {
    // The same profile with both roles asking to be pinned. This is the scenario that exercises the
    // `pinName` path, and it exists because pinning stopped being the default: without it, the whole
    // rename-and-link-file mechanism would have no coverage at all, which is how a feature that is
    // still supported quietly stops working.
    //
    // Two things this golden is here to hold still: the blast radius rises to `boot` because a rename
    // takes effect only at the next start, and the rename of the interface carrying the management
    // session is reported as such rather than as routine.
    name: 'pinned-names-access-point-and-ethernet',
    inventory: 'one-built-in-radio',
    profile: {
      ...withAccessPoint(base('Home, pinned'), { pinName: true }),
      uplinks: [
        {
          id: 'wan-eth',
          kind: 'ethernet',
          priority: 10,
          enabled: true,
          bind: { by: 'any-ethernet' },
          pinName: true,
          config: { dhcp: true },
        },
      ],
    },
  },
  {
    // Pinning on only one of two roles. The mixed case is the one a reader will assume works and
    // nobody will check: the access point keeps the name the kernel gave it while the uplink is
    // renamed, so exactly one link file is written and every artefact has to agree about which name
    // belongs to which role.
    name: 'pinned-uplink-unpinned-access-point',
    inventory: 'one-built-in-radio',
    profile: {
      ...withAccessPoint(base('Half pinned')),
      uplinks: [
        {
          id: 'wan-eth',
          kind: 'ethernet',
          priority: 10,
          enabled: true,
          bind: { by: 'any-ethernet' },
          pinName: true,
          config: { dhcp: true },
        },
      ],
    },
  },
  {
    // The two-radio build: access point on the dongle, client on the built-in radio. The arrangement
    // the driver actually permits.
    name: 'access-point-on-dongle-wifi-uplink',
    inventory: 'built-in-and-dongle',
    profile: {
      ...withAccessPoint(base('Travel'), {
        bind: { by: 'phy-usb', value: '0e8d:7961' },
        radio: { band: '5GHz', channel: 36, width: 80, country: 'US', hidden: false },
      }),
      uplinks: [
        {
          id: 'wan-wifi',
          kind: 'wifi-sta',
          priority: 20,
          enabled: true,
          bind: { by: 'phy-builtin' },
          config: { ssid: 'UpstreamAP', psk: 'upstream-secret' as unknown as string, band: '5GHz' },
        },
      ],
    },
  },
  {
    // Both roles on one radio, on a driver that says it is exclusive. Must refuse, naming the
    // combination in the driver's own words.
    name: 'both-roles-on-exclusive-radio',
    inventory: 'one-built-in-radio',
    profile: {
      ...withAccessPoint(base('Impossible')),
      uplinks: [
        {
          id: 'wan-wifi',
          kind: 'wifi-sta',
          priority: 10,
          enabled: true,
          bind: { by: 'phy-builtin' },
          config: { ssid: 'UpstreamAP', psk: 'upstream-secret' as unknown as string },
        },
      ],
    },
  },
  {
    // Both roles on a radio that permits it, but on one channel, and without the acknowledgement.
    name: 'dual-role-unacknowledged',
    inventory: 'dual-role-dongle',
    profile: {
      ...withAccessPoint(base('Dual'), { bind: { by: 'phy-usb', value: '0e8d:7961' } }),
      uplinks: [
        {
          id: 'wan-wifi',
          kind: 'wifi-sta',
          priority: 10,
          enabled: true,
          bind: { by: 'phy-usb', value: '0e8d:7961' },
          config: { ssid: 'UpstreamAP', psk: 'upstream-secret' as unknown as string },
        },
      ],
    },
  },
  {
    // The same, acknowledged. The channel field becomes decoration and the generated configuration
    // must say channel=0, which is the only value that means "the one the radio is already on".
    name: 'dual-role-acknowledged',
    inventory: 'dual-role-dongle',
    profile: {
      ...withAccessPoint(base('Dual accepted'), {
        bind: { by: 'phy-usb', value: '0e8d:7961' },
        acceptChannelFollowsUplink: true,
      }),
      uplinks: [
        {
          id: 'wan-wifi',
          kind: 'wifi-sta',
          priority: 10,
          enabled: true,
          bind: { by: 'phy-usb', value: '0e8d:7961' },
          config: { ssid: 'UpstreamAP', psk: 'upstream-secret' as unknown as string },
        },
      ],
    },
  },
  {
    // A profile written on another device. The role is unbound, which is a state and not a broken
    // document: the interface offers the candidates it found.
    name: 'unbound-access-point-role',
    inventory: 'one-built-in-radio',
    profile: withAccessPoint(base('Imported'), { bind: { by: 'phy-usb', value: 'aaaa:bbbb' } }),
  },
  {
    // Two identical dongles. Must be an explicit failure, never a coin flip.
    name: 'ambiguous-usb-selector',
    inventory: 'two-identical-dongles',
    profile: withAccessPoint(base('Ambiguous'), { bind: { by: 'phy-usb', value: '0e8d:7961' } }),
  },
  {
    // A channel the regulatory domain does not offer, and a channel it offers but disables. Two
    // refusals with different messages from one inventory.
    name: 'channel-outside-regulatory-domain',
    inventory: 'restricted-regulatory-domain',
    profile: withAccessPoint(base('Wrong channel'), {
      radio: { band: '5GHz', channel: 149, width: 80, country: 'DE', hidden: false },
    }),
  },
  {
    // The full shape: tunnels of both roles, every routing rule kind, the kill-switch on, blocked
    // endpoints, and a rule set. This is the scenario that exercises the core-configuration generator.
    name: 'tunnels-routing-and-killswitch',
    inventory: 'built-in-and-dongle',
    profile: {
      ...withAccessPoint(base('Everything'), { bind: { by: 'phy-usb', value: '0e8d:7961' } }),
      uplinks: [
        { id: 'wan-eth', kind: 'ethernet', priority: 10, enabled: true, bind: { by: 'any-ethernet' }, config: { dhcp: true } },
      ],
      tunnels: [
        {
          id: 'alt-a',
          name: 'Warsaw',
          role: 'alternative', onUnavailable: 'block' as const,
          enabled: true,
          protocol: 'vless',
          config: {
            server: '198.51.100.7',
            port: 443,
            id: 'a-placeholder-account',
            network: 'tcp',
            security: 'tls',
          },
        },
        {
          // Obfuscated, with two entry points: the shape that had a port written by hand in two files.
          id: 'alt-b',
          name: 'Berlin',
          role: 'alternative', onUnavailable: 'block' as const,
          enabled: true,
          protocol: 'cloak-openvpn',
          config: {
            profile: 'client\ndev tun\nremote peer.example.net 1194\n',
            interfaceSuffix: 'b',
            entryPoints: [
              {
                id: 'front-a',
                host: '198.51.100.8',
                port: 443,
                uid: 'a-placeholder-identifier',
                publicKey: 'a-placeholder-public-key',
                proxyMethod: 'openvpn',
                encryptionMethod: 'aes-gcm',
                serverName: 'www.example.com',
                browserSignature: 'chrome',
                transport: 'direct',
              },
              {
                id: 'front-b',
                host: '198.51.100.9',
                port: 8443,
                uid: 'a-placeholder-identifier',
                publicKey: 'a-placeholder-public-key',
                proxyMethod: 'openvpn',
                encryptionMethod: 'chacha20-poly1305',
                serverName: 'api.example.com',
                browserSignature: 'ios',
                transport: 'cdn',
              },
            ],
          },
        },
        {
          id: 'res-hq',
          name: 'HQ',
          role: 'resource', onUnavailable: 'block' as const,
          enabled: true,
          protocol: 'openvpn',
          config: { profile: 'client\ndev tun\nremote hq.example.net 1194\n', interfaceSuffix: '0' },
          resources: { domainSuffix: ['.hq.example'], ipCidr: ['10.0.0.0/8'] },
          dns: { server: '10.184.100.5', dynamic: true, domainSuffix: ['.hq.example'] },
        },
        {
          // Disabled: it must appear nowhere in the generated configuration, and must not be removed
          // from the profile either.
          id: 'alt-off',
          name: 'Disabled',
          role: 'alternative', onUnavailable: 'block' as const,
          enabled: false,
          protocol: 'vless',
          config: {
            server: '198.51.100.10',
            port: 443,
            id: 'a-placeholder-account',
            network: 'tcp',
            security: 'tls',
          },
        },
      ],
      policy: {
        priority: ['alt-b', 'alt-a'],
        excluded: [],
        sticky: true,
        probes: (emptyProfile({ name: 'x' }) as unknown as ProfileDocument).policy.probes,
        onAllDown: 'block',
      },
      routing: {
        rules: [
          { kind: 'protect-own-networks' },
          { kind: 'tunnel-resources' },
          { kind: 'domain', domains: ['exact.example.com'], action: { outbound: 'direct' } },
          { kind: 'domainSuffix', suffixes: ['.internal.example'], action: { outbound: 'res-hq' } },
          { kind: 'ipCidr', cidrs: ['203.0.113.0/24'], action: { outbound: 'block' } },
          { kind: 'private', action: { outbound: 'direct' } },
          { kind: 'ruleSet', sets: ['geoip-example'], action: { outbound: 'direct' } },
        ],
        ruleSets: [
          { tag: 'geoip-example', type: 'remote', url: 'https://example.invalid/geoip.srs', updateIntervalHours: 24 },
        ],
      },
      firewall: {
        killSwitch: true,
        ipv6: 'block',
        ntpBypass: true,
        blockedEndpoints: [
          { ipCidr: '198.51.100.0/24', ports: [3478], protocol: 'udp', note: 'address discovery' },
          { domain: 'discovery.example.invalid', note: 'address discovery by name' },
        ],
      },
    },
  },
  {
    // A foreign core already running, with a profile that has tunnels. Must refuse and name the unit.
    name: 'foreign-core-running',
    inventory: 'one-built-in-radio',
    profile: {
      ...base('Contended'),
      tunnels: [
        {
          id: 'alt-a',
          name: 'Warsaw',
          role: 'alternative', onUnavailable: 'block' as const,
          enabled: true,
          protocol: 'vless',
          config: {
            server: '198.51.100.7',
            port: 443,
            id: 'a-placeholder-account',
            network: 'tcp',
            security: 'tls',
          },
        },
      ],
    },
    facts: {
      ...cleanFacts(),
      foreignCores: [{ unit: 'sing-box.service', binary: '/usr/bin/sing-box' }],
    },
  },
  {
    // Another manager already configures the interface this profile wants. Detection is this epic;
    // taking it over belongs to the epic with a revert window.
    name: 'interface-claimed-elsewhere',
    inventory: 'one-built-in-radio',
    profile: {
      ...base('Contested'),
      uplinks: [
        { id: 'wan-eth', kind: 'ethernet', priority: 10, enabled: true, bind: { by: 'any-ethernet' }, config: { dhcp: true } },
      ],
    },
    facts: {
      ...cleanFacts(),
      interfaceClaims: [
        { interface: 'wfwan0', by: 'another network manager', file: '/etc/netplan/10-dhcp-all-interfaces.yaml' },
      ],
    },
  },
];

/* ── emissions: what the provider layer would contribute ─────────────────────────────────── */

/**
 * The **real** emission, not a stand-in.
 *
 * This used to be a hand-written `emissionsFor` that produced a plausible outbound per provider, and
 * the cost of that was not obvious until the catalogue existed: the stand-in's generated `.ovpn`
 * carried `route-nopull`, which is the one directive the production generator documents at length as
 * wrong — it discards every pulled option including the `dhcp-option DNS` the configuration exists to
 * capture. So the golden files held a protection that the shipped code does not produce, and would
 * have held it indefinitely.
 *
 * Calling the catalogue is possible because every entry is pure, which is the property this whole file
 * exists to make worth something. The credentials in the fixtures are placeholders, and they now reach
 * the golden files, which is the point: an `.ovpn` whose hardening lines disappear is a diff somebody
 * reads.
 */
function emissionFor(profile: ProfileDocument): ReturnType<typeof emitTunnels> {
  return emitTunnels({
    profile,
    // Nothing is known about the core, so every entry offers itself. Binary presence comes from the
    // inventory through the invariant checks, which is where "this device cannot run that" belongs.
    core: { known: false, outboundTypes: new Set() },
    installed: new Set(['openvpn', 'ck-client', 'xray', 'sing-box']),
    allocatedPorts: new Set(),
  });
}

/** The emission, spread into the planner's input, so no caller assembles the four fields by hand. */
function emissionsInput(profile: ProfileDocument): {
  emissions: ReturnType<typeof emitTunnels>['emissions'];
  ports: ReturnType<typeof emitTunnels>['ports'];
  refusals: ReturnType<typeof emitTunnels>['refusals'];
  carriers: ReturnType<typeof emitTunnels>['carriers'];
} {
  const emitted = emissionFor(profile);
  return {
    emissions: emitted.emissions,
    ports: emitted.ports,
    refusals: emitted.refusals,
    carriers: emitted.carriers,
  };
}

/* ── reality: a device with nothing of ours on it ────────────────────────────────────────── */

function bareReality(inventory: Inventory): Reality {
  return {
    files: [],
    units: [],
    interfaces: inventory.interfaces.map((entry) => ({ name: entry.name, mac: entry.mac })),
    managementInterfaces: ['end0'],
    sysctl: { 'net.ipv4.ip_forward': '0' },
  };
}

/* ── the test ────────────────────────────────────────────────────────────────────────────── */

function render(scenario: (typeof SCENARIOS)[number]): string {
  const inventory = INVENTORIES[scenario.inventory]!();
  const facts = scenario.facts ?? cleanFacts();

  const result = plan({
    profile: scenario.profile,
    inventory,
    facts,
    ...emissionsInput(scenario.profile),
    managementPort: 8088,
    // Ports as configuration rather than constants at the call site.
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
  });

  const classified = diff({ desired: result.desired, reality: bareReality(inventory) });

  const sections: string[] = [];
  sections.push(`# scenario: ${scenario.name}`);
  sections.push(`# inventory: ${scenario.inventory}`);
  sections.push(`# usable: ${result.usable}`);
  sections.push(`# blast radius: ${classified.blastRadius}`);
  sections.push('');

  sections.push('## bindings');
  for (const [role, resolution] of [...result.bindings.entries()].sort()) {
    sections.push(`- ${role}: ${resolution.state}${'name' in resolution ? ` → ${resolution.name}` : ''}`);
    if (resolution.state !== 'bound') sections.push(`    reason: ${resolution.reason}`);
  }
  if (result.bindings.size === 0) sections.push('- (none: this profile binds no hardware)');
  sections.push('');

  sections.push('## findings');
  if (result.findings.length === 0) sections.push('- (none)');
  for (const finding of result.findings) {
    sections.push(`- [${finding.severity}] ${finding.code} at ${finding.pointer}`);
    sections.push(`    ${finding.message}`);
    sections.push(`    hint: ${finding.hint}`);
  }
  sections.push('');

  sections.push('## notes');
  for (const note of result.desired.notes) sections.push(`- ${note}`);
  if (result.desired.notes.length === 0) sections.push('- (none)');
  sections.push('');

  sections.push('## sysctl');
  for (const setting of result.desired.sysctl) sections.push(`- ${setting.key}=${setting.value} — ${setting.reason}`);
  if (result.desired.sysctl.length === 0) sections.push('- (none)');
  sections.push('');

  sections.push('## units');
  for (const unit of result.desired.units) {
    sections.push(`- ${unit.name} enabled=${unit.enabled} active=${unit.active} — ${unit.purpose}`);
  }
  sections.push('');

  sections.push('## plan, in apply order');
  for (const line of classified.humanDiff) sections.push(`- ${line}`);
  sections.push('');

  sections.push('## generated files');
  const files = [...result.desired.files, ...result.desired.networkFiles].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  for (const file of files) {
    sections.push('');
    sections.push(`### ${file.path} (mode ${file.mode.toString(8)})`);
    sections.push(`purpose: ${file.purpose}`);
    sections.push('```');
    sections.push(file.content.trimEnd());
    sections.push('```');
  }
  sections.push('');

  return `${sections.join('\n')}\n`;
}

for (const scenario of SCENARIOS) {
  test(`golden: ${scenario.name}`, () => {
    const rendered = render(scenario);
    const path = join(goldenDir, `${scenario.name}.txt`);

    if (process.env['UPDATE_GOLDEN'] === '1') {
      mkdirSync(goldenDir, { recursive: true });
      writeFileSync(path, rendered);
      return;
    }

    const golden = readFileSync(path, 'utf8');
    assert.equal(
      rendered,
      golden,
      `the generated artefacts for "${scenario.name}" changed. Read the diff: a line that vanished ` +
        'from a generated file is a capability or a protection that vanished with it. Regenerate with ' +
        'UPDATE_GOLDEN=1 once the change is intended.',
    );
  });
}

test('the planner is pure: the same input twice produces identical output', () => {
  // Purity is the property the whole epic rests on and it is lost one call at a time, so it is
  // asserted rather than assumed. A clock, a random value or a read of the environment inside a
  // generator would show up here.
  for (const scenario of SCENARIOS) {
    assert.equal(render(scenario), render(scenario), `${scenario.name} is not deterministic`);
  }
});

test('the planner never mutates the profile it is given', () => {
  // A generator that sorted an array in place would corrupt the caller's document, and the caller here
  // is the stored active profile.
  for (const scenario of SCENARIOS) {
    const snapshot = JSON.stringify(scenario.profile);
    render(scenario);
    assert.equal(JSON.stringify(scenario.profile), snapshot, `${scenario.name} mutated its input`);
  }
});

test('no generated artefact reaches a plan review with a secret in it', () => {
  // The generated core configuration necessarily contains real credentials on a device. The rule that
  // keeps that from defeating redaction is structural: the human-facing diff names paths and purposes,
  // never contents. Asserted here because it is the kind of rule a later convenience quietly breaks.
  for (const scenario of SCENARIOS) {
    const inventory = INVENTORIES[scenario.inventory]!();
    const result = plan({
      profile: scenario.profile,
      inventory,
      facts: scenario.facts ?? cleanFacts(),
      ...emissionsInput(scenario.profile),
      managementPort: 8088,
      timePorts: [123],
      coreBinaryPath: '/usr/bin/sing-box',
      upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
    });
    const classified = diff({ desired: result.desired, reality: bareReality(inventory) });

    const humanText = [...classified.humanDiff, ...result.desired.notes, ...result.findings.map((f) => f.message)].join(
      '\n',
    );
    assert.equal(
      /a-passphrase-for-the-test|upstream-secret/.test(humanText),
      false,
      `${scenario.name}: a secret appeared in a human-facing surface`,
    );
  }
});

/**
 * `docs/13-plan.md` row G12: the drift check prints the first differing line of a non-JSON file unless
 * the file is marked as holding credentials, and the mark is set by the generator. So every file the
 * planner writes a credential into must carry it — found by looking for the credential in the content,
 * not by a list of paths, which would be a second copy of the generator's knowledge.
 */
test('every generated file that holds the access point or uplink passphrase is marked as credentials', () => {
  const marked: string[] = [];
  for (const scenario of SCENARIOS) {
    const inventory = INVENTORIES[scenario.inventory]!();
    const result = plan({
      profile: scenario.profile,
      inventory,
      facts: scenario.facts ?? cleanFacts(),
      ...emissionsInput(scenario.profile),
      managementPort: 8088,
      timePorts: [123],
      coreBinaryPath: '/usr/bin/sing-box',
      upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
    });
    for (const file of [...result.desired.files, ...result.desired.networkFiles]) {
      // The supplicant is handed the key derived from the passphrase, not the passphrase: the derived
      // key joins the network just as well, so it is the credential too.
      if (!/a-passphrase-for-the-test|upstream-secret|^\s*psk=[0-9a-f]{64}$/m.test(file.content)) continue;
      assert.equal(file.credentials, true, `${scenario.name}: ${file.path} holds a passphrase and is not marked as credentials`);
      marked.push(file.path);
    }
  }
  // Found somewhere, or the loop above proved nothing.
  assert.ok(marked.some((path) => path.includes('hostapd')), `no hostapd file carried the passphrase: ${marked.join(', ')}`);
  assert.ok(marked.some((path) => path.includes('supplicant')), `no supplicant file carried the key: ${marked.join(', ')}`);
});

/* ── a plan is empty immediately after its own apply ─────────────────────────────────────── */

/**
 * Reality as it would be *after* this desired state was applied, built by construction.
 *
 * This models a device that did exactly what the plan asked, so re-planning must find nothing left to
 * do. Any difference the diff reports here is a value the generator emits and nothing reads back — and
 * that whole class is invisible to every other test, because every other test starts from a bare
 * device where everything is legitimately a change.
 */
function realityAfterApplying(desired: ReturnType<typeof plan>['desired'], inventory: Inventory): Reality {
  const files = [...desired.files, ...desired.networkFiles].map((file) => ({
    path: file.path,
    content: file.content,
    mode: file.mode,
  }));

  /**
   * A template is **not** reported as a known unit, because systemd does not report it as one.
   *
   * This helper used to say `known: true` for every desired unit, and that one word is why the
   * convergence assertion below passed for a year while the real device never converged. Measured on
   * the bench board, 2026-09-20: `systemctl show -p LoadState wf-hostapd@.service` does not answer
   * `loaded`, it fails outright — "Unit name wf-hostapd@.service is neither a valid invocation ID nor
   * unit name" — because a template is not a unit, only its instances are. A stand-in reality that
   * answers a question the real one refuses is not a stand-in; it is a different system, and an
   * invariant proved against it is proved about nothing.
   */
  const units = desired.units.map((unit) => {
    const isTemplate = unit.name.includes('@.');
    return {
      name: unit.name,
      active: isTemplate ? false : unit.active,
      enabled: isTemplate ? false : unit.enabled,
      known: !isTemplate,
    };
  });

  const sysctl: Record<string, string> = {};
  for (const setting of desired.sysctl) sysctl[setting.key] = setting.value;

  // The interfaces have been renamed to the names the link files pin, which is what a device looks
  // like after a reboot — and a rename is the one change that needs one.
  const renamed = new Map<string, string>();
  for (const file of desired.networkFiles) {
    if (!file.path.endsWith('.link')) continue;
    const name = /^Name=(.+)$/m.exec(file.content)?.[1];
    const mac = /^MACAddress=(.+)$/m.exec(file.content)?.[1];
    if (name !== undefined && mac !== undefined) renamed.set(mac.toLowerCase(), name);
  }

  return {
    files,
    units,
    interfaces: inventory.interfaces.map((entry) => ({
      name: entry.mac !== null && renamed.has(entry.mac.toLowerCase()) ? renamed.get(entry.mac.toLowerCase())! : entry.name,
      mac: entry.mac,
    })),
    managementInterfaces: ['end0'],
    sysctl,
  };
}

for (const scenario of SCENARIOS) {
  test(`re-planning right after applying "${scenario.name}" finds nothing to do`, (t) => {
    // The defect this catches, and it is a whole class rather than one bug: the caller read a
    // hardcoded list of sysctl keys while the generator emitted two more whenever IPv6 was blocked.
    // Those two were never read, so the differ saw them as changed for ever, **every** plan was forced
    // to `network`, and the whole-apply refusal fired on every apply — including immediately after a
    // successful one.
    //
    // The damage was not the wrong class. An operator or a script that meets a spurious refusal every
    // time learns to pass the narrowing automatically, and from then on a real network change goes
    // through the path built to stop it. A safety mechanism that cries wolf trains the bypass.
    //
    // A plan that is not empty right after its own apply is always a bug, whatever produced it.
    const inventory = INVENTORIES[scenario.inventory]!();
    const result = plan({
      profile: scenario.profile,
      inventory,
      facts: scenario.facts ?? cleanFacts(),
      ...emissionsInput(scenario.profile),
      managementPort: 8088,
      timePorts: [123],
      coreBinaryPath: '/usr/bin/sing-box',
      upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
    });

    if (!result.usable) {
      /*
       * A plan carrying an error is never applied, so "apply it and re-plan" is not a state this
       * device can reach and asserting about it would be asserting about nothing.
       *
       * Worth recording what the attempt exposed, because it is real: the three scenarios that bind
       * two roles to one radio emit **two `.link` files matching the same address** with different
       * names. systemd applies the first match in lexical order and the other silently never takes
       * effect, so such a device would report a pending rename for ever. It is already refused one
       * level up — the interface-combination check rejects both roles on one radio, in the driver's
       * own words — so the conflicting files are a consequence of a configuration that cannot be
       * applied rather than a fault of their own.
       */
      t.diagnostic(`skipped: this plan is not usable (${result.findings.filter((f) => f.severity === 'error').length} errors)`);
      return;
    }

    const settled = diff({ desired: result.desired, reality: realityAfterApplying(result.desired, inventory) });

    assert.deepEqual(
      {
        files: settled.fileChanges.map((change) => `${change.action} ${change.path}`),
        units: settled.unitChanges.map((change) => `${change.action} ${change.name}`),
        sysctl: settled.sysctlChanges.map((change) => change.key),
        renames: settled.interfaceRenames.map((rename) => `${rename.from}->${rename.to}`),
      },
      { files: [], units: [], sysctl: [], renames: [] },
      `"${scenario.name}" still has work to do immediately after being applied`,
    );

    assert.equal(settled.empty, true);
    // And with nothing to do, the class is the lowest one rather than being forced upwards.
    assert.equal(settled.blastRadius, 'hot');
  });
}

/* ── the plan records the interface names its own tunnels create ─────────────────────────── */

/**
 * A consumer asking "is this interface one of ours" must be able to ask the plan.
 *
 * Before this, the recorded surfaces held the access point and the uplinks and nothing else, so anything
 * needing the tunnel names had two choices: go without, or re-derive them from the provider emission and
 * the generated-name rules in `binding.ts`, `config.interfaceSuffix` included. The second is a copy of a
 * convention, and two copies of a convention agree exactly until one of them changes.
 *
 * The assertion is deliberately not a literal list of names. A hardcoded `wfvpn0` would pass while the
 * plan and the recorded surfaces drifted apart in the same direction, which is the whole failure being
 * guarded against: what matters is that the recorded names are *the ones this plan actually created*.
 */
test('the recorded surfaces name the interfaces this plan creates for its own tunnels', () => {
  const scenario = SCENARIOS.find((entry) => entry.profile.tunnels.some((tunnel) => tunnel.enabled));
  assert.ok(scenario, 'the fixture set must contain a profile with an enabled tunnel, or this proves nothing');

  const inventory = INVENTORIES[scenario.inventory]!();
  const emitted = emissionFor(scenario.profile);
  const result = plan({
    profile: scenario.profile,
    inventory,
    facts: scenario.facts ?? cleanFacts(),
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

  const created = [...emitted.emissions.values()].flatMap((emission) => emission.interfaces ?? []);
  assert.ok(created.length > 0, 'the chosen scenario must create at least one tunnel interface');

  assert.deepEqual(
    [...result.desired.managementSurfaces.tunnels].sort(),
    [...created].sort(),
    'every interface an emission creates must appear in the recorded surfaces, and nothing else',
  );

  // And they stay distinguishable from the other two roles, which is the point of recording them apart:
  // `desired.interfaces` mixes in the access point and the uplinks.
  assert.equal(
    result.desired.managementSurfaces.tunnels.includes(result.desired.managementSurfaces.accessPoint ?? '\u0000'),
    false,
    'the access point is not a tunnel',
  );
});

/**
 * The units of each tunnel, recorded per tunnel rather than per plan.
 *
 * The same argument as the interfaces above and one step further: `desired.units` is flat, and the
 * grouping cannot be recovered from it. A consumer asking "which units is *this* tunnel made of"
 * therefore had the same two choices — go without, or rebuild the names from the tunnel's protocol —
 * and a tunnel is not one unit, so the second is a copy of a rule with a join in it.
 *
 * Again not a literal list of names: a hardcoded `wf-openvpn@work.service` would stay green while
 * the emission and the recording drifted together, which is the failure. What is asserted is that
 * every recorded unit is a unit this plan actually emitted, that every tunnel with an emission is
 * recorded, and that the grouping is the emission's own.
 */
test('the plan records which units each of its tunnels is made of', () => {
  const scenario = SCENARIOS.find((entry) => entry.profile.tunnels.some((tunnel) => tunnel.enabled));
  assert.ok(scenario, 'the fixture set must contain a profile with an enabled tunnel, or this proves nothing');

  const inventory = INVENTORIES[scenario.inventory]!();
  const emitted = emissionFor(scenario.profile);
  const result = plan({
    profile: scenario.profile,
    inventory,
    facts: scenario.facts ?? cleanFacts(),
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

  const recorded = result.desired.tunnelUnits;
  assert.ok(recorded.length > 0, 'the chosen scenario must plan at least one tunnel');
  assert.ok(
    recorded.some((entry) => entry.units.length > 0),
    'at least one planned tunnel must emit a unit, or the grouping proves nothing',
  );

  for (const entry of recorded) {
    const emission = emitted.emissions.get(entry.id);
    assert.ok(emission, `the plan recorded units for "${entry.id}", which emitted nothing`);
    assert.deepEqual(
      [...entry.units].sort(),
      [...(emission.units ?? []).map((unit) => unit.name)].sort(),
      `the units recorded for "${entry.id}" must be the ones its emission actually produced`,
    );
  }

  // Every tunnel that was planned is recorded, so a tunnel cannot be silently missing from the
  // status view — the absence this field exists to break.
  assert.deepEqual(
    [...recorded.map((entry) => entry.id)].sort(),
    [...emitted.emissions.keys()].sort(),
    'every tunnel with an emission must be recorded, and nothing else',
  );

  // And the recording is a tunnel's units only: the access point, the firewall and the core are in
  // `desired.units` and must not be attributed to a tunnel.
  const planUnits = new Set(result.desired.units.map((unit) => unit.name));
  for (const entry of recorded) {
    for (const unit of entry.units) {
      assert.ok(planUnits.has(unit), `"${unit}" was recorded for tunnel "${entry.id}" but the plan does not install it`);
    }
  }
});

/**
 * The link between the plan and everybody who reads it, asserted because a missing one is silent.
 *
 * The planner recording a value and nothing carrying it out of the pipeline is the same failure as a
 * response key nothing produces: the consumer sees a device with nothing to report and cannot tell
 * that apart from a device nobody asked. There is exactly one line joining them, it sits beside an
 * identical line for the management surfaces, and a deletion of either reads as tidying up.
 *
 * Both are asserted together, so the next value recorded on the desired state finds the pattern here
 * rather than inventing a third one.
 */
test('every plan hands its tunnel units and its resolved surfaces to the caller', async () => {
  const scenario = SCENARIOS.find((entry) => entry.profile.tunnels.some((tunnel) => tunnel.enabled));
  assert.ok(scenario, 'the fixture set must contain a profile with an enabled tunnel, or this proves nothing');

  const inventory = INVENTORIES[scenario.inventory]!();
  const handed: { tunnelUnits?: unknown; surfaces?: unknown } = {};

  const planned = await planDocument(
    {
      // Only the core schema is read from the platform here, and an absent one narrows availability
      // discovery rather than failing — which is what this stand-in reproduces.
      platform: { binaries: { coreSchema: async () => null } } as unknown as Platform,
      inventory: async () => inventory,
      facts: async () => scenario.facts ?? cleanFacts(),
      reality: async (paths, units) => ({
        files: paths.map((path) => ({ path, content: null, mode: null })),
        units: units.map((name) => ({ name, active: false, enabled: false, known: false })),
        interfaces: inventory.interfaces.map((entry) => ({ name: entry.name, mac: entry.mac })),
        managementInterfaces: [],
        sysctl: {},
      }),
      managementPort: 8088,
      timePorts: [123],
      upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
      onTunnelUnits: (value) => {
        handed.tunnelUnits = value;
      },
      onManagementSurfaces: (value) => {
        handed.surfaces = value;
      },
    },
    scenario.profile,
  );

  assert.deepEqual(handed.tunnelUnits, planned.plan.desired.tunnelUnits, 'the tunnel units never left the pipeline');
  assert.ok(
    Array.isArray(handed.tunnelUnits) && handed.tunnelUnits.length > 0,
    'the chosen scenario must hand over at least one tunnel, or this proves nothing',
  );
  assert.deepEqual(handed.surfaces, planned.plan.desired.managementSurfaces, 'the surfaces never left the pipeline');
});
