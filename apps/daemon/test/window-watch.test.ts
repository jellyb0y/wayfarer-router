/**
 * The health checks that run during a confirmation window.
 *
 * The property under test is not "does it notice a failure" — that is the easy half. It is **does it
 * refuse to conclude anything it did not positively observe**, because the moment a probe is most
 * likely to fail is the moment the board is briefly busy, which is during an apply — and, since
 * 2026-09-23, **does it never end the window**, because the deadline the device reported is the one
 * it keeps.
 *
 * Every stand-in here answers in the shape `ip -j` really prints on the bench board — upper-case
 * `operstate`, the kernel's flags — because the stand-ins used to answer in lower case, which the
 * real tool never does, and that is how a reader that could not see a single real carrier passed
 * every test here while reverting healthy changes on the board.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWindowWatch, readUplinks, windowScopeOf, type WindowFinding, type WindowSubject } from '../src/core/window-watch.ts';
import { parseIpAddresses, parseIpLinks } from '../src/platform/parse/ip-json.ts';
import type { Platform } from '../src/platform/index.ts';

/** A link as `ip -j link show` prints it on the bench board: upper-case operstate and the kernel's flags. */
const UP = { operstate: 'UP', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'] };
const NO_CARRIER = { operstate: 'DOWN', flags: ['NO-CARRIER', 'BROADCAST', 'MULTICAST', 'UP'] };

interface Answers {
  apStatus?: () => Promise<unknown>;
  snapshot?: () => Promise<unknown>;
  unitState?: (unit: string) => Promise<unknown>;
}

function platformWith(answers: Answers): Platform {
  return {
    ap: { status: answers.apStatus ?? (async () => ({ state: 'ENABLED' })) },
    net: {
      snapshot:
        answers.snapshot ??
        (async () => ({
          links: [{ name: 'end0', ...UP }],
          addresses: [{ name: 'end0', family: 'inet', address: '192.0.2.5', prefixLength: 24 }],
          routes: [],
          at: Date.now(),
        })),
    },
    systemd: {
      state: answers.unitState ?? (async (unit: string) => ({ unit, activeState: 'active', isActive: true })),
    },
  } as unknown as Platform;
}

const SUBJECT: WindowSubject = {
  transactionId: 'abc123',
  expects: { accessPoint: true, uplink: true, core: true },
  // A change that acted on both, so every check is reachable. The scope tests take this away.
  scope: { uplink: ['rewrites /etc/systemd/network/20-wayfarer-wan.network'], accessPoint: ['restarts wf-hostapd@wlan1.service'] },
  accessPointInterface: 'wlan1',
  uplinkInterfaces: ['end0'],
  startedUnits: ['wf-hostapd@wlan1.service', 'wf-dhcp@wlan1.service'],
};

function watcher(platform: Platform, onFinding: (id: string, finding: WindowFinding | null) => Promise<void>) {
  return createWindowWatch({
    platform,
    onFinding,
    stillOpen: () => true,
    log: () => undefined,
  });
}

test('window checks: a healthy device yields no finding and is never confirmed', async () => {
  const reverts: string[] = [];
  const watch = watcher(platformWith({}), async (id, finding) => {
    if (finding !== null) reverts.push(id);
  });
  const reading = await watch.readOnce(SUBJECT, 60_000);

  assert.equal(reading.accessPointEnabled.known, true);
  assert.equal(reading.uplinkUp.known && reading.uplinkUp.value, true);
  assert.deepEqual(reading.failedUnits.known ? reading.failedUnits.value : null, []);
  assert.equal(reverts.length, 0);
  // There is deliberately no outcome here that confirms anything. Confirmation is a human act, and a
  // working uplink does not prove the configuration is the one the operator wanted.
});

test('window checks: every kind of unreadable value becomes unknown, not false', async () => {
  // Three different ways to fail, because in practice they arrive differently: a throw from a control
  // socket, a null from a tool that ran and said nothing, and a rejection from a busy system.
  const cases: { name: string; answers: Answers; field: 'accessPointEnabled' | 'uplinkUp' | 'failedUnits' }[] = [
    { name: 'hostapd threw', answers: { apStatus: async () => { throw new Error('socket gone'); } }, field: 'accessPointEnabled' },
    {
      // The one most likely to be got wrong: hostapd_cli returns nothing when the control socket is
      // not there yet, which is normal moments after a restart. Read as "not enabled" it would revert
      // every access-point change during the seconds it takes to come up.
      name: 'hostapd returned null',
      answers: { apStatus: async () => null },
      field: 'accessPointEnabled',
    },
    { name: 'the network read failed', answers: { snapshot: async () => { throw new Error('busy'); } }, field: 'uplinkUp' },
    {
      name: 'one unit was unreadable',
      answers: { unitState: async () => { throw new Error('dbus timeout'); } },
      field: 'failedUnits',
    },
  ];

  for (const entry of cases) {
    const watch = watcher(platformWith(entry.answers), async () => {
      assert.fail(`${entry.name} produced a finding`);
    });
    // Well past every settle allowance, so nothing is protecting this except the rule itself.
    const reading = await watch.readOnce(SUBJECT, 600_000);
    assert.equal(reading[entry.field].known, false, `${entry.name}: should be unknown`);
  }
});

test('window checks: one unreadable unit does not become an empty list of failures', async () => {
  // Partial knowledge about which units failed is a half-answer, and a half-answer must not drive a
  // revert. So a single unreadable unit makes the whole observation unknown rather than reporting the
  // ones it managed to read.
  const watch = watcher(
    platformWith({
      unitState: async (unit) => {
        if (unit.startsWith('wf-dhcp@')) throw new Error('could not read');
        return { unit, activeState: 'active', isActive: true };
      },
    }),
    async () => assert.fail('a finding was produced'),
  );
  const reading = await watch.readOnce(SUBJECT, 600_000);
  assert.equal(reading.failedUnits.known, false);
});

test('window checks: a failed unit this plan started is conclusive', async () => {
  const watch = watcher(
    platformWith({
      unitState: async (unit) => ({
        unit,
        activeState: unit.startsWith('wf-hostapd@') ? 'failed' : 'active',
        isActive: !unit.startsWith('wf-hostapd@'),
      }),
    }),
    async () => undefined,
  );
  const reading = await watch.readOnce(SUBJECT, 0);
  assert.equal(reading.failedUnits.known && reading.failedUnits.value.length, 1);
});

test('window checks: any uplink being up is enough, because they are a failover group', async () => {
  // Requiring all of them would revert a device that is working perfectly through its second choice.
  const watch = watcher(
    platformWith({
      snapshot: async () => ({
        links: [
          { name: 'end0', ...NO_CARRIER },
          { name: 'wlan0', ...UP },
        ],
        addresses: [{ name: 'wlan0', family: 'inet', address: '192.0.2.9', prefixLength: 24 }],
        routes: [],
        at: Date.now(),
      }),
    }),
    async () => assert.fail('a finding was produced'),
  );
  const reading = await watch.readOnce({ ...SUBJECT, uplinkInterfaces: ['end0', 'wlan0'] }, 600_000);
  assert.equal(reading.uplinkUp.known && reading.uplinkUp.value, true);
});

test('window checks: nothing is concluded about a component the plan never wanted', async () => {
  // An empty uplink list is valid and is the default; `accessPoint` may be null. A check that reverted
  // because an absent component was absent would make the most ordinary profile un-appliable.
  const watch = watcher(
    platformWith({
      apStatus: async () => { throw new Error('there is no access point'); },
      snapshot: async () => { throw new Error('there is no uplink'); },
    }),
    async () => assert.fail('a finding was produced'),
  );
  const reading = await watch.readOnce(
    { ...SUBJECT, expects: { accessPoint: false, uplink: false, core: false } },
    600_000,
  );
  assert.equal(reading.accessPointEnabled.known, false);
  assert.equal(reading.uplinkUp.known, false);
  assert.equal(reading.coreRunning.known, false);
});

test('window checks: a conclusive failure is recorded once, and the window is left open', async () => {
  /*
   * This test used to assert that a conclusive failure *reverted* exactly once. It asserts the
   * opposite half now, on purpose, and the change is a decision rather than a relaxation: a check that
   * reverts on its own gives the device a second deadline it never reports (G13 — told 148 s, gone at
   * 45 s). The property that carries over is "once": a finding is a transition, recorded when the
   * verdict changes, not re-recorded on every tick while it holds.
   *
   * Mutation: in `createWindowWatch`, delete the `if (code === entry.lastCode) return;` guard and this
   * goes red with one finding per tick.
   */
  const findings: (WindowFinding | null)[] = [];
  const watch = createWindowWatch({
    platform: platformWith({
      unitState: async (unit) => ({ unit, activeState: 'failed', isActive: false }),
    }),
    stillOpen: () => true,
    log: () => undefined,
    onFinding: async (_id, finding) => {
      findings.push(finding);
    },
    // Fast ticks so the test does not wait on the real five-second interval.
    thresholds: { intervalMs: 5, uplinkSettleMs: 0, accessPointEnabledMs: 0 },
  });

  watch.start(SUBJECT);
  await new Promise((resolve) => setTimeout(resolve, 120));
  watch.stop(SUBJECT.transactionId);

  assert.equal(findings.length, 1, `recorded ${findings.length} findings for one unchanged verdict`);
  assert.equal(findings[0]?.code, 'unit_failed');
  assert.ok(findings[0]!.evidence.some((line) => line.includes('ActiveState=failed')), 'the finding carries no evidence');
});

test('window checks: starting the same watch twice does not double the polling', async () => {
  let readings = 0;
  const watch = createWindowWatch({
    platform: platformWith({
      unitState: async (unit) => {
        readings += 1;
        return { unit, activeState: 'active', isActive: true };
      },
    }),
    stillOpen: () => true,
    log: () => undefined,
    onFinding: async () => assert.fail('a healthy device produced a finding'),
    thresholds: { intervalMs: 10, uplinkSettleMs: 45_000, accessPointEnabledMs: 30_000 },
  });

  watch.start(SUBJECT);
  watch.start(SUBJECT);
  await new Promise((resolve) => setTimeout(resolve, 60));
  watch.stop(SUBJECT.transactionId);
  const afterStop = readings;
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.ok(readings > 0, 'nothing was ever read');
  // Stopping means stopping: a watcher that kept running after the window closed would revert a
  // transaction somebody had already confirmed.
  assert.equal(readings, afterStop, 'the watcher kept polling after it was stopped');
});

test('window checks: a tick that throws does not kill the watcher', async () => {
  // A watcher that dies on one bad tick leaves a window with no checks, and that looks exactly like a
  // healthy one from outside — which is the state this whole module exists to prevent.
  let calls = 0;
  const watch = createWindowWatch({
    platform: platformWith({
      unitState: async (unit) => {
        calls += 1;
        if (calls === 1) throw new Error('a transient fault');
        return { unit, activeState: 'active', isActive: true };
      },
    }),
    stillOpen: () => true,
    log: () => undefined,
    onFinding: async () => assert.fail('a transient read error produced a finding'),
    thresholds: { intervalMs: 5, uplinkSettleMs: 45_000, accessPointEnabledMs: 30_000 },
  });

  watch.start(SUBJECT);
  await new Promise((resolve) => setTimeout(resolve, 60));
  watch.stop(SUBJECT.transactionId);
  assert.ok(calls > 2, `the watcher stopped after the first fault (${calls} calls)`);
});

/* ── G5: the reading, against the shapes this board produces ─────────────────────────────── */

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

test('G5: the uplink on the real board capture reads as up, with carrier and address', async () => {
  /*
   * `test/fixtures/ip/*.json` is `ip -j link show` / `ip -j addr show` captured on the bench board.
   * `wlan0` there is the uplink: `UP`, flags `…,UP,LOWER_UP`, `192.168.1.237/24`. The reader compared
   * `operstate` with lower-case `'up'`, which `ip` never prints, so this read as no carrier — the
   * false verdict of 2026-09-22.
   *
   * Mutation: in `linkCarrier`, delete the `LOWER_UP` branch and compare `link.operstate === 'up'`
   * as the old reader did — this goes red naming `wlan0`.
   */
  const snapshot = {
    links: parseIpLinks(fixture('ip/link.json')),
    addresses: parseIpAddresses(fixture('ip/addr.json')),
    routes: [],
    at: Date.now(),
  };
  const watch = watcher(platformWith({ snapshot: async () => snapshot }), async () => assert.fail('a finding was produced'));
  const reading = await watch.readOnce({ ...SUBJECT, uplinkInterfaces: ['wlan0'] }, 600_000);

  assert.equal(reading.uplinkUp.known && reading.uplinkUp.value, true, `wlan0 read as down: ${reading.uplinkEvidence.join(' | ')}`);
  assert.deepEqual(reading.uplinkEvidence, ['wlan0: operstate UP, flags BROADCAST,MULTICAST,UP,LOWER_UP, inet 192.168.1.237/24']);
});

test('G5: the exact interface state measured at the false revert reads as up', () => {
  // `wfwan0` at 19:04:10 on 2026-09-22, as measured beside the revert that called it dead.
  const measured = {
    links: [{ name: 'wfwan0', operstate: 'UP', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'] }],
    addresses: [{ name: 'wfwan0', family: 'inet', address: '192.168.77.8', prefixLength: 24 }],
  };
  const read = readUplinks(measured, ['wfwan0']);
  assert.equal(read.up.known && read.up.value, true, read.evidence.join(' | '));
});

test('G5: a real carrier-less link on the board capture still reads as down', () => {
  // The other half: `end0` in the same capture is `DOWN` with `NO-CARRIER` and no address. A reader
  // that could no longer say "down" would have fixed the false verdict by going blind.
  const snapshot = { links: parseIpLinks(fixture('ip/link.json')), addresses: parseIpAddresses(fixture('ip/addr.json')) };
  const read = readUplinks(snapshot, ['end0']);
  assert.equal(read.up.known, true);
  assert.equal(read.up.known && read.up.value, false);
  assert.match(read.evidence[0]!, /end0: operstate DOWN, flags NO-CARRIER/);
});

test('G5: an uplink missing from the snapshot is unknown, never down', () => {
  // A name resolved before a rename, or an `ip` that printed nothing: "could not tell", not "no".
  const read = readUplinks({ links: [{ name: 'wlan0', ...UP }], addresses: [] }, ['wfwan0']);
  assert.equal(read.up.known, false);
  assert.match(read.evidence[0]!, /wfwan0: not in `ip link` \(present: wlan0\)/);
});

/* ── G5: the judgement is of the change ──────────────────────────────────────────────────── */

test('G5: a core-config change and a wf-core restart put neither the uplink nor the access point in scope', () => {
  // The exact change set of 6110779e063cfb9f: one file, one restart.
  const scope = windowScopeOf(
    {
      fileChanges: [{ path: '/etc/wayfarer/core/config.json' }],
      unitChanges: [{ name: 'wf-core.service', action: 'restart' }],
      interfaceRenames: [],
    },
    [],
  );
  assert.deepEqual(scope, { uplink: [], accessPoint: [] });
});

test('G5: what does put the uplink in scope — its networkd file, the supplicant, a takeover, a rename', () => {
  const cases: [string, Parameters<typeof windowScopeOf>[0], string[]][] = [
    ['networkd file', { fileChanges: [{ path: '/etc/systemd/network/20-wayfarer-wan.network' }], unitChanges: [], interfaceRenames: [] }, []],
    ['supplicant file', { fileChanges: [{ path: '/etc/wayfarer/supplicant/wfwan0.conf' }], unitChanges: [], interfaceRenames: [] }, []],
    ['supplicant restart', { fileChanges: [], unitChanges: [{ name: 'wf-supplicant@wfwan0.service', action: 'restart' }], interfaceRenames: [] }, []],
    ['takeover', { fileChanges: [], unitChanges: [], interfaceRenames: [] }, ['wlan0']],
    ['rename', { fileChanges: [], unitChanges: [], interfaceRenames: [{ from: 'wlan0', to: 'wfwan0' }] }, []],
  ];
  for (const [name, plan, takeovers] of cases) {
    assert.ok(windowScopeOf(plan, takeovers).uplink.length > 0, `${name} did not put the uplink in scope`);
  }
  // And a hostapd restart is the access point's, not the uplink's.
  const ap = windowScopeOf({ fileChanges: [], unitChanges: [{ name: 'wf-hostapd@wlx90de8047b4b4.service', action: 'restart' }], interfaceRenames: [] }, []);
  assert.deepEqual(ap.uplink, []);
  assert.equal(ap.accessPoint.length, 1);
});

test('G5: a watched core-only change with the uplink genuinely down produces no uplink finding', async () => {
  // End to end through the watcher: the uplink is really down, well past the settle allowance, and the
  // change never touched it. Judging the device here is what destroyed four healthy changes.
  const watch = watcher(
    platformWith({ snapshot: async () => ({ links: [{ name: 'end0', ...NO_CARRIER }], addresses: [], routes: [], at: 0 }) }),
    async () => assert.fail('a core-only change was judged by the uplink'),
  );
  const subject = { ...SUBJECT, scope: { uplink: [], accessPoint: [] } };
  const findings: (WindowFinding | null)[] = [];
  const live = createWindowWatch({
    platform: platformWith({ snapshot: async () => ({ links: [{ name: 'end0', ...NO_CARRIER }], addresses: [], routes: [], at: 0 }) }),
    stillOpen: () => true,
    log: () => undefined,
    onFinding: async (_id, finding) => {
      findings.push(finding);
    },
    thresholds: { intervalMs: 5, uplinkSettleMs: 0, accessPointEnabledMs: 0 },
  });
  const reading = await watch.readOnce(subject, 600_000);
  assert.equal(reading.uplinkUp.known && reading.uplinkUp.value, false, 'the stand-in should really read the uplink down');
  live.start(subject);
  await new Promise((resolve) => setTimeout(resolve, 60));
  live.stop(subject.transactionId);
  assert.deepEqual(findings, []);
});
