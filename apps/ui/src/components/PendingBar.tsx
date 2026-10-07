/**
 * Saving, reviewing, applying and confirming — the one bar the editing screens share.
 *
 * ## Why it is a component now
 *
 * Tunnels, Routing and Network each carried their own copy of this markup. Three copies were already
 * the duplicate-control defect one floor up, and the rule below would have had to be written into all
 * three — which is how three copies become three copies that disagree. `lib/editing.ts` was made a
 * hook for exactly this reason; this is the same argument applied to what the hook draws.
 *
 * ## Applying is unreachable on a profile that is not running, and that is a safety property
 *
 * On the active profile the bar offers Save, Discard and Review, and Review leads to an apply inside a
 * confirmation window. On any other profile **it offers Save and Discard only.**
 *
 * The reason is what the confirmation window actually is. Its entire safety property is an operator
 * watching a countdown on the device being changed: the device applies, waits, and undoes itself
 * unless somebody who can still reach it says otherwise. A profile that is not running has no plan
 * against reality, no blast radius and no window — so a button labelled "review and apply" here would
 * blur two different acts into one word. Activating a profile and applying it are separate steps, and
 * a first-time user has already been recorded reading one as the other.
 *
 * So the bar says what is missing rather than drawing a disabled button with no explanation: a
 * control that is present and does nothing is a control somebody presses twice and then distrusts.
 */
import type { ReactElement } from 'react';
import type { useProfileEditing } from '../lib/editing.ts';
import type { ProfileTarget } from '../lib/target.ts';
import { t, tf } from '../lib/i18n.ts';
import { Card } from './ui/index.tsx';
import { EditingElsewhere } from './EditingElsewhere.tsx';
import { PlanReview } from './PlanReview.tsx';
import { ConfirmationWindow } from './ConfirmationWindow.tsx';

export function PendingBar({
  editing,
  target,
}: {
  editing: ReturnType<typeof useProfileEditing>;
  target: ProfileTarget;
}): ReactElement {
  return (
    <Card title={t('routing.pending')}>
      <p className="muted">
        {editing.changes.length === 0 ? t('routing.saved') : tf('routing.unsaved', editing.changes.length)}
      </p>

      {/*
        * Two different facts, reported separately, because they are different: unsaved edits here, and
        * a saved profile the device has not adopted. `notApplied` is a comparison against reality and
        * means nothing for a profile reality is not running, so it is only asked of the active one.
        */}
      {target.isActive && editing.notApplied ? <p className="note">{t('routing.notApplied')}</p> : null}
      {target.isActive ? null : <EditingElsewhere name={target.name ?? ''} mode="bar" />}

      <div className="row-actions">
        <button
          type="button"
          className="primary"
          disabled={editing.changes.length === 0 || editing.save.isPending}
          onClick={() => editing.save.mutate()}
        >
          {t('routing.save')}
        </button>
        <button type="button" disabled={editing.changes.length === 0} onClick={() => editing.draft.discard()}>
          {t('routing.discard')}
        </button>
        {/*
          * Absent rather than disabled. There is no plan to show for a document nothing is running,
          * so the button would have nothing to do — and a disabled control with no sentence beside it
          * reads as a fault in the panel rather than as a step that has not happened yet. The sentence
          * above says which step.
          */}
        {target.isActive ? (
          <button type="button" disabled={editing.dryRun.isPending} onClick={() => editing.dryRun.mutate()}>
            {t('routing.review')}
          </button>
        ) : null}
      </div>

      {/*
        * The window and the plan hang off the apply, which only the active profile can reach — but
        * they are drawn from the outcome rather than from the flag, so a window that is already open
        * cannot be taken off the screen by a profile being switched underneath it. An operator with a
        * countdown running must never lose the control that answers it.
        */}
      {editing.outcome?.transaction.secondsRemaining != null &&
      editing.outcome.transaction.state === 'awaiting-confirm' ? (
        // A duration, never the device's timestamp — see ConfirmationWindow's second property.
        <ConfirmationWindow
          secondsRemaining={editing.outcome.transaction.secondsRemaining}
          contact={editing.contact}
          confirmed={editing.confirmed}
          busy={editing.confirm.isPending}
          onConfirm={() => editing.confirm.mutate(editing.outcome!.transaction.id)}
        />
      ) : null}

      {editing.review ? (
        <PlanReview
          plan={editing.review}
          outcome={editing.outcome}
          error={editing.failure}
          busy={editing.apply.isPending}
          pendingChanges={editing.changes.length}
          onApply={(classes) => editing.apply.mutate(classes)}
        />
      ) : null}
    </Card>
  );
}
