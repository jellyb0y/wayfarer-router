/**
 * Synthetic inventories: the hardware shapes the planner and the invariant checks have to be right
 * about.
 *
 * These are hand-built rather than captured, and the reason is worth stating because it looks like
 * the opposite of this project's habit of using real fixtures. Parser fixtures *are* real output —
 * they exist to prove the parser reads what the driver printed. These describe the *combinations* the
 * planner must handle, and several of them cannot be captured at all from any one board: two
 * identical dongles plugged in at once, a board with no radio, a profile bound to hardware that is
 * not present. Every value inside them is nonetheless a shape observed on real hardware, and where a
 * value came from a measurement it is named.
 *
 * Numbers drawn from the bench board (Orange Pi Zero3, kernel 6.18.49-current-sunxi64, `iw` 6.9,
 * measured 2026-09-19):
 *
 * * the built-in radio publishes **one** combination, `#{ managed, AP } <= 1, … total <= 3,
 *   #channels <= 2` — managed and AP share a budget of one;
 * * the USB radio publishes **two**, and only the second permits AP mode, limited to
 *   `#channels <= 1`;
 * * the built-in radio's VHT capabilities are `0x01b07031` — 80 MHz supported, 160 not;
 * * `/sys/class/ieee80211/phy1/macaddress` reads all zeros for the built-in radio while its
 *   interface has a real address, so `macFromSysfs` is null there.
 */

import type { IwInterfaceCombination } from '../../src/platform/parse/iw-phy.ts';
import type {
  InterfaceInventory,
  Inventory,
  InventoryChannel,
  RadioInventory,
} from '../../src/inventory/index.ts';

/* ── building blocks ─────────────────────────────────────────────────────────────────────── */

/** The built-in radio's combination: managed and AP share a budget of one. */
export const COMBINATION_EXCLUSIVE: IwInterfaceCombination = {
  text: '#{ managed, AP } <= 1, #{ P2P-client, P2P-GO } <= 1, #{ P2P-device } <= 1, total <= 3, #channels <= 2',
  groups: [
    { modes: ['managed', 'AP'], max: 1 },
    { modes: ['P2P-client', 'P2P-GO'], max: 1 },
    { modes: ['P2P-device'], max: 1 },
  ],
  total: 3,
  channels: 2,
  radarDetectWidths: [],
};

/** The USB radio's first combination: no AP mode at all. */
export const COMBINATION_CLIENT_ONLY: IwInterfaceCombination = {
  text: '#{ managed, P2P-client } <= 2, #{ P2P-GO } <= 1, #{ P2P-device } <= 1, total <= 3, #channels <= 2',
  groups: [
    { modes: ['managed', 'P2P-client'], max: 2 },
    { modes: ['P2P-GO'], max: 1 },
    { modes: ['P2P-device'], max: 1 },
  ],
  total: 3,
  channels: 2,
  radarDetectWidths: [],
};

/**
 * The USB radio's second combination: AP permitted, and `#channels <= 1`.
 *
 * Both limits arrive on a continuation line indented with spaces rather than tabs, which is why the
 * parser had to be written to join them — a line-by-line reader reports no channel limit at all, and
 * that is exactly the configuration that silently fails to start.
 */
export const COMBINATION_AP_ONE_CHANNEL: IwInterfaceCombination = {
  text: '#{ managed, P2P-client } <= 2, #{ AP } <= 1, #{ P2P-device } <= 1, total <= 3, #channels <= 1',
  groups: [
    { modes: ['managed', 'P2P-client'], max: 2 },
    { modes: ['AP'], max: 1 },
    { modes: ['P2P-device'], max: 1 },
  ],
  total: 3,
  channels: 1,
  radarDetectWidths: [],
};

function channel(
  number: number,
  frequencyMhz: number,
  band: InventoryChannel['band'],
  options: Partial<InventoryChannel> = {},
): InventoryChannel {
  return {
    band,
    channel: number,
    frequencyMhz,
    maxTxPowerDbm: 23,
    requiresRadarDetection: false,
    noInitiatingRadiation: false,
    disabled: false,
    flags: [],
    ...options,
  };
}

/** 2.4 GHz channels 1–13, as a driver publishes them in a permissive domain. */
export function channels24(): InventoryChannel[] {
  return Array.from({ length: 13 }, (_, index) =>
    channel(index + 1, 2412 + index * 5, '2.4GHz', { maxTxPowerDbm: 20 }),
  );
}

/**
 * A representative 5 GHz set with the real flag distribution: the low band is indoor-only at 23 dBm
 * with no radar requirement, the middle bands require radar detection, and the top band is limited to
 * 13 dBm — the difference between good and unusable coverage.
 */
export function channels5(): InventoryChannel[] {
  return [
    channel(36, 5180, '5GHz'),
    channel(40, 5200, '5GHz'),
    channel(44, 5220, '5GHz'),
    channel(48, 5240, '5GHz'),
    channel(52, 5260, '5GHz', { requiresRadarDetection: true, flags: ['radar detection'] }),
    channel(100, 5500, '5GHz', { requiresRadarDetection: true, flags: ['radar detection'] }),
    channel(149, 5745, '5GHz', { maxTxPowerDbm: 13 }),
    channel(153, 5765, '5GHz', { maxTxPowerDbm: 13 }),
  ];
}

/** Band reports as a driver publishes them: one entry per band, each with its own capabilities. */
export interface BandReport {
  index: number;
  htCapabilitiesHex: string | null;
  vhtCapabilitiesHex: string | null;
  heIftypes: string[];
  frequencyCount: number;
}

export interface RadioOptions {
  phy: string;
  bus: RadioInventory['reported']['bus'];
  usbId?: string | null;
  devicePath?: string;
  combinations: IwInterfaceCombination[];
  interfaceModes?: string[];
  channels?: InventoryChannel[];
  /** Null reproduces the measured case where sysfs reports an unusable address. */
  macFromSysfs?: string | null;
  interfaceName?: string | null;
  interfaceMac?: string | null;
  interfaceType?: string | null;
  vhtCapabilitiesHex?: string | null;
  htCapabilitiesHex?: string | null;
  heIftypes?: string[];
  regulatory?: RadioInventory['reported']['regulatory'];
  maxAssociatedStations?: number | null;
  /**
   * Band reports, when the radio publishes more than one.
   *
   * A real dual-band radio publishes a report per band with *different* capabilities — 2.4 GHz
   * commonly has HT and no VHT, 5 GHz has both. A helper that always produced one report could not
   * express the case where the wrong band is consulted, which is exactly the fault worth covering.
   */
  bandReports?: BandReport[];
}

export function radio(options: RadioOptions): RadioInventory {
  const modes = options.interfaceModes ?? ['managed', 'AP', 'monitor'];
  const combinations = options.combinations;
  const channelList = options.channels ?? [...channels24(), ...channels5()];

  const apGroupIn = (combination: IwInterfaceCombination): boolean =>
    combination.groups.some((group) => group.modes.includes('AP'));
  const together = (() => {
    for (const combination of combinations) {
      const ap = combination.groups.find((group) => group.modes.includes('AP'));
      const client = combination.groups.find((group) => group.modes.includes('managed'));
      if (!ap || !client) continue;
      if (ap === client && ap.max < 2) continue;
      if ((combination.total ?? Number.POSITIVE_INFINITY) < 2) continue;
      return {
        supported: true,
        sameChannelOnly: combination.channels !== null && combination.channels < 2,
        text: combination.text,
      };
    }
    return { supported: false, sameChannelOnly: false, text: combinations[0]?.text ?? 'none published' };
  })();

  const interfaces =
    options.interfaceName === null
      ? []
      : [
          {
            name: options.interfaceName ?? `wlan${options.phy.replace('phy', '')}`,
            type: options.interfaceType ?? 'managed',
            mac: options.interfaceMac ?? '90:de:80:47:b4:b4',
            ssid: null,
            channel: null,
            widthMhz: null,
            txPowerDbm: 20,
          },
        ];

  return {
    phy: options.phy,
    reported: {
      interfaceModes: modes,
      softwareInterfaceModes: [],
      interfaceCombinations: combinations,
      antennas: { txMask: 1, rxMask: 1 },
      maxAssociatedStations: options.maxAssociatedStations ?? 16,
      maxScanSsids: 4,
      bands: options.bandReports ?? [
        {
          index: 0,
          htCapabilitiesHex: options.htCapabilitiesHex ?? '0x11ee',
          // The measured value for the bench board's built-in radio: 80 MHz yes, 160 no.
          vhtCapabilitiesHex: options.vhtCapabilitiesHex ?? '0x01b07031',
          heIftypes: options.heIftypes ?? [],
          frequencyCount: channelList.length,
        },
      ],
      extendedFeatures: [],
      devicePath:
        options.devicePath ??
        (options.bus === 'usb' ? '/sys/devices/platform/soc/5310000.usb/usb2/2-1/2-1:1.0' : '/sys/devices/platform/unisoc_wifi'),
      bus: options.bus,
      usbId: options.usbId ?? (options.bus === 'usb' ? '0e8d:7961' : null),
      macFromSysfs: options.macFromSysfs === undefined ? null : options.macFromSysfs,
      regulatory:
        options.regulatory ?? { source: 'global', country: 'US', dfsRegion: 'DFS-FCC', rules: [] },
      interfaces,
    },
    derived: {
      canHostAccessPoint: {
        value: modes.includes('AP') && combinations.some(apGroupIn),
        from: `supported interface modes: ${modes.join(', ')}`,
      },
      canHostClient: { value: modes.includes('managed'), from: `supported interface modes: ${modes.join(', ')}` },
      accessPointAndClientTogether: {
        value: { supported: together.supported, sameChannelOnly: together.sameChannelOnly },
        from: together.text,
      },
      removable: { value: options.bus === 'usb', from: `device path: ${options.devicePath ?? 'unknown'}` },
      scanAllowedNow: { value: true, from: 'no access point is running on this radio' },
      bands: {
        value: [...new Set(channelList.filter((entry) => !entry.disabled).map((entry) => entry.band))],
        from: 'frequencies published by the driver across 1 band(s)',
      },
      channels: channelList,
    },
  };
}

export function ethernetInterface(name = 'end0', mac = '02:81:5a:11:22:33', ifindex = 2): InterfaceInventory {
  return {
    name,
    ifindex,
    mac,
    flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'],
    operstate: 'UP',
    linkType: 'ether',
    kind: null,
    altNames: [],
    addresses: [{ family: 'inet', address: '192.168.1.237', prefixLength: 24, scope: 'global' }],
    phy: null,
    wirelessType: null,
  };
}

export function loopbackInterface(): InterfaceInventory {
  return {
    name: 'lo',
    ifindex: 1,
    mac: '00:00:00:00:00:00',
    flags: ['LOOPBACK', 'UP', 'LOWER_UP'],
    operstate: 'UNKNOWN',
    linkType: 'loopback',
    kind: null,
    altNames: [],
    addresses: [{ family: 'inet', address: '127.0.0.1', prefixLength: 8, scope: 'host' }],
    phy: null,
    wirelessType: null,
  };
}

export function wirelessInterface(
  name: string,
  phy: string,
  mac: string,
  ifindex: number,
  type = 'managed',
): InterfaceInventory {
  return {
    name,
    ifindex,
    mac,
    flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'],
    operstate: 'UP',
    linkType: 'ether',
    kind: null,
    altNames: [],
    addresses: [],
    phy,
    wirelessType: type,
  };
}

function inventory(radios: RadioInventory[], interfaces: InterfaceInventory[], notes: string[] = []): Inventory {
  return {
    // A fixed timestamp: a golden file that changed every run would be a golden file nobody reads.
    at: '2026-09-19T12:00:00.000Z',
    system: {
      kernel: '6.18.49-current-sunxi64',
      architecture: 'arm64',
      cpuCount: 4,
      memoryMb: 1973,
      boardModel: 'OrangePi Zero3',
    },
    radios,
    interfaces,
    binaries: [
      { name: 'sing-box', present: true, path: '/usr/bin/sing-box', version: '1.14.0', features: ['with_quic'], neededFor: 'the data plane' },
      { name: 'hostapd', present: true, path: '/usr/sbin/hostapd', version: '2.10', features: [], neededFor: 'hosting an access point' },
      { name: 'dnsmasq', present: true, path: '/usr/sbin/dnsmasq', version: '2.90', features: [], neededFor: 'handing out addresses' },
      { name: 'nft', present: true, path: '/usr/sbin/nft', version: '1.1.3', features: [], neededFor: 'the firewall' },
      { name: 'openvpn', present: true, path: '/usr/sbin/openvpn', version: '2.6.12', features: [], neededFor: 'tunnels of that kind' },
      { name: 'ck-client', present: true, path: '/usr/local/bin/ck-client', version: '2.9.0', features: [], neededFor: 'obfuscated tunnels' },
    ],
    clock: {
      timezone: 'UTC',
      ntpEnabled: true,
      synchronized: true,
      localRtc: false,
      timeUsec: '1789732800000000',
      rtcTimeUsec: '1789732800000000',
    },
    notes,
  };
}

/* ── the cases ───────────────────────────────────────────────────────────────────────────── */

/** (a) One built-in radio, no dongle. The bare board. */
export function oneBuiltInRadio(): Inventory {
  return inventory(
    [radio({ phy: 'phy0', bus: 'platform', combinations: [COMBINATION_EXCLUSIVE], interfaceName: 'wlan0' })],
    [loopbackInterface(), ethernetInterface(), wirelessInterface('wlan0', 'phy0', '90:de:80:47:b4:b4', 3)],
    ['Only one radio is present.'],
  );
}

/** (b) Built-in plus a USB dongle: the usual two-radio build. */
export function builtInAndDongle(): Inventory {
  return inventory(
    [
      radio({ phy: 'phy0', bus: 'platform', combinations: [COMBINATION_EXCLUSIVE], interfaceName: 'wlan0' }),
      radio({
        phy: 'phy1',
        bus: 'usb',
        usbId: '0e8d:7961',
        combinations: [COMBINATION_CLIENT_ONLY, COMBINATION_AP_ONE_CHANNEL],
        interfaceName: 'wlan1',
        interfaceMac: '00:c0:ca:b1:c2:d3',
        // This radio reports its own address correctly, unlike the built-in one.
        macFromSysfs: '00:c0:ca:b1:c2:d3',
        heIftypes: ['managed', 'AP'],
      }),
    ],
    [
      loopbackInterface(),
      ethernetInterface(),
      wirelessInterface('wlan0', 'phy0', '90:de:80:47:b4:b4', 3),
      wirelessInterface('wlan1', 'phy1', '00:c0:ca:b1:c2:d3', 4),
    ],
  );
}

/** (c) A single dongle that can do both roles, on one channel. */
export function dualRoleDongle(): Inventory {
  return inventory(
    [
      radio({
        phy: 'phy0',
        bus: 'usb',
        usbId: '0e8d:7961',
        combinations: [COMBINATION_CLIENT_ONLY, COMBINATION_AP_ONE_CHANNEL],
        interfaceName: 'wlan0',
        macFromSysfs: '00:c0:ca:b1:c2:d3',
        interfaceMac: '00:c0:ca:b1:c2:d3',
      }),
    ],
    [loopbackInterface(), ethernetInterface(), wirelessInterface('wlan0', 'phy0', '00:c0:ca:b1:c2:d3', 3)],
  );
}

/** (d) No radio at all. A valid device, reachable over Ethernet, that cannot host an access point. */
export function noRadio(): Inventory {
  return inventory(
    [],
    [loopbackInterface(), ethernetInterface()],
    ['No radio was detected. The device can be managed over Ethernet, but it cannot host an access point.'],
  );
}

/**
 * (g) Two identical USB radios.
 *
 * `bind.by: "phy-usb"` matches both, and picking one would be arbitrary within a boot and unstable
 * across boots — so the access point would move between radios, with different antennas, for no
 * reason anybody could see. This must resolve to an explicit failure.
 */
export function twoIdenticalDongles(): Inventory {
  const combinations = [COMBINATION_CLIENT_ONLY, COMBINATION_AP_ONE_CHANNEL];
  return inventory(
    [
      radio({
        phy: 'phy0',
        bus: 'usb',
        usbId: '0e8d:7961',
        devicePath: '/sys/devices/platform/soc/5310000.usb/usb2/2-1/2-1:1.0',
        combinations,
        interfaceName: 'wlan0',
        macFromSysfs: '00:c0:ca:00:00:01',
        interfaceMac: '00:c0:ca:00:00:01',
      }),
      radio({
        phy: 'phy1',
        bus: 'usb',
        usbId: '0e8d:7961',
        devicePath: '/sys/devices/platform/soc/5311000.usb/usb3/3-1/3-1:1.0',
        combinations,
        interfaceName: 'wlan1',
        macFromSysfs: '00:c0:ca:00:00:02',
        interfaceMac: '00:c0:ca:00:00:02',
      }),
    ],
    [
      loopbackInterface(),
      ethernetInterface(),
      wirelessInterface('wlan0', 'phy0', '00:c0:ca:00:00:01', 3),
      wirelessInterface('wlan1', 'phy1', '00:c0:ca:00:00:02', 4),
    ],
  );
}

/**
 * (h) A regulatory domain that forbids the channel a profile asks for.
 *
 * The radio's *own* block wins over the global one, and the channels it publishes are the ones the
 * kernel will allow. Measured shape: the global block reported `country US` while the built-in radio
 * reported `country 00` — a different channel set and a different power limit.
 */
export function restrictedRegulatoryDomain(): Inventory {
  return inventory(
    [
      radio({
        phy: 'phy0',
        bus: 'platform',
        combinations: [COMBINATION_EXCLUSIVE],
        interfaceName: 'wlan0',
        // Channel 149 is absent entirely, and 52 is present but disabled: two different refusals,
        // with two different messages, from one inventory.
        channels: [
          ...channels24(),
          channel(36, 5180, '5GHz'),
          channel(40, 5200, '5GHz'),
          channel(52, 5260, '5GHz', { disabled: true, flags: ['disabled'] }),
        ],
        regulatory: { source: 'own', country: '00', dfsRegion: 'DFS-UNSET', rules: [] },
      }),
    ],
    [loopbackInterface(), ethernetInterface(), wirelessInterface('wlan0', 'phy0', '90:de:80:47:b4:b4', 3)],
  );
}

/**
 * (i) A genuinely dual-band radio, publishing a separate report per band.
 *
 * 2.4 GHz has HT and **no VHT**; 5 GHz has both. That asymmetry is the point: consulting the first
 * band with frequencies — which both the invariant check and the hostapd generator used to do —
 * validates a 5 GHz access point against the 2.4 GHz report and concludes it cannot do 80 MHz.
 *
 * It cannot be captured from the bench board, whose radios each publish one band, and that is
 * precisely why it has to be a fixture: the fault needs somebody else's hardware to appear, and it
 * appears as an access point that will not start.
 */
export function dualBandRadio(): Inventory {
  const channels = [...channels24(), ...channels5()];
  return inventory(
    [
      radio({
        phy: 'phy0',
        bus: 'usb',
        usbId: '0b05:1234',
        combinations: [COMBINATION_CLIENT_ONLY, COMBINATION_AP_ONE_CHANNEL],
        interfaceName: 'wlan0',
        macFromSysfs: '00:c0:ca:dd:ee:ff',
        interfaceMac: '00:c0:ca:dd:ee:ff',
        channels,
        bandReports: [
          // 2.4 GHz: HT only. A driver that reports no VHT here is the normal case, not a defect.
          { index: 0, htCapabilitiesHex: '0x11ee', vhtCapabilitiesHex: null, heIftypes: [], frequencyCount: 13 },
          // 5 GHz: HT and VHT, 80 MHz supported.
          {
            index: 1,
            htCapabilitiesHex: '0x11ee',
            vhtCapabilitiesHex: '0x01b07031',
            heIftypes: ['AP'],
            frequencyCount: 8,
          },
        ],
      }),
    ],
    [loopbackInterface(), ethernetInterface(), wirelessInterface('wlan0', 'phy0', '00:c0:ca:dd:ee:ff', 3)],
  );
}

/** Every inventory, by the name a golden file uses. */
export const INVENTORIES: Record<string, () => Inventory> = {
  'one-built-in-radio': oneBuiltInRadio,
  'built-in-and-dongle': builtInAndDongle,
  'dual-role-dongle': dualRoleDongle,
  'no-radio': noRadio,
  'two-identical-dongles': twoIdenticalDongles,
  'restricted-regulatory-domain': restrictedRegulatoryDomain,
  'dual-band-radio': dualBandRadio,
};

/** Runtime facts with nothing in the way: the baseline every case starts from. */
export function cleanFacts(): import('../../src/core/invariants.ts').RuntimeFacts {
  return {
    foreignCores: [],
    interfaceClaims: [],
    managementInterfaces: ['end0'],
    // The network the management session is on, which is what must keep its return path. A synthetic value
    // rather than an empty list, because an empty one would make every golden file silently miss the
    // exclusion this fact exists to produce.
    uplinkNetworks: [{ interface: 'end0', cidr: '192.0.2.0/24' }],
    binaries: [
      { name: 'sing-box', present: true, version: '1.14.0' },
      { name: 'hostapd', present: true, version: '2.10' },
      { name: 'dnsmasq', present: true, version: '2.90' },
      { name: 'nft', present: true, version: '1.1.3' },
      { name: 'openvpn', present: true, version: '2.6.12' },
      /*
       * The obfuscation client, present here because the golden scenarios include an obfuscated
       * tunnel and a *clean* device is one that can run what the fixtures configure. Its absence is
       * asserted deliberately, in `catalogue-requirements.test.ts`, rather than as a side effect of
       * a helper — a scenario that is quietly unusable stops exercising everything downstream of it.
       */
      { name: 'ck-client', present: true, version: '2.9.0' },
    ],
  };
}
