/**
 * Has the resolver a peer pushed actually reached the file the core reads?
 *
 * This is the comparison that was missing on 2026-09-22, when the capture held `10.184.100.5`, the
 * generated configuration named `10.184.40.5`, and `resolver.reconverged` was recorded twice. Every
 * part of the mechanism worked except the part that asks.
 *
 * ## Why the configuration side is *generated* rather than hand-written here
 *
 * The comparison reads an address out of the core's configuration by tag. A test that hand-builds
 * that document proves the reader agrees with the test's author. Generating it with the planner
 * means the day the generator spells the tag differently, this goes red — instead of the reader
 * quietly finding nothing and the device reporting that a captured resolver is not in use when it
 * is. That failure would be silent and it would look exactly like the defect being fixed.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';

import { plan } from '../src/core/planner.ts';
import { PATHS } from '../src/core/desired-state.ts';
import {
  dynamicResolverTunnels,
  resolverDivergence,
  resolversInCoreConfig,
} from '../src/core/resolver-convergence.ts';
import { tunnelDnsTag } from '../src/core/generate/core-config.ts';
import { cleanFacts, oneBuiltInRadio } from './helpers/synthetic-inventory.ts';

const PROFILE_RESOLVER = '10.184.40.5';
const PUSHED_RESOLVER = '10.184.100.5';

/** The bench board's hq tunnel: a resolver the peer chooses, a profile value that is a guess. */
function benchProfile(dynamic = true): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' }) as unknown as ProfileDocument;
  return {
    ...base,
    tunnels: [
      {
        id: 'hq',
        name: 'HQ',
        role: 'resource',
        enabled: true,
        protocol: 'openvpn',
        onUnavailable: 'block',
        dns: { server: PROFILE_RESOLVER, dynamic, domainSuffix: ['hq.lan'] },
        config: { profile: 'client\ndev tun\n', interfaceSuffix: '0' },
      } as unknown as ProfileDocument['tunnels'][number],
    ],
  };
}

/** The core configuration this device would generate, with whatever the peers have pushed so far. */
function generatedCoreConfig(captured: Map<string, string>, document = benchProfile()): string {
  const result = plan({
    profile: document,
    inventory: oneBuiltInRadio(),
    facts: {
      ...cleanFacts(),
      uplinkNetworks: [
        { interface: 'end0', cidr: '192.0.2.10/24' },
        { interface: 'wfvpn0', cidr: '10.165.5.67/20' },
      ],
    },
    emissions: new Map([
      [
        'hq',
        {
          target: 'outbounds' as const,
          object: { type: 'direct', bind_interface: 'wfvpn0' },
          interfaces: ['wfvpn0'],
        },
      ],
    ]),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
    capturedResolvers: captured,
  });
  const file = result.desired.files.find((entry) => entry.path === PATHS.coreConfig);
  assert.ok(file, 'the plan generated no core configuration');
  return file.content;
}

test('the address the generator writes is the address this reads back', () => {
  // The join between the two halves, asserted rather than assumed. Mutation: change the spelling in
  // `tunnelDnsTag` for one of the two callers and this is what fails.
  const generated = generatedCoreConfig(new Map([['hq', PUSHED_RESOLVER]]));
  const named = resolversInCoreConfig(generated);
  assert.ok(named !== null, 'a generated configuration could not be read back');
  assert.equal(named.get(tunnelDnsTag('hq')), PUSHED_RESOLVER);
});

test('the board of 2026-09-22: a capture the configuration does not name is a divergence', () => {
  // The configuration as it sat on the board: generated before the peer moved, so it carries the
  // profile's starting value while the capture holds what the peer actually pushed.
  const onDisk = generatedCoreConfig(new Map());
  const divergent = resolverDivergence({
    tunnels: dynamicResolverTunnels(benchProfile()),
    captured: new Map([['hq', PUSHED_RESOLVER]]),
    coreConfig: onDisk,
  });

  assert.equal(divergent.length, 1, 'the stale configuration was reported as converged');
  assert.deepEqual(divergent[0], {
    tunnelId: 'hq',
    tunnelName: 'HQ',
    captured: PUSHED_RESOLVER,
    inCore: PROFILE_RESOLVER,
  });
});

test('a configuration that already names the captured resolver diverges from nothing', () => {
  // The positive twin. A check that only ever answers "diverged" is a check nobody can act on, and
  // it would make every daemon start re-derive and restart the core for no reason.
  const converged = generatedCoreConfig(new Map([['hq', PUSHED_RESOLVER]]));
  assert.deepEqual(
    resolverDivergence({
      tunnels: dynamicResolverTunnels(benchProfile()),
      captured: new Map([['hq', PUSHED_RESOLVER]]),
      coreConfig: converged,
    }),
    [],
  );
});

test('a tunnel whose resolver is not dynamic is never compared', () => {
  // The profile's value is a setting for such a tunnel, not a guess. A capture from a peer must not
  // be allowed to overrule it, and must certainly not be reported as a divergence forever.
  const document = benchProfile(false);
  assert.deepEqual(dynamicResolverTunnels(document), []);
  assert.deepEqual(
    resolverDivergence({
      tunnels: dynamicResolverTunnels(document),
      captured: new Map([['hq', PUSHED_RESOLVER]]),
      coreConfig: generatedCoreConfig(new Map(), document),
    }),
    [],
  );
});

test('a tunnel with nothing captured is not a divergence', () => {
  // Nothing to converge on. The planner already says so with `dynamic_resolver_uncaptured`, and an
  // alarm that cannot be acted on is how people learn to ignore alarms.
  assert.deepEqual(
    resolverDivergence({
      tunnels: dynamicResolverTunnels(benchProfile()),
      captured: new Map(),
      coreConfig: generatedCoreConfig(new Map()),
    }),
    [],
  );
});

test('a configuration that cannot be read is a divergence, not a convergence', () => {
  // Fail closed. "I could not read it" is not "the captured value is in use" — that reading is the
  // whole shape of this defect, and it is the one a missing file would otherwise produce.
  for (const unreadable of [null, 'not json', '{"dns":{}}']) {
    const divergent = resolverDivergence({
      tunnels: dynamicResolverTunnels(benchProfile()),
      captured: new Map([['hq', PUSHED_RESOLVER]]),
      coreConfig: unreadable,
    });
    assert.equal(divergent.length, 1, `an unreadable configuration (${String(unreadable)}) read as converged`);
    assert.equal(divergent[0]?.inCore, null);
  }
  assert.equal(resolversInCoreConfig(null), null);
  assert.equal(resolversInCoreConfig('not json'), null);
});
