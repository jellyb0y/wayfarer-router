/**
 * The radio as a device rather than as a wireless interface: whether frames move through it, and putting
 * a USB radio through its driver again.
 *
 * Here because both are reads and writes of sysfs, and only this layer knows a filesystem exists.
 *
 * Why the second exists at all (bench board, 2026-10-16): an mt7921u adapter's firmware hung and the
 * driver's own in-place reset left the radio silent for six hours while hostapd reported `ENABLED`.
 * Unbinding the USB interface from its driver and binding it again is the reset that starts the device
 * from nothing short of unplugging it — the effect a reboot had, without touching anything else.
 */

import { readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface LinkCounters {
  txPackets: number;
  rxPackets: number;
}

/** The interface's packet counters, or `null` when the interface or its counters cannot be read. */
export async function counters(iface: string, sysClassNet = '/sys/class/net'): Promise<LinkCounters | null> {
  if (!/^[A-Za-z0-9._-]{1,15}$/.test(iface)) return null;
  const read = async (name: string): Promise<number | null> => {
    const text = await readFile(join(sysClassNet, iface, 'statistics', name), 'utf8').catch(() => null);
    const value = text === null ? Number.NaN : Number(text.trim());
    return Number.isSafeInteger(value) ? value : null;
  };
  const [txPackets, rxPackets] = await Promise.all([read('tx_packets'), read('rx_packets')]);
  return txPackets === null || rxPackets === null ? null : { txPackets, rxPackets };
}

export type RebindOutcome = { ok: true; device: string; driver: string } | { ok: false; reason: string };

/**
 * Unbinds a USB device from its driver and binds it again.
 *
 * Refuses anything that is not a USB interface under `/sys/devices`: the path comes from the radio's own
 * report, and a write to `unbind` for the wrong device takes that device away — the Ethernet the device
 * is reached through, say. The interface comes back under the same name, because names here are derived
 * from the MAC address, and whatever is bound to its device unit (hostapd) has to be started again.
 */
export async function rebindUsb(devicePath: string): Promise<RebindOutcome> {
  const device = await realpath(devicePath).catch(() => null);
  if (device === null || !device.startsWith('/sys/devices/') || !/\/usb\d+\//.test(device)) {
    return { ok: false, reason: `${devicePath} is not a USB device` };
  }
  const name = basename(device);
  if (!/^\d+-[\d.]+:\d+\.\d+$/.test(name)) return { ok: false, reason: `${name} is not a USB interface` };
  const driverLink = await readlink(join(device, 'driver')).catch(() => null);
  if (driverLink === null) return { ok: false, reason: `${name} has no driver bound` };
  const driverDir = await realpath(join(device, 'driver')).catch(() => null);
  if (driverDir === null) return { ok: false, reason: `${name}: its driver cannot be resolved` };
  const driver = basename(driverDir);
  try {
    await writeFile(join(driverDir, 'unbind'), name);
    await writeFile(join(driverDir, 'bind'), name);
  } catch (error) {
    return { ok: false, reason: `${driver} would not rebind ${name}: ${String(error)}` };
  }
  return { ok: true, device: name, driver };
}
