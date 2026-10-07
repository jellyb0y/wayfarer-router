/**
 * Capability reporting, and the half that makes it worth having: the command that closes each gap.
 *
 * A gap with no stated remedy is a message that makes somebody search, and the search is where the wrong
 * answer comes from. A gap with the *wrong* remedy is worse still: they run it, get "no such package",
 * and conclude the report is broken rather than that the package is named differently.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { describeCapabilities, hasRemedyFor, remedyFor } from '../src/core/capabilities.ts';
import { CATALOGUE_LIST } from '../src/core/catalogue/index.ts';
import { BINARIES } from '../src/inventory/index.ts';

const binary = (name: string, present: boolean) => ({
  name,
  present,
  path: present ? `/usr/sbin/${name}` : null,
  version: null,
  features: [],
  neededFor: 'something',
});

const ALL = ['sing-box', 'hostapd', 'hostapd_cli', 'wpa_supplicant', 'dnsmasq', 'nft', 'iw', 'ip', 'openvpn', 'xray', 'systemd-run'];

function inventoryWith(options: { present?: string[]; modes?: string[]; radios?: number } = {}) {
  const present = new Set(options.present ?? ALL);
  const radios = Array.from({ length: options.radios ?? 1 }, (_, index) => ({
    phy: `phy${index}`,
    reported: { interfaceModes: options.modes ?? ['managed', 'AP'] },
  }));
  return {
    binaries: ALL.map((name) => binary(name, present.has(name))),
    radios,
    interfaces: [],
  } as never;
}

test('every binary the inventory looks for has a remedy', async () => {
  /*
   * Derived from the inventory's own list rather than repeated here. A binary the inventory looks for but
   * which appears in neither remedy table would be reported as a gap with nothing said about it — the
   * report would name a problem and offer no answer, which is the failure this module exists to avoid.
   */
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const source = await readFile(join(import.meta.dirname, '..', 'src', 'inventory', 'index.ts'), 'utf8');
  const block = /const BINARIES:[\s\S]*?\n\];/.exec(source)?.[0];
  assert.ok(block, 'the inventory should declare the binaries it looks for');

  const names = [...block.matchAll(/name: '([^']+)'/g)].map((match) => match[1]!);
  assert.ok(names.length >= 10, `expected the real list, found ${names.length}`);
  for (const name of names) {
    assert.ok(hasRemedyFor(name), `${name} is looked for but has no remedy`);
  }
});

test('the command names the package, which is often not the binary', () => {
  // Measured on the bench board with `dpkg -S` against each resolved path, 2026-09-21.
  assert.equal(remedyFor('nft').command, 'apt-get install --no-install-recommends nftables');
  assert.equal(remedyFor('ip').command, 'apt-get install --no-install-recommends iproute2');
  assert.equal(remedyFor('dnsmasq').command, 'apt-get install --no-install-recommends dnsmasq-base');
  assert.equal(remedyFor('wpa_supplicant').command, 'apt-get install --no-install-recommends wpasupplicant');
  // hostapd_cli ships inside hostapd: the same package, a different binary.
  assert.equal(remedyFor('hostapd_cli').command, 'apt-get install --no-install-recommends hostapd');

  // And where the two differ, it says so, because somebody will otherwise think the report is confused.
  assert.match(remedyFor('dnsmasq').note!, /called dnsmasq-base, not dnsmasq/);
  // Where they agree, there is nothing to explain.
  assert.equal(remedyFor('openvpn').note, undefined);
});

test('a release binary gets no install command and says why', () => {
  // This daemon never downloads executables, so the remedy names the step and leaves it to a person.
  const remedy = remedyFor('sing-box');
  assert.equal(remedy.command, null);
  assert.match(remedy.note!, /never downloads executables/);
  assert.equal(remedyFor('xray').command, null);
});

test('a complete device reports everything available and nothing unknown', () => {
  const capabilities = describeCapabilities(inventoryWith());
  assert.equal(capabilities.filter((entry) => entry.state !== 'available').length, 0);
  assert.ok(capabilities.some((entry) => entry.id === 'access-point'));
  assert.ok(capabilities.some((entry) => entry.id === 'revert-timer'));
});

test('a missing binary is reported against the capability the operator wanted', () => {
  // Not "dnsmasq is missing" on its own: the operator's question is what they cannot do.
  const capabilities = describeCapabilities(inventoryWith({ present: ALL.filter((name) => name !== 'dnsmasq') }));
  const dhcp = capabilities.find((entry) => entry.id === 'dhcp')!;
  assert.equal(dhcp.state, 'missing');
  assert.match(dhcp.title, /Hand out addresses/);
  assert.deepEqual(dhcp.missing, ['dnsmasq']);
  assert.equal(dhcp.remedies[0]!.command, 'apt-get install --no-install-recommends dnsmasq-base');
});

test('no radios detected is unknown, never "this device cannot"', () => {
  /*
   * The distinction the whole inventory is built on. A driver that has not loaded, or an unplugged dongle,
   * is not evidence about what the hardware can do — and reporting "this device cannot host an access
   * point" from a device that failed to look at its hardware is a confident wrong answer.
   */
  const capabilities = describeCapabilities(inventoryWith({ radios: 0 }));
  const ap = capabilities.find((entry) => entry.id === 'access-point')!;
  assert.equal(ap.state, 'unknown');
  assert.deepEqual(ap.missing, []);
  assert.match(ap.detail!, /not the same as "no radio can do it"/);
});

test('a radio that cannot host an access point is a gap with no command', () => {
  // It is a property of the driver, not a setting, and pretending a command fixes it wastes somebody's time.
  const capabilities = describeCapabilities(inventoryWith({ modes: ['managed'] }));
  const ap = capabilities.find((entry) => entry.id === 'access-point')!;
  assert.equal(ap.state, 'missing');
  assert.deepEqual(ap.missing, ['a radio that can host an access point']);
  assert.equal(ap.remedies[0]!.command, null);
  assert.match(ap.remedies[0]!.note!, /property of the driver, not a setting/);
});

test('missing binaries win over an unanswerable radio question', () => {
  // With hostapd absent the answer is "missing" whatever the radios say, because that much is known.
  const capabilities = describeCapabilities(
    inventoryWith({ present: ALL.filter((name) => name !== 'hostapd'), radios: 0 }),
  );
  const ap = capabilities.find((entry) => entry.id === 'access-point')!;
  assert.equal(ap.state, 'missing');
  assert.deepEqual(ap.missing, ['hostapd']);
});

test('every binary a capability requires is one the inventory looks for', async () => {
  /*
   * The matching assertion to the one above, and the reason it exists: `systemd-run` was required by the
   * revert-timer capability and absent from the inventory's list, so `present` was never true for it and
   * the report said the revert timer was unavailable **on a device where it works**. A capability whose
   * requirement is never looked for is reported missing for ever, and a confidently wrong gap sends
   * somebody to install something they already have.
   *
   * Derived from both lists rather than asserted as a pair of numbers.
   */
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const inventorySource = await readFile(join(import.meta.dirname, '..', 'src', 'inventory', 'index.ts'), 'utf8');
  const block = /const BINARIES:[\s\S]*?\n\];/.exec(inventorySource)?.[0];
  const known = new Set([...block!.matchAll(/name: '([^']+)'/g)].map((match) => match[1]!));

  // Every binary any capability names as missing, on a device where nothing at all is installed.
  const nothing = {
    binaries: [...known].map((name) => binary(name, false)),
    radios: [],
    interfaces: [],
  } as never;
  const required = new Set(describeCapabilities(nothing).flatMap((entry) => entry.missing));

  for (const name of required) {
    // Skip the hardware phrases, which are not binaries.
    if (name.includes(' ')) continue;
    assert.ok(known.has(name), `the "${name}" capability requirement is never looked for by the inventory`);
  }
});

test('every binary a catalogue entry requires is one the inventory looks for', () => {
  /*
   * The same assertion as the one above, in the other direction the shape keeps coming back from:
   * a capability's requirements are guarded, and a catalogue entry's were not. `ck-client` was
   * required by the obfuscated-OpenVPN entry and absent from the inventory's list, so `present` was
   * never true for it and the plan said "ck-client is not installed" on a bench board where it was
   * installed and running five transports — and because that finding is an error, the profile could
   * not be applied at all. A requirement the inventory never looks for is reported missing for ever.
   *
   * Both sides are derived: the entries come from the catalogue, the probe list from the inventory.
   * A hand-written list of names here would be a third copy, and a copy is what drifted.
   */
  const probed = new Set(BINARIES.map((entry) => entry.name));

  const required = new Map<string, string>();
  for (const entry of CATALOGUE_LIST) {
    /*
     * Asked on the least capable device there can be: nothing installed, and — separately — a core
     * that was read and speaks nothing. An entry that names a binary only when the core cannot carry
     * the protocol itself (VLESS does) states that requirement in no other context.
     */
    for (const core of [
      { known: false, outboundTypes: new Set<string>() },
      { known: true, outboundTypes: new Set<string>() },
    ]) {
      for (const requirement of entry.availability({ core, installed: new Set<string>() }).requires ?? []) {
        required.set(requirement.binary, entry.id);
      }
    }
  }

  assert.ok(required.size > 0, 'no entry stated a requirement; the walk found nothing to check');
  for (const [name, protocol] of required) {
    assert.ok(probed.has(name), `the "${protocol}" entry requires ${name}, which the inventory never looks for`);
  }
});
