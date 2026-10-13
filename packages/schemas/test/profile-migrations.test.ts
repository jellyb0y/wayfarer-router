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
      { id: 'a', name: 'A', enabled: true, onUnavailable: 'block', protocol: 'openvpn', config: { profile: 'client\n' } },
      { id: 'b', name: 'B', enabled: true, onUnavailable: 'block', protocol: 'vless', config: { server: 'x.example.invalid', port: 443, id: 'u', network: 'tcp', security: 'tls' } },
    ],
  };
  const { document, applied } = migrateProfile(structuredClone(stored) as never);

  // 8 since 2026-09-24, when `tunnels[].probe` was removed (plan row G30) — a removal, which is a step.
  // 9 since 2026-10-14, when a subscription became a group — a change of shape, which is a step too.
  assert.equal(PROFILE_SCHEMA_VERSION, 9, 'a new catalogue entry must not move the document version');
  assert.deepEqual(applied, [], 'nothing has to be rewritten for a protocol nobody stored');
  assert.deepEqual(document, stored);

  // And the new branch is genuinely reachable, so the union grew rather than merely compiling.
  assert.equal(
    Value.Check(Tunnel, {
      id: 'ru',
      name: 'Russian proxy',
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
  assert.deepEqual(applied, [
    'a tunnel is asked whether it is alive, not a server behind it',
    'a subscription is a group, and the egress is one id instead of a list',
  ]);
  assert.equal(document['schemaVersion'], 9);
  const tunnels = document['tunnels'] as Record<string, unknown>[];
  assert.equal('probe' in tunnels[0]!, false);
  // Everything else is carried, the resource that was the probe target included.
  // `role` goes too, by the next step (8 → 9).
  const { probe: _gone, role: _role0, ...rest } = (before['tunnels'] as Record<string, unknown>[])[0]!;
  assert.deepEqual(tunnels[0], rest);
  const { role: _role1, ...second } = (before['tunnels'] as Record<string, unknown>[])[1]!;
  assert.deepEqual(tunnels[1], second);
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

/* ── 8 → 9: a subscription is a group ─────────────────────────────────────────────────────── */

const vless = (server: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  server,
  port: 8080,
  id: { $secret: 'uuid' },
  network: 'tcp',
  security: 'none',
  ...extra,
});

/**
 * The bench board's profile as it stood on 2026-10-14, structurally — every id, role, reference and
 * order as read through the API, the credentials replaced.
 */
function boardAtVersion8(): Record<string, unknown> {
  const { groups: _groups, ...current } = emptyProfile({ name: 'CryptoCAT VPN' }) as unknown as Record<string, unknown>;
  const derived = (subscription: string, server: string, port = 8080) => ({ subscription, node: `vless://${server}:${String(port)}` });
  return {
    ...current,
    schemaVersion: 8,
    tunnels: [
      { id: 'germany', name: 'Germany · Frankfurt', role: 'alternative', enabled: true, onUnavailable: 'block', protocol: 'vless', config: vless('5.39.255.51'), derivedFrom: derived('cryptocat', '5.39.255.51') },
      { id: 'france', name: '🇩🇪 Germany · Frankfurt 2', role: 'alternative', enabled: true, onUnavailable: 'block', protocol: 'vless', config: vless('82.21.117.116'), derivedFrom: derived('cryptocat', '82.21.117.116') },
      {
        id: 'collect-vpn', name: 'Collectibles · via VPN', role: 'resource', enabled: true, onUnavailable: 'block', protocol: 'openvpn',
        config: { profile: { $secret: 'client\n' }, via: 'failover' }, resources: { domainSuffix: ['collectibles.internal'], ipCidr: ['10.20.0.0/16'] },
      },
      {
        id: 'oddscp', name: 'Oddscp work', role: 'resource', enabled: true, onUnavailable: 'block', protocol: 'openvpn',
        config: { profile: { $secret: 'client\n' } }, resources: { ipCidr: ['10.8.0.0/24'] },
      },
      { id: 'claude-1', name: 'luwzxe00', role: 'alternative', enabled: false, onUnavailable: 'block', protocol: 'vless', config: vless('82.22.50.101', { port: 51060 }), derivedFrom: derived('claude', '82.22.50.101', 51060) },
      {
        id: 'claude', name: 'Anthropic', role: 'resource', enabled: true, onUnavailable: 'block', protocol: 'vless', config: vless('82.22.50.101'),
        derivedFrom: derived('claude', '82.22.50.101'), resources: { domainSuffix: ['claude.ai', 'anthropic.com'] },
      },
      { id: 'cryptocat-1', name: '🇵🇱 Poland · Warsaw', role: 'alternative', enabled: false, onUnavailable: 'block', protocol: 'vless', config: vless('81.85.73.157'), derivedFrom: derived('cryptocat', '81.85.73.157') },
    ],
    subscriptions: [
      { id: 'cryptocat', name: 'CryptoCAT', enabled: true, url: { $secret: 'http://feed.example/sub/a' }, refreshHours: 1, lastRefresh: { at: '2026-10-13T22:17:07.179Z', ok: true, detail: '3 node(s) offered', nodeCount: 3 } },
      { id: 'claude', name: 'Claude', enabled: true, url: { $secret: 'https://feed.example/sub/b' }, refreshHours: 1 },
    ],
    policy: { ...(current['policy'] as Record<string, unknown>), priority: ['germany', 'france'], excluded: [] },
    routing: {
      ...(current['routing'] as Record<string, unknown>),
      rules: [
        { kind: 'protect-own-networks' },
        { kind: 'tunnel-resources' },
        { kind: 'domainSuffix', suffixes: ['ru'], action: { outbound: 'direct' } },
        { kind: 'domain', domains: ['api.example'], action: { outbound: 'germany' } },
      ],
    },
  };
}

test('version 9: each subscription becomes a group of its derived tunnels, which keep their ids and order', () => {
  const { document, applied, from } = migrateProfile(boardAtVersion8());
  assert.equal(from, 8);
  assert.deepEqual(applied, ['a subscription is a group, and the egress is one id instead of a list']);
  assert.equal(document['schemaVersion'], 9);
  assert.equal('subscriptions' in document, false);

  // Only a person's tunnels remain, without `role` or `derivedFrom`.
  const tunnels = document['tunnels'] as Record<string, unknown>[];
  assert.deepEqual(tunnels.map((tunnel) => tunnel['id']), ['collect-vpn', 'oddscp']);
  for (const tunnel of tunnels) {
    assert.equal('role' in tunnel, false);
    assert.equal('derivedFrom' in tunnel, false);
  }
  // `via: failover` still means the egress, which is now a group.
  assert.equal((tunnels[0]!['config'] as Record<string, unknown>)['via'], 'failover');

  const groups = document['groups'] as Record<string, unknown>[];
  assert.deepEqual(groups.map((group) => group['id']), ['cryptocat', 'claude']);
  const [cryptocat, claude] = groups as [Record<string, unknown>, Record<string, unknown>];
  // Disabled ones too: a group has no disabled members. Same ids, so the same outbound tags and ports.
  assert.deepEqual((cryptocat['members'] as Record<string, unknown>[]).map((member) => member['id']), ['germany', 'france', 'cryptocat-1']);
  // `claude` the member shares an id with `claude` the group, and every id is an outbound tag: the member
  // is renamed, to the first `claude-<n>` nothing uses. Found by a dry run against the board's profile.
  assert.deepEqual((claude['members'] as Record<string, unknown>[]).map((member) => member['id']), ['claude-1', 'claude-2']);
  assert.equal((cryptocat['members'] as Record<string, unknown>[])[0]!['node'], 'vless://5.39.255.51:8080');
  assert.deepEqual(cryptocat['lastRefresh'], { at: '2026-10-13T22:17:07.179Z', ok: true, detail: '3 node(s) offered', nodeCount: 3 });

  // The group whose node carried resources carries them now; the other carries none.
  assert.deepEqual(claude['resources'], { domainSuffix: ['claude.ai', 'anthropic.com'] });
  assert.equal(claude['onUnavailable'], 'block');
  assert.equal('resources' in cryptocat, false);

  // The first of the old order, as its group; the list is gone.
  const policy = document['policy'] as Record<string, unknown>;
  assert.equal(policy['egress'], 'cryptocat');
  assert.equal('priority' in policy, false);
  assert.equal('excluded' in policy, false);

  // A rule that named a derived tunnel names its group.
  const rules = (document['routing'] as Record<string, unknown>)['rules'] as Record<string, unknown>[];
  assert.deepEqual(rules[3], { kind: 'domain', domains: ['api.example'], action: { outbound: 'cryptocat' } });
  assert.deepEqual(rules[2], { kind: 'domainSuffix', suffixes: ['ru'], action: { outbound: 'direct' } });

  assertProfileDocument(document);
});

test('version 9: the egress skips an excluded or disabled alternative, and a hand-authored one stays a tunnel', () => {
  const before = boardAtVersion8();
  const tunnels = before['tunnels'] as Record<string, unknown>[];
  tunnels.unshift({ id: 'hq', name: 'HQ', role: 'alternative', enabled: true, onUnavailable: 'block', protocol: 'openvpn', config: { profile: { $secret: 'client\n' } }, resources: { ipCidr: ['192.0.2.0/24'] } });
  (before['policy'] as Record<string, unknown>)['priority'] = ['germany', 'hq'];
  (before['policy'] as Record<string, unknown>)['excluded'] = ['germany'];
  const { document } = migrateProfile(before);
  assert.equal((document['policy'] as Record<string, unknown>)['egress'], 'hq');
  const hq = (document['tunnels'] as Record<string, unknown>[]).find((tunnel) => tunnel['id'] === 'hq')!;
  // An alternative's resources were never routed; kept, they would make it a resource under schema 9.
  assert.equal('resources' in hq, false);
  assertProfileDocument(document);
});

test('a document at version 9 that still names a removed field is refused by name', () => {
  const current = migrateProfile(boardAtVersion8()).document;
  (current['tunnels'] as Record<string, unknown>[])[0]!['role'] = 'resource';
  assert.equal(profileFaults(current)[0]!.code, 'tunnel_field_removed');
  assert.equal(profileFaults(current)[0]!.pointer, '/tunnels/0/role');

  const withList = migrateProfile(boardAtVersion8()).document;
  (withList['policy'] as Record<string, unknown>)['priority'] = ['cryptocat'];
  assert.equal(profileFaults(withList)[0]!.code, 'field_removed');
  assert.equal(profileFaults(withList)[0]!.pointer, '/policy/priority');
});
