/**
 * A restart whose reasons were refused, and what the caller is told about it.
 *
 * ## The defect
 *
 * Six times in a row the core was restarted with a configuration file whose rewrite had been
 * refused, and the reconciler recorded success every time. Every half was correct on its own: the
 * refusal named the file, the restart ran, systemd answered `done`. Nothing joined them, so an apply
 * that changed nothing at all reported a successful restart of the thing it had not changed.
 *
 * `UnitChange.becauseOf` is the join, as paths, and this file is the consumer. A field computed and
 * read by nothing is the mirror of a response key no schema declares: both look from outside exactly
 * like a device with nothing to report.
 *
 * ## A skip is a refusal, not a failed step
 *
 * A step reporting `ok: false` says "I tried and it did not work", and that did not happen — a report
 * of an action that never took place, which is the family of lie this whole mechanism exists to
 * remove. The reconciler already has a channel for what it declined to do, and a skip belongs there.
 * It is also the difference between a caller that can act and one that cannot: a refusal names the
 * files and their class, so a script can re-run with wider classes; "the step failed" tells it
 * nothing, because nothing said there was nothing to succeed at.
 *
 * ## The direction that matters more than the obvious one
 *
 * The rule is **all**, not any: skip only when *every* path in `becauseOf` was refused. The wrong
 * version looks safer — "any" skips more, and skipping reads as caution — and a test that only
 * checks the full-refusal case passes with it. So the partial case is asserted here in its own test,
 * and it is the one to keep if only one survives.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { reconcile } from '../src/core/reconciler.ts';
import { diff, type Plan2, type Reality } from '../src/core/differ.ts';
import { PATHS, emptyDesiredState, type DesiredState } from '../src/core/desired-state.ts';
import type { Platform } from '../src/platform/index.ts';

const UNIT = 'wf-firewall.service';
const DEFINITION = `${PATHS.unitDir}/${UNIT}`;
/** The ruleset. A `network`-class file, so a `service`-only apply refuses to write it. */
const RULESET = '/etc/wayfarer/nftables.conf';

/**
 * Records what the tools were asked to do. Everything succeeds: this file is about the steps that
 * are never reached, so a failure anywhere else would be indistinguishable from the skip.
 */
function recorder(): { platform: Platform; calls: string[] } {
  const calls: string[] = [];
  const job = (unit: string): Promise<{ result: string; unit: string; jobPath: string; waitedMs: number }> => {
    calls.push(`restart:${unit}`);
    return Promise.resolve({ result: 'done', unit, jobPath: '/job/1', waitedMs: 3 });
  };
  const platform = {
    systemd: {
      start: (unit: string) => job(unit),
      restart: (unit: string) => job(unit),
      stop: (unit: string) => Promise.resolve({ result: 'done', unit, jobPath: '', waitedMs: 1 }),
      reload: (unit: string) => job(unit),
      enable: (unit: string) => {
        calls.push(`enable:${unit}`);
        return Promise.resolve();
      },
      disable: () => Promise.resolve(),
      daemonReload: () => {
        calls.push('daemon-reload');
        return Promise.resolve();
      },
      state: (unit: string) => Promise.resolve({ unit, isActive: true, isEnabled: true }),
      show: () => Promise.resolve({}),
    },
    nft: {
      check: () => Promise.resolve({ ok: true, message: '' }),
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
  return { platform, calls };
}

/**
 * The firewall, running, with its ruleset and optionally a rewritten definition.
 *
 * The pair is chosen so the two causes land in **different** classes: the ruleset is `network` and a
 * unit definition is `service`, so a `service`-only apply refuses exactly one of them. A fixture
 * whose causes shared a class could not express the partial case at all.
 */
function state(options: { ruleset: string; definition: string }): DesiredState {
  const desired = emptyDesiredState();
  desired.units.push({ name: UNIT, enabled: true, active: true, purpose: 'the firewall', content: options.definition });
  desired.files.push({
    path: DEFINITION,
    content: options.definition,
    mode: 0o644,
    purpose: `the unit definition for ${UNIT}`,
    consumedBy: { kind: 'external', by: 'systemd' },
  });
  desired.files.push({
    path: RULESET,
    content: options.ruleset,
    mode: 0o600,
    purpose: 'the firewall ruleset',
    consumedBy: { kind: 'unit', unit: UNIT },
  });
  return desired;
}

const RUNNING = { ruleset: 'table inet wayfarer { }\n', definition: '[Unit]\nDescription=firewall\n' };

function reality(): Reality {
  return {
    files: [
      { path: DEFINITION, content: RUNNING.definition, mode: 0o644 },
      { path: RULESET, content: RUNNING.ruleset, mode: 0o600 },
    ],
    units: [{ name: UNIT, active: true, enabled: true, known: true }],
    interfaces: [{ name: 'end0', mac: '02:81:5a:11:22:33' }],
    managementInterfaces: ['end0'],
    sysctl: {},
  };
}

/** Narrowed on purpose: an un-narrowed plan carrying a refusal is refused whole, before any of this. */
const SERVICE_ONLY = { classes: ['hot', 'service'] as const };

test('a restart whose every reason was refused does not run, and is reported as a refusal', async () => {
  const { platform, calls } = recorder();
  const desired = state({ ...RUNNING, ruleset: 'table inet wayfarer { chain input { } }\n' });
  const plan = diff({ desired, reality: reality() });

  // The premise, asserted rather than assumed: the plan really does contain this restart, and its
  // only reason really is the file the apply is about to refuse. Without this, the assertions below
  // would be satisfied by a plan with no restart in it at all.
  const planned = plan.unitChanges.find((change) => change.action === 'restart' && change.name === UNIT);
  assert.ok(planned, 'the ruleset rewrite must plan a restart, or this test proves nothing');
  assert.deepEqual(planned.becauseOf, [RULESET]);

  const result = await reconcile({
    platform,
    desired,
    plan,
    options: { classes: [...SERVICE_ONLY.classes] },
    timeSyncUnit: 'systemd-timesyncd.service',
  });

  assert.equal(result.applied, true, JSON.stringify(result.error));
  assert.equal(calls.includes(`write:${RULESET}`), false, 'the ruleset write was refused, as this test needs');
  assert.equal(calls.includes(`restart:${UNIT}`), false, 'the restart ran with nothing written for it');

  // Reported, and reported as a refusal rather than as a step.
  const refusal = result.refused.find((entry) => entry.what === `restart ${UNIT}`);
  assert.ok(refusal, `the skip was silent; refused: ${JSON.stringify(result.refused)}`);
  assert.match(refusal.needs, /nftables\.conf/, 'the refusal must name the files it was waiting on');
  assert.equal(
    result.steps.some((step) => step.step === `restart ${UNIT}`),
    false,
    'a skip must not appear as a step: nothing was attempted, so there is nothing to report the outcome of',
  );
});

/**
 * **The direction that looks less safe and is.**
 *
 * The definition was rewritten and the ruleset was not. The restart is still what puts the new
 * definition into force, so skipping it would leave a file written on disk and never in effect —
 * the original defect with the sides swapped, and invisible for the same reason.
 *
 * A test that only covered the full-refusal case above would pass against an implementation reading
 * "any refused cause skips", which is why this one exists and why it names both causes explicitly.
 */
test('a restart with only some reasons refused still runs', async () => {
  const { platform, calls } = recorder();
  const desired = state({
    ruleset: 'table inet wayfarer { chain input { } }\n',
    definition: '[Unit]\nDescription=firewall, reworded\n',
  });
  const plan = diff({ desired, reality: reality() });

  const planned = plan.unitChanges.find((change) => change.action === 'restart' && change.name === UNIT);
  assert.ok(planned, 'the rewrite must plan a restart, or this test proves nothing');
  assert.deepEqual([...(planned.becauseOf ?? [])].sort(), [DEFINITION, RULESET].sort());

  const result = await reconcile({
    platform,
    desired,
    plan,
    options: { classes: [...SERVICE_ONLY.classes] },
    timeSyncUnit: 'systemd-timesyncd.service',
  });

  assert.equal(result.applied, true, JSON.stringify(result.error));
  // Exactly one of the two causes survived, which is the whole premise.
  assert.ok(calls.includes(`write:${DEFINITION}`), 'the definition must have been written');
  assert.equal(calls.includes(`write:${RULESET}`), false, 'the ruleset must have been refused');

  assert.ok(calls.includes(`restart:${UNIT}`), 'a restart with a surviving reason must still run');
  assert.equal(
    result.refused.some((entry) => entry.what === `restart ${UNIT}`),
    false,
    'a restart that ran must not also be reported as refused',
  );
});

/**
 * Nothing refused, nothing skipped — the ordinary case, asserted so the filter cannot be a blanket.
 *
 * A filter that dropped every restart carrying causes would pass both tests above: the first expects
 * a skip and the second is the only thing standing between "all" and "any". This one stands between
 * either of those and "always".
 */
test('a restart whose reasons were all written runs normally', async () => {
  const { platform, calls } = recorder();
  const desired = state({ ...RUNNING, definition: '[Unit]\nDescription=firewall, reworded\n' });
  const plan = diff({ desired, reality: reality() });

  const planned = plan.unitChanges.find((change) => change.action === 'restart' && change.name === UNIT);
  assert.ok(planned, 'the definition rewrite must plan a restart, or this test proves nothing');
  assert.deepEqual(planned.becauseOf, [DEFINITION]);

  const result = await reconcile({
    platform,
    desired,
    plan,
    options: { classes: [...SERVICE_ONLY.classes] },
    timeSyncUnit: 'systemd-timesyncd.service',
  });

  assert.equal(result.applied, true, JSON.stringify(result.error));
  assert.equal(result.refused.length, 0, `nothing should have been refused: ${JSON.stringify(result.refused)}`);
  assert.ok(calls.includes(`restart:${UNIT}`));
});

/* ── the two readings of a cause list that is not there ──────────────────────────────────── */

/**
 * Absent and empty, proved against a plan this file builds by hand.
 *
 * ## Why a hand-built plan, when every other test here goes through the differ
 *
 * Because the differ **cannot produce either shape**. A restart is planned only once a cause has
 * been found, so `becauseOf` is absent or non-empty and never `[]`. That is what the boundary beside
 * the field promises, and it is exactly what makes the guard unprovable from a real plan: measured
 * 2026-09-21 by deleting the `causes.length > 0` test from the reconciler — the whole daemon suite
 * stayed green. A guard no input can reach reports the same green as a guard that works, which is
 * the shape this repository keeps finding, and the answer is to reach it rather than to trust it.
 *
 * The reconciler takes a `Plan2`, so a plan assembled elsewhere is not a contrivance: it is the
 * input this function accepts, and the contract says what it must do with one. That contract is the
 * reason the boundary is written down at all — a step assembled somewhere that does not track causes
 * must not be read as having been examined and found causeless.
 *
 * ## The trap being guarded
 *
 * `[].every(…)` is `true`. An empty cause list reaching the filter without the length test would be
 * "every cause refused" against no refusals at all, and the step would vanish in silence — a restart
 * dropped for the reason that it had no reasons.
 */

const REFUSED_FILE = '/etc/systemd/network/10-wayfarer-lan.network';

/** A plan the differ would not produce, carrying the two shapes only a hand-built plan can carry. */
function planWith(unitChanges: Plan2['unitChanges'], fileChanges: Plan2['fileChanges'] = []): Plan2 {
  return {
    fileChanges,
    unitChanges,
    sysctlChanges: [],
    interfaceRenames: [],
    blastRadius: 'network',
    humanDiff: [],
    empty: unitChanges.length === 0 && fileChanges.length === 0,
    foreignUnits: [],
    affectsManagementInterfaces: [],
  };
}

test('absent and empty are both read as "not recorded", and neither is ever skipped', async () => {
  const { platform, calls } = recorder();
  const plan = planWith(
    [
      // No field at all: the shape every step assembled outside this differ has.
      { name: 'wf-dhcp@wfap0.service', action: 'restart', purpose: 'addressing', blastRadius: 'service' },
      // Present and empty. Impossible from the differ, and the reading that would drop it silently.
      { name: 'wf-socks.service', action: 'restart', purpose: 'the listener', blastRadius: 'service', becauseOf: [] },
      // The control: a real cause list, entirely refused. Without it, a filter that had stopped
      // working altogether would satisfy every assertion below.
      {
        name: 'wf-metrics.service',
        action: 'restart',
        purpose: 'the counters',
        blastRadius: 'service',
        becauseOf: [REFUSED_FILE],
      },
    ],
    [{ path: REFUSED_FILE, action: 'update', purpose: 'addressing', blastRadius: 'network' }],
  );

  const result = await reconcile({
    platform,
    desired: emptyDesiredState(),
    plan,
    options: { classes: [...SERVICE_ONLY.classes] },
    timeSyncUnit: 'systemd-timesyncd.service',
  });

  assert.equal(result.applied, true, JSON.stringify(result.error));
  // The anchor: the control really was skipped, so the filter is running at all.
  assert.equal(calls.includes('restart:wf-metrics.service'), false, 'the fully-refused control must be skipped');

  assert.ok(calls.includes('restart:wf-dhcp@wfap0.service'), 'a step with no cause list was skipped');
  assert.ok(calls.includes('restart:wf-socks.service'), 'an empty cause list was read as "every cause refused"');
  assert.deepEqual(
    result.refused.filter((entry) => entry.what.startsWith('restart ')).map((entry) => entry.what),
    ['restart wf-metrics.service'],
  );
});

/**
 * And what it says when it is given nothing at all.
 *
 * Asked because the question has been the productive one here. A filter over an empty list with
 * nothing to join against must produce an empty refusal list — not an entry, and not an absent
 * field that a reader would have to guess at.
 */
test('nothing in, nothing out: no refusals, no unit changes, no invented skip', async () => {
  const { platform, calls } = recorder();

  const result = await reconcile({
    platform,
    desired: emptyDesiredState(),
    plan: planWith([]),
    options: { classes: [...SERVICE_ONLY.classes] },
    timeSyncUnit: 'systemd-timesyncd.service',
  });

  assert.equal(result.applied, true, JSON.stringify(result.error));
  assert.deepEqual(result.refused, [], 'an apply with nothing to refuse says so as an empty list');
  assert.equal(
    calls.some((call) => call.startsWith('restart:')),
    false,
  );
});
