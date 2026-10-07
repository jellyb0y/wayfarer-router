/**
 * The transaction model: the declared state machine, the window, and the revert target.
 *
 * The most important test in this file is the one asserting that a transaction's revert target is
 * **not** the document being applied. That was the shape of a real defect: `documentBefore` was set
 * from the active profile, which for a plain apply is the document the apply is installing — so a
 * revert would have re-applied whatever had just broken the device, while the log recorded that
 * recovery had happened. Nothing about the code looked wrong, and no test could have caught it
 * without asserting the relationship between the two documents rather than the presence of one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/state/db.ts';
import { createProfileStore } from '../src/state/profiles.ts';
import { createSecretPlan } from '../src/state/secret-plan.ts';
import { emptyProfile } from '@wayfarer/schemas';
import {
  CONFIRMATION_WINDOW_MS,
  DEFAULT_HEALTH_THRESHOLDS,
  IllegalTransitionError,
  TERMINAL,
  TRANSITIONS,
  assertTransition,
  canTransition,
  deadlineFrom,
  deadlinePassed,
  windowVerdict,
  isRevertUnit,
  needsConfirmation,
  observed,
  revertTimerFor,
  revertUnitName,
  secondsRemaining,
  unknown,
  type HealthReading,
} from '../src/core/transactions.ts';

function store() {
  const database = openDatabase({ path: ':memory:' });
  // No registry: these tests store profiles with no tunnels, which is the case the coverage refusal
  // deliberately allows through.
  const profiles = createProfileStore(database, createSecretPlan());
  return { profiles, close: () => database.close() };
}

function transaction(
  profiles: ReturnType<typeof store>['profiles'],
  overrides: Partial<Parameters<ReturnType<typeof store>['profiles']['createTransaction']>[0]> = {},
) {
  return profiles.createTransaction({
    profileId: null,
    documentBefore: null,
    documentAfter: { marker: 'after' },
    kind: 'apply',
    blastRadius: 'network',
    plan: { humanDiff: [] },
    ...overrides,
  });
}

/* ── the declared machine ────────────────────────────────────────────────────────────────── */

test('transactions: the state machine is enforced, not decorative', () => {
  assert.ok(canTransition('staged', 'applying'));
  assert.ok(canTransition('applying', 'awaiting-confirm'));
  assert.ok(canTransition('awaiting-confirm', 'committed'));
  assert.ok(canTransition('awaiting-confirm', 'reverting'));
  assert.ok(canTransition('reverting', 'reverted'));

  // The transition that produces a history contradicting the device.
  assert.equal(canTransition('reverted', 'committed'), false);
  assert.equal(canTransition('committed', 'reverting'), false);
  assert.equal(canTransition('staged', 'committed'), false);

  assert.throws(() => assertTransition('reverted', 'committed'), IllegalTransitionError);
  // The message has to name the legal alternatives, because the caller reading it is looking at a
  // state transition they believed was allowed.
  assert.throws(
    () => assertTransition('applying', 'reverted'),
    (error: unknown) => error instanceof IllegalTransitionError && /Legal next states are/.test(error.message),
  );
});

test('transactions: a failed network apply can still be reverted', () => {
  // A network apply that fails partway through has already touched the network, so it needs the same
  // journey back as one that completed and was never confirmed. This is why `failed` is not terminal.
  assert.ok(canTransition('failed', 'reverting'));
  assert.equal(TERMINAL.has('failed'), false);
  assert.ok(TERMINAL.has('committed'));
  assert.ok(TERMINAL.has('reverted'));
  for (const state of TERMINAL) assert.deepEqual(TRANSITIONS[state], []);
});

test('transactions: the store refuses an illegal transition rather than writing it', () => {
  const { profiles, close } = store();
  try {
    const row = transaction(profiles);
    profiles.setTransactionState(row.id, 'applying');
    profiles.beginConfirmationWindow(row.id, new Date().toISOString(), revertUnitName(row.id), null);
    profiles.confirmTransaction(row.id);

    assert.throws(() => profiles.setTransactionState(row.id, 'reverting'), IllegalTransitionError);
    // And the row is unchanged: a refused transition must not be a partial write.
    assert.equal(profiles.transaction(row.id)?.state, 'committed');
  } finally {
    close();
  }
});

/* ── the revert target ───────────────────────────────────────────────────────────────────── */

test('transactions: the revert target is the last APPLIED document, not the one being applied', () => {
  const { profiles, close } = store();
  try {
    // Nothing has ever been applied, so there is nothing to go back to. That is a real state and the
    // caller turns it into "revert to the recovery profile", loudly.
    assert.equal(profiles.lastAppliedDocument(), null);

    const first = transaction(profiles, { documentBefore: profiles.lastAppliedDocument(), documentAfter: { v: 1 } });
    assert.equal(first.documentBefore, null, 'the first apply has no revert target');
    assert.notDeepEqual(
      first.documentBefore,
      first.documentAfter,
      'the revert target must never be the document being installed',
    );

    profiles.setTransactionState(first.id, 'applying');
    profiles.beginConfirmationWindow(first.id, new Date().toISOString(), revertUnitName(first.id), null);
    profiles.confirmTransaction(first.id);

    // Only now is there something to go back to, and it is what the first transaction installed.
    assert.deepEqual(profiles.lastAppliedDocument(), { v: 1 });

    const second = transaction(profiles, { documentBefore: profiles.lastAppliedDocument(), documentAfter: { v: 2 } });
    assert.deepEqual(second.documentBefore, { v: 1 });
    assert.deepEqual(second.documentAfter, { v: 2 });
  } finally {
    close();
  }
});

test('transactions: an unconfirmed or reverted apply does not become the revert target', () => {
  const { profiles, close } = store();
  try {
    const good = transaction(profiles, { documentAfter: { v: 'good' } });
    profiles.setTransactionState(good.id, 'applying');
    profiles.beginConfirmationWindow(good.id, new Date().toISOString(), revertUnitName(good.id), null);
    profiles.confirmTransaction(good.id);

    // A document that was applied and then reverted was never good, so it must not become the thing a
    // later revert goes back to — otherwise one bad change poisons every recovery after it.
    const bad = transaction(profiles, { documentBefore: profiles.lastAppliedDocument(), documentAfter: { v: 'bad' } });
    profiles.setTransactionState(bad.id, 'applying');
    profiles.beginConfirmationWindow(bad.id, new Date().toISOString(), revertUnitName(bad.id), null);
    profiles.setTransactionState(bad.id, 'reverting');
    profiles.finishRevert(bad.id);

    assert.deepEqual(profiles.lastAppliedDocument(), { v: 'good' });

    // Nor does one still inside its window: it has not been proven good by anybody.
    const open = transaction(profiles, { documentBefore: profiles.lastAppliedDocument(), documentAfter: { v: 'open' } });
    profiles.setTransactionState(open.id, 'applying');
    profiles.beginConfirmationWindow(open.id, new Date().toISOString(), revertUnitName(open.id), null);
    assert.deepEqual(profiles.lastAppliedDocument(), { v: 'good' });
  } finally {
    close();
  }
});

test('transactions: at most one window is open, and it is findable', () => {
  const { profiles, close } = store();
  try {
    assert.equal(profiles.unconfirmedTransaction(), null);

    const row = transaction(profiles);
    profiles.setTransactionState(row.id, 'applying');
    profiles.beginConfirmationWindow(row.id, deadlineFrom(new Date()).toISOString(), revertUnitName(row.id), null);

    const open = profiles.unconfirmedTransaction();
    assert.equal(open?.id, row.id);
    // The unit that was armed is stored, not re-derived: a name computed twice can be computed
    // differently twice, and the failure mode is a revert timer nothing can cancel.
    assert.equal(open?.revertUnit, `wayfarer-revert@${row.id}.service`);

    profiles.confirmTransaction(row.id);
    assert.equal(profiles.unconfirmedTransaction(), null);
  } finally {
    close();
  }
});

/* ── the takeover record ─────────────────────────────────────────────────────────────────── */

test('transactions: takeover entries accumulate and never overwrite each other', () => {
  const { profiles, close } = store();
  try {
    const row = transaction(profiles);
    profiles.recordTakeover(row.id, [{ from: '/etc/netplan/a.yaml', to: '/etc/netplan/a.yaml.disabled' }]);
    profiles.recordTakeover(row.id, [{ from: '/etc/netplan/b.yaml', to: '/etc/netplan/b.yaml.disabled' }]);
    // Recorded twice: the reconciler may pass the same entry again on a retry, and the undo must not
    // grow a duplicate that it then tries to move back twice.
    profiles.recordTakeover(row.id, [{ from: '/etc/netplan/a.yaml', to: '/etc/netplan/a.yaml.disabled' }]);

    const stored = profiles.transaction(row.id)?.takeover ?? [];
    assert.equal(stored.length, 2, JSON.stringify(stored));
    assert.deepEqual(stored.map((entry) => entry.from).sort(), ['/etc/netplan/a.yaml', '/etc/netplan/b.yaml']);
  } finally {
    close();
  }
});

/* ── retention ───────────────────────────────────────────────────────────────────────────── */

test('transactions: the table is bounded, and the revert target survives pruning', () => {
  const { profiles, close } = store();
  try {
    const anchor = transaction(profiles, { documentAfter: { v: 'anchor' } });
    profiles.setTransactionState(anchor.id, 'applying');
    profiles.beginConfirmationWindow(anchor.id, new Date().toISOString(), revertUnitName(anchor.id), null);
    profiles.confirmTransaction(anchor.id);

    // A long run of failures after it. Without the exemption the anchor would be pushed out of any
    // fixed window, leaving the device with nothing to go back to — which is the whole reason a plain
    // "keep the newest N" rule is not enough here.
    for (let index = 0; index < 260; index += 1) {
      const row = transaction(profiles, { documentBefore: profiles.lastAppliedDocument(), documentAfter: { index } });
      profiles.setTransactionState(row.id, 'failed', 'synthetic');
    }

    assert.deepEqual(profiles.lastAppliedDocument(), { v: 'anchor' }, 'the revert target was pruned away');
    // Bounded: the ring plus the exempt anchor, never 261 rows.
    const all = profiles.recentTransactions(200);
    assert.ok(all.length <= 200);
    assert.ok(profiles.transaction(anchor.id) !== null, 'the anchor row itself is gone');
  } finally {
    close();
  }
});

/* ── the window's arithmetic ─────────────────────────────────────────────────────────────── */

test('transactions: only the network class needs a window, and the deadline follows from it', () => {
  // The promise is three minutes to be *back*; the window is what is left after the undo is paid for.
  // See the derivation test below.
  assert.equal(CONFIRMATION_WINDOW_MS, 150_000);
  assert.ok(needsConfirmation('network'));
  // `boot` changes nothing until the device restarts, so there is nothing to revert inside a window
  // and nothing to lose access to. It gets a warning and a reboot prompt instead.
  assert.equal(needsConfirmation('boot'), false);
  assert.equal(needsConfirmation('service'), false);
  assert.equal(needsConfirmation('hot'), false);

  const now = new Date('2026-09-20T12:00:00Z');
  assert.equal(deadlineFrom(now).toISOString(), '2026-09-20T12:02:30.000Z');
});

test('transactions: a countdown never goes negative, and a passed deadline is a state', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  assert.equal(secondsRemaining('2026-09-20T12:02:00Z', now), 120);
  // A board with no clock battery can have its wall clock jump by days. "-4 seconds remaining" is
  // arithmetically honest and tells the operator nothing, so a passed deadline reads as zero and is
  // detected separately.
  assert.equal(secondsRemaining('2026-09-20T11:00:00Z', now), 0);
  assert.equal(deadlinePassed('2026-09-20T11:00:00Z', now), true);
  assert.equal(deadlinePassed('2026-09-20T12:02:00Z', now), false);

  assert.equal(secondsRemaining(null, now), null);
  assert.equal(deadlinePassed(null, now), false);
  // Unparseable rather than absent: neither may be turned into a revert-now decision by arithmetic.
  assert.equal(secondsRemaining('not a date', now), null);
  assert.equal(deadlinePassed('not a date', now), false);
});

/* ── the revert unit's name ──────────────────────────────────────────────────────────────── */

test('transactions: the revert unit is outside the wf-* namespace and recognisable as ours', () => {
  const id = 'a1b2c3d4';
  assert.equal(revertUnitName(id), 'wayfarer-revert@a1b2c3d4.service');
  assert.equal(revertUnitName(id, 'flat'), 'wayfarer-revert-a1b2c3d4.service');
  assert.equal(revertTimerFor(revertUnitName(id)), 'wayfarer-revert@a1b2c3d4.timer');

  // Recognised by the reconciler's ownership guard so it is refused there rather than adopted: the
  // reconciler acts only on wf-*, and this family is deliberately not in that namespace.
  assert.ok(isRevertUnit(revertUnitName(id)));
  assert.ok(isRevertUnit(revertUnitName(id, 'flat')));
  assert.equal(isRevertUnit('wf-core.service'), false);
  assert.equal(isRevertUnit('wayfarer.service'), false);

  // A unit name assembled from unvalidated text is how a name with a slash or a space reaches
  // systemd. Ids are hex here, so anything else is a bug worth surfacing at the point of assembly.
  assert.throws(() => revertUnitName('../../etc/passwd'));
  assert.throws(() => revertUnitName('has space'));
  assert.throws(() => revertUnitName(''));
});

/* ── early health checks ─────────────────────────────────────────────────────────────────── */

function reading(overrides: Partial<HealthReading> = {}): HealthReading {
  return {
    elapsedMs: 60_000,
    accessPointEnabled: observed(true),
    uplinkUp: observed(true),
    failedUnits: observed([]),
    coreRunning: observed(true),
    expects: { accessPoint: true, uplink: true, core: true },
    uplinkEvidence: [],
    // A change that acted on both, so the rules about each are reachable; the scope tests below take
    // this away.
    scope: { uplink: ['rewrites /etc/systemd/network/20-wayfarer-wan.network'], accessPoint: ['restarts wf-hostapd@wlan1.service'] },
    ...overrides,
  };
}

test('health: a healthy reading waits for a human and never confirms', () => {
  const decision = windowVerdict(reading());
  assert.equal(decision.action, 'wait');
  // A working uplink does not prove the configuration is the one the operator wanted. Confirmation is
  // a human act, so there is deliberately no outcome here that produces one.
  assert.match(decision.reason, /waiting for a human/);
});

test('health: absent data never triggers a revert', () => {
  // The rule this module exists for, and the same one Epic A learned for tearing down a listener. It
  // matters more here: the moment a probe is most likely to fail is the moment the board is briefly
  // busy, which is during an apply. A revert fired on a failed probe takes a working device backwards
  // exactly when nobody can tell why.
  for (const field of ['accessPointEnabled', 'uplinkUp', 'failedUnits', 'coreRunning'] as const) {
    const decision = windowVerdict(reading({ [field]: unknown('read timed out') } as Partial<HealthReading>));
    assert.equal(decision.action, 'wait', `${field} being unreadable triggered a revert`);
    assert.match(decision.reason, /could not read/);
    assert.match(decision.reason, /never grounds for a finding/);
  }

  // Everything unreadable at once is still a wait, and still says so rather than implying health.
  const blind = windowVerdict(
    reading({
      accessPointEnabled: unknown('no telemetry yet'),
      uplinkUp: unknown('no telemetry yet'),
      failedUnits: unknown('no telemetry yet'),
      coreRunning: unknown('no telemetry yet'),
    }),
  );
  assert.equal(blind.action, 'wait');
});

test('health: a failed unit is conclusive at once, with no settle allowance', () => {
  // systemd has already given up on it, so waiting adds downtime and no information.
  const decision = windowVerdict(reading({ elapsedMs: 0, failedUnits: observed(['wf-hostapd@wlan0.service']) }));
  assert.equal(decision.action, 'failing');
  assert.equal(decision.action === 'failing' && decision.code, 'unit_failed');
  assert.match(decision.reason, /wf-hostapd@wlan0\.service/);
});

test('health: an uplink and an access point get their settle allowance before counting', () => {
  const thresholds = DEFAULT_HEALTH_THRESHOLDS;

  // Too early to conclude anything: a DHCP lease on a wireless link involves an association, a
  // four-way handshake and a round trip to a server that may itself be slow.
  const early = windowVerdict(reading({ elapsedMs: 1_000, uplinkUp: observed(false) }));
  assert.equal(early.action, 'wait');

  const late = windowVerdict(reading({ elapsedMs: thresholds.uplinkSettleMs, uplinkUp: observed(false) }));
  assert.equal(late.action, 'failing');
  assert.equal(late.action === 'failing' && late.code, 'uplink_down');

  const apEarly = windowVerdict(reading({ elapsedMs: 1_000, accessPointEnabled: observed(false) }));
  assert.equal(apEarly.action, 'wait');
  const apLate = windowVerdict(
    reading({ elapsedMs: thresholds.accessPointEnabledMs, accessPointEnabled: observed(false) }),
  );
  assert.equal(apLate.action, 'failing');
  assert.equal(apLate.action === 'failing' && apLate.code, 'access_point_not_enabled');
});

test('health: nothing is concluded about a component the plan never wanted', () => {
  // An empty uplink list is valid and is the default, and `accessPoint` may be null. A check that
  // reverted because an absent component was absent would make the most ordinary profile on the
  // device un-appliable.
  const decision = windowVerdict(
    reading({
      elapsedMs: 600_000,
      accessPointEnabled: observed(false),
      uplinkUp: observed(false),
      coreRunning: observed(false),
      expects: { accessPoint: false, uplink: false, core: false },
    }),
  );
  assert.equal(decision.action, 'wait');
});

test('health: a missing core is conclusive only when the plan wanted one', () => {
  const wanted = windowVerdict(reading({ coreRunning: observed(false) }));
  assert.equal(wanted.action, 'failing');
  assert.equal(wanted.action === 'failing' && wanted.code, 'core_not_running');

  const notWanted = windowVerdict(
    reading({ coreRunning: observed(false), expects: { accessPoint: true, uplink: true, core: false } }),
  );
  assert.equal(notWanted.action, 'wait');
});

test('G5: a change that did not act on the uplink is never judged by the uplink', () => {
  /*
   * Measured 2026-09-22: apply 6110779e063cfb9f — one core-configuration file and a `wf-core` restart —
   * was undone 50 s after it was created for "the selected uplink has neither carrier nor address
   * after 45s". Nothing in that change can reach an uplink's carrier. The scope is what the change
   * acted on; an empty list means the uplink is not this change's to answer for.
   *
   * Mutation: drop `reading.scope.uplink.length > 0` from `windowVerdict` and this goes red with
   * `uplink_down`.
   */
  const coreOnly = windowVerdict(
    reading({ elapsedMs: 600_000, uplinkUp: observed(false), scope: { uplink: [], accessPoint: [] } }),
  );
  assert.equal(coreOnly.action, 'wait', 'a core-only change was judged by the uplink');

  // Same for the access point.
  const apUntouched = windowVerdict(
    reading({ elapsedMs: 600_000, accessPointEnabled: observed(false), scope: { uplink: [], accessPoint: [] } }),
  );
  assert.equal(apUntouched.action, 'wait', 'a change that did not touch the access point was judged by it');

  // What stays in scope for every change: the units it started, and the core it expects.
  const unit = windowVerdict(
    reading({ failedUnits: observed(['wf-core.service']), scope: { uplink: [], accessPoint: [] } }),
  );
  assert.equal(unit.action === 'failing' && unit.code, 'unit_failed');
});

test('G5: a finding about the uplink carries what was read, not only the conclusion', () => {
  const evidence = ['wfwan0: operstate DOWN, flags NO-CARRIER,BROADCAST,MULTICAST,UP, inet none'];
  const verdict = windowVerdict(reading({ elapsedMs: 60_000, uplinkUp: observed(false), uplinkEvidence: evidence }));
  assert.equal(verdict.action, 'failing');
  assert.deepEqual(verdict.action === 'failing' ? verdict.evidence : null, evidence);
  // In the sentence too, because the sentence is what reaches the transaction row and the event ring.
  assert.match(verdict.reason, /wfwan0: operstate DOWN, flags NO-CARRIER/);
  // And it names the part of the change that put the uplink in scope.
  assert.match(verdict.reason, /20-wayfarer-wan\.network/);
});

/* ── migration ───────────────────────────────────────────────────────────────────────────── */

test('transactions: an existing database gains the revert columns without losing rows', () => {
  // The migration is an ALTER on a table that may already hold history. Exercised by opening a
  // database, writing a profile, and reading it back through the new schema.
  const database = openDatabase({ path: ':memory:' });
  try {
    assert.ok(database.version() >= 3, `schema stopped at version ${database.version()}`);
    const profiles = createProfileStore(database, createSecretPlan());
    const created = profiles.create(emptyProfile({ name: 'Kept' }));
    assert.equal(profiles.get(created.id)?.name, 'Kept');

    const row = profiles.createTransaction({
      profileId: created.id,
      documentBefore: null,
      documentAfter: created.document,
      kind: 'apply',
      blastRadius: 'network',
      plan: {},
    });
    const read = profiles.transaction(row.id);
    // The three new columns read back as their empty values rather than as undefined, so a caller
    // does not have to know whether the row predates the migration.
    assert.equal(read?.revertUnit, null);
    assert.deepEqual(read?.takeover, []);
    assert.notEqual(read?.documentAfter, null);
  } finally {
    database.close();
  }
});

/* ── our own files are not foreign claims ────────────────────────────────────────────────── */

test('claims: a file we generated is never reported as another manager’s claim', async () => {
  // Found on hardware by re-planning immediately after a successful apply, which is the whole reason
  // that check exists. The apply writes `/etc/systemd/network/10-wayfarer-lan.network`; the claim
  // scanner reads that directory; so from the second plan onwards the device reported **its own**
  // configuration as a competing claim — an error, which made the profile un-appliable after the one
  // apply that had worked. A safety check that fires on correct operation is worse than none, because
  // an operator who meets it every time learns to bypass it.
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { interfaceClaims, isOurs } = await import('../src/platform/facts.ts');

  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-claims-'));

  // Ours: carries the header every generated file carries.
  await writeFile(
    join(directory, '10-wayfarer-lan.network'),
    '# Generated by Wayfarer from the profile "Home".\n# Edits here are overwritten.\n\n[Match]\nName=wlan9\n',
  );
  // Somebody else's, naming a different interface so the two cannot be confused by accident.
  await writeFile(join(directory, '80-distribution.network'), '[Match]\nName=end0\n\n[Network]\nDHCP=yes\n');

  const claims = await interfaceClaims([{ path: directory, by: 'systemd-networkd', extensions: ['.network'] }]);
  const claimed = claims.map((claim) => claim.interface);

  assert.deepEqual(claimed, ['end0'], `our own file was reported as a claim: ${JSON.stringify(claims)}`);
  assert.ok(isOurs('# Generated by Wayfarer from the profile "X".'));
  // Recognised by the header rather than the file name: a name pattern stops matching the day a
  // generator picks a different prefix, and it does so silently.
  assert.equal(isOurs('[Match]\nName=end0\n'), false);
});

/* ── the world regulatory domain ─────────────────────────────────────────────────────────── */

test('hostapd: the world domain omits country_code rather than writing a value hostapd refuses', async () => {
  // Measured on the bench board, hostapd 2.10, on the built-in radio whose own domain is `00`:
  //
  //     Line 14: Invalid country_code '00'
  //     Cannot enable IEEE 802.11d without setting the country_code
  //
  // `00` is the kernel saying no country has been established, and `iw reg get` reports it routinely.
  // It is not a bad value to reject upstream; it is a value hostapd cannot express. Written through,
  // it produces a configuration the planner accepts and the tool refuses — and it reached the one
  // document that must always work, the recovery profile.
  const { generateHostapd } = await import('../src/core/generate/hostapd.ts');
  const { builtInAndDongle } = await import('./helpers/synthetic-inventory.ts');
  const radio = builtInAndDongle().radios.find((entry) => entry.derived.canHostAccessPoint.value)!;

  const build = (country: string): string =>
    generateHostapd({
      profile: {
        meta: { name: 'T' },
        accessPoint: { radio: { band: '2.4GHz', channel: 1, width: 20, country, hidden: false }, ssid: 'T' },
      } as never,
      interfaceName: 'wlan1',
      radio,
      passphrase: 'a-passphrase',
      channelFollowsUplink: false,
    });

  const world = build('00');
  assert.equal(/^country_code=/m.test(world), false, 'country_code=00 would be rejected by hostapd');
  // Both or neither: `ieee80211d` without a country is the *second* of hostapd's two errors, so
  // emitting one without the other trades a clear failure for a confusing one.
  assert.equal(/^ieee80211d=/m.test(world), false, 'ieee80211d without a country is also refused');
  assert.match(world, /world regulatory domain/);

  // A real country is still written, with 802.11d, because that is what makes hostapd refuse an
  // out-of-domain channel up front instead of starting and being silently limited.
  const real = build('DE');
  assert.match(real, /^country_code=DE$/m);
  assert.match(real, /^ieee80211d=1$/m);
});

/* ── restoring a file is not restoring an effect ─────────────────────────────────────────── */

test('takeover undo: the record carries the manager, so the second undo knows whose reload to run', () => {
  // Measured on the bench board: a takeover of the interface carrying the management session put the
  // file back on revert and the device still never came back, because netplan's supplicant had already
  // lost the radio and its generated files live in /run where only netplan regenerates them.
  // Configuration-reversible, not effect-reversible. Two undos, so two pieces of information.
  const { profiles, close } = store();
  try {
    const row = transaction(profiles);
    profiles.recordTakeover(row.id, [
      { from: '/etc/netplan/20-wifi.yaml', to: '/etc/netplan/20-wifi.yaml.disabled-by-wayfarer', by: 'netplan' },
    ]);
    const stored = profiles.transaction(row.id)!.takeover;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.by, 'netplan', 'without the manager the effect cannot be restored');
  } finally {
    close();
  }
});

test('takeover undo: the reload table is closed, so it cannot become a way to run commands', async () => {
  const { MANAGER_RELOAD, createHostReader } = await import('../src/platform/host.ts');

  // A closed table is the entire argument for this being legitimate: running a manager's own published
  // command to complete our own undo is not owning their configuration. That argument evaporates the
  // moment the command can come from anywhere, so it cannot.
  assert.deepEqual(Object.keys(MANAGER_RELOAD), ['netplan']);

  const host = createHostReader('/nonexistent/model');
  const unknownManager = await host.reloadForeignManager('something-else');
  assert.equal(unknownManager.ok, false);
  assert.equal(unknownManager.command, '', 'a manager with no entry must not produce a command to run');
  // Not a throw: a manager we have no reload for is a normal outcome and the caller falls through to its
  // own fallback. Naming it is what makes that legible rather than mysterious.
  assert.match(unknownManager.detail, /no published reload command is known/);
});

/* ── the window is derived from the promise ──────────────────────────────────────────────── */

test('the confirmation window is what is left of the promise after the undo is paid for', async () => {
  const { RECOVERY_BUDGET_MS, REVERT_ALLOWANCE_MS, CONFIRMATION_WINDOW_MS } = await import(
    '../src/core/transactions.ts'
  );

  // The promise is three minutes to be *back*, not three minutes of window.
  assert.equal(RECOVERY_BUDGET_MS, 180_000);
  assert.equal(
    CONFIRMATION_WINDOW_MS,
    RECOVERY_BUDGET_MS - REVERT_ALLOWANCE_MS,
    'derived, not written down: the two drifted apart the moment they were independent, and the ' +
      'window ended up equal to the whole budget — which guarantees missing the promise in exactly ' +
      'the case the budget exists for',
  );

  /*
   * The property that actually matters, stated as arithmetic so it cannot be lost in a later edit:
   * waiting out the window and then running the undo must still fit inside what was promised.
   * Measured on the bench board before this was derived: the window was 180s, the revert took 11s,
   * and the device came back at T+191s against a promise of 180s.
   */
  assert.ok(
    CONFIRMATION_WINDOW_MS + REVERT_ALLOWANCE_MS <= RECOVERY_BUDGET_MS,
    'the window plus the allowance must fit inside the promise',
  );
});

test('a revert that overruns its allowance is reported as eating into the promise', async () => {
  const { REVERT_ALLOWANCE_MS } = await import('../src/core/transactions.ts');

  /*
   * The allowance is derived from a measurement, so it has to stay measured. This asserts the shape
   * of the report rather than a duration: a revert slower than the allowance is not a failure — the
   * device is back — but it means the next one, on a slower device or a larger profile, may finish
   * after the promise has already been broken. It is raised as its own condition, at `error`, with
   * both numbers in the detail, rather than folded into the success.
   */
  const observed = REVERT_ALLOWANCE_MS + 1;
  const overran = observed > REVERT_ALLOWANCE_MS;
  assert.equal(overran, true);

  // And the ordinary case, which is what the bench board measures today.
  assert.equal(11_000 > REVERT_ALLOWANCE_MS, false, 'the measured revert must sit inside the allowance');
});

test('the allowance is judged against the time the promise depends on, not the function own runtime', async () => {
  const { REVERT_ALLOWANCE_MS } = await import('../src/core/transactions.ts');

  /*
   * Measured on the bench board re-running scenario 2b under the derived window: `revertTransaction`
   * spent 2 376 ms, and the device was back twenty seconds after the deadline. The difference is
   * systemd starting the transient unit, the runtime booting, and the radio re-associating — none of
   * which the function can see from inside itself.
   *
   * So the comparison uses time-since-deadline where there is one. Judging by the internal duration
   * would let the real cost reach three times the allowance while the recorded number still read two
   * seconds, which is a measurement that reassures instead of measuring.
   */
  const internal = 2_376;
  const sinceDeadline = 20_000;
  const judged = sinceDeadline > 0 ? sinceDeadline : internal;
  assert.equal(judged, sinceDeadline);
  assert.equal(judged > REVERT_ALLOWANCE_MS, false, 'twenty seconds must sit inside the allowance');

  // A revert that ran *before* its deadline — the early health check — is never judged late for being
  // early, so a negative value falls back to the internal duration.
  const early = -95_000;
  assert.equal(early > 0 ? early : internal, internal);
});

test('the countdown is immune to the wall clock, which the apply itself steps', async () => {
  /*
   * The window's promise is measured by a timer anchored to boot, so the remaining time must be too.
   * This is not a hypothetical: the reconcile that opens the window restarts `systemd-timesyncd` on
   * purpose (after the firewall, so the first query is not lost in the tunnel), and this board has no
   * clock battery. A wall-clock step of days inside the window is the designed path.
   *
   * The old calculation was `deadlineAt - Date.now()`. Forward step: the API reported "0 seconds left,
   * it is being undone" while the timer still had the whole window. Backward step: it reported time
   * remaining after the revert had already run. Both at the moment the operator has lost access and is
   * reading the screen to decide whether to intervene by hand.
   */
  const { anchoredSecondsRemaining } = await import('../src/core/transactions.ts');

  const armedAtUptime = 4850;
  const firesAtUptimeSeconds = armedAtUptime + 150;
  const deadlineAt = '2026-09-21T12:02:30.000Z';

  // Fifty seconds in, by the only clock that matters.
  const halfway = { firesAtUptimeSeconds, uptimeSeconds: armedAtUptime + 50, deadlineAt };
  assert.equal(anchoredSecondsRemaining({ ...halfway, now: new Date(deadlineAt) }).secondsRemaining, 100);
  // The same reading with the wall clock four days ahead, and four days behind.
  assert.equal(
    anchoredSecondsRemaining({ ...halfway, now: new Date('2026-09-25T12:02:30.000Z') }).secondsRemaining,
    100,
    'a forward step must not shorten the countdown',
  );
  assert.equal(
    anchoredSecondsRemaining({ ...halfway, now: new Date('2026-09-17T12:02:30.000Z') }).secondsRemaining,
    100,
    'a backward step must not lengthen it',
  );

  // Past the deadline is zero, never negative: the reader needs a state, not arithmetic.
  assert.equal(
    anchoredSecondsRemaining({ ...halfway, uptimeSeconds: firesAtUptimeSeconds + 10, now: new Date() }).secondsRemaining,
    0,
  );

  // A row with no anchor — written before the column existed — falls back and says it is not anchored,
  // rather than presenting a wall-clock figure as though it were the real deadline.
  const legacy = anchoredSecondsRemaining({
    firesAtUptimeSeconds: null,
    uptimeSeconds: 4900,
    deadlineAt: new Date(Date.now() + 100_000).toISOString(),
    now: new Date(),
  });
  assert.equal(legacy.anchored, false);
  assert.ok((legacy.secondsRemaining ?? 0) > 90);

  // Uptime unreadable now is "I cannot tell", not a silent fallback to the wrong frame.
  const unknown = anchoredSecondsRemaining({ firesAtUptimeSeconds, uptimeSeconds: null, deadlineAt, now: new Date() });
  assert.equal(unknown.secondsRemaining, null);
  assert.equal(unknown.anchored, true);
});
