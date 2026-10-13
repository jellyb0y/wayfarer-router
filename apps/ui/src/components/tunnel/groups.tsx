/**
 * **Groups**: a subscription, and the nodes it offers, chosen among by the device.
 *
 * Since schema 9 a subscription is not a source of separate tunnels; it is a group. Its members are
 * exactly what the feed offers now — a node the provider withdraws leaves, a node it adds joins — and the
 * watchdog keeps the group's traffic on one healthy member and moves it to the best other one when that
 * member fails. So the members are shown here and **edited nowhere**: every field of a member is the
 * feed's, and a control over one would be typed over by the next refresh.
 *
 * What a person decides about a group is the same as about a tunnel: its name, whether it is in use,
 * what it carries (resources), what happens when nothing in it works, and its resolver. Whether it carries
 * everything else is the egress choice on the policy card, made once.
 *
 * ## It is not the paste-a-link control, and it must not read like it
 *
 * The VLESS editor takes a link and fills one tunnel, once, here and now. A group is stored and re-read,
 * and every refresh replaces its members. The two never share a word: one *fills from a link*, the other
 * is *a feed*.
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import { readAt, useDraft } from '../../lib/draft.ts';
import { Card, CheckField, Fold, NumberField, SecretField, TextField } from '../ui/index.tsx';
import { CarrierFields } from './common.tsx';

type Group = Record<string, unknown>;

export function Groups({ document }: { document: Record<string, unknown> }): ReactElement {
  const draft = useDraft();
  const groups = (readAt(document, '/groups') as Group[] | undefined) ?? [];
  const tunnels = (readAt(document, '/tunnels') as Group[] | undefined) ?? [];

  // The watchdog's last reading of each member: healthy or not, and which one each group is on.
  const observers = useQuery({ queryKey: ['observers'], queryFn: api.observers, refetchInterval: 30_000 });
  const looked = observers.data?.observers?.find((observer) => observer.name === 'tunnel-watchdog')?.lastLooked;
  const readings = new Map((looked?.items ?? []).map((item) => [item.subject, item]));

  const add = (): void => {
    // One namespace with tunnels and members: the id becomes the group's selector tag.
    const taken = new Set([...groups, ...tunnels].map((entry) => String(entry['id'])));
    let counter = groups.length + 1;
    while (taken.has(`group-${counter}`)) counter += 1;
    draft.set('/groups', [
      ...groups,
      { id: `group-${counter}`, name: `Group ${counter}`, enabled: true, refreshHours: 1, onUnavailable: 'block', members: [] },
    ]);
  };

  return (
    <Card title="Groups">
      {groups.length === 0 ? (
        <p className="muted">No groups. A group is a subscription: its members are the nodes the feed offers.</p>
      ) : (
        <p className="muted">
          Members follow the feed on every refresh. Each group uses one healthy member and moves to the best other one when it fails.
        </p>
      )}

      {/* The list is the control for `/groups`: adding and removing write that position whole. */}
      <ol className="tunnel-list" data-pointer="/groups">
        {groups.map((group, index) => {
          const id = String(group['id']);
          const members = (group['members'] as Group[] | undefined) ?? [];
          const last = group['lastRefresh'] as Record<string, unknown> | undefined;

          return (
            <li key={id} className="tunnel-item">
              <div className="row-head">
                <span className="row-title">{String(group['name'] ?? id)}</span>
                <span className="row-badge pill">{group['enabled'] === false ? 'Off' : `${members.length} member(s)`}</span>
              </div>

              <dl className="row-fields">
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
                      : `${String(last['at'])} · ${last['ok'] === true ? `${String(last['nodeCount'])} offered` : String(last['detail'])}`}
                  </dd>
                </div>
              </dl>

              <ul className="member-list">
                {members.map((member) => {
                  const reading = readings.get(String(member['id']));
                  const selected = reading?.note?.includes('selected') === true;
                  return (
                    <li key={String(member['id'])}>
                      {String(member['name'] ?? member['id'])}
                      <span className="muted"> · {String(member['node'] ?? '')}</span>
                      <span className={reading?.state === 'healthy' ? 'ok' : 'muted'}>
                        {' · '}
                        {reading === undefined ? 'not measured yet' : reading.state}
                        {selected ? ', in use' : ''}
                      </span>
                    </li>
                  );
                })}
                {members.length === 0 ? <li className="muted">None yet: the next refresh fills them from the feed.</li> : null}
              </ul>

              <div className="row-actions">
                <button type="button" onClick={() => draft.set('/groups', groups.filter((_unused, other) => other !== index))}>
                  Remove
                </button>
              </div>

              <Fold summary="Edit">
                <TextField pointer={`/groups/${index}/name`} label="Name" value={group['name']} />
                {/*
                  * A credential, and marked as one in the schema because the token is usually inside
                  * the URL itself rather than beside it. Shown as a state and replaced, never printed.
                  */}
                <SecretField
                  pointer={`/groups/${index}/url`}
                  label="Feed address"
                  value={group['url']}
                  help="Usually carries your account token inside it, so it is kept and shown the way a password is."
                />
                <CheckField
                  pointer={`/groups/${index}/enabled`}
                  label="In use"
                  checked={group['enabled'] !== false}
                  help="Turned off, none of its members runs and it is not refreshed; the settings are kept."
                />
                <NumberField
                  pointer={`/groups/${index}/refreshHours`}
                  label="Re-read every"
                  value={group['refreshHours']}
                  min={0}
                  max={720}
                  help="Hours; zero means only when you ask."
                />
                <CarrierFields base={`/groups/${index}`} carrier={group} />
              </Fold>
            </li>
          );
        })}
      </ol>

      <div className="row-actions">
        <button type="button" onClick={add}>
          Add a group
        </button>
      </div>
    </Card>
  );
}
