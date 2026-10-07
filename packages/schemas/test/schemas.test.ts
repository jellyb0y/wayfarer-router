import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import {
  ALL_SCHEMAS,
  ChangePasswordRequest,
  ErrorResponse,
  LogsQuery,
  LogsResponse,
  SystemResponse,
} from '../src/index.ts';

test('every registered schema has a unique $id, because the server registers them by it', () => {
  const ids = ALL_SCHEMAS.map((schema) => (schema as { $id?: string }).$id).filter(
    (id): id is string => typeof id === 'string',
  );
  assert.equal(new Set(ids).size, ids.length);
  // A schema with no $id cannot be referenced from another one, which is a silent way to end up
  // with an inlined duplicate in the generated OpenAPI document.
  assert.equal(ids.length, ALL_SCHEMAS.length);
});

test('the error contract requires a code and a message and allows a pointer and a hint', () => {
  assert.equal(Value.Check(ErrorResponse, { error: { code: 'invalid_request', message: 'no' } }), true);
  assert.equal(
    Value.Check(ErrorResponse, {
      error: {
        code: 'invariant_violation',
        message: 'that radio cannot do both',
        pointer: '/accessPoint/bind',
        hint: 'assign the access point to the other radio',
        detail: { phy: 'phy1' },
      },
    }),
    true,
  );
  // A message with no code cannot be acted on programmatically, which is the whole point of having
  // a contract rather than a string.
  assert.equal(Value.Check(ErrorResponse, { error: { message: 'something' } }), false);
});

test('the password change refuses anything shorter than twelve characters', () => {
  assert.equal(Value.Check(ChangePasswordRequest, { currentPassword: 'wayfarer', newPassword: 'short' }), false);
  assert.equal(
    Value.Check(ChangePasswordRequest, { currentPassword: 'wayfarer', newPassword: 'twelve-chars' }),
    true,
  );
});

test('the log query bounds its limit, because an unbounded journal read is a memory hazard', () => {
  assert.equal(Value.Check(LogsQuery, { limit: 2000 }), true);
  assert.equal(Value.Check(LogsQuery, { limit: 2001 }), false);
  assert.equal(Value.Check(LogsQuery, { level: 8 }), false);
  assert.equal(Value.Check(LogsQuery, {}), true);
});

test('the logs response carries the boot-id facts the interface has to state', () => {
  const properties = Object.keys((LogsResponse as unknown as { properties: Record<string, unknown> }).properties);
  // After a power cut the journal is empty for earlier boots, and an empty log must not read as an
  // absence of events — so these three are part of the contract, not of the interface's guesswork.
  for (const required of ['currentBootId', 'containsEarlierBoots', 'currentBootEmpty']) {
    assert.ok(properties.includes(required), `${required} missing from LogsResponse`);
  }
});

test('the system response keeps binary detection in the contract', () => {
  const properties = Object.keys((SystemResponse as unknown as { properties: Record<string, unknown> }).properties);
  // A capability gap should be a sentence in the interface rather than a cryptic failure at apply
  // time, which needs the detected binaries to be part of the response.
  assert.ok(properties.includes('binaries'));
  assert.ok(properties.includes('clock'));
  assert.ok(properties.includes('listen'));
});
