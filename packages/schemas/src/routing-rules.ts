/**
 * Turning a profile's routing list into the rules the proxy core matches on.
 *
 * This lives in the shared package, and that placement is the point. The planner emits these into the
 * generated configuration, and the interface shows them as a preview beside the editor — **from the
 * same function**. A second implementation for the preview would drift, and a preview that disagrees
 * with what is generated is worse than no preview, because somebody would trust it.
 *
 * Pure, and derived from the **profile document** — where secrets are still wrapped — never by reading
 * back a generated file. That distinction matters and it is not the same as "no contents in plan
 * review": the invariant is *nothing that can carry a resolved secret*. A routing rule is a domain, a
 * suffix, a subnet and a target; there is nothing secret in one. A core configuration holds real
 * credentials and cannot be shown. See docs/10-security.md.
 */

import type { ProfileDocument } from './profile.ts';

/** Tags the core uses that are not tunnel ids. */
export const CORE_TAGS = {
  direct: 'direct',
  block: 'block',
  /** The selector the health watchdog switches; where unmatched traffic goes. */
  selector: 'wf-selector',
  dnsDirect: 'dns-direct',
  dnsTunnel: 'dns-tunnel',
  inbound: 'wf-lan',
} as const;

/**
 * The selector that stands in front of one destination tunnel, so its traffic can be **blocked**
 * rather than merely failing when the tunnel is unavailable.
 *
 * Its members are that tunnel and `block`, nothing else — it is not a failover group and it never
 * chooses a different tunnel, because a tunnel that exists for a specific set of destinations has no
 * substitute. The health watchdog moves it, exactly as it moves the main selector, which is why this
 * needs no new mechanism: switching a selector is a `hot` change and costs no restart.
 *
 * Why a selector rather than pointing the rule straight at the tunnel: a rule naming the tunnel's own
 * outbound produces a *connection error* when the tunnel is down, and an error is not a refusal. It
 * behaves differently on retry, it is invisible in the event ring, and the name is still looked up. A
 * selector pointed at `block` is an actual rejection, observable and recorded.
 */
export function guardSelectorTag(tunnelId: string): string {
  return `wf-guard-${tunnelId}`;
}

/**
 * The selector in front of a destination tunnel whose traffic may **leave another way** when the tunnel
 * is dead (`onUnavailable: fall-through`, plan row G31).
 *
 * Its members are the tunnel and {@link FALL_THROUGH_ORDINARY}, in that order, the tunnel the default.
 * The watchdog moves it to the ordinary member only on consecutive confident dead readings of the tunnel
 * itself, and back once it reads alive again — see `FALL_THROUGH_DEAD_ROUNDS` in the daemon's watchdog.
 *
 * Until 2026-09-24 no such selector existed: a fall-through tunnel's rule pointed straight at its own
 * outbound, so while it was down its traffic failed exactly as under `block`, and the interface's
 * promise that it "goes out the ordinary way instead" was false.
 */
export function fallThroughSelectorTag(tunnelId: string): string {
  return `wf-fall-${tunnelId}`;
}

/**
 * The selector the resolver of a fall-through tunnel is reached through: the tunnel, or
 * {@link FALL_THROUGH_DNS.outbound}, which hands the query to this device's ordinary resolver.
 *
 * Separate from {@link fallThroughSelectorTag} because the ordinary member differs. A tunnel's own
 * resolver is usually an address that exists only behind the tunnel (`corp` pushes `10.122.0.1`,
 * `hq` uses `10.184.100.5`): sending the query to that address the ordinary way would put it on the
 * uplink towards an address that is not there — or, worse, is somebody else's. So when the tunnel falls
 * through, the question is re-asked of the resolver everything else uses.
 */
export function fallThroughDnsSelectorTag(tunnelId: string): string {
  return `wf-fall-dns-${tunnelId}`;
}

/**
 * Where a fall-through tunnel's traffic goes while the tunnel is dead: **the route traffic no rule names
 * takes** — `route.final`, the main selector.
 *
 * The honest reading of "the ordinary way" is *what this traffic would do if the tunnel's rule did not
 * exist*, and the core cannot say that: a routing rule is final, there is no "skip this rule" a selector
 * can choose, and the rules after it may split the tunnel's resources several ways. `route.final` is the
 * one member that is defined for every profile, and it is what the rule list ends in. On the bench board
 * it is `direct` (no alternative tunnel, `onAllDown: direct`). A later rule that would have caught some
 * of these destinations — `hq`'s `10.0.0.0/8` overlaps `corp`'s `10.122.0.0/24` — is **not**
 * consulted while falling through; the preview says so.
 *
 * Never a cycle: the main selector's members are `alternative` tunnels and the fallback, and a
 * fall-through selector only ever stands in front of a `resource` tunnel.
 */
export const FALL_THROUGH_ORDINARY: string = CORE_TAGS.selector;

/**
 * The loop that lets a fall-through tunnel's resolver query be answered by the ordinary resolver.
 *
 * A DNS server's address is fixed in the configuration and a selector can change only the path to it,
 * not the address. So the ordinary member of {@link fallThroughDnsSelectorTag} is a SOCKS outbound to a
 * SOCKS inbound on loopback; what arrives there is hijacked as DNS by the first routing rule, and the
 * first DNS rule answers anything from that inbound with the resolver unmatched names use. Everything is
 * static configuration, so the switch is one selector move — the same kind of move as the traffic's,
 * made in the same round — and needs no file and no restart.
 *
 * Loopback only; the firewall accepts `lo` and nothing else reaches the port. Nothing that arrives on
 * the inbound can be proxied anywhere: the rule that catches it answers it as DNS or not at all.
 */
export const FALL_THROUGH_DNS = {
  inbound: 'wf-fall-dns-in',
  outbound: 'wf-fall-dns-out',
  listen: '127.0.0.1',
  port: 10853,
} as const;

/**
 * The host names the watchdog probes, from the endpoint URLs.
 *
 * Exported because the firewall generator and the interface both need the same list, and a second
 * parser of the same URLs would eventually disagree with this one about what a host is.
 *
 * A URL that cannot be parsed yields nothing rather than a guess: an unparseable endpoint is already a
 * finding from the invariant pass, and inventing a host name from it here would turn one clear error
 * into a routing rule nobody asked for.
 */
export function probeEndpointHosts(profile: ProfileDocument): string[] {
  const hosts: string[] = [];
  /*
   * Read defensively, because this function runs against a **draft**.
   *
   * The interface previews these rules from the document being edited, which can be missing whole
   * objects while somebody is halfway through adding one — and a generator that throws on a partial
   * draft takes the editor down with it, which this repository already has a test against. The first
   * version indexed straight into `policy.probes.endpoints` and broke the preview for a document with an
   * empty `probes`, which is exactly the shape a new profile passes through.
   */
  const endpoints = profile.policy?.probes?.endpoints;
  if (!Array.isArray(endpoints)) return hosts;
  for (const endpoint of endpoints) {
    if (typeof endpoint !== 'string') continue;
    try {
      const host = new URL(endpoint).hostname;
      if (host !== '' && !hosts.includes(host)) hosts.push(host);
    } catch {
      // Left out on purpose. See above.
    }
  }
  return hosts;
}

/**
 * The point-to-point network between the host and the core's tun device, in **network** form.
 *
 * Defined here rather than beside the inbound that uses it because two things need it and they must
 * not disagree: the inbound's address, and the routing rule that tells the device's own traffic apart
 * from a forwarded client's.
 *
 * That distinction is a measurement, not a convention. Traffic the device originates reaches the core
 * having already been given the tun's own address by the routing table — `ip route get 1.1.1.1 uid
 * 65534` reports `via 172.19.0.2 dev tun0 src 172.19.0.1` — while a forwarded packet keeps the
 * client's address, because nothing masquerades on the way into the tun. So the source the core sees
 * *is* the answer to "whose traffic is this", and it is the only field that answers it: both paths
 * arrive on the same inbound.
 */
export const DEVICE_TUN_NETWORK = '172.19.0.0/30';

/** The same network in host form, which is what the tun inbound's `address` wants. */
export const DEVICE_TUN_ADDRESS = '172.19.0.1/30';

/**
 * The firewall mark meaning **"this device originated it; do not send it through the tunnel"**.
 *
 * Three things must agree on this number and previously each carried its own copy: the nftables ruleset
 * that sets it on the device's own traffic, the policy routing rule that acts on it, and the core's
 * `default_mark`. Three literals for one value is the shape where two of them stay right and one drifts.
 *
 * **It only means anything because something consults it.** Setting a mark changes nothing by itself —
 * measured on the bench board, 2026-09-21, with the mark being set and no policy rule referring to it:
 * `ip route get <address> mark 0x1e7` returned the tunnel device, identical to the unmarked lookup, and
 * the tunnel client's own connection to its VPN server was visible inside the core. The protection was
 * written, documented, and inert. See the note in the firewall unit generator for the rule that fixes it.
 */
export const DEVICE_MARK = 0x1e7;

/**
 * Where the policy rule that acts on {@link DEVICE_MARK} sits.
 *
 * **Below the core's own rules, and that is what makes it work rather than the order things started in.**
 * The proxy core installs its `auto_route` policy rules in the 9000–9010 range when it starts and removes
 * them when it stops. Linux evaluates policy rules in ascending priority order, so a rule at 8000 is
 * consulted before every one of them — whichever was installed first, and across any number of core
 * restarts. Priority is a property of the rule, not of its history, which is the only kind of guarantee
 * worth having here: "it worked when I tried it" depends on an ordering nobody controls.
 */
export const DEVICE_MARK_RULE_PRIORITY = 8000;

export interface RoutingContext {
  /** Uplink interface names, so the protect anchor can match on them. */
  uplinkInterfaces: string[];
  /**
   * The networks the uplinks are currently on, as CIDRs in **network** form.
   *
   * A runtime reading, not a profile field — it comes from DHCP or from whatever network the device was
   * plugged into. The preview passes an empty list and says so, because it has no device to read.
   */
  uplinkNetworks?: string[];
}

/**
 * The interface name an uplink will be given.
 *
 * Deterministic from its position in the list, which is what makes it knowable before the hardware is
 * resolved — and therefore what lets the interface preview a rule that names it.
 */
export function uplinkInterfaceName(index: number): string {
  return `wfwan${index}`;
}

/**
 * The uplink interfaces a profile expects, from the profile alone.
 *
 * **The single source for both sides.** The planner filters this further by what actually resolved,
 * because it has an inventory; the preview cannot, and says so rather than guessing. What matters is
 * that neither computes the names itself: the preview once built its list from *all* uplinks while
 * the generator used only the enabled and resolved ones, so the preview named an interface that was
 * never going to exist — undermining the exact trust it is there to create.
 */
export function expectedUplinkInterfaces(profile: ProfileDocument): string[] {
  return profile.uplinks
    .map((uplink, index) => ({ uplink, index }))
    .filter((entry) => entry.uplink.enabled !== false)
    .map((entry) => uplinkInterfaceName(entry.index));
}

export interface GeneratedRule {
  /**
   * The object as it goes into the generated configuration, or **`null` for a row that is only a note.**
   *
   * Nullable because this structure has two consumers — the generated configuration and the preview beside
   * the editor — and one of them wants rows the other must never emit. An anchor that contributes nothing
   * still deserves a line in the preview saying so, otherwise the operator sees a rule in their list that
   * has simply vanished.
   *
   * It was not nullable, and the anchor pushed `rule: {}` for that case. The generator then wrote an empty
   * object into the routing list — which the proxy core **matches against everything** and then fails to
   * resolve an outbound for:
   *
   * ```
   * ERROR router: outbound not found:
   * ```
   *
   * Every client connection was reset by a rule that existed only to say "nothing here". It was invisible
   * from the configuration, because an empty object does not look wrong, and invisible from the preview,
   * because there it rendered as the sentence it was meant to be. Only a client trying to reach the internet
   * showed it — which is why "the configuration says direct" is not connectivity.
   */
  rule: Record<string, unknown> | null;
  /**
   * Which entry in `routing.rules` produced it, or null for one the generator adds itself. Lets the
   * interface line a generated rule up with the row the operator is editing.
   */
  fromIndex: number | null;
  /** One line describing what this matches, for the preview. */
  summary: string;
}

/**
 * The rules, in order, with a description of each.
 *
 * **The order is data.** The two anchors are emitted at the position they occupy in the list, not
 * hoisted — hoisting would make the interface's reorderable list a lie, and the warning about moving
 * an anchor below a tunnel rule exists precisely because moving it is allowed.
 */
export function generateRoutingRules(profile: ProfileDocument, context: RoutingContext): GeneratedRule[] {
  const output: GeneratedRule[] = [];

  // Before anything the profile says: DNS has to be answerable at all, and a query that is itself
  // routed by a rule needing a resolved name cannot be answered.
  /**
   * Read the destination name out of the connection itself, before any rule tries to match one.
   *
   * **Without this, no rule that names a domain matches a client's traffic at all.** A forwarded client
   * resolves a name and then connects to an *address*; the core sees the address and nothing else, so
   * `domain` and `domain_suffix` rules — the way an operator naturally says "these services" — silently
   * match nothing. The device's own traffic is unaffected, because there the core resolved the name and
   * originates the connection, which is exactly why this is invisible when tested from the board.
   *
   * Measured on the bench board, 2026-09-21, with a forwarded client and a deliberately dead tunnel:
   *
   * | how the destination was named | result |
   * | --- | --- |
   * | `domainSuffix: ['example.com']` | `HTTP/1.1 200 OK` — **served, three for three** |
   * | `ipCidr: ['104.20.23.154/32', …]` | connection reset — refused, three for three |
   *
   * Same tunnel, same guard, same client. Address matching worked and name matching did not match at all.
   *
   * A route action rather than an inbound field: in the measured build (sing-box 1.14.0) sniffing is
   * expressed as `{"action":"sniff"}` in the rule list, and the inbound `sniff` option of earlier versions
   * is gone. It is first so that everything after it can match on what it found.
   *
   * What it does **not** cover, stated here because the gap is the dangerous part: it reads a TLS
   * `server_name` or an HTTP `Host`, so a protocol carrying neither, a client using encrypted client
   * hello, and a connection made to a literal address with no name at all remain unmatched by any
   * name rule. Those need the destination expressed as addresses.
   */
  output.push({
    rule: { action: 'sniff' },
    fromIndex: null,
    summary:
      'Read the destination name from each connection first. Without this, rules that name a domain ' +
      'match nothing for clients, because a client connects to an address.',
  });

  output.push({
    rule: { action: 'hijack-dns', protocol: 'dns' },
    fromIndex: null,
    summary: 'Name lookups are answered by this device, always first.',
  });

  /**
   * The network the uplink is on goes direct, **always**, and this rule is not movable.
   *
   * It is separate from the `protect-own-networks` anchor on purpose, and the distinction is the reasoning
   * rather than a technicality. The anchor covers the network this device *serves*, and it stays movable
   * because sending one's own LAN through a tunnel is a legitimate if unusual choice. The network the
   * uplink is *on* is different: losing the return path to it does not route the device differently, it
   * makes the device **unmanageable**, from the only direction anybody can reach it. A switch whose sole
   * effect is to make a device unreachable with no way to undo it is not a choice worth offering.
   *
   * Measured on the bench board: with `auto_route` on and only the served LAN excluded, replies to inbound
   * connections from the uplink's own network were captured by the tunnel, and the board disappeared from
   * the network it was plugged into. `12-hardware-invariants.md` had claimed this exclusion existed for
   * some time; it did not.
   *
   * `fromIndex: null` is what marks it as ours rather than the profile's, so the interface shows it as a
   * fixed rule and does not offer to move it.
   */
  const uplinkNetworks = (context.uplinkNetworks ?? []).filter((cidr) => cidr !== '');
  if (uplinkNetworks.length > 0) {
    output.push({
      rule: { ip_cidr: uplinkNetworks, outbound: CORE_TAGS.direct },
      fromIndex: null,
      summary:
        `${uplinkNetworks.join(', ')} goes direct: that is the network this device is reached through, ` +
        'and it is not a routing choice.',
    });
  }

  /*
   * Blocked endpoints given by name, and the probe destinations, in one rule.
   *
   * Enforced here rather than in the firewall because a firewall matches addresses — which is also why
   * this does nothing for a client that resolved the name elsewhere and dialled a literal address.
   *
   * **`domain`, not `domain_suffix`.** The core's suffix match is a literal string suffix, so blocking
   * `example.com` as a suffix also blocks `notexample.com`. This repository documents that trap for the
   * `domain` routing rule kind and then committed it here, which is how a block on one address-discovery
   * host silently became a block on every host whose name happened to end the same way. A suffix is
   * still expressible, deliberately, as a routing rule of kind `domainSuffix` with a `block` action.
   */
  const blockedDomains = profile.firewall.blockedEndpoints
    .map((entry) => entry.domain)
    .filter((domain): domain is string => typeof domain === 'string' && domain !== '');

  /*
   * The watchdog's probe destinations, blocked for everything that is not the probe.
   *
   * This is the point of the rule rather than a side effect. A probe exists to answer one question —
   * *does this tunnel carry traffic?* — and the answer is only worth having if the endpoint cannot be
   * reached any other way. Left reachable, a client's own captive-portal check reaches the same host and
   * a person watching the network cannot tell a working tunnel from a device passing traffic around it.
   *
   * The device's own probe still gets through, and not by an exemption: the core's per-outbound delay
   * test dials **through the named outbound** and does not consult the routing rules at all. So a
   * reject rule here blocks every path except the one the watchdog measures on. Verified against the
   * core's own behaviour rather than assumed — see `platform/core-api.ts`.
   *
   * Derived from `policy.probes.endpoints` rather than asked for again in the blocked list. Two copies
   * of one set is the shape this project fails in, and the copy an operator has to maintain by hand is
   * the one that would be forgotten.
   */
  const probeHosts = probeEndpointHosts(profile);

  /*
   * The operator's own blocked list applies to **everything**: the device and every client alike.
   * That is a policy the operator asked for, and a block that quietly exempted clients would not be
   * the block they asked for.
   */
  if (blockedDomains.length > 0) {
    output.push({
      rule: { domain: blockedDomains, outbound: CORE_TAGS.block },
      fromIndex: null,
      summary:
        `Blocked by exact name, for this device and for every client: ${blockedDomains.join(', ')}. ` +
        'No effect on a client that already has the address.',
    });
  }

  /*
   * The probe destinations are blocked **only for this device's own traffic**, and that scoping is the
   * whole point of this rule rather than a refinement of it.
   *
   * Why they are blocked at all: a probe exists to answer one question — *does this tunnel carry
   * traffic?* — and the answer is only worth having if the endpoint cannot be reached any other way.
   * Left reachable by the device through some other path, a passing result stops meaning the tunnel
   * works. The watchdog's own probe is unaffected, and not by an exemption: the core's per-outbound
   * delay test dials **through the named outbound** and does not consult the routing rules at all.
   * Verified against the core's own behaviour rather than assumed — see `platform/core-api.ts`.
   *
   * Why they must stay reachable for clients, which is the part that was wrong and reached a user:
   * probe destinations are connectivity-check hosts, and a connectivity-check host is exactly what a
   * phone or a laptop asks before it decides whether a network works. Blocked, the client's operating
   * system concludes the network is dead, shows "No Internet", and on a phone leaves for cellular —
   * **while the network is working perfectly.** That is indistinguishable from a genuinely broken
   * tunnel to the person holding the device, and it will contaminate every test they run for us.
   *
   * The naive reading is "these hosts are blocked, therefore block them", and it is wrong because the
   * list is not a list of hosts to block. It is a list of hosts whose *reachability must mean
   * something specific for this device*. One list, two paths, and the rule has to say which path it is
   * acting on — which `source_ip_cidr` does, because the device's own traffic arrives bearing the tun's
   * address and a forwarded client's arrives bearing the client's.
   *
   * A host in both lists is blocked outright by the rule above; the operator asking for it wins over
   * this narrower scoping, so it is removed here rather than blocked twice.
   */
  const probeOnly = probeHosts.filter((host) => !blockedDomains.includes(host));
  if (probeOnly.length > 0) {
    output.push({
      rule: { domain: probeOnly, source_ip_cidr: [DEVICE_TUN_NETWORK], outbound: CORE_TAGS.block },
      fromIndex: null,
      summary:
        `${probeOnly.join(', ')} ${probeOnly.length === 1 ? 'is the tunnel health probe destination' : 'are the tunnel health probe destinations'}, ` +
        'unreachable from this device by any path except the probe itself — which is what makes the ' +
        'probe an answer about the tunnel. Clients are deliberately NOT blocked: these are the hosts a ' +
        'phone asks before deciding a network works, and blocking them makes a working network report ' +
        'itself as dead and send the phone back to cellular.',
    });
  }

  profile.routing.rules.forEach((rule, index) => {
    switch (rule.kind) {
      case 'protect-own-networks': {
        output.push({
          rule: { ip_cidr: [profile.network.cidr, '127.0.0.0/8'], outbound: CORE_TAGS.direct },
          fromIndex: index,
          summary: `${profile.network.cidr} and loopback go direct.`,
        });
        if (context.uplinkInterfaces.length > 0) {
          output.push({
            rule: { outbound: CORE_TAGS.direct, inbound: context.uplinkInterfaces },
            fromIndex: index,
            summary: `Traffic arriving on ${context.uplinkInterfaces.join(', ')} goes direct.`,
          });
        }
        break;
      }

      case 'tunnel-resources': {
        let emitted = 0;
        for (const tunnel of profile.tunnels) {
          if (!tunnel.enabled || tunnel.role !== 'resource') continue;
          const resources = tunnel.resources;
          if (!resources) continue;
          const matcher: Record<string, unknown> = {};
          const parts: string[] = [];
          if (resources.domainSuffix?.length) {
            matcher['domain_suffix'] = resources.domainSuffix;
            parts.push(resources.domainSuffix.join(', '));
          }
          if (resources.ipCidr?.length) {
            matcher['ip_cidr'] = resources.ipCidr;
            parts.push(resources.ipCidr.join(', '));
          }
          if (Object.keys(matcher).length === 0) continue;
          emitted += 1;
          /*
           * A blocking tunnel is reached through its own guard selector, not through its outbound.
           *
           * Pointing the rule at `tunnel.id` makes an unavailable tunnel produce a connection *error*.
           * That is not a refusal: it behaves differently on retry, it leaves no record anyone can read
           * afterwards, and it is decided inside a dial rather than by the routing policy. The guard
           * selector holds the tunnel and `block`, and the health watchdog moves it — so the refusal is a
           * routing decision, it appears in the event ring, and it costs no restart to switch.
           */
          /*
           * A fall-through tunnel is reached through its own fall-through selector (G31), which the
           * watchdog moves to the ordinary route when the tunnel reads dead and back when it reads alive.
           */
          const blocking = tunnel.onUnavailable === 'block';
          const via = blocking ? guardSelectorTag(tunnel.id) : fallThroughSelectorTag(tunnel.id);
          output.push({
            rule: { ...matcher, outbound: via },
            fromIndex: index,
            summary:
              `${parts.join(' and ')} → ${tunnel.name} (${tunnel.id}). ` +
              (blocking
                ? 'If this tunnel is unavailable, that traffic is refused rather than sent another way — ' +
                  'nothing reaches the open network.'
                : 'If this tunnel reads dead, that traffic leaves OUTSIDE the tunnel, the way traffic no ' +
                  `rule names goes (${describeFinalShort(profile)}), and its names are looked up the ordinary ` +
                  'way too; rules below this one are not consulted for it. It goes back into the tunnel ' +
                  'once the tunnel reads alive again.'),
          });
        }
        if (emitted === 0) {
          // A note, not a rule: `null` keeps it out of the generated configuration while still showing the
          // operator that their anchor is here and doing nothing.
          output.push({
            rule: null,
            fromIndex: index,
            summary: 'Nothing — no enabled resource tunnel declares any resources.',
          });
        }
        break;
      }

      case 'private':
        output.push({
          rule: { ip_is_private: true, outbound: target(rule.action.outbound) },
          fromIndex: index,
          summary: `Private address space → ${rule.action.outbound}.`,
        });
        break;

      case 'ruleSet':
        output.push({
          rule: { rule_set: rule.sets, outbound: target(rule.action.outbound) },
          fromIndex: index,
          summary: `Rule sets ${rule.sets.join(', ')} → ${rule.action.outbound}.`,
        });
        break;

      case 'domain':
        output.push({
          rule: { domain: rule.domains, outbound: target(rule.action.outbound) },
          fromIndex: index,
          summary: `Exactly ${describeList(rule.domains)} → ${rule.action.outbound}.`,
        });
        break;

      case 'domainSuffix':
        output.push({
          rule: { domain_suffix: rule.suffixes, outbound: target(rule.action.outbound) },
          fromIndex: index,
          summary: `Any name ending ${describeList(rule.suffixes)} → ${rule.action.outbound}.`,
        });
        break;

      case 'ipCidr':
        output.push({
          rule: { ip_cidr: rule.cidrs, outbound: target(rule.action.outbound) },
          fromIndex: index,
          summary: `${describeList(rule.cidrs)} → ${rule.action.outbound}.`,
        });
        break;
    }
  });

  return output;
}

/** Where unmatched traffic goes, which is the last thing the preview should say. */
export function describeFinal(profile: ProfileDocument): string {
  const alternatives = profile.tunnels.filter(
    (tunnel) => tunnel.enabled && tunnel.role === 'alternative' && !profile.policy.excluded.includes(tunnel.id),
  );
  if (alternatives.length === 0) {
    return profile.policy.onAllDown === 'direct'
      ? 'Everything else goes direct — there is no alternative tunnel enabled.'
      : 'Everything else is blocked — there is no alternative tunnel enabled, and the policy is to block.';
  }
  return `Everything else goes to whichever alternative is selected (${alternatives.map((t) => t.id).join(', ')}).`;
}

/** Where `route.final` sends traffic, in a few words, for the fall-through preview. */
function describeFinalShort(profile: ProfileDocument): string {
  const alternatives = (profile.tunnels ?? []).filter(
    (tunnel) => tunnel.enabled && tunnel.role === 'alternative' && !(profile.policy?.excluded ?? []).includes(tunnel.id),
  );
  if (alternatives.length > 0) return 'whichever alternative tunnel is selected';
  return profile.policy?.onAllDown === 'direct' ? 'on this profile, direct' : 'on this profile, blocked';
}

function target(outbound: string): string {
  if (outbound === 'direct') return CORE_TAGS.direct;
  if (outbound === 'block') return CORE_TAGS.block;
  return outbound;
}

/** A short list in full, a long one truncated — a preview nobody can read is not a preview. */
function describeList(values: string[]): string {
  if (values.length === 0) return '(nothing yet)';
  if (values.length <= 3) return values.join(', ');
  return `${values.slice(0, 3).join(', ')} and ${values.length - 3} more`;
}
