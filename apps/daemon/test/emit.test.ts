/**
 * The emission path, after it was moved onto the catalogue.
 *
 * These are the assertions that used to live in `transports.test.ts`, rewritten against the shape
 * that replaced the thing they were testing. A transport is no longer something an operator
 * assembles beside a tunnel — it is `config.entryPoints` of the `Cloak + OpenVPN` entry — so the
 * questions worth asking changed with it. The two that matter most are the two traps the catalogue
 * was built to close, and both are checked here as *agreement between two generated files* rather
 * than as the value of either one on its own: a test that reads only one side would pass on the day
 * they disagree, which is exactly the failure that was paid for by hand on the bench.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createValidatorCache } from '@wayfarer/protocols';
import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { emitTunnels, validateTunnelConfigs } from '../src/core/emit.ts';
import { PATHS } from '../src/core/desired-state.ts';
import type { CoreCapabilities } from '../src/core/catalogue/index.ts';

/** Nothing is known about the core, which every entry must read as "everything is offered". */
const UNKNOWN_CORE: CoreCapabilities = { known: false, outboundTypes: new Set() };

const OVPN = 'client\ndev tun\nremote vpn.example.net 1194\n';

function profileWith(tunnels: unknown[]): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' });
  return { ...base, tunnels: tunnels as ProfileDocument['tunnels'] };
}

function entryPoint(id: string, host: string, port: number): Record<string, unknown> {
  return {
    id,
    host,
    port,
    uid: 'an-account-identifier',
    publicKey: 'a-public-key',
    proxyMethod: 'openvpn',
    encryptionMethod: 'aes-gcm',
    serverName: `${id}.example.com`,
    browserSignature: 'chrome',
    transport: 'direct',
  };
}

function cloakTunnel(entryPoints: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: 'hq',
    name: 'HQ',
    role: 'alternative',
    enabled: true,
    onUnavailable: 'fall-through',
    protocol: 'cloak-openvpn',
    config: { profile: OVPN, entryPoints },
  };
}

const emit = (tunnels: unknown[]): ReturnType<typeof emitTunnels> =>
  emitTunnels({
    profile: profileWith(tunnels),
    core: UNKNOWN_CORE,
    // Deliberately empty: whether a binary is present is an invariant check, and emission must not
    // depend on it. See the note in `emit.ts` about the diff an operator used to be shown instead.
    installed: new Set(),
    allocatedPorts: new Set(),
  });

/* ── trap 1: one allocated port, written into two files ──────────────────────────────────── */

test('the loopback port is allocated once and both generated files carry that same number', () => {
  const result = emit([cloakTunnel([entryPoint('site-a', 'a.example.net', 443)])]);

  const claim = result.ports[0]!;
  assert.equal(result.ports.length, 1, 'one entry point should claim exactly one port');

  const emission = result.emissions.get('hq')!;
  const client = emission.files!.find((file) => file.path.endsWith('hq-site-a.json'))!;
  const ovpn = emission.files!.find((file) => file.path === `${PATHS.openvpnDir}/hq.conf`)!;

  /*
   * The two numbers that had to be kept in step by hand. Measured on the bench, 2026-09-21: an
   * obfuscated tunnel's `.ovpn` blob named `127.0.0.1:12294` while a `"LocalPort": "12294"` sat forty
   * lines away in a different string field, and nothing checked that the two agreed.
   *
   * Asserted against the *allocated* value rather than against a literal, because a literal here
   * would be a third place the number is written down.
   */
  assert.equal(JSON.parse(client.content)['LocalPort'], `${claim.port}`);
  assert.match(ovpn.content, new RegExp(`^remote 127\\.0\\.0\\.1 ${claim.port}$`, 'm'));
});

test('the supplied profile own remote lines are dropped when this device supplies its own', () => {
  const result = emit([cloakTunnel([entryPoint('site-a', 'a.example.net', 443)])]);
  const ovpn = result.emissions.get('hq')!.files!.find((file) => file.path.endsWith('hq.conf'))!;
  // Keeping them would mean the client could dial the peer directly, past the obfuscation the whole
  // tunnel exists for, depending on which line it tried first.
  assert.doesNotMatch(ovpn.content, /^remote vpn\.example\.net 1194$/m);
});

test('two entry points get two different ports, each traceable to the field that claimed it', () => {
  const result = emit([
    cloakTunnel([entryPoint('site-a', 'a.example.net', 443), entryPoint('site-b', 'b.example.net', 8443)]),
  ]);

  const ports = result.ports.map((claim) => claim.port);
  assert.equal(new Set(ports).size, 2, 'two listeners on one port is how the second fails to bind');
  assert.deepEqual(
    result.ports.map((claim) => claim.pointer),
    ['/tunnels/0/config/entryPoints/0', '/tunnels/0/config/entryPoints/1'],
  );
  assert.ok(result.ports.every((claim) => claim.owner.includes('HQ')));
});

test('the remote order is the entry point order, because that order is the failover order', () => {
  const result = emit([
    cloakTunnel([entryPoint('site-a', 'a.example.net', 443), entryPoint('site-b', 'b.example.net', 8443)]),
  ]);
  const ovpn = result.emissions.get('hq')!.files!.find((file) => file.path.endsWith('hq.conf'))!;
  const remotes = [...ovpn.content.matchAll(/^remote 127\.0\.0\.1 (\d+)$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(remotes, result.ports.map((claim) => claim.port));
});

/* ── trap 2: the file name is part of the format ─────────────────────────────────────────── */

test('the obfuscation client configuration is written as .json, because the client reads the extension', () => {
  const result = emit([cloakTunnel([entryPoint('site-a', 'a.example.net', 443)])]);
  const paths = result.emissions.get('hq')!.files!.map((file) => file.path);

  /*
   * A generator naming this file `.conf` met a client that infers its format from the extension, and
   * the client did not start — silently. Three separate defects in one unit, each invisible until the
   * previous was fixed, all presenting identically as *a client that will not start*.
   */
  assert.ok(paths.includes(`${PATHS.transportDir}/hq-site-a.json`));
  assert.ok(!paths.some((path) => path === `${PATHS.transportDir}/hq-site-a.conf`));
});

test('every generated file names the unit that reads it, so none of them is an orphan', () => {
  const result = emit([cloakTunnel([entryPoint('site-a', 'a.example.net', 443)])]);
  const emission = result.emissions.get('hq')!;
  const units = new Set(emission.units!.map((unit) => unit.name));

  for (const file of emission.files!) {
    assert.equal(file.consumedBy.kind, 'unit');
    assert.ok(
      units.has((file.consumedBy as { unit: string }).unit),
      `${file.path} names ${(file.consumedBy as { unit: string }).unit}, which this tunnel does not start`,
    );
  }
});

test('the credential-bearing files are readable by root alone', () => {
  const result = emit([cloakTunnel([entryPoint('site-a', 'a.example.net', 443)])]);
  const emission = result.emissions.get('hq')!;
  const client = emission.files!.find((file) => file.path.endsWith('.json'))!;
  const ovpn = emission.files!.find((file) => file.path.endsWith('hq.conf'))!;
  // The client configuration carries the account identifier; the profile is the whole credential.
  assert.equal(client.mode, 0o600);
  assert.equal(ovpn.mode, 0o600);
});

/* ── what emission is, and is not, responsible for ───────────────────────────────────────── */

test('a tunnel is planned although its binaries are missing, so plan review still shows the diff', () => {
  const result = emit([cloakTunnel([entryPoint('site-a', 'a.example.net', 443)])]);
  /*
   * The file this replaces skipped a tunnel whose provider was unavailable, so an operator missing a
   * binary saw a finding about it and an apparently empty change. Whether the device *can* run a
   * protocol is an invariant check; nothing is applied while an error stands, and the review is more
   * useful showing both.
   */
  assert.ok(result.emissions.has('hq'));
  assert.deepEqual(result.refusals, []);
});

test('a disabled tunnel emits nothing and claims nothing', () => {
  const result = emit([{ ...cloakTunnel([entryPoint('site-a', 'a.example.net', 443)]), enabled: false }]);
  assert.equal(result.emissions.size, 0);
  assert.deepEqual(result.ports, []);
  assert.deepEqual(result.refusals, []);
});

test('a protocol outside the catalogue is refused by name, and the refusal says nothing has stopped', () => {
  const result = emit([
    {
      id: 'legacy',
      name: 'Legacy',
      role: 'alternative',
      enabled: true,
      onUnavailable: 'fall-through',
      protocol: 'shadowsocks',
      config: {},
    },
  ]);

  assert.equal(result.emissions.size, 0);
  const refusal = result.refusals[0]!;
  assert.equal(refusal.protocol, 'shadowsocks');
  assert.equal(refusal.pointer, '/tunnels/0/protocol');
  assert.match(refusal.reason, /shadowsocks/);
  assert.match(refusal.reason, /OpenVPN, Cloak \+ OpenVPN, VLESS/);
  // The sentence that stops a person assuming their network fell over because a router sent them a
  // message. It is true — units are independent of this daemon — and it is why it is said every time.
  assert.match(refusal.reason, /Nothing has stopped/);
});

/* ── the carrier, stated rather than guessed ─────────────────────────────────────────────── */

const vlessTunnel = (config: Record<string, unknown>): Record<string, unknown> => ({
  id: 'sub',
  name: 'Subscription',
  role: 'alternative',
  enabled: true,
  onUnavailable: 'fall-through',
  protocol: 'vless',
  config: { server: 'node.example.net', port: 443, id: 'an-account', network: 'tcp', security: 'tls', ...config },
});

test('a VLESS account the core can carry runs no second process, and says why', () => {
  const result = emit([vlessTunnel({})]);
  assert.deepEqual(result.emissions.get('sub')!.units ?? [], []);
  assert.deepEqual(result.ports, []);
  assert.equal(result.carriers.get('sub')!.kind, 'native');
});

test('an account carrying an encryption parameter is carried externally, on an allocated port', () => {
  const result = emit([vlessTunnel({ encryption: 'mlkem768x25519plus.native.0rtt.KEYMATERIAL' })]);

  assert.equal(result.carriers.get('sub')!.kind, 'external');
  const port = result.ports[0]!.port;
  const emission = result.emissions.get('sub')!;
  // The outbound the core is given and the port the client listens on are one number, again.
  assert.deepEqual(emission.object, { type: 'socks', server: '127.0.0.1', server_port: port });
  const client = emission.files!.find((file) => file.path === `${PATHS.socksDir}/sub.json`)!;
  assert.equal(JSON.parse(client.content).inbounds[0].port, port);
  assert.equal(JSON.parse(client.content).inbounds[0].listen, '127.0.0.1');
});

test('the carrier reason names what decided it, so the choice can be accounted for afterwards', () => {
  const external = emit([vlessTunnel({ encryption: 'mlkem768x25519plus.native.0rtt.KEYMATERIAL' })]);
  assert.match(external.carriers.get('sub')!.reason, /encryption/);
  const native = emit([vlessTunnel({})]);
  assert.match(native.carriers.get('sub')!.reason, /No second process runs/);
});

/* ── the schema pass, which is now ours and needs no binary ──────────────────────────────── */

test('a bad field is reported with a pointer into the profile, on a device with no core at all', () => {
  const validators = createValidatorCache();
  const issues = validateTunnelConfigs({
    profile: profileWith([vlessTunnel({ port: 'four-four-three' })]),
    validators,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.pointer, '/tunnels/0/config/port');
});

test('a stored configuration validates although its secrets are still wrapped', () => {
  const validators = createValidatorCache();
  const issues = validateTunnelConfigs({
    profile: profileWith([
      {
        id: 'hq',
        name: 'HQ',
        role: 'alternative',
        enabled: true,
        onUnavailable: 'fall-through',
        protocol: 'openvpn',
        config: { profile: { $secret: OVPN } },
      },
    ]),
    validators,
  });
  // The canonical schema describes the *resolved* form. Validating the stored shape against it
  // without unwrapping would report every credential in the profile as the wrong type.
  assert.deepEqual(issues, []);
});
