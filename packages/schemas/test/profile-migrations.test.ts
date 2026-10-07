/**
 * Profile document migrations, one test per step.
 *
 * A step that has shipped is never edited, so each of these is also a regression guard on a document shape
 * somebody actually had.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { migrateProfile } from '../src/profile-migrations.ts';
import { PROFILE_SCHEMA_VERSION, Tunnel } from '../src/profile.ts';
import { emptyProfile } from '../src/profile-defaults.ts';
import { assertProfileDocument, profileFaults } from '../src/validate-profile.ts';

test('version 3 carries a blocked endpoint’s suffix meaning into an explicit rule', () => {
  /*
   * The generated block rule changed from `domain_suffix` to `domain`, which narrowed every existing entry.
   *
   * The exact-match change was right — the core's suffix match is literal, so `example.com` as a suffix also
   * blocked `notexample.com`. What was missing was carrying the old meaning forward. Silently narrowing a
   * *blocking* rule is a security regression: the entry still exists, still looks right, and covers less
   * than it did, with nothing telling anybody.
   */
  const before = {
    schemaVersion: 2,
    firewall: {
      killSwitch: false,
      ipv6: 'block',
      ntpBypass: true,
      blockedEndpoints: [
        { domain: 'whatismyipaddress.com', note: 'address discovery' },
        { ipCidr: '198.51.100.0/24', ports: [3478], protocol: 'udp' },
        { domain: 'stun.example.invalid' },
      ],
    },
    routing: { rules: [{ kind: 'protect-own-networks' }], ruleSets: [] },
  };

  const { document, applied } = migrateProfile(before as never);
  assert.ok(applied.some((name) => name.includes('suffix meaning')));

  const rules = (document as { routing: { rules: Record<string, unknown>[] } }).routing.rules;
  const added = rules.find((rule) => rule['kind'] === 'domainSuffix')!;
  assert.ok(added, 'the suffix meaning should survive as an explicit rule');
  assert.deepEqual(added['suffixes'], ['whatismyipaddress.com', 'stun.example.invalid']);
  assert.deepEqual(added['action'], { outbound: 'block' });

  // Appended, not prepended: a block must never end up above the protect anchor.
  assert.equal(rules[0]!['kind'], 'protect-own-networks');
  assert.equal(rules[rules.length - 1], added);

  // The entries themselves are untouched — they now match exactly, which is what was intended.
  const blocked = (document as { firewall: { blockedEndpoints: unknown[] } }).firewall.blockedEndpoints;
  assert.equal(blocked.length, 3);
});

test('a profile with no blocked domains gains no rule', () => {
  // An invariant that fires on a configuration nobody asked about teaches operators to ignore diffs.
  const before = {
    schemaVersion: 2,
    firewall: { killSwitch: false, ipv6: 'block', ntpBypass: true, blockedEndpoints: [] },
    routing: { rules: [{ kind: 'protect-own-networks' }], ruleSets: [] },
  };
  const { document } = migrateProfile(before as never);
  const rules = (document as { routing: { rules: unknown[] } }).routing.rules;
  assert.equal(rules.length, 1);
});

test('an ipCidr-only blocked entry contributes no suffix', () => {
  // A firewall entry was never matched by name, so there is no suffix meaning to carry.
  const before = {
    schemaVersion: 2,
    firewall: {
      killSwitch: false,
      ipv6: 'block',
      ntpBypass: true,
      blockedEndpoints: [{ ipCidr: '198.51.100.0/24' }],
    },
    routing: { rules: [], ruleSets: [] },
  };
  const { document } = migrateProfile(before as never);
  assert.deepEqual((document as { routing: { rules: unknown[] } }).routing.rules, []);
});

test('version 4 gives a stored profile the management setting, defaulting to on', () => {
  /*
   * A schema default is present on every new profile and absent from every stored one — a bill this
   * repository has already paid once, when the watchdog threw every thirty seconds against a document that
   * predated its probe fields.
   *
   * `true` is right for an existing profile as well as a new one: an upgrade that silently narrowed how a
   * device can be reached could strand somebody whose only route to the panel is the network they are on.
   */
  const before = { schemaVersion: 3, services: { clashApi: { enabled: true, bind: '127.0.0.1:9090' } } };
  const { document, applied } = migrateProfile(before as never);
  assert.ok(applied.includes('where the management surface answers'));
  assert.deepEqual((document as { services: { management: unknown } }).services.management, {
    onUplinkNetwork: true,
  });
});

/**
 * **Widening the catalogue is not a migration, and this is the assertion that says so.**
 *
 * `Tunnel` is a union with one branch per catalogue entry. Adding a branch adds documents the schema
 * accepts and removes none, so every profile already on a device still matches the branch it always
 * matched — which is why `proxy` (Epic F, row F5) shipped with no step and no version bump.
 *
 * It is worth a test rather than a sentence because the opposite is easy to do by accident: a change
 * that *narrowed* a branch, or that made `type` required on an existing entry, would be a migration
 * pretending to be an addition, and the device it broke would be somebody's.
 */
test('adding a catalogue entry leaves stored profiles alone: no step, no version bump', () => {
  const stored = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    tunnels: [
      { id: 'a', name: 'A', role: 'alternative', enabled: true, onUnavailable: 'block', protocol: 'openvpn', config: { profile: 'client\n' } },
      { id: 'b', name: 'B', role: 'alternative', enabled: true, onUnavailable: 'block', protocol: 'vless', config: { server: 'x.example.invalid', port: 443, id: 'u', network: 'tcp', security: 'tls' } },
    ],
  };
  const { document, applied } = migrateProfile(structuredClone(stored) as never);

  // 8 since 2026-09-24, when `tunnels[].probe` was removed (plan row G30) — a removal, which is a step.
  assert.equal(PROFILE_SCHEMA_VERSION, 8, 'a new catalogue entry must not move the document version');
  assert.deepEqual(applied, [], 'nothing has to be rewritten for a protocol nobody stored');
  assert.deepEqual(document, stored);

  // And the new branch is genuinely reachable, so the union grew rather than merely compiling.
  assert.equal(
    Value.Check(Tunnel, {
      id: 'ru',
      name: 'Russian proxy',
      role: 'alternative',
      enabled: true,
      onUnavailable: 'block',
      protocol: 'proxy',
      config: { type: 'socks', server: 'proxy.example.invalid', port: 1080, auth: { username: 'u', password: 'p' } },
    }),
    true,
  );
  // The pairing the union exists for: a proxy configuration under another protocol's name matches
  // no branch at all, which is what makes the refusal a property of the schema.
  assert.equal(
    Value.Check(Tunnel, {
      id: 'ru',
      name: 'Russian proxy',
      role: 'alternative',
      enabled: true,
      onUnavailable: 'block',
      protocol: 'vless',
      config: { type: 'socks', server: 'proxy.example.invalid', port: 1080 },
    }),
    false,
  );
});

test('a profile that already states the setting is left alone', () => {
  // A step that overwrote an explicit choice would turn an upgrade into a silent policy change.
  const before = {
    schemaVersion: 3,
    services: { clashApi: { enabled: true, bind: '127.0.0.1:9090' }, management: { onUplinkNetwork: false } },
  };
  const { document } = migrateProfile(before as never);
  assert.deepEqual((document as { services: { management: unknown } }).services.management, {
    onUplinkNetwork: false,
  });
});

/* ── 7 → 8: the probe leaves the profile (plan row G30) ──────────────────────────────────── */

/**
 * The stored shape the bench board had on 2026-09-24, reduced to what the step reads: `partner` carrying
 * one of its own resources as its probe — the input that blocked every destination behind a healthy
 * tunnel — and a tunnel with no probe beside it.
 */
function boardAtVersion7(): Record<string, unknown> {
  const current = emptyProfile({ name: 'Bench' }) as unknown as Record<string, unknown>;
  return {
    ...current,
    schemaVersion: 7,
    tunnels: [
      {
        id: 'partner',
        name: 'Partner work',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        protocol: 'openvpn',
        config: { interfaceSuffix: 'prt', profile: 'client\ndev tun\nremote vpn.example.invalid 1194\n' },
        resources: { ipCidr: ['172.30.0.212/32'] },
        probe: { endpoints: ['http://172.30.0.212/'] },
      },
      {
        id: 'relay',
        name: 'Relay',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        protocol: 'vless',
        config: { server: '198.51.100.7', port: 443, id: 'u', network: 'tcp', security: 'tls' },
      },
    ],
  };
}

test('version 8 removes a stored probe, and nothing else about the tunnel', () => {
  const before = boardAtVersion7();
  const { document, applied, from } = migrateProfile(structuredClone(before));
  assert.equal(from, 7);
  assert.deepEqual(applied, ['a tunnel is asked whether it is alive, not a server behind it']);
  assert.equal(document['schemaVersion'], 8);
  const tunnels = document['tunnels'] as Record<string, unknown>[];
  assert.equal('probe' in tunnels[0]!, false);
  // Everything else is carried, the resource that was the probe target included.
  const { probe: _gone, ...rest } = (before['tunnels'] as Record<string, unknown>[])[0]!;
  assert.deepEqual(tunnels[0], rest);
  assert.deepEqual(tunnels[1], (before['tunnels'] as unknown[])[1]);
  assertProfileDocument(document);
});

test('a document at version 8 that still names a probe is refused by name, not with "Unexpected property"', () => {
  const current = migrateProfile(boardAtVersion7()).document;
  (current['tunnels'] as Record<string, unknown>[])[0]!['probe'] = { endpoints: ['http://172.30.0.212/'] };
  const faults = profileFaults(current);
  assert.equal(faults.length, 1, JSON.stringify(faults));
  assert.equal(faults[0]!.code, 'tunnel_field_removed');
  assert.equal(faults[0]!.pointer, '/tunnels/0/probe');
  assert.match(faults[0]!.message, /no longer takes "probe"/);
  assert.match(faults[0]!.hint, /Nothing replaces it/);
  assert.throws(() => assertProfileDocument(current));
});
