/**
 * When a `daemon-reload` is planned, and when it is not.
 *
 * `install` in a plan is one thing: telling systemd to read the unit definitions again. The unit
 * *file* is written through the ordinary managed-file path, so the question "does this plan need a
 * reload" is a question about the file, not about the unit's runtime state.
 *
 * It used to be keyed off "systemd does not know this unit", and both halves of that were wrong on
 * real hardware. Measured on the bench board, 2026-09-20, fresh image, after a committed apply.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { diff, type Reality } from '../src/core/differ.ts';
import { PATHS, emptyDesiredState, type DesiredState } from '../src/core/desired-state.ts';

/** One template and one instance of it, the shape every generated data-plane unit has. */
function templateAndInstance(templateContent: string): DesiredState {
  const desired = emptyDesiredState();
  desired.units.push({
    name: 'wf-dhcp@.service',
    enabled: false,
    active: false,
    purpose: 'address server template',
    content: templateContent,
  });
  desired.units.push({
    name: 'wf-dhcp@wfap0.service',
    enabled: true,
    active: true,
    purpose: 'the address service on wfap0',
  });
  desired.files.push({
    path: `${PATHS.unitDir}/wf-dhcp@.service`,
    content: templateContent,
    mode: 0o644,
    purpose: 'the unit definition for wf-dhcp@.service',
    consumedBy: { kind: 'external', by: 'systemd' },
  });
  return desired;
}

/**
 * What a converged device looks like: the template's file matches, the template itself is **not** a
 * unit systemd can report on, and the instance is loaded, enabled and running.
 */
function convergedReality(templateContent: string): Reality {
  return {
    files: [{ path: `${PATHS.unitDir}/wf-dhcp@.service`, content: templateContent, mode: 0o644 }],
    units: [
      // Deliberately absent: `wf-dhcp@.service`. systemd refuses to report a template's state at all.
      { name: 'wf-dhcp@wfap0.service', active: true, enabled: true, known: true },
    ],
    interfaces: [{ name: 'end0', mac: '02:81:5a:11:22:33' }],
    managementInterfaces: ['end0'],
    sysctl: {},
  };
}

test('a converged device plans no reload, even though systemd cannot report the template', () => {
  const content = '[Unit]\nDescription=address server\n';
  const plan = diff({ desired: templateAndInstance(content), reality: convergedReality(content) });
  assert.deepEqual(
    plan.unitChanges.map((change) => `${change.action} ${change.name}`),
    [],
    'a template whose file matches needs nothing: keying the reload off its unreadable unit state is ' +
      'what made the plan never converge, and never converging forced a network blast radius on to ' +
      'every trivial change',
  );
  assert.equal(plan.empty, true);
  assert.equal(plan.blastRadius, 'hot');
});

test('a changed unit definition plans the reload that makes the change take effect', () => {
  const desired = templateAndInstance('[Unit]\nDescription=new wording\n');
  const plan = diff({ desired, reality: convergedReality('[Unit]\nDescription=old wording\n') });
  const actions = plan.unitChanges.map((change) => `${change.action} ${change.name}`);
  assert.ok(
    actions.includes('install wf-dhcp@.service'),
    'without this, the definition is written and the instance is restarted from the copy systemd still ' +
      `has in memory. Planned instead: ${JSON.stringify(actions)}`,
  );
  assert.ok(
    plan.fileChanges.some((change) => change.path === `${PATHS.unitDir}/wf-dhcp@.service`),
    'the definition is written through the ordinary file path',
  );
});

test('a template whose instance systemd does not know plans a reload', () => {
  // The crash-in-between case: the file was written, nothing reloaded, so the instance is unknown.
  const content = '[Unit]\nDescription=address server\n';
  const reality = convergedReality(content);
  reality.units = [{ name: 'wf-dhcp@wfap0.service', active: false, enabled: false, known: false }];
  const plan = diff({ desired: templateAndInstance(content), reality });
  assert.ok(
    plan.unitChanges.some((change) => change.action === 'install' && change.name === 'wf-dhcp@.service'),
    'the file matching does not prove systemd has read it; an unknown instance is the evidence that it has not',
  );
});

test('a plain unit systemd does not know is still installed', () => {
  const desired = emptyDesiredState();
  desired.units.push({
    name: 'wf-core.service',
    enabled: true,
    active: true,
    purpose: 'the core',
    content: '[Unit]\n',
  });
  desired.files.push({
    path: `${PATHS.unitDir}/wf-core.service`,
    content: '[Unit]\n',
    mode: 0o644,
    purpose: 'the unit definition for wf-core.service',
    consumedBy: { kind: 'external', by: 'systemd' },
  });
  const reality: Reality = {
    files: [{ path: `${PATHS.unitDir}/wf-core.service`, content: '[Unit]\n', mode: 0o644 }],
    units: [],
    interfaces: [],
    managementInterfaces: [],
    sysctl: {},
  };
  const plan = diff({ desired, reality });
  assert.ok(plan.unitChanges.some((change) => change.action === 'install' && change.name === 'wf-core.service'));
});

/* ── the writability probe ───────────────────────────────────────────────────────────────── */

test('a directory that does not exist yet is writable when its parent is', async () => {
  const { directoryWritable } = await import('../src/platform/files.ts');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = await mkdtemp(join(tmpdir(), 'wayfarer-writable-'));
  try {
    // The exact shape that produced a false refusal on hardware: a new generator emits into a
    // directory no installer created, and the writer would have made it on the way past.
    const result = await directoryWritable(join(base, 'supplicant'));
    assert.equal(result.writable, true, `expected writable, got ${result.reason}`);
    // Two levels deep, because `mkdir` is recursive and the probe has to be too.
    assert.equal((await directoryWritable(join(base, 'a', 'b'))).writable, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a directory under an unwritable parent is refused, and the refusal names the parent', async (t) => {
  const { directoryWritable } = await import('../src/platform/files.ts');
  const { mkdtemp, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  if (process.getuid?.() === 0) {
    // root writes through any mode bits, so there is no refusal to observe.
    t.skip('running as root: directory permissions do not refuse anything');
    return;
  }
  const base = await mkdtemp(join(tmpdir(), 'wayfarer-readonly-'));
  try {
    await chmod(base, 0o500);
    const result = await directoryWritable(join(base, 'supplicant'));
    assert.equal(result.writable, false);
    assert.ok(
      result.reason.endsWith(`at ${base}`),
      `the reason must name the ancestor that actually refused, not the directory that does not exist; got ${result.reason}`,
    );
  } finally {
    await chmod(base, 0o700).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});
