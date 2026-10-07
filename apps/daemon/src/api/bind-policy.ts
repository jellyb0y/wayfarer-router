/**
 * Where the management surface may listen, and where it must not.
 *
 * ## The requirement, in the owner's words
 *
 * Listen on every **local** channel — the wire, this device's own access point, the Wi-Fi network
 * this device is a client of, and loopback — and on **no tunnel interface at all**. The negative
 * half is a prohibition, not a preference: four tunnels are up on the bench board, two of them
 * corporate, and a panel audible inside one is a panel offered to a network that never asked for a
 * client. With a short published default password that is not a theoretical exposure.
 *
 * ## Why this is a module and not four lines in the listener
 *
 * Measured on the bench board, 2026-09-21, `ss -tln` on port 8088:
 *
 * ```
 * 127.0.0.1:8088        loopback
 * 10.44.0.1:8088        wlx90de8047b4b4, the access point
 * 192.168.77.8:8088    wfwan0, the wireless uplink
 * ```
 *
 * and `end0` — the wire, `192.168.77.7/24` — answering nothing. Both halves of the requirement
 * looked satisfied: the panel opened, and no tunnel was listening. The wire was missing because the
 * bind set was built from what the last apply **recorded**, and no plan touches the wire — it is the
 * lifeline every plan is written to leave alone. So it could not appear in that record under any
 * configuration, and the check that passed had looked only at the interfaces already in the list.
 *
 * Two addresses in one subnet, `192.168.77.7` and `.8`, with opposite answers, is also the whole
 * argument for proving this by a socket list **per interface** rather than by opening the page.
 *
 * ## The negative half is enforced, not inherited
 *
 * Before this module, no tunnel was ever bound — but not because anything refused one. The positive
 * half simply never named one, and the guarantee was a side effect of a list that happened to be
 * short. **A guarantee that holds because control never reaches it stops being a guarantee the
 * moment the list gets longer**, which is exactly what widening the positive half does. So the
 * refusal below is a separate, final step over the names already chosen, and it reports when it has
 * something to remove: if the positive half ever yields a tunnel, that is a defect to hear about,
 * not one to repair in silence.
 *
 * The classification itself is not decided here. What an interface *is* is knowledge about the
 * system and belongs to the platform layer; what the management surface may do with it is policy and
 * belongs here. This module is a reader of the first and the author of the second.
 */

import {
  classifyInterfaces,
  type ChannelClass,
  type ClassifiedInterface,
} from "../core/interface-class.ts";
import type { NetLink } from "../platform/parse/ip-json.ts";

/**
 * Re-exported, not redefined.
 *
 * What an interface *is* is the platform layer's vocabulary and it has exactly one definition. A
 * second copy here would read as a convenience and behave as a second source of truth: the two would
 * agree until one of them gained a class, and the disagreement would show up as a tunnel that this
 * policy does not recognise as one.
 *
 * Worth knowing about the classes, because this module leans on it: `unknown` is a real third answer
 * and not a synonym for `tunnel`. It means the classifier could not decide. Neither is ever bound,
 * but they are reported differently, because "we could not tell" and "we know this is a tunnel" call
 * for different actions from whoever reads the log.
 */
export type { ChannelClass, ClassifiedInterface };

/** The record every plan writes and this module reads: the surfaces a profile resolved to. */
export interface ManagementSurfaces {
  accessPoint: string | null;
  uplinks: string[];
  /**
   * Interface names this plan's own tunnels resolve to.
   *
   * **Empty means "this plan created no tunnels", not "unknown."** That reading is only safe while
   * the link's own shape stays the primary verdict and this stays a supplement to it. Make this the
   * sole source of what a tunnel is, and the assumption rots with no symptom to show for it.
   */
  tunnels: string[];
}

export interface BindDecision {
  /** Interface names the management surface may bind, in a stable order. */
  bind: string[];
  /**
   * Names the positive half chose and the final refusal then removed.
   *
   * Expected to be empty for ever. When it is not, something upstream classified a tunnel as a local
   * channel, and the caller records an event rather than quietly enjoying the save.
   */
  refused: ClassifiedInterface[];
  /** Local channels deliberately left out — today only the uplink, when the operator turns it off. */
  withheld: ClassifiedInterface[];
}

export interface BindPolicyInput {
  /** Every interface the kernel currently reports, with the platform layer's verdict on each. */
  classified: ClassifiedInterface[];
  /**
   * `services.management.onUplinkNetwork`. The wire and the access point are not negotiable; the
   * network this device is a client of is a profile setting, defaulting to on.
   */
  onUplinkNetwork: boolean;
  /**
   * Names known to be tunnels, from every source that knows one — the classifier's own verdict and
   * the interface names the active profile's tunnels resolve to.
   *
   * Passed separately rather than read off `classified` on purpose, and this is the point of the
   * whole module: the refusal must be able to catch a name that the positive half has already
   * accepted. If it could only consult the same verdict that chose the name, it could never disagree
   * with it, and a filter that cannot disagree is decoration.
   *
   * It must also catch tunnels this device did not create. `tun0` on the bench board belongs to no
   * profile of ours and the prohibition covers it exactly the same.
   */
  tunnelInterfaces: Iterable<string>;
}

/** Loopback is not decided here: the listener always has it from `listen.addresses`. */
const ALWAYS_LOCAL: ChannelClass[] = ["wired", "accessPoint"];

/**
 * The final gate: the names the positive half chose, minus anything that is not a local channel.
 *
 * ## Why this is exported rather than four lines inside the decision
 *
 * Mutation testing on 2026-09-21, against `test/bind-policy.test.ts`: deleting `tunnels.has(name)`
 * from the condition below turns a test red. Deleting `entry.class === 'tunnel'` does not. Deleting
 * `entry.class === 'unknown'` does not either. Both survived every case in the file.
 *
 * The reason is not a missing assertion, it is reachability. The positive half only ever puts
 * `wired`, `accessPoint` and `wirelessUplink` entries into `chosen`, so a gate that reads `chosen`
 * can never *see* an entry whose class is `tunnel` or `unknown`. The module header argues that a
 * guarantee which holds because control never reaches it is not a guarantee — and the gate written
 * to remove that shape from the bind path had grown the same shape inside itself. A comment here
 * used to claim that `tunnel` and `unknown` "still pass through the refusal below". They did not.
 *
 * The clauses are still right, and they are the whole reason the gate survives somebody widening
 * `ALWAYS_LOCAL`. What was missing was any way for a test to reach them. So the gate is a function
 * with its own input: a test hands it a `tunnel` directly, with an empty name list so the other
 * clause cannot cover for it, and breaking either class clause now turns that test red.
 *
 * `tunnelInterfaces` is kept as a separate argument for the reason the input type gives: a gate that
 * can only consult the verdict that chose the name can never disagree with it.
 */
export function refuseNonLocal(
  chosen: ClassifiedInterface[],
  tunnelInterfaces: Iterable<string>,
): { bind: string[]; refused: ClassifiedInterface[] } {
  const tunnels = new Set(tunnelInterfaces);

  const bind: string[] = [];
  const refused: ClassifiedInterface[] = [];
  for (const entry of chosen) {
    if (
      tunnels.has(entry.name) ||
      entry.class === "tunnel" ||
      entry.class === "unknown"
    ) {
      refused.push(entry);
      continue;
    }
    // Two links can resolve to the same name across sources; the bind list is addresses to open, and
    // opening one twice is an error the listener reports as a port conflict, not as a duplicate.
    if (!bind.includes(entry.name)) bind.push(entry.name);
  }

  return { bind, refused };
}

export function decideManagementInterfaces(
  input: BindPolicyInput,
): BindDecision {
  const withheld: ClassifiedInterface[] = [];
  const chosen: ClassifiedInterface[] = [];

  for (const entry of input.classified) {
    if (ALWAYS_LOCAL.includes(entry.class)) {
      chosen.push(entry);
      continue;
    }
    if (entry.class === "wirelessUplink") {
      if (input.onUplinkNetwork) chosen.push(entry);
      else withheld.push(entry);
      continue;
    }
    // `loopback` is already covered by `listen.addresses`, and `tunnel` and `unknown` are not chosen
    // here. They therefore never reach the gate below either — which is why the gate is tested on its
    // own, through `refuseNonLocal`, and not only through this function.
  }

  const { bind, refused } = refuseNonLocal(chosen, input.tunnelInterfaces);
  return { bind, refused, withheld };
}

/**
 * The line recorded when the refusal had something to remove.
 *
 * Separate from the decision so the decision stays a pure function, and phrased as a defect rather
 * than as housekeeping: reaching this means something upstream called a tunnel a local channel, and
 * the only reason the panel did not appear inside somebody else's network is a filter that should
 * never have been needed.
 */
export function refusalSummary(refused: ClassifiedInterface[]): string {
  const names = refused
    .map((entry) => `${entry.name} (${entry.class}: ${entry.why})`)
    .join(", ");
  return (
    `the management surface was about to bind ${refused.length} interface(s) that are not local ` +
    `channels, and they were refused: ${names}. This is a defect upstream of the refusal, not a ` +
    `routine exclusion — the panel must never be reachable from inside a tunnel.`
  );
}

/**
 * Classify, then decide, in one place that a test can reach.
 *
 * The two halves are separately correct and separately tested, and the defect this whole module
 * exists for lived in neither of them — it lived in the join, where a list was assembled from a
 * source that could not contain the wire. So the join is a function rather than a few lines inside
 * the daemon's start-up, where nothing can call it.
 *
 * The caller does the I/O and hands over the answers, including the two that are allowed to be
 * absent. `radios: null` means nobody could ask the driver, which is not the same as a device with
 * no radios: the classifier then refuses to guess which `ether` links are wires.
 */
export function localChannelsFor(input: {
  links: NetLink[];
  /** Interface names the driver reports as radios, or `null` when the question could not be asked. */
  radios: string[] | null;
  managementSurfaces: ManagementSurfaces | null;
  /**
   * Interface names the active profile's own tunnels create.
   *
   * Taken as its own argument rather than read off `managementSurfaces.tunnels`, because the caller
   * is the one that knows whether the record it holds is current. A reader that helped itself to the
   * field would silently use a stale list on any path where the record had not been refreshed, and
   * the failure would be a tunnel that is no longer recognised as one — the quietest possible way for
   * this to go wrong.
   */
  profileTunnelInterfaces: string[];
  onUplinkNetwork: boolean;
  /*
   * The classified list comes back with the decision, rather than the caller classifying a second
   * time to report it. Two calls would be two readings taken a moment apart, and the report would
   * occasionally describe a device that never existed — the interface list can change between them.
   */
}): BindDecision & { classified: ClassifiedInterface[] } {
  const classified = classifyInterfaces({
    links: input.links,
    managementSurfaces: input.managementSurfaces,
    tunnelInterfaces: input.profileTunnelInterfaces,
    wirelessInterfaces: input.radios,
  });

  return {
    classified,
    ...decideManagementInterfaces({
      classified,
      onUplinkNetwork: input.onUplinkNetwork,
      /*
       * Both sources, united: what the kernel's link shape says, and what the profile says it created.
       *
       * **Neither term is load-bearing on today's inputs, and that is stated rather than implied.**
       * Measured by mutation on 2026-09-21, against every case in `test/bind-policy.test.ts`: delete
       * the first term and the suite stays green; delete the second and it stays green. They are the
       * only two survivors in the file, and they survive *each other*.
       *
       * The second is covered because the profile's list also reaches the classifier above, which marks
       * every name in it `tunnel` before it considers the local classes — so those names are already in
       * the first term. The first is covered because a `tunnel` verdict makes the positive half skip the
       * interface outright, so the gate is never asked about it. No input can make the classifier
       * disagree with a list it was handed, which is why no case here can force either term to fire.
       *
       * Both are kept, because each costs one spread and each guards a different change rather than a
       * different input. Move the classifier's `ours` check below its access-point or radio checks and a
       * tunnel the plan named starts classifying as a local channel — then the second term is the only
       * thing left. Widen `ALWAYS_LOCAL` and the first term is.
       *
       * Recorded as uncovered instead of being counted as coverage. `refuseNonLocal` is exported and
       * tested directly for the same reason: where a guard cannot be reached through its caller, the
       * honest answer is either a way to reach it or a note saying it is not reached — never a test that
       * passes because nothing arrives.
       */
      tunnelInterfaces: [
        ...classified
          .filter((entry) => entry.class === "tunnel")
          .map((entry) => entry.name),
        ...input.profileTunnelInterfaces,
      ],
    }),
  };
}

/**
 * Whether a newly resolved record differs from the stored one.
 *
 * Here, next to the code that reads the record, and not beside the code that writes it. That is the
 * point rather than a filing decision: `tunnels` was added to the record and to the reader, and the
 * writer's "has it changed?" check was left comparing the other two fields. It typechecked, every
 * test passed, and the effect would have been a plan whose tunnel names changed never being written
 * — so the reader would have gone on using names from an earlier profile, which for this field means
 * a tunnel the refusal no longer recognises. Whoever next adds a member now has both halves on one
 * screen.
 *
 * A predicate that does not know about a field answers "unchanged" with complete confidence, which
 * is the worst answer a predicate can give: there is no failure to notice.
 */
export function managementSurfacesChanged(
  stored: ManagementSurfaces | null,
  resolved: ManagementSurfaces,
): boolean {
  if (stored === null) return true;
  const sameList = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((name, index) => name === b[index]);
  return (
    stored.accessPoint !== resolved.accessPoint ||
    !sameList(stored.uplinks, resolved.uplinks) ||
    !sameList(stored.tunnels, resolved.tunnels)
  );
}

/* ── reporting the decision, not just acting on it ─────────────────────────────────────── */

/** One interface as the management view describes it. */
export interface ChannelReport {
  interface: string;
  class: ChannelClass;
  /** Every address the kernel reports for it, whether or not anything is listening on one. */
  addresses: string[];
  /**
   * Whether the daemon is actually answering on one of those addresses.
   *
   * Its own field, and the whole reason this report exists rather than a list of names. Measured on
   * the bench board, 2026-09-21: `end0` was named in the configuration and bound to nothing, and a
   * view that draws a list of chosen names had no way to show that — "named and silent" rendered
   * identically to "working". A screen that cannot express a defect reports that there is none.
   */
  listening: boolean;
}

/** An interface that was not bound, with the classifier's own words for why. */
export interface ChannelExclusion {
  interface: string;
  class: ChannelClass;
  /**
   * The reason, as a sentence a person can act on.
   *
   * This is the classifier's `why` verbatim, not a code and not an enumeration. It is read by
   * somebody whose panel did not open, and "kind=wireguard" tells them what happened where
   * `TUNNEL_EXCLUDED` tells them only that we have a constant for it.
   */
  reason: string;
}

export interface ManagementChannels {
  channels: ChannelReport[];
  /** Refused by the final gate. Never routine: see `refusalSummary`. */
  refused: ChannelExclusion[];
  /** Local channels deliberately left out, today only the uplink when the operator turns it off. */
  withheld: ChannelExclusion[];
}

/**
 * Turn a decision into something a person can be shown.
 *
 * ## Why this exists at all
 *
 * `BindDecision.refused` and `.withheld` were computed here and died here. Nothing carried them to
 * the wire, and `GET /api/system` reported `listen` as a port, a list of addresses and the
 * unresolved names — so the one screen on which a refusal could have appeared was structurally
 * incapable of mentioning one. A refusal means the positive half offered a tunnel, which is a defect
 * upstream rather than a lucky save; a screen that is empty where a refusal belongs says quietly
 * that there were none.
 *
 * That is the same shape this module was written to remove, one level up: a guarantee that held
 * because control never reached it, now a report that was true because nothing could read it.
 *
 * ## Why the device classifies and the browser does not
 *
 * The class travels on the wire rather than being derived by whoever draws it. Linux reports `ether`
 * for a radio exactly as it does for a wire — measured, and the reason `radios` is an input to the
 * classifier at all — so a client deciding classes would be a second source of truth about the one
 * question this module exists to answer once.
 *
 * `listening` is computed from the addresses the daemon reports as bound, not from membership of
 * `decision.bind`. Being chosen and being bound are different facts, and it is exactly their
 * difference that went unseen on the board.
 */
export function managementChannels(input: {
  classified: ClassifiedInterface[];
  decision: BindDecision;
  /** Every address the kernel reports, as the platform layer read them. */
  addresses: { name: string; address: string; family: string }[];
  /** Addresses the daemon is answering on right now. */
  boundAddresses: string[];
}): ManagementChannels {
  const bound = new Set(input.boundAddresses);
  const addressesFor = (name: string): string[] =>
    input.addresses
      .filter((entry) => entry.name === name)
      .map((entry) => entry.address);

  const channels = input.classified.map((entry) => {
    const addresses = addressesFor(entry.name);
    return {
      interface: entry.name,
      class: entry.class,
      addresses,
      // Chosen is not bound. An interface the policy picked whose address never came up, or whose
      // bind failed, is reported as silent rather than omitted or assumed.
      listening: addresses.some((address) => bound.has(address)),
    };
  });

  const exclusion = (entry: ClassifiedInterface): ChannelExclusion => ({
    interface: entry.name,
    class: entry.class,
    reason: entry.why,
  });

  return {
    channels,
    refused: input.decision.refused.map(exclusion),
    withheld: input.decision.withheld.map(exclusion),
  };
}
