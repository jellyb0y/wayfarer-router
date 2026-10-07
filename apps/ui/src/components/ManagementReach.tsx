/**
 * Where this device's own control panel can be reached from, and what each answer exposes.
 *
 * ## Why this is a choice at all
 *
 * The access point is always a management surface — a device whose panel cannot be reached from the network
 * it hosts is a device nobody can configure — and loopback always is. The question is the **other** network:
 * the one the device is a *client* of.
 *
 * At home that is the owner's own network, and reaching the panel from a laptop on it is what anybody
 * expects. On a trip it is a hotel's wireless, and then everyone else in the building is on it too. Those
 * are the same setting and opposite situations, which is exactly the kind of thing that should be a switch
 * with its consequence written down rather than a decision made once by us.
 *
 * ## What it does not offer, and why there is no setting for it
 *
 * A **tunnel** is never a management surface. Whatever is at the far end of a tunnel is not somebody this
 * device should accept management traffic from, and no configuration makes that a good idea. The proxy
 * core's own dashboard likewise stays on loopback: it has no authentication of its own and full control
 * over routing.
 *
 * ## Where it lives, and why it moved
 *
 * It was reachable only from the profile editor, which Epic E deletes with the tunnel editor — two
 * designed controls about to lose their only route, which is the defect this epic removes arriving
 * through the removal itself. It sits on **Network** now, directly under the reading that says which
 * interfaces the panel currently answers on: the reading and the setting answer halves of one question,
 * and a person who has just read where the panel answers is the person deciding where it should.
 *
 * ## The wording
 *
 * Plain sentences about what is exposed and to whom, in the same spirit as the leak policy — not a warning
 * symbol, which tells somebody to be careful without telling them of what. And it names what stands behind
 * leaving it on, because "this network is untrusted" is only actionable next to "and here is what protects
 * you anyway".
 */

import type { ReactElement } from 'react';
import { readAt, useDraft } from '../lib/draft.ts';
import { Field } from './ui/index.tsx';

export interface ManagementReachProps {
  document: Record<string, unknown>;
}

export function ManagementReach({ document }: ManagementReachProps): ReactElement {
  const draft = useDraft();
  const onUplink = readAt(document, '/services/management/onUplinkNetwork') !== false;

  return (
    <div className="management-reach">
      <p className="note">
        This device’s control panel is always reachable from <strong>the network it hosts</strong> — the
        access point clients join — and from the device itself. That cannot be turned off here: a panel you
        cannot reach from the network you were told to join is a device nobody can set up.
      </p>

      {/*
        * The label is three words and the switch carries the pointer it writes, like every other control
        * that edits the document. The consequence is not `help`: help is one short sentence where a label
        * would mislead, and this is a different sentence for each answer — what the reader is choosing
        * between rather than what the label means.
        */}
      <Field pointer="/services/management/onUplinkNetwork" label="Reachable from uplink">
        <input
          type="checkbox"
          checked={onUplink}
          onChange={(event) => draft.set('/services/management/onUplinkNetwork', event.target.checked)}
        />
      </Field>

      <p className="note">
        {onUplink ? (
          <>
            <strong>On.</strong> Anyone on the same network can open this panel and try to sign in —
            at home that is your own laptop, away from home it is the café.
          </>
        ) : (
          <>
            <strong>Off.</strong> The panel answers only on the access point and on the device itself.
            To reach it from the network this device is connected to you will need a forwarded port over
            SSH. Choose this when you do not know who else is on that network.
          </>
        )}
      </p>

      <p className="note">
        What stands behind leaving it on, rather than any assumption that the network is safe: a password is
        required, repeated wrong guesses lock that address out for fifteen minutes, and the machine API is
        <strong> off until you turn it on</strong> and needs a token you create here. Nothing about this
        setting exposes your tunnels, your credentials or the proxy’s own controls — those are never on a
        network at all.
      </p>
    </div>
  );
}
