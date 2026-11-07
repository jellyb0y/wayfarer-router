/**
 * Refreshing a group: its members become what its subscription offers now.
 *
 * Since schema 9 this is the whole rule. A group's members are the feed's nodes; a node the feed dropped
 * leaves the group, a node it added joins it, and a node it still offers is updated in place. Nothing
 * else in the document is read or written — no tunnel, no policy, no rule — because nothing else refers to
 * a member: the egress, the rules and an OpenVPN `via` name the **group**, and which member carries its
 * traffic is the watchdog's choice, made again every round.
 *
 * Until 2026-10-14 each node was a separate tunnel and the failover order a list beside them, and this
 * function had to keep the two in step: keep a withdrawn node the list still named, guess which new node
 * replaced it, add the rest disabled. Every one of those rules was a guess about what a person meant, and
 * on the bench board the list went on naming a node its provider had withdrawn. There is nothing left to
 * guess.
 *
 * Pure: the document and the parsed feed in, the next document and an account of the change out.
 * Fetching, timing, applying and recording belong to `core/subscription-refresh.ts`.
 */

import { DIRECT, nodeIdentity, nodeName, type FeedRule, type FeedSelector, type ParsedNode } from '@wayfarer/protocols';
import { isStoredSecret, type GroupLayout, type GroupMember, type ProfileDocument } from '@wayfarer/schemas';

/** The structure a feed in the core's JSON gives its nodes, by the feed's own tags. */
export interface FeedLayout {
  final: string;
  selectors: FeedSelector[];
  rules: FeedRule[];
}

export interface RefreshOutcome {
  document: ProfileDocument;
  added: string[];
  updated: string[];
  removed: string[];
  notes: string[];
  /** Whether the feed's selectors or rules changed — a change like a member's, though no member moved. */
  layoutChanged: boolean;
}

/**
 * The document with `groupId`'s members replaced by `nodes`.
 *
 * * **A member the feed still offers keeps its id and its place**, matched by `nodeIdentity` (protocol,
 *   server, port, security, transport) rather than by its label, which providers change for cosmetic reasons. The id is the
 *   member's outbound tag and its external client's unit name, and its place is its loopback port
 *   (`core/emit.ts` hands ports out in order), so neither moves unless the node itself goes.
 * * **A new node goes at the end**, as `<group>-<n>` with the first `n` no tunnel, group or member uses.
 * * A node of a protocol a member cannot be (only VLESS comes from a feed today) is left out with a note.
 */
export function refreshGroup(input: {
  document: ProfileDocument;
  groupId: string;
  nodes: readonly ParsedNode[];
  /** Present for a feed in the core's JSON. Absent, the group has no layout and the watchdog chooses. */
  layout?: FeedLayout;
}): RefreshOutcome {
  const { document, groupId, nodes } = input;
  const group = document.groups.find((entry) => entry.id === groupId);
  if (group === undefined) return { document, added: [], updated: [], removed: [], notes: [`no group "${groupId}"`], layoutChanged: false };

  const notes: string[] = [];
  const offered = new Map<string, ParsedNode>();
  for (const node of nodes) {
    if (node.protocol !== 'vless' && node.protocol !== 'hysteria2') {
      notes.push(`"${nodeName(node)}" is ${node.protocol}, which a group member cannot be; left out`);
      continue;
    }
    // A feed listing one node twice is one node.
    offered.set(nodeIdentity(node), node);
  }

  const taken = new Set<string>([
    ...document.tunnels.map((tunnel) => tunnel.id),
    ...document.groups.flatMap((entry) => [
      entry.id,
      ...entry.members.map((member) => member.id),
      ...(entry.layout?.selectors ?? []).map((selector) => selector.id),
    ]),
  ]);
  const freshId = (): string => {
    let n = 1;
    while (taken.has(`${groupId}-${String(n)}`.slice(0, 63))) n += 1;
    const id = `${groupId}-${String(n)}`.slice(0, 63);
    taken.add(id);
    return id;
  };
  const asMember = (id: string, identity: string, node: ParsedNode): GroupMember =>
    ({ id, name: nodeName(node).slice(0, 64), node: identity, protocol: node.protocol, config: node.config }) as GroupMember;

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const members: GroupMember[] = [];
  const kept = new Set<string>();

  for (const member of group.members) {
    const identity = offered.has(member.node) ? member.node : legacyMatch(member, offered, kept);
    const node = identity === undefined ? undefined : offered.get(identity);
    if (identity === undefined || node === undefined) {
      removed.push(member.id);
      continue;
    }
    kept.add(identity);
    const next = asMember(member.id, identity, node);
    if (next.name !== member.name || next.node !== member.node || !sameValue(next.config, member.config)) updated.push(member.id);
    members.push(next);
  }
  for (const [identity, node] of offered) {
    if (kept.has(identity)) continue;
    const member = asMember(freshId(), identity, node);
    added.push(member.id);
    members.push(member);
  }

  const layout = input.layout === undefined ? undefined : storedLayout(input.layout, group, members, freshId, notes);
  const layoutChanged = !sameValue(layout ?? null, group.layout ?? null);

  // A choice that is gone is no choice: dropped, and said, so the group chooses on its own again. With a
  // layout the choice is an option of the group's own selector; without one, a member.
  const { preferred, layout: _previous, ...rest } = group;
  const choosable =
    layout === undefined
      ? members.map((member) => member.id)
      : (layout.selectors.find((selector) => selector.id === groupId)?.options ?? []);
  const keepsChoice = preferred !== undefined && choosable.includes(preferred);
  if (preferred !== undefined && !keepsChoice) notes.push(`the chosen ${layout === undefined ? 'member' : 'option'} ${preferred} is no longer offered; the group chooses on its own again`);
  const next = { ...rest, members, ...(layout === undefined ? {} : { layout }), ...(keepsChoice ? { preferred } : {}) };
  return {
    document: { ...document, groups: document.groups.map((entry) => (entry.id === groupId ? next : entry)) },
    added,
    updated,
    removed,
    notes,
    layoutChanged,
  };
}

/**
 * The feed's layout in this product's ids.
 *
 * The selector `route.final` names takes **the group's id**: it is the group's tag in the core, which is
 * what the egress, a rule or a guard names. Every other selector keeps the id it had under the same feed
 * tag, or takes a fresh one, so a refresh that changes nothing changes no tag. References become member
 * ids, selector ids or `direct`; one that resolves to nothing — its node was refused — is dropped with a
 * note, as the parser already did for its own refusals.
 */
function storedLayout(
  feed: FeedLayout,
  group: ProfileDocument['groups'][number],
  members: readonly GroupMember[],
  freshId: () => string,
  notes: string[],
): GroupLayout {
  const previous = new Map((group.layout?.selectors ?? []).filter((entry) => entry.id !== group.id).map((entry) => [entry.name, entry.id]));
  const selectorIds = new Map<string, string>();
  for (const selector of feed.selectors) {
    selectorIds.set(selector.tag, selector.tag === feed.final ? group.id : (previous.get(selector.tag.slice(0, 64)) ?? freshId()));
  }
  const memberIds = new Map(members.filter((member) => member.node.startsWith('tag:')).map((member) => [member.node.slice(4), member.id]));
  const ref = (tag: string): string | undefined => (tag === DIRECT ? DIRECT : (memberIds.get(tag) ?? selectorIds.get(tag)));

  const selectors = feed.selectors.map((selector) => {
    const options = selector.options.map(ref).filter((id): id is string => id !== undefined);
    if (options.length < selector.options.length) notes.push(`"${selector.tag}" lost an option this device cannot run`);
    const fallback = selector.default === undefined ? undefined : ref(selector.default);
    return {
      id: selectorIds.get(selector.tag)!,
      name: selector.tag.slice(0, 64),
      kind: selector.kind,
      options,
      ...(fallback === undefined ? {} : { default: fallback }),
      ...(selector.url === undefined ? {} : { url: selector.url }),
      ...(selector.interval === undefined ? {} : { interval: selector.interval }),
      ...(selector.tolerance === undefined ? {} : { tolerance: selector.tolerance }),
      ...(selector.idleTimeout === undefined ? {} : { idleTimeout: selector.idleTimeout }),
      ...(selector.interruptExisting === undefined ? {} : { interruptExisting: selector.interruptExisting }),
    };
  });
  const rules = feed.rules.flatMap((rule) => {
    const to = rule.to === undefined ? undefined : ref(rule.to);
    if (rule.to !== undefined && to === undefined) {
      notes.push(`a rule to "${rule.to}" was left out: nothing this device runs is called that`);
      return [];
    }
    return [{ ...rule, ...(to === undefined ? {} : { to }) }];
  });
  return { selectors, rules };
}

/**
 * The offered node a member stored under an older identity still is: the identity its own stored
 * configuration gives under today's rules. Identities grew twice — the wrapping (2026-10-30), then the
 * path (2026-11-01) — and without this every existing member would be removed and re-added under a new
 * id on the first refresh after each change — new outbound tags, new unit names, new loopback ports —
 * for nodes that did not change. The fields read are the endpoint and the wrapping, never a secret.
 */
function legacyMatch(member: GroupMember, offered: ReadonlyMap<string, ParsedNode>, kept: ReadonlySet<string>): string | undefined {
  const identity = nodeIdentity({ scheme: member.protocol, label: member.name, protocol: member.protocol, config: member.config } as ParsedNode);
  return identity !== member.node && offered.has(identity) && !kept.has(identity) ? identity : undefined;
}

/**
 * Whether two configurations say the same thing.
 *
 * Not `JSON.stringify` of both: a stored configuration holds its secrets as `{"$secret": …}` and a parsed
 * one holds them in clear, so every member compared as changed on every refresh and the core was
 * restarted for nothing (found 2026-10-14). Key order is not meaning either.
 */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  if (isStoredSecret(value)) return canonical(value.$secret);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonical(record[key])]),
  );
}

/**
 * Whether a refresh may be applied by a timer, or must stop and wait for a person.
 *
 * A timer must not start the class of change that needs a human at a confirmation window. The window
 * exists so somebody can say "yes, I can still reach this"; there is nobody to say it at four in the
 * morning, and an unconfirmed `network` change reverts three minutes later — so an unattended refresh
 * that produced one would take the device down and put it back, repeatedly, on a timer.
 *
 * `hot` and `service` are applied. Anything higher stops and reports.
 */
export function refreshMayApply(blastRadius: 'hot' | 'service' | 'network' | 'boot'): boolean {
  return blastRadius === 'hot' || blastRadius === 'service';
}
