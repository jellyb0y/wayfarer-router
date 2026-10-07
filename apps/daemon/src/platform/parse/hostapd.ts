/**
 * Parsers for the `hostapd_cli` control interface: `status`, `all_sta` and the
 * `STA-FIRST` / `STA-NEXT` iteration, and the unsolicited event lines.
 *
 * hostapd has no D-Bus interface — the D-Bus support in that source tree is built
 * only for wpa_supplicant — so the control socket is the only way in.
 */

export interface HostapdStatus {
  /** `ENABLED`, `DISABLED`, `COUNTRY_UPDATE`, `ACS`, `HT_SCAN`, `DFS`… */
  state: string | null;
  phy: string | null;
  frequencyMhz: number | null;
  channel: number | null;
  secondaryChannel: number | null;
  /** hostapd's own field names for the widths it negotiated. */
  ieee80211n: boolean | null;
  ieee80211ac: boolean | null;
  ieee80211ax: boolean | null;
  vhtOperChwidth: number | null;
  maxTxPowerDbm: number | null;
  /** DFS channel-availability-check state, when the channel requires radar detection. */
  cacTimeSeconds: number | null;
  cacTimeLeftSeconds: number | null;
  /** One entry per BSS the instance serves; index is hostapd's `bss[N]`. */
  bss: HostapdBss[];
  /** Everything as printed, so a field we have not modelled is still reachable. */
  fields: Record<string, string>;
}

export interface HostapdBss {
  index: number;
  interfaceName: string | null;
  bssid: string | null;
  ssid: string | null;
  stationCount: number | null;
}

export function parseHostapdStatus(output: string): HostapdStatus {
  const fields = parseKeyValues(output);

  const bssIndexes = new Set<number>();
  for (const key of Object.keys(fields)) {
    const match = /^(?:bss|bssid|ssid|num_sta)\[(\d+)\]$/.exec(key);
    if (match) bssIndexes.add(Number.parseInt(match[1]!, 10));
  }

  return {
    state: fields['state'] ?? null,
    phy: fields['phy'] ?? null,
    frequencyMhz: intOrNull(fields['freq']),
    channel: intOrNull(fields['channel']),
    secondaryChannel: intOrNull(fields['secondary_channel']),
    ieee80211n: oneZero(fields['ieee80211n']),
    ieee80211ac: oneZero(fields['ieee80211ac']),
    ieee80211ax: oneZero(fields['ieee80211ax']),
    vhtOperChwidth: intOrNull(fields['vht_oper_chwidth']),
    maxTxPowerDbm: intOrNull(fields['max_txpower']),
    cacTimeSeconds: intOrNull(fields['cac_time_seconds']),
    // Printed as `N/A` when no channel-availability check is running, which is not
    // zero: zero would read as "the check has finished".
    cacTimeLeftSeconds: intOrNull(fields['cac_time_left_seconds']),
    bss: [...bssIndexes]
      .sort((a, b) => a - b)
      .map((index) => ({
        index,
        interfaceName: fields[`bss[${index}]`] ?? null,
        bssid: fields[`bssid[${index}]`] ?? null,
        ssid: fields[`ssid[${index}]`] ?? null,
        stationCount: intOrNull(fields[`num_sta[${index}]`]),
      })),
    fields,
  };
}

export interface HostapdStation {
  mac: string;
  /** `[AUTH][ASSOC][AUTHORIZED][WMM][HT]` split into bare names. */
  flags: string[];
  aid: number | null;
  connectedSeconds: number | null;
  inactiveMs: number | null;
  rxPackets: number | null;
  txPackets: number | null;
  rxBytes: number | null;
  txBytes: number | null;
  signalDbm: number | null;
  /**
   * Negotiated rates in Mbit/s, converted here at the parse boundary.
   *
   * hostapd reports `tx_rate_info` / `rx_rate_info` in units of **100 kbps**, which an earlier
   * version of this file recorded in fields named `…Kbps` — a unit error waiting for its first
   * reader. Cross-checked against `iw` on the same two stations at the same instant:
   * `tx_rate_info=2340` ↔ `234.0 MBit/s`, `tx_rate_info=260` ↔ `26.0 MBit/s`,
   * `rx_rate_info=390` ↔ `39.0 MBit/s`.
   *
   * The raw values stay available verbatim under `fields` for anyone who needs them.
   */
  txRateMbps: number | null;
  rxRateMbps: number | null;
  fields: Record<string, string>;
}

/**
 * `all_sta` and a single `sta <mac>` reply have the same shape: a bare MAC line
 * followed by `key=value` lines, repeated per station.
 *
 * The reply to `all_sta` is truncated at roughly 4 KB by the control interface, and
 * the truncation is **silent** — the caller gets a short list that looks complete.
 * `stationListLooksTruncated` below is how the platform layer decides to fall back to
 * `STA-FIRST` / `STA-NEXT` iteration instead.
 */
export function parseHostapdStations(output: string): HostapdStation[] {
  const stations: HostapdStation[] = [];
  let current: { mac: string; fields: Record<string, string> } | null = null;

  const flush = (): void => {
    if (current) stations.push(buildStation(current.mac, current.fields));
    current = null;
  };

  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line === '' || line === 'OK' || line === 'FAIL') continue;
    if (isMac(line)) {
      flush();
      current = { mac: line.toLowerCase(), fields: {} };
      continue;
    }
    const idx = line.indexOf('=');
    if (idx > 0 && current) current.fields[line.slice(0, idx)] = line.slice(idx + 1);
  }
  flush();

  return stations;
}

/**
 * True when the reply hit the control interface's buffer limit, which means stations
 * are missing. Detected by size and by a final line that is not a complete
 * `key=value` pair, because both happen: the cut can land mid-line or exactly on a
 * boundary. The threshold is deliberately below the observed ~4 KB limit so a reply
 * that ends suspiciously close to it is treated as suspect.
 */
export function stationListLooksTruncated(output: string): boolean {
  if (output.length >= 3800) return true;
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  return !(isMac(last.trim()) || last.includes('=') || last.trim() === 'OK');
}

export type HostapdEvent =
  | { kind: 'station-connected'; mac: string; interfaceName: string | null; raw: string }
  | { kind: 'station-disconnected'; mac: string; interfaceName: string | null; raw: string }
  | { kind: 'ap-enabled' | 'ap-disabled' | 'dfs' | 'other'; interfaceName: string | null; raw: string };

/**
 * An unsolicited event line from a subscribed `hostapd_cli`. The interface name is present only
 * when hostapd was started with several BSSs, so it is nullable and the caller supplies the
 * interface it subscribed to.
 *
 * Lines look like `<3>AP-STA-CONNECTED aa:bb:cc:dd:ee:ff` — the `<N>` is a syslog priority and is
 * not always present.
 *
 * **The `> ` is hostapd_cli's interactive prompt, and it shares a line with the first unsolicited
 * event.** It is not defensive noise and removing it costs a real event. Captured verbatim from a
 * subscriber on the bench board while a phone associated:
 *
 * ```
 * > <3>AP-STA-CONNECTED aa:bb:cc:00:0d:02
 * <3>EAPOL-4WAY-HS-COMPLETED aa:bb:cc:00:0d:02
 * <3>AP-STA-DISCONNECTED aa:bb:cc:00:0d:02
 * ```
 *
 * Only the first line carries it, which is why this survived until a real client joined at the
 * right moment: every test that starts mid-stream passes, and the consequence is late rather than
 * lost because the five-second poll finds the client anyway. That is the general shape to watch for
 * in any long-lived reader attached to a program with a prompt — the first line is shaped
 * differently from every line after it, and the first line is the one nobody captures.
 */
export function parseHostapdEvent(line: string): HostapdEvent | null {
  const text = line
    .replace(/^(?:>\s*)+/, '')
    .replace(/^<\d+>/, '')
    .trim();
  if (text === '') return null;

  const sta = /^(AP-STA-CONNECTED|AP-STA-DISCONNECTED)\s+(\S+)(?:\s+(\S+))?/.exec(text);
  if (sta) {
    const mac = isMac(sta[2]!) ? sta[2]!.toLowerCase() : (sta[3] ?? '').toLowerCase();
    const iface = isMac(sta[2]!) ? null : sta[2]!;
    return {
      kind: sta[1] === 'AP-STA-CONNECTED' ? 'station-connected' : 'station-disconnected',
      mac,
      interfaceName: iface,
      raw: text,
    };
  }
  if (text.startsWith('AP-ENABLED')) return { kind: 'ap-enabled', interfaceName: null, raw: text };
  if (text.startsWith('AP-DISABLED')) return { kind: 'ap-disabled', interfaceName: null, raw: text };
  if (text.startsWith('DFS-')) return { kind: 'dfs', interfaceName: null, raw: text };
  return { kind: 'other', interfaceName: null, raw: text };
}

function buildStation(mac: string, fields: Record<string, string>): HostapdStation {
  return {
    mac,
    flags: [...(fields['flags'] ?? '').matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!),
    aid: intOrNull(fields['aid']),
    connectedSeconds: intOrNull(fields['connected_time']),
    inactiveMs: intOrNull(fields['inactive_msec']),
    rxPackets: intOrNull(fields['rx_packets']),
    txPackets: intOrNull(fields['tx_packets']),
    rxBytes: intOrNull(fields['rx_bytes']),
    txBytes: intOrNull(fields['tx_bytes']),
    signalDbm: intOrNull(fields['signal']),
    txRateMbps: hundredKbpsToMbps(intOrNull(fields['tx_rate_info'])),
    rxRateMbps: hundredKbpsToMbps(intOrNull(fields['rx_rate_info'])),
    fields,
  };
}

export function parseKeyValues(output: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    fields[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return fields;
}

function isMac(value: string): boolean {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value);
}

function intOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /-?\d+/.exec(value);
  if (!match) return null;
  const n = Number.parseInt(match[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** hostapd's rate unit is 100 kbps; `iw` prints the same figure as Mbit/s with one decimal. */
function hundredKbpsToMbps(value: number | null): number | null {
  return value === null ? null : value / 10;
}

function oneZero(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  if (value.trim() === '1') return true;
  if (value.trim() === '0') return false;
  return null;
}
