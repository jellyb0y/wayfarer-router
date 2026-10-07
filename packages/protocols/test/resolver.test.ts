/**
 * The resolver, tested against the real schema.
 *
 * The fixture is the unmodified 444 895-byte output of `sing-box schema` from the bench board
 * (sing-box 1.14.0, tags including `with_quic,with_wireguard,with_openvpn,with_clash_api`,
 * captured 2026-09-19). It is checked in at full size on purpose: the properties this resolver
 * exists for — a nested `oneOf`, and one type occupying two branches — cannot be reproduced by a
 * hand-made miniature, and a fixture that cannot reproduce them proves nothing about them.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  AmbiguousBranchError,
  flattenUnion,
  jsonTypeOf,
  resolveBranch,
  unionTypes,
} from '../src/resolver.ts';
import { inlineRefs, resolveRef, SchemaResolutionError, type JsonSchemaNode } from '../src/json.ts';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(here, 'fixtures', 'core-schema-sing-box-1.14.0.json'), 'utf8'),
) as JsonSchemaNode;

const defs = schema['$defs'] as Record<string, JsonSchemaNode>;
const outbound = defs['Outbound']!;
const endpoint = defs['Endpoint']!;

test('the fixture is the schema that was measured, unmodified', () => {
  // Guards against somebody trimming the fixture to make a test faster. The numbers are the ones in
  // the documentation, and if they move it is because the core moved, which is worth noticing.
  assert.equal(schema['$schema'], 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(Object.keys(defs).length, 93);
  const text = readFileSync(join(here, 'fixtures', 'core-schema-sing-box-1.14.0.json'), 'utf8');
  assert.equal(Buffer.byteLength(text, 'utf8'), 444_895);
  // The absence of documentation in this schema is the reason the metadata overlay exists at all.
  assert.equal(text.includes('"description"'), false);
  assert.equal(text.includes('"title"'), false);
});

test('the outbound union is nested, and flattening finds the branch a single level misses', () => {
  const shallow = outbound['oneOf'] as unknown[];
  assert.equal(shallow.length, 20, 'the union reports 20 entries at the top level');

  const flat = flattenUnion(outbound);
  assert.equal(flat.length, 21, 'one of those entries is itself a oneOf, so flattened it is 21');
});

test('snell occupies two branches, so type alone is not a discriminator', () => {
  const flat = flattenUnion(outbound);
  const snell = flat.filter((branch) => {
    const properties = branch['properties'] as Record<string, JsonSchemaNode> | undefined;
    return properties?.['type']?.['const'] === 'snell';
  });
  assert.equal(snell.length, 2);

  // And the thing that separates them is a second const, which is what the resolver looks for.
  const versions = snell.map((branch) => (branch['properties'] as Record<string, JsonSchemaNode>)['version']?.['const']);
  assert.equal(new Set(versions.map((v) => JSON.stringify(v))).size, 2);
});

test('unionTypes lists every protocol once, including the nested one', () => {
  const types = unionTypes(outbound);
  assert.equal(types.length, 20, 'snell appears once although it has two branches');
  for (const expected of ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic', 'direct', 'snell']) {
    assert.ok(types.includes(expected), `expected ${expected} in ${types.join(',')}`);
  }
  // WireGuard is deliberately absent here: in this build it is an endpoint, not an outbound.
  assert.equal(types.includes('wireguard'), false);
});

test('wireguard is an endpoint in this build, and endpoints resolve the same way', () => {
  const types = unionTypes(endpoint);
  assert.deepEqual(types.sort(), ['openconnect', 'openvpn-client', 'openvpn-server', 'tailscale', 'wireguard']);

  const resolved = resolveBranch(schema, endpoint, 'wireguard');
  const names = resolved.fields.map((field) => field.name);
  assert.ok(names.includes('peers'));
  assert.ok(names.includes('private_key'));
});

test('resolving a plain branch yields flat descriptors with the schema facts carried through', () => {
  const resolved = resolveBranch(schema, outbound, 'vless');
  const byName = new Map(resolved.fields.map((field) => [field.name, field]));

  assert.equal(byName.get('type')?.const, 'vless');
  assert.equal(byName.get('server')?.jsonType, 'string');
  assert.equal(byName.get('server_port')?.jsonType, 'integer');
  assert.equal(byName.get('uuid')?.jsonType, 'string');

  // x-tag-reference is the schema telling us a field names another object, which is enough to
  // render a picker without knowing anything about the protocol.
  assert.equal(byName.get('detour')?.tagReference, 'outbound');
});

test('an unresolvable type is an error naming the discriminator, not an empty form', () => {
  assert.throws(
    () => resolveBranch(schema, outbound, 'not-a-protocol'),
    (error: unknown) => error instanceof SchemaResolutionError && error.pointer === '/type',
  );
});

test('an ambiguous branch reports the property that separates it rather than guessing', () => {
  const resolved = resolveBranch(schema, outbound, 'snell');
  assert.ok(resolved.discriminatedBy, 'the resolver must say a secondary discriminator was needed');
  assert.equal(resolved.discriminatedBy?.property, 'version');
});

test('a caller that names the secondary discriminator gets exactly that branch', () => {
  const resolved = resolveBranch(schema, outbound, 'snell', {
    secondary: { property: 'version', value: 4 },
  });
  const version = resolved.fields.find((field) => field.name === 'version');
  assert.equal(version?.const, 4);
});

test('a secondary discriminator that separates nothing is refused, not first-matched', () => {
  // Two branches of one type pinned on nothing that differs. The resolver must refuse: a form built
  // from either one is wrong for the other, and the user cannot see which they got.
  const union: JsonSchemaNode = {
    oneOf: [
      { type: 'object', properties: { type: { const: 'twin' }, a: { type: 'string' } } },
      { type: 'object', properties: { type: { const: 'twin' }, b: { type: 'string' } } },
    ],
  };
  assert.throws(
    () => resolveBranch(union, union, 'twin'),
    (error: unknown) => error instanceof AmbiguousBranchError && error.type === 'twin',
  );
});

test('references are inlined so the renderer never has to resolve anything', () => {
  const resolved = resolveBranch(schema, outbound, 'vless');
  const text = JSON.stringify(resolved.schema);
  // Remaining $refs are only the ones left in place to terminate a cycle; there must be far fewer
  // than the branch started with, and the common Duration reference must be gone.
  const duration = JSON.stringify(resolveRef(schema, '#/$defs/Duration'));
  assert.ok(text.includes(duration.slice(1, 30)), 'Duration was inlined rather than referenced');
});

test('inlining terminates on a self-referential schema instead of exhausting the stack', () => {
  const recursive: JsonSchemaNode = {
    $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
  };
  const target = resolveRef(recursive, '#/$defs/Node');
  const inlined = inlineRefs(recursive, target, 4);
  assert.ok(JSON.stringify(inlined).length > 0);
});

test('a remote reference is refused rather than fetched', () => {
  // A schema that could pull in a URL would turn a binary's output into a network request made by a
  // root daemon. That is not a capability this project wants to have.
  assert.throws(
    () => resolveRef({}, 'https://example.invalid/schema.json'),
    (error: unknown) => error instanceof SchemaResolutionError,
  );
});

test('a field with no declared type still resolves, as unknown rather than as nothing', () => {
  assert.equal(jsonTypeOf({}), 'unknown');
  assert.equal(jsonTypeOf({ type: ['string', 'null'] }), 'string');
  assert.equal(jsonTypeOf({ anyOf: [{ type: 'string' }, { type: 'null' }] }), 'string');
});

test('every protocol in the union resolves to a non-empty form', () => {
  // The whole extensibility claim rests on this: a protocol nobody here has described still
  // produces a usable form. If any branch resolves to nothing, that claim is false for it.
  for (const type of unionTypes(outbound)) {
    const resolved = resolveBranch(schema, outbound, type);
    assert.ok(resolved.fields.length > 0, `${type} resolved to no fields`);
    assert.ok(
      resolved.fields.some((field) => field.name === 'type'),
      `${type} lost its discriminator`,
    );
  }
});
