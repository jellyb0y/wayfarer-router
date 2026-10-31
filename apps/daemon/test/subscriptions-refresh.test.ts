/**
 * Refreshing a group: its members become what its subscription offers.
 *
 * Since schema 9 there are no guesses left to test — no kept, re-pointed or disabled node — only that the
 * members follow the feed, that a member keeps its id and place while the feed keeps it, and that nothing
 * outside the group moves.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile, type Group, type ProfileDocument } from '@wayfarer/schemas';
import type { ParsedNode } from '@wayfarer/protocols';
import { refreshGroup, refreshMayApply } from '../src/core/subscriptions.ts';

function node(server: string, label: string, id = 'u'): ParsedNode {
  return { scheme: 'vless', label, protocol: 'vless', config: { server, port: 443, id, network: 'tcp', security: 'tls' } };
}

const member = (id: string, server: string, account = 'u'): Group['members'][number] => ({
  id,
  name: id,
  node: `vless://${server}:443?security=tls&type=tcp`,
  protocol: 'vless',
  config: { server, port: 443, id: { $secret: account } as never, network: 'tcp', security: 'tls' },
});

function documentWith(members: Group['members'], extra: Partial<ProfileDocument> = {}): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' });
  return {
    ...base,
    groups: [{ id: 'feed', name: 'Feed', enabled: true, url: 'https://feed.example/sub', refreshHours: 1, onUnavailable: 'block', members }],
    policy: { ...base.policy, egress: 'feed' },
    ...extra,
  };
}

test('a node the feed dropped leaves the group, and nothing else is touched', () => {
  const before = documentWith([member('de', 'de.example'), member('fr', 'fr.example')]);
  const result = refreshGroup({ document: before, groupId: 'feed', nodes: [node('de.example', 'DE')] });
  assert.deepEqual(result.removed, ['fr']);
  assert.deepEqual(result.document.groups[0]!.members.map((entry) => entry.id), ['de']);
  // The egress names the group, not a member, so it never needs to follow a refresh.
  assert.deepEqual(result.document.policy, before.policy);
  assert.deepEqual(result.document.tunnels, before.tunnels);
});

test('a new node joins at the end with a fresh id, and is a member at once — not a disabled extra', () => {
  const before = documentWith([member('de', 'de.example')]);
  const result = refreshGroup({ document: before, groupId: 'feed', nodes: [node('new.example', '🇵🇱 Poland · Warsaw'), node('de.example', 'DE')] });
  assert.deepEqual(result.added, ['feed-1']);
  const members = result.document.groups[0]!.members;
  assert.deepEqual(members.map((entry) => entry.id), ['de', 'feed-1'], 'the existing member keeps its place, and with it its port');
  assert.equal(members[1]!.name, '🇵🇱 Poland · Warsaw');
  assert.equal(members[1]!.node, 'vless://new.example:443?security=tls&type=tcp');
});

test('a fresh id avoids every id in the document: tunnels, groups and members', () => {
  const before = documentWith([member('feed-1', 'one.example')], {
    tunnels: [{ id: 'feed-2', name: 'Hand', enabled: true, onUnavailable: 'block', protocol: 'openvpn', config: { profile: 'client\n' } } as never],
  });
  const result = refreshGroup({ document: before, groupId: 'feed', nodes: [node('one.example', 'One'), node('two.example', 'Two')] });
  assert.deepEqual(result.added, ['feed-3']);
});

test('a renamed node is an update in place, matched by its endpoint rather than its label', () => {
  const before = documentWith([member('de', 'de.example')]);
  const result = refreshGroup({ document: before, groupId: 'feed', nodes: [node('de.example', 'Germany · Frankfurt')] });
  assert.deepEqual(result.updated, ['de']);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.equal(result.document.groups[0]!.members[0]!.name, 'Germany · Frankfurt');
});

test('an unchanged node is not an update, though the stored credential is wrapped and the parsed one is not', () => {
  const before = documentWith([{ ...member('de', 'de.example'), name: 'DE' }]);
  const result = refreshGroup({ document: before, groupId: 'feed', nodes: [node('de.example', 'DE')] });
  assert.deepEqual(result.updated, [], 'every refresh would otherwise restart the core for nothing');
});

test('a changed credential is an update', () => {
  const before = documentWith([{ ...member('de', 'de.example', 'old'), name: 'DE' }]);
  const result = refreshGroup({ document: before, groupId: 'feed', nodes: [node('de.example', 'DE', 'new')] });
  assert.deepEqual(result.updated, ['de']);
});

test('another group is left exactly as it was', () => {
  const before = documentWith([member('de', 'de.example')]);
  const other: Group = { id: 'other', name: 'Other', enabled: true, url: 'https://other.example/sub', refreshHours: 1, onUnavailable: 'block', members: [member('o1', 'o.example')] };
  const document = { ...before, groups: [...before.groups, other] };
  const result = refreshGroup({ document, groupId: 'feed', nodes: [] });
  assert.deepEqual(result.document.groups[1], other);
});

test('a feed listing one node twice is one member', () => {
  const result = refreshGroup({ document: documentWith([]), groupId: 'feed', nodes: [node('a.example', 'A'), node('a.example', 'A again')] });
  assert.equal(result.document.groups[0]!.members.length, 1);
});

test('a timer may apply a service change and must stop at a network one', () => {
  assert.equal(refreshMayApply('hot'), true);
  assert.equal(refreshMayApply('service'), true);
  assert.equal(refreshMayApply('network'), false);
  assert.equal(refreshMayApply('boot'), false);
});

test('two nodes on one server and port with different wrapping are two members', () => {
  const reality: ParsedNode = { scheme: 'vless', label: 'Reality', protocol: 'vless', config: { server: 'ru.example', port: 443, id: 'u', network: 'xhttp', security: 'reality' } };
  const tls: ParsedNode = { scheme: 'vless', label: 'TLS', protocol: 'vless', config: { server: 'ru.example', port: 443, id: 'u', network: 'xhttp', security: 'tls' } };
  const outcome = refreshGroup({ document: documentWith([]), groupId: 'feed', nodes: [reality, tls] });
  const members = outcome.document.groups[0]!.members;
  assert.equal(members.length, 2);
  assert.deepEqual(members.map((entry) => entry.name), ['Reality', 'TLS']);
});

test('two nodes on one front that differ only by path are two members (2026-11-01: …/pl and …/de)', () => {
  const at = (path: string, label: string): ParsedNode => ({ scheme: 'vless', label, protocol: 'vless', config: { server: 'front.example', port: 443, id: 'u', network: 'xhttp', security: 'tls', path } });
  const outcome = refreshGroup({ document: documentWith([]), groupId: 'feed', nodes: [at('/x/pl', 'PL'), at('/x/de', 'DE')] });
  assert.deepEqual(outcome.document.groups[0]!.members.map((entry) => entry.name), ['PL', 'DE']);
});

test('a member stored before the path joined the identity keeps its id', () => {
  const config = { server: 'front.example', port: 443, id: 'u', network: 'xhttp' as const, security: 'tls' as const, path: '/x/pl' };
  const stored: Group['members'][number] = { ...member('pl', 'front.example'), node: 'vless://front.example:443?security=tls&type=xhttp', config };
  const outcome = refreshGroup({ document: documentWith([stored]), groupId: 'feed', nodes: [{ scheme: 'vless', label: 'PL', protocol: 'vless', config } as ParsedNode] });
  assert.deepEqual(outcome.document.groups[0]!.members.map((entry) => [entry.id, entry.node]), [['pl', 'vless://front.example:443?security=tls&type=xhttp&path=%2Fx%2Fpl']]);
  assert.deepEqual(outcome.added, []);
  assert.deepEqual(outcome.removed, []);
});

test('a member stored with the older identity keeps its id and takes the new identity', () => {
  const legacy = { ...member('de', 'de.example'), node: 'vless://de.example:443' };
  const outcome = refreshGroup({ document: documentWith([legacy]), groupId: 'feed', nodes: [node('de.example', 'de')] });
  const members = outcome.document.groups[0]!.members;
  assert.deepEqual(members.map((entry) => [entry.id, entry.node]), [['de', 'vless://de.example:443?security=tls&type=tcp']]);
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.added, []);
});
