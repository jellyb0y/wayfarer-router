/**
 * Hardware inventory: what this device actually is, discovered at runtime.
 *
 * Two structural rules, and they are the reason this module exists rather than the API simply
 * returning parser output:
 *
 * 1. **What the driver reported and what we concluded are separated.** Every entry under
 *    `derived` names the input it came from, so a wrong conclusion can be traced to the line
 *    of output that produced it instead of being argued about.
 * 2. **Interface combinations keep their structure.** The constraint is
 *    `#{ managed, AP } <= 1` together with `total` and `#channels` limits. Flattening that to
 *    `canDoBoth: false` throws away the reason, and the reason is what the operator needs to
 *    read when a configuration is refused.
 *
 * Nothing here is hardcoded about any particular board: no interface names, no channel lists,
 * no MAC addresses, and no assumption that a radio exists at all.
 */

import { arch, cpus, release, totalmem } from 'node:os';
import type { Platform } from '../platform/index.ts';
import { apAndClientSupport, scanAllowed, type Radio } from '../platform/wifi.ts';
import type { IwInterfaceCombination } from '../platform/parse/iw-phy.ts';
import type { RegDomain } from '../platform/parse/iw-reg.ts';
import type { ClockStatus } from '../platform/parse/systemctl.ts';

export interface InventoryChannel {
  /** Band label derived from the frequency, not from the driver's band index. */
  band: '2.4GHz' | '5GHz' | '6GHz' | 'other';
  channel: number | null;
  frequencyMhz: number;
  maxTxPowerDbm: number | null;
  /** The driver said this frequency needs radar detection. */
  requiresRadarDetection: boolean;
  /** The driver said no initiating radiation is allowed here. */
  noInitiatingRadiation: boolean;
  disabled: boolean;
  /** Every flag the driver printed, so an unknown one is not lost. */
  flags: string[];
}

export interface DerivedValue<T> {
  value: T;
  /** The observation this was concluded from, in the driver's own words where possible. */
  from: string;
}

export interface RadioInventory {
  phy: string;
  /** Straight from the driver and the kernel. Nothing in here is our opinion. */
  reported: {
    interfaceModes: string[];
    softwareInterfaceModes: string[];
    interfaceCombinations: IwInterfaceCombination[];
    antennas: { txMask: number | null; rxMask: number | null } | null;
    maxAssociatedStations: number | null;
    maxScanSsids: number | null;
    bands: {
      index: number;
      htCapabilitiesHex: string | null;
      vhtCapabilitiesHex: string | null;
      heIftypes: string[];
      frequencyCount: number;
    }[];
    extendedFeatures: string[];
    devicePath: string | null;
    bus: Radio['bus'];
    usbId: string | null;
    /** Null when sysfs reports an unusable address, which one radio here does. */
    macFromSysfs: string | null;
    regulatory: {
      source: 'own' | 'global' | 'none';
      country: string | null;
      dfsRegion: string | null;
      rules: RegDomain['rules'];
    };
    interfaces: {
      name: string | null;
      type: string | null;
      mac: string | null;
      ssid: string | null;
      channel: number | null;
      widthMhz: number | null;
      txPowerDbm: number | null;
    }[];
  };
  /** Conclusions. Each carries the observation behind it. */
  derived: {
    canHostAccessPoint: DerivedValue<boolean>;
    canHostClient: DerivedValue<boolean>;
    accessPointAndClientTogether: DerivedValue<{ supported: boolean; sameChannelOnly: boolean }>;
    removable: DerivedValue<boolean>;
    scanAllowedNow: DerivedValue<boolean>;
    bands: DerivedValue<string[]>;
    /** Channels the driver offers and the regulatory domain permits, with their limits. */
    channels: InventoryChannel[];
  };
}

export interface InterfaceInventory {
  name: string;
  ifindex: number;
  mac: string | null;
  flags: string[];
  operstate: string | null;
  linkType: string | null;
  kind: string | null;
  altNames: string[];
  addresses: { family: string; address: string; prefixLength: number; scope: string | null }[];
  /** Set when this interface belongs to a radio. */
  phy: string | null;
  wirelessType: string | null;
}

export interface BinaryInventory {
  name: string;
  present: boolean;
  path: string | null;
  version: string | null;
  features: string[];
  /** Why it matters, so the interface can say what is unavailable without it. */
  neededFor: string;
}

export interface SystemInventory {
  kernel: string;
  architecture: string;
  cpuCount: number;
  memoryMb: number;
  /** From the device tree when present; null on hardware that does not publish one. */
  boardModel: string | null;
}

export interface Inventory {
  at: string;
  system: SystemInventory;
  radios: RadioInventory[];
  interfaces: InterfaceInventory[];
  binaries: BinaryInventory[];
  clock: ClockStatus;
  /** Things an operator should know about this hardware, in plain words. */
  notes: string[];
}

/**
 * Which binaries are looked for, and what each one is needed for.
 *
 * Exported so that the guards which assert nothing requires a binary this list omits read the list
 * itself rather than a copy of it: a second copy is the thing that drifts.
 */
export const BINARIES: { name: string; neededFor: string }[] = [
  { name: 'sing-box', neededFor: 'the data plane and every tunnel type it speaks natively' },
  { name: 'hostapd', neededFor: 'hosting an access point' },
  { name: 'hostapd_cli', neededFor: 'access-point state and client events' },
  { name: 'wpa_supplicant', neededFor: 'a Wi-Fi uplink' },
  { name: 'dnsmasq', neededFor: 'handing out addresses on the local network' },
  { name: 'nft', neededFor: 'the firewall, the kill-switch and address translation' },
  { name: 'iw', neededFor: 'radio capabilities and link quality' },
  { name: 'ip', neededFor: 'interface, address and route state' },
  { name: 'openvpn', neededFor: 'tunnels of that kind' },
  { name: 'xray', neededFor: 'tunnels that run another client behind a local SOCKS port' },
  { name: 'ck-client', neededFor: 'masking an OpenVPN tunnel so that it is not recognisable as one' },
  /*
   * The transient-unit tool, and the reason it is in this list.
   *
   * The confirmation window's revert timer and the bench deadman are both `systemd-run` transient units,
   * so a device without it has no way to undo a network change by itself — which is the single promise
   * this design makes to somebody reconfiguring the network they are connected over. It was absent from
   * this list while the capability report named it, so the report said the revert timer was unavailable on
   * a device where it works: a capability the inventory never looks for is reported missing for ever. The
   * reverse of that mistake — a binary looked for with no stated remedy — is asserted by a test; this one
   * needed the matching assertion in the other direction, which now exists too.
   */
  { name: 'systemd-run', neededFor: 'undoing a network change by itself when nobody confirms it' },
];

export async function collectInventory(platform: Platform): Promise<Inventory> {
  const [radios, netSnapshot, clock] = await Promise.all([
    platform.wifi.phys().catch(() => [] as Radio[]),
    platform.net.snapshot(),
    platform.clock.status(),
  ]);

  const binaries = await Promise.all(
    BINARIES.map(async (entry) => {
      const info = await platform.binaries.detect(entry.name).catch(() => null);
      return {
        name: entry.name,
        present: info !== null,
        path: info?.path ?? null,
        version: info?.version ?? null,
        features: info?.features ?? [],
        neededFor: entry.neededFor,
      } satisfies BinaryInventory;
    }),
  );

  const interfaceToPhy = new Map<string, { phy: string; type: string | null }>();
  for (const radio of radios) {
    for (const iface of radio.interfaces) {
      if (iface.name !== null) interfaceToPhy.set(iface.name, { phy: radio.phy, type: iface.type });
    }
  }

  const interfaces: InterfaceInventory[] = netSnapshot.links.map((link) => {
    const wireless = interfaceToPhy.get(link.name);
    return {
      name: link.name,
      ifindex: link.ifindex,
      mac: link.mac,
      flags: link.flags,
      operstate: link.operstate,
      linkType: link.linkType,
      kind: link.kind,
      altNames: link.altNames,
      addresses: netSnapshot.addresses
        .filter((address) => address.name === link.name)
        .map((address) => ({
          family: address.family,
          address: address.address,
          prefixLength: address.prefixLength,
          scope: address.scope,
        })),
      phy: wireless?.phy ?? null,
      wirelessType: wireless?.type ?? null,
    };
  });

  const notes: string[] = [];
  const radioInventory = radios.map((radio) => describeRadio(radio, notes));

  if (radios.length === 0) {
    notes.push('No radio was detected. The device can be managed over Ethernet, but it cannot host an access point.');
  }
  if (radios.length === 1) {
    notes.push(
      'Only one radio is present. An access point and a Wi-Fi uplink at the same time need two radios unless this ' +
        "one's driver publishes a combination that allows both, in which case they must share a channel.",
    );
  }
  for (const radio of radioInventory) {
    if (radio.reported.bus === 'usb') {
      notes.push(
        `${radio.phy} is on USB. A USB 2.0 port caps throughput at roughly 280–300 Mbit/s regardless of what the ` +
          'radio itself can do, so tuning the radio past that point achieves nothing.',
      );
    }
  }
  if (clock.synchronized === false) {
    notes.push(
      'The clock has not been synchronised since boot. This board has no clock battery, and transports that ' +
        'authenticate on a timestamp fail while direct connections work — which looks like broken tunnels.',
    );
  }

  return {
    at: new Date().toISOString(),
    system: await collectSystem(platform),
    radios: radioInventory,
    interfaces,
    binaries,
    clock,
    notes,
  };
}

function describeRadio(radio: Radio, notes: string[]): RadioInventory {
  const capabilities = radio.capabilities;
  const both = apAndClientSupport(capabilities);
  const scan = scanAllowed(radio);

  const apCombination = capabilities.interfaceCombinations.find((combination) =>
    combination.groups.some((group) => group.modes.includes('AP')),
  );
  const canHostAp = capabilities.interfaceModes.includes('AP');
  const canHostClient = capabilities.interfaceModes.includes('managed');

  const channels: InventoryChannel[] = [];
  for (const band of capabilities.bands) {
    for (const frequency of band.frequencies) {
      const flags = frequency.flags.map((flag) => flag.toLowerCase());
      channels.push({
        band: bandOf(frequency.mhz),
        channel: frequency.channel,
        frequencyMhz: frequency.mhz,
        maxTxPowerDbm: frequency.maxTxPowerDbm,
        requiresRadarDetection: flags.some((flag) => flag.includes('radar')),
        noInitiatingRadiation: flags.some((flag) => flag === 'no ir' || flag.includes('no initiating')),
        disabled: frequency.disabled,
        flags: frequency.flags,
      });
    }
  }

  if (radio.mac === null && radio.devicePath !== null) {
    notes.push(
      `${radio.phy} does not report a usable address of its own in sysfs, so it is identified by its bus path ` +
        `(${radio.devicePath}) and by the addresses of its interfaces.`,
    );
  }

  return {
    phy: radio.phy,
    reported: {
      interfaceModes: capabilities.interfaceModes,
      softwareInterfaceModes: capabilities.softwareInterfaceModes,
      interfaceCombinations: capabilities.interfaceCombinations,
      antennas: capabilities.antennas,
      maxAssociatedStations: capabilities.maxAssociatedStations,
      maxScanSsids: capabilities.maxScanSsids,
      bands: capabilities.bands.map((band) => ({
        index: band.index,
        htCapabilitiesHex: band.htCapabilities?.hex ?? null,
        vhtCapabilitiesHex: band.vhtCapabilities?.hex ?? null,
        heIftypes: band.heIftypes.map((entry) => entry.iftype),
        frequencyCount: band.frequencies.length,
      })),
      extendedFeatures: capabilities.extendedFeatures,
      devicePath: radio.devicePath,
      bus: radio.bus,
      usbId: radio.usbId,
      macFromSysfs: radio.mac,
      regulatory: {
        source: radio.regulatoryIsOwn ? 'own' : radio.regulatory === null ? 'none' : 'global',
        country: radio.regulatory?.country ?? null,
        dfsRegion: radio.regulatory?.dfsRegion ?? null,
        rules: radio.regulatory?.rules ?? [],
      },
      interfaces: radio.interfaces.map((iface) => ({
        name: iface.name,
        type: iface.type,
        mac: iface.mac,
        ssid: iface.ssid,
        channel: iface.channel?.channel ?? null,
        widthMhz: iface.channel?.widthMhz ?? null,
        txPowerDbm: iface.txPowerDbm,
      })),
    },
    derived: {
      canHostAccessPoint: {
        value: canHostAp,
        from: `supported interface modes: ${capabilities.interfaceModes.join(', ') || 'none reported'}`,
      },
      canHostClient: {
        value: canHostClient,
        from: `supported interface modes: ${capabilities.interfaceModes.join(', ') || 'none reported'}`,
      },
      accessPointAndClientTogether: {
        value: { supported: both.supported, sameChannelOnly: both.sameChannelOnly },
        from: both.combination ?? 'the driver published no interface combinations',
      },
      removable: {
        value: radio.bus === 'usb',
        from: `device path: ${radio.devicePath ?? 'unknown'}`,
      },
      scanAllowedNow: {
        value: scan.allowed,
        from: scan.reason ?? 'no access point is running on this radio',
      },
      bands: {
        value: [...new Set(channels.filter((channel) => !channel.disabled).map((channel) => channel.band))],
        from: `frequencies published by the driver across ${capabilities.bands.length} band(s)`,
      },
      channels,
    },
  };
}

function bandOf(mhz: number): InventoryChannel['band'] {
  if (mhz >= 2400 && mhz < 2500) return '2.4GHz';
  if (mhz >= 5150 && mhz < 5925) return '5GHz';
  if (mhz >= 5925 && mhz <= 7125) return '6GHz';
  return 'other';
}

async function collectSystem(platform: Platform): Promise<SystemInventory> {
  return {
    // The runtime can answer these without knowing which operating system it is on, so they stay
    // here; the board's own name comes from the device tree and therefore from the platform layer.
    kernel: release(),
    architecture: arch(),
    cpuCount: cpus().length,
    memoryMb: Math.round(totalmem() / (1024 * 1024)),
    boardModel: await platform.host.boardModel(),
  };
}
