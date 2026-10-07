/**
 * Generating the proxy core's configuration.
 *
 * This is **assembly and validation, not transformation**, and that is the whole payoff of storing a
 * tunnel as the core's own object verbatim. There is no per-protocol branch here, no field mapping,
 * and no list of protocol names — which is why a protocol the core gains needs no code in this file.
 *
 * Two arrays, not one: a tunnel's object goes into `outbounds` or into `endpoints` depending on what
 * the core calls it. In the measured build (sing-box 1.14.0) WireGuard, Tailscale and the native
 * OpenVPN client are **endpoints**, while VLESS, Trojan, Hysteria2 and the rest are outbounds. The
 * destination comes from the provider descriptor rather than from a name test here.
 *
 * ## The core is the LAN resolver, and that has a consequence worth stating
 *
 * DHCP hands clients this device's own address as their resolver and the core answers there. Two
 * caches in a row — a local resolver in front of the core — is a debugging trap: a stale answer from
 * a layer somebody forgot exists. And the core's routing decisions depend on seeing the query
 * itself, which it cannot do if something else answered first.
 *
 * The cost, stated plainly rather than papered over: **with the core stopped, clients lose name
 * resolution.** That is a fail-open policy question and it belongs to the epic that owns policy, not
 * to a second resolver added here to make the symptom go away.
 */

import {
  CORE_TAGS,
  DEVICE_TUN_ADDRESS,
  FALL_THROUGH_DNS,
  FALL_THROUGH_ORDINARY,
  fallThroughDnsSelectorTag,
  fallThroughSelectorTag,
  generateRoutingRules,
  guardSelectorTag,
  type ProfileDocument,
  type Tunnel,
} from '@wayfarer/schemas';
import { networkCidr } from '../invariants.ts';
import { PATHS } from '../desired-state.ts';

/**
 * The point-to-point network between the host and the core's tun device.
 *
 * Ours, not the operator's and not the environment's: it is written into the inbound below and into
 * the exclusion list from this one definition, so the two cannot disagree. Defined in the schemas
 * package because a third thing needs it — the rule that tells this device's own traffic from a
 * forwarded client's, which it does by source address.
 */
const TUN_ADDRESS = DEVICE_TUN_ADDRESS;

export { CORE_TAGS };

/**
 * The tag a tunnel's own resolver carries in the generated configuration.
 *
 * One definition, because a second reader of this file now exists: the convergence check reads the
 * address back out to decide whether a captured resolver actually reached the core. A reader that
 * spelled `dns-${id}` itself would stop matching the day this spelling changed, and it would stop
 * matching **silently** — reporting that the captured resolver is not in use when it is, or the
 * reverse. Both are the defect the check exists to end.
 */
export function tunnelDnsTag(tunnelId: string): string {
  return `dns-${tunnelId}`;
}

export interface CoreConfigInput {
  profile: ProfileDocument;
  /** Interface names resolved from the profile's bindings, by role key. */
  interfaces: { accessPoint: string | null; uplinks: Map<string, string> };
  /**
   * Per tunnel: the object to emit and where it goes. Produced by the catalogue entry that owns the
   * protocol, so this generator still never asks what protocol something is.
   */
  emitted: Map<string, { target: 'outbounds' | 'endpoints'; object: Record<string, unknown> }>;
  /** Resolvers reachable only through a particular tunnel's interface. */
  tunnelDns: Map<string, { address: string; viaInterface: string; domainSuffix: string[] }>;
  /**
   * The networks the uplinks are currently on, in **network** form.
   *
   * A runtime reading rather than anything in the profile, because the uplink's subnet comes from DHCP.
   * Without it the tunnel's `auto_route` captures replies to inbound connections from the network the
   * device is reached through, and the device disappears from it.
   */
  uplinkNetworks: string[];
}

export function generateCoreConfig(input: CoreConfigInput): Record<string, unknown> {
  return generateCoreConfigWithProvenance(input).config;
}

/**
 * A place in the generated configuration whose value was **read off the running device** when it was
 * generated, rather than derived from the profile.
 *
 * Carried on the `ManagedFile` (see `ObservedPointer` there) so the drift check can tell a reading that
 * has moved since from a profile the device is not running, and can compare a list whose order means
 * nothing as a set.
 */
export interface CoreConfigProvenance {
  config: Record<string, unknown>;
  observed: { pointer: string; from: string; unordered: boolean }[];
}

/**
 * The observed networks in one canonical order: numerically by address, then by prefix length.
 *
 * **Why an order is imposed at all.** The kernel lists addresses by interface index, and a tunnel's
 * interface gets a new, higher index every time it is recreated. So deriving twice from the same
 * profile on the same device gave the same networks in a different order whenever a tunnel had been
 * restarted in between — measured on the bench board, 2026-09-22: a file written seconds after an
 * apply held `…, "10.136.0.0/24", "10.164.0.0/20"` and a re-derivation produced `10.164.0.0/20` first. The
 * core does not care about the order; the file comparison did, so the apply rewrote an unchanged
 * configuration and restarted the core, and the drift check reported a divergence that was not one.
 * A derivation must be a function of what it reads, not of the order the kernel happened to list it.
 */
function canonicalNetworks(values: string[]): string[] {
  const normalised = [...new Set(values.map((cidr) => networkCidr(cidr)).filter((cidr): cidr is string => cidr !== null))];
  const key = (cidr: string): [number, number] => {
    const [address = '', prefix = '0'] = cidr.split('/');
    const octets = address.split('.').map((part) => Number(part));
    const numeric = octets.length === 4 && octets.every((part) => Number.isInteger(part)) ? octets.reduce((acc, part) => acc * 256 + part, 0) : Number.MAX_SAFE_INTEGER;
    return [numeric, Number(prefix)];
  };
  return normalised.sort((left, right) => {
    const [a, ap] = key(left);
    const [b, bp] = key(right);
    return a !== b ? a - b : ap !== bp ? ap - bp : left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Where each observed value came from, in the words a finding will use. */
export const OBSERVED_NETWORKS_SOURCE =
  'the IPv4 networks on this device’s interfaces (tunnels included) at the moment of generation';

export function generateCoreConfigWithProvenance(input: CoreConfigInput): CoreConfigProvenance {
  const { profile } = input;
  const observedNetworks = canonicalNetworks(input.uplinkNetworks);
  const enabled = profile.tunnels.filter((tunnel) => tunnel.enabled);
  const alternatives = enabled.filter(
    (tunnel) => tunnel.role === 'alternative' && !profile.policy.excluded.includes(tunnel.id),
  );

  const outbounds: Record<string, unknown>[] = [];
  const endpoints: Record<string, unknown>[] = [];

  for (const tunnel of enabled) {
    const emission = input.emitted.get(tunnel.id);
    if (!emission) continue;
    // The tag is the tunnel id, always. It is the one field this generator sets on somebody else's
    // object, because routing references it and a tag chosen anywhere else could disagree.
    const object = { ...emission.object, tag: tunnel.id };
    if (emission.target === 'endpoints') endpoints.push(object);
    else outbounds.push(object);
  }

  // The selector exists even with one alternative, and even with none. With one, it is what the
  // watchdog switches without rewriting the configuration; with none, it keeps every routing rule
  // that names it valid, so removing the last tunnel is not a configuration error.
  /**
   * The fallback is a **member** of the selector, always — not only when there are no alternatives.
   *
   * The watchdog points the selector at this when nothing is healthy, and a selector can only be set to
   * one of its own members. Listing it only in the no-alternatives case meant the fallback was
   * unreachable in exactly the situation it exists for. Measured on the bench board, 2026-09-21, with two
   * tunnels configured and both failing:
   *
   * ```
   * health.switch-failed  could not point the selector at block:
   *                       400 {"message":"Selector update error: not found"}
   * ```
   *
   * The event ring is the only reason that was visible: the watchdog reported the refusal instead of
   * assuming the selection had taken, so the device said plainly that it could not do the one thing left
   * to do. It is listed last so it is never the default choice.
   */
  const fallbackTag = profile.policy.onAllDown === 'direct' ? CORE_TAGS.direct : CORE_TAGS.block;
  const selectorMembers =
    alternatives.length > 0
      ? [...orderedAlternatives(alternatives, profile.policy.priority), fallbackTag]
      : [fallbackTag];

  outbounds.push({
    type: 'selector',
    tag: CORE_TAGS.selector,
    outbounds: selectorMembers,
    ...(alternatives.length > 0 ? { default: orderedAlternatives(alternatives, profile.policy.priority)[0] } : {}),
    // Sticky: stay on a healthy choice rather than returning to the top the moment the preferred one
    // recovers, which otherwise moves every live connection for no gain.
    interrupt_exist_connections: !profile.policy.sticky,
  });

  outbounds.push({ type: 'direct', tag: CORE_TAGS.direct });
  outbounds.push({ type: 'block', tag: CORE_TAGS.block });

  /**
   * One guard selector per destination tunnel that must block rather than fall through.
   *
   * Members are the tunnel and `block`, in that order, and **nothing else** — this is not a failover
   * group. A tunnel that exists for a named set of destinations has no substitute, so offering one would
   * send traffic somewhere nobody chose, which is the same reason a `resource` tunnel never joins the main
   * selector.
   *
   * The default member is the tunnel, so a device that has never completed a health round carries the
   * traffic rather than refusing it. That direction is deliberate and it is the one place this design
   * leans the other way: at start-up "not yet measured" is not evidence of failure, and refusing on the
   * strength of a measurement nobody has taken yet would break every tunnel on every boot.
   *
   * `interrupt_exist_connections` is **true** here regardless of the sticky policy. When the watchdog
   * moves this selector to `block` it is because the traffic must stop; leaving established connections
   * running on the tunnel that was just declared unusable would keep the leak open for exactly as long as
   * something kept a socket alive.
   */
  for (const tunnel of enabled) {
    if (tunnel.role !== 'resource' || tunnel.onUnavailable !== 'block') continue;
    outbounds.push({
      type: 'selector',
      tag: guardSelectorTag(tunnel.id),
      outbounds: [tunnel.id, CORE_TAGS.block],
      default: tunnel.id,
      interrupt_exist_connections: true,
    });
  }

  /**
   * One fall-through selector per destination tunnel on `onUnavailable: fall-through` (G31).
   *
   * Members: the tunnel, then the ordinary route (`FALL_THROUGH_ORDINARY`, the main selector — see its
   * note for why that and not "the rules below"). `block` is **not** a member, and neither is anything
   * else: a `block` tunnel gets no member that could leak, and a fall-through tunnel gets exactly one way
   * out besides itself. The default is the tunnel, so a core that starts before any reading carries the
   * traffic in the tunnel.
   *
   * `interrupt_exist_connections` is true in both directions. Falling through, a connection still open on
   * the dead tunnel carries nothing and should be re-dialled the ordinary way; switching back, a connection
   * left open on the ordinary route is traffic leaving outside the tunnel after the tunnel came back.
   */
  const fallThrough = enabled.filter((tunnel) => tunnel.role === 'resource' && tunnel.onUnavailable === 'fall-through');
  for (const tunnel of fallThrough) {
    outbounds.push({
      type: 'selector',
      tag: fallThroughSelectorTag(tunnel.id),
      outbounds: [tunnel.id, FALL_THROUGH_ORDINARY],
      default: tunnel.id,
      interrupt_exist_connections: true,
    });
  }

  /**
   * The resolvers of fall-through tunnels, reached through a selector of their own — see
   * `FALL_THROUGH_DNS` for the loop its ordinary member closes. Only tunnels with a resolver of their own:
   * a fall-through tunnel without one already has its names answered by the ordinary resolver.
   */
  const fallThroughDns = fallThrough.filter((tunnel) => input.tunnelDns.has(tunnel.id)).map((tunnel) => tunnel.id);
  for (const id of fallThroughDns) {
    outbounds.push({
      type: 'selector',
      tag: fallThroughDnsSelectorTag(id),
      outbounds: [id, FALL_THROUGH_DNS.outbound],
      default: id,
      interrupt_exist_connections: true,
    });
  }
  if (fallThroughDns.length > 0) {
    outbounds.push({
      type: 'socks',
      tag: FALL_THROUGH_DNS.outbound,
      server: FALL_THROUGH_DNS.listen,
      server_port: FALL_THROUGH_DNS.port,
      version: '5',
    });
  }

  /**
   * Everything that must never be routed into a tunnel, in network form and deduplicated.
   *
   * Normalised because a host address carrying a prefix is not a network: `10.44.0.1/24` is what the
   * profile states as the device's own address, and the exclusion needs `10.44.0.0/24`. Relying on a
   * consumer to interpret the host form as its containing network is being right by luck.
   *
   * An unparseable LAN CIDR is dropped rather than passed through, because an exclusion list containing a
   * value the core cannot read may fail the whole configuration — and the invariant checks have already
   * refused the profile by this point if it is malformed.
   */
  /**
   * The tunnel's own transfer network, stated here rather than discovered.
   *
   * It is a value **we choose** — the address on the `tun` inbound below — so deriving it from
   * whether a `tun0` interface happens to exist at plan time makes a configuration that depends on
   * whether the thing it configures is already running.
   *
   * Measured on the bench board, 2026-09-20: planning with the core stopped produced exclusions
   * without `172.19.0.0/30`; the core then started, `tun0` appeared, and the next plan added it
   * back. Harmless as a two-step convergence, and not harmless at all for the boot guard, which runs
   * **before** the core by design and would therefore rewrite this file on every single boot — a
   * write to the one component of this device that wears out, and a plan that is never empty after a
   * restart.
   */
  const transferNetwork = networkCidr(TUN_ADDRESS);
  const exclusions = [
    ...new Set(
      [
        networkCidr(profile.network.cidr),
        transferNetwork,
        ...observedNetworks,
      ].filter((cidr): cidr is string => cidr !== null),
    ),
  ];
  /**
   * The networks that must reach the device directly rather than through the tunnel.
   *
   * The transfer network is included here for the same reason it is included above: it is ours, and
   * a list that contains it only when `tun0` already exists makes this file depend on whether the
   * core it configures is running.
   */
  const uplinkNetworks = [
    ...new Set(
      [transferNetwork, ...observedNetworks].filter(
        (cidr): cidr is string => cidr !== null,
      ),
    ),
  ];

  const config: Record<string, unknown> = {
    log: { level: 'warn', timestamp: true },

    dns: {
      servers: [
        // TCP, not UDP. Over UDP the core sends every query to this resolver from one socket, back to
        // back, and a NAT in front of this device can drop the second packet of a new flow. Measured on
        // the bench board, 2026-10-07: an A and an HTTPS query for one new name — what a browser sends
        // for every host — lost one answer in 15 of 15 pairs, and the core waits 10 s before giving up,
        // so every new site stalled for 10 s. Over TCP: 0 of 15, one connection reused for all queries.
        // UDP through a SOCKS exit answered nothing at all (0 of 25); TCP through it works. See docs/04.
        { type: 'tcp', tag: CORE_TAGS.dnsTunnel, server: profile.dns.overTunnel, detour: CORE_TAGS.selector },
        ...directDnsServer(profile),
        ...[...input.tunnelDns.entries()].map(([id, spec]) => ({
          type: 'udp',
          tag: tunnelDnsTag(id),
          server: spec.address,
          // A fall-through tunnel's resolver is reached through its own selector, so that when the
          // tunnel falls through, its names are answered by the ordinary resolver (G31).
          detour: fallThroughDns.includes(id) ? fallThroughDnsSelectorTag(id) : id,
        })),
      ],
      rules: [
        // First: a query handed over by a fallen-through tunnel's resolver selector is answered by the
        // resolver unmatched names use. Before the tunnel's own suffix rule, which would send it back
        // round the loop.
        ...(fallThroughDns.length > 0 ? [{ inbound: [FALL_THROUGH_DNS.inbound], server: CORE_TAGS.dnsTunnel }] : []),
        // A resource tunnel's own resolver, matched on the suffixes that tunnel serves. First,
        // because a corporate name must not be answered by a public resolver that will return a
        // public address for it.
        ...[...input.tunnelDns.entries()]
          .filter(([, spec]) => spec.domainSuffix.length > 0)
          .map(([id, spec]) => ({ domain_suffix: spec.domainSuffix, server: tunnelDnsTag(id) })),
        // Names the routing rules send **direct** are resolved directly too. Without this the query
        // goes through the tunnel while the connection does not, which leaks the lookup and can
        // return an address chosen for the wrong exit.
        ...directDnsRules(profile),
      ],
      // Everything unmatched resolves through the tunnel, matching `route.final`, which is the
      // selector. A `final` of direct would leak every name a client looks up.
      //
      // Expressed as `final` rather than as a catch-all rule with an `outbound` item: measured
      // against sing-box 1.14.0, `{ "outbound": "any" }` in a DNS rule is refused outright —
      // "outbound DNS rule item is deprecated in sing-box 1.12.0 and will be removed in 1.14.0" —
      // and the core exits rather than warning. A generated configuration that a fixture accepts and
      // the binary rejects is exactly what running the binary's own check catches.
      final: CORE_TAGS.dnsTunnel,
      strategy: profile.dns.strategy,
    },

    inbounds: [
      {
        type: 'tun',
        tag: CORE_TAGS.inbound,
        address: [TUN_ADDRESS],
        auto_route: true,
        /**
         * The LAN we serve **and** the networks the uplinks are on. Not a user-editable field.
         *
         * The previous version of this line read `[lanCidr, ...(parsed ? [] : [])]` while its comment
         * claimed both were present. Both branches of that conditional were empty, so it spread nothing
         * whichever way it went — a placeholder that made the line look like it had two parts. The uplink
         * network was never excluded, `auto_route` captured the return path to it, and the board became
         * unreachable from the only network that could reach it.
         *
         * The same shape as a ternary whose branches are identical: a conditional that cannot change the
         * result is not a simplification waiting to happen, it is a statement of intent that was never
         * carried out.
         */
        route_exclude_address: exclusions,
        strict_route: false,
        /**
         * **`system`, the host's own network stack — verified to carry forwarded client traffic.**
         *
         * Measured on the bench board, 2026-09-21, with a forwarded client built from a `veth` pair in a
         * network namespace at `10.44.0.240`, inside the LAN this device serves: name resolution
         * answered, TCP open to two internet hosts, `HTTP/1.1 200 OK` from a real request, and a
         * connectivity-check host returning `204`. A ping to the gateway is run first as a control, so a
         * silent probe cannot be read as a silent network.
         *
         * ## The reason this comment is long: it records a wrong answer that was shipped
         *
         * This was briefly changed to `gvisor`, on the confident conclusion — with a table of
         * measurements — that the host stack could not accept forwarded traffic at all. That conclusion
         * was wrong, and the way it was reached is the part worth keeping.
         *
         * The evidence for it came from a forwarded client at `10.99.0.2`, built deliberately as a real
         * forwarded client rather than a local process standing in for one. Every website timed out from
         * it while a local process on the same board reached the same address. The contrast looked
         * decisive.
         *
         * `10.99.0.2` is not inside `route_exclude_address`. **The core's replies to a client outside the
         * excluded ranges are themselves captured by `auto_route` and sent back into the tunnel instead
         * of to the client, so the handshake can never complete — whatever the stack does.** A real
         * associated station is inside the served LAN and has no such problem.
         *
         * Two controls, in order, because the first was not enough:
         *
         * | stack | client | result |
         * | --- | --- | --- |
         * | gvisor | `10.99.0.2` (outside the excluded ranges) | fails |
         * | gvisor | `10.44.0.240` (inside them) | works |
         * | system | `10.44.0.240` (inside them) | works |
         *
         * The first two rows hold the stack constant and vary the subnet: the result flips, so the subnet
         * was the variable all along. The third row is what should have been run before changing anything
         * — it shows the original setting was never at fault.
         *
         * So the lesson is not about stacks. It is that the second stand-in was broken more subtly than
         * the first and produced a **more confident** wrong answer *because* it was more realistic. A
         * probe built specifically to escape a known trap is the one nobody re-examines. And a line the
         * core had already logged under `system` — `open connection to …:80 using outbound/direct`,
         * dialling out for a forwarded connection — contradicted the claim and was not weighed.
         *
         * `system` is also the cheaper of the two on four small cores, which is a reason to prefer it but
         * was not the reason it was kept: it was kept because it works.
         *
         * **If you are writing a test client for this device, put it inside the LAN the profile serves.**
         * Anywhere else and it cannot complete a connection, and the failure looks exactly like a broken
         * tunnel.
         *
         * What must not be done is masquerading into the tun to make a foreign source work: it rewrites
         * every client to one address and destroys the per-client identity the routing rules above are
         * written against.
         */
        stack: 'system',
      },
      // The far end of the fall-through resolver loop. See `FALL_THROUGH_DNS`.
      ...(fallThroughDns.length > 0
        ? [{ type: 'socks', tag: FALL_THROUGH_DNS.inbound, listen: FALL_THROUGH_DNS.listen, listen_port: FALL_THROUGH_DNS.port }]
        : []),
    ],

    outbounds,
    ...(endpoints.length > 0 ? { endpoints } : {}),

    route: {
      // The shared generator, the same one the interface renders as a preview. One implementation, so
      // the preview cannot drift from what is actually emitted.
      rules: [
        /*
         * Whatever arrives on the fall-through resolver loop is answered as DNS, first and whatever it
         * is: the inbound exists for that and nothing else, so nothing reaching it can be proxied on.
         */
        ...(fallThroughDns.length > 0 ? [{ inbound: [FALL_THROUGH_DNS.inbound], action: 'hijack-dns' }] : []),
        ...generateRoutingRules(profile, {
          uplinkInterfaces: [...input.interfaces.uplinks.values()],
          uplinkNetworks,
        })
          /*
           * Notes are dropped. A `null` rule is a row that exists for the preview — "this anchor contributes
           * nothing" — and writing it into the configuration put an empty object into the routing list, which
           * the core matches against **everything** and then cannot resolve an outbound for. Every client
           * connection was reset by a rule whose only purpose was to say there was no rule.
           */
          .map((entry) => entry.rule)
          .filter((rule): rule is Record<string, unknown> => rule !== null),
      ],
      ...(profile.routing.ruleSets.length > 0
        ? {
            rule_set: profile.routing.ruleSets.map((set) => ({
              tag: set.tag,
              type: set.type,
              ...(set.url ? { url: set.url } : {}),
              ...(set.path ? { path: set.path } : {}),
              ...(set.format ? { format: set.format } : {}),
              ...(set.updateIntervalHours ? { update_interval: `${set.updateIntervalHours}h` } : {}),
            })),
          }
        : {}),
      final: CORE_TAGS.selector,
      auto_detect_interface: true,
      // How the *server addresses of outbounds* are resolved. Direct, and it has to be: resolving a
      // tunnel's own endpoint through that tunnel is circular, and the tunnel never comes up.
      default_domain_resolver: { server: CORE_TAGS.dnsDirect },
      // The device's own traffic carries a mark the core treats as already handled. The documented
      // per-user exclusion does not take effect in the chains generated for forwarded traffic —
      // verified by inspecting those chains, which contain no user-matching rules at all.
      default_mark: 0x1e7,
    },

    experimental: profile.services.clashApi.enabled
      ? {
          clash_api: {
            external_controller: profile.services.clashApi.bind,
          },
          // One name for this file, because `core/rule-set-age.ts` reads its modification time to
          // say how old the remote rule sets are. A second literal is one rename away from a check
          // that silently looks at a file nothing writes.
          cache_file: { enabled: true, path: PATHS.coreCache },
        }
      : { cache_file: { enabled: true, path: PATHS.coreCache } },
  };

  return { config, observed: observedPointers(config, uplinkNetworks) };
}

/**
 * The pointers in `config` whose value is a reading of the device rather than the profile.
 *
 * Located in the finished object rather than predicted from the order it was assembled in, so a
 * reordering of the generator cannot make these marks point at the wrong element.
 */
function observedPointers(config: Record<string, unknown>, uplinkNetworks: string[]): CoreConfigProvenance['observed'] {
  const observed: CoreConfigProvenance['observed'] = [];
  const inbounds = Array.isArray(config['inbounds']) ? (config['inbounds'] as Record<string, unknown>[]) : [];
  inbounds.forEach((inbound, index) => {
    if (Array.isArray(inbound['route_exclude_address'])) {
      observed.push({
        pointer: `/inbounds/${String(index)}/route_exclude_address`,
        from: `the served network, the transfer network, and ${OBSERVED_NETWORKS_SOURCE}`,
        unordered: true,
      });
    }
  });
  const rules = ((config['route'] as { rules?: unknown } | undefined)?.rules ?? []) as Record<string, unknown>[];
  rules.forEach((rule, index) => {
    if (
      uplinkNetworks.length > 0 &&
      rule['outbound'] === CORE_TAGS.direct &&
      JSON.stringify(rule['ip_cidr']) === JSON.stringify(uplinkNetworks)
    ) {
      observed.push({
        pointer: `/route/rules/${String(index)}/ip_cidr`,
        from: `the transfer network and ${OBSERVED_NETWORKS_SOURCE}`,
        unordered: true,
      });
    }
  });
  return observed;
}

/**
 * DNS rules mirroring the routing rules that send a name direct.
 *
 * Only the domain-shaped ones: an address-shaped rule cannot be mirrored, because at the moment a
 * query is answered there is no address yet to match on. That asymmetry is worth knowing rather than
 * discovering — a `ipCidr` rule sending a range direct does not make the names in it resolve
 * directly.
 */
function directDnsRules(profile: ProfileDocument): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [];

  for (const rule of profile.routing.rules) {
    if (!('action' in rule) || rule.action.outbound !== 'direct') continue;
    if (rule.kind === 'domain') rules.push({ domain: rule.domains, server: CORE_TAGS.dnsDirect });
    if (rule.kind === 'domainSuffix') rules.push({ domain_suffix: rule.suffixes, server: CORE_TAGS.dnsDirect });
  }

  return rules;
}

function directDnsServer(profile: ProfileDocument): Record<string, unknown>[] {
  if (profile.dns.direct === 'auto') {
    // `local` follows whatever the uplink handed us, which is the only correct answer for "auto":
    // a literal address would be the one the uplink offered at the moment the profile was written.
    return [{ type: 'local', tag: CORE_TAGS.dnsDirect }];
  }
  // TCP for the same reason as `dns-tunnel`: the NAT that drops the second packet of a new UDP flow is
  // on the direct path too.
  //
  // No `detour`. sing-box 1.14.0 refuses to start with a DNS server whose detour is an empty `direct`
  // outbound — "detour to an empty direct outbound makes no sense" — and `sing-box check` passes that
  // configuration, so the binary's own check does not catch it. Measured on the bench board,
  // 2026-10-07: without a detour the server is dialled directly on the uplink (SYNs on `end0`), not
  // through the first outbound or `route.final`, both of which were a tunnel in that test.
  return [{ type: 'tcp', tag: CORE_TAGS.dnsDirect, server: profile.dns.direct }];
}

/**
 * The alternatives in preference order.
 *
 * The stated priority first, then anything enabled that the priority list does not mention — a
 * tunnel somebody added and forgot to prioritise should still be reachable, not silently inert.
 */
function orderedAlternatives(alternatives: Tunnel[], priority: string[]): string[] {
  const available = new Set(alternatives.map((tunnel) => tunnel.id));
  const ordered = priority.filter((id) => available.has(id));
  for (const tunnel of alternatives) if (!ordered.includes(tunnel.id)) ordered.push(tunnel.id);
  return ordered;
}

