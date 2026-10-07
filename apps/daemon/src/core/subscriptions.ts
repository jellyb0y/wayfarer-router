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

import { nodeIdentity, type ParsedNode } from '@wayfarer/protocols';
import type { ProfileDocument, Tunnel } from '@wayfarer/schemas';

export interface RefreshOutcome {
  document: ProfileDocument;
  added: string[];
  updated: string[];
  removed: string[];
  /** Nodes that vanished from the feed while policy still names them. Kept, never re-pointed. */
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
 * 2. **A node that policy references and the feed has dropped is kept.** The old definition stays, a
 *    note says so, and nothing is re-pointed. Sending traffic somewhere the operator did not choose is
 *    worse than a tunnel being down: a tunnel that is down is visible, and a tunnel silently pointed at
 *    a different exit is not.
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
  const keptBecauseReferenced: string[] = [];
  const notes: string[] = [];
  const next: Tunnel[] = [];

  for (const [identity, tunnel] of byIdentity) {
    if (offered.has(identity)) continue; // rebuilt from the feed below
    if (referenced.has(tunnel.id)) {
      keptBecauseReferenced.push(tunnel.id);
      next.push(tunnel);
      notes.push(
        `"${tunnel.name}" is no longer offered by subscription "${subscriptionId}", but the routing ` +
          'policy still names it, so its old definition is kept and nothing has been re-pointed. ' +
          'Traffic that chose it will fail visibly rather than going somewhere nobody chose.',
      );
    } else {
      removed.push(tunnel.id);
    }
  }

  for (const [identity, node] of offered) {
    const before = byIdentity.get(identity);
    const tunnel = toTunnel(node, before);
    // The mark survives every refresh: it is what makes the next one safe.
    next.push({ ...tunnel, derivedFrom: { subscription: subscriptionId, node: identity } });
    if (before === undefined) added.push(tunnel.id);
    else if (JSON.stringify(before.config) !== JSON.stringify(tunnel.config)) updated.push(tunnel.id);
  }

  return {
    document: { ...document, tunnels: [...foreign, ...next] },
    added,
    updated,
    removed,
    keptBecauseReferenced,
    leftAlone: foreign.map((tunnel) => tunnel.id),
    notes,
  };
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
