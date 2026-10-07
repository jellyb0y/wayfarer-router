/**
 * Whether the station list on the status snapshot is the whole list — asked of the reply the bench
 * board's access point actually gave.
 *
 * Measured 2026-09-23 on the bench board (USB radio, hostapd 2.10): `all_sta` exited 0 in 7 ms with
 * 1755 bytes and two stations; `list_sta` and `iw station dump` named the same two. The Clients screen
 * still said "This access point did not finish listing its clients", because the snapshot carried the
 * platform layer's "rebuilt one station at a time" flag and the screen read it as "complete". These
 * tests drive that captured reply through the real controller and the real telemetry poll, and ask
 * the question the screen asks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApController, type HostapdCall } from '../src/platform/ap.ts';
import { createTelemetry } from '../src/telemetry/index.ts';

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

/** The reply captured from `hostapd_cli -p /run/wayfarer/hostapd -i <ap> all_sta`, addresses replaced. */
const CAPTURED = fixture('hostapd/all-sta-two-clients-usb-radio.txt');

async function snapshotOf(call: HostapdCall) {
  const ap = createApController({ call });
  const platform = {
    net: {
      watch: () => ({ stop: () => undefined }),
      snapshot: async () => ({ links: [], addresses: [], routes: [], at: Date.now() }),
      addresses: async () => [],
    },
    systemd: { watch: async () => ({ stop: () => undefined }), state: async () => null },
    ap: { watch: () => ({ stop: () => undefined }), status: async () => null, stations: ap.stations },
    wifi: { link: async () => ({ connected: false }) },
    clock: {
      status: async () => ({ timezone: null, ntpEnabled: null, synchronized: null, localRtc: null, timeUsec: null, rtcTimeUsec: null }),
    },
  } as unknown as Parameters<typeof createTelemetry>[0];

  const telemetry = createTelemetry(platform);
  telemetry.watchAccessPoints(['bench-ap0']);
  const stop = await telemetry.start({ pollIntervalMs: 60_000, coalesceMs: 5 });
  await telemetry.pollNow();
  const reading = telemetry.snapshot().accessPoints['bench-ap0'];
  await stop();
  assert.ok(reading, 'the access point was polled');
  return reading;
}

test('a whole all_sta reply from the bench radio is reported as the whole list', async () => {
  const reading = await snapshotOf(async (_interfaceName, command) =>
    command[0] === 'all_sta' ? { code: 0, stdout: CAPTURED } : { code: 1, stdout: 'not asked on this path' },
  );

  assert.deepEqual(
    reading.stations.map((s) => s.mac),
    ['aa:bb:cc:00:0e:01', 'aa:bb:cc:00:0e:02'],
  );
  // The question the Clients screen asks. Before the fix the snapshot said `stationsIterated: false`
  // for this reply, and the screen drew that as an unfinished list.
  assert.equal(reading.stationsComplete, true);
  assert.equal(reading.stationsIncomplete, null);
});

test('a list that genuinely did not finish says why, in words', async () => {
  const failed = await snapshotOf(async () => ({
    code: 255,
    stdout: '',
    stderr: 'Failed to connect to hostapd - wpa_ctrl_open: No such file or directory\n',
  }));
  assert.equal(failed.stationsComplete, false);
  assert.equal(
    failed.stationsIncomplete,
    'hostapd_cli all_sta exited with status 255: Failed to connect to hostapd - wpa_ctrl_open: No such file or directory',
  );

  const slow = await snapshotOf(async () => ({ code: null, stdout: '', timedOut: true }));
  assert.equal(slow.stationsComplete, false);
  assert.equal(slow.stationsIncomplete, 'hostapd_cli all_sta did not answer in time');

  const threw = await snapshotOf(async () => {
    throw new Error('spawn /usr/sbin/hostapd_cli ENOENT');
  });
  assert.equal(threw.stationsComplete, false);
  assert.match(threw.stationsIncomplete ?? '', /could not be read \(spawn \/usr\/sbin\/hostapd_cli ENOENT\)/);
});

test('a truncated reply rebuilt to the end is whole; one whose listing failed is not, and says so', async () => {
  const truncated = fixture('hostapd/all-sta-truncated.txt');
  const blocks = CAPTURED.split(/\n(?=aa:bb:cc:00:0e:02\n)/);

  const rebuilt = await snapshotOf(async (_interfaceName, command) => {
    if (command[0] === 'all_sta') return { code: 0, stdout: truncated };
    if (command[0] === 'list_sta') return { code: 0, stdout: 'aa:bb:cc:00:0e:01\naa:bb:cc:00:0e:02\n' };
    if (command[0] === 'sta' && command[1] === 'aa:bb:cc:00:0e:01') return { code: 0, stdout: blocks[0]! };
    if (command[0] === 'sta' && command[1] === 'aa:bb:cc:00:0e:02') return { code: 0, stdout: blocks[1]! };
    return { code: 1, stdout: '' };
  });
  assert.equal(rebuilt.stationsComplete, true);
  assert.equal(rebuilt.stations.length, 2);

  const unlisted = await snapshotOf(async (_interfaceName, command) =>
    command[0] === 'all_sta' ? { code: 0, stdout: truncated } : { code: null, stdout: '', timedOut: true },
  );
  assert.equal(unlisted.stationsComplete, false);
  assert.equal(
    unlisted.stationsIncomplete,
    'the full list was too long for one reply, and hostapd_cli list_sta did not answer in time',
  );
});
