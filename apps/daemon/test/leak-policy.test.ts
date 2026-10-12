/**
 * The kill-switch and the all-tunnels-down policy are one decision expressed as two fields.
 *
 * What the operator is really choosing is whether their traffic can ever leave this device outside a
 * tunnel. Two fields decide it, they cover different failures, and they can be set to disagree — at
 * which point the kill-switch quietly stops meaning what its name says, in the more likely of the two
 * failures. These tests pin the refusal and, more importantly, pin the *words*: a refusal that names
 * settings instead of consequences is one the operator cannot act on.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile } from '@wayfarer/schemas';
import { checkInvariants } from '../src/core/invariants.ts';

function findingsFor(overrides: {
  killSwitch: boolean;
  onAllDown: 'block' | 'direct';
}): ReturnType<typeof checkInvariants> {
  const profile = emptyProfile();
  profile.firewall.killSwitch = overrides.killSwitch;
  profile.policy.onAllDown = overrides.onAllDown;
  return checkInvariants({
    profile: profile as never,
    bindings: new Map(),
    inventory: { interfaces: [], radios: [], binaries: [] } as never,
    facts: {
      foreignCores: [],
      interfaceClaims: [],
      managementInterfaces: [],
      binaries: [],
      uplinkNetworks: [],
    } as never,
  });
}

const contradiction = (findings: ReturnType<typeof checkInvariants>) =>
  findings.find((entry) => entry.code === 'leak_policy_contradiction');

test('a kill-switch with fail-open is refused, because the kill-switch would not hold', () => {
  const found = contradiction(findingsFor({ killSwitch: true, onAllDown: 'direct' }));
  assert.ok(found, 'the contradictory pair should be a finding');
  assert.equal(found.severity, 'error');
  assert.equal(found.pointer, '/policy/onAllDown');
});

test('the three arrangements that are not contradictory are left alone', () => {
  /*
   * Only one pair contradicts. A kill-switch with `block` is coherent; no kill-switch with either
   * policy is coherent, because nothing has promised otherwise. Asserting the silence matters as much
   * as asserting the refusal: an invariant that fires on a legitimate configuration teaches operators
   * to ignore invariants.
   */
  for (const pair of [
    { killSwitch: true, onAllDown: 'block' as const },
    { killSwitch: false, onAllDown: 'block' as const },
    { killSwitch: false, onAllDown: 'direct' as const },
  ]) {
    assert.equal(contradiction(findingsFor(pair)), undefined, `${JSON.stringify(pair)} should not be refused`);
  }
});

test('the refusal is stated as what the operator loses, not as the names of the settings', () => {
  const found = contradiction(findingsFor({ killSwitch: true, onAllDown: 'direct' }))!;
  const words = `${found.message} ${found.hint}`;

  // The consequence, in both directions, because the operator has to choose between two losses.
  assert.match(words, /leave this device unencrypted/, 'say that traffic leaves unprotected');
  assert.match(words, /stops passing traffic/, 'say that the device stops working instead');
  assert.match(words, /lose their connection rather than losing their privacy/, 'name the trade plainly');

  // And it must say *why* the kill-switch does not cover this, or the operator reasonably concludes
  // the refusal is a bug in our reasoning rather than a fact about their configuration.
  assert.match(words, /forwarded around the tunnel software/);

  // No jargon standing in for the consequence. These are the field names; a message that leans on
  // them is telling the operator what they already typed.
  assert.ok(!/onAllDown/.test(words), 'do not quote the field name at the operator');
  assert.ok(!/blast radius|invariant/i.test(words));
});

/* ── the reason the refusal exists, derived from the artefact rather than asserted ────────── */

test('the kill-switch rule only covers forwarded traffic, which is why fail-open defeats it', async () => {
  /*
   * The invariant above rests on a claim about the ruleset this project generates: the kill-switch is a
   * rule in the `forward` chain, so it cannot see traffic the proxy core sends out itself, which is
   * exactly what `onAllDown: direct` makes it do.
   *
   * That claim is checked here against the generated ruleset rather than left in a comment. It is a
   * structural fact about our own artefact, not a packet capture — stated that way in the invariant's
   * own documentation too, so nobody reads it as an end-to-end measurement.
   */
  const { generateFirewall } = await import('../src/core/generate/firewall.ts');
  const profile = emptyProfile();
  profile.firewall.killSwitch = true;
  profile.network.cidr = '10.44.0.1/24';

  const ruleset = generateFirewall({
    profile,
    lanInterface: 'wlanap',
    wanInterfaces: ['wlan-wan'],
    managementPort: 8088,
    timePorts: [123],
    clientsGoThroughCore: true,
  });

  // Split into chains so a rule cannot be credited to a chain it is not in.
  const chainOf = (name: string): string => {
    const start = ruleset.indexOf(`chain ${name} {`);
    assert.ok(start >= 0, `the ruleset should have a ${name} chain`);
    const end = ruleset.indexOf('\n  }', start);
    return ruleset.slice(start, end === -1 ? undefined : end);
  };

  const forward = chainOf('forward');
  const output = chainOf('output');

  // The kill-switch is here, and matches traffic arriving on the LAN and leaving on an uplink.
  assert.match(forward, /ct state new reject/);
  assert.match(forward, /iifname "wlanap" oifname "wlan-wan"/);

  // And it is *only* here. If a future change also rejected in `output`, this invariant would be
  // over-cautious and should be revisited rather than left to refuse a configuration that now works.
  assert.ok(!/reject/.test(output), 'nothing in the output chain rejects, so the core’s own traffic is not stopped');

  // What the output chain does with the device's own traffic instead: marks it as already handled.
  assert.match(output, /meta skuid 0 meta mark set 0x1e7/);
});

/*
 * The leak guard: what holds when the policy rules capturing clients are gone. Measured on the bench
 * board, 2026-10-12: with them removed by `systemd-networkd`, the forward chain was `policy accept`, the
 * kill-switch was off, and clients went out of the uplink past every tunnel.
 */
async function forwardChain(options: { killSwitch: boolean; clientsGoThroughCore: boolean }): Promise<string> {
  const { generateFirewall } = await import('../src/core/generate/firewall.ts');
  const profile = emptyProfile();
  profile.firewall.killSwitch = options.killSwitch;
  profile.network.cidr = '10.44.0.1/24';
  const ruleset = generateFirewall({
    profile,
    lanInterface: 'wlanap',
    wanInterfaces: ['end0', 'wfwan0'],
    managementPort: 8088,
    timePorts: [123],
    clientsGoThroughCore: options.clientsGoThroughCore,
  });
  const start = ruleset.indexOf('chain forward {');
  return ruleset.slice(start, ruleset.indexOf('\n  }', start));
}

test('with clients meant to go through the core, new forwarded connections to the internet are refused on every uplink, kill-switch off', async () => {
  const forward = await forwardChain({ killSwitch: false, clientsGoThroughCore: true });
  for (const wan of ['end0', 'wfwan0']) {
    const rule = forward.split('\n').find((line) => line.includes(`oifname "${wan}"`));
    assert.ok(rule, `a guard rule for ${wan}`);
    assert.match(rule, /iifname "wlanap"/);
    assert.match(rule, /ct state new/);
    assert.match(rule, /reject$/);
    // The local network stays reachable: the uplink's own network is excluded from capture on purpose.
    for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16']) {
      assert.ok(rule.includes(range), `${range} stays reachable`);
    }
    assert.match(rule, /ip daddr != \{/);
  }
});

test('with no tunnel the direct path is the intended one, so no guard is written', async () => {
  const forward = await forwardChain({ killSwitch: false, clientsGoThroughCore: false });
  assert.doesNotMatch(forward, /reject$/m);
});
