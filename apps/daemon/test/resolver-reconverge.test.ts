/**
 * What gets recorded after re-deriving because a peer pushed a different resolver.
 *
 * Every case here exists because the old code recorded success unconditionally. So each one asserts
 * the **kind** of the event and not merely that an event happened: a test where the refused branch
 * and the applied branch produce the same record proves nothing at all, which is the shape that let
 * this run six times on the board while the owner's names did not resolve.
 *
 * The pairs are deliberate. Every negative case has a positive twin differing in one field, so a
 * verdict that stopped consulting that field turns one of the two red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolverReconvergeEvent, type ReconvergeVerification } from '../src/api/resolver-reconverge.ts';
import { PATHS } from '../src/core/desired-state.ts';
import type { ApplyOutcome } from '../src/core/apply.ts';
import type { RefusedChange } from '../src/core/reconciler.ts';

const TRANSACTION = { id: 'tx-1', state: 'applied', blastRadius: 'service', deadlineAt: null, secondsRemaining: null };

/** An outcome shaped like the one the board produced, with whatever the case needs refused. */
function outcome(over: { ok?: boolean; refused?: RefusedChange[]; error?: ApplyOutcome['error'] } = {}): ApplyOutcome {
  return {
    ok: over.ok ?? true,
    transaction: TRANSACTION,
    result: {
      applied: true,
      steps: [],
      refused: over.refused ?? [],
      verificationFailures: [],
    },
    ...(over.error === undefined ? {} : { error: over.error }),
  };
}

/**
 * The refusal measured on the bench board on 2026-09-21.
 *
 * The tunnel reconnected, the peer pushed a new resolver, and the same reconnection moved the
 * tunnel's own subnet — so the difference reached the `ip_cidr` lists, the change was promoted to
 * `network`, and a `hot`/`service` apply refused exactly this while restarting the core anyway.
 */
const CORE_CONFIG_REFUSED: RefusedChange = {
  what: `write ${PATHS.coreConfig}`,
  blastRadius: 'network',
  needs: 'an apply that includes the network class, which re-deriving deliberately does not',
};

// ------------------------------------------------------- the branch that was missing

test('a refused core configuration is never reported as a reconvergence', () => {
  const event = resolverReconvergeEvent(outcome({ refused: [CORE_CONFIG_REFUSED] }));

  // The whole defect in one assertion. This is what was recorded six times while the file on disk
  // had not been rewritten for an hour.
  assert.notEqual(
    event.kind,
    'resolver.reconverged',
    'a re-derive whose file write was refused reported itself as a success',
  );
  assert.equal(event.kind, 'resolver.reconverge-refused');
  assert.equal(event.level, 'warn', 'an operator does not read info lines looking for failures');
});

test('the refusal names the path, the class and what it would have needed', () => {
  const event = resolverReconvergeEvent(outcome({ refused: [CORE_CONFIG_REFUSED] }));

  // A person reading the journal has to be able to act. "Something was refused" sends them to the
  // source; the path, the class and the requirement are the three facts that do not.
  assert.match(event.summary, new RegExp(PATHS.coreConfig.replace(/[.]/g, '\\.')));
  assert.match(event.summary, /network/);
  assert.match(event.summary, /needs an apply that includes the network class/);
  assert.equal(event.detail['coreConfigRefused'], true);
  assert.deepEqual(event.detail['refused'], [CORE_CONFIG_REFUSED]);
});

test('when the core configuration is the refused change, the message says the resolver is not in use', () => {
  const event = resolverReconvergeEvent(outcome({ refused: [CORE_CONFIG_REFUSED] }));

  // Not hedged. When the path matched we know the edit did not land, and the reader is told that
  // rather than being left to infer it from a class name.
  assert.match(event.summary, /NOT in use/);
});

test('a refusal that is not the core configuration is reported as unestablished, not as success', () => {
  // The verdict rests on the count and not on the path match, so that a change to how `what` is
  // composed cannot fail open. This is that case: a refusal the path match does not recognise.
  const other: RefusedChange = {
    what: 'rename wlan0 to wfwan0',
    blastRadius: 'boot',
    needs: 'a reboot. The name changes when the device next starts.',
  };
  const event = resolverReconvergeEvent(outcome({ refused: [other] }));

  assert.equal(event.kind, 'resolver.reconverge-refused', 'an unrecognised refusal fell through to success');
  assert.equal(event.detail['coreConfigRefused'], false);
  // Honest about which fact it has: not established is not the same claim as "the resolver is dead".
  assert.match(event.summary, /not established/);
  assert.doesNotMatch(event.summary, /NOT in use/);
});

// ------------------------------------------------------- the branch that already worked

/**
 * The core's configuration, read back after the apply, naming what the peer pushed.
 *
 * This argument is what a success now rests on. Before it existed, success was concluded from the
 * absence of refusals — and an apply that refuses nothing and *writes* nothing looks exactly the
 * same from the outcome alone. Measured on the bench board on 2026-09-22: `resolver.reconverged`
 * twice, `config.json` unchanged for hours, and the owner's internal names not resolving.
 */
const CONVERGED: ReconvergeVerification = {
  readable: true,
  divergent: [],
  inUse: [{ tunnelId: 'hq', address: '10.184.100.5' }],
};

/** The same reading on the board that morning: the capture is not what the core was given. */
test('an apply refused before any transaction, because nothing in it was permitted, is a refusal naming the core file', () => {
  // `applyDocument` answers `nothing_permitted` rather than committing a transaction that does nothing
  // (the board's `a36badb1d45169a9`, 2026-09-23). That is not a failure of the apply; it is a refusal.
  const refusedOutcome: ApplyOutcome = {
    ok: false,
    error: {
      status: 409,
      code: 'nothing_permitted',
      message: 'every change this plan needs is of a class this caller may not apply',
      hint: '',
      detail: { refused: [{ what: PATHS.coreConfig, blastRadius: 'network' }, { what: 'restart wf-core.service', blastRadius: 'service' }] },
    },
  };
  const event = resolverReconvergeEvent(refusedOutcome, CONVERGED);
  // Mutation: drop the `nothing_permitted` branch and this reads `resolver.reconverge-failed`.
  assert.equal(event.kind, 'resolver.reconverge-refused');
  assert.equal(event.detail['coreConfigRefused'], true);
  assert.equal(event.detail['transaction'], null);
});

const STILL_STALE: ReconvergeVerification = {
  readable: true,
  divergent: [{ tunnelId: 'hq', tunnelName: 'HQ', captured: '10.184.100.5', inCore: '10.184.40.5' }],
  inUse: [{ tunnelId: 'hq', address: '10.184.40.5' }],
};

test('a clean re-derive whose write is in the file is reported as a reconvergence', () => {
  const event = resolverReconvergeEvent(outcome({ refused: [] }), CONVERGED);

  // The twin of the first test. Without this one, a verdict hardcoded to "refused" would pass every
  // negative case above and the suite would prove nothing about the field it reads.
  assert.equal(event.kind, 'resolver.reconverged');
  assert.equal(event.level, 'info');
  assert.deepEqual(event.detail['refused'], []);
  // The evidence travels with the claim: which resolver the core is now configured with.
  assert.deepEqual(event.detail['inUse'], CONVERGED.inUse);
  assert.match(event.summary, /10\.184\.100\.5/);
});

test('a re-derive that refused nothing and changed nothing is not a reconvergence', () => {
  // The defect of 2026-09-22 in one assertion. Nothing was refused, `ok` was true, and the file the
  // core reads still named the address from the profile. The old verdict called this success twice.
  const event = resolverReconvergeEvent(outcome({ refused: [] }), STILL_STALE);

  assert.notEqual(event.kind, 'resolver.reconverged', 'a write that never happened reported success');
  assert.equal(event.kind, 'resolver.reconverge-unverified');
  assert.equal(event.level, 'warn');
  assert.match(event.summary, /NOT\s+in use/);
  // A person reading the journal gets both numbers, which is what makes it actionable.
  assert.match(event.summary, /10\.184\.100\.5/);
  assert.match(event.summary, /10\.184\.40\.5/);
  assert.deepEqual(event.detail['divergent'], STILL_STALE.divergent);
});

test('a configuration that could not be read back is not a reconvergence either', () => {
  // Fail closed, for the reason this module already refuses a path match: absence of evidence read
  // as evidence of success is the shape of every defect in this file's history.
  const event = resolverReconvergeEvent(outcome({ refused: [] }), { readable: false, divergent: [], inUse: [] });

  assert.equal(event.kind, 'resolver.reconverge-unverified');
  assert.equal(event.level, 'warn');
  assert.match(event.summary, /not established/);
  assert.equal(event.detail['readable'], false);
});

test('no verification at all is never a success', () => {
  // A caller that forgets to read the file back must not be able to produce a success by omission.
  // That is how the previous verdict worked, and it is the one mistake this module exists to end.
  const event = resolverReconvergeEvent(outcome({ refused: [] }));

  assert.equal(event.kind, 'resolver.reconverge-unverified');
  assert.notEqual(event.kind, 'resolver.reconverged');
});

// ------------------------------------------------------- failure that does not throw

test('an apply that reports failure by return value is not a reconvergence either', () => {
  // `applyDocument` reports failure this way at least as often as by throwing, and the caller's
  // `catch` never saw these at all — so `ok: false` used to be recorded as a success.
  const event = resolverReconvergeEvent(
    outcome({
      ok: false,
      error: { code: 'core_unavailable', message: 'the core did not accept the configuration', hint: 'check the unit', status: 503 },
    }),
  );

  assert.equal(event.kind, 'resolver.reconverge-failed');
  assert.equal(event.level, 'warn');
  assert.match(event.summary, /the core did not accept the configuration/);
  assert.match(event.summary, /not in use/);
});

test('failure is decided before the refused list, so an ok:false with nothing refused still fails', () => {
  // Order matters and is asserted rather than assumed: an outcome can report failure with an empty
  // refused list, and reading the list first would call that a clean success.
  const event = resolverReconvergeEvent(outcome({ ok: false, refused: [] }));

  assert.equal(event.kind, 'resolver.reconverge-failed');
  assert.notEqual(event.kind, 'resolver.reconverged');
});

// ------------------------------------------------------- the absent reading

test('an outcome carrying no result is not read as nothing refused', () => {
  // A missing `result` means the reconciler reported nothing, which is not the same fact as "it ran
  // and refused nothing". Today both end in the same verdict; this records which one is being
  // relied on, so that a change making them differ has a test to fail.
  const bare: ApplyOutcome = { ok: true, transaction: TRANSACTION };
  const event = resolverReconvergeEvent(bare, CONVERGED);

  assert.equal(event.kind, 'resolver.reconverged');
  assert.equal(event.detail['transaction'], 'tx-1');
});
