/**
 * The marking of secrets, checked against itself and against a real document.
 *
 * ## The defect these exist for
 *
 * A redacted export of the bench profile, taken 2026-09-21, carried credentials in clear. Two separate
 * causes, both invisible from the redaction side:
 *
 * 1. The external-client schema declared `configFile` as an ordinary string while the transport schema
 *    declared the identical field `x-secret`. Same field, same meaning, different marking, no reason —
 *    a schema written by copying its neighbour and losing a line.
 * 2. Nothing ever walked `/tunnels/-/transports/`, so the transport's *correct* marking was never read.
 *    Five blobs carrying `UID` and `PublicKey` left in clear, and the export's own `leavingInClear`
 *    report — built from the same matchers — did not mention any of them.
 *
 * The redaction machinery was correct throughout. It redacts what it is told is a secret, and it was
 * told wrong. **This is a marking defect, not a redaction defect**, and a test that asked "is everything
 * marked today?" would have to be rewritten every time a field is added, which means it would not be.
 *
 * ## So these two tests are written to fail on tomorrow's omission rather than today's
 *
 * The first derives what counts as a credential **from our own markings** rather than from a list
 * somebody maintains: a field name we call secret in one schema must be secret in every schema that has
 * it. It needs no list to keep current, and it is exactly the asymmetry that caused the leak.
 *
 * The second works on values rather than names: an invented credential is planted in every opaque blob
 * a profile has, and the export is searched for it as text. A field added next year, in a shape nobody
 * here anticipated, is still caught the moment its value survives redaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProfileDocument, redactForExport, TUNNEL_CONFIGS } from '@wayfarer/schemas';
import { secretPointersIn, type JsonSchemaNode } from '@wayfarer/protocols';

import { createSecretPlan } from '../src/state/secret-plan.ts';

/**
 * Every schema **this project authors**, which is now all of them.
 *
 * It used to be "the registry's schemas with no core installed", a phrasing that existed only to
 * exclude the foreign schema a binary emitted. There is no foreign schema in a tunnel's configuration
 * any more: the catalogue's three entries are declared here, so the markings are entirely ours to get
 * right and the asymmetry this test hunts is entirely ours to cause.
 */
function ourSchemas(): { id: string; schema: JsonSchemaNode }[] {
  return [
    ...Object.entries(TUNNEL_CONFIGS).map(([id, schema]) => ({ id, schema: schema as unknown as JsonSchemaNode })),
    { id: 'profile', schema: ProfileDocument as unknown as JsonSchemaNode },
  ];
}

/** Every property name in a schema, with whether each occurrence is marked secret. */
function propertyMarks(schema: JsonSchemaNode): Map<string, boolean[]> {
  const marks = new Map<string, boolean[]>();
  const secretPointers = new Set(secretPointersIn(schema).map((entry) => entry.pointer));

  const walk = (node: unknown, pointer: string): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    const properties = record['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
        const childPointer = `${pointer}/${name}`;
        const list = marks.get(name) ?? [];
        list.push(secretPointers.has(childPointer));
        marks.set(name, list);
        walk(child, childPointer);
      }
    }
    /*
     * Union branches share the pointer of the node they belong to, exactly as the secret walk treats
     * them: a value at that position matches one branch, and which one is not knowable from the schema.
     * Descended because `Tunnel` is a union now — a walk that stopped at `properties` would never reach
     * a single tunnel configuration through the profile, and would report a clean result for a schema it
     * had not looked at.
     */
    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = record[keyword];
      if (Array.isArray(branches)) for (const branch of branches) walk(branch, pointer);
    }

    // `$defs` is not walked: a definition is only reachable through a reference, and a reference that
    // is never used is not a field anybody can fill.
  };

  walk(schema, '');
  return marks;
}

test('a field name we call secret in one schema is secret in every schema that has it', () => {
  const schemas = ourSchemas();
  assert.ok(schemas.length >= 4, 'the three catalogue configurations and the document schema');

  // Discovered, not declared: what counts as a credential comes from where we already said so.
  const secretNames = new Set<string>();
  for (const { schema } of schemas) {
    for (const [name, occurrences] of propertyMarks(schema)) {
      if (occurrences.some(Boolean)) secretNames.add(name);
    }
  }

  const unmarked: string[] = [];
  for (const { id, schema } of schemas) {
    for (const [name, occurrences] of propertyMarks(schema)) {
      if (!secretNames.has(name)) continue;
      if (occurrences.every(Boolean)) continue;
      unmarked.push(`${id}: "${name}" is a secret elsewhere and is not marked here`);
    }
  }

  assert.deepEqual(
    unmarked,
    [],
    `these fields are marked secret in one schema and left bare in another:\n  ${unmarked.join('\n  ')}`,
  );
});

/**
 * The shape of the bench profile, in catalogue form, with every real value replaced by an invented one.
 *
 * Four tunnels and five obfuscation entry points, because that is what the device actually runs and a
 * fixture that cannot express the defect proves nothing: the leak lived in the *fourth* tunnel's entry
 * points, which a one-tunnel fixture would never have reached. The old version of this fixture wrote
 * them as a separate `transports` list with the whole client configuration inside a string; that is the
 * shape the catalogue replaced, and the credentials are now fields with names.
 */
const PLANTED = 'a1b2c3d4-0000-4000-8000-planted0cred';

function benchShapedProfile(): Record<string, unknown> {
  const entryPoint = (id: string): Record<string, unknown> => ({
    id,
    host: 'entry.example.com',
    port: 443,
    // The field that leaked, five times, out of a *redacted* export.
    uid: PLANTED,
    // Deliberately not planted: it is public by construction, and marking things that are not
    // credentials makes a redacted export useless for diagnosing what it was exported to diagnose.
    publicKey: 'a-public-key',
    proxyMethod: 'openvpn',
    encryptionMethod: 'aes-gcm',
    serverName: 'www.example.com',
    browserSignature: 'chrome',
    transport: 'direct',
  });

  return {
    schemaVersion: 7,
    meta: { name: 'shaped like the bench' },
    tunnels: [
      {
        id: 'corp',
        name: 'Collector',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        protocol: 'cloak-openvpn',
        config: {
          profile: `client\nremote example.com 1194\n<key>${PLANTED}</key>\n`,
          interfaceSuffix: 'crp',
          entryPoints: [entryPoint('corp-a')],
        },
      },
      {
        id: 'partner',
        name: 'Second',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        protocol: 'openvpn',
        config: { profile: `client\n<key>${PLANTED}</key>\n`, interfaceSuffix: 'prt' },
      },
      {
        id: 'sub',
        name: 'External',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        protocol: 'vless',
        config: {
          server: 'node.example.net',
          port: 443,
          // The account, which in VLESS is the whole credential.
          id: PLANTED,
          // Key material, 1.6 KiB of it on the bench, and the field that decides the carrier.
          encryption: `mlkem768x25519plus.native.0rtt.${PLANTED}`,
          network: 'tcp',
          security: 'tls',
        },
      },
      {
        id: 'hq',
        name: 'HQ',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        protocol: 'cloak-openvpn',
        config: {
          profile: `client\n<key>${PLANTED}</key>\n`,
          interfaceSuffix: 'hq',
          auth: { username: 'someone', password: PLANTED },
          // Four entry points, one per site: the array is an array for this reason.
          entryPoints: ['hq-a', 'hq-b', 'hq-c', 'hq-d'].map((id) => entryPoint(id)),
        },
      },
    ],
  };
}

test('no planted credential survives a redacted export, anywhere in a bench-shaped profile', () => {
  const plan = createSecretPlan();
  const document = benchShapedProfile();

  const exported = redactForExport(document, plan.forDocument(document));
  const text = JSON.stringify(exported);

  /*
   * Searched as text rather than pointer by pointer, deliberately.
   *
   * A pointer-by-pointer assertion can only check the places its author thought of, which is the same
   * blind spot that produced the defect: the walk did not know transports existed, so a test written
   * from the same understanding would not have looked there either. Searching the serialised document
   * asks the only question that matters to somebody about to attach this file to an email — is the
   * credential in here, anywhere.
   */
  assert.equal(
    text.includes(PLANTED),
    false,
    'a credential survived redaction somewhere in the export; search the output for the planted value',
  );
});

test('the planted-credential test can produce the failure it claims to exclude', () => {
  // The guard above is only worth something if an unmarked field really does reach the output. With no
  // matchers at all, every planted value must survive — otherwise the test would pass for a reason
  // that has nothing to do with marking, and would keep passing after the marking was lost.
  const document = benchShapedProfile();
  const text = JSON.stringify(redactForExport(document, new Map()));
  assert.equal(text.includes(PLANTED), true, 'with no matchers the planted credential must survive');
});
