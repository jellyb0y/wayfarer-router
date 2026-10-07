/**
 * The transaction state machine, and the rules about the confirmation window.
 *
 * **Pure.** No database, no clock of its own, no systemd. Every function here takes what it needs and
 * returns a decision, so the awkward cases — a deadline that has already passed, a second apply
 * arriving mid-window, an illegal transition — are reachable from a test without a board or a
 * database.
 *
 * ## Why a declared machine rather than a string column
 *
 * The seven states were written into the schema during the previous slice with only four of them
 * reachable, so that the API contract would not change shape when the rest arrived. A declared
 * machine that nothing enforces is decoration, and the way it fails is specific: a code path writes
 * `committed` over a transaction that was already `reverted`, the row now says the change stuck, and
 * the device disagrees with its own history. So every transition goes through `assertTransition`, and
 * an illegal one throws rather than being written.
 *
 * ## What the window is for, stated once
 *
 * A `network` change can cost the operator their access. The machinery that makes that survivable is
 * three separate things, and none of them is sufficient alone:
 *
 * 1. a **deadline** recorded with the transaction, and the previous document stored beside it;
 * 2. a **transient unit outside this process** that runs `way revert` when the deadline passes, so
 *    killing the daemon cannot cancel the recovery;
 * 3. a **sweep at every daemon start** that reverts anything still unconfirmed, which is the only
 *    thing covering power loss inside the window.
 *
 * Confirmation is a human act and never an inference. A change can restore the operator's own path
 * while breaking everyone else's, or bring the access point back while leaving the uplink dead, so a
 * client reconnecting proves nothing. Health checks during the window may therefore **record a
 * finding and never a confirmation** — and never end the window before the deadline it reported; see
 * `windowVerdict`.
 */

import type { BlastRadius } from './differ.ts';

export type TransactionState =
  | 'staged'
  | 'applying'
  | 'awaiting-confirm'
  | 'committed'
  | 'reverting'
  | 'reverted'
  | 'failed';

/**
 * The declared machine, as data.
 *
 * `reverting` is reachable from `failed` as well as from `awaiting-confirm`, and that is deliberate
 * rather than generous: a `network` apply that fails partway through has already touched the network,
 * so it needs the same journey back as one that completed and was never confirmed. A `hot` or
 * `service` failure has nothing to undo and stops at `failed`, which is the caller's choice to make
 * and not this table's.
 */
export const TRANSITIONS: Readonly<Record<TransactionState, readonly TransactionState[]>> = {
  staged: ['applying', 'failed'],
  applying: ['awaiting-confirm', 'committed', 'reverting', 'failed'],
  'awaiting-confirm': ['committed', 'reverting', 'failed'],
  committed: [],
  reverting: ['reverted', 'failed'],
  reverted: [],
  failed: ['reverting'],
};

/** States from which nothing further can happen. Useful for "is this transaction still live?". */
export const TERMINAL: ReadonlySet<TransactionState> = new Set<TransactionState>([
  'committed',
  'reverted',
]);

export class IllegalTransitionError extends Error {
  readonly from: TransactionState;
  readonly to: TransactionState;

  constructor(from: TransactionState, to: TransactionState) {
    super(
      `a transaction cannot go from "${from}" to "${to}". Legal next states are ` +
        `${TRANSITIONS[from].length === 0 ? '(none: this state is terminal)' : TRANSITIONS[from].join(', ')}. ` +
        'This is a bug in the caller rather than a configuration problem: writing a state the machine ' +
        'does not allow leaves the stored history disagreeing with what the device actually did.',
    );
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: TransactionState, to: TransactionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TransactionState, to: TransactionState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/* ── the window ──────────────────────────────────────────────────────────────────────────── */

/**
 * **The promise**: three minutes from a change being applied to the device being back.
 *
 * This is the product's commitment and the number everything else is derived from. Long enough for an
 * operator to notice a page has stopped responding, reconnect to an access point whose radio has just
 * restarted, and load the interface; short enough that nobody walks away believing the device is dead.
 * It is quoted in the documentation, so it lives in one place.
 */
export const RECOVERY_BUDGET_MS = 180_000;

/**
 * How much of the budget is reserved for the revert **itself** to run.
 *
 * The promise is three minutes to be *back*, not three minutes of waiting followed by however long
 * the undo takes. Measured on the bench board, 2026-09-20: a revert of a full network profile — nine
 * units, every one verified `active` and `enabled` — took about eleven seconds from the transient
 * timer firing to the uplink being associated and addressed again. Thirty seconds is roughly
 * threefold headroom for a slower device, a busier board, or a profile with more units to restore.
 *
 * It is an allowance, not a guess that is allowed to rot: every revert records its own duration, and
 * one that exceeds this is reported as eating into the promise rather than passing silently.
 */
export const REVERT_ALLOWANCE_MS = 30_000;

/**
 * How long an operator has to confirm — **what is left of the budget after the undo is paid for**.
 *
 * Derived rather than written down, because the two numbers drifted apart the moment they were
 * independent: the window was set to the whole budget, so the one case the budget exists for — the
 * daemon dead and the deadline the only trigger — restored at T+191s against a promise of 180s. A
 * window equal to the budget guarantees missing the promise in exactly the situation it was written
 * for.
 *
 * Deriving it means a person who shortens the window sees the budget it came out of, and a person who
 * changes the promise gets a window that follows.
 */
export const CONFIRMATION_WINDOW_MS = RECOVERY_BUDGET_MS - REVERT_ALLOWANCE_MS;

/** Which classes need a confirmation window at all. */
export function needsConfirmation(blastRadius: BlastRadius): boolean {
  // `boot` does not: nothing changes until the device restarts, so there is nothing to revert within
  // a window and nothing to lose access to. It gets a warning and a reboot prompt instead.
  return blastRadius === 'network';
}

export function deadlineFrom(now: Date): Date {
  return new Date(now.getTime() + CONFIRMATION_WINDOW_MS);
}

/**
 * Seconds left, floored at zero and never negative.
 *
 * Negative would be arithmetically honest and useless: the interface renders this as a countdown, and
 * "-4 seconds remaining" tells the operator nothing except that something is wrong with the clock.
 * A board with no clock battery can have its wall clock jump by days, so a passed deadline is a state
 * to act on rather than a number to display.
 */
/**
 * Seconds left, from the deadline **in the frame the timer acts on**.
 *
 * Prefer this over `secondsRemaining`. The armed revert timer fires at a number of seconds since boot,
 * so that is the only figure whose difference from the current uptime is the real remaining time. The
 * wall clock is not: this device has no clock battery, and the apply that opens the window restarts
 * `systemd-timesyncd` on purpose, so a step of days inside the window is the designed path.
 *
 * Both inputs may be unavailable, and each absence means something different:
 *
 * * `firesAtUptimeSeconds === null` — the row predates the column, or uptime could not be read when the
 *   timer was armed. There is no anchored deadline, so the wall-clock figure is returned as the best
 *   available and `anchored` says it is not.
 * * `uptimeSeconds === null` — uptime cannot be read *now*. Returns `null` rather than silently falling
 *   back, because "I cannot tell" is a different answer from a number.
 */
export function anchoredSecondsRemaining(input: {
  firesAtUptimeSeconds: number | null;
  uptimeSeconds: number | null;
  deadlineAt: string | null;
  now: Date;
}): { secondsRemaining: number | null; anchored: boolean } {
  if (input.firesAtUptimeSeconds === null) {
    return { secondsRemaining: secondsRemaining(input.deadlineAt, input.now), anchored: false };
  }
  if (input.uptimeSeconds === null) return { secondsRemaining: null, anchored: true };
  return {
    secondsRemaining: Math.max(0, Math.ceil(input.firesAtUptimeSeconds - input.uptimeSeconds)),
    anchored: true,
  };
}

/**
 * The countdown of a transaction as every surface reports it: a number only while it is
 * `awaiting-confirm`, and `null` in every other state.
 *
 * The row keeps `deadline_at` and `fires_at_uptime_seconds` after a confirmation — they are history —
 * and a surface that derived a countdown from any row carrying them counted a **committed**
 * transaction down while the confirm response had said `null`. Measured on the bench board,
 * 2026-09-23, on `GET /api/transactions`. One function, so the state rule cannot be applied in one
 * place and forgotten in another.
 */
export function windowCountdown(
  row: { state: TransactionState; firesAtUptimeSeconds: number | null; deadlineAt: string | null },
  uptimeSeconds: number | null,
  now: Date,
): { secondsRemaining: number | null; anchored: boolean } {
  if (row.state !== 'awaiting-confirm') return { secondsRemaining: null, anchored: row.firesAtUptimeSeconds !== null };
  return anchoredSecondsRemaining({
    firesAtUptimeSeconds: row.firesAtUptimeSeconds,
    uptimeSeconds,
    deadlineAt: row.deadlineAt,
    now,
  });
}

/**
 * Seconds left from the stored wall-clock instant.
 *
 * Kept for rows that carry no anchored deadline. Where one exists, use `anchoredSecondsRemaining`.
 */
export function secondsRemaining(deadlineAt: string | null, now: Date): number | null {
  if (deadlineAt === null) return null;
  const deadline = new Date(deadlineAt).getTime();
  if (!Number.isFinite(deadline)) return null;
  return Math.max(0, Math.ceil((deadline - now.getTime()) / 1000));
}

export function deadlinePassed(deadlineAt: string | null, now: Date): boolean {
  if (deadlineAt === null) return false;
  const deadline = new Date(deadlineAt).getTime();
  if (!Number.isFinite(deadline)) return false;
  return deadline <= now.getTime();
}

/* ── the transient revert unit ───────────────────────────────────────────────────────────── */

/**
 * The unit name for a transaction's revert timer.
 *
 * Two shapes, because systemd may refuse the first. `wayfarer-revert@<id>.service` is the documented
 * name and reads as what it is — an instance of a family — but a transient unit whose name contains
 * `@` has no template on disk behind it, and whether systemd accepts that is a question about
 * systemd rather than about this code. So the flat form exists as a fallback, the name that was
 * actually armed is **stored on the transaction row**, and confirmation stops the name that was
 * stored rather than re-deriving one.
 *
 * Storing it rather than re-deriving it is the part that matters. A name computed twice is a name
 * that can be computed differently twice, and the failure mode is a revert timer nobody can cancel.
 */
export type RevertUnitStyle = 'instanced' | 'flat';

export function revertUnitName(transactionId: string, style: RevertUnitStyle = 'instanced'): string {
  // The id is generated from random bytes as hex, so there is nothing here to escape. Asserted rather
  // than assumed, because a unit name assembled from unvalidated text is how a name with a slash or a
  // space in it reaches systemd.
  if (!/^[0-9a-f]{1,64}$/.test(transactionId)) {
    throw new Error(
      `refusing to build a unit name from transaction id "${transactionId}": ids are lower-case hex ` +
        'here, and anything else would need escaping that systemd does not do the way a reader expects',
    );
  }
  return style === 'instanced' ? `wayfarer-revert@${transactionId}.service` : `wayfarer-revert-${transactionId}.service`;
}

/** The timer half of a transient unit armed with `--on-active`. Stopping this is what disarms it. */
export function revertTimerFor(unitName: string): string {
  return unitName.replace(/\.service$/, '.timer');
}

/**
 * True when this unit name is one the transaction layer created.
 *
 * Used by the reconciler's ownership guard so that a revert unit is refused there rather than
 * accidentally adopted: the reconciler acts only on `wf-*`, and this family is deliberately not in
 * that namespace.
 */
export function isRevertUnit(name: string): boolean {
  return /^wayfarer-revert[@-]/.test(name);
}

/* ── health checks inside the window ─────────────────────────────────────────────────────── */

/**
 * The thresholds the window's health checks operate on.
 *
 * **Every number here is an assumption, not a measurement**, and they are labelled that way rather
 * than presented as findings. They were chosen to be obviously safe rather than tight, and the soak
 * that replaces them with measured values is a later task.
 */
export interface HealthThresholds {
  /** How often the checks run during the window. */
  intervalMs: number;
  /**
   * How long an uplink is allowed to have neither carrier nor address before that counts as
   * conclusive. Generous on purpose: a DHCP lease on a wireless link involves an association, a
   * four-way handshake and a round trip to a server that may itself be slow.
   */
  uplinkSettleMs: number;
  /** How long the access point has to reach `ENABLED`. */
  accessPointEnabledMs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  intervalMs: 5_000,
  uplinkSettleMs: 45_000,
  accessPointEnabledMs: 30_000,
};

/**
 * What a health check observed, with **absence distinguished from failure**.
 *
 * Each field is a three-valued answer rather than a boolean, because "I could not tell" must not be
 * representable as "it is broken". **A finding may only come from a positively observed failure,
 * never from absent data.** A read that timed out, a source that is unavailable, an interface that is
 * not in the snapshot at all — none of those is evidence that anything is wrong, and the moment a
 * probe is most likely to fail is the moment the board is briefly busy, which is to say *during an
 * apply*.
 */
export type Observation<T> = { known: true; value: T } | { known: false; why: string };

export function observed<T>(value: T): Observation<T> {
  return { known: true, value };
}

export function unknown<T>(why: string): Observation<T> {
  return { known: false, why };
}

/**
 * Which parts of the device **this change** acted on — the scope a verdict about it may cover.
 *
 * Measured 2026-09-22, and three times in September: a change consisting of one core-configuration
 * file and a `wf-core` restart was undone for *"the selected uplink has neither carrier nor address"*.
 * Nothing in that change could reach an uplink's carrier. A check inside a change's window is a
 * verdict on **the change**; judging the whole device there means any unrelated flap — or, as it
 * turned out, any misreading — destroys whatever change happens to be open.
 *
 * Each list holds the changes in the plan that act on that component, so a finding can say *why* it
 * was judged at all. An empty list means this change did not touch it and it is not judged.
 */
export interface WindowScope {
  uplink: string[];
  accessPoint: string[];
}

export interface HealthReading {
  /** Milliseconds since the apply finished, so a settle allowance can be applied. */
  elapsedMs: number;
  /** True when the access point interface has reached `ENABLED`. Absent when it could not be read. */
  accessPointEnabled: Observation<boolean>;
  /** True when at least one selected uplink has a carrier **and** an address. */
  uplinkUp: Observation<boolean>;
  /**
   * What was actually read for each uplink, in the words of the tool that reported it — operstate,
   * flags, IPv4 addresses, or "not present". Carried into every finding about the uplink, so the next
   * person can hold the verdict against the device instead of trusting the conclusion.
   */
  uplinkEvidence: string[];
  /** Units this plan started that have entered `failed`. An empty list is a real observation. */
  failedUnits: Observation<string[]>;
  /** True when the proxy core is running. Only meaningful when the plan wanted it running. */
  coreRunning: Observation<boolean>;
  /** Whether this plan expected an access point, an uplink and a core at all. */
  expects: { accessPoint: boolean; uplink: boolean; core: boolean };
  /** What this change acted on. See `WindowScope`. */
  scope: WindowScope;
}

export type HealthVerdict =
  | { action: 'wait'; reason: string }
  | { action: 'failing'; reason: string; code: string; evidence: string[] };

/**
 * What the window's health checks conclude about **the change** — a finding, never an action.
 *
 * ## Why a failing verdict does not revert
 *
 * This used to be `earlyRevertDecision`, and a `revert` answer undid the change on the spot. That made
 * the device keep two deadlines: the one it reported (`secondsRemaining: 148` of 150) and the one it
 * enforced (45 s, the uplink settle allowance, or the first five-second tick for a failed unit).
 * Measured 2026-09-22: transaction `6110779e063cfb9f` was created 19:03:20 and gone at 19:04:10, while
 * the caller had been told it had minutes. A deadline is a promise, and no number can honestly be
 * reported for a revert that fires *if* something is observed: 148 is a lie when it may act at 45,
 * and the earliest moment it may act — the first tick — is useless as a deadline.
 *
 * So the check produces a finding with the evidence it read, the finding is recorded on the
 * transaction and shown, and the change is undone **at its reported deadline** by the timer outside
 * this process — or sooner only when a person asks. The promise to be back within
 * `RECOVERY_BUDGET_MS` is unchanged, because the window was derived for exactly this path: the
 * deadline as the only trigger.
 *
 * Never returns a confirmation. A healthy reading produces `wait`, because a working uplink does not
 * prove the configuration is the one the operator wanted — only a person can say that.
 */
export function windowVerdict(
  reading: HealthReading,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): HealthVerdict {
  // A unit the plan started that has entered `failed` needs no settle allowance: systemd has already
  // given up on it. It is in scope by construction — `failedUnits` holds only units this plan started.
  if (reading.failedUnits.known && reading.failedUnits.value.length > 0) {
    return {
      action: 'failing',
      code: 'unit_failed',
      reason: `units this change started have failed: ${reading.failedUnits.value.join(', ')}`,
      evidence: reading.failedUnits.value.map((unit) => `${unit}: ActiveState=failed`),
    };
  }

  if (reading.expects.core && reading.coreRunning.known && reading.coreRunning.value === false) {
    return {
      action: 'failing',
      code: 'core_not_running',
      reason: 'the proxy core is not running, and this configuration expects it to be',
      evidence: ['wf-core.service: not active'],
    };
  }

  if (
    reading.expects.accessPoint &&
    reading.scope.accessPoint.length > 0 &&
    reading.elapsedMs >= thresholds.accessPointEnabledMs &&
    reading.accessPointEnabled.known &&
    reading.accessPointEnabled.value === false
  ) {
    return {
      action: 'failing',
      code: 'access_point_not_enabled',
      reason:
        `the access point has not reached ENABLED after ${Math.round(thresholds.accessPointEnabledMs / 1000)}s, ` +
        `and this change acted on it (${reading.scope.accessPoint.join('; ')})`,
      evidence: ['hostapd state: not ENABLED'],
    };
  }

  if (
    reading.expects.uplink &&
    reading.scope.uplink.length > 0 &&
    reading.elapsedMs >= thresholds.uplinkSettleMs &&
    reading.uplinkUp.known &&
    reading.uplinkUp.value === false
  ) {
    return {
      action: 'failing',
      code: 'uplink_down',
      reason:
        `no selected uplink has both carrier and address after ${Math.round(thresholds.uplinkSettleMs / 1000)}s, ` +
        `and this change acted on the uplink (${reading.scope.uplink.join('; ')}). ` +
        `Read: ${reading.uplinkEvidence.join(' | ')}`,
      evidence: reading.uplinkEvidence,
    };
  }

  // Everything else waits, including every unreadable value. The reason is carried so a diagnostic
  // surface can say *why* the window is still open rather than implying everything is fine.
  const unreadable = [
    reading.accessPointEnabled.known ? null : `access point state (${reading.accessPointEnabled.why})`,
    reading.uplinkUp.known ? null : `uplink state (${reading.uplinkUp.why})`,
    reading.failedUnits.known ? null : `unit states (${reading.failedUnits.why})`,
    reading.coreRunning.known ? null : `core state (${reading.coreRunning.why})`,
  ].filter((entry): entry is string => entry !== null);

  if (unreadable.length > 0) {
    return {
      action: 'wait',
      reason: `could not read ${unreadable.join('; ')} — an unreadable value is never grounds for a finding`,
    };
  }

  return { action: 'wait', reason: 'no conclusive failure observed; waiting for a human to confirm' };
}
