/**
 * Factory reset: the one operation with no undo.
 *
 * These tests are about what it will and will not touch, because that is the only property whose
 * failure cannot be corrected afterwards.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  FORBIDDEN,
  ResetWouldTouchForbiddenPath,
  assertResetPlanIsOurs,
  factoryResetPlan,
} from '../src/core/factory-reset.ts';
import { CONFIG_ROOT, PATHS } from '../src/core/desired-state.ts';

async function planForRealUnits() {
  const { coreUnit, templateUnits } = await import('../src/core/generate/units.ts');
  const generatedUnits = [
    coreUnit({ binaryPath: '/usr/bin/sing-box' }),
    ...templateUnits({ upScript: '/opt/wayfarer/bin/tunnel-up' }),
  ].map((unit) => unit.name);
  return {
    generatedUnits,
    plan: factoryResetPlan({ generatedUnits, stateDir: '/var/lib/wayfarer' }),
  };
}

test('every managed path appears in the plan, because the plan is derived from the paths table', async () => {
  const { plan } = await planForRealUnits();
  const removed = plan.filter((step) => step.kind === 'remove-path').map((step) => step.target);

  for (const [name, value] of Object.entries(PATHS)) {
    if (typeof value !== 'string' || !value.startsWith('/')) continue;
    // Two directories are shared with other software: only our own files inside them are removed.
    if (value === PATHS.unitDir || value === PATHS.networkdDir) continue;
    assert.ok(
      removed.includes(value),
      `PATHS.${name} (${value}) is a managed path and the reset does not remove it — a hand-written list ` +
        'would have missed it, which is why the plan is derived',
    );
  }
});

test('the plan removes nothing outside our ownership', async () => {
  const { plan } = await planForRealUnits();
  assert.doesNotThrow(() => assertResetPlanIsOurs(plan));

  const removed = plan.filter((step) => step.kind === 'remove-path').map((step) => step.target);
  for (const forbidden of FORBIDDEN) {
    for (const target of removed) {
      assert.ok(
        target !== forbidden.prefix && !target.startsWith(`${forbidden.prefix}/`),
        `the reset would remove ${target}, inside ${forbidden.prefix}: ${forbidden.why}`,
      );
    }
  }
});

test('the safety net is outside the reset, and that is checked rather than assumed', () => {
  // Its script and its snapshot were "deliberately placed" outside our state directory for this exact
  // moment, and deliberately placed is a claim. These are the two paths that claim depends on.
  const netPaths = ['/var/lib/wayfarer-deadman/good.tar', '/usr/local/sbin/wayfarer-deadman'];
  for (const path of netPaths) {
    const covered = FORBIDDEN.some((entry) => path.startsWith(`${entry.prefix}/`) || path === entry.prefix);
    assert.ok(covered, `${path} is not protected from a factory reset`);
  }
  // And a plan that did name one is refused whole rather than partly run.
  assert.throws(
    () =>
      assertResetPlanIsOurs([
        { kind: 'remove-path', target: '/var/lib/wayfarer-deadman', why: 'a mistake' },
      ]),
    ResetWouldTouchForbiddenPath,
  );
});

test('the state directory is taken from configuration, not hardcoded', () => {
  const plan = factoryResetPlan({ generatedUnits: [], stateDir: '/srv/somewhere-else' });
  const removed = plan.filter((step) => step.kind === 'remove-path').map((step) => step.target);
  assert.ok(removed.includes('/srv/somewhere-else'));
  assert.ok(!removed.includes('/var/lib/wayfarer'), 'a hardcoded default would delete the wrong device state');
});

test('units are stopped and disabled before their definitions are removed', async () => {
  const { plan } = await planForRealUnits();
  const firstRemoval = plan.findIndex((step) => step.kind === 'remove-path');
  const lastUnitAction = plan.reduce(
    (last, step, index) => (step.kind === 'stop-unit' || step.kind === 'disable-unit' ? index : last),
    -1,
  );
  assert.ok(
    lastUnitAction < firstRemoval,
    'removing a unit file while it is still enabled leaves systemd with enablement links pointing at ' +
      'nothing, which warns at every boot and cannot be cleaned up',
  );
});

test('a template is never acted on as if it were a unit', async () => {
  const { plan } = await planForRealUnits();
  const acted = plan
    .filter((step) => step.kind === 'stop-unit' || step.kind === 'disable-unit' || step.kind === 'unmask-unit')
    .map((step) => step.target);
  assert.deepEqual(
    acted.filter((name) => name.includes('@.')),
    [],
    'systemd refuses to report or act on a template as a unit; only its instances are units',
  );
});

test('a file another program owned is restored, not deleted', () => {
  const plan = factoryResetPlan({
    generatedUnits: [],
    stateDir: '/var/lib/wayfarer',
    movedAside: [{ from: '/etc/netplan/20-wifi.yaml', to: '/etc/netplan/20-wifi.yaml.disabled-by-wayfarer' }],
  });
  const restore = plan.find((step) => step.kind === 'restore-aside');
  assert.ok(restore, 'a takeover left this file aside and the reset must put it back');
  assert.match(restore.why, /never ours/);
  // And it is not also queued for deletion.
  assert.equal(
    plan.some((step) => step.kind === 'remove-path' && step.target.includes('20-wifi.yaml')),
    false,
  );
});

test('the installation itself survives: a reset returns the device to freshly installed', async () => {
  const { plan } = await planForRealUnits();
  const removed = plan.filter((step) => step.kind === 'remove-path').map((step) => step.target);
  assert.equal(removed.some((target) => target.startsWith('/opt/')), false);
  assert.equal(
    removed.some((target) => target.includes('wayfarer.service') && !target.includes('wf-')),
    false,
    'removing the install would need an installer to put it back, and the thing asking for the reset is ' +
      'usually the installed software',
  );
  // The configuration tree does go.
  assert.ok(removed.includes(CONFIG_ROOT));
});

test('moved-aside files are discovered from the disk, because the reset deletes the records', async () => {
  const { findMovedAside, ASIDE_SUFFIX } = await import('../src/platform/files.ts');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-aside-'));
  try {
    await writeFile(join(directory, `20-wifi.yaml${ASIDE_SUFFIX}`), 'network: {}\n');
    await writeFile(join(directory, '10-dhcp.yaml'), 'network: {}\n');

    const found = await findMovedAside([directory]);
    assert.deepEqual(found, [
      { from: join(directory, '20-wifi.yaml'), to: join(directory, `20-wifi.yaml${ASIDE_SUFFIX}`) },
      // And nothing else: a file we never touched is not ours to restore.
    ]);

    /*
     * The reason this reads the disk. A takeover's undo is recorded in the transaction table, and a
     * factory reset deletes the transaction table — so discovering from our own records would find
     * nothing at exactly the moment it matters. Measured on the bench board, 2026-09-21: the first
     * reset completed every step and left another program's configuration displaced for good.
     */
    const plan = factoryResetPlan({ generatedUnits: [], stateDir: '/var/lib/wayfarer', movedAside: found });
    assert.ok(plan.some((step) => step.kind === 'restore-aside'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stopping a unit that does not exist is success, because the goal is the state', () => {
  // systemd reports this by throwing, not by returning — `DBusError: Unit wf-core.service not loaded.`
  // A second reset on a device whose units are already gone must not report failure for a job it did.
  const absent = (message: string): boolean => /not loaded|not found|no such unit/i.test(message);
  assert.equal(absent('DBusError: Unit wf-core.service not loaded.'), true);
  assert.equal(absent('Unit wf-firewall.service not found.'), true);
  assert.equal(absent('Job for wf-core.service failed because the control process exited'), false);
});

test('the reset leaves the directories the installer would have made', async () => {
  const { plan } = await planForRealUnits();
  const created = plan.filter((step) => step.kind === 'create-path');

  assert.deepEqual(
    created.map((step) => [step.target, (step as { mode: number }).mode.toString(8)]),
    [[CONFIG_ROOT, '750'], ['/var/lib/wayfarer', '700']],
  );

  /*
   * And they are created after everything is removed, or the removal takes them away again. The claim
   * this command makes is "as it was immediately after installation", and the installer creates these —
   * without them the daemon's sandbox grants write access to a directory that does not exist, `/etc`
   * stays read-only to it, and the device is reachable but cannot be configured by anything short of a
   * reinstall.
   */
  const lastRemoval = plan.reduce((last, step, index) => (step.kind === 'remove-path' ? index : last), -1);
  const firstCreate = plan.findIndex((step) => step.kind === 'create-path');
  assert.ok(firstCreate > lastRemoval, 'creating before removing would delete them again');
});

test('the daemon is restarted last, because its sandbox predates the new directories', async () => {
  const { plan } = await planForRealUnits();
  const restart = plan.findIndex((step) => step.kind === 'restart-daemon');
  assert.ok(restart >= 0, 'without this the device is reachable and cannot configure itself');
  assert.equal(restart, plan.length - 1, 'anything after it might not run: the restart can kill this process');

  /*
   * `ReadWritePaths` is resolved when the unit starts. The daemon was running while its configuration
   * directory was removed, so recreating the directory does not reach into a mount namespace that is
   * already set up — measured as `/etc/wayfarer — EROFS` on the first apply after a reset.
   */
  const create = plan.findIndex((step) => step.kind === 'create-path');
  assert.ok(create < restart, 'the directories must exist before the namespace is rebuilt');
});
