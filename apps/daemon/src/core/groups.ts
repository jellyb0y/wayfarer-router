/**
 * A group's members, planned as tunnels.
 *
 * A member is a catalogue configuration the feed offers — today always VLESS — and everything that
 * turns a tunnel into a running outbound (the catalogue entry, the external carrier, its unit, its
 * loopback port) applies to it unchanged. So the planner is handed the document with each enabled
 * group's members **appended to `tunnels`**, after the person's own, in group order and member order.
 * The stored document never holds them there; this view exists for one plan and is discarded. Expanded
 * by each consumer of the tunnel list (the emitter, the config validator, the planner) from the stored
 * document it is given — and the invariants are given the stored document, so they see groups as groups.
 *
 * The order is load-bearing: loopback ports are handed out in tunnel order (`core/emit.ts`), so a
 * person's tunnels keep theirs whatever a feed does, and a member added by a refresh goes to the end.
 */

import { enabledMembers, type ProfileDocument, type Tunnel } from '@wayfarer/schemas';

export function withMembersAsTunnels(profile: ProfileDocument): ProfileDocument {
  const members = enabledMembers(profile).map(
    ({ member }): Tunnel =>
      ({
        id: member.id,
        name: member.name,
        enabled: true,
        onUnavailable: 'block',
        protocol: member.protocol,
        config: member.config,
      }) as Tunnel,
  );
  // Not deduplicated against the person's tunnels: an id used by both is a collision the invariants
  // report on the stored document (`checkCrossReferences`), and hiding one of the two would hide it.
  if (members.length === 0) return profile;
  return { ...profile, tunnels: [...profile.tunnels, ...members] };
}

/** The ids of every member of an enabled group, for the places that treat a member differently. */
export function memberIds(profile: Pick<ProfileDocument, 'groups'>): Set<string> {
  return new Set(enabledMembers(profile).map(({ member }) => member.id));
}

/** Which group each member belongs to. */
export function groupOfMember(profile: Pick<ProfileDocument, 'groups'>): Map<string, string> {
  return new Map(enabledMembers(profile).map(({ group, member }) => [member.id, group.id]));
}

/** The pointer of a member in the stored document, for a finding about it. */
export function memberPointer(profile: Pick<ProfileDocument, 'groups'>, memberId: string): string | null {
  for (const [g, group] of (profile.groups ?? []).entries()) {
    const m = group.members.findIndex((member) => member.id === memberId);
    if (m >= 0) return `/groups/${String(g)}/members/${String(m)}`;
  }
  return null;
}
