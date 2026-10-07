/**
 * Parity's hard core, from the daemon's side: the required set *is* the refusal's own vocabulary.
 *
 * ## What this file is, and what it deliberately is not
 *
 * It does not compare anything against the interface. That comparison runs in the interface's own
 * suite, in the same process that writes the manifest from the rendered DOM — read the manifest
 * from a second process and it can be stale, and a stale manifest fails in the reassuring
 * direction, still listing a field that was since deleted from a screen. The possibility is removed
 * rather than detected.
 *
 * What belongs here is the claim that makes layer 1 worth anything, and it is about the daemon
 * rather than about any screen: **the positions `parityRequirements()` marks `refusal` are exactly
 * the positions a missing-secret refusal can name, in both directions.**
 *
 * That is the whole reason layer 1 admits no exception. The daemon already refuses to activate a
 * profile whose secrets are missing and names the positions; that list is the system's own answer
 * to *a person must fill this*, derived from the document by the same code that then blocks the
 * activation. No annotation and no file can excuse a pointer from it, because the daemon would
 * refuse regardless. The claim holds only while the two sets are the same set, so it is asserted
 * rather than believed.
 *
 * ## Both directions, because each names a different defect
 *
 * * **A required position the refusal could never name** is a requirement no input can satisfy —
 *   the mirror of a guard control never reaches, a shape this project has found before inside the
 *   commit that fixed the previous one. It would fail parity forever for a field that cannot exist.
 * * **A position the refusal names that is not required** is a hole: the daemon blocks activation
 *   over a credential that parity never asked any screen to offer.
 *
 * ## Why the divergence this guards against is not hypothetical
 *
 * It has already happened once, in the other direction. `state/secret-plan.ts` used to reduce the
 * static schema and then widen it from a provider registry, because a tunnel's configuration was an
 * opaque record. A device whose core had not been unpacked got the *narrow* answer, and the narrow
 * answer covered nothing inside `/tunnels/-/config` — which is how five obfuscation identities and
 * a user id came to be stored bare, returned by `GET`, and shipped in clear by the export that
 * exists to be shared. Schema 7 removed the opacity and the registry call with it. This assertion
 * is what would notice the plan narrowing again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { missingSecrets, parityRequirements } from '@wayfarer/schemas';

import { createSecretPlan } from '../src/state/secret-plan.ts';

/**
 * A document holding a value at every matcher position, built from the matchers themselves.
 *
 * Deriving the document from the list under test looks circular and is not. `missingSecrets` walks
 * the *document*, so a position absent from the document is never visited and never named; handing
 * it a hand-written fixture would test the fixture's coverage rather than the plan's. What this
 * establishes is the thing in question: every matcher is a position the refusal can **reach**.
 *
 * `null` at each leaf, because that is one of the three states `missingSecrets` counts as missing,
 * and the one that needs no wrapper.
 */
function documentWithEverySecretPosition(matchers: Iterable<string>): unknown {
  const root: Record<string, unknown> = {};
  for (const matcher of matchers) {
    const segments = matcher.split('/').slice(1);
    let node: Record<string | number, unknown> = root;
    for (let index = 0; index < segments.length; index += 1) {
      const raw = segments[index]!;
      // `-` in a matcher means "any array element", so the document gets exactly one: index 0. Any
      // index would do — `normalise` turns it back into `-` on the way out.
      const key = raw === '-' ? 0 : raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (index === segments.length - 1) node[key] = null;
      else {
        node[key] ??= segments[index + 1] === '-' ? [] : {};
        node = node[key] as Record<string | number, unknown>;
      }
    }
  }
  return root;
}

/** A concrete pointer back to the position it describes: `/tunnels/0/…` becomes `/tunnels/-/…`. */
function normalise(pointer: string): string {
  return pointer
    .split('/')
    .map((segment) => (/^\d+$/.test(segment) ? '-' : segment))
    .join('/');
}

test('layer 1 is exactly the set of positions a missing-secret refusal can name', () => {
  const matchers = createSecretPlan().forDocument({});
  const document = documentWithEverySecretPosition(matchers.keys());

  const namedByRefusal = [...new Set(missingSecrets(document, matchers).map((site) => normalise(site.pointer)))].sort();
  const requiredByParity = parityRequirements()
    .filter((entry) => entry.layer === 'refusal')
    .map((entry) => entry.pointer)
    .sort();

  assert.deepEqual(
    requiredByParity,
    namedByRefusal,
    'a requirement the refusal cannot name can never be satisfied; a position the refusal names ' +
      'that parity does not require is a credential no screen was ever asked to offer',
  );
});

/**
 * The assertion above compares two derived lists, and two derived lists can agree by both being
 * empty. That would be a green run proving nothing — the shape this project has found in a layout
 * check reporting three passes about a blank page.
 */
test('neither side of that comparison is empty', () => {
  const matchers = createSecretPlan().forDocument({});
  assert.ok(matchers.size > 0, 'the secret plan reduced the document schema to no matchers at all');
  assert.ok(
    parityRequirements().some((entry) => entry.layer === 'refusal'),
    'parity requires nothing on the refusal layer, so the comparison above is vacuous',
  );
});
