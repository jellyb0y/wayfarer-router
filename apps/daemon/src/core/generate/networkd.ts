/**
 * Generating `systemd-networkd` configuration.
 *
 * **`networkd` files, never netplan YAML.** Writing YAML would make our output the input of another
 * translator whose output we do not control, and put two layers between a mistake and its error
 * message. `networkd` is the invariant here; netplan is a distribution's choice.
 *
 * That leaves a real conflict on a device where a netplan-style manager already configures an
 * interface, and **the answer is not to overwrite.** An interface claimed elsewhere is refused by an
 * invariant check that names the file holding the claim. Detection belongs to this epic; taking an
 * interface over belongs to the epic that has a revert window to survive it going wrong. A planner
 * that quietly writes a second claim produces two sources disagreeing, and the one that takes effect
 * is whichever ran last — which is the lockout shape this whole design exists to avoid.
 */

import type { ProfileDocument, Uplink } from '@wayfarer/schemas';
import { generatedHeader, PATHS, type ManagedFile } from '../desired-state.ts';
import { parseCidr, uplinkUsesDhcp } from '../invariants.ts';

export interface NetworkdInput {
  profile: ProfileDocument;
  /** Interface names, resolved. */
  lanInterface: string | null;
  uplinkInterfaces: Map<string, string>;
}

/**
 * File name prefixes. `networkd` applies the first matching `.network` file in lexical order, so the
 * numbers are load-bearing rather than cosmetic: a more specific configuration must sort before a
 * general one, and anything the distribution ships usually starts at `80-`.
 */
const LAN_PREFIX = '10-wayfarer';
const UPLINK_PREFIX = '20-wayfarer';

export function generateNetworkd(input: NetworkdInput): ManagedFile[] {
  const files: ManagedFile[] = [];
  const { profile } = input;

  if (input.lanInterface !== null) {
    const parsed = parseCidr(profile.network.cidr);
    if (parsed === null) throw new Error(`network.cidr is not usable: ${profile.network.cidr}`);

    files.push({
      path: `${PATHS.networkdDir}/${LAN_PREFIX}-lan.network`,
      mode: 0o644,
      consumedBy: { kind: 'external', by: 'systemd-networkd' },
      purpose: `addressing for the local network on ${input.lanInterface}`,
      content: [
        generatedHeader('#', profile.meta.name).trimEnd(),
        '',
        '[Match]',
        `Name=${input.lanInterface}`,
        '',
        '[Network]',
        `Address=${profile.network.cidr}`,
        // Forwarding is enabled per interface rather than globally: a global sysctl is a setting that
        // outlives this profile and affects interfaces this device does not own.
        'IPForward=yes',
        // No DHCP client and no router advertisements on the interface this device serves: it is the
        // authority on this network, and accepting either would let a client reconfigure the router.
        'DHCP=no',
        'IPv6AcceptRA=no',
        'LinkLocalAddressing=no',
        '',
        '[Link]',
        // The access point brings the interface up itself; requiring it here would make the address
        // wait for a carrier that only appears once hostapd has started, and the DHCP server that
        // binds to the address would fail permanently in the meantime.
        'RequiredForOnline=no',
        '',
      ].join('\n'),
    });
  }

  for (const uplink of profile.uplinks) {
    if (uplink.enabled === false) continue;
    const interfaceName = input.uplinkInterfaces.get(uplink.id);
    if (interfaceName === undefined) continue;

    files.push({
      path: `${PATHS.networkdDir}/${UPLINK_PREFIX}-${uplink.id}.network`,
      mode: 0o644,
      consumedBy: { kind: 'external', by: 'systemd-networkd' },
      purpose: `addressing for uplink "${uplink.id}" on ${interfaceName}`,
      content: uplinkNetwork(profile, uplink, interfaceName),
    });
  }

  return files;
}

function uplinkNetwork(profile: ProfileDocument, uplink: Uplink, interfaceName: string): string {
  const lines: string[] = [];
  lines.push(generatedHeader('#', profile.meta.name).trimEnd());
  lines.push('');
  lines.push('[Match]');
  lines.push(`Name=${interfaceName}`);
  lines.push('');
  lines.push('[Network]');

  /*
   * One reading of the flag, for both kinds, from the module that also enforces it.
   *
   * Until 2026-09-21 the wireless branch below did not consult it at all: it wrote `DHCP=ipv4`
   * whatever the flag said, so turning automatic addressing off on a wireless uplink did not give
   * a static address — it silently dropped the failover metric, which lived inside the block the
   * flag suppressed. A setting that is contradicted rather than obeyed changes something nobody
   * asked about, and nothing reported it.
   */
  const dhcp = uplinkUsesDhcp(uplink);

  if (dhcp) {
    lines.push('DHCP=ipv4');
    lines.push('');
    lines.push('# IPv6 is not accepted on the uplink either. A router advertisement here would give the');
    lines.push('# device a routable v6 address and a default route, and traffic would leave outside the');
    lines.push('# tunnel — which is the leak the access-point side is already rejecting.');
    lines.push('IPv6AcceptRA=no');
    lines.push('');
    lines.push('[DHCPv4]');
    lines.push('# Routes come from the uplink, but the resolver does not: the core is the resolver, and');
    lines.push('# a pushed one written into the host configuration is a second answer nobody asked for.');
    lines.push('UseDNS=no');
    lines.push('UseDomains=no');
    // The metric carries the failover priority into the routing table, so the kernel's own choice of
    // default route matches the order the profile states.
    lines.push(`RouteMetric=${100 + uplink.priority}`);
  } else {
    // The same static block for a radio as for a wired port: once the supplicant has associated,
    // the network layer sees one interface and knows nothing about how it joined.
    const address = uplink.config.address;
    const gateway = uplink.config.gateway;
    lines.push('DHCP=no');
    lines.push('IPv6AcceptRA=no');
    if (address) lines.push(`Address=${address}`);
    if (gateway) lines.push(`Gateway=${gateway}`);
    lines.push('');
    lines.push('# A statically addressed uplink still gets the failover metric, so priority behaves the');
    lines.push('# same way whether addresses are learned or stated. The metric is written whether or not');
    lines.push('# a gateway was given: a route section that appears only alongside a gateway is a metric');
    lines.push('# that disappears with a field nobody connected to failover.');
    lines.push('[Route]');
    if (gateway) lines.push(`Gateway=${gateway}`);
    lines.push(`Metric=${100 + uplink.priority}`);
  }

  lines.push('');
  lines.push('[Link]');
  lines.push('# An uplink that is not present must not hold up boot. A device with no uplink is a valid,');
  lines.push('# expected state, and waiting for one would delay the access point that makes the device');
  lines.push('# reachable in the first place.');
  lines.push('RequiredForOnline=no');
  lines.push('');

  return lines.join('\n');
}

/**
 * The sysctl settings the generated state needs.
 *
 * Kept as data rather than written into a file, so the reconciler applies them in the fixed order —
 * after the network configuration has settled and **before** the firewall, because a forwarding
 * setting that arrives after the ruleset means the first packets through are dropped by a rule whose
 * premise is not yet true.
 */
export function sysctlFor(profile: ProfileDocument, lanInterface: string | null): {
  key: string;
  value: string;
  reason: string;
}[] {
  const settings: { key: string; value: string; reason: string }[] = [];

  if (lanInterface !== null) {
    settings.push({
      key: 'net.ipv4.ip_forward',
      value: '1',
      reason: 'clients on the local network reach the internet through this device',
    });
  }

  /**
   * Reverse-path filtering must be **loose**, or a tunnel bound to its own interface receives nothing.
   *
   * A tunnel reached by `bind_interface` has its socket tied to one interface, and under *strict* reverse
   * path filtering (`1`) the kernel discards the replies: the return packet arrives on the tunnel
   * interface while the route back to that source would be chosen elsewhere. The tunnel comes up, the
   * route is right, and the resource never answers — which reads as a broken tunnel and is not one.
   *
   * `2` (loose) rather than `0`: loose still drops a packet whose source has **no** route back at all,
   * which is worth keeping. Turning the check off entirely buys nothing extra here.
   *
   * Set on `all` because the effective value is the numeric maximum of `conf.all` and the interface's own,
   * and `2` is numerically above strict `1` — so asserting it on `all` makes the outcome loose whatever an
   * individual interface says, including interfaces that do not exist yet. `default` is set as well, since
   * that is what a tunnel interface created later inherits. Two keys, because neither alone covers both
   * the interfaces that exist now and the ones a tunnel will create.
   *
   * **Measured on the bench board, 2026-09-21, and this is why it is here:** every interface already
   * reported `2`, and **nothing set it** — `/etc/sysctl.d` contained no `rp_filter` line and neither did
   * `sysctl.conf`. It was the operating-system image's default (`conf.default = 2`, `conf.all = 0`). So the
   * device depended on a property no part of this repository established, and on an image shipping the
   * common default of `1` every interface-bound tunnel would have failed in the way described above. A
   * dependency that happens to hold is not a configured dependency; it is one nobody has noticed yet.
   */
  settings.push({
    key: 'net.ipv4.conf.all.rp_filter',
    value: '2',
    reason: 'a tunnel bound to its own interface would otherwise have its replies discarded by the kernel',
  });
  settings.push({
    key: 'net.ipv4.conf.default.rp_filter',
    value: '2',
    reason: 'so an interface a tunnel creates later inherits the same setting',
  });

  if (profile.firewall.ipv6 === 'block' && lanInterface !== null) {
    settings.push({
      key: `net.ipv6.conf.${lanInterface}.accept_ra`,
      value: '0',
      reason: 'no router advertisement is accepted on the interface this device serves',
    });
    settings.push({
      key: `net.ipv6.conf.${lanInterface}.disable_ipv6`,
      value: '1',
      reason:
        'IPv6 is blocked at the access point: a v6 address on this interface is one clients can ' +
        'reach the internet through, outside the tunnel',
    });
  }

  return settings;
}
