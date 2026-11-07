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

/**
 * Where each selector of a layout group should point, given the option a person chose for the group.
 *
 * The group's own selector (tagged with its id) goes to the chosen option. **Every other `selector` of
 * the layout goes to its option for the same country**, and this is the one place this product departs
 * from what the core would do with the feed's file — the owner's decision of 2026-11-07. In the core's
 * JSON the feed's UDP selector is independent and, with no `default`, stays on its first option whatever
 * is chosen for TCP; the feed's operator calls that a gap in the template, and in the feed's Xray form
 * choosing a country switches both. See docs/04-tunnels-and-protocols.md.
 *
 * "The same country" is read off the names the feed gives, and only this narrowly: the text before the
 * first ` · ` (`🇩🇪 Германия · Rapid Авто` and `🇩🇪 Германия · Rapid UDP` share `🇩🇪 Германия`). A
 * selector with no option, or with more than one, sharing that text is left where the core put it and
 * reported in `unmatched` — a guess here would route somebody's traffic through a country they did not pick.
 *
 * Empty when nothing is chosen: then every selector starts where the feed says, as in the core.
 */
export function layoutChoices(group: Pick<Group, 'id' | 'members' | 'layout' | 'preferred'>): {
  selections: { selector: string; option: string }[];
  unmatched: string[];
} {
  const layout = group.layout;
  const chosen = group.preferred;
  if (layout === undefined || chosen === undefined) return { selections: [], unmatched: [] };
  const top = layout.selectors.find((selector) => selector.id === group.id);
  if (top === undefined || !top.options.includes(chosen)) return { selections: [], unmatched: [] };

  const names = new Map<string, string>([
    ...group.members.map((member): [string, string] => [member.id, member.name]),
    ...layout.selectors.map((selector): [string, string] => [selector.id, selector.name]),
  ]);
  const country = (ref: string): string => (names.get(ref) ?? ref).split(' · ')[0]!.trim();
  const wanted = country(chosen);

  const selections = [{ selector: top.id, option: chosen }];
  const unmatched: string[] = [];
  for (const selector of layout.selectors) {
    if (selector.id === top.id || selector.kind !== 'selector') continue;
    const matching = selector.options.filter((option) => country(option) === wanted);
    if (matching.length === 1) selections.push({ selector: selector.id, option: matching[0]! });
    else unmatched.push(selector.id);
  }
  return { selections, unmatched };
}
