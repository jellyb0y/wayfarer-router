/**
 * What a profile routes to, read the same way by the generator, the invariants and the interface.
 *
 * Since schema 9 two kinds of thing carry traffic: a **tunnel** (a person's, one endpoint) and a
 * **group** (a subscription, whose members are what the feed offers). Both can be the egress, both can
 * carry resources, both can be named by a rule or an OpenVPN `via`. These functions are the one place
 * that says so, so a reader cannot handle tunnels and forget groups — which is how a resource group's
 * destinations would silently stop being routed.
 */

import type { Group, ProfileDocument, Tunnel } from './profile.ts';

/** Something a rule, a `via` or the egress can name. */
export type Carrier =
  | { kind: 'tunnel'; id: string; name: string; enabled: boolean; tunnel: Tunnel }
  | { kind: 'group'; id: string; name: string; enabled: boolean; group: Group };

/** Every tunnel and group, tunnels first, in document order. */
export function carriers(profile: Pick<ProfileDocument, 'tunnels' | 'groups'>): Carrier[] {
  return [
    ...(profile.tunnels ?? []).map((tunnel): Carrier => ({ kind: 'tunnel', id: tunnel.id, name: tunnel.name, enabled: tunnel.enabled, tunnel })),
    ...(profile.groups ?? []).map((group): Carrier => ({ kind: 'group', id: group.id, name: group.name, enabled: group.enabled, group })),
  ];
}

export function carrierById(profile: Pick<ProfileDocument, 'tunnels' | 'groups'>, id: string): Carrier | undefined {
  return carriers(profile).find((carrier) => carrier.id === id);
}

/** What `/policy/egress` names, when it names something that exists and is enabled. */
export function egressOf(profile: Pick<ProfileDocument, 'tunnels' | 'groups' | 'policy'>): Carrier | null {
  const id = profile.policy?.egress;
  if (id === undefined) return null;
  const carrier = carrierById(profile, id);
  return carrier !== undefined && carrier.enabled ? carrier : null;
}

/** An enabled tunnel or group that declares destinations: what the resources anchor routes. */
export interface ResourceCarrier {
  kind: 'tunnel' | 'group';
  id: string;
  name: string;
  resources: NonNullable<Tunnel['resources']>;
  onUnavailable: 'block' | 'fall-through';
  dns: Tunnel['dns'];
}

export function resourceCarriers(profile: Pick<ProfileDocument, 'tunnels' | 'groups'>): ResourceCarrier[] {
  const out: ResourceCarrier[] = [];
  for (const carrier of carriers(profile)) {
    if (!carrier.enabled) continue;
    const owner = carrier.kind === 'tunnel' ? carrier.tunnel : carrier.group;
    if (owner.resources === undefined) continue;
    out.push({ kind: carrier.kind, id: carrier.id, name: carrier.name, resources: owner.resources, onUnavailable: owner.onUnavailable, dns: owner.dns });
  }
  return out;
}

/** Every member of every enabled group, with its group, in document order — the order ports follow. */
export function enabledMembers(profile: Pick<ProfileDocument, 'groups'>): { group: Group; member: Group['members'][number] }[] {
  return (profile.groups ?? []).filter((group) => group.enabled).flatMap((group) => group.members.map((member) => ({ group, member })));
}
