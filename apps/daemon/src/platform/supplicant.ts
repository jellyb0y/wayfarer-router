/**
 * Wi-Fi client control and events through wpa_supplicant's D-Bus interface
 * (`fi.w1.wpa_supplicant1`).
 *
 * Why D-Bus and not the control socket: the control socket is a Unix **datagram** socket,
 * which this runtime does not support natively — reaching it needs a native module, and
 * this project has none by design. D-Bus also gives association state as signals instead of
 * a poll.
 *
 * What D-Bus does **not** give: signal strength, negotiated rate, modulation index or
 * channel width for the associated link. Those come from `iw` — see `wifi.ts`.
 *
 * One operational limit worth knowing before calling `scan`: a scan makes the radio leave
 * its channel, which interrupts an access point hosted on the same radio, visibly, for
 * every associated client. Gating that is `scanAllowed` in `wifi.ts`, which asks what the
 * radio is currently doing; nothing here can tell.
 */

import dbus from 'dbus-native';

const SERVICE = 'fi.w1.wpa_supplicant1';
const ROOT_PATH = '/fi/w1/wpa_supplicant1';
const ROOT_INTERFACE = 'fi.w1.wpa_supplicant1';
const INTERFACE_INTERFACE = 'fi.w1.wpa_supplicant1.Interface';
const BSS_INTERFACE = 'fi.w1.wpa_supplicant1.BSS';

export interface ScanResult {
  ssid: string | null;
  bssid: string | null;
  frequencyMhz: number | null;
  signalDbm: number | null;
  /** Security as advertised: `open`, `wep`, `wpa`, `wpa2`, `wpa3`, or a mix. */
  security: string[];
}

export interface SupplicantState {
  interfaceName: string;
  /** `disconnected`, `scanning`, `associating`, `completed`, `4way_handshake`… */
  state: string | null;
  currentSsid: string | null;
  currentBssid: string | null;
}

export type SupplicantEvent =
  | { kind: 'state'; state: SupplicantState }
  | { kind: 'scan-done'; interfaceName: string; success: boolean };

export interface SupplicantController {
  /** Whether wpa_supplicant is reachable over D-Bus at all. */
  available(): Promise<boolean>;
  /** Interfaces wpa_supplicant knows about, by name. */
  interfaces(): Promise<string[]>;
  state(interfaceName: string): Promise<SupplicantState | null>;
  /** Trigger a scan. Resolves when the request is accepted, not when results arrive. */
  scan(interfaceName: string): Promise<void>;
  /** Last known scan results for the interface. */
  scanResults(interfaceName: string): Promise<ScanResult[]>;
  watch(interfaceName: string, onEvent: (event: SupplicantEvent) => void): Promise<{ stop: () => void }>;
  close(): void;
}

type Loose = Record<string, unknown> & {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  $subscribe?: (signal: string, listener: (...args: unknown[]) => void) => PromiseLike<void>;
  $readProp?: (name: string) => PromiseLike<unknown>;
  $readAllProps?: () => PromiseLike<Record<string, unknown>>;
  $callMethod?: (name: string, args: unknown[]) => PromiseLike<unknown>;
};

export function createSupplicantController(): SupplicantController {
  const bus = dbus.systemBus();

  const root = async (): Promise<Loose> =>
    (await bus.getInterface(SERVICE, ROOT_PATH, ROOT_INTERFACE)) as unknown as Loose;

  const interfacePath = async (interfaceName: string): Promise<string> => {
    if (interfaceName.trim() === '') {
      throw new Error('wpa_supplicant was asked about an empty interface name');
    }
    const rootInterface = await root();
    return String(await callMethod(rootInterface, 'GetInterface', [interfaceName]));
  };

  const interfaceObject = async (interfaceName: string): Promise<Loose> =>
    (await bus.getInterface(SERVICE, await interfacePath(interfaceName), INTERFACE_INTERFACE)) as unknown as Loose;

  const controller: SupplicantController = {
    async available() {
      try {
        await root();
        return true;
      } catch {
        // A supplicant started without `-u` has no D-Bus interface at all. That is a
        // deployment fact to report, not an error to throw at a status view.
        return false;
      }
    },

    async interfaces() {
      try {
        const rootInterface = await root();
        const paths = asArray(plain(await readProp(rootInterface, 'Interfaces')));
        const names: string[] = [];
        for (const path of paths) {
          if (typeof path !== 'string') continue;
          const iface = (await bus.getInterface(SERVICE, path, INTERFACE_INTERFACE)) as unknown as Loose;
          const name = asString(plain(await readProp(iface, 'Ifname')));
          if (name) names.push(name);
        }
        return names;
      } catch {
        return [];
      }
    },

    async state(interfaceName) {
      try {
        const iface = await interfaceObject(interfaceName);
        const state = asString(plain(await readProp(iface, 'State')));
        const currentBssPath = asString(plain(await readProp(iface, 'CurrentBSS')));
        let currentSsid: string | null = null;
        let currentBssid: string | null = null;
        // `/` is wpa_supplicant's way of saying "no current BSS"; treating it as a path
        // produces an unknown-object error on every status read while disconnected.
        if (currentBssPath !== null && currentBssPath !== '/') {
          const bss = (await bus.getInterface(SERVICE, currentBssPath, BSS_INTERFACE)) as unknown as Loose;
          currentSsid = bytesToString(plain(await readProp(bss, 'SSID')));
          currentBssid = bytesToMac(plain(await readProp(bss, 'BSSID')));
        }
        return { interfaceName, state, currentSsid, currentBssid };
      } catch {
        return null;
      }
    },

    async scan(interfaceName) {
      const iface = await interfaceObject(interfaceName);
      // The argument is a dict of variants; `Type: active` is the only required entry.
      await callMethod(iface, 'Scan', [[['Type', ['s', 'active']]]]);
    },

    async scanResults(interfaceName) {
      const iface = await interfaceObject(interfaceName);
      const paths = asArray(plain(await readProp(iface, 'BSSs')));
      const results: ScanResult[] = [];
      for (const path of paths) {
        if (typeof path !== 'string' || path === '/') continue;
        try {
          const bss = (await bus.getInterface(SERVICE, path, BSS_INTERFACE)) as unknown as Loose;
          const properties = bss.$readAllProps ? (plain(await bss.$readAllProps()) as Record<string, unknown>) : {};
          results.push({
            ssid: bytesToString(plain(properties['SSID'])),
            bssid: bytesToMac(plain(properties['BSSID'])),
            frequencyMhz: asNumber(plain(properties['Frequency'])),
            signalDbm: asNumber(plain(properties['Signal'])),
            security: securityOf(properties),
          });
        } catch {
          // A BSS can disappear between listing and reading it. Skipping one is correct;
          // failing the whole scan because an access point went away is not.
        }
      }
      return results;
    },

    async watch(interfaceName, onEvent) {
      const iface = await interfaceObject(interfaceName);

      const onProperties = (...args: unknown[]): void => {
        const changed = plain(args[0]);
        if (!isRecord(changed)) return;
        if (!('State' in changed) && !('CurrentBSS' in changed)) return;
        void controller.state(interfaceName).then((state) => {
          if (state) onEvent({ kind: 'state', state });
        });
      };
      const onScanDone = (...args: unknown[]): void => {
        onEvent({ kind: 'scan-done', interfaceName, success: plain(args[0]) === true });
      };

      if (iface.$subscribe) {
        await iface.$subscribe('PropertiesChanged', onProperties);
        await iface.$subscribe('ScanDone', onScanDone);
      } else {
        iface.on('PropertiesChanged', onProperties);
        iface.on('ScanDone', onScanDone);
      }

      return {
        stop(): void {
          iface.removeListener?.('PropertiesChanged', onProperties);
          iface.removeListener?.('ScanDone', onScanDone);
        },
      };
    },

    close() {
      try {
        bus.connection.end();
      } catch {
        /* Already gone. */
      }
    },
  };

  return controller;
}

function securityOf(properties: Record<string, unknown>): string[] {
  const security: string[] = [];
  const rsn = plain(properties['RSN']);
  const wpa = plain(properties['WPA']);
  const keyMgmt = (value: unknown): string[] => {
    if (!isRecord(value)) return [];
    const list = asArray(plain(value['KeyMgmt']));
    return list.filter((entry): entry is string => typeof entry === 'string');
  };
  const rsnKeys = keyMgmt(rsn);
  const wpaKeys = keyMgmt(wpa);
  if (rsnKeys.some((k) => k.includes('sae'))) security.push('wpa3');
  if (rsnKeys.length > 0 && !security.includes('wpa3')) security.push('wpa2');
  if (wpaKeys.length > 0) security.push('wpa');
  if (security.length === 0) security.push(plain(properties['Privacy']) === true ? 'wep' : 'open');
  return security;
}

/** SSIDs arrive as a byte array, because an SSID is not required to be valid UTF-8. */
function bytesToString(value: unknown): string | null {
  const bytes = toByteArray(value);
  if (bytes === null) return null;
  return Buffer.from(bytes).toString('utf8');
}

function bytesToMac(value: unknown): string | null {
  const bytes = toByteArray(value);
  if (bytes === null || bytes.length !== 6) return null;
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

function toByteArray(value: unknown): number[] | null {
  if (Buffer.isBuffer(value)) return [...value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) return value as number[];
  return null;
}

async function readProp(iface: Loose, name: string): Promise<unknown> {
  if (iface.$readProp) return await iface.$readProp(name);
  return undefined;
}

async function callMethod(iface: Loose, name: string, args: unknown[]): Promise<unknown> {
  if (iface.$callMethod) return await iface.$callMethod(name, args);
  const method = iface[name];
  if (typeof method !== 'function') throw new Error(`D-Bus interface has no method ${name}`);
  return await (method as (...callArgs: unknown[]) => PromiseLike<unknown>)(...args);
}

function plain(value: unknown): unknown {
  const toPlain = (dbus as unknown as { toPlain?: (v: unknown) => unknown }).toPlain;
  return typeof toPlain === 'function' ? toPlain(value) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
