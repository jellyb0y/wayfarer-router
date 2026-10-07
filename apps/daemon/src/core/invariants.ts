/**
 * Invariant checks: refusing an impossible configuration with a sentence somebody can act on,
 * instead of letting it become a service that will not start.
 *
 * Every check here comes from a measurement on real hardware, and every one of them carries a
 * **JSON Pointer** into the profile document and a **suggested fix**. Both are part of the contract
 * rather than decoration: the pointer lets the interface put the message on the field, and on a
 * device where a wrong configuration can cost access, an error that does not say what to do instead
 * is only half an error.
 *
 * The rule the whole file obeys: **discover, do not assume.** Nothing below contains a channel
 * list, a capability table or an interface name. Every value is read from the inventory, which read
 * it from the driver.
 *
 * ## Refuse versus warn
 *
 * A check **refuses** when the configuration cannot work, or when it can work but would take the
 * operator's access with it. A check **warns** when the configuration is legal and surprising. The
 * distinction is not stylistic: warnings that are usually wrong teach people to ignore warnings,
 * and a refusal that should have been a warning is the thing standing between somebody and a
 * configuration they actually need.
 */

import type { ProfileDocument } from '@wayfarer/schemas';
import type { Inventory, RadioInventory } from '../inventory/index.ts';
import type { Resolution } from './binding.ts';
import { bandCapabilities } from './radio-capabilities.ts';
import { CATALOGUE_LIST, type CoreCapabilities } from './catalogue/index.ts';

export type Severity = 'error' | 'warning';

export interface Finding {
  severity: Severity;
  /** Stable machine-readable code, matching the API error contract. */
  code: string;
  message: string;
  /** JSON Pointer into the profile document. */
  pointer: string;
  /** What to do instead. Required, not optional — see the note above. */
  hint: string;
  /** The observation behind the finding, in the driver's or the system's own words. */
  detail?: Record<string, unknown>;
}

/**
 * Facts about the running system that a check needs and the inventory does not carry.
 *
 * Gathered by the platform layer and passed in, so the checker stays pure and every case below is
 * reachable from a synthetic fixture rather than from a board in a particular state.
 */
export interface RuntimeFacts {
  /**
   * Proxy cores already running that this project did not start. Two cores fight over the tun
   * device and the same ports, and the loser fails in a way that looks like a configuration error.
   */
  foreignCores: { unit: string; binary: string }[];
  /**
   * Interfaces claimed by another network manager, with the file that claims them. Writing a second
   * claim on an interface is the lockout shape: two sources disagree, and the one that wins is
   * whichever ran last.
   */
  interfaceClaims: { interface: string; by: string; file: string }[];
  /** Interfaces currently carrying a management session. A rename of one of these is not routine. */
  managementInterfaces: string[];
  /** What is installed, for the requirement checks. */
  binaries: { name: string; present: boolean; version: string | null }[];
  /**
   * The networks the uplinks are currently **on**, as CIDRs, discovered from their addresses.
   *
   * A runtime fact and not a profile field, because it cannot be one: the uplink's subnet comes from DHCP
   * or from whatever network the device was plugged into, and the planner is pure. That is precisely why
   * its absence was invisible — nothing in the profile was missing, so no schema, no invariant and no
   * golden file could show the gap.
   *
   * What it is for: the device must keep the return path to the network its uplink is on. Without this the
   * proxy core's `auto_route` captures replies to inbound connections from that network, and the device
   * becomes unreachable from the only way in. Measured on the bench board — this is what locked it out.
   */
  uplinkNetworks: { interface: string; cidr: string }[];
}

export interface InvariantInput {
  profile: ProfileDocument;
  inventory: Inventory;
  /** Resolution per role key: `access-point`, `uplink:<id>`. */
  bindings: Map<string, Resolution>;
  facts: RuntimeFacts;
  /**
   * Every local port this plan will claim, from the one place that knows: the emission.
   *
   * Not re-derived here. The previous version walked the profile looking for ports it recognised,
   * which meant it saw a port a provider had *allocated* only if that provider happened to be one it
   * knew about — so the check inspected a subset of reality and would have passed on exactly the day
   * two providers collided.
   */
  ports?: { port: number; owner: string; pointer: string }[];
  /**
   * What the installed core was discovered to speak, for the catalogue entries' own availability.
   *
   * Optional, and absence means **nothing is known** rather than nothing is offered — which is why
   * the default is `known: false` and not an empty capability set with `known: true`. A test that
   * omits it gets a device that demands no binary on the strength of a core it never read.
   */
  core?: CoreCapabilities;
}

export function checkInvariants(input: InvariantInput): Finding[] {
  return [
    ...checkBindings(input),
    ...checkRadioRoles(input),
    ...checkRegulatory(input),
    ...checkCrossReferences(input),
    ...checkPortCollisions(input),
    ...checkNetwork(input),
    ...checkUplinkAddressing(input),
    ...checkCidrForms(input),
    ...checkForeignOwnership(input),
    ...checkRequirements(input),
    ...checkWirelessCredentials(input),
    ...checkTunnelReality(input),
    ...checkProbeEndpoints(input),
    ...checkResourceTunnelReach(input),
    ...checkTunnelResourceOrder(input),
    ...checkLeakPolicy(input),
  ];
}

/* ── the two settings that are one decision ──────────────────────────────────────────────── */

/**
 * The kill-switch and the all-tunnels-down policy answer the same question for the operator, and can
 * be set to contradict each other.
 *
 * What the operator wants to know is one thing: **can my traffic ever leave this device without going
 * through a tunnel?** Two fields decide it, and they cover two different failures:
 *
 * * `firewall.killSwitch` covers the proxy core not being in the path at all — it is dead, or never
 *   started, or a routing rule sends traffic around it. It is a rule in the **forward** chain:
 *   `iifname <lan> oifname <wan> ct state new reject`.
 * * `policy.onAllDown` covers the core being alive and having no working tunnel. `block` sends traffic
 *   to a rejecting outbound; `direct` sends it out unencrypted, which is a legitimate choice and is
 *   what "fail open" means.
 *
 * Set together as kill-switch **on** and `onAllDown` **direct**, the result is not a compromise — it is
 * the kill-switch silently not doing the thing its name promises, in the *more common* of the two
 * failures. Derived from the ruleset this project generates rather than from a packet capture: the
 * kill-switch rule is in `forward`, and traffic the core emits on its `direct` outbound leaves through
 * `output`, where the generated ruleset marks the device's own traffic `0x1e7` instead of rejecting it.
 * Nothing in the generated ruleset stops it. An operator who turned the kill-switch on has been told
 * their traffic cannot leave outside a tunnel, and when the tunnel dies it will.
 *
 * So this is refused rather than resolved silently, because either resolution would be us deciding
 * something only the operator can decide, and both hints are given in terms of what they lose.
 */
function checkLeakPolicy({ profile }: InvariantInput): Finding[] {
  if (!profile.firewall.killSwitch || profile.policy.onAllDown !== 'direct') return [];
  return [
    {
      severity: 'error',
      code: 'leak_policy_contradiction',
      message:
        'The kill-switch is on, but the policy for when every tunnel is down is to send traffic out ' +
        'directly. Those cannot both be honoured: when the last tunnel fails, traffic will leave this ' +
        'device unencrypted, past the kill-switch, because the kill-switch only stops traffic that is ' +
        'forwarded around the tunnel software and not traffic the tunnel software sends out itself.',
      pointer: '/policy/onAllDown',
      hint:
        'Decide which you want. Set the all-tunnels-down policy to "block" to keep the promise the ' +
        'kill-switch makes — the device stops passing traffic until a tunnel comes back, and clients ' +
        'lose their connection rather than losing their privacy. Or turn the kill-switch off to accept ' +
        'that traffic keeps flowing unprotected when no tunnel is working, and that nothing will warn ' +
        'the people using it.',
      detail: { killSwitch: true, onAllDown: 'direct' },
    },
  ];
}

/* ── probe endpoints ─────────────────────────────────────────────────────────────────────── */

/**
 * The probe endpoints must not be answerable without leaving this device's own networks.
 *
 * A probe exists to measure a tunnel. The core's per-outbound delay test dials through the named
 * outbound, so the *path* is right by construction — but the **destination** still has to be somewhere a
 * tunnel is needed to reach. An endpoint inside the network this device serves, or inside the network it
 * is managed over, is answered locally: the measurement succeeds, returns a small number, and describes
 * nothing about the tunnel it is attributed to. A confident measurement of the wrong thing is worse than
 * a missing one, because it is acted on.
 *
 * Only literal addresses are checked. A hostname cannot be resolved here — this function is pure, and
 * resolving one would make the plan depend on DNS at planning time — so a hostname is accepted and the
 * reasoning is recorded rather than enforced.
 */
/** Networks this device must never lose the return path to. */
function ownNetworksOf({ profile, facts }: InvariantInput): { cidr: string; what: string }[] {
  return [
    ...(networkCidr(profile.network.cidr) === null
      ? []
      : [{ cidr: networkCidr(profile.network.cidr)!, what: 'the network this device serves' }]),
    ...facts.uplinkNetworks.map((entry) => ({
      cidr: entry.cidr,
      what: `the network this device is managed over, via ${entry.interface}`,
    })),
  ];
}

/** True when `outer` contains every address in `inner`. */
function covers(outer: string, inner: string): boolean {
  const a = parseCidr(outer);
  const b = parseCidr(inner);
  if (a === null || b === null) return false;
  return a.networkStart <= b.networkStart && a.networkEnd >= b.networkEnd;
}

/**
 * A destination tunnel whose ranges contain the network this device is managed over.
 *
 * Corporate ranges are legitimately broad — an internal name set can span `10.0.0.0/8` and
 * `192.168.0.0/16`, which between them cover almost all private space including the network this board is
 * reached on and the one it serves. **The range is not the problem and is not refused here.** Refusing it
 * would make a tunnel the operator genuinely needs unconfigurable, and they would be right to be annoyed.
 *
 * What is refused is the **ordering** that makes it fatal. With such a tunnel present, moving
 * `protect-own-networks` below the rules that carry those ranges sends this device's own management traffic
 * into the tunnel: the operator's session goes with it, and the device stops being reachable from the only
 * direction that could undo it. Anchors stay movable, as already decided — movable everywhere except into
 * the one position that cannot be undone from outside the building.
 *
 * The warning fires whenever such a tunnel exists at all, even when the order is correct, and it names the
 * overlap and says why the anchor is pinned in this profile. A constraint the operator understands is a
 * feature; one that appears from nowhere when they drag a rule is a bug with good intentions.
 */
function checkResourceTunnelReach(input: InvariantInput): Finding[] {
  const { profile } = input;
  const findings: Finding[] = [];
  const own = ownNetworksOf(input);
  if (own.length === 0) return findings;

  const rules = profile.routing.rules;
  const protectAt = rules.findIndex((rule) => rule.kind === 'protect-own-networks');
  const resourcesAt = rules.findIndex((rule) => rule.kind === 'tunnel-resources');

  /** Ranges in the document that would take one of our own networks with them, and where they came from. */
  const claims: { cidr: string; mine: { cidr: string; what: string }; pointer: string; label: string }[] = [];

  profile.tunnels.forEach((tunnel, index) => {
    if (!tunnel.enabled || tunnel.role !== 'resource') return;
    (tunnel.resources?.ipCidr ?? []).forEach((value, cidrIndex) => {
      for (const mine of own) {
        if (!covers(value, mine.cidr)) continue;
        claims.push({
          cidr: value,
          mine,
          pointer: `/tunnels/${index}/resources/ipCidr/${cidrIndex}`,
          label: `"${tunnel.name}"`,
        });
      }
    });
  });

  if (claims.length === 0) return findings;

  // The ordering refusal. `protect-own-networks` missing counts as "below everything": there is nothing
  // keeping our own networks direct at all.
  const ordered = protectAt !== -1 && (resourcesAt === -1 || protectAt < resourcesAt);
  if (!ordered) {
    const first = claims[0]!;
    findings.push({
      severity: 'error',
      code: 'own_network_unprotected_order',
      message:
        `${first.label} claims ${first.cidr}, which contains ${first.mine.cidr} — ${first.mine.what}. ` +
        (protectAt === -1
          ? 'This profile has no "protect own networks" rule, so nothing keeps that network direct.'
          : 'The "protect own networks" rule is below the tunnel rules, so it no longer keeps that network ' +
            'direct.') +
        ' Applying this would send this device\'s own management traffic into the tunnel, and it would stop ' +
        'being reachable from the only direction that could undo it.',
      pointer: protectAt === -1 ? '/routing/rules' : `/routing/rules/${protectAt}`,
      hint:
        'Put "protect own networks" above the tunnel rules. The tunnel\'s range itself is fine and does not ' +
        'need narrowing — it is the order that decides whether this device keeps its own network.',
      detail: { claims: claims.map((c) => ({ range: c.cidr, contains: c.mine.cidr })), protectAt, resourcesAt },
    });
    return findings;
  }

  for (const claim of claims) {
    findings.push({
      severity: 'warning',
      code: 'resource_tunnel_covers_own_network',
      message:
        `${claim.label} claims ${claim.cidr}, which contains ${claim.mine.cidr} — ${claim.mine.what}. ` +
        'The rule keeping that network direct is above it, so this is correct as written — and while this ' +
        'tunnel exists, that rule cannot be moved below it.',
      pointer: claim.pointer,
      hint:
        'Nothing to change. This is here so the pinned rule order is explained rather than surprising if ' +
        'you try to move it later.',
      detail: { claimed: claim.cidr, contains: claim.mine.cidr, what: claim.mine.what },
    });
  }

  return findings;
}

/**
 * One destination tunnel's ranges swallowing another's, so the second never receives anything.
 *
 * The resource anchor emits one rule per tunnel **in the order the tunnels are listed**, and the core takes
 * the first rule that matches. So a tunnel claiming `10.0.0.0/8` listed before one claiming `10.148.0.0/16`
 * leaves the second unreachable: it is configured, it connects, it appears healthy, and no traffic is ever
 * routed to it.
 *
 * This is the same shape as a generated rule that matched everything — valid, plausible, and doing the
 * opposite of what was meant — which is why it is detected rather than documented. "List the narrow ones
 * first" in a document is advice nobody reads at the moment they reorder two tunnels.
 *
 * Total containment is refused: the later tunnel cannot receive the traffic it exists for, which is not a
 * legal-but-surprising configuration, it is one that cannot do what it says. A partial overlap warns,
 * because splitting a range across two tunnels is a real thing an operator may mean.
 */
function checkTunnelResourceOrder({ profile }: InvariantInput): Finding[] {
  const findings: Finding[] = [];
  const resources = profile.tunnels
    .map((tunnel, index) => ({ tunnel, index }))
    .filter((entry) => entry.tunnel.enabled && entry.tunnel.role === 'resource');

  for (let earlier = 0; earlier < resources.length; earlier += 1) {
    for (let later = earlier + 1; later < resources.length; later += 1) {
      const a = resources[earlier]!;
      const b = resources[later]!;

      for (const wide of a.tunnel.resources?.ipCidr ?? []) {
        for (const narrow of b.tunnel.resources?.ipCidr ?? []) {
          if (!covers(wide, narrow) || wide === narrow) continue;
          findings.push({
            severity: 'error',
            code: 'tunnel_range_shadowed',
            message:
              `"${a.tunnel.name}" (${a.tunnel.id}) claims ${wide}, which contains ${narrow} claimed by ` +
              `"${b.tunnel.name}" (${b.tunnel.id}). Because it is listed first, it takes that traffic and ` +
              `"${b.tunnel.name}" never receives any — it will connect, look healthy, and carry nothing.`,
            pointer: `/tunnels/${b.index}/resources/ipCidr`,
            hint:
              `List "${b.tunnel.name}" before "${a.tunnel.name}". The narrower range has to come first, ` +
              'because the first matching rule wins.',
            detail: { earlier: a.tunnel.id, later: b.tunnel.id, wide, narrow },
          });
        }
      }

      for (const wide of a.tunnel.resources?.domainSuffix ?? []) {
        for (const narrow of b.tunnel.resources?.domainSuffix ?? []) {
          if (narrow === wide || !narrow.endsWith(wide)) continue;
          findings.push({
            severity: 'error',
            code: 'tunnel_suffix_shadowed',
            message:
              `"${a.tunnel.name}" (${a.tunnel.id}) claims the suffix "${wide}", which already matches ` +
              `"${narrow}" claimed by "${b.tunnel.name}" (${b.tunnel.id}). Listed first, it takes those ` +
              `names and "${b.tunnel.name}" never receives them.`,
            pointer: `/tunnels/${b.index}/resources/domainSuffix`,
            hint: `List "${b.tunnel.name}" before "${a.tunnel.name}", so the more specific suffix is tried first.`,
            detail: { earlier: a.tunnel.id, later: b.tunnel.id, wide, narrow },
          });
        }
      }
    }
  }

  return findings;
}

function checkProbeEndpoints({ profile, facts }: InvariantInput): Finding[] {
  const findings: Finding[] = [];
  const endpoints = profile.policy.probes.endpoints ?? [];

  // Networks this device answers for itself: the one it serves, and the ones it is reached over.
  const ownNetworks: { cidr: string; what: string }[] = [
    ...(networkCidr(profile.network.cidr) === null
      ? []
      : [{ cidr: networkCidr(profile.network.cidr)!, what: 'the network this device serves' }]),
    ...facts.uplinkNetworks.map((entry) => ({
      cidr: entry.cidr,
      what: `a network this device is on, via ${entry.interface}`,
    })),
  ];

  endpoints.forEach((endpoint, index) => {
    const host = hostOf(endpoint);
    if (host === null) {
      findings.push({
        severity: 'error',
        code: 'invariant_violation',
        message: `The probe endpoint "${endpoint}" is not a URL this device can fetch.`,
        pointer: `/policy/probes/endpoints/${index}`,
        hint: 'Give a full URL, such as http://example.invalid/generate_204.',
      });
      return;
    }
    const address = parseIpv4(host);
    if (address === null) return; // A hostname. See the note above.

    for (const own of ownNetworks) {
      const parsed = parseCidr(own.cidr);
      if (parsed === null) continue;
      if (address >= parsed.networkStart && address <= parsed.networkEnd) {
        findings.push({
          severity: 'error',
          code: 'invariant_violation',
          message:
            `The probe endpoint "${endpoint}" is inside ${own.cidr} — ${own.what}. It would be answered ` +
            'without going through any tunnel, so every tunnel would measure as healthy against it and ' +
            'the numbers would describe the local network rather than the tunnel they are attributed to.',
          pointer: `/policy/probes/endpoints/${index}`,
          hint: 'Use an address that can only be reached by leaving this device.',
        });
        return;
      }
    }
  });

  return findings;
}

/** The host part of a URL, or `null` when it is not one. */
function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
}

/* ── wireless credentials ────────────────────────────────────────────────────────────────── */

/** WPA-PSK's own bounds. A passphrase outside them has no key, at either end of the link. */
const WPA_PASSPHRASE_MIN = 8;
const WPA_PASSPHRASE_MAX = 63;
/** An SSID is 32 **bytes**, not 32 characters. */
const SSID_MAX_BYTES = 32;

/**
 * What WPA itself will not accept, reported as a finding rather than discovered at run time.
 *
 * Both halves of the radio are checked in one place, because the rules are the standard's and are the
 * same whether we are hosting the network or joining it. Getting this wrong is not a crash: hostapd
 * refuses to start, or the supplicant associates with nothing, and neither says which field was the
 * problem.
 *
 * The SSID bound is in bytes on purpose. `maxLength` in the schema counts UTF-16 code units, so a name
 * of 32 accented or non-Latin characters passes validation and is then too long for the air.
 */
/* ── Reality: two values that are one credential ─────────────────────────────────────────── */

/**
 * A tunnel that says `security: 'reality'` and does not carry what a Reality handshake needs.
 *
 * `tunnel-configs.ts` carried the sentence *"Only when `security` is `reality`. Both are needed
 * together; the invariants say so."* beside these two fields, and **no such check existed**. That is
 * the second time this repository has found that exact shape: the wired uplink's address and gateway
 * carried the same claim, with the same absence behind it, and the note recorded then is the one that
 * applies here — *a comment claiming a check exists is worse than no comment, because it stops the
 * next reader looking.*
 *
 * The consequence is not a degraded tunnel. `nativeOutbound` emits `tls.reality = { enabled: true }`
 * with no key, and the proxy core either refuses to load the whole core configuration — **taking
 * every tunnel that shares that file with it** — or completes no handshake and says nothing. The
 * external carrier is the same bargain in its own file. Neither outcome names the field, and nothing
 * on this device measures a handshake, so the tunnel reports `active` throughout.
 *
 * Errors rather than warnings, both, because neither state has a working reading:
 *
 * * **No public key** is a Reality handshake with no server key to disguise itself as. There is
 *   nothing partial about it.
 * * **A public key and no short id** is the half-credential the comment was about. It is the one it
 *   would be tempting to make a warning, and that is backwards for the usual reason: the pair is
 *   issued together by whoever runs the server, so one without the other is a transcription that
 *   stopped halfway, and the failure it produces looks like anything but a missing field.
 *
 * Disabled tunnels are skipped, on the same argument as the uplinks: refusing activation over the
 * configuration of something switched off makes the switch useless.
 */
function checkTunnelReality({ profile }: InvariantInput): Finding[] {
  const findings: Finding[] = [];

  profile.tunnels.forEach((tunnel, index) => {
    if (!tunnel.enabled) return;
    if (tunnel.protocol !== 'vless') return;
    if (tunnel.config.security !== 'reality') return;

    const name = `Tunnel "${tunnel.name}"`;
    const publicKey = tunnel.config.realityPublicKey ?? '';
    const shortId = tunnel.config.realityShortId ?? '';

    if (publicKey === '') {
      findings.push({
        severity: 'error',
        code: 'reality_without_public_key',
        message:
          `${name} is set to use Reality and carries no public key, so there is nothing for the ` +
          'handshake to disguise itself as. The client would start and never connect, and nothing ' +
          'on this device measures a handshake, so the tunnel would report itself as running.',
        pointer: `/tunnels/${index}/config/realityPublicKey`,
        hint:
          'Paste the public key from the link or from whoever runs the server — the `pbk` parameter ' +
          'in a `vless://` link — or change this tunnel’s transport security to TLS if the server is ' +
          'not a Reality server.',
        detail: { security: 'reality' },
      });
      return;
    }

    if (shortId === '') {
      findings.push({
        severity: 'error',
        code: 'reality_without_short_id',
        message:
          `${name} has a Reality public key and no short id. The two are issued together by whoever ` +
          'runs the server, so one without the other is a credential that was copied halfway, and ' +
          'the server will refuse the handshake without saying which field was wrong.',
        pointer: `/tunnels/${index}/config/realityShortId`,
        hint:
          'Paste the short id from the same place as the public key — the `sid` parameter in a ' +
          '`vless://` link.',
        detail: { security: 'reality' },
      });
    }
  });

  return findings;
}

function checkWirelessCredentials({ profile }: InvariantInput): Finding[] {
  const findings: Finding[] = [];

  const checkSsid = (ssid: string, pointer: string, what: string): void => {
    const bytes = Buffer.byteLength(ssid, 'utf8');
    if (bytes > SSID_MAX_BYTES) {
      findings.push({
        severity: 'error',
        code: 'invariant_violation',
        message:
          `The ${what} network name is ${bytes} bytes long and the limit is ${SSID_MAX_BYTES}. ` +
          'A network name is measured in bytes rather than characters, so accented or non-Latin ' +
          'characters reach the limit sooner than the text looks.',
        pointer,
        hint: 'Shorten the name.',
      });
    }
  };

  const checkPassphrase = (value: unknown, pointer: string, what: string): void => {
    // Only a passphrase this device can actually read is checked. A redacted or absent one is a
    // different fault, reported where secrets are handled, and guessing its length here would invent
    // a finding about a value nobody has.
    const text = plainSecret(value);
    if (text === null) return;
    if (text.length < WPA_PASSPHRASE_MIN || text.length > WPA_PASSPHRASE_MAX) {
      findings.push({
        severity: 'error',
        code: 'invariant_violation',
        message:
          `The ${what} passphrase is ${text.length} characters. WPA accepts between ` +
          `${WPA_PASSPHRASE_MIN} and ${WPA_PASSPHRASE_MAX}, and a value outside that range produces ` +
          'no key at either end of the link.',
        pointer,
        // Deliberately says nothing about the value itself beyond its length.
        hint: 'Use a passphrase of at least eight characters.',
      });
    }
  };

  if (profile.accessPoint !== null) {
    checkSsid(profile.accessPoint.ssid, '/accessPoint/ssid', 'access point\u2019s');
    checkPassphrase(profile.accessPoint.passphrase, '/accessPoint/passphrase', 'access point\u2019s');
  }

  profile.uplinks.forEach((uplink, index) => {
    if (uplink.kind !== 'wifi-sta' || uplink.enabled === false) return;
    checkSsid(uplink.config.ssid, `/uplinks/${index}/config/ssid`, `"${uplink.id}" uplink\u2019s`);
    checkPassphrase(uplink.config.psk, `/uplinks/${index}/config/psk`, `"${uplink.id}" uplink\u2019s`);
  });

  return findings;
}

/**
 * The readable text of a secret, or `null` when there is nothing readable to check.
 *
 * Never returned to a caller that logs, and never part of a finding's message.
 */
function plainSecret(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (value !== null && typeof value === 'object' && '$secret' in value) {
    const inner = (value as { $secret: unknown }).$secret;
    const text = Array.isArray(inner) ? inner.join('\n') : inner;
    return typeof text === 'string' && text !== '' ? text : null;
  }
  return null;
}

/* ── bindings ────────────────────────────────────────────────────────────────────────────── */

function checkBindings({ bindings, profile }: InvariantInput): Finding[] {
  const findings: Finding[] = [];

  for (const [role, resolution] of bindings) {
    const pointer = role === 'access-point' ? '/accessPoint/bind' : `/uplinks/${uplinkIndexOf(profile, role)}/bind`;

    if (resolution.state === 'unbound') {
      findings.push({
        // An unbound role is a *state*. It is reported as an error only because a profile cannot be
        // activated while a required role is unbound — the document itself stays valid, which is
        // what lets it be imported onto different hardware and fixed rather than rejected.
        severity: 'error',
        code: 'role_unbound',
        message: `The ${describeRole(role)} is not bound to any hardware on this device: ${resolution.reason}.`,
        pointer,
        hint:
          resolution.candidates.length > 0
            ? `Pick one of the detected candidates: ${resolution.candidates.map((entry) => entry.label).join('; ')}.`
            : 'Attach the hardware this profile expects, or change this role to use what is present.',
        detail: { candidates: resolution.candidates },
      });
    }

    if (resolution.state === 'ambiguous') {
      findings.push({
        severity: 'error',
        code: 'role_ambiguous',
        message: `The ${describeRole(role)} matches more than one piece of hardware: ${resolution.reason}`,
        pointer,
        hint:
          'Bind this role by bus path instead. It is the only selector that separates two identical ' +
          `devices: ${resolution.candidates.map((entry) => entry.label).join('; ')}.`,
        detail: { candidates: resolution.candidates },
      });
    }
  }

  return findings;
}

/* ── radios ──────────────────────────────────────────────────────────────────────────────── */

function checkRadioRoles(input: InvariantInput): Finding[] {
  const { profile, inventory, bindings } = input;
  const findings: Finding[] = [];
  const accessPoint = profile.accessPoint;
  if (accessPoint === null) return findings;

  const apResolution = bindings.get('access-point');
  if (apResolution?.state !== 'bound' || apResolution.phy === null) return findings;

  const radio = inventory.radios.find((entry) => entry.phy === apResolution.phy);
  if (!radio) return findings;

  // Can this radio host an access point at all? An access-point configuration that claims a
  // capability the driver does not have simply fails to start, with no useful message.
  if (!radio.derived.canHostAccessPoint.value) {
    findings.push({
      severity: 'error',
      code: 'radio_cannot_host_ap',
      message: `${radio.phy} does not support access-point mode.`,
      pointer: '/accessPoint/bind',
      hint: alternativeApRadios(inventory, radio.phy),
      detail: { observed: radio.derived.canHostAccessPoint.from },
    });
    return findings;
  }

  // The combination check. Measured on the bench board's built-in radio: one combination,
  // `#{ managed, AP } <= 1, … total <= 3, #channels <= 2` — managed and AP share a budget of one,
  // which is a hard driver limit and not a policy.
  const wifiUplinkOnSameRadio = profile.uplinks.find((uplink) => {
    if (uplink.kind !== 'wifi-sta') return false;
    const resolution = bindings.get(`uplink:${uplink.id}`);
    return resolution?.state === 'bound' && resolution.phy === apResolution.phy;
  });

  if (wifiUplinkOnSameRadio) {
    const together = radio.derived.accessPointAndClientTogether.value;
    const observed = radio.derived.accessPointAndClientTogether.from;

    if (!together.supported) {
      findings.push({
        severity: 'error',
        code: 'invariant_violation',
        message:
          `${radio.phy} cannot host an access point and associate as a client at the same time. ` +
          `The driver publishes: ${observed}`,
        pointer: '/accessPoint/bind',
        hint:
          `Put the access point on a second radio, or give "${wifiUplinkOnSameRadio.id}" an ` +
          'Ethernet uplink instead. Two roles on one radio needs a driver that says it is possible.',
        detail: { phy: radio.phy, combination: observed },
      });
    } else if (together.sameChannelOnly && accessPoint.acceptChannelFollowsUplink !== true) {
      findings.push({
        severity: 'error',
        code: 'channel_follows_uplink_unacknowledged',
        message:
          `${radio.phy} can host an access point and a client together, but only on one channel: ` +
          `${observed}. The access point will therefore follow whatever channel the upstream ` +
          'network is on, and the upstream can change channel without asking.',
        pointer: '/accessPoint/acceptChannelFollowsUplink',
        hint:
          'Set acceptChannelFollowsUplink to true to accept that the channel is not yours to ' +
          'choose, or move one of the two roles to another radio.',
        detail: { phy: radio.phy, combination: observed, requestedChannel: accessPoint.radio.channel },
      });
    } else if (together.sameChannelOnly) {
      findings.push({
        // Acknowledged, so not a refusal — but the configured channel is now decoration, and an
        // interface that keeps showing it as a setting is lying about what the device will do.
        severity: 'warning',
        code: 'channel_ignored',
        message:
          `The access-point channel (${accessPoint.radio.channel}) will be ignored: ${radio.phy} ` +
          'hosts both roles on a single channel, which the upstream network chooses.',
        pointer: '/accessPoint/radio/channel',
        hint: 'No action needed. Move the access point to another radio if you need a fixed channel.',
        detail: { combination: observed },
      });
    }
  }

  findings.push(...checkChannelSupport(radio, accessPoint));
  return findings;
}

/**
 * True when the kernel has not established a country for this radio, while the profile names one.
 *
 * `00` is the kernel saying "no country has been established", not a country. In that state every
 * 5 GHz band is published as passive-scan — that is, `no-IR` — so **every** 5 GHz channel reads as
 * forbidden for an access point. The permission is not a property of the radio; it is a property of
 * a regulatory domain that has not been set yet, and that this very apply establishes: hostapd sets
 * it from the `country_code` the generator writes, at start-up, before it brings the interface up.
 *
 * Measured on the bench board, 2026-09-21: after a reboot `iw reg get` reported `country 00:
 * DFS-UNSET` with `(5170 - 5250 @ 80) ... PASSIVE-SCAN`, and the apply for a profile asking for
 * `country_code=DE, channel=36` was refused with `channel_no_initiating_radiation`. The access point
 * had run on that exact channel before the reboot, because the domain had been established by then.
 *
 * So the check was deciding a question the action it blocked would have answered — and it is
 * self-locking in the same shape as a clock that cannot be corrected because correcting it needs the
 * network: the domain is established by hostapd, hostapd is started by the apply, and the apply was
 * refused for want of the domain. After a reboot the device could never bring its own access point
 * back up on 5 GHz, which from the other side of the radio is simply a network that stopped existing.
 */
function regulatoryNotYetEstablished(
  radio: RadioInventory,
  accessPoint: NonNullable<ProfileDocument['accessPoint']>,
): boolean {
  const applied = radio.reported.regulatory.country;
  return (applied === null || applied === '00') && accessPoint.radio.country !== '00';
}

function checkChannelSupport(radio: RadioInventory, accessPoint: NonNullable<ProfileDocument['accessPoint']>): Finding[] {
  const findings: Finding[] = [];
  const wanted = accessPoint.radio;
  // Whether a permission can be decided at all right now. Not "assume it is allowed": the finding is
  // still reported, as a warning that says which question is open and who answers it.
  const undecidable = regulatoryNotYetEstablished(radio, accessPoint);

  const channel = radio.derived.channels.find(
    (entry) => entry.channel === wanted.channel && entry.band === wanted.band,
  );

  if (!channel) {
    const offered = radio.derived.channels
      .filter((entry) => entry.band === wanted.band && !entry.disabled)
      .map((entry) => entry.channel)
      .filter((entry): entry is number => entry !== null);
    findings.push({
      severity: 'error',
      code: 'channel_unavailable',
      message: `${radio.phy} does not offer channel ${wanted.channel} on ${wanted.band}.`,
      pointer: '/accessPoint/radio/channel',
      hint:
        offered.length > 0
          ? `Available on this radio in this band: ${offered.join(', ')}.`
          : `This radio reports no usable channel on ${wanted.band}. Choose another band.`,
      detail: { phy: radio.phy, band: wanted.band, offered },
    });
    return findings;
  }

  if (channel.disabled) {
    findings.push({
      severity: undecidable ? 'warning' : 'error',
      code: 'channel_disabled',
      message: undecidable
        ? `Channel ${wanted.channel} reads as disabled on ${radio.phy}, but no country has been ` +
          `established yet — the kernel reports the world domain, which disables it. The access ` +
          `point sets country ${wanted.country} when it starts, and the channel is decided then.`
        : `Channel ${wanted.channel} is disabled on ${radio.phy} in the current regulatory domain.`,
      pointer: '/accessPoint/radio/channel',
      hint: undecidable
        ? 'Nothing to change. If the access point still fails to start, the country and the channel ' +
          'genuinely disagree and the channel is the one to change.'
        : 'Choose a channel the driver reports as usable, or check the regulatory domain.',
      detail: { flags: channel.flags, regulatoryEstablished: !undecidable },
    });
  }

  if (channel.noInitiatingRadiation) {
    findings.push({
      severity: undecidable ? 'warning' : 'error',
      code: 'channel_no_initiating_radiation',
      message: undecidable
        ? `Channel ${wanted.channel} is marked "no initiating radiation", but that mark comes from ` +
          `the world regulatory domain, which is what the kernel reports when no country has been ` +
          `established. The access point sets country ${wanted.country} when it starts; the ` +
          `restriction is decided then, not now.`
        : `Channel ${wanted.channel} is marked "no initiating radiation", which means this radio may ` +
          'listen on it but may not start an access point there.',
      pointer: '/accessPoint/radio/channel',
      hint: undecidable
        ? 'Nothing to change. This is reported rather than hidden because if the access point does ' +
          'fail to start, this is the line that explains why.'
        : 'Choose a channel without that restriction. The interface lists which ones qualify.',
      detail: { flags: channel.flags, regulatoryEstablished: !undecidable },
    });
  }

  if (channel.requiresRadarDetection) {
    findings.push({
      severity: 'warning',
      code: 'channel_requires_radar_detection',
      message:
        `Channel ${wanted.channel} requires radar detection. The access point will wait through a ` +
        'channel-availability check before it starts, and it will move if radar is detected.',
      pointer: '/accessPoint/radio/channel',
      hint: 'Expect a delay of a minute or more before clients can associate. Choose a channel without a radar requirement to avoid it.',
      detail: { flags: channel.flags, maxTxPowerDbm: channel.maxTxPowerDbm },
    });
  }

  /**
   * The width the radio actually chose, reported beside the one that was asked for — never reconciled.
   *
   * Measured on the bench board, 2026-09-21: a profile asking for channel 36 at **80 MHz** produced
   * `channel 36 (5180 MHz), width: 40 MHz` on the live interface. The apply succeeded, the access point
   * worked, and nothing anywhere said the width was not what had been requested.
   *
   * That is the shape this project treats as its dominant failure: the operator was told one thing and
   * the hardware did another, with nothing reconciling the two. It is the same defect as a check that
   * describes a truth instead of deriving it from the truth — and the answer is the same one already
   * reached for the channel. **The profile states a request; the device reports what happened; both stay
   * visible.**
   *
   * So this does not rewrite `width` to match the radio. Doing so would destroy the operator's stated
   * intention, and the next driver that honours 80 MHz would then silently behave differently from this
   * one for reasons nobody could find. The request is the request.
   *
   * Only reported when the running channel and band are the ones being asked for, because otherwise the
   * live reading describes some *other* configuration — a draft mid-edit, or the profile before this
   * change — and attributing that difference to the radio would be a second wrong claim.
   */
  const live = radio.reported.interfaces.find(
    (entry) => entry.type === 'AP' && entry.channel === wanted.channel && entry.widthMhz !== null,
  );
  if (live !== undefined && live.widthMhz !== wanted.width) {
    findings.push({
      severity: 'warning',
      code: 'width_not_honoured',
      message:
        `You asked for ${wanted.width} MHz on channel ${wanted.channel}. The radio is running ` +
        `${live.widthMhz} MHz. The difference is ${radio.phy}'s decision, not this device's — the ` +
        'profile still asks for what you set.',
      pointer: '/accessPoint/radio/width',
      hint:
        `Nothing is wrong and nothing needs changing: the access point is working at ${live.widthMhz} MHz. ` +
        `Set the width to ${live.widthMhz} only if you want the profile to state what this radio does ` +
        'rather than what you would prefer it to do.',
      detail: { requested: wanted.width, effective: live.widthMhz, phy: radio.phy, interface: live.name },
    });
  }

  // Width is checked against what the driver published **for the configured band**, not against the
  // first band that has any frequencies. Observed on the bench board's built-in radio: VHT
  // capabilities 0x01b07031 — 80 MHz supported, 160 and 80+80 not.
  const band = bandCapabilities(radio, wanted.band);
  if (wanted.width > 20 && band?.vhtCapabilitiesHex == null && band?.htCapabilitiesHex == null) {
    findings.push({
      severity: 'error',
      code: 'width_unsupported',
      message:
        `${radio.phy} publishes no HT or VHT capabilities on ${wanted.band}, so it cannot use a ` +
        `${wanted.width} MHz channel there.`,
      pointer: '/accessPoint/radio/width',
      hint: 'Set the width to 20 MHz.',
      detail: { phy: radio.phy },
    });
  }

  return findings;
}

/* ── regulatory ──────────────────────────────────────────────────────────────────────────── */

function checkRegulatory({ profile, inventory, bindings }: InvariantInput): Finding[] {
  const findings: Finding[] = [];
  const accessPoint = profile.accessPoint;
  if (accessPoint === null) return findings;

  const resolution = bindings.get('access-point');
  if (resolution?.state !== 'bound' || resolution.phy === null) return findings;
  const radio = inventory.radios.find((entry) => entry.phy === resolution.phy);
  if (!radio) return findings;

  const regulatory = radio.reported.regulatory;

  // A radio's own domain wins over the global one, and a radio missing from the output follows the
  // global domain — both measured on the bench board, where the global block reported `country US`
  // while the built-in radio reported `country 00`, a different channel set and a different power
  // limit. Reading only the first block applies the wrong limits to a radio the kernel is treating
  // as world-domain.
  if (regulatory.country !== null && regulatory.country !== accessPoint.radio.country) {
    findings.push({
      severity: 'warning',
      code: 'regulatory_mismatch',
      message:
        `The profile asks for country ${accessPoint.radio.country}, but the kernel currently applies ` +
        `${regulatory.country} to ${radio.phy} (${regulatory.source === 'own' ? "the radio's own domain" : 'the global domain'}).`,
      pointer: '/accessPoint/radio/country',
      hint:
        'The driver enforces its own view, so the channels and power limits that apply are the ' +
        "kernel's, not the profile's. Align the two, or expect the stricter of them.",
      detail: { requested: accessPoint.radio.country, applied: regulatory.country, source: regulatory.source },
    });
  }

  const channel = radio.derived.channels.find(
    (entry) => entry.channel === accessPoint.radio.channel && entry.band === accessPoint.radio.band,
  );
  if (channel?.maxTxPowerDbm !== null && channel?.maxTxPowerDbm !== undefined && channel.maxTxPowerDbm <= 14) {
    findings.push({
      severity: 'warning',
      code: 'low_power_channel',
      message:
        `Channel ${accessPoint.radio.channel} is limited to ${channel.maxTxPowerDbm} dBm here. ` +
        'The difference between that and a 23 dBm channel is the difference between good and unusable coverage.',
      pointer: '/accessPoint/radio/channel',
      hint: 'Choose a channel with a higher permitted power if range matters more than a clear channel.',
      detail: { maxTxPowerDbm: channel.maxTxPowerDbm },
    });
  }

  return findings;
}

/* ── cross references ────────────────────────────────────────────────────────────────────── */

/** Outbound names that are reserved words rather than tunnel ids. */
const RESERVED_OUTBOUNDS = new Set(['direct', 'block']);

function checkCrossReferences({ profile }: InvariantInput): Finding[] {
  const findings: Finding[] = [];
  const tunnelIds = new Set(profile.tunnels.map((tunnel) => tunnel.id));
  const enabledAlternatives = new Set(
    profile.tunnels.filter((tunnel) => tunnel.enabled && tunnel.role === 'alternative').map((tunnel) => tunnel.id),
  );

  const seen = new Set<string>();
  profile.tunnels.forEach((tunnel, index) => {
    if (seen.has(tunnel.id)) {
      findings.push({
        severity: 'error',
        code: 'duplicate_tunnel_id',
        // A tunnel id becomes the core's outbound tag. Two objects with one tag is a configuration
        // the core rejects, and it rejects it by name, which is unhelpful when the name is correct.
        message: `Two tunnels share the id "${tunnel.id}", which becomes a routing tag and must be unique.`,
        pointer: `/tunnels/${index}/id`,
        hint: 'Rename one of them.',
      });
    }
    seen.add(tunnel.id);

    if (RESERVED_OUTBOUNDS.has(tunnel.id)) {
      findings.push({
        severity: 'error',
        code: 'reserved_tunnel_id',
        message: `"${tunnel.id}" is a reserved routing target and cannot be a tunnel id.`,
        pointer: `/tunnels/${index}/id`,
        hint: `Reserved names: ${[...RESERVED_OUTBOUNDS].join(', ')}.`,
      });
    }
  });

  profile.policy.priority.forEach((id, index) => {
    if (!tunnelIds.has(id)) {
      findings.push({
        severity: 'error',
        code: 'unknown_tunnel_reference',
        message: `The failover order names "${id}", which is not a tunnel in this profile.`,
        pointer: `/policy/priority/${index}`,
        hint: 'Remove it, or add the tunnel it refers to.',
      });
    } else if (!enabledAlternatives.has(id)) {
      findings.push({
        severity: 'warning',
        code: 'priority_names_non_alternative',
        message: `"${id}" is in the failover order but is not an enabled alternative, so it will never be selected.`,
        pointer: `/policy/priority/${index}`,
        hint: 'Set its role to "alternative" and enable it, or remove it from the order.',
      });
    }
  });

  profile.policy.excluded.forEach((id, index) => {
    if (!tunnelIds.has(id)) {
      findings.push({
        severity: 'warning',
        code: 'unknown_tunnel_reference',
        message: `The exclusion list names "${id}", which is not a tunnel in this profile.`,
        pointer: `/policy/excluded/${index}`,
        hint: 'Remove it. An exclusion for a tunnel that does not exist has no effect.',
      });
    }
  });

  const ruleSetTags = new Set(profile.routing.ruleSets.map((set) => set.tag));
  profile.routing.rules.forEach((rule, index) => {
    if ('action' in rule) {
      const target = rule.action.outbound;
      if (!RESERVED_OUTBOUNDS.has(target) && !tunnelIds.has(target)) {
        findings.push({
          severity: 'error',
          code: 'unknown_tunnel_reference',
          message: `Routing rule ${index + 1} sends traffic to "${target}", which is not a tunnel in this profile.`,
          pointer: `/routing/rules/${index}/action/outbound`,
          hint: `Use a tunnel id, or one of: ${[...RESERVED_OUTBOUNDS].join(', ')}.`,
        });
      }
    }
    if (rule.kind === 'ruleSet') {
      rule.sets.forEach((tag, setIndex) => {
        if (!ruleSetTags.has(tag)) {
          findings.push({
            severity: 'error',
            code: 'unknown_rule_set',
            message: `Routing rule ${index + 1} uses the rule set "${tag}", which is not defined in this profile.`,
            pointer: `/routing/rules/${index}/sets/${setIndex}`,
            hint: 'Define it under routing.ruleSets, or remove the reference.',
          });
        }
      });
    }
  });

  findings.push(...checkRuleSets(profile));
  findings.push(...checkAnchorOrder(profile));
  return findings;
}

/**
 * A rule set has to be fetchable, or the core will not start.
 *
 * This is not a tidiness check. The proxy core resolves every rule set at start-up, and one it cannot
 * obtain is a fatal configuration error for the whole process — so a `remote` set with no URL, or a
 * `local` set with no path, does not degrade into "that rule matches nothing". It takes the tunnels, the
 * access point's routing and the management path's exemptions down with it, and the symptom is a unit
 * that will not start rather than anything naming the rule set.
 *
 * Refused at plan time, where it is one field with a pointer, instead of at apply time where it is a
 * service that failed for reasons the operator has to read a journal to discover.
 */
function checkRuleSets(profile: ProfileDocument): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, number>();

  profile.routing.ruleSets.forEach((set, index) => {
    const pointer = `/routing/ruleSets/${index}`;

    const first = seen.get(set.tag);
    if (first !== undefined) {
      findings.push({
        severity: 'error',
        code: 'duplicate_rule_set_tag',
        message:
          `Two rule sets are both called "${set.tag}" (entries ${first + 1} and ${index + 1}). A rule ` +
          'naming it would silently get one of them, and which one is not something this profile states.',
        pointer: `${pointer}/tag`,
        hint: 'Give each rule set its own tag.',
      });
    } else {
      seen.set(set.tag, index);
    }

    if (set.type === 'remote' && !set.url) {
      findings.push({
        severity: 'error',
        code: 'rule_set_unfetchable',
        message:
          `The rule set "${set.tag}" is remote but has no URL, so the proxy core cannot obtain it. ` +
          'A rule set it cannot obtain stops the core starting altogether — this would not merely make ' +
          'one rule match nothing, it would leave the device with no tunnels and no routing.',
        pointer: `${pointer}/url`,
        hint: 'Give it a URL, or change its type to "local" and give it a path.',
      });
    }

    if (set.type === 'local' && !set.path) {
      findings.push({
        severity: 'error',
        code: 'rule_set_unfetchable',
        message:
          `The rule set "${set.tag}" is local but has no path, so the proxy core cannot read it, and a ` +
          'rule set it cannot read stops the core starting altogether.',
        pointer: `${pointer}/path`,
        hint: 'Give it a path to a file on this device, or change its type to "remote" and give it a URL.',
      });
    }

    if (set.type === 'remote' && set.path) {
      findings.push({
        severity: 'warning',
        code: 'rule_set_mixed_source',
        message: `The rule set "${set.tag}" is remote and also names a path, which is ignored.`,
        pointer: `${pointer}/path`,
        hint: 'Remove the path, so the profile says where this comes from without a reader having to know which field wins.',
      });
    }

    if (set.type === 'local' && set.url) {
      findings.push({
        severity: 'warning',
        code: 'rule_set_mixed_source',
        message: `The rule set "${set.tag}" is local and also names a URL, which is ignored.`,
        pointer: `${pointer}/url`,
        hint: 'Remove the URL.',
      });
    }

    /*
     * A remote rule set needs the network at start-up, and the device may have none yet.
     *
     * Not an error, because it is a legitimate configuration that works on a device with a working
     * uplink, and refusing it would make this feature unusable. A warning, because the failure it
     * predicts is the confusing kind: the core does not start, nothing mentions the rule set, and the
     * device looks broken in a way that has nothing to do with what was just changed.
     */
    if (set.type === 'remote' && profile.uplinks.filter((uplink) => uplink.enabled).length === 0) {
      findings.push({
        severity: 'warning',
        code: 'rule_set_needs_uplink',
        message:
          `The rule set "${set.tag}" is downloaded at start-up, and this profile has no enabled uplink. ` +
          'If the device cannot reach the network when the proxy core starts, the core will not start at ' +
          'all — and the message it gives will not mention this rule set.',
        pointer: `${pointer}/url`,
        hint:
          'Add an uplink, or use a local rule set with a file on the device, which needs no network. A ' +
          'device that must come up without an uplink should not depend on a download.',
      });
    }
  });

  return findings;
}

/**
 * The anchor-order warning.
 *
 * Anchors are movable, including below a tunnel rule, and this is a **warning** on purpose. Private
 * address space overlaps heavily — corporate networks routinely occupy large parts of 10/8 and
 * 192.168/16, which is also where the management network and the access point live — so a rule
 * sending 192.168.0.0/16 into a tunnel above the protect anchor takes the operator's own management
 * traffic with it, and the device is gone until the revert window brings it back.
 *
 * It is not a refusal because a locked rule would eventually be the thing standing between someone
 * and a configuration they actually need, and because the warning names exactly what will be lost.
 */
function checkAnchorOrder(profile: ProfileDocument): Finding[] {
  const findings: Finding[] = [];
  const protectIndex = profile.routing.rules.findIndex((rule) => rule.kind === 'protect-own-networks');

  if (protectIndex === -1) {
    findings.push({
      severity: 'warning',
      code: 'protect_anchor_absent',
      message:
        'This profile has no "protect own networks" rule, so nothing guarantees that traffic to the ' +
        'local network and the uplink stays off the tunnel.',
      pointer: '/routing/rules',
      hint:
        'Add the protect-own-networks anchor, normally first. Without it, a rule matching private ' +
        'address space can capture the management network.',
    });
    return findings;
  }

  const tunnelRuleAbove = profile.routing.rules.findIndex(
    (rule, index) =>
      index < protectIndex &&
      'action' in rule &&
      !RESERVED_OUTBOUNDS.has(rule.action.outbound),
  );

  if (tunnelRuleAbove !== -1) {
    const rule = profile.routing.rules[tunnelRuleAbove]!;
    findings.push({
      severity: 'warning',
      code: 'anchor_below_tunnel_rule',
      message:
        `Rule ${tunnelRuleAbove + 1} sends traffic into a tunnel above the "protect own networks" ` +
        'anchor. If it matches the local network or the uplink network, management traffic goes into ' +
        'the tunnel and this device becomes unreachable.',
      pointer: `/routing/rules/${tunnelRuleAbove}`,
      hint:
        'Move the protect anchor above it, unless sending your own networks through that tunnel is ' +
        'what you intend.',
      detail: { ruleKind: rule.kind, target: 'action' in rule ? rule.action.outbound : null },
    });
  }

  return findings;
}

/* ── ports ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Local listener collisions.
 *
 * Reads the port registry the emission produced, plus the ports this project's own configuration
 * fixes. Nothing here re-derives a port from a provider's configuration: the provider is the only
 * thing that knows which port it took.
 *
 * A collision with software this device does not manage is a different question, answered by the
 * foreign-ownership checks — "port 9090 is busy" and "another proxy core is running" are the same fact
 * with very different fixes.
 */
function checkPortCollisions({ profile, ports }: InvariantInput): Finding[] {
  const findings: Finding[] = [];
  const claimed = new Map<number, { owner: string; pointer: string }>();

  const claim = (port: number, owner: string, pointer: string): void => {
    const existing = claimed.get(port);
    if (existing !== undefined && existing.owner !== owner) {
      findings.push({
        severity: 'error',
        code: 'port_collision',
        message: `Port ${port} is claimed by both ${existing.owner} and ${owner}.`,
        pointer,
        hint: `Give one of them a different local port. ${existing.owner} claims it at ${existing.pointer}.`,
        detail: { port, owners: [existing.owner, owner] },
      });
      return;
    }
    claimed.set(port, { owner, pointer });
  };

  const clashPort = Number(profile.services.clashApi.bind.split(':').pop());
  if (Number.isInteger(clashPort)) claim(clashPort, "the core's control API", '/services/clashApi/bind');

  for (const entry of ports ?? []) claim(entry.port, entry.owner, entry.pointer);

  return findings;
}

/* ── the local network ───────────────────────────────────────────────────────────────────── */

/**
 * A CIDR that names a host where a network is meant.
 *
 * Checked as an invariant rather than left to each generator, because it is a **class** of mistake: the
 * value looks right, most consumers normalise it, and the one that does not fails somewhere unrelated. It
 * reached the generated routing exclusions as `10.44.0.1/24` and was correct only because the proxy core
 * happened to read it as the containing network.
 *
 * A warning rather than an error, and the asymmetry is the point: the device's own address with its prefix
 * is exactly how `network.cidr` is *meant* to be written, so the same text is right in one field and wrong
 * in another. What is flagged is a **blocked endpoint** written that way, where the operator plainly meant
 * a range and will get a different one.
 */
function checkCidrForms({ profile }: InvariantInput): Finding[] {
  const findings: Finding[] = [];

  profile.firewall.blockedEndpoints.forEach((entry, index) => {
    const value = entry.ipCidr;
    if (typeof value !== 'string' || value === '' || value.includes(':')) return;
    if (!isHostAddressWithPrefix(value)) return;
    findings.push({
      severity: 'warning',
      code: 'cidr_names_a_host',
      message:
        `${value} names a single host with a network prefix, which is almost certainly not what was ` +
        `meant. It is treated as ${networkCidr(value) ?? value}, which is a larger range.`,
      pointer: `/firewall/blockedEndpoints/${index}/ipCidr`,
      hint:
        `Write ${networkCidr(value) ?? value} for the whole range, or ${value.split('/')[0] ?? value}/32 ` +
        'for just that one address. Both are unambiguous; this is not.',
      detail: { given: value, interpretedAs: networkCidr(value) },
    });
  });

  return findings;
}

/**
 * Whether an uplink takes its address from DHCP.
 *
 * One reader, exported, because the generator asks the same question and the two must not be able to
 * disagree about what the flag means. The two kinds spell the default differently — the wired one
 * states `dhcp` and the wireless one leaves it optional — and a second copy of this expression is a
 * second chance to get the absent case backwards. Absent means DHCP, on both, which is what the
 * schema's `default: true` says.
 */
export function uplinkUsesDhcp(uplink: ProfileDocument['uplinks'][number]): boolean {
  return uplink.config.dhcp ?? true;
}

/**
 * A statically addressed uplink that was never given an address.
 *
 * `dhcp: false` reads as *I will configure this myself*, and the schema offers `address` and
 * `gateway` for exactly that — but until 2026-09-21 **nothing required them**, while a comment in
 * `profile.ts` said the invariant checks did. The generator was the only reader of those fields, so
 * the flag off with neither field set produced an interface with `DHCP=no`, no address and no route:
 * a link that comes up, reports carrier, and can reach nothing. Nothing reported it, because there
 * was nothing to report it — and the next reader who wondered stopped at the comment.
 *
 * An error rather than a warning on both counts, because neither state has a working reading:
 *
 * * **No address** is an interface with no addressing at all. It is not degraded, it is inert.
 * * **An address with no gateway** is an interface that can reach its own subnet and nothing beyond
 *   it. That one is worse to leave as a warning, not better, because it half-works: the link is up,
 *   the address is right, and the failure looks like anything but addressing.
 *
 * Disabled uplinks are skipped. A profile is allowed to carry an uplink it is not using, and
 * refusing activation over the configuration of something that is switched off would make the switch
 * useless.
 */
function checkUplinkAddressing({ profile }: InvariantInput): Finding[] {
  const findings: Finding[] = [];

  profile.uplinks.forEach((uplink, index) => {
    if (uplink.enabled === false) return;
    if (uplinkUsesDhcp(uplink)) return;

    const name = `The "${uplink.id}" uplink`;
    const address = uplink.config.address ?? null;
    const gateway = uplink.config.gateway ?? null;

    if (address === null || address === '') {
      findings.push({
        severity: 'error',
        code: 'uplink_static_without_address',
        message:
          `${name} is set to be configured by hand and has no address, so it would come up with no ` +
          'addressing at all — the link would show as connected and reach nothing.',
        pointer: `/uplinks/${index}/config/address`,
        hint:
          'Give it an address with a prefix length, e.g. 192.168.1.50/24, and the gateway to reach ' +
          'the rest of the network through — or turn automatic addressing back on and let the ' +
          'network hand both out.',
        detail: { kind: uplink.kind, dhcp: false },
      });
    }

    if (gateway === null || gateway === '') {
      findings.push({
        severity: 'error',
        code: 'uplink_static_without_gateway',
        message:
          `${name} is set to be configured by hand and has no gateway, so it could reach its own ` +
          'network and nothing past it. It would never carry traffic out, whatever its failover ' +
          'priority says.',
        pointer: `/uplinks/${index}/config/gateway`,
        hint:
          'Give it the address of the router on that network — or turn automatic addressing back ' +
          'on and let the network hand it out.',
        detail: { kind: uplink.kind, dhcp: false, address },
      });
    }
  });

  return findings;
}

function checkNetwork({ profile, inventory }: InvariantInput): Finding[] {
  const findings: Finding[] = [];
  const parsed = parseCidr(profile.network.cidr);

  if (parsed === null) {
    findings.push({
      severity: 'error',
      code: 'invalid_cidr',
      message: `"${profile.network.cidr}" is not an address with a prefix length, e.g. 10.44.0.1/24.`,
      pointer: '/network/cidr',
      hint: 'Give the device its own address and the prefix, not the network address.',
    });
    return findings;
  }

  const { from, to } = profile.network.dhcp;
  for (const [value, field] of [
    [from, 'from'],
    [to, 'to'],
  ] as const) {
    const address = parseIpv4(value);
    if (address === null || !inSameNetwork(address, parsed)) {
      findings.push({
        severity: 'error',
        code: 'dhcp_range_outside_network',
        message: `The DHCP range ${field} address ${value} is not inside ${profile.network.cidr}.`,
        pointer: `/network/dhcp/${field}`,
        hint: `Choose an address inside the local network.`,
      });
    }
  }

  const deviceAddress = parseIpv4(parsed.address);
  const fromAddress = parseIpv4(from);
  const toAddress = parseIpv4(to);
  if (deviceAddress !== null && fromAddress !== null && toAddress !== null) {
    if (deviceAddress >= fromAddress && deviceAddress <= toAddress) {
      findings.push({
        severity: 'error',
        code: 'dhcp_range_contains_device',
        message:
          `The DHCP range includes this device's own address (${parsed.address}), so a client could ` +
          'be handed the router\'s address and the local network would stop working for everyone.',
        pointer: '/network/dhcp/from',
        hint: `Start the range above ${parsed.address}.`,
      });
    }
    if (fromAddress > toAddress) {
      findings.push({
        severity: 'error',
        code: 'dhcp_range_inverted',
        message: `The DHCP range starts at ${from} and ends at ${to}, which is backwards.`,
        pointer: '/network/dhcp/to',
        hint: 'Swap the two addresses.',
      });
    }
  }

  // A LAN on the same subnet as an uplink makes the return path ambiguous: the kernel has two routes
  // to the same network and picks by metric, which is not something the operator chose.
  for (const address of inventory.interfaces.flatMap((entry) => entry.addresses)) {
    if (address.family !== 'inet') continue;
    const other = parseIpv4(address.address);
    if (other !== null && inSameNetwork(other, parsed) && address.address !== parsed.address) {
      findings.push({
        severity: 'warning',
        code: 'lan_overlaps_existing_network',
        message:
          `The local network ${profile.network.cidr} overlaps an address already on this device ` +
          `(${address.address}/${address.prefixLength}). Traffic to that range has two possible paths.`,
        pointer: '/network/cidr',
        hint: 'Choose a local network that does not overlap anything the device is already attached to.',
      });
      break;
    }
  }

  findings.push(...checkBlockedEndpoints(profile));
  return findings;
}

/**
 * Blocked endpoints that cannot be enforced as written.
 *
 * Every one of these was previously dropped by the firewall generator without a word, so an operator
 * added a block, saw it in the profile and in plan review, and it did not exist. A rule the user can
 * see must either work or say why it does not.
 */
function checkBlockedEndpoints(profile: ProfileDocument): Finding[] {
  const findings: Finding[] = [];

  profile.firewall.blockedEndpoints.forEach((entry, index) => {
    const pointer = `/firewall/blockedEndpoints/${index}`;

    if (entry.domain === undefined && entry.ipCidr === undefined) {
      findings.push({
        severity: 'error',
        code: 'blocked_endpoint_empty',
        message: 'A blocked endpoint names neither a domain nor an address, so it matches nothing.',
        pointer,
        hint: 'Give it a domain, an address range, or remove it.',
      });
      return;
    }

    if (entry.ipCidr === undefined) return;

    if (entry.ipCidr.includes(':')) {
      findings.push({
        // A warning, not a refusal: the entry is redundant rather than wrong, and refusing would make
        // a profile written for a future IPv6 mode unusable today.
        severity: 'warning',
        code: 'blocked_endpoint_ipv6_redundant',
        message:
          `The blocked endpoint ${entry.ipCidr} is an IPv6 address, and this profile rejects IPv6 at ` +
          'the access point already — so no client can reach it whether this entry exists or not.',
        pointer: `${pointer}/ipCidr`,
        hint:
          'Nothing to do: the entry is unnecessary rather than broken. It will start being enforced ' +
          'on its own if IPv6 ever gains a mode other than "block".',
        detail: { ipCidr: entry.ipCidr },
      });
      return;
    }

    if (parseCidr(entry.ipCidr) === null && parseIpv4(entry.ipCidr) === null) {
      findings.push({
        severity: 'error',
        code: 'blocked_endpoint_unparseable',
        message: `The blocked endpoint "${entry.ipCidr}" is not an address this device can match on.`,
        pointer: `${pointer}/ipCidr`,
        hint: 'Use an IPv4 address, optionally with a prefix length, such as 198.51.100.0/24.',
      });
    }
  });

  return findings;
}

/* ── things that already own the system ──────────────────────────────────────────────────── */

/**
 * The two ownership checks, and why they refuse rather than warn.
 *
 * This project owns only what it generates: files under its own directory, and units whose names it
 * produced. It never adopts a unit somebody else installed, and never writes a second claim on an
 * interface another manager already configures. Both checks exist because the alternative is a
 * configuration that works until the other side runs.
 */
function checkForeignOwnership({ profile, facts, bindings }: InvariantInput): Finding[] {
  const findings: Finding[] = [];

  if (facts.foreignCores.length > 0 && profile.tunnels.some((tunnel) => tunnel.enabled)) {
    const core = facts.foreignCores[0]!;
    findings.push({
      severity: 'error',
      code: 'foreign_core_running',
      message:
        `A proxy core this device did not start is already running (${core.unit}, ${core.binary}). ` +
        'Two cores contend for the same tunnel device and the same local ports, and the one that ' +
        'loses fails in a way that looks like a configuration mistake.',
      pointer: '/tunnels',
      hint: `Stop and disable ${core.unit} before applying a profile with tunnels, or run this device without them.`,
      detail: { foreignCores: facts.foreignCores },
    });
  }

  // Every interface this profile intends to own, by the name it will be pinned to *and* by the name
  // it currently has — a claim is written against whichever the other manager knows. The role is
  // carried alongside, because whether a claim may be cleared is now a per-role decision.
  const intended = new Map<string, { role: string; pointer: string; takeOver: boolean }>();
  for (const [role, resolution] of bindings) {
    if (resolution.state !== 'bound') continue;
    const pointer = role === 'access-point' ? '/accessPoint' : `/uplinks/${uplinkIndexOf(profile, role)}`;
    const takeOver =
      role === 'access-point'
        ? profile.accessPoint?.takeOverInterface === true
        : profile.uplinks[uplinkIndexOf(profile, role)]?.takeOverInterface === true;
    const entry = { role, pointer, takeOver };
    intended.set(resolution.name, entry);
    if (resolution.currentName !== null) intended.set(resolution.currentName, entry);
  }

  for (const claim of facts.interfaceClaims) {
    const owner = intended.get(claim.interface);
    if (owner === undefined) continue;

    if (owner.takeOver) {
      // Allowed, and still worth saying out loud in the plan review. Clearing a claim moves another
      // program's file, which is not something to discover afterwards from a directory listing.
      findings.push({
        severity: 'warning',
        code: 'interface_takeover_planned',
        message:
          `${claim.interface} is currently configured by ${claim.by} (${claim.file}), and this profile ` +
          'will take it over. That file is moved aside, never deleted, and a revert inside the ' +
          'confirmation window puts it back.',
        pointer: `${owner.pointer}/takeOverInterface`,
        hint:
          `After this is confirmed, ${claim.by} no longer configures ${claim.interface}. The file it ` +
          'used is kept on the device with a suffix saying what happened to it.',
        detail: claim as unknown as Record<string, unknown>,
      });
      continue;
    }

    findings.push({
      severity: 'error',
      code: 'interface_claimed_elsewhere',
      message:
        `${claim.interface} is already configured by ${claim.by} (${claim.file}). Writing a second ` +
        'configuration for it would leave two sources disagreeing, and the one that takes effect ' +
        'would be whichever ran last.',
      pointer: `${owner.pointer}/takeOverInterface`,
      hint:
        `Set takeOverInterface on this role to move ${claim.file} aside as part of the apply — it ` +
        `happens inside the confirmation window, so it is undone automatically if the device does not ` +
        `come back. Or remove ${claim.interface} from that file by hand, or bind this role to an ` +
        'interface nothing else manages.',
      detail: claim as unknown as Record<string, unknown>,
    });
  }

  return findings;
}

/* ── requirements ────────────────────────────────────────────────────────────────────────── */

function checkRequirements({ profile, facts, core }: InvariantInput): Finding[] {
  const findings: Finding[] = [];
  const present = new Set(facts.binaries.filter((entry) => entry.present).map((entry) => entry.name));

  const need = (binary: string, why: string, pointer: string): void => {
    if (present.has(binary)) return;
    findings.push({
      severity: 'error',
      code: 'binary_missing',
      message: `${binary} is not installed, and it is needed for ${why}.`,
      pointer,
      hint: `Install ${binary} on the device. This daemon never downloads executables.`,
      detail: { binary },
    });
  };

  if (profile.accessPoint !== null) need('hostapd', 'hosting an access point', '/accessPoint');
  if (profile.network.dhcp.enabled) need('dnsmasq', 'handing out addresses', '/network/dhcp/enabled');
  if (profile.tunnels.some((tunnel) => tunnel.enabled)) need('sing-box', 'the data plane', '/tunnels');

  /**
   * What each tunnel's protocol needs, **asked of the catalogue entry rather than of its name.**
   *
   * This was a line reading `tunnel.provider === 'openvpn'` and requiring `openvpn`. Every other
   * protocol's binary requirement simply did not exist here, because there was no place to put it
   * that was not a second branch on a second name — and the obfuscation client, which will not start
   * without `ck-client`, was never checked at all. The requirement now comes from the entry that
   * knows it: one walk, no names, and Epic F's protocols are covered on the day they are appended.
   *
   * `core` may say nothing is known, and then every entry must behave as though everything is
   * offered. Absence of knowledge about the core is not a negative answer, and demanding a binary on
   * the strength of it is how an unfinished fetch turns into an error about an unrelated thing.
   */
  const capabilities = core ?? { known: false, outboundTypes: new Set<string>() };
  for (const entry of CATALOGUE_LIST) {
    const index = profile.tunnels.findIndex((tunnel) => tunnel.enabled && tunnel.protocol === entry.id);
    if (index < 0) continue;

    const availability = entry.availability({ core: capabilities, installed: present });
    if (availability.available) continue;

    const pointer = `/tunnels/${index}/protocol`;
    for (const requirement of availability.requires ?? []) {
      need(requirement.binary, requirement.neededFor, pointer);
    }
    if ((availability.requires ?? []).length === 0) {
      findings.push({
        severity: 'error',
        code: 'protocol_unavailable',
        message: `${entry.title} cannot run on this device. ${availability.reason ?? ''}`.trim(),
        pointer,
        hint:
          'Nothing has stopped: tunnels already running are independent of this daemon. Disable this ' +
          'tunnel, or use a protocol this device can run.',
        detail: { protocol: entry.id },
      });
    }
  }

  return findings;
}

/* ── helpers ─────────────────────────────────────────────────────────────────────────────── */

function describeRole(role: string): string {
  if (role === 'access-point') return 'access point';
  return `uplink "${role.slice('uplink:'.length)}"`;
}

/**
 * The position of an uplink in the list, from its id.
 *
 * Looked up, not parsed. The previous version read `Number(role.split(':')[1])` — an *id*, not an
 * index — so every real id produced `NaN` and fell back to zero, and every unbound-role finding
 * pointed at the first uplink. A pointer that is confidently wrong sends somebody to fix a
 * configuration that was never broken, which is worse than no pointer at all.
 */
function uplinkIndexOf(profile: ProfileDocument, role: string): number {
  const id = role.slice('uplink:'.length);
  const index = profile.uplinks.findIndex((uplink) => uplink.id === id);
  // Not found means the binding outlived the uplink, which the cross-reference checks report. The
  // pointer then names the list rather than an element that is not there.
  return index >= 0 ? index : 0;
}

function alternativeApRadios(inventory: Inventory, exclude: string): string {
  const capable = inventory.radios.filter(
    (radio) => radio.phy !== exclude && radio.derived.canHostAccessPoint.value,
  );
  if (capable.length === 0) {
    return 'No radio on this device reports access-point support, so this device cannot host one.';
  }
  return `These radios do support it: ${capable.map((radio) => radio.phy).join(', ')}.`;
}

export interface ParsedCidr {
  address: string;
  prefixLength: number;
  networkStart: number;
  networkEnd: number;
}

export function parseCidr(value: string): ParsedCidr | null {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const address = parseIpv4(match[1]!);
  const prefixLength = Number(match[2]);
  if (address === null || prefixLength < 0 || prefixLength > 32) return null;

  // `>>> 0` because a 32-bit shift in JavaScript produces a signed value, and a mask of /0 shifts by
  // 32, which is a no-op rather than zero — both are quiet wrong answers.
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const networkStart = (address & mask) >>> 0;
  const networkEnd = (networkStart | (~mask >>> 0)) >>> 0;
  return { address: match[1]!, prefixLength, networkStart, networkEnd };
}

/**
 * The **network** form of a CIDR: `10.44.0.1/24` becomes `10.44.0.0/24`.
 *
 * A host address carrying a prefix length is not a network, and writing one where a network is meant is a
 * silent class of bug rather than a visible one — a consumer may read it as the containing network, as a
 * single host, or reject it, and all three look plausible in a configuration file. It reached the generated
 * routing exclusions on the bench board as `10.44.0.1/24`, which is the network by luck rather than by
 * construction.
 *
 * Returns null for anything unparseable, so a caller has to decide rather than receive a guess.
 */
export function networkCidr(value: string): string | null {
  const parsed = parseCidr(value);
  if (parsed === null) return null;
  return `${formatIpv4(parsed.networkStart)}/${parsed.prefixLength}`;
}

/**
 * A 32-bit address back into dotted-quad form.
 *
 * Exported because a second implementation of it appeared elsewhere, with a different internal
 * representation, in a path that decides whether the tunnel may come up at boot. Two implementations of
 * one truth is the catalogued shape, and the cost of them drifting there is a board that does not come
 * back.
 */
export function formatIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

/** True when a CIDR names a host rather than the network it is in, which is almost always a mistake. */
export function isHostAddressWithPrefix(value: string): boolean {
  const normalised = networkCidr(value);
  return normalised !== null && normalised !== value.trim();
}

export function parseIpv4(value: string): number | null {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

function inSameNetwork(address: number, cidr: ParsedCidr): boolean {
  return address >= cidr.networkStart && address <= cidr.networkEnd;
}
