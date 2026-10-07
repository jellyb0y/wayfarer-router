/**
 * Safe mode: what a device does when applying its own configuration keeps failing.
 *
 * ## Why the count is derived and not stored
 *
 * A stored counter is a second description of something the transaction history already records, and a
 * second description drifts — it has to be incremented in every failure path and reset in every success
 * path, and the day somebody adds a third path the counter is wrong in a direction nobody notices.
 *
 * So the count is **read from the transactions**: consecutive non-successes for this profile, newest
 * first, stopping at the first committed one. Two behaviours then come for free rather than needing
 * their own code:
 *
 * * **it resets on a success**, because a committed transaction ends the walk; and
 * * **it resets on an edit**, because only transactions newer than the profile's `updatedAt` are
 *   counted — an operator who has changed something is trying something new, and holding their
 *   previous three attempts against them would drop a device into safe mode for a configuration it has
 *   not been asked to apply yet.
 *
 * ## What safe mode is for
 *
 * Reaching the device. Not running it correctly, not carrying traffic — being reachable by the person
 * who has to fix it. Everything below follows from that single purpose, and the things it switches off
 * are exactly the things that can deny access.
 */

import type { ProfileDocument } from '@wayfarer/schemas';

/**
 * How many consecutive failures put a device into safe mode.
 *
 * Three rather than one: a single failure is ordinary — a typo in a field, a radio that was busy, an
 * upstream that was down — and dropping to safe mode on it would be a device that panics. Three of the
 * same thing in a row is a configuration this device cannot apply, and the operator has by then seen
 * three failures and is being told something they already suspect.
 */
export const SAFE_MODE_THRESHOLD = 3;

export interface ApplyAttempt {
  /** ISO timestamp. Recorded and displayed; deliberately **not** used to decide anything here. */
  at: string;
  /**
   * The profile revision this attempt was an attempt at, or `null` for a row that predates the column.
   *
   * This is what separates attempts against the current configuration from attempts against one the
   * operator has since changed. It replaces a comparison of the attempt's wall-clock timestamp against
   * the profile's `updatedAt`: two instants written at different moments on a device with no clock
   * battery, whose clock is stepped by the `systemd-timesyncd` restart the apply itself performs. A
   * backward step made every attempt look older than the edit, so the run ended at the first row, the
   * count was always zero, and the device could not enter safe mode however many applies failed.
   *
   * "Which configuration was this about" is a question about identity, and a counter answers it without
   * reference to any clock.
   */
  profileRevision?: number | null;
  /** The transaction's final state. */
  state: string;
  /**
   * Why it ended that way, as recorded on the row.
   *
   * Read, not ignored. The reason is the only thing that distinguishes a revert the device performed
   * because something went wrong from one the operator asked for — and without it the count is answering
   * the wrong question. See `REVERT_REASONS`.
   */
  reason?: string | null;
}

/**
 * Reasons a revert can carry, as one definition shared by whoever writes them and whoever reads them.
 *
 * String matching across a module boundary is exactly the copy-of-a-truth shape this project keeps
 * meeting, so the strings live here and both sides import them.
 */
export const REVERT_REASONS = {
  /** An operator pressed the button. A change of mind, not a failure. */
  operatorRequested: 'the operator asked for it to be reverted',
} as const;

/** States in which the device did not end up running what it was asked to run. */
const UNSUCCESSFUL_STATES = new Set(['failed', 'reverted', 'reverting']);

/**
 * Whether one attempt is evidence that this configuration **cannot be applied**.
 *
 * The distinction the count depends on, and getting it wrong has now cost twice — both times from
 * asking *"did this end in a revert"* instead of *"did this fail"*:
 *
 * * a plan refused before anything was attempted was counted, so a typo in a form walked a device
 *   towards rescue; and
 * * a revert **the operator asked for** was counted, so three deliberate changes of mind on a healthy
 *   device switched its tunnels off.
 *
 * A revert is a mechanism, not a verdict. It runs when a change failed *and* when somebody decided
 * against it, and only the reason tells those apart.
 */
export function isFailureEvidence(attempt: ApplyAttempt): boolean {
  if (!UNSUCCESSFUL_STATES.has(attempt.state)) return false;
  // A prefix, not equality: a revert records the window's health finding after its own cause
  // (`revertTransaction`), so an operator's revert of a change the check had doubts about reads
  // "the operator asked for it to be reverted. During the window the health check had found: …". It
  // is still a change of mind, and equality would have counted it towards rescue.
  if (attempt.reason?.startsWith(REVERT_REASONS.operatorRequested) === true) return false;
  return true;
}

export interface SafeModeDecision {
  /** Consecutive failures counted, after the resets above are applied. */
  failures: number;
  enter: boolean;
  reason: string | null;
}

/**
 * Whether this device should drop into safe mode, from its own recent history.
 *
 * `attempts` is newest first **by insertion order**, not by timestamp — a run ordered by a clock that
 * can step backwards is not a run. `profileRevision` is the identity of the configuration in force;
 * attempts stamped with a different one describe something the operator has since changed.
 */
export function safeModeDecision(input: {
  attempts: readonly ApplyAttempt[];
  /**
   * The revision of the profile as it stands now. Attempts stamped with any other revision describe a
   * configuration that is no longer in force.
   */
  profileRevision: number;
  threshold?: number;
}): SafeModeDecision {
  const threshold = input.threshold ?? SAFE_MODE_THRESHOLD;
  let failures = 0;

  for (const attempt of input.attempts) {
    /*
     * Anything that is not evidence of failure **ends the run**, not merely skipped.
     *
     * A success ends it because the device has proved it can apply something. An operator-requested
     * revert ends it for a different reason that matters just as much: somebody was present and made a
     * decision, so whatever came before is no longer an unattended pattern of a device failing by
     * itself — which is the only thing safe mode should react to.
     */
    if (!isFailureEvidence(attempt)) break;
    /*
     * An attempt against a different configuration is not evidence about this one, and that is decided
     * by revision rather than by time. A `null` revision is a row written before the column existed: it
     * makes no claim about which configuration it applied, so it cannot be counted towards this one and
     * ends the run — the cautious direction, which delays safe mode rather than entering it on evidence
     * that may belong to something else.
     */
    if (attempt.profileRevision !== input.profileRevision) break;
    failures += 1;
  }

  return {
    failures,
    enter: failures >= threshold,
    reason:
      failures >= threshold
        ? `${failures} consecutive applies of this profile failed, so the device has stopped trying to ` +
          'run it and has kept only what is needed to reach it'
        : null,
  };
}

/**
 * The document a device runs in safe mode, derived from the one it could not apply.
 *
 * **Derived rather than replaced**, and that is the whole design. A fresh minimal profile would also be
 * safe, and it would change the network name and address range the operator's own devices know — so the
 * person arriving to fix a device would first have to work out how to reach it. Safe mode keeps
 * everything that makes the device findable and removes only what can make it unreachable.
 *
 * Kept:
 *
 * * **the access point**, with its own name and passphrase, so the phone that knew this network still
 *   knows it;
 * * **the local network** — the same address range and DHCP pool, so a device with a lease keeps it;
 * * **the management listener**, untouched: it is the thing being reached.
 *
 * Removed:
 *
 * * **every tunnel**, because a tunnel is the most likely thing to be denying access — it captures
 *   routes, and a captured route to the management network is the failure this project has met most
 *   often;
 * * **the kill-switch**, because its entire purpose is to stop traffic when the tunnel is not up, and
 *   in safe mode the tunnel is deliberately not up. Leaving it on would produce a device that is
 *   reachable and can do nothing, which reads to the operator as still broken.
 *
 * Nothing else is altered. In particular the profile is **not saved over**: safe mode is a document the
 * device runs, and the operator's configuration stays exactly as they left it so they can correct the
 * two fields that were wrong rather than rebuild it.
 */
export function buildSafeModeDocument(current: ProfileDocument): ProfileDocument {
  return {
    ...current,
    // Disabled rather than deleted: the operator's definitions survive, and leaving safe mode is
    // re-enabling them rather than re-entering them.
    tunnels: current.tunnels.map((tunnel) => ({ ...tunnel, enabled: false })),
    firewall: { ...current.firewall, killSwitch: false },
  };
}

/**
 * Whether `running` **is** the safe-mode derivation of `stored`.
 *
 * A definite comparison, not a shape inference, and the difference is not academic. The first version
 * asked whether a document *looked like* safe mode — no enabled tunnel, no kill-switch, an access point
 * — and that is true of any perfectly ordinary profile with no tunnels configured, which is what a new
 * device has. Measured on the bench board, 2026-09-20: the guard against entering safe mode twice
 * therefore matched on the very first evaluation and **blocked safe mode from ever being entered at
 * all**. Four consecutive reverted applies, the count correct at four, and nothing happened.
 *
 * Comparing against the derivation cannot make that mistake: it asks "is what we are running exactly
 * what safe mode would produce from what is stored", which is false while there is anything to do and
 * true once there is not. And when a profile has nothing to disable, "already in safe mode" and
 * "entering safe mode changes nothing" are the same statement, so agreeing with it is correct.
 */
export function isSafeModeOf(running: ProfileDocument, stored: ProfileDocument): boolean {
  return JSON.stringify(buildSafeModeDocument(stored)) === JSON.stringify(running);
}

/**
 * What to *tell* somebody about safe mode, which is not the same question as whether to enter it.
 *
 * `isSafeModeOf` is true whenever the running document equals the safe-mode derivation of the stored
 * one — including when the profile has nothing safe mode would turn off, where it is true trivially.
 * That is the right answer for the guard (there is nothing to do) and the wrong thing to show an
 * operator: a healthy device with no tunnels configured would report "in safe mode", and somebody would
 * go looking for a fault that is not there.
 *
 * Measured on the bench board, 2026-09-21: exactly that happened after a profile was restored to a
 * working state with no tunnels and the kill-switch off.
 */
export type SafeModeState = 'in-safe-mode' | 'nothing-to-disable' | 'normal';

export function safeModeState(running: ProfileDocument | null, stored: ProfileDocument): SafeModeState {
  // Nothing to disable: the derivation is the profile itself, so the two cannot be told apart and there
  // would be nothing to report even if they could.
  if (JSON.stringify(buildSafeModeDocument(stored)) === JSON.stringify(stored)) return 'nothing-to-disable';
  if (running !== null && isSafeModeOf(running, stored)) return 'in-safe-mode';
  return 'normal';
}
