/**
 * Traffic assigned to a tunnel must not go anywhere else when that tunnel cannot carry it.
 *
 * The requirement, in the operator's words: *if this tunnel is not working, that traffic must be blocked
 * completely — never fall back to direct.* The distinction that makes this a feature rather than a
 * configuration is that **a connection error is not a refusal.** A rule pointing at a tunnel's own
 * outbound produces an error when the tunnel is down: it is decided inside a dial, it behaves differently
 * on retry, it leaves no record, and the name is still looked up. A selector pointed at `block` is a
 * routing decision — observable, recorded, and the same machinery already proved for the fallback.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));

import {
  CORE_TAGS,
  emptyProfile,
  fallThroughSelectorTag,
  generateRoutingRules,
  guardSelectorTag,
  type ProfileDocument,
} from '@wayfarer/schemas';

const context = { uplinkInterfaces: [], uplinkNetworks: [] };

function withResourceTunnel(onUnavailable: 'block' | 'fall-through'): ProfileDocument {
  const base = emptyProfile({ name: 'Work', now: () => '2026-09-21T00:00:00.000Z' });
  return {
    ...base,
    tunnels: [
      {
        id: 'vpn-relay',
        name: 'Relay',
        role: 'resource',
        enabled: true,
        onUnavailable,
        protocol: 'vless',
        config: {
          server: '198.51.100.9',
          port: 443,
          id: '00000000-0000-4000-8000-000000000000',
          network: 'tcp',
          security: 'tls',
        },
        resources: { domainSuffix: ['.service-c.example'] },
      },
    ],
    routing: { ...base.routing, rules: [{ kind: 'tunnel-resources' }] },
  } as ProfileDocument;
}

/* ── the shape of the configuration ──────────────────────────────────────────────────────── */

test('a blocking tunnel is reached through a guard selector, not through its own outbound', () => {
  const rules = generateRoutingRules(withResourceTunnel('block'), context);
  const rule = rules.find((entry) => {
    const suffixes = (entry.rule as { domain_suffix?: string[] } | null)?.domain_suffix;
    return Array.isArray(suffixes) && suffixes.includes('.service-c.example');
  });
  assert.ok(rule?.rule, 'the resource anchor must emit a rule');
  assert.equal(
    (rule.rule as { outbound: string }).outbound,
    guardSelectorTag('vpn-relay'),
    'pointing straight at the tunnel makes an unavailable tunnel an error rather than a refusal',
  );
  // The operator reads this sentence before confirming, so it has to say what happens on failure.
  assert.match(rule.summary, /refused rather than sent another way/);
});

test('a fall-through tunnel is reached through its fall-through selector, and says in words that it leaves outside the tunnel', () => {
  /*
   * Until G31 (2026-09-24) this test asserted the rule pointed straight at the tunnel — and that was the
   * defect: with no selector in front of it, nothing could send the traffic anywhere else, and the
   * sentence it checked for promised a route that did not exist.
   */
  const rules = generateRoutingRules(withResourceTunnel('fall-through'), context);
  const rule = rules.find((entry) => {
    const suffixes = (entry.rule as { domain_suffix?: string[] } | null)?.domain_suffix;
    return Array.isArray(suffixes) && suffixes.includes('.service-c.example');
  });
  assert.ok(rule?.rule);
  assert.equal((rule.rule as { outbound: string }).outbound, fallThroughSelectorTag('vpn-relay'));
  assert.match(rule.summary, /leaves OUTSIDE the tunnel/);
  assert.match(rule.summary, /rules below this one are not consulted/);
});

test('a document written before the field migrates to block, not to fall-through', async () => {
  /*
   * The default is the ruling, not a style preference: a request that leaks onto the open network is the
   * exact outcome the tunnel was paid to prevent and nobody sees it, while an application that cannot
   * connect is an error somebody sees and retries. Fail towards the smaller loss.
   *
   * The migration is where that ruling is tested, because it is where it is most tempting to get wrong.
   * Migrating to `fall-through` would preserve the old behaviour exactly — and preserve it by preserving a
   * leak: traffic the operator deliberately assigned to a tunnel would quietly go direct the moment the
   * tunnel failed. A migration carries intent forward, and the intent of assigning traffic to a tunnel is
   * that it goes there or nowhere.
   */
  const { migrateProfile } = await import('@wayfarer/schemas');
  const before = {
    schemaVersion: 4,
    /*
     * Written in the dialect of the version it claims to be, which for a `schemaVersion: 4` document means
     * `provider` and an opaque `config` — `protocol` is what the catalogue migration *produces*, and a
     * document already wearing it is rejected as naming a provider of "nothing". The profile blob is real
     * enough to survive that migration, so this test keeps failing only for its own reason: that
     * `onUnavailable` must arrive as `block`.
     */
    tunnels: [
      {
        id: 'vpn-relay',
        name: 'Relay',
        role: 'resource',
        enabled: true,
        provider: 'openvpn',
        config: { profile: 'client\ndev tun\n' },
      },
    ],
  } as unknown as Record<string, unknown>;

  const result = migrateProfile(before);
  const migrated = (result.document as { tunnels: { onUnavailable?: string }[] }).tunnels[0];
  assert.equal(migrated?.onUnavailable, 'block');
  assert.ok(result.applied.includes('what a tunnel does when it is unavailable'));
});

/* ── the watchdog: see guard-liveness.test.ts ─────────────────────────────────────────────── */

/*
 * The tests that stood here held the guard to blocking a tunnel on `block` after a failed probe streak.
 * That behaviour was removed on 2026-09-24 by the owner's decision (plan row G30): a tunnel on `block`
 * is measured by its own protocol and reported, and its selector is never moved towards `block`. What
 * the guard does now is proven in `guard-liveness.test.ts`, through the wiring `index.ts` uses.
 */

/* ── rule order: the two ways a valid list does the opposite of what was meant ───────────── */

function facts(uplink: { interface: string; cidr: string }[] = [{ interface: 'wfwan0', cidr: '192.168.77.0/24' }]) {
  return {
    foreignCores: [],
    interfaceClaims: [],
    managementInterfaces: [],
    binaries: [],
    uplinkNetworks: uplink,
  };
}

function resourceTunnel(id: string, name: string, over: { ipCidr?: string[]; domainSuffix?: string[] }) {
  return {
    id,
    name,
    role: 'resource' as const,
    enabled: true,
    onUnavailable: 'block' as const,
    provider: 'openvpn',
    config: { configBlob: 'x' },
    resources: over,
  };
}

async function findingsFor(document: ProfileDocument) {
  const { checkInvariants } = await import('../src/core/invariants.ts');
  return checkInvariants({
    profile: document,
    bindings: new Map(),
    inventory: { interfaces: [], radios: [], binaries: [] } as never,
    facts: facts() as never,
  });
}

function profileWith(tunnels: unknown[], rules: unknown[]): ProfileDocument {
  const base = emptyProfile({ name: 'Work', now: () => '2026-09-21T00:00:00.000Z' });
  return { ...base, tunnels, routing: { ...base.routing, rules } } as unknown as ProfileDocument;
}

test('a broad corporate range is allowed; putting the protect rule below it is refused', async () => {
  /*
   * The range is legitimate — an internal name set really can span almost all private space — so refusing
   * it would make a tunnel the operator needs unconfigurable. What must never happen is the ordering that
   * sends this device's own management traffic into that tunnel, because that cannot be undone from
   * outside the building.
   */
  const hq = resourceTunnel('hq', 'HQ', { ipCidr: ['10.0.0.0/8', '192.168.0.0/16'] });

  const correct = await findingsFor(
    profileWith([hq], [{ kind: 'protect-own-networks' }, { kind: 'tunnel-resources' }]),
  );
  assert.equal(
    correct.find((f) => f.severity === 'error' && f.code === 'own_network_unprotected_order'),
    undefined,
    'the range itself must not be refused',
  );
  const explained = correct.filter((f) => f.code === 'resource_tunnel_covers_own_network');
  assert.ok(explained.length > 0, 'the operator must be told why the rule order is pinned');
  assert.ok(explained.every((f) => f.severity === 'warning'));
  // Both of this device's own networks are inside 10.0.0.0/8 and 192.168.0.0/16, and each is named:
  // reporting only the first would leave the operator fixing one overlap and rediscovering the other.
  const contained = explained.map((f) => f.detail?.['contains']).sort();
  assert.deepEqual(contained, ['10.44.0.0/24', '192.168.77.0/24']);
  assert.match(explained[0]!.message, /cannot be moved below it/);

  const inverted = await findingsFor(
    profileWith([hq], [{ kind: 'tunnel-resources' }, { kind: 'protect-own-networks' }]),
  );
  const refused = inverted.find((f) => f.code === 'own_network_unprotected_order');
  assert.ok(refused, 'the ordering must be refused');
  assert.equal(refused.severity, 'error');
  assert.match(refused.message, /stop being reachable/);
  assert.match(refused.hint, /range itself is fine/);
});

test('no protect rule at all counts as below everything', async () => {
  const hq = resourceTunnel('hq', 'HQ', { ipCidr: ['10.0.0.0/8'] });
  const found = await findingsFor(profileWith([hq], [{ kind: 'tunnel-resources' }]));
  const refused = found.find((f) => f.code === 'own_network_unprotected_order');
  assert.ok(refused);
  assert.equal(refused.severity, 'error');
  assert.match(refused.message, /no "protect own networks" rule/);
});

test('a broad tunnel listed before a narrow one is refused, naming both and the order that works', async () => {
  /*
   * The resource anchor emits one rule per tunnel in list order and the core takes the first match, so the
   * second tunnel connects, looks healthy, and carries nothing. Valid, plausible, and the opposite of what
   * was meant — the same shape as a generated rule that matched everything.
   */
  const found = await findingsFor(
    profileWith(
      [
        resourceTunnel('hq', 'HQ', { ipCidr: ['10.0.0.0/8'] }),
        resourceTunnel('corp', 'Corp', { ipCidr: ['10.148.0.0/16'] }),
      ],
      [{ kind: 'protect-own-networks' }, { kind: 'tunnel-resources' }],
    ),
  );
  const shadowed = found.find((f) => f.code === 'tunnel_range_shadowed');
  assert.ok(shadowed, 'a swallowed tunnel must be reported');
  assert.equal(shadowed.severity, 'error');
  assert.match(shadowed.message, /"HQ" \(hq\)/);
  assert.match(shadowed.message, /"Corp" \(corp\)/);
  assert.match(shadowed.message, /10\.148\.0\.0\/16/);
  assert.match(shadowed.message, /connect, look healthy, and carry nothing/);
  assert.match(shadowed.hint, /List "Corp" before "HQ"/);
});

test('the narrow tunnel listed first raises nothing', async () => {
  const found = await findingsFor(
    profileWith(
      [
        resourceTunnel('corp', 'Corp', { ipCidr: ['10.148.0.0/16'] }),
        resourceTunnel('hq', 'HQ', { ipCidr: ['10.0.0.0/8'] }),
      ],
      [{ kind: 'protect-own-networks' }, { kind: 'tunnel-resources' }],
    ),
  );
  assert.equal(found.find((f) => f.code === 'tunnel_range_shadowed'), undefined);
});

test('a broader domain suffix listed first shadows a more specific one', async () => {
  const found = await findingsFor(
    profileWith(
      [
        resourceTunnel('hq', 'HQ', { domainSuffix: ['example.com'] }),
        resourceTunnel('inner', 'Inner', { domainSuffix: ['svc.example.com'] }),
      ],
      [{ kind: 'protect-own-networks' }, { kind: 'tunnel-resources' }],
    ),
  );
  const shadowed = found.find((f) => f.code === 'tunnel_suffix_shadowed');
  assert.ok(shadowed);
  assert.match(shadowed.hint, /List "Inner" before "HQ"/);
});

/* ── the mark has to be consulted by something ───────────────────────────────────────────── */

/**
 * Setting a mark changes nothing unless a policy rule acts on it.
 *
 * Measured on the bench board, 2026-09-21, before this existed: the ruleset marked the device's own
 * traffic, `ip rule show` contained no rule mentioning a mark, `ip route get <address> mark 0x1e7`
 * returned the tunnel device exactly as the unmarked lookup did, and the tunnel client's own connection
 * to its VPN server was sitting inside the proxy core. Every part of the protection was present except
 * the part that acts — and because the traffic still arrived, nothing looked wrong.
 */
test('the device\'s own traffic is kept off the tunnel by selectors known at route time', async () => {
  /*
   * A policy rule matching the firewall mark was tried first and broke the device's own networking.
   *
   * The source address is chosen on the FIRST route lookup, which happens before the output hook runs and
   * therefore before the mark exists. The packet was given 172.19.0.1 — the tunnel's own address — and the
   * reroute triggered by setting the mark keeps a source that is still local to the machine. Measured on
   * the bench board, 2026-09-21: every marked connection timed out, the same connection bound explicitly
   * to a real address succeeded, and `ping -I` worked because binding to an interface skips the decision.
   *
   * A mark cannot fix a source that has already been chosen. `uidrange` and `dport` are known at the first
   * lookup, so the right table is consulted before a source is picked.
   */
  const { firewallUnit } = await import('../src/core/generate/units.ts');
  const { DEVICE_MARK_RULE_PRIORITY } = await import('@wayfarer/schemas');
  const content = firewallUnit({ timePorts: [123] }).content;
  assert.ok(content, 'the firewall unit must have content');
  const adds = content.split('\n').filter((line) => line.includes('rule add'));
  assert.ok(adds.length >= 3, 'one rule for the device itself and one per time port and protocol');

  // Root-owned traffic: the tunnel clients and the core itself.
  const byUid = adds.find((line) => line.includes('uidrange 0-0'));
  assert.ok(byUid, 'root-owned traffic must be selected by uid, which is known at route time');
  /*
   * A forwarded packet has no socket and therefore no owning user, and the kernel matches it as uid 0
   * regardless. Measured: a bare uid rule sent a client's packet out the physical interface carrying an
   * address nothing masquerades — clients resolved names and reached nothing. `iif lo` is how a policy
   * rule says "locally originated".
   */
  assert.match(byUid, /iif lo/, 'without this the rule also captures every forwarded client packet');
  assert.match(byUid, /lookup main/, 'it must take the ordinary table, not the tunnel table');
  assert.doesNotMatch(byUid, /fwmark/, 'a mark is set after the source is chosen, so it cannot be used here');

  // The time ports, because the time service does NOT run as root — a uid rule misses it entirely, and
  // that failure is self-locking: correcting a wrong clock needs a time query.
  assert.ok(adds.some((l) => l.includes('ipproto udp dport 123 iif lo')), 'time queries must bypass by port');
  assert.ok(adds.some((l) => l.includes('ipproto tcp dport 123 iif lo')), 'both protocols');
  // A client's own time query is forwarded traffic and belongs in the tunnel with the rest of it.
  for (const line of adds) assert.match(line, /iif lo/);

  // Below the core's own rules, which it installs at 9000 and above. Priority decides, not install order.
  assert.ok(DEVICE_MARK_RULE_PRIORITY < 9000);
  for (const line of adds) {
    // Idempotent: `ip rule add` is not, so a restart without the delete stacks duplicates for ever.
    assert.match(line, /while .*rule del priority/);
  }
});

test('the time ports reach the ruleset and the policy rules from one value', async () => {
  // Two halves of one protection: the ruleset marks those ports and the unit keeps them off the tunnel.
  // Two lists agree until somebody edits one, so both are generated from the same input.
  const { firewallUnit } = await import('../src/core/generate/units.ts');
  const content = firewallUnit({ timePorts: [123, 4460] }).content;
  assert.ok(content);
  for (const port of [123, 4460]) {
    assert.ok(content.includes(`ipproto udp dport ${port} iif lo`), `port ${port} must be carried through`);
  }
});

/* ── a guard removed with the defect it guarded against ─────────────────────────────────── */

/*
 * Removed here, 2026-09-21: a test named "an external client with a configuration gets the file and is
 * told where it is".
 *
 * It guarded a real pair of failures. A provider advertised a `configFile` field and no generator wrote
 * one, so a client whose whole purpose is to run with a configuration started, found its environment
 * variable unset and exited. And the value was declared `x-secret`, so the file writer unwrapped the
 * `{ $secret: … }` envelope while the script that had to point at the file tested `typeof === "string"`,
 * concluded there was no configuration, and left a file nothing referred to.
 *
 * Both halves became **unreachable**, not merely unlikely. A tunnel no longer carries an opaque `config`
 * beside a provider name: it carries a `protocol` from the catalogue and a typed configuration, so a
 * generated file's name and format belong to the catalogue entry rather than to a string a generator
 * chose, and the script is produced from the same value as the file instead of from a second reading of
 * it. There is no longer a way to write the file and not refer to it.
 *
 * It is deleted rather than kept, because a test that guards something impossible reads, a year later,
 * like a test guarding something important, and the next person is afraid to touch it. That is how a
 * suite accumulates tests nothing can reach.
 *
 * Where each half now lives, checked rather than assumed before deleting this:
 *
 * * the file-and-its-reader half, generalised and strengthened, in `test/emit.test.ts` — "every generated
 *   file names the unit that reads it, so none of them is an orphan" asserts it for every file of every
 *   emission, where this asserted one environment variable in one script;
 * * the extension and the permissions, in the same file, by name;
 * * **the secret-unwrapping half**, which was the one worth checking for, since it is about a wrapper and
 *   not about the vanished provider. Verified by mutation rather than by reading: removing the unwrap in
 *   `core/emit.ts` turns "a stored configuration validates although its secrets are still wrapped" and "a
 *   valid configuration produces no issues, including one with secrets still wrapped" red, neither of
 *   which touches the removed path. Had nothing gone red, this test would have stayed.
 */

/* ── a captured value must provoke its own reading ───────────────────────────────────────── */

/**
 * A corporate peer chooses the resolver per connection, so the profile can only hold a starting point.
 *
 * Measured on the bench board, 2026-09-21: one tunnel pushed 10.184.100.5, 10.184.40.5 and 10.184.48.5 over
 * one evening, with only the current one reachable through the tunnel and the other two silent — and
 * reconnected six times in forty minutes. A value captured at connection time and read only when somebody
 * happens to apply something is right about half the time, which is the state a hardcoded address was
 * already in.
 */
test('a captured resolver is preferred over the profile value, and the difference is reported', async () => {
  const { tunnelDnsFromProfile } = await import('../src/core/planner.ts');
  const tunnel = {
    id: 'hq',
    name: 'HQ',
    role: 'resource' as const,
    enabled: true,
    onUnavailable: 'block' as const,
    provider: 'openvpn',
    config: {},
    dns: { server: '10.184.100.5', dynamic: true, domainSuffix: ['hq.lan'] },
  };

  // The peer has pushed something else. The captured value is the truth; the profile is a starting point.
  const findings: { code: string; severity: string }[] = [];
  const used = tunnelDnsFromProfile(tunnel as never, new Map([['hq', '10.184.40.5']]), findings as never);
  assert.equal(used?.address, '10.184.40.5', 'the profile value would have been unreachable from this gateway');
  assert.ok(
    findings.some((f) => f.code === 'dynamic_resolver_differs'),
    'the operator must be told the address in use is not the one written down',
  );

  // Nothing captured yet — the normal state before a tunnel first connects. Falling back to the profile
  // is the smaller loss: refusing would mean no core configuration at all, and so no other tunnel either.
  const none: { code: string; severity: string }[] = [];
  const fallback = tunnelDnsFromProfile(tunnel as never, new Map(), none as never);
  assert.equal(fallback?.address, '10.184.100.5');
  assert.ok(none.some((f) => f.code === 'dynamic_resolver_uncaptured'));
  assert.ok(none.every((f) => f.severity === 'warning'), 'a tunnel not yet up must not refuse the whole plan');

  // Not marked dynamic: the operator stated an address and it is used regardless of what any peer says.
  const fixed = { ...tunnel, dns: { server: '10.9.9.9', domainSuffix: ['x'] } };
  const quiet: { code: string }[] = [];
  const stated = tunnelDnsFromProfile(fixed as never, new Map([['hq', '10.184.40.5']]), quiet as never);
  assert.equal(stated?.address, '10.9.9.9');
  assert.deepEqual(quiet, []);
});

test('the reader survives a directory that does not exist yet', async () => {
  // The normal state before any tunnel has connected: the up script creates the directory. An empty map
  // is the honest answer to "what have peers pushed so far", and the caller decides what to do about it.
  const { readCapturedResolvers } = await import('../src/platform/captured-resolvers.ts');
  const found = await readCapturedResolvers('/nonexistent/wayfarer/tunnel');
  assert.deepEqual([...found.entries()], []);
});

test('the reader takes the first address and ignores blank lines', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { readCapturedResolvers } = await import('../src/platform/captured-resolvers.ts');

  const dir = await mkdtemp(joinPath(tmpdir(), 'wf-resolvers-'));
  // The producer may write several, newline separated; the first is the one in use.
  await writeFile(joinPath(dir, 'hq.dns'), '10.184.40.5\n10.184.48.5\n');
  await writeFile(joinPath(dir, 'corp.dns'), '\n10.122.0.1\n');
  await writeFile(joinPath(dir, 'notes.txt'), 'ignored');

  const found = await readCapturedResolvers(dir);
  assert.equal(found.get('hq'), '10.184.40.5');
  assert.equal(found.get('corp'), '10.122.0.1');
  assert.equal(found.has('notes'), false, 'only .dns files are resolvers');
});

test('a watcher that cannot be installed reports that, rather than looking installed', async () => {
  // A dead watcher that still looks alive is the same defect as everything else in this file's catalogue
  // entry: a consumer that cannot say it is not consuming.
  //
  // It used to say so by returning `null`, and that turned out to be the wrong way to say it: the
  // caller read the answer once and the mechanism was then dead for the life of the process, on every
  // boot, because the directory is created by the up script *after* the daemon starts. So the handle
  // now exists, answers `watching()` honestly, and keeps looking. See `test/resolver-watch.test.ts`
  // for the retry itself; what this asserts is the half that must not change — it does not claim to
  // be watching something that is not there.
  const { watchCapturedResolvers } = await import('../src/platform/captured-resolvers.ts');
  const reasons: string[] = [];
  const handle = watchCapturedResolvers(() => {}, {
    directory: '/nonexistent/wayfarer/tunnel',
    onUnavailable: (reason) => reasons.push(reason),
  });
  try {
    assert.equal(handle.watching(), false);
    assert.equal(reasons.length, 1, 'nothing told the daemon it is not watching');
  } finally {
    handle.stop();
  }
});

/* ── a unit whose definition changed must be restarted, not merely reloaded ───────────────── */

/**
 * The device declared convergence while the running state differed from the declared one.
 *
 * Measured twice on the bench board, 2026-09-21: a changed unit file was written and reloaded, the unit
 * kept running the old definition, the apply reported `install wf-firewall.service` and success, and the
 * next plan reported `empty: true`. Both times the protection just added was absent until the unit was
 * restarted by hand — and both times the apply's own report said it had worked.
 *
 * A reload tells systemd the definition is new. It does not put the new definition into force for a unit
 * that is already running, so nothing the unit does at start-up — including every `ExecStartPost` — is
 * re-run.
 */
test('a unit whose own definition changed is restarted', async () => {
  const { diff } = await import('../src/core/differ.ts');
  const { emptyDesiredState, PATHS } = await import('../src/core/desired-state.ts');

  const unitPath = `${PATHS.unitDir}/wf-firewall.service`;
  const desired = emptyDesiredState();
  desired.files.push({
    path: unitPath,
    content: 'NEW',
    mode: 0o644,
    purpose: 'the firewall unit',
    // A unit file is read by systemd itself, not by one of our units. The restart must therefore come
    // from the unit's own definition having changed, which is the case this test exists for.
    consumedBy: { kind: 'external', by: 'systemd' },
  });
  desired.units.push({
    name: 'wf-firewall.service',
    enabled: true,
    active: true,
    purpose: 'firewall',
    content: 'NEW',
  });

  const plan = diff({
    desired,
    reality: {
      files: [{ path: unitPath, content: 'OLD' }],
      units: [{ name: 'wf-firewall.service', active: true, enabled: true, known: true }],
      interfaces: [],
      managementInterfaces: [],
      sysctl: {},
    } as never,
  });

  const actions = plan.unitChanges.filter((c) => c.name === 'wf-firewall.service').map((c) => c.action);
  assert.ok(actions.includes('install'), 'a changed definition still needs the reload');
  assert.ok(
    actions.includes('restart'),
    'a reload alone leaves the running unit on the old definition, and the plan then reports convergence',
  );
});

test('a restart is derived from what a file declares it feeds, not guessed from its path', async () => {
  // Every managed file already names its consumer. The old code ignored that and matched substrings, so a
  // file whose name did not happen to contain its unit's instance name never triggered a restart.
  const { diff } = await import('../src/core/differ.ts');
  const { emptyDesiredState } = await import('../src/core/desired-state.ts');

  const path = '/etc/wayfarer/somewhere/unrelated-name.conf';
  const desired = emptyDesiredState();
  desired.files.push({
    path,
    content: 'NEW',
    mode: 0o600,
    purpose: 'configuration for a unit whose name appears nowhere in this path',
    consumedBy: { kind: 'unit', unit: 'wf-openvpn@hq.service' },
  });
  desired.units.push({
    name: 'wf-openvpn@hq.service',
    enabled: true,
    active: true,
    purpose: 'hq',
  });

  const plan = diff({
    desired,
    reality: {
      files: [{ path, content: 'OLD' }],
      units: [{ name: 'wf-openvpn@hq.service', active: true, enabled: true, known: true }],
      interfaces: [],
      managementInterfaces: [],
      sysctl: {},
    } as never,
  });

  assert.ok(
    plan.unitChanges.some((c) => c.name === 'wf-openvpn@hq.service' && c.action === 'restart'),
    'the declaration says which unit reads this file; nothing else should have to be inferred',
  );
});
