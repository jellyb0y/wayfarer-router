/**
 * Tests for the `iw` parsers, against output captured from real hardware.
 * Provenance of every fixture is in test/fixtures/README.md; two fixtures there are
 * labelled synthetic and the tests that use them say so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseIwPhy } from '../src/platform/parse/iw-phy.ts';
import {
  parseIwDev,
  parseIwDevInfo,
  parseIwLink,
  parseIwStationDump,
  parseBitrate,
} from '../src/platform/parse/iw-dev.ts';
import { parseIwRegGet, domainForPhy } from '../src/platform/parse/iw-reg.ts';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

test('iw phy: both radios are found with their own capabilities', () => {
  const phys = parseIwPhy(fixture('iw/phy-two-radios.txt'));
  assert.equal(phys.length, 2);
  assert.deepEqual(
    phys.map((p) => p.name),
    ['phy1', 'phy0'],
  );
  // Radios are not numbered in order and phy0 is not the built-in one on this board,
  // which is the reason nothing may key off the name.
  assert.equal(phys[0]!.index, 1);
  assert.equal(phys[1]!.index, 0);
});

test('iw phy: interface combinations keep their structure, their totals and their channel limit', () => {
  const phys = parseIwPhy(fixture('iw/phy-two-radios.txt'));
  const builtIn = phys.find((p) => p.name === 'phy1')!;
  const usb = phys.find((p) => p.name === 'phy0')!;

  // Measured: the built-in radio publishes ONE combination in which managed and AP
  // share a limit of 1, so it cannot serve an access point and a client at once.
  assert.equal(builtIn.interfaceCombinations.length, 1);
  const combo = builtIn.interfaceCombinations[0]!;
  assert.deepEqual(combo.groups[0], { modes: ['managed', 'AP'], max: 1 });
  assert.equal(combo.total, 3);
  assert.equal(combo.channels, 2);
  assert.match(combo.text, /#\{ managed, AP \} <= 1/);

  // The USB radio publishes TWO combinations, and the one that allows an access point
  // is limited to a single channel — the fact that forces the access point to follow
  // the uplink's channel when both roles are on this radio.
  assert.equal(usb.interfaceCombinations.length, 2);
  const withAp = usb.interfaceCombinations.find((c) =>
    c.groups.some((g) => g.modes.includes('AP')),
  )!;
  assert.equal(withAp.channels, 1);
  assert.equal(withAp.total, 3);
  const withoutAp = usb.interfaceCombinations.find((c) => c !== withAp)!;
  assert.equal(withoutAp.channels, 2);
});

test('iw phy: the continuation line is attached to the combination it belongs to', () => {
  // `total <= 3, #channels <= 1` arrives on a separate line, indented with spaces
  // rather than tabs. A line-by-line parser reports no channel limit at all.
  const phys = parseIwPhy(fixture('iw/phy-two-radios.txt'));
  for (const phy of phys) {
    for (const combo of phy.interfaceCombinations) {
      assert.notEqual(combo.total, null, `${phy.name}: ${combo.text}`);
      assert.notEqual(combo.channels, null, `${phy.name}: ${combo.text}`);
    }
  }
});

test('iw phy: frequencies carry channel, power and flags, and disabled ones carry no power', () => {
  const phys = parseIwPhy(fixture('iw/phy-two-radios.txt'));
  const usb = phys.find((p) => p.name === 'phy0')!;
  const fiveGhz = usb.bands.find((b) => b.frequencies.some((f) => f.mhz > 5000))!;

  const ch149 = fiveGhz.frequencies.find((f) => f.channel === 149)!;
  assert.equal(ch149.mhz, 5745);
  assert.equal(ch149.maxTxPowerDbm, 30);
  assert.equal(ch149.disabled, false);
  assert.deepEqual(ch149.flags, []);

  const radar = fiveGhz.frequencies.find((f) => f.channel === 52)!;
  assert.deepEqual(radar.flags, ['radar detection']);
  assert.equal(radar.maxTxPowerDbm, 24);

  const noIr = fiveGhz.frequencies.find((f) => f.channel === 169)!;
  assert.deepEqual(noIr.flags, ['no IR']);
  assert.equal(noIr.maxTxPowerDbm, 27);

  const twoGhz = usb.bands.find((b) => b.frequencies.some((f) => f.channel === 1))!;
  const disabled = twoGhz.frequencies.find((f) => f.channel === 12)!;
  assert.equal(disabled.disabled, true);
  // Not zero: a disabled channel with a power of 0 dBm would be offered as usable.
  assert.equal(disabled.maxTxPowerDbm, null);
});

test('iw phy: band numbering is not contiguous and is not an index', () => {
  const usb = parseIwPhy(fixture('iw/phy-two-radios.txt')).find((p) => p.name === 'phy0')!;
  assert.deepEqual(
    usb.bands.map((b) => b.index),
    [1, 2, 4],
  );
});

test('iw phy: VHT capabilities are reported as the driver printed them', () => {
  const builtIn = parseIwPhy(fixture('iw/phy-two-radios.txt')).find((p) => p.name === 'phy1')!;
  const band = builtIn.bands.find((b) => b.vhtCapabilities !== null)!;
  assert.equal(band.vhtCapabilities!.hex, '0x01b07031');
  // The capability list is what decides whether 160 MHz may be offered at all.
  assert.ok(
    band.vhtCapabilities!.flags.some((f) => f.includes('neither 160 nor 80+80')),
    band.vhtCapabilities!.flags.join(' | '),
  );

  const usb = parseIwPhy(fixture('iw/phy-two-radios.txt')).find((p) => p.name === 'phy0')!;
  const usbBand = usb.bands.find((b) => b.vhtCapabilities !== null)!;
  // A different radio on the same board reports a different set, which is why no
  // capability may come from a table.
  assert.equal(usbBand.vhtCapabilities!.hex, '0x339071b2');
});

test('iw phy: antennas, modes and HE iftypes', () => {
  const phys = parseIwPhy(fixture('iw/phy-two-radios.txt'));
  const builtIn = phys.find((p) => p.name === 'phy1')!;
  const usb = phys.find((p) => p.name === 'phy0')!;

  assert.deepEqual(builtIn.antennas, { txMask: 0x1, rxMask: 0x1 });
  assert.deepEqual(usb.antennas, { txMask: 0x3, rxMask: 0x3 });
  assert.ok(builtIn.interfaceModes.includes('AP'));
  assert.ok(builtIn.interfaceModes.includes('managed'));
  // An empty list is the honest answer here: this radio publishes no software modes.
  assert.deepEqual(builtIn.softwareInterfaceModes, []);
  assert.equal(builtIn.maxAssociatedStations, 10);

  const heBand = usb.bands.find((b) => b.heIftypes.length > 0)!;
  assert.deepEqual(
    heBand.heIftypes.map((h) => h.iftype),
    ['managed', 'AP'],
  );
  assert.equal(heBand.heIftypes[0]!.macCapabilitiesHex, '0x08011a000040');
});

test('iw dev: an unnamed non-netdev interface does not become an interface called undefined', () => {
  const interfaces = parseIwDev(fixture('iw/dev-ap-and-managed.txt'));
  assert.equal(interfaces.length, 3);

  const unnamed = interfaces.find((i) => i.name === null)!;
  assert.equal(unnamed.type, 'P2P-device');
  assert.equal(unnamed.phy, 'phy1');
  assert.equal(unnamed.ifindex, null);

  const client = interfaces.find((i) => i.type === 'managed')!;
  assert.equal(client.name, 'wlan0');
  assert.equal(client.phy, 'phy1');
  assert.equal(client.ifindex, 4);

  const ap = interfaces.find((i) => i.type === 'AP')!;
  assert.equal(ap.phy, 'phy0');
  assert.equal(ap.channel?.channel, 149);
  assert.equal(ap.channel?.widthMhz, 80);
  assert.equal(ap.channel?.center1Mhz, 5775);
  assert.equal(ap.txPowerDbm, 3);
});

test('iw dev info: the same block parses with a wiphy line instead of a phy header', () => {
  const ap = parseIwDevInfo(fixture('iw/dev-info-ap.txt'))!;
  assert.equal(ap.name, 'wlanap');
  assert.equal(ap.phy, 'phy0');
  assert.equal(ap.type, 'AP');
  assert.equal(ap.channel?.frequencyMhz, 5745);

  const client = parseIwDevInfo(fixture('iw/dev-info-managed.txt'))!;
  assert.equal(client.phy, 'phy1');
  assert.equal(client.type, 'managed');
  // This driver prints no channel for a client interface: unknown, not zero.
  assert.equal(client.channel, null);
});

test('iw dev link: signal, counters and the negotiated rate', () => {
  const link = parseIwLink(fixture('iw/dev-link-connected.txt'));
  assert.equal(link.connected, true);
  assert.equal(link.signalDbm, -49);
  assert.equal(link.frequencyMhz, 5220);
  assert.equal(link.rxPackets, 1969975);
  assert.equal(link.txBytes, 359837657);
  assert.equal(link.txBitrate?.mbps, 390);
  // The modulation index and the width matter more than signal strength: throughput
  // improves with decorrelated antenna paths while the signal figure stays put.
  assert.equal(link.txBitrate?.mcs, 9);
  assert.equal(link.txBitrate?.widthMhz, 80);
  assert.equal(link.txBitrate?.nss, 1);
  // This driver reports no rx bitrate at all.
  assert.equal(link.rxBitrate, null);
});

test('iw dev link: not connected is a state, not an error', () => {
  const link = parseIwLink('Not connected.\n');
  assert.equal(link.connected, false);
  assert.equal(link.signalDbm, null);
  assert.deepEqual(parseIwLink('').connected, false);
});

test('iw station dump: empty output from a working interface yields no stations', () => {
  // Captured from the built-in radio while associated and passing traffic: the driver
  // does not populate this report at all.
  assert.deepEqual(parseIwStationDump(fixture('iw/station-dump-empty.txt')), []);
});

test('iw station dump: two real clients, one on VHT and one on HT', () => {
  // Captured from the bench access point with two devices associated (2026-09-19). The second
  // station is the valuable one: its rates carry no width and no spatial-stream count, which is the
  // shape the synthetic fixture used to guess at.
  const stations = parseIwStationDump(fixture('iw/station-dump-two-clients.txt'));
  assert.equal(stations.length, 2);

  const vht = stations[0]!;
  assert.equal(vht.onInterface, 'wlanap');
  assert.equal(vht.connectedSeconds, 147);
  assert.equal(vht.authorized, true);
  assert.equal(vht.authenticated, true);
  // `signal: -78 [-81, -81] dBm` — the combined figure first, then one value per chain.
  assert.equal(vht.signalDbm, -78);
  assert.equal(vht.signalAvgDbm, -77);
  assert.equal(vht.txBitrate?.mbps, 234);
  assert.equal(vht.txBitrate?.mcs, 3);
  assert.equal(vht.txBitrate?.widthMhz, 80);
  assert.equal(vht.txBitrate?.nss, 2);
  assert.equal(vht.rxBitrate?.mbps, 175.5);

  const ht = stations[1]!;
  // `tx bitrate: 26.0 MBit/s MCS 3` — no width, no NSS. Absent, not zero: a status view that
  // defaults the width to 0 would report a working client as being on a 0 MHz channel.
  assert.equal(ht.txBitrate?.mbps, 26);
  assert.equal(ht.txBitrate?.mcs, 3);
  assert.equal(ht.txBitrate?.widthMhz, null);
  assert.equal(ht.txBitrate?.nss, null);
  assert.equal(ht.inactiveMs, 39488);
  assert.equal(ht.connectedSeconds, 49);
});

test('iw station dump: this driver does populate the retry counters, and every field is kept', () => {
  const stations = parseIwStationDump(fixture('iw/station-dump-two-clients.txt'));
  for (const station of stations) {
    // Measured rather than assumed: on this radio `tx retries` and `tx failed` are present and
    // zero, so zero here is a real measurement. On a driver that omits them the parser reports
    // null, and only the caller that has seen a non-zero value from that interface can tell the
    // two apart.
    assert.equal(station.txRetries, 0);
    assert.equal(station.txFailed, 0);
    assert.equal(station.fields['tx retries'], '0');

    // Fields nobody has modelled survive verbatim, including the ones whose labels contain a colon
    // or brackets.
    assert.equal(station.fields['airtime weight'], '256');
    assert.ok('associated at [boottime]' in station.fields);
    // `last ack signal:-79 dBm` is printed with no space after the colon.
    assert.match(station.fields['last ack signal'] ?? '', /^-\d+ dBm$/);
  }
});

test('bitrate parsing survives lines with fewer tokens', () => {
  assert.equal(parseBitrate(undefined), null);
  assert.equal(parseBitrate('')!, null);
  const legacy = parseBitrate('6.0 MBit/s')!;
  assert.deepEqual(
    { mbps: legacy.mbps, mcs: legacy.mcs, widthMhz: legacy.widthMhz, nss: legacy.nss },
    { mbps: 6, mcs: null, widthMhz: null, nss: null },
  );
  const he = parseBitrate('1201.0 MBit/s HE-MCS 11 80MHz HE-NSS 2 HE-GI 0 HE-DCM 0')!;
  assert.equal(he.mcs, 11);
  assert.equal(he.nss, 2);
});

test('iw reg get: a per-phy domain overrides the global one', () => {
  const domains = parseIwRegGet(fixture('iw/reg-get-global-and-phy.txt'));
  assert.equal(domains.global?.country, 'US');
  assert.equal(domains.global?.dfsRegion, 'DFS-FCC');
  assert.equal(domains.perPhy['phy1']?.country, '00');
  assert.equal(domains.perPhy['phy1']?.dfsRegion, 'DFS-UNSET');

  // Reading only the first block would apply the US limits to a radio the kernel is
  // treating as world-domain, which offers channels and power it may not use.
  assert.equal(domainForPhy(domains, 'phy1')!.country, '00');
});

test('iw reg get: a phy absent from the output falls back to the global domain', () => {
  // Measured: phy0 exists, is up and is hosting an access point, and does not appear
  // in `iw reg get` at all. Absence means it uses the global domain.
  const domains = parseIwRegGet(fixture('iw/reg-get-global-and-phy.txt'));
  assert.equal(domains.perPhy['phy0'], undefined);
  assert.equal(domainForPhy(domains, 'phy0')!.country, 'US');
});

test('iw reg get: rules carry bandwidth, power, DFS time and flags', () => {
  const domains = parseIwRegGet(fixture('iw/reg-get-global-and-phy.txt'));
  const rules = domains.global!.rules;

  const indoorOnly = rules.find((r) => r.startMhz === 5150)!;
  assert.equal(indoorOnly.endMhz, 5250);
  assert.equal(indoorOnly.maxBandwidthMhz, 80);
  assert.equal(indoorOnly.maxEirpDbm, 23);
  // `N/A` is unknown, not zero: an antenna gain of 0 dBi is a different claim.
  assert.equal(indoorOnly.maxAntennaGainDbi, null);
  assert.equal(indoorOnly.dfsCacMs, null);
  assert.deepEqual(indoorOnly.flags, ['AUTO-BW']);

  const radar = rules.find((r) => r.startMhz === 5250)!;
  assert.equal(radar.dfsCacMs, 0);
  assert.ok(radar.flags.includes('DFS'));

  const lowPower = rules.find((r) => r.startMhz === 5925)!;
  // The difference between 23 and 12 dBm is the difference between good coverage and
  // unusable coverage, so the power figure is shown for the chosen channel.
  assert.equal(lowPower.maxEirpDbm, 12);
  assert.ok(lowPower.flags.includes('NO-OUTDOOR'));
});
