/** Tests for the `ip`, `nft`, hostapd, systemd and journal parsers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseIpLinks, parseIpAddresses, parseIpRoutes, defaultRoute } from '../src/platform/parse/ip-json.ts';
import { parseNftRuleset, foreignTables } from '../src/platform/parse/nft-json.ts';
import {
  parseHostapdStatus,
  parseHostapdStations,
  stationListLooksTruncated,
  parseHostapdEvent,
} from '../src/platform/parse/hostapd.ts';
import {
  parseSystemctlShow,
  parseTimedatectlShow,
  systemdEscape,
  deviceUnitForInterface,
} from '../src/platform/parse/systemctl.ts';
import { parseJournalJsonLines } from '../src/platform/parse/journal.ts';
// Imported here as well as in the iw suite: the cross-check below is only meaningful if both tools'
// output is read by the code that will read it in production.
import { parseIwStationDump } from '../src/platform/parse/iw-dev.ts';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

test('ip -j link: tun devices, a carrier-less Ethernet port and altnames all survive', () => {
  const links = parseIpLinks(fixture('ip/link.json'));
  assert.equal(links.length, 7);

  const ethernet = links.find((l) => l.name === 'end0')!;
  assert.ok(ethernet.flags.includes('NO-CARRIER'));
  // The UP flag and operstate are different questions: this link is administratively
  // up with no cable in it.
  assert.ok(ethernet.flags.includes('UP'));
  assert.equal(ethernet.operstate, 'DOWN');

  const tun = links.find((l) => l.name.startsWith('tun'))!;
  assert.equal(tun.linkType, 'none');
  assert.equal(tun.mac, null);

  const loopback = links.find((l) => l.name === 'lo')!;
  assert.equal(loopback.mtu, 65536);
});

test('ip -j addr: addresses are flattened per interface with family and prefix', () => {
  const addresses = parseIpAddresses(fixture('ip/addr.json'));
  const apAddress = addresses.find((a) => a.address === '10.44.0.1')!;
  assert.equal(apAddress.family, 'inet');
  assert.equal(apAddress.prefixLength, 24);
  assert.equal(apAddress.scope, 'global');

  // Both families are present and neither is filtered out here: IPv6 policy is a
  // planner decision, not a parser one.
  assert.ok(addresses.some((a) => a.family === 'inet6'));
});

test('ip -j route: the default route is found by metric', () => {
  const routes = parseIpRoutes(fixture('ip/route.json'));
  const def = defaultRoute(routes)!;
  assert.equal(def.destination, 'default');
  assert.equal(def.device, 'wlan0');
  assert.equal(def.protocol, 'dhcp');
  assert.equal(def.metric, 600);
});

test('ip parsers return empty on malformed input instead of throwing', () => {
  // A status view must degrade, not fall over, when a command's output is not what
  // this version of iproute2 was expected to print.
  assert.deepEqual(parseIpLinks('not json'), []);
  assert.deepEqual(parseIpAddresses('{}'), []);
  assert.deepEqual(parseIpRoutes('[1, 2, 3]'), []);
  assert.equal(defaultRoute([]), null);
});

test('nft -j: every table in the live ruleset is seen, including the ones we do not own', () => {
  const ruleset = parseNftRuleset(fixture('nft/list-ruleset.json'));
  const names = ruleset.tables.map((t) => t.name).sort();
  assert.deepEqual(names, ['filter', 'foreign-a', 'nat', 'sing-box']);
  assert.ok(ruleset.ruleCount > 0);
  assert.equal(ruleset.nftablesVersion, '1.1.3');

  // The check that keeps `flush ruleset` out of this project: anything not in the set
  // we generated belongs to someone else and must survive an apply.
  const foreign = foreignTables(ruleset, ['inet:filter', 'inet:nat']);
  assert.deepEqual(foreign.map((t) => t.name).sort(), ['foreign-a', 'sing-box']);
});

test('nft -j: chains carry their hook and policy', () => {
  const ruleset = parseNftRuleset(fixture('nft/list-ruleset.json'));
  const input = ruleset.chains.find((c) => c.table === 'filter' && c.name === 'input')!;
  assert.equal(input.hook, 'input');
  assert.equal(input.policy, 'accept');
  assert.equal(input.type, 'filter');
});

test('hostapd status: the live access point reports channel, width and per-BSS fields', () => {
  const status = parseHostapdStatus(fixture('hostapd/status-ap-5ghz.txt'));
  assert.equal(status.state, 'ENABLED');
  assert.equal(status.phy, 'phy0');
  assert.equal(status.channel, 149);
  assert.equal(status.frequencyMhz, 5745);
  assert.equal(status.ieee80211ac, true);
  assert.equal(status.ieee80211ax, false);
  assert.equal(status.vhtOperChwidth, 1);
  assert.equal(status.maxTxPowerDbm, 13);
  // `cac_time_left_seconds=N/A` must not become 0, which would read as "the radar
  // check has finished".
  assert.equal(status.cacTimeLeftSeconds, null);
  assert.equal(status.bss.length, 1);
  assert.equal(status.bss[0]!.stationCount, 0);
  assert.equal(status.bss[0]!.interfaceName, 'wlanap');
});

test('hostapd all_sta: two real clients, with the rate fields the tool actually prints', () => {
  // Captured from the bench access point with two devices associated (2026-09-19).
  const output = fixture('hostapd/all-sta-two-clients.txt');
  assert.equal(stationListLooksTruncated(output), false, `${output.length} bytes should be well under the limit`);

  const stations = parseHostapdStations(output);
  assert.equal(stations.length, 2);

  const ht = stations.find((station) => station.flags.includes('SHORT_PREAMBLE'))!;
  assert.deepEqual(ht.flags, ['AUTH', 'ASSOC', 'AUTHORIZED', 'SHORT_PREAMBLE', 'WMM', 'HT']);
  assert.equal(ht.aid, 2);
  assert.equal(ht.signalDbm, -85);

  const vht = stations.find((station) => station.flags.includes('VHT'))!;
  assert.equal(vht.aid, 1);
  assert.ok((vht.txBytes ?? 0) > 1_000_000);
  // Every field hostapd printed is kept, including the ones nobody has modelled: the RSN counters,
  // the capability words and the supported operating classes.
  assert.ok('dot11RSNAStatsSelectedPairwiseCipher' in vht.fields);
  assert.equal(vht.fields['wpa'], '2');
  assert.ok('supp_op_classes' in vht.fields);
});

test('hostapd sta <mac>: the per-station read parses the same shape as all_sta', () => {
  const vht = parseHostapdStations(fixture('hostapd/sta-one-client-vht.txt'));
  const ht = parseHostapdStations(fixture('hostapd/sta-one-client-ht.txt'));
  assert.equal(vht.length, 1);
  assert.equal(ht.length, 1);
  // This is the reply the truncation fallback assembles one station at a time, so it has to parse
  // identically to a slice of all_sta.
  assert.ok(vht[0]!.flags.includes('VHT'));
  assert.ok(ht[0]!.flags.includes('HT'));
  assert.notEqual(vht[0]!.mac, ht[0]!.mac);
});

test('hostapd status: a live access point with clients reports the count per BSS', () => {
  const status = parseHostapdStatus(fixture('hostapd/status-ap-5ghz-with-clients.txt'));
  assert.equal(status.state, 'ENABLED');
  assert.equal(status.channel, 149);
  assert.equal(status.bss[0]!.stationCount, 2);
  assert.equal(status.bss[0]!.interfaceName, 'wlanap');
});

test('hostapd all_sta: an empty reply is empty, not truncated', () => {
  const output = fixture('hostapd/all-sta-empty.txt');
  assert.deepEqual(parseHostapdStations(output), []);
  assert.equal(stationListLooksTruncated(output), false);
});

test('hostapd all_sta: a truncated reply is detected so iteration can take over', () => {
  // SYNTHETIC fixture — see test/fixtures/README.md. The control interface truncates
  // near 4 KB silently, so the caller must detect it rather than trust the list.
  const output = fixture('hostapd/all-sta-truncated.txt');
  assert.equal(stationListLooksTruncated(output), true);
  const stations = parseHostapdStations(output);
  assert.ok(stations.length > 1);
  assert.match(stations[0]!.mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  assert.ok(stations[0]!.flags.includes('AUTHORIZED'));
  assert.equal(stations[0]!.connectedSeconds, 3421);
});

test('hostapd events: the real lines a subscribed hostapd_cli printed on the bench board', () => {
  // Captured from the long-lived subscriber over a real association and disassociation
  // (2026-09-19). Everything the tool writes to stdout is here, banner and prompt included, because
  // that is what the reader receives.
  const lines = fixture('hostapd/subscriber-events.txt').split('\n');
  const parsed = lines.map((line) => parseHostapdEvent(line)).filter((event) => event !== null);

  const disconnected = parsed.find((event) => event.kind === 'station-disconnected');
  assert.ok(disconnected, 'the disconnect line should be recognised');
  assert.equal(disconnected.kind === 'station-disconnected' ? disconnected.mac : '', 'aa:bb:cc:00:0d:02');

  // The banner and the four-way-handshake line are kept as unmodelled events rather than dropped.
  assert.ok(parsed.some((event) => event.kind === 'other' && event.raw.includes('EAPOL-4WAY-HS-COMPLETED')));
});

test('hostapd events: connect and disconnect lines, with and without a priority prefix', () => {
  const connected = parseHostapdEvent('<3>AP-STA-CONNECTED aa:bb:cc:dd:ee:ff')!;
  assert.equal(connected.kind, 'station-connected');
  assert.equal(connected.kind === 'station-connected' ? connected.mac : '', 'aa:bb:cc:dd:ee:ff');

  const disconnected = parseHostapdEvent('AP-STA-DISCONNECTED AA:BB:CC:DD:EE:FF')!;
  assert.equal(disconnected.kind, 'station-disconnected');
  assert.equal(disconnected.kind === 'station-disconnected' ? disconnected.mac : '', 'aa:bb:cc:dd:ee:ff');

  // Multi-BSS hostapd prefixes the interface name before the address.
  const withInterface = parseHostapdEvent('<3>AP-STA-CONNECTED bench-ap0 aa:bb:cc:dd:ee:01')!;
  assert.equal(withInterface.interfaceName, 'bench-ap0');
  assert.equal(withInterface.kind === 'station-connected' ? withInterface.mac : '', 'aa:bb:cc:dd:ee:01');

  assert.equal(parseHostapdEvent('AP-ENABLED')?.kind, 'ap-enabled');
  assert.equal(parseHostapdEvent('DFS-CAC-START freq=5260')?.kind, 'dfs');
  assert.equal(parseHostapdEvent('   '), null);
});

test('systemctl show: values containing = are not truncated, and both states are read', () => {
  const unit = parseSystemctlShow(fixture('systemd/show-hostapd-instance.txt'));
  assert.equal(unit.isActive, true);
  assert.equal(unit.activeState, 'active');
  assert.equal(unit.subState, 'running');
  assert.equal(unit.isEnabled, true);
  // ExecStart carries `=` inside its value; splitting on every `=` truncates it.
  assert.ok((unit.properties['ExecStart'] ?? '').includes('path='));
});

test('systemctl show: activating is not active and static is not enabled', () => {
  const activating = parseSystemctlShow('ActiveState=activating\nUnitFileState=static\n');
  assert.equal(activating.isActive, false);
  assert.equal(activating.isEnabled, false);
  assert.equal(parseSystemctlShow('UnitFileState=enabled-runtime\n').isEnabled, true);
});

test('timedatectl show: synchronisation state is read separately from the enabled flag', () => {
  const clock = parseTimedatectlShow(fixture('systemd/timedatectl-show.txt'));
  assert.equal(clock.ntpEnabled, true);
  assert.equal(clock.synchronized, true);
  assert.equal(clock.localRtc, false);
  assert.equal(clock.timezone, 'Europe/Moscow');
  // A board with no clock battery can have NTP enabled and still be days behind, so
  // the two flags are never collapsed into one.
  const unsynced = parseTimedatectlShow('NTP=yes\nNTPSynchronized=no\n');
  assert.equal(unsynced.ntpEnabled, true);
  assert.equal(unsynced.synchronized, false);
});

test('systemd escaping: a hyphen becomes \\x2d, which is why generated names carry none', () => {
  assert.equal(systemdEscape('wlanap'), 'wlanap');
  assert.equal(systemdEscape('wlan-ap'), 'wlan\\x2dap');
  assert.equal(deviceUnitForInterface('wlanap'), 'sys-subsystem-net-devices-wlanap.device');
  // The trap: a `BindsTo=` on the unescaped name refers to a unit that does not exist,
  // and the service is then stopped immediately with no useful error.
  assert.equal(
    deviceUnitForInterface('wlan-ap'),
    'sys-subsystem-net-devices-wlan\\x2dap.device',
  );
  assert.equal(systemdEscape('a/b'), 'a-b');
  assert.equal(systemdEscape('.hidden'), '\\x2ehidden');
});

test('journal: microsecond timestamps stay strings and the boot id is available', () => {
  const page = parseJournalJsonLines(fixture('journal/journalctl-json-3-lines.json'));
  assert.equal(page.entries.length, 3);
  assert.equal(page.skipped, 0);
  const first = page.entries[0]!;
  assert.equal(typeof first.realtimeUsec, 'string');
  assert.equal(first.atMs, Math.floor(Number(first.realtimeUsec) / 1000));
  assert.equal(first.priority, 6);
  assert.equal(first.unit, 'ssh.service');
  assert.ok(page.bootIds.length >= 1);
  assert.equal(page.nextCursor, page.entries[page.entries.length - 1]!.cursor);
});

test('journal: a MESSAGE that arrived as bytes is decoded and flagged', () => {
  const line = JSON.stringify({
    __CURSOR: 'c',
    __REALTIME_TIMESTAMP: '1789835476681396',
    _BOOT_ID: 'b',
    PRIORITY: '3',
    MESSAGE: [104, 105],
  });
  const page = parseJournalJsonLines(`${line}\n`);
  assert.equal(page.entries[0]!.message, 'hi');
  assert.equal(page.entries[0]!.messageWasBinary, true);
});

test('journal: a garbled line is counted, not thrown', () => {
  const page = parseJournalJsonLines('{"MESSAGE":"ok"}\nnot json\n');
  assert.equal(page.entries.length, 1);
  assert.equal(page.skipped, 1);
});

test('hostapd all_sta: a cut inside a value is still detected, because the record parses cleanly', async () => {
  // SYNTHETIC fixture — see test/fixtures/README.md. This is the shape that makes
  // truncation dangerous: the reply ends inside `signal=-54`, leaving `signal=-5`, which
  // parses as a perfectly plausible −5 dBm. Nothing in the text says it is incomplete, so
  // detection has to come from the reply as a whole.
  const output = fixture('hostapd/all-sta-truncated-midfield.txt');
  assert.equal(stationListLooksTruncated(output), true);

  const parsed = parseHostapdStations(output);
  const last = parsed[parsed.length - 1]!;
  assert.equal(last.signalDbm, -5);
  // Which is why the controller discards the parsed list and iterates instead of trying to
  // repair it: a repaired record is a guess presented as a measurement.
});

test('hostapd stations: a truncated reply is rebuilt with list_sta and sta <mac>', async () => {
  const { createApController } = await import('../src/platform/ap.ts');

  const truncated = fixture('hostapd/all-sta-truncated.txt');
  const record = (mac: string, signal: number): string =>
    [`${mac}`, 'flags=[AUTH][ASSOC][AUTHORIZED]', 'aid=1', `signal=${signal}`, 'connected_time=10'].join('\n');

  const calls: string[][] = [];
  const controller = createApController({
    call: async (_interfaceName, command) => {
      calls.push(command);
      if (command[0] === 'all_sta') return { code: 0, stdout: truncated };
      if (command[0] === 'list_sta') return { code: 0, stdout: 'aa:bb:cc:00:01:01\naa:bb:cc:00:01:02\n' };
      if (command[0] === 'sta' && command[1] === 'aa:bb:cc:00:01:01') {
        return { code: 0, stdout: record('aa:bb:cc:00:01:01', -40) };
      }
      if (command[0] === 'sta' && command[1] === 'aa:bb:cc:00:01:02') {
        return { code: 0, stdout: record('aa:bb:cc:00:01:02', -60) };
      }
      // `sta_first` and `sta_next` are control-interface commands, not hostapd_cli commands:
      // measured on hostapd_cli 2.10, the tool answers "Unknown command 'sta_first'" locally. A
      // fallback built on them fails exactly when it is needed.
      return { code: 255, stdout: `Unknown command '${command[0]}'` };
    },
  });

  const result = await controller.stations('bench-ap0');
  assert.equal(result.iterated, true);
  assert.deepEqual(
    result.stations.map((s) => s.mac),
    ['aa:bb:cc:00:01:01', 'aa:bb:cc:00:01:02'],
  );
  assert.deepEqual(calls[0], ['all_sta']);
  assert.deepEqual(calls[1], ['list_sta']);
  assert.deepEqual(calls[2], ['sta', 'aa:bb:cc:00:01:01']);
  assert.deepEqual(calls[3], ['sta', 'aa:bb:cc:00:01:02']);
});

test('hostapd stations: a station that leaves mid-iteration costs one row, not the sample', async () => {
  const { createApController } = await import('../src/platform/ap.ts');
  const controller = createApController({
    call: async (_interfaceName, command) => {
      if (command[0] === 'all_sta') return { code: 0, stdout: fixture('hostapd/all-sta-truncated.txt') };
      if (command[0] === 'list_sta') return { code: 0, stdout: 'aa:bb:cc:00:02:01\naa:bb:cc:00:02:02\n' };
      if (command[0] === 'sta' && command[1] === 'aa:bb:cc:00:02:01') {
        return { code: 0, stdout: 'aa:bb:cc:00:02:01\nflags=[AUTH]\nsignal=-44\n' };
      }
      // Gone between the listing and the read.
      return { code: 0, stdout: 'FAIL' };
    },
  });
  const result = await controller.stations('bench-ap0');
  assert.deepEqual(
    result.stations.map((s) => s.mac),
    ['aa:bb:cc:00:02:01'],
  );
});

test('hostapd stations: an untruncated reply is used as is, with no iteration', async () => {
  const { createApController } = await import('../src/platform/ap.ts');
  const controller = createApController({
    call: async (_interfaceName, command) =>
      command[0] === 'all_sta'
        ? { code: 0, stdout: 'aa:bb:cc:00:02:01\nflags=[AUTH]\nsignal=-50\n' }
        : { code: 1, stdout: 'iteration must not happen here' },
  });
  const result = await controller.stations('bench-ap0');
  assert.equal(result.iterated, false);
  assert.equal(result.stations.length, 1);
});

test('hostapd: an empty interface name is refused instead of hanging forever', async () => {
  const { createApController, EmptyInterfaceError } = await import('../src/platform/ap.ts');
  const controller = createApController();
  // The real failure this prevents: hostapd_cli with an empty -i argument never returns.
  await assert.rejects(() => controller.status('  '), EmptyInterfaceError);
  assert.throws(() => controller.watch('', () => undefined), EmptyInterfaceError);
});

// ---------------------------------------------------------------------------------------------
// Two disagreements between the real capture and the parsers, found on 2026-09-19 and fixed.
// Both are kept as regression tests against the real output that exposed them.
// ---------------------------------------------------------------------------------------------

test('hostapd events: the prompt shares a line with the first event, and the event still parses', () => {
  // `> <3>AP-STA-CONNECTED …` — hostapd_cli prints its interactive prompt and the first unsolicited
  // event lands on the same line. Only the first one carries it, so every test that starts
  // mid-stream passed while the first client to join after a restart produced no event at all.
  const line = fixture('hostapd/subscriber-events.txt')
    .split('\n')
    .find((candidate) => candidate.includes('AP-STA-CONNECTED'))!;
  assert.match(line, /^> /, 'the fixture should still contain the prompt this test exists for');

  const event = parseHostapdEvent(line);
  assert.equal(event?.kind, 'station-connected');
  assert.equal(event?.kind === 'station-connected' ? event.mac : '', 'aa:bb:cc:00:0d:02');

  // A prompt with no event behind it is still nothing.
  assert.equal(parseHostapdEvent('> '), null);
  // And a doubled prompt, which appears when two events arrive before the reader drains the pipe.
  const doubled = parseHostapdEvent('> > <3>AP-STA-DISCONNECTED aa:bb:cc:00:0d:02');
  assert.equal(doubled?.kind, 'station-disconnected');
});

test('hostapd stations: rates are Mbit/s, cross-checked against iw at the same instant', () => {
  // hostapd reports hundreds of kbps; `iw` prints Mbit/s with one decimal. The two tools describing
  // the same two stations at the same moment is a stronger fixture than either alone, and it is the
  // evidence that the fields named `…Kbps` were wrong by a factor of ten.
  const hostapdStations = parseHostapdStations(fixture('hostapd/all-sta-two-clients.txt'));
  const ht = hostapdStations.find((station) => station.flags.includes('SHORT_PREAMBLE'))!;
  const vht = hostapdStations.find((station) => station.flags.includes('VHT'))!;

  assert.equal(ht.txRateMbps, 26);
  assert.equal(ht.rxRateMbps, 39);
  assert.equal(vht.txRateMbps, 234);

  // The same figures, from the other tool, in the dump captured beside it.
  const iwStations = parseIwStationDump(fixture('iw/station-dump-two-clients.txt'));
  const iwHt = iwStations.find((station) => station.txBitrate?.widthMhz === null)!;
  const iwVht = iwStations.find((station) => station.txBitrate?.widthMhz === 80)!;
  assert.equal(iwHt.txBitrate?.mbps, ht.txRateMbps);
  assert.equal(iwHt.rxBitrate?.mbps, ht.rxRateMbps);
  assert.equal(iwVht.txBitrate?.mbps, vht.txRateMbps);

  // The raw value stays reachable for anyone who needs the unit as hostapd printed it.
  assert.equal(ht.fields['tx_rate_info'], '260 mcs 3');
});
