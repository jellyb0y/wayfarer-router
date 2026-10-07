/**
 * What kind of channel each interface is, decided from what the kernel reports.
 *
 * This answers one question for the binding policy — *may the management surface listen here?* — and it
 * answers it in words a person can act on. It is pure: it interprets readings the platform layer took
 * and performs no I/O of its own, which is why it lives here rather than beside the OS.
 *
 * ## Why `unknown` is a value and not a failure
 *
 * Three verdicts, not two. "This is a tunnel" and "I could not tell what this is" both end in no
 * binding, and they are **different lines in the log and different actions for the person reading it**:
 * the first is the policy working, the second is a question nobody has answered yet. Collapsing them
 * would produce a device that reports a confident refusal about an interface it never recognised, which
 * is the shape this project has already been caught by — a reading whose absence is indistinguishable
 * from a real answer.
 *
 * ## Why a tunnel is decided by its shape, not by our list of tunnels
 *
 * The profile names the tunnels this device creates. It says nothing about tunnels created by anything
 * else, and the owner's prohibition covers those identically — a route into somebody's network is a
 * route into somebody's network whoever built it. Measured on the bench board, 2026-09-21: a `tun0`
 * carrying `172.19.0.1/30`, created outside this profile. A classifier consulting only the profile's
 * own list calls that interface ordinary and offers to listen on it.
 *
 * So the verdict comes from the link: `ip` reports `link/none` for a tun device and names a `kind` for
 * every virtual link it understands. Our own tunnel names are still accepted, as a second source rather
 * than the only one.
 *
 * ## Why telling a wire from a radio needs the radio list
 *
 * Linux reports `ether` for a wireless interface exactly as it does for a wired port; nothing in a link
 * distinguishes them. The answer exists — the driver knows — but it is a *reading*, taken by the
 * platform layer, not something derivable here. So it is an input, and when it is absent an `ether`
 * link this profile does not mention becomes `unknown` rather than `wired`.
 *
 * Guessing from the name was considered and rejected: names like `end0` and `wlx…` are conventions of a
 * particular userspace, this repository hardcodes nothing about the hardware, and the failure mode of a
 * wrong guess is the management surface listening on a radio nobody configured.
 */

import type { NetLink } from '../platform/parse/ip-json.ts';

export type ChannelClass = 'loopback' | 'wired' | 'accessPoint' | 'wirelessUplink' | 'tunnel' | 'unknown';

export interface ClassifiedInterface {
  name: string;
  class: ChannelClass;
  /** Why, in words. This reaches the refusal the operator reads, so it names the evidence. */
  why: string;
}

export interface ClassifyInput {
  links: NetLink[];
  /** What the active profile says it manages. Null when there is no active profile. */
  managementSurfaces: { accessPoint: string | null; uplinks: string[] } | null;
  /** Interfaces this profile's own tunnels create. A second source, never the only one. */
  tunnelInterfaces: string[];
  /**
   * Interfaces the driver reports as radios, as the platform layer enumerated them.
   *
   * **Null is a real answer and not a default**: it means nobody asked the driver. Every `ether` link
   * this profile does not otherwise account for is then `unknown`, because a wire and a radio are
   * indistinguishable from a link alone and this is not a question worth guessing at.
   *
   * **A failed enumeration must arrive here as `null`, never as `[]`.** The two are different claims:
   * `[]` says the driver was asked and reported no radios, which makes every radio on the device look
   * like a wire — including the one carrying the uplink. A `catch` that returns an empty list would
   * therefore turn a tool failure into a confident wrong answer, on the interface where being wrong
   * means offering to listen on a radio.
   */
  wirelessInterfaces: string[] | null;
}

/**
 * Link kinds that are a path to somewhere else.
 *
 * Listed rather than inferred because `kind` is a name from the kernel, and the ones that carry traffic
 * off this device are a closed set we can enumerate. Anything not listed still reaches the `link/none`
 * check below, which is what catches a plain tun device — `ip` reports no kind for those at all.
 */
const TUNNEL_KINDS = new Set([
  'tun',
  'tap',
  'wireguard',
  'gre',
  'gretap',
  'ip6gre',
  'ip6tnl',
  'sit',
  'ipip',
  'vti',
  'vti6',
  'xfrm',
  'ppp',
  'geneve',
  'vxlan',
  'bareudp',
  'wwan',
]);

export function classifyInterfaces(input: ClassifyInput): ClassifiedInterface[] {
  const ours = new Set(input.tunnelInterfaces);
  const accessPoint = input.managementSurfaces?.accessPoint ?? null;
  const uplinks = new Set(input.managementSurfaces?.uplinks ?? []);
  const radios = input.wirelessInterfaces === null ? null : new Set(input.wirelessInterfaces);

  return input.links.map((link) => {
    const name = link.name;

    if (link.linkType === 'loopback') {
      return { name, class: 'loopback' as const, why: 'the kernel reports this as the loopback device' };
    }

    // Shape first, and deliberately before the profile is consulted. A tunnel this device did not create
    // is still a tunnel, and asking our own list first is what made a foreign one look ordinary.
    if (link.kind !== null && TUNNEL_KINDS.has(link.kind)) {
      return {
        name,
        class: 'tunnel' as const,
        why: `the kernel reports this as a ${link.kind} link, which is a path to another network`,
      };
    }
    if (link.linkType === 'none') {
      return {
        name,
        class: 'tunnel' as const,
        why: 'the kernel reports no link layer for this device, which is what a tunnel looks like',
      };
    }
    if (ours.has(name)) {
      return { name, class: 'tunnel' as const, why: 'a tunnel in the active profile creates this interface' };
    }

    if (accessPoint !== null && name === accessPoint) {
      return { name, class: 'accessPoint' as const, why: 'the active profile serves its access point here' };
    }

    if (radios !== null && radios.has(name)) {
      if (uplinks.has(name)) {
        return {
          name,
          class: 'wirelessUplink' as const,
          why: 'the driver reports a radio here and the active profile uses it as an uplink',
        };
      }
      return {
        name,
        class: 'unknown' as const,
        why: 'the driver reports a radio here that the active profile neither serves nor uses as an uplink',
      };
    }

    if (uplinks.has(name) && radios === null) {
      /*
       * The profile says this is an uplink, and that is not enough to place it.
       *
       * A wireless uplink is its own class; a wired one is simply `wired`. Which of the two this is
       * cannot be read from a link, so naming either would be a guess dressed as a verdict — and the
       * reason below has to say that, because "unknown" about an interface the profile clearly
       * configured looks like a bug to whoever reads it unless the open question is named.
       */
      return {
        name,
        class: 'unknown' as const,
        why:
          'the active profile uses this as an uplink, but whether it is a radio or a wire was not ' +
          'established: the list of radios was not available',
      };
    }

    if (link.linkType === 'ether') {
      if (radios === null) {
        return {
          name,
          class: 'unknown' as const,
          why:
            'this reports an Ethernet link layer, which a wired port and a radio both do, and the list ' +
            'of radios was not available to tell them apart',
        };
      }
      return {
        name,
        class: 'wired' as const,
        why: 'an Ethernet link layer that the driver does not report as a radio',
      };
    }

    return {
      name,
      class: 'unknown' as const,
      why: `nothing here identifies this interface: link layer ${link.linkType ?? 'unreported'}, no kind reported`,
    };
  });
}
