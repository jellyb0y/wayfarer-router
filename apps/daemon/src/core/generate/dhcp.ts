/**
 * Generating the address server's configuration.
 *
 * **This device answers DNS for its clients, and forwards every query through the proxy core.**
 *
 * ## Correction: the earlier design advertised a resolver that did not exist
 *
 * An earlier revision set `port=0` — disabling this resolver entirely — and advertised this device's own
 * address as option 6, on the stated basis that "the proxy core answers queries instead". **It does not,
 * and it never could.**
 *
 * The core's only inbound is a `tun` with `auto_route`, which captures traffic being **forwarded** through
 * the device. A query a client sends *to the device's own address* is input, not forwarded, so `auto_route`
 * never sees it and the `hijack-dns` route rule never fires. Nothing was listening on port 53 at all.
 *
 * Measured on the bench board with a real client connected: an associated, authorised phone with a valid
 * lease, a default route, and a resolver address that answered nothing. From the phone that is *"no site
 * loads"* — which is exactly what it looked like, and it reached a user.
 *
 * The two reasons the earlier design gave were both good, and this arrangement keeps them:
 *
 * * **No second cache.** `cache-size=0`. Two caches in a row is a trap: a stale answer arrives from a
 *   layer somebody forgot exists and the usual conclusion is that the tunnel is broken.
 * * **The core still sees every query.** That is the part worth understanding: this resolver forwards
 *   upstream, and `dnsmasq` drops privileges to `nobody`, so its own packets are **not** marked as the
 *   device's own traffic — they are captured by the tun exactly like a client's, hijacked by the core's
 *   DNS rule, and resolved under whatever tunnel policy is in force. Nothing is removed from the routing
 *   rules' view, and nothing leaks past the tunnel.
 *
 * So the consequence the earlier text stated honestly still holds — **with the core stopped, clients lose
 * name resolution** — because this resolver's own upstream query depends on the core. Adding a fallback
 * would be a leak, and whether the device should fail open is a policy question that belongs with the rest
 * of the policy.
 */

import type { ProfileDocument } from '@wayfarer/schemas';
import { generatedHeader } from '../desired-state.ts';
import { parseCidr } from '../invariants.ts';

export interface DhcpInput {
  profile: ProfileDocument;
  interfaceName: string;
  /** Where leases are kept. On its own path so a factory reset can remove it deliberately. */
  leaseFile?: string;
}

export function generateDhcp(input: DhcpInput): string {
  const { profile, interfaceName } = input;
  const parsed = parseCidr(profile.network.cidr);
  if (parsed === null) throw new Error(`network.cidr is not usable: ${profile.network.cidr}`);

  const lines: string[] = [];
  lines.push(generatedHeader('#', profile.meta.name).trimEnd());
  lines.push('');

  lines.push('# Read only this file. Include-directory scanning is not used, so a stray file in a');
  lines.push('# shared directory cannot reach this instance — this device shares a namespace with');
  lines.push('# nothing.');
  lines.push('conf-dir=');
  lines.push('');

  lines.push('# This device answers DNS for its clients, on this interface only, and forwards every query');
  lines.push('# upstream. dnsmasq drops privileges to `nobody`, so its upstream packets are NOT marked as');
  lines.push("# the device's own traffic: the core's tun captures them, its DNS rule hijacks them, and they");
  lines.push('# resolve under whatever tunnel policy is in force. Measured: the query traverses tun0 and');
  lines.push('# comes back answered. See the generator.');
  lines.push('#');
  lines.push('# An earlier revision set `port=0` here and advertised this device as the resolver anyway, on');
  lines.push('# the basis that the core would answer. It cannot: the core captures FORWARDED traffic, and a');
  lines.push("# query addressed to this device is input. Clients had an address, a route, and a resolver");
  lines.push('# that answered nothing.');
  lines.push('no-resolv');
  lines.push(`server=${profile.dns.overTunnel}`);
  lines.push('');
  lines.push('# No second cache. A stale answer from a layer nobody remembers is read as a broken tunnel.');
  lines.push('cache-size=0');

  if (profile.dns.logQueries) {
    lines.push('');
    lines.push('# Query logging is ON because this profile asks for it. Every name every client looks up is');
    lines.push('# written to the journal with the address that asked. That is a record of what the people on');
    lines.push('# this network were doing, so it is off unless somebody turned it on to answer a question.');
    lines.push('log-queries');
  }
  lines.push('');

  lines.push('# Bound to one interface, and bind-interfaces rather than bind-dynamic: with several');
  lines.push('# services on this device, a wildcard bind is how two of them end up fighting over the');
  lines.push('# same socket and the loser fails at start-up rather than at configuration time.');
  lines.push(`interface=${interfaceName}`);
  lines.push('bind-interfaces');
  lines.push('except-interface=lo');
  lines.push('');

  if (!profile.network.dhcp.enabled) {
    lines.push('# Address service is disabled in this profile: clients configure their own addresses.');
    lines.push('dhcp-range=');
    return `${lines.join('\n')}\n`;
  }

  const netmask = maskFor(parsed.prefixLength);
  lines.push(
    `dhcp-range=${profile.network.dhcp.from},${profile.network.dhcp.to},${netmask},${profile.network.dhcp.leaseHours}h`,
  );
  lines.push('');
  lines.push(`# Option 3: the router. Option 6: the resolver — this device, where the core answers.`);
  lines.push(`dhcp-option=3,${parsed.address}`);
  lines.push(`dhcp-option=6,${parsed.address}`);
  lines.push('');

  if (profile.firewall.ipv6 === 'block') {
    lines.push('# No IPv6 is offered at all. IPv6 reaching the internet directly while the tunnel');
    lines.push('# carries only IPv4 leaks the real address of every client, and it does so invisibly');
    lines.push('# because pages still load. The firewall rejects it as well; this stops it being');
    lines.push('# offered in the first place.');
    lines.push('dhcp-option=option6:dns-server');
    lines.push('ra-param=*,0,0');
    lines.push('');
  }

  lines.push(`dhcp-leasefile=${input.leaseFile ?? '/var/lib/wayfarer/dhcp.leases'}`);
  lines.push('dhcp-authoritative');
  lines.push('');
  lines.push('# A client that asks for a hostname gets no domain appended: this device serves one');
  lines.push('# subnet with no local naming, and a made-up domain suffix is a name that resolves');
  lines.push('# somewhere unexpected the moment the device is behind a real one.');
  lines.push('expand-hosts');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

/** Dotted-quad netmask for a prefix length. Computed, because a table of 33 entries is a table. */
export function maskFor(prefixLength: number): string {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 0xff).join('.');
}
