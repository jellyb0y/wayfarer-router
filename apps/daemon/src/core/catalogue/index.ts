/**
 * The catalogue: three entries, one list, and nothing outside it.
 *
 * This is the other half of a catalogue entry. The half the owner meets — the fields he fills — is
 * `TUNNEL_CONFIGS` in `@wayfarer/schemas`. This half is everything he is never asked: the binary,
 * its arguments, the configuration file's **name and format**, the unit shape, the order things are
 * written in, and which local port is used. None of those three — `command`, `configFile`,
 * `localPort` — exists in a profile any more.
 *
 * ## The one rule that keeps this cheap
 *
 * **`CATALOGUE` is a list, so the count is a line and never a structure.** Everything that used to
 * switch on a provider name now iterates this list. Epic F adds Shadowsocks and WireGuard by
 * appending a key to `TUNNEL_CONFIGS` and an entry here; the compiler requires the second, because
 * `CATALOGUE` is typed as a total map over that object's keys. If either addition turns out to need
 * a change to *how* the catalogue works, that is a defect in this design and is recorded as one
 * rather than absorbed.
 *
 * The file it replaces opened by warning that "if a future change adds a branch on a protocol name
 * to this file, the extensibility argument has been broken". The argument was broken from a
 * different direction: there was no code per protocol here because the code had been moved into the
 * owner's configuration, where it was neither tested nor versioned nor reviewed. This file is that
 * code, brought back where it can be read. See
 * [04-tunnels-and-protocols](../../../../../docs/04-tunnels-and-protocols.md).
 *
 * ## Refusing rather than guessing
 *
 * `plan` returns a result, not a value, because one entry genuinely cannot always decide. A VLESS
 * configuration may need a carrier this device cannot establish from what it was given, and the
 * ruling is that it refuses by name rather than picking whichever is more likely to work. A silently
 * chosen carrier is the confident answer nobody can explain afterwards.
 *
 * A refusal here is **not** an outage. Units are independent of this daemon: a profile that cannot be
 * planned means there is nothing to manage with, not that the network fell over. Every message this
 * file produces says so in the same breath.
 */

import {
  TUNNEL_CONFIGS,
  TUNNEL_PROTOCOL_TITLES,
  TUNNEL_PROTOCOLS,
  type TunnelProtocol,
} from '@wayfarer/schemas';
import type { DesiredUnit, ManagedFile } from '../desired-state.ts';
import type { LivenessMethod } from '../liveness.ts';

/* ── what an entry is given ──────────────────────────────────────────────────────────────── */

/**
 * What the installed core turned out to be able to do.
 *
 * **Availability discovery only.** The core publishes a schema describing what it was built with,
 * and the single question still asked of it is of the form "this core was built without QUIC". It
 * may be absent — no core installed, the binary not yet unpacked, the fetch not finished — and
 * absence is not a refusal and never a wait. Measured consequence of the previous arrangement: a
 * profile could not be *saved* on a device with no core, because the secret pointers were derived
 * from that schema at runtime. They are static now, so the schema has no say in whether a
 * configuration may be written down.
 */
export interface CoreCapabilities {
  /** False when nothing is known. Every entry must behave as though everything is offered. */
  known: boolean;
  /** Outbound types the installed core's own schema offers. */
  outboundTypes: ReadonlySet<string>;
}

/** Binaries this device was found to have, for saying what is missing rather than guessing. */
export type InstalledBinaries = ReadonlySet<string>;

/**
 * The tunnel an entry is planning, reduced to what an entry may see.
 *
 * Deliberately not the whole `Tunnel`: an entry has no business reading `role`, `resources` or
 * `onUnavailable`, all of which belong to routing. Passing the whole object is how an entry grows a
 * dependency on something outside itself and stops being appendable.
 */
export interface EntrySubject {
  id: string;
  name: string;
  /** Position in `profile.tunnels`. Used only to derive a name when the owner gave no suffix. */
  index: number;
}

export interface EntryPlanContext {
  tunnel: EntrySubject;
  core: CoreCapabilities;
  installed: InstalledBinaries;
  /**
   * Takes the next free local port and records who holds it.
   *
   * An entry never reads a port from the profile and never picks a number itself: a fixed port in a
   * profile is how two clients collide, and it is found when the second one fails to bind. `owner`
   * and `pointer` are what the collision message says, so a claim can be traced to the thing that
   * made it.
   */
  allocatePort(claim: { owner: string; pointer: string }): number;
}

/* ── what an entry produces ──────────────────────────────────────────────────────────────── */

/**
 * Which carrier runs this tunnel, and why.
 *
 * Stated in the plan for every entry that has a choice to make, because the owner cannot be asked —
 * he holds a link, not a preference — and an unexplained choice is the thing this is here to avoid.
 * Entries with only one possible carrier leave it undefined rather than inventing a sentence.
 */
export interface CarrierChoice {
  kind: 'native' | 'external';
  /** One sentence naming what decided it, for the plan the owner reads before applying. */
  reason: string;
}

export interface EntryPlan {
  target: 'outbounds' | 'endpoints';
  /** The object that joins the generated core configuration. */
  object: Record<string, unknown>;
  files: ManagedFile[];
  units: DesiredUnit[];
  /** Interfaces this tunnel creates, so the planner can reference them before they exist. */
  interfaces: string[];
  carrier?: CarrierChoice;
}

/**
 * Why an entry would not plan a tunnel.
 *
 * `pointer` is a JSON Pointer into the profile so the interface can put the message on the field
 * that caused it, and `protocol` is present so a refusal names the tunnel *and* the protocol — the
 * shape E5 requires of every refusal in this epic.
 */
export interface EntryRefusal {
  protocol: TunnelProtocol;
  tunnelId: string;
  /** JSON Pointer at the field that could not be placed. */
  pointer: string;
  /** What is wrong, in words an owner can act on. */
  reason: string;
}

export type EntryPlanResult = { ok: true; plan: EntryPlan } | { ok: false; refusal: EntryRefusal };

export interface EntryAvailability {
  available: boolean;
  /** Why not, in words an operator can act on. Absent when available. */
  reason?: string;
  /** What to install, when that is the answer. */
  requires?: { binary: string; neededFor: string }[];
}

/* ── the entry ───────────────────────────────────────────────────────────────────────────── */

export interface CatalogueEntry<P extends TunnelProtocol = TunnelProtocol> {
  /** What a profile stores, and what a refusal names. */
  id: P;
  /** What the owner holds, in his words. Never what this device starts. */
  title: string;
  /**
   * Whether this device can run this entry at all, from what was **discovered** — binaries present
   * and, where it applies, what the core was built with. Never a version table.
   *
   * Must return `available: true` when `core.known` is false and the binaries are present: an
   * unavailable core schema is missing knowledge, not a negative answer, and treating it as one is
   * how a fetch blocks configuration.
   */
  availability(context: { core: CoreCapabilities; installed: InstalledBinaries }): EntryAvailability;
  /** Pure. No I/O, no side effects — which is what makes a dry run free. */
  plan(config: unknown, context: EntryPlanContext): EntryPlanResult;
  /**
   * How this protocol can be asked whether a tunnel is alive. Pure, like `plan`.
   *
   * The entry answers because only the entry knows what its protocol offers: a session with a
   * keepalive, or nothing at all while idle. It is given the tunnel's id and the interfaces the last
   * plan recorded for it, and **nothing the tunnel carries** — the same restriction `EntrySubject`
   * states for planning, for the reason `core/liveness.ts` opens with: a guard that judged `partner` by
   * one of its own resources blocked every destination behind it because one server closed a port.
   */
  liveness(subject: LivenessSubjectInput): LivenessMethod;
  /**
   * Why traffic assigned to this tunnel cannot leave another way when the tunnel is down, in one
   * sentence the panel shows beside a dead reading.
   *
   * It exists because the guard no longer blocks a tunnel on `onUnavailable: block`, and the panel
   * must say plainly why that is safe for *this* tunnel. Each sentence is a claim about the outbound
   * `plan` produces, and the test beside the catalogue holds each one to that object.
   */
  failsClosed(subject: LivenessSubjectInput): string;
}

/** What `liveness` and `failsClosed` are given: the tunnel's id and the interfaces its last plan recorded. */
export interface LivenessSubjectInput {
  tunnelId: string;
  /** From `tunnelUnits[].interfaces`; undefined when no plan has recorded this tunnel yet. */
  interfaces: readonly string[] | undefined;
}

/* ── the list ────────────────────────────────────────────────────────────────────────────── */

import { openVpnEntry } from './openvpn.ts';
import { cloakOpenVpnEntry } from './cloak-openvpn.ts';
import { vlessEntry } from './vless.ts';
import { proxyEntry } from './proxy.ts';

/**
 * Every entry there is.
 *
 * Typed as a total map over the protocols so that adding a configuration without an entry, or an
 * entry without a configuration, fails to compile rather than failing on a device.
 */
export const CATALOGUE: { readonly [P in TunnelProtocol]: CatalogueEntry<P> } = {
  openvpn: openVpnEntry,
  'cloak-openvpn': cloakOpenVpnEntry,
  vless: vlessEntry,
  proxy: proxyEntry,
};

/** The catalogue in the order it is offered. Iterate this; never switch on a protocol name. */
export const CATALOGUE_LIST: readonly CatalogueEntry[] = TUNNEL_PROTOCOLS.map(
  (protocol) => CATALOGUE[protocol] as CatalogueEntry,
);

export function catalogueEntry(protocol: TunnelProtocol): CatalogueEntry {
  return CATALOGUE[protocol] as CatalogueEntry;
}

/**
 * The refusal text for a protocol that is not in the catalogue, naming the tunnel and the protocol.
 *
 * Kept here rather than at each caller so that import, storage and the planner refuse with the same
 * sentence. Two refusals that mean the same thing and read differently are two defects to report.
 */
export function outsideCatalogue(input: { tunnelId: string; protocol: unknown }): string {
  const named = typeof input.protocol === 'string' && input.protocol !== '' ? `"${input.protocol}"` : 'nothing';
  return (
    `Tunnel "${input.tunnelId}" names ${named}, which this product does not run. ` +
    `It runs ${TUNNEL_PROTOCOLS.map((p) => TUNNEL_PROTOCOL_TITLES[p]).join(', ')}. ` +
    'Nothing has stopped: tunnels already running are independent of this daemon, so this is a ' +
    'configuration that cannot be managed rather than a network that has failed.'
  );
}

export { TUNNEL_CONFIGS, TUNNEL_PROTOCOL_TITLES, TUNNEL_PROTOCOLS, type TunnelProtocol };
