/**
 * Generating the nftables ruleset.
 *
 * Every rule below traces to a measurement, and the two structural decisions are the ones worth
 * reading first.
 *
 * **Only our own table is deleted and recreated, in one load.** Never `flush ruleset`. Measured on
 * the bench board: the live ruleset holds four tables in the `inet` family and at least two belong
 * to other software — a proxy core creates its own when it manages redirection. A global flush
 * removes it and silently disables tunnelling on any restart of the firewall service. The
 * `table … {}` / `delete table` / `table … { … }` idiom recreates exactly one table and leaves the
 * rest untouched; the empty declaration first is what makes the delete succeed on a device where the
 * table does not exist yet.
 *
 * **The kill-switch rejects only new connections.** Measured at idle with clients connected: zero
 * packets in the `new` state against 460 established. So rejecting only `new` closes the leak and
 * tears nothing down — with a healthy tunnel there are no new connections on that path anyway,
 * because redirection has already moved them, and with a dead tunnel none are created. `reject`
 * rather than `drop`, so an application fails at once and retries instead of hanging in a timeout.
 */

import type { ProfileDocument } from '@wayfarer/schemas';
import { DEVICE_MARK } from '@wayfarer/schemas';
import { generatedHeader, OWNED_TABLE } from '../desired-state.ts';
import { networkCidr } from '../invariants.ts';

/** The mark as nftables wants it written. One definition, three consumers. */
const MARK = `0x${DEVICE_MARK.toString(16)}`;

export interface FirewallInput {
  profile: ProfileDocument;
  /** The interface the access point runs on, or null when there is none. */
  lanInterface: string | null;
  /** Uplink interfaces, in failover order. */
  wanInterfaces: string[];
  /** The port the management interface listens on. */
  managementPort: number;
  /** Ports time synchronisation uses. Configuration, not a constant at the call site. */
  timePorts: number[];
}

export function generateFirewall(input: FirewallInput): string {
  const { profile, lanInterface, wanInterfaces, managementPort } = input;
  const lines: string[] = [];
  const lan = lanInterface;
  const wan = wanInterfaces;

  lines.push(generatedHeader('#', profile.meta.name));
  lines.push('#');
  lines.push('# Only the table below is touched. Tables belonging to other software on this device —');
  lines.push('# including the one a proxy core creates for redirection — are left exactly as they are.');
  lines.push('');

  // Declared empty, then deleted, then defined. The empty declaration is what makes the delete
  // succeed on a device where the table has never existed: deleting a missing table is an error that
  // aborts the whole load.
  lines.push(`table ${OWNED_TABLE.family} ${OWNED_TABLE.name} {}`);
  lines.push(`delete table ${OWNED_TABLE.family} ${OWNED_TABLE.name}`);
  lines.push('');
  lines.push(`table ${OWNED_TABLE.family} ${OWNED_TABLE.name} {`);

  /* ── sets ─────────────────────────────────────────────────────────────────────────────── */

  // Only IPv4 reaches a rule, and that is not a silent filter any more: an IPv6 entry raises a warning
  // naming it and saying it is redundant because IPv6 is rejected at the access point, and an
  // unparseable one is an error. By the time generation runs, every dropped entry has been explained.
  const blockedV4 = profile.firewall.blockedEndpoints
    .map((entry) => entry.ipCidr)
    .filter((value): value is string => typeof value === 'string' && value !== '' && !value.includes(':'));
  const blockedPorts = [
    ...new Set(profile.firewall.blockedEndpoints.flatMap((entry) => entry.ports ?? [])),
  ].sort((a, b) => a - b);

  if (blockedV4.length > 0) {
    lines.push('  # Address-discovery and probe endpoints, from firewall.blockedEndpoints. A named set');
    lines.push('  # rather than inline rules so the list can be updated without regenerating the ruleset.');
    lines.push('  set blocked_v4 {');
    lines.push('    type ipv4_addr');
    lines.push('    flags interval');
    lines.push(`    elements = { ${blockedV4.join(', ')} }`);
    lines.push('  }');
    lines.push('');
  }

  /* ── input ────────────────────────────────────────────────────────────────────────────── */

  lines.push('  chain input {');
  lines.push('    type filter hook input priority filter; policy accept;');
  lines.push('    ct state established,related accept');
  lines.push('    iif lo accept');
  lines.push('');
  /*
   * Which interfaces the control panel and API answer on, enforced here as well as by the bind address.
   *
   * Two layers for one decision, on purpose: a bind address is what makes the socket exist, and an input
   * rule is what survives a profile change that alters which interface is which. Both are derived from
   * `managementInterfaces` so they cannot disagree — this project has already been bitten once by a rule
   * enforced at one door and not the other.
   */
  /*
   * Only the *decision* comes from the profile here; the interface names come from `input`, already
   * resolved. An earlier version of this took the names from `managementInterfaces` too and compared them
   * against `wan` — comparing the profile's *expected* name (`wfwan0`, which is only correct when the
   * uplink is pinned) against the name that actually resolved (`wlan0` when it is not). Every unpinned
   * uplink therefore fell through to the reject branch while the profile asked for the opposite. Caught by
   * the golden fixtures, which is what they are for.
   */
  const onUplinkNetwork = profile.services?.management?.onUplinkNetwork !== false;

  if (lan !== null) {
    lines.push('    # The access point always reaches the management interface, even with the kill-switch');
    lines.push('    # active: that is an input decision and the kill-switch acts on forward. Written as an');
    lines.push('    # explicit rule so the guarantee is in the ruleset rather than inferred.');
    lines.push(`    iifname "${lan}" tcp dport ${managementPort} accept`);
  }

  for (const interfaceName of wan) {
    lines.push('');
    if (onUplinkNetwork) {
      lines.push('    # Reachable from the network this device is a CLIENT of, because the profile asks for');
      lines.push('    # it (services.management.onUplinkNetwork). What that exposes and to whom is stated');
      lines.push('    # where the choice is made; behind it stand password authentication, a lockout');
      lines.push('    # counted in uptime rather than wall-clock time, and an API that is off until a');
      lines.push('    # human turns it on.');
      lines.push(`    iifname "${interfaceName}" tcp dport ${managementPort} accept`);
    } else {
      lines.push('    # Not reachable from the uplink: the profile turned that off. Rejected rather than');
      lines.push('    # dropped, so a client on that network is told at once instead of timing out.');
      lines.push(`    iifname "${interfaceName}" tcp dport ${managementPort} reject with tcp reset`);
    }
  }

  /*
   * A tunnel is never a management surface, and this rule is not conditional on any setting.
   *
   * Without it the surface would be decided only by which interfaces are *named* — and a tunnel device
   * appears after an apply, is not named by anything here, and would inherit the chain's accept policy.
   * Whatever is at the far end of a tunnel is not somebody this device should accept management traffic
   * from, whichever network the operator has chosen to trust.
   */
  lines.push('');
  lines.push('    # A tunnel is never a management surface. Not a setting, and deliberately not one.');
  lines.push(`    iifname "tun*" tcp dport ${managementPort} reject with tcp reset`);
  lines.push(`    iifname "wg*" tcp dport ${managementPort} reject with tcp reset`);

  if (profile.firewall.ipv6 === 'block' && lan !== null) {
    lines.push('');
    lines.push('    # IPv6 is rejected at the access point, not merely left unrouted. A tunnel carrying');
    lines.push('    # only IPv4 while IPv6 reaches the internet directly leaks the real address of every');
    lines.push('    # client, and invisibly, because pages still load. Rejected rather than dropped so a');
    lines.push('    # client falls back to IPv4 at once instead of waiting out a timeout.');
    lines.push(`    iifname "${lan}" meta nfproto ipv6 icmpv6 type { nd-router-advert, nd-router-solicit } drop`);
    lines.push(`    iifname "${lan}" meta nfproto ipv6 reject with icmpv6 admin-prohibited`);
  }
  lines.push('  }');
  lines.push('');

  /* ── forward ──────────────────────────────────────────────────────────────────────────── */

  lines.push('  chain forward {');
  lines.push('    type filter hook forward priority filter; policy accept;');
  lines.push('');
  lines.push('    # Clamp the segment size to the path MTU. A tunnel lowers the effective MTU and the');
  lines.push('    # symptom of not clamping is that small requests work and large ones hang, which is');
  lines.push('    # diagnosed as "the internet is slow" rather than as a configuration fault.');
  lines.push('    tcp flags syn tcp option maxseg size set rt mtu');
  lines.push('');

  if (profile.firewall.ipv6 === 'block') {
    lines.push('    # See the input chain: rejected, not dropped, and at the access point.');
    lines.push('    meta nfproto ipv6 reject with icmpv6 admin-prohibited');
    lines.push('');
  }

  if (blockedV4.length > 0) {
    const protocols = new Set(
      profile.firewall.blockedEndpoints
        .filter((entry) => entry.ipCidr)
        .map((entry) => entry.protocol ?? 'any'),
    );
    for (const protocol of protocols) {
      const match = protocol === 'any' ? '' : `meta l4proto ${protocol} `;
      const ports = blockedPorts.length > 0 && protocol !== 'any' ? `th dport { ${blockedPorts.join(', ')} } ` : '';
      lines.push(`    ${match}${ports}ip daddr @blocked_v4 reject`);
    }
    lines.push('');
  }

  if (profile.firewall.killSwitch && lan !== null && wan.length > 0) {
    lines.push('    # The kill-switch. New connections only — measured at idle with clients connected:');
    lines.push('    # 0 packets in the new state against 460 established, so this closes the leak and');
    lines.push('    # breaks nothing that is already running. The local network itself is exempt: traffic');
    lines.push('    # from clients to the LAN does not go through the tunnel and must not be blocked.');
    for (const interfaceName of wan) {
      // The **network**, not the device's own address with a prefix on it. `nft` happens to accept the
      // host form and normalise it, which is the kind of luck that stops being luck in a different field.
      lines.push(
        `    iifname "${lan}" oifname "${interfaceName}" ip daddr != ${networkCidr(profile.network.cidr) ?? profile.network.cidr} ct state new reject`,
      );
    }
    lines.push('');
  } else if (!profile.firewall.killSwitch) {
    lines.push('    # The kill-switch is off. With no tunnel configured yet, a kill-switch on makes a');
    lines.push('    # working device look broken, so it is a switch rather than a policy baked in.');
    lines.push('');
  }
  lines.push('  }');
  lines.push('');

  /* ── output: time synchronisation, and the device's own mark ──────────────────────────── */

  lines.push('  chain output {');
  lines.push('    type route hook output priority mangle; policy accept;');
  lines.push('');
  if (profile.firewall.ntpBypass && input.timePorts.length > 0) {
    lines.push('    # Time synchronisation is labelled by DESTINATION PORT and not by user, and the policy');
    lines.push('    # rule that acts on it is installed by the firewall unit using the same ports.');
    lines.push('    # By port because the time service does not run as root, so a rule written in');
    lines.push('    # terms of the root user misses it entirely — and this failure is self-locking:');
    lines.push('    # correcting a wrong clock needs a time query, and transports that authenticate on a');
    lines.push('    # timestamp refuse to connect while the clock is wrong. Every tunnel then looks');
    lines.push('    # broken while every direct connection works.');
    lines.push(`    udp dport { ${input.timePorts.join(', ')} } meta mark set ${MARK}`);
    lines.push(`    tcp dport { ${input.timePorts.join(', ')} } meta mark set ${MARK}`);
    lines.push('');
  }
  lines.push("    # A label on the device's own traffic. **It does not route anything by itself, and the");
  lines.push('    # routing is not done here.** Keeping the tunnel off this traffic is the job of the policy');
  lines.push('    # rules the firewall unit installs, which select on user and destination port.');
  lines.push('    #');
  lines.push('    # That split is a measurement, not a preference. A policy rule matching this mark was tried');
  lines.push('    # and broke the device\'s own networking outright: the source address is chosen on the FIRST');
  lines.push('    # route lookup, before this chain runs and therefore before the mark exists, so the packet');
  lines.push('    # already carried the tunnel\'s own address — and the reroute a mark triggers keeps a source');
  lines.push('    # that is still local. Packets left the physical interface with an address the upstream');
  lines.push('    # cannot reply to. A mark cannot fix a source that has already been chosen.');
  lines.push('    #');
  lines.push('    # It is kept because it is a true statement about the packet that costs nothing, and the');
  lines.push('    # proxy core is free to use it. Nothing in this project routes on it.');
  lines.push(`    meta skuid 0 meta mark set ${MARK}`);
  lines.push('  }');
  lines.push('');

  /* ── nat ──────────────────────────────────────────────────────────────────────────────── */

  lines.push('  chain postrouting {');
  lines.push('    type nat hook postrouting priority srcnat; policy accept;');
  for (const interfaceName of wan) {
    lines.push(`    oifname "${interfaceName}" masquerade`);
  }
  if (wan.length === 0) {
    lines.push('    # No uplink is configured, which is a valid and expected state: there is nothing to');
    lines.push('    # translate towards. The chain exists so the ruleset shape does not change when one');
    lines.push('    # is added, which keeps the diff between the two states small and readable.');
  }
  lines.push('  }');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}
