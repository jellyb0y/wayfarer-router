/**
 * Subscription parsers, against **synthetic** fixtures.
 *
 * Every test name below says "believed shape" where it rests on a fixture, and that is not padding. The
 * fixtures in `fixtures/subscriptions/` were written by hand from what this project believes each link
 * format to be; none is a capture from a real provider. Elsewhere in this repository a fixture is a
 * recording and therefore evidence about the world — the `iw phy` dumps, the hostapd station output, the
 * core's own schema. These are not, and a fixture that disagrees with reality produces a green suite and a
 * wrong parser.
 *
 * What the tests below *do* establish independently of any belief about formats:
 *
 * * a parsed draft is one the catalogue can store, checked against the entry's own schema;
 * * a link this product does not run is **refused by name**, and the refusal says what *is* run;
 * * an unparseable line is **reported**, with its scheme and position, never skipped;
 * * a credential never reaches an error message;
 * * a whole-body base64 wrapper is detected by trying rather than by guessing at the characters;
 * * a provider renaming a node is not reported as the node vanishing.
 *
 * Those six are about our own behaviour and hold whatever the formats turn out to be.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TUNNEL_PROTOCOL_TITLES, type VlessConfig } from '@wayfarer/schemas';

import {
  BUILT_IN_PARSERS,
  RECOGNISED_NOT_RUN,
  decodeSubscriptionBody,
  diffSubscription,
  nodeIdentity,
  parseSubscription,
  safeExcerpt,
  tryBase64,
  type ParsedNode,
} from '../src/index.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'subscriptions');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** The single node a one-link fixture contains, or a failure with the reason shown. */
function only(name: string): ParsedNode {
  const result = parseSubscription(fixture(name));
  assert.equal(
    result.failures.length,
    0,
    `${name} did not parse: ${result.failures.map((entry) => `${entry.scheme ?? '?'}: ${entry.reason}`).join('; ')}`,
  );
  assert.equal(result.nodes.length, 1, `${name} produced ${result.nodes.length} nodes`);
  return result.nodes[0]!;
}

/**
 * The configuration of a node, narrowed to the one catalogue entry a link can produce.
 *
 * The narrowing is the assertion: `ParsedNode` pairs the protocol with its configuration as a union, so
 * reading a VLESS field off a node requires first establishing that it is one.
 */
function vlessOf(node: ParsedNode): VlessConfig {
  if (node.protocol !== 'vless') assert.fail(`expected a vless node, got ${node.protocol}`);
  return node.config;
}

/** The single failure a one-link body produces, or the nodes it wrongly produced. */
function refusal(line: string): { scheme: string | null; reason: string; excerpt: string } {
  const result = parseSubscription(line);
  assert.equal(result.nodes.length, 0, `${line} should not have produced a node`);
  assert.equal(result.failures.length, 1, `${line} produced ${result.failures.length} failures`);
  return result.failures[0]!;
}

/* ── the believed shapes, and the catalogue they land in ─────────────────────────────────── */

test('believed shape: a VLESS link over WebSocket and TLS becomes a catalogue configuration', () => {
  // Not a proxy-core outbound, which is what this produced before the catalogue and what nothing in
  // this product could store. The pair below is exactly the pair a stored tunnel is made of.
  const node = only('vless-ws-tls.txt');
  assert.equal(node.scheme, 'vless');
  assert.equal(node.protocol, 'vless');
  assert.equal(node.label, 'Example VLESS WS');
  assert.deepEqual(vlessOf(node), {
    server: 'vless.example.com',
    port: 443,
    id: '11111111-2222-3333-4444-555555555555',
    network: 'ws',
    security: 'tls',
    serverName: 'vless.example.com',
    fingerprint: 'chrome',
    path: '/websocket',
    host: 'vless.example.com',
  });
  // `encryption=none` is the absence of the feature spelled out, and the carrier decision reads exactly
  // this field: carrying it would make an ordinary account look like one the proxy core cannot run.
  assert.equal('encryption' in vlessOf(node), false);
});

test('believed shape: REALITY parameters land in the two fields the catalogue has for them', () => {
  const node = only('vless-reality.txt');
  assert.equal(vlessOf(node).security, 'reality');
  assert.equal(vlessOf(node).flow, 'xtls-rprx-vision');
  assert.equal(vlessOf(node).realityPublicKey, 'not-a-real-public-key');
  assert.equal(vlessOf(node).realityShortId, 'ab');
  // `type=tcp` is the absence of a transport, not a transport called tcp — but `network` is required
  // by the schema, so it is written rather than omitted.
  assert.equal(vlessOf(node).network, 'tcp');
});

test('a bare sni with no security means TLS, which is what every producer that emits it means', () => {
  const node = parseSubscription('vless://11111111-2222-3333-4444-555555555555@h.example.com:443?sni=h.example.com#Bare')
    .nodes[0]!;
  assert.equal(vlessOf(node).security, 'tls');
  // And with neither, nothing is invented.
  const plain = parseSubscription('vless://11111111-2222-3333-4444-555555555555@h.example.com:443#Plain').nodes[0]!;
  assert.equal(vlessOf(plain).security, 'none');
});

test('a link carrying post-quantum encryption keeps it, because it is what decides the carrier', () => {
  const node = parseSubscription(
    'vless://11111111-2222-3333-4444-555555555555@h.example.com:443?encryption=mlkem768x25519plus.native.0rtt.abc#PQ',
  ).nodes[0]!;
  assert.equal(vlessOf(node).encryption, 'mlkem768x25519plus.native.0rtt.abc');
});

/* ── a draft nothing can store is the defect this file was rewritten to remove ───────────── */

test('a parsed draft is checked against the catalogue entry that will have to store it', () => {
  // The bound is the schema's, not the parser's: `path` is capped at 256 characters. A link from a real
  // provider can exceed it, and without this check the draft would be refused two layers away, at the
  // profile write, with no line number and no excerpt to diagnose it by.
  const long = 'x'.repeat(300);
  const failure = refusal(
    `vless://11111111-2222-3333-4444-555555555555@h.example.com:443?type=ws&path=%2F${long}#TooLong`,
  );
  assert.match(failure.reason, /cannot store/);
  assert.match(failure.reason, /path/, 'the refusal must name the field, or it is true and unactionable');
});

test('every refused transport and security names the values that are accepted', () => {
  // A refusal that says only what was rejected is a riddle: the person is sent to documentation to
  // learn what would have worked.
  const transport = refusal('vless://11111111-2222-3333-4444-555555555555@h.example.com:443?type=xhttp#X');
  assert.match(transport.reason, /"xhttp"/);
  for (const accepted of ['tcp', 'ws', 'grpc', 'http', 'quic']) {
    assert.match(transport.reason, new RegExp(accepted), `the refusal must name ${accepted}`);
  }

  const security = refusal('vless://11111111-2222-3333-4444-555555555555@h.example.com:443?security=shadowtls#S');
  assert.match(security.reason, /"shadowtls"/);
  for (const accepted of ['none', 'tls', 'reality']) {
    assert.match(security.reason, new RegExp(accepted));
  }
});

test('h2 is http under an older spelling, which is a translation rather than a guess', () => {
  const node = parseSubscription(
    'vless://11111111-2222-3333-4444-555555555555@h.example.com:443?type=h2&path=%2Fp#H2',
  ).nodes[0]!;
  assert.equal(vlessOf(node).network, 'http');
});

test('a link asking for certificate checking to be turned off is refused, naming the parameter', () => {
  // Deliberate, and not an omission. A switch that stops checking the server is who it claims to be
  // removes the one guarantee separating a tunnel from a pipe to whoever answered; it gets added because
  // the owner asks for it knowing the price, not because a parameter turned up in somebody's link.
  // Dropping it silently is the other option and is worse: a configuration that looks complete and fails
  // certificate verification, for a reason the link stated and the product discarded.
  for (const parameter of ['allowInsecure', 'insecure']) {
    const failure = refusal(
      `vless://11111111-2222-3333-4444-555555555555@h.example.com:443?security=tls&${parameter}=1#Insecure`,
    );
    assert.match(failure.reason, new RegExp(parameter));
    assert.match(failure.reason, /turns off checking/);
  }
});

/* ── refusing by name, which is what makes a decision distinguishable from a gap ──────────── */

test('a link of a scheme this product does not run is refused BY NAME, not left unhandled', () => {
  // Their predicates survive and their bodies are gone, and that difference is the point. A scheme with
  // no predicate falls into "nothing here parses that", which reads as missing coverage — a gap somebody
  // might fill. These five are a product decision, and only a refusal naming the scheme says so.
  const cases: { fixture: string; scheme: string; name: string }[] = [
    { fixture: 'vmess-base64-json.txt', scheme: 'vmess', name: 'VMess' },
    { fixture: 'shadowsocks-sip002.txt', scheme: 'shadowsocks', name: 'Shadowsocks' },
    { fixture: 'shadowsocks-legacy.txt', scheme: 'shadowsocks', name: 'Shadowsocks' },
    { fixture: 'trojan-grpc.txt', scheme: 'trojan', name: 'Trojan' },
    { fixture: 'hysteria2-obfs.txt', scheme: 'hysteria2', name: 'Hysteria 2' },
    { fixture: 'tuic.txt', scheme: 'tuic', name: 'TUIC' },
  ];

  for (const entry of cases) {
    const failure = refusal(fixture(entry.fixture).trim());
    assert.equal(failure.scheme, entry.scheme, `${entry.fixture} must be reported as ${entry.scheme}`);
    assert.match(failure.reason, new RegExp(entry.name), `the refusal must name ${entry.name}`);
    // And in the same breath, what this product does run.
    for (const title of Object.values(TUNNEL_PROTOCOL_TITLES)) {
      assert.ok(failure.reason.includes(title), `the refusal must name ${title}: ${failure.reason}`);
    }
  }
});

test('hy2:// is refused under the same name as hysteria2://', () => {
  const failure = refusal('hy2://pw@hy2.example.com:8443#Short');
  assert.equal(failure.scheme, 'hysteria2');
});

test('a line nothing recognises is REPORTED with its scheme, its position and the catalogue', () => {
  // "Skipping unsupported format" is the failure mode this design exists to avoid: a node that vanishes
  // without a word is how somebody ends up with a routing policy pointing at nothing.
  const result = parseSubscription(fixture('body-with-one-bad-line.txt'));
  assert.equal(result.nodes.length, 1, 'the VLESS line must still parse');

  const socks = result.failures.find((entry) => entry.scheme === 'socks5');
  assert.ok(socks, 'the socks5 line must be reported');
  assert.equal(socks.line, 2, 'the position must be the line a person would count');
  assert.match(socks.reason, /nothing here parses a socks5 link/);
  assert.ok(socks.reason.includes('OpenVPN'), 'and it must say what is parsed');

  // The trojan line on line 3 is refused by name rather than as an unknown scheme.
  const trojan = result.failures.find((entry) => entry.scheme === 'trojan');
  assert.ok(trojan);
  assert.equal(trojan.line, 3);
});

/* ── our own behaviour, which holds whatever the formats turn out to be ──────────────────── */

test('a whole-body base64 wrapper is detected by trying to decode it, not by guessing', () => {
  // A base64 blob of links and a plain list of links are both printable ASCII, so no heuristic on the
  // characters present can separate them. Decoding and looking for a scheme is a direct test.
  const wrapped = parseSubscription(fixture('body-base64-vless.txt'));
  assert.equal(wrapped.wasBase64, true);
  assert.equal(wrapped.nodes.length, 3);
  assert.equal(wrapped.failures.length, 0);

  const plain = parseSubscription(fixture('vless-ws-tls.txt'));
  assert.equal(plain.wasBase64, false);
  assert.equal(plain.nodes.length, 1);
});

test('a base64 body of links this product refuses is still decoded, so each line is named', () => {
  // Detecting the wrapper and running the catalogue are different questions, and the first is the wider
  // one. A body that failed to decode would produce one message about a body rather than three about
  // lines, and the person would not learn which of their nodes are usable.
  const mixed = parseSubscription(fixture('body-base64.txt'));
  assert.equal(mixed.wasBase64, true);
  assert.equal(mixed.nodes.length, 1, 'the VLESS node is usable');
  assert.deepEqual(
    mixed.failures.map((entry) => entry.scheme),
    ['trojan', 'shadowsocks'],
  );
});

test('a credential never reaches an error message', () => {
  // A subscription link *is* a credential, and an error path is where nobody is looking for a leak — it
  // goes to a log, an API response and a screen.
  const secret = 'super-secret-password-do-not-log';
  const result = parseSubscription(`vless://${secret}@nowhere.example.com:0#Broken`);
  assert.equal(result.failures.length, 1);
  const serialised = JSON.stringify(result.failures[0]);
  assert.equal(serialised.includes(secret), false, `the credential reached the failure: ${serialised}`);
  assert.match(result.failures[0]!.excerpt, /<redacted>/);

  // And for the base64 forms there is no `@` to find, so the whole payload is reduced to its scheme.
  const opaque = safeExcerpt('vmess://eyJwcyI6InNlY3JldCJ9');
  assert.equal(opaque.includes('eyJwcyI'), false);
  assert.match(opaque, /^vmess:\/\/<redacted>$/);
});

test('a link with no usable port is refused rather than given an invented default', () => {
  // Inventing 443 would turn a broken link into a tunnel that fails for a reason nobody can see.
  const failure = refusal('vless://11111111-2222-3333-4444-555555555555@example.com#No port');
  assert.match(failure.reason, /port/);
});

test('a link missing its credential is refused, not turned into an anonymous tunnel', () => {
  const failure = refusal('vless://@example.com:443#No uuid');
  assert.match(failure.reason, /UUID/);
});

test('blank lines and comments are ignored without being reported as failures', () => {
  const result = parseSubscription(['# a provider comment', '', fixture('vless-reality.txt').trim(), '   '].join('\n'));
  assert.equal(result.nodes.length, 1);
  assert.equal(result.failures.length, 0, 'a blank line is not a failure');
});

test('base64 is accepted in either alphabet, padded or not', () => {
  // Providers use standard and URL-safe interchangeably and some omit the padding, so insisting on one
  // form would reject a body for a reason unrelated to its contents.
  assert.equal(tryBase64('aGVsbG8='), 'hello');
  assert.equal(tryBase64('aGVsbG8'), 'hello');
  assert.equal(tryBase64('YT9iL2M='), 'a?b/c');
  assert.equal(tryBase64('YT9iL2M'), 'a?b/c');
  // Not base64 at all: returns null so callers can use it as a test rather than a conversion.
  assert.equal(tryBase64('vless://x@y:1'), null);
  assert.equal(tryBase64(''), null);
});

test('a body that is neither a link list nor base64 is left for the line parser to explain', () => {
  // So the diagnosis names what is actually wrong, rather than this layer inventing a claim about
  // encoding for what may simply be a wrong paste.
  const { body, wasBase64 } = decodeSubscriptionBody('just some prose the user pasted by mistake');
  assert.equal(wasBase64, false);
  assert.equal(body, 'just some prose the user pasted by mistake');
  const result = parseSubscription(body);
  assert.equal(result.nodes.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]!.scheme, null);
  assert.match(result.failures[0]!.reason, /not a link/);
});

/* ── refresh, and the rule it exists for ─────────────────────────────────────────────────── */

test('a refresh identifies nodes by endpoint, so a provider renaming one is not a vanishing', () => {
  // Identity is server, port and protocol — deliberately not the label. A provider renames nodes freely,
  // and treating a rename as "one vanished and another appeared" would warn on every refresh. A warning
  // that is usually wrong teaches people to ignore warnings.
  const before = parseSubscription(fixture('body-base64-vless.txt')).nodes;
  // Asserted before the comparison, because `unchanged.length === before.length` is trivially true of two
  // empty lists: a harness fed nothing is green forever, and this test would then pass on the day the
  // parser stopped producing anything at all.
  assert.equal(before.length, 3, 'the fixture must produce nodes for this comparison to mean anything');
  const renamed = before.map((node) => ({ ...node, label: `${node.label ?? ''} (new name)` }));

  const diff = diffSubscription(before, renamed);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.vanished, []);
  assert.equal(diff.unchanged.length, before.length);
});

test('a node that disappears from a subscription is reported, so re-pointing policy stays a decision', () => {
  // The rule: a refresh must never silently change which endpoint the policy prefers. If a node the
  // priority order names disappears, the stored node is kept and the interface says the subscription no
  // longer offers it.
  const before = parseSubscription(fixture('body-base64-vless.txt')).nodes;
  assert.equal(before.length, 3, 'and here too: a slice of an empty list vanishes nothing');
  const after = before.slice(1);

  const diff = diffSubscription(before, after);
  assert.equal(diff.vanished.length, 1);
  assert.equal(diff.vanished[0], nodeIdentity(before[0]!));
  assert.deepEqual(diff.added, []);
});

test('node identity is the catalogue entry and the endpoint, so it survives a rename', () => {
  const node = only('vless-ws-tls.txt');
  assert.equal(nodeIdentity(node), 'vless://vless.example.com:443');
});

/* ── the two lists, and the boundary between them ────────────────────────────────────────── */

test('one parser, for the one catalogue entry that arrives as a link', () => {
  // OpenVPN and Cloak + OpenVPN are an `.ovpn` file plus entry points, never a subscription line, so
  // there is nothing for a parser of them to do.
  assert.deepEqual(BUILT_IN_PARSERS.map((parser) => parser.id), ['vless']);
  assert.deepEqual(BUILT_IN_PARSERS.map((parser) => parser.protocol), ['vless']);
});

test('every predicate claims exactly the schemes it names, and nothing claims another’s', () => {
  // A predicate that matched too widely would swallow another's links and report a confusing reason.
  const claimants = (line: string): string[] => [
    ...BUILT_IN_PARSERS.filter((parser) => parser.test(line)).map((parser) => parser.id),
    ...RECOGNISED_NOT_RUN.filter((entry) => entry.test(line)).map((entry) => entry.id),
  ];

  const cases: { line: string; expected: string }[] = [
    { line: 'vless://u@h:1', expected: 'vless' },
    { line: 'vmess://abcd', expected: 'vmess' },
    { line: 'ss://abcd', expected: 'shadowsocks' },
    { line: 'trojan://p@h:1', expected: 'trojan' },
    { line: 'hysteria2://p@h:1', expected: 'hysteria2' },
    { line: 'hy2://p@h:1', expected: 'hysteria2' },
    { line: 'tuic://u:p@h:1', expected: 'tuic' },
  ];
  for (const entry of cases) {
    const matching = claimants(entry.line);
    assert.deepEqual(matching, [entry.expected], `${entry.line} matched ${matching.join(', ')}`);
  }
  assert.deepEqual(claimants('socks5://h:1'), []);
});
