/**
 * Applying, confirming and reverting — the transaction layer around the reconciler.
 *
 * Everything that makes a `network` change survivable is here, and none of it is in the reconciler on
 * purpose: the reconciler cannot tell whether anybody is watching, so the decision to perform a change
 * that can cost access belongs to the layer that arms the way back.
 *
 * Three mechanisms, and **none is sufficient alone**:
 *
 * 1. A transaction with the previous document and a deadline, written before anything is touched.
 * 2. A transient unit **outside this process**, armed with `systemd-run --on-active`, which runs
 *    `way revert` when the deadline passes. An in-process timer dies with the process, so a daemon
 *    that applies a bad change and then crashes would leave the device stranded.
 * 3. A sweep at **every daemon start** that reverts anything still unconfirmed. This is the only thing
 *    that covers power loss inside the window, which a timer alone cannot.
 *
 * Reverting is not an inverse operation. It is re-applying a document we already hold, through exactly
 * the same planner and reconciler — which is the single largest benefit of the whole-profile model,
 * because there is no second code path to get wrong.
 */

import type { ProfileDocument } from '@wayfarer/schemas';
import { recoveryProfile } from '@wayfarer/schemas';
import type { Platform } from '../platform/index.ts';
import type { Inventory } from '../inventory/index.ts';
import type { ProfileStore, TakeoverRecord, TransactionRow } from '../state/profiles.ts';
import type { Store } from '../state/store.ts';
import { planDocument, type PipelineContext } from './pipeline.ts';
import type { DriftMonitor } from './drift.ts';
import { reconcile, type ApplyClass, type ReconcileResult } from './reconciler.ts';
import { containsClass, highest, type BlastRadius, type Plan2 } from './differ.ts';
import { SAFE_MODE_THRESHOLD, buildSafeModeDocument, isSafeModeOf, safeModeDecision } from './safe-mode.ts';
import { windowScopeOf, type WindowFinding, type WindowWatchController } from './window-watch.ts';
import {
  CONFIRMATION_WINDOW_MS,
  REVERT_ALLOWANCE_MS,
  windowCountdown,
  deadlineFrom,
  needsConfirmation,
  revertUnitName,
  type RevertUnitStyle,
} from './transactions.ts';

export interface ApplyDeps {
  platform: Platform;
  profiles: ProfileStore;
  store: Store;
  pipeline: PipelineContext;
  timeSyncUnit: string;
  /** The `way` executable, for the revert unit's command line. Configuration, not a constant. */
  wayBinary: string;
  log: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string) => void;
  now?: () => Date;
  /**
   * The document to fall back to when nothing has ever been applied on this device.
   *
   * Built by the caller because it needs the hardware: a recovery profile that named a radio would be
   * a constant describing somebody else's board. Null when no radio can host an access point, in which
   * case a first-apply revert has genuinely nothing to go back to and says so.
   */
  recoveryDocument: () => Promise<ProfileDocument | null>;
  /**
   * The health checks that run during a confirmation window.
   *
   * Optional so a caller that only applies safe classes needs no watcher at all. When it is absent a
   * window works exactly as it does with one — the transient timer ends it at the deadline — and what
   * is missing is only the finding, with what it read, on the transaction and in the event ring. A
   * watcher never ends a window: see `recordWindowFinding`.
   */
  windowWatch?: WindowWatchController;
  /**
   * The check that compares the stored profile with what is actually on this device.
   *
   * **Required, not optional**, and that is deliberate. An optional dependency whose absence is the
   * permissive answer is the shape this repository has already been caught by once — see the
   * catalogue entry *a default meaning "assume everything" turns a missing wire into silence*, where
   * an omitted argument in `pipeline.ts` meant two invariant checks could never fire on a real
   * device and no test could see it, because every test called the checker directly. Making this
   * mandatory means every construction of `ApplyDeps`, in the daemon, in the CLI and in a test, has
   * to say what happens after a revert.
   */
  drift: DriftMonitor;
  /**
   * Told when a transaction ends — confirmed, reverted, or a revert that failed — after the drift check
   * that follows it. Awaited, so a one-shot process (`way revert`) does not exit before it has run.
   *
   * It exists for the resolver follower, which waits while a window is open and used to pick the
   * deferred resolver up only at its next round: measured on the bench board, 2026-09-23, `hq.lan`
   * failed to resolve for about 80 s after a confirm. See `core/transaction-ended.ts`.
   */
  transactionEnded?: (event: { transaction: string; how: 'confirmed' | 'reverted' | 'revert-failed' }) => void | Promise<void>;
}

/**
 * **The one place a transaction ends.** Every confirm and every revert path comes through here: the
 * device is compared with its stored profile, and then whoever waits on a transaction ending is told.
 */
async function transactionEnded(
  deps: ApplyDeps,
  transaction: string,
  how: 'confirmed' | 'reverted' | 'revert-failed',
  driftReason: string,
): Promise<void> {
  await deps.drift.run(driftReason);
  try {
    await deps.transactionEnded?.({ transaction, how });
  } catch (error) {
    // The transaction has ended whatever a listener does; a listener that throws is logged, not fatal.
    deps.log('warn', { transaction, how, error: String(error) }, 'a listener for a transaction ending failed');
  }
}

export interface ApplyOutcome {
  ok: boolean;
  transaction?: {
    id: string;
    state: string;
    blastRadius: string;
    deadlineAt: string | null;
    secondsRemaining: number | null;
  };
  result?: ReconcileResult;
  error?: { code: string; message: string; hint: string; status: number; detail?: unknown };
}

/* ── applying ────────────────────────────────────────────────────────────────────────────── */

interface ClassifiedChange {
  what: string;
  blastRadius: BlastRadius;
  /** For a unit step: the files it is for (`UnitChange.becauseOf`). */
  becauseOf?: string[];
}

/** Every change a classified plan holds, with its class — the units the classes filter is applied to. */
function classifiedChanges(classified: Plan2): ClassifiedChange[] {
  return [
    ...classified.fileChanges.map((change) => ({ what: change.path, blastRadius: change.blastRadius })),
    ...classified.unitChanges.map((change) => ({
      what: `${change.action} ${change.name}`,
      blastRadius: change.blastRadius,
      ...(change.becauseOf === undefined ? {} : { becauseOf: change.becauseOf }),
    })),
    ...classified.sysctlChanges.map((change) => ({ what: `sysctl ${change.key}`, blastRadius: 'network' as BlastRadius })),
    ...classified.interfaceRenames.map((rename) => ({
      what: `rename ${rename.from} to ${rename.to}`,
      blastRadius: (rename.carriesManagement ? 'network' : 'boot') as BlastRadius,
    })),
  ];
}

/**
 * The changes a caller's classes let through — by the reconciler's own rule, so the transaction and the
 * reconcile agree about what happens: a file of a class not permitted is refused, and a step whose every
 * cause is such a file is refused with it ("a restart whose every reason was refused is not performed",
 * `core/reconciler.ts`). On the board the follower's plan held `config.json` and `fence.json` (`network`)
 * and `restart wf-core.service` (`service`) caused only by them: nothing it could do.
 */
function permittedChanges(changes: ClassifiedChange[], classified: Plan2, classes: ApplyClass[]): ClassifiedChange[] {
  const refusedFiles = new Set(
    classified.fileChanges.filter((change) => !classes.includes(change.blastRadius)).map((change) => change.path),
  );
  return changes.filter(
    (change) =>
      classes.includes(change.blastRadius) &&
      !(change.becauseOf !== undefined && change.becauseOf.length > 0 && change.becauseOf.every((path) => refusedFiles.has(path))),
  );
}

type ApplyInput = Parameters<typeof applyDocumentOnce>[1];

/**
 * Apply, and then ask whether the device now matches its stored profile.
 *
 * **After every apply that reached the device, whoever asked for it.** Measured on the bench board,
 * 2026-09-23: the resolver follower fixed the core's resolver 4 s after start-up and `GET /api/drift`
 * went on showing the boot-time red for fifteen minutes, because the check ran at boot, after an undo
 * and on its cadence — never after an apply. A report that describes the device as it was before the
 * last change is the stale reading this project keeps writing entries about. An apply that was
 * refused before a transaction existed changed nothing, and is not followed by a check.
 */
export async function applyDocument(deps: ApplyDeps, input: ApplyInput): Promise<ApplyOutcome> {
  const outcome = await applyDocumentOnce(deps, input);
  if (outcome.transaction !== undefined) await deps.drift.run('after-apply');
  return outcome;
}

async function applyDocumentOnce(
  deps: ApplyDeps,
  input: {
    profileId: string;
    document: ProfileDocument;
    classes?: ApplyClass[];
    /**
     * The credential that asked for this apply. Recorded on the transaction so that credential is not
     * expired while the window it opened is counting down — the operator must not lose the ability to
     * confirm a change only they can confirm. Absent for work the device starts itself.
     */
    openedBy?: string | null;
  },
): Promise<ApplyOutcome> {
  const now = deps.now ?? ((): Date => new Date());

  /**
   * One window at a time.
   *
   * Two open windows mean two armed revert timers, and the second fires against a document the
   * operator has already abandoned — at a moment when they have stopped expecting anything to happen.
   * Refused with the transaction named and the time left, so the answer is "wait or confirm" rather
   * than "something is wrong".
   */
  const open = deps.profiles.unconfirmedTransaction();
  if (open !== null) {
    const remaining = await remainingSeconds(deps, open, now());
    return {
      ok: false,
      error: {
        status: 409,
        code: 'confirmation_pending',
        message:
          `Transaction ${open.id} is inside its confirmation window with ` +
          `${remaining === null ? 'an unknown time' : `${remaining} seconds`} left. Confirm it or let it ` +
          'revert before applying anything else.',
        hint: `POST /api/transactions/${open.id}/confirm to keep it, or /revert to undo it now.`,
        detail: { transaction: open.id, secondsRemaining: remaining },
      },
    };
  }

  const planned = await planDocument(deps.pipeline, input.document);
  const { plan, classified } = planned;

  if (!plan.usable) {
    const firstError = plan.findings.find((finding) => finding.severity === 'error')!;
    return {
      ok: false,
      error: {
        status: 422,
        code: firstError.code,
        message: firstError.message,
        hint: firstError.hint,
        detail: { findings: plan.findings.filter((finding) => finding.severity === 'error') },
      },
    };
  }

  /**
   * Which classes are actually performed.
   *
   * A caller's explicit narrowing wins. Otherwise: everything the plan contains, because the window is
   * about to be armed — that is what makes the dangerous classes safe to attempt. `boot` is included
   * because writing a `.link` file changes nothing until the device restarts, so it costs nothing to
   * apply and would otherwise be a change that can never happen.
   */
  const classes: ApplyClass[] = input.classes ?? ['hot', 'service', 'network', 'boot'];

  /**
   * A window is armed only when a `network` change is actually going to happen.
   *
   * Two things this gets right that the obvious version does not, both found by a test rather than by
   * reading:
   *
   * * **It asks whether the plan *contains* a network change, not what its highest class is.** `boot`
   *   orders above `network`, so a plan that renames an interface and changes addressing classifies as
   *   `boot` — which needs no window, because nothing happens until a restart. Deciding from the
   *   highest class would leave the live network change in that plan completely unprotected.
   * * **It respects the caller's narrowing.** A caller that asked for only the safe classes is not
   *   performing a network change, so arming a window would start a countdown for something that was
   *   refused — and if nobody confirmed it, the revert would undo the *safe* part that did apply.
   */
  const performsNetworkChange = classes.includes('network') && containsClass(classified, 'network');
  const needsWindow = performsNetworkChange && needsConfirmation('network');

  /*
   * **The transaction carries the class of what it performs, and there is none for a change nobody may
   * perform.** Measured on the bench board, 2026-09-23 09:07:46: the follower's start-up attempt opened
   * `a36badb1d45169a9` — kind `apply`, blast radius `network`, committed with no deadline, opened by
   * nobody — and wrote nothing: every change it needed was `network`, and it applies only `hot` and
   * `service`. The recorded class was the whole plan's (`classified.blastRadius`), not the class of
   * anything that happened, so the device's own history showed a network change committed without a
   * window — the one thing the window exists to prevent — for an apply that changed nothing at all.
   */
  const changes = classifiedChanges(classified);
  const permitted = permittedChanges(changes, classified, classes);
  if (input.classes !== undefined && changes.length > 0 && permitted.length === 0) {
    const refused = changes.map((change) => ({ what: change.what, blastRadius: change.blastRadius, needs: 'a class this caller did not permit' }));
    deps.log('warn', { classes, refused }, 'nothing in this plan is of a class the caller permits; no transaction was opened');
    return {
      ok: false,
      error: {
        status: 409,
        code: 'nothing_permitted',
        message:
          `every change this plan needs is of a class this caller may not apply (it applies ${classes.join(', ')}): ` +
          changes.map((change) => `${change.what} (${change.blastRadius})`).join('; '),
        hint: 'An ordinary apply, which opens a confirmation window, can make these changes.',
        detail: { refused },
      },
    };
  }
  const performedRadius = input.classes === undefined ? classified.blastRadius : highest(permitted.map((change) => change.blastRadius));

  const transaction = deps.profiles.createTransaction({
    ...(input.openedBy !== undefined ? { openedBy: input.openedBy } : {}),
    profileId: input.profileId,
    // The last **successfully applied** document, which is not the one being installed. Reading the
    // active profile here would make the revert target and the apply target the same document, so a
    // revert would re-apply whatever had just broken the device.
    documentBefore: deps.profiles.lastAppliedDocument(),
    documentAfter: input.document,
    kind: 'apply',
    blastRadius: performedRadius,
    plan: { humanDiff: classified.humanDiff, blastRadius: classified.blastRadius },
  });

  deps.profiles.setTransactionState(transaction.id, 'applying');
  deps.store.recordEvent({
    level: 'info',
    kind: 'apply.started',
    summary: `apply started (${performedRadius})`,
    detail: { transaction: transaction.id, classes },
  });

  /**
   * Validate before arming, and arm before changing anything.
   *
   * Three states in a fixed order, and the middle one is easy to get wrong in both directions.
   *
   * Arming **after** the change would leave the most dangerous interval — the one where the network is
   * half reconfigured — with nothing watching it, and that is exactly where the daemon is most likely to
   * lose the ability to arm anything. So arming precedes the change.
   *
   * But arming **before validating** is also wrong, and a test caught it: a plan refused at step 1 for a
   * directory it could not write had already consumed a revert timer, and the transaction then needed a
   * full revert of a change that never happened — producing an event log saying the device was reverted
   * when nothing had been touched. Validation mutates nothing, so it costs nothing to do first.
   *
   * The general rule, the same one the deploy script had to learn: **a refusal must be reachable before
   * anything with a consequence happens.** The validation runs twice, and that is the price — a few tens
   * of milliseconds of `nft -c -f` and some writability probes, against a window burned for nothing.
   */
  if (needsWindow) {
    const preflight = await reconcile({
      platform: deps.platform,
      desired: plan.desired,
      plan: classified,
      options: { classes, validateOnly: true },
      timeSyncUnit: deps.timeSyncUnit,
    });
    if (preflight.error !== undefined) {
      deps.profiles.setTransactionState(transaction.id, 'failed', preflight.error.message);
      deps.store.recordEvent({
        level: 'error',
        kind: 'apply.refused',
        summary: `validation refused this change before anything was touched: ${preflight.error.code}`,
        detail: { transaction: transaction.id, steps: preflight.steps },
      });
      return {
        ok: false,
        result: preflight,
        transaction: {
          id: transaction.id,
          state: 'failed',
          blastRadius: performedRadius,
          deadlineAt: null,
          secondsRemaining: null,
        },
        error: {
          status: 500,
          code: preflight.error.code,
          message: preflight.error.message,
          hint: preflight.error.hint,
          detail: { steps: preflight.steps },
        },
      };
    }
  }

  let armedUnit: string | null = null;
  if (needsWindow) {
    const armed = await armRevertTimer(deps, transaction.id);
    if (!armed.ok) {
      deps.profiles.setTransactionState(transaction.id, 'failed', armed.message);
      deps.store.recordEvent({
        level: 'error',
        kind: 'apply.refused',
        summary: 'could not arm the revert timer; nothing was applied',
        detail: { transaction: transaction.id, message: armed.message },
      });
      return {
        ok: false,
        error: {
          status: 503,
          code: 'revert_timer_unavailable',
          message:
            `The revert timer could not be armed (${armed.message}), so this change was not applied. ` +
            'A change that can cost access is never attempted without the way back already in place.',
          hint: 'Check `systemd-run` is available and that no stale wayfarer-revert unit is left behind.',
        },
      };
    }
    armedUnit = armed.unit;
    const deadline = deadlineFrom(now());
    // Both frames recorded: the wall-clock instant for a row a human reads later, and the
    // boot-relative one the armed timer will actually act on. `armed.firesAtUptimeSeconds` is the
    // number that was handed to `OnBootSec`, not a second calculation of it.
    deps.profiles.beginConfirmationWindow(
      transaction.id,
      deadline.toISOString(),
      armed.unit,
      armed.firesAtUptimeSeconds ?? null,
    );
  }

  const result = await reconcile({
    platform: deps.platform,
    desired: plan.desired,
    plan: classified,
    options: { classes },
    timeSyncUnit: deps.timeSyncUnit,
    onTakeover: async (entries) => {
      // Recorded on the transaction before the move happens, so a revert can find the file.
      deps.profiles.recordTakeover(transaction.id, entries as TakeoverRecord[]);
    },
  });

  if (!result.applied) {
    /**
     * A failed `network` apply has already touched the network, so it needs the journey back.
     *
     * A failed `service` apply has not, and stops at `failed`. That distinction is why `failed` is not
     * a terminal state in the machine: the same word covers two situations with different obligations.
     */
    if (needsWindow) {
      deps.store.recordEvent({
        level: 'error',
        kind: 'apply.failed',
        summary: `apply failed partway through a network change; reverting (${result.error?.code ?? 'unknown'})`,
        detail: { transaction: transaction.id, steps: result.steps },
      });
      const reverted = await revertTransaction(deps, transaction.id, `the apply failed: ${result.error?.message ?? 'unknown'}`);
      return {
        ok: false,
        result,
        transaction: { id: transaction.id, state: reverted.ok ? 'reverted' : 'failed', blastRadius: performedRadius, deadlineAt: null, secondsRemaining: null },
        error: {
          status: 500,
          code: result.error?.code ?? 'apply_failed',
          // The revert's own account of what it did, not a sentence asserting what it was asked to do.
          // A revert whose target was already live undoes nothing, and saying otherwise sends the reader
          // looking for a configuration that is not the one running.
          message: `${result.error?.message ?? 'the apply did not complete'} ${capitalise(reverted.message)}.`,
          hint: result.error?.hint ?? 'Read the steps.',
          detail: { steps: result.steps, refused: result.refused },
        },
      };
    }

    deps.profiles.setTransactionState(transaction.id, 'failed', result.error?.message ?? null);
    deps.store.recordEvent({
      level: result.error?.code === 'blast_radius_not_applicable' ? 'info' : 'error',
      kind: 'apply.refused',
      summary: result.error?.message.split('\n')[0] ?? 'apply did not complete',
      detail: { transaction: transaction.id, refused: result.refused },
    });
    return {
      ok: false,
      result,
      transaction: { id: transaction.id, state: 'failed', blastRadius: performedRadius, deadlineAt: null, secondsRemaining: null },
      error: {
        status: result.error?.code === 'blast_radius_not_applicable' ? 409 : 500,
        code: result.error?.code ?? 'apply_failed',
        message: result.error?.message ?? 'the apply did not complete',
        hint: result.error?.hint ?? 'Read the steps.',
        detail: { refused: result.refused, steps: result.steps, verificationFailures: result.verificationFailures },
      },
    };
  }

  if (!needsWindow) {
    // `hot` and `service` go straight to committed: neither can cost access, so there is nothing to
    // confirm and a simple client does not have to special-case anything.
    deps.profiles.confirmTransaction(transaction.id, now().toISOString());
    deps.store.recordEvent({
      level: 'info',
      kind: 'apply.succeeded',
      summary: `apply succeeded (${performedRadius})`,
      detail: { transaction: transaction.id },
    });
    return {
      ok: true,
      result,
      transaction: { id: transaction.id, state: 'committed', blastRadius: performedRadius, deadlineAt: null, secondsRemaining: null },
    };
  }

  const row = deps.profiles.transaction(transaction.id)!;

  /**
   * Start watching, now that the change is in place and the window is open.
   *
   * After the apply rather than before it: during the apply the device is *expected* to be briefly
   * inconsistent — hostapd restarting, an address moving — and checks running then would revert a
   * change for being halfway through, which is the one thing they must never do.
   *
   * What the checks are allowed to conclude about is taken from the plan, not assumed. A profile with
   * no uplink must not be judged for having no uplink, and `expects` is what stops that; a change that
   * never touched the uplink must not be judged by it either, and `scope` is what stops that.
   *
   * What they conclude is recorded, never acted on: see `windowVerdict` for why a check inside the
   * window cannot end it before the deadline this function is about to report.
   */
  deps.windowWatch?.start({
    transactionId: transaction.id,
    scope: windowScopeOf(classified, plan.desired.takeover.map((claim) => claim.interfaceName)),
    expects: {
      accessPoint: input.document.accessPoint !== null,
      uplink: input.document.uplinks.some((uplink) => uplink.enabled !== false),
      // Only when the plan actually started it. A device with no core installed generates no core
      // unit, and reverting because an uninstalled program is not running would be absurd.
      core: plan.desired.units.some((unit) => unit.name === 'wf-core.service' && unit.active),
    },
    accessPointInterface: accessPointInterfaceOf(plan.desired.managedInterfaces),
    uplinkInterfaces: plan.desired.managedInterfaces
      .filter((entry) => entry.expect === 'carrier-and-address')
      .map((entry) => entry.name),
    // Only units this plan started. A unit that was already failing before this change is not this
    // change's fault, and reverting for it would make every apply on a board with an unrelated broken
    // service impossible.
    startedUnits: classified.unitChanges
      .filter((change) => change.action === 'start' || change.action === 'restart')
      .map((change) => change.name),
  });

  deps.store.recordEvent({
    level: 'info',
    kind: 'apply.awaiting-confirm',
    summary: `network change applied; ${CONFIRMATION_WINDOW_MS / 1000}s to confirm before it reverts`,
    detail: { transaction: transaction.id, deadlineAt: row.deadlineAt, revertUnit: armedUnit },
  });

  return {
    ok: true,
    result,
    transaction: {
      id: transaction.id,
      state: 'awaiting-confirm',
      blastRadius: performedRadius,
      deadlineAt: row.deadlineAt,
      secondsRemaining: await remainingSeconds(deps, row, now()),
    },
  };
}

/**
 * How long is left on an open window, from the deadline the armed timer acts on.
 *
 * One helper rather than the three inline `deadlineAt - now` subtractions this file used to contain.
 * They were three copies of one calculation, all of them in the wall-clock frame — which is the wrong
 * frame here, because the apply that opens the window restarts `systemd-timesyncd` and this board has
 * no clock battery.
 */
async function remainingSeconds(deps: ApplyDeps, row: TransactionRow, now: Date): Promise<number | null> {
  const uptime = await deps.platform.host.uptimeSeconds().catch(() => null);
  return windowCountdown(row, uptime, now).secondsRemaining;
}

/* ── arming the timer outside this process ───────────────────────────────────────────────── */

/**
 * Arms the transient revert unit, trying the documented name first.
 *
 * The instanced form `wayfarer-revert@<id>.service` is what the design documents, and whether systemd
 * accepts a transient unit whose name contains `@` with no template on disk is a question about
 * systemd rather than about this code. So it is **attempted** and the flat form is the fallback, the
 * name that actually worked is returned, and the caller stores it — because a name recomputed later
 * can be recomputed differently, and the failure mode of that is a revert timer nothing can cancel.
 */
async function armRevertTimer(
  deps: ApplyDeps,
  transactionId: string,
): Promise<{ ok: true; unit: string; firesAtUptimeSeconds?: number } | { ok: false; message: string }> {
  const attempts: RevertUnitStyle[] = ['instanced', 'flat'];
  const failures: string[] = [];

  for (const style of attempts) {
    const unit = revertUnitName(transactionId, style);
    const result = await deps.platform.systemd.runTransient({
      unit,
      // A deadline, not a delay: see `TransientUnitOptions.withinSeconds`. This timer is armed
      // *before* the reconcile runs, and the reconcile reloads systemd once per unit it installs, so
      // expressing this as an interval from the timer's activation made every such reload postpone
      // the revert by the whole window.
      withinSeconds: Math.round(CONFIRMATION_WINDOW_MS / 1000),
      description: `Wayfarer: revert transaction ${transactionId} unless it is confirmed`,
      argv: [deps.wayBinary, 'revert', '--txn', transactionId],
    });
    if (result.ok) {
      if (style !== 'instanced') {
        deps.log('warn', { unit, style }, 'systemd refused the instanced transient unit name; used the flat form');
      }
      return {
        ok: true,
        unit,
        ...(result.firesAtUptimeSeconds !== undefined ? { firesAtUptimeSeconds: result.firesAtUptimeSeconds } : {}),
      };
    }
    failures.push(`${unit}: ${result.message}`);
  }

  return { ok: false, message: failures.join(' | ') };
}

/* ── what the window's checks found ──────────────────────────────────────────────────────── */

/**
 * Records a window health finding on the open transaction and in the event ring — and does nothing
 * else.
 *
 * This is the only thing a finding is allowed to do, and that is the point: the deadline the device
 * reported when it opened the window is the deadline it keeps. A verdict that reverted on its own gave
 * a caller told `secondsRemaining: 148` a real budget of 45 s, and on 2026-09-22 destroyed a healthy
 * change on a misread interface. The check's value is its evidence, which a person can act on with
 * `POST /api/transactions/:id/revert`, and which the revert at the deadline carries into its record.
 */
export async function recordWindowFinding(deps: ApplyDeps, id: string, finding: WindowFinding | null): Promise<void> {
  const text =
    finding === null
      ? null
      : `${finding.reason} (code ${finding.code}, ${Math.round(finding.elapsedMs / 1000)}s into the window)`;
  deps.profiles.noteWindowFinding(id, text);
  deps.store.recordEvent({
    level: finding === null ? 'info' : 'warn',
    kind: 'apply.window-finding',
    summary:
      finding === null
        ? `transaction ${id}: the window's health check no longer finds a failure`
        : `transaction ${id}: the window's health check found ${finding.reason}. Nothing is undone before the deadline unless you ask`,
    detail: { transaction: id, ...(finding === null ? { cleared: true } : { code: finding.code, evidence: finding.evidence, elapsedMs: finding.elapsedMs }) },
  });
}

/* ── confirming ──────────────────────────────────────────────────────────────────────────── */

/**
 * Confirmation: an explicit act, never inferred.
 *
 * Not a client reconnecting. A change can restore the operator's own path while breaking everyone
 * else's, or bring the access point back while leaving the uplink dead — so the only signal worth
 * acting on is a person saying "this is correct".
 */
export async function confirmTransaction(deps: ApplyDeps, id: string): Promise<ApplyOutcome> {
  const row = deps.profiles.transaction(id);
  if (row === null) {
    return { ok: false, error: { status: 404, code: 'not_found', message: `No transaction ${id}.`, hint: 'It may have been pruned.' } };
  }
  if (row.state !== 'awaiting-confirm') {
    return {
      ok: false,
      error: {
        status: 409,
        code: 'not_awaiting_confirm',
        message: `Transaction ${id} is ${row.state}, so there is nothing to confirm.`,
        hint: row.state === 'committed' ? 'It is already confirmed.' : 'It has already been reverted or failed.',
      },
    };
  }

  // The timer first, and the state second. If the process dies between them, the worst case is a
  // transaction that still says `awaiting-confirm` with no timer — which the start-up sweep reverts,
  // costing the operator their change. The other order risks a committed transaction whose timer is
  // still armed, which reverts a change the operator was told had been kept.
  await stopRevertTimer(deps, row);
  deps.windowWatch?.stop(id);
  deps.profiles.confirmTransaction(id);
  deps.store.recordEvent({ level: 'info', kind: 'apply.confirmed', summary: `transaction ${id} confirmed`, detail: { transaction: id } });
  // The window's change is now the device's state; the report must say what that state is.
  await transactionEnded(deps, id, 'confirmed', 'after-confirm');

  return { ok: true, transaction: { id, state: 'committed', blastRadius: row.blastRadius, deadlineAt: null, secondsRemaining: null } };
}

async function stopRevertTimer(deps: ApplyDeps, row: TransactionRow): Promise<void> {
  // The unit that was actually armed, read from the row rather than recomputed. See `armRevertTimer`.
  if (row.revertUnit === null) return;
  const stopped = await deps.platform.systemd.stopTransient(row.revertUnit).catch((error: unknown) => ({
    ok: false,
    message: String(error),
  }));
  if (!stopped.ok) {
    deps.log('warn', { unit: row.revertUnit, message: stopped.message }, 'could not stop the revert timer');
  }
}

/* ── reverting ───────────────────────────────────────────────────────────────────────────── */

export interface RevertOutcome {
  ok: boolean;
  /** What the device was taken back to, so a caller can say it rather than imply it. */
  target: 'previous-document' | 'recovery-profile' | 'nothing';
  restored: { from: string; to: string; outcome: string; why?: string }[];
  /** The second undo, per displaced manager: which command ran and what it said. */
  reloads: { manager: string; command: string; ok: boolean; detail: string }[];
  /** True when the effect could not be restored any other way and a reboot was asked for. */
  rebooted: boolean;
  /**
   * How long this revert took, end to end, in milliseconds.
   *
   * Recorded on every revert rather than sampled, because the confirmation window is derived by
   * subtracting an allowance for exactly this from the promise. An allowance nobody measures is a
   * belief; measuring it on every run is what keeps the derivation honest as the profile grows.
   */
  durationMs: number;
  /**
   * True when the document being reverted *to* was already the running state, so nothing was undone.
   *
   * Recorded because the difference is invisible otherwise and matters enormously to whoever reads the
   * refusal. Measured on the bench board, 2026-09-20: an apply failed on a false timeout, reverted, and
   * reported "reverted to the previously applied configuration" — while the device sat there running
   * the configuration that had just been called a failure, because the previous committed document was
   * the same one. The bookkeeping was right and the sentence was misleading.
   */
  changedNothing: boolean;
  result?: ReconcileResult;
  message: string;
}

/**
 * Re-applies the document this transaction was moving away from.
 *
 * Safe to run more than once, and it has to be: the transient timer can fire while a start-up sweep
 * is also deciding to revert, and an operator can ask for one at the same moment.
 */
export async function revertTransaction(deps: ApplyDeps, id: string, reason: string): Promise<RevertOutcome> {
  // Started before anything is read, so the measurement covers the whole undo and not just its
  // interesting half.
  const startedAt = Date.now();
  const row = deps.profiles.transaction(id);
  if (row === null) {
    return {
      ok: false,
      target: 'nothing',
      restored: [],
      reloads: [],
      rebooted: false,
      changedNothing: true,
      durationMs: Date.now() - startedAt,
      message: `no transaction ${id}`,
    };
  }

  if (row.state === 'committed') {
    // Confirmed by a human. Reverting it now would undo a change somebody explicitly kept, which is
    // worse than an expired timer doing nothing.
    return {
      ok: true,
      target: 'nothing',
      restored: [],
      reloads: [],
      rebooted: false,
      changedNothing: true,
      durationMs: Date.now() - startedAt,
      message: `transaction ${id} was confirmed; nothing to revert`,
    };
  }
  if (row.state === 'reverted') {
    return {
      ok: true,
      target: 'nothing',
      restored: [],
      reloads: [],
      rebooted: false,
      changedNothing: true,
      durationMs: Date.now() - startedAt,
      message: `transaction ${id} was already reverted`,
    };
  }

  /*
   * What the window's health check had found, folded into what this revert records.
   *
   * The deadline is now the only unattended trigger, so the revert that runs there is usually the
   * transient timer's `way revert` in another process — and the finding, with the interface state it
   * read, lives on the row for exactly that reason. A revert that says only "the deadline passed" when
   * the check had seen `wfwan0: operstate DOWN, flags NO-CARRIER,…` throws away the one line that lets
   * the next person tell a broken change from an impatient one.
   */
  const finding = row.state === 'awaiting-confirm' && row.reason !== null ? row.reason : null;
  const recorded = finding === null ? reason : `${reason}. During the window the health check had found: ${finding}`;
  if (row.state !== 'reverting') deps.profiles.setTransactionState(id, 'reverting', recorded);
  deps.store.recordEvent({
    level: 'warn',
    kind: 'apply.reverting',
    summary: `reverting transaction ${id}: ${recorded}`,
    detail: { transaction: id, reason, ...(finding === null ? {} : { windowFinding: finding }) },
  });

  // The timer is stopped first: this revert is happening, and leaving it armed would run a second one.
  await stopRevertTimer(deps, row);
  // And the health checks: a finding recorded mid-revert would describe a window that has shut.
  deps.windowWatch?.stop(id);

  /**
   * Put back any file that was moved aside, before re-applying.
   *
   * Before, because the document being restored may expect the other manager to own that interface
   * again, and a `networkctl reload` that happens first would read a directory still missing the file.
   */
  const restored: RevertOutcome['restored'] = [];
  const displacedManagers = new Set<string>();
  for (const entry of row.takeover) {
    const outcome = await deps.platform.files.restoreAside(entry).catch((error: unknown) => ({
      outcome: 'collision' as const,
      from: entry.from,
      to: entry.to,
      why: String(error),
    }));
    restored.push({ from: outcome.from, to: outcome.to, outcome: outcome.outcome, ...('why' in outcome ? { why: outcome.why } : {}) });
    if (outcome.outcome === 'collision') {
      deps.log('warn', { ...outcome }, 'a file moved aside for a takeover was not restored');
    } else if (outcome.outcome === 'restored' && entry.by !== undefined) {
      displacedManagers.add(entry.by);
    }
  }

  /**
   * The second undo: restoring a file is not restoring an effect.
   *
   * Putting `/etc/netplan/20-wifi.yaml` back does nothing about netplan's running state — its supplicant
   * has already lost the radio, and its generated files live in `/run` where only netplan regenerates
   * them. Measured on the bench board: a takeover of the interface carrying the management session was
   * configuration-reversible and **not** effect-reversible, the device never came back, and the bench
   * deadman had to rescue it.
   *
   * Running the command that manager publishes is not a breach of the rule that we never adopt or fight
   * over another program's units. The rule exists to stop us *owning* their configuration; this is
   * completing our own undo of our own change, with their own published command, and it is constrained so
   * it cannot grow into anything else: only while reverting a takeover we performed, never in a forward
   * apply, only from the closed table in the platform layer, bounded by a timeout, and recorded.
   */
  const reloads: RevertOutcome['reloads'] = [];
  for (const manager of displacedManagers) {
    const result = await deps.platform.host.reloadForeignManager(manager).catch((error: unknown) => ({
      manager,
      command: '',
      ok: false,
      detail: String(error),
    }));
    reloads.push(result);
    deps.log(result.ok ? 'info' : 'warn', { ...result }, 'asked a displaced manager to re-apply its own configuration');
  }

  /**
   * What to go back to.
   *
   * `documentBefore` when there is one. When there is not — the very first apply a device has ever
   * performed — the recovery profile, **loudly**, so that a device found running the recovery
   * configuration is not read as a mysterious factory reset.
   */
  let target: ProfileDocument | null = (row.documentBefore as ProfileDocument | null) ?? null;
  let targetKind: RevertOutcome['target'] = 'previous-document';
  if (target === null) {
    target = await deps.recoveryDocument();
    targetKind = 'recovery-profile';
    deps.store.recordEvent({
      level: 'warn',
      kind: 'apply.reverted-to-recovery',
      summary: 'no previously applied configuration existed, so the recovery profile was applied instead',
      detail: { transaction: id, reason },
    });
    deps.log(
      'warn',
      { transaction: id },
      'reverting with no prior device state: applying the built-in recovery profile. This is not a factory reset.',
    );
  }

  if (target === null) {
    // No prior document and no radio that can host an access point. Honest rather than silent: the
    // files stay as they are, and the operator is told there was nothing to go back to.
    deps.profiles.setTransactionState(id, 'failed', `nothing to revert to — reverting because ${recorded}`);
    /*
     * Compared anyway, and this is the path where it is least obvious and most useful.
     *
     * Nothing was put back, so the device is left running the very change that failed its window —
     * with the transaction recorded `failed` and no statement anywhere about what is actually on
     * disk. That is the silence this check exists to end, so it speaks here too.
     */
    await transactionEnded(deps, id, 'reverted', 'after-revert');
    return {
      ok: false,
      target: 'nothing',
      restored,
      reloads,
      rebooted: false,
      changedNothing: true,
      durationMs: Date.now() - startedAt,
      message:
        'There is no previously applied configuration and no recovery profile is possible on this ' +
        'hardware, so there was nothing to revert to. The configuration on disk is unchanged.',
    };
  }

  const planned = await planDocument(deps.pipeline, target);
  /**
   * Whether going back changes anything at all, decided before the reconcile rather than guessed from
   * its step list. An empty plan here means the revert target is already live.
   */
  const changedNothing = planned.classified.empty;
  const result = await reconcile({
    platform: deps.platform,
    desired: planned.plan.desired,
    plan: planned.classified,
    // Every class. A revert that refused the dangerous half would leave the device in the state it is
    // being rescued from, which is the one outcome this path exists to prevent.
    options: { classes: ['hot', 'service', 'network', 'boot'] },
    timeSyncUnit: deps.timeSyncUnit,
  });

  if (!result.applied) {
    deps.profiles.setTransactionState(
      id,
      'failed',
      `the revert itself failed: ${result.error?.message ?? 'unknown'} — reverting because ${recorded}`,
    );
    deps.store.recordEvent({
      level: 'error',
      kind: 'apply.revert-failed',
      summary: `the revert of ${id} did not complete`,
      detail: { transaction: id, steps: result.steps },
    });
    // A revert that did not complete leaves the device in a state nobody has described. That is the
    // case most worth comparing, not the least, so the check runs on this path too.
    await transactionEnded(deps, id, 'revert-failed', 'after-failed-revert');
    return {
      ok: false,
      target: targetKind,
      restored,
      reloads,
      rebooted: false,
      changedNothing: false,
      durationMs: Date.now() - startedAt,
      result,
      message: `the revert did not complete: ${result.error?.message ?? 'unknown'}`,
    };
  }

  deps.profiles.finishRevert(id);

  /**
   * What this device is running now, compared with what is stored — asked here because this is the
   * moment the two are most likely to differ and the one place nothing ever asked.
   *
   * The profile pointer is deliberately not moved back (see the note further down), so after a revert
   * the stored profile routinely describes something the device is no longer doing. That was the
   * design and it was correct; what was missing is that nobody was told. Measured on the bench board,
   * 2026-09-22: six blocked endpoints stood in the stored profile while the running core configuration
   * held none, and the only way to learn it was to read the file and the database by hand.
   *
   * It reports and never repairs. A revert that ended by quietly re-applying something would be a
   * change nobody ordered, arriving at the exact moment a safeguard has just undone one.
   */
  await transactionEnded(deps, id, 'reverted', 'after-revert');

  /**
   * What the undo actually cost, against the allowance the confirmation window was derived from.
   *
   * A revert that overruns has not failed — the device is back — but it has eaten into the promise,
   * and the next one on a slower device or a larger profile may not make it at all. So it is reported
   * as its own condition rather than folded into the success.
   */
  const durationMs = Date.now() - startedAt;

  /**
   * The number the promise actually depends on: how long after the **deadline** the device was put
   * back, not how long `revertTransaction` spent inside itself.
   *
   * Measured on the bench board, 2026-09-20, re-running scenario 2b under the derived window: the
   * revert's own work took 2 376 ms, and the device came back at T+170s against a window of 150s — so
   * the real cost was about twenty seconds. The missing eighteen are systemd starting the transient
   * unit, the runtime booting, and the radio re-associating and taking a lease. Comparing the internal
   * duration against the allowance would have let the real cost grow to three times the allowance
   * while the recorded number still read two seconds.
   *
   * Negative when the revert ran *before* the deadline — an operator asking for it, or the start-up
   * sweep — and deciding it overran because it was early would be nonsense. Only a positive value is
   * judged.
   */
  /*
   * Measured against the **boot-relative** deadline the timer acted on, not the stored wall-clock one.
   *
   * The apply that opened this window restarts `systemd-timesyncd`, so a wall-clock step inside the
   * window is the designed path on this board. Subtracting a wall-clock instant recorded before the step
   * from a wall-clock reading taken after it produced a figure of hours, an `error`-level event claiming
   * "the three-minute promise is no longer safe", and somebody sent to investigate a performance fault
   * that never happened. `null` when the frame is unavailable, and a `null` is not judged at all — an
   * alarm that cannot be computed must not be raised on a guess.
   */
  const uptimeNow = await deps.platform.host.uptimeSeconds().catch(() => null);
  const sinceDeadlineMs =
    row.firesAtUptimeSeconds !== null && uptimeNow !== null
      ? Math.round((uptimeNow - row.firesAtUptimeSeconds) * 1000)
      : null;
  const againstAllowanceMs = sinceDeadlineMs !== null && sinceDeadlineMs > 0 ? sinceDeadlineMs : durationMs;
  const overran = againstAllowanceMs > REVERT_ALLOWANCE_MS;
  deps.store.recordEvent({
    level: overran ? 'error' : 'warn',
    kind: overran ? 'apply.revert-overran' : 'apply.reverted',
    summary: overran
      ? `transaction ${id} reverted, but putting the device back took ` +
        `${Math.round(againstAllowanceMs / 1000)}s against an allowance of ` +
        `${REVERT_ALLOWANCE_MS / 1000}s, so the three-minute promise is no longer safe`
      : `transaction ${id} reverted: ${reason}`,
    detail: {
      transaction: id,
      reason,
      target: targetKind,
      restored,
      // Both: the work this function did, and the cost the promise is measured against.
      durationMs,
      // Named for its frame, so nobody reads it as a wall-clock difference. `null` means the anchored
      // deadline was not available, in which case only the function's own duration was judged.
      sinceDeadlineMs,
      sinceDeadlineFrame: sinceDeadlineMs === null ? 'unavailable' : 'uptime',
      againstAllowanceMs,
      allowanceMs: REVERT_ALLOWANCE_MS,
    },
  });
  if (overran) {
    deps.log(
      'error',
      { transaction: id, durationMs, sinceDeadlineMs, againstAllowanceMs, allowanceMs: REVERT_ALLOWANCE_MS },
      'this revert took longer than the allowance the confirmation window is derived from: the window ' +
        'must be shortened or the revert made faster, or a future revert will finish after the promise ' +
        'has already been broken',
    );
  }

  /**
   * The active profile pointer is deliberately **not** moved back.
   *
   * The device now runs the previous document while the pointer still names the profile that failed.
   * Moving the pointer would silently discard the operator's edit, and they would reopen the interface
   * to find their work gone with nothing saying why. The profile is usually two fields away from
   * correct. That part of the decision stands.
   *
   * ## Correction, 2026-09-22: this used to claim the divergence was already visible
   *
   * It said "the interface honestly shows pending changes: what is stored is not what is running",
   * and that was wrong twice over. The pending-changes indicator is `apps/ui/src/lib/draft.ts`
   * comparing a **draft being edited** with the stored document — it is about unsaved work and says
   * nothing whatever about the files on disk. And after this path runs there is no draft, so it shows
   * nothing at all.
   *
   * What it cost: on 2026-09-22 six entries stood in `profile.firewall.blockedEndpoints` while
   * `/etc/wayfarer/core/config.json` held none, and the only way to learn it was to read the file and
   * the database by hand. The comment was part of what kept anyone from looking, which is why it is
   * corrected here rather than deleted.
   *
   * The comparison that actually answers it is `core/drift.ts`, and it is called a few lines above
   * this — on this path, on the failed-undo path and on the nothing-to-go-back-to path.
   */
  /**
   * The fallback, when an effect could not be restored: reboot.
   *
   * Reached when a manager was displaced and its reload was unavailable or failed. A revert that put the
   * files back and left the running state broken is the worst of both — the device looks configured and
   * is unreachable — and a reboot is the one thing that reliably makes another manager's configuration
   * take effect again, because that is how it took effect in the first place.
   *
   * Everything explaining why has already been written above: the transaction is `reverted`, the event
   * ring carries the reason, and the reload results are in it. Nothing after this line can be relied on
   * to run.
   */
  const effectUnrestored = reloads.filter((entry) => !entry.ok);
  let rebooted = false;
  if (effectUnrestored.length > 0) {
    deps.store.recordEvent({
      level: 'warn',
      kind: 'apply.revert-reboot',
      summary: 'rebooting: a displaced manager could not be asked to re-apply its own configuration',
      detail: { transaction: id, reloads },
    });
    deps.log(
      'warn',
      { transaction: id, reloads: effectUnrestored },
      'the files were restored but the effect was not; rebooting, which is the only reliable way to make ' +
        "another manager's configuration take effect again",
    );
    const result = await deps.platform.host
      .reboot(`revert of ${id} could not restore ${effectUnrestored.map((entry) => entry.manager).join(', ')}`)
      .catch((error: unknown) => ({ ok: false, detail: String(error) }));
    rebooted = result.ok;
    if (!result.ok) deps.log('error', { detail: result.detail }, 'the reboot could not be started either');
  }

  /*
   * A completed revert is where "this configuration does not work" is finally known.
   *
   * The synchronous failure path is not enough, and that gap was measured on the bench board,
   * 2026-09-20: four applies in a row each returned **HTTP 200** with `awaiting-confirm`, and each was
   * reverted a minute later by the early health check. They were read at the time as failures of
   * exactly the kind safe mode exists for — a configuration this device cannot successfully run — and
   * none of them reached the decision, because at the moment the route answered, nothing had gone wrong
   * yet.
   *
   * Correction, 2026-09-23: that reading of the four reverts is not safe. The early check's uplink
   * reading compared `operstate` with a lower-case literal `ip` never prints, so it reported every
   * uplink as carrier-less and reverted any unconfirmed windowed change with an uplink at 45 s,
   * working or not (`platform/parse/ip-json.ts#linkCarrier`). The rule placed here is still right; the
   * evidence cited for it may be four healthy changes.
   *
   * Placed here rather than in each caller so that every way a revert happens is covered by one piece of
   * code: an operator asking for it, the transient timer in its own process at the deadline, and the
   * start-up sweep. The window's health check is no longer one of them.
   */
  if (!rebooted) await enterSafeModeIfRepeated(deps, row.profileId);

  return {
    ok: true,
    target: targetKind,
    restored,
    reloads,
    rebooted,
    changedNothing,
    durationMs,
    result,
    message:
      (changedNothing
        ? 'nothing was undone: the last configuration applied on this device is the same one that just ' +
          'failed, so the device is still running it'
        : targetKind === 'recovery-profile'
          ? 'reverted to the built-in recovery profile, because nothing had ever been applied on this device'
          : 'reverted to the previously applied configuration') +
      (rebooted
        ? '; rebooting, because a displaced manager could not be asked to re-apply its own configuration'
        : ''),
  };
}

/** First letter upper-cased, for a sentence that follows another. */
function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/* ── safe mode ───────────────────────────────────────────────────────────────────────────── */

export interface SafeModeOutcome {
  entered: boolean;
  failures: number;
  reason: string | null;
  /** What the apply of the safe-mode document did, when one was attempted. */
  applied?: ReconcileResult;
  message: string;
}

/**
 * Drop into safe mode if this profile has now failed too many times in a row.
 *
 * Called **after** a failed apply rather than from inside one, for two reasons. Applying the safe-mode
 * document is itself an apply, so doing it inside the failure path would mean an apply running inside an
 * apply; and the decision belongs to whoever asked for the change, because it is an automatic action and
 * automatic actions should be visible at the level that triggered them.
 *
 * The safe-mode document is **applied, not saved**. The operator's profile stays exactly as they left
 * it, so they can correct the two fields that were wrong instead of rebuilding it — and the interface
 * shows the honest state, which is that what is stored is not what is running.
 */
/**
 * Enter safe mode if this profile keeps failing, and say nothing if it does not.
 *
 * Wrapped so the revert path can call it without caring about the outcome, and so the guard against
 * re-entering lives in one place.
 */
async function enterSafeModeIfRepeated(deps: ApplyDeps, profileId: string | null): Promise<void> {
  if (profileId === null) return;
  const outcome = await maybeEnterSafeMode(deps, profileId).catch((error: unknown) => {
    // A failure to *enter* safe mode must not mask the revert that just succeeded: the device is back,
    // which is the outcome that matters, and this is reported rather than thrown.
    deps.log('error', { profile: profileId, detail: String(error) }, 'could not evaluate safe mode');
    return null;
  });
  /*
   * Logged whether or not it entered. This is an automatic action on a device nobody is watching, so
   * "it was considered and declined" has to be auditable — otherwise the only evidence that the
   * mechanism exists at all is the day it fires.
   */
  deps.log(
    outcome?.entered === true ? 'warn' : 'info',
    { profile: profileId, failures: outcome?.failures ?? null, entered: outcome?.entered ?? false },
    outcome?.message ?? 'safe mode could not be evaluated',
  );
}

export async function maybeEnterSafeMode(deps: ApplyDeps, profileId: string): Promise<SafeModeOutcome> {
  const profile = deps.profiles.get(profileId);
  if (profile === null) {
    return { entered: false, failures: 0, reason: null, message: `no profile ${profileId}` };
  }

  const decision = safeModeDecision({
    attempts: deps.profiles.recentAttempts(profileId),
    /*
     * The profile's **revision**, not a timestamp of any kind.
     *
     * Two earlier versions of this argument were both wrong, and the second was wrong in a way the first
     * hid. It began as `document.meta.updatedAt`, which travels inside the document a client sends and
     * which nothing server-side rewrites — measured on the bench board, 2026-09-20: a `PUT` replacing the
     * whole profile left it reading the previous day, so the edit-reset never fired. It then became the
     * row's `updatedAt`, which is genuinely maintained on every write and still wrong, because the
     * *comparison* was between two wall-clock instants written at different moments on a device with no
     * clock battery — and the apply performing the comparison is the one that restarts
     * `systemd-timesyncd`. A backward step made every attempt look older than the edit, ending the run at
     * the first row, so the count was zero and safe mode was unreachable however many applies failed.
     *
     * A revision counter answers the question the code is actually asking — which configuration was this
     * an attempt at — without consulting a clock at all.
     */
    profileRevision: deps.profiles.profileRevision(profile.id) ?? 0,
  });

  if (!decision.enter) {
    return {
      entered: false,
      failures: decision.failures,
      reason: null,
      message: `${decision.failures} consecutive failure(s); safe mode needs ${SAFE_MODE_THRESHOLD}`,
    };
  }

  /*
   * Already in safe mode: do nothing.
   *
   * Entering safe mode is itself an apply, and an apply can fail and revert — which would evaluate this
   * again and try to enter safe mode from inside safe mode, for ever. The guard is the **state of what
   * is running** rather than a flag threaded through the call, because a flag is something a future
   * caller can forget to pass and the state is something the device can be asked about.
   */
  const running = deps.profiles.lastAppliedDocument();
  if (running !== null && isSafeModeOf(running as ProfileDocument, profile.document as ProfileDocument)) {
    return {
      entered: false,
      failures: decision.failures,
      reason: null,
      message: 'already running a safe-mode configuration; not entering it again',
    };
  }

  const safe = buildSafeModeDocument(profile.document as ProfileDocument);
  const planned = await planDocument(deps.pipeline, safe);

  /**
   * Recorded as a transaction, committed immediately.
   *
   * Not bookkeeping for its own sake. `lastAppliedDocument()` is the newest committed transaction, and
   * three separate things read it: the re-entry guard below, the `way safe-mode` report, and — most
   * importantly — the **revert target** of every apply that follows.
   *
   * Measured on the bench board, 2026-09-20, with safe mode applying `reconcile` directly and recording
   * nothing: the device entered safe mode correctly, and then `way safe-mode` said `in safe mode now:
   * no`, the guard against re-entering never matched, and it entered again on the next revert — and a
   * later failed apply would have reverted to the document from *before* safe mode, undoing the rescue.
   * A device that does something and does not write it down cannot reason about itself afterwards.
   *
   * Committed rather than left open because there is nothing to confirm: safe mode is not a change an
   * operator asked for, and a confirmation window on it would revert the rescue three minutes later
   * with nobody there to answer.
   */
  const transaction = deps.profiles.createTransaction({
    profileId,
    documentBefore: deps.profiles.lastAppliedDocument(),
    documentAfter: safe,
    kind: 'safe-mode',
    blastRadius: planned.classified.blastRadius,
    plan: { humanDiff: planned.classified.humanDiff, blastRadius: planned.classified.blastRadius },
  });

  /*
   * Through `applying`, not straight to a final state.
   *
   * Measured on the bench board, 2026-09-20: setting `committed` directly threw
   * `IllegalTransitionError: a transaction cannot go from "staged" to "committed"`, the error was caught
   * and logged, and the row was left `staged` for ever. Because `staged` is not a failure state it then
   * **ended the consecutive-failure walk**, so the count fell to zero and safe mode could never be
   * reached again — a rescue path that disabled itself by recording its own attempt badly.
   *
   * The machine was right and the caller was wrong, which is what it says. Walking the real lifecycle is
   * also more honest: the transaction genuinely is applying while `reconcile` runs.
   */
  deps.profiles.setTransactionState(transaction.id, 'applying', null);

  const result = await reconcile({
    platform: deps.platform,
    desired: planned.plan.desired,
    plan: planned.classified,
    /*
     * Every class, like a revert. Safe mode exists to make the device reachable, and refusing the part
     * of it that could cost access would leave the device in the state it is being rescued from.
     *
     * In practice the plan is `service` or below — it stops tunnels and drops the kill-switch, and it
     * leaves the access point, the local network and the listener alone — but that is a property of
     * what safe mode removes, not a constraint worth relying on here.
     */
    options: { classes: ['hot', 'service', 'network', 'boot'] },
    timeSyncUnit: deps.timeSyncUnit,
  });

  // Committed only when it worked. A safe mode that could not be applied must not become the document
  // the next revert aims at.
  deps.profiles.setTransactionState(
    transaction.id,
    result.applied ? 'committed' : 'failed',
    result.applied ? null : (result.error?.message ?? 'the safe-mode apply did not complete'),
  );

  deps.store.recordEvent({
    level: 'error',
    kind: 'safe-mode.entered',
    summary: decision.reason ?? 'entered safe mode',
    detail: {
      transaction: transaction.id,
      profile: profileId,
      failures: decision.failures,
      applied: result.applied,
      // Said explicitly because the distinction is the one an operator needs: their configuration is
      // untouched, and this is what the device is running instead.
      storedProfileUnchanged: true,
    },
  });
  deps.log(
    'error',
    { profile: profileId, failures: decision.failures, applied: result.applied },
    'entered safe mode: tunnels and the kill-switch are off, the access point and the local network are ' +
      'kept as configured, and the stored profile has not been modified',
  );

  return {
    entered: true,
    failures: decision.failures,
    reason: decision.reason,
    applied: result,
    message: result.applied
      ? 'safe mode is in force: every tunnel is stopped and the kill-switch is off. The access point, ' +
        'the local network and the management interface are as configured. Your profile has not been changed.'
      : `safe mode could not be applied either: ${result.error?.message ?? 'unknown'}`,
  };
}

/* ── the sweep at start-up: the only cover for power loss inside the window ──────────────── */

/**
 * Reverts a transaction left unconfirmed by a crash or a power cut.
 *
 * Runs at **every** daemon start and costs one query. The transient timer covers a daemon that dies;
 * this covers the machine dying, which no timer can. Together they mean the window is survivable by
 * anything short of the card failing.
 */
export async function sweepUnconfirmed(deps: ApplyDeps): Promise<RevertOutcome | null> {
  const open = deps.profiles.unconfirmedTransaction();
  if (open === null) return null;

  deps.log(
    'warn',
    { transaction: open.id, deadlineAt: open.deadlineAt },
    'found a transaction still inside its confirmation window at start-up: this daemon did not survive ' +
      'the window, so the change was never confirmed and is being reverted',
  );

  return await revertTransaction(
    deps,
    open.id,
    'the daemon restarted while this change was still unconfirmed, so nobody ever confirmed it',
  );
}

/**
 * The recovery document for this device, built from what the hardware reports.
 *
 * Kept here rather than in the planner because it needs the inventory, and returned as `null` when no
 * radio can host an access point — a recovery profile that cannot come up is worse than none, because
 * it looks like an answer.
 *
 * **The access-point credentials are the current profile's, not the documented defaults**, whenever
 * they are usable. Safe mode exists so the operator can reach the device; changing the network name
 * and passphrase at that exact moment does the opposite — their phone stops reconnecting, and they now
 * need the device in order to learn how to reach the device. Dropping to a published default
 * passphrase would also turn a device that may be sitting in a hotel into an open door at the moment
 * it is least supervised. The documented defaults are for a **fresh** device that has never been
 * configured, which is a different case.
 */
export async function buildRecoveryDocument(input: {
  platform: Platform;
  inventory: () => Promise<Inventory>;
  /** The active profile, if there is one with a usable access point. */
  current: ProfileDocument | null;
  fallbackSsid: string;
  fallbackPassphrase: string;
  /**
   * Interfaces currently carrying a management session.
   *
   * Passed in because the recovery profile must **not** take the radio the operator is reachable
   * through. On hardware where a radio reports `#{ managed, AP } <= 1`, turning that radio into an
   * access point ends the client association that is carrying the session — so a recovery path that
   * picked it would disconnect the operator in the act of rescuing them, and on a first-ever apply it
   * would do so while they were watching a countdown they could no longer answer.
   */
  managementInterfaces?: string[];
}): Promise<ProfileDocument | null> {
  const inventory = await input.inventory();
  const management = new Set(input.managementInterfaces ?? []);

  /**
   * A radio is only a candidate if it can host an access point **and** taking it will not end the
   * session. A radio that can do both roles at once is fine either way; an exclusive one that is
   * currently a client for the management path is not.
   */
  const carriesManagement = (radio: Inventory['radios'][number]): boolean =>
    radio.reported.interfaces.some((entry) => entry.name !== null && management.has(entry.name));

  const candidates = inventory.radios.filter((radio) => radio.derived.canHostAccessPoint.value);
  const capable =
    candidates.find(
      (radio) => !carriesManagement(radio) || radio.derived.accessPointAndClientTogether.value.supported,
    ) ??
    // Nothing else can host one. Taking the management radio is then the only way to make the device
    // reachable at all, which is still better than a recovery profile that cannot come up — but it is a
    // last resort rather than a first choice, and the ordering above is what makes that true.
    candidates[0];
  if (capable === undefined) return null;

  // 2.4 GHz, and the lowest usable channel the driver actually offers. Not a constant: the channel a
  // regulatory domain permits is read from the driver, and a list in the source would be a second
  // description of the kernel's database.
  // `channel` can be null for a frequency the driver reports without a channel number; such an entry
  // cannot be put in a hostapd configuration, so it is skipped rather than coerced to zero.
  const usable = capable.derived.channels.filter(
    (entry) => !entry.disabled && entry.band === '2.4GHz' && entry.channel !== null,
  );
  const channel = usable[0]?.channel;
  if (channel === undefined || channel === null) return null;

  const bind =
    capable.reported.bus === 'usb' && capable.reported.usbId !== null
      ? ({ by: 'phy-usb', value: capable.reported.usbId } as const)
      : ({ by: 'phy-builtin' } as const);

  const currentAp = input.current?.accessPoint ?? null;
  const currentPassphrase = extractSecret(currentAp?.passphrase);
  const keepCurrent = currentAp !== null && currentPassphrase !== null && currentAp.ssid !== '';

  return recoveryProfile({
    bind,
    ssid: keepCurrent ? currentAp.ssid : input.fallbackSsid,
    passphrase: keepCurrent ? currentPassphrase : input.fallbackPassphrase,
    /**
     * A real country where one is known, `00` only as a last resort.
     *
     * A radio's *own* domain is often `00` — the kernel saying no country has been established — while
     * the global block holds a real one. hostapd rejects `00` outright, so preferring the radio's own
     * value would hand the recovery profile a configuration that cannot start. The generator also
     * handles `00` by omitting the field, so this is belt and braces on the one document that has to
     * work.
     */
    country: realCountry(capable, inventory) ?? '00',
    channel,
    band: '2.4GHz',
  });
}

/**
 * The value of a stored secret, or null when it is absent or still a redaction marker.
 *
 * Null rather than an empty string, because an access point with an empty passphrase is an open
 * network — the one outcome a recovery path must never produce by accident.
 */
function extractSecret(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'object' && value !== null && '$secret' in value) {
    const inner = (value as { $secret: string | string[] }).$secret;
    const text = Array.isArray(inner) ? inner.join('\n') : inner;
    return text === '' ? null : text;
  }
  return null;
}

/**
 * The access-point interface among the managed ones.
 *
 * Identified by what settling means for it rather than by name, because that expectation is already
 * the fact being encoded: an interface that settles on an address alone is one something else brings
 * up, which on this device is the access point. Matching on a name prefix would break the moment a
 * role stopped being renamed — which is exactly what `pinName` made possible.
 */
function accessPointInterfaceOf(managed: { name: string; expect: string }[]): string | null {
  return managed.find((entry) => entry.expect === 'address')?.name ?? null;
}

/**
 * A usable regulatory country for this radio, or null when none is established.
 *
 * Prefers the radio's own domain, falls back to any other radio's, and treats `00` as absent
 * throughout — because `00` is the kernel reporting that no country has been established, not a
 * country. hostapd cannot express it at all.
 */
function realCountry(radio: Inventory['radios'][number], inventory: Inventory): string | null {
  const own = radio.reported.regulatory.country;
  if (own !== null && own !== '00') return own;
  for (const other of inventory.radios) {
    const country = other.reported.regulatory.country;
    if (country !== null && country !== '00') return country;
  }
  return null;
}
