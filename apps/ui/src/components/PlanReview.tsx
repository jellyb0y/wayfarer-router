/**
 * Plan review.
 *
 * This is the surface a person reads under time pressure, deciding whether to confirm a change that
 * might cost them the device. An unreadable diff here is a safety defect rather than a styling one,
 * so this component is finished while the rest of the interface is deliberately plain.
 *
 * Four rules it follows:
 *
 * 1. **The worst thing first.** Errors, then what the change can cost, then what will happen, then
 *    the detail. A reader who stops after two lines should have read the two that matter.
 * 2. **Consequences in words, not classes.** "network" means nothing to somebody who has not read the
 *    design; "this can make the device unreachable" does.
 * 3. **Never a file's contents.** The generated core configuration holds real credentials, so this
 *    shows paths and purposes. A review that printed the artefact would defeat redaction while
 *    looking like a safety feature.
 * 4. **A refusal names what it needs.** Nobody should be left holding a configuration with no visible
 *    reason it will not apply.
 */

import type { ReactElement } from 'react';
import type { ApplyResponse, Finding, PlanResponse } from '../lib/api.ts';
import { NoActionNotice } from './ConfirmationWindow.tsx';
import { LongValue } from './ui/index.tsx';

/** What each class means for the person reading, in their terms. */
const CONSEQUENCE: Record<PlanResponse['blastRadius'], { title: string; detail: string; tone: string }> = {
  hot: {
    title: 'Nothing restarts',
    detail: 'A running component is told about the change through its own interface. Connections continue.',
    tone: 'ok',
  },
  service: {
    title: 'Some services restart',
    detail:
      'Traffic through the affected tunnels is interrupted briefly. Wi-Fi clients keep their connection ' +
      'and their address, and this page stays reachable.',
    tone: 'ok',
  },
  network: {
    title: 'This can make the device unreachable',
    detail:
      'It changes addressing, a radio, or which interface is which. If it goes wrong you lose access to ' +
      'this page, and getting back means the device undoing it by itself.',
    tone: 'danger',
  },
  boot: {
    title: 'Takes effect after a restart',
    detail: 'Nothing changes now. The device behaves differently the next time it starts.',
    tone: 'warn',
  },
};

export interface PlanReviewProps {
  plan: PlanResponse;
  /** Present after an apply, so the same surface shows what happened. */
  outcome?: ApplyResponse | null;
  error?: { code: string; message: string; hint?: string; refused?: ApplyResponse['refused'] } | null;
  onApply?(classes?: ('hot' | 'service')[]): void;
  busy?: boolean;
  /**
   * How many edits are still unsaved.
   *
   * A plan is always computed from the **stored** active profile, because that is what an apply would
   * act on. With unsaved edits on screen the two disagree, and a review that did not say so would show
   * somebody a plan for a configuration they are no longer looking at — which is the exact failure
   * this screen exists to prevent, arriving through the screen itself.
   */
  pendingChanges?: number;
}

export function PlanReview({ plan, outcome, error, onApply, busy, pendingChanges }: PlanReviewProps): ReactElement {
  const errors = plan.findings.filter((finding) => finding.severity === 'error');
  const warnings = plan.findings.filter((finding) => finding.severity === 'warning');
  const consequence = CONSEQUENCE[plan.blastRadius];
  const refused = error?.refused ?? outcome?.refused ?? [];
  const unbound = plan.bindings.filter((binding) => binding.state !== 'bound');

  return (
    <section className="plan-review">
      {pendingChanges !== undefined && pendingChanges > 0 ? (
        <div className="panel warn">
          <h3>This plan does not include your unsaved changes</h3>
          <p>
            {pendingChanges} change{pendingChanges === 1 ? ' is' : 's are'} still only in this page. A
            plan is computed from the profile as stored, because that is what applying would act on.
            Save first, then review again.
          </p>
        </div>
      ) : null}

      {/* 1. The worst thing first. */}
      {errors.length > 0 ? (
        <div className="panel danger">
          <h3>
            This cannot be applied: {errors.length} problem{errors.length === 1 ? '' : 's'}
          </h3>
          {errors.map((finding) => (
            <FindingRow key={`${finding.code}-${finding.pointer}`} finding={finding} />
          ))}
        </div>
      ) : plan.empty ? (
        <div className="panel ok">
          <h3>Nothing to do</h3>
          <p>The device already matches this profile. Applying it again would change nothing.</p>
        </div>
      ) : (
        <div className={`panel ${consequence.tone}`}>
          <h3>{consequence.title}</h3>
          <p>{consequence.detail}</p>
        </div>
      )}

      {/* 2. Anything refused, with what it needs. Before the diff, because it changes what the diff
             means: some of what follows will not happen. */}
      {refused.length > 0 ? (
        <div className="panel warn">
          <h3>
            {refused.length} change{refused.length === 1 ? '' : 's'} will not be applied
          </h3>
          <p className="muted">
            {error?.code === 'blast_radius_not_applicable'
              ? 'Nothing has been changed. These need something this version does not have yet:'
              : 'These were left out of this apply:'}
          </p>
          <ul>
            {refused.map((entry) => (
              <li key={entry.what}>
                <code>{entry.what}</code>
                <span className="muted small"> — needs {entry.needs}</span>
              </li>
            ))}
          </ul>
          {error?.hint ? <p>{error.hint}</p> : null}
        </div>
      ) : null}

      {unbound.length > 0 ? (
        <div className="panel warn">
          <h3>Hardware this profile expects is not here</h3>
          {/* An unbound role is a state, not a broken document — a profile written on another device
              arrives this way, and the candidates are what makes it fixable rather than rejected. */}
          {unbound.map((binding) => (
            <div key={binding.role}>
              <strong>{binding.role}</strong>: {binding.state}
              {binding.reason ? <p className="muted small">{binding.reason}</p> : null}
              {binding.candidates && binding.candidates.length > 0 ? (
                <p className="muted small">Detected here: {binding.candidates.map((c) => c.label).join('; ')}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="panel warn">
          <h3>
            {warnings.length} thing{warnings.length === 1 ? '' : 's'} worth knowing
          </h3>
          {warnings.map((finding) => (
            <FindingRow key={`${finding.code}-${finding.pointer}`} finding={finding} />
          ))}
        </div>
      ) : null}

      {/* 3. What will happen, in the order it will happen. The sequence is what is being agreed to. */}
      {!plan.empty ? (
        <div className="panel">
          <h3>What will happen, in order</h3>
          <ol className="diff">
            {/*
              * Each line is cut after three lines with the whole of it one tap away.
              *
              * The prose on this panel stays long, deliberately — it is what the reader is agreeing
              * to rather than an explanation of the design. These are not that: a plan line carries
              * a value, and on the bench four of them held a 253-character domain and painted
              * **fifteen line boxes each** in a 282 px column. A sequence somebody is agreeing to
              * under a countdown, printed as sixty lines of wrapped name, is unreadable in exactly
              * the situation this panel exists for.
              */}
            {plan.humanDiff.map((line, index) => (
              <li key={`${index}-${line}`}>
                <LongValue value={line} lines={3} mono={false} label="this line" />
              </li>
            ))}
          </ol>
          <p className="muted small">
            File contents are not shown here. Generated files hold real credentials, so this page lists
            what changes and why, never what is inside.
          </p>
        </div>
      ) : null}

      {plan.notes.length > 0 ? (
        <div className="panel">
          <h3>About this device</h3>
          <ul>
            {plan.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 4. What actually happened, once it has. */}
      {outcome ? (
        <div className={`panel ${outcome.steps.every((step) => step.ok) ? 'ok' : 'danger'}`}>
          <h3>Applied — {outcome.transaction.state}</h3>
          <ol className="steps">
            {outcome.steps.map((step, index) => (
              <li key={`${index}-${step.step}`} className={step.ok ? 'ok' : 'danger'}>
                <span>{step.ok ? 'done' : 'failed'}</span> {step.step}
                <span className="muted small"> — {step.detail}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {error && error.code !== 'blast_radius_not_applicable' ? (
        <div className="panel danger">
          <h3>This apply did not finish</h3>
          <p>{error.message}</p>
          {error.hint ? <p className="muted">{error.hint}</p> : null}
        </div>
      ) : null}

      {/*
        * Read before applying, not after.
        *
        * A `network` change can take the connection this page arrived over, and once it has there is no
        * page left on which to explain what to do. So the instruction — do nothing, wait, it undoes
        * itself — has to be delivered while the reader can still see it. It sits immediately above the
        * button rather than in the consequence panel, because that is where their eyes are when they
        * decide.
        */}
      {onApply && !plan.empty && errors.length === 0 ? <NoActionNotice blastRadius={plan.blastRadius} /> : null}

      {onApply ? (
        <div className="actions">
          {/*
            * No tooltip on the disabled state. A `title` is a pointer-only affordance — on the device
            * this is designed for it never appears at all — and the reason this button is disabled is
            * already a panel at the top of this review, in full sentences. A reason that exists only
            * under a mouse is a reason most readers will never be given.
            */}
          <button
            type="button"
            disabled={busy || errors.length > 0 || plan.empty || (pendingChanges ?? 0) > 0}
            onClick={() => onApply()}
          >
            Apply
          </button>
          {/* Offered only when there is something to narrow. A partial apply must be a deliberate act,
              never something that happens because the plan turned out to contain more than expected. */}
          {refused.length > 0 && errors.length === 0 ? (
            <button type="button" disabled={busy} onClick={() => onApply(['hot', 'service'])}>
              Apply only the safe changes
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function FindingRow({ finding }: { finding: Finding }): ReactElement {
  return (
    <div className="finding">
      <p>
        <strong>{finding.message}</strong>
      </p>
      {/* The hint is part of the error contract rather than decoration: on a device where a wrong
          configuration can cost access, an error that does not say what to do instead is half an error. */}
      <p className="hint">{finding.hint}</p>
      <p className="muted small">
        <code>{finding.pointer || '(the whole document)'}</code> · {finding.code}
      </p>
    </div>
  );
}
