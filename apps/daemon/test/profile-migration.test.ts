/**
 * The migration path, exercised against a document at its input version.
 *
 * This is the machinery's first real use, and it was needed because of a mistake worth keeping: three
 * fields were added to the probe configuration **with defaults and no migration**. Defaults fill a gap for
 * documents written afterwards and do nothing for the ones already on devices — which are precisely the
 * documents an update meets. On the bench board the result was a watchdog throwing once every thirty
 * seconds against a profile that predated the fields.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import {
  PROFILE_SCHEMA_VERSION,
  ProfileDocument,
  emptyProfile,
  migrateProfile,
} from '@wayfarer/schemas';

/** A profile as version 1 wrote it: probes with the four thresholds it had and nothing else. */
function versionOneDocument(): Record<string, unknown> {
  const current = emptyProfile({ name: 'From an older build' }) as unknown as Record<string, unknown>;
  const policy = { ...(current['policy'] as Record<string, unknown>) };
  policy['probes'] = { count: 4, maxFails: 2, maxLatencyMs: 500, maxJitterMs: 250, failStreak: 2 };
  return { ...current, schemaVersion: 1, policy };
}

test('a version 1 document is invalid against the current schema, which is why a migration is needed', () => {
  assert.equal(
    Value.Check(ProfileDocument, versionOneDocument()),
    false,
    'if this passed, the fields were optional and no migration would have been required',
  );
});

test('the migration fills the probe fields and produces a valid document', () => {
  const result = migrateProfile(versionOneDocument());
  assert.equal(result.from, 1);
  // Every step from the document's version to the current one runs, in order. Asserting the *list* rather
  // than a count is what makes a later step's arrival visible here instead of silently absorbed.
  assert.deepEqual(result.applied, [
    'probe endpoints, loss threshold and interval',
    'blocked endpoints keep their suffix meaning',
    'where the management surface answers',
    'what a tunnel does when it is unavailable',
    'client name logging is a choice, not a default',
    'every tunnel becomes a catalogue entry',
    'a tunnel is asked whether it is alive, not a server behind it',
  ]);

  const probes = (result.document['policy'] as { probes: Record<string, unknown> }).probes;
  assert.equal(probes['maxLossPercent'], 34);
  assert.equal(probes['intervalSeconds'], 30);
  assert.deepEqual(probes['endpoints'], [
    'http://cp.cloudflare.com/generate_204',
    'http://connectivitycheck.gstatic.com/generate_204',
  ]);
  // The thresholds it already had are untouched.
  assert.equal(probes['maxLatencyMs'], 500);
  assert.equal(probes['failStreak'], 2);

  assert.equal(Value.Check(ProfileDocument, { ...result.document, schemaVersion: PROFILE_SCHEMA_VERSION }), true);
});

test('the migration does not overwrite values a document already has', () => {
  const partly = versionOneDocument();
  (partly['policy'] as { probes: Record<string, unknown> }).probes['intervalSeconds'] = 120;
  const result = migrateProfile(partly);
  const probes = (result.document['policy'] as { probes: Record<string, unknown> }).probes;
  assert.equal(probes['intervalSeconds'], 120, 'an operator choice survives the migration');
});

test('a current document passes through with no steps applied', () => {
  const result = migrateProfile(emptyProfile({ name: 'current' }) as unknown as Record<string, unknown>);
  assert.deepEqual(result.applied, [], 'and therefore nothing is written back on an ordinary read');
});

test('the values are written out rather than imported from the defaults', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const source = await readFile(
    join(import.meta.dirname, '..', '..', '..', 'packages', 'schemas', 'src', 'profile-migrations.ts'),
    'utf8',
  );
  /*
   * A migration that followed the current defaults would rewrite old documents differently depending on
   * when it ran, so the step carries its own literals. This asserts that rather than trusting the comment
   * saying so.
   */
  // Comments stripped: the step's own docstring names `profile-defaults.ts` to explain why it does not
  // import from it, and a test that matched prose would fail on that explanation.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('profile-defaults'), 'a step must not depend on values that can move');
  assert.ok(source.includes("'http://cp.cloudflare.com/generate_204'"));
});
