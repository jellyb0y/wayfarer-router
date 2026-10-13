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

import { nodeIdentity, nodeName, type ParsedNode } from '@wayfarer/protocols';
import { isStoredSecret, type GroupMember, type ProfileDocument } from '@wayfarer/schemas';

export interface RefreshOutcome {
  document: ProfileDocument;
  added: string[];
  updated: string[];
  removed: string[];
  notes: string[];
}

/**
 * The document with `groupId`'s members replaced by `nodes`.
 *
 * * **A member the feed still offers keeps its id and its place**, matched by `nodeIdentity` (protocol,
 *   server, port) rather than by its label, which providers change for cosmetic reasons. The id is the
 *   member's outbound tag and its external client's unit name, and its place is its loopback port
 *   (`core/emit.ts` hands ports out in order), so neither moves unless the node itself goes.
 * * **A new node goes at the end**, as `<group>-<n>` with the first `n` no tunnel, group or member uses.
 * * A node of a protocol a member cannot be (only VLESS comes from a feed today) is left out with a note.
 */
export function refreshGroup(input: { document: ProfileDocument; groupId: string; nodes: readonly ParsedNode[] }): RefreshOutcome {
  const { document, groupId, nodes } = input;
  const group = document.groups.find((entry) => entry.id === groupId);
  if (group === undefined) return { document, added: [], updated: [], removed: [], notes: [`no group "${groupId}"`] };

  const notes: string[] = [];
  const offered = new Map<string, ParsedNode>();
  for (const node of nodes) {
    if (node.protocol !== 'vless') {
      notes.push(`"${nodeName(node)}" is ${node.protocol}, which a group member cannot be; left out`);
      continue;
    }
    // A feed listing one node twice is one node.
    offered.set(nodeIdentity(node), node);
  }

  const taken = new Set<string>([
    ...document.tunnels.map((tunnel) => tunnel.id),
    ...document.groups.flatMap((entry) => [entry.id, ...entry.members.map((member) => member.id)]),
  ]);
  const freshId = (): string => {
    let n = 1;
    while (taken.has(`${groupId}-${String(n)}`.slice(0, 63))) n += 1;
    const id = `${groupId}-${String(n)}`.slice(0, 63);
    taken.add(id);
    return id;
  };
  const asMember = (id: string, identity: string, node: ParsedNode): GroupMember => ({
    id,
    name: nodeName(node).slice(0, 64),
    node: identity,
    protocol: 'vless',
    config: node.config as GroupMember['config'],
  });

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const members: GroupMember[] = [];
  const kept = new Set<string>();

  for (const member of group.members) {
    const node = offered.get(member.node);
    if (node === undefined) {
      removed.push(member.id);
      continue;
    }
    kept.add(member.node);
    const next = asMember(member.id, member.node, node);
    if (next.name !== member.name || !sameValue(next.config, member.config)) updated.push(member.id);
    members.push(next);
  }
  for (const [identity, node] of offered) {
    if (kept.has(identity)) continue;
    const member = asMember(freshId(), identity, node);
    added.push(member.id);
    members.push(member);
  }

  return {
    document: { ...document, groups: document.groups.map((entry) => (entry.id === groupId ? { ...entry, members } : entry)) },
    added,
    updated,
    removed,
    notes,
  };
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
