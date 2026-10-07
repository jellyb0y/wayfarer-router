/**
 * Safe mode.
 *
 * Rescue paths in this codebase have been broken the first time they ran on three separate occasions,
 * so these tests are written to be about the *behaviour on the device* rather than about the shape of a
 * function — and the paths are also exercised on hardware, which is recorded in the progress notes.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import {
  SAFE_MODE_THRESHOLD,
  buildSafeModeDocument,
  isSafeModeOf,
  safeModeDecision,
} from '../src/core/safe-mode.ts';

const EDITED = '2026-09-20T12:00:00.000Z';
/**
 * The configuration these attempts are attempts at.
 *
 * The cut between "this configuration" and "one the operator has since changed" is a revision, not a
 * timestamp: the timestamps below are still present because a row carries one, but nothing in the
 * decision reads them. See `ApplyAttempt.profileRevision`.
 */
const REVISION = 7;
const after = (minutes: number): string => new Date(Date.parse(EDITED) + minutes * 60_000).toISOString();

test('one failure is not safe mode: a device that panics on a typo is worse than one that does not', () => {
  const decision = safeModeDecision({
    attempts: [{ at: after(1), state: 'failed', profileRevision: REVISION }],
    profileRevision: REVISION,
  });
  assert.equal(decision.failures, 1);
  assert.equal(decision.enter, false);
});

test('three consecutive failures enter safe mode, and the reason says what was kept', () => {
  const decision = safeModeDecision({
    attempts: [
      { at: after(3), state: 'reverted', profileRevision: REVISION },
      { at: after(2), state: 'failed', profileRevision: REVISION },
      { at: after(1), state: 'reverted', profileRevision: REVISION },
    ],
    profileRevision: REVISION,
  });
  assert.equal(decision.failures, SAFE_MODE_THRESHOLD);
  assert.equal(decision.enter, true);
  assert.match(decision.reason!, /kept only what is needed to reach it/);
});

test('a success resets the count, whenever it happened', () => {
  // The device has proved it can apply something, so the run of failures before it is not evidence
  // about the configuration it is being asked to apply now.
  const decision = safeModeDecision({
    attempts: [
      { at: after(5), state: 'failed', profileRevision: REVISION },
      { at: after(4), state: 'committed', profileRevision: REVISION },
      { at: after(3), state: 'failed', profileRevision: REVISION },
      { at: after(2), state: 'failed', profileRevision: REVISION },
      { at: after(1), state: 'failed', profileRevision: REVISION },
    ],
    profileRevision: REVISION,
  });
  assert.equal(decision.failures, 1);
  assert.equal(decision.enter, false);
});

test('an edit resets the count: three attempts at something since changed are not evidence about this', () => {
  const decision = safeModeDecision({
    attempts: [
      { at: '2026-09-20T11:50:00.000Z', state: 'failed', profileRevision: REVISION - 1 },
      { at: '2026-09-20T11:40:00.000Z', state: 'failed', profileRevision: REVISION - 1 },
      { at: '2026-09-20T11:30:00.000Z', state: 'failed', profileRevision: REVISION - 1 },
    ],
    // An edit bumped the revision after all three. An operator who changed something is trying
    // something new, and this device has no failures against the thing it is running now.
    profileRevision: REVISION,
  });
  assert.equal(decision.failures, 0);
  assert.equal(decision.enter, false);
});

test('the reset holds when the clock moved backwards over the edit, which is when it used to fail', () => {
  /*
   * The case that made the old comparison wrong, and it is not exotic: this device has no clock battery
   * and the apply itself restarts `systemd-timesyncd`, so the clock stepping mid-sequence is the
   * designed path. Here the three stale attempts carry timestamps *later* than the two current ones,
   * which is exactly what a backward step produces. The old code compared timestamps and concluded that
   * nothing had happened since the edit; the revision says plainly which two belong to now.
   */
  const decision = safeModeDecision({
    attempts: [
      { at: '2026-09-20T09:00:00.000Z', state: 'failed', profileRevision: REVISION },
      { at: '2026-09-20T08:59:00.000Z', state: 'failed', profileRevision: REVISION },
      { at: '2026-09-24T12:00:00.000Z', state: 'failed', profileRevision: REVISION - 1 },
    ],
    profileRevision: REVISION,
  });
  assert.equal(decision.failures, 2, 'the two stamped with the current revision, whatever the clock says');
});

test('an attempt that makes no claim about which configuration it was ends the run', () => {
  // A row written before the revision column existed. It cannot be credited to the current
  // configuration, and counting it would be a guess in the direction of entering safe mode.
  const decision = safeModeDecision({
    attempts: [
      { at: after(2), state: 'failed', profileRevision: REVISION },
      { at: after(1), state: 'failed', profileRevision: null },
      { at: after(0), state: 'failed', profileRevision: REVISION },
    ],
    profileRevision: REVISION,
  });
  assert.equal(decision.failures, 1);
  assert.equal(decision.enter, false);
});

test('failures straddling an edit count only the ones after it', () => {
  const decision = safeModeDecision({
    attempts: [
      { at: after(2), state: 'failed', profileRevision: REVISION },
      { at: after(1), state: 'failed', profileRevision: REVISION },
      { at: '2026-09-20T11:00:00.000Z', state: 'failed', profileRevision: REVISION - 1 },
      { at: '2026-09-20T10:00:00.000Z', state: 'failed', profileRevision: REVISION - 1 },
    ],
    profileRevision: REVISION,
  });
  assert.equal(decision.failures, 2, 'two at this configuration, not four');
  assert.equal(decision.enter, false);
});

/* ── what safe mode keeps and removes ────────────────────────────────────────────────────── */

function configured(): ProfileDocument {
  const base = emptyProfile({ name: 'Bench' }) as unknown as ProfileDocument;
  return {
    ...base,
    accessPoint: {
      bind: { by: 'phy-usb', value: '0e8d:7961' },
      radio: { band: '2.4GHz', channel: 6, width: 20, country: 'DE', hidden: false },
      ssid: 'The owner own network',
      passphrase: 'the-passphrase-they-know',
      acceptChannelFollowsUplink: false,
      pinName: false,
      takeOverInterface: false,
    } as never,
    network: { cidr: '10.44.0.1/24', dhcp: { enabled: true, from: '10.44.0.100', to: '10.44.0.200', leaseHours: 12 } },
    tunnels: [
      {
        id: 'a',
        name: 'A',
        role: 'alternative',
        enabled: true,
        protocol: 'vless',
        config: { server: 'a.example.net', port: 443, id: 'account-a', network: 'tcp', security: 'tls' },
      },
      {
        id: 'b',
        name: 'B',
        role: 'alternative',
        enabled: true,
        protocol: 'vless',
        config: { server: 'b.example.net', port: 443, id: 'account-b', network: 'tcp', security: 'tls' },
      },
    ] as never,
    firewall: { ...base.firewall, killSwitch: true },
  };
}

test('safe mode keeps the network the owner devices already know', () => {
  const safe = buildSafeModeDocument(configured());
  assert.equal(safe.accessPoint?.ssid, 'The owner own network');
  assert.equal(safe.accessPoint?.passphrase, 'the-passphrase-they-know');
  assert.deepEqual(
    safe.network,
    configured().network,
    'a fresh minimal profile would also be safe and would change the address range, so the person ' +
      'arriving to fix the device would first have to work out how to reach it',
  );
});

test('safe mode removes every tunnel and the kill-switch, because either can be what denies access', () => {
  const safe = buildSafeModeDocument(configured());
  assert.equal(safe.tunnels.every((tunnel) => tunnel.enabled === false), true);
  assert.equal(
    safe.firewall.killSwitch,
    false,
    'its purpose is to stop traffic when the tunnel is down, and in safe mode the tunnel is ' +
      'deliberately down — leaving it on produces a device that is reachable and can do nothing',
  );
});

test('the tunnels are disabled, not deleted, so leaving safe mode is re-enabling rather than re-entering', () => {
  const safe = buildSafeModeDocument(configured());
  assert.deepEqual(safe.tunnels.map((tunnel) => tunnel.id), ['a', 'b']);
  // The protocol survives too: safe mode turns a tunnel off, it does not forget what it was.
  assert.deepEqual(safe.tunnels.map((tunnel) => tunnel.protocol), ['vless', 'vless']);
});

test('being in safe mode is a comparison against the derivation, not a shape that can be coincidental', () => {
  const stored = configured();
  assert.equal(isSafeModeOf(buildSafeModeDocument(stored), stored), true);
  assert.equal(isSafeModeOf(stored, stored), false, 'a normal configured device is not in safe mode');

  /*
   * The case that broke it on hardware. A profile with no tunnels and no kill-switch *looks* exactly
   * like safe mode, so a shape test says "already in safe mode" for an ordinary new device — and the
   * guard against entering twice then blocks the first entry for ever. Four consecutive reverted
   * applies produced nothing on the bench board because of this.
   *
   * Against the derivation it is still true here, but harmlessly: with nothing to disable, "already in
   * safe mode" and "entering changes nothing" are the same statement.
   */
  const plain = { ...configured(), tunnels: [], firewall: { ...configured().firewall, killSwitch: false } };
  assert.equal(isSafeModeOf(plain, plain), true);
  // And the running document being something else entirely is not safe mode, whatever its shape.
  assert.equal(isSafeModeOf(plain, stored), false);
});

test('nothing else in the document is altered', () => {
  const before = configured();
  const safe = buildSafeModeDocument(before);
  // Everything except the two things safe mode is allowed to change.
  const stripped = (doc: ProfileDocument): unknown => ({
    ...doc,
    tunnels: doc.tunnels.map((tunnel) => ({ ...tunnel, enabled: null })),
    firewall: { ...doc.firewall, killSwitch: null },
  });
  assert.deepEqual(stripped(safe), stripped(before));
});

test('the safe-mode transaction walks a legal path through the state machine', async () => {
  const { TRANSITIONS } = await import('../src/core/transactions.ts');
  /*
   * Asserted as a property of the machine rather than of the calling code, because the calling code
   * getting it wrong is exactly what happened: `staged -> committed` threw, the error was swallowed, the
   * row stayed `staged`, and because `staged` is not a failure state it ended the consecutive-failure
   * walk — so a rescue path disabled itself by recording its own attempt badly.
   */
  assert.equal(TRANSITIONS.staged.includes('committed'), false, 'this is the transition that threw');
  assert.equal(TRANSITIONS.staged.includes('applying'), true);
  assert.equal(TRANSITIONS.applying.includes('committed'), true);
  assert.equal(TRANSITIONS.applying.includes('failed'), true, 'a safe mode that did not apply must not commit');
});

test('a healthy profile with nothing to disable is reported as normal, not as being in safe mode', async () => {
  const { safeModeState } = await import('../src/core/safe-mode.ts');
  const stored = configured();

  assert.equal(safeModeState(buildSafeModeDocument(stored), stored), 'in-safe-mode');
  assert.equal(safeModeState(stored, stored), 'normal');

  // The case that read wrong on hardware: a working device with no tunnels and no kill-switch. The
  // derivation equals the profile, so "in safe mode" is true and useless — somebody would go looking
  // for a fault that is not there.
  const plain = { ...stored, tunnels: [], firewall: { ...stored.firewall, killSwitch: false } };
  assert.equal(safeModeState(plain, plain), 'nothing-to-disable');
});

/* ── a revert is a mechanism, not a verdict ──────────────────────────────────────────────── */

test('reverts the operator asked for are not failures, however many there are', async () => {
  const { REVERT_REASONS } = await import('../src/core/safe-mode.ts');
  /*
   * Three deliberate changes of mind on a perfectly healthy device. Counting them walked it into the
   * rescue mechanism and switched its tunnels off — the second time safe mode has counted something as
   * a failure that was not one, and both came from asking "did this end in a revert" rather than "did
   * this fail".
   */
  const decision = safeModeDecision({
    attempts: [
      { at: after(3), state: 'reverted', reason: REVERT_REASONS.operatorRequested, profileRevision: REVISION },
      { at: after(2), state: 'reverted', reason: REVERT_REASONS.operatorRequested, profileRevision: REVISION },
      { at: after(1), state: 'reverted', reason: REVERT_REASONS.operatorRequested, profileRevision: REVISION },
    ],
    profileRevision: REVISION,
  });
  assert.equal(decision.failures, 0);
  assert.equal(decision.enter, false);
});

test('an operator revert ends the run, because somebody was present', async () => {
  const { REVERT_REASONS } = await import('../src/core/safe-mode.ts');
  // Two genuine failures, then a decision. Whatever came before is no longer an unattended pattern of
  // a device failing by itself, which is the only thing safe mode should react to.
  const decision = safeModeDecision({
    attempts: [
      { at: after(4), state: 'reverted', reason: REVERT_REASONS.operatorRequested, profileRevision: REVISION },
      { at: after(3), state: 'reverted', reason: 'an early health check found: the uplink has no carrier', profileRevision: REVISION },
      { at: after(2), state: 'failed', reason: 'verification did not pass', profileRevision: REVISION },
      { at: after(1), state: 'failed', reason: 'verification did not pass', profileRevision: REVISION },
    ],
    profileRevision: REVISION,
  });
  assert.equal(decision.failures, 0, 'the run ends at the operator revert, newest first');
});

test('a revert the device performed on its own is still a failure', async () => {
  const decision = safeModeDecision({
    attempts: [
      { at: after(3), state: 'reverted', reason: 'an early health check found: the uplink has no carrier', profileRevision: REVISION },
      { at: after(2), state: 'reverted', reason: 'the confirmation window expired without a confirmation', profileRevision: REVISION },
      { at: after(1), state: 'reverted', reason: null, profileRevision: REVISION },
    ],
    profileRevision: REVISION,
  });
  assert.equal(decision.failures, 3);
  assert.equal(decision.enter, true);
});

test('the reason the route writes is the reason the decision reads', async () => {
  const { REVERT_REASONS, isFailureEvidence } = await import('../src/core/safe-mode.ts');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const routes = readFileSync(join(import.meta.dirname, '..', 'src', 'api', 'profiles-routes.ts'), 'utf8');

  // One definition, imported by both sides. Two copies of this string would drift, and the failure mode
  // of the drift is safe mode quietly counting deliberate reverts again.
  assert.ok(routes.includes('REVERT_REASONS.operatorRequested'), 'the route should use the constant');
  assert.ok(!routes.includes("'the operator asked for it to be reverted'"), 'and not a second copy of it');
  assert.equal(
    isFailureEvidence({ at: after(1), state: 'reverted', reason: REVERT_REASONS.operatorRequested, profileRevision: REVISION }),
    false,
  );
});
