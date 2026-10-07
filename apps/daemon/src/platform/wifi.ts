/**
 * Radio capabilities and link quality, read through `iw`.
 *
 * `iw` is used here and not wpa_supplicant's D-Bus interface because that interface
 * exposes neither signal strength, negotiated rate, modulation index nor channel width,
 * and those are the numbers that tell an operator whether a link is good. Association
 * control and association *events* go over D-Bus instead — see `supplicant.ts`.
 *
 * Everything in here is best-effort: a field a driver does not implement comes back as
 * null and must not break the caller.
 */

import { readFile, readdir, realpath } from 'node:fs/promises';
import { run } from './exec.ts';
import { parseIwPhy, type IwPhy } from './parse/iw-phy.ts';
import {
  parseIwDev,
  parseIwLink,
  parseIwStationDump,
  type IwInterface,
  type IwLink,
  type IwStation,
} from './parse/iw-dev.ts';
import { domainForPhy, parseIwRegGet, type RegDomain, type RegDomains } from './parse/iw-reg.ts';

/** A radio, as discovered — never from a table of known hardware. */
export interface Radio {
  /** Kernel name, e.g. `phy0`. Ordering is not stable across boots. */
  phy: string;
  capabilities: IwPhy;
  /**
   * Where the radio is attached, from `/sys/class/ieee80211/<phy>/device`. A platform
   * path means built in and non-removable; a USB path means a dongle. This is what a
   * profile binds to, because it survives renaming and re-enumeration.
   */
  devicePath: string | null;
  bus: 'usb' | 'platform' | 'pci' | 'other' | null;
  /** USB `vendor:product`, when the radio is on USB. */
  usbId: string | null;
  /**
   * The radio's own address from sysfs, or null when it is unusable. Measured on the
   * bench board: the built-in radio reports `00:00:00:00:00:00` here while its interface
   * has a real address, so an all-zero value is treated as absent rather than matched on.
   */
  mac: string | null;
  /** Interfaces currently on this radio, from `iw dev`. */
  interfaces: IwInterface[];
  /** The regulatory domain this radio is subject to: its own, else the global one. */
  regulatory: RegDomain | null;
  /** True when the radio's own domain was published, rather than inherited. */
  regulatoryIsOwn: boolean;
}

export interface WifiReader {
  phys(): Promise<Radio[]>;
  interfaces(): Promise<IwInterface[]>;
  regulatory(): Promise<RegDomains>;
  link(interfaceName: string): Promise<IwLink>;
  stations(interfaceName: string): Promise<IwStation[]>;
}

const IW = '/usr/sbin/iw';
const SYSFS_PHY = '/sys/class/ieee80211';

export function createWifiReader(iwPath = IW, sysfsPhy = SYSFS_PHY): WifiReader {
  return {
    async phys() {
      const [phyOutput, devOutput, regulatory] = await Promise.all([
        run(iwPath, ['phy'], { timeoutMs: 10_000, maxOutputBytes: 2 * 1024 * 1024 }),
        run(iwPath, ['dev'], { timeoutMs: 5000 }),
        run(iwPath, ['reg', 'get'], { timeoutMs: 5000 }),
      ]);

      const capabilities = parseIwPhy(phyOutput.stdout);
      const interfaces = parseIwDev(devOutput.stdout);
      const domains = parseIwRegGet(regulatory.stdout);

      return await Promise.all(
        capabilities.map(async (phy) => {
          const hardware = await readPhyHardware(sysfsPhy, phy.name);
          return {
            phy: phy.name,
            capabilities: phy,
            devicePath: hardware.devicePath,
            bus: hardware.bus,
            usbId: hardware.usbId,
            mac: hardware.mac,
            interfaces: interfaces.filter((i) => i.phy === phy.name),
            regulatory: domainForPhy(domains, phy.name),
            regulatoryIsOwn: domains.perPhy[phy.name] !== undefined,
          } satisfies Radio;
        }),
      );
    },

    async interfaces() {
      const result = await run(iwPath, ['dev'], { timeoutMs: 5000 });
      return parseIwDev(result.stdout);
    },

    async regulatory() {
      const result = await run(iwPath, ['reg', 'get'], { timeoutMs: 5000 });
      return parseIwRegGet(result.stdout);
    },

    async link(interfaceName) {
      // An empty interface name would be caught by exec, but naming it here makes the
      // error say which caller had nothing to pass.
      requireInterfaceName(interfaceName, 'iw dev link');
      const result = await run(iwPath, ['dev', interfaceName, 'link'], { timeoutMs: 5000 });
      return parseIwLink(result.stdout);
    },

    async stations(interfaceName) {
      requireInterfaceName(interfaceName, 'iw dev station dump');
      const result = await run(iwPath, ['dev', interfaceName, 'station', 'dump'], {
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
      });
      return parseIwStationDump(result.stdout);
    },
  };
}

/**
 * Whether a scan may be started on this radio.
 *
 * A scan requires the radio to leave its channel, which interrupts an access point
 * hosted on it — visibly, for every associated client. So the answer is derived from
 * what the radio is currently doing, and the reason is returned for the interface to
 * show instead of a bare refusal.
 */
export function scanAllowed(radio: Radio): { allowed: boolean; reason?: string } {
  const ap = radio.interfaces.find((i) => i.type === 'AP');
  if (ap) {
    return {
      allowed: false,
      reason:
        `${radio.phy} is hosting an access point on ${ap.name ?? 'an unnamed interface'}. ` +
        'Scanning makes the radio leave its channel, which every associated client sees.',
    };
  }
  return { allowed: true };
}

/**
 * Whether this radio can host an access point and a client at the same time, and under
 * what constraint. The answer comes from the driver's published interface combinations:
 * the union across combinations, not the first one — the bench board's USB radio
 * publishes two and only the second permits AP mode.
 */
export function apAndClientSupport(radio: IwPhy): {
  supported: boolean;
  sameChannelOnly: boolean;
  combination: string | null;
} {
  for (const combination of radio.interfaceCombinations) {
    const apGroup = combination.groups.find((g) => g.modes.includes('AP'));
    const clientGroup = combination.groups.find((g) => g.modes.includes('managed'));
    if (!apGroup || !clientGroup) continue;
    // Both roles in one group sharing a budget of one is the "cannot do both" case.
    if (apGroup === clientGroup && apGroup.max < 2) continue;
    if ((combination.total ?? Number.POSITIVE_INFINITY) < 2) continue;
    return {
      supported: true,
      sameChannelOnly: combination.channels !== null && combination.channels < 2,
      combination: combination.text,
    };
  }
  return {
    supported: false,
    sameChannelOnly: false,
    combination: radio.interfaceCombinations[0]?.text ?? null,
  };
}

function requireInterfaceName(name: string, what: string): void {
  if (name.trim() === '') {
    throw new Error(`${what} called with an empty interface name; the caller must resolve it first`);
  }
}

async function readPhyHardware(
  sysfsPhy: string,
  phy: string,
): Promise<{ devicePath: string | null; bus: Radio['bus']; usbId: string | null; mac: string | null }> {
  let devicePath: string | null = null;
  try {
    devicePath = await realpath(`${sysfsPhy}/${phy}/device`);
  } catch {
    devicePath = null;
  }

  let mac: string | null = null;
  try {
    const raw = (await readFile(`${sysfsPhy}/${phy}/macaddress`, 'utf8')).trim().toLowerCase();
    mac = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(raw) && raw !== '00:00:00:00:00:00' ? raw : null;
  } catch {
    mac = null;
  }

  let bus: Radio['bus'] = null;
  let usbId: string | null = null;
  if (devicePath !== null) {
    if (devicePath.includes('/usb')) bus = 'usb';
    else if (devicePath.includes('/pci')) bus = 'pci';
    else if (devicePath.includes('/platform/')) bus = 'platform';
    else bus = 'other';

    if (bus === 'usb') {
      usbId = await readUsbId(devicePath);
    }
  }

  return { devicePath, bus, usbId, mac };
}

/**
 * `idVendor` and `idProduct` live on the USB *device*, while the radio hangs off an
 * interface of it — so the tree is walked upwards until both files appear.
 */
async function readUsbId(devicePath: string): Promise<string | null> {
  let current = devicePath;
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const entries = await readdir(current);
      if (entries.includes('idVendor') && entries.includes('idProduct')) {
        const vendor = (await readFile(`${current}/idVendor`, 'utf8')).trim();
        const product = (await readFile(`${current}/idProduct`, 'utf8')).trim();
        if (vendor && product) return `${vendor}:${product}`;
      }
    } catch {
      return null;
    }
    const parent = current.slice(0, current.lastIndexOf('/'));
    if (parent === '' || parent === current) return null;
    current = parent;
  }
  return null;
}
