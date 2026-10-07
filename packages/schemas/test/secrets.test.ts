/**
 * The four behaviours, and the one that owes nothing to any of the machinery.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  applyWrite,
  droppedSecrets,
  emptyProfile,
  isStoredSecret,
  matchesPointer,
  migrateProfile,
  missingSecrets,
  PROFILE_SCHEMA_VERSION,
  ProfileDocument,
  ProfileVersionError,
  redactForExport,
  redactForLog,
  redactForRead,
  REDACTED,
  Secret,
  secretMatchers,
  secretPointers,
  wrapSecrets,
  type SecretKind,
  type SecretMatcher,
} from '../src/index.ts';

const matchers = secretMatchers(ProfileDocument);

test('the profile schema declares its secrets where they are', () => {
  const pointers = secretPointers(ProfileDocument);
  // `-` is the JSON Pointer form for "any element", which is what lets one matcher cover every
  // uplink without naming an index that would be wrong for all the others.
  assert.ok(pointers.includes('/accessPoint/passphrase'), pointers.join(', '));
  assert.ok(pointers.includes('/uplinks/-/config/psk'), pointers.join(', '));
});

test('a secret inside a union keeps its kind label', () => {
  // `uplinks` is an array of a union, and the pre-shared key is an *optional* secret inside one
  // branch — so the pointer passes through a union before the leaf. A walk that committed to the first
  // branch containing `config` chose the Ethernet one, found no `psk`, and fell back to the generic
  // kind. The checklist then said "a secret is missing here" where it could have said "a pre-shared
  // key", which is most of what the label is for, and nothing failed.
  assert.equal(matchers.get('/uplinks/-/config/psk'), 'psk');
  assert.equal(matchers.get('/accessPoint/passphrase'), 'psk');
});

test('a matcher with a wildcard segment matches any index', () => {
  assert.equal(matchesPointer('/uplinks/-/config/psk', '/uplinks/0/config/psk'), true);
  assert.equal(matchesPointer('/uplinks/-/config/psk', '/uplinks/7/config/psk'), true);
  assert.equal(matchesPointer('/uplinks/-/config/psk', '/uplinks/0/config/ssid'), false);
  assert.equal(matchesPointer('/uplinks/-/config/psk', '/uplinks/0/config/psk/extra'), false);
});

test('a union does not need to be discriminated, because the absent key simply never matches', () => {
  // The reason matchers beat a lockstep schema walk: an Ethernet uplink has no `psk`, so nothing at
  // that position is found, and no branch had to be chosen.
  const profile = {
    uplinks: [
      { id: 'a', kind: 'ethernet', config: { dhcp: true } },
      { id: 'b', kind: 'wifi-sta', config: { ssid: 'x', psk: 'upstream' } },
    ],
  };
  const wrapped = wrapSecrets(profile, matchers) as typeof profile;
  assert.deepEqual(wrapped.uplinks[0]!.config, { dhcp: true });
  assert.deepEqual(wrapped.uplinks[1]!.config, { ssid: 'x', psk: { $secret: 'upstream' } });
});

test('storage wraps, and wrapping is idempotent', () => {
  const once = wrapSecrets({ accessPoint: { passphrase: 'hunter2' } }, matchers);
  const twice = wrapSecrets(once, matchers);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, { accessPoint: { passphrase: { $secret: 'hunter2' } } });
});

test('a key given as several lines is one secret, and the wrapper can hold it', () => {
  // Measured shape: `ssh.private_key` and `tls.client_key` are declared `string | string[]` in the
  // schema a proxy core emits. A wrapper that only accepted a string left both unwrapped.
  const lines = ['-----BEGIN-----', 'abc', '-----END-----'];
  const wrapped = wrapSecrets({ accessPoint: { passphrase: lines } }, matchers) as {
    accessPoint: { passphrase: unknown };
  };
  assert.ok(isStoredSecret(wrapped.accessPoint.passphrase));
  assert.deepEqual((wrapped.accessPoint.passphrase as { $secret: unknown }).$secret, lines);
});

test('a read says whether a value is set, and never what it is', () => {
  const stored = wrapSecrets({ accessPoint: { passphrase: 'hunter2' } }, matchers);
  const read = redactForRead(stored, matchers);
  assert.deepEqual(read, { accessPoint: { passphrase: { $set: true } } });

  const empty = redactForRead({ accessPoint: { passphrase: { $secret: '' } } }, matchers);
  assert.deepEqual(empty, { accessPoint: { passphrase: { $set: false } } });
});

test('an export carries the kind, which is what the import checklist can name', () => {
  const stored = wrapSecrets({ accessPoint: { passphrase: 'hunter2' } }, matchers);
  const exported = redactForExport(stored, matchers);
  assert.deepEqual(exported, { accessPoint: { passphrase: { $redacted: 'psk' } } });
});

test('a write may keep the stored value, and keeping something that is not there is an error', () => {
  const stored = wrapSecrets({ accessPoint: { passphrase: 'hunter2' } }, matchers);

  const kept = applyWrite({ accessPoint: { passphrase: { $keep: true } } }, stored, matchers);
  assert.deepEqual(kept.errors, []);
  assert.deepEqual(kept.document, { accessPoint: { passphrase: { $secret: 'hunter2' } } });

  // The failure this prevents is silent: a form that saved what a GET gave it would blank every
  // secret on the first save of an unrelated field, and nothing would say so until a tunnel stopped.
  const nothing = applyWrite({ accessPoint: { passphrase: { $keep: true } } }, {}, matchers);
  assert.equal(nothing.errors.length, 1);
  assert.equal(nothing.errors[0]?.pointer, '/accessPoint/passphrase');
});

test('a write of the read shape is rejected, with its pointer', () => {
  // This is why there is no single permissive union: `{ $set: true }` must never reach storage.
  const result = applyWrite({ accessPoint: { passphrase: { $set: true } } }, {}, matchers);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.pointer, '/accessPoint/passphrase');
});

test('the import checklist lists exactly the gaps', () => {
  const imported = {
    accessPoint: { passphrase: { $redacted: 'psk' } },
    uplinks: [
      { id: 'a', kind: 'wifi-sta', config: { ssid: 'x', psk: { $redacted: 'psk' } } },
      { id: 'b', kind: 'wifi-sta', config: { ssid: 'y', psk: { $secret: 'known' } } },
    ],
  };
  const missing = missingSecrets(imported, matchers);
  assert.deepEqual(
    missing.map((entry) => entry.pointer).sort(),
    ['/accessPoint/passphrase', '/uplinks/0/config/psk'],
  );
  assert.equal(missing[0]?.kind, 'psk');
});

test('an imported gap survives storage rather than being filled with an empty value', () => {
  // An access point with an empty passphrase is an open network, so the gap has to stay visible
  // until somebody fills it deliberately.
  const wrapped = wrapSecrets({ accessPoint: { passphrase: { $redacted: 'psk' } } }, matchers);
  assert.deepEqual(wrapped, { accessPoint: { passphrase: { $redacted: 'psk' } } });
});

test('the log redactor works on the wrapper alone, with no schema in sight', () => {
  // Deliberately a document no schema describes: this is the case a schema lookup would fail open on,
  // and it is the one most likely to reach a log line during an incident.
  const value = {
    whatever: { nested: [{ $secret: 'a-real-key' }, 'plain'] },
    tunnels: [{ config: { uuid: { $secret: 'another' } } }],
  };
  const redacted = JSON.stringify(redactForLog(value));
  assert.equal(redacted.includes('a-real-key'), false);
  assert.equal(redacted.includes('another'), false);
  assert.equal(redacted.includes(REDACTED), true);
  assert.equal(redacted.includes('plain'), true);
});

test('the log redactor does not throw on a cycle', () => {
  // A logger that can crash its caller is worse than a log line that says so.
  const cyclic: Record<string, unknown> = { name: 'x' };
  cyclic['self'] = cyclic;
  const redacted = JSON.stringify(redactForLog(cyclic));
  assert.ok(redacted.includes('[cyclic]'));
});

test('a secret field declares a bound, because a document arrives over the network', () => {
  const schema = Secret({ kind: 'private-key' }) as unknown as Record<string, unknown>;
  assert.equal(schema['x-secret'], true);
  assert.equal(schema['x-secret-kind'], 'private-key');
  assert.equal(typeof schema['maxLength'], 'number');
});

/* ── migrations ──────────────────────────────────────────────────────────────────────────── */

test('a document at the current version passes through unchanged', () => {
  const profile = emptyProfile({ name: 'x', now: () => '2026-09-19T00:00:00.000Z' });
  const result = migrateProfile(profile);
  assert.equal(result.from, PROFILE_SCHEMA_VERSION);
  assert.equal(result.to, PROFILE_SCHEMA_VERSION);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.document, profile);
});

test('a document from the future is refused, not accepted with its unknown parts dropped', () => {
  // Dropping what this build does not understand can drop a routing rule, and a dropped routing rule
  // sends traffic somewhere nobody intended.
  assert.throws(
    () => migrateProfile({ schemaVersion: PROFILE_SCHEMA_VERSION + 1 }),
    (error: unknown) => error instanceof ProfileVersionError && /newer version/.test(error.message),
  );
});

test('a document with no usable version is refused rather than assumed to be current', () => {
  assert.throws(() => migrateProfile({}), (error: unknown) => error instanceof ProfileVersionError);
  assert.throws(() => migrateProfile('not an object'), (error: unknown) => error instanceof ProfileVersionError);
});

test('migration does not mutate its input', () => {
  const profile = emptyProfile({ name: 'x', now: () => '2026-09-19T00:00:00.000Z' });
  const snapshot = JSON.stringify(profile);
  migrateProfile(profile);
  assert.equal(JSON.stringify(profile), snapshot);
});

test('a write that sends back what a read returned names that mistake specifically', () => {
  // Found against the running daemon on the bench board while doing the most natural thing an
  // automation client does: read the profile, change one field, write it back. Every secret in the
  // document fails, because a read gives `{"$set": true}` and a write takes a literal or `{"$keep":
  // true}`. The general message stated the rule correctly and still left the caller to work out which
  // rule they had broken by comparing two shapes character by character.
  const matchers = new Map<SecretMatcher, SecretKind>([['/accessPoint/passphrase', 'psk']]);
  const stored = { accessPoint: { passphrase: { $secret: 'the-stored-one' } } };

  const result = applyWrite({ accessPoint: { passphrase: { $set: true } } }, stored, matchers);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.pointer, '/accessPoint/passphrase');
  assert.match(result.errors[0]!.message, /shape a GET returns/);
  assert.match(result.errors[0]!.message, /\$keep/);
  // And it still says what a read never does, because that is the reason the two shapes differ at all.
  assert.match(result.errors[0]!.message, /never reveals/);

  // The generic message is still there for a value that is simply the wrong type.
  const wrongType = applyWrite({ accessPoint: { passphrase: 42 } }, stored, matchers);
  assert.match(wrongType.errors[0]!.message, /expected a psk/);

  // And the shape that does work still works.
  const kept = applyWrite({ accessPoint: { passphrase: { $keep: true } } }, stored, matchers);
  assert.equal(kept.errors.length, 0);
  assert.deepEqual(kept.document, stored);
});


/* ── a write that leaves a secret out ────────────────────────────────────────────────────── */

/**
 * The failure these three tests exist for, measured on the owner's live profile on 2026-09-21: one API
 * write dropped **six** stored secrets, five of them the account identifier of an obfuscation entry
 * point. Everything above walks the *incoming* document, so a position the caller omitted was a position
 * nothing visited — no value to check, no `$keep` to resolve, no error, and a stored document that was
 * wrong from that moment on. The device kept running only because nothing had been applied.
 *
 * Both directions are asserted, because the qualification is the whole of the rule: dropping a field out
 * of something that is still there is a loss nobody asked for, and removing the thing it belonged to is
 * how a credential is deliberately discarded.
 */

function benchTunnelProfile(uid: string): Record<string, unknown> {
  const base = emptyProfile({ name: 'Bench' }) as unknown as Record<string, unknown>;
  return {
    ...base,
    tunnels: [
      {
        id: 'hq',
        name: 'HQ',
        role: 'alternative',
        onUnavailable: 'block',
        enabled: true,
        protocol: 'cloak-openvpn',
        config: {
          profile: 'client\ndev tun\n',
          entryPoints: [
            {
              id: 'front-a',
              host: '198.51.100.8',
              port: 443,
              uid,
              publicKey: 'a-public-key',
              proxyMethod: 'openvpn',
              encryptionMethod: 'aes-gcm',
              serverName: 'www.example.com',
              browserSignature: 'chrome',
              transport: 'direct',
            },
          ],
        },
      },
    ],
  };
}

test('a write that omits a stored secret is refused, naming the pointer it would have deleted', () => {
  const matchers = secretMatchers(ProfileDocument);
  const stored = wrapSecrets(benchTunnelProfile('the-account-identifier'), matchers) as Record<string, unknown>;

  // The entry point survives; only its credential is gone from the payload. This is what a client does
  // after `{"$keep": true}` is refused at that pointer: the only remaining move.
  const incoming = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
  const entryPoint = ((incoming['tunnels'] as Record<string, unknown>[])[0]!['config'] as Record<string, unknown>);
  delete ((entryPoint['entryPoints'] as Record<string, unknown>[])[0]!)['uid'];

  const result = applyWrite(incoming, stored, matchers);
  assert.deepEqual(
    result.errors.map((error) => error.pointer),
    ['/tunnels/0/config/entryPoints/0/uid'],
  );
  assert.match(result.errors[0]!.message, /leaves out a token that is stored here/);
});

test('removing the entry point removes its credential with it, and that is not an error', () => {
  const matchers = secretMatchers(ProfileDocument);
  const stored = wrapSecrets(benchTunnelProfile('the-account-identifier'), matchers) as Record<string, unknown>;

  const incoming = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
  const config = (incoming['tunnels'] as Record<string, unknown>[])[0]!['config'] as Record<string, unknown>;
  config['entryPoints'] = [];

  // The other direction. A rule that refused this would make an entry point impossible to delete, and
  // the operator would learn to work around the refusal — which is how a safety check trains its bypass.
  const result = applyWrite(incoming, stored, matchers);
  assert.deepEqual(result.errors, []);
});

test('an empty stored secret is not something a write can lose, so editing round it is allowed', () => {
  const matchers = secretMatchers(ProfileDocument);
  const stored = wrapSecrets(benchTunnelProfile(''), matchers) as Record<string, unknown>;

  const incoming = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
  const config = (incoming['tunnels'] as Record<string, unknown>[])[0]!['config'] as Record<string, unknown>;
  delete ((config['entryPoints'] as Record<string, unknown>[])[0]!)['uid'];

  /*
   * A gap is already reported by the import checklist, which is where a person is told to fill it.
   * Refusing a write over one would make a profile with a known gap impossible to edit at all — and an
   * imported redacted export is exactly such a profile.
   */
  assert.deepEqual(droppedSecrets(incoming, stored, matchers), []);
  assert.deepEqual(applyWrite(incoming, stored, matchers).errors, []);
});
