/**
 * The differ: desired state against reality, and what the difference can break.
 *
 * Pure, like the planner. It is handed what reality currently looks like rather than reading it, so
 * every classification below is reachable from a fixture.
 *
 * ## The classes are defined by what they disturb, not by what they call
 *
 * The mechanism is the wrong axis, and defining them by it produces a false answer immediately: the
 * proxy core cannot reload its configuration, so "reload the core" is not a thing that exists, and a
 * routing-rule edit therefore restarts a process. What matters to the operator is not which call is
 * made but what stops working while it happens.
 *
 * | Class | What it disturbs | Can it cost the operator access? |
 * |---|---|---|
 * | `hot` | Nothing restarts. A running component is told something through its own API. | No |
 * | `service` | Processes we own restart. Link layer, addressing and radios untouched; clients keep their association and their lease; the management session survives. | No |
 * | `network` | Links, addresses, radios, reachability. | **Yes** |
 * | `boot` | Effective only after a reboot. | Deferred |
 *
 * A plan takes the highest class it contains.
 *
 * One rule that is not obvious from the table and is the reason a rename is not routine: **renaming
 * the interface that currently carries the management session is `network`, never `service`.** A
 * rename needs the link down, and a link going down is indistinguishable from losing the board.
 */

import { readFenceRecordEntries } from './followed-networks.ts';
import { CONFIG_ROOT, PATHS, isOwnedUnit, type DesiredState, type ManagedFile } from './desired-state.ts';

export type BlastRadius = 'hot' | 'service' | 'network' | 'boot';

const ORDER: Record<BlastRadius, number> = { hot: 0, service: 1, network: 2, boot: 3 };

/**
 * Whether any single change in a plan belongs to a class.
 *
 * Needed because **"the plan takes the highest class" is not the same as "the plan contains that
 * class"**, and confusing the two produces a specific and serious bug. `boot` orders above `network`,
 * so a plan that renames an interface *and* changes addressing is classified `boot` — and `boot` needs
 * no confirmation window, because nothing happens until the device restarts. Deciding on the single
 * highest class would therefore give a plan containing a live network change no window at all, which
 * is precisely the plan most in need of one.
 *
 * So the window is decided by this, not by `blastRadius`. The highest class is still the right thing to
 * *show* an operator; it is the wrong thing to make a safety decision from.
 */
export function containsClass(plan: Plan2, blastRadius: BlastRadius): boolean {
  return (
    plan.fileChanges.some((change) => change.blastRadius === blastRadius) ||
    plan.unitChanges.some((change) => change.blastRadius === blastRadius) ||
    (blastRadius === 'network' && plan.sysctlChanges.length > 0) ||
    plan.interfaceRenames.some((rename) => (rename.carriesManagement ? 'network' : 'boot') === blastRadius)
  );
}

export function highest(classes: BlastRadius[]): BlastRadius {
  return classes.reduce<BlastRadius>((worst, candidate) => (ORDER[candidate] > ORDER[worst] ? candidate : worst), 'hot');
}

export interface FileState {
  path: string;
  /** Null when the file does not exist. */
  content: string | null;
  mode: number | null;
}

export interface UnitState {
  name: string;
  active: boolean;
  enabled: boolean;
  /** False when systemd does not know this unit at all. */
  known: boolean;
}

export interface Reality {
  files: FileState[];
  units: UnitState[];
  /**
   * Interfaces the kernel currently reports, **with their addresses**.
   *
   * The address is not decoration: a `.link` file matches on it, so working out which interface a
   * rename affects means comparing addresses. An earlier version of this file carried only names and
   * guessed the source of a rename from the management-interface list — which produced "rename end0
   * to wfap0, this interface currently carries your session" for a plan that renames a radio and does
   * not touch the Ethernet port at all. A plan review that misidentifies what is about to be renamed
   * is worse than one that says nothing, because the operator acts on it.
   */
  interfaces: { name: string; mac: string | null }[];
  /** Interfaces carrying a management session right now. */
  managementInterfaces: string[];
  sysctl: Record<string, string>;
  /**
   * **Every** unit on this device whose name this project owns, whether the plan mentions it or not.
   *
   * `units` above holds the ones the plan asked about, which means the differ structurally cannot see a
   * unit that *should not exist any more*. Measured on the bench board, 2026-09-21: a tunnel with a
   * transport was configured and applied, then removed from the profile — and the plan came back
   * **empty** while `wf-transport@obfs` and `wf-socks@viaobfs` were still running, still enabled, and
   * still holding their loopback ports. The device reported itself converged while doing more than the
   * profile asked.
   *
   * Optional so that a caller which cannot enumerate units degrades to the old behaviour rather than
   * concluding that everything owned should be stopped — an empty list and "I could not look" must not
   * mean the same thing.
   */
  ownedUnits?: string[];
}

export interface FileChange {
  path: string;
  action: 'create' | 'update' | 'chmod';
  purpose: string;
  blastRadius: BlastRadius;
}

export interface UnitChange {
  name: string;
  action: 'install' | 'enable' | 'disable' | 'start' | 'restart' | 'stop';
  purpose: string;
  blastRadius: BlastRadius;
  /**
   * What the operator loses while this step runs, in their terms, or absent when the answer is "nothing".
   *
   * It lives here, beside the classification, because it is the *same fact*: a unit is `network` precisely
   * because of what stopping it costs, and putting the sentence anywhere else would be a second description
   * of the reason. A plan review that says `restart wf-hostapd@wlan0 — Wayfarer access point` tells somebody
   * what will happen and not what it will cost them.
   */
  consequence?: string;
  /**
   * The file paths whose change is **why this restart is in the plan**.
   *
   * Paths and not a flag, and not prose: a refusal is per path, so a path is the only key that joins
   * a restart to the writes it depends on. A boolean would say a restart has causes and leave a
   * caller unable to check whether *its* causes survived.
   *
   * ## Why it exists
   *
   * Six times in a row the core was restarted with a configuration file whose rewrite had been
   * refused, and the caller recorded success every time. The plan was right, the refusal was right,
   * and nothing carried the one fact that joins them: the restart had no way to say what it was for,
   * so no caller could see that the reason had not happened.
   *
   * ## The boundary — what counts as a cause, and what does not
   *
   * **A unit's own definition file counts as its own cause.** A unit whose definition changed is
   * restarted because of that file, and if writing it was refused there is nothing to restart for.
   * The consumer walk does not reach it: a unit file is consumed by *systemd*, not by one of our
   * units, so nothing in the desired state declares it — the same blind spot as the defect fixed
   * here where a unit whose definition changed was reloaded and never restarted.
   *
   * **A restart planned because the unit is not active has no file cause, and must not be given
   * one.** Nothing was written for it; it is in the plan because the unit is down. Such a step
   * carries no `becauseOf` at all and is therefore permanently unskippable, which is the safe
   * direction: a unit that is down stays a unit somebody has to bring up.
   *
   * **Absent means "not recorded", never "no causes".** A restart without this field is never
   * skippable. Every step this differ plans for a file reason carries it, but a step assembled
   * anywhere else, now or later, must not be read as having been examined and found causeless.
   *
   * **An empty array is impossible by construction** — the restart is only planned when at least one
   * cause was found — and a consumer that meets one anyway treats it as absent rather than as "no
   * causes", because the two readings differ by exactly the mistake above.
   *
   * ## What a consumer may do with it
   *
   * **Skip only when it is present, non-empty, and *every* path in it was refused.** "All", not
   * "any": a restart may have been needed for a second file in the same apply, and skipping on one
   * refused cause would leave that second file written and not in force — which is the original
   * defect with the sides swapped.
   *
   * **The name promises more than the mechanism covers, and that gap is stated rather than left to
   * be inferred.** This lists the file causes the differ knows about. It is not a complete account
   * of why a unit is being restarted, and the case above is the standing proof of that: a step with
   * no file cause is a step this field says nothing about.
   */
  becauseOf?: string[];
}

export interface Plan2 {
  fileChanges: FileChange[];
  unitChanges: UnitChange[];
  sysctlChanges: { key: string; from: string | null; to: string; reason: string }[];
  interfaceRenames: { from: string; to: string; carriesManagement: boolean }[];
  blastRadius: BlastRadius;
  /** One line per change, in the order they will be applied. What the plan review shows. */
  humanDiff: string[];
  /** True when nothing needs doing. Re-applying a profile that matches reality is a no-op. */
  empty: boolean;
  /**
   * Units this plan would have to act on but did not generate. Always empty in a correct plan; it is
   * carried so the reconciler can refuse rather than trust.
   */
  foreignUnits: string[];
  /**
   * Interfaces this plan changes that are **currently carrying a management session**.
   *
   * The warning that a plan review has to lead with, and the one this project learned the hard way: a
   * change that reconfigures the interface the request arrived on is a change that can take away the
   * operator's only way of answering the confirmation prompt it is about to show them.
   *
   * It is computed here rather than left to a caller because the differ is the only place that knows
   * both halves — what the plan touches and which interfaces the session is on — and because a warning
   * that depends on a client remembering to ask for it is a warning that will be missing from the one
   * client that needed it. It goes in the API response too, so a script can see it.
   */
  affectsManagementInterfaces: string[];
}

/**
 * Which class a path belongs to.
 *
 * Derived from the path rather than declared per file, because the destination is what decides what
 * has to happen afterwards: a ruleset is loaded, a hostapd configuration means restarting a radio.
 */
/**
 * Paths that reached the fall-back, for a caller that wants to report them.
 *
 * Module-level and additive: the differ is pure and must not log, but an unclassified path is
 * something a maintainer has to be told about, so it is recorded here and read by the plan review.
 */
const unclassifiedPaths = new Set<string>();

/** Every path that has fallen back to the cautious default since the process started. */
export function unclassifiedArtefactPaths(): string[] {
  return [...unclassifiedPaths];
}

export function classifyPath(path: string): BlastRadius {
  const explicit = classifyPathExplicitly(path);
  if (explicit !== null) return explicit;
  /*
   * An unrecognised path gets the **cautious** class, not the convenient one.
   *
   * The costs are asymmetric and that asymmetry is the whole argument: a needless three-minute
   * confirmation window wastes somebody's time, and a missing one can cost them the device. An
   * unknown artefact is by definition one whose blast radius nobody has reasoned about, which is
   * exactly the moment to have the safety net on.
   *
   * This used to default to `service` — the class that gets no window at all — and that is how a
   * change which took the uplink down committed instantly with nothing watching. Making the
   * fall-back *visible* was not enough; it had to be made *safe*.
   */
  unclassifiedPaths.add(path);
  return 'network';
}

/**
 * The class of a path, or `null` when nothing here recognises it.
 *
 * Separated from `classifyPath` so the fall-back is visible rather than indistinguishable from a
 * deliberate `service`. Measured on the bench board, 2026-09-20, and it cost a scenario: the wireless
 * uplink's configuration lives in a directory added after this function was written, so a change that
 * pointed the uplink at a non-existent network fell through to `service` — **and a `service` change
 * gets no confirmation window and no revert timer.** The apply committed immediately, the uplink went
 * down, and nothing was watching. On a device whose uplink carries management that is the lockout
 * with the safety net switched off.
 */
export function classifyPathExplicitly(path: string): BlastRadius | null {
  // A unit file takes the class of the unit it defines. Writing the file starts nothing, but keeping
  // it with its unit means a narrowed apply does not leave a definition on disk for a unit it was not
  // allowed to install, enable or start — which would be a half-applied change of exactly the kind
  // the whole-plan refusal exists to prevent.
  //
  // The directory comes from `PATHS` rather than being spelled out: this test used to name
  // `/etc/systemd/system/` and kept doing so after generated units moved to `/usr/local/lib`, so every
  // generated unit file silently stopped taking its unit's class.
  if (path.startsWith(`${PATHS.unitDir}/`)) {
    return unitClassFor(path.slice(PATHS.unitDir.length + 1));
  }
  if (path.startsWith(`${PATHS.networkdDir}/`)) {
    // A `.link` file renames an interface, which needs the link down; a `.network` file changes
    // addressing. Both are the link layer.
    return path.endsWith('.link') ? 'boot' : 'network';
  }
  if (path.startsWith(`${PATHS.hostapdDir}/`)) return 'network';
  // The wireless client owns the radio just as the access point does, and taking it down takes the
  // uplink with it.
  if (path.startsWith(`${PATHS.supplicantDir}/`)) return 'network';
  if (path === PATHS.firewall) return 'network';
  // Kernel settings: forwarding and IPv6 behaviour on the interface we serve.
  if (path === PATHS.sysctlDropIn) return 'network';
  if (path.startsWith(`${PATHS.dhcpDir}/`)) return 'service';
  if (path === PATHS.coreConfig) return 'service';
  // Read by nothing that runs; written with the core configuration and classed with it in `diff`.
  if (path === PATHS.coreFence) return 'service';
  if (
    path.startsWith(`${PATHS.openvpnDir}/`) ||
    path.startsWith(`${PATHS.transportDir}/`) ||
    path.startsWith(`${PATHS.socksDir}/`)
  ) {
    return 'service';
  }
  if (path === `${CONFIG_ROOT}/README`) return 'service';
  return null;
}


/* ── blast radius is a property of the change, not of the file ───────────────────────────── */

/**
 * Which parts of a generated document determine whether the device can still be **reached**.
 *
 * One mechanism, two tables. The coarse table above answers "what kind of artefact is this"; this one
 * answers "which fields in it matter for reachability", and it is consulted when an artefact carries
 * both kinds of content.
 *
 * The core configuration is the case that forced this. It holds, in one file:
 *
 * * the tunnel inbound — its address, `auto_route`, `strict_route` and the **exclusion list** — which
 *   decides which traffic the tunnel captures and therefore whether a host on our own network can
 *   still get a reply from us; and
 * * the outbounds and the rules that select between them, which decide where traffic *goes* once it
 *   has been captured, and cannot make the device unreachable.
 *
 * Classifying the whole file as `network` would put a three-minute window on every routing edit;
 * classifying it as `service` — which is what it did — means a wrong exclusion list lands with no
 * window and no revert timer, and that is the exact mechanism that made this board unreachable twice.
 * So the class comes from the fields that actually differ.
 *
 * Pointers are JSON-pointer prefixes. `/inbounds` covers the tun device and the exclusion list, which
 * between them are also what every uplink-network change touches: the direct routing rules are
 * generated from the same input, so an exclusion change never appears without an inbound change.
 * `ip_cidr` is matched anywhere in the rules because a rule naming a network is a rule about
 * reachability whatever its position.
 */
const REACHABILITY_POINTERS: Record<string, { prefixes: string[]; leaves: string[]; unorderedLists: string[] }> = {
  [PATHS.coreConfig]: {
    prefixes: ['/inbounds', '/route/auto_detect_interface', '/route/default_mark'],
    leaves: ['ip_cidr'],
    unorderedLists: ['/route/rules'],
  },
};

/**
 * The document as the reachability rules read it: every list named in `unorderedLists` reduced to
 * the entries that carry a reachability leaf, **in their order among themselves**.
 *
 * ## Why positions had to go
 *
 * A JSON pointer into a list is a position, and the routing list is where the classifier went wrong.
 * Measured 2026-09-22: removing the `russia` tunnel moved exactly four things — its two outbounds, its
 * one routing rule (a `domain_suffix` rule, no addresses), and its name in `wf-selector`'s members —
 * none of them reachability. But removing one rule shifts every rule after it by one, so the hq
 * tunnel's `{ ip_cidr: ["10.0.0.0/8"], … }` rule now sat at an index where a different rule had been,
 * and `/route/rules/6/ip_cidr` read as an address list that **appeared**. The class came out `network`,
 * a three-minute window opened for a routing edit, and the plan review warned the owner he would
 * probably lose his connection. Adding an outbound whose rule lands above an address rule did the
 * same, and so does any apply against a file missing one early rule — the `blockedEndpoints` rule of
 * G1 is exactly that.
 *
 * Reduced this way, a rule without an address leaves the view entirely, so adding, removing or
 * moving one cannot shift anything the classification reads. A rule **with** an address is still in
 * the view, so adding, removing or reordering *those* is still `network`: `ip_cidr` stays a
 * reachability leaf "whatever its position", and this changes which positions exist, not that rule.
 */
function reachabilityView(document: unknown, lists: string[], leaves: string[]): unknown {
  if (lists.length === 0 || typeof document !== 'object' || document === null) return document;
  const copy = structuredClone(document) as Record<string, unknown>;
  for (const pointer of lists) {
    const keys = pointer.split('/').slice(1);
    let parent: Record<string, unknown> | undefined = copy;
    for (const key of keys.slice(0, -1)) {
      const next: unknown = parent?.[key];
      parent = typeof next === 'object' && next !== null && !Array.isArray(next) ? (next as Record<string, unknown>) : undefined;
    }
    const last = keys[keys.length - 1]!;
    const list = parent?.[last];
    if (parent === undefined || !Array.isArray(list)) continue;
    parent[last] = list.filter((entry) => carriesLeaf(entry, leaves));
  }
  return copy;
}

function valueAt(document: unknown, pointer: string): unknown {
  if (pointer === '/' || pointer === '') return document;
  let value: unknown = document;
  for (const key of pointer.split('/').slice(1)) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function carriesLeaf(value: unknown, leaves: string[]): boolean {
  if (Array.isArray(value)) return value.some((item) => carriesLeaf(item, leaves));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, inner]) => leaves.includes(key) || carriesLeaf(inner, leaves));
}

/**
 * Which networks this device **defends** and which it merely **follows**.
 *
 * Supplied by the planner, because it is knowledge about the device and not about the diff — the
 * same reason `hotReloadable` is a parameter. The differ sees two JSON documents and has no way to
 * tell one kind of network from the other.
 *
 * `followed` are networks a peer assigned to an interface one of our tunnels created. `defended` are
 * the networks whose exclusion is what keeps this device reachable — the served LAN, the transfer
 * network, and the networks of interfaces the device is actually reached through.
 *
 * **Every network the generator puts in the exclusion list is in exactly one of these**, and that is
 * asserted by a test rather than promised here. A network belonging to neither would be softened,
 * which is the one way this could fail unsafely.
 */
export interface ReachabilityNetworks {
  followed: readonly string[];
  defended: readonly string[];
  /**
   * The networks the **running** fence recorded as followed when it was written (`PATHS.coreFence`).
   * Only these may leave the fence without a window. Absent means no record could be read — and that
   * permits nothing to leave.
   */
  previouslyFollowed?: readonly string[];
}

/**
 * The followed networks the running fence recorded, or `undefined` when there is no readable record.
 *
 * Unreadable and absent are the same answer here on purpose: both mean nothing is known about the
 * running fence, and the only safe reading of that is "no network in it is known to be followed".
 */
export function readFenceRecord(content: string | null | undefined): string[] | undefined {
  return readFenceRecordEntries(content)?.map((entry) => entry.network);
}

/**
 * The class of a change to one generated file, from what differs inside it.
 *
 * Falls back to the whole-file class when the document cannot be compared field by field — an
 * unparseable side, or a file with no entry above. "I could not read it" is not "nothing important
 * changed", so the coarse answer stands rather than being softened.
 *
 * ## The gate that nothing could ever pass
 *
 * Measured on the bench board, 2026-09-21, and it disabled a mechanism built the same morning. A
 * corporate OpenVPN tunnel reconnected at 12:41 and the peer handed out a different resolver *and* a
 * different transfer subnet — `10.164.0.0/20` became `10.165.0.0/20`. The captured resolver was
 * written, the watcher fired, the planner said plainly that the new value was in use, and
 * `/etc/wayfarer/core/config.json` was **not rewritten once** in the ninety minutes that followed,
 * while the core was restarted from the stale file and each reconverge recorded success.
 *
 * The cause was here. Reconvergence from a captured value applies with the `hot` and `service`
 * classes only, deliberately, so that a value a peer supplied can never touch the network. But the
 * peer's new subnet appears in the exclusion list under `/inbounds` and in an `ip_cidr` rule, so the
 * class was promoted to `network` and the write was refused — **on precisely the event the mechanism
 * exists for.** An OpenVPN reconnection that changes the pushed DNS almost always changes the pushed
 * subnet too, so the mechanism was not connected to nothing: it was connected to a gate it could
 * never pass.
 *
 * The fix is this project's own rule, one level deeper than it was being applied. The class already
 * comes from *what differs* rather than from which file was touched; it now comes from **what the
 * difference means** rather than from which pointer it landed on. A subnet the peer moved is one we
 * are catching up with — the network has already moved, and refusing to write it down protects
 * nothing and preserves something stale. Our own reachability exclusions are a different thing and
 * keep the `network` class, including every structural change to the inbound.
 */
export function classifyContentChange(
  path: string,
  before: string | null,
  after: string,
  networks?: ReachabilityNetworks,
): BlastRadius {
  const coarse = classifyPath(path);
  const rules = REACHABILITY_POINTERS[path];
  if (rules === undefined || before === null) return coarse;

  let previous: unknown;
  let next: unknown;
  try {
    // Read through the reachability view, so a list position is never mistaken for a reachability
    // pointer. See `reachabilityView`.
    previous = reachabilityView(JSON.parse(before), rules.unorderedLists, rules.leaves);
    next = reachabilityView(JSON.parse(after), rules.unorderedLists, rules.leaves);
  } catch {
    return coarse;
  }

  const differing = differingPointers(previous, next);
  if (differing.length === 0) return coarse;

  const touchesReachability =
    differing.some(
      (pointer) =>
        rules.prefixes.some((prefix) => pointer === prefix || pointer.startsWith(`${prefix}/`)) ||
        rules.leaves.some((leaf) => pointer.includes(`/${leaf}`)) ||
        // A whole entry that came or went is reported at the entry's own pointer, which names no leaf:
        // removing the last address rule differs at `/route/rules/2`, not at `…/ip_cidr`. So the
        // values on both sides are asked as well. Before the reachability view this gap was masked by
        // the index shift, which escalated nearly every rule removal for the wrong reason.
        carriesLeaf(valueAt(previous, pointer), rules.leaves) ||
        carriesLeaf(valueAt(next, pointer), rules.leaves),
    ) && !onlyFollowedNetworksMoved(previous, next, rules, networks);

  // Only ever softens a `network` file to `service`, never the reverse: a file already classified
  // below `network` is not promoted here, because this table describes reachability and nothing else.
  if (coarse === 'network' && !touchesReachability) return 'service';
  if (coarse !== 'network' && touchesReachability) return 'network';
  return coarse;
}

/**
 * True when the whole reachability difference is networks this device follows rather than defends.
 *
 * Two conditions, and both are needed. The **shape** of the reachability region must be identical —
 * same inbounds, same `auto_route`, same rules in the same places, with only the contents of the
 * address lists set aside; and the networks that came or went must not include one we defend.
 *
 * Comparing the lists as sets rather than position by position is not a nicety: the exclusion list
 * is built from a `Set`, so one network changing can shift every index after it, and a positional
 * comparison would report unrelated networks as differing and escalate anyway.
 *
 * A network that is in neither list escalates — including one that has simply departed, since a
 * stale value written by an earlier plan is not in today's reading of the device. That is the
 * conservative direction: the check asks for permission to soften and is refused by default.
 */
function onlyFollowedNetworksMoved(
  previous: unknown,
  next: unknown,
  rules: { prefixes: string[]; leaves: string[] },
  networks: ReachabilityNetworks | undefined,
): boolean {
  if (networks === undefined) return false;

  const before = reachabilityFacts(previous, rules);
  const after = reachabilityFacts(next, rules);

  // Anything but an address list differing — an inbound added, `auto_route` flipped, a rule moved —
  // is a reachability change whatever the addresses say.
  if (JSON.stringify(before.shape) !== JSON.stringify(after.shape)) return false;

  /*
   * **List by list, never pooled.** A network is judged in the list it enters or leaves.
   *
   * Measured on the bench board, 2026-09-23 09:07:52: the follower wanted `10.122.0.0/24` in the fence
   * and refused itself, because `corp`'s own resource rule already named `10.122.0.0/24`. With every
   * address in the region gathered into one set, adding it to the exclusion list read as nothing
   * appearing and nothing departing, and a change that moved nothing was refused its softening. Pooling
   * also hid the opposite case: a network entering a routing rule because it already sat in the fence.
   *
   * And only the lists the fence is made of may move: the exclusion list under `/inbounds`, and a rule
   * sending addresses `direct`, which the generator writes from the same reading. Any other rule whose
   * addresses change is a change to where traffic for an address goes — `network`, whatever the
   * addresses are.
   */
  const appeared: string[] = [];
  const departed: string[] = [];
  for (const pointer of new Set([...before.lists.keys(), ...after.lists.keys()])) {
    const was = before.lists.get(pointer) ?? new Set<string>();
    const is = after.lists.get(pointer) ?? new Set<string>();
    const came = [...is].filter((cidr) => !was.has(cidr));
    const went = [...was].filter((cidr) => !is.has(cidr));
    if (came.length === 0 && went.length === 0) continue;
    if (!isFenceList(pointer, previous) || !isFenceList(pointer, next)) return false;
    appeared.push(...came);
    departed.push(...went);
  }
  if (appeared.length === 0 && departed.length === 0) return false;

  const defended = new Set(networks.defended);
  const followed = new Set(networks.followed);

  // A network we are about to **write down** must be one we positively follow. "Not on the defended
  // list" is not enough for a value being added: an unrecognised address arriving in the exclusion
  // list is the case where this check should decline to soften, not the case it should wave through.
  if (!appeared.every((cidr) => followed.has(cidr))) return false;

  // A network **leaving** must be one the running fence itself recorded as followed, and must not be
  // defended now.
  //
  // It used to need only "not defended", and "defended" is a reading of the interfaces at plan time.
  // Measured 2026-09-23 on the bench board's own configuration: with the uplink momentarily without an
  // address — which is what an uplink flap is — its network was on neither list, so the fence
  // dropping it was `service`: no window, and the core's return path to the network the board is
  // reached through gone. A reading that a flap can empty cannot be what grants permission to narrow
  // the fence. The record written with the fence cannot be emptied by a flap.
  const recorded = new Set(networks.previouslyFollowed ?? []);
  return departed.every((cidr) => recorded.has(cidr) && !defended.has(cidr));
}

/**
 * Whether an address list is part of the fence: the core's exclusion list, or a rule sending its
 * addresses to the `direct` outbound (the generator's rule over the same networks).
 */
function isFenceList(pointer: string, document: unknown): boolean {
  if (/^\/inbounds\/\d+\/route_exclude_address$/.test(pointer)) return true;
  const rule = /^(\/route\/rules\/\d+)\/ip_cidr$/.exec(pointer);
  return rule !== null && valueAt(document, `${rule[1]}/outbound`) === 'direct';
}

/**
 * The reachability region of a document, split into the addresses it names and everything else.
 *
 * `shape` records each reachability location and what kind of thing is there, with address lists
 * collapsed to a marker; `networks` is every address named anywhere in the region.
 */
function reachabilityFacts(
  document: unknown,
  rules: { prefixes: string[]; leaves: string[] },
): { shape: Record<string, unknown>; networks: Set<string>; lists: Map<string, Set<string>> } {
  const shape: Record<string, unknown> = {};
  const networks = new Set<string>();
  // The same addresses, kept by the list they are in. See `onlyFollowedNetworksMoved` for why a pooled
  // set is not enough.
  const lists = new Map<string, Set<string>>();

  const matches = (pointer: string): boolean =>
    rules.prefixes.some((prefix) => pointer === prefix || pointer.startsWith(`${prefix}/`)) ||
    rules.leaves.some((leaf) => pointer.endsWith(`/${leaf}`) || pointer.includes(`/${leaf}/`));

  const walk = (value: unknown, pointer: string): void => {
    const inRegion = pointer !== '' && matches(pointer);

    if (Array.isArray(value)) {
      if (inRegion && value.every((item) => typeof item === 'string')) {
        for (const item of value as string[]) networks.add(item);
        lists.set(pointer, new Set(value as string[]));
        // A marker, and deliberately not the length: a list gaining or losing a member is exactly
        // the change being examined, and recording its size here would make the shapes differ and
        // escalate it again through the back door.
        shape[pointer] = 'addresses';
        return;
      }
      value.forEach((item, index) => walk(item, `${pointer}/${index}`));
      return;
    }

    if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${pointer}/${key}`);
      return;
    }

    if (inRegion) {
      if (typeof value === 'string') {
        networks.add(value);
        lists.set(pointer, new Set([value]));
      } else shape[pointer] = value;
    }
  };

  walk(document, '');
  return { shape, networks, lists };
}

/** Every JSON pointer whose leaf value differs between two documents. */
/**
 * Every JSON Pointer at which two documents differ.
 *
 * Exported because the drift check names the pointer and both values, and deriving "where do these
 * two documents disagree" a second time is the shape this repository keeps paying for: two copies of
 * one rule agree exactly until the day one of them changes. `'/'` is the whole document, returned
 * when the two sides are not both objects — a file that stopped being JSON has no inner pointer.
 */
export function differingPointers(before: unknown, after: unknown, at = ''): string[] {
  if (before === after) return [];
  const bothObjects =
    typeof before === 'object' && before !== null && typeof after === 'object' && after !== null;
  if (!bothObjects) return [at === '' ? '/' : at];

  if (Array.isArray(before) !== Array.isArray(after)) return [at === '' ? '/' : at];

  const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
  const found: string[] = [];
  for (const key of keys) {
    const left = (before as Record<string, unknown>)[key];
    const right = (after as Record<string, unknown>)[key];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    found.push(...differingPointers(left, right, `${at}/${key}`));
  }
  return found;
}

/**
 * The class of a unit action, from what it changes **in effect**.
 *
 * The firewall is the case that forced this. Re-asserting a ruleset that is already in force changes
 * nothing, so it is `service`. Bringing the unit from not-running to running puts the whole ruleset —
 * kill-switch included — into force for the first time, which is a `network` change by any reading.
 * Same rule as above: what changes in effect, not which file was touched.
 */
export function classifyUnitAction(
  name: string,
  action: UnitChange['action'],
  wasActive: boolean | undefined,
): BlastRadius {
  const base = unitClassFor(name);
  if (action === 'start' && wasActive !== true) {
    // Nothing was enforcing this unit's configuration a moment ago and now something is.
    return name.startsWith('wf-firewall') ? 'network' : base;
  }
  if (action === 'restart' && wasActive === true && name.startsWith('wf-firewall')) {
    // The same ruleset, re-read. Nothing in force changes.
    return 'service';
  }
  return base;
}

export interface DiffInput {
  desired: DesiredState;
  reality: Reality;
  /**
   * Changes reachable through a running component's API rather than by restarting it — in practice
   * the selected tunnel and rule-set contents. Supplied by the caller because knowing what is
   * hot-reloadable is knowledge about the component, not about the diff.
   *
   * **The `hot` class is now reachable, and this note records how rather than that it is not.**
   *
   * Changing which exit traffic uses does not go through a plan at all. The health watchdog reads the
   * policy live and points the core's selector through the core's own control interface, so the change
   * takes effect in a running core: measured on the bench board, 2026-09-21, the selector moved from one
   * tunnel to another with `wf-core`'s `MainPID` unchanged, `tun0` unchanged and `NRestarts` at zero.
   *
   * The consequence for the differ is a pleasing one: a profile edit that only changes the failover
   * order, the exclusions or the probe thresholds produces **no artefact changes at all**, so the plan is
   * empty and its class is `hot` by the ordinary rule that an empty plan is the lowest class. Nothing had
   * to be special-cased.
   *
   * This parameter remains for the case it was written for — a path whose *contents* a running component
   * can be told about, such as a rule set — which nothing supplies yet. That part is still honestly
   * absent, and a plan review says `service` for it because the class is computed rather than declared.
   */
  hotReloadable?: { paths: string[] };
}

export function diff(input: DiffInput): Plan2 {
  const { desired, reality } = input;
  const realityFiles = new Map(reality.files.map((file) => [file.path, file]));
  const realityUnits = new Map(reality.units.map((unit) => [unit.name, unit]));
  const hotPaths = new Set(input.hotReloadable?.paths ?? []);

  const fileChanges: FileChange[] = [];
  const allFiles: ManagedFile[] = [...desired.files, ...desired.networkFiles];

  // The running fence's own record, read from the device rather than from the plan: see `readFenceRecord`.
  const previouslyFollowed = readFenceRecord(realityFiles.get(PATHS.coreFence)?.content);
  const networks: ReachabilityNetworks = {
    ...desired.reachabilityNetworks,
    ...(previouslyFollowed === undefined ? {} : { previouslyFollowed }),
  };
  const coreFile = allFiles.find((file) => file.path === PATHS.coreConfig);
  const coreClass =
    coreFile === undefined
      ? null
      : classifyContentChange(coreFile.path, realityFiles.get(coreFile.path)?.content ?? null, coreFile.content, networks);

  for (const file of allFiles) {
    const current = realityFiles.get(file.path);
    // The class of this *change*, computed from what differs inside the file where that is knowable.
    // The fence record takes the fence's class, so a narrowed apply refused the fence is refused its
    // record too: a record describing a fence that was never written would grant the next change a
    // permission nobody earned.
    const blastRadius = hotPaths.has(file.path)
      ? 'hot'
      : file.path === PATHS.coreFence && coreClass !== null
        ? coreClass
        : classifyContentChange(file.path, current?.content ?? null, file.content, networks);

    if (current === undefined || current.content === null) {
      fileChanges.push({ path: file.path, action: 'create', purpose: file.purpose, blastRadius });
      continue;
    }
    if (current.content !== file.content) {
      fileChanges.push({ path: file.path, action: 'update', purpose: file.purpose, blastRadius });
      continue;
    }
    if (current.mode !== null && current.mode !== file.mode) {
      // A mode change alone: the content is right and the permissions are not. Classified with the
      // file rather than as cosmetic, because a file a service cannot read is a service that fails.
      fileChanges.push({ path: file.path, action: 'chmod', purpose: file.purpose, blastRadius });
    }
  }

  const unitChanges: UnitChange[] = [];
  const foreignUnits: string[] = [];
  const changedFiles = new Set(fileChanges.map((change) => change.path));

  /**
   * Which unit each changed file belongs to, taken from the file's **own declaration**.
   *
   * Every managed file already carries `consumedBy`, and this used to ignore it and re-guess from the
   * path with substring matching. Two consequences, both measured on the bench board, 2026-09-21:
   *
   * * A file whose name did not happen to contain its unit's instance name never triggered a restart.
   * * **A unit whose own definition changed was reloaded and never restarted.** The apply reported
   *   `install wf-firewall.service`, the file on disk was correct, the running unit kept the old
   *   content, and the next plan reported `empty: true` — so the device declared convergence while the
   *   running state differed from the declared one. Twice in one evening the protection just added was
   *   simply absent until the unit was restarted by hand.
   *
   * Deriving it from the declaration instead of describing it is the rule this project already states
   * for artefacts; it was applied to the files and not to the units that read them.
   */
  /*
   * Kept as unit → **paths** rather than as a set of unit names.
   *
   * The names alone answer "does this unit need restarting" and nothing else. A restart that has to
   * say *what it is for* needs the paths, and recovering them afterwards would mean walking the files
   * a second time with the same rule — a second copy of the rule, which is how the two halves come to
   * disagree about which files a unit reads.
   */
  const consumedPathsByUnit = new Map<string, string[]>();
  for (const file of allFiles) {
    if (!changedFiles.has(file.path)) continue;
    if (file.consumedBy?.kind !== 'unit') continue;
    const existing = consumedPathsByUnit.get(file.consumedBy.unit);
    if (existing === undefined) consumedPathsByUnit.set(file.consumedBy.unit, [file.path]);
    else existing.push(file.path);
  }
  const desiredUnitNames = new Set(desired.units.map((unit) => unit.name));

  for (const unit of desired.units) {
    if (!isOwnedUnit(unit.name)) {
      // Never acted on. This project stops, restarts and removes only units whose names it generated.
      foreignUnits.push(unit.name);
      continue;
    }
    const current = realityUnits.get(unit.name);
    const unitClass = unitClassFor(unit.name);

    /**
     * `install` is a `daemon-reload`, nothing more: the unit *file* is written through the ordinary
     * managed-file path. So it is planned when systemd's copy of the definition is out of date, which
     * is a question about the file and not about the unit's state.
     *
     * Two things this replaces, both measured on the bench board, 2026-09-20, fresh image, after a
     * committed network apply:
     *
     * 1. **A template has no unit state at all.** `systemctl show wf-hostapd@.service` does not return
     *    `LoadState=loaded`; it fails with "Unit name wf-hostapd@.service is neither a valid invocation
     *    ID nor unit name", because a template is not a unit — only its instances are. Asking reality
     *    whether it is loaded therefore answers "no" forever, and keying `install` off that answer made
     *    the plan **never converge**: five templates, five `install` steps and five daemon-reloads on
     *    every apply, a device that always showed pending changes when nothing was pending, and — the
     *    part that actually costs something — a permanent `network` blast radius, so every trivial
     *    change dragged a three-minute confirmation window behind it.
     * 2. **A changed unit definition got no reload.** For a non-template already known to systemd, the
     *    old condition was false, so editing a generated unit planned a write and a restart with no
     *    reload in between — and the restart then ran the definition systemd still had in memory. The
     *    planner's own comment beside the unit-file emission already said "a unit whose definition
     *    changed is the thing that makes the reload necessary"; this is the differ finally agreeing.
     *
     * The residual case is a write that happened without a reload following it — a crash in between.
     * The file then matches and systemd has not seen it, which is invisible in the file and visible in
     * the unit: for a plain unit, `known` is false and covered below; for a template, the evidence is
     * an instance systemd does not know about.
     */
    const definitionWritten = changedFiles.has(`${PATHS.unitDir}/${unit.name}`);
    const isTemplate = unit.name.includes('@.');
    const unreadNonTemplate = !isTemplate && (current === undefined || !current.known);
    const unreadInstanceOfTemplate =
      isTemplate &&
      desired.units.some(
        (other) => other.name !== unit.name && instanceOf(other.name) === unit.name && !realityUnits.get(other.name)?.known,
      );
    if (unit.content !== undefined && (definitionWritten || unreadNonTemplate || unreadInstanceOfTemplate)) {
      unitChanges.push({ name: unit.name, action: 'install', purpose: unit.purpose, blastRadius: unitClass });
    }

    // Enable before start, always, and even when the unit is already running. A failing restart aborts
    // a sequence, and if enable has not run the unit is left disabled — a fault that only appears
    // after the next reboot: the service works now and is gone in the morning.
    //
    // The class is the **unit's own**, not a flat `service`. Enabling the access point is part of
    // bringing the access point up, and classifying it lower splits one change across two classes:
    // a narrowed apply would then enable hostapd without writing its configuration or starting it,
    // leaving a unit that is enabled, not running, and configured to fail at the next boot. Worse, it
    // defers a network change to a reboot with nothing having confirmed it.
    if (unit.enabled && current?.enabled !== true) {
      unitChanges.push({ name: unit.name, action: 'enable', purpose: unit.purpose, blastRadius: unitClass });
    }
    if (!unit.enabled && current?.enabled === true) {
      unitChanges.push({ name: unit.name, action: 'disable', purpose: unit.purpose, blastRadius: unitClass });
    }

    if (unit.active) {
      const restartCauses = restartCausesFor(unit.name, changedFiles, consumedPathsByUnit.get(unit.name));
      if (current?.active !== true) {
        unitChanges.push({
          name: unit.name,
          action: 'start',
          purpose: unit.purpose,
          // What this start puts into force, not what kind of unit it is.
          blastRadius: classifyUnitAction(unit.name, 'start', current?.active),
          /*
           * No `becauseOf`, deliberately, and **not** `restartCauses` even when that list is not
           * empty. This step is in the plan because the unit is down, not because a file changed, so
           * the files it happens to share an apply with are not what it is for. Attaching them would
           * make a unit that is down skippable the moment those writes were refused — and a unit that
           * is down still has to be brought up.
           */
        });
      } else if (restartCauses.length > 0) {
        // Restart, not "enable and start". For a unit already running, an enable-and-start call does
        // nothing at all, and the new configuration is silently not applied.
        unitChanges.push({
          name: unit.name,
          action: 'restart',
          purpose: unit.purpose,
          blastRadius: classifyUnitAction(unit.name, 'restart', current?.active),
          // Non-empty by construction: this branch is only reached because a cause was found.
          becauseOf: restartCauses,
        });
      }
    } else if (current?.active === true && unit.content === undefined) {
      unitChanges.push({ name: unit.name, action: 'stop', purpose: unit.purpose, blastRadius: unitClass });
    }
  }

  /**
   * Units we own that the profile no longer asks for.
   *
   * Stopped and disabled, never deleted here — removing the *file* is a file change and goes through
   * the ordinary path. The ownership rule is what makes this safe: only names this project generates
   * are touched, so a stale unit is by definition one we created and no longer want.
   *
   * Instances only. A template has no state: `wf-hostapd@.service` is a file rather than something
   * that can be running.
   */
  for (const name of reality.ownedUnits ?? []) {
    if (!isOwnedUnit(name) || name.includes('@.')) continue;
    if (desiredUnitNames.has(name)) continue;
    const current = realityUnits.get(name);
    const active = current?.active === true;
    const enabled = current?.enabled === true;
    if (!active && !enabled) continue;
    const blastRadius = unitClassFor(name);
    if (active) {
      unitChanges.push({
        name,
        action: 'stop',
        purpose: 'this profile no longer asks for it, and it is still running',
        blastRadius,
      });
    }
    if (enabled) {
      unitChanges.push({
        name,
        action: 'disable',
        purpose: 'this profile no longer asks for it, and it would start again at the next boot',
        blastRadius,
      });
    }
  }

  const sysctlChanges = desired.sysctl
    .filter((setting) => reality.sysctl[setting.key] !== setting.value)
    .map((setting) => ({
      key: setting.key,
      from: reality.sysctl[setting.key] ?? null,
      to: setting.value,
      reason: setting.reason,
    }));

  // A rename is detected from the `.link` files: the target name is what the interface will be called,
  // and the address is which interface that is. An interface already called the target name is not a
  // rename, and an address the kernel does not report is hardware that is not present — neither is a
  // change to anything.
  const interfaceRenames: Plan2['interfaceRenames'] = [];
  const byMac = new Map(
    reality.interfaces
      .filter((entry): entry is { name: string; mac: string } => entry.mac !== null)
      .map((entry) => [entry.mac.toLowerCase(), entry.name]),
  );
  const presentNames = new Set(reality.interfaces.map((entry) => entry.name));

  for (const file of desired.networkFiles) {
    if (!file.path.endsWith('.link')) continue;
    const target = /^Name=(.+)$/m.exec(file.content)?.[1];
    const mac = /^MACAddress=(.+)$/m.exec(file.content)?.[1];
    if (target === undefined || mac === undefined) continue;

    const current = byMac.get(mac.toLowerCase());
    // The hardware is not attached: nothing is renamed, and reporting a rename here would invent a
    // change to a device that does not exist.
    if (current === undefined) continue;
    if (current === target) continue;
    // Some other interface already holds the target name. That is a collision rather than a rename,
    // and it is caught by the name checks rather than described here as something benign.
    if (presentNames.has(target) && current !== target) continue;

    interfaceRenames.push({
      from: current,
      to: target,
      carriesManagement: reality.managementInterfaces.includes(current),
    });
  }

  const classes: BlastRadius[] = [
    ...fileChanges.map((change) => change.blastRadius),
    ...unitChanges.map((change) => change.blastRadius),
    ...(sysctlChanges.length > 0 ? (['network'] as BlastRadius[]) : []),
    // A rename of the interface carrying the management session is network, never service: the rename
    // needs the link down, and a link going down is indistinguishable from losing the board.
    ...interfaceRenames.map((rename): BlastRadius => (rename.carriesManagement ? 'network' : 'boot')),
  ];

  /**
   * Which management-carrying interfaces this plan disturbs.
   *
   * Three ways a plan can reach one, and all three count: a rename of it, a `.network` file that
   * configures it **when this plan rewrites networkd's configuration at all**, and a unit instanced on
   * it — an access point started on the interface currently carrying a client association takes that
   * association with it, which is precisely the change that cost this project a locked-out board.
   *
   * ## The warning that cried wolf on every apply
   *
   * The middle clause used to ask whether *any desired* `.network` file named the interface — and every
   * profile with an uplink or an access point has one, whether this plan changes it or not. So the
   * warning "this change reconfigures wlx90de8047b4b4, wfwan0 … you will probably lose access" was on
   * every plan the bench board produced. Measured 2026-09-22 on three applies whose change set was the
   * core configuration and a `wf-core` restart and nothing else (`1b87739bc7c85899`,
   * `c77ac7f27f86a096`, `d03414ffe34327ff`); the access point never went down. A warning that is always
   * there is a warning nobody reads on the day it is true.
   *
   * The condition is now the reconciler's own: it reloads networkd and runs `networkctl reconfigure`
   * over every managed link when a networkd file changed or a takeover is planned (`reconciler.ts`,
   * step 3b), and not otherwise. A `.network` file that names the interface matters exactly then.
   */
  const reconfiguresLinks =
    (desired.takeover ?? []).length > 0 || fileChanges.some((change) => change.path.startsWith(`${PATHS.networkdDir}/`));
  const affectsManagementInterfaces = [
    ...new Set(
      reality.managementInterfaces.filter((name) => {
        if (interfaceRenames.some((rename) => rename.from === name)) return true;
        if (
          reconfiguresLinks &&
          desired.networkFiles.some(
            (file) => file.path.endsWith('.network') && new RegExp(`^Name=${escapeForMatch(name)}$`, 'm').test(file.content),
          )
        ) {
          return true;
        }
        // A unit instance named after the interface. `wf-hostapd@wlan0.service` is the case that
        // matters: it turns a client radio into an access point.
        return unitChanges.some(
          (change) => change.action !== 'stop' && change.name.includes(`@${name}.`),
        );
      }),
    ),
  ];

  const empty =
    fileChanges.length === 0 &&
    unitChanges.length === 0 &&
    sysctlChanges.length === 0 &&
    interfaceRenames.length === 0;

  // Computed once and used for both the structured list and the prose, so a client reading `unitChanges`
  // and a person reading `humanDiff` are told the same thing.
  const described = withConsequences(unitChanges);

  return {
    fileChanges,
    unitChanges: described,
    sysctlChanges,
    interfaceRenames,
    blastRadius: classes.length === 0 ? 'hot' : highest(classes),
    humanDiff: describe(described, sysctlChanges, interfaceRenames, affectsManagementInterfaces, fileChanges),
    empty,
    foreignUnits,
    affectsManagementInterfaces,
  };
}

/**
 * Escapes an interface name for use inside a regular expression.
 *
 * Interface names are constrained where we generate them, but this also matches names the *kernel*
 * chose — and a predictable-looking name is exactly the kind of input that turns out to contain a
 * character with a meaning somewhere else.
 */
function escapeForMatch(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which class acting on this unit falls into.
 *
 * The access point is the one that stands out: restarting it drops every associated client, so it is
 * `network` even though nothing about addressing changes. "Clients keep their association" is part of
 * the definition of `service`, and a radio restart breaks it.
 */
/**
 * The template a unit name is an instance of, or `null` when the name is not an instance.
 *
 * `wf-hostapd@wlan0.service` → `wf-hostapd@.service`. The separator is the first `@`, because an
 * instance name may contain one and the template name is everything up to the first.
 */
function instanceOf(name: string): string | null {
  const at = name.indexOf('@');
  if (at < 0) return null;
  const dot = name.lastIndexOf('.');
  if (dot < at) return null;
  const instance = name.slice(at + 1, dot);
  if (instance.length === 0) return null;
  return `${name.slice(0, at)}@${name.slice(dot)}`;
}

function unitClassFor(name: string): BlastRadius {
  // The two units that own a radio. Stopping or restarting either takes a link down: the access point
  // takes the network we serve, the client takes the uplink we are reached through.
  if (name.startsWith('wf-hostapd@')) return 'network';
  if (name.startsWith('wf-supplicant@')) return 'network';
  return 'service';
}

/**
 * What stopping or restarting a unit costs, in the operator's terms.
 *
 * Derived from the same name test as the class above, on purpose: the reason a radio unit is `network` *is*
 * the cost, so the two answers come from one place. Only for the actions that interrupt it — enabling a unit
 * costs nothing, and a sentence attached to every step would be noise the reader learns to skip.
 */
function unitConsequenceFor(name: string, action: UnitChange['action']): string | undefined {
  if (action !== 'restart' && action !== 'stop' && action !== 'start') return undefined;
  if (name.startsWith('wf-hostapd@')) {
    return action === 'start'
      ? 'the wireless network this device offers comes up; nothing is connected to it yet'
      : 'every device connected to this access point is disconnected and has to join again — including the ' +
          'phone or laptop you may be reading this on, and if the network name or passphrase changed they ' +
          'will need the new ones';
  }
  if (name.startsWith('wf-supplicant@')) {
    return action === 'start'
      ? 'this device joins the wireless network it uses for internet access'
      : 'this device leaves the wireless network it uses for internet access, so anything going through it ' +
          'stops until it rejoins';
  }
  return undefined;
}

/**
 * Whether a unit's configuration is among the files that changed.
 *
 * Matched on the instance name rather than on a table of unit-to-file pairs, because the file is
 * named after the instance by construction — and a table would be a second description of a naming
 * scheme that already exists.
 */
/**
 * **Which files** make a running unit need restarting for this plan to take effect.
 *
 * Paths rather than a boolean, because the answer is also the restart's `becauseOf`: a caller that
 * has to decide whether a restart is still worth doing needs to know what it was for, and a boolean
 * can only say that it was for something. An empty result means no restart, which is why the caller
 * can treat a non-empty `becauseOf` as guaranteed by construction.
 *
 * Three reasons, and the first is the one that was missing:
 *
 * 1. **Its own definition changed.** A rewritten unit file is reloaded by `install`, and a reload tells
 *    systemd the definition is new — it does not put the new definition into force for a unit that is
 *    already running. Anything the unit does at start-up, including every `ExecStartPost`, keeps running
 *    the old version until it restarts. Measured twice on 2026-09-21: the policy rules a changed unit was
 *    meant to install did not exist, the apply reported success, and the following plan was empty.
 * 2. **A file that declares this unit as its consumer changed.** From the declaration, not from a guess
 *    about the path.
 * 3. The legacy path-shape rules, kept as a safety net for any file that has no declaration yet, so
 *    removing the guess cannot silently stop restarting something it used to catch.
 */
function restartCausesFor(unitName: string, changedFiles: Set<string>, consumedPaths: string[] | undefined): string[] {
  /*
   * A set, because the three sources overlap: a core configuration file is both declared as consumed
   * by `wf-core.service` and matched by the path-shape net, and listing it twice would make a caller
   * checking "were all of my causes refused" compare against a multiset for no reason.
   *
   * Returned in insertion order rather than sorted: the definition file first, then the declarations,
   * then whatever the net caught — which is the order a person reading a plan review wants, cause
   * before consequence.
   */
  const causes = new Set<string>();

  // 1. Its own definition, which nothing else in this function can reach. A unit file is consumed by
  //    *systemd*, not by one of our units, so no `consumedBy` declaration names it — and a restart
  //    whose only reason is a rewritten definition would otherwise arrive with no cause at all,
  //    which reads as "not recorded" and is exactly wrong.
  const definition = `${PATHS.unitDir}/${unitName}`;
  if (changedFiles.has(definition)) causes.add(definition);

  // 2. Files that declare this unit as their consumer. From the declaration, not from a guess.
  for (const path of consumedPaths ?? []) causes.add(path);

  /*
   * 3. The path-shape net, kept for any file that carries no declaration yet, so removing the guess
   *    cannot silently stop restarting something it used to catch.
   *
   *    **Measured 2026-09-21: deleting this net entirely turns nothing red in the daemon suite.**
   *    Every file it would catch today is also declared, so it currently catches nothing and the
   *    number is recorded rather than the net removed — it is a fall-back for a file that arrives
   *    without a declaration, which is a thing that has not happened yet rather than a thing that
   *    cannot. What the measurement says is that nothing is watching it: if it is ever edited, no
   *    test will object.
   */
  const instance = /@(.+)\.service$/.exec(unitName)?.[1];
  for (const path of changedFiles) {
    if (unitName === 'wf-core.service' && path.includes('/core/')) causes.add(path);
    if (instance !== undefined && path.includes(`/${instance}.`)) causes.add(path);
  }

  return [...causes];
}

/**
 * Attaches the consequence to each unit change, in one place.
 *
 * One pass rather than a field set at each of the eight `unitChanges.push` sites — because a consequence
 * that is right at seven of them and forgotten at the eighth is worse than none: the reader learns that the
 * absence of a warning means the step is harmless.
 */
function withConsequences(units: UnitChange[]): UnitChange[] {
  return units.map((unit) => {
    const consequence = unitConsequenceFor(unit.name, unit.action);
    return consequence === undefined ? unit : { ...unit, consequence };
  });
}

function describe(
  units: UnitChange[],
  sysctl: Plan2['sysctlChanges'],
  renames: Plan2['interfaceRenames'],
  affectsManagement: string[],
  files: FileChange[],
): string[] {
  const lines: string[] = [];

  // First, before the list of changes, because it is the one line that changes what the operator should
  // do before pressing anything. A plan that reconfigures the interface the request arrived on can take
  // away the only means of answering the confirmation it is about to ask for.
  if (affectsManagement.length > 0) {
    lines.push(
      `WARNING: this change reconfigures ${affectsManagement.join(', ')}, which is carrying the connection ` +
        'you are using right now. You will probably lose access while it applies. Make sure you have a ' +
        'second way in — another network, or a cable — before confirming, because the confirmation has to ' +
        'come from you and the device reverts on its own if it does not arrive.',
    );
  }

  // Ordered the way it will be applied, not grouped by kind: the review is read by somebody deciding
  // whether to press Apply, and the sequence is the thing they are agreeing to.
  for (const rename of renames) {
    lines.push(
      `rename ${rename.from} to ${rename.to}` +
        (rename.carriesManagement
          ? ' — this interface currently carries your session, so the connection will drop'
          : ' (takes effect after a reboot)'),
    );
  }
  for (const file of files) {
    const verb = file.action === 'create' ? 'write' : file.action === 'update' ? 'replace' : 'fix permissions on';
    lines.push(`${verb} ${file.path} — ${file.purpose}`);
  }
  for (const setting of sysctl) {
    lines.push(`set ${setting.key} to ${setting.to} (was ${setting.from ?? 'unset'}) — ${setting.reason}`);
  }
  for (const unit of units) {
    lines.push(
      `${unit.action} ${unit.name} — ${unit.purpose}` +
        (unit.consequence === undefined ? '' : `. ${unit.consequence}`),
    );
  }

  if (lines.length === 0) lines.push('nothing to do: the device already matches this profile');
  return lines;
}
