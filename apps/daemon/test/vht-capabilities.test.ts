/**
 * The `vht_capab` line hostapd is given, from the capability word the driver reports.
 *
 * Measured on the bench board, 2026-10-16: moving the access point to the built-in radio failed because the
 * line carried `[TX-ANTENNA-PATTERN]`, read off bit 20 — which is MU-beamformee. hostapd refused to start
 * ("Driver does not support configured VHT capability [VHT_CAP_TX_ANTENNA_PATTERN]") and the window reverted.
 * Both words below are the ones `iw phy` printed on that board.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vhtCapabilities } from '../src/core/generate/hostapd.ts';

test('the built-in radio is offered only what it reports, and no antenna pattern', () => {
  assert.equal(vhtCapabilities('0x01b07031'), '[MAX-MPDU-7991][RXLDPC][SHORT-GI-80][SU-BEAMFORMEE]');
});

test('the USB adapter keeps its antenna patterns, read from bits 28 and 29', () => {
  assert.equal(vhtCapabilities('0x339071b2'), '[MAX-MPDU-11454][RXLDPC][SHORT-GI-80][TX-STBC-2BY1][SU-BEAMFORMEE][RX-ANTENNA-PATTERN][TX-ANTENNA-PATTERN]');
});
