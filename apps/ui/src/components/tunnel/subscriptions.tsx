/**
 * **Where tunnels come from**: the feeds this device re-reads on a schedule.
 *
 * It is on the tunnel screen and not in Settings, and that is not a convenience. A subscription is
 * the *origin* of tunnels — a tunnel already carries `derivedFrom` pointing back at one, and the
 * badge saying "a refresh replaces it" is this section's other side. Listed among the device's other
 * settings it would be a list of URLs explaining nothing.
 *
 * ## It is not the paste-a-link control, and it must not read like it
 *
 * The VLESS editor takes a link and fills one tunnel, once, here and now. A subscription is stored
 * and re-read, and every refresh rewrites the tunnels it owns. Somebody who cannot tell those apart
 * will paste a subscription into a tunnel and wonder why it never updates, or store a one-off link
 * and find a tunnel he edited replaced overnight. So the two never share a word: one *fills from a
 * link*, the other is *a feed*, and this section says what a refresh does to what it owns.
 *
 * ## Why these fields had no editor
 *
 * Found by the mechanical parity check rather than by a person, which is the first time in this epic
 * that happened. The device parses a pasted link once and stores the result; the refresh interval,
 * the enabled flag and the URL itself then live in the profile with nothing drawing them. A provider
 * that changes its URL, or an owner who wants the automatic refresh to stop, had exactly one door: a
 * write to the profile through the API. That is the same shape as the three tunnel fields this
 * screen was built for — **not a field somebody decided to hide, but a field whose editor was never
 * written, because no task owned the screen it belonged on.**
 */
import type { ReactElement } from 'react';
import { readAt, useDraft } from '../../lib/draft.ts';
import { Card, Fold, NumberField, SecretField, TextField, CheckField } from '../ui/index.tsx';
import type { Tunnel } from './common.tsx';

type Subscription = Record<string, unknown>;

export function Subscriptions({ document }: { document: Record<string, unknown> }): ReactElement {
  const draft = useDraft();
  const subscriptions = (readAt(document, '/subscriptions') as Subscription[] | undefined) ?? [];
  const tunnels = (readAt(document, '/tunnels') as Tunnel[] | undefined) ?? [];

  const add = (): void => {
    const taken = new Set(subscriptions.map((entry) => String(entry['id'])));
    let counter = subscriptions.length + 1;
    while (taken.has(`subscription-${counter}`)) counter += 1;
    draft.set('/subscriptions', [
      ...subscriptions,
      { id: `subscription-${counter}`, name: `Feed ${counter}`, enabled: true, refreshHours: 24 },
    ]);
  };

  return (
    <Card title="Where tunnels come from">
      {subscriptions.length === 0 ? (
        <p className="muted">
          No feeds. Every tunnel above was written here by hand, and nothing replaces one on its own.
        </p>
      ) : (
        <p className="muted">Re-read on a schedule. A refresh replaces the tunnels a feed created.</p>
      )}

      {/* The list is the control for `/subscriptions`: adding and removing write that position whole. */}
      <ol className="tunnel-list" data-pointer="/subscriptions">
        {subscriptions.map((subscription, index) => {
          const id = String(subscription['id']);
          /*
           * The other side of the badge on a tunnel row. Counted from the tunnels themselves rather
           * than from anything the feed reports, because what matters to somebody about to remove a
           * feed is how many tunnels in *this* document go with it.
           */
          const derived = tunnels.filter(
            (tunnel) => (tunnel['derivedFrom'] as Record<string, unknown> | undefined)?.['subscription'] === id,
          ).length;
          const last = subscription['lastRefresh'] as Record<string, unknown> | undefined;

          return (
            <li key={id} className="tunnel-item">
              <div className="row-head">
                <span className="row-title">{String(subscription['name'] ?? id)}</span>
                <span className="row-badge pill">{subscription['enabled'] === false ? 'Paused' : 'Refreshing'}</span>
              </div>

              <dl className="row-fields">
                <div className="row-field">
                  <dt>Tunnels</dt>
                  <dd>
                    {derived === 0
                      ? 'None in this profile'
                      : `${derived} above — removing this feed leaves them, and nothing refreshes them again`}
                  </dd>
                </div>
                <div className="row-field">
                  <dt>Last read</dt>
                  {/*
                    * Three states, and the empty one is a sentence rather than a blank. "Never read
                    * here" is a fact about this device; a profile carried from another board arrives
                    * honest about it, and a dash would read as a failure nobody reported.
                    */}
                  <dd>
                    {last === undefined
                      ? 'Never, on this device'
                      : `${String(last['at'])} · ${last['ok'] === true ? `${String(last['nodeCount'])} found` : String(last['detail'])}`}
                  </dd>
                </div>
              </dl>

              <div className="row-actions">
                <button
                  type="button"
                  onClick={() =>
                    draft.set('/subscriptions', subscriptions.filter((_unused, other) => other !== index))
                  }
                >
                  Remove
                </button>
              </div>

              <Fold summary="Edit">
                <TextField pointer={`/subscriptions/${index}/name`} label="Name" value={subscription['name']} />
                {/*
                  * A credential, and marked as one in the schema because the token is usually inside
                  * the URL itself rather than beside it. Shown as a state and replaced, never printed.
                  */}
                <SecretField
                  pointer={`/subscriptions/${index}/url`}
                  label="Feed address"
                  value={subscription['url']}
                  help="Usually carries your account token inside it, so it is kept and shown the way a password is."
                />
                <CheckField
                  pointer={`/subscriptions/${index}/enabled`}
                  label="Refreshing"
                  checked={subscription['enabled'] !== false}
                  help="Paused, the tunnels it made stay exactly as they are and stop following the provider."
                />
                <NumberField
                  pointer={`/subscriptions/${index}/refreshHours`}
                  label="Re-read every"
                  value={subscription['refreshHours']}
                  min={0}
                  max={720}
                  help="Hours; zero means only when you ask."
                />
              </Fold>
            </li>
          );
        })}
      </ol>

      <div className="row-actions">
        <button type="button" onClick={add}>
          Add a feed
        </button>
      </div>
    </Card>
  );
}
