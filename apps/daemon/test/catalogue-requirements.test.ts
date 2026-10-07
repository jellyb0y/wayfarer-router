/**
 * What a tunnel's protocol needs installed, asked of the catalogue rather than of a name.
 *
 * The line this replaces read `tunnel.provider === 'openvpn'` and required `openvpn`. It was correct
 * and it was the only one there was: no other protocol's binary requirement existed, because adding
 * one meant adding a second branch on a second name. The obfuscation client — without which an
 * obfuscated tunnel cannot start at all — was never checked, and the symptom was a unit that would
 * not come up on a device the plan had called usable.
 *
 * The requirement now comes from the entry that knows it, so these tests are about the walk rather
 * than about any one protocol: what is asserted is that the finding names the binary the entry asked
 * for, points at the tunnel that needs it, and appears for an entry nobody wrote a branch for.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { checkInvariants, type RuntimeFacts } from '../src/core/invariants.ts';
import { INVENTORIES, cleanFacts } from './helpers/synthetic-inventory.ts';

const OVPN = 'client\ndev tun\nremote peer.example.net 1194\n';

const ENTRY_POINT = {
  id: 'front-a',
  host: '198.51.100.8',
  port: 443,
  uid: 'an-identifier',
  publicKey: 'a-public-key',
  proxyMethod: 'openvpn',
  encryptionMethod: 'aes-gcm',
  serverName: 'www.example.com',
  browserSignature: 'chrome',
  transport: 'direct',
};

function profileWith(protocol: string, config: Record<string, unknown>): ProfileDocument {
  const base = emptyProfile({ name: 'R', now: () => '2026-09-21T00:00:00.000Z' });
  return {
    ...base,
    tunnels: [
      {
        id: 'only',
        name: 'The tunnel',
        role: 'alternative',
        onUnavailable: 'block' as const,
        enabled: true,
        protocol,
        config,
      },
    ] as ProfileDocument['tunnels'],
  };
}

/** The facts with named binaries removed, so a missing one is stated rather than arranged. */
function without(...missing: string[]): RuntimeFacts {
  const facts = cleanFacts();
  return { ...facts, binaries: facts.binaries.filter((entry) => !missing.includes(entry.name)) };
}

function findings(profile: ProfileDocument, facts: RuntimeFacts): ReturnType<typeof checkInvariants> {
  return checkInvariants({
    profile,
    inventory: INVENTORIES['no-radio']!(),
    bindings: new Map(),
    facts,
  });
}

test('an obfuscated tunnel requires the obfuscation client, which nothing ever checked before', () => {
  const profile = profileWith('cloak-openvpn', { profile: OVPN, entryPoints: [ENTRY_POINT] });
  const missing = findings(profile, without('ck-client')).filter((finding) => finding.code === 'binary_missing');

  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.match(missing[0]!.message, /ck-client is not installed/);
  // The reason comes from the entry, in the entry's words, rather than from a generic "tunnels of that
  // kind" written at the check.
  assert.match(missing[0]!.message, /obfuscated OpenVPN tunnel/);
  // And it points at the tunnel that needs it, not at the list.
  assert.equal(missing[0]!.pointer, '/tunnels/0/protocol');
});

test('a plain OpenVPN tunnel requires only the OpenVPN client, on the same device', () => {
  const profile = profileWith('openvpn', { profile: OVPN });
  // `ck-client` is absent here too, and this tunnel must not ask for it: a check that named every
  // binary any entry might want would make one missing client block every protocol.
  const missing = findings(profile, without('ck-client')).filter((finding) => finding.code === 'binary_missing');
  assert.deepEqual(missing, []);

  const both = findings(profile, without('openvpn', 'ck-client')).filter(
    (finding) => finding.code === 'binary_missing',
  );
  assert.deepEqual(both.map((finding) => finding.detail?.['binary']), ['openvpn']);
});

test('an obfuscated tunnel with both clients missing asks for both, in one pass', () => {
  const profile = profileWith('cloak-openvpn', { profile: OVPN, entryPoints: [ENTRY_POINT] });
  const missing = findings(profile, without('openvpn', 'ck-client')).filter(
    (finding) => finding.code === 'binary_missing',
  );
  // A person fixing a device should learn everything to install once, not one binary per attempt.
  assert.deepEqual(missing.map((finding) => finding.detail?.['binary']).sort(), ['ck-client', 'openvpn']);
});

test('a VLESS account the core can carry needs no external client at all', () => {
  const profile = profileWith('vless', {
    server: 'node.example.net',
    port: 443,
    id: 'an-account',
    network: 'tcp',
    security: 'tls',
  });

  /*
   * Nothing is known about the core here, which every entry must read as "everything is offered".
   * Absence of knowledge is not a negative answer: a device whose schema fetch has not finished must
   * not be told to install a client it does not need, because that error is about a different thing
   * entirely and sends somebody to fix what is not broken.
   */
  const missing = findings(profile, without('xray')).filter((finding) => finding.code === 'binary_missing');
  assert.deepEqual(missing, []);
});

test('a VLESS account this core cannot carry asks for the external client instead', () => {
  const profile = profileWith('vless', {
    server: 'node.example.net',
    port: 443,
    id: 'an-account',
    network: 'tcp',
    security: 'tls',
  });

  const missing = checkInvariants({
    profile,
    inventory: INVENTORIES['no-radio']!(),
    bindings: new Map(),
    facts: without('xray'),
    // A core that was read, and that speaks nothing this entry needs. This is the only shape in which
    // a negative answer about the core is a fact rather than an absence.
    core: { known: true, outboundTypes: new Set(['direct', 'socks', 'http']) },
  }).filter((finding) => finding.code === 'binary_missing');

  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.equal(missing[0]!.detail?.['binary'], 'xray');
  assert.match(missing[0]!.message, /carrying a VLESS subscription this core cannot/);
});

test('a disabled tunnel asks for nothing, because nothing will be started for it', () => {
  const profile = profileWith('cloak-openvpn', { profile: OVPN, entryPoints: [ENTRY_POINT] });
  const disabled: ProfileDocument = {
    ...profile,
    tunnels: profile.tunnels.map((tunnel) => ({ ...tunnel, enabled: false })),
  };
  const missing = findings(disabled, without('openvpn', 'ck-client')).filter(
    (finding) => finding.code === 'binary_missing',
  );
  assert.deepEqual(missing, []);
});
