/**
 * The health watchdog's decisions, as pure functions.
 *
 * ## Latency alone is not enough, and that is the whole point
 *
 * A channel with a low median and a wide spread is worse to use than a steadier, slower one. Every
 * protocol above it reacts to variance: a retransmission timer sized from a moving average, a video
 * buffer that drains during the long tail, a TLS handshake that stalls on one lost packet. So jitter and
 * loss are **inputs to the decision**, not numbers displayed beside it — a tunnel can fail its health
 * check on jitter while its median latency is the best of the set, and that is the correct answer.
 *
 * ## Why a score and thresholds, rather than one or the other
 *
 * Thresholds answer "is this usable at all", which is what failover needs: a tunnel over its loss limit
 * must be left alone regardless of how fast the answers that arrived were. The score answers "which of
 * the usable ones is best", which is what choosing needs. Collapsing them into one number loses the
 * first question — a weighted sum can always be dragged back over the line by a good median.
 *
 * ## Why stickiness is not hysteresis on the score
 *
 * Switching costs every live connection through the tunnel. So a healthy current choice is kept even when
 * a better one appears, and only a *failing* current choice is replaced. The alternative — switch whenever
 * the score improves — produces a device that migrates between two near-identical tunnels all day,
 * breaking connections each time, in exchange for a few milliseconds nobody asked for.
 */

/** One round of probing, for one tunnel. */
export interface ProbeResult {
  tunnelId: string;
  /**
   * Round-trip times in milliseconds, one per probe that answered.
   *
   * Short by design: the ones that did not answer are counted in `attempted`, not represented here as
   * zeros or as some sentinel. A zero in a latency series is a measurement, and a lost probe is not one.
   */
  latenciesMs: number[];
  /** How many probes were sent. `attempted - latenciesMs.length` were lost. */
  attempted: number;
}

export interface ProbeThresholds {
  maxLatencyMs: number;
  maxJitterMs: number;
  maxLossPercent: number;
}

export interface TunnelHealth {
  tunnelId: string;
  /** The middle value, not the mean: one 4-second outlier should not condemn a steady channel. */
  medianMs: number | null;
  /**
   * Mean absolute deviation from the median, in milliseconds.
   *
   * Not the standard deviation, and not max-minus-min. The standard deviation squares the outliers,
   * which makes one stalled probe dominate a series that was otherwise steady; max-minus-min *is* the
   * outlier and nothing else. What matters to a protocol above the tunnel is how far a typical packet
   * sits from the typical packet, which is what this is.
   */
  jitterMs: number | null;
  lossPercent: number;
  healthy: boolean;
  /** Which thresholds it failed, in words, for the event ring and the interface. */
  failed: string[];
}

export function summarise(result: ProbeResult, thresholds: ProbeThresholds): TunnelHealth {
  const answered = [...result.latenciesMs].sort((a, b) => a - b);
  const attempted = Math.max(result.attempted, answered.length);
  const lost = attempted - answered.length;
  const lossPercent = attempted === 0 ? 100 : Math.round((lost / attempted) * 100);

  const medianMs = answered.length === 0 ? null : median(answered);
  const jitterMs =
    answered.length < 2 || medianMs === null
      ? null
      : answered.reduce((total, value) => total + Math.abs(value - medianMs), 0) / answered.length;

  const failed: string[] = [];
  if (answered.length === 0) {
    failed.push('nothing answered');
  } else {
    if (medianMs !== null && medianMs > thresholds.maxLatencyMs) {
      failed.push(`latency ${Math.round(medianMs)}ms over ${thresholds.maxLatencyMs}ms`);
    }
    /*
     * Jitter is judged even when the median passes. A tunnel answering in 40ms, 900ms, 60ms and 880ms has
     * a median inside any reasonable limit and is unusable, and this is the only line that notices.
     */
    if (jitterMs !== null && jitterMs > thresholds.maxJitterMs) {
      failed.push(`jitter ${Math.round(jitterMs)}ms over ${thresholds.maxJitterMs}ms`);
    }
    if (lossPercent > thresholds.maxLossPercent) {
      failed.push(`loss ${lossPercent}% over ${thresholds.maxLossPercent}%`);
    }
  }

  return { tunnelId: result.tunnelId, medianMs, jitterMs, lossPercent, healthy: failed.length === 0, failed };
}

/* ── availability, which is a different question from quality ────────────────────────────── */

/**
 * Whether a guarded tunnel is carrying traffic **at all**.
 *
 * ## Why this is not `summarise`
 *
 * `summarise` answers *how good is this tunnel compared to the others*, and its thresholds exist to rank
 * interchangeable members of a failover group: over the latency limit means "prefer another one", which is
 * a sensible thing to say when there is another one. A guarded destination tunnel has no other one. Its
 * selector's only members are the tunnel and `block`, so "prefer another one" resolves to *refuse the
 * traffic* — and a latency limit then decides an availability question it was never asked.
 *
 * That is not hypothetical. Measured 2026-09-21: the tunnel `partner` answered through its own outbound, to
 * one of its own resource addresses, in 519 / 528 / 521 / 643 ms against a device-wide `maxLatencyMs` of
 * 500. Every round computed `block`; the state never changed, so after the first one nothing was written
 * either. A working tunnel was cut for hours by a ranking threshold, silently.
 *
 * So the guard asks only what the field's own documentation says it asks — *whether its own traffic may
 * flow*. Answered or did not answer, and loss. **Latency and jitter are recorded and never judged**: a
 * slow tunnel is still a tunnel, and there is nothing to prefer over it.
 */
export interface GuardReachability {
  tunnelId: string;
  /** How many probes came back. */
  answered: number;
  attempted: number;
  lossPercent: number;
  /** The only verdict this function makes. */
  reachable: boolean;
  /** Why not, in words, for the event ring. Empty when reachable. */
  failed: string[];
  /**
   * Median of the answers that arrived. **Reported, never judged.**
   *
   * It is here because an operator looking at a blocked tunnel wants to know whether it was slow as well
   * as whether it answered, and because leaving it out would make the ring entry unfalsifiable. Nothing in
   * this file reads it back.
   */
  medianMs: number | null;
}

export function judgeReachability(result: ProbeResult, maxLossPercent: number): GuardReachability {
  const answered = [...result.latenciesMs].sort((a, b) => a - b);
  const attempted = Math.max(result.attempted, answered.length);
  const lost = attempted - answered.length;
  const lossPercent = attempted === 0 ? 100 : Math.round((lost / attempted) * 100);

  const failed: string[] = [];
  if (answered.length === 0) {
    failed.push('nothing answered through the tunnel');
  } else if (lossPercent > maxLossPercent) {
    /*
     * Loss belongs here and latency does not, and the difference is not a matter of degree. A lost probe
     * is the tunnel failing to carry one request; a slow probe is the tunnel carrying it. Only the first
     * is evidence about whether traffic may flow.
     */
    failed.push(`${lossPercent}% of probes lost, over the ${maxLossPercent}% limit`);
  }

  return {
    tunnelId: result.tunnelId,
    answered: answered.length,
    attempted,
    lossPercent,
    reachable: failed.length === 0,
    failed,
    medianMs: answered.length === 0 ? null : median(answered),
  };
}

/**
 * How good a *usable* tunnel is, lower being better. Only ever compared between healthy tunnels.
 *
 * Jitter is weighted equal to latency and loss far heavier than either, which is a claim about what
 * degrades a connection rather than a tuning knob: 100 ms of median and 100 ms of swing are about equally
 * unpleasant, while 10% loss ruins a channel that is otherwise perfect. The weights are stated here so
 * that an argument about them is an argument about this sentence.
 */
export function score(health: TunnelHealth): number {
  if (!health.healthy || health.medianMs === null) return Number.POSITIVE_INFINITY;
  return health.medianMs + (health.jitterMs ?? 0) + health.lossPercent * 20;
}

export interface SelectionInput {
  /** Tunnel ids in the operator's preference order. Their order is honoured over any measurement. */
  priority: string[];
  /** Ids kept out of the failover group without being deleted. */
  excluded: string[];
  health: TunnelHealth[];
  /** What the core currently has selected, if anything. */
  current: string | null;
  sticky: boolean;
  /** What unmatched traffic does when nothing is healthy. */
  onAllDown: 'block' | 'direct';
  /** Consecutive rounds each tunnel has failed, so a single bad round does not move anything. */
  failStreaks: Record<string, number>;
  /** How many consecutive failures are needed before a healthy-looking choice is abandoned. */
  failStreak: number;
}

export interface SelectionDecision {
  /** What the selector should be set to: a tunnel id, or the fallback for "nothing is healthy". */
  select: string;
  /** True when this differs from `current` and the core must be told. */
  change: boolean;
  reason: string;
  /** Considered in the order they were considered, for the event ring. */
  considered: { tunnelId: string; healthy: boolean; score: number; excluded: boolean }[];
}

/**
 * Which tunnel unmatched traffic should use.
 *
 * **Priority order is the operator's and beats every measurement.** The list is a statement about which
 * exit they want traffic to leave by — a jurisdiction, a paid line, a corporate route — and a watchdog
 * that reordered it because a lower choice measured 8 ms faster would be substituting its own judgement
 * for theirs on a question measurement cannot answer. So the choice is *the first healthy tunnel in their
 * order*, and the score only breaks ties among tunnels they did not rank.
 */
export function decideSelection(input: SelectionInput): SelectionDecision {
  const excluded = new Set(input.excluded);
  const byId = new Map(input.health.map((entry) => [entry.tunnelId, entry]));

  const considered = input.health.map((entry) => ({
    tunnelId: entry.tunnelId,
    healthy: entry.healthy,
    score: score(entry),
    excluded: excluded.has(entry.tunnelId),
  }));

  const usable = (id: string): boolean => !excluded.has(id) && byId.get(id)?.healthy === true;

  /**
   * Whether the thing currently selected is one of the tunnels being measured.
   *
   * The guard below only makes sense for something that gets probed, and leaving that implicit was a
   * defect that made the fallback a **one-way door**. `block` and `direct` are not tunnels and are never
   * probed, so `block` was never "healthy" and its fail streak never advanced past zero — and with
   * `failStreak` at 2 the watchdog reported, every round, "the current choice failed 0 round(s); 2 in a
   * row are needed before switching" and stayed on `block` with a perfectly healthy tunnel sitting
   * beside it. A device that fell back, or that started up before any tunnel was healthy, would never
   * have recovered on its own. Observed on the bench board, 2026-09-21.
   *
   * It covers a second case for the same reason: a tunnel removed from the profile while it was selected
   * is also absent from the measurements, and must not hold the selection either.
   */
  const currentIsMeasured = input.current !== null && byId.has(input.current);

  /*
   * Stay where we are while it is working, and while it has not failed enough times in a row.
   *
   * A single failed round is a bad sample: the other end was busy, a DNS answer was slow, a packet was
   * dropped. Switching on one of those breaks every live connection through the tunnel to escape
   * something that has already passed. `failStreak` is how many consecutive rounds it takes to believe it.
   *
   * Applies **only to a measured candidate** — see `currentIsMeasured`. Protecting a choice that is not
   * being measured is not caution, it is a latch.
   */
  if (input.sticky && currentIsMeasured && input.current !== null && !excluded.has(input.current)) {
    const currentHealth = byId.get(input.current);
    const streak = input.failStreaks[input.current] ?? 0;
    if (currentHealth?.healthy === true) {
      return { select: input.current, change: false, reason: 'the current choice is healthy', considered };
    }
    if (streak < input.failStreak) {
      return {
        select: input.current,
        change: false,
        reason: `the current choice failed ${streak} round(s); ${input.failStreak} in a row are needed before switching`,
        considered,
      };
    }
  }

  // The operator's order first, and only theirs.
  const ranked = input.priority.find((id) => usable(id));
  if (ranked !== undefined) {
    return {
      select: ranked,
      change: ranked !== input.current,
      reason: `first healthy tunnel in the configured order${input.current === null ? '' : `, replacing ${input.current}`}`,
      considered,
    };
  }

  // Then anything healthy they did not rank, best score first. Score decides only here.
  const unranked = considered
    .filter((entry) => entry.healthy && !entry.excluded && !input.priority.includes(entry.tunnelId))
    .sort((a, b) => a.score - b.score)[0];
  if (unranked !== undefined) {
    return {
      select: unranked.tunnelId,
      change: unranked.tunnelId !== input.current,
      reason: 'no tunnel in the configured order is healthy; chose the best of the rest by latency, jitter and loss',
      considered,
    };
  }

  return {
    select: input.onAllDown,
    change: input.onAllDown !== input.current,
    reason:
      input.onAllDown === 'block'
        ? 'nothing is healthy, and this profile blocks rather than leaking traffic outside the tunnel'
        : 'nothing is healthy, and this profile is configured to send traffic direct rather than block it',
    considered,
  };
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
