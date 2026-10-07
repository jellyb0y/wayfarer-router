/**
 * The one question behind two settings: can traffic leave this device outside a tunnel?
 *
 * `policy.onAllDown` and `firewall.killSwitch` are separate fields covering separate failures, and
 * presenting them as two switches makes the operator answer the same question twice without being told
 * it is the same question. Worse, the two answers can disagree — a kill-switch with fail-open is a
 * kill-switch that does not hold when the tunnel dies, which is the failure it was turned on for.
 *
 * ## Why this is written as consequences rather than as settings
 *
 * The person choosing here is choosing between two losses, and neither is obviously right:
 *
 * * stop passing traffic, and the people using this network lose their connection with no explanation;
 * * keep passing traffic, and they lose the protection they believe they have, also with no explanation.
 *
 * A switch labelled "Kill-switch" tells them nothing about either. Nor does a warning symbol: a symbol
 * says "be careful" to somebody who has no way to know what about. So every option here states what
 * happens, in the words of somebody who has to live with it, and the default — off, fail open — is
 * stated as a consequence too rather than being silently the safe-looking one.
 *
 * The contradiction, when it exists, is a sentence in the ordinary flow of the page. Not an alert box:
 * the operator has not done anything wrong yet and is mid-decision, and a page that shouts at them
 * teaches them to click past shouting.
 */

import type { ReactElement } from 'react';
import { readAt } from '../lib/draft.ts';
import { CheckField, ChoiceField } from './ui/index.tsx';

export type AllDown = 'block' | 'direct';

export interface LeakPolicyProps {
  document: Record<string, unknown>;
}

/**
 * Whether the two fields promise opposite things.
 *
 * Pure and exported so the sentence the operator reads is testable without rendering, and so the
 * interface and the daemon's `leak_policy_contradiction` invariant can be checked against each other
 * rather than drifting into disagreeing about which pairs are legal.
 */
export function contradicts(killSwitch: boolean, onAllDown: AllDown): boolean {
  return killSwitch && onAllDown === 'direct';
}

const OPTIONS: ReadonlyArray<{ value: AllDown; title: string; consequence: string }> = [
  {
    value: 'block',
    title: 'Stop passing traffic',
    consequence: 'Everyone loses their connection until a tunnel works again, and nothing leaves unprotected.',
  },
  {
    value: 'direct',
    title: 'Keep passing traffic, unprotected',
    consequence: 'Everyone stays online, unprotected and visible on the uplink, and nobody is told.',
  },
];

export function LeakPolicy({ document }: LeakPolicyProps): ReactElement {
  const onAllDown = (readAt(document, '/policy/onAllDown') as AllDown | undefined) ?? 'block';
  const killSwitch = readAt(document, '/firewall/killSwitch') === true;

  return (
    <div className="leak-policy">
      {/*
        * Both controls carry the position they write, and that is a repair rather than a detail.
        *
        * They were hand-built inputs with no `data-pointer` — so the coverage manifest, which is
        * harvested from the rendered DOM, reported that **nothing in this interface edits
        * `/policy/onAllDown` or `/firewall/killSwitch`**. The two most consequential settings on the
        * device were invisible to the one check that asks what a person can reach, and the mechanical
        * parity comparison named them the first time it ran. The words are unchanged; only the
        * stamping is new, and `ChoiceField` is the shared control that does it.
        */}
      <ChoiceField
        pointer="/policy/onAllDown"
        label="If all fail"
        value={onAllDown}
        options={OPTIONS}
      />

      <CheckField
        pointer="/firewall/killSwitch"
        label="Kill switch"
        checked={killSwitch}
        help="Off, a crashed or unstarted tunnel passes traffic straight out and looks like a working network."
      />

      {contradicts(killSwitch, onAllDown) ? (
        <p className="choice-consequence contradiction">
          These answers contradict: blocking when the software stops cannot stop the tunnel sending out unprotected.
        </p>
      ) : null}
    </div>
  );
}
