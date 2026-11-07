/**
 * Hysteria 2: the outbound the core is handed, the values that validate and cannot work, and the one
 * field only a feed may set.
 *
 * The configuration below is the shape of a node the `za-stenoy.ru` feed served as sing-box JSON on
 * 2026-11-07, with every credential and address invented.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile, type Hysteria2Config, type ProfileDocument } from '@wayfarer/schemas';
import { hysteria2Entry, hysteria2Outbound } from '../src/core/catalogue/hysteria2.ts';
import type { EntryPlanContext } from '../src/core/catalogue/index.ts';
import { checkInvariants } from '../src/core/invariants.ts';

const NODE: Hysteria2Config = {
  server: '198.51.100.7',
  port: 8844,
  serverPorts: ['18020:18039'],
  password: 'invented-password',
  obfsPassword: 'invented-obfs',
  serverName: 'node.example.invalid',
  alpn: ['h3'],
};

function context(): EntryPlanContext {
  return {
    tunnel: { id: 'hy', name: 'Hysteria', index: 0 },
    core: { known: true, outboundTypes: new Set(['hysteria2']) },
    installed: new Set(),
    allocatePort: () => {
      throw new Error('a native entry must not allocate a port');
    },
  };
}

test('the outbound is the core’s own hysteria2 object, field for field', () => {
  assert.deepEqual(hysteria2Outbound(NODE), {
    type: 'hysteria2',
    server: '198.51.100.7',
    server_port: 8844,
    password: 'invented-password',
    server_ports: ['18020:18039'],
    obfs: { type: 'salamander', password: 'invented-obfs' },
    tls: { enabled: true, server_name: 'node.example.invalid', alpn: ['h3'] },
  });
});

test('insecure reaches the core only when the configuration says so', () => {
  assert.equal((hysteria2Outbound(NODE)['tls'] as Record<string, unknown>)['insecure'], undefined);
  assert.equal((hysteria2Outbound({ ...NODE, insecure: true })['tls'] as Record<string, unknown>)['insecure'], true);
});

test('with no handshake name the server address is presented', () => {
  const { serverName: _omitted, ...bare } = NODE;
  assert.equal((hysteria2Outbound(bare)['tls'] as Record<string, unknown>)['server_name'], '198.51.100.7');
});

test('an empty password, an empty obfuscation password and a backwards range are refused by field', () => {
  const cases: [Partial<Hysteria2Config>, string][] = [
    [{ password: '' }, '/tunnels/0/config/password'],
    [{ obfsPassword: '' }, '/tunnels/0/config/obfsPassword'],
    [{ serverPorts: ['18039:18020'] }, '/tunnels/0/config/serverPorts/0'],
    [{ serverPorts: ['70000'] }, '/tunnels/0/config/serverPorts/0'],
  ];
  for (const [change, pointer] of cases) {
    const result = hysteria2Entry.plan({ ...NODE, ...change }, context());
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.ok(!result.ok);
    assert.equal(result.refusal.pointer, pointer);
  }
  // The anchor: the same node unchanged plans, so the refusals above are about the fields.
  assert.equal(hysteria2Entry.plan(NODE, context()).ok, true);
});

test('a core built without Hysteria 2 makes the entry unavailable, an unknown core does not', () => {
  assert.equal(hysteria2Entry.availability({ core: { known: true, outboundTypes: new Set(['vless']) }, installed: new Set() }).available, false);
  assert.equal(hysteria2Entry.availability({ core: { known: false, outboundTypes: new Set() }, installed: new Set() }).available, true);
});

function invariantsFor(config: Record<string, unknown>) {
  const profile = emptyProfile() as unknown as Record<string, unknown>;
  profile['tunnels'] = [{ id: 'hy', name: 'Hysteria', onUnavailable: 'block', enabled: true, protocol: 'hysteria2', config }];
  return checkInvariants({
    profile: profile as unknown as ProfileDocument,
    bindings: new Map(),
    inventory: { interfaces: [], radios: [], binaries: [] } as never,
    facts: { foreignCores: [], interfaceClaims: [], managementInterfaces: [], binaries: [], uplinkNetworks: [] } as never,
  }).filter((finding) => finding.code === 'insecure_outside_feed');
}

test('a tunnel made by hand may not turn certificate checking off', () => {
  const found = invariantsFor({ ...NODE, insecure: true });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, 'error');
  assert.equal(found[0]!.pointer, '/tunnels/0/config/insecure');
  // The anchor: without the field nothing is said, so the check is about the field.
  assert.equal(invariantsFor({ ...NODE }).length, 0);
});
