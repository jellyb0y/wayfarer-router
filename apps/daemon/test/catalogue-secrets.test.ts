/**
 * **Every credential a catalogue entry writes into the generated configuration must be recognisable
 * as one by the code that decides what may be printed.**
 *
 * `core/drift.ts` withholds both values of a divergence at a credential, because a drift finding is
 * served by `GET /api/drift`, drawn on the Status screen and written into the **persisted** event
 * ring. It decides which pointers those are from a list of key names, and a list is exactly the kind
 * of thing that stops matching what it describes: a catalogue entry renames a marked profile field
 * on the way out — `ProxyConfig.auth.password` becomes `password`, `VlessConfig.id` becomes `uuid` —
 * so nothing mechanical joins the schema's `x-secret` marks to the keys the core is handed.
 *
 * This file closes that from the other end. Every entry is planned with a **sentinel** in each of
 * its credential fields, the emitted object is walked, and any pointer whose value carries the
 * sentinel must be one `carriesSecret` recognises. A protocol added without a thought about this is
 * a red test here rather than a password in an event ring on somebody's device.
 *
 * `CONFIGS` is a total map over `TunnelProtocol`, so adding an entry to the catalogue and not to
 * this file does not compile.
 *
 * **Every value below is invented.**
 *
 * Generated **files** are covered by the second test: the `.ovpn` blob holds a private key, and a
 * file that holds a credential must carry `ManagedFile.credentials`, which is what makes the drift
 * check name the file and withhold its lines (`docs/13-plan.md` row G12). The planner's own files —
 * `hostapd`, the supplicant — are held to the same rule in `planner-golden.test.ts`.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { TUNNEL_PROTOCOLS, type TunnelProtocol } from '@wayfarer/schemas';

import { CATALOGUE, type EntryPlanContext } from '../src/core/catalogue/index.ts';
import { carriesSecret } from '../src/core/drift.ts';

/** Distinctive enough that finding it in a value is proof it came from a credential field. */
const SENTINEL = 'INVENTED-CREDENTIAL-SENTINEL';

const CONFIGS = {
  openvpn: { profile: `client\ndev tun\nremote vpn.example.invalid 1194\nkey ${SENTINEL}\n` },
  'cloak-openvpn': {
    profile: `client\ndev tun\nkey ${SENTINEL}\n`,
    entryPoints: [
      {
        id: 'entry-1',
        host: 'entry.example.invalid',
        port: 443,
        uid: `${SENTINEL}-uid`,
        publicKey: 'AAAA',
        proxyMethod: 'openvpn',
        encryptionMethod: 'aes-gcm',
        serverName: 'www.example.invalid',
        browserSignature: 'chrome',
        transport: 'direct',
      },
    ],
  },
  vless: {
    server: 'v.example.invalid',
    port: 443,
    id: `${SENTINEL}-uuid`,
    network: 'tcp',
    security: 'tls',
  },
  proxy: {
    type: 'socks',
    server: 'proxy.example.invalid',
    port: 1080,
    auth: { username: 'invented-user', password: `${SENTINEL}-password` },
  },
} as const satisfies Record<TunnelProtocol, Record<string, unknown>>;

function context(): EntryPlanContext {
  let next = 10_800;
  return {
    tunnel: { id: 't1', name: 'Tunnel one', index: 0 },
    core: { known: true, outboundTypes: new Set(['vless', 'socks', 'http', 'direct']) },
    installed: new Set(['openvpn', 'ck-client', 'xray']),
    allocatePort: () => {
      next += 1;
      return next;
    },
  };
}

/** Every leaf of an emitted object, as a JSON Pointer and a value. */
function* leaves(value: unknown, pointer = ''): Generator<{ pointer: string; value: unknown }> {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) yield* leaves(entry, `${pointer}/${String(index)}`);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      yield* leaves(entry, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    }
    return;
  }
  yield { pointer, value };
}

test('no catalogue entry hides a credential under a key the drift check would print', () => {
  const checked: string[] = [];

  for (const protocol of TUNNEL_PROTOCOLS) {
    const result = CATALOGUE[protocol].plan(CONFIGS[protocol], context());
    assert.equal(result.ok, true, `${protocol} must plan from this fixture, or it proves nothing`);
    assert.ok(result.ok);

    for (const leaf of leaves(result.plan.object)) {
      if (typeof leaf.value !== 'string' || !leaf.value.includes(SENTINEL)) continue;
      checked.push(`${protocol}${leaf.pointer}`);
      assert.equal(
        carriesSecret(leaf.pointer),
        true,
        `${protocol} writes a credential to ${leaf.pointer}, and \`carriesSecret\` does not recognise ` +
          'that key — so a divergence there would print it into the API, a screen and the event ring. ' +
          'Add the key to SECRET_LEAVES in core/drift.ts.',
      );
    }
  }

  /*
   * **And the sentinel has to have been found somewhere**, or this test is a loop over nothing that
   * passes for ever. Two entries emit a credential into the object: VLESS's account and the proxy's
   * password. The other two carry theirs in generated *files*, which is the gap named in the header.
   */
  assert.deepEqual(checked.sort(), ['proxy/password', 'vless/uuid']);
});

test('the recogniser matches a leaf and is not fooled by a similar-looking path', () => {
  // Proof the predicate can answer both ways, so the assertion above is not satisfied by a function
  // that says yes to everything.
  assert.equal(carriesSecret('/outbounds/0/password'), true);
  assert.equal(carriesSecret('/outbounds/1/uuid'), true);
  assert.equal(carriesSecret('/outbounds/0/server'), false);
  assert.equal(carriesSecret('/outbounds/0/password/0'), false, 'the leaf is the last segment');
});

test('every file a catalogue entry writes a credential into is marked as holding credentials', () => {
  const marked: string[] = [];

  for (const protocol of TUNNEL_PROTOCOLS) {
    const result = CATALOGUE[protocol].plan(CONFIGS[protocol], context());
    assert.ok(result.ok, `${protocol} must plan from this fixture, or it proves nothing`);
    for (const file of result.plan.files ?? []) {
      if (!file.content.includes(SENTINEL)) continue;
      assert.equal(
        file.credentials,
        true,
        `${protocol} writes a credential into ${file.path} without marking it, so the drift check would ` +
          'print its differing line into the API, a screen and the event ring. Set `credentials: true` ' +
          'where the file is generated.',
      );
      marked.push(`${protocol}:${file.path}`);
    }
  }

  // Found, or the loop proved nothing: both OpenVPN entries carry the key in the blob, and the
  // obfuscated one also carries the account id in its entry point.
  assert.ok(marked.some((entry) => entry.startsWith('openvpn:')), marked.join(', '));
  assert.ok(marked.some((entry) => entry.startsWith('cloak-openvpn:')), marked.join(', '));
});
