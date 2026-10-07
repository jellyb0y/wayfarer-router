/**
 * The distribution units the installer masks, and the drift finding when one is no longer masked.
 *
 * Observed on the bench board, 2026-09-24: the stock `dnsmasq.service` was enabled and failed at every
 * boot while `wf-dhcp@<ap>` served the access point — the two raced for the same sockets and ours
 * happened to win. The installer now masks it; these tests hold the three things that fix rests on:
 *
 * 1. the installer's list and the daemon's list are the same list, name for name and reason for reason;
 * 2. the installer's function, run against a stand-in `systemctl`, masks persistently, skips a unit
 *    that is not installed, and is idempotent;
 * 3. every standing a unit can have becomes the right finding, and "could not ask" never reads as masked.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFLICTING_STOCK_UNITS,
  readStockUnits,
  standingOf,
  type StockUnitReading,
} from '../src/platform/stock-units.ts';
import { compareRunningState, stockUnitFinding } from '../src/core/drift.ts';
import { emptyDesiredState } from '../src/core/desired-state.ts';
import { run } from '../src/platform/exec.ts';

const INSTALLER = join(import.meta.dirname, '..', '..', '..', 'deploy', 'install.sh');

/** The entries of `STOCK_UNITS_TO_MASK=( … )`, parsed the way bash would split them. */
function installerList(script: string): { unit: string; reason: string }[] {
  const block = /^STOCK_UNITS_TO_MASK=\(\n([\s\S]*?)^\)/m.exec(script);
  assert.ok(block !== null, 'install.sh must define STOCK_UNITS_TO_MASK=( … ) as a multi-line array');
  return [...block[1]!.matchAll(/^\s*"([^"|]+)\|([^"]+)"\s*$/gm)].map((match) => ({
    unit: match[1]!,
    reason: match[2]!,
  }));
}

/** The installer's function and the list it reads, cut out of the script so they can run on their own. */
function installerFunction(script: string): string {
  const list = /^STOCK_UNITS_TO_MASK=\([\s\S]*?^\)$/m.exec(script);
  const fn = /^mask_conflicting_stock_units\(\) \{[\s\S]*?^\}$/m.exec(script);
  assert.ok(list !== null && fn !== null, 'install.sh must define the list and mask_conflicting_stock_units()');
  return `${list[0]}\n${fn[0]}\n`;
}

/* ── one list ──────────────────────────────────────────────────────────────────────────────── */

test('the installer masks exactly the units the daemon watches, for the same reasons', async () => {
  const script = await readFile(INSTALLER, 'utf8');
  const fromInstaller = installerList(script);
  assert.ok(fromInstaller.length > 0, 'an empty parse would make this test pass for nothing');
  assert.deepEqual(
    fromInstaller,
    CONFLICTING_STOCK_UNITS.map(({ unit, reason }) => ({ unit, reason })),
    'deploy/install.sh STOCK_UNITS_TO_MASK and platform/stock-units.ts CONFLICTING_STOCK_UNITS differ',
  );
});

test('the stock dnsmasq is on the list, and the units that do not contend are not', () => {
  const names = CONFLICTING_STOCK_UNITS.map((entry) => entry.unit);
  assert.ok(names.includes('dnsmasq.service'));
  // wpa_supplicant.service serves radios no profile names, and ours runs without `-u` so as never to
  // contend with it. Masking it would take a connection this project was never asked to touch.
  assert.ok(!names.includes('wpa_supplicant.service'));
  // hostapd.service holds no port and no global name; it contends only for a radio configured by hand.
  assert.ok(!names.includes('hostapd.service'));
});

/* ── the installer's function, against a stand-in systemctl ─────────────────────────────────── */

/**
 * A `systemctl` that keeps one unit's state in files and logs every call. Just enough of `show`,
 * `is-enabled`, `disable --now` and `mask` to run the installer's function for real.
 */
async function fakeSystemctl(initial: { load: string; enablement: string; maskRefused?: boolean }): Promise<{
  dir: string;
  calls: () => Promise<string[]>;
  enablement: () => Promise<string>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'wayfarer-stock-'));
  await writeFile(join(dir, 'load'), initial.load);
  await writeFile(join(dir, 'enablement'), initial.enablement);
  await writeFile(join(dir, 'calls'), '');
  const script = `#!/bin/bash
state="${dir}"
echo "$*" >> "$state/calls"
case "$1" in
  show) cat "$state/load"; echo ;;
  is-enabled) cat "$state/enablement"; echo; [ "$(cat "$state/enablement")" = enabled ] ;;
  disable) [ "$(cat "$state/enablement")" = masked ] || printf disabled > "$state/enablement" ;;
  mask)
    ${initial.maskRefused === true ? 'echo "Failed to mask unit: File exists" >&2; exit 1' : ''}
    [ "$2" = --runtime ] && printf masked-runtime > "$state/enablement" || printf masked > "$state/enablement" ;;
  *) exit 1 ;;
esac
`;
  await writeFile(join(dir, 'systemctl'), script);
  await chmod(join(dir, 'systemctl'), 0o755);
  return {
    dir,
    calls: async () => (await readFile(join(dir, 'calls'), 'utf8')).split('\n').filter((line) => line !== ''),
    enablement: async () => await readFile(join(dir, 'enablement'), 'utf8'),
  };
}

async function runMask(dir: string, dryRun = false): Promise<{ code: number | null; out: string }> {
  const script = await readFile(INSTALLER, 'utf8');
  const harness = [
    'set -euo pipefail',
    `DRY_RUN=${dryRun ? 1 : 0}`,
    "log()  { printf '[wayfarer] %s\\n' \"$*\"; }",
    "warn() { printf '[wayfarer] warning: %s\\n' \"$*\"; }",
    installerFunction(script),
    'mask_conflicting_stock_units',
  ].join('\n');
  const result = await run('/bin/bash', ['-c', harness], {
    timeoutMs: 10_000,
    // Merged over the process environment by `run`; only the stand-in's directory is put first.
    env: { PATH: `${dir}:${process.env['PATH'] ?? ''}` },
  });
  return { code: result.code, out: result.stdout + result.stderr };
}

test('install: an enabled stock unit is stopped, disabled and masked persistently, with its reason', async () => {
  const fake = await fakeSystemctl({ load: 'loaded', enablement: 'enabled' });
  const { code, out } = await runMask(fake.dir);
  assert.equal(code, 0, out);
  assert.equal(await fake.enablement(), 'masked');
  const calls = await fake.calls();
  assert.ok(calls.includes('disable --now dnsmasq.service'), `stopped as well as disabled: ${calls.join('; ')}`);
  assert.ok(calls.includes('mask dnsmasq.service'), 'masked');
  assert.ok(!calls.some((call) => call.includes('--runtime')), 'never a runtime mask: the race is at boot');
  const reason = CONFLICTING_STOCK_UNITS.find((entry) => entry.unit === 'dnsmasq.service')!.reason;
  assert.ok(out.includes(`masked dnsmasq.service: ${reason}`), out);
});

test('install: a second run changes nothing and says the unit is still masked', async () => {
  const fake = await fakeSystemctl({ load: 'masked', enablement: 'masked' });
  const { code, out } = await runMask(fake.dir);
  assert.equal(code, 0, out);
  const calls = await fake.calls();
  assert.ok(!calls.some((call) => call.startsWith('mask') || call.startsWith('disable')), calls.join('; '));
  assert.match(out, /kept dnsmasq\.service masked/);
});

test('install: a unit that is not installed is skipped without a word', async () => {
  const fake = await fakeSystemctl({ load: 'not-found', enablement: '' });
  const { code, out } = await runMask(fake.dir);
  assert.equal(code, 0, out);
  assert.equal(out.trim(), '');
  const calls = await fake.calls();
  assert.ok(!calls.some((call) => call.startsWith('mask') || call.startsWith('disable')), calls.join('; '));
});

test('install: a mask systemd refuses is a warning, checked by result, and does not abort the install', async () => {
  const fake = await fakeSystemctl({ load: 'loaded', enablement: 'enabled', maskRefused: true });
  const { code, out } = await runMask(fake.dir);
  assert.equal(code, 0, out);
  assert.match(out, /could NOT mask dnsmasq\.service/);
  assert.doesNotMatch(out, /\] masked dnsmasq/);
});

test('install: --dry-run says what it would mask and touches nothing', async () => {
  const fake = await fakeSystemctl({ load: 'loaded', enablement: 'enabled' });
  const { code, out } = await runMask(fake.dir, true);
  assert.equal(code, 0, out);
  assert.equal(await fake.enablement(), 'enabled');
  assert.match(out, /would stop, disable and mask dnsmasq\.service/);
});

test('install: the masking runs from main, before the daemon is started', async () => {
  const script = await readFile(INSTALLER, 'utf8');
  const main = /^main\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0] ?? '';
  const masked = main.indexOf('mask_conflicting_stock_units');
  const unit = main.indexOf('install_unit');
  assert.ok(masked > 0, 'main must call mask_conflicting_stock_units');
  assert.ok(masked < unit, 'masked before install_unit starts the daemon');
});

/* ── the reading ───────────────────────────────────────────────────────────────────────────── */

test('standing: not installed, masked, runtime-masked and unmasked are four different answers', () => {
  assert.equal(standingOf({ known: false, unitFileState: null }), 'absent');
  assert.equal(standingOf({ known: true, unitFileState: 'masked' }), 'masked');
  // Masked now, gone at the next boot — which is when the race happens.
  assert.equal(standingOf({ known: true, unitFileState: 'masked-runtime' }), 'unmasked');
  assert.equal(standingOf({ known: true, unitFileState: 'enabled' }), 'unmasked');
  assert.equal(standingOf({ known: true, unitFileState: 'disabled' }), 'unmasked');
});

test('reading: a controller that throws is "unreadable" for that unit, never "masked"', async () => {
  const readings = await readStockUnits({
    state: async () => {
      throw new Error('the system bus did not answer');
    },
  });
  assert.equal(readings.length, CONFLICTING_STOCK_UNITS.length);
  for (const reading of readings) {
    assert.equal(reading.standing, 'unreadable');
    assert.match(reading.error ?? '', /system bus/);
  }
});

/* ── the finding ───────────────────────────────────────────────────────────────────────────── */

function reading(overrides: Partial<StockUnitReading>): StockUnitReading {
  return {
    unit: 'dnsmasq.service',
    reason: CONFLICTING_STOCK_UNITS[0]!.reason,
    standing: 'masked',
    unitFileState: 'masked',
    activeState: 'inactive',
    ...overrides,
  };
}

test('finding: a masked or absent stock unit is nothing to say', () => {
  assert.equal(stockUnitFinding(reading({})), null);
  assert.equal(stockUnitFinding(reading({ standing: 'absent', unitFileState: null })), null);
});

test('finding: an unmasked, enabled, running stock unit is red, names the unit, the reason and the fix', () => {
  const finding = stockUnitFinding(reading({ standing: 'unmasked', unitFileState: 'enabled', activeState: 'active' }));
  assert.ok(finding !== null);
  assert.equal(finding.kind, 'unit-conflicting');
  assert.equal(finding.subject, 'dnsmasq.service');
  assert.equal(finding.stored, 'masked');
  assert.equal(finding.running, 'enabled, active');
  assert.match(finding.message, /running now/);
  assert.ok(finding.message.includes(CONFLICTING_STOCK_UNITS[0]!.reason));
  assert.match(finding.hint, /systemctl mask dnsmasq\.service/);
});

test('finding: unmasked but idle is still red — nothing then stops it coming back', () => {
  const disabled = stockUnitFinding(reading({ standing: 'unmasked', unitFileState: 'disabled' }));
  assert.ok(disabled !== null);
  assert.match(disabled.message, /nothing stops it/);
  const runtime = stockUnitFinding(reading({ standing: 'unmasked', unitFileState: 'masked-runtime' }));
  assert.match(runtime?.message ?? '', /only until the next boot/);
  const enabled = stockUnitFinding(reading({ standing: 'unmasked', unitFileState: 'enabled' }));
  assert.match(enabled?.message ?? '', /next boot/);
});

test('finding: "could not ask" is its own red finding, never silence', () => {
  const finding = stockUnitFinding(reading({ standing: 'unreadable', unitFileState: null, activeState: null, error: 'bus gone' }));
  assert.ok(finding !== null);
  assert.equal(finding.running, null);
  assert.match(finding.message, /could not say/);
});

test('finding: reported even when the stored profile cannot be planned', () => {
  const { findings } = compareRunningState({
    desired: emptyDesiredState(),
    reality: { files: [], units: [], interfaces: [], managementInterfaces: [], sysctl: {} },
    classified: { fileChanges: [], unitChanges: [], sysctlChanges: [] } as never,
    planUsable: false,
    planError: { pointer: '/uplinks', message: 'no uplink' },
    stockUnits: [reading({ standing: 'unmasked', unitFileState: 'enabled', activeState: 'active' })],
  });
  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['unit-conflicting', 'unplannable'],
  );
});
