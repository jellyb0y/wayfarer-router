/**
 * `onUnavailable: fall-through`, built for real (plan row G31, 2026-09-24).
 *
 * Until then the option had no route around the tunnel: its rule pointed straight at the tunnel's own
 * outbound, so a dead fall-through tunnel failed exactly like a `block` one, and the interface's "Traffic
 * goes out the ordinary way instead" was false. These tests hold the three halves of the fix:
 *
 * 1. **the configuration** — a selector per fall-through tunnel whose only other member is the ordinary
 *    route, a resolver selector whose other member re-asks the ordinary resolver, and nothing new for a
 *    `block` tunnel;
 * 2. **the guard** — out only on consecutive dead readings, back only on consecutive alive ones, never on
 *    a reading that could not be taken, and re-derived from the tunnel after a restart rather than
 *    trusted from the core's cache;
 * 3. **the reading** — how long the traffic has been leaving outside the tunnel, on a monotonic clock.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  CORE_TAGS,
  emptyProfile,
  FALL_THROUGH_DNS,
  FALL_THROUGH_ORDINARY,
  fallThroughDnsSelectorTag,
  fallThroughSelectorTag,
  guardSelectorTag,
  type ProfileDocument,
} from '@wayfarer/schemas';
import { generateCoreConfig, tunnelDnsTag } from '../src/core/generate/core-config.ts';
import {
  createWatchdog,
  FALL_THROUGH_ALIVE_ROUNDS,
  FALL_THROUGH_DEAD_ROUNDS,
  guardedTunnels,
  observeWatchdog,
  type GuardedTunnel,
  type GuardOutcome,
} from '../src/core/watchdog.ts';
import { createObserverRegistry } from '../src/core/observers.ts';
import type { Liveness } from '../src/core/liveness.ts';
import type { CoreApi } from '../src/platform/core-api.ts';

/* ── 1. the configuration ────────────────────────────────────────────────────────────────── */

/**
 * The bench board's shape with `corp` switched to fall-through, which is what the acceptance run does:
 * `corp` (resolver `10.122.0.1`, names `corp.internal`), `partner` on block with no resolver of
 * its own, and `spare`, a fall-through tunnel with no resolver.
 */
function profile(): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' }) as unknown as ProfileDocument;
  return {
    ...base,
    policy: { ...base.policy, onAllDown: 'direct' },
    tunnels: [
      {
        id: 'corp',
        name: 'Corp',
        role: 'resource',
        enabled: true,
        onUnavailable: 'fall-through',
        protocol: 'openvpn',
        config: { profile: 'client\n', interfaceSuffix: 'crp' },
        resources: { domainSuffix: ['corp.internal'], ipCidr: ['10.148.0.0/16', '10.122.0.0/24'] },
      },
      {
        id: 'partner',
        name: 'Partner',
        role: 'resource',
        enabled: true,
        onUnavailable: 'block',
        protocol: 'openvpn',
        config: { profile: 'client\n', interfaceSuffix: 'prt' },
        resources: { domainSuffix: ['partner.example'], ipCidr: ['172.30.0.212/32'] },
      },
      {
        id: 'spare',
        name: 'Spare',
        role: 'resource',
        enabled: true,
        onUnavailable: 'fall-through',
        protocol: 'proxy',
        config: { type: 'socks', server: '198.51.100.20', port: 1080 },
        resources: { domainSuffix: ['spare.example'] },
      },
    ],
    routing: { ...base.routing, rules: [{ kind: 'protect-own-networks' }, { kind: 'tunnel-resources' }] },
  } as unknown as ProfileDocument;
}

type Config = {
  inbounds: Record<string, unknown>[];
  outbounds: { type: string; tag: string; outbounds?: string[]; default?: string; [key: string]: unknown }[];
  dns: { servers: { tag: string; detour?: string; server?: string }[]; rules: Record<string, unknown>[]; final: string };
  route: { rules: Record<string, unknown>[]; final: string };
};

function generate(document: ProfileDocument, dns: [string, string, string[]][] = [['corp', '10.122.0.1', ['corp.internal']]]): Config {
  return generateCoreConfig({
    profile: document,
    interfaces: { accessPoint: 'wlan0', uplinks: new Map([['uplink', 'wfwan0']]) },
    emitted: new Map(
      document.tunnels.map((tunnel) => [tunnel.id, { target: 'outbounds' as const, object: { type: 'direct', bind_interface: `wf-${tunnel.id}` } }]),
    ),
    tunnelDns: new Map(dns.map(([id, address, suffixes]) => [id, { address, viaInterface: id, domainSuffix: suffixes }])),
    uplinkNetworks: ['192.168.77.0/24'],
  }) as unknown as Config;
}

const outbound = (config: Config, tag: string) => config.outbounds.find((entry) => entry.tag === tag);

test('a fall-through tunnel gets a selector of the tunnel and the ordinary route, the tunnel first and the default', () => {
  const config = generate(profile());
  const selector = outbound(config, fallThroughSelectorTag('corp'));
  assert.ok(selector, 'no fall-through selector');
  assert.equal(selector.type, 'selector');
  assert.deepEqual(selector.outbounds, ['corp', FALL_THROUGH_ORDINARY]);
  assert.equal(selector.default, 'corp');
  assert.equal(selector['interrupt_exist_connections'], true);
  // The ordinary member is exactly where unmatched traffic goes.
  assert.equal(FALL_THROUGH_ORDINARY, config.route.final);
  assert.equal(config.route.final, CORE_TAGS.selector);
  // And its rule points at the selector, never straight at the tunnel.
  const rule = config.route.rules.find((entry) => (entry['domain_suffix'] as string[] | undefined)?.includes('corp.internal'));
  assert.equal(rule?.['outbound'], fallThroughSelectorTag('corp'));
  assert.ok(!config.route.rules.some((entry) => entry['outbound'] === 'corp'), 'a rule still names the tunnel directly');
});

test('a block tunnel is unchanged: its guard is the tunnel and block, and it gets nothing that could leak', () => {
  const config = generate(profile());
  assert.deepEqual(outbound(config, guardSelectorTag('partner'))?.outbounds, ['partner', 'block']);
  assert.equal(outbound(config, fallThroughSelectorTag('partner')), undefined);
  assert.equal(outbound(config, fallThroughDnsSelectorTag('partner')), undefined);
  // No fall-through tunnel has block as a member, and no guard has the ordinary route.
  for (const entry of config.outbounds) {
    if (entry.type === 'selector' && entry.tag.startsWith('wf-fall-')) assert.ok(!entry.outbounds!.includes('block'), entry.tag);
    if (entry.tag.startsWith('wf-guard-')) assert.ok(!entry.outbounds!.includes(FALL_THROUGH_ORDINARY), entry.tag);
  }
});

test('a profile with no fall-through tunnel generates exactly what it did before G31', () => {
  const document = profile();
  const blockOnly = { ...document, tunnels: document.tunnels.map((tunnel) => ({ ...tunnel, onUnavailable: 'block' as const })) } as ProfileDocument;
  const config = generate(blockOnly);
  assert.ok(!config.outbounds.some((entry) => entry.tag.startsWith('wf-fall')));
  assert.equal(config.inbounds.length, 1, 'the resolver loop inbound exists only for a fall-through tunnel with a resolver');
  assert.equal(config.dns.servers.find((server) => server.tag === tunnelDnsTag('corp'))?.detour, 'corp');
  assert.ok(!config.route.rules.some((rule) => JSON.stringify(rule).includes(FALL_THROUGH_DNS.inbound)));
  assert.ok(!config.dns.rules.some((rule) => JSON.stringify(rule).includes(FALL_THROUGH_DNS.inbound)));
});

test('DNS: a fall-through tunnel’s own resolver is reached through a selector whose other member re-asks the ordinary resolver', () => {
  const config = generate(profile());
  // The server keeps its address; only its path is switchable.
  const server = config.dns.servers.find((entry) => entry.tag === tunnelDnsTag('corp'))!;
  assert.equal(server.server, '10.122.0.1');
  assert.equal(server.detour, fallThroughDnsSelectorTag('corp'));
  const selector = outbound(config, fallThroughDnsSelectorTag('corp'))!;
  assert.deepEqual(selector.outbounds, ['corp', FALL_THROUGH_DNS.outbound]);
  assert.equal(selector.default, 'corp');

  // The loop: a SOCKS outbound to a loopback SOCKS inbound ...
  const socksOut = outbound(config, FALL_THROUGH_DNS.outbound)!;
  assert.equal(socksOut.type, 'socks');
  assert.equal(socksOut['server'], '127.0.0.1');
  assert.equal(socksOut['server_port'], FALL_THROUGH_DNS.port);
  const socksIn = config.inbounds.find((entry) => entry['tag'] === FALL_THROUGH_DNS.inbound)!;
  assert.equal(socksIn['type'], 'socks');
  assert.equal(socksIn['listen'], '127.0.0.1', 'the loop must never listen beyond loopback');
  assert.equal(socksIn['listen_port'], FALL_THROUGH_DNS.port);
  // ... whose arrivals are answered as DNS before any other rule, and so can never be proxied on ...
  assert.deepEqual(config.route.rules[0], { inbound: [FALL_THROUGH_DNS.inbound], action: 'hijack-dns' });
  // ... by the resolver unmatched names use, before the tunnel's own suffix rule sends it round again.
  assert.deepEqual(config.dns.rules[0], { inbound: [FALL_THROUGH_DNS.inbound], server: CORE_TAGS.dnsTunnel });
  assert.equal(config.dns.final, CORE_TAGS.dnsTunnel);
  const suffixRule = config.dns.rules.findIndex((rule) => (rule['domain_suffix'] as string[] | undefined)?.includes('corp.internal'));
  assert.ok(suffixRule > 0);
  // A fall-through tunnel with no resolver of its own already resolves the ordinary way: nothing for it.
  assert.equal(outbound(config, fallThroughDnsSelectorTag('spare')), undefined);
  assert.equal(config.inbounds.filter((entry) => entry['tag'] === FALL_THROUGH_DNS.inbound).length, 1);
});

test('the watchdog is told the selectors the generator made, by the same names', () => {
  const document = profile();
  const config = generate(document);
  const guards = guardedTunnels(document, { interfaces: new Map() });
  for (const guard of guards) {
    assert.ok(outbound(config, guard.selector!), `${guard.tunnelId}: ${String(guard.selector)} is not in the configuration`);
  }
  assert.equal(guards.find((guard) => guard.tunnelId === 'corp')?.dnsSelector, fallThroughDnsSelectorTag('corp'));
  assert.equal(guards.find((guard) => guard.tunnelId === 'partner')?.dnsSelector, null);
});

/* ── 2. the guard ────────────────────────────────────────────────────────────────────────── */

const DEAD: Liveness = { state: 'dead', basis: 'keepalive', why: 'nothing has arrived from the peer for at least 30 s' };
const ALIVE: Liveness = { state: 'alive', basis: 'keepalive', why: 'the peer’s packets were last seen arriving 4 s ago' };
const UNMEASURABLE: Liveness = { state: 'unmeasurable', basis: 'none', why: 'the client’s own counters could not be read' };

/**
 * A watchdog over one fall-through tunnel with a resolver, a scripted liveness per round, and a core whose
 * selectors answer and move like the real one's (read back each round). `selectors` survives across a
 * "daemon restart" — a new watchdog over the same core — the way the core's cache file keeps a choice.
 */
function harness(options: { selectors?: Map<string, string>; withDns?: boolean; core?: boolean } = {}) {
  const selectors =
    options.selectors ??
    new Map<string, string>([
      [fallThroughSelectorTag('corp'), 'corp'],
      ...(options.withDns === false ? [] : [[fallThroughDnsSelectorTag('corp'), 'corp'] as [string, string]]),
      [guardSelectorTag('partner'), 'partner'],
    ]);
  const puts: { selector: string; member: string }[] = [];
  const core: CoreApi = {
    available: async () => true,
    delay: async () => null,
    proxies: async () =>
      options.core === false
        ? []
        : [...selectors].map(([name, now]) => ({ name, type: 'Selector', now, all: null })),
    select: async (selector, member) => {
      puts.push({ selector, member });
      selectors.set(selector, member);
      return { ok: true, message: '' };
    },
  };
  const script: Liveness[] = [];
  let clock = 5_000_000;
  const events: { kind: string; summary: string }[] = [];
  const guards: GuardedTunnel[] = [
    {
      tunnelId: 'corp',
      onUnavailable: 'fall-through',
      selector: fallThroughSelectorTag('corp'),
      dnsSelector: fallThroughDnsSelectorTag('corp'),
      method: { kind: 'peer-keepalive', interfaceName: 'wfvpncrp' },
      failsClosed: 'its outbound is bound to wfvpncrp',
    },
    {
      tunnelId: 'partner',
      onUnavailable: 'block',
      selector: guardSelectorTag('partner'),
      dnsSelector: null,
      method: { kind: 'peer-keepalive', interfaceName: 'wfvpnprt' },
      failsClosed: 'its outbound is bound to wfvpnprt',
    },
  ];
  const observers = createObserverRegistry({ monotonicMs: () => clock });
  const observer = observers.register({ name: 'tunnel-watchdog', watches: 'tunnels', everyMs: 30_000 });
  observer.armed();
  const observation = observeWatchdog(observer, () => clock);
  const probes = (emptyProfile({ name: 'x' }) as unknown as ProfileDocument).policy.probes;
  const make = () =>
    createWatchdog({
      core,
      selector: CORE_TAGS.selector,
      candidates: async () => [],
      guards: async () => guards,
      policy: () => ({ priority: [], excluded: [], sticky: true, onAllDown: 'direct', probes }),
      record: (event) => events.push({ kind: event.kind, summary: event.summary }),
      log: () => undefined,
      now: () => clock,
      liveness: {
        measureRound: async (subjects) => {
          const reading = script.shift() ?? UNMEASURABLE;
          return new Map(subjects.map((subject) => [subject.tunnelId, subject.tunnelId === 'corp' ? reading : ALIVE]));
        },
      },
    });
  let watchdog = make();
  /** One round, thirty seconds after the last, with `corp` reading `liveness`. */
  const round = async (liveness: Liveness): Promise<GuardOutcome> => {
    clock += 30_000;
    script.push(liveness);
    observation.onRoundStart();
    const outcome = await watchdog.runOnce();
    observation.onRound(outcome);
    return outcome.guards!.find((guard) => guard.tunnelId === 'corp')!;
  };
  const restart = () => {
    watchdog = make();
  };
  const report = () => observers.report().find((entry) => entry.name === 'tunnel-watchdog')!;
  const traffic = () => selectors.get(fallThroughSelectorTag('corp'));
  const names = () => selectors.get(fallThroughDnsSelectorTag('corp'));
  return {
    round,
    restart,
    report,
    traffic,
    names,
    puts,
    events,
    selectors,
    tick: (ms: number) => (clock += ms),
    roundStart: () => observation.onRoundStart(),
  };
}

test(`the hysteresis is ${String(FALL_THROUGH_DEAD_ROUNDS)} dead rounds out and ${String(FALL_THROUGH_ALIVE_ROUNDS)} alive rounds back`, () => {
  assert.equal(FALL_THROUGH_DEAD_ROUNDS, 2);
  assert.equal(FALL_THROUGH_ALIVE_ROUNDS, 3);
});

test('dead for two consecutive rounds: traffic and names move to the ordinary side together, and it is said', async () => {
  const bench = harness();
  const first = await bench.round(DEAD);
  assert.equal(first.changed, false);
  assert.equal(bench.traffic(), 'corp');
  assert.equal(first.fallingThrough, null);

  const second = await bench.round(DEAD);
  assert.equal(second.changed, true);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
  assert.equal(bench.names(), FALL_THROUGH_DNS.outbound);
  assert.deepEqual(second.fallingThrough, { forSeconds: 0 });
  assert.match(second.action, /leaves OUTSIDE the tunnel/);
  assert.ok(bench.events.some((event) => event.kind === 'guard.fell-through'));
  // The block tunnel beside it was never touched.
  assert.ok(!bench.puts.some((entry) => entry.selector === guardSelectorTag('partner')));

  const third = await bench.round(DEAD);
  assert.equal(third.changed, false, 'staying fallen through writes nothing');
  assert.deepEqual(third.fallingThrough, { forSeconds: 30 });
  assert.equal(bench.puts.length, 2);
});

test('a reading that flaps never moves anything: dead, alive, dead, not measurable, dead … for twenty rounds', async () => {
  const bench = harness();
  const pattern = [DEAD, ALIVE, DEAD, UNMEASURABLE];
  for (let n = 0; n < 20; n += 1) {
    const outcome = await bench.round(pattern[n % pattern.length]!);
    assert.equal(outcome.changed, false, `round ${String(n)}`);
  }
  assert.deepEqual(bench.puts, []);
  assert.equal(bench.traffic(), 'corp');
});

test('not measurable never moves it, for thirty rounds, and is never counted as one of the dead rounds', async () => {
  const bench = harness();
  for (let n = 0; n < 30; n += 1) await bench.round(UNMEASURABLE);
  assert.deepEqual(bench.puts, []);
  // Dead, not measurable, dead: two dead readings, not two consecutive ones.
  await bench.round(DEAD);
  await bench.round(UNMEASURABLE);
  const outcome = await bench.round(DEAD);
  assert.equal(outcome.changed, false);
  assert.equal(bench.traffic(), 'corp');
});

test('recovery: back only after three consecutive alive rounds; a dead or unmeasurable round starts the count again', async () => {
  const bench = harness();
  await bench.round(DEAD);
  await bench.round(DEAD);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);

  for (const reading of [ALIVE, ALIVE, DEAD, ALIVE, ALIVE, UNMEASURABLE, ALIVE, ALIVE]) {
    const outcome = await bench.round(reading);
    assert.equal(outcome.changed, false);
    assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
    assert.ok(outcome.fallingThrough !== null);
  }
  const back = await bench.round(ALIVE);
  assert.equal(back.changed, true);
  assert.equal(bench.traffic(), 'corp');
  assert.equal(bench.names(), 'corp', 'the names go back into the tunnel with the traffic');
  assert.equal(back.fallingThrough, null);
  assert.ok(bench.events.some((event) => event.kind === 'guard.fall-through-ended' && /back in the tunnel after 270 s/.test(event.summary)));
});

test('restart: a position found on the ordinary route while the tunnel reads alive is put back on the tunnel at once', async () => {
  const bench = harness();
  await bench.round(DEAD);
  await bench.round(DEAD);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
  bench.restart(); // the core's cache keeps the choice; this process remembers nothing
  const outcome = await bench.round(ALIVE);
  assert.equal(outcome.changed, true, 'traffic must not stay outside a tunnel that is alive');
  assert.equal(bench.traffic(), 'corp');
  assert.equal(bench.names(), 'corp');
  assert.ok(bench.events.some((event) => event.kind === 'guard.fall-through-ended' && /no dead reading from this watchdog/.test(event.summary)));
});

/*
 * The G31 acceptance failure, as it happened on the board on 2026-09-24: `corp` fallen through and
 * dead, `systemctl restart wayfarer`, and the fresh process's first rounds read not measurable (it has no
 * earlier counter sample). The first build put both selectors back on `corp` within 5 s, and they
 * stayed there ~60 s — a dead tunnel swallowing its traffic — until two dead rounds sent them out again.
 */
test('restart while fallen through: not measurable moves nothing, and the dead reading after it keeps it out', async () => {
  const bench = harness();
  await bench.round(DEAD);
  await bench.round(DEAD);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
  const before = bench.puts.length;

  bench.restart();
  for (let n = 0; n < 3; n += 1) {
    const outcome = await bench.round(UNMEASURABLE);
    assert.equal(outcome.changed, false, `not-measurable round ${String(n)} after the restart moved a selector`);
    assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
    assert.equal(bench.names(), FALL_THROUGH_DNS.outbound);
    assert.ok(outcome.fallingThrough !== null, 'it is still falling through and must say so');
  }
  const dead = await bench.round(DEAD);
  assert.equal(dead.changed, false);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
  assert.equal(bench.names(), FALL_THROUGH_DNS.outbound);
  assert.equal(bench.puts.length, before, 'no selector was written across the restart');
  // The "since" counts from when this process first saw it: four rounds ago, not reset by the dead one.
  assert.deepEqual(dead.fallingThrough, { forSeconds: 90 });

  // Confirmed by that dead reading, it is an ordinary fall-through now: back only after the full count.
  await bench.round(ALIVE);
  await bench.round(ALIVE);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
  await bench.round(ALIVE);
  assert.equal(bench.traffic(), 'corp');
  assert.equal(bench.names(), 'corp');
});

test('restart while fallen through: not measurable, then alive — the unconfirmed position goes back at the first alive reading', async () => {
  const bench = harness({
    selectors: new Map([
      [fallThroughSelectorTag('corp'), FALL_THROUGH_ORDINARY],
      [fallThroughDnsSelectorTag('corp'), FALL_THROUGH_DNS.outbound],
    ]),
  });
  assert.equal((await bench.round(UNMEASURABLE)).changed, false);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
  const back = await bench.round(ALIVE);
  assert.equal(back.changed, true);
  assert.equal(bench.traffic(), 'corp');
  assert.equal(bench.names(), 'corp');
});

test('restart: a position found on the ordinary route while the tunnel reads dead is kept, and needs three alive rounds to end', async () => {
  const bench = harness({
    selectors: new Map([
      [fallThroughSelectorTag('corp'), FALL_THROUGH_ORDINARY],
      [fallThroughDnsSelectorTag('corp'), 'corp'], // the two disagree: the names must follow the traffic
    ]),
  });
  const adopted = await bench.round(DEAD);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
  assert.equal(bench.names(), FALL_THROUGH_DNS.outbound);
  assert.deepEqual(adopted.fallingThrough, { forSeconds: 0 });
  assert.ok(bench.events.some((event) => event.kind === 'guard.fell-through' && /found leaving outside the tunnel/.test(event.summary)));
  await bench.round(ALIVE);
  await bench.round(ALIVE);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
  await bench.round(ALIVE);
  assert.equal(bench.traffic(), 'corp');
});

test('a core restart that forgot the choice is re-derived: still dead, it falls through again at once', async () => {
  const bench = harness();
  await bench.round(DEAD);
  await bench.round(DEAD);
  bench.selectors.set(fallThroughSelectorTag('corp'), 'corp'); // back to its default
  bench.selectors.set(fallThroughDnsSelectorTag('corp'), 'corp');
  const outcome = await bench.round(DEAD);
  assert.equal(outcome.changed, true);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
  assert.equal(bench.names(), FALL_THROUGH_DNS.outbound);
});

test('a tunnel with no resolver of its own moves only its traffic selector', async () => {
  const bench = harness({ withDns: false });
  await bench.round(DEAD);
  await bench.round(DEAD);
  assert.equal(bench.traffic(), FALL_THROUGH_ORDINARY);
  assert.deepEqual(bench.puts.map((entry) => entry.selector), [fallThroughSelectorTag('corp')]);
});

test('a core that has no fall-through selector yet (profile not applied) is told so, and nothing is written', async () => {
  const bench = harness({ core: false });
  for (let n = 0; n < 4; n += 1) {
    const outcome = await bench.round(DEAD);
    assert.match(outcome.action, /has no wf-fall-corp/);
  }
  assert.deepEqual(bench.puts, []);
});

/* ── 3. the reading ──────────────────────────────────────────────────────────────────────── */

test('the reading: FALLING THROUGH, red, and for how long on the monotonic clock — advanced when shown again at a round start', async () => {
  const bench = harness();
  await bench.round(DEAD);
  await bench.round(DEAD);
  await bench.round(DEAD);
  const item = bench.report().lastLooked!.items!.find((entry) => entry.subject === 'corp')!;
  assert.equal(item.state, 'FALLING THROUGH');
  assert.equal(item.tone, 'bad');
  assert.equal(item.fallingThroughSeconds, 30);
  assert.match(bench.report().problem ?? '', /corp \(30 s\) is leaving OUTSIDE the VPN/);

  // The next round starts ten seconds later; the look it records shows the same items, ten seconds older.
  bench.tick(10_000);
  bench.roundStart();
  assert.equal(bench.report().lastLooked!.items!.find((entry) => entry.subject === 'corp')!.fallingThroughSeconds, 40);
  // Back in the tunnel: no duration, and not red for it.
  for (let n = 0; n < FALL_THROUGH_ALIVE_ROUNDS; n += 1) await bench.round(ALIVE);
  const after = bench.report().lastLooked!.items!.find((entry) => entry.subject === 'corp')!;
  assert.equal(after.fallingThroughSeconds, undefined);
  assert.equal(after.tone, 'ok');
});
