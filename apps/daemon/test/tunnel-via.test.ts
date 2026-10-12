/**
 * An OpenVPN tunnel whose own connection goes through another tunnel (`OpenVpnConfig.via`).
 *
 * Asked for on 2026-10-12: a server unreachable from the uplink's network and reachable from abroad. The
 * device's own traffic always took the main table, so there was no way to say "dial it through Germany".
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { CORE_TAGS, emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { generateCoreConfig } from '../src/core/generate/core-config.ts';
import { checkInvariants } from '../src/core/invariants.ts';

function tunnel(id: string, extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    role: 'resource',
    enabled: true,
    onUnavailable: 'block',
    protocol: 'openvpn',
    resources: { domainSuffix: [`${id}.internal`] },
    config: { profile: 'client\n', interfaceSuffix: id.slice(0, 6), ...config },
    ...extra,
  };
}

function alternative(id: string) {
  return { id, name: id, role: 'alternative', enabled: true, onUnavailable: 'block', protocol: 'vless', config: { server: '198.51.100.1', port: 443, id: 'x', network: 'tcp', security: 'none' } };
}

function viaFindings(tunnels: unknown[]): { code: string; pointer: string }[] {
  const profile = { ...emptyProfile(), tunnels } as unknown as ProfileDocument;
  return checkInvariants({
    profile: profile as never,
    bindings: new Map(),
    inventory: { interfaces: [], radios: [], binaries: [] } as never,
    facts: { foreignCores: [], interfaceClaims: [], managementInterfaces: [], binaries: [], uplinkNetworks: [] } as never,
  })
    .filter((finding) => finding.code.startsWith('tunnel_via') || finding.code === 'reserved_tunnel_id')
    .map((finding) => ({ code: finding.code, pointer: finding.pointer ?? '' }));
}

/* ── refusals ────────────────────────────────────────────────────────────────────────────── */

test('through the selected alternative, or through an enabled tunnel: accepted', () => {
  assert.deepEqual(viaFindings([alternative('germany'), tunnel('collect', {}, { via: 'failover' })]), []);
  assert.deepEqual(viaFindings([alternative('germany'), tunnel('collect', {}, { via: 'germany' })]), []);
});

test('a tunnel that is not there, or the tunnel itself, is refused on the field', () => {
  assert.deepEqual(viaFindings([tunnel('collect', {}, { via: 'nowhere' })]), [
    { code: 'tunnel_via_unknown', pointer: '/tunnels/0/config/via' },
  ]);
  assert.deepEqual(viaFindings([tunnel('collect', {}, { via: 'collect' })]), [
    { code: 'tunnel_via_unknown', pointer: '/tunnels/0/config/via' },
  ]);
});

test('a tunnel that is turned off cannot carry anything', () => {
  assert.deepEqual(viaFindings([{ ...alternative('germany'), enabled: false }, tunnel('collect', {}, { via: 'germany' })]), [
    { code: 'tunnel_via_disabled', pointer: '/tunnels/1/config/via' },
  ]);
});

test('two tunnels connecting through each other are a loop', () => {
  const codes = viaFindings([tunnel('aaa', {}, { via: 'bbb' }), tunnel('bbb', {}, { via: 'aaa' })]).map((finding) => finding.code);
  assert.deepEqual([...new Set(codes)], ['tunnel_via_loop']);
});

test('an alternative going through the selection would carry its own connection when selected', () => {
  assert.deepEqual(viaFindings([tunnel('hq', { role: 'alternative' }, { via: 'failover' })]), [
    { code: 'tunnel_via_itself', pointer: '/tunnels/0/config/via' },
  ]);
});

test('"failover" cannot be a tunnel id, because via uses the word', () => {
  assert.deepEqual(viaFindings([{ ...alternative('failover') }]), [{ code: 'reserved_tunnel_id', pointer: '/tunnels/0/id' }]);
});

/* ── the core ────────────────────────────────────────────────────────────────────────────── */

test('the core opens a loopback listener for the tunnel and routes it before any other rule', () => {
  const base = emptyProfile({ name: 'Bench' }) as unknown as ProfileDocument;
  const profile = { ...base, tunnels: [alternative('germany'), tunnel('collect', {}, { via: 'failover' })] } as unknown as ProfileDocument;
  const config = generateCoreConfig({
    profile,
    interfaces: { accessPoint: 'wlan0', uplinks: new Map([['uplink', 'end0']]) },
    emitted: new Map([
      ['germany', { target: 'outbounds' as const, object: { type: 'socks', server: '127.0.0.1', server_port: 10800 } }],
      [
        'collect',
        {
          target: 'outbounds' as const,
          object: { type: 'direct', bind_interface: 'wfvpncollec' },
          coreInbound: { tag: 'wf-via-collect', port: 10801, outbound: CORE_TAGS.selector },
        },
      ],
    ]),
    tunnelDns: new Map(),
    uplinkNetworks: ['192.168.1.0/24'],
  }) as unknown as { inbounds: Record<string, unknown>[]; route: { rules: Record<string, unknown>[] } };

  assert.deepEqual(
    config.inbounds.find((inbound) => inbound['tag'] === 'wf-via-collect'),
    { type: 'socks', tag: 'wf-via-collect', listen: '127.0.0.1', listen_port: 10801 },
  );
  // First, ahead of sniffing and every domain or resource rule: the connection is already destined.
  assert.deepEqual(config.route.rules[0], { inbound: ['wf-via-collect'], outbound: CORE_TAGS.selector });
});
