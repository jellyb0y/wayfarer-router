/**
 * A feed in the proxy core's JSON, read from a capture of the `za-stenoy.ru` feed (2026-11-07, credentials
 * replaced; see the fixtures README). What it must produce is what the core itself would run from the file.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeSingBoxFeed, nodeIdentity, parseSingBoxFeed } from '../src/index.ts';

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'subscriptions', 'sing-box-za-stenoy.json'),
  'utf8',
);

test('the captured feed is recognised as the core’s JSON, and a link body is not', () => {
  assert.equal(looksLikeSingBoxFeed(FIXTURE), true);
  assert.equal(looksLikeSingBoxFeed('dmxlc3M6Ly9hYmM='), false);
  assert.equal(looksLikeSingBoxFeed('{"not":"a config"}'), false);
});

test('every one of the twelve nodes is kept, and nothing is refused', () => {
  const feed = parseSingBoxFeed(FIXTURE);
  assert.deepEqual(feed.failures, []);
  // Twelve outbounds: per country two VISION, two HY and two HY-UDP. The urltest groups name them sixteen
  // times between them, which is where an earlier count of "16 nodes" came from (corrected in docs/04).
  assert.equal(feed.nodes.length, 12);
  assert.equal(feed.nodes.filter((node) => node.protocol === 'vless').length, 4);
  assert.equal(feed.nodes.filter((node) => node.protocol === 'hysteria2').length, 8);
  // No key of any node went unread: the catalogue holds everything this feed says about its nodes.
  assert.deepEqual(feed.nodes.filter((node) => node.ignoredParams !== undefined).map((node) => node.label), []);
});

test('two identical Hysteria 2 outbounds stay two nodes, because each is its own QUIC connection', () => {
  const feed = parseSingBoxFeed(FIXTURE);
  const hy = feed.nodes.find((node) => node.label === '🇵🇱 Польша · R1 · HY')!;
  const hyUdp = feed.nodes.find((node) => node.label === '🇵🇱 Польша · R1 · HY-UDP')!;
  const { password: _a, obfsPassword: _b, ...one } = hy.config as Record<string, unknown>;
  const { password: _c, obfsPassword: _d, ...two } = hyUdp.config as Record<string, unknown>;
  assert.deepEqual(one, two, 'the capture has them identical apart from the invented credentials');
  assert.notEqual(nodeIdentity(hy), nodeIdentity(hyUdp));
  assert.equal(new Set(feed.nodes.map(nodeIdentity)).size, 12);
});

test('a VISION node becomes the VLESS configuration the core would be handed', () => {
  const node = parseSingBoxFeed(FIXTURE).nodes.find((entry) => entry.label === '🇩🇪 Германия · R2 · VISION')!;
  assert.equal(node.protocol, 'vless');
  const { id: _id, realityPublicKey: _pk, realityShortId: _sid, ...rest } = node.config as Record<string, unknown>;
  assert.deepEqual(rest, {
    server: '213.171.25.107',
    port: 443,
    network: 'tcp',
    security: 'reality',
    flow: 'xtls-rprx-vision',
    serverName: 'ozon.ru',
    fingerprint: 'chrome',
  });
});

test('a Hysteria 2 node keeps its port range, obfuscation and the insecure the feed states', () => {
  const node = parseSingBoxFeed(FIXTURE).nodes.find((entry) => entry.label === '🇩🇪 Германия · R1 · HY')!;
  const { password: _p, obfsPassword, ...rest } = node.config as Record<string, unknown>;
  assert.equal(typeof obfsPassword, 'string');
  assert.deepEqual(rest, {
    server: '95.174.94.144',
    port: 8525,
    serverPorts: ['11640:11659'],
    serverName: 'za-stenoy.ru',
    alpn: ['h3'],
    insecure: true,
  });
});

test('the selectors and urltest groups are kept in order, with their own parameters', () => {
  const feed = parseSingBoxFeed(FIXTURE);
  assert.equal(feed.final, '🚀 VPN');
  assert.deepEqual(
    feed.selectors.map((selector) => [selector.tag, selector.kind]),
    [
      ['🚀 VPN', 'selector'],
      ['🎮 Rapid UDP', 'selector'],
      ['🇵🇱 Польша · Rapid UDP', 'urltest'],
      ['🇩🇪 Германия · Rapid UDP', 'urltest'],
      ['🇵🇱 Польша · Rapid Авто', 'urltest'],
      ['🇩🇪 Германия · Rapid Авто', 'urltest'],
    ],
  );
  const udp = feed.selectors.find((selector) => selector.tag === '🇵🇱 Польша · Rapid UDP')!;
  assert.deepEqual(udp, {
    tag: '🇵🇱 Польша · Rapid UDP',
    kind: 'urltest',
    options: ['🇵🇱 Польша · R2 · HY-UDP', '🇵🇱 Польша · R1 · HY-UDP', '🇵🇱 Польша · R2 · VISION', '🇵🇱 Польша · R1 · VISION'],
    url: 'https://www.gstatic.com/generate_204',
    interval: '15s',
    tolerance: 1000,
    interruptExisting: false,
  });
});

test('the rules this product carries are kept in place; sniffing and DNS hijacking are the device’s own', () => {
  const feed = parseSingBoxFeed(FIXTURE);
  assert.deepEqual(feed.rules, [
    { action: 'route', privateDestination: true, to: 'direct' },
    { action: 'reject', network: 'udp', port: [443] },
    { action: 'route', network: 'udp', to: '🎮 Rapid UDP' },
  ]);
  assert.deepEqual(feed.dropped.sort(), [
    'dns',
    'experimental',
    'inbounds',
    'log',
    'route.auto_detect_interface',
    'route.default_domain_resolver',
    'route.rules[0] (sniff, which this device does for every connection)',
    'route.rules[1] (DNS hijacking, which this device does itself)',
  ]);
});

test('an outbound the catalogue cannot hold is refused by position, and its selector loses only that option', () => {
  const document = JSON.parse(FIXTURE) as { outbounds: Record<string, unknown>[] };
  const index = document.outbounds.findIndex((entry) => entry['tag'] === '🇵🇱 Польша · R1 · VISION');
  document.outbounds[index] = { type: 'vmess', tag: '🇵🇱 Польша · R1 · VISION', server: 'x', server_port: 1 };
  const feed = parseSingBoxFeed(JSON.stringify(document));
  assert.equal(feed.nodes.length, 11);
  assert.ok(feed.failures.some((failure) => failure.at === `/outbounds/${String(index)}` && /vmess/.test(failure.reason)));
  const auto = feed.selectors.find((selector) => selector.tag === '🇵🇱 Польша · Rapid Авто')!;
  assert.deepEqual(auto.options, ['🇵🇱 Польша · R2 · VISION', '🇵🇱 Польша · R1 · HY', '🇵🇱 Польша · R2 · HY']);
});

test('a rule matching something this product does not carry is refused, not widened', () => {
  const document = JSON.parse(FIXTURE) as { route: { rules: Record<string, unknown>[] } };
  document.route.rules.push({ domain_suffix: ['example.com'], outbound: 'direct' });
  const feed = parseSingBoxFeed(JSON.stringify(document));
  assert.equal(feed.rules.length, 3);
  assert.ok(feed.failures.some((failure) => /domain_suffix/.test(failure.reason)));
});

test('a feed whose route.final is not a selector has no group to make, and says so', () => {
  const document = JSON.parse(FIXTURE) as { route: Record<string, unknown> };
  document.route['final'] = 'direct';
  assert.throws(() => parseSingBoxFeed(JSON.stringify(document)), /route\.final/);
});
