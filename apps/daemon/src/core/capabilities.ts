/**
 * What this device can do, what it cannot, and the exact command that closes each gap.
 *
 * ## Why the command matters more than the report
 *
 * "hostapd is not installed" is a fact an operator can act on only if they already know what to do
 * about it. The report is worth writing because of the second half: a gap with no stated remedy is a
 * message that makes somebody search, and the search is where the wrong answer comes from.
 *
 * ## The command is a measured fact, not a template
 *
 * The obvious implementation writes `apt install <binary>` and is wrong for half of these. Measured on
 * the bench board, 2026-09-21, with `dpkg -S` against the resolved path of each installed binary:
 *
 * ```
 * hostapd         /usr/sbin/hostapd           hostapd
 * hostapd_cli     /usr/sbin/hostapd_cli       hostapd        <- same package, different binary
 * wpa_supplicant  /usr/sbin/wpa_supplicant    wpasupplicant  <- no underscore
 * dnsmasq         /usr/sbin/dnsmasq           dnsmasq-base   <- not "dnsmasq"
 * nft             /usr/sbin/nft               nftables
 * iw              /usr/sbin/iw                iw
 * ip              /usr/sbin/ip                iproute2
 * openvpn         /usr/sbin/openvpn           openvpn
 * sing-box        /usr/local/bin/sing-box     not from a package
 * systemd-run     /usr/bin/systemd-run        systemd
 * ```
 *
 * Five of the ten differ from the binary name, and two are not in the distribution at all. A generated
 * command would therefore have been confidently wrong most of the time — and a wrong instruction is
 * worse than none, because somebody runs it, gets "no such package", and concludes the report is broken
 * rather than that the package is named differently.
 *
 * `sing-box` and `xray` are deliberately not `apt` lines: they are release binaries, and **this daemon
 * never downloads executables**. The remedy names the step and leaves the fetching to a person.
 */

import type { Inventory, RadioInventory } from '../inventory/index.ts';

/** How a missing binary is obtained, as a command that can be copied. */
export interface Remedy {
  /** Exactly what to run, or null when there is nothing to run and a person must decide. */
  command: string | null;
  /** Said in words when the command needs context, or when there is no command. */
  note?: string;
}

/**
 * Binary name to the package that ships it, measured rather than derived from the name.
 *
 * Absent from this table means "not obtainable with the package manager", which is a different answer
 * from "not installed" and is reported as one.
 */
const PACKAGE_FOR: Record<string, string> = {
  hostapd: 'hostapd',
  hostapd_cli: 'hostapd',
  wpa_supplicant: 'wpasupplicant',
  dnsmasq: 'dnsmasq-base',
  nft: 'nftables',
  iw: 'iw',
  ip: 'iproute2',
  openvpn: 'openvpn',
  'systemd-run': 'systemd',
};

/** The ones that are release binaries, with what to do instead of an install command. */
const NOT_PACKAGED: Record<string, string> = {
  'sing-box':
    'sing-box is a release binary rather than a distribution package. Put it at /usr/local/bin/sing-box ' +
    'and make it executable. This daemon never downloads executables, so fetching it is a deliberate act ' +
    'by a person who chose the version.',
  xray: 'xray is a release binary rather than a distribution package. Put it on PATH and make it executable.',
  'ck-client':
    'ck-client is a release binary rather than a distribution package. Put it on PATH — /usr/local/bin/ck-client ' +
    'is where it was found on the bench board — and make it executable.',
};

export function remedyFor(binary: string): Remedy {
  const pkg = PACKAGE_FOR[binary];
  if (pkg !== undefined) {
    return {
      command: `apt-get install --no-install-recommends ${pkg}`,
      ...(pkg === binary ? {} : { note: `the package is called ${pkg}, not ${binary}` }),
    };
  }
  const note = NOT_PACKAGED[binary];
  return { command: null, ...(note === undefined ? {} : { note }) };
}

export type CapabilityState = 'available' | 'missing' | 'unknown';

export interface Capability {
  /** A stable key, for a client that wants to act on one. */
  id: string;
  /** What the operator gets, in their terms rather than ours. */
  title: string;
  state: CapabilityState;
  /** What is missing, when anything is. */
  missing: string[];
  /** One remedy per missing piece, in the same order. */
  remedies: Remedy[];
  /** Why it is `unknown`, which is never the same as `missing`. */
  detail?: string;
}

/**
 * Whether any radio reports being able to take a role.
 *
 * Three-valued on purpose. With no radios detected at all the honest answer is *unknown* — the driver
 * may not have loaded, the dongle may be unplugged, and reporting "this device cannot host an access
 * point" would be a statement about hardware from a device that has not managed to look at its hardware.
 */
function radioCan(radios: RadioInventory[], role: 'AP' | 'managed'): CapabilityState {
  if (radios.length === 0) return 'unknown';
  // Read from what the driver reported, not from any judgement of ours: `reported` is the raw list.
  return radios.some((radio) => radio.reported.interfaceModes.includes(role)) ? 'available' : 'missing';
}

export function describeCapabilities(inventory: Inventory): Capability[] {
  const byName = new Map(inventory.binaries.map((entry) => [entry.name, entry]));
  const absent = (names: string[]): string[] => names.filter((name) => byName.get(name)?.present !== true);

  /** A capability that needs only binaries. */
  const fromBinaries = (id: string, title: string, needs: string[]): Capability => {
    const missing = absent(needs);
    return {
      id,
      title,
      state: missing.length === 0 ? 'available' : 'missing',
      missing,
      remedies: missing.map(remedyFor),
    };
  };

  const capabilities: Capability[] = [
    fromBinaries('firewall', 'Block traffic, translate addresses, and enforce a kill-switch', ['nft']),
    fromBinaries('addressing', 'Read and set interfaces, addresses and routes', ['ip']),
    fromBinaries('dhcp', 'Hand out addresses to clients on the local network', ['dnsmasq']),
    fromBinaries('radio-capabilities', 'Report what the radios can actually do', ['iw']),
    fromBinaries('tunnels', 'Run tunnels of the kinds the data plane speaks natively', ['sing-box']),
    fromBinaries('openvpn', 'Run OpenVPN tunnels', ['openvpn']),
    fromBinaries('external-client', 'Run a tunnel through another client on a local SOCKS port', ['xray']),
    fromBinaries('revert-timer', 'Undo a network change by itself if nobody confirms it', ['systemd-run']),
  ];

  /*
   * The two that need hardware as well as software, and therefore have an `unknown` answer.
   *
   * Reported as one capability each rather than as a binary list plus a radio list, because the operator's
   * question is "can this device host an access point?" — and answering it with two half-answers in
   * different places is how somebody installs hostapd on a board whose radio cannot do AP at all.
   */
  const apBinaries = absent(['hostapd', 'hostapd_cli']);
  const apRadio = radioCan(inventory.radios, 'AP');
  capabilities.push({
    id: 'access-point',
    title: 'Host a wireless network for clients',
    state: apBinaries.length > 0 ? 'missing' : apRadio,
    missing: [...apBinaries, ...(apRadio === 'missing' ? ['a radio that can host an access point'] : [])],
    remedies: [
      ...apBinaries.map(remedyFor),
      ...(apRadio === 'missing'
        ? [
            {
              command: null,
              note:
                'No detected radio reports the AP mode. This is a property of the driver, not a setting: ' +
                'a USB radio that supports it is the only fix, and the radio page lists what each one reports.',
            },
          ]
        : []),
    ],
    ...(apRadio === 'unknown' && apBinaries.length === 0
      ? {
          detail:
            'No radios were detected, so this cannot be answered. That is not the same as "no radio can ' +
            'do it" — a driver may not have loaded, or a dongle may be unplugged.',
        }
      : {}),
  });

  const staBinaries = absent(['wpa_supplicant']);
  const staRadio = radioCan(inventory.radios, 'managed');
  capabilities.push({
    id: 'wifi-uplink',
    title: 'Reach the internet over someone else’s wireless network',
    state: staBinaries.length > 0 ? 'missing' : staRadio,
    missing: [...staBinaries, ...(staRadio === 'missing' ? ['a radio that can join a network'] : [])],
    remedies: [
      ...staBinaries.map(remedyFor),
      ...(staRadio === 'missing'
        ? [{ command: null, note: 'No detected radio reports the managed mode.' }]
        : []),
    ],
    ...(staRadio === 'unknown' && staBinaries.length === 0
      ? { detail: 'No radios were detected, so this cannot be answered.' }
      : {}),
  });

  return capabilities;
}

/**
 * Whether a binary the inventory found is one this build knows how to obtain.
 *
 * Exported so a test can hold the two lists against each other. A binary the inventory looks for but
 * which appears in neither table would be reported as missing with no remedy at all — the report would
 * name a gap and say nothing about it, which is the failure this whole module exists to avoid.
 */
export function hasRemedyFor(binary: string): boolean {
  return binary in PACKAGE_FOR || binary in NOT_PACKAGED;
}
