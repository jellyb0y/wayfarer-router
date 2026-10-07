/**
 * The probe destinations are blocked on every path except the probe's own.
 *
 * This is the point of the rule rather than a side effect. A probe answers one question — *does this
 * tunnel carry traffic?* — and the answer is only worth having if nothing else can reach the endpoint.
 * Left reachable, a client's own captive-portal check reaches the same host, and a person looking at
 * the network cannot tell a working tunnel from a device passing traffic around it.
 *
 * The device's own probe still gets through, and not by an exemption: the core's per-outbound delay test
 * dials through the named outbound and does not consult routing rules at all.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  CORE_TAGS,
  DEVICE_TUN_NETWORK,
  emptyProfile,
  generateRoutingRules,
  probeEndpointHosts,
} from '@wayfarer/schemas';
import { checkInvariants } from '../src/core/invariants.ts';

const context = { uplinkInterfaces: [], uplinkNetworks: [] };

function rulesFor(profile: ReturnType<typeof emptyProfile>) {
  return generateRoutingRules(profile, context);
}

test('the probe hosts are blocked for this device only, never for a client', () => {
  /*
   * The scoping is the assertion, not a detail of it.
   *
   * Probe destinations are connectivity-check hosts — the ones a phone asks before deciding whether a
   * network works. Blocked for clients, a working network reports itself as dead: the phone shows "No
   * Internet" and leaves for cellular. That is indistinguishable from a broken tunnel to the person
   * holding it, and it contaminates every test they run.
   *
   * The naive reading that produced it was "these hosts are blocked, therefore block them". The list is
   * not a list of hosts to block; it is a list of hosts whose reachability must mean something specific
   * *for this device*.
   */
  const profile = emptyProfile();
  const hosts = probeEndpointHosts(profile);
  assert.deepEqual(hosts, ['cp.cloudflare.com', 'connectivitycheck.gstatic.com']);

  const blocked = rulesFor(profile).find(
    (entry) => (entry.rule as { outbound?: string } | null)?.outbound === CORE_TAGS.block,
  );
  assert.ok(blocked?.rule, 'a block rule should be emitted for the probe destinations');
  assert.deepEqual((blocked.rule as { domain?: string[] }).domain, hosts);

  // The whole point: it matches the device's own source, so a forwarded client is untouched.
  assert.deepEqual(
    (blocked.rule as { source_ip_cidr?: string[] }).source_ip_cidr,
    [DEVICE_TUN_NETWORK],
    'a probe block with no source scope blocks every client from its captivity check',
  );

  // Ours, not the profile's: the interface shows it as fixed and does not offer to move it.
  assert.equal(blocked.fromIndex, null);
  // And it says why, because a rule nobody can explain is a rule somebody deletes.
  assert.match(blocked.summary, /nothing except the probe itself can reach it|except the probe itself/);
  assert.match(blocked.summary, /Clients are deliberately NOT blocked/);
});

test("an operator's blocked endpoint applies to clients as well, unlike a probe host", () => {
  // Two lists, two paths. The operator asked for a block; exempting clients would not be that block.
  const profile = emptyProfile();
  profile.firewall.blockedEndpoints = [{ domain: 'tracker.example', note: 'policy' }];

  const rules = rulesFor(profile).filter(
    (entry) => (entry.rule as { outbound?: string } | null)?.outbound === CORE_TAGS.block,
  );
  const operator = rules.find((entry) => (entry.rule as { domain: string[] }).domain.includes('tracker.example'));
  assert.ok(operator, 'the operator block must be emitted');
  assert.equal(
    (operator.rule as { source_ip_cidr?: string[] }).source_ip_cidr,
    undefined,
    'an operator block is not scoped to the device',
  );

  const probes = rules.find((entry) => (entry.rule as { source_ip_cidr?: string[] }).source_ip_cidr !== undefined);
  assert.ok(probes, 'the probe block must still be emitted, and still scoped');
  assert.ok(!(probes.rule as { domain: string[] }).domain.includes('tracker.example'));
});

test('an exact name, never a suffix, because the core matches suffixes literally', () => {
  /*
   * `domain_suffix` in the core is a literal string suffix, so blocking `example.com` as a suffix also
   * blocks `notexample.com`. This repository documents that trap for the `domain` rule kind and then
   * committed it in the blocked-endpoints generator, where a block on one address-discovery host
   * silently became a block on every host whose name ended the same way.
   */
  const profile = emptyProfile();
  profile.firewall.blockedEndpoints = [{ domain: 'example.com', note: 'address discovery' }];
  const blocked = rulesFor(profile).find(
    (entry) => (entry.rule as { outbound?: string } | null)?.outbound === CORE_TAGS.block,
  )!;
  assert.ok(!('domain_suffix' in blocked.rule!), 'a blocked endpoint must not be matched as a suffix');
  assert.ok((blocked.rule as { domain: string[] }).domain.includes('example.com'));
});

test('a host named in both places appears once', () => {
  // Two copies of one set is the shape this project fails in; the rule is derived from both and deduped.
  const profile = emptyProfile();
  profile.firewall.blockedEndpoints = [{ domain: 'cp.cloudflare.com' }];
  const blocked = rulesFor(profile).find(
    (entry) => (entry.rule as { outbound?: string } | null)?.outbound === CORE_TAGS.block,
  )!;
  const domains = (blocked.rule as { domain: string[] }).domain;
  assert.equal(domains.filter((entry) => entry === 'cp.cloudflare.com').length, 1);
});

test('an unparseable endpoint contributes no rule rather than a guessed host', () => {
  const profile = emptyProfile();
  profile.policy.probes.endpoints = ['not a url', 'http://good.example/204'];
  assert.deepEqual(probeEndpointHosts(profile), ['good.example']);
});

test('a draft with no probes at all does not throw', () => {
  // The interface previews these rules from a document somebody is halfway through editing.
  const partial = { policy: {}, firewall: { blockedEndpoints: [] } } as never;
  assert.deepEqual(probeEndpointHosts(partial), []);
});

/* ── rule sets ───────────────────────────────────────────────────────────────────────────── */

function findingsFor(profile: ReturnType<typeof emptyProfile>) {
  return checkInvariants({
    profile: profile as never,
    bindings: new Map(),
    inventory: { interfaces: [], radios: [], binaries: [] } as never,
    facts: { foreignCores: [], interfaceClaims: [], managementInterfaces: [], binaries: [], uplinkNetworks: [] } as never,
  });
}

test('a rule set the core cannot obtain is refused, and the message says what it costs', () => {
  /*
   * Not a tidiness check. The core resolves every rule set at start-up and a failure is fatal to the
   * whole process — so this does not degrade into "that rule matches nothing", it takes the tunnels, the
   * access point's routing and the management exemptions with it, and the symptom is a unit that will not
   * start for reasons that never mention the rule set.
   */
  const profile = emptyProfile();
  profile.routing.ruleSets = [{ tag: 'geoip', type: 'remote' }];
  const found = findingsFor(profile).find((entry) => entry.code === 'rule_set_unfetchable');
  assert.ok(found);
  assert.equal(found.severity, 'error');
  assert.equal(found.pointer, '/routing/ruleSets/0/url');
  assert.match(found.message, /stops the core starting altogether/);
  assert.match(found.hint, /change its type to "local"/);
});

test('a local rule set with no path is refused too', () => {
  const profile = emptyProfile();
  profile.routing.ruleSets = [{ tag: 'mine', type: 'local' }];
  const found = findingsFor(profile).find((entry) => entry.code === 'rule_set_unfetchable');
  assert.ok(found);
  assert.equal(found.pointer, '/routing/ruleSets/0/path');
});

test('two rule sets with one tag is refused, because nothing says which one a rule gets', () => {
  const profile = emptyProfile();
  profile.routing.ruleSets = [
    { tag: 'geoip', type: 'remote', url: 'https://example.invalid/a.srs' },
    { tag: 'geoip', type: 'remote', url: 'https://example.invalid/b.srs' },
  ];
  const found = findingsFor(profile).find((entry) => entry.code === 'duplicate_rule_set_tag');
  assert.ok(found);
  assert.equal(found.pointer, '/routing/ruleSets/1/tag');
});

test('a remote rule set on a profile with no uplink is a warning that names the confusing failure', () => {
  /*
   * A warning rather than an error: it is a legitimate configuration on a device with a working uplink,
   * and refusing it would make the feature unusable. But the failure it predicts is the confusing kind —
   * the core does not start, nothing mentions the rule set, and the device looks broken in a way
   * unrelated to what was just changed.
   */
  const profile = emptyProfile();
  profile.routing.ruleSets = [{ tag: 'geoip', type: 'remote', url: 'https://example.invalid/a.srs' }];
  const found = findingsFor(profile).find((entry) => entry.code === 'rule_set_needs_uplink');
  assert.ok(found);
  assert.equal(found.severity, 'warning');
  assert.match(found.message, /will not start at all/);
  assert.match(found.hint, /needs no network/);
});

test('a coherent rule set raises nothing', () => {
  // Asserting the silence matters as much as asserting the refusal: an invariant that fires on a
  // legitimate configuration teaches operators to ignore invariants.
  const profile = emptyProfile();
  profile.uplinks = [
    { id: 'wan', kind: 'wifi-sta', priority: 10, enabled: true, bind: { by: 'phy-builtin' }, config: { ssid: 'x', psk: 'y', dhcp: true } },
  ] as never;
  profile.routing.ruleSets = [{ tag: 'geoip', type: 'remote', url: 'https://example.invalid/a.srs' }];
  const codes = findingsFor(profile)
    .filter((entry) => entry.code.startsWith('rule_set') || entry.code === 'duplicate_rule_set_tag')
    .map((entry) => entry.code);
  assert.deepEqual(codes, []);
});

/* ── every generated routing rule must be a rule ─────────────────────────────────────────── */

test('no generated routing rule is empty, and every one names an action', async () => {
  /*
   * The defect this exists to prevent, found by a client rather than by a test:
   *
   *   ERROR router: outbound not found:
   *
   * The `tunnel-resources` anchor, when no resource tunnel declares any resources — which is the default and
   * was true of every profile on the bench — pushed `rule: {}` so the *preview* could show a row saying
   * "nothing here". The same structure feeds the generated configuration, so an empty object went into the
   * routing list. The core matches an empty rule against **everything** and then fails to resolve an
   * outbound, and every client connection was reset.
   *
   * It was invisible from both ends: an empty object does not look wrong in a configuration, and in the
   * preview it rendered as the sentence it was meant to be. Only a client trying to reach the internet showed
   * it.
   *
   * Asserted over the generated configuration rather than over the helper, because the helper is allowed to
   * produce notes and the configuration is not.
   */
  const { generateCoreConfig } = await import('../src/core/generate/core-config.ts');
  const profile = emptyProfile();

  const config = generateCoreConfig({
    profile,
    interfaces: { accessPoint: 'wlanap', uplinks: new Map([['wan', 'wfwan0']]) },
    emitted: new Map(),
    tunnelDns: new Map(),
    uplinkNetworks: ['192.168.1.0/24'],
  }) as { route: { rules: Record<string, unknown>[] } };

  assert.ok(config.route.rules.length > 0, 'there should be rules');
  for (const [index, rule] of config.route.rules.entries()) {
    assert.ok(Object.keys(rule).length > 0, `routing rule ${index} is empty and would match everything`);
    const hasAction = 'outbound' in rule || 'action' in rule;
    assert.ok(hasAction, `routing rule ${index} names no outbound and no action: ${JSON.stringify(rule)}`);
  }
});

test('the anchor that contributes nothing is still shown in the preview', () => {
  // The note has to survive, or the operator sees a rule in their list that has simply vanished.
  const profile = emptyProfile();
  const entries = generateRoutingRules(profile, { uplinkInterfaces: [], uplinkNetworks: [] });
  const note = entries.find((entry) => entry.rule === null);
  assert.ok(note, 'the tunnel-resources anchor should still produce a preview row');
  assert.match(note.summary, /no enabled resource tunnel declares any resources/);
});

/* ── the resolver clients are told to use must exist ─────────────────────────────────────── */

test('the address service answers DNS on the interface it advertises itself on', async () => {
  /*
   * The defect this exists to prevent reached a user, and it is the sharpest "verified the wrong path"
   * instance in this project.
   *
   * The generator used to set `port=0` — no resolver — while advertising this device as the resolver in
   * DHCP option 6, on the stated basis that the proxy core would answer instead. The core's only inbound is
   * a `tun` with `auto_route`, which captures traffic being **forwarded**; a query addressed to the device
   * itself is *input*, so it was never captured and nothing was listening on port 53 at all.
   *
   * Measured with a real client: associated, authorised, valid lease, default route, and a resolver that
   * answered nothing. "No site loads" is exactly what that looks like from a phone.
   *
   * So: if option 6 names this device, this device must actually answer.
   */
  const { generateDhcp } = await import('../src/core/generate/dhcp.ts');
  const profile = emptyProfile();
  const config = generateDhcp({ profile, interfaceName: 'wlanap' });

  const advertisesSelf = config.includes(`dhcp-option=6,${profile.network.cidr.split('/')[0]}`);
  assert.ok(advertisesSelf, 'the generator should advertise this device as the resolver');

  assert.ok(!/^port=0$/m.test(config), 'a device that advertises itself as the resolver must not disable its resolver');
  assert.match(config, /^no-resolv$/m, 'it must never fall back to the host resolver, which bypasses the core');
  assert.match(config, new RegExp(`^server=${profile.dns.overTunnel.replace(/\./g, '\\.')}$`, 'm'));
  // No second cache: a stale answer from a forgotten layer is read as a broken tunnel.
  assert.match(config, /^cache-size=0$/m);
  // And still bound to the one interface, so this resolver is not offered to the uplink or the lifeline.
  assert.match(config, /^interface=wlanap$/m);
  assert.match(config, /^bind-interfaces$/m);
});
