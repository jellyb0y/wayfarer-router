/**
 * Reality's public key and short id are one credential, and nothing required them together.
 *
 * `tunnel-configs.ts` said *"Both are needed together; the invariants say so."* and no such check
 * existed — the second time this repository has found that exact shape, the first being the wired
 * uplink's address and gateway. A profile with `security: 'reality'` and no public key validated,
 * stored, and reached `nativeOutbound`, which emitted `tls.reality = { enabled: true }` with nothing
 * in it: the proxy core then either refuses the whole core configuration, **taking every tunnel that
 * shares that file**, or completes no handshake and says nothing while the unit reports `active`.
 *
 * The last two tests are the anchors. Without them the four above are satisfied by a check that
 * refuses every VLESS tunnel, which is the cheapest way to make this file green.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { checkInvariants, type Finding } from '../src/core/invariants.ts';

function findingsFor(config: Record<string, unknown>, options: { enabled?: boolean } = {}): Finding[] {
  const profile = emptyProfile() as unknown as Record<string, unknown>;
  profile['tunnels'] = [
    {
      id: 'alt-a',
      name: 'Warsaw',
      role: 'alternative',
      onUnavailable: 'block',
      enabled: options.enabled ?? true,
      protocol: 'vless',
      config: { server: '198.51.100.7', port: 443, id: 'an-account', network: 'tcp', ...config },
    },
  ];
  return checkInvariants({
    profile: profile as unknown as ProfileDocument,
    bindings: new Map(),
    inventory: { interfaces: [], radios: [], binaries: [] } as never,
    facts: {
      foreignCores: [],
      interfaceClaims: [],
      managementInterfaces: [],
      binaries: [],
      uplinkNetworks: [],
    } as never,
  });
}

const reality = (findings: Finding[]): Finding[] => findings.filter((entry) => entry.code.startsWith('reality_'));

test('a Reality tunnel with no public key is refused, pointing at the field', () => {
  const found = reality(findingsFor({ security: 'reality' }));
  assert.equal(found.length, 1, `expected one refusal, got ${JSON.stringify(found)}`);
  assert.equal(found[0]!.code, 'reality_without_public_key');
  assert.equal(found[0]!.severity, 'error');
  assert.equal(found[0]!.pointer, '/tunnels/0/config/realityPublicKey');
  // The hint names where the value comes from. A refusal that says only what is wrong is a riddle.
  assert.match(found[0]!.hint, /pbk/);
});

test('a Reality tunnel with a public key and no short id is refused, pointing at the short id', () => {
  const found = reality(
    findingsFor({ security: 'reality', realityPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
  );
  assert.equal(found.length, 1, `expected one refusal, got ${JSON.stringify(found)}`);
  assert.equal(found[0]!.code, 'reality_without_short_id');
  assert.equal(found[0]!.severity, 'error');
  assert.equal(found[0]!.pointer, '/tunnels/0/config/realityShortId');
  assert.match(found[0]!.hint, /sid/);
});

test('a Reality tunnel missing both is refused once, at the key, rather than twice', () => {
  // Two refusals for one transcription mistake is how a person is taught to skim refusals.
  const found = reality(findingsFor({ security: 'reality' }));
  assert.deepEqual(found.map((entry) => entry.code), ['reality_without_public_key']);
});

test('a switched-off Reality tunnel is not a refusal', () => {
  // Refusing activation over the configuration of something switched off makes the switch useless.
  assert.deepEqual(reality(findingsFor({ security: 'reality' }, { enabled: false })), []);
});

test('a complete Reality tunnel is accepted', () => {
  assert.deepEqual(
    reality(
      findingsFor({
        security: 'reality',
        realityPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        realityShortId: '0123abcd',
      }),
    ),
    [],
  );
});

test('a TLS tunnel with no Reality fields is not a refusal', () => {
  // The check must be about Reality, not about VLESS. The bench board's VLESS tunnel is this one.
  assert.deepEqual(reality(findingsFor({ security: 'tls' })), []);
});
