/**
 * How the core reaches the resolvers that answer public names (2026-10-07).
 *
 * Both are TCP. Over UDP the core sent an A and an HTTPS query for one new name from one socket, back to
 * back; a NAT in front of the bench board dropped the second packet of the new flow, and the core waited
 * 10 s for the answer that never came — every new site a browser opened stalled for 10 s. The direct
 * resolver also had a `detour` to the empty `direct` outbound, which sing-box 1.14.0 refuses to start
 * with while `sing-box check` passes it. Measurements are in docs/04.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { CORE_TAGS, emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { generateCoreConfig, tunnelDnsTag } from '../src/core/generate/core-config.ts';

type Server = { type: string; tag: string; server?: string; detour?: string };

function servers(direct: string): Server[] {
  const base = emptyProfile({ name: 'Bench' }) as unknown as ProfileDocument;
  const profile = {
    ...base,
    dns: { ...base.dns, direct },
    tunnels: [
      {
        id: 'corp',
        name: 'Corp',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        protocol: 'openvpn',
        config: { profile: 'client\n', interfaceSuffix: 'crp' },
        resources: { domainSuffix: ['corp.internal'] },
      },
    ],
  } as unknown as ProfileDocument;
  const config = generateCoreConfig({
    profile,
    interfaces: { accessPoint: 'wlan0', uplinks: new Map([['uplink', 'wfwan0']]) },
    emitted: new Map([['corp', { target: 'outbounds' as const, object: { type: 'direct', bind_interface: 'wfvpncrp' } }]]),
    tunnelDns: new Map([['corp', { address: '10.122.0.1', viaInterface: 'corp', domainSuffix: ['corp.internal'] }]]),
    uplinkNetworks: ['192.168.77.0/24'],
  }) as unknown as { dns: { servers: Server[] } };
  return config.dns.servers;
}

const byTag = (list: Server[], tag: string) => list.find((entry) => entry.tag === tag);

test('the resolver unmatched names use is reached over TCP, through the selector', () => {
  const tunnel = byTag(servers('auto'), CORE_TAGS.dnsTunnel);
  assert.equal(tunnel?.type, 'tcp');
  assert.equal(tunnel?.detour, CORE_TAGS.selector);
});

test('a literal direct resolver is TCP and has no detour, which the core would refuse to start with', () => {
  const direct = byTag(servers('9.9.9.9'), CORE_TAGS.dnsDirect);
  assert.deepEqual(direct, { type: 'tcp', tag: CORE_TAGS.dnsDirect, server: '9.9.9.9' });
});

test('"auto" still follows the uplink, and a tunnel\'s own resolver is left on UDP', () => {
  const list = servers('auto');
  assert.deepEqual(byTag(list, CORE_TAGS.dnsDirect), { type: 'local', tag: CORE_TAGS.dnsDirect });
  // Not measured to lose anything inside a tunnel (0 of 15 through `corp`), and a corporate resolver
  // is not promised to answer TCP. Changing it would be a guess.
  assert.equal(byTag(list, tunnelDnsTag('corp'))?.type, 'udp');
});
