/**
 * Which wireless interfaces get watched, and what a failed read is allowed to mean.
 *
 * Every case pairs a failed read against an empty one. That pairing is the test: the defect being
 * fixed was that those two produced the same answer, so a suite that exercised only one of them
 * would have passed against the broken code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wirelessRolesFrom, unreadableRadiosSummary } from '../src/api/wireless-roles.ts';
import type { Radio } from '../src/platform/wifi.ts';

/** A radio as the driver reports one, with only the fields this decision reads. */
function radio(interfaces: { name: string | null; type: string }[]): Radio {
  return {
    phy: 'phy0',
    capabilities: {} as Radio['capabilities'],
    devicePath: null,
    bus: null,
    usbId: null,
    mac: null,
    interfaces,
  } as Radio;
}

const BENCH = [
  radio([{ name: 'wlx90de8047b4b4', type: 'AP' }]),
  radio([{ name: 'wfwan0', type: 'managed' }]),
];

// ------------------------------------------------------- the distinction that was lost

test('a failed read is null, and null is not an empty answer', () => {
  // The defect, in one line. `platform.wifi.phys().catch(() => [])` made these identical, and the
  // watch calls replace their sets — so one `iw` timeout stopped all wireless telemetry and the
  // panel reported nobody connected.
  assert.equal(wirelessRolesFrom(null), null, 'a failed read produced a watch list instead of a refusal to answer');
});

test('a driver that answers with no radios is an empty answer, and says so', () => {
  // The twin. Without this case a verdict hardcoded to null would pass the test above, and the
  // suite would prove nothing about which input it read.
  assert.deepEqual(wirelessRolesFrom([]), { accessPoints: [], links: [] });
});

test('the two are distinguishable by the caller, which is the entire point', () => {
  // Stated as an assertion rather than left to the comment above: a caller must be able to branch on
  // the difference, and `null` versus an object is the one shape that cannot be confused.
  assert.notDeepEqual(wirelessRolesFrom(null), wirelessRolesFrom([]));
});

// ------------------------------------------------------- the roles themselves

test('an AP interface is watched as an access point and a managed one for link quality', () => {
  assert.deepEqual(wirelessRolesFrom(BENCH), { accessPoints: ['wlx90de8047b4b4'], links: ['wfwan0'] });
});

test('both roles on one radio are separated, not merged', () => {
  // Named one by one rather than by count: a board hosting an access point and a client on one
  // radio is the configuration this device is for, and putting either in the wrong set points a
  // poller at an interface it cannot read.
  const roles = wirelessRolesFrom([radio([{ name: 'ap0', type: 'AP' }, { name: 'sta0', type: 'managed' }])]);
  assert.deepEqual(roles?.accessPoints, ['ap0']);
  assert.deepEqual(roles?.links, ['sta0']);
});

test('an interface with no name is skipped rather than guessed at', () => {
  const roles = wirelessRolesFrom([radio([{ name: null, type: 'AP' }, { name: 'ap0', type: 'AP' }])]);
  assert.deepEqual(roles?.accessPoints, ['ap0']);
});

test('a mode neither poller understands lands in neither set', () => {
  // Monitor mode is not made to fit one of the two sets. The sets drive two specific pollers, and
  // pointing one at an interface it cannot read produces a failing reading, not a missing one.
  const roles = wirelessRolesFrom([radio([{ name: 'mon0', type: 'monitor' }, { name: 'mesh0', type: 'mesh point' }])]);
  assert.deepEqual(roles, { accessPoints: [], links: [] });
});

// ------------------------------------------------------- what the operator is told

test('the summary names what is still being watched, and refuses to imply nothing is connected', () => {
  const summary = unreadableRadiosSummary({ accessPoints: ['wlx90de8047b4b4'], links: ['wfwan0'] });

  assert.match(summary, /wlx90de8047b4b4/);
  assert.match(summary, /wfwan0/);
  // The operator's actual question when the panel shows nothing: is it broken, or are we not looking?
  assert.match(summary, /not evidence that nothing is connected/);
});

test('the summary distinguishes an empty watch list from a lost one', () => {
  const summary = unreadableRadiosSummary({ accessPoints: [], links: [] });
  assert.match(summary, /nothing was being watched yet/);
});
