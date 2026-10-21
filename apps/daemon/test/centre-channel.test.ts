/**
 * The centre-frequency index hostapd is given for a wide 5 GHz channel.
 *
 * Measured on the bench board, 2026-10-21: channel 149 at 80 MHz was written with centre 154, hostapd
 * refused to bring the interface up, and the window reverted. The expected values are the centres of
 * the 802.11 5 GHz channel plan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { centreChannel } from '../src/core/generate/hostapd.ts';

test('the lower groups count from 36', () => {
  assert.equal(centreChannel(36, 80), 42);
  assert.equal(centreChannel(48, 80), 42);
  assert.equal(centreChannel(52, 80), 58);
  assert.equal(centreChannel(140, 80), 138);
  assert.equal(centreChannel(36, 40), 38);
  assert.equal(centreChannel(44, 40), 46);
  assert.equal(centreChannel(100, 160), 114);
});

test('the upper groups count from 149, not from 148', () => {
  assert.equal(centreChannel(149, 80), 155);
  assert.equal(centreChannel(161, 80), 155);
  assert.equal(centreChannel(149, 40), 151);
  assert.equal(centreChannel(157, 40), 159);
  assert.equal(centreChannel(149, 160), 163);
});
