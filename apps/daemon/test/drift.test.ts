/**
 * The drift check: does what is on this device match what the stored profile says?
 *
 * The failures it exists for, both measured on the bench board:
 *
 * * 2026-09-22 — `profile.firewall.blockedEndpoints` held six entries while
 *   `/etc/wayfarer/core/config.json` held none, and the only way to learn it was to read the file and
 *   the database by hand.
 * * 2026-09-21 — the core kept asking `10.184.40.5` while the daemon had captured `10.184.100.5`.
 *   `wplan.hq.lan` stopped resolving for every client, the tunnel was healthy throughout, and
 *   nothing reported the mismatch.
 *
 * The last test in this file is the one that matters most, and it is the reason for the others: it
 * writes the generated configuration to a real directory, **edits one value out from under the
 * daemon**, and asserts the check goes red naming that exact pointer and both values — then restores
 * the byte and asserts it goes green again. A check that has never once fired is unproven, not
 * healthy.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import {
  checkDrift,
  compareRunningState,
  createDriftMonitor,
  summarise,
  valueAt,
  type DriftFinding,
} from '../src/core/drift.ts';
import { diff, type Reality } from '../src/core/differ.ts';
import { ruleSetAgesFor, type RuleSetAge } from '../src/core/rule-set-age.ts';
import { emptyDesiredState, PATHS, type DesiredState, type ManagedFile } from '../src/core/desired-state.ts';
import type { PipelineContext } from '../src/core/pipeline.ts';
import type { Platform } from '../src/platform/index.ts';
import type { ProfileStore } from '../src/state/profiles.ts';
import type { Store } from '../src/state/store.ts';
import { builtInAndDongle, cleanFacts } from './helpers/synthetic-inventory.ts';
import { CONFLICTING_STOCK_UNITS } from '../src/platform/stock-units.ts';

const CORE = PATHS.coreConfig;

function managed(path: string, content: string, overrides: Partial<ManagedFile> = {}): ManagedFile {
  return {
    path,
    content,
    mode: 0o600,
    purpose: 'the thing this file is for',
    consumedBy: { kind: 'unit', unit: 'wf-core.service' },
    ...overrides,
  };
}

function desiredWith(files: ManagedFile[], units: DesiredState['units'] = []): DesiredState {
  const desired = emptyDesiredState();
  desired.files.push(...files);
  desired.units.push(...units);
  return desired;
}

function realityWith(overrides: Partial<Reality>): Reality {
  return {
    files: [],
    units: [],
    interfaces: [],
    managementInterfaces: ['end0'],
    sysctl: {},
    ...overrides,
  };
}

/** The comparison over the real differ, so no test asserts against a second classification engine. */
function compare(desired: DesiredState, reality: Reality): { findings: DriftFinding[]; omitted: number } {
  return compareRunningState({
    desired,
    reality,
    classified: diff({ desired, reality }),
    planUsable: true,
  });
}

/* ── the pure comparison ─────────────────────────────────────────────────────────────────── */

test('a device holding exactly what the profile derives reports nothing', () => {
  const desired = desiredWith([managed(CORE, '{"a":1}')]);
  const result = compare(desired, realityWith({ files: [{ path: CORE, content: '{"a":1}', mode: 0o600 }] }));
  assert.deepEqual(result.findings, []);
  assert.equal(result.omitted, 0);
});

test('a JSON file that differs names the pointer inside it and both values', () => {
  // The resolver case, in the shape it was measured in: the core asking the address the peer used to
  // hand out, while the profile derives the one it hands out now.
  const stored = JSON.stringify({ dns: { servers: [{ tag: 'hq', server: '10.184.100.5' }] } });
  const running = JSON.stringify({ dns: { servers: [{ tag: 'hq', server: '10.184.40.5' }] } });
  const result = compare(desiredWith([managed(CORE, stored)]), realityWith({ files: [{ path: CORE, content: running, mode: 0o600 }] }));

  assert.equal(result.findings.length, 1);
  const finding = result.findings[0]!;
  assert.equal(finding.severity, 'error');
  assert.equal(finding.kind, 'file-content');
  assert.equal(finding.subject, CORE);
  assert.equal(finding.pointer, '/dns/servers/0/server');
  assert.equal(finding.stored, '"10.184.100.5"');
  assert.equal(finding.running, '"10.184.40.5"');
  // Both values in the sentence, not only in the fields: the event ring shows summaries.
  assert.match(finding.message, /10\.184\.100\.5/);
  assert.match(finding.message, /10\.184\.40\.5/);
});

test('an exclusion that names a subnet the tunnel has left is named as a pointer, not as "the file differs"', () => {
  // Found in passing on 2026-09-22: `route_exclude_address` still listed `10.164.0.0/20`, a subnet the
  // hq tunnel occupied that morning and left for `10.165.0.0/20`.
  const stored = JSON.stringify({ inbounds: [{ route_exclude_address: ['10.44.0.0/24', '10.165.0.0/20'] }] });
  const running = JSON.stringify({ inbounds: [{ route_exclude_address: ['10.44.0.0/24', '10.164.0.0/20'] }] });
  const result = compare(desiredWith([managed(CORE, stored)]), realityWith({ files: [{ path: CORE, content: running, mode: 0o600 }] }));

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.pointer, '/inbounds/0/route_exclude_address/1');
  assert.equal(result.findings[0]!.stored, '"10.165.0.0/20"');
  assert.equal(result.findings[0]!.running, '"10.164.0.0/20"');
});

test('a value the profile derives and the device does not hold at all reads as "nothing there"', () => {
  const stored = JSON.stringify({ route: { rules: [{ domain: ['a.example'] }] } });
  const running = JSON.stringify({ route: { rules: [] } });
  const result = compare(desiredWith([managed(CORE, stored)]), realityWith({ files: [{ path: CORE, content: running, mode: 0o600 }] }));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.running, null);
  assert.match(result.findings[0]!.message, /nothing there/);
});

test('a file the profile derives and the device does not have is a divergence, not an absence of evidence', () => {
  const result = compare(desiredWith([managed(CORE, '{"a":1}')]), realityWith({ files: [{ path: CORE, content: null, mode: null }] }));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.kind, 'file-missing');
  assert.equal(result.findings[0]!.running, null);
});

test('a path nobody read back is reported rather than passed over', () => {
  // Three-valued, exactly as the boot guard and the confirmation window are: "I could not look" is
  // not "it is fine". Here the path is simply absent from the reading.
  const result = compare(desiredWith([managed(CORE, '{"a":1}')]), realityWith({ files: [] }));
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0]!.message, /was not read back/);
});

test('the right content with the wrong permissions is its own finding, with both modes', () => {
  const result = compare(
    desiredWith([managed(CORE, '{"a":1}', { mode: 0o600 })]),
    realityWith({ files: [{ path: CORE, content: '{"a":1}', mode: 0o644 }] }),
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.kind, 'file-mode');
  assert.equal(result.findings[0]!.stored, '0o600');
  assert.equal(result.findings[0]!.running, '0o644');
});

test('a divergence at a credential says that it differs and never what it is', () => {
  /*
   * **Every value here is invented.**
   *
   * A drift finding is served by `GET /api/drift`, drawn on the Status screen and written into the
   * persisted event ring. The generated core configuration holds real credentials in clear by
   * necessity — a proxy's `password`, a VLESS account's `uuid` — so a finding that prints both sides
   * of a differing pointer publishes the credential to all three and writes it to disk in a table
   * nothing redacts. There was no test for this and the check did exactly that.
   *
   * The finding keeps what an operator needs — the file, the pointer, that the two disagree — and
   * loses only the one thing a log must not carry.
   */
  const stored = JSON.stringify({
    outbounds: [
      { type: 'socks', server: 'proxy.example.invalid', server_port: 1080, username: 'u', password: 'invented-stored' },
      { type: 'vless', server: 'v.example.invalid', uuid: 'invented-stored-uuid' },
    ],
  });
  const running = JSON.stringify({
    outbounds: [
      { type: 'socks', server: 'proxy.example.invalid', server_port: 1080, username: 'u', password: 'invented-running' },
      { type: 'vless', server: 'v.example.invalid', uuid: 'invented-running-uuid' },
    ],
  });

  const result = compare(
    desiredWith([managed(CORE, stored)]),
    realityWith({ files: [{ path: CORE, content: running, mode: 0o600 }] }),
  );

  assert.equal(result.findings.length, 2, 'both credentials differ, and both are reported as differing');
  const printed = JSON.stringify(result.findings);
  for (const value of ['invented-stored', 'invented-running', 'invented-stored-uuid', 'invented-running-uuid']) {
    assert.equal(printed.includes(value), false, `the finding must not carry ${value}`);
  }
  // It is still actionable: the file, the pointer, and the fact that the two sides disagree.
  const password = result.findings.find((finding) => finding.pointer === '/outbounds/0/password');
  assert.ok(password !== undefined, `expected a finding at the password pointer, got ${result.findings.map((f) => f.pointer).join(', ')}`);
  assert.equal(password.subject, CORE);
  assert.equal(password.stored, 'a credential, withheld');
  assert.equal(password.running, 'a credential, withheld');
  assert.ok(result.findings.some((finding) => finding.pointer === '/outbounds/1/uuid'));

  // And an ordinary value at the same file is still named on both sides, or the check loses its point.
  const ordinary = compare(
    desiredWith([managed(CORE, JSON.stringify({ outbounds: [{ server_port: 1080 }] }))]),
    realityWith({ files: [{ path: CORE, content: JSON.stringify({ outbounds: [{ server_port: 8080 }] }), mode: 0o600 }] }),
  );
  assert.equal(ordinary.findings[0]!.stored, '1080');
  assert.equal(ordinary.findings[0]!.running, '8080');
});

test('a stale rule set is told to look where that kind of set actually comes from', () => {
  /*
   * A hint is an instruction, and a confidently wrong instruction costs more than none because it
   * is followed. Neither branch of the first version looked at the kind of set, so a `local` set —
   * a file sitting on this device — sent the operator to check an uplink and a URL it does not
   * have.
   */
  const age = (over: Partial<RuleSetAge>): RuleSetAge => ({
    tag: 'trackers',
    type: 'local',
    state: 'overdue',
    ageSeconds: 9_000_000,
    ageLabel: '104d',
    intervalHours: 24,
    overdueAfterSeconds: 259_200,
    observedFrom: '/etc/wayfarer/rule-sets/trackers.json',
    exact: true,
    summary: 'refreshed 104d ago',
    ...over,
  });

  const local = compareRunningState({
    desired: emptyDesiredState(),
    reality: realityWith({}),
    classified: diff({ desired: emptyDesiredState(), reality: realityWith({}) }),
    planUsable: true,
    ruleSets: [age({})],
  }).findings[0]!;
  assert.equal(local.kind, 'rule-set-stale');
  assert.match(local.hint, /\/etc\/wayfarer\/rule-sets\/trackers\.json/);
  assert.equal(/uplink|URL|fetched from/.test(local.hint), false, 'a file on this device is not a network fault');

  const remote = compareRunningState({
    desired: emptyDesiredState(),
    reality: realityWith({}),
    classified: diff({ desired: emptyDesiredState(), reality: realityWith({}) }),
    planUsable: true,
    ruleSets: [age({ type: 'remote', tag: 'geoip-ru', exact: false, observedFrom: '/var/lib/wayfarer/core-cache.db' })],
  }).findings[0]!;
  assert.match(remote.hint, /uplink and the URL/, 'a fetched set is a network and a URL');
});

test('a file that is not JSON is reported at the first differing line, with its number', () => {
  const stored = 'interface=wlan0\nchannel=36\nssid=Wayfarer\n';
  const running = 'interface=wlan0\nchannel=149\nssid=Wayfarer\n';
  const path = `${PATHS.hostapdDir}/wfap0.conf`;
  const result = compare(
    desiredWith([managed(path, stored, { consumedBy: { kind: 'unit', unit: 'wf-hostapd@wfap0.service' } })]),
    realityWith({ files: [{ path, content: running, mode: 0o600 }] }),
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.pointer, null, 'a line number is not a JSON Pointer and must not pretend to be one');
  assert.match(result.findings[0]!.message, /line 2/);
  assert.equal(result.findings[0]!.stored, 'channel=36');
  assert.equal(result.findings[0]!.running, 'channel=149');
});

test('a unit the profile wants running and systemd has never heard of is named as unknown, not as stopped', () => {
  const desired = desiredWith(
    [],
    [{ name: 'wf-core.service', enabled: true, active: true, content: 'a unit', purpose: 'the proxy core' }],
  );
  const result = compare(desired, realityWith({ units: [{ name: 'wf-core.service', active: false, enabled: false, known: false }] }));
  const kinds = result.findings.map((finding) => finding.kind);
  assert.ok(kinds.includes('unit-unknown'), `expected unit-unknown, got ${kinds.join(', ')}`);
  assert.ok(!kinds.includes('unit-stopped'), 'a unit systemd does not know is a different fault from one that stopped');
});

test('a unit that is running from a file that has since changed says which file', () => {
  const desired = desiredWith(
    [managed(CORE, '{"a":2}')],
    [{ name: 'wf-core.service', enabled: true, active: true, purpose: 'the proxy core' }],
  );
  const reality = realityWith({
    files: [{ path: CORE, content: '{"a":1}', mode: 0o600 }],
    units: [{ name: 'wf-core.service', active: true, enabled: true, known: true }],
  });
  const result = compare(desired, reality);
  const stale = result.findings.find((finding) => finding.kind === 'unit-stale');
  assert.ok(stale !== undefined, 'a running unit whose configuration changed underneath it is a divergence');
  assert.deepEqual(stale.becauseOf, [CORE], 'the differ already knows which file; the finding carries it rather than re-deriving it');
});

test('a unit this project owns that the profile no longer asks for is reported as extra', () => {
  const result = compare(
    desiredWith([]),
    realityWith({
      units: [{ name: 'wf-socks@viaobfs.service', active: true, enabled: true, known: true }],
      ownedUnits: ['wf-socks@viaobfs.service'],
    }),
  );
  const extra = result.findings.filter((finding) => finding.kind === 'unit-extra');
  assert.equal(extra.length, 1);
  assert.equal(extra[0]!.subject, 'wf-socks@viaobfs.service');
  assert.equal(extra[0]!.running, 'active');
});

test('a kernel setting that differs carries both values', () => {
  const desired = emptyDesiredState();
  desired.sysctl.push({ key: 'net.ipv4.ip_forward', value: '1', reason: 'this device routes for its clients' });
  const result = compare(desired, realityWith({ sysctl: { 'net.ipv4.ip_forward': '0' } }));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.kind, 'sysctl');
  assert.equal(result.findings[0]!.stored, '1');
  assert.equal(result.findings[0]!.running, '0');
});

test('a stored profile that cannot be planned is reported, and nothing else is compared', () => {
  // A desired state built from an unusable plan is not a statement about what should be running, and
  // naming values nobody chose would send somebody to fix a file that is a symptom.
  const result = compareRunningState({
    desired: desiredWith([managed(CORE, '{"a":1}')]),
    reality: realityWith({ files: [{ path: CORE, content: null, mode: null }] }),
    classified: diff({ desired: desiredWith([managed(CORE, '{"a":1}')]), reality: realityWith({}) }),
    planUsable: false,
    planError: { pointer: '/accessPoint/radio/channel', message: 'channel 149 is not offered in DE' },
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.kind, 'unplannable');
  assert.equal(result.findings[0]!.pointer, '/accessPoint/radio/channel');
});

test('a report is capped, and says how many it left out', () => {
  const files = Array.from({ length: 60 }, (_, index) => managed(`/etc/wayfarer/f${index}.conf`, 'x'));
  const result = compare(
    desiredWith(files),
    realityWith({ files: files.map((file) => ({ path: file.path, content: null, mode: null })) }),
  );
  assert.equal(result.findings.length, 40);
  assert.equal(result.omitted, 20);
});

test('a JSON Pointer with an escaped segment resolves to the value it names', () => {
  assert.equal(valueAt({ 'a/b': { '~c': 3 } }, '/a~1b/~0c'), 3);
  assert.deepEqual(valueAt({ a: 1 }, '/'), { a: 1 });
  assert.equal(valueAt({ a: 1 }, '/missing'), undefined);
});

/* ── the check, over a store and a pipeline ──────────────────────────────────────────────── */

const CORE_SCHEMA = readFileSync(
  `${dirname(fileURLToPath(import.meta.url))}/../../../packages/protocols/test/fixtures/core-schema-sing-box-1.14.0.json`,
  'utf8',
);

/**
 * A device whose configuration directory is a real directory.
 *
 * The files are written and read through the filesystem rather than through a map, because the
 * mutation this file has to prove is *editing a generated file out from under the daemon* — and a
 * stand-in that holds content in memory cannot be edited from outside, so the proof would be of the
 * harness rather than of the check.
 */
async function bench(
  options: {
    capturedResolver?: string;
    ruleSets?: boolean;
    /** The networks on the device's interfaces, in the order the kernel lists them. Mutable, like a device. */
    networks?: { current: string[] };
  } = {},
): Promise<{
  root: string;
  deps: { store: Store; profiles: ProfileStore; pipeline: PipelineContext };
  document: ProfileDocument;
  /** Writes every file the plan derives, and marks every unit it wants as running. An "apply". */
  converge: () => Promise<void>;
  /** The absolute path this bench holds `path` at. */
  on: (path: string) => string;
  events: { level: string; kind: string; summary: string }[];
  /**
   * The distribution's conflicting units, as systemd would report them. Masked by default, which is
   * what the installer leaves; a test unmasks one the way somebody at the console would.
   */
  stock: Map<string, { unitFileState: string; activeState: string }>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-drift-'));
  const on = (path: string): string => join(root, path);
  const units = new Map<string, { active: boolean; enabled: boolean }>();
  /** What the kernel currently holds. Empty until this bench converges, exactly like a fresh board. */
  const sysctl = new Map<string, string>();
  const events: { level: string; kind: string; summary: string }[] = [];

  const inventory = builtInAndDongle();
  const document = profileForBench(options.ruleSets === true);

  const stock = new Map(
    CONFLICTING_STOCK_UNITS.map((entry) => [entry.unit, { unitFileState: 'masked', activeState: 'inactive' }]),
  );

  const platform = {
    binaries: { coreSchema: async () => ({ schema: CORE_SCHEMA, cacheKey: 'test', fromCache: true }) },
    // Only the stock units: every unit the plan names is read through `reality` below, as in production.
    systemd: {
      state: async (unit: string) => {
        const entry = stock.get(unit);
        return {
          unit,
          activeState: entry?.activeState ?? 'inactive',
          subState: null,
          unitFileState: entry?.unitFileState ?? null,
          loadState: entry === undefined ? 'not-found' : entry.unitFileState === 'masked' ? 'masked' : 'loaded',
          isActive: entry?.activeState === 'active',
          isEnabled: entry?.unitFileState === 'enabled',
          known: entry !== undefined,
        };
      },
    },
  } as unknown as Platform;

  const pipeline: PipelineContext = {
    platform,
    inventory: async () => inventory,
    facts: async () =>
      options.networks === undefined
        ? cleanFacts()
        : {
            ...cleanFacts(),
            uplinkNetworks: options.networks.current.map((cidr, index) => ({ interface: `if${String(index)}`, cidr })),
          },
    reality: async (paths, unitNames, sysctlKeys) => ({
      files: await Promise.all(
        paths.map(async (path) => {
          const content = await readFile(on(path), 'utf8').catch(() => null);
          // The mode is read off the file rather than assumed. A bench that answered a constant here
          // would report every file as mis-permissioned, or — worse — never as mis-permissioned.
          const mode = await stat(on(path))
            .then((entry) => entry.mode & 0o777)
            .catch(() => null);
          return { path, content, mode };
        }),
      ),
      units: unitNames.map((name) => ({
        name,
        active: units.get(name)?.active ?? false,
        enabled: units.get(name)?.enabled ?? false,
        known: units.has(name),
      })),
      interfaces: inventory.interfaces.map((entry) => ({ name: entry.name, mac: entry.mac })),
      managementInterfaces: ['end0'],
      sysctl: Object.fromEntries(sysctlKeys.map((key) => [key, sysctl.get(key) ?? '0'])),
      ownedUnits: [...units.keys()],
    }),
    managementPort: 8088,
    timePorts: [123],
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
    ...(options.capturedResolver === undefined
      ? {}
      : { capturedResolvers: async () => new Map([['res-hq', options.capturedResolver!]]) }),
  };

  const store = {
    device: () => ({ activeProfileId: 'p1' }),
    recordEvent: (event: { level: string; kind: string; summary: string }) => {
      events.push({ level: event.level, kind: event.kind, summary: event.summary });
      return event;
    },
  } as unknown as Store;

  const profiles = {
    get: (id: string) => (id === 'p1' ? { document } : null),
  } as unknown as ProfileStore;

  const converge = async (): Promise<void> => {
    const { planDocument } = await import('../src/core/pipeline.ts');
    const planned = await planDocument(pipeline, document);
    assert.equal(planned.plan.usable, true, 'the bench profile must be plannable, or this bench proves nothing');
    for (const file of [...planned.plan.desired.files, ...planned.plan.desired.networkFiles]) {
      await mkdir(dirname(on(file.path)), { recursive: true });
      await writeFile(on(file.path), file.content, 'utf8');
      // `writeFile`'s mode applies only when it creates the file, so the permission is set explicitly:
      // otherwise the second convergence of the same bench leaves the umask's mode in place.
      await chmod(on(file.path), file.mode);
    }
    for (const unit of planned.plan.desired.units) {
      if (unit.name.includes('@.')) continue;
      units.set(unit.name, { active: unit.active, enabled: unit.enabled });
    }
    for (const setting of planned.plan.desired.sysctl) sysctl.set(setting.key, setting.value);
  };

  return { root, deps: { store, profiles, pipeline }, document, converge, on, events, stock };
}

/** The bench profile: tunnels, routing rules, a kill switch and blocked endpoints. */
function profileForBench(withRuleSets = false): ProfileDocument {
  const base = emptyProfile({ name: 'Bench', now: () => '2026-09-22T00:00:00.000Z' }) as ProfileDocument;
  return {
    ...base,
    /*
     * Off by default, so the rule-set age is a thing one test asks for rather than a fourth
     * comparison every other test in this file silently runs.
     */
    ...(withRuleSets
      ? {
          routing: {
            ...base.routing,
            rules: [
              ...base.routing.rules,
              { kind: 'ruleSet' as const, sets: ['geoip-ru'], action: { outbound: 'res-hq' } },
            ],
            ruleSets: [
              {
                tag: 'geoip-ru',
                type: 'remote' as const,
                url: 'https://example.invalid/geoip-ru.srs',
                format: 'binary' as const,
                updateIntervalHours: 24,
              },
              // Pointed at by nothing, deliberately: a set no rule names must never become a finding,
              // however old it is, or the report fills with things nobody can act on.
              {
                tag: 'geosite-unused',
                type: 'remote' as const,
                url: 'https://example.invalid/geosite-unused.srs',
                format: 'binary' as const,
                updateIntervalHours: 1,
              },
            ],
          },
        }
      : {}),
    uplinks: [
      { id: 'wan-eth', kind: 'ethernet', priority: 10, enabled: true, bind: { by: 'any-ethernet' }, config: { dhcp: true } },
    ],
    tunnels: [
      {
        id: 'res-hq',
        name: 'HQ',
        role: 'resource',
        onUnavailable: 'block',
        enabled: true,
        protocol: 'openvpn',
        config: { profile: 'client\ndev tun\nremote hq.example.net 1194\n', interfaceSuffix: '0' },
        resources: { domainSuffix: ['.hq.example'], ipCidr: ['10.0.0.0/8'] },
        dns: { server: '10.184.100.5', dynamic: true, domainSuffix: ['.hq.example'] },
      },
    ],
    firewall: {
      killSwitch: true,
      ipv6: 'block',
      ntpBypass: true,
      blockedEndpoints: [{ ipCidr: '198.51.100.0/24', ports: [3478], protocol: 'udp', note: 'address discovery' }],
    },
  } as ProfileDocument;
}

test('a device with no active profile says so, rather than reporting that nothing diverged', async () => {
  const { deps } = await bench();
  const withoutProfile = { ...deps, store: { ...deps.store, device: () => ({ activeProfileId: null }) } as unknown as Store };
  const report = await checkDrift(withoutProfile, 'test');
  assert.equal(report.state, 'no-profile');
  assert.deepEqual(report.findings, []);
  assert.match(summarise(report), /nothing this device is supposed to be running/);
});

test('a check that could not be made is "unreadable", never "converged"', async () => {
  const { deps } = await bench();
  const broken: PipelineContext = {
    ...deps.pipeline,
    inventory: async () => {
      throw new Error('the driver did not answer');
    },
  };
  const report = await checkDrift({ ...deps, pipeline: broken }, 'test');
  assert.equal(report.state, 'unreadable');
  assert.match(report.error ?? '', /the driver did not answer/);
  assert.notEqual(report.state, 'converged');
});

test('a device that has had nothing written to it is diverged in every generated file', async () => {
  const { deps } = await bench();
  const report = await checkDrift(deps, 'test');
  assert.equal(report.state, 'diverged');
  assert.ok(report.checked.files > 0, 'a report must say what it looked at');
  assert.ok(report.findings.some((finding) => finding.kind === 'file-missing'));
});

/* ── the monitor: the event ring, and not filling it ─────────────────────────────────────── */

function monotonic(): { now: () => number; advance: (ms: number) => void } {
  let value = 0;
  return { now: () => value, advance: (ms) => void (value += ms) };
}

test('the monitor has no opinion before it has run once, and null is not "converged"', async () => {
  const { deps } = await bench();
  const monitor = createDriftMonitor(deps);
  assert.equal(monitor.last(), null);
  assert.equal(monitor.ageSeconds(), null);
});

test('a divergence is recorded once, and an unchanged second round adds nothing to the ring', async () => {
  const { deps, events } = await bench();
  const monitor = createDriftMonitor(deps);
  await monitor.run('boot');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.level, 'error');
  assert.equal(events[0]!.kind, 'config.diverged');

  await monitor.run('periodic');
  assert.equal(
    events.length,
    1,
    'a device left diverged — the normal state after a revert — must not write the same entry every round ' +
      'until the ring holds nothing else',
  );
});

test('the ring learns when the divergence changes, and when it is resolved', async () => {
  const { deps, events, converge } = await bench();
  const monitor = createDriftMonitor(deps);
  await monitor.run('boot');
  assert.equal(events.length, 1);

  await converge();
  await monitor.run('periodic');
  assert.equal(events.length, 2);
  assert.equal(events[1]!.kind, 'config.converged');
  assert.equal(monitor.last()?.state, 'converged');
});

test('the age of a report comes from the monotonic clock, never from the wall clock', async () => {
  const { deps } = await bench();
  const clock = monotonic();
  const monitor = createDriftMonitor({ ...deps, monotonicMs: clock.now });
  await monitor.run('boot');
  assert.equal(monitor.ageSeconds(), 0);
  clock.advance(90_000);
  assert.equal(monitor.ageSeconds(), 90, 'this board has no clock battery: a wall-clock step must not move this');
});

test('a monitor whose event ring throws still returns a report, and the report is not healthy', async () => {
  const { deps } = await bench();
  const exploding = {
    ...deps,
    store: {
      ...deps.store,
      device: deps.store.device.bind(deps.store),
      recordEvent: () => {
        throw new Error('the database is locked');
      },
    } as unknown as Store,
  };
  const report = await createDriftMonitor(exploding).run('after-revert');
  assert.equal(report.state, 'unreadable');
  assert.match(report.error ?? '', /the database is locked/);
});

test('an entry that could not be written is written on the next round, not treated as told', async () => {
  // The answer is marked as reported only after the write succeeds. Marking it first means one failed
  // write costs one silent divergence for as long as the divergence lasts, which is for ever.
  const { deps } = await bench();
  const written: string[] = [];
  let refuseOnce = true;
  const flaky = {
    ...deps,
    store: {
      device: () => deps.store.device(),
      recordEvent: (event: { kind: string }) => {
        if (refuseOnce) {
          refuseOnce = false;
          throw new Error('the database is locked');
        }
        written.push(event.kind);
        return event;
      },
    } as unknown as Store,
  };
  const monitor = createDriftMonitor(flaky);

  const first = await monitor.run('boot');
  assert.equal(first.state, 'unreadable', 'a round whose entry could not be written is not a healthy round');
  assert.deepEqual(written, []);

  const second = await monitor.run('periodic');
  assert.equal(second.state, 'diverged');
  assert.deepEqual(written, ['config.diverged'], 'the same divergence must still reach the ring on the next round');
});

/* ── the proof: it can fire, and it fires on the right thing ─────────────────────────────── */

/**
 * Substitutes `from` for `to` in a file, **after asserting the anchor is present and unique**.
 *
 * The catalogue's rule, and the reason it is a rule: a mutation that does not apply produces a green
 * run reporting on unmutated code, which proves exactly as much as a guard that cannot fire. An
 * absent or ambiguous anchor aborts the test rather than producing a result.
 */
async function substitute(path: string, from: string, to: string): Promise<string> {
  const before = await readFile(path, 'utf8');
  const occurrences = before.split(from).length - 1;
  assert.equal(occurrences, 1, `the anchor ${JSON.stringify(from)} must appear exactly once in ${path}, found ${occurrences}`);
  await writeFile(path, before.replace(from, to), 'utf8');
  const after = await readFile(path, 'utf8');
  assert.notEqual(after, before, 'the substitution did not change the file, so nothing below is evidence');
  return before;
}

test('editing a generated file out from under the daemon turns the check red, naming the pointer and both values', async () => {
  const { deps, converge, on } = await bench();
  await converge();

  // Green first, or the red below proves nothing: a check that is red before the mutation is red for
  // a reason this test did not create.
  const before = await checkDrift(deps, 'test');
  assert.equal(before.state, 'converged', `expected a converged device, got: ${summarise(before)}`);
  assert.equal(before.findings.length, 0);

  const corePath = on(CORE);
  const original = await substitute(corePath, '"10.184.100.5"', '"10.184.40.5"');

  const red = await checkDrift(deps, 'test');
  assert.equal(red.state, 'diverged');
  const finding = red.findings.find((entry) => entry.subject === CORE);
  assert.ok(finding !== undefined, `expected a finding about ${CORE}, got ${red.findings.map((f) => f.subject).join(', ')}`);
  assert.equal(finding.stored, '"10.184.100.5"', 'the value the stored profile derives');
  assert.equal(finding.running, '"10.184.40.5"', 'the value this device actually holds');
  assert.ok(finding.pointer !== null && finding.pointer.length > 1, 'the finding must name where inside the file');
  assert.match(finding.message, /10\.184\.100\.5/);
  assert.match(finding.message, /10\.184\.40\.5/);

  // And it says the same thing in the one sentence an event ring carries.
  assert.match(summarise(red), /not running its stored profile/);

  await writeFile(corePath, original, 'utf8');
  const green = await checkDrift(deps, 'test');
  assert.equal(green.state, 'converged', `expected the restored device to be converged, got: ${summarise(green)}`);
  assert.equal(green.findings.length, 0);
});

/**
 * The rule-set age, proved the same way: make it old, watch it go red, restore it, watch it go green.
 *
 * Only the two leaves that reach the operating system are faked — a file's modification time and the
 * time service's verdict on the clock. The composition that decides *which* file answers for which
 * kind of set, and the arithmetic that decides what is too old, are the shipped ones.
 */
test('a rule set that has stopped being refreshed turns the check red and names the set', async () => {
  const { deps, converge } = await bench({ ruleSets: true });
  await converge();

  const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
  const DAY = 24 * 3600 * 1000;
  // The interval the bench profile states is 24h, so the finding is due after three of them.
  let cacheModifiedMs: number | null = NOW - DAY;
  let readFails: string | null = null;
  let synchronised: boolean | null = true;

  /*
   * Only the two leaves that reach the operating system are replaced. The selection of which sets
   * are in use, the choice of which file answers for which kind of set, and the arithmetic are all
   * the shipped ones — `ruleSetAgesFor` is what the daemon itself calls.
   */
  const withReading = {
    ...deps,
    ruleSetAges: (document: ProfileDocument) =>
      ruleSetAgesFor(document, {
        modifiedMs: async (path: string) => {
          if (readFails !== null) throw new Error(readFails);
          return path === PATHS.coreCache ? cacheModifiedMs : null;
        },
        clockSynchronized: async () => synchronised,
        nowMs: () => NOW,
        notBeforeMs: async () => NOW - 3650 * DAY,
      }),
  };

  // Green first, or the red below proves nothing.
  const fresh = await checkDrift(withReading, 'test');
  assert.equal(fresh.state, 'converged', `expected a converged device, got: ${summarise(fresh)}`);

  // Four days: past three missed refreshes of twenty-four hours.
  cacheModifiedMs = NOW - 4 * DAY;
  const red = await checkDrift(withReading, 'test');
  assert.equal(red.state, 'diverged');
  const finding = red.findings.find((entry) => entry.kind === 'rule-set-stale');
  assert.ok(finding !== undefined, `expected a rule-set finding, got ${red.findings.map((f) => f.kind).join(', ')}`);
  assert.equal(finding.subject, 'rule set "geoip-ru"', 'the finding names the set, in the word the owner typed');
  assert.equal(finding.stored, 'refreshed every 24h');
  assert.match(finding.running ?? '', /at least 4d old/);
  // A remote figure is a lower bound, and the finding says so rather than sounding like a measurement.
  assert.match(finding.running ?? '', /may be far older/);
  assert.match(finding.hint, /uplink and the URL/);
  assert.match(finding.message, /leaving by the ordinary route while everything looks healthy/);

  /*
   * And the set nothing points at is **not** in the report, although it is far older against a
   * one-hour interval. A finding about a list no rule reads is a finding nobody can act on.
   */
  assert.equal(
    red.findings.some((entry) => entry.subject.includes('geosite-unused')),
    false,
    'a rule set no rule points at must not become a finding',
  );

  // Restored, and the check goes green again — the property that separates a check from an alarm.
  cacheModifiedMs = NOW - DAY;
  const green = await checkDrift(withReading, 'test');
  assert.equal(green.state, 'converged', `expected the refreshed device to be converged, got: ${summarise(green)}`);

  /*
   * The clock, which is the part that has to be argued. The file is just as old as it was when the
   * check was red, and with an unsynchronised clock no number is produced and **no finding is
   * raised**: an age computed across a clock step is worse than no age, and an error nobody can act
   * on teaches people to ignore errors.
   */
  cacheModifiedMs = NOW - 4 * DAY;
  synchronised = false;
  const unmeasured = await checkDrift(withReading, 'test');
  assert.equal(unmeasured.state, 'converged', 'an unsynchronised clock is not a divergence');
  assert.equal(unmeasured.findings.some((entry) => entry.kind === 'rule-set-stale'), false);

  // A reading that failed is a third answer and not a quiet `false`, and it computes just as little.
  synchronised = null;
  const unread = await checkDrift(withReading, 'test');
  assert.equal(unread.findings.some((entry) => entry.kind === 'rule-set-stale'), false);

  /*
   * No cache file at all: nothing has ever been downloaded, so the rules pointing at the set match
   * nothing. That is the failure in its loudest form and it is reported whatever the clock says.
   */
  synchronised = false;
  cacheModifiedMs = null;
  const never = await checkDrift(withReading, 'test');
  const missing = never.findings.find((entry) => entry.kind === 'rule-set-stale');
  assert.ok(missing !== undefined, 'a set with no copy on this device must be reported');
  assert.match(missing.running ?? '', /never fetched/);
  assert.match(missing.hint, /reach the URL/, 'a remote set that never arrived is a network or a URL');

  /*
   * **A read that failed is not an observed absence**, and the hint is the proof: the operator must
   * be sent to a permission on this device, not to an uplink. The first version flattened every
   * error into `null` and reported an unreadable cache as *never fetched*.
   */
  cacheModifiedMs = NOW - DAY;
  readFails = 'EACCES: permission denied, stat';
  const blind = await checkDrift(withReading, 'test');
  const unreadable = blind.findings.find((entry) => entry.kind === 'rule-set-stale');
  assert.ok(unreadable !== undefined, '"I could not look" must never render as "there is nothing wrong"');
  assert.match(unreadable.running ?? '', /could not read the file/);
  assert.match(unreadable.hint, /permissions/);
  assert.equal(/uplink|URL/.test(unreadable.hint), false, 'a local fault must not send somebody to the network');
  readFails = null;

  /*
   * The clock jump that lands. The file is stamped before this software existed — what a board with
   * no RTC battery writes when it refreshes a set before NTP has landed — and the clock is
   * synchronised by the time anybody looks. No age, and no finding, rather than *"11574d ago"*.
   */
  synchronised = true;
  cacheModifiedMs = 0;
  const bogus = await checkDrift(withReading, 'test');
  assert.equal(bogus.state, 'converged', 'a clock-damaged timestamp is not evidence that a list is stale');
  assert.equal(bogus.findings.some((entry) => entry.kind === 'rule-set-stale'), false);
});

test('a unit stopped out from under the daemon turns the check red and names the unit', async () => {
  const { deps, converge } = await bench();
  await converge();
  assert.equal((await checkDrift(deps, 'test')).state, 'converged');

  // Reaching into the bench's systemd the way something outside the daemon would: the unit is still
  // known, and it is no longer running.
  const reality = deps.pipeline.reality;
  const stopped: PipelineContext = {
    ...deps.pipeline,
    reality: async (paths, units, keys) => {
      const read = await reality(paths, units, keys);
      return {
        ...read,
        units: read.units.map((unit) => (unit.name === 'wf-core.service' ? { ...unit, active: false } : unit)),
      };
    },
  };
  const red = await checkDrift({ ...deps, pipeline: stopped }, 'test');
  assert.equal(red.state, 'diverged');
  const finding = red.findings.find((entry) => entry.subject === 'wf-core.service');
  assert.ok(finding !== undefined, `expected a finding about wf-core.service, got ${red.findings.map((f) => f.subject).join(', ')}`);
  assert.equal(finding.kind, 'unit-stopped');
  assert.equal(finding.running, 'inactive');
});

test('a stock unit the installer masked, unmasked and started, turns the check red; masked again, green', async () => {
  const { deps, converge, stock } = await bench();
  await converge();
  assert.equal((await checkDrift(deps, 'test')).state, 'converged', 'green first, or the red below proves nothing');

  // What `systemctl unmask dnsmasq && systemctl enable --now dnsmasq` at the console leaves behind.
  stock.set('dnsmasq.service', { unitFileState: 'enabled', activeState: 'active' });
  const red = await checkDrift(deps, 'test');
  assert.equal(red.state, 'diverged');
  const finding = red.findings.find((entry) => entry.kind === 'unit-conflicting');
  assert.ok(finding !== undefined, `expected a unit-conflicting finding, got ${red.findings.map((f) => f.kind).join(', ')}`);
  assert.equal(finding.subject, 'dnsmasq.service');
  assert.equal(finding.running, 'enabled, active');
  assert.match(summarise(red), /dnsmasq\.service is no longer masked/);

  stock.set('dnsmasq.service', { unitFileState: 'masked', activeState: 'inactive' });
  assert.equal((await checkDrift(deps, 'test')).state, 'converged', 'and green again once it is masked');
});

test('the check is cheap enough to run every fifteen minutes on this board', async () => {
  /*
   * A cost, measured rather than asserted to be small.
   *
   * The bound is deliberately loose — this runs in CI on whatever machine is free, and a tight bound
   * would fail for the machine rather than for the code. What it is here to catch is an order of
   * magnitude: a check that starts re-compiling the core's 445 KB schema on every round, or reading
   * the whole of `/etc`, shows up as seconds and not as milliseconds. The figure for the target board
   * is in `docs/06-apply-and-rollback.md`, taken with the same code.
   */
  const { deps, converge } = await bench();
  await converge();
  // One round first, so the figure below is not the one that compiles the validators and the core's
  // schema — those are cached for the life of the process and a periodic round does not pay them.
  await checkDrift(deps, 'warm-up');
  const started = performance.now();
  const rounds = 20;
  for (let index = 0; index < rounds; index += 1) await checkDrift(deps, 'measurement');
  const perRound = (performance.now() - started) / rounds;
  assert.ok(perRound < 2000, `a drift round took ${Math.round(perRound)} ms, which is not a periodic check`);
  /*
   * What a round leaves behind, when the runtime is willing to say.
   *
   * Only under `--expose-gc`, because without a collection on either side the figure is whatever the
   * collector happened to do in between — which on one run here read **minus** 262 KiB, a number that
   * would have been reported as a measurement. A reading that can come back negative is not a weak
   * reading of allocation; it is not a reading of it.
   */
  const collect = (globalThis as { gc?: () => void }).gc;
  let retained = '';
  if (collect !== undefined) {
    collect();
    const before = process.memoryUsage().heapUsed;
    for (let index = 0; index < rounds; index += 1) await checkDrift(deps, 'measurement');
    collect();
    retained = `, ${Math.round((process.memoryUsage().heapUsed - before) / rounds / 1024)} KiB retained per round`;
  }
  process.stdout.write(
    `# drift: ${perRound.toFixed(1)} ms per round${retained} on this machine, with the inventory and the ` +
      'device reading supplied by the bench. What the board adds is in docs/06-apply-and-rollback.md.\n',
  );
});

/* ── a list read off the device, and a derivation that must be reproducible ──────────────── */

/**
 * Measured on the bench board, 2026-09-22: seconds after an apply, the report read "not running its
 * stored profile … at /inbounds/0/route_exclude_address/3: the profile derives 10.164.0.0/20 and the
 * device holds 10.136.0.0/24 (and 4 more)". The file held `…, "10.136.0.0/24", "10.164.0.0/20"`: the hq
 * tunnel had been recreated, its interface had a new index, and the kernel now listed it after the
 * other tunnel. Same networks, other order — and the derivation followed the kernel's order while the
 * comparison went by index.
 */
const BOARD_NETWORKS = ['192.168.77.8/24', '10.136.0.6/24', '10.164.0.9/20'];

test('the same networks listed in another order derive the same configuration, and the check stays green', async () => {
  const networks = { current: [...BOARD_NETWORKS] };
  const { deps, converge } = await bench({ networks });
  await converge();
  assert.equal((await checkDrift(deps, 'test')).state, 'converged');

  // The hq tunnel restarts: its interface comes back with a higher index and is listed last.
  networks.current = ['192.168.77.8/24', '10.164.0.9/20', '10.136.0.6/24'];
  const after = await checkDrift(deps, 'test');
  assert.equal(after.state, 'converged', `a reordering is not a divergence, got: ${summarise(after)}`);
});

test('a list written in the kernel’s order by an older build is read as the set it is', () => {
  // What is on the board right now: written before the order was made canonical.
  const derived = JSON.stringify({ inbounds: [{ route_exclude_address: ['10.44.0.0/24', '172.19.0.0/30', '10.136.0.0/24', '10.164.0.0/20', '192.168.77.0/24'] }] });
  const held = JSON.stringify({ inbounds: [{ route_exclude_address: ['10.44.0.0/24', '172.19.0.0/30', '192.168.77.0/24', '10.136.0.0/24', '10.164.0.0/20'] }] });
  const file = managed(CORE, derived, {
    observed: [{ pointer: '/inbounds/0/route_exclude_address', from: 'the networks on the interfaces', unordered: true }],
  });
  const result = compare(desiredWith([file]), realityWith({ files: [{ path: CORE, content: held, mode: 0o600 }] }));
  assert.deepEqual(result.findings, [], 'the same members in another order are the same fence');
});

test('a network that has really gone from the fence is red, named once at the list, and says which way it runs', async () => {
  const networks = { current: [...BOARD_NETWORKS] };
  const { deps, converge } = await bench({ networks });
  await converge();
  assert.equal((await checkDrift(deps, 'test')).state, 'converged', 'green first, or the red below proves nothing');

  // The tunnel on 10.136.0.0/24 goes down: a derivation now would not exclude its network.
  networks.current = ['192.168.77.8/24', '10.164.0.9/20'];
  const red = await checkDrift(deps, 'test');
  assert.equal(red.state, 'diverged');
  const fence = red.findings.find((finding) => finding.pointer === '/inbounds/0/route_exclude_address');
  assert.ok(fence, `expected one finding at the list, got: ${red.findings.map((finding) => finding.pointer).join(', ')}`);
  assert.equal(
    red.findings.filter((finding) => finding.pointer?.startsWith('/inbounds/0/route_exclude_address/') === true).length,
    0,
    'no per-index findings: one element leaving is one difference, not one per later position',
  );
  assert.equal(fence.running, '["10.136.0.0/24"]', 'what the device holds and a derivation now drops');
  assert.equal(fence.stored, '[]');
  assert.match(fence.message, /read off this device/);
  assert.match(fence.message, /10\.136\.0\.0\/24, which a derivation now would drop|\["10\.136\.0\.0\/24"\], which a derivation now would drop/);
  assert.match(fence.hint, /an apply now removes it/);

  networks.current = [...BOARD_NETWORKS];
  assert.equal((await checkDrift(deps, 'test')).state, 'converged', 'and green again when it comes back');
});

test('a captured resolver that has moved is named as a reading, not as something the profile says', async () => {
  const { deps, converge } = await bench({ capturedResolver: '10.184.40.5' });
  await converge();
  // The peer hands out another address: what the device holds is now behind what a derivation gives.
  const moved = { ...deps, pipeline: { ...deps.pipeline, capturedResolvers: async () => new Map([['res-hq', '10.184.48.5']]) } };
  const red = await checkDrift(moved, 'test');
  const finding = red.findings.find((entry) => entry.running === '"10.184.40.5"');
  assert.ok(finding, `expected the resolver, got: ${red.findings.map((entry) => entry.message).join(' | ')}`);
  assert.equal(finding.stored, '"10.184.48.5"');
  assert.match(finding.message, /read off this device rather than written in the profile/);
  assert.match(finding.message, /peer pushed/);
});

/* ── a file whose generator marked it as credentials ─────────────────────────────────────── */

test('a divergence inside a file marked as credentials names the file and withholds every line of it', () => {
  // Invented key material, shaped like the hq `.ovpn` blob: a private key and a tls-crypt key inline.
  const derived = [
    'client',
    'dev tun',
    '<key>',
    'INVENTED-PRIVATE-KEY-LINE-ONE',
    '</key>',
    '<tls-crypt>',
    'INVENTED-TLS-CRYPT-STATIC-KEY-A',
    '</tls-crypt>',
    '',
  ].join('\n');
  const held = derived.replace('INVENTED-TLS-CRYPT-STATIC-KEY-A', 'INVENTED-TLS-CRYPT-STATIC-KEY-B');
  const path = '/etc/wayfarer/openvpn/hq.conf';
  const file = managed(path, derived, { credentials: true, consumedBy: { kind: 'unit', unit: 'wf-openvpn@hq.service' } });
  const result = compare(desiredWith([file]), realityWith({ files: [{ path, content: held, mode: 0o600 }] }));

  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding!.subject, path, 'the file is named');
  assert.equal(finding!.kind, 'file-content');
  const everything = JSON.stringify(finding);
  assert.doesNotMatch(everything, /INVENTED-TLS-CRYPT/, 'neither version of the key reaches the finding');
  assert.doesNotMatch(everything, /INVENTED-PRIVATE-KEY/);
  assert.doesNotMatch(everything, /line \d/, 'not even where in the key block the difference starts');
  assert.match(finding!.message, /holds credentials/);

  // And the mark is what does it: the same divergence in an unmarked file prints the line, as before.
  const unmarked = compare(
    desiredWith([managed(path, derived)]),
    realityWith({ files: [{ path, content: held, mode: 0o600 }] }),
  );
  assert.match(JSON.stringify(unmarked.findings), /INVENTED-TLS-CRYPT-STATIC-KEY-A/);
});

test('a JSON file marked as credentials names the pointer and withholds both values, whatever the key', () => {
  const derived = JSON.stringify({ transport: 'direct', UID: 'INVENTED-UID-A' });
  const held = JSON.stringify({ transport: 'direct', UID: 'INVENTED-UID-B' });
  const path = '/etc/wayfarer/transport/hq-entry-1.json';
  const result = compare(
    desiredWith([managed(path, derived, { credentials: true })]),
    realityWith({ files: [{ path, content: held, mode: 0o600 }] }),
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.pointer, '/UID');
  assert.doesNotMatch(JSON.stringify(result.findings), /INVENTED-UID/);
});

/**
 * A check a person runs is stored like the daemon's own. Bench board, 2026-09-23: with a marker line
 * in the README, `way drift` said diverged at 22:13 while `/api/drift` said converged from 22:05 until
 * the periodic round at 22:18. `/api/drift` serves `DriftMonitor.current()`, asserted here directly.
 */
test('a hand-run `way drift` that finds a divergence is what the daemon serves at once', async () => {
  const { deps, converge, on } = await bench();
  await converge();
  const { createStore } = await import('../src/state/store.ts');
  const { openDatabase } = await import('../src/state/db.ts');
  const { operatorDrift, createDriftMonitor } = await import('../src/core/drift.ts');
  const real = createStore(openDatabase({ path: join(await mkdtemp(join(tmpdir(), 'wayfarer-opdrift-')), 'state.db') }));
  real.device();
  // The bench's store, with the one column both processes share backed by a real database.
  const store = Object.assign(Object.create(deps.store) as Store, {
    device: deps.store.device,
    recordEvent: deps.store.recordEvent,
    setLastDrift: (report: unknown) => real.setLastDrift(report),
    lastDrift: () => real.lastDrift(),
  });
  let uptime = 100;
  const stamp = async () => ({ bootId: 'b', uptimeSeconds: (uptime += 10) });

  const daemon = createDriftMonitor({ ...deps, store, stamp });
  assert.equal((await daemon.run('boot')).state, 'converged');

  await substitute(on(CORE), '"10.184.100.5"', '"10.184.40.5"');
  // `way drift`, in its own process: its own monitor, the same database.
  const byHand = await operatorDrift({ ...deps, store, stamp });
  assert.equal(byHand.state, 'diverged');

  const served = await daemon.current();
  assert.equal(served.report?.state, 'diverged', 'the daemon went on serving its own older converged report');
  assert.equal(served.report?.reason, 'operator');
});
