/**
 * The trailing-space network name, end to end.
 *
 * The bench router's SSID is `VINTAGE ` — seven letters and a space. It is a real network, the space
 * is part of its name, and every layer between the person typing it and the radio has an opportunity
 * to helpfully remove it. When one does, the device looks for a network that does not exist and the
 * only symptom is that it never associates.
 *
 * These are not tests about one router. An SSID is 32 bytes of anything: leading and trailing spaces,
 * tabs, quotes, bytes that are not valid UTF-8. The trailing space is simply the case that is
 * invisible in every interface that displays it, which makes it the one worth pinning down.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { ProfileDocument, emptyProfile, secretMatchers, redactForExport, wrapSecrets } from '@wayfarer/schemas';
import { checkInvariants } from '../src/core/invariants.ts';
import { describeSsid, derivePsk, generateSupplicant } from '../src/core/generate/supplicant.ts';

/** The network the bench board has to join. The space at the end is the point of the fixture. */
const SSID = 'VINTAGE ';
const PASSPHRASE = 'vintage123';

/** A complete, valid profile carrying one wireless uplink — built from the real default document. */
function profileWith(uplink: unknown): Record<string, unknown> {
  const base = emptyProfile({ name: 'Bench' }) as Record<string, unknown>;
  base['uplinks'] = [uplink];
  return Value.Default(ProfileDocument, base) as Record<string, unknown>;
}

function uplinkFor(ssid: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'wan-wifi',
    kind: 'wifi-sta' as const,
    priority: 10,
    bind: { by: 'phy-builtin' as const },
    pinName: false,
    takeOverInterface: false,
    config: { ssid, psk: PASSPHRASE, ...overrides },
  };
}

test('the fixture itself has the trailing space, so a stripped copy of this file fails loudly', () => {
  assert.equal(SSID, 'VINTAGE ');
  assert.equal(SSID.length, 8);
  assert.equal(SSID.at(-1), ' ');
  assert.notEqual(SSID, SSID.trim());
});

test('the generated configuration carries the space, byte for byte', () => {
  const config = generateSupplicant({
    uplink: uplinkFor(SSID) as never,
    interfaceName: 'wlan0',
    profileName: 'Bench',
    passphrase: PASSPHRASE,
  });
  // 56 49 4e 54 41 47 45 20 — the last byte is the space.
  assert.match(config, /^\tssid=56494e5441474520$/m);
  assert.ok(
    config.includes(Buffer.from(SSID, 'utf8').toString('hex')),
    'the hex is the SSID s own bytes, not a re-encoding of some cleaned-up version',
  );
});

test('the same name without the space produces a different file, in both the name and the key', () => {
  const withSpace = generateSupplicant({
    uplink: uplinkFor(SSID) as never,
    interfaceName: 'wlan0',
    profileName: 'Bench',
    passphrase: PASSPHRASE,
  });
  const without = generateSupplicant({
    uplink: uplinkFor(SSID.trim()) as never,
    interfaceName: 'wlan0',
    profileName: 'Bench',
    passphrase: PASSPHRASE,
  });
  assert.notEqual(withSpace, without, 'a trim anywhere upstream would make these two identical');
  // The key is PBKDF2 over the passphrase *and the SSID*, so the space changes it too. This is why a
  // trimmed name does not merely fail to be found — it would not authenticate if it were.
  assert.notEqual(derivePsk(PASSPHRASE, SSID), derivePsk(PASSPHRASE, SSID.trim()));
});

test('the readable form spells the space out, because no interface can show it', () => {
  assert.equal(describeSsid(SSID), '"VINTAGE␠", 8 bytes (␠ marks a space, ␉ a tab — they are part of the name)');
  // An ordinary name is shown plainly, with no distracting annotation.
  assert.equal(describeSsid('VINTAGE'), '"VINTAGE", 7 bytes');
  // Bytes, not characters.
  assert.equal(describeSsid('Café'), '"Café", 5 bytes');
});

test('the derived key is the standard s, not ours', () => {
  // RFC 7664 / IEEE 802.11i test vector: passphrase "password", SSID "IEEE".
  assert.equal(
    derivePsk('password', 'IEEE'),
    'f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e',
  );
});

test('the name survives the profile document, and export does not touch it', () => {
  const document = profileWith(uplinkFor(SSID));
  assert.ok(Value.Check(ProfileDocument, document), 'a name with a trailing space is a valid profile');

  const matchers = secretMatchers(ProfileDocument);
  const stored = wrapSecrets(document, matchers) as { uplinks: { config: { ssid: string } }[] };
  assert.equal(stored.uplinks[0]!.config.ssid, SSID, 'storing a secret must not touch the name beside it');

  const exported = redactForExport(stored, matchers) as { uplinks: { config: { ssid: string } }[] };
  assert.equal(exported.uplinks[0]!.config.ssid, SSID);

  // And a full JSON round trip, which is what an export file is.
  const reimported = JSON.parse(JSON.stringify(exported)) as { uplinks: { config: { ssid: string } }[] };
  assert.equal(reimported.uplinks[0]!.config.ssid, SSID);
  assert.equal(reimported.uplinks[0]!.config.ssid.at(-1), ' ');
});

test('an open network is configured as open rather than left to a default', () => {
  const config = generateSupplicant({
    uplink: uplinkFor(SSID, { psk: null }) as never,
    interfaceName: 'wlan0',
    profileName: 'Bench',
    passphrase: null,
  });
  assert.match(config, /^\tkey_mgmt=NONE$/m);
  assert.ok(!config.includes('psk='), 'no key line at all for an open network');
});

test('a hidden network is asked for by name, or it is never found', () => {
  const config = generateSupplicant({
    uplink: uplinkFor(SSID, { hidden: true }) as never,
    interfaceName: 'wlan0',
    profileName: 'Bench',
    passphrase: PASSPHRASE,
  });
  assert.match(config, /^\tscan_ssid=1$/m);
});

test('the passphrase itself never reaches the generated file', () => {
  const config = generateSupplicant({
    uplink: uplinkFor(SSID) as never,
    interfaceName: 'wlan0',
    profileName: 'Bench',
    passphrase: PASSPHRASE,
  });
  assert.ok(
    !config.includes(PASSPHRASE),
    'the key is derived, so the operator s passphrase is not sitting in a file on the card',
  );
});

/* ── the bounds WPA itself sets, reported rather than discovered ─────────────────────────── */

/** The whole invariant pass, on a device where nothing else is happening. */
function findingsFor(document: Record<string, unknown>) {
  return checkInvariants({
    profile: document as never,
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

test('a passphrase WPA cannot use is a finding on the field, not an exception', () => {
  const findings = findingsFor(profileWith(uplinkFor(SSID, { psk: 'short' })));
  const found = findings.find((entry) => entry.pointer === '/uplinks/0/config/psk');
  assert.ok(found, `expected a finding on the passphrase field; got ${JSON.stringify(findings.map((f) => f.pointer))}`);
  assert.equal(found.severity, 'error');
  assert.ok(!found.message.includes('short'), 'a finding about a secret must not quote the secret');
});

test('a network name is bounded in bytes, not in characters', () => {
  // 32 characters, each three bytes: valid by the schema s maxLength and far too long for the air.
  const tooLong = '日'.repeat(32);
  const found = findingsFor(profileWith(uplinkFor(tooLong))).find(
    (entry) => entry.pointer === '/uplinks/0/config/ssid',
  );
  assert.ok(found, 'a 96-byte name must be refused');
  assert.match(found.message, /96 bytes/);
});
