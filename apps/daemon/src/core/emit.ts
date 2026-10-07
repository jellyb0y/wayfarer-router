/**
 * What each enabled tunnel contributes to the desired state, asked of the catalogue.
 *
 * This replaces a file called `providers.ts` that switched on a provider name across five branches
 * and carried four schemas of its own. The switch is gone because there is nothing left to switch
 * on: a tunnel names a catalogue entry, the entry is looked up in a total map, and the entry
 * decides its own binary, files, units, ports and interfaces. Adding a protocol in Epic F touches
 * `TUNNEL_CONFIGS` and the catalogue's list, and does not touch this file.
 *
 * ## What left with the old file, and why none of it is hidden
 *
 * The `raw` provider, the two loose `command` + `configFile` + `localPort` schemas and the separate
 * `transports` channel are **deleted**. Keeping any of them behind a flag would keep exactly the
 * inconsistency Epic E exists to remove — a second way to configure a tunnel, untyped, unchecked,
 * and the one everybody reaches for when the designed screen does not do what they want. See
 * [04-tunnels-and-protocols](../../../../docs/04-tunnels-and-protocols.md).
 *
 * `transportFiles` and `transportUnits` were a second channel out of this function because a
 * transport was not a tunnel and had no core object of its own. An obfuscation entry point is now
 * part of the `Cloak + OpenVPN` entry, so its files and units arrive in that entry's plan, through
 * the one channel every other artefact already used.
 *
 * ## Ports
 *
 * The range is owned here rather than by an entry, because collision is a property of the device and
 * not of a protocol. An entry asks for a port and says who is asking; it never reads one from a
 * profile and never picks a number. Every port handed out is reported in `ports`, so the collision
 * check sees all of reality rather than the part it can recognise — an invariant that inspects a
 * subset of reality is one that passes on the day it matters.
 */

import { isStoredSecret, isTunnelProtocol, TUNNEL_CONFIGS, type ProfileDocument } from '@wayfarer/schemas';
import type { JsonSchemaNode, ValidatorCache } from '@wayfarer/protocols';
import {
  catalogueEntry,
  outsideCatalogue,
  type CarrierChoice,
  type CoreCapabilities,
  type EntryPlanContext,
  type InstalledBinaries,
} from './catalogue/index.ts';
import type { TunnelEmission } from './planner.ts';

/** The loopback ports this daemon hands out. Stated once, and reported in the message when it runs out. */
const PORT_RANGE = { first: 10_800, last: 10_899 } as const;

export interface EmitInput {
  profile: ProfileDocument;
  /** What the installed core turned out to speak. Availability discovery only; no entry plans from it. */
  core: CoreCapabilities;
  /** Binaries found on this device, so a refusal can say what to install rather than guess. */
  installed: InstalledBinaries;
  /** Ports already taken, so an entry cannot be handed one that is spoken for. */
  allocatedPorts: Set<number>;
}

/** A local port this device will listen on, and what claimed it. */
export interface PortClaim {
  port: number;
  /** Who holds it, in words, for the collision message. */
  owner: string;
  /** JSON Pointer at the field nearest the claim, so a collision can be traced to what made it. */
  pointer: string;
}

/**
 * A tunnel that will not be planned, and why.
 *
 * Carries the protocol as well as the tunnel, because a refusal that names only the tunnel sends a
 * person looking at the wrong field. Every refusal in this epic has this shape.
 */
export interface TunnelRefusal {
  tunnelId: string;
  tunnelName: string;
  /** What the profile said it was. A string rather than a `TunnelProtocol`: it may be neither. */
  protocol: string;
  /** JSON Pointer into the profile, so the interface can land the message on the field. */
  pointer: string;
  reason: string;
  /** What to install, when that is the answer. */
  requires?: { binary: string; neededFor: string }[];
}

export interface EmitResult {
  emissions: Map<string, TunnelEmission>;
  ports: PortClaim[];
  /** Tunnels the catalogue would not plan. Findings, never silence: see the note in the loop. */
  refusals: TunnelRefusal[];
  /**
   * Which carrier runs each tunnel that had a choice to make, by tunnel id.
   *
   * Reported because the owner cannot be asked — he holds a link, not a preference — and a choice
   * made on his behalf without a sentence explaining it is the confident answer nobody can account
   * for afterwards. The planner puts these in the plan he reads before applying.
   */
  carriers: Map<string, CarrierChoice>;
}

export function emitTunnels(input: EmitInput): EmitResult {
  const emissions = new Map<string, TunnelEmission>();
  const carriers = new Map<string, CarrierChoice>();
  const refusals: TunnelRefusal[] = [];
  const ports: PortClaim[] = [];
  const taken = new Set(input.allocatedPorts);

  const allocatePort = (claim: { owner: string; pointer: string }): number => {
    for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port += 1) {
      if (taken.has(port)) continue;
      taken.add(port);
      ports.push({ port, owner: claim.owner, pointer: claim.pointer });
      return port;
    }
    throw new Error(
      `no local port is free in the range this daemon allocates from (${PORT_RANGE.first}–${PORT_RANGE.last})`,
    );
  };

  input.profile.tunnels.forEach((tunnel, index) => {
    if (!tunnel.enabled) return;

    /**
     * The runtime guard on a field the type system already narrows.
     *
     * `tunnel.protocol` is a literal union in the schema, so this branch is unreachable from a
     * document that was validated. A document read from storage, written by a newer build, or
     * handed in by an import is not necessarily one that was — and a tunnel silently producing no
     * emission is a profile that appears to apply cleanly while doing less than it says.
     */
    if (!isTunnelProtocol(tunnel.protocol)) {
      refusals.push({
        tunnelId: tunnel.id,
        tunnelName: tunnel.name,
        protocol: String((tunnel as { protocol?: unknown }).protocol ?? ''),
        pointer: `/tunnels/${index}/protocol`,
        reason: outsideCatalogue({ tunnelId: tunnel.id, protocol: (tunnel as { protocol?: unknown }).protocol }),
      });
      return;
    }

    /**
     * Availability is **not** consulted here, and that is a change from the file this replaces.
     *
     * The old emitter skipped a tunnel whose provider was unavailable, so a device missing a binary
     * showed no diff for that tunnel at all — the operator saw a finding about `openvpn` and an
     * apparently empty change. Whether this device *can* run a protocol is an invariant check, which
     * reports `binary_missing` naming the binary and the tunnel; planning continues, because the plan
     * review shows the diff alongside the findings and nothing is applied while an error stands.
     *
     * So there is one question here and it is a different one: can this *configuration* be planned.
     */
    const entry = catalogueEntry(tunnel.protocol);

    const context: EntryPlanContext = {
      tunnel: { id: tunnel.id, name: tunnel.name, index },
      core: input.core,
      installed: input.installed,
      allocatePort,
    };

    const planned = entry.plan(tunnel.config, context);
    if (!planned.ok) {
      refusals.push({
        tunnelId: planned.refusal.tunnelId,
        tunnelName: tunnel.name,
        protocol: planned.refusal.protocol,
        pointer: planned.refusal.pointer,
        reason: planned.refusal.reason,
      });
      return;
    }

    const { plan } = planned;
    emissions.set(tunnel.id, {
      target: plan.target,
      object: plan.object,
      ...(plan.files.length > 0 ? { files: plan.files } : {}),
      ...(plan.units.length > 0 ? { units: plan.units } : {}),
      ...(plan.interfaces.length > 0 ? { interfaces: plan.interfaces } : {}),
    });
    if (plan.carrier !== undefined) carriers.set(tunnel.id, plan.carrier);
  });

  return { emissions, ports, refusals, carriers };
}

/* ── validating a tunnel's configuration before it is embedded ───────────────────────────── */

export interface TunnelValidationIssue {
  tunnelIndex: number;
  /** JSON Pointer into the *profile document*, so the interface can land on the field. */
  pointer: string;
  message: string;
}

/**
 * Validates every enabled tunnel's configuration against **its own catalogue entry's schema**.
 *
 * Runs before anything is embedded or written, and that position is the whole point: a bad field
 * found here produces a JSON Pointer into the profile, which the interface puts on the offending
 * input. The same fault found later arrives as a unit that will not start, after files have been
 * written and other units restarted, with a message about a file the operator never wrote.
 *
 * **The schema is now ours and static.** It used to come from the installed binary, which meant a
 * device with no core could not check a configuration — and, worse, could not store one. The
 * validator cache survives because compiling is not free on a four-core board, but the key no longer
 * carries a core version: these schemas change when this repository does.
 *
 * It does not replace the core's own `check` on the generated file. A schema pass catches a wrong
 * type, a missing required field and an unknown key; it cannot catch a well-formed field the binary
 * has deprecated. Both run, cheapest first.
 */
export function validateTunnelConfigs(input: {
  profile: ProfileDocument;
  validators: ValidatorCache;
}): TunnelValidationIssue[] {
  const issues: TunnelValidationIssue[] = [];

  input.profile.tunnels.forEach((tunnel, index) => {
    if (!tunnel.enabled) return;
    // Outside the catalogue is a refusal, not a validation issue: `emitTunnels` names it, with the
    // sentence every refusal in this epic uses. Reporting it twice in two voices is two defects.
    if (!isTunnelProtocol(tunnel.protocol)) return;

    const schema = TUNNEL_CONFIGS[tunnel.protocol];
    const config = unwrapSecrets(tunnel.config as Record<string, unknown>);

    let result;
    try {
      result = input.validators.forSchema(`catalogue\u0000${tunnel.protocol}`, () => schema as unknown as JsonSchemaNode).validate(config);
    } catch (error) {
      // A schema that will not compile is a fault to report, not one to validate around.
      issues.push({
        tunnelIndex: index,
        pointer: `/tunnels/${index}/config`,
        message: `this protocol's schema could not be compiled: ${String(error)}`,
      });
      return;
    }

    for (const issue of result.issues) {
      issues.push({
        tunnelIndex: index,
        // The validator's pointer is relative to the config; the profile's is what the interface needs.
        pointer: `/tunnels/${index}/config${issue.pointer}`,
        message: issue.allowed ? `${issue.message} (allowed: ${issue.allowed.join(', ')})` : issue.message,
      });
    }
  });

  return issues;
}

/**
 * Removes the storage wrapper so a stored configuration can be checked against the schema that
 * describes its **resolved** form.
 *
 * A secret is declared as a plain string and stored as `{ "$secret": … }`; validating the stored
 * shape against the canonical schema would report every credential in the profile as the wrong
 * type. A resolved document arrives here unwrapped already, and passing one through this function
 * changes nothing — which is why there is one reader rather than a flag saying which stage it is.
 */
function unwrapSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    output[key] = unwrapValue(value);
  }
  return output;
}

function unwrapValue(value: unknown): unknown {
  if (isStoredSecret(value)) {
    // Handed on exactly as stored. A secret's value is `string | string[]`, and joining or splitting
    // it here would change what the owner typed.
    return value.$secret;
  }
  if (Array.isArray(value)) return value.map((entry) => unwrapValue(entry));
  if (typeof value === 'object' && value !== null) {
    return unwrapSecrets(value as Record<string, unknown>);
  }
  return value;
}
