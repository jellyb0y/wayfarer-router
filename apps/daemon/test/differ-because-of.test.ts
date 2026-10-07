/**
 * Why a restart is in the plan, recorded as the paths it is for.
 *
 * ## The defect
 *
 * Six times in a row the core was restarted with a configuration file whose rewrite had been
 * refused, and the caller recorded success every time. The plan was right and the refusal was right;
 * what was missing was the one fact joining them. A restart had no way to say what it was for, so
 * nothing downstream could notice that the reason had not happened.
 *
 * `becauseOf` is that fact, as **paths**: a refusal is per path, so a path is the only key the two
 * sides share. A boolean would say a restart has causes and leave a caller unable to check whether
 * *its* causes survived.
 *
 * ## The two readings this file keeps apart
 *
 * **Absent is "not recorded", never "no causes".** The distinction carries a decision: a restart with
 * no `becauseOf` is never skippable. So a test that accepts an absent field where a populated one is
 * required would assert the opposite of the rule, and every check below names which of the two it
 * expects rather than checking truthiness.
 *
 * **An empty array is impossible by construction** — the restart is planned only because a cause was
 * found — and that is asserted here rather than trusted, because it is what lets a consumer treat a
 * non-empty list as the only populated shape.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { diff, type Reality } from '../src/core/differ.ts';
import { PATHS, emptyDesiredState, type DesiredState } from '../src/core/desired-state.ts';

const UNIT = 'wf-core.service';
const DEFINITION = `${PATHS.unitDir}/${UNIT}`;
const CONFIG = '/etc/wayfarer/core/config.json';

/**
 * One running unit, its definition, and a configuration file that declares the unit as its consumer.
 *
 * `wf-core.service` and a path under `/core/` are **also** matched by the legacy path-shape net that
 * predates the declarations, so these fixtures exercise the definition rule and the overlap. The
 * declaration rule on its own is proved further down, against a unit and a path the net cannot
 * reach — see the note there for how that gap was found.
 */
function desiredState(options: { definition: string; config: string }): DesiredState {
  const desired = emptyDesiredState();
  desired.units.push({
    name: UNIT,
    enabled: true,
    active: true,
    purpose: 'the proxy core',
    content: options.definition,
  });
  desired.files.push({
    path: DEFINITION,
    content: options.definition,
    mode: 0o644,
    purpose: `the unit definition for ${UNIT}`,
    // A unit file is consumed by systemd, never by one of our units. This is what makes the
    // definition invisible to the consumer walk, and why it is added as a cause on its own.
    consumedBy: { kind: 'external', by: 'systemd' },
  });
  desired.files.push({
    path: CONFIG,
    content: options.config,
    mode: 0o600,
    purpose: 'the proxy core configuration',
    consumedBy: { kind: 'unit', unit: UNIT },
  });
  return desired;
}

function reality(options: { definition: string; config: string; active?: boolean }): Reality {
  return {
    files: [
      { path: DEFINITION, content: options.definition, mode: 0o644 },
      { path: CONFIG, content: options.config, mode: 0o600 },
    ],
    units: [{ name: UNIT, active: options.active ?? true, enabled: true, known: true }],
    interfaces: [{ name: 'end0', mac: '02:81:5a:11:22:33' }],
    managementInterfaces: ['end0'],
    sysctl: {},
  };
}

const SAME = { definition: '[Unit]\nDescription=core\n', config: '{"a":1}\n' };

/** The one step of a given action, asserted to exist before anything is said about its fields. */
function step(plan: ReturnType<typeof diff>, action: string): { becauseOf?: string[] } {
  const found = plan.unitChanges.filter((change) => change.action === action && change.name === UNIT);
  assert.equal(
    found.length,
    1,
    `expected exactly one "${action} ${UNIT}" step, got ${found.length}: ${plan.unitChanges
      .map((change) => `${change.action} ${change.name}`)
      .join(', ')}`,
  );
  return found[0]!;
}

test('a restart caused by a configuration rewrite names that file and nothing else', () => {
  const plan = diff({
    desired: desiredState({ ...SAME, config: '{"a":2}\n' }),
    reality: reality(SAME),
  });
  assert.deepEqual(step(plan, 'restart').becauseOf, [CONFIG]);
});

/**
 * A unit's own definition is its own cause, and nothing else in the differ can reach it.
 *
 * The consumer walk reads `consumedBy`, and a unit file declares `{ kind: 'external', by: 'systemd' }`
 * — correctly, because systemd is what reads it. So a restart whose only reason is a rewritten
 * definition would arrive with no causes at all, which reads as "not recorded" and would make it
 * unskippable for the wrong reason: the right answer is that it has exactly one cause and that the
 * cause is the definition.
 *
 * This is the same blind spot as the defect already fixed here, where a unit whose definition
 * changed was reloaded and never restarted.
 */
test('a rewritten unit definition is its own cause', () => {
  const plan = diff({
    desired: desiredState({ ...SAME, definition: '[Unit]\nDescription=core, reworded\n' }),
    reality: reality(SAME),
  });
  assert.deepEqual(step(plan, 'restart').becauseOf, [DEFINITION]);
});

/**
 * Two causes in one apply, which is the case the "all, not any" rule exists for.
 *
 * A consumer that skipped on *any* refused cause would skip this restart when only the
 * configuration was refused — leaving the rewritten definition written and never in force, which is
 * the original defect with the sides swapped.
 */
test('a restart with two reasons carries both, so neither can be skipped on the other', () => {
  const plan = diff({
    desired: desiredState({ definition: '[Unit]\nDescription=reworded\n', config: '{"a":2}\n' }),
    reality: reality(SAME),
  });
  assert.deepEqual([...(step(plan, 'restart').becauseOf ?? [])].sort(), [CONFIG, DEFINITION].sort());
});

/**
 * **What this check prints when it is given nothing.**
 *
 * A step planned because the unit is *down* has no file cause: nothing was written for it, and it is
 * in the plan because the unit is not running. Attaching the files it happens to share an apply with
 * would make a unit that is down skippable the moment those writes were refused.
 *
 * The step is asserted to exist first. A test that only asked "the start step has no becauseOf"
 * would be green on a plan with no start step at all — which is the same assertion, satisfied by
 * nothing, and is precisely the shape this project keeps finding.
 */
test('a step planned because the unit is down carries no cause at all', () => {
  const plan = diff({
    desired: desiredState({ ...SAME, config: '{"a":2}\n' }),
    reality: reality({ ...SAME, active: false }),
  });
  const start = step(plan, 'start');
  assert.equal('becauseOf' in start, false, 'a unit that is down must not be given a file cause');
  assert.equal(start.becauseOf, undefined);
  // And the files that changed in the same apply are genuinely there, so the absence above is a
  // decision rather than an empty input: with a cause available, it was still not attached.
  assert.ok(
    plan.fileChanges.some((change) => change.path === CONFIG),
    'the configuration rewrite must be in this plan, or the start step had nothing to be given',
  );
});

/** A converged device plans nothing, so there is no step for the field to be wrong about. */
test('a converged device plans no restart, and therefore no causes', () => {
  const plan = diff({ desired: desiredState(SAME), reality: reality(SAME) });
  assert.deepEqual(
    plan.unitChanges.map((change) => `${change.action} ${change.name}`),
    [],
  );
});

/**
 * Non-empty by construction, asserted rather than trusted.
 *
 * The consumer rule — skip only when present, non-empty and every path refused — leans on there
 * being no third shape. If a restart could carry `[]`, a consumer reading "every path was refused"
 * over an empty list would find that vacuously true and skip a restart it knows nothing about: the
 * "all clear" answer produced from no information, one more time.
 */
test('no restart ever carries an empty cause list', () => {
  const plans = [
    diff({ desired: desiredState({ ...SAME, config: '{"a":2}\n' }), reality: reality(SAME) }),
    diff({ desired: desiredState({ ...SAME, definition: '[Unit]\nX=1\n' }), reality: reality(SAME) }),
    diff({ desired: desiredState({ definition: '[Unit]\nX=1\n', config: '{"a":2}\n' }), reality: reality(SAME) }),
    diff({ desired: desiredState(SAME), reality: reality({ ...SAME, active: false }) }),
  ];
  let restarts = 0;
  for (const plan of plans) {
    for (const change of plan.unitChanges) {
      if (change.becauseOf === undefined) continue;
      restarts += 1;
      assert.ok(change.becauseOf.length > 0, `${change.action} ${change.name} carries an empty cause list`);
    }
  }
  assert.ok(restarts >= 3, `expected at least three steps carrying causes across these plans, got ${restarts}`);
});

/**
 * A cause is listed once, however many of the three rules found it.
 *
 * The core's configuration is both declared as consumed by `wf-core.service` and matched by the
 * path-shape net that predates the declarations. A consumer asking "were all of my causes refused"
 * against a list with duplicates is comparing against a multiset for no reason, and the duplicate
 * would be invisible in a plan review.
 */
test('a file found by two rules is named once', () => {
  const plan = diff({
    desired: desiredState({ ...SAME, config: '{"a":2}\n' }),
    reality: reality(SAME),
  });
  const causes = step(plan, 'restart').becauseOf ?? [];
  assert.deepEqual(causes, [...new Set(causes)]);
});

/**
 * Every path named is a path this plan actually changes.
 *
 * The join a consumer makes is `becauseOf` against the refused file changes. A cause naming a file
 * the plan does not touch can never be refused, so it would make the restart permanently
 * unskippable — the safe direction, but silently, and for a reason nobody could see.
 */
test('every cause is a file change in the same plan', () => {
  const plan = diff({
    desired: desiredState({ definition: '[Unit]\nX=1\n', config: '{"a":2}\n' }),
    reality: reality(SAME),
  });
  const changed = new Set(plan.fileChanges.map((change) => change.path));
  const causes = step(plan, 'restart').becauseOf ?? [];
  assert.ok(causes.length > 0, 'the restart must carry causes, or this proves nothing');
  for (const cause of causes) {
    assert.ok(changed.has(cause), `"${cause}" is named as a cause but this plan does not change it`);
  }
});


/* ── the declaration rule, where nothing else can reach ──────────────────────────────────── */

/**
 * A cause found **only** because the file declares its consumer.
 *
 * This exists because of a gap in the first version of this file, and the gap is worth recording
 * because it is the same shape as several already in `docs/16`. Every fixture above uses
 * `wf-core.service` with a configuration under `/core/`, which the legacy path-shape net matches as
 * well as the declaration does — so deleting the declaration rule entirely left every test in this
 * file green. A rule with a second rule standing behind it is a rule nothing is measuring.
 *
 * Found by mutation, 2026-09-21: removing `for (const path of consumedPaths ?? []) causes.add(path)`
 * broke nothing. `wf-firewall.service` has no instance name, is not the core, and its ruleset lives
 * nowhere the net looks, so here the declaration is the only thing that can produce the cause.
 */
const FIREWALL = 'wf-firewall.service';
const RULESET = '/etc/wayfarer/nftables.conf';

function declaredOnly(ruleset: string): DesiredState {
  const desired = emptyDesiredState();
  const definition = '[Unit]\nDescription=firewall\n';
  desired.units.push({ name: FIREWALL, enabled: true, active: true, purpose: 'the firewall', content: definition });
  desired.files.push({
    path: `${PATHS.unitDir}/${FIREWALL}`,
    content: definition,
    mode: 0o644,
    purpose: `the unit definition for ${FIREWALL}`,
    consumedBy: { kind: 'external', by: 'systemd' },
  });
  desired.files.push({
    path: RULESET,
    content: ruleset,
    mode: 0o600,
    purpose: 'the firewall ruleset',
    consumedBy: { kind: 'unit', unit: FIREWALL },
  });
  return desired;
}

function declaredOnlyReality(ruleset: string): Reality {
  return {
    files: [
      { path: `${PATHS.unitDir}/${FIREWALL}`, content: '[Unit]\nDescription=firewall\n', mode: 0o644 },
      { path: RULESET, content: ruleset, mode: 0o600 },
    ],
    units: [{ name: FIREWALL, active: true, enabled: true, known: true }],
    interfaces: [{ name: 'end0', mac: '02:81:5a:11:22:33' }],
    managementInterfaces: ['end0'],
    sysctl: {},
  };
}

test('a cause reachable only through the consumer declaration is recorded', () => {
  const plan = diff({ desired: declaredOnly('table inet filter { }\n'), reality: declaredOnlyReality('') });

  const restarts = plan.unitChanges.filter((change) => change.action === 'restart' && change.name === FIREWALL);
  assert.equal(restarts.length, 1, 'the ruleset rewrite must plan a restart, or this proves nothing');
  assert.deepEqual(restarts[0]?.becauseOf, [RULESET]);

  // And the path really is out of the net's reach, so the assertion above cannot be satisfied by the
  // fall-back. Stated as an assertion rather than as a claim in prose: if the net ever grows to cover
  // this path, this test quietly goes back to proving nothing and nobody would know.
  assert.equal(FIREWALL.includes('@'), false, 'an instance name would put this path within the net\'s reach');
  assert.equal(RULESET.includes('/core/'), false, 'a path under /core/ is matched by the net for wf-core.service');
});
