/**
 * What the installed core turned out to speak, asserted **through the pipeline**.
 *
 * `checkInvariants` takes an optional `core`, and absence means *nothing is known*, which every
 * catalogue entry must read as "everything is offered" — that default is right and is not what this
 * file is about. What it is about is that `planDocument` computed the capabilities for
 * `emitTunnels` and then left the field out of the `computePlan` call four lines below, and
 * `planDocument` is the only caller of `computePlan` outside the tests. So every plan a device made
 * ran the availability checks with the core unknown, and `protocol_unavailable` and `binary_missing`
 * for a protocol could not fire on any real device.
 *
 * Nothing went red, because every existing test of those checks calls `checkInvariants` directly
 * with an explicit `core`. **A test that bypasses the wiring cannot see that the wiring is
 * missing**, so this one goes the long way round on purpose: a real core schema, through
 * `planDocument`, and the finding read off the plan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planDocument } from '../src/core/pipeline.ts';
import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import type { Platform } from '../src/platform/index.ts';
import { builtInAndDongle, cleanFacts } from './helpers/synthetic-inventory.ts';

/**
 * A core that offers two outbounds and not VLESS.
 *
 * Written out rather than taken from the 445 KB bench fixture, because the fixture's core *does*
 * speak VLESS and the whole question here is what happens when one does not. `coreCapabilitiesOf`
 * reads `$defs.Outbound` and nothing else.
 */
const CORE_WITHOUT_VLESS = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: {
    Outbound: {
      anyOf: [
        { type: 'object', properties: { type: { const: 'direct' } } },
        { type: 'object', properties: { type: { const: 'block' } } },
      ],
    },
  },
});

function vlessProfile(): ProfileDocument {
  const profile = emptyProfile({ name: 'One VLESS tunnel' });
  return {
    ...profile,
    tunnels: [
      {
        id: 'alt-a',
        name: 'Warsaw',
        role: 'alternative',
        onUnavailable: 'block',
        enabled: true,
        protocol: 'vless',
        config: {
          server: '198.51.100.7',
          port: 443,
          id: 'a-placeholder-account',
          network: 'tcp',
          security: 'tls',
        },
      },
    ],
  } as ProfileDocument;
}

async function planWithCoreSchema(schema: string | null): Promise<{ code: string; pointer: string }[]> {
  const inventory = builtInAndDongle();
  const planned = await planDocument(
    {
      platform: {
        binaries: { coreSchema: async () => (schema === null ? null : { schema, version: '1.14.0' }) },
      } as unknown as Platform,
      inventory: async () => inventory,
      facts: async () => cleanFacts(),
      reality: async (paths, units) => ({
        files: paths.map((path) => ({ path, content: null, mode: null })),
        units: units.map((name) => ({ name, active: false, enabled: false, known: false })),
        interfaces: inventory.interfaces.map((entry) => ({ name: entry.name, mac: entry.mac })),
        managementInterfaces: [],
        sysctl: {},
      }),
      managementPort: 8088,
      timePorts: [123],
      upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
    },
    vlessProfile(),
  );
  return planned.plan.findings.map((finding) => ({ code: finding.code, pointer: finding.pointer }));
}

test('a plan made against a core that does not speak the protocol says so', async () => {
  const findings = await planWithCoreSchema(CORE_WITHOUT_VLESS);

  // `xray` is the external carrier, and the synthetic inventory does not have it. So neither carrier
  // can run this tunnel and the availability check has a real answer to give.
  const named = findings.find((finding) => finding.code === 'binary_missing' || finding.code === 'protocol_unavailable');
  assert.ok(
    named,
    `no availability finding reached the plan, so the core capabilities never got past emitTunnels: ` +
      `${JSON.stringify(findings)}`,
  );
  assert.equal(named.pointer, '/tunnels/0/protocol', 'the finding does not point at the tunnel that caused it');
});

/**
 * The other half, and it is the one that keeps the fix from being a regression.
 *
 * A core nobody could read must go on offering everything. Without this, "wire the capabilities in"
 * and "refuse whenever the fetch failed" are the same diff, and the second turns an unfinished
 * download into an error about a tunnel.
 */
test('a core schema that could not be read still offers every protocol', async () => {
  const findings = await planWithCoreSchema(null);
  assert.equal(
    findings.find((finding) => finding.code === 'binary_missing' && finding.pointer === '/tunnels/0/protocol'),
    undefined,
    `an unreadable core schema was treated as a negative answer: ${JSON.stringify(findings)}`,
  );
});
