/**
 * When a credential stops working, on a device whose clock is not to be trusted.
 *
 * The rule these tests defend is a product decision as much as a technical one: **the single moment an
 * operator must not lose their credentials is while a timer is counting down on a change only they can
 * confirm** — and since the apply restarts the time service, a forward clock step inside that window is
 * the designed path rather than bad luck.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  attemptCountsTowardsLockout,
  sessionVerdict,
  tokenVerdict,
  type MonotonicStamp,
} from '../src/core/credential-expiry.ts';
import { LOGIN_ATTEMPT_HISTORY, SESSION_IDLE_SECONDS, TOUCH_THROTTLE_SECONDS } from '../src/state/store.ts';

const BOOT = 'boot-a';
const stampAt = (uptimeSeconds: number): MonotonicStamp => ({ bootId: BOOT, uptimeSeconds });

/* ── sessions ────────────────────────────────────────────────────────────────────────────── */

test('a session is judged on idle time, so no wall-clock step can retire one in use', () => {
  const anchor = { bootId: BOOT, lastSeenUptimeSeconds: 1_000 };
  const base = { anchor, idleLimitSeconds: 100, holdsOpenWindow: false };

  assert.deepEqual(sessionVerdict({ ...base, stamp: stampAt(1_050) }), { kind: 'valid', reanchor: false });
  assert.equal(sessionVerdict({ ...base, stamp: stampAt(1_101) }).kind, 'expired');
  // Exactly at the limit is still valid: an off-by-one here signs the operator out a second early.
  assert.equal(sessionVerdict({ ...base, stamp: stampAt(1_100) }).kind, 'valid');
});

test('a session from another boot is re-anchored, not retired', () => {
  // Its age cannot be computed, and the two ways of resolving that are not symmetric: retiring it logs
  // out somebody who has just rebooted their own device, which is the direction that costs management.
  const verdict = sessionVerdict({
    anchor: { bootId: 'boot-previous', lastSeenUptimeSeconds: 900_000 },
    stamp: stampAt(30),
    idleLimitSeconds: 100,
    holdsOpenWindow: false,
  });
  assert.deepEqual(verdict, { kind: 'valid', reanchor: true });
});

test('a session with no anchor at all is re-anchored on first use', () => {
  // A row written before the column existed.
  const verdict = sessionVerdict({
    anchor: { bootId: null, lastSeenUptimeSeconds: null },
    stamp: stampAt(30),
    idleLimitSeconds: 100,
    holdsOpenWindow: false,
  });
  assert.deepEqual(verdict, { kind: 'valid', reanchor: true });
});

test('an unreadable uptime makes a session unverifiable, never expired', () => {
  const verdict = sessionVerdict({
    anchor: { bootId: BOOT, lastSeenUptimeSeconds: 1_000 },
    stamp: null,
    idleLimitSeconds: 100,
    holdsOpenWindow: false,
  });
  assert.equal(verdict.kind, 'unverifiable');
});

test('an open confirmation window keeps its own session alive past any limit', () => {
  /*
   * The rule this file exists for. The operator has applied a network change, the page is counting
   * down, and only their session can confirm it — losing it there means the change reverts for want of
   * a click nobody could make. The idle time here is absurd on purpose: nothing overrides the exemption.
   */
  const verdict = sessionVerdict({
    anchor: { bootId: BOOT, lastSeenUptimeSeconds: 0 },
    stamp: stampAt(10_000_000),
    idleLimitSeconds: 100,
    holdsOpenWindow: true,
  });
  assert.deepEqual(verdict, { kind: 'valid', reanchor: false });
});

test('the idle limit is far larger than the interval at which the anchor moves', () => {
  /*
   * A derived relationship rather than two numbers checked by eye. The anchor is only rewritten when
   * "last seen" is more than `TOUCH_THROTTLE_SECONDS` stale, so an idle limit anywhere near that
   * interval would expire sessions that were being used continuously.
   */
  assert.ok(
    SESSION_IDLE_SECONDS > TOUCH_THROTTLE_SECONDS * 100,
    `an idle limit of ${SESSION_IDLE_SECONDS}s is too close to a ${TOUCH_THROTTLE_SECONDS}s write throttle`,
  );
});

/* ── tokens ──────────────────────────────────────────────────────────────────────────────── */

test('a token with no expiry is always valid, whatever the clock says', () => {
  for (const clockTrusted of [true, false, null]) {
    assert.deepEqual(tokenVerdict({ expiresAt: null, now: new Date(), clockTrusted, holdsOpenWindow: false }), {
      kind: 'valid',
      reanchor: false,
    });
  }
});

test('an absolute expiry is enforced only against a clock worth judging against', () => {
  /*
   * The opposite direction from the certificate warning, and the difference is the cost of each mistake.
   * A certificate wrongly trusted exposes the operator's traffic to a stranger; a token wrongly expired
   * locks the owner out of their own device. Fail towards the smaller loss in each case.
   */
  const past = '2026-09-01T00:00:00.000Z';
  const now = new Date('2026-09-21T00:00:00.000Z');

  assert.equal(tokenVerdict({ expiresAt: past, now, clockTrusted: true, holdsOpenWindow: false }).kind, 'expired');

  for (const clockTrusted of [false, null]) {
    const verdict = tokenVerdict({ expiresAt: past, now, clockTrusted, holdsOpenWindow: false });
    assert.equal(verdict.kind, 'unverifiable', 'an unreliable clock must not enforce an expiry');
    // The reason is carried so the caller can log it: honouring it silently would be a hidden extension.
    assert.match(verdict.kind === 'unverifiable' ? verdict.reason : '', /clock/);
  }
});

test('an unreadable expiry is unverifiable rather than treated as long past', () => {
  const verdict = tokenVerdict({ expiresAt: 'whenever', now: new Date(), clockTrusted: true, holdsOpenWindow: false });
  assert.equal(verdict.kind, 'unverifiable');
});

test('an open confirmation window keeps its own token alive past its stated expiry', () => {
  const verdict = tokenVerdict({
    expiresAt: '2020-01-01T00:00:00.000Z',
    now: new Date('2026-09-21T00:00:00.000Z'),
    clockTrusted: true,
    holdsOpenWindow: true,
  });
  assert.deepEqual(verdict, { kind: 'valid', reanchor: false });
});

/* ── lockouts ────────────────────────────────────────────────────────────────────────────── */

test('only failures from this boot, inside the window, count towards a lockout', () => {
  const stamp = stampAt(1_000);
  const counts = (attempt: { bootId: string | null; uptimeSeconds: number | null; succeeded: boolean }) =>
    attemptCountsTowardsLockout({ attempt, stamp, windowSeconds: 600 });

  assert.equal(counts({ bootId: BOOT, uptimeSeconds: 900, succeeded: false }), true);
  assert.equal(counts({ bootId: BOOT, uptimeSeconds: 900, succeeded: true }), false, 'a success is not a failure');
  assert.equal(counts({ bootId: BOOT, uptimeSeconds: 300, succeeded: false }), false, 'outside the window');
  assert.equal(counts({ bootId: 'boot-other', uptimeSeconds: 900, succeeded: false }), false, 'another boot');
  assert.equal(counts({ bootId: null, uptimeSeconds: null, succeeded: false }), false, 'undatable');
});

test('the recorded trade: a reboot clears an in-progress lockout', () => {
  /*
   * Asserted rather than merely commented, because it is a security-relevant choice somebody will
   * reasonably want to change. The reasoning that has to be met first: nobody can reboot this device
   * without already holding the access a lockout protects, the management surface is the device's own
   * access point rather than the open internet, and treating undatable rows as recent locks a legitimate
   * operator out of a device they may have no other way into. Losing management of the device is the
   * worse outcome than a slower brute force.
   */
  const beforeReboot = Array.from({ length: LOGIN_ATTEMPT_HISTORY }, (_, index) => ({
    bootId: 'boot-before',
    uptimeSeconds: 1_000 + index,
    succeeded: false,
  }));
  const afterReboot = stampAt(20);
  const counted = beforeReboot.filter((attempt) =>
    attemptCountsTowardsLockout({ attempt, stamp: afterReboot, windowSeconds: 600 }),
  );
  assert.equal(counted.length, 0);
});
