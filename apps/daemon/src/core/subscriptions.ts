/**
 * Refreshing a subscription: the one path where the device edits its own configuration unasked.
 *
 * That sentence is the whole design constraint. Everywhere else in this project a change is something
 * a person asked for and can see coming; here a timer fetches somebody else's document and rewrites
 * part of the profile from it. So the rules are tighter than anywhere else, and all of them are about
 * limiting what an unattended edit is allowed to do.
 *
 * The function below is **pure**. It takes the current document and a parsed feed and returns the next
 * document plus an account of what it did and refused to do. Fetching, timing, applying and recording
 * belong to callers, which keeps the decisions testable without a network.
 */

import { nodeIdentity, nodeName, type ParsedNode } from '@wayfarer/protocols';
import { isStoredSecret, type ProfileDocument, type Tunnel } from '@wayfarer/schemas';

export interface RefreshOutcome {
  document: ProfileDocument;
  added: string[];
  updated: string[];
  removed: string[];
  /**
   * Tunnels whose node vanished from the feed while something still names them, moved to a node the feed
   * still offers and no other tunnel uses. The id stays, so the policy and the rules follow it.
   */
  repointed: { id: string; from: string; to: string }[];
  /** Tunnels whose node vanished while something names them, and for which the feed had no free node. Kept. */
  keptBecauseReferenced: string[];
  /** Hand-authored tunnels this refresh did not touch, named so the report says what it left alone. */
  leftAlone: string[];
  notes: string[];
}

/**
 * The next document after a refresh.
 *
 * Four rules, each of which exists because the alternative is worse in a specific way:
 *
 * 1. **Only this subscription's derived tunnels are touched.** A tunnel with no `derivedFrom`, or one
 *    derived from a different subscription, is left exactly as it is. A refresh that could delete a
 *    hand-authored tunnel is a refresh that will eventually delete somebody's work while they sleep.
 * 2. **A tunnel the policy or a rule names, whose node the feed has dropped, moves to a free node.** Free
 *    means offered by the same feed and used by no tunnel of it; one whose name shares the country of the
 *    old one is preferred, otherwise the first. The tunnel keeps its id — so the policy and the rules
 *    keep pointing at it — and takes the new node's configuration and name, so what it is called says
 *    where it leads. With no free node it is kept as it was, and a note says so.
 *
 *    **Changed 2026-10-14, on the owner's decision.** This rule used to be "kept, and nothing is
 *    re-pointed", on the argument that a tunnel silently pointed at a different exit is worse than one
 *    that is down. The bench board showed the cost of that argument: the provider withdrew the node
 *    behind `france` and offered another in its place, and the device went on failing over to an address
 *    that no longer existed, with nobody told. The owner chose that the feed decides which of its nodes a
 *    tunnel uses; every re-point is recorded as an event, which is what keeps it from being silent.
 * 3. **Policy is never edited.** Not reordered, not extended, not pruned. The operator's preference
 *    order is theirs; a feed may supply exits, not decide which one is preferred.
 * 4. **Identity is the feed's node identity, not the display name.** Names change between refreshes for
 *    cosmetic reasons, and matching on them turns a renamed node into a delete plus an add — which
 *    breaks policy that named the old id.
 */
export function refreshSubscription(input: {
  document: ProfileDocument;
  subscriptionId: string;
  /** The nodes the feed currently offers, already parsed. */
  nodes: readonly ParsedNode[];
  /** Turns one node into a tunnel. Supplied by the caller: naming and the catalogue entry are not this
   * function's business, and passing it keeps the refresh rules testable apart from what a link means. */
  toTunnel: (node: ParsedNode, existing: Tunnel | undefined) => Tunnel;
}): RefreshOutcome {
  const { document, subscriptionId, nodes, toTunnel } = input;

  const mine = (tunnel: Tunnel): boolean => tunnel.derivedFrom?.subscription === subscriptionId;
  const existing = document.tunnels.filter(mine);
  const foreign = document.tunnels.filter((tunnel) => !mine(tunnel));

  // Identity, not label: `nodeIdentity` is server, port and protocol, so a provider renaming a node is
  // an update rather than a delete plus an add — and a delete plus an add breaks policy naming the old id.
  const byIdentity = new Map(existing.map((tunnel) => [tunnel.derivedFrom!.node, tunnel]));
  const offered = new Map(nodes.map((node) => [nodeIdentity(node), node]));

  /**
   * Every tunnel id anything in this document depends on.
   *
   * **Policy and the routing rules**, not policy alone. A rule naming a tunnel is as much a reference as
   * a place in the failover order — and the consequence of missing them was the worst combination
   * available: the tunnel was deleted, the cross-reference invariant then raised an error, the plan
   * became unusable, and the subscription was stuck with the tunnel already gone. An irreversible
   * deletion followed by a refusal to proceed.
   *
   * Collected by walking the rules for an `outbound`, which is the one field in any rule kind that names
   * a tunnel — rather than by listing the kinds that have one, which is a list that stops matching the
   * schema the moment a kind is added.
   */
  const referenced = new Set<string>([
    ...document.policy.priority,
    ...document.policy.excluded,
    ...routingReferences(document),
  ]);

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const repointed: { id: string; from: string; to: string }[] = [];
  const keptBecauseReferenced: string[] = [];
  const notes: string[] = [];

  const rebuilt = (identity: string, node: ParsedNode, before: Tunnel | undefined): Tunnel => {
    const tunnel = toTunnel(node, before);
    if (before === undefined) added.push(tunnel.id);
    else if (!sameValue(before.config, tunnel.config)) updated.push(tunnel.id);
    // The mark survives every refresh: it is what makes the next one safe.
    return { ...tunnel, derivedFrom: { subscription: subscriptionId, node: identity } };
  };

  /*
   * Which free node each withdrawn, referenced tunnel moves to — decided before anything is built, in
   * document order, so the earlier tunnel in the list gets the first choice and no node is given twice.
   */
  const free = [...offered.keys()].filter((identity) => !byIdentity.has(identity));
  const replacement = new Map<string, string>();
  for (const tunnel of existing) {
    if (offered.has(tunnel.derivedFrom!.node) || !referenced.has(tunnel.id) || free.length === 0) continue;
    const country = countryKeys(tunnel.name);
    const sameCountry = free.findIndex((identity) => intersects(country, countryKeys(nodeName(offered.get(identity)!))));
    const [chosen] = free.splice(sameCountry >= 0 ? sameCountry : 0, 1);
    replacement.set(tunnel.id, chosen!);
  }

  /*
   * **Every tunnel keeps its place in the list; a new one goes at the end.** Order is not cosmetic: the
   * emitter hands out loopback ports in document order (`core/emit.ts`), so moving a tunnel moves the
   * port of every enabled tunnel after it. Measured on the bench board, 2026-10-14 00:16: this function
   * used to return `[...foreign, ...derived]`, the first unattended refresh of `cryptocat` moved
   * `germany` and `france` behind `collect-vpn` and `intra`, and the plan it produced replaced the
   * configuration of both — `network`, held for a person — for a feed that had changed nothing they use.
   */
  const tunnels: Tunnel[] = [];
  for (const tunnel of document.tunnels) {
    if (!mine(tunnel)) {
      tunnels.push(tunnel);
      continue;
    }
    const identity = tunnel.derivedFrom!.node;
    const node = offered.get(identity);
    const moveTo = replacement.get(tunnel.id);
    if (node !== undefined) {
      tunnels.push(rebuilt(identity, node, byIdentity.get(identity)));
    } else if (moveTo !== undefined) {
      const target = offered.get(moveTo)!;
      const moved = toTunnel(target, tunnel);
      repointed.push({ id: tunnel.id, from: identity, to: moveTo });
      notes.push(
        `"${tunnel.name}" is no longer offered by subscription "${subscriptionId}"; it now uses ` +
          `"${nodeName(target)}" (${moveTo}), which the feed offers and no other tunnel used.`,
      );
      tunnels.push({ ...moved, name: nodeName(target).slice(0, 64), derivedFrom: { subscription: subscriptionId, node: moveTo } });
    } else if (referenced.has(tunnel.id)) {
      keptBecauseReferenced.push(tunnel.id);
      tunnels.push(tunnel);
      notes.push(
        `"${tunnel.name}" is no longer offered by subscription "${subscriptionId}", and the feed has no ` +
          'node that another tunnel does not already use, so its old definition is kept.',
      );
    } else {
      removed.push(tunnel.id);
    }
  }
  for (const identity of free) tunnels.push(rebuilt(identity, offered.get(identity)!, undefined));

  return {
    document: { ...document, tunnels },
    added,
    updated,
    removed,
    repointed,
    keptBecauseReferenced,
    leftAlone: foreign.map((tunnel) => tunnel.id),
    notes,
  };
}

/**
 * What a display name says about the country it leads to: a flag's two letters, and the first word.
 *
 * A heuristic, and only a preference — it decides which free node a withdrawn tunnel moves to first,
 * never whether it moves. "France · Paris" gives `{france}`; "🇩🇪 Germany · Frankfurt 2" gives
 * `{de, germany}`. Labels are the provider's free text, so nothing stronger is available.
 */
function countryKeys(name: string): Set<string> {
  const keys = new Set<string>();
  const flag = [...name].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x1f1e6 && code <= 0x1f1ff;
  });
  if (flag.length >= 2) keys.add(flag.slice(0, 2).map((char) => String.fromCharCode((char.codePointAt(0)! - 0x1f1e6) + 97)).join(''));
  const word = /\p{L}{2,}/u.exec(name.normalize('NFKC'));
  if (word !== null) keys.add(word[0].toLowerCase());
  return keys;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const key of a) if (b.has(key)) return true;
  return false;
}

/**
 * Whether two configurations say the same thing.
 *
 * Not `JSON.stringify` of both, which is what this was: a stored configuration holds its secrets as
 * `{"$secret": "…"}` and a parsed one holds them in clear, so every derived tunnel compared as changed
 * on every refresh and was reported as updated when nothing in the feed had moved. Key order is not
 * meaning either — the parser and the store need not agree on it.
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
 * Tunnel ids named by the routing rules.
 *
 * Every rule kind that points somewhere does so through an `action.outbound`, so this reads that field
 * wherever it appears instead of enumerating the kinds that have one. A list of kinds is a second
 * description of the schema and would silently stop covering a kind added later — which is precisely how
 * the routing rules came to be missed here in the first place.
 */
function routingReferences(document: ProfileDocument): string[] {
  const found: string[] = [];
  for (const rule of document.routing?.rules ?? []) {
    const action = (rule as { action?: { outbound?: unknown } }).action;
    if (action !== undefined && typeof action.outbound === 'string') found.push(action.outbound);
  }
  return found;
}

/**
 * Whether a refresh may be applied by a timer, or must stop and wait for a person.
 *
 * A timer must not start the class of change that needs a human at a confirmation window. The window
 * exists so somebody can say "yes, I can still reach this"; there is nobody to say it at four in the
 * morning, and an unconfirmed `network` change reverts three minutes later — so an unattended refresh
 * that produced one would take the device down and put it back, repeatedly, on a timer.
 *
 * `hot` and `service` are applied. Anything higher stops and reports, with the plan kept so a person
 * can look at it and apply it themselves.
 */
export function refreshMayApply(blastRadius: 'hot' | 'service' | 'network' | 'boot'): boolean {
  return blastRadius === 'hot' || blastRadius === 'service';
}
