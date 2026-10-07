/**
 * The reconciler: the refusal, the ordering rules, and verification of both states.
 *
 * Driven against a recording stand-in for the platform layer rather than a board. That is not a
 * substitute for running it on hardware — it is what lets the *order* be asserted, which a board
 * cannot show you: on a device a wrong order usually still works, and the fault appears after a
 * reboot or on the one occasion the clock is wrong.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { orderUnitChanges, reconcile } from '../src/core/reconciler.ts';
import { classifyPath, diff, highest, type Reality } from '../src/core/differ.ts';
import { emptyDesiredState, isOwnedUnit, type DesiredState } from '../src/core/desired-state.ts';
import type { Platform } from '../src/platform/index.ts';

/* ── a recording platform ────────────────────────────────────────────────────────────────── */

interface Recorder {
  platform: Platform;
  calls: string[];
  unitStates: Map<string, { isActive: boolean; isEnabled: boolean }>;
}

function recorder(options: { nftOk?: boolean; jobResult?: string } = {}): Recorder {
  const calls: string[] = [];
  const unitStates = new Map<string, { isActive: boolean; isEnabled: boolean }>();

  const job = (unit: string): Promise<{ result: string; unit: string; jobPath: string; waitedMs: number }> => {
    calls.push(`start/restart:${unit}`);
    const result = options.jobResult ?? 'done';
    if (result === 'done') {
      const current = unitStates.get(unit) ?? { isActive: false, isEnabled: false };
      unitStates.set(unit, { ...current, isActive: true });
    }
    return Promise.resolve({ result, unit, jobPath: '/job/1', waitedMs: 12 });
  };

  const platform = {
    systemd: {
      start: (unit: string) => job(unit),
      restart: (unit: string) => job(unit),
      stop: (unit: string) => {
        calls.push(`stop:${unit}`);
        return Promise.resolve({ result: 'done', unit, jobPath: '', waitedMs: 1 });
      },
      reload: (unit: string) => job(unit),
      enable: (unit: string) => {
        calls.push(`enable:${unit}`);
        const current = unitStates.get(unit) ?? { isActive: false, isEnabled: false };
        unitStates.set(unit, { ...current, isEnabled: true });
        return Promise.resolve();
      },
      disable: (unit: string) => {
        calls.push(`disable:${unit}`);
        return Promise.resolve();
      },
      daemonReload: () => {
        calls.push('daemon-reload');
        return Promise.resolve();
      },
      state: (unit: string) =>
        Promise.resolve({
          unit,
          isActive: unitStates.get(unit)?.isActive ?? false,
          isEnabled: unitStates.get(unit)?.isEnabled ?? false,
        }),
      show: () => Promise.resolve({}),
      watch: () => Promise.resolve({ stop: () => undefined }),
      close: () => undefined,
    },
    nft: {
      check: (ruleset: string) => {
        calls.push('nft-check');
        return Promise.resolve({
          ok: options.nftOk !== false,
          message: options.nftOk === false ? 'syntax error, line 3, column 12' : '',
        });
      },
      apply: () => Promise.resolve(),
      list: () => Promise.resolve({ tables: [], rules: [] }),
      foreign: () => Promise.resolve([]),
    },
    files: {
      writeAtomic: (path: string) => {
        calls.push(`write:${path}`);
        return Promise.resolve({ path, bytes: 10, changed: true });
      },
      readManaged: () => Promise.resolve(null),
      fileMode: () => Promise.resolve(null),
    },
    binaries: { detect: () => Promise.resolve(null), coreSchema: () => Promise.resolve(null) },
  } as unknown as Platform;

  return { platform, calls, unitStates };
}

/* ── fixtures ────────────────────────────────────────────────────────────────────────────── */

function serviceOnlyState(): DesiredState {
  const desired = emptyDesiredState();
  desired.files.push({
    path: '/etc/wayfarer/core/config.json',
    content: '{}\n',
    mode: 0o600,
    purpose: 'the proxy core configuration',
    consumedBy: { kind: 'unit', unit: 'wf-core.service' },
  });
  desired.files.push({
    path: '/etc/wayfarer/dhcp/wfap0.conf',
    content: 'port=0\n',
    mode: 0o644,
    purpose: 'hands out addresses',
    consumedBy: { kind: 'unit', unit: 'wf-dhcp@wfap0.service' },
  });
  desired.units.push({ name: 'wf-core.service', enabled: true, active: true, purpose: 'the core', content: '[Unit]\n' });
  desired.units.push({
    name: 'wf-dhcp@wfap0.service',
    enabled: true,
    active: true,
    purpose: 'the address service',
  });
  desired.checks.push({ kind: 'nft-check', ruleset: 'table inet wayfarer {}\n' });
  desired.checks.push({
    kind: 'unit-not-foreign',
    units: ['wf-core.service', 'wf-dhcp@wfap0.service'],
  });
  return desired;
}

function withNetworkChange(desired: DesiredState): DesiredState {
  desired.files.push({
    path: '/etc/wayfarer/nftables.conf',
    content: 'table inet wayfarer {}\n',
    mode: 0o600,
    purpose: 'the firewall ruleset',
    consumedBy: { kind: 'unit', unit: 'wf-firewall.service' },
  });
  desired.files.push({
    path: '/etc/wayfarer/hostapd/wfap0.conf',
    content: 'interface=wfap0\n',
    mode: 0o600,
    purpose: 'the access point',
    consumedBy: { kind: 'unit', unit: 'wf-hostapd@wfap0.service' },
  });
  return desired;
}

const bareReality: Reality = {
  files: [],
  units: [],
  interfaces: [{ name: 'end0', mac: '02:81:5a:11:22:33' }],
  managementInterfaces: ['end0'],
  sysctl: {},
};

/* ── classification ──────────────────────────────────────────────────────────────────────── */

test('the classes are ordered, and a plan takes the highest it contains', () => {
  assert.equal(highest(['hot', 'service']), 'service');
  assert.equal(highest(['service', 'network']), 'network');
  assert.equal(highest(['network', 'boot']), 'boot');
  assert.equal(highest([]), 'hot');
});

test('paths classify by what has to happen afterwards', () => {
  assert.equal(classifyPath('/etc/wayfarer/dhcp/wfap0.conf'), 'service');
  assert.equal(classifyPath('/etc/wayfarer/core/config.json'), 'service');
  assert.equal(classifyPath('/etc/wayfarer/nftables.conf'), 'network');
  assert.equal(classifyPath('/etc/wayfarer/hostapd/wfap0.conf'), 'network');
  assert.equal(classifyPath('/etc/systemd/network/10-wayfarer-lan.network'), 'network');
  assert.equal(classifyPath('/etc/systemd/network/70-wayfarer-ap.link'), 'boot');
  /*
   * An unrecognised path makes a plan cautious rather than optimistic — and `network` is the cautious
   * one, because it is the class that gets a confirmation window and a revert timer.
   *
   * This asserted `service` until 2026-09-20, which reads as caution and is the opposite: `service` is
   * precisely the class that gets **no** safety net. A change that took the uplink down committed
   * instantly under that default. The costs are asymmetric — a needless window wastes somebody's
   * time, a missing one can cost them the device — so the unknown gets the net.
   */
  assert.equal(classifyPath('/etc/wayfarer/something-new.conf'), 'network');
});

test('restarting the access point is a network change even though addressing does not move', () => {
  // "Clients keep their association" is part of the definition of `service`, and a radio restart
  // breaks it. Classified by what it disturbs, not by which call is made.
  const desired = withNetworkChange(serviceOnlyState());
  desired.units.push({
    name: 'wf-hostapd@wfap0.service',
    enabled: true,
    active: true,
    purpose: 'the access point',
  });
  const plan = diff({ desired, reality: bareReality });
  const change = plan.unitChanges.find((entry) => entry.name === 'wf-hostapd@wfap0.service' && entry.action === 'start');
  assert.equal(change?.blastRadius, 'network');
});

/* ── the refusal ─────────────────────────────────────────────────────────────────────────── */

test('a plan containing a network change is refused whole, and nothing is touched', () => {
  const { platform, calls } = recorder();
  const desired = withNetworkChange(serviceOnlyState());
  const plan = diff({ desired, reality: bareReality });

  return reconcile({ platform, desired, plan, timeSyncUnit: 'systemd-timesyncd.service' }).then((result) => {
    assert.equal(result.applied, false);
    assert.equal(result.error?.code, 'blast_radius_not_applicable');
    // Nothing at all, not even a validation call: the refusal is computed before the gate.
    assert.deepEqual(calls, []);

    // And the refusal is actionable: it names every change and what each one needs.
    assert.ok(result.refused.length >= 2);
    assert.ok(result.refused.every((entry) => entry.needs.length > 0));
    assert.ok(/nftables\.conf/.test(result.error!.message));
    assert.ok(/classes = \["hot", "service"\]/.test(result.error!.hint));
  });
});

test('a caller can ask for the safe part explicitly, and the rest is reported rather than forgotten', () => {
  const { platform, calls } = recorder();
  const desired = withNetworkChange(serviceOnlyState());
  const plan = diff({ desired, reality: bareReality });

  return reconcile({
    platform,
    desired,
    plan,
    options: { classes: ['hot', 'service'] },
    timeSyncUnit: 'systemd-timesyncd.service',
  }).then((result) => {
    assert.equal(result.applied, true, JSON.stringify(result.error));
    // The safe files were written and the network-class ones were not.
    assert.ok(calls.includes('write:/etc/wayfarer/core/config.json'));
    assert.ok(calls.includes('write:/etc/wayfarer/dhcp/wfap0.conf'));
    assert.equal(calls.includes('write:/etc/wayfarer/nftables.conf'), false);
    assert.equal(calls.includes('write:/etc/wayfarer/hostapd/wfap0.conf'), false);
    // Still reported, so the interface can keep showing the rest as pending.
    assert.ok(result.refused.some((entry) => /nftables\.conf/.test(entry.what)));
  });
});

/* ── the validation gate ─────────────────────────────────────────────────────────────────── */

test('a ruleset that fails the check stops everything, before a single write', () => {
  const { platform, calls } = recorder({ nftOk: false });
  const desired = serviceOnlyState();
  const plan = diff({ desired, reality: bareReality });

  return reconcile({ platform, desired, plan, timeSyncUnit: 'systemd-timesyncd.service' }).then((result) => {
    assert.equal(result.applied, false);
    assert.equal(result.error?.code, 'ruleset_invalid');
    // nft's own message names the line, which is the reason it is surfaced verbatim.
    assert.ok(/line 3, column 12/.test(result.error!.message));
    assert.deepEqual(calls, ['nft-check']);
  });
});

test('validateOnly exercises the gate and changes nothing', () => {
  const { platform, calls } = recorder();
  const desired = serviceOnlyState();
  const plan = diff({ desired, reality: bareReality });

  return reconcile({
    platform,
    desired,
    plan,
    options: { validateOnly: true },
    timeSyncUnit: 'systemd-timesyncd.service',
  }).then((result) => {
    assert.equal(result.applied, false);
    assert.equal(result.error, undefined);
    assert.deepEqual(calls, ['nft-check']);
  });
});

/* ── ownership ───────────────────────────────────────────────────────────────────────────── */

test('only units we generated are ours', () => {
  assert.equal(isOwnedUnit('wf-core.service'), true);
  assert.equal(isOwnedUnit('wf-hostapd@wfap0.service'), true);
  // The units already on the bench board, which this device must never touch.
  assert.equal(isOwnedUnit('sing-box.service'), false);
  assert.equal(isOwnedUnit('hostapd@wlanap.service'), false);
  assert.equal(isOwnedUnit('dnsmasq.service'), false);
  // Our own daemon is installed rather than generated, so the reconciler does not act on it either.
  assert.equal(isOwnedUnit('wayfarer.service'), false);
});

test('a unit we did not generate is never acted on, and the differ does not plan it', () => {
  const desired = serviceOnlyState();
  desired.units.push({ name: 'sing-box.service', enabled: true, active: true, purpose: 'somebody else' });
  const plan = diff({ desired, reality: bareReality });

  assert.deepEqual(plan.foreignUnits, ['sing-box.service']);
  assert.equal(
    plan.unitChanges.some((change) => change.name === 'sing-box.service'),
    false,
    'a foreign unit must never appear as a change',
  );
});

test('a foreign unit reaching the reconciler is refused as a planner bug', () => {
  const { platform, calls } = recorder();
  const desired = serviceOnlyState();
  desired.units.push({ name: 'sing-box.service', enabled: true, active: true, purpose: 'somebody else' });
  const plan = diff({ desired, reality: bareReality });

  return reconcile({ platform, desired, plan, timeSyncUnit: 'systemd-timesyncd.service' }).then((result) => {
    assert.equal(result.applied, false);
    assert.equal(result.error?.code, 'foreign_unit');
    assert.ok(/sing-box\.service/.test(result.error!.message));
    assert.deepEqual(calls, []);
  });
});

/* ── ordering ────────────────────────────────────────────────────────────────────────────── */

test('enable precedes start for every unit', () => {
  const { platform, calls } = recorder();
  const desired = serviceOnlyState();
  const plan = diff({ desired, reality: bareReality });

  return reconcile({ platform, desired, plan, timeSyncUnit: 'systemd-timesyncd.service' }).then((result) => {
    assert.equal(result.applied, true, JSON.stringify(result.error));
    for (const unit of ['wf-core.service', 'wf-dhcp@wfap0.service']) {
      const enableAt = calls.indexOf(`enable:${unit}`);
      const startAt = calls.indexOf(`start/restart:${unit}`);
      assert.ok(enableAt >= 0, `${unit} was never enabled`);
      assert.ok(startAt >= 0, `${unit} was never started`);
      // A failing restart aborts a sequence, and a unit left disabled works now and is gone after a
      // reboot — a fault nothing in the running system reveals.
      assert.ok(enableAt < startAt, `${unit} was started before it was enabled`);
    }
  });
});

test('listeners come up before the tunnels that connect to them', () => {
  const ordered = orderUnitChanges([
    { name: 'wf-core.service', action: 'restart' },
    { name: 'wf-openvpn@hq.service', action: 'start' },
    { name: 'wf-transport@site-a.service', action: 'start' },
    { name: 'wf-dhcp@wfap0.service', action: 'start' },
    { name: 'wf-socks@x.service', action: 'start' },
  ]);
  assert.deepEqual(
    ordered.map((change) => change.name),
    [
      'wf-dhcp@wfap0.service',
      'wf-transport@site-a.service',
      'wf-socks@x.service',
      'wf-openvpn@hq.service',
      // The core last: it binds to the interfaces the tunnels create.
      'wf-core.service',
    ],
  );
});

test('the order is stable within a stage, so the profile’s own order survives', () => {
  const ordered = orderUnitChanges([
    { name: 'wf-openvpn@b.service', action: 'start' },
    { name: 'wf-openvpn@a.service', action: 'start' },
  ]);
  assert.deepEqual(
    ordered.map((change) => change.name),
    ['wf-openvpn@b.service', 'wf-openvpn@a.service'],
  );
});

test('installs happen before anything is enabled, and stops before starts', () => {
  const ordered = orderUnitChanges([
    { name: 'wf-core.service', action: 'start' },
    { name: 'wf-dhcp@old.service', action: 'stop' },
    { name: 'wf-core.service', action: 'enable' },
    { name: 'wf-core.service', action: 'install' },
  ]);
  assert.deepEqual(
    ordered.map((change) => `${change.action}:${change.name}`),
    ['install:wf-core.service', 'stop:wf-dhcp@old.service', 'enable:wf-core.service', 'start:wf-core.service'],
  );
});

/* ── verification ────────────────────────────────────────────────────────────────────────── */

test('verification reports active and enabled separately', () => {
  const { platform } = recorder();
  const desired = serviceOnlyState();
  const plan = diff({ desired, reality: bareReality });

  return reconcile({ platform, desired, plan, timeSyncUnit: 'systemd-timesyncd.service' }).then((result) => {
    const verifications = result.steps.filter((step) => step.step.startsWith('verify '));
    assert.ok(verifications.length >= 2);
    // A single boolean would hide exactly the fault this check exists for.
    for (const step of verifications) assert.match(step.detail, /active=(true|false) enabled=(true|false)/);
  });
});

test('a unit that is active but not enabled fails verification', () => {
  const { platform, unitStates } = recorder();
  const desired = serviceOnlyState();
  const plan = diff({ desired, reality: bareReality });

  // The recorder marks a unit enabled when `enable` is called; this one is pre-marked active so no
  // enable is planned for it, which reproduces the "works now, gone in the morning" state.
  const reality: Reality = {
    ...bareReality,
    units: [{ name: 'wf-core.service', active: true, enabled: false, known: true }],
  };
  unitStates.set('wf-core.service', { isActive: true, isEnabled: false });
  const planned = diff({ desired, reality });
  void plan;

  // The differ must plan the enable even though the unit is already running.
  assert.ok(
    planned.unitChanges.some((change) => change.name === 'wf-core.service' && change.action === 'enable'),
    'an already-running but disabled unit must still be enabled',
  );
});

test('a unit that fails to start stops the sequence and names the log to read', () => {
  const { platform } = recorder({ jobResult: 'failed' });
  const desired = serviceOnlyState();
  const plan = diff({ desired, reality: bareReality });

  return reconcile({ platform, desired, plan, timeSyncUnit: 'systemd-timesyncd.service' }).then((result) => {
    assert.equal(result.applied, false);
    assert.equal(result.error?.code, 'unit_failed');
    assert.ok(/journalctl -u/.test(result.error!.hint));
  });
});

/* ── idempotence ─────────────────────────────────────────────────────────────────────────── */

test('re-applying a profile that already matches is a no-op', () => {
  // Idempotency comes free from the desired-state model, and it is the property that makes a reboot
  // and a re-apply the same thing. Asserted because it is easy to lose in a generator that emits a
  // timestamp.
  const desired = serviceOnlyState();
  const reality: Reality = {
    files: [
      { path: '/etc/wayfarer/core/config.json', content: '{}\n', mode: 0o600 },
      { path: '/etc/wayfarer/dhcp/wfap0.conf', content: 'port=0\n', mode: 0o644 },
    ],
    units: [
      { name: 'wf-core.service', active: true, enabled: true, known: true },
      { name: 'wf-dhcp@wfap0.service', active: true, enabled: true, known: true },
    ],
    interfaces: [{ name: 'end0', mac: '02:81:5a:11:22:33' }],
    managementInterfaces: ['end0'],
    sysctl: {},
  };

  const plan = diff({ desired, reality });
  assert.equal(plan.fileChanges.length, 0, JSON.stringify(plan.fileChanges));
  assert.equal(plan.empty, true);
  assert.deepEqual(plan.humanDiff, ['nothing to do: the device already matches this profile']);
});

test('a file whose content matches but whose mode does not is still a change', () => {
  // A file a service cannot read is a service that fails, so this is not cosmetic.
  const desired = serviceOnlyState();
  const reality: Reality = {
    ...bareReality,
    files: [
      { path: '/etc/wayfarer/core/config.json', content: '{}\n', mode: 0o644 },
      { path: '/etc/wayfarer/dhcp/wfap0.conf', content: 'port=0\n', mode: 0o644 },
    ],
  };
  const plan = diff({ desired, reality });
  assert.deepEqual(
    plan.fileChanges.map((change) => `${change.action}:${change.path}`),
    ['chmod:/etc/wayfarer/core/config.json'],
  );
});

/* ── the warning that would have saved a locked-out board ─────────────────────────────────── */

test('a plan that touches the interface the request arrived on says so, first', () => {
  // The product feature behind a process error: a scenario was run that destroyed the only management
  // path, and nothing in the plan review said it was about to. The daemon knows which interface the
  // session is on, so the plan can say it — and it has to be the product rather than a test checklist,
  // because the operator is the one who needs the second way in.
  const desired = emptyDesiredState();
  desired.networkFiles.push({
    path: '/etc/systemd/network/10-wayfarer-lan.network',
    content: '[Match]\nName=wlan0\n\n[Network]\nAddress=10.44.0.1/24\n',
    mode: 0o644,
    purpose: 'addressing for the local network on wlan0',
    consumedBy: { kind: 'external', by: 'systemd-networkd' },
  });
  desired.units.push({
    name: 'wf-hostapd@wlan0.service',
    enabled: true,
    active: true,
    purpose: 'hosts the access point on wlan0',
  });

  const plan = diff({
    desired,
    reality: {
      files: [],
      units: [],
      interfaces: [{ name: 'wlan0', mac: '38:d5:92:d3:80:d8' }],
      // The session is on wlan0, which is exactly the interface the plan turns into an access point.
      managementInterfaces: ['wlan0'],
      sysctl: {},
    },
  });

  assert.deepEqual(plan.affectsManagementInterfaces, ['wlan0']);
  // First line, not buried: it is the one line that changes what the operator should do before pressing
  // anything, and a warning below thirty file writes is a warning nobody reads.
  assert.match(plan.humanDiff[0]!, /^WARNING:/);
  assert.match(plan.humanDiff[0]!, /wlan0/);
  assert.match(plan.humanDiff[0]!, /second way in/);
});

test('a plan that leaves the management interface alone raises no such warning', () => {
  // A warning that fires on ordinary changes is one people learn to scroll past, which is how the real
  // one gets missed.
  const desired = emptyDesiredState();
  desired.networkFiles.push({
    path: '/etc/systemd/network/10-wayfarer-lan.network',
    content: '[Match]\nName=wlxaabbcc\n\n[Network]\nAddress=10.44.0.1/24\n',
    mode: 0o644,
    purpose: 'addressing for the local network on wlxaabbcc',
    consumedBy: { kind: 'external', by: 'systemd-networkd' },
  });
  desired.units.push({
    name: 'wf-hostapd@wlxaabbcc.service',
    enabled: true,
    active: true,
    purpose: 'hosts the access point',
  });

  const plan = diff({
    desired,
    reality: {
      files: [],
      units: [],
      interfaces: [{ name: 'wlan0', mac: '38:d5:92:d3:80:d8' }],
      managementInterfaces: ['wlan0'],
      sysctl: {},
    },
  });

  assert.deepEqual(plan.affectsManagementInterfaces, []);
  assert.equal(/^WARNING:/.test(plan.humanDiff[0] ?? ''), false);
});
