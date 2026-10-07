/**
 * `{"$keep": true}` names a secret by **what holds it**, not by where it sits in a list.
 *
 * Measured by the acceptance tester on the bench board, 2026-09-23: inserting a tunnel anywhere but
 * last failed with `400 invalid_secret_write` at `/tunnels/1/…`, because every later tunnel moved down
 * one place and `$keep` was looked up by array index in the stored document — so it found the wrong
 * tunnel's credential, or none. The same lookup made reordering tunnels in the interface either fail
 * or, where two neighbours both had a credential at the same field, **silently swap them**.
 *
 * Each test inserts, reorders or removes and asserts every kept secret lands on the tunnel it belongs
 * to — checked by value, which is the only thing that shows a swap.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyWrite, wrapSecrets, type SecretKind, type SecretMatcher } from '../src/index.ts';

// A tunnel credential and an entry-point credential, the two nested shapes the board carries.
const matchers = new Map<SecretMatcher, SecretKind>([
  ['/tunnels/-/config/id', 'password'],
  ['/tunnels/-/config/entryPoints/-/uid', 'password'],
]);

function tunnel(id: string, secret: unknown, entryPoints: { id: string; uid: unknown }[] = []): Record<string, unknown> {
  return { id, name: id, config: { id: secret, ...(entryPoints.length > 0 ? { entryPoints } : {}) } };
}

const STORED = wrapSecrets(
  {
    tunnels: [
      tunnel('relay', 'secret-relay'),
      tunnel('hq', 'secret-hq', [
        { id: 'front-a', uid: 'uid-a' },
        { id: 'front-b', uid: 'uid-b' },
      ]),
      tunnel('russia', 'secret-russia'),
    ],
  },
  matchers,
);

const KEEP = { $keep: true };

function secretsById(document: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of (document as { tunnels: { id: string; config: { id: unknown; entryPoints?: { id: string; uid: unknown }[] } }[] }).tunnels) {
    out[entry.id] = entry.config.id;
    for (const point of entry.config.entryPoints ?? []) out[`${entry.id}/${point.id}`] = point.uid;
  }
  return out;
}

const EXPECTED = {
  relay: { $secret: 'secret-relay' },
  hq: { $secret: 'secret-hq' },
  'hq/front-a': { $secret: 'uid-a' },
  'hq/front-b': { $secret: 'uid-b' },
  russia: { $secret: 'secret-russia' },
};

test('$keep: a tunnel inserted first — every kept secret stays with its own tunnel', () => {
  // Mutation: resolve `$keep` through `valueAt(stored, pointer)` again and this goes red with
  // invalid_secret_write at /tunnels/1/config/id — the board's error.
  const result = applyWrite(
    {
      tunnels: [
        tunnel('wftest', 'a-new-literal'),
        tunnel('relay', KEEP),
        tunnel('hq', KEEP, [
          { id: 'front-a', uid: KEEP },
          { id: 'front-b', uid: KEEP },
        ]),
        tunnel('russia', KEEP),
      ],
    },
    STORED,
    matchers,
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(secretsById(result.document), { ...EXPECTED, wftest: { $secret: 'a-new-literal' } });
});

test('$keep: two tunnels reordered, and two entry points reordered — nothing swaps', () => {
  const result = applyWrite(
    {
      tunnels: [
        tunnel('russia', KEEP),
        tunnel('hq', KEEP, [
          { id: 'front-b', uid: KEEP },
          { id: 'front-a', uid: KEEP },
        ]),
        tunnel('relay', KEEP),
      ],
    },
    STORED,
    matchers,
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(secretsById(result.document), EXPECTED);
});

test('$keep: a tunnel removed from the middle — the ones after it keep their own secrets', () => {
  const result = applyWrite(
    { tunnels: [tunnel('relay', KEEP), tunnel('russia', KEEP)] },
    STORED,
    matchers,
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(secretsById(result.document), { relay: EXPECTED.relay, russia: EXPECTED.russia });
});

test('$keep: a new tunnel has nothing to keep, even where an old one used to sit', () => {
  // By index, `/tunnels/0` has a stored credential; by identity, `wftest` has none.
  const result = applyWrite(
    { tunnels: [tunnel('wftest', KEEP), tunnel('relay', KEEP), tunnel('hq', KEEP, [{ id: 'front-a', uid: KEEP }, { id: 'front-b', uid: KEEP }]), tunnel('russia', KEEP)] },
    STORED,
    matchers,
  );
  assert.deepEqual(result.errors.map((error) => error.pointer), ['/tunnels/0/config/id']);
});

test('omitting a kept secret is still refused after a reorder — the drop check is by identity too', () => {
  // The drop check walked the stored document by index as well: after a reorder it compared a stored
  // credential with a different tunnel's position. Here russia moved first and silently lost its `id`.
  const result = applyWrite(
    {
      tunnels: [
        { id: 'russia', name: 'russia', config: {} },
        tunnel('relay', KEEP),
        tunnel('hq', KEEP, [
          { id: 'front-a', uid: KEEP },
          { id: 'front-b', uid: KEEP },
        ]),
      ],
    },
    STORED,
    matchers,
  );
  // Reported where russia sits in the write the caller sent, which is the pointer they can act on.
  assert.deepEqual(result.errors.map((error) => error.pointer), ['/tunnels/0/config/id']);
});

test('a tunnel with no credential moved above one with a credential — no phantom "left out" error', () => {
  // The drop check compared the stored credential at index 0 with whatever now sits at index 0. A
  // tunnel with no credential there (a plain proxy) made a kept secret look deleted, and the write
  // was refused although nothing was lost. Mutation: compare by `pointer` instead of by
  // `counterpartPointer` in `droppedSecrets` and this goes red with /tunnels/0/config/id.
  const stored = wrapSecrets({ tunnels: [tunnel('relay', 'secret-relay'), { id: 'plain', name: 'plain', config: {} }] }, matchers);
  const result = applyWrite(
    { tunnels: [{ id: 'plain', name: 'plain', config: {} }, tunnel('relay', KEEP)] },
    stored,
    matchers,
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(secretsById(result.document), { plain: undefined, relay: { $secret: 'secret-relay' } });
});
