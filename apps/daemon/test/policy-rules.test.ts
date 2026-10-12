/**
 * The policy rules this device depends on: reading them, noticing they are gone, putting them back.
 *
 * The cause these exist for, measured on the bench board 2026-10-12 with systemd 257.13: networkd removed
 * every policy rule on its start and on `networkctl reconfigure end0`, and nothing put them back.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { CORE_ROUTE_TABLE } from '@wayfarer/schemas';
import { diff, type Reality } from '../src/core/differ.ts';
import { emptyDesiredState, PATHS } from '../src/core/desired-state.ts';
import { firewallUnit } from '../src/core/generate/units.ts';
import { deviceBypassRules, readPolicyRules } from '../src/core/policy-rules.ts';
import { createObserverRegistry } from '../src/core/observers.ts';
import { reassertPolicyRules, reconcile } from '../src/core/reconciler.ts';
import { watchPolicyRules } from '../src/core/rules-watch.ts';
import { parseIpRules, type PolicyRule } from '../src/platform/parse/ip-json.ts';
import type { Platform } from '../src/platform/index.ts';

/** `ip -j rule show`, verbatim from the bench board, 2026-10-12, with every rule present. */
const BOARD_RULES =
  '[{"priority":0,"src":"all","table":"local"},{"priority":8000,"src":"all","iif":"lo","uid_start":0,"uid_end":0,"table":"main"},' +
  '{"priority":8001,"src":"all","iif":"lo","ipproto":"udp","dport":123,"dport_mask":"0xffff","table":"main"},' +
  '{"priority":8002,"src":"all","iif":"lo","ipproto":"tcp","dport":123,"dport_mask":"0xffff","table":"main"},' +
  '{"priority":9000,"src":"all","dst":"172.19.0.0","dstlen":30,"table":"2022"},{"priority":9001,"src":"all","table":"2022","suppress_prefixlen":0},' +
  '{"priority":9002,"not":null,"src":"all","dport":53,"dport_mask":"0xffff","table":"main","suppress_prefixlen":0},' +
  '{"priority":9002,"src":"all","iif":"tun0","goto":9010},{"priority":9003,"not":null,"src":"all","iif":"lo","table":"2022"},' +
  '{"priority":9003,"src":"0.0.0.0","iif":"lo","table":"2022"},{"priority":9003,"src":"172.19.0.0","srclen":30,"iif":"lo","table":"2022"},' +
  '{"priority":9010,"src":"all","nop":null},{"priority":32766,"src":"all","table":"main"},{"priority":32767,"src":"all","table":"default"}]';

const boardRules = (): PolicyRule[] => parseIpRules(BOARD_RULES);
const without = (rules: PolicyRule[], drop: (rule: PolicyRule) => boolean): PolicyRule[] => rules.filter((rule) => !drop(rule));
const isBypass = (rule: PolicyRule): boolean => rule.priority >= 8000 && rule.priority < 8100;
const isCore = (rule: PolicyRule): boolean => rule.table === String(CORE_ROUTE_TABLE);

test('the board\'s rules parse, including the inverted ones and the uid range', () => {
  const rules = boardRules();
  assert.equal(rules.length, 14);
  assert.deepEqual(rules.find((rule) => rule.priority === 8000), {
    priority: 8000, table: 'main', iif: 'lo', uidStart: 0, uidEnd: 0, ipproto: null, dport: null, inverted: false,
  });
  assert.equal(rules.filter((rule) => rule.inverted).length, 2);
});

test('with every rule present nothing is missing', () => {
  assert.deepEqual(readPolicyRules({ rules: boardRules(), timePorts: [123], coreActive: true }), {
    missingBypass: [], coreCaptureMissing: false,
  });
});

test('after networkd removed them, both sets are reported missing — the core only while it runs', () => {
  const removed = without(boardRules(), (rule) => isBypass(rule) || isCore(rule));
  assert.deepEqual(readPolicyRules({ rules: removed, timePorts: [123], coreActive: true }), {
    missingBypass: [8000, 8001, 8002], coreCaptureMissing: true,
  });
  assert.equal(readPolicyRules({ rules: removed, timePorts: [123], coreActive: false }).coreCaptureMissing, false);
});

test('a rule at the right priority with the wrong selector does not count as present', () => {
  const rules = boardRules().map((rule) => (rule.priority === 8000 ? { ...rule, uidStart: 1000, uidEnd: 1000 } : rule));
  assert.deepEqual(readPolicyRules({ rules, timePorts: [123], coreActive: true }).missingBypass, [8000]);
});

test('the unit installs exactly the rules the check looks for', () => {
  const content = firewallUnit({ timePorts: [123] }).content ?? '';
  for (const rule of deviceBypassRules([123])) {
    assert.ok(content.includes(`rule add priority ${String(rule.priority)} ${rule.selector} lookup main`), rule.selector);
  }
});

/* ── acting ──────────────────────────────────────────────────────────────────────────────── */

/**
 * A device whose rules are a list, where restarting the firewall puts the bypass back and restarting the
 * core puts its capture back — unless told those restarts do nothing.
 */
function device(options: { rules?: PolicyRule[]; restartsFix?: boolean; firewallActive?: boolean } = {}) {
  let rules = options.rules ?? boardRules();
  const calls: string[] = [];
  const full = boardRules();
  const platform = {
    net: {
      rules: () => Promise.resolve(rules),
      reload: () => { calls.push('networkctl reload'); return Promise.resolve({ ok: true, message: '' }); },
      reconfigure: () => {
        calls.push('networkctl reconfigure');
        rules = without(rules, (rule) => isBypass(rule) || isCore(rule));
        return Promise.resolve({ ok: true, message: '' });
      },
      waitForSettle: () => Promise.resolve({ settled: true, perInterface: [] }),
      watchRules: () => ({ stop: () => undefined }),
    },
    systemd: {
      restart: (unit: string) => {
        calls.push(`restart ${unit}`);
        if (unit === 'systemd-networkd.service') rules = without(rules, (rule) => isBypass(rule) || isCore(rule));
        if (options.restartsFix !== false && unit === 'wf-firewall.service') rules = [...without(rules, isBypass), ...full.filter(isBypass)];
        if (options.restartsFix !== false && unit === 'wf-core.service') rules = [...without(rules, isCore), ...full.filter(isCore)];
        return Promise.resolve({ result: 'done', unit, jobPath: '', waitedMs: 1 });
      },
      reload: (unit: string) => {
        calls.push(`reload ${unit}`);
        if (options.restartsFix !== false && unit === 'wf-firewall.service') rules = [...without(rules, isBypass), ...full.filter(isBypass)];
        return Promise.resolve({ result: 'done', unit, jobPath: '', waitedMs: 1 });
      },
      start: (unit: string) => { calls.push(`start ${unit}`); return Promise.resolve({ result: 'done', unit, jobPath: '', waitedMs: 1 }); },
      state: (unit: string) =>
        Promise.resolve({ unit, isActive: unit === 'wf-core.service' || (unit === 'wf-firewall.service' && options.firewallActive !== false), isEnabled: true }),
      enable: () => Promise.resolve(),
      daemonReload: () => Promise.resolve(),
    },
    nft: { check: () => Promise.resolve({ ok: true, message: '' }) },
    files: {
      writeAtomic: (path: string) => { calls.push(`write ${path}`); return Promise.resolve({ path, bytes: 1, changed: true }); },
      readManaged: () => Promise.resolve(null),
      fileMode: () => Promise.resolve(null),
    },
    binaries: { detect: () => Promise.resolve(null), coreSchema: () => Promise.resolve(null) },
  } as unknown as Platform;
  return { platform, calls, rules: () => rules };
}

const noteSteps = async (_step: string, run: () => Promise<{ ok: boolean; detail: string }>) => await run();

test('a missing bypass is put back by reloading the firewall, which takes nothing else down', async () => {
  // Measured 2026-10-12: a restart of wf-firewall also restarted the core, the access point and the address
  // service, dropping every client from the radio. The reload writes only the rules.
  const { platform, calls } = device({ rules: without(boardRules(), isBypass) });
  const result = await reassertPolicyRules(platform, { policyRules: { timePorts: [123], core: true } }, noteSteps);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['reload wf-firewall.service']);
});

test('a firewall unit that is not active cannot be reloaded, so it is restarted', async () => {
  const { platform, calls } = device({ rules: without(boardRules(), isBypass), firewallActive: false });
  const result = await reassertPolicyRules(platform, { policyRules: { timePorts: [123], core: true } }, noteSteps);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['restart wf-firewall.service']);
});

test('the reload writes the same rules as the start, and loads no ruleset', () => {
  const content = firewallUnit({ timePorts: [123] }).content ?? '';
  const reloads = content.split('\n').filter((line) => line.startsWith('ExecReload='));
  assert.equal(reloads.length, deviceBypassRules([123]).length);
  assert.ok(reloads.every((line) => !line.includes('nft')));
});

test('a restart that reports done but brings nothing back is a failure', async () => {
  const { platform } = device({ rules: without(boardRules(), isBypass), restartsFix: false });
  const result = await reassertPolicyRules(platform, { policyRules: { timePorts: [123], core: true } }, noteSteps);
  assert.equal(result.ok, false);
  assert.match(result.after, /8000, 8001, 8002/);
});

test('an apply that lands the networkd drop-in restarts networkd and ends with every rule back', async () => {
  const { platform, calls, rules } = device();
  const desired = emptyDesiredState();
  desired.policyRules = { timePorts: [123], core: true };
  desired.files.push({
    path: PATHS.networkdDropIn,
    content: '[Network]\nManageForeignRoutingPolicyRules=no\n',
    mode: 0o644,
    purpose: 'x',
    consumedBy: { kind: 'external', by: 'systemd-networkd' },
  });
  const reality: Reality = { files: [], units: [], interfaces: [], managementInterfaces: [], sysctl: {} };
  const plan = diff({ desired, reality });
  const result = await reconcile({ platform, desired, plan, timeSyncUnit: 'systemd-timesyncd.service', options: { classes: ['hot', 'service', 'network'] } });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  const networkd = calls.indexOf('restart systemd-networkd.service');
  assert.ok(networkd > calls.indexOf(`write ${PATHS.networkdDropIn}`), 'written before networkd reads it');
  assert.ok(calls.indexOf('reload wf-firewall.service') > networkd);
  assert.ok(calls.indexOf('restart wf-core.service') > networkd);
  assert.deepEqual(readPolicyRules({ rules: rules(), timePorts: [123], coreActive: true }), { missingBypass: [], coreCaptureMissing: false });
});

/* ── the observer ────────────────────────────────────────────────────────────────────────── */

function watched(options: { rules: PolicyRule[]; restartsFix?: boolean; applying?: boolean }) {
  const dev = device(options);
  const events: string[] = [];
  let clock = 0;
  const watch = watchPolicyRules({
    observers: createObserverRegistry(),
    platform: dev.platform,
    timePorts: [123],
    applying: () => options.applying === true,
    record: (event) => events.push(event.kind),
    checkMs: 3_600_000,
    now: () => clock,
  });
  return { ...dev, events, watch, advance: (ms: number) => { clock += ms; } };
}

test('the observer puts missing rules back and records it', async () => {
  const { watch, calls, events } = watched({ rules: without(boardRules(), (rule) => isBypass(rule) || isCore(rule)) });
  await watch.check();
  watch.stop();
  assert.deepEqual(calls, ['reload wf-firewall.service', 'restart wf-core.service']);
  assert.deepEqual(events, ['policy-rules.reinstated']);
});

test('the observer leaves the units alone during an apply', async () => {
  const { watch, calls } = watched({ rules: without(boardRules(), isBypass), applying: true });
  await watch.check();
  watch.stop();
  assert.deepEqual(calls, []);
});

test('repairs that do not hold are spaced a minute apart and stop after three', async () => {
  const { watch, calls, advance } = watched({ rules: without(boardRules(), isBypass), restartsFix: false });
  await watch.check();
  await watch.check(); // within the minute: not attempted
  for (let attempt = 0; attempt < 4; attempt += 1) {
    advance(61_000);
    await watch.check();
  }
  watch.stop();
  assert.equal(calls.filter((call) => call === 'reload wf-firewall.service').length, 3);
});

