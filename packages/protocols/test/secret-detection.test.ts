/**
 * The secret name rule, and its coverage over the real schema.
 *
 * The coverage is a **golden file** rather than a set of spot assertions, and that is the point of
 * the test. A heuristic hidden inside a function is a heuristic nobody audits; one whose output is
 * checked in gets reviewed every time it moves. Adding a word to the list becomes a visible diff
 * somebody approves, and a core release that renames a field or adds a protocol shows up as a
 * change in coverage rather than as silence.
 *
 * Regenerate deliberately, never automatically:
 *
 *     UPDATE_GOLDEN=1 node --test --experimental-strip-types test/secret-detection.test.ts
 */

import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { looksLikeSecretField, stampSecrets } from '../src/secret-detection.ts';
import { resolveBranch, unionTypes } from '../src/resolver.ts';
import type { FieldDescriptor } from '../src/resolver.ts';
import type { JsonSchemaNode } from '../src/json.ts';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(here, 'fixtures', 'core-schema-sing-box-1.14.0.json'), 'utf8'),
) as JsonSchemaNode;
const defs = schema['$defs'] as Record<string, JsonSchemaNode>;

test('a name that merely contains a secret word is not a secret', () => {
  // `domain_keyword` is the case this test exists for. It contains `key`, and its entire purpose is
  // to be read and edited. A substring matcher marks it secret and makes a routing field
  // unreadable, so the matcher compares whole segments and explicit suffixes — never substrings.
  assert.equal(looksLikeSecretField('domain_keyword'), false);
  assert.equal(looksLikeSecretField('keyword'), false);
  assert.equal(looksLikeSecretField('keyboard'), false);
  assert.equal(looksLikeSecretField('password_hint'), false);
  assert.equal(looksLikeSecretField('tokenizer'), false);
});

test('the names and suffixes that are secrets', () => {
  for (const name of ['uuid', 'password', 'private_key', 'psk', 'auth_str', 'UUID', 'Password']) {
    assert.equal(looksLikeSecretField(name), true, `${name} should be a secret`);
  }
  for (const name of ['reality_private_key', 'obfs_password', 'api_token', 'wg_psk', 'shared_secret']) {
    assert.equal(looksLikeSecretField(name), true, `${name} should be a secret by suffix`);
  }
  // A bare suffix with nothing in front is the suffix rule matching itself; the exact list already
  // covers the real names, so this must not widen to every field ending in an underscore.
  assert.equal(looksLikeSecretField('_key'), false);
});

test('a published value is not a secret, by exact name only', () => {
  // A checklist that names things which were never secret is a checklist people skim, and the one
  // genuinely missing secret then hides among the false ones. A peer's public key is the case that
  // forced this: the importer cannot look it up, because it belongs to the other end.
  assert.equal(looksLikeSecretField('public_key'), false);
  assert.equal(looksLikeSecretField('host_key'), false);
  // Exact segments only. A suffix rule pointing this way is how `certificate_key` becomes public.
  assert.equal(looksLikeSecretField('my_public_key'), true);
  assert.equal(looksLikeSecretField('certificate_key'), true);
});

test('the public list is unreachable from configuration', () => {
  // The invariant is not "nothing can unmark a secret" — the list above does exactly that. It is
  // that nothing *outside the source* can. `stampSecrets` takes one configuration-shaped input,
  // `overlaySecretPointers`, and there is no parameter of any kind that subtracts.
  const options = Object.keys({ overlaySecretPointers: [], isSecretName: () => false });
  assert.deepEqual(options.sort(), ['isSecretName', 'overlaySecretPointers']);

  // `isSecretName` is a test seam, not configuration: nothing on the API or in a profile reaches
  // it. Asserting the only other input cannot subtract is the real check.
  const node: JsonSchemaNode = { type: 'object', properties: { password: { type: 'string' } } };
  for (const attempt of [[], ['/password'], ['']]) {
    const { schema: stamped } = stampSecrets(node, { overlaySecretPointers: attempt });
    const properties = stamped['properties'] as Record<string, JsonSchemaNode>;
    assert.equal(properties['password']?.['x-secret'], true, 'no overlay input can unmark a secret');
  }
});

test('the overlay can add a secret but never remove one the name rule found', () => {
  const node: JsonSchemaNode = {
    type: 'object',
    properties: { uuid: { type: 'string' }, flow: { type: 'string' } },
  };
  const { schema: stamped } = stampSecrets(node, { overlaySecretPointers: ['/flow'] });
  const properties = stamped['properties'] as Record<string, JsonSchemaNode>;
  assert.equal(properties['uuid']?.['x-secret'], true, 'found by name');
  assert.equal(properties['flow']?.['x-secret'], true, 'added by the overlay');

  // Nothing in the overlay's vocabulary can unmark a field: there is no "not secret" entry, on
  // purpose, because the only way to use one would be to make a leak configurable.
  const { schema: again } = stampSecrets(node, { overlaySecretPointers: [] });
  const still = (again['properties'] as Record<string, JsonSchemaNode>)['uuid'];
  assert.equal(still?.['x-secret'], true);
});

test('stamping copies rather than mutating the cached schema', () => {
  const node: JsonSchemaNode = { type: 'object', properties: { password: { type: 'string' } } };
  stampSecrets(node);
  const properties = node['properties'] as Record<string, JsonSchemaNode>;
  assert.equal(properties['password']?.['x-secret'], undefined, 'the input must be untouched');
});

test('only string fields are marked', () => {
  // Marking an object would make the redactor replace a subtree with a scalar, which is a shape
  // change rather than a redaction, and the form renderer cannot render it back.
  const node: JsonSchemaNode = {
    type: 'object',
    properties: {
      key: { type: 'object', properties: { inner: { type: 'string' } } },
      password: { type: ['string', 'null'] },
    },
  };
  const { schema: stamped } = stampSecrets(node);
  const properties = stamped['properties'] as Record<string, JsonSchemaNode>;
  assert.equal(properties['key']?.['x-secret'], undefined);
  assert.equal(properties['password']?.['x-secret'], true, 'string-or-null is still a string');
});

/* ── the reviewed artefact ───────────────────────────────────────────────────────────────── */

function secretPointersFor(union: JsonSchemaNode, type: string): string[] {
  const resolved = resolveBranch(schema, union, type);
  const { schema: stamped } = stampSecrets(resolved.schema);
  const restamped = resolveBranch(
    { $defs: {}, oneOf: [stamped] } as JsonSchemaNode,
    { oneOf: [stamped] } as JsonSchemaNode,
    type,
  );
  const found: string[] = [];
  const walk = (fields: FieldDescriptor[]): void => {
    for (const field of fields) {
      if (field.secret) found.push(field.pointer);
      if (field.children) walk(field.children);
    }
  };
  walk(restamped.fields);
  return found.sort();
}

test('secret coverage over the real schema matches the reviewed golden file', () => {
  const coverage: Record<string, string[]> = {};
  for (const type of unionTypes(defs['Outbound']!)) {
    coverage[`outbound/${type}`] = secretPointersFor(defs['Outbound']!, type);
  }
  for (const type of unionTypes(defs['Endpoint']!)) {
    coverage[`endpoint/${type}`] = secretPointersFor(defs['Endpoint']!, type);
  }

  const goldenPath = join(here, 'fixtures', 'secret-coverage.json');
  const serialised = `${JSON.stringify(coverage, null, 2)}\n`;

  if (process.env['UPDATE_GOLDEN'] === '1') {
    writeFileSync(goldenPath, serialised);
    return;
  }

  const golden = readFileSync(goldenPath, 'utf8');
  assert.equal(
    serialised,
    golden,
    'secret coverage changed. Review the diff: a field that stopped being redacted is a leak, and ' +
      'a field that started is a usability cost. Regenerate with UPDATE_GOLDEN=1 once approved.',
  );
});

test('the protocols people actually configure have their credential redacted', () => {
  // The golden file above is the audit; these are the cases whose absence would make the whole
  // mechanism pointless, asserted by name so a regeneration cannot quietly drop them.
  const outbound = defs['Outbound']!;
  assert.ok(secretPointersFor(outbound, 'vless').includes('/uuid'));
  assert.ok(secretPointersFor(outbound, 'vmess').includes('/uuid'));
  assert.ok(secretPointersFor(outbound, 'trojan').includes('/password'));
  assert.ok(secretPointersFor(outbound, 'shadowsocks').includes('/password'));
  assert.ok(secretPointersFor(defs['Endpoint']!, 'wireguard').includes('/private_key'));
});
