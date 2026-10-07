/**
 * Parser for `iw phy` (identical output to `iw list` — verified byte for byte on the
 * bench board, 26568 bytes from both).
 *
 * This is the input every radio decision is made from: which bands and channels a
 * driver offers, at what power, with which capabilities, and — the part that decides
 * whether a configuration is possible at all — the valid interface combinations.
 *
 * Two rules the shape below exists to enforce:
 *
 * 1. **Nothing is inferred that the driver did not print.** A missing line means
 *    unknown, represented as `null` or an empty array, never as a default. A driver
 *    that does not report antennas is not a driver with one antenna.
 * 2. **Interface combinations keep their structure and their original text.** The
 *    constraint is `#{ managed, AP } <= 1` together with `total` and `#channels`
 *    limits; flattening it to a boolean throws away both the reason and the message
 *    the operator needs to see.
 */

import {
  bulletValues,
  childStartingWith,
  keyValue,
  parseIndentTree,
  parseIntOrNull,
  type IndentNode,
} from './indent-tree.ts';

export interface IwCapabilityBits {
  /** The hex value exactly as printed, kept so it can be shown and compared. */
  hex: string;
  /** The flag lines the driver printed underneath it, verbatim. */
  flags: string[];
}

export interface IwFrequency {
  mhz: number;
  /** Channel number from `[36]`. Absent on some frequencies, hence nullable. */
  channel: number | null;
  /** Regulatory maximum for this frequency, dBm. Absent when disabled. */
  maxTxPowerDbm: number | null;
  disabled: boolean;
  /**
   * Parenthesised flags other than the power figure, lower-cased and verbatim:
   * `radar detection`, `no IR`, `passive scan`, `no HT40+`… Kept as strings because
   * the set differs per driver and kernel, and an unknown flag must survive rather
   * than be dropped.
   */
  flags: string[];
}

export interface IwHeIftype {
  /** `HE Iftypes: managed` — which interface type these capabilities apply to. */
  iftype: string;
  macCapabilitiesHex: string | null;
  phyCapabilitiesHex: string | null;
}

export interface IwBand {
  /** `Band 1:` → 1. Bands are not contiguous: the bench dongle reports 1, 2 and 4. */
  index: number;
  htCapabilities: IwCapabilityBits | null;
  vhtCapabilities: IwCapabilityBits | null;
  heIftypes: IwHeIftype[];
  frequencies: IwFrequency[];
  /** Legacy bitrates in Mbps, as printed under `Bitrates`. */
  bitratesMbps: number[];
}

export interface IwCombinationGroup {
  /** `#{ managed, AP } <= 1` → modes `['managed', 'AP']`, max 1. */
  modes: string[];
  max: number;
}

export interface IwInterfaceCombination {
  /** The driver's own wording, for the error message the operator reads. */
  text: string;
  groups: IwCombinationGroup[];
  /** `total <= 3`, or null when the driver did not print a total. */
  total: number | null;
  /** `#channels <= 1` — the limit that forces an AP to follow an uplink's channel. */
  channels: number | null;
  /** `radar detect widths { 20 MHz (no HT), … }`, verbatim. */
  radarDetectWidths: string[];
}

export interface IwPhy {
  /** `phy0`. Never assumed to exist and never assumed to be numbered from zero. */
  name: string;
  index: number | null;
  antennas: { txMask: number | null; rxMask: number | null } | null;
  /** Modes the driver supports at all. */
  interfaceModes: string[];
  /** Modes that can always be added on top of a combination. Often empty. */
  softwareInterfaceModes: string[];
  interfaceCombinations: IwInterfaceCombination[];
  bands: IwBand[];
  maxScanSsids: number | null;
  maxAssociatedStations: number | null;
  supportedCiphers: string[];
  supportedCommands: string[];
  extendedFeatures: string[];
}

const HEX_IN_PARENS = /\((0x[0-9a-f]+)\)/i;

export function parseIwPhy(output: string): IwPhy[] {
  const roots = parseIndentTree(output);
  const phys: IwPhy[] = [];

  for (const root of roots) {
    const match = /^Wiphy\s+(\S+)$/.exec(root.text);
    if (!match) continue;
    phys.push(parseOnePhy(match[1]!, root));
  }

  return phys;
}

function parseOnePhy(name: string, node: IndentNode): IwPhy {
  return {
    name,
    index: parseIntOrNull(keyValue(node, 'wiphy index')),
    antennas: parseAntennas(keyValue(node, 'Available Antennas')),
    interfaceModes: bulletValues(childStartingWith(node, 'Supported interface modes')),
    softwareInterfaceModes: bulletValues(childStartingWith(node, 'software interface modes')),
    interfaceCombinations: parseCombinations(childStartingWith(node, 'valid interface combinations')),
    bands: node.children.flatMap((child) => {
      const band = /^Band\s+(\d+):$/.exec(child.text);
      return band ? [parseBand(Number.parseInt(band[1]!, 10), child)] : [];
    }),
    maxScanSsids: parseIntOrNull(keyValue(node, 'max # scan SSIDs')),
    maxAssociatedStations: parseIntOrNull(keyValue(node, 'Maximum associated stations in AP mode')),
    supportedCiphers: bulletValues(childStartingWith(node, 'Supported Ciphers')),
    supportedCommands: bulletValues(childStartingWith(node, 'Supported commands')),
    // The same bullet reader as everywhere else: `Supported extended features` prints its bullets
    // without the leading space that the interface-mode list uses, and one reader that trims first
    // handles both without a second, looser rule drifting away from it.
    extendedFeatures: bulletValues(childStartingWith(node, 'Supported extended features')),
  };
}

function parseAntennas(value: string | undefined): IwPhy['antennas'] {
  if (value === undefined) return null;
  const tx = /TX\s+(0x[0-9a-f]+|\d+)/i.exec(value);
  const rx = /RX\s+(0x[0-9a-f]+|\d+)/i.exec(value);
  return {
    txMask: tx ? Number(tx[1]) : null,
    rxMask: rx ? Number(rx[1]) : null,
  };
}

/**
 * A combination entry wraps across lines, and the continuation is indented with
 * spaces rather than tabs — so `#channels <= 1`, the constraint that decides whether
 * an access point may share a radio with a client, arrives on a *different* line
 * from the `#{ … }` groups it belongs to. Measured on the bench board's USB radio:
 *
 *   * #{ managed, P2P-client } <= 2, #{ AP } <= 1, #{ P2P-device } <= 1,
 *     total <= 3, #channels <= 1
 *
 * A parser that reads line by line reports that radio as having no channel limit,
 * which is exactly the configuration that silently fails to start.
 */
function parseCombinations(node: IndentNode | undefined): IwInterfaceCombination[] {
  if (!node) return [];

  const entries: string[] = [];
  for (const child of node.children) {
    const text = child.text.trim();
    if (text.startsWith('* ')) entries.push(text.slice(2).trim());
    else if (entries.length > 0) entries[entries.length - 1] += ` ${text}`;
  }

  return entries.map((text) => {
    const groups: IwCombinationGroup[] = [];
    for (const group of text.matchAll(/#\{([^}]*)\}\s*<=\s*(\d+)/g)) {
      groups.push({
        modes: group[1]!.split(',').map((m) => m.trim()).filter((m) => m.length > 0),
        max: Number.parseInt(group[2]!, 10),
      });
    }
    const radar = /radar detect widths\s*\{([^}]*)\}/.exec(text);
    return {
      text,
      groups,
      total: parseIntOrNull(/total\s*<=\s*(\d+)/.exec(text)?.[1]),
      channels: parseIntOrNull(/#channels\s*<=\s*(\d+)/.exec(text)?.[1]),
      radarDetectWidths: radar
        ? radar[1]!.split(',').map((w) => w.trim()).filter((w) => w.length > 0)
        : [],
    };
  });
}

function parseBand(index: number, node: IndentNode): IwBand {
  const capabilities = childStartingWith(node, 'Capabilities:');
  const vht = childStartingWith(node, 'VHT Capabilities');

  return {
    index,
    htCapabilities: capabilities
      ? {
          hex: capabilities.text.slice('Capabilities:'.length).trim(),
          flags: capabilities.children.map((c) => c.text).filter((t) => !t.startsWith('* ')),
        }
      : null,
    vhtCapabilities: vht
      ? {
          hex: HEX_IN_PARENS.exec(vht.text)?.[1] ?? '',
          flags: vht.children.map((c) => c.text),
        }
      : null,
    heIftypes: node.children.flatMap((child) => {
      const he = /^HE Iftypes:\s*(.+)$/.exec(child.text);
      if (!he) return [];
      return [
        {
          iftype: he[1]!.trim(),
          macCapabilitiesHex:
            HEX_IN_PARENS.exec(childStartingWith(child, 'HE MAC Capabilities')?.text ?? '')?.[1] ?? null,
          phyCapabilitiesHex:
            HEX_IN_PARENS.exec(childStartingWith(child, 'HE PHY Capabilities')?.text ?? '')?.[1] ?? null,
        },
      ];
    }),
    frequencies: (childStartingWith(node, 'Frequencies:')?.children ?? []).flatMap(parseFrequency),
    bitratesMbps: bulletValues(childStartingWith(node, 'Bitrates'))
      .map((b) => Number.parseFloat(b))
      .filter((n) => Number.isFinite(n)),
  };
}

/**
 * `* 5745.0 MHz [149] (30.0 dBm)`
 * `* 5845.0 MHz [169] (27.0 dBm) (no IR)`
 * `* 2467.0 MHz [12] (disabled)`
 *
 * A disabled frequency carries no power figure. Treating "disabled" as a power of
 * zero would offer the channel in the interface at 0 dBm instead of hiding it.
 */
function parseFrequency(node: IndentNode): IwFrequency[] {
  const text = node.text.replace(/^\*\s*/, '');
  const head = /^([\d.]+)\s*MHz/.exec(text);
  if (!head) return [];

  const channel = parseIntOrNull(/\[(\d+)\]/.exec(text)?.[1]);
  const parens = [...text.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!.trim());
  const power = parens.find((p) => /dBm$/i.test(p));
  const flags = parens.filter((p) => p !== power && p.toLowerCase() !== 'disabled');

  return [
    {
      mhz: Number.parseFloat(head[1]!),
      channel,
      maxTxPowerDbm: power ? Number.parseFloat(power) : null,
      disabled: parens.some((p) => p.toLowerCase() === 'disabled'),
      flags,
    },
  ];
}
