/**
 * A group fed by the proxy core's JSON, end to end on the daemon's side: the refresh stores the feed's
 * nodes and layout, the generated configuration runs it as the core would from the feed's own file, the
 * person's choice of a country moves TCP and UDP together, and the watchdog holds that choice.
 *
 * Read from the capture of the `za-stenoy.ru` feed (2026-11-07, credentials replaced).
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TAGS, emptyProfile, layoutChoices, profileFaults, type Group, type ProfileDocument } from '@wayfarer/schemas';
import { refreshGroup } from '../src/core/subscriptions.ts';
import { readFeed } from '../src/core/subscription-refresh.ts';
import { generateCoreConfig } from '../src/core/generate/core-config.ts';
import { createWatchdog } from '../src/core/watchdog.ts';
import { checkInvariants } from '../src/core/invariants.ts';

const FEED = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'protocols', 'test', 'fixtures', 'subscriptions', 'sing-box-za-stenoy.json'),
  'utf8',
);

function emptyGroupDocument(): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' });
  return {
    ...base,
    groups: [
      { id: 'cryptocat', name: 'CryptoCAT', enabled: true, format: 'sing-box', url: 'https://feed.example/sub', refreshHours: 1, onUnavailable: 'block', members: [] },
    ],
    policy: { ...base.policy, egress: 'cryptocat' },
  };
}

function refreshed(document = emptyGroupDocument()) {
  const read = readFeed('sing-box', FEED);
  return refreshGroup({ document, groupId: 'cryptocat', nodes: read.nodes, layout: read.layout! });
}

const group = (document: ProfileDocument): Group => document.groups[0]!;
const selectorNamed = (g: Group, name: string) => g.layout!.selectors.find((selector) => selector.name === name)!;
const memberNamed = (g: Group, name: string) => g.members.find((member) => member.name === name)!;

test('the refresh stores twelve members and the feed’s layout in this product’s ids', () => {
  const outcome = refreshed();
  const g = group(outcome.document);
  assert.equal(g.members.length, 12);
  assert.equal(outcome.added.length, 12);
  assert.equal(outcome.layoutChanged, true);
  // The selector route.final names is the group itself.
  assert.equal(selectorNamed(g, '🚀 VPN').id, 'cryptocat');
  // Every reference is an id of this group or `direct`, never a feed tag.
  const ids = new Set(['direct', ...g.members.map((m) => m.id), ...g.layout!.selectors.map((s) => s.id)]);
  for (const selector of g.layout!.selectors) for (const option of selector.options) assert.ok(ids.has(option), option);
  assert.deepEqual(
    g.layout!.rules.map((rule) => ({ ...rule, to: rule.to === undefined ? undefined : rule.to === 'direct' ? 'direct' : g.layout!.selectors.find((s) => s.id === rule.to)?.name })),
    [
      { action: 'route', privateDestination: true, to: 'direct' },
      { action: 'reject', network: 'udp', port: [443], to: undefined },
      { action: 'route', network: 'udp', to: '🎮 Rapid UDP' },
    ],
  );
  // The stored document is one the schema accepts.
  assert.deepEqual(profileFaults(outcome.document), []);
});

test('HY and HY-UDP of one server are two members with two outbound tags', () => {
  const g = group(refreshed().document);
  assert.notEqual(memberNamed(g, '🇵🇱 Польша · R1 · HY').id, memberNamed(g, '🇵🇱 Польша · R1 · HY-UDP').id);
});

test('refreshing again from the same feed changes nothing and moves no id', () => {
  const first = refreshed();
  const second = refreshed(first.document);
  assert.deepEqual([second.added, second.updated, second.removed], [[], [], []]);
  assert.equal(second.layoutChanged, false);
  assert.deepEqual(group(second.document).layout, group(first.document).layout);
});

test('a chosen country survives a refresh that still offers it', () => {
  const first = refreshed();
  const germany = selectorNamed(group(first.document), '🇩🇪 Германия · Rapid Авто').id;
  const chosen = { ...first.document, groups: [{ ...group(first.document), preferred: germany }] };
  assert.equal(group(refreshed(chosen).document).preferred, germany);
});

test('choosing Germany points the group at Germany Auto and the UDP selector at Germany UDP', () => {
  const g = group(refreshed().document);
  const germany = selectorNamed(g, '🇩🇪 Германия · Rapid Авто').id;
  const { selections, unmatched } = layoutChoices({ ...g, preferred: germany });
  assert.deepEqual(selections, [
    { selector: 'cryptocat', option: germany },
    { selector: selectorNamed(g, '🎮 Rapid UDP').id, option: selectorNamed(g, '🇩🇪 Германия · Rapid UDP').id },
  ]);
  assert.deepEqual(unmatched, []);
  // Nothing chosen, nothing moved: every selector starts where the feed says.
  assert.deepEqual(layoutChoices(g).selections, []);
});

function coreConfigFor(document: ProfileDocument) {
  const emitted = new Map(
    group(document).members.map((member) => [member.id, { target: 'outbounds' as const, object: { type: member.protocol } }]),
  );
  return generateCoreConfig({
    profile: document,
    interfaces: { accessPoint: 'wlan0', uplinks: new Map([['uplink', 'wfwan0']]) },
    emitted,
    tunnelDns: new Map(),
    uplinkNetworks: ['192.168.77.0/24'],
  }) as unknown as { outbounds: Record<string, unknown>[]; route: { rules: Record<string, unknown>[]; final: string } };
}

test('the core runs the feed’s selectors and urltest groups as the feed wrote them', () => {
  const document = refreshed().document;
  const g = group(document);
  const config = coreConfigFor(document);
  const byTag = new Map(config.outbounds.map((outbound) => [outbound['tag'], outbound]));

  const top = byTag.get('cryptocat')!;
  assert.equal(top['type'], 'selector');
  assert.deepEqual(top['outbounds'], [selectorNamed(g, '🇵🇱 Польша · Rapid Авто').id, selectorNamed(g, '🇩🇪 Германия · Rapid Авто').id]);
  assert.equal(top['interrupt_exist_connections'], true);

  const plUdp = byTag.get(selectorNamed(g, '🇵🇱 Польша · Rapid UDP').id)!;
  assert.deepEqual(
    { type: plUdp['type'], url: plUdp['url'], interval: plUdp['interval'], tolerance: plUdp['tolerance'] },
    { type: 'urltest', url: 'https://www.gstatic.com/generate_204', interval: '15s', tolerance: 1000 },
  );
  assert.equal(plUdp['outbounds'] instanceof Array && plUdp['outbounds'][0], memberNamed(g, '🇵🇱 Польша · R2 · HY-UDP').id);

  // The UDP selector also offers the fallback, so the watchdog can send UDP there with everything else.
  const udp = byTag.get(selectorNamed(g, '🎮 Rapid UDP').id)!;
  assert.deepEqual(udp['outbounds'], [selectorNamed(g, '🇵🇱 Польша · Rapid UDP').id, selectorNamed(g, '🇩🇪 Германия · Rapid UDP').id, CORE_TAGS.block]);
  // The egress is the group, through the main selector, as for any group.
  assert.deepEqual(byTag.get(CORE_TAGS.selector)!['outbounds'], ['cryptocat', CORE_TAGS.block]);
});

test('the feed’s rules come last, after every rule of this device’s own, and only for the egress', () => {
  const document = refreshed().document;
  const g = group(document);
  const rules = coreConfigFor(document).route.rules;
  assert.deepEqual(rules.slice(-3), [
    { ip_is_private: true, outbound: CORE_TAGS.direct },
    { network: 'udp', port: [443], action: 'reject' },
    { network: 'udp', outbound: selectorNamed(g, '🎮 Rapid UDP').id },
  ]);
  // Not the egress: no feed rule is written, and the planner says why.
  const elsewhere = { ...document, policy: { ...document.policy, egress: undefined } } as unknown as ProfileDocument;
  assert.equal(coreConfigFor(elsewhere).route.rules.some((rule) => rule['port'] !== undefined), false);
  const findings = checkInvariants({
    profile: elsewhere,
    bindings: new Map(),
    inventory: { interfaces: [], radios: [], binaries: [] } as never,
    facts: { foreignCores: [], interfaceClaims: [], managementInterfaces: [], binaries: [], uplinkNetworks: [] } as never,
  });
  assert.ok(findings.some((finding) => finding.code === 'group_feed_rules_unused'));
});

test('a layout that names something the group does not have is refused before it reaches the core', () => {
  const document = refreshed().document;
  const g = group(document);
  const broken = {
    ...document,
    groups: [{ ...g, layout: { ...g.layout!, rules: [{ action: 'route' as const, network: 'udp' as const, to: 'nowhere' }] } }],
  };
  const findings = checkInvariants({
    profile: broken,
    bindings: new Map(),
    inventory: { interfaces: [], radios: [], binaries: [] } as never,
    facts: { foreignCores: [], interfaceClaims: [], managementInterfaces: [], binaries: [], uplinkNetworks: [] } as never,
  });
  assert.ok(findings.some((finding) => finding.code === 'group_layout_dangling_reference' && finding.pointer === '/groups/0/layout/rules/0/to'));
});

test('a sing-box group answered with links changes nothing, rather than losing its layout quietly', () => {
  const read = readFeed('sing-box', 'dmxlc3M6Ly91QGguZXhhbXBsZTo0NDM=');
  assert.deepEqual(read.nodes, []);
  assert.match(read.refused.join(' '), /did not answer with the proxy core/);
});

test('the watchdog holds the chosen country on both selectors and chooses nothing among members', async () => {
  const g = group(refreshed().document);
  const germany = selectorNamed(g, '🇩🇪 Германия · Rapid Авто').id;
  const poland = selectorNamed(g, '🇵🇱 Польша · Rapid Авто').id;
  const udp = selectorNamed(g, '🎮 Rapid UDP').id;
  const plUdp = selectorNamed(g, '🇵🇱 Польша · Rapid UDP').id;
  const deUdp = selectorNamed(g, '🇩🇪 Германия · Rapid UDP').id;
  const now = new Map<string, string>([[CORE_TAGS.selector, 'cryptocat'], ['cryptocat', poland], [udp, plUdp]]);
  const selects: [string, string][] = [];
  const core = {
    available: async () => true,
    proxies: async () => [
      ...[...now].map(([name, current]) => ({ name, type: 'Selector', now: current, all: [] as string[] })),
      ...g.members.map((member) => ({ name: member.id, type: 'Hysteria2', now: null, all: [] as string[] })),
    ],
    delay: async () => 120,
    select: async (selector: string, option: string) => {
      selects.push([selector, option]);
      now.set(selector, option);
      return { ok: true as const };
    },
    connections: async () => null,
  };
  const watchdog = createWatchdog({
    core: core as never,
    selector: CORE_TAGS.selector,
    selections: async () => ({
      groups: [
        {
          id: 'cryptocat',
          members: g.members.map((member) => member.id),
          preferred: germany,
          layout: {
            choices: layoutChoices({ ...g, preferred: germany }).selections,
            others: [{ selector: udp, first: plUdp }],
          },
        },
      ],
      egress: { kind: 'group', id: 'cryptocat' },
    }),
    guards: async () => [],
    policy: () => ({
      sticky: true,
      onAllDown: 'block',
      probes: { count: 1, failStreak: 3, endpoints: ['https://probe.example/generate_204'], intervalSeconds: 600, maxLatencyMs: 1000, maxJitterMs: 1000, maxLossPercent: 50 },
    }),
    record: () => undefined,
    log: () => undefined,
  } as never);
  await watchdog.runOnce();
  assert.deepEqual(selects, [['cryptocat', germany], [udp, deUdp]]);
  // No member was ever selected: the feed's urltest groups choose among them.
  assert.ok(selects.every(([selector]) => selector === 'cryptocat' || selector === udp));
});
