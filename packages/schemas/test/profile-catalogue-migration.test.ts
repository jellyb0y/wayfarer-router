/**
 * Schema version 6 → 7: every tunnel becomes a catalogue entry, or the document is refused by name.
 *
 * The fixtures below carry the **shapes** of the four tunnels on the bench board, read from a
 * redacted export taken 2026-09-21, filled with invented values. Nothing from that export is
 * reproduced here: it contains real credentials, which is itself a defect this migration exists to
 * make impossible — five account identifiers sat in clear inside a *redacted* export because they
 * lived in a string field nothing could walk into.
 *
 * | fixture | stored as | becomes |
 * |---|---|---|
 * | `partner` | `openvpn`, no transports | OpenVPN |
 * | `corp` | `openvpn` + 1 transport | Cloak + OpenVPN, one entry point |
 * | `hq` | `openvpn` + 4 transports | Cloak + OpenVPN, four entry points |
 * | `relay` | `external-socks` running a VLESS client | VLESS |
 *
 * All four are `role: 'resource'`. **The bench has no interchangeable tunnel**, so nothing here is
 * evidence about the failover group, and that is said out loud rather than left for somebody to
 * assume.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import {
  catalogueConfigFaults,
  migrateProfile,
  PROFILE_MIGRATIONS,
  ProfileCatalogueError,
  PROFILE_SCHEMA_VERSION,
  Tunnel,
  type TunnelProtocol,
} from '../src/index.ts';
import { secretMatchers, secretPointers } from '../src/index.ts';
import { ProfileDocument } from '../src/profile.ts';

/* ── fixtures at the input version ───────────────────────────────────────────────────────── */

/** A Cloak client configuration, as version 6 stored it: a JSON document inside a string field. */
function cloakBlob(input: { host: string; serverName: string; localPort: number; uid: string }): string {
  return JSON.stringify({
    Transport: 'direct',
    ProxyMethod: 'openvpn',
    EncryptionMethod: 'aes-gcm',
    UID: input.uid,
    PublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=',
    ServerName: input.serverName,
    NumConn: 4,
    BrowserSig: 'chrome',
    StreamTimeout: 60,
    RemoteHost: input.host,
    RemotePort: '443',
    LocalPort: `${input.localPort}`,
    LocalHost: '127.0.0.1',
    UDP: true,
  });
}

function transport(id: string, host: string, serverName: string, localPort: number) {
  return {
    id,
    provider: 'transport',
    config: {
      command: '/usr/local/bin/ck-client -c "$WAYFARER_CONFIG_FILE"',
      configFile: { $secret: cloakBlob({ host, serverName, localPort, uid: 'AAAAAAAAAAAAAAAAAAAAAA==' }) },
      localPort,
    },
  };
}

/** The external client's configuration, with the post-quantum parameter the proxy core rejects. */
function xrayBlob(): string {
  return JSON.stringify({
    log: { loglevel: 'warning' },
    inbounds: [{ listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { udp: true, auth: 'noauth' } }],
    outbounds: [
      {
        protocol: 'vless',
        tag: 'proxy',
        settings: {
          vnext: [
            {
              address: '198.51.100.7',
              port: 43456,
              users: [
                {
                  id: '00000000-0000-4000-8000-000000000000',
                  encryption: 'mlkem768x25519plus.native.0rtt.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                },
              ],
            },
          ],
        },
        streamSettings: {
          network: 'ws',
          security: 'tls',
          tlsSettings: { serverName: '198.51.100.7', fingerprint: 'chrome', alpn: ['h2', 'http/1.1'] },
          wsSettings: { path: '/' },
        },
      },
    ],
  });
}

function benchAtVersion6(): Record<string, unknown> {
  return {
    schemaVersion: 6,
    tunnels: [
      {
        id: 'partner',
        name: 'Partner work',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        provider: 'openvpn',
        config: { interfaceSuffix: 'prt', profile: { $secret: 'client\ndev tun\nremote vpn.example.invalid 1194\n' } },
        resources: { domainSuffix: ['partner.invalid'], ipCidr: ['198.51.100.0/24'] },
        probe: { endpoints: ['http://198.51.100.9/'] },
      },
      {
        id: 'corp',
        name: 'Corp',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        provider: 'openvpn',
        config: { profile: { $secret: 'client\ndev tun\nremote 127.0.0.1 61195\n' }, interfaceSuffix: 'crp' },
        transports: [transport('corpsg', 'sg.example.invalid', 'www.example.invalid', 61195)],
        dns: { server: '10.122.0.1', domainSuffix: ['corp.invalid'] },
      },
      {
        id: 'hq',
        name: 'HQ',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        provider: 'openvpn',
        config: {
          profile: { $secret: 'client\ndev tun\nremote 127.0.0.1 12294\n' },
          interfaceSuffix: 'hq',
          auth: { username: 'someone', password: { $secret: 'a-password-for-the-test' } },
        },
        transports: [
          transport('war1', 'war1.example.invalid', 'a.example.invalid', 12294),
          transport('war2', 'war2.example.invalid', 'b.example.invalid', 12295),
          transport('msk1', 'msk1.example.invalid', 'c.example.invalid', 12194),
          transport('msk2', 'msk2.example.invalid', 'd.example.invalid', 12195),
        ],
      },
      {
        id: 'relay',
        name: 'Relay',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        provider: 'external-socks',
        config: {
          command: '/usr/local/bin/xray run -config "$WAYFARER_CONFIG_FILE" -format json',
          configFile: { $secret: xrayBlob() },
          localPort: 10808,
        },
        resources: { domainSuffix: ['example.invalid'] },
      },
    ],
  };
}

function migratedTunnels(document: Record<string, unknown> = benchAtVersion6()) {
  const result = migrateProfile(document);
  assert.equal(result.to, PROFILE_SCHEMA_VERSION);
  assert.equal(result.document['schemaVersion'], PROFILE_SCHEMA_VERSION);
  return result.document['tunnels'] as Record<string, unknown>[];
}

/* ── the four bench shapes ───────────────────────────────────────────────────────────────── */

test('all four bench tunnels translate, and none of them keeps a command, a config blob or a port', () => {
  const tunnels = migratedTunnels();
  assert.deepEqual(
    tunnels.map((tunnel) => [tunnel['id'], tunnel['protocol']]),
    [
      ['partner', 'openvpn'],
      ['corp', 'cloak-openvpn'],
      ['hq', 'cloak-openvpn'],
      ['relay', 'vless'],
    ],
  );

  // The three fields that left the profile entirely. Asserted over the whole document rather than
  // field by field, because the point is that there is nowhere left for them to hide.
  const text = JSON.stringify(tunnels);
  for (const gone of ['"command"', '"configFile"', '"localPort"', '"provider"', '"transports"']) {
    assert.ok(!text.includes(gone), `${gone} still appears in a migrated profile`);
  }
});

test('OpenVPN: the profile and everything routing owns are carried unchanged', () => {
  const [partner] = migratedTunnels();
  assert.ok(partner);
  const config = partner['config'] as Record<string, unknown>;
  assert.deepEqual(config['profile'], { $secret: 'client\ndev tun\nremote vpn.example.invalid 1194\n' });
  assert.equal(config['interfaceSuffix'], 'prt');
  // A migration translates the tunnel, and must not quietly reshape what the tunnel reaches.
  assert.deepEqual(partner['resources'], { domainSuffix: ['partner.invalid'], ipCidr: ['198.51.100.0/24'] });
  // The probe is carried by this step unchanged — a shipped step is never edited — and removed by the
  // next one, 7 → 8 (plan row G30), which is why the chain as a whole leaves none.
  const step = PROFILE_MIGRATIONS.find((candidate) => candidate.from === 6)!;
  const atSeven = (step.migrate(benchAtVersion6())['tunnels'] as Record<string, unknown>[])[0]!;
  assert.deepEqual(atSeven['probe'], { endpoints: ['http://198.51.100.9/'] });
  assert.equal('probe' in partner, false);
  assert.equal(partner['onUnavailable'], 'block');
  assert.equal(partner['role'], 'resource');
});

test('Cloak + OpenVPN: one transport becomes one entry point, and the credential becomes a marked field', () => {
  const [, corp] = migratedTunnels();
  assert.ok(corp);
  const config = corp['config'] as Record<string, unknown>;
  const entryPoints = config['entryPoints'] as Record<string, unknown>[];
  assert.equal(entryPoints.length, 1);

  const [sg] = entryPoints;
  assert.ok(sg);
  assert.equal(sg['id'], 'corpsg');
  assert.equal(sg['host'], 'sg.example.invalid');
  assert.equal(sg['port'], 443, 'the client stores the port as a string and this project as an integer');
  assert.equal(sg['serverName'], 'www.example.invalid');
  assert.equal(sg['transport'], 'direct');
  assert.equal(sg['connections'], 4);
  assert.equal(sg['streamTimeoutSeconds'], 60);
  assert.equal(sg['udp'], true);

  // The account identifier comes out of the blob **wrapped**, because it is a field of its own now
  // and storage is where the wrapping means something. A bare string here is the old defect exactly.
  assert.deepEqual(sg['uid'], { $secret: 'AAAAAAAAAAAAAAAAAAAAAA==' });
  assert.equal(typeof sg['publicKey'], 'string', 'a public key is not a credential and stays readable');

  assert.deepEqual(corp['dns'], { server: '10.122.0.1', domainSuffix: ['corp.invalid'] });
});

test('Cloak + OpenVPN: four entry points keep their order, and the credentials come with them', () => {
  const [, , hq] = migratedTunnels();
  assert.ok(hq);
  const config = hq['config'] as Record<string, unknown>;
  const entryPoints = config['entryPoints'] as Record<string, unknown>[];

  // The order is data: it becomes the order of the `remote` lines, which is the order the client
  // tries them in. A migration that sorted or de-duplicated would silently change failover.
  assert.deepEqual(
    entryPoints.map((entry) => entry['id']),
    ['war1', 'war2', 'msk1', 'msk2'],
  );
  assert.deepEqual(
    entryPoints.map((entry) => entry['serverName']),
    ['a.example.invalid', 'b.example.invalid', 'c.example.invalid', 'd.example.invalid'],
  );
  for (const entry of entryPoints) {
    assert.deepEqual(entry['uid'], { $secret: 'AAAAAAAAAAAAAAAAAAAAAA==' });
  }

  // The OpenVPN half of the same entry survives intact.
  assert.deepEqual(config['auth'], { username: 'someone', password: { $secret: 'a-password-for-the-test' } });
  assert.equal(config['interfaceSuffix'], 'hq');
});

test('VLESS: the account comes out of the client configuration and the carrier is not recorded', () => {
  const [, , , relay] = migratedTunnels();
  assert.ok(relay);
  const config = relay['config'] as Record<string, unknown>;

  assert.equal(config['server'], '198.51.100.7');
  assert.equal(config['port'], 43456);
  assert.deepEqual(config['id'], { $secret: '00000000-0000-4000-8000-000000000000' });
  assert.equal(config['network'], 'ws');
  assert.equal(config['security'], 'tls');
  assert.equal(config['serverName'], '198.51.100.7');
  assert.equal(config['fingerprint'], 'chrome');
  assert.deepEqual(config['alpn'], ['h2', 'http/1.1']);
  assert.equal(config['path'], '/');

  // The parameter that decides the carrier, kept and marked. It is key material, not a mode name.
  assert.deepEqual(config['encryption'], {
    $secret: 'mlkem768x25519plus.native.0rtt.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  });

  // Nothing here says which program runs it. The entry establishes that from the configuration each
  // time it plans, so a choice frozen at migration time would be a stale answer to a live question.
  const text = JSON.stringify(config);
  assert.ok(!/xray|sing-?box/i.test(text));
});

test('an ordinary VLESS account does not carry an encryption parameter forward', () => {
  // `none` is the absence of the feature spelled out. Carrying it would make every ordinary account
  // look like one the proxy core cannot run, and send it to an external client for no reason.
  const document = benchAtVersion6();
  const tunnels = document['tunnels'] as Record<string, unknown>[];
  const relay = tunnels[3] as Record<string, unknown>;
  const client = JSON.parse(xrayBlob()) as Record<string, unknown>;
  const outbound = (client['outbounds'] as Record<string, unknown>[])[0] as Record<string, unknown>;
  const settings = outbound['settings'] as Record<string, unknown>;
  const peer = (settings['vnext'] as Record<string, unknown>[])[0] as Record<string, unknown>;
  (peer['users'] as Record<string, unknown>[])[0]!['encryption'] = 'none';
  (relay['config'] as Record<string, unknown>)['configFile'] = { $secret: JSON.stringify(client) };

  const [, , , migrated] = migratedTunnels(document);
  assert.ok(migrated);
  assert.equal((migrated['config'] as Record<string, unknown>)['encryption'], undefined);
});

/* ── what the migration produces is a valid v7 document ──────────────────────────────────── */

/** Storage wraps secrets; the canonical schema holds the value. Unwrapped for the check only. */
function unwrap(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('$secret' in record) return record['$secret'];
    return Object.fromEntries(Object.entries(record).map(([key, inner]) => [key, unwrap(inner)]));
  }
  return value;
}

test('every migrated tunnel validates against the version 7 schema', () => {
  for (const tunnel of migratedTunnels()) {
    const resolved = unwrap(tunnel);
    assert.ok(
      Value.Check(Tunnel, resolved),
      `${String(tunnel['id'])} does not validate: ${JSON.stringify([...Value.Errors(Tunnel, resolved)].slice(0, 3))}`,
    );
  }
});

test('the credentials the old shape hid are now findable by the machinery that redacts them', () => {
  // The defect this whole change answers: a credential inside a string field cannot be walked into,
  // so it reached a *redacted* export in clear. Now the entry point's account is a marked field, and
  // the same detection every other secret uses finds it.
  const pointers = secretPointers(ProfileDocument);
  assert.ok(
    pointers.some((pointer) => pointer.endsWith('/entryPoints/-/uid')),
    `the entry point credential is not among the secret pointers: ${pointers.join(', ')}`,
  );
  assert.ok(pointers.some((pointer) => pointer.endsWith('/config/encryption')));

  // And it is reachable by pointer matching, which is what redaction actually uses.
  const matchers = secretMatchers(ProfileDocument);
  const matched = [...matchers.keys()].length;
  assert.ok(matched > 0);
});

/* ── refusing ────────────────────────────────────────────────────────────────────────────── */

function refusalFor(tunnel: Record<string, unknown>): ProfileCatalogueError {
  const document = { schemaVersion: 6, tunnels: [tunnel] };
  try {
    migrateProfile(document);
  } catch (error) {
    assert.ok(error instanceof ProfileCatalogueError, `expected a catalogue refusal, got ${String(error)}`);
    return error;
  }
  throw new Error('the migration accepted something it cannot run');
}

test('a protocol outside the catalogue is refused, naming the tunnel and what it named', () => {
  const error = refusalFor({
    id: 'legacy',
    name: 'Something else',
    role: 'alternative',
    enabled: true,
    onUnavailable: 'block',
    provider: 'singbox-outbound',
    config: { type: 'hysteria2', server: 'example.invalid' },
  });

  assert.deepEqual(error.tunnels.map((entry) => [entry.tunnel, entry.protocol]), [['legacy', 'singbox-outbound']]);
  assert.match(error.message, /legacy/);
  assert.match(error.message, /singbox-outbound/);
  // What it does run, so the message is actionable rather than only negative.
  assert.match(error.message, /OpenVPN, Cloak \+ OpenVPN, VLESS/);
  // And the sentence that has to be in the same breath: a profile that cannot be managed is not a
  // network that has failed.
  assert.match(error.message, /Nothing has stopped/);
  assert.match(error.message, /do not depend on this daemon/);
});

test('the escape hatch is refused like anything else', () => {
  const error = refusalFor({
    id: 'handwritten',
    name: 'Raw',
    role: 'alternative',
    enabled: true,
    onUnavailable: 'block',
    provider: 'raw',
    config: { anything: true },
  });
  assert.equal(error.tunnels[0]?.protocol, 'raw');
  assert.match(error.message, /no escape hatch/);
});

test('a redacted export is refused rather than translated into a tunnel that cannot connect', () => {
  // A redacted export has had the very content the translation needs removed from it. Producing an
  // empty configuration from it would give the owner a tunnel that looks configured and never works.
  const error = refusalFor({
    id: 'corp',
    name: 'Corp',
    role: 'resource',
    enabled: true,
    onUnavailable: 'block',
    provider: 'openvpn',
    config: { profile: { $redacted: 'config-blob' } },
  });
  assert.match(error.message, /removed by redaction/);
});

test('an obfuscation entry point missing what it cannot run without is refused by its own name', () => {
  const broken = transport('war1', 'war1.example.invalid', 'a.example.invalid', 12294);
  const client = JSON.parse((broken.config.configFile as { $secret: string }).$secret) as Record<string, unknown>;
  delete client['UID'];
  broken.config.configFile = { $secret: JSON.stringify(client) };

  const error = refusalFor({
    id: 'hq',
    name: 'HQ',
    role: 'resource',
    enabled: true,
    onUnavailable: 'block',
    provider: 'openvpn',
    config: { profile: { $secret: 'client\ndev tun\n' } },
    transports: [broken],
  });
  assert.match(error.message, /"war1"/);
  assert.match(error.message, /host, account, public key, disguised name/);
});

test('an external client that is not running VLESS is refused', () => {
  const error = refusalFor({
    id: 'other',
    name: 'Some other client',
    role: 'alternative',
    enabled: true,
    onUnavailable: 'block',
    provider: 'external-socks',
    config: {
      command: '/usr/local/bin/something run',
      configFile: { $secret: JSON.stringify({ outbounds: [{ protocol: 'trojan', settings: {} }] }) },
      localPort: 10810,
    },
  });
  assert.match(error.message, /not a VLESS account/);
});

test('every untranslatable tunnel is named at once, not one per attempt', () => {
  const document = {
    schemaVersion: 6,
    tunnels: [
      { id: 'one', provider: 'raw', config: {} },
      { id: 'two', provider: 'singbox-endpoint', config: {} },
    ],
  };
  try {
    migrateProfile(document);
    throw new Error('the migration accepted something it cannot run');
  } catch (error) {
    assert.ok(error instanceof ProfileCatalogueError);
    assert.deepEqual(error.tunnels.map((entry) => entry.tunnel), ['one', 'two']);
    assert.match(error.message, /2 tunnels name/);
  }
});

/* ── what a failed migration leaves behind ───────────────────────────────────────────────── */

test('a migration that refuses leaves the caller’s document exactly as it was', () => {
  // Three mechanisms in two days were found leaving the system half-changed and reporting success.
  // This one cannot: every step runs against a clone and the result is returned only at the end, so
  // a refusal in the middle of the tunnel list leaves no partially translated document anywhere.
  const document = benchAtVersion6();
  const tunnels = document['tunnels'] as Record<string, unknown>[];
  tunnels.push({ id: 'legacy', provider: 'raw', config: {} });
  const before = structuredClone(document);

  assert.throws(() => migrateProfile(document), ProfileCatalogueError);
  assert.deepEqual(document, before, 'the input was mutated by a migration that failed');

  // And it is still a version 6 document: nothing bumped the version on the way past.
  assert.equal(document['schemaVersion'], 6);
});

test('the refusal branch is reachable from a document that only just fails', () => {
  // The four translatable tunnels, plus one that is not. If the refusal branch were unreachable this
  // would return a document and the assertion would fail here rather than never running at all.
  const document = benchAtVersion6();
  (document['tunnels'] as Record<string, unknown>[]).push({
    id: 'fifth',
    provider: 'openvpn',
    config: { interfaceSuffix: 'x' },
  });
  const error = (() => {
    try {
      migrateProfile(document);
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof ProfileCatalogueError);
  assert.deepEqual(error.tunnels.map((entry) => entry.tunnel), ['fifth']);
  assert.match(error.message, /OpenVPN profile is missing/);
});

/* ── the gate on the producer ────────────────────────────────────────────────────────────── */

/**
 * The step builds catalogue configurations by hand, and nothing compared them to the entry that has
 * to accept them.
 *
 * Both halves were tested against themselves — the translations against what they were written to
 * produce, the schema against documents somebody wrote out — and no test put the first into the
 * second, because that seam is inside neither file. This project has met exactly this shape before,
 * with `parseSubscription`, and the fix there was to move the check into the producer. It was not
 * carried across.
 *
 * `interfaceSuffix` is the instance that proves it is not hypothetical: the field is carried
 * straight through, and the catalogue narrowed it from 1–8 characters to 1–6. A seven-character
 * suffix migrated into a version-7 document that was **already invalid** — stored, and refused by
 * nothing until something downstream tried to use it.
 */
test('a translation the catalogue entry would not accept is refused, naming the tunnel and the field', () => {
  const document = benchAtVersion6();
  const tunnels = document['tunnels'] as Record<string, unknown>[];
  // Seven characters: valid under version 6's 1–8, outside the catalogue's 1–6.
  (tunnels[0]!['config'] as Record<string, unknown>)['interfaceSuffix'] = 'toolong';

  const error = (() => {
    try {
      migrateProfile(document);
      return null;
    } catch (caught) {
      return caught;
    }
  })();

  assert.ok(
    error instanceof ProfileCatalogueError,
    'the migration produced a document its own catalogue entry cannot accept',
  );
  assert.deepEqual(error.tunnels.map((entry) => entry.tunnel), ['partner'], 'the refusal does not name the tunnel');
  assert.match(error.tunnels[0]!.reason, /interfaceSuffix/, 'the refusal does not name the field');
});

/**
 * The anchor, and it is the reason this gate is a gate rather than a wall.
 *
 * The bench document — four tunnels, one uplink, six secrets — must still go 6 → 7 in one step. A
 * check that refuses the real thing is not a check, and a mutation of the gate has to be
 * distinguishable from a mutation of the fixture.
 */
test('the bench document still migrates cleanly through the gate', () => {
  const migrated = migrateProfile(benchAtVersion6());
  assert.equal(migrated.document['schemaVersion'], PROFILE_SCHEMA_VERSION);
  assert.equal((migrated.document['tunnels'] as unknown[]).length, 4);
  for (const tunnel of migrated.document['tunnels'] as Record<string, unknown>[]) {
    assert.equal(
      catalogueConfigFaults(tunnel['protocol'] as TunnelProtocol, tunnel['config'], '').length,
      0,
      `the migrated "${String(tunnel['id'])}" is not one its own entry accepts`,
    );
  }
});
