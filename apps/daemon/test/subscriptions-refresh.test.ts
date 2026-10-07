/**
 * Refreshing a subscription — the one path where the device edits its own configuration unasked.
 *
 * Every test here is about what an unattended edit is **not** allowed to do.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile, type ProfileDocument, type Tunnel } from '@wayfarer/schemas';
import type { ParsedNode } from '@wayfarer/protocols';
import { refreshMayApply, refreshSubscription } from '../src/core/subscriptions.ts';

function node(server: string, port: number, label: string): ParsedNode {
  return {
    scheme: 'vless',
    label,
    protocol: 'vless',
    config: { server, port, id: 'u', network: 'tcp', security: 'tls' },
  };
}

/**
 * The caller's job: naming, and placing a parsed node into a tunnel.
 *
 * Deliberately simple here. `refreshSubscription` takes this as a parameter precisely so that naming is
 * somebody else's decision and these tests are about the refresh rules alone. Since E5 the translation
 * from a link to a catalogue configuration happens in the parser, so what arrives here is already a
 * `VlessConfig` — the caller decides the id, the name and the role, and nothing else.
 */
const toTunnel = (parsed: ParsedNode, existing: Tunnel | undefined): Tunnel => {
  // The narrowing is the point of the union: the protocol and the configuration travel together, so a
  // caller reading a VLESS field must first establish that it has a VLESS node. Every node these tests
  // make is one; a future catalogue entry that arrives from a link gets its own arm here.
  if (parsed.protocol !== 'vless') assert.fail(`this fixture only makes vless nodes, got ${parsed.protocol}`);
  return {
    id: existing?.id ?? `sub-${parsed.config.server}`.replace(/[^a-z0-9-]/g, '-'),
    name: parsed.label ?? 'unnamed',
    role: 'alternative',
    onUnavailable: 'block' as const,
    enabled: true,
    protocol: parsed.protocol,
    config: parsed.config,
  };
};

function documentWith(
  tunnels: Tunnel[],
  policy?: { priority?: string[]; excluded?: string[] },
  /**
   * Routing rules. Defaulted to empty here, and **that default is why this path had no coverage**: no
   * fixture ever set it, so every test asserted against a document whose rules referenced nothing.
   */
  rules?: unknown[],
): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' }) as unknown as ProfileDocument;
  return {
    ...base,
    tunnels,
    policy: { ...base.policy, priority: policy?.priority ?? [], excluded: policy?.excluded ?? [] },
    routing: { ...base.routing, rules: (rules ?? []) as never },
  };
}

const derived = (id: string, identity: string, name = id): Tunnel => ({
  id,
  name,
  role: 'alternative', onUnavailable: 'block' as const,
  enabled: true,
  protocol: 'vless',
  config: {
    server: identity.split('://')[1]?.split(':')[0] ?? 'x',
    port: 443,
    id: 'u',
    network: 'tcp',
    security: 'tls',
  },
  derivedFrom: { subscription: 'feed', node: identity },
});

test('a hand-authored tunnel is never touched, whatever the feed says', () => {
  const byHand: Tunnel = {
    id: 'hq',
    name: 'HQ',
    role: 'alternative', onUnavailable: 'block' as const,
    enabled: true,
    protocol: 'openvpn',
    config: { profile: 'client\ndev tun\n' },
  };
  const result = refreshSubscription({
    document: documentWith([byHand]),
    subscriptionId: 'feed',
    nodes: [node('a.example', 443, 'A')],
    toTunnel,
  });

  const kept = result.document.tunnels.find((tunnel) => tunnel.id === 'hq');
  assert.deepEqual(
    kept,
    byHand,
    'a refresh that can alter a tunnel nobody derived is a refresh that deletes somebody work while ' +
      'they are asleep',
  );
  assert.deepEqual(result.leftAlone, ['hq']);
});

test('a tunnel derived from a different subscription is left alone too', () => {
  const other = derived('other-feed-node', 'vless://b.example:443', 'Other');
  other.derivedFrom = { subscription: 'a-different-feed', node: 'vless://b.example:443' };
  const result = refreshSubscription({
    document: documentWith([other]),
    subscriptionId: 'feed',
    nodes: [],
    toTunnel,
  });
  assert.ok(result.document.tunnels.some((tunnel) => tunnel.id === 'other-feed-node'));
  assert.deepEqual(result.removed, []);
});

test('a node the feed dropped is removed when nothing references it', () => {
  const gone = derived('gone', 'vless://old.example:443');
  const result = refreshSubscription({
    document: documentWith([gone]),
    subscriptionId: 'feed',
    nodes: [node('new.example', 443, 'New')],
    toTunnel,
  });
  assert.deepEqual(result.removed, ['gone']);
  assert.equal(result.document.tunnels.some((tunnel) => tunnel.id === 'gone'), false);
});

test('a node the feed dropped is KEPT when policy names it, and policy is not re-pointed', () => {
  const referenced = derived('chosen', 'vless://old.example:443', 'The one they picked');
  const before = documentWith([referenced], { priority: ['chosen'] });
  const result = refreshSubscription({
    document: before,
    subscriptionId: 'feed',
    nodes: [node('new.example', 443, 'A substitute')],
    toTunnel,
  });

  assert.deepEqual(result.keptBecauseReferenced, ['chosen']);
  assert.ok(result.document.tunnels.some((tunnel) => tunnel.id === 'chosen'), 'the old definition stays');
  assert.deepEqual(
    result.document.policy.priority,
    ['chosen'],
    'sending traffic somewhere the operator did not choose is worse than a tunnel being down: a tunnel ' +
      'that is down is visible, one silently re-pointed is not',
  );
  assert.match(result.notes[0]!, /nothing has been re-pointed/);
});

test('an excluded node counts as referenced: policy names it in either list', () => {
  const result = refreshSubscription({
    document: documentWith([derived('parked', 'vless://old.example:443')], { excluded: ['parked'] }),
    subscriptionId: 'feed',
    nodes: [],
    toTunnel,
  });
  assert.deepEqual(result.keptBecauseReferenced, ['parked']);
});

test('a renamed node is an update, not a delete and an add', () => {
  // Identity is server, port and protocol. A provider renaming a node must not break policy that
  // named the old id.
  const existing = derived('stable-id', 'vless://a.example:443', 'Old name');
  const result = refreshSubscription({
    document: documentWith([existing], { priority: ['stable-id'] }),
    subscriptionId: 'feed',
    nodes: [node('a.example', 443, 'Brand new marketing name')],
    toTunnel,
  });
  assert.deepEqual(result.added, [], 'a rename must not look like an arrival');
  assert.deepEqual(result.removed, []);
  assert.ok(result.document.tunnels.some((tunnel) => tunnel.id === 'stable-id'), 'the id survives the rename');
});

test('policy is never edited by a refresh, in any direction', () => {
  const before = documentWith([derived('a', 'vless://a.example:443')], {
    priority: ['a', 'something-else'],
    excluded: ['parked'],
  });
  const result = refreshSubscription({
    document: before,
    subscriptionId: 'feed',
    nodes: [node('a.example', 443, 'A'), node('b.example', 443, 'B')],
    toTunnel,
  });
  assert.deepEqual(result.document.policy, before.policy, 'a feed may supply exits, not choose between them');
});

test('the derived mark survives every refresh', () => {
  const result = refreshSubscription({
    document: documentWith([]),
    subscriptionId: 'feed',
    nodes: [node('a.example', 443, 'A')],
    toTunnel,
  });
  const fresh = result.document.tunnels[0]!;
  assert.deepEqual(fresh.derivedFrom, { subscription: 'feed', node: 'vless://a.example:443' });
});

test('a timer may apply a service change and must stop at a network one', () => {
  assert.equal(refreshMayApply('hot'), true);
  assert.equal(refreshMayApply('service'), true);
  // There is nobody at four in the morning to say "yes, I can still reach this", and an unconfirmed
  // network change reverts three minutes later — so a timer that applied one would take the device
  // down and put it back, repeatedly.
  assert.equal(refreshMayApply('network'), false);
  assert.equal(refreshMayApply('boot'), false);
});

/* ── a routing rule is a reference too ───────────────────────────────────────────────────── */

test('a node a routing rule still names is kept, exactly as a policy reference is', () => {
  /*
   * The combination this prevents is the worst available: the tunnel is deleted, the cross-reference
   * invariant then raises an error, the plan becomes unusable, and the subscription is stuck — with the
   * tunnel already gone. An irreversible deletion followed by a refusal to proceed.
   */
  const referenced = derived('chosen', 'vless://old.example:443', 'Named by a rule');
  const before = documentWith([referenced], {}, [
    { kind: 'domain', domains: ['intranet.example'], action: { outbound: 'chosen' } },
  ]);

  const result = refreshSubscription({
    document: before,
    subscriptionId: 'feed',
    nodes: [node('new.example', 443, 'A substitute')],
    toTunnel,
  });

  assert.deepEqual(result.keptBecauseReferenced, ['chosen']);
  assert.deepEqual(result.removed, []);
  assert.ok(result.document.tunnels.some((tunnel) => tunnel.id === 'chosen'), 'the old definition stays');
  assert.match(result.notes[0]!, /nothing has been re-pointed/);
});

test('a reference from any rule kind counts, because the field is what names a tunnel', () => {
  // Read off `action.outbound` wherever it appears rather than from a list of kinds that have one: such
  // a list is a second description of the schema and stops covering a kind added later.
  for (const rule of [
    { kind: 'private', action: { outbound: 'chosen' } },
    { kind: 'ruleSet', sets: ['ads'], action: { outbound: 'chosen' } },
    { kind: 'domain', domains: ['x.example'], action: { outbound: 'chosen' } },
  ]) {
    const result = refreshSubscription({
      document: documentWith([derived('chosen', 'vless://old.example:443')], {}, [rule]),
      subscriptionId: 'feed',
      nodes: [],
      toTunnel,
    });
    assert.deepEqual(result.keptBecauseReferenced, ['chosen'], `rule kind ${rule.kind} should count`);
  }
});

test('a rule naming something else does not protect an unrelated node', () => {
  const result = refreshSubscription({
    document: documentWith([derived('gone', 'vless://old.example:443')], {}, [
      { kind: 'domain', domains: ['x.example'], action: { outbound: 'direct' } },
    ]),
    subscriptionId: 'feed',
    nodes: [],
    toTunnel,
  });
  assert.deepEqual(result.removed, ['gone'], 'nothing references it, so it goes');
});
