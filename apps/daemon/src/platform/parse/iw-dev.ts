/**
 * Parsers for `iw dev`, `iw dev <if> info`, `iw dev <if> link` and
 * `iw dev <if> station dump`.
 *
 * Everything here is best-effort by design: these reports are where drivers differ
 * most, and a missing field must degrade to `null` rather than break the caller.
 * Measured on the bench board, both of these are real and both would break a
 * stricter parser:
 *
 * * `iw dev` lists an entry with no interface name at all —
 *   `Unnamed/non-netdev interface` with `type P2P-device` — so a parser that assumes
 *   every entry under a phy has a name produces an interface called `undefined`.
 * * `iw dev wlan0 station dump` returns **empty output** on the built-in radio while
 *   the interface is associated and passing traffic. Empty is not an error and not
 *   "no peers"; it is a driver that does not populate that report.
 */

import { parseIndentTree, parseIntOrNull, type IndentNode } from './indent-tree.ts';

export interface IwInterface {
  /** Null for the unnamed non-netdev entries some drivers expose (P2P devices). */
  name: string | null;
  phy: string;
  ifindex: number | null;
  wdev: string | null;
  mac: string | null;
  ssid: string | null;
  /** `managed`, `AP`, `P2P-device`, `monitor`… whatever the driver printed. */
  type: string | null;
  channel: IwChannel | null;
  txPowerDbm: number | null;
}

export interface IwChannel {
  channel: number | null;
  frequencyMhz: number | null;
  widthMhz: number | null;
  center1Mhz: number | null;
  center2Mhz: number | null;
}

export function parseIwDev(output: string): IwInterface[] {
  const interfaces: IwInterface[] = [];

  for (const phyNode of parseIndentTree(output)) {
    const phyMatch = /^phy#(\S+)$/.exec(phyNode.text);
    if (!phyMatch) continue;
    const phy = `phy${phyMatch[1]}`;

    for (const child of phyNode.children) {
      const named = /^Interface\s+(\S+)$/.exec(child.text);
      const unnamed = /^Unnamed\/non-netdev interface$/.test(child.text);
      if (!named && !unnamed) continue;
      interfaces.push(parseInterfaceNode(named ? named[1]! : null, phy, child));
    }
  }

  return interfaces;
}

/**
 * `iw dev <if> info` prints the same block as `iw dev`, minus the phy header and
 * with a `wiphy <n>` line instead. Parsed by the same code so the two cannot drift.
 */
export function parseIwDevInfo(output: string): IwInterface | null {
  const roots = parseIndentTree(output);
  const root = roots.find((r) => /^Interface\s+\S+$/.test(r.text));
  if (!root) return null;
  const name = /^Interface\s+(\S+)$/.exec(root.text)![1]!;
  const wiphy = parseIntOrNull(root.children.find((c) => c.text.startsWith('wiphy '))?.text);
  const parsed = parseInterfaceNode(name, wiphy === null ? '' : `phy${wiphy}`, root);
  return parsed;
}

function parseInterfaceNode(name: string | null, phy: string, node: IndentNode): IwInterface {
  const line = (prefix: string): string | undefined => {
    const hit = node.children.find((c) => c.text.startsWith(`${prefix} `));
    return hit ? hit.text.slice(prefix.length + 1).trim() : undefined;
  };

  const channelLine = node.children.find((c) => c.text.startsWith('channel '));
  const txpower = line('txpower');

  return {
    name,
    phy,
    ifindex: parseIntOrNull(line('ifindex')),
    wdev: line('wdev') ?? null,
    mac: line('addr') ?? null,
    ssid: line('ssid') ?? null,
    type: line('type') ?? null,
    channel: channelLine ? parseChannelLine(channelLine.text) : null,
    txPowerDbm: txpower === undefined ? null : Number.parseFloat(txpower),
  };
}

/** `channel 149 (5745 MHz), width: 80 MHz, center1: 5775 MHz` */
export function parseChannelLine(text: string): IwChannel {
  return {
    channel: parseIntOrNull(/channel\s+(\d+)/.exec(text)?.[1]),
    frequencyMhz: parseIntOrNull(/\((\d+)\s*MHz\)/.exec(text)?.[1]),
    widthMhz: parseIntOrNull(/width:\s*(\d+)\s*MHz/.exec(text)?.[1]),
    center1Mhz: parseIntOrNull(/center1:\s*(\d+)\s*MHz/.exec(text)?.[1]),
    center2Mhz: parseIntOrNull(/center2:\s*(\d+)\s*MHz/.exec(text)?.[1]),
  };
}

export interface IwBitrate {
  /** Mbit/s as printed. */
  mbps: number | null;
  /** `VHT-MCS 9`, `HE-MCS 7`, `MCS 10` — the modulation index. */
  mcs: number | null;
  /** `80MHz`, `40MHz`… the width the rate was negotiated at. */
  widthMhz: number | null;
  /** `VHT-NSS 1` — spatial streams. */
  nss: number | null;
  /** The whole line, because drivers add tokens nobody has seen yet. */
  text: string;
}

export interface IwLink {
  connected: boolean;
  bssid: string | null;
  ssid: string | null;
  frequencyMhz: number | null;
  signalDbm: number | null;
  rxBytes: number | null;
  rxPackets: number | null;
  txBytes: number | null;
  txPackets: number | null;
  txBitrate: IwBitrate | null;
  rxBitrate: IwBitrate | null;
}

/**
 * `iw dev <if> link`. When the interface is not associated the output is the single
 * line `Not connected.`, which is a normal state and not a failure.
 */
export function parseIwLink(output: string): IwLink {
  const empty: IwLink = {
    connected: false,
    bssid: null,
    ssid: null,
    frequencyMhz: null,
    signalDbm: null,
    rxBytes: null,
    rxPackets: null,
    txBytes: null,
    txPackets: null,
    txBitrate: null,
    rxBitrate: null,
  };
  if (/^\s*Not connected\.?\s*$/m.test(output) || output.trim() === '') return empty;

  const roots = parseIndentTree(output);
  const root = roots.find((r) => r.text.startsWith('Connected to '));
  if (!root) return empty;

  const field = (prefix: string): string | undefined => {
    const hit = root.children.find((c) => c.text.startsWith(`${prefix}:`));
    return hit ? hit.text.slice(prefix.length + 1).trim() : undefined;
  };

  const rx = field('RX');
  const tx = field('TX');

  return {
    connected: true,
    bssid: /^Connected to\s+(\S+)/.exec(root.text)?.[1] ?? null,
    ssid: field('SSID') ?? null,
    // Printed as `freq: 5220.0` on this build — a float, so parseInt would silently
    // work here and break on a kHz-precision build.
    frequencyMhz: numberOrNull(field('freq')),
    signalDbm: numberOrNull(field('signal')),
    rxBytes: parseIntOrNull(rx),
    rxPackets: parseIntOrNull(/\((\d+)\s+packets\)/.exec(rx ?? '')?.[1]),
    txBytes: parseIntOrNull(tx),
    txPackets: parseIntOrNull(/\((\d+)\s+packets\)/.exec(tx ?? '')?.[1]),
    txBitrate: parseBitrate(field('tx bitrate')),
    rxBitrate: parseBitrate(field('rx bitrate')),
  };
}

export interface IwStation {
  mac: string;
  /** Interface the station is seen on, taken from the header line. */
  onInterface: string | null;
  inactiveMs: number | null;
  rxBytes: number | null;
  rxPackets: number | null;
  txBytes: number | null;
  txPackets: number | null;
  txRetries: number | null;
  txFailed: number | null;
  signalDbm: number | null;
  signalAvgDbm: number | null;
  txBitrate: IwBitrate | null;
  rxBitrate: IwBitrate | null;
  connectedSeconds: number | null;
  authorized: boolean | null;
  authenticated: boolean | null;
  /** Everything the driver printed, unparsed, keyed by label. */
  fields: Record<string, string>;
}

/**
 * `iw dev <if> station dump`.
 *
 * `txRetries` is deliberately reported as the driver's own number with no
 * interpretation. Measured on hardware: one driver reported zero transmit retries
 * across 18 000 packets at −89 dBm, which is not physically possible — the counter is
 * simply not populated. Deciding that zero means "unknown" is the caller's job and
 * requires having seen a non-zero value from that interface at least once; a parser
 * cannot know that.
 */
export function parseIwStationDump(output: string): IwStation[] {
  if (output.trim() === '') return [];

  const stations: IwStation[] = [];
  for (const root of parseIndentTree(output)) {
    const header = /^Station\s+(\S+)\s+\(on\s+(\S+)\)/.exec(root.text);
    if (!header) continue;

    const fields: Record<string, string> = {};
    for (const child of root.children) {
      const idx = child.text.indexOf(':');
      if (idx <= 0) continue;
      fields[child.text.slice(0, idx).trim()] = child.text.slice(idx + 1).trim();
    }

    stations.push({
      mac: header[1]!,
      onInterface: header[2] ?? null,
      inactiveMs: parseIntOrNull(fields['inactive time']),
      rxBytes: parseIntOrNull(fields['rx bytes']),
      rxPackets: parseIntOrNull(fields['rx packets']),
      txBytes: parseIntOrNull(fields['tx bytes']),
      txPackets: parseIntOrNull(fields['tx packets']),
      txRetries: parseIntOrNull(fields['tx retries']),
      txFailed: parseIntOrNull(fields['tx failed']),
      signalDbm: numberOrNull(fields['signal']),
      signalAvgDbm: numberOrNull(fields['signal avg']),
      txBitrate: parseBitrate(fields['tx bitrate']),
      rxBitrate: parseBitrate(fields['rx bitrate']),
      connectedSeconds: parseIntOrNull(fields['connected time']),
      authorized: yesNo(fields['authorized']),
      authenticated: yesNo(fields['authenticated']),
      fields,
    });
  }

  return stations;
}

function yesNo(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  if (/^yes$/i.test(value.trim())) return true;
  if (/^no$/i.test(value.trim())) return false;
  return null;
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /-?\d+(\.\d+)?/.exec(value);
  if (!match) return null;
  const n = Number.parseFloat(match[0]);
  return Number.isFinite(n) ? n : null;
}

/** `390.0 MBit/s VHT-MCS 9 80MHz VHT-NSS 1` */
export function parseBitrate(text: string | undefined): IwBitrate | null {
  if (text === undefined || text.trim() === '') return null;
  return {
    mbps: numberOrNull(/^([\d.]+)\s*MBit\/s/.exec(text)?.[1]),
    mcs: parseIntOrNull(/(?:VHT-|HE-|EHT-)?MCS\s+(\d+)/.exec(text)?.[1]),
    widthMhz: parseIntOrNull(/(\d+)MHz/.exec(text)?.[1]),
    nss: parseIntOrNull(/(?:VHT-|HE-|EHT-)?NSS\s+(\d+)/.exec(text)?.[1]),
    text: text.trim(),
  };
}
