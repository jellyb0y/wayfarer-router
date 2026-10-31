/**
 * The access point radio watch (`core/radio-watch.ts`).
 *
 * The incident it answers (bench board, 2026-10-16): a USB radio's firmware hung, and for six hours hostapd
 * said `ENABLED`, the unit was active, and the interface moved no packets. These tests hold the watch to
 * three promises: it notices from the radio rather than from hostapd, it climbs its ladder one rung at a
 * time and stops, and it never acts while something else owns the access point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Platform } from '../src/platform/index.ts';
import { createObserverRegistry } from '../src/core/observers.ts';
import { REPAIR_SETTLE_MS, SILENT_WITH_CLIENTS_MS, LADDER_MIN_INTERVAL_MS, watchAccessPointRadio } from '../src/core/radio-watch.ts';

const USB_DEVICE = '/sys/devices/platform/soc/5200000.usb/usb2/2-1/2-1:1.0';
const HANG = 'mt7921u 2-1:1.0: Message 00020003 (seq 7) timeout';

function bench(options: { bus?: 'usb' | 'platform'; applying?: boolean; windowOpen?: boolean } = {}) {
  const calls: string[] = [];
  const events: { kind: string; level: string }[] = [];
  const state = {
    hostapd: 'ENABLED' as string | null,
    unitActive: true,
    stations: 0,
    tx: 100,
    rx: 100,
    kernel: [] as string[],
    cursor: 0,
  };
  const platform = {
    systemd: {
      listOwnedUnits: async () => ['wf-hostapd@.service', 'wf-hostapd@wlx90de8047b4b4.service'],
      state: async () => ({ isEnabled: true, isActive: state.unitActive }),
      restart: async (unit: string) => {
        calls.push(`restart ${unit}`);
        return { ok: true };
      },
      resetFailed: async () => undefined,
    },
    wifi: {
      phys: async () => [
        {
          phy: 'phy1',
          devicePath: options.bus === 'platform' ? '/sys/devices/platform/unisoc_wifi' : USB_DEVICE,
          bus: options.bus ?? 'usb',
          interfaces: [{ name: 'wlx90de8047b4b4', type: 'AP' }],
        },
      ],
    },
    ap: {
      status: async () =>
        state.hostapd === null ? null : { state: state.hostapd, bss: [{ index: 0, stationCount: state.stations }] },
    },
    radio: {
      counters: async () => ({ txPackets: state.tx, rxPackets: state.rx }),
      rebindUsb: async (path: string) => {
        calls.push(`rebind ${path}`);
        return { ok: true as const, device: '2-1:1.0', driver: 'mt7921u' };
      },
    },
    journal: {
      // A cursor is the number of kernel lines seen; a page is what came after it.
      read: async (query: { afterCursor?: string; limit?: number }) => {
        const from = query.afterCursor === undefined ? state.kernel.length : Number(query.afterCursor);
        const entries = query.afterCursor === undefined ? [] : state.kernel.slice(from).map((message) => ({ message }));
        return { entries, nextCursor: String(state.kernel.length) };
      },
    },
  } as unknown as Platform;

  let clock = 0;
  const watch = watchAccessPointRadio({
    observers: createObserverRegistry(),
    platform,
    applying: () => options.applying === true,
    windowOpen: () => options.windowOpen === true,
    record: (event) => events.push({ kind: event.kind, level: event.level }),
    now: () => clock,
    start: false,
  });
  return { watch, calls, events, state, advance: (ms: number) => void (clock += ms) };
}

test('an error from the radio’s own device in the kernel log restarts the access point, and nothing else', async () => {
  const b = bench();
  await b.watch.check();
  b.state.kernel.push('usb 1-1: some other device complaining', HANG);
  b.advance(30_000);
  await b.watch.check();
  assert.deepEqual(b.calls, ['restart wf-hostapd@wlx90de8047b4b4.service']);
  assert.deepEqual(b.events.map((event) => event.kind), ['radio.restarted']);
});

test('the complaint a restart itself causes is not taken for a second hang', async () => {
  const b = bench();
  await b.watch.check();
  b.state.kernel.push(HANG);
  b.advance(30_000);
  await b.watch.check();
  // Measured at 09:41 on 2026-10-16: the restart that fixed the radio logged `timed out waiting for pending tx`.
  b.state.kernel.push('mt7921u 2-1:1.0: timed out waiting for pending tx');
  b.advance(30_000);
  await b.watch.check();
  b.advance(REPAIR_SETTLE_MS);
  await b.watch.check();
  assert.deepEqual(b.calls, ['restart wf-hostapd@wlx90de8047b4b4.service']);
  assert.deepEqual(b.events.map((event) => event.kind), ['radio.restarted', 'radio.recovered']);
});

test('a restart that does not hold is followed by a USB rebind, and then the watch gives up and says so', async () => {
  const b = bench();
  await b.watch.check();
  b.state.kernel.push(HANG);
  await b.watch.check();
  // Still broken after it settles: hostapd never comes back.
  b.state.hostapd = 'DISABLED';
  for (const _ of [1, 2, 3]) {
    b.advance(REPAIR_SETTLE_MS);
    await b.watch.check();
    await b.watch.check();
  }
  assert.deepEqual(b.calls, [
    'restart wf-hostapd@wlx90de8047b4b4.service',
    `rebind ${USB_DEVICE}`,
    'restart wf-hostapd@wlx90de8047b4b4.service',
  ]);
  assert.deepEqual(b.events.map((event) => event.kind), ['radio.restarted', 'radio.usb-rebound', 'radio.unrecoverable']);
  // Gave up: no more restarts however long it stays broken.
  b.advance(LADDER_MIN_INTERVAL_MS * 3);
  await b.watch.check();
  await b.watch.check();
  assert.equal(b.calls.length, 3);
});

test('a built-in radio has no USB rung', async () => {
  const b = bench({ bus: 'platform' });
  await b.watch.check();
  b.state.hostapd = 'DISABLED';
  await b.watch.check();
  await b.watch.check();
  b.advance(REPAIR_SETTLE_MS);
  await b.watch.check();
  await b.watch.check();
  assert.deepEqual(b.calls, ['restart wf-hostapd@wlx90de8047b4b4.service']);
  assert.deepEqual(b.events.map((event) => event.kind), ['radio.restarted', 'radio.unrecoverable']);
});

test('silence without clients is not a fault; silence with clients for a minute is', async () => {
  const b = bench();
  for (let i = 0; i < 12; i += 1) {
    await b.watch.check();
    b.advance(60_000);
  }
  assert.deepEqual(b.calls, [], 'an access point nobody is using stands still honestly');

  b.state.stations = 1;
  await b.watch.check();
  b.advance(SILENT_WITH_CLIENTS_MS - 1_000);
  await b.watch.check();
  assert.deepEqual(b.calls, []);
  b.advance(2_000);
  await b.watch.check();
  assert.deepEqual(b.calls, ['restart wf-hostapd@wlx90de8047b4b4.service']);
});

test('frames received with clients connected is health', async () => {
  const b = bench();
  b.state.stations = 3;
  await b.watch.check();
  for (let i = 0; i < 20; i += 1) {
    b.state.rx += 5;
    b.advance(30_000);
    await b.watch.check();
  }
  assert.deepEqual(b.calls, []);
});

test('a trickle of stray packets does not hide a hung radio (2026-10-30: 17 packets in 250 s)', async () => {
  const b = bench();
  b.state.stations = 3;
  await b.watch.check();
  for (let i = 0; i < 4; i += 1) {
    b.state.rx += 1;
    b.advance(30_000);
    await b.watch.check();
  }
  assert.deepEqual(b.calls, ['restart wf-hostapd@wlx90de8047b4b4.service']);
});

test('a restart nobody can rejoin is not a recovery (2026-10-31: enabled, 0 clients, still hung)', async () => {
  const b = bench();
  b.state.stations = 3;
  await b.watch.check();
  b.advance(SILENT_WITH_CLIENTS_MS + 1_000);
  await b.watch.check();
  assert.deepEqual(b.calls, ['restart wf-hostapd@wlx90de8047b4b4.service']);
  b.state.stations = 0;
  b.advance(REPAIR_SETTLE_MS);
  await b.watch.check();
  assert.deepEqual(b.calls, ['restart wf-hostapd@wlx90de8047b4b4.service', `rebind ${USB_DEVICE}`, 'restart wf-hostapd@wlx90de8047b4b4.service']);
  assert.deepEqual(b.events.map((event) => event.kind), ['radio.restarted', 'radio.usb-rebound']);
  // The clients come back after the rebind and the radio receives: that is the recovery.
  b.state.stations = 2;
  b.advance(REPAIR_SETTLE_MS);
  for (let i = 0; i < 3; i += 1) {
    b.state.rx += 100;
    await b.watch.check();
    b.advance(30_000);
  }
  assert.equal(b.calls.length, 3);
  assert.deepEqual(b.events.map((event) => event.kind), ['radio.restarted', 'radio.usb-rebound', 'radio.recovered']);
});

test('frames still being sent do not hide a radio that receives nothing', async () => {
  // Measured on 2026-10-22: from 19:28:50 the adapter received nothing while hostapd handed it about one
  // frame a second, and the kernel stayed quiet until 19:34:10.
  const b = bench();
  b.state.stations = 5;
  await b.watch.check();
  for (let i = 0; i < 3; i += 1) {
    b.state.tx += 30;
    b.advance(30_000);
    await b.watch.check();
  }
  assert.deepEqual(b.calls, ['restart wf-hostapd@wlx90de8047b4b4.service']);
});

test('an unreadable hostapd status is not a down access point while its unit runs', async () => {
  const b = bench();
  b.state.hostapd = null;
  for (let i = 0; i < 5; i += 1) await b.watch.check();
  assert.deepEqual(b.calls, []);
  b.state.unitActive = false;
  await b.watch.check();
  await b.watch.check();
  assert.deepEqual(b.calls, ['restart wf-hostapd@wlx90de8047b4b4.service']);
});

for (const owner of ['applying', 'windowOpen'] as const) {
  test(`nothing is done while ${owner === 'applying' ? 'an apply runs' : 'a confirmation window is open'}`, async () => {
    const b = bench({ [owner]: true });
    await b.watch.check();
    b.state.kernel.push(HANG);
    b.state.hostapd = 'DISABLED';
    for (let i = 0; i < 4; i += 1) {
      b.advance(REPAIR_SETTLE_MS);
      await b.watch.check();
    }
    assert.deepEqual(b.calls, []);
    assert.deepEqual(b.events, []);
  });
}

test('a radio that recovers starts the ladder again, but not within ten minutes of the last climb', async () => {
  const b = bench();
  await b.watch.check();
  b.state.kernel.push(HANG);
  await b.watch.check();
  b.advance(REPAIR_SETTLE_MS);
  await b.watch.check();
  assert.equal(b.calls.length, 1);
  b.state.kernel.push(HANG);
  b.advance(30_000);
  await b.watch.check();
  assert.equal(b.calls.length, 1, 'a second climb inside ten minutes would be a restart loop');
  b.advance(LADDER_MIN_INTERVAL_MS);
  b.state.kernel.push(HANG);
  await b.watch.check();
  assert.deepEqual(b.calls, ['restart wf-hostapd@wlx90de8047b4b4.service', 'restart wf-hostapd@wlx90de8047b4b4.service']);
});

/* ── the platform half ───────────────────────────────────────────────────────────────────── */

test('the counters are read from sysfs, and an interface that cannot be read is null rather than zero', async () => {
  const { scratchDir } = await import('./helpers/scratch.ts');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { counters } = await import('../src/platform/radio-device.ts');
  const root = await scratchDir('wayfarer-radio-');
  await mkdir(join(root, 'wlan1', 'statistics'), { recursive: true });
  await writeFile(join(root, 'wlan1', 'statistics', 'tx_packets'), '26032568\n');
  await writeFile(join(root, 'wlan1', 'statistics', 'rx_packets'), '9661049\n');
  assert.deepEqual(await counters('wlan1', root), { txPackets: 26032568, rxPackets: 9661049 });
  assert.equal(await counters('wlan9', root), null);
  assert.equal(await counters('../etc', root), null);
});

test('a rebind refuses anything that is not a USB interface: the wrong unbind takes a device away', async () => {
  const { rebindUsb } = await import('../src/platform/radio-device.ts');
  for (const path of ['/sys/devices/platform/unisoc_wifi', '/sys/devices/platform/soc/5020000.ethernet', '/nonexistent']) {
    const outcome = await rebindUsb(path);
    assert.equal(outcome.ok, false, path);
  }
});
