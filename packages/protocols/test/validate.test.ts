/**
 * Validation against the real schema, including the cases that make it input rather than a fact.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  createValidatorCache,
  MAX_SCHEMA_BYTES,
  parseForeignSchema,
  SchemaCompileError,
} from '../src/validate.ts';
import { resolveBranch } from '../src/resolver.ts';
import type { JsonSchemaNode } from '../src/json.ts';

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, 'fixtures', 'core-schema-sing-box-1.14.0.json'), 'utf8');
const schema = parseForeignSchema(text);
const outbound = (schema['$defs'] as Record<string, JsonSchemaNode>)['Outbound']!;

test('a well-formed outbound validates against its own resolved branch', () => {
  const branch = resolveBranch(schema, outbound, 'vless');
  const validator = createValidatorCache().forSchema('test', () => branch.schema);

  const result = validator.validate({
    type: 'vless',
    tag: 'example',
    server: '198.51.100.7',
    server_port: 443,
    uuid: '00000000-0000-4000-8000-000000000000',
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test('a wrong field type is reported with a JSON Pointer, which is what the contract promises', () => {
  const branch = resolveBranch(schema, outbound, 'vless');
  const validator = createValidatorCache().forSchema('test', () => branch.schema);

  const result = validator.validate({ type: 'vless', server_port: 'four-four-three' });
  assert.equal(result.valid, false);
  const issue = result.issues.find((entry) => entry.pointer === '/server_port');
  assert.ok(issue, `expected an issue at /server_port, got ${JSON.stringify(result.issues)}`);
});

test('an unknown field is rejected, because the branch declares additionalProperties false', () => {
  const branch = resolveBranch(schema, outbound, 'vless');
  const validator = createValidatorCache().forSchema('test', () => branch.schema);

  const result = validator.validate({ type: 'vless', server: 'a', not_a_real_field: 1 });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.keyword === 'additionalProperties'));
});

test('a missing required property points at the property, not at the object', () => {
  const node: JsonSchemaNode = {
    type: 'object',
    properties: { server: { type: 'string' } },
    required: ['server'],
  };
  const validator = createValidatorCache().forSchema('missing', () => node);
  const result = validator.validate({});
  assert.equal(result.valid, false);
  // An interface pointed at the object would highlight the whole form.
  assert.equal(result.issues[0]?.pointer, '/server');
});

test('the whole schema compiles, which is the claim the protocol model rests on', () => {
  const cache = createValidatorCache();
  const validator = cache.forSchema('full', () => schema);
  // A complete, minimal configuration: if the top-level document cannot be validated, nothing the
  // planner generates can be checked before it reaches the core.
  const result = validator.validate({ log: { level: 'info' }, outbounds: [{ type: 'direct', tag: 'direct' }] });
  assert.equal(result.valid, true, JSON.stringify(result.issues.slice(0, 5)));
});

test('a compiled validator is cached, because compiling 445 KB is not free on this board', () => {
  const cache = createValidatorCache();
  const first = cache.forSchema('same', () => schema);
  const second = cache.forSchema('same', () => {
    throw new Error('the schema must not be read again for a key already compiled');
  });
  assert.equal(first, second);
  assert.equal(cache.size(), 1);
});

test('a schema that is not JSON fails the fetch cleanly', () => {
  assert.throws(() => parseForeignSchema('{not json'), (error: unknown) => error instanceof SchemaCompileError);
  assert.throws(() => parseForeignSchema('[]'), (error: unknown) => error instanceof SchemaCompileError);
});

test('an oversized schema is refused before it is parsed', () => {
  // Before, not after: the point of the bound is not to discover the cost once it has been paid.
  const huge = `{"x":"${'a'.repeat(MAX_SCHEMA_BYTES)}"}`;
  assert.throws(
    () => parseForeignSchema(huge),
    (error: unknown) => error instanceof SchemaCompileError && /refusing a schema of/.test(error.message),
  );
});

test('a schema that cannot compile is an error the caller can report, not an unhandled throw', () => {
  const cache = createValidatorCache();
  assert.throws(
    () => cache.forSchema('broken', () => ({ type: 'object', properties: { a: { type: 'not-a-type' } } })),
    (error: unknown) => error instanceof SchemaCompileError,
  );
  // And a failed compile leaves nothing behind that a later call would find and trust.
  assert.equal(cache.size(), 0);
});

test('unknown annotations do not stop validation', () => {
  // `x-tag-reference` is the core's own; `x-secret` is ours, stamped on. Strict mode would turn
  // either into a device that cannot validate any tunnel at all.
  const node: JsonSchemaNode = {
    type: 'object',
    properties: { uuid: { type: 'string', 'x-secret': true, 'x-tag-reference': 'outbound' } },
  };
  const validator = createValidatorCache().forSchema('annotated', () => node);
  assert.equal(validator.validate({ uuid: 'x' }).valid, true);
});
