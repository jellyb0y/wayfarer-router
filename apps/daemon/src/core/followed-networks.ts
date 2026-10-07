/**
 * Followed networks: the subnets a tunnel's peer hands one of our tunnel interfaces, which the core's
 * exclusion list (the fence) must carry.
 *
 * ## What went wrong, measured on the bench board, 2026-09-22 to 23
 *
 * The `corp` tunnel was down from at least 22:15 until 07:32:27, when its peer answered and pushed
 * `ifconfig 10.122.0.2 255.255.255.0`. `/etc/wayfarer/fence.json` and the core's `route_exclude_address`
 * had been written around 23:00, while `corp` was down, and listed only the networks of `wfvpnhq` and
 * `wfvpnprt`. From 07:32 `wfvpncrp` held `10.122.0.0/24` and **nothing re-derived**: the drift check
 * correctly read the device `diverged` and would have stayed red until somebody applied. The fence had
 * moved once in the night only because a resolver changed at the same moment and the resolver
 * follower's re-derive swept the fence along with it. A tunnel coming up with a network while its
 * resolver stays the same woke nothing.
 *
 * ## Add promptly, remove lazily
 *
 * A network appearing on a tunnel interface that the running fence does not hold is worth a core
 * restart, and the follower (`core/resolver-follower.ts`) makes it. A network **leaving** is not: a
 * followed network left in the fence after its tunnel went down excludes a subnet nothing is using,
 * which harms nothing, while removing it would cost a restart — which interrupts every connection
 * through the core, the session this device is managed over included — **on every flap**. `corp`
 * failed its handshake every six minutes for nine hours; the hq peer has handed out `10.164.96.0/20`,
 * then `10.165.0.0/20`, then the first again, between connects.
 *
 * So a network the running fence records as followed (`fence.json`) is **retained** by the planner while
 * it is absent from the interfaces, and it leaves only when the core configuration is being rewritten
 * for another reason anyway (`core/pipeline.ts`, `planDocument`). The alternative — remove after a long
 * settle — lost for two reasons: it needs a clock and a memory of when each network went absent, which
 * is state the planner does not have and a restart would lose; and whatever the settle, a peer that
 * alternates between two subnets more slowly than it pays one restart per alternation for ever, where
 * retaining pays once per distinct network.
 *
 * Retaining is bounded by what it retains: only networks the running fence itself recorded as followed,
 * only while the interface they were read from is still one of this plan's tunnel interfaces, and never
 * one that is on an interface now (which is then read, and classified, like any other).
 */

export interface FollowedEntry {
  network: string;
  interface: string;
}

/**
 * The fence record's entries — the followed networks and the interface each was read from — or
 * `undefined` when there is no readable record. Unreadable and absent are one answer: nothing is known.
 */
export function readFenceRecordEntries(content: string | null | undefined): FollowedEntry[] | undefined {
  if (content === null || content === undefined) return undefined;
  try {
    const parsed = JSON.parse(content) as { followed?: unknown };
    if (!Array.isArray(parsed.followed)) return undefined;
    return parsed.followed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const network = (entry as { network?: unknown }).network;
      const name = (entry as { interface?: unknown }).interface;
      return typeof network === 'string' && typeof name === 'string' ? [{ network, interface: name }] : [];
    });
  } catch {
    return undefined;
  }
}

/**
 * The network reading the planner builds the fence from, with the running fence's recorded followed
 * networks added back where they are merely absent. See the note at the top for the rule and its bounds.
 *
 * A retained entry keeps the interface it was recorded from, so the planner's own split (a network read
 * from a tunnel interface is followed) classifies it exactly as it did when it was written.
 */
export function withRetainedFollowed(
  reading: { interface: string; cidr: string }[],
  tunnelInterfaces: readonly string[],
  retained: readonly FollowedEntry[] | undefined,
): { interface: string; cidr: string }[] {
  if (retained === undefined || retained.length === 0) return reading;
  const tunnels = new Set(tunnelInterfaces);
  const present = new Set(reading.map((entry) => entry.cidr));
  const added: { interface: string; cidr: string }[] = [];
  for (const entry of retained) {
    if (!tunnels.has(entry.interface) || present.has(entry.network)) continue;
    present.add(entry.network);
    added.push({ interface: entry.interface, cidr: entry.network });
  }
  return added.length === 0 ? reading : [...reading, ...added];
}

/**
 * The fence as the core's configuration on disk holds it: every address in every inbound's
 * `route_exclude_address`. `null` for a file that cannot be read or parsed — which is not an empty fence.
 */
export function fenceInCoreConfig(text: string | null): Set<string> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const inbounds = (parsed as { inbounds?: unknown } | null)?.inbounds;
  if (!Array.isArray(inbounds)) return null;
  const fence = new Set<string>();
  for (const inbound of inbounds as unknown[]) {
    const list = (inbound as { route_exclude_address?: unknown } | null)?.route_exclude_address;
    if (!Array.isArray(list)) continue;
    for (const entry of list) if (typeof entry === 'string') fence.add(entry);
  }
  return fence;
}

export interface FollowedNetworkReading {
  /** Whether the core's configuration could be read and parsed at all. */
  readable: boolean;
  /** The followed networks on the tunnel interfaces right now. */
  followed: FollowedEntry[];
  /** Followed now and not in the running fence: what the follower re-derives for. */
  missing: FollowedEntry[];
  /** In the running fence's record as followed and on no interface now: retained, and not a divergence. */
  retained: string[];
}

/**
 * The follower's question about networks: is every network a peer has handed one of our tunnel
 * interfaces in the fence the core is running with?
 *
 * The inputs are the planner's own — the interface reading `collectFacts` gives it (`interfaceNetworks`)
 * and the tunnel interfaces the last plan recorded — and the rule is the planner's split: a network read
 * from a tunnel interface is followed. Only **missing** networks are a divergence; a retained one is the
 * fence doing what this module argues it should.
 *
 * A configuration that cannot be read makes every followed network missing: an unreadable file is not
 * evidence that the network is there.
 */
export function followedNetworkDivergence(input: {
  networks: { interface: string; cidr: string }[];
  tunnelInterfaces: readonly string[];
  coreConfig: string | null;
  fenceRecord: string | null;
}): FollowedNetworkReading {
  const tunnels = new Set(input.tunnelInterfaces);
  const followed = input.networks
    .filter((entry) => tunnels.has(entry.interface))
    .map((entry) => ({ network: entry.cidr, interface: entry.interface }));
  const fence = fenceInCoreConfig(input.coreConfig);
  const now = new Set(input.networks.map((entry) => entry.cidr));
  const retained = (readFenceRecordEntries(input.fenceRecord) ?? [])
    .filter((entry) => !now.has(entry.network) && (fence?.has(entry.network) ?? false))
    .map((entry) => entry.network);
  return {
    readable: fence !== null,
    followed,
    missing: followed.filter((entry) => !(fence?.has(entry.network) ?? false)),
    retained,
  };
}
