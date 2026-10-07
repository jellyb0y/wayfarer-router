/**
 * The notice that the profile being edited is not the one the device is running.
 *
 * It is said in two places and it is **one component**, for the reason every other shared renderer
 * here is shared: two copies are two copies that drift, and this pair would drift in the worst
 * possible direction — a shell that stops warning while the bar still refuses to apply reads as a
 * broken button rather than as a profile that is not running.
 *
 * * `shell` — above every screen, with the way back beside it. It carries a link because a sentence a
 *   reader has to act on by remembering where the choice was made is a sentence that gets ignored.
 * * `bar` — in the pending bar, where it explains **which act is missing and why**. Applying is not
 *   merely unavailable here: a profile the device is not running has no plan against reality, no
 *   blast radius, and therefore no confirmation window — and the window is the entire safety property
 *   of applying. Reusing "review and apply" would blur activating with applying, which are two acts.
 *
 * Both carry the profile's name, which is the value that breaks a layout: profile names are typed by
 * people who do not put spaces in them, and 64 characters with no break opportunity is the case this
 * is measured against at 360 px. **It did not fit**, and the 360 px bench is what said so — the first
 * draft of these two lines pushed the page to 504 px wide.
 *
 * The fix is `overflow-wrap: anywhere`, which is the one place in this interface where wrapping a long
 * value is the right answer rather than the defect rule 6 exists to stop. The rule is about values
 * whose meaning a break destroys — an address split across two lines reads as two addresses, a
 * fingerprint broken anywhere reads as a different fingerprint — and those are truncated with a copy
 * control instead. A profile's *name* is a label, nobody retypes it, and the alternative here is
 * worse in the exact way that matters: truncating it hides which profile is being edited, which is
 * the entire content of the sentence.
 */
import type { ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import { t, tf } from '../lib/i18n.ts';

export function EditingElsewhere({ name, mode }: { name: string; mode: 'shell' | 'bar' }): ReactElement {
  if (mode === 'bar') return <p className="note editing-note">{tf('editing.savingOnly', name)}</p>;
  return (
    <div className="note editing-elsewhere editing-note">
      <span>{tf('editing.elsewhere', name)}</span>
      <NavLink to="/settings">{t('editing.backToActive')}</NavLink>
    </div>
  );
}
