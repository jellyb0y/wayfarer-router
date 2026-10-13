/**
 * Groups, schema 9: a subscription's nodes are one group, chosen among by the watchdog.
 *
 * What these pin is the wiring that lets everything else stay unchanged — a group is reached by its id
 * exactly as a tunnel is, its members are planned as tunnels, and the invariants see one namespace.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile, generateRoutingRules, type Group, type ProfileDocument } from '@wayfarer/schemas';
import { generateCoreConfig } from '../src/core/generate/core-config.ts';
import { checkInvariants } from '../src/core/invariants.ts';
import { withMembersAsTunnels } from '../src/core/groups.ts';
import { guardedTunnels } from '../src/core/watchdog.ts';

const member = (id: string, server: string): Group['members'][number] => ({
  id,
  name: id,
  node: `vless://${server}:443`,
  protocol: 'vless',
  config: { server, port: 443, id: 'u', network: 'tcp', security: 'tls' },
});

function profile(extra: Partial<ProfileDocument> = {}): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' });
  return {
    ...base,
    groups: [
      { id: 'main', name: 'Main', enabled: true, url: 'https://a.example/sub', refreshHours: 1, onUnavailable: 'block', members: [member('de', 'de.example'), member('pl', 'pl.example')] },
      {
        id: 'claude', name: 'Claude', enabled: true, url: 'https://b.example/sub', refreshHours: 1, onUnavailable: 'block',
        resources: { domainSuffix: ['claude.ai'] }, members: [member('c1', 'c.example')],
      },
    ],
    policy: { ...base.policy, egress: 'main' },
    ...extra,
  };
}

function config(document: ProfileDocument): { tag?: string; type?: string; outbounds?: string[]; default?: string }[] {
  // As the planner hands it: the document with the members among the tunnels.
  const expanded = withMembersAsTunnels(document);
  const generated = generateCoreConfig({
    profile: expanded,
    interfaces: { accessPoint: 'wlx0', uplinks: new Map() },
    emitted: new Map(
      expanded.tunnels.map((tunnel) => [tunnel.id, { target: 'outbounds', object: { type: 'vless', tag: tunnel.id } }]),
    ) as never,
    tunnelDns: new Map(),
    uplinkNetworks: [],
  });
  return generated['outbounds'] as never;
}

test('each group is a selector tagged with its id, holding its members and block', () => {
  const outbounds = config(profile());
  const main = outbounds.find((entry) => entry.tag === 'main')!;
  assert.equal(main.type, 'selector');
  assert.deepEqual(main.outbounds, ['de', 'pl', 'block']);
  assert.equal(main.default, 'de');
  // Every member is an outbound of its own, which the watchdog probes and the selector chooses among.
  for (const id of ['de', 'pl', 'c1']) assert.ok(outbounds.some((entry) => entry.tag === id), id);
});

test('the main selector holds the egress group and the fallback, and nothing else', () => {
  const selector = config(profile()).find((entry) => entry.tag === 'wf-selector')!;
  assert.deepEqual(selector.outbounds, ['main', 'block']);
  assert.equal(selector.default, 'main');
});

test('a resource group is reached through a guard that wraps its selector', () => {
  const document = profile();
  const guard = config(document).find((entry) => entry.tag === 'wf-guard-claude')!;
  assert.deepEqual(guard.outbounds, ['claude', 'block']);
  const rules = generateRoutingRules(document, { uplinkInterfaces: [], uplinkNetworks: [] });
  assert.ok(rules.some((entry) => JSON.stringify(entry.rule) === JSON.stringify({ domain_suffix: ['claude.ai'], outbound: 'wf-guard-claude' })));
});

test('a member that was not planned is not in its group selector', () => {
  const document = profile();
  // As the planner hands it: the document with the members among the tunnels.
  const expanded = withMembersAsTunnels(document);
  const generated = generateCoreConfig({
    profile: expanded,
    interfaces: { accessPoint: 'wlx0', uplinks: new Map() },
    emitted: new Map(
      expanded.tunnels.filter((tunnel) => tunnel.id !== 'pl').map((tunnel) => [tunnel.id, { target: 'outbounds', object: { type: 'vless', tag: tunnel.id } }]),
    ) as never,
    tunnelDns: new Map(),
    uplinkNetworks: [],
  });
  const main = (generated['outbounds'] as { tag?: string; outbounds?: string[] }[]).find((entry) => entry.tag === 'main')!;
  assert.deepEqual(main.outbounds, ['de', 'block']);
});

test('members are planned after the person’s tunnels, so a feed never moves a tunnel’s port', () => {
  const document = profile({
    tunnels: [{ id: 'hq', name: 'HQ', enabled: true, onUnavailable: 'block', protocol: 'openvpn', config: { profile: 'client\n' } } as never],
  });
  assert.deepEqual(withMembersAsTunnels(document).tunnels.map((tunnel) => tunnel.id), ['hq', 'de', 'pl', 'c1']);
  // A disabled group's members are not planned at all.
  const off = { ...document, groups: document.groups.map((group) => (group.id === 'claude' ? { ...group, enabled: false } : group)) };
  assert.deepEqual(withMembersAsTunnels(off).tunnels.map((tunnel) => tunnel.id), ['hq', 'de', 'pl']);
});

test('a resource group is guarded through its own selector, by the VLESS liveness its members have', () => {
  const guards = guardedTunnels(profile(), { interfaces: new Map() });
  assert.deepEqual(guards.map((guard) => [guard.tunnelId, guard.selector]), [['claude', 'wf-guard-claude']]);
  assert.notEqual(guards[0]!.method.kind, 'none');
});

function findings(document: ProfileDocument): { code: string; pointer: string }[] {
  return checkInvariants({
    profile: document as never,
    bindings: new Map(),
    inventory: { interfaces: [], radios: [], binaries: [] } as never,
    facts: { foreignCores: [], interfaceClaims: [], managementInterfaces: [], binaries: [], uplinkNetworks: [] } as never,
  }).map((finding) => ({ code: finding.code, pointer: finding.pointer ?? '' }));
}

test('tunnels, groups and members share one namespace of ids', () => {
  const document = profile({
    tunnels: [{ id: 'pl', name: 'Hand', enabled: true, onUnavailable: 'block', protocol: 'openvpn', config: { profile: 'client\n' } } as never],
  });
  assert.ok(findings(document).some((entry) => entry.code === 'duplicate_tunnel_id' && entry.pointer === '/groups/0/members/1/id'));
});

test('the egress must name a tunnel or group that exists; a rule and a via may name a group', () => {
  const base = profile();
  assert.ok(findings({ ...base, policy: { ...base.policy, egress: 'nowhere' } }).some((entry) => entry.code === 'unknown_tunnel_reference' && entry.pointer === '/policy/egress'));

  const routed = profile({
    tunnels: [{ id: 'hq', name: 'HQ', enabled: true, onUnavailable: 'block', protocol: 'openvpn', config: { profile: 'client\n', via: 'claude' } } as never],
  });
  routed.routing = { ...routed.routing, rules: [...routed.routing.rules, { kind: 'domain', domains: ['x.example'], action: { outbound: 'main' } }] };
  const codes = findings(routed).map((entry) => entry.code);
  assert.equal(codes.includes('unknown_tunnel_reference'), false);
  assert.equal(codes.some((code) => code.startsWith('tunnel_via')), false);
});

test('a transaction recorded under schema 8 is read back in the current shape, so nothing plans it with no egress', async () => {
  const { openDatabase } = await import('../src/state/db.ts');
  const { createProfileStore } = await import('../src/state/profiles.ts');
  const { createSecretPlan } = await import('../src/state/secret-plan.ts');
  const database = openDatabase({ path: ':memory:' });
  try {
    const profiles = createProfileStore(database, createSecretPlan());
    const { groups: _groups, ...current } = emptyProfile({ name: 'Old' }) as unknown as Record<string, unknown>;
    const atEight = {
      ...current,
      schemaVersion: 8,
      tunnels: [
        {
          id: 'de', name: 'DE', role: 'alternative', enabled: true, onUnavailable: 'block', protocol: 'vless',
          config: { server: 'de.example', port: 443, id: { $secret: 'u' }, network: 'tcp', security: 'tls' },
          derivedFrom: { subscription: 'feed', node: 'vless://de.example:443' },
        },
      ],
      subscriptions: [{ id: 'feed', name: 'Feed', enabled: true, url: { $secret: 'https://feed.example/s' }, refreshHours: 1 }],
      policy: { ...(current['policy'] as Record<string, unknown>), priority: ['de'], excluded: [] },
    };
    const transaction = profiles.createTransaction({ profileId: null, documentBefore: atEight, documentAfter: atEight, kind: 'apply', blastRadius: 'service', plan: {} });
    profiles.setTransactionState(transaction.id, 'applying');
    profiles.setTransactionState(transaction.id, 'committed');
    const applied = profiles.lastAppliedDocument() as ProfileDocument;
    assert.equal(applied.schemaVersion, 9);
    assert.equal(applied.policy.egress, 'feed');
    assert.deepEqual(applied.groups[0]!.members.map((entry) => entry.id), ['de']);
    assert.equal((profiles.transaction(transaction.id)!.documentBefore as ProfileDocument).policy.egress, 'feed');
  } finally {
    database.close();
  }
});
