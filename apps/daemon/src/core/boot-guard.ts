/**
 * The two boot-time guards, as pure decisions.
 *
 * ## The problem they exist for
 *
 * The data-plane units are deliberately independent of the daemon, so that a configuration survives
 * a reboot without it. That independence is correct and it is also what makes this failure possible:
 * some generated artefacts encode **the environment** rather than the profile, and the data plane
 * asserts them at every boot without anyone asking whether they still describe the world.
 *
 * Measured on the bench board, 2026-09-20. The board was moved to a different network. Its core
 * configuration still excluded `192.168.1.0/24` — the network it used to be on — and nothing
 * excluded `192.168.77.0/24`, the one it was now plugged into. It took a correct DHCP address and
 * answered nothing, and from outside that is indistinguishable from a dead board. It cost a person a
 * trip to its access point to find out.
 *
 * ## Why re-derive rather than re-check
 *
 * A check can only report; it cannot make the artefact right, and at boot there is nobody to report
 * to. An artefact that encodes the environment must be **re-derived when the environment may have
 * changed**, and a boot is exactly that moment. So the first guard re-derives the discovered facts
 * and rewrites the artefacts that depend on them. It does not re-plan the profile: what the operator
 * asked for is unchanged, and only the values that were read off the device are refreshed.
 *
 * ## Why the failure mode is "the core does not start"
 *
 * A device with no tunnel is inconvenient. A device with a tunnel built on a stale picture of the
 * network is unreachable. Given the choice, fail towards reachable.
 *
 * ## Why the second guard asks a question the device can answer alone
 *
 * After the core is up, every address the device itself holds must still route off a real interface
 * rather than into the tunnel. That needs no external peer, which is precisely what makes it
 * trustworthy: a reachability test against an outside host cannot tell our fault from the network's,
 * so a failure would be ambiguous exactly when it mattered. "Can a packet to an address I hold leave
 * by the interface that holds it" is the same question asked in a form with only one possible
 * culprit.
 */

import { formatIpv4, parseCidr, parseIpv4 } from './invariants.ts';

/** An artefact whose content depends on what was discovered about the environment. */
export interface EnvironmentDependentArtefact {
  path: string;
  content: string;
}

export interface RederiveDecision {
  /** Artefacts whose freshly derived content differs from what is on disk. */
  toWrite: EnvironmentDependentArtefact[];
  /** Every path considered, for a report that says what was checked and not only what changed. */
  considered: string[];
  unchanged: number;
}

/**
 * Which environment-dependent artefacts need rewriting.
 *
 * The allowlist is the point: this guard rewrites the files whose content is derived from discovered
 * facts and **nothing else**. It does not install units, does not start or stop anything, and does
 * not touch a file the profile alone decides. Keeping it narrow is what makes it safe to run
 * unattended, before the daemon, on every boot.
 */
export function decideRederive(input: {
  /** Freshly generated artefacts, from planning the applied document against current reality. */
  generated: EnvironmentDependentArtefact[];
  /** What those paths currently hold; a path absent from the map is treated as different. */
  onDisk: Map<string, string>;
  /** The paths this guard is allowed to rewrite. */
  allowed: readonly string[];
}): RederiveDecision {
  const allowed = new Set(input.allowed);
  const considered: string[] = [];
  const toWrite: EnvironmentDependentArtefact[] = [];
  let unchanged = 0;

  for (const artefact of input.generated) {
    if (!allowed.has(artefact.path)) continue;
    considered.push(artefact.path);
    if (input.onDisk.get(artefact.path) === artefact.content) unchanged += 1;
    else toWrite.push(artefact);
  }

  return { toWrite, considered, unchanged };
}

/**
 * A probe address on one of the networks this device is on: a neighbour, not the device itself.
 *
 * **Asking about our own address proves nothing.** Measured on the bench board, 2026-09-20:
 * `ip route get <an address this device holds>` answers `dev lo` for every one of them, because the
 * kernel resolves it as a local delivery. A check built on that passes on a captured device exactly
 * as happily as on a healthy one — a check that cannot fail.
 *
 * The lockout is about traffic to *other hosts* on the networks we are on: a machine on the LAN
 * sends to us, and our reply goes into the tunnel. So the question has to be asked about a
 * neighbour's address, and the gateway is the neighbour we always know about.
 */
export interface RouteObservation {
  /** The neighbouring address the route was resolved for. */
  address: string;
  /** The interface holding the network that address is on. */
  heldOn: string;
  /**
   * The device `ip route get <address>` resolved to, or `null` when the route could not be read.
   *
   * `null` is not "fine". It is the third value: we do not know. See `assertNoSelfCapture`.
   */
  routesVia: string | null;
}

export interface CaptureFinding {
  address: string;
  heldOn: string;
  routesVia: string | null;
  reason: 'captured' | 'unreadable';
  message: string;
}

/**
 * Whether the device can still reach the networks it is itself on.
 *
 * A violation is an address the device holds whose route leaves through a tunnel device. That is the
 * lockout shape exactly: the interface is up, the address is correct, and the reply never comes back.
 *
 * An **unreadable** route is reported separately and does not count as a pass. "I could not read it"
 * is not "it is fine" — the same three-valued discipline the confirmation window uses — because a
 * guard that treats an unanswerable question as a pass is a guard that stops working silently on the
 * day something goes wrong with it.
 */
export function assertNoSelfCapture(input: {
  observations: RouteObservation[];
  /** Interfaces the core creates. A route leaving through one of these is the capture. */
  tunnelDevices: readonly string[];
}): { ok: boolean; findings: CaptureFinding[] } {
  const tunnels = new Set(input.tunnelDevices);
  const findings: CaptureFinding[] = [];

  for (const observation of input.observations) {
    if (observation.routesVia === null) {
      findings.push({
        ...observation,
        reason: 'unreadable',
        message:
          `The route to ${observation.address}, on the network this device holds ${observation.heldOn} on, ` +
          'could not be read. That is not the same as the route being correct, so it is reported ' +
          'rather than passed over.',
      });
      continue;
    }
    if (tunnels.has(observation.routesVia)) {
      findings.push({
        ...observation,
        reason: 'captured',
        message:
          `Traffic to ${observation.address}, a neighbour on the network this device holds ${observation.heldOn} ` +
          `on, leaves through ${observation.routesVia}, which is the tunnel. Anything on that network ` +
          'that tries to reach this device will get no reply, while every interface looks healthy.',
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

/**
 * A neighbour to ask about, for one address this device holds.
 *
 * The gateway when there is one on the same network, because it is a host we know exists and it is
 * the one every reply to the outside world passes. Otherwise the network's first host address, or
 * the second if the first is us.
 *
 * `null` when the network is too small to contain a neighbour — a /31 or /32 has no third party, and
 * inventing one would produce an address off the network and a meaningless answer.
 */
export function probeAddressFor(input: {
  address: string;
  prefixLength: number;
  /** The gateway on this interface, if one is known. */
  gateway?: string | null;
}): string | null {
  /*
   * Parsing and network arithmetic come from `invariants`, which already owns them.
   *
   * This file previously carried its own — a second set of octet/number conversions with a different
   * internal representation, in the path that decides whether the tunnel may come up at boot. Two
   * implementations of one truth is the shape this project keeps paying for, and here the cost of them
   * drifting is a board that does not come back.
   */
  if (input.prefixLength < 1 || input.prefixLength > 30) return null;
  const own = parseCidr(`${input.address}/${input.prefixLength}`);
  if (own === null) return null;

  // The gateway, when there is one on this network and it is not us: a host we know exists, and the one
  // every reply to the outside world passes through.
  if (input.gateway != null) {
    const gateway = parseCidr(`${input.gateway}/${input.prefixLength}`);
    if (
      gateway !== null &&
      gateway.networkStart === own.networkStart &&
      parseIpv4(input.gateway) !== parseIpv4(input.address)
    ) {
      return input.gateway;
    }
  }

  const ownAddress = parseIpv4(input.address);
  const first = (own.networkStart + 1) >>> 0;
  const candidate = first === ownAddress ? (own.networkStart + 2) >>> 0 : first;
  // Still inside the network: a /30 holds exactly two hosts, so the second candidate can fall outside it.
  return candidate <= own.networkEnd ? formatIpv4(candidate) : null;
}
