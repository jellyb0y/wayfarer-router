/**
 * The catalogue: three entries, and the two things about them that are decisions rather than code.
 *
 * Every value here is invented. The shapes were taken from a redacted export of the bench profile;
 * the credentials in that export are real, so nothing from it is copied into this repository — only
 * the shape of each field, filled with values that are obviously not anybody's.
 *
 * ## What these tests are for, stated so a later reader can tell whether they still do it
 *
 * Two of them exist to catch a specific defect and nothing else, and both were **proved by
 * mutation**: the thing they exist to catch was broken, and exactly one test failed.
 *
 * * *the carrier is established, not guessed* — a configuration the proxy core rejects must select
 *   the external client, and an ordinary one must select the native outbound. A test where both
 *   branches agree proves nothing, so each branch is asserted on its **artefacts** — the number of
 *   units, the outbound type — and not on the label the entry put on its own decision.
 * * *the port is allocated once and used twice* — the generated `.ovpn` must dial the ports the
 *   entry points were actually given, in the order the entry points are listed. This is the failure
 *   that the old two-blob shape made invisible.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { TUNNEL_PROTOCOLS } from '@wayfarer/schemas';
import {
  CATALOGUE,
  CATALOGUE_LIST,
  type CoreCapabilities,
  type EntryPlanContext,
  type EntryPlanResult,
} from '../src/core/catalogue/index.ts';
import { establishCarrier } from '../src/core/catalogue/vless.ts';
import { PATHS } from '../src/core/desired-state.ts';

const CORE_KNOWS_EVERYTHING: CoreCapabilities = {
  known: true,
  outboundTypes: new Set(['vless', 'socks', 'direct']),
};

/** A context that records what was allocated, so a test can assert on the claims as well as the files. */
function context(overrides: Partial<EntrySubjectish> = {}): {
  context: EntryPlanContext;
  claims: { port: number; owner: string; pointer: string }[];
} {
  const claims: { port: number; owner: string; pointer: string }[] = [];
  let next = 10_800;
  return {
    claims,
    context: {
      tunnel: { id: overrides.id ?? 'hq', name: overrides.name ?? 'HQ', index: overrides.index ?? 0 },
      core: CORE_KNOWS_EVERYTHING,
      installed: new Set(['openvpn', 'ck-client', 'xray']),
      allocatePort: (claim) => {
        const port = next;
        next += 1;
        claims.push({ port, ...claim });
        return port;
      },
    },
  };
}

interface EntrySubjectish {
  id: string;
  name: string;
  index: number;
}

function planned(result: EntryPlanResult) {
  assert.equal(result.ok, true, result.ok ? '' : result.refusal.reason);
  assert.ok(result.ok);
  return result.plan;
}

/* ── the list ────────────────────────────────────────────────────────────────────────────── */

test('the catalogue is a list, and its count is a line', () => {
  // `proxy` joined on 2026-09-22 (Epic F, row F5). The list grew by a line and by nothing else,
  // which is the property this assertion exists for rather than the number four.
  assert.deepEqual([...TUNNEL_PROTOCOLS], ['openvpn', 'cloak-openvpn', 'vless', 'proxy']);
  assert.equal(CATALOGUE_LIST.length, TUNNEL_PROTOCOLS.length);
  // Every entry is reachable from the list, and every entry's id is the key it is filed under. A
  // mismatch here would let a refusal name one protocol while another was planned.
  for (const protocol of TUNNEL_PROTOCOLS) {
    assert.equal(CATALOGUE[protocol].id, protocol);
  }
});

test('an entry is named after what the owner holds, never after what this device starts', () => {
  // `Xray` is the program that runs a VLESS subscription; the owner holds the subscription. The
  // rename is the whole correction, so it is asserted rather than trusted to survive an edit.
  const titles = CATALOGUE_LIST.map((entry) => entry.title);
  assert.deepEqual(titles, ['OpenVPN', 'Cloak + OpenVPN', 'VLESS', 'Proxy']);
  for (const title of titles) {
    assert.ok(!/xray|sing-?box|ck-client/i.test(title), `"${title}" names a program, not a thing an owner has`);
  }
});

/* ── OpenVPN ─────────────────────────────────────────────────────────────────────────────── */

test('OpenVPN: the profile’s own remotes stand, and the interface name is generated', () => {
  const { context: ctx, claims } = context({ id: 'partner', name: 'Partner work', index: 1 });
  const plan = planned(
    CATALOGUE.openvpn.plan(
      {
        profile: 'client\ndev tun\nremote vpn.example.invalid 1194\n',
        interfaceSuffix: 'prt',
      },
      ctx,
    ),
  );

  assert.deepEqual(plan.interfaces, ['wfvpnprt']);
  assert.deepEqual(plan.object, { type: 'direct', bind_interface: 'wfvpnprt' });
  assert.equal(plan.units.length, 1);
  assert.equal(plan.units[0]?.name, 'wf-openvpn@partner.service');
  // No port is claimed: a plain OpenVPN tunnel listens on nothing locally.
  assert.deepEqual(claims, []);

  const conf = plan.files.find((file) => file.path.endsWith('partner.conf'));
  assert.ok(conf);
  assert.match(conf.content, /^remote vpn\.example\.invalid 1194$/m);
});

/* ── Cloak + OpenVPN ─────────────────────────────────────────────────────────────────────── */

function entryPoint(id: string, host: string, serverName: string) {
  return {
    id,
    host,
    port: 443,
    uid: 'AAAAAAAAAAAAAAAAAAAAAA==',
    publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=',
    proxyMethod: 'openvpn',
    encryptionMethod: 'aes-gcm' as const,
    serverName,
    browserSignature: 'chrome' as const,
    transport: 'direct' as const,
  };
}

test('Cloak + OpenVPN: one port allocated per entry point, and the .ovpn dials exactly those', () => {
  const { context: ctx, claims } = context({ id: 'hq', name: 'HQ', index: 2 });
  const plan = planned(
    CATALOGUE['cloak-openvpn'].plan(
      {
        // The supplied profile names a remote of its own. It must be dropped: under the old shape
        // this line had to be kept in step by hand with a port stated in a different string.
        profile: 'client\ndev tun\nremote 127.0.0.1 12294\n',
        interfaceSuffix: 'hq',
        entryPoints: [
          entryPoint('war1', 'war1.example.invalid', 'a.example.invalid'),
          entryPoint('war2', 'war2.example.invalid', 'b.example.invalid'),
          entryPoint('msk1', 'msk1.example.invalid', 'c.example.invalid'),
          entryPoint('msk2', 'msk2.example.invalid', 'd.example.invalid'),
        ],
      },
      ctx,
    ),
  );

  assert.equal(claims.length, 4, 'one port per entry point');
  // Four listeners plus the OpenVPN client itself.
  assert.equal(plan.units.length, 5);

  const conf = plan.files.find((file) => file.path === `${PATHS.openvpnDir}/hq.conf`);
  assert.ok(conf);
  const remotes = conf.content.split('\n').filter((line) => line.startsWith('remote '));
  assert.deepEqual(
    remotes,
    claims.map((claim) => `remote 127.0.0.1 ${claim.port}`),
    'the generated remotes are the allocated ports, in the order the entry points are listed',
  );
  assert.ok(!conf.content.includes('remote 127.0.0.1 12294'), 'the supplied profile’s own remote is dropped');

  // Each listener's own configuration names the same port as the remote that dials it.
  for (const [index, claim] of claims.entries()) {
    const listener = plan.files.find((file) => file.path.endsWith(`.json`) && file.content.includes(`"LocalPort": "${claim.port}"`));
    assert.ok(listener, `entry point ${index} has a configuration naming its allocated port`);
  }

  // The file extension is ours, and it is `.json`: a client that infers its format from the
  // extension met a `.conf` once and did not start, silently.
  for (const file of plan.files.filter((candidate) => candidate.path.startsWith(PATHS.transportDir))) {
    assert.ok(/\.(json|sh)$/.test(file.path), `${file.path} states its format in its name`);
  }
});

test('Cloak + OpenVPN: the account identifier reaches the generated file and nothing else does', () => {
  const { context: ctx } = context({ id: 'corp', name: 'Corp', index: 0 });
  const plan = planned(
    CATALOGUE['cloak-openvpn'].plan(
      {
        profile: 'client\ndev tun\n',
        entryPoints: [entryPoint('sg', 'sg.example.invalid', 'e.example.invalid')],
      },
      ctx,
    ),
  );

  const listener = plan.files.find((file) => file.path.endsWith('.json'));
  assert.ok(listener);
  assert.match(listener.content, /"UID": "AAAAAAAAAAAAAAAAAAAAAA=="/);
  // 0600, because this file carries the credential that makes the entry point work.
  assert.equal(listener.mode, 0o600);
});

/* ── VLESS: the carrier ──────────────────────────────────────────────────────────────────── */

const ORDINARY_VLESS = {
  server: '198.51.100.7',
  port: 43456,
  id: '00000000-0000-4000-8000-000000000000',
  network: 'ws' as const,
  security: 'tls' as const,
  serverName: '198.51.100.7',
  fingerprint: 'chrome',
  alpn: ['h2', 'http/1.1'],
  path: '/',
};

/**
 * The configuration shape the bench's fourth tunnel has: a post-quantum encryption parameter, which
 * the proxy core defines no field for and rejects outright. The value here is invented; only its
 * leading token matches what was measured.
 */
const CORE_REJECTS_THIS = {
  ...ORDINARY_VLESS,
  encryption: 'mlkem768x25519plus.native.0rtt.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

test('VLESS: a configuration the core rejects selects the external client', () => {
  const { context: ctx, claims } = context({ id: 'relay', name: 'Relay', index: 3 });
  const plan = planned(CATALOGUE.vless.plan(CORE_REJECTS_THIS, ctx));

  assert.equal(plan.carrier?.kind, 'external');
  // Asserted on the artefacts, not on the label: a second process runs, on a port this daemon
  // allocated, and the core reaches it over loopback.
  assert.equal(claims.length, 1);
  assert.equal(plan.units.length, 1);
  assert.equal(plan.units[0]?.name, 'wf-socks@relay.service');
  assert.deepEqual(plan.object, { type: 'socks', server: '127.0.0.1', server_port: claims[0]?.port });

  const clientConfig = plan.files.find((file) => file.path === `${PATHS.socksDir}/relay.json`);
  assert.ok(clientConfig, 'the client configuration is named .json, not .conf');
  assert.match(clientConfig.content, /mlkem768x25519plus/);
  // The reason is stated in the plan, because the owner cannot be asked and must be able to read
  // why afterwards.
  assert.match(plan.carrier?.reason ?? '', /encryption/);
});

test('VLESS: an ordinary configuration selects the core’s own outbound', () => {
  const { context: ctx, claims } = context({ id: 'relay', name: 'Relay', index: 3 });
  const plan = planned(CATALOGUE.vless.plan(ORDINARY_VLESS, ctx));

  assert.equal(plan.carrier?.kind, 'native');
  // The other half of the pair. If this ever matches the branch above, the choice has stopped being
  // a choice and the test above proves nothing.
  assert.deepEqual(claims, [], 'no port is allocated, because no second process runs');
  assert.deepEqual(plan.units, []);
  assert.deepEqual(plan.files, []);
  assert.equal(plan.object['type'], 'vless');
  assert.equal(plan.object['server_port'], 43456);
  assert.deepEqual(plan.object['transport'], { type: 'ws', path: '/' });
});

test('VLESS: a field whose carrier cannot be established is refused by name', () => {
  const { context: ctx } = context({ id: 'relay', name: 'Relay', index: 3 });
  // A field nobody classified. This is the branch that fires the day somebody adds a field to
  // `VlessConfig` and does not say which client understands it.
  const result = CATALOGUE.vless.plan({ ...ORDINARY_VLESS, somethingNew: 'yes' }, ctx);

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.refusal.protocol, 'vless');
  assert.equal(result.refusal.tunnelId, 'relay');
  assert.equal(result.refusal.pointer, '/tunnels/3/config/somethingNew');
  assert.match(result.refusal.reason, /somethingNew/);
  // A refusal says in the same breath that the data plane is still running: a profile that cannot
  // be planned means there is nothing to manage with, not that the network fell over.
  assert.match(result.refusal.reason, /independent of this daemon/);
});

test('VLESS: "encryption": "none" is the absence of the feature, and the core carries it', () => {
  const established = establishCarrier({ ...ORDINARY_VLESS, encryption: 'none' });
  assert.ok(established.ok);
  assert.equal(established.carrier.kind, 'native');
});

/* ── availability ────────────────────────────────────────────────────────────────────────── */

test('an unknown core schema offers everything rather than refusing', () => {
  // The fetch survives for availability discovery only, and it must not be able to block
  // configuration by refusal or by waiting. Absent knowledge is not a negative answer.
  const unknown: CoreCapabilities = { known: false, outboundTypes: new Set() };
  for (const entry of CATALOGUE_LIST) {
    const availability = entry.availability({
      core: unknown,
      installed: new Set(['openvpn', 'ck-client', 'xray']),
    });
    assert.equal(availability.available, true, `${entry.title} is offered when the core schema is unknown`);
  }
});

test('a missing binary is reported as what to install, not as a mystery', () => {
  const availability = CATALOGUE['cloak-openvpn'].availability({
    core: CORE_KNOWS_EVERYTHING,
    installed: new Set(['openvpn']),
  });
  assert.equal(availability.available, false);
  assert.deepEqual(availability.requires?.map((requirement) => requirement.binary), ['ck-client']);
});

/**
 * Reality over the external carrier, which had no branch at all.
 *
 * `xrayConfig` wrote `streamSettings.security = "reality"` — telling the client to do a Reality
 * handshake — and then wrote a settings block only for `security === 'tls'`, so the public key and
 * the short id were dropped. The unit file is written cleanly, the unit starts, and the handshake
 * fails against the real server: **applies with no refusal, cannot pass traffic.**
 *
 * Reachable because the carrier is established from the configuration rather than chosen: any field
 * that forces the external client sends a Reality link down this path, and `encryption` is the
 * measured one. The bench board's VLESS tunnel is `security: "tls"`, so this is latent there and not
 * live — which decides who finds it, not whether it is broken.
 *
 * Asserted on the parsed document rather than on the text, because a test matching on a substring
 * passes for a key written in the wrong place.
 */
test('VLESS: a Reality link carried externally keeps its Reality parameters', () => {
  const { context: ctx, claims } = context({ id: 'relay', name: 'Relay', index: 3 });
  const plan = planned(
    CATALOGUE.vless.plan(
      {
        ...ORDINARY_VLESS,
        security: 'reality',
        // The field that forces the external carrier. Without it this configuration would be native
        // and the branch under test would never be reached.
        encryption: 'mlkem768x25519plus.native.0rtt.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        realityPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        realityShortId: '0123abcd',
      },
      ctx,
    ),
  );

  assert.equal(plan.carrier?.kind, 'external', 'this configuration must be carried externally, or it proves nothing');
  assert.equal(claims.length, 1);

  const clientConfig = plan.files.find((file) => file.path === `${PATHS.socksDir}/relay.json`);
  assert.ok(clientConfig, 'no client configuration was written');
  const document = JSON.parse(clientConfig.content) as {
    outbounds: { streamSettings: { security: string; realitySettings?: Record<string, unknown> } }[];
  };
  const stream = document.outbounds[0]!.streamSettings;

  assert.equal(stream.security, 'reality');
  assert.ok(
    stream.realitySettings,
    'the client is told to do a Reality handshake and given nothing to do it with: the unit starts, ' +
      'and the handshake fails against the real server',
  );
  // The external client's own field names. Mirroring the core's `public_key` / `short_id` here would
  // be the same values dropped a second time, and would look correct beside `nativeOutbound`.
  assert.equal(stream.realitySettings['publicKey'], 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(stream.realitySettings['shortId'], '0123abcd');
  assert.equal(stream.realitySettings['serverName'], '198.51.100.7');
});

/** The native carrier's half of the same pair, so a fix to one cannot silently be a fix to neither. */
test('VLESS: a Reality link carried by the core keeps its Reality parameters', () => {
  const { context: ctx } = context({ id: 'relay', name: 'Relay', index: 3 });
  const plan = planned(
    CATALOGUE.vless.plan(
      {
        ...ORDINARY_VLESS,
        security: 'reality',
        realityPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        realityShortId: '0123abcd',
      },
      ctx,
    ),
  );

  assert.equal(plan.carrier?.kind, 'native');
  const tls = plan.object['tls'] as { reality?: Record<string, unknown> };
  assert.deepEqual(tls.reality, {
    enabled: true,
    public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    short_id: '0123abcd',
  });
});

/* ── Proxy ───────────────────────────────────────────────────────────────────────────────── */

/**
 * **Every value below is invented.** The owner holds the real address, port, user name and password
 * and configures the board himself; not one of them is in this repository, in any file, including
 * this one.
 *
 * The configuration these tests exercise hardest is **SOCKS with a user name and a password and no
 * TLS**, because that is the one the entry was written for. A suite spread evenly over three types
 * would test the two nobody is holding as thoroughly as the one somebody is.
 */
const SOCKS_WITH_SIGN_IN = {
  type: 'socks' as const,
  server: 'proxy.example.invalid',
  port: 1080,
  auth: { username: 'invented-user', password: 'invented-password' },
};

test('Proxy: SOCKS with a sign-in emits one outbound and starts nothing at all', () => {
  const { context: ctx, claims } = context({ id: 'ru', name: 'Russian proxy', index: 2 });
  const plan = planned(CATALOGUE.proxy.plan(SOCKS_WITH_SIGN_IN, ctx));

  assert.equal(plan.target, 'outbounds');
  assert.deepEqual(plan.object, {
    type: 'socks',
    server: 'proxy.example.invalid',
    server_port: 1080,
    // Written rather than defaulted: SOCKS4 has no user-name/password authentication, so a version
    // left to a default is a credential that may silently mean nothing.
    version: '5',
    username: 'invented-user',
    password: 'invented-password',
  });

  /*
   * The whole of the F5 claim, asserted on artefacts rather than on prose: no binary, no external
   * process, no generated file, no unit, no interface and no allocated port. An entry that grew any
   * of these would still pass a test that only looked at the outbound object.
   */
  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.units, []);
  assert.deepEqual(plan.interfaces, []);
  assert.deepEqual(claims, []);
  // Only an entry with a choice to make states one. This one has no second carrier to choose.
  assert.equal(plan.carrier, undefined);
});

test('Proxy: a password still wrapped for a dry run is unwrapped into the outbound', () => {
  /*
   * A dry run plans an **unresolved** document, where a stored secret is still `{ "$secret": … }`.
   * `secretText` unwraps it; an entry reading the field directly would put the object itself into
   * the configuration, and the core would be handed a password whose value is `[object Object]`.
   *
   * Unwrapping is not redaction, and this test asserts the unwrapping only. What keeps a dry run from
   * publishing the value is `renderPlan`, which never returns generated file content at all.
   */
  const { context: ctx } = context();
  const plan = planned(
    CATALOGUE.proxy.plan(
      { ...SOCKS_WITH_SIGN_IN, auth: { username: 'invented-user', password: { $secret: 'invented-password' } } },
      ctx,
    ),
  );
  assert.equal(plan.object['password'], 'invented-password');
});

test('Proxy: a proxy with no sign-in carries neither half of one', () => {
  const { context: ctx } = context();
  const plan = planned(CATALOGUE.proxy.plan({ type: 'socks', server: 'proxy.example.invalid', port: 1080 }, ctx));
  assert.equal('username' in plan.object, false);
  assert.equal('password' in plan.object, false);
});

test('Proxy: HTTPS is the core’s http outbound with TLS on, and verification is never turned off', () => {
  const { context: ctx } = context();
  const plan = planned(
    CATALOGUE.proxy.plan(
      {
        type: 'https',
        server: 'proxy.example.invalid',
        port: 8443,
        tlsCertificate: ['-----BEGIN CERTIFICATE-----', 'AAAA', '-----END CERTIFICATE-----'],
      },
      ctx,
    ),
  );

  // The translation that is ours rather than the owner's: he was told "an HTTPS proxy", and the
  // core has no such outbound type.
  assert.equal(plan.object['type'], 'http');
  assert.deepEqual(plan.object['tls'], {
    enabled: true,
    // No handshake name given, so the address is the name.
    server_name: 'proxy.example.invalid',
    certificate: ['-----BEGIN CERTIFICATE-----', 'AAAA', '-----END CERTIFICATE-----'],
  });

  /*
   * The field this repository refused for subscription links, asserted absent on the entry that
   * would be the obvious place to reintroduce it. Supplying a certificate answers the need behind
   * `allowInsecure`; switching the check off does not, and nothing here may write it.
   */
  assert.equal(JSON.stringify(plan.object).includes('insecure'), false);
});

test('Proxy: the handshake name overrides the address when it is given', () => {
  const { context: ctx } = context();
  const plan = planned(
    CATALOGUE.proxy.plan(
      { type: 'https', server: '198.51.100.7', port: 8443, tlsServerName: 'proxy.example.invalid' },
      ctx,
    ),
  );
  assert.deepEqual(plan.object['tls'], { enabled: true, server_name: 'proxy.example.invalid' });
});

test('Proxy: a TLS field on a proxy with no handshake is refused, not dropped', () => {
  /*
   * The predicate this entry exists to make fire. The interface draws those two controls for HTTPS
   * and for nothing else, so a document reaching here arrived some other way — which is exactly when
   * nobody is watching a screen. Dropping the field would produce a tunnel that looks complete and
   * fails for a reason its author wrote down: the shape `allowInsecure` was refused for.
   */
  const { context: ctx } = context({ id: 'ru', name: 'Russian proxy', index: 2 });
  const refused = CATALOGUE.proxy.plan({ ...SOCKS_WITH_SIGN_IN, tlsServerName: 'proxy.example.invalid' }, ctx);

  assert.equal(refused.ok, false);
  assert.ok(!refused.ok);
  assert.equal(refused.refusal.protocol, 'proxy');
  assert.equal(refused.refusal.tunnelId, 'ru');
  assert.equal(refused.refusal.pointer, '/tunnels/2/config/tlsServerName');
  assert.match(refused.refusal.reason, /SOCKS/);
  // A refusal is not an outage, and every refusal in this catalogue says so in the same breath.
  assert.match(refused.refusal.reason, /Nothing has stopped/);

  const alsoRefused = CATALOGUE.proxy.plan(
    { type: 'http', server: 'p.example.invalid', port: 3128, tlsCertificate: ['x'] },
    ctx,
  );
  assert.equal(alsoRefused.ok, false);
  assert.ok(!alsoRefused.ok);
  assert.equal(alsoRefused.refusal.pointer, '/tunnels/2/config/tlsCertificate');

  // An empty list is not a stated certificate, so it is not a refusal either.
  assert.equal(
    CATALOGUE.proxy.plan({ type: 'socks', server: 'p.example.invalid', port: 1080, tlsCertificate: [] }, ctx).ok,
    true,
  );
});

test('Proxy: a sign-in with an empty password is refused rather than emitted as ""', () => {
  /*
   * `Secret()` sets no minimum length, so `password: ""` is a legal document: it validates, it
   * stores, it plans, and the core is handed an empty password that the proxy refuses — with nothing
   * in the configuration looking wrong. Refused here rather than by tightening `Secret()`, which is
   * shared by every credential in the product.
   */
  const { context: ctx } = context({ id: 'ru', name: 'Russian proxy', index: 2 });
  const refused = CATALOGUE.proxy.plan(
    { ...SOCKS_WITH_SIGN_IN, auth: { username: 'invented-user', password: '' } },
    ctx,
  );
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok);
  assert.equal(refused.refusal.pointer, '/tunnels/2/config/auth/password');
  assert.match(refused.refusal.reason, /empty/);

  // The wrapped form of the same emptiness, which is what a dry run sees.
  const wrapped = CATALOGUE.proxy.plan(
    { ...SOCKS_WITH_SIGN_IN, auth: { username: 'invented-user', password: { $secret: '' } } },
    ctx,
  );
  assert.equal(wrapped.ok, false);

  // And no sign-in at all is not an empty password: that is a proxy that does not ask.
  assert.equal(CATALOGUE.proxy.plan({ type: 'socks', server: 'p.example.invalid', port: 1080 }, ctx).ok, true);
});

test('Proxy: a certificate that is obviously not PEM is refused here, not at the core’s start-up', () => {
  /*
   * No parser — the core has one, and a second would disagree with it eventually. Only that a PEM
   * block was opened, which is the difference between pasting a certificate and pasting the middle
   * of one. Without it the value travels to the core's start-up and fails in a journal, about a file
   * nobody wrote by hand.
   */
  const { context: ctx } = context({ id: 'ru', name: 'Russian proxy', index: 2 });
  const refused = CATALOGUE.proxy.plan(
    { type: 'https', server: 'p.example.invalid', port: 8443, tlsCertificate: ['MIIBAAAAAA', 'QUJD'] },
    ctx,
  );
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok);
  assert.equal(refused.refusal.pointer, '/tunnels/2/config/tlsCertificate');
  assert.match(refused.refusal.reason, /-----BEGIN/);

  // A whole PEM passes, including one indented by a paste.
  assert.equal(
    CATALOGUE.proxy.plan(
      {
        type: 'https',
        server: 'p.example.invalid',
        port: 8443,
        tlsCertificate: ['  -----BEGIN CERTIFICATE-----', 'AAAA', '-----END CERTIFICATE-----'],
      },
      ctx,
    ).ok,
    true,
  );
});

test('Proxy: availability is unconditional, because nothing can be missing', () => {
  /*
   * A core that published an empty outbound union, and a device with no binaries at all. Every other
   * entry has something it could be waiting for; this one has none, so an unavailable verdict would
   * be one nobody could act on.
   */
  const nothing: CoreCapabilities = { known: true, outboundTypes: new Set() };
  assert.deepEqual(CATALOGUE.proxy.availability({ core: nothing, installed: new Set() }), { available: true });
  assert.deepEqual(
    CATALOGUE.proxy.availability({ core: { known: false, outboundTypes: new Set() }, installed: new Set() }),
    { available: true },
  );
});
