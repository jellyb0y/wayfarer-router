/**
 * The guard asks the tunnel whether it is alive, and knows nothing about what the tunnel carries (G30).
 *
 * Measured on the bench board, 2026-09-24: `partner` (OpenVPN, `onUnavailable: block`) carried
 * `probe: { endpoints: ["http://172.30.0.212/"] }` — one of its own resources. That server stopped
 * answering on port 80, the guard read the tunnel dead and blocked everything it carried, while its
 * pushed gateway `10.136.0.1` answered over `wfvpnprt` in 95 ms with no loss.
 *
 * Everything below is built through the functions `index.ts` calls: the real planner and catalogue record
 * each tunnel's interface, the real store keeps it, `deviceGuards` builds the guards, `createLivenessMeter`
 * over `deviceLivenessReaders` measures them with the real file readers and the real core client
 * (`createCoreApi`), and the real watchdog and observer decide and report. The stand-ins are the core's
 * HTTP transport — answering with bodies captured from sing-box 1.14.1 — and `ping`. The files the readers
 * read are the captured OpenVPN 2.6.14 status files, and the up-script is the shipped one.
 *
 * **`relay` is VLESS on `block` and carries the session this work was done over.** Its tests fail every
 * measurement there is, for many rounds, and assert its selector is never touched.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { emptyProfile, fallThroughSelectorTag, guardSelectorTag, type ProfileDocument } from '@wayfarer/schemas';
import { plan } from '../src/core/planner.ts';
import { emitTunnels } from '../src/core/emit.ts';
import { createWatchdog, deviceGuards, observeWatchdog, type GuardOutcome } from '../src/core/watchdog.ts';
import { createLivenessMeter, KEEPALIVE_SILENCE_SECONDS, NEUTRAL_CHECKS } from '../src/core/liveness.ts';
import { createObserverRegistry } from '../src/core/observers.ts';
import { createCoreApi, parseConnections } from '../src/platform/core-api.ts';
import { deviceLivenessReaders, parseOpenVpnStatus, parsePushedKeepalive } from '../src/platform/tunnel-readings.ts';
import { parseJournalJsonLines } from '../src/platform/parse/journal.ts';
import type { JournalReader } from '../src/platform/journal-reader.ts';
import { openVpnUnit } from '../src/core/catalogue/openvpn.ts';
import { pingOutcome, type PingOutcome } from '../src/platform/net.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore } from '../src/state/store.ts';
import { builtInAndDongle, cleanFacts } from './helpers/synthetic-inventory.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');
const fixture = (path: string): Promise<string> => readFile(join(FIXTURES, path), 'utf8');

/* ── captured core answers ───────────────────────────────────────────────────────────────── */

/** `{body}\n\nHTTP nnn` as the capture wrote it, into a status and a body. */
function response(text: string): { status: number; text: string } {
  const status = /HTTP (\d{3})/.exec(text);
  const body = /^\{.*\}$/m.exec(text);
  assert.ok(status && body, `not a captured response: ${text}`);
  return { status: Number(status[1]), text: `${body[0]}\n` };
}

/** One section of `delay-https.txt`, by outbound and URL. */
async function capturedDelay(outbound: string, url: string): Promise<{ status: number; text: string }> {
  const all = await fixture('core-api/delay-https.txt');
  const section = all.split('=== ').find((part) => part.startsWith(`outbound=${outbound} url=${url} `));
  assert.ok(section, `no capture for ${outbound} ${url}`);
  return response(section);
}

/* ── the bench ───────────────────────────────────────────────────────────────────────────── */

/**
 * The board's four tunnels, in the shape the store holds them after migration: `partner` with its own
 * resources (172.30.0.212 among them), two Cloak + OpenVPN tunnels, and `relay`. Plus one fall-through
 * proxy, which the board does not have, for the one path the board cannot show.
 */
function benchProfile(): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' }) as unknown as ProfileDocument;
  const cloak = (suffix: string) => ({
    profile: 'client\ndev tun\nremote 127.0.0.1 1194\n',
    interfaceSuffix: suffix,
    entryPoints: [
      {
        id: 'front',
        host: '198.51.100.170',
        port: 443,
        uid: 'a-placeholder-identifier',
        publicKey: 'a-placeholder-public-key',
        proxyMethod: 'openvpn',
        encryptionMethod: 'aes-gcm',
        serverName: 'www.example.com',
        browserSignature: 'chrome',
        transport: 'direct',
      },
    ],
  });
  return {
    ...base,
    tunnels: [
      {
        id: 'partner',
        name: 'Partner',
        role: 'resource',
        onUnavailable: 'block',
        enabled: true,
        protocol: 'openvpn',
        config: { profile: 'client\ndev tun\nremote vpn.example.invalid 1194\n', interfaceSuffix: 'prt' },
        resources: { ipCidr: ['172.30.0.212/32'], domainSuffix: ['partner.invalid'] },
      },
      { id: 'corp', name: 'Corp', role: 'resource', onUnavailable: 'block', enabled: true, protocol: 'cloak-openvpn', config: cloak('crp') },
      { id: 'hq', name: 'HQ', role: 'resource', onUnavailable: 'block', enabled: true, protocol: 'cloak-openvpn', config: cloak('hq') },
      {
        id: 'relay',
        name: 'Relay',
        role: 'resource',
        onUnavailable: 'block',
        enabled: true,
        protocol: 'vless',
        config: { server: '198.51.100.7', port: 443, id: 'a-placeholder-account', network: 'tcp', security: 'tls' },
        resources: { domainSuffix: ['relay.invalid'] },
      },
      {
        id: 'spare',
        name: 'Spare',
        role: 'resource',
        onUnavailable: 'fall-through',
        enabled: true,
        protocol: 'proxy',
        config: { type: 'socks', server: '198.51.100.20', port: 1080 },
      },
    ],
  } as unknown as ProfileDocument;
}

let journalAsked: string[] = [];

/**
 * The client journal, answering with the captured PUSH_REPLY line for the tunnels named, through the
 * real journal-entry parser.
 */
async function capturedJournal(tunnels: string[]): Promise<JournalReader> {
  journalAsked = [];
  const line = (await fixture('openvpn/push-reply-subnet.txt')).trim();
  const message = line.slice(line.indexOf('PUSH:'));
  return {
    currentBootId: async () => 'boot',
    read: async (query) => {
      journalAsked.push(query.unit ?? '');
      const wanted = tunnels.some((id) => query.unit === openVpnUnit(id));
      const text = wanted ? JSON.stringify({ MESSAGE: message, _SYSTEMD_UNIT: query.unit, __CURSOR: 'c1' }) : '';
      const page = parseJournalJsonLines(text);
      return { entries: page.entries, nextCursor: null, currentBootId: 'boot', containsEarlierBoots: false, hasMore: false, incomplete: false, incompleteReason: null, skippedLines: 0 };
    },
  };
}

interface CoreBehaviour {
  /** How the delay test answers for each outbound: a captured response. Default: the dead-outbound 503. */
  delay?: (outbound: string, url: string) => Promise<{ status: number; text: string }>;
  /** What `/connections` answers, round by round; the last one repeats. */
  connections?: string[];
  /** A selector's starting member. Default: its tunnel. */
  selectors?: Record<string, string>;
}

async function bench(
  options: {
    core?: CoreBehaviour;
    ping?: (interfaceName: string, address: string) => PingOutcome;
    /** Tunnels whose client journal holds the captured PUSH_REPLY line (`ping 15`). */
    pushReplyFor?: string[];
  } = {},
) {
  const document = benchProfile();
  const emitted = emitTunnels({
    profile: document,
    core: { known: false, outboundTypes: new Set() },
    installed: new Set(['openvpn', 'ck-client', 'xray', 'sing-box']),
    allocatedPorts: new Set(),
  });
  const planned = plan({
    profile: document,
    inventory: builtInAndDongle(),
    facts: cleanFacts(),
    emissions: emitted.emissions,
    ports: emitted.ports,
    refusals: emitted.refusals,
    carriers: emitted.carriers,
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
  });
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-guard-liveness-'));
  const store = createStore(openDatabase({ path: join(root, 'state.db') }));
  store.setTunnelUnits(planned.desired.tunnelUnits);
  const statusDirectory = join(root, 'openvpn');
  const captureDirectory = join(root, 'tunnel');
  await mkdir(statusDirectory);
  await mkdir(captureDirectory);

  // The core's control interface, over the real client, answering with captured bodies.
  const selectors = new Map<string, string>();
  for (const tunnel of document.tunnels) {
    const tag = tunnel.onUnavailable === 'block' ? guardSelectorTag(tunnel.id) : fallThroughSelectorTag(tunnel.id);
    selectors.set(tag, options.core?.selectors?.[tunnel.id] ?? tunnel.id);
  }
  const members = (name: string): string[] =>
    name.startsWith('wf-guard-') ? [name.replace('wf-guard-', ''), 'block'] : [name.replace('wf-fall-', ''), 'wf-selector'];
  const requests: { method: string; path: string }[] = [];
  const connections = [...(options.core?.connections ?? [])];
  const dead = response(await fixture('core-api/delay-https-dead-outbound.txt'));
  const core = createCoreApi({
    fetchJson: async (method, path, body) => {
      requests.push({ method, path });
      if (path === '/version') return { status: 200, text: '{"version":"sing-box 1.14.1"}' };
      if (method === 'GET' && path === '/proxies') {
        const proxies: Record<string, unknown> = {};
        for (const [name, now] of selectors) proxies[name] = { type: 'Selector', now, all: members(name) };
        return { status: 200, text: JSON.stringify({ proxies }) };
      }
      if (method === 'PUT') {
        const name = decodeURIComponent(path.replace('/proxies/', ''));
        selectors.set(name, (body as { name: string }).name);
        return { status: 204, text: '' };
      }
      const delay = /^\/proxies\/([^/]+)\/delay\?url=([^&]+)&/.exec(path);
      if (delay) {
        const outbound = decodeURIComponent(delay[1]!);
        const url = decodeURIComponent(delay[2]!);
        return options.core?.delay === undefined ? dead : await options.core.delay(outbound, url);
      }
      if (path === '/connections') {
        const text = connections.length > 1 ? connections.shift()! : (connections[0] ?? (await fixture('core-api/connections-idle.json')));
        return { status: 200, text };
      }
      return { status: 404, text: '{"message":"Resource not found"}\n' };
    },
  });

  let clock = 1_000_000;
  const pings: { interfaceName: string; address: string }[] = [];
  const meter = createLivenessMeter(
    deviceLivenessReaders({
      core,
      ping: async (interfaceName, address) => {
        pings.push({ interfaceName, address });
        return options.ping?.(interfaceName, address) ?? { kind: 'lost', why: 'no echo reply' };
      },
      statusDirectory,
      captureDirectory,
      now: () => clock,
      journal: await capturedJournal(options.pushReplyFor ?? []),
      clientUnit: openVpnUnit,
    }),
  );
  const journalQueries = () => journalAsked;

  const observers = createObserverRegistry({ monotonicMs: () => clock });
  const observer = observers.register({ name: 'tunnel-watchdog', watches: 'tunnels', everyMs: 30_000 });
  const observation = observeWatchdog(observer);
  observer.armed();
  const events: { kind: string; summary: string }[] = [];
  const probes = (emptyProfile({ name: 'x' }) as unknown as ProfileDocument).policy.probes;
  const watchdog = createWatchdog({
    core,
    selector: 'wf-selector',
    candidates: async () => [],
    guards: deviceGuards({ document: () => document, tunnelUnits: () => store.device().tunnelUnits }),
    liveness: meter,
    policy: () => ({ priority: [], excluded: [], sticky: true, onAllDown: 'block', probes }),
    record: (event) => {
      events.push({ kind: event.kind, summary: event.summary });
      observation.recorded(event);
    },
    log: () => undefined,
    now: () => clock,
    onRoundStart: () => observation.onRoundStart(),
    onRound: (outcome) => observation.onRound(outcome),
  });

  /** One round, the interval later, the way the daemon's loop reports it. */
  const round = async (): Promise<GuardOutcome[]> => {
    clock += 30_000;
    observation.onRoundStart();
    const outcome = await watchdog.runOnce();
    observation.onRound(outcome);
    return outcome.guards ?? [];
  };
  const writeStatus = async (tunnelId: string, file: string): Promise<void> => {
    await writeFile(join(statusDirectory, `${tunnelId}.status`), await fixture(`openvpn/${file}`));
  };
  /** The up-script's capture, written the way it writes it: a temporary file renamed over the old one. */
  const writeGateway = async (tunnelId: string, address: string): Promise<void> => {
    const temporary = join(captureDirectory, `.${tunnelId}.gateway.tmp`);
    await writeFile(temporary, `${address}\n`);
    await rename(temporary, join(captureDirectory, `${tunnelId}.gateway`));
  };
  const report = () => observers.report().find((entry) => entry.name === 'tunnel-watchdog')!;
  const puts = () => requests.filter((entry) => entry.method === 'PUT');
  const delays = () => requests.filter((entry) => entry.path.includes('/delay?'));
  /** Step the clock and sample the counters, the way `index.ts`'s five-second sampler does. */
  const sample = async (seconds: number, ids: string[]): Promise<string[]> => {
    clock += seconds * 1000;
    return meter.sampleKeepalives(ids);
  };
  /** One round without advancing the clock — what a nudge runs. */
  const roundNow = async (): Promise<GuardOutcome[]> => (await watchdog.runOnce()).guards ?? [];
  return { round, roundNow, sample, writeStatus, writeGateway, report, puts, delays, requests, pings, events, selectors, root, planned, journalQueries, watchdog };
}

const guardOf = (guards: GuardOutcome[], id: string): GuardOutcome => {
  const found = guards.find((guard) => guard.tunnelId === id);
  assert.ok(found, `no guard outcome for ${id}`);
  return found;
};

/* ── 1. the entry decides how, and the guard is never told what a tunnel carries ─────────── */

test('each tunnel is asked by its own protocol: OpenVPN by keepalive over its own interface, VLESS and proxy through the outbound', async () => {
  const { round, writeStatus, writeGateway, pings, delays } = await bench({ ping: () => ({ kind: 'answered', ms: 95 }) });
  await writeStatus('partner', 'status-t20-idle.txt');
  await writeGateway('partner', '10.136.0.1');
  await round();
  await writeStatus('partner', 'status-t40-idle.txt');
  const guards = await round();

  const partner = guardOf(guards, 'partner');
  assert.equal(partner.liveness.state, 'alive');
  assert.equal(partner.liveness.basis, 'keepalive');
  assert.match(partner.liveness.why, /10\.136\.0\.1, the gateway its peer pushed, over wfvpnprt answered in 95 ms/);
  // Echoes went to the gateway, over the tunnel's own interface, and nowhere else.
  assert.ok(pings.every((entry) => entry.interfaceName === 'wfvpnprt' && entry.address === '10.136.0.1'));
  // Nothing about partner went through the core: no fetch of anything, least of all its own resource.
  assert.ok(!delays().some((entry) => entry.path.startsWith('/proxies/partner/')), 'partner was fetched through');
  assert.ok(!JSON.stringify(delays()).includes('172.30.0.212'), 'a resource of a tunnel was used to measure it');

  const relay = guardOf(guards, 'relay');
  assert.equal(relay.liveness.basis, 'neutral-endpoints');
  const spare = guardOf(guards, 'spare');
  assert.equal(spare.liveness.basis, 'neutral-endpoints');
});

test('the guard cannot learn a tunnel\'s resources: every URL it sends is one of the three neutral checks, all HTTPS', async () => {
  const { round, delays } = await bench();
  for (let n = 0; n < 3; n += 1) await round();
  const urls = new Set(delays().map((entry) => decodeURIComponent(/url=([^&]+)/.exec(entry.path)![1]!)));
  assert.deepEqual([...urls].sort(), [...NEUTRAL_CHECKS].sort());
  // sing-box 1.14.1 replaces any http:// URL with its own default (fixtures/core-api/delay-http-url-ignored.txt).
  assert.ok(NEUTRAL_CHECKS.every((url) => url.startsWith('https://')));
  assert.equal(new Set(NEUTRAL_CHECKS.map((url) => new URL(url).hostname.split('.').slice(-2).join('.'))).size, 3, 'three operators');
});

/* ── 2. OpenVPN: keepalive primary, gateway confirming, never-answering gateway not measurable ── */

test('a peer that stops sending reads dead by keepalive after the silence limit, not before', async () => {
  const { round, writeStatus, report } = await bench();
  await writeStatus('partner', 'status-silent-t30.txt');
  // The captured client froze at 5363 read bytes once the server went silent: the same file every round.
  const first = guardOf(await round(), 'partner');
  assert.equal(first.liveness.state, 'unmeasurable');
  const second = guardOf(await round(), 'partner');
  assert.equal(second.liveness.state, 'unmeasurable', `30 s of silence is under the ${String(KEEPALIVE_SILENCE_SECONDS)} s limit`);
  await writeStatus('partner', 'status-silent-t60.txt');
  const third = guardOf(await round(), 'partner');
  assert.equal(third.liveness.state, 'dead');
  assert.equal(third.liveness.basis, 'keepalive');
  assert.match(third.liveness.why, /nothing has arrived from the peer for at least 60 s/);
  assert.equal(report().state, 'failing');
});

test('a gateway that answered on this connection and stops confirms a dead peer', async () => {
  let answering = true;
  const { round, writeStatus, writeGateway } = await bench({
    ping: () => (answering ? { kind: 'answered', ms: 95 } : { kind: 'lost', why: 'no echo reply' }),
  });
  await writeGateway('partner', '10.136.0.1');
  await writeStatus('partner', 'status-t20-idle.txt');
  await round();
  answering = false;
  await writeStatus('partner', 'status-silent-t30.txt');
  await round(); // the counter rose to 5363: packets arrived since the last reading
  await round();
  const dead = guardOf(await round(), 'partner');
  assert.equal(dead.liveness.state, 'dead');
  assert.equal(dead.liveness.basis, 'gateway-echo');
  assert.match(dead.liveness.why, /answered earlier on this connection and has stopped/);
});

test('a gateway that has never answered is not measurable, never dead — and a new connection forgets the old answers', async () => {
  let answering = false;
  const { round, writeGateway } = await bench({
    ping: () => (answering ? { kind: 'answered', ms: 40 } : { kind: 'lost', why: 'no echo reply' }),
  });
  // No status file at all, so the echo is the only reading.
  await writeGateway('corp', '10.122.0.1');
  for (let n = 0; n < 4; n += 1) {
    const corp = guardOf(await round(), 'corp');
    assert.equal(corp.liveness.state, 'unmeasurable');
    assert.match(corp.liveness.why, /has not answered since this connection was made, so its silence says nothing/);
  }
  answering = true;
  assert.equal(guardOf(await round(), 'corp').liveness.state, 'alive');
  answering = false;
  // A gateway that stopped answering, with no counter to confirm it, is one signal, and neither signal
  // alone is dead (G30 round 2). Before round 2 this read dead on the echo alone.
  assert.equal(guardOf(await round(), 'corp').liveness.state, 'unmeasurable');
  // The tunnel reconnects: the up-script renames a new capture into place, a new inode.
  await writeGateway('corp', '10.122.0.1');
  assert.equal(guardOf(await round(), 'corp').liveness.state, 'unmeasurable');
});

test('a rising counter is enough on its own: a peer that pushed no gateway still reads alive', async () => {
  const { round, writeStatus, pings } = await bench();
  await writeStatus('hq', 'status-t20-idle.txt');
  await round();
  await writeStatus('hq', 'status-t40-idle.txt');
  const hq = guardOf(await round(), 'hq');
  assert.equal(hq.liveness.state, 'alive');
  assert.equal(hq.liveness.basis, 'keepalive');
  assert.match(hq.liveness.why, /its peer has pushed no gateway since this device started/);
  assert.ok(!pings.some((entry) => entry.interfaceName === 'wfvpnhq'), 'an echo was sent with no gateway to send it to');
});

test('a gateway echo that answers overrides a counter that has not been read long enough', async () => {
  const { round, writeGateway } = await bench({ ping: () => ({ kind: 'answered', ms: 95 }) });
  await writeGateway('partner', '10.136.0.1');
  const partner = guardOf(await round(), 'partner');
  assert.equal(partner.liveness.state, 'alive');
  assert.equal(partner.liveness.basis, 'gateway-echo');
});

/* ── 3. VLESS and proxy: traffic first, neutral checks only when idle ────────────────────── */

/** The captured connection list, with the captured outbound `alive` renamed to the tunnel it stands for. */
async function connectionsAs(file: string, outbound: string): Promise<string> {
  return (await fixture(`core-api/${file}`)).replaceAll('wf-guard-alive', guardSelectorTag(outbound)).replaceAll('"alive"', `"${outbound}"`);
}

test('bytes arriving back through the outbound are the answer, and no check is sent', async () => {
  const { round, delays } = await bench({
    core: { connections: [await connectionsAs('connections-active-t0.json', 'relay'), await connectionsAs('connections-active-t10.json', 'relay')] },
  });
  await round();
  const before = delays().filter((entry) => entry.path.startsWith('/proxies/relay/')).length;
  const relay = guardOf(await round(), 'relay');
  assert.equal(relay.liveness.state, 'alive');
  assert.equal(relay.liveness.basis, 'traffic');
  assert.match(relay.liveness.why, /^alive: 5\.6 MB received through it in the last 30 s/);
  assert.equal(delays().filter((entry) => entry.path.startsWith('/proxies/relay/')).length, before, 'a check was sent while traffic was flowing');
});

test('a connection with a large total and no growth is not evidence: the tunnel is idle and is checked', async () => {
  // Captured at --limit-rate 20k: the download stayed at 4247568 for ten seconds on the same connection.
  const stalled = await connectionsAs('connections-stalled-t0.json', 'relay');
  assert.deepEqual(parseConnections(stalled)?.map((entry) => entry.download), [4247568]);
  const { round, delays } = await bench({ core: { connections: [stalled, await connectionsAs('connections-stalled-t10.json', 'relay')] } });
  await round();
  const relay = guardOf(await round(), 'relay');
  assert.equal(relay.liveness.basis, 'neutral-endpoints');
  assert.match(relay.liveness.why, /^idle; 0 of 3 connectivity checks answered through it/);
  assert.ok(delays().some((entry) => entry.path.startsWith('/proxies/relay/')));
});

test('a connection that has gone contributes nothing, and uploaded bytes are never evidence', async () => {
  const active = await connectionsAs('connections-active-t0.json', 'relay');
  const gone = await fixture('core-api/connections-idle.json');
  const uploading = active.replace('"upload":105', '"upload":99999999');
  const { round } = await bench({ core: { connections: [active, gone, uploading, uploading] } });
  await round();
  assert.equal(guardOf(await round(), 'relay').liveness.basis, 'neutral-endpoints');
  // A connection reappearing is new since the previous sample, so its bytes count once…
  assert.equal(guardOf(await round(), 'relay').liveness.basis, 'traffic');
  // …and not again: its upload grew by nothing and its download did not move.
  assert.equal(guardOf(await round(), 'relay').liveness.basis, 'neutral-endpoints');
});

test('idle: decided by majority of the three checks, and no majority is not measurable', async () => {
  const answered = await capturedDelay('alive', 'https://cp.cloudflare.com/generate_204');
  const lost = response(await fixture('core-api/delay-https-dead-outbound.txt'));
  const unknown = response(await fixture('core-api/delay-unknown-outbound.txt'));
  const timeout = response(await fixture('core-api/delay-timeout.txt'));
  const plans: Record<string, { status: number; text: string }[]> = {
    alive2: [answered, answered, lost],
    dead2: [answered, timeout, lost],
    split: [answered, lost, unknown],
  };
  for (const [name, answers] of Object.entries(plans)) {
    const { round } = await bench({
      core: { delay: async (outbound, url) => (outbound === 'relay' ? answers[NEUTRAL_CHECKS.indexOf(url)]! : lost) },
    });
    const relay = guardOf(await round(), 'relay');
    assert.equal(relay.liveness.state, { alive2: 'alive', dead2: 'dead', split: 'unmeasurable' }[name], name);
  }
});

/* ── 4. under block the guard reports and moves nothing ──────────────────────────────────── */

test('relay: every measurement fails for twenty rounds and wf-guard-relay is never moved', async () => {
  const { round, puts, selectors, report, pings } = await bench({ ping: () => ({ kind: 'lost', why: 'no echo reply' }) });
  for (let n = 0; n < 20; n += 1) {
    const relay = guardOf(await round(), 'relay');
    assert.equal(relay.liveness.state, 'dead');
    assert.equal(relay.changed, false);
    assert.equal(relay.blocked, false);
    assert.match(relay.action, /NOT being blocked by the guard: its outbound is a proxy protocol/);
  }
  assert.equal(selectors.get(guardSelectorTag('relay')), 'relay');
  assert.ok(!puts().some((entry) => entry.path.includes('relay')), 'relay’s selector was written');
  assert.ok(!pings.some((entry) => /relay/.test(entry.interfaceName)));
  // Red, and saying why nothing was blocked.
  const item = report().lastLooked!.items!.find((entry) => entry.subject === 'relay')!;
  assert.equal(item.tone, 'bad');
  assert.equal(item.method, 'neutral endpoints');
  assert.match(item.action ?? '', /NOT being blocked by the guard/);
  assert.match(report().problem ?? '', /relay \(20 round\(s\)\)/);
});

test('no tunnel on block is ever moved, whatever every measurement says, for thirty rounds', async () => {
  const { round, puts, writeStatus, writeGateway, events } = await bench({ ping: () => ({ kind: 'lost', why: 'no echo reply' }) });
  for (const id of ['partner', 'corp', 'hq']) {
    await writeStatus(id, 'status-silent-t60.txt');
    await writeGateway(id, '10.136.0.1');
  }
  let dead = 0;
  for (let n = 0; n < 30; n += 1) {
    for (const guard of await round()) {
      if (guard.onUnavailable === 'block') assert.equal(guard.blocked, false, `${guard.tunnelId} reads blocked`);
      if (guard.liveness.state === 'dead') dead += 1;
    }
  }
  assert.ok(dead > 60, 'the rounds were rounds in which tunnels read dead');
  // `spare` (fall-through, dead throughout) falls through; no `block` tunnel's selector is ever written.
  assert.deepEqual(puts().filter((entry) => entry.path.includes('wf-guard-')), [], 'a guard selector was written');
  assert.ok(!events.some((event) => event.kind === 'guard.blocked'));
  assert.ok(events.some((event) => event.kind === 'guard.dead' && /partner reads dead .*NOT being blocked by the guard: its outbound is bound to wfvpnprt/.test(event.summary)));
});

test('a selector left on block by an earlier build is put back on its tunnel, once, and said so', async () => {
  const { round, puts, selectors, events } = await bench({ core: { selectors: { partner: 'block' } } });
  const partner = guardOf(await round(), 'partner');
  assert.equal(partner.changed, true);
  assert.equal(partner.blocked, false);
  assert.equal(selectors.get(guardSelectorTag('partner')), 'partner');
  const guardPuts = () => puts().filter((entry) => entry.path.includes('wf-guard-'));
  assert.deepEqual(guardPuts().map((entry) => entry.path), [`/proxies/${guardSelectorTag('partner')}`]);
  assert.ok(events.some((event) => event.kind === 'guard.unparked'));
  await round();
  assert.equal(guardPuts().length, 1);
});

test('a fall-through tunnel that reads dead twice in a row is sent outside the tunnel, through the real wiring, and shown red', async () => {
  /*
   * Until G31 this test held that there was no selector to move. `spare` is a proxy tunnel on
   * `fall-through` whose every neutral check is the captured dead-outbound answer.
   */
  const { round, selectors, report, events } = await bench();
  const first = guardOf(await round(), 'spare');
  assert.equal(first.selector, fallThroughSelectorTag('spare'));
  assert.equal(first.liveness.state, 'dead');
  assert.equal(first.changed, false, 'one dead round must not move it');
  assert.equal(first.fallingThrough, null);
  assert.match(first.action, /dead 1 of the 2 consecutive rounds/);

  const second = guardOf(await round(), 'spare');
  assert.equal(second.changed, true);
  assert.equal(selectors.get(fallThroughSelectorTag('spare')), 'wf-selector');
  assert.deepEqual(second.fallingThrough, { forSeconds: 0 });
  assert.ok(events.some((event) => event.kind === 'guard.fell-through' && /spare read dead for 2 consecutive rounds/.test(event.summary)));

  await round();
  const item = report().lastLooked!.items!.find((entry) => entry.subject === 'spare')!;
  assert.equal(item.state, 'FALLING THROUGH');
  assert.equal(item.tone, 'bad');
  assert.equal(item.fallingThroughSeconds, 30);
  assert.match(report().problem ?? '', /spare \(30 s\) is leaving OUTSIDE the VPN/);
});

/* ── 5. the readings, parsed from what the tools really print ────────────────────────────── */

test('the OpenVPN status file: the link counter, from 2.6.14 as captured', async () => {
  assert.equal(parseOpenVpnStatus(await fixture('openvpn/status-t0-first-write.txt')), 0);
  assert.equal(parseOpenVpnStatus(await fixture('openvpn/status-t20-idle.txt')), 4927);
  assert.equal(parseOpenVpnStatus(await fixture('openvpn/status-t40-idle.txt')), 5039);
  assert.equal(parseOpenVpnStatus(await fixture('openvpn/status-silent-t30.txt')), 5363);
  assert.equal(parseOpenVpnStatus(await fixture('openvpn/status-silent-t60.txt')), 5363);
  // Caught between the client's truncate and its write.
  assert.equal(parseOpenVpnStatus(''), null);
});

test('the core client reads the delay test three ways, from sing-box 1.14.1 as captured', async () => {
  const answers: Record<string, { status: number; text: string }> = {
    answered: await capturedDelay('alive', 'https://cp.cloudflare.com/generate_204'),
    dead: response(await fixture('core-api/delay-https-dead-outbound.txt')),
    timeout: response(await fixture('core-api/delay-timeout.txt')),
    unknown: response(await fixture('core-api/delay-unknown-outbound.txt')),
  };
  const kinds: Record<string, string> = {};
  for (const [name, answer] of Object.entries(answers)) {
    const core = createCoreApi({ fetchJson: async () => answer });
    kinds[name] = (await core.check('x', NEUTRAL_CHECKS[0]!, 4000)).kind;
  }
  assert.deepEqual(kinds, { answered: 'answered', dead: 'lost', timeout: 'lost', unknown: 'error' });
  const unreachable = createCoreApi({ fetchJson: async () => Promise.reject(new Error('ECONNREFUSED')) });
  assert.equal((await unreachable.check('x', NEUTRAL_CHECKS[0]!, 4000)).kind, 'error');
});

test('the connection list, from sing-box 1.14.1 as captured: chains lead with the carrying outbound', async () => {
  assert.deepEqual(parseConnections(await fixture('core-api/connections-idle.json')), []);
  const active = parseConnections(await fixture('core-api/connections-active-t0.json'))!;
  assert.deepEqual(active[0]!.chains, ['alive', 'wf-guard-alive']);
  assert.equal(active[0]!.download, 7788224);
  assert.equal(parseConnections('{"connections":[{"id":"a","chains":["x"],"download":1}'), null, 'a list cut short is unreadable');
});

/* ── 6. the gateway capture, by the shipped up-script ────────────────────────────────────── */

const run = promisify(execFile);

async function runUpScript(envFile: string): Promise<string | null> {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-tunnel-up-'));
  const shipped = await readFile(join(here, '..', '..', '..', 'deploy', 'bin', 'tunnel-up'), 'utf8');
  // The shipped script, with only its state directory moved somewhere a test may write.
  assert.ok(shipped.includes('STATE_DIR=/run/wayfarer/tunnel\n'));
  const script = join(root, 'tunnel-up');
  await writeFile(script, shipped.replace('STATE_DIR=/run/wayfarer/tunnel\n', `STATE_DIR=${join(root, 'state')}\n`));
  await chmod(script, 0o755);
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  for (const line of (await fixture(`openvpn/${envFile}`)).split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  await run('/bin/sh', [script, 'wfvpnprt'], { env });
  try {
    return await readFile(join(root, 'state', 'partner.gateway'), 'utf8');
  } catch {
    return null;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('the up-script captures the pushed gateway from the environment OpenVPN 2.6.14 really gave it', async () => {
  assert.equal(await runUpScript('up-env-subnet-with-route-line.txt'), '10.136.0.1\n');
  assert.equal(await runUpScript('up-env-net30-with-route-line.txt'), '10.136.0.5\n');
  // Without the generated route line OpenVPN exports no gateway, and the script writes none.
  assert.equal(await runUpScript('up-env-subnet-no-route-line.txt'), null);
});

test('the generated client configuration carries the route line that makes the gateway exported, and the status file', () => {
  const ovpn = (plannedFiles: { path: string; content: string }[]) => plannedFiles.find((file) => file.path.endsWith('/partner.conf'))!.content;
  return bench().then(({ planned }) => {
    const content = ovpn(planned.desired.files as { path: string; content: string }[]);
    assert.match(content, /^route 192\.0\.2\.1 255\.255\.255\.255$/m);
    assert.match(content, /^route-noexec$/m);
    assert.match(content, /^status \/run\/wayfarer\/openvpn\/partner\.status 5$/m);
    const template = planned.desired.units.find((unit) => unit.name === 'wf-openvpn@.service')!.content!;
    assert.match(template, /^RuntimeDirectory=wayfarer\/openvpn$/m);
    assert.match(template, /^RuntimeDirectoryPreserve=yes$/m);
  });
});

test('a gateway capture is read with the identity of its connection', async () => {
  const { writeGateway, root } = await bench();
  await writeGateway('partner', '10.136.0.1');
  const first = (await stat(join(root, 'tunnel', 'partner.gateway'))).ino;
  await writeGateway('partner', '10.136.0.1');
  assert.notEqual((await stat(join(root, 'tunnel', 'partner.gateway'))).ino, first, 'a rename is a new inode');
});

/* ── the echo's reading ──────────────────────────────────────────────────────────────────── */

test('ping’s exit status is read three ways: answered, lost (the tunnel is not there), and could not run', () => {
  assert.deepEqual(pingOutcome({ code: 0, stdout: '64 bytes from 10.122.0.1: icmp_seq=1 ttl=64 time=41.2 ms', stderr: '', timedOut: false }), {
    kind: 'answered',
    ms: 41,
  });
  assert.equal(pingOutcome({ code: 1, stdout: '1 packets transmitted, 0 received', stderr: '', timedOut: false }).kind, 'lost');
  // The interface is gone: the tunnel client removed it. Dead, not "could not measure".
  assert.equal(pingOutcome({ code: 2, stdout: '', stderr: 'ping: SO_BINDTODEVICE wfvpncrp: No such device', timedOut: false }).kind, 'lost');
  assert.equal(pingOutcome({ code: 2, stdout: '', stderr: 'ping: connect: Network is unreachable', timedOut: false }).kind, 'lost');
  // A probe that could not run is not evidence about the tunnel.
  assert.equal(pingOutcome({ code: 2, stdout: '', stderr: 'ping: socket: Operation not permitted', timedOut: false }).kind, 'error');
  assert.equal(pingOutcome({ code: null, stdout: '', stderr: 'spawn /usr/bin/ping ENOENT', timedOut: false }).kind, 'error');
});

/* ── G30 round 2: detection as fast as the readings allow, and no faster ─────────────────── */

/*
 * Measured on the bench board, 2026-09-24: `corp`'s transport stopped at 08:39:27, its counter froze at
 * 10662, and the first dead reading came at 08:41:22 — about 115 s. The counter was sampled once a round,
 * so the silence clock started when a round noticed, and the limit was a fixed 60 s. These drive the
 * meter the way `index.ts` does — a sample every five seconds, a round when a sample changes a standing —
 * over the captured OpenVPN 2.6.14 status files and the captured PUSH_REPLY (`ping 15`).
 */

/** The captured counter sequence: first write 0, idle 4927 and 5039, then 5363 and frozen there. */
const CAPTURED_SEQUENCE = ['status-t0-first-write.txt', 'status-t20-idle.txt', 'status-t40-idle.txt', 'status-silent-t30.txt'];

test('the pushed keepalive is read from the captured PUSH_REPLY: ping 15, never ping-restart', async () => {
  const line = await fixture('openvpn/push-reply-subnet.txt');
  assert.equal(parsePushedKeepalive(line), 15);
  assert.equal(parsePushedKeepalive(line.replace(',ping 15,', ',')), null, 'ping-restart 120 read as ping');
  assert.equal(parsePushedKeepalive('Initialization Sequence Completed'), null);
});

test('silence is timed from the five-second sample, and the limit is three pushed keepalives: dead 45 s after the last packet, not before', async () => {
  const { sample, writeStatus, roundNow, journalQueries } = await bench({ pushReplyFor: ['corp'] });
  for (const file of CAPTURED_SEQUENCE) {
    await writeStatus('corp', file);
    assert.deepEqual(await sample(5, ['corp']), []);
  }
  // The last rise was seen at this sample; from here the captured client read 5363 for as long as the
  // server stayed silent. Samples at +5 … +40 are under the limit.
  for (let elapsed = 5; elapsed < 45; elapsed += 5) {
    assert.deepEqual(await sample(5, ['corp']), [], `silent at +${String(elapsed)} s already`);
  }
  // +45 s: three of the peer's 15 s keepalives missed. The sample says so, which is what nudges a round.
  assert.deepEqual(await sample(5, ['corp']), ['corp']);
  const corp = guardOf(await roundNow(), 'corp');
  assert.equal(corp.liveness.state, 'dead');
  assert.equal(corp.liveness.basis, 'keepalive');
  assert.match(corp.liveness.why, /at least 45 s \(limit 45 s: three of the 15 s keepalives its peer pushed\)/);
  assert.ok(journalQueries().includes(openVpnUnit('corp')));
});

test('with no PUSH_REPLY in the journal the limit is the stated 60 s, and the reading says the interval is unknown', async () => {
  const { sample, writeStatus, roundNow } = await bench();
  for (const file of CAPTURED_SEQUENCE) {
    await writeStatus('corp', file);
    await sample(5, ['corp']);
  }
  for (let elapsed = 5; elapsed < 60; elapsed += 5) assert.deepEqual(await sample(5, ['corp']), []);
  assert.deepEqual(await sample(5, ['corp']), ['corp']);
  assert.match(guardOf(await roundNow(), 'corp').liveness.why, /limit 60 s: its peer’s keepalive interval is not known/);
});

test('a gateway that answered on this connection and stops, with a counter flat across two status writes, is dead at once', async () => {
  let answering = true;
  const { sample, writeStatus, writeGateway, roundNow } = await bench({
    pushReplyFor: ['corp'],
    ping: () => (answering ? { kind: 'answered', ms: 40 } : { kind: 'lost', why: 'no echo reply' }),
  });
  await writeGateway('corp', '10.122.0.1');
  for (const file of CAPTURED_SEQUENCE) {
    await writeStatus('corp', file);
    await sample(5, ['corp']);
  }
  assert.equal(guardOf(await roundNow(), 'corp').liveness.state, 'alive');
  answering = false;
  // Five seconds after the last rise: the echo is lost, but an idle peer's counter is flat between
  // keepalives, so one flat status write is not a second signal. Not dead yet.
  await sample(5, ['corp']);
  assert.equal(guardOf(await roundNow(), 'corp').liveness.state, 'alive');
  // Ten seconds, two status writes: both signals. Dead now, 35 s before the keepalive limit alone.
  await sample(5, ['corp']);
  const corp = guardOf(await roundNow(), 'corp');
  assert.equal(corp.liveness.state, 'dead');
  assert.equal(corp.liveness.basis, 'gateway-echo');
  assert.match(corp.liveness.why, /answered earlier on this connection and has stopped \(no echo reply\), and the peer's packets were last seen arriving 10 s ago/);
});

test('a gateway that never answered, with a flat counter under the limit, still decides nothing', async () => {
  const { sample, writeStatus, writeGateway, roundNow } = await bench({ pushReplyFor: ['corp'] });
  await writeGateway('corp', '10.122.0.1');
  for (const file of CAPTURED_SEQUENCE) {
    await writeStatus('corp', file);
    await sample(5, ['corp']);
  }
  for (let n = 1; n <= 8; n += 1) {
    await sample(5, ['corp']);
    assert.equal(guardOf(await roundNow(), 'corp').liveness.state, 'alive', `read dead at +${String(n * 5)} s on the echo alone`);
  }
});

test('a nudge runs a round at once rather than at the end of the interval', async () => {
  const { watchdog, requests } = await bench();
  // Every round begins by asking the core for its version.
  const rounds = (): number => requests.filter((entry) => entry.path === '/version').length;
  const settle = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (rounds() < count) {
      if (Date.now() > deadline) throw new Error(`only ${String(rounds())} round(s) ran`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const handle = watchdog.start(() => 3600);
  try {
    await settle(1);
    // The interval is an hour: without the nudge there is no second round inside this test.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rounds(), 1);
    handle.nudge();
    await settle(2);
  } finally {
    handle.stop();
  }
});
