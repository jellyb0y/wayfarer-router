/**
 * When a session or a token stops being usable, on a device whose clock cannot be trusted.
 *
 * Pure, and separate from the store, because the decisions here are the ones worth arguing about and
 * they should be readable without SQL around them.
 *
 * ## The frame problem, again
 *
 * A credential's lifetime used to be an absolute wall-clock instant compared against a later wall-clock
 * reading. This board has no clock battery, and — worse — the apply that opens a confirmation window
 * deliberately restarts `systemd-timesyncd`, so a step of days *inside that window* is the designed
 * path. A forward step retired every session minted before the resync, logging the operator out at the
 * one moment they must not be logged out.
 *
 * So the primary rule is a **duration since last use**, anchored to a pair that is both durable and
 * immune to any wall-clock step: **the boot identity plus the board's uptime.** Within one boot,
 * uptimes are comparable and monotonic. Across boots the anchor is meaningless, and that case is
 * handled by saying so rather than by guessing.
 *
 * ## Which way each decision fails, and why they differ
 *
 * Two rules in this codebase treat "I cannot tell" in opposite directions, and it looks inconsistent
 * until the cost of each mistake is named.
 *
 * * A **certificate** whose validity cannot be checked is treated as untrusted. Wrongly trusting one
 *   exposes the operator's traffic to a stranger.
 * * A **credential** whose expiry cannot be checked is reported as *unverifiable* and left usable, and
 *   the reason is logged. Wrongly expiring one locks the owner out of their own device — possibly in a
 *   hotel room, with the management surface on the device's own access point and no other way in.
 *
 * Fail towards the smaller loss in each case. That is the rule; "always fail closed" is not.
 */

/** The pair that makes a duration durable and step-proof. Read together or not at all. */
export interface MonotonicStamp {
  /** Identity of the current boot. Rows stamped with another one have an unknown age. */
  bootId: string;
  /** Seconds since that boot, from `/proc/uptime`. */
  uptimeSeconds: number;
}

/**
 * Reads the boot identity and the uptime together, because they are only meaningful together.
 *
 * One implementation, used by the request path and by the session sweep. They were about to be two, and two
 * readers of one quantity is how the sweep came to disagree with the request path in the first place.
 *
 * `null` when either part is unavailable: an uptime without a boot identity cannot be compared with a
 * stored one, and a boot identity without an uptime yields no duration. A caller that gets `null` must
 * treat every credential as *unverifiable*, never as stale.
 */
export async function readStamp(readers: {
  bootId: () => Promise<string | null>;
  uptimeSeconds: () => Promise<number | null>;
}): Promise<MonotonicStamp | null> {
  const [bootId, uptimeSeconds] = await Promise.all([
    readers.bootId().catch(() => null),
    readers.uptimeSeconds().catch(() => null),
  ]);
  if (bootId === null || uptimeSeconds === null) return null;
  return { bootId, uptimeSeconds };
}

export type CredentialVerdict =
  /** Usable. `reanchor` asks the caller to re-stamp it, because its anchor is from another boot. */
  | { kind: 'valid'; reanchor: boolean }
  | { kind: 'expired'; reason: string }
  /**
   * Usable, but its expiry could not be checked. Distinct from `valid` so the caller can say so in a
   * log line: a credential outliving its stated life is worth a record even when honouring it is right.
   */
  | { kind: 'unverifiable'; reason: string };

/**
 * A session is valid while it is being used.
 *
 * `idleLimitSeconds` is a duration since last use, not a lifetime from creation: an operator who has
 * been working for a week has not become less authorised, and one who signed in and walked away has.
 */
export function sessionVerdict(input: {
  anchor: { bootId: string | null; lastSeenUptimeSeconds: number | null };
  stamp: MonotonicStamp | null;
  idleLimitSeconds: number;
  /**
   * True only while a transaction opened by *this* session is awaiting confirmation.
   *
   * The narrow exemption, and the product rule behind everything else here: the single moment an
   * operator must not lose their credentials is while a timer is counting down on a change only they
   * can confirm. Losing the session then means the change reverts for want of a click nobody could
   * make — and because the time service restarts inside that window, this is the designed path rather
   * than bad luck.
   */
  holdsOpenWindow: boolean;
}): CredentialVerdict {
  if (input.holdsOpenWindow) return { kind: 'valid', reanchor: false };

  if (input.stamp === null) {
    return { kind: 'unverifiable', reason: 'the board’s uptime could not be read, so no age can be computed' };
  }
  if (input.anchor.bootId === null || input.anchor.lastSeenUptimeSeconds === null) {
    // A row written before the anchor existed. Its age is unknown, so it is re-stamped on this use
    // rather than retired — the same trade as a row from another boot.
    return { kind: 'valid', reanchor: true };
  }
  if (input.anchor.bootId !== input.stamp.bootId) {
    return { kind: 'valid', reanchor: true };
  }

  const idleSeconds = input.stamp.uptimeSeconds - input.anchor.lastSeenUptimeSeconds;
  // Negative cannot happen within one boot and is treated as "just used" rather than as a huge idle
  // time: the alternative reading of a negative number is "expire immediately", which is the wrong
  // direction for a credential.
  if (idleSeconds > input.idleLimitSeconds) {
    return { kind: 'expired', reason: `unused for ${Math.round(idleSeconds)}s` };
  }
  return { kind: 'valid', reanchor: false };
}

/**
 * A token with an absolute expiry the operator chose.
 *
 * Unlike a session, this instant is a deliberate statement by whoever issued the token — "stop working
 * after the end of the month" — so it cannot be turned into an idle duration without changing what the
 * operator asked for. It therefore has to be judged against the wall clock, which means it can only be
 * enforced when the wall clock is worth judging against.
 */
export function tokenVerdict(input: {
  expiresAt: string | null;
  now: Date;
  /** From the platform's clock status: `null` means the question could not be answered. */
  clockTrusted: boolean | null;
  holdsOpenWindow: boolean;
}): CredentialVerdict {
  if (input.expiresAt === null) return { kind: 'valid', reanchor: false };
  if (input.holdsOpenWindow) return { kind: 'valid', reanchor: false };

  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(expires)) {
    return { kind: 'unverifiable', reason: 'the stored expiry is not a readable timestamp' };
  }

  if (input.clockTrusted !== true) {
    return {
      kind: 'unverifiable',
      reason:
        input.clockTrusted === null
          ? 'the clock’s synchronisation state could not be read, so an expiry cannot be enforced'
          : 'the clock is not synchronised, so an expiry cannot be enforced',
    };
  }

  return expires <= input.now.getTime()
    ? { kind: 'expired', reason: `expired at ${input.expiresAt}` }
    : { kind: 'valid', reanchor: false };
}

/**
 * Whether a failed login counts towards a lockout.
 *
 * Only attempts from **this** boot do. Across boots an attempt's age is unknown, and the two ways of
 * resolving that are not symmetric:
 *
 * * Treating undatable rows as recent locks a legitimate operator out of a device whose only management
 *   surface is its own access point — which, on this hardware, may mean no way in at all.
 * * Ignoring them means **a reboot clears an in-progress lockout.** Nobody can reboot this device
 *   without already holding the physical or administrative access that a lockout protects, and the
 *   management surface is not on the open internet.
 *
 * Losing management of the device is the worse outcome, so the second is chosen deliberately. It is a
 * trade, not an oversight, and it is written here so that nobody 'fixes' it later without reading this.
 */
export function attemptCountsTowardsLockout(input: {
  attempt: { bootId: string | null; uptimeSeconds: number | null; succeeded: boolean };
  stamp: MonotonicStamp;
  windowSeconds: number;
}): boolean {
  const { attempt, stamp, windowSeconds } = input;
  if (attempt.succeeded) return false;
  if (attempt.bootId === null || attempt.uptimeSeconds === null) return false;
  if (attempt.bootId !== stamp.bootId) return false;
  return stamp.uptimeSeconds - attempt.uptimeSeconds <= windowSeconds;
}
