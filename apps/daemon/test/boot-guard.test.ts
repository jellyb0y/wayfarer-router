/**
 * The boot guards.
 *
 * The failure they exist for, measured on the bench board on 2026-09-20: the device was moved to a
 * different network, its core configuration still excluded the network it used to be on, and it took
 * a correct address and answered nothing.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { assertNoSelfCapture, decideRederive } from '../src/core/boot-guard.ts';

const CORE = '/etc/wayfarer/core/config.json';
const FIREWALL = '/etc/wayfarer/nftables.conf';
const ALLOWED = [CORE, FIREWALL];

test('an artefact whose derived content still matches is left alone', () => {
  const decision = decideRederive({
    generated: [{ path: CORE, content: 'same' }],
    onDisk: new Map([[CORE, 'same']]),
    allowed: ALLOWED,
  });
  assert.deepEqual(decision.toWrite, []);
  assert.equal(decision.unchanged, 1);
  // It still reports that it looked, because "nothing to do" and "did not run" must not look alike.
  assert.deepEqual(decision.considered, [CORE]);
});

test('an artefact that encodes a network the device has left is rewritten', () => {
  const decision = decideRederive({
    generated: [{ path: CORE, content: 'excludes 192.168.77.0/24' }],
    onDisk: new Map([[CORE, 'excludes 192.168.1.0/24']]),
    allowed: ALLOWED,
  });
  assert.deepEqual(decision.toWrite, [{ path: CORE, content: 'excludes 192.168.77.0/24' }]);
});

test('a missing artefact counts as different rather than as matching', () => {
  const decision = decideRederive({
    generated: [{ path: CORE, content: 'anything' }],
    onDisk: new Map(),
    allowed: ALLOWED,
  });
  assert.equal(decision.toWrite.length, 1);
});

test('the guard rewrites only what it is allowed to, whatever else the plan produced', () => {
  const decision = decideRederive({
    generated: [
      { path: CORE, content: 'new' },
      { path: '/usr/local/lib/systemd/system/wf-core.service', content: 'a unit definition' },
      { path: '/etc/wayfarer/hostapd/wfap0.conf', content: 'the access point' },
    ],
    onDisk: new Map(),
    allowed: ALLOWED,
  });
  assert.deepEqual(
    decision.toWrite.map((entry) => entry.path),
    [CORE],
    'this guard re-derives discovered facts; it does not re-plan the profile, install units or touch ' +
      'anything the profile alone decides',
  );
});

/* ── the backstop ────────────────────────────────────────────────────────────────────────── */

test('an address that routes off its own interface is fine', () => {
  const result = assertNoSelfCapture({
    observations: [{ address: '192.168.77.7', heldOn: 'end0', routesVia: 'end0' }],
    tunnelDevices: ['tun0'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test('an address the device holds that routes into the tunnel is the lockout shape', () => {
  const result = assertNoSelfCapture({
    observations: [{ address: '192.168.77.7', heldOn: 'end0', routesVia: 'tun0' }],
    tunnelDevices: ['tun0'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0]?.reason, 'captured');
  assert.match(result.findings[0]!.message, /leaves through tun0/);
  assert.match(
    result.findings[0]!.message,
    /while every interface looks healthy/,
    'the message has to say why nobody noticed, because that is the whole difficulty',
  );
});

test('a route that could not be read is reported, not passed', () => {
  const result = assertNoSelfCapture({
    observations: [{ address: '192.168.77.7', heldOn: 'end0', routesVia: null }],
    tunnelDevices: ['tun0'],
  });
  assert.equal(result.ok, false, '"I could not read it" is not "it is fine"');
  assert.equal(result.findings[0]?.reason, 'unreadable');
});

test('every held address is checked, not just the first', () => {
  const result = assertNoSelfCapture({
    observations: [
      { address: '192.168.77.7', heldOn: 'end0', routesVia: 'end0' },
      { address: '192.168.77.8', heldOn: 'wlan0', routesVia: 'tun0' },
      { address: '10.44.0.1', heldOn: 'wlx0', routesVia: 'wlx0' },
    ],
    tunnelDevices: ['tun0'],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((entry) => entry.address), ['192.168.77.8']);
});

/* ── which address to ask about ──────────────────────────────────────────────────────────── */

test('asking about our own address is the mistake this function exists to avoid', async () => {
  const { probeAddressFor } = await import('../src/core/boot-guard.ts');
  // Measured on the bench board: `ip route get <own address>` answers `dev lo` every time, so a check
  // built on it passes on a captured device exactly as happily as on a healthy one.
  const probe = probeAddressFor({ address: '192.168.77.7', prefixLength: 24 });
  assert.notEqual(probe, '192.168.77.7');
  assert.equal(probe, '192.168.77.1');
});

test('the gateway is preferred, because it is a neighbour we know exists', async () => {
  const { probeAddressFor } = await import('../src/core/boot-guard.ts');
  assert.equal(
    probeAddressFor({ address: '192.168.77.7', prefixLength: 24, gateway: '192.168.77.254' }),
    '192.168.77.254',
  );
});

test('a gateway on another network is not a neighbour on this one', async () => {
  const { probeAddressFor } = await import('../src/core/boot-guard.ts');
  assert.equal(
    probeAddressFor({ address: '10.44.0.1', prefixLength: 24, gateway: '192.168.77.1' }),
    '10.44.0.1'.replace('10.44.0.1', '10.44.0.2'),
    'the first host address is us, so the neighbour is the second',
  );
});

test('the first host address is skipped when it is our own', async () => {
  const { probeAddressFor } = await import('../src/core/boot-guard.ts');
  assert.equal(probeAddressFor({ address: '10.44.0.1', prefixLength: 24 }), '10.44.0.2');
  assert.equal(probeAddressFor({ address: '10.44.0.9', prefixLength: 24 }), '10.44.0.1');
});

test('a network with no room for a neighbour yields nothing rather than an address off it', async () => {
  const { probeAddressFor } = await import('../src/core/boot-guard.ts');
  // The core's own /30 transfer network, and the degenerate cases.
  assert.equal(probeAddressFor({ address: '172.19.0.1', prefixLength: 30 }), '172.19.0.2');
  assert.equal(probeAddressFor({ address: '10.0.0.1', prefixLength: 31 }), null);
  assert.equal(probeAddressFor({ address: '10.0.0.1', prefixLength: 32 }), null);
  assert.equal(probeAddressFor({ address: 'not-an-address', prefixLength: 24 }), null);
});

test('the tunnel own transfer network is not a capture', () => {
  // An address on tun0 routes through tun0, which is correct. Counting it as a capture made the check
  // fail every time on the bench board, which would have stopped the core at every boot.
  const result = assertNoSelfCapture({
    observations: [
      { address: '192.168.77.1', heldOn: 'end0', routesVia: 'end0' },
      { address: '10.44.0.2', heldOn: 'wlx0', routesVia: 'wlx0' },
    ],
    tunnelDevices: ['tun0'],
  });
  assert.equal(result.ok, true, 'the caller excludes tunnel-held addresses before asking');
});

test('the core configuration does not depend on whether the core is already running', async () => {
  const { generateCoreConfig } = await import('../src/core/generate/core-config.ts');
  const { emptyProfile } = await import('@wayfarer/schemas');

  const build = (uplinkNetworks: string[]): string =>
    JSON.stringify(
      generateCoreConfig({
        profile: emptyProfile({ name: 'Bench' }) as never,
        interfaces: { accessPoint: 'wlx0', uplinks: new Map() },
        emitted: new Map(),
        tunnelDns: new Map(),
        uplinkNetworks,
      }),
    );

  // Cold: the boot guard runs before the core, so no tun device exists and none is discovered.
  const cold = build(['192.168.77.0/24']);
  // Warm: the core is up, so its own transfer network is among the addresses the device holds.
  const warm = build(['192.168.77.0/24', '172.19.0.0/30']);

  assert.equal(
    cold,
    warm,
    'the guard runs before the core by design; if this file differed, it would be rewritten on every ' +
      'single boot — a write to the one component that wears out, and a plan never empty after a restart',
  );
  assert.ok(cold.includes('172.19.0.0/30'), 'the transfer network is stated, not discovered');
});

test('a unit bound to an interface this plan renames is enabled but not started', async () => {
  const { plan } = await import('../src/core/planner.ts');
  const { emptyProfile } = await import('@wayfarer/schemas');
  const { builtInAndDongle } = await import('./helpers/synthetic-inventory.ts');

  const profile = emptyProfile({ name: 'Bench' }) as Record<string, unknown>;
  profile['uplinks'] = [
    {
      id: 'wan-wifi',
      kind: 'wifi-sta',
      priority: 10,
      enabled: true,
      bind: { by: 'phy-builtin' },
      // The pin is what causes the rename, and the rename is what takes effect only at boot.
      pinName: true,
      takeOverInterface: false,
      config: { ssid: 'VINTAGE ', psk: 'vintage123', dhcp: true },
    },
  ];

  const result = plan({
    profile: profile as never,
    inventory: builtInAndDongle(),
    facts: {
      foreignCores: [],
      interfaceClaims: [],
      managementInterfaces: ['end0'],
      binaries: [],
      uplinkNetworks: [],
    } as never,
    emissions: new Map(),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
  } as never);

  const supplicant = result.desired.units.find((unit) => unit.name.startsWith('wf-supplicant@'));
  assert.ok(supplicant, 'the plan should still emit the client');
  assert.equal(supplicant.enabled, true, 'enabling is what makes the reboot finish the job');
  assert.equal(
    supplicant.active,
    false,
    'the device unit it binds to does not exist until the rename takes effect at boot; starting it now ' +
      'only spends the apply failing, as it did on the bench board',
  );
  assert.ok(
    result.desired.notes.some((note) => note.includes('takes effect at the next reboot')),
    'and the operator is told why it is not running yet',
  );
});

test('kernel settings are written where a reboot will find them, not only applied live', async () => {
  const { plan } = await import('../src/core/planner.ts');
  const { emptyProfile } = await import('@wayfarer/schemas');
  const { builtInAndDongle } = await import('./helpers/synthetic-inventory.ts');
  const { PATHS } = await import('../src/core/desired-state.ts');

  const profile = emptyProfile({ name: 'Bench' }) as Record<string, unknown>;
  profile['accessPoint'] = {
    bind: { by: 'phy-usb', value: '0e8d:7961' },
    radio: { band: '2.4GHz', channel: 6, width: 20, country: 'DE', hidden: false },
    ssid: 'Bench', passphrase: 'bench-passphrase', acceptChannelFollowsUplink: false,
    pinName: false, takeOverInterface: false,
  };

  const result = plan({
    profile: profile as never,
    inventory: builtInAndDongle(),
    facts: { foreignCores: [], interfaceClaims: [], managementInterfaces: ['end0'], binaries: [], uplinkNetworks: [] } as never,
    emissions: new Map(),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
  } as never);

  assert.ok(result.desired.sysctl.length > 0, 'this profile forwards, so there are settings to make');
  const dropIn = result.desired.files.find((file) => file.path === PATHS.sysctlDropIn);
  assert.ok(
    dropIn,
    'applying a sysctl changes the running kernel and nothing else; without a drop-in the device loses ' +
      'IP forwarding at every power cycle and nothing says why',
  );
  for (const setting of result.desired.sysctl) {
    assert.ok(
      dropIn.content.includes(`${setting.key} = ${setting.value}`),
      `${setting.key} is applied live but would not survive a reboot`,
    );
  }
});

test('every artefact whose content follows the environment carries the mark that makes the guard re-derive it', async () => {
  const { plan } = await import('../src/core/planner.ts');
  const { emptyProfile } = await import('@wayfarer/schemas');
  const { builtInAndDongle } = await import('./helpers/synthetic-inventory.ts');

  const profile = emptyProfile({ name: 'Bench' }) as Record<string, unknown>;
  profile['accessPoint'] = {
    bind: { by: 'phy-usb', value: '0e8d:7961' },
    radio: { band: '2.4GHz', channel: 6, width: 20, country: 'DE', hidden: false },
    ssid: 'Bench', passphrase: 'bench-passphrase', acceptChannelFollowsUplink: false,
    pinName: false, takeOverInterface: false,
  };

  /** The same profile, planned on a device standing in two different places. */
  const planOn = (networks: string[]) =>
    plan({
      profile: profile as never,
      inventory: builtInAndDongle(),
      facts: {
        foreignCores: [],
        interfaceClaims: [],
        managementInterfaces: ['end0'],
        binaries: [],
        // The runtime shape: each network with the interface it was read from.
        uplinkNetworks: networks.map((cidr) => ({ interface: 'end0', cidr })),
      } as never,
      emissions: new Map(),
      managementPort: 8088,
      timePorts: [123],
      coreBinaryPath: '/usr/bin/sing-box',
      upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      wayBinary: '/usr/local/bin/way',
    } as never);

  const here = planOn(['192.168.1.0/24']);
  const there = planOn(['192.168.77.0/24']);

  const byPath = new Map(there.desired.files.map((file) => [file.path, file.content]));
  const moved: string[] = [];
  for (const file of here.desired.files) {
    const other = byPath.get(file.path);
    if (other !== undefined && other !== file.content) moved.push(file.path);
  }

  assert.ok(
    moved.length > 0,
    'moving the device between networks must change something, or this test is asserting nothing',
  );

  /*
   * The point of the whole exercise. Any artefact whose content follows the environment must be marked,
   * because the boot guard finds what to re-derive by that mark. An unmarked one is silently left
   * describing a network the device has left — which is exactly the defect the guard exists to prevent,
   * reintroduced through the guard's own blind spot.
   */
  for (const path of moved) {
    const file = here.desired.files.find((entry) => entry.path === path)!;
    assert.equal(
      file.environmentDependent,
      true,
      `${path} has different content on two different networks but is not marked environmentDependent, ` +
        'so the boot guard will not re-derive it and it will keep describing a network the device has left',
    );
  }
});

/* ── classification: nothing a generator emits may fall through ──────────────────────────── */

test('every artefact a generator can emit is classified explicitly, not by falling back', async () => {
  const { classifyPathExplicitly } = await import('../src/core/differ.ts');
  const { plan } = await import('../src/core/planner.ts');
  const { emptyProfile } = await import('@wayfarer/schemas');
  const { builtInAndDongle } = await import('./helpers/synthetic-inventory.ts');

  const profile = emptyProfile({ name: 'Bench' }) as Record<string, unknown>;
  profile['accessPoint'] = {
    bind: { by: 'phy-usb', value: '0e8d:7961' },
    radio: { band: '2.4GHz', channel: 6, width: 20, country: 'DE', hidden: false },
    ssid: 'Bench', passphrase: 'bench-passphrase', acceptChannelFollowsUplink: false,
    pinName: false, takeOverInterface: false,
  };
  profile['uplinks'] = [
    {
      id: 'wan-wifi', kind: 'wifi-sta', priority: 10, enabled: true,
      bind: { by: 'phy-builtin' }, pinName: false, takeOverInterface: false,
      config: { ssid: 'VINTAGE ', psk: 'vintage123', dhcp: true },
    },
  ];

  const result = plan({
    profile: profile as never,
    inventory: builtInAndDongle(),
    facts: {
      foreignCores: [], interfaceClaims: [], managementInterfaces: ['end0'], binaries: [],
      uplinkNetworks: [{ interface: 'end0', cidr: '192.168.77.0/24' }],
    } as never,
    emissions: new Map(),
    managementPort: 8088,
    timePorts: [123],
    coreBinaryPath: '/usr/bin/sing-box',
    upScriptPath: '/opt/wayfarer/bin/tunnel-up',
    wayBinary: '/usr/local/bin/way',
  } as never);

  const everything = [...result.desired.files, ...result.desired.networkFiles];
  assert.ok(everything.length > 5, 'this profile should produce a full set of artefacts');

  for (const file of everything) {
    assert.notEqual(
      classifyPathExplicitly(file.path),
      null,
      `${file.path} is emitted by a generator and nothing classifies it, so it falls back to "service" — ` +
        'and a service change gets no confirmation window and no revert timer. That is how a change ' +
        'which took the uplink down committed instantly with nothing watching.',
    );
  }
});

test('taking the radio down is a network change, whichever half of it is running', async () => {
  const { classifyPath } = await import('../src/core/differ.ts');
  const { PATHS } = await import('../src/core/desired-state.ts');
  // The access point and the wireless client both own a radio. The client was missed, and the miss
  // meant the uplink could be broken without a confirmation window.
  assert.equal(classifyPath(`${PATHS.hostapdDir}/wfap0.conf`), 'network');
  assert.equal(classifyPath(`${PATHS.supplicantDir}/wfwan0.conf`), 'network');
});

test('a generated unit file takes the class of its unit, from the directory units actually live in', async () => {
  const { classifyPath } = await import('../src/core/differ.ts');
  const { PATHS } = await import('../src/core/desired-state.ts');
  // This read `/etc/systemd/system/` long after generated units moved, so every generated unit file
  // silently stopped taking its unit's class.
  assert.equal(classifyPath(`${PATHS.unitDir}/wf-hostapd@.service`), 'network');
  assert.equal(classifyPath(`${PATHS.unitDir}/wf-supplicant@.service`), 'network');
  assert.equal(classifyPath(`${PATHS.unitDir}/wf-dhcp@.service`), 'service');
});

/* ── blast radius is a property of the change, not of the file ───────────────────────────── */

test('a change to the exclusion list is a network change, and a change to an outbound is not', async () => {
  const { classifyContentChange } = await import('../src/core/differ.ts');
  const { generateCoreConfig } = await import('../src/core/generate/core-config.ts');
  const { emptyProfile } = await import('@wayfarer/schemas');
  const { PATHS } = await import('../src/core/desired-state.ts');

  /** A profile with one tunnel, so the outbound half of the document is not empty. */
  const profileWithTunnel = (): Record<string, unknown> => {
    const profile = emptyProfile({ name: 'Bench' }) as Record<string, unknown>;
    profile['tunnels'] = [
      { id: 'hq', name: 'HQ', role: 'alternative', enabled: true, provider: 'socks', config: { command: 'x', localPort: 1080 } },
    ];
    return profile;
  };

  const build = (uplinkNetworks: string[], outbound: Record<string, unknown>): string =>
    `${JSON.stringify(
      generateCoreConfig({
        profile: profileWithTunnel() as never,
        interfaces: { accessPoint: 'wlx0', uplinks: new Map() },
        emitted: new Map([['hq', { target: 'outbounds', object: outbound }]]) as never,
        tunnelDns: new Map(),
        uplinkNetworks,
      }),
      null,
      2,
    )}\n`;

  const hqOutbound = { type: 'socks', tag: 'hq', server: '127.0.0.1', server_port: 1080 };
  const base = build(['192.168.1.0/24'], hqOutbound);

  // Differing only in which networks are excluded — the thing that decides whether a host on our own
  // network can still get a reply from us.
  const movedNetwork = build(['192.168.77.0/24'], hqOutbound);
  assert.notEqual(base, movedNetwork, 'the fixture must actually differ, or this asserts nothing');
  assert.equal(
    classifyContentChange(PATHS.coreConfig, base, movedNetwork),
    'network',
    'a wrong exclusion list is the mechanism that made this board unreachable twice; it must arrive ' +
      'with a confirmation window and a revert timer',
  );

  // Differing only in an outbound — where captured traffic goes, which cannot make the device
  // unreachable. This is what keeps routing edits from dragging a three-minute window behind them.
  const extraOutbound = build(['192.168.1.0/24'], { ...hqOutbound, server_port: 1081 });
  assert.notEqual(base, extraOutbound, 'the fixture must actually differ, or this asserts nothing');
  assert.equal(classifyContentChange(PATHS.coreConfig, base, extraOutbound), 'service');
});

test('an unreadable document keeps the whole-file class rather than being softened', async () => {
  const { classifyContentChange } = await import('../src/core/differ.ts');
  const { PATHS } = await import('../src/core/desired-state.ts');
  // "I could not read it" is not "nothing important changed".
  assert.equal(classifyContentChange(PATHS.coreConfig, 'not json', '{"inbounds":[]}'), 'service');
  // A file being created has no previous content to compare against.
  assert.equal(classifyContentChange(PATHS.coreConfig, null, '{"inbounds":[]}'), 'service');
});

test('the firewall unit: putting a ruleset into force is a network change, re-asserting it is not', async () => {
  const { classifyUnitAction } = await import('../src/core/differ.ts');
  // Nothing was enforcing the kill-switch a moment ago and now something is.
  assert.equal(classifyUnitAction('wf-firewall.service', 'start', false), 'network');
  assert.equal(classifyUnitAction('wf-firewall.service', 'start', undefined), 'network');
  // The same ruleset, re-read. Nothing in force changes.
  assert.equal(classifyUnitAction('wf-firewall.service', 'restart', true), 'service');
  // And the radio units keep their class whichever action is taken.
  assert.equal(classifyUnitAction('wf-supplicant@wfwan0.service', 'restart', true), 'network');
  assert.equal(classifyUnitAction('wf-hostapd@wlx0.service', 'start', false), 'network');
});

test('an unclassified path gets the safety net, and is recorded so somebody classifies it', async () => {
  const { classifyPath, unclassifiedArtefactPaths } = await import('../src/core/differ.ts');
  assert.equal(
    classifyPath('/etc/wayfarer/something-nobody-classified.conf'),
    'network',
    'an unknown artefact is one whose blast radius nobody has reasoned about, which is exactly when ' +
      'the safety net should be on',
  );
  assert.ok(unclassifiedArtefactPaths().includes('/etc/wayfarer/something-nobody-classified.conf'));
});

test('a unit path is never spelled out where the paths table already holds it', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { PATHS } = await import('../src/core/desired-state.ts');

  /*
   * `/etc/systemd/system` is the administrator's directory and appears legitimately in a handful of
   * places — the factory reset's forbidden list, and a quoted systemd error in two comments. What it must
   * never be is the directory *our* generated units are looked for in: that was hardcoded in two places
   * during this epic, in `classifyPath` and again in the reality collector, and in both the consequence
   * was a fact about our own units that was silently always wrong.
   */
  const root = join(import.meta.dirname, '..', 'src');
  for (const file of ['platform/facts.ts', 'core/differ.ts']) {
    const text = await readFile(join(root, file), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !code.includes("'/etc/systemd/system"),
      `${file} spells out a unit directory instead of using PATHS.unitDir`,
    );
  }
  assert.equal(PATHS.unitDir, '/usr/local/lib/systemd/system');
});
