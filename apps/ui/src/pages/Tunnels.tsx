/**
 * Tunnels answers one question: **what connections exist, which is carrying, what breaks if one dies?**
 *
 * This is the screen the epic exists for. What stood here was a text field wanting a command line
 * with flags beside another holding an entire client configuration as a string — in the owner's
 * words, *you literally have to write commands for launching daemons into the config for every
 * tunnel; that is code too, and it is not friendly.* A wrong flag failed silently, which is the
 * worst property a configuration field can have.
 *
 * So there is one designed screen per catalogue entry, three of them, each named for **what the
 * owner holds**: an `.ovpn` file; an `.ovpn` file plus the entry points that front it; a link or a
 * subscription. Never for the program this device starts to run it.
 *
 * ## Fields that had never had a control, and are here
 *
 * `resources` — what the tunnel exists to reach, and the only real leak path found in this epic when
 * the address ranges are missing. The obfuscation entry points — several per tunnel, five of whose
 * credentials left the bench in a redacted export because no code and no screen ever descended into
 * the list.
 *
 * There was a third, `probe` — what to fetch *through* the tunnel to decide it works. It was removed on
 * 2026-09-24 with the profile field: its own help text advised giving a tunnel "something behind it",
 * and a guard that fetched one of `partner`'s own resources blocked every destination behind it when that
 * one server closed a port. A tunnel's health is now asked of its protocol; the list below shows it.
 *
 * ## What happens when a tunnel cannot carry its traffic belongs here
 *
 * Three questions, at three scales, and all of them are on this screen because all of them are about
 * tunnels. Per tunnel: `onUnavailable`, inside each tunnel's own editor. Across the alternatives:
 * `FailoverPolicy` — which one is preferred, which are parked, and how hard a tunnel has to fail
 * before it is dropped. For the device, when none of them is healthy: `LeakPolicy`, which used to sit
 * in the profile editor this change deletes.
 *
 * The one thing the person deciding any of the three needs is the list of tunnels it is about, and
 * that list is directly above all of them. A screen called *Failover* would have been an eighth
 * screen answering half of the question this one already asks.
 *
 * ## One mechanism for saving, as everywhere else
 *
 * The bar, the plan, the apply and the confirmation window come from `lib/editing.ts`. Routing,
 * Network, Settings and this screen call the same hook. A second mechanism for the same act is the
 * duplicate-control defect one floor up.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TUNNEL_PROTOCOLS, TUNNEL_PROTOCOL_TITLES, type TunnelProtocol } from '@wayfarer/schemas';
import { ApiFailure, api, profileApi } from '../lib/api.ts';
import { readAt, useDraft } from '../lib/draft.ts';
import { useProfileEditing } from '../lib/editing.ts';
import { t, tf } from '../lib/i18n.ts';
import { Card, CheckField, Fold, Screen } from '../components/ui/index.tsx';
import { FailoverPolicy } from '../components/FailoverPolicy.tsx';
import { LeakPolicy } from '../components/LeakPolicy.tsx';
import { PendingBar } from '../components/PendingBar.tsx';
import { useProfileTarget } from '../lib/target.ts';
import {
  blankTunnel,
  protocolTitle,
  TunnelCommonFields,
  TunnelEditor,
  type Tunnel,
} from '../components/tunnel/index.tsx';
import { Subscriptions } from '../components/tunnel/subscriptions.tsx';

export function Tunnels(): ReactElement {
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: profileApi.list });
  const target = useProfileTarget();
  const editing = useProfileEditing(target.id);
  const document = editing.draft.draft;

  if (profiles.isLoading) return <Screen title={t('nav.tunnels')}><p className="muted">{t('common.loading')}</p></Screen>;
  if (target.id === undefined) {
    return (
      <Screen title={t('nav.tunnels')}>
        <p className="note">{t('routing.noProfile')}</p>
      </Screen>
    );
  }
  if (document === null) return <Screen title={t('nav.tunnels')}><p className="muted">{t('common.loading')}</p></Screen>;

  return (
    <Screen title={t('nav.tunnels')}>
      <TunnelListCard document={document} running={target.isActive} />

      {/*
        * Where the tunnels above come from, directly under them. Not the same act as the VLESS
        * editor's "fill from a link": that parses one link into one tunnel once, and this is stored
        * and re-read, rewriting the tunnels it owns on every refresh. The two never share a word.
        */}
      <Subscriptions document={document} />

      {/*
        * The device-wide half of the same question, directly under the list it is about. Its own
        * two fields are `/policy/onAllDown` and `/firewall/killSwitch`, which are not tunnel fields —
        * which is why it is a component of its own and not part of an editor.
        */}
      <Card title={t('tunnels.allDown')}>
        <LeakPolicy document={document} />
        {/*
          * `firewall.ntpBypass` is on this card and not on Network, because it is the same question
          * these two fields ask: may something leave this device outside a tunnel? It is named here
          * for what it lets out rather than for the protocol it names, and the consequence is the
          * reason it exists at all — this board has no clock battery, and a tunnel whose transport
          * authenticates on a timestamp cannot come up while the clock is wrong.
          */}
        <CheckField
          pointer="/firewall/ntpBypass"
          label="Let time out"
          checked={readAt(document, '/firewall/ntpBypass') === true}
          help="Time synchronisation leaves outside the tunnel; without it a wrong clock stops every tunnel."
        />

        {/*
          * The rest of the same question, one step earlier: `LeakPolicy` above answers what happens
          * when **no** alternative is healthy, and these answer which one is chosen while some are,
          * and how the device decides one has stopped being healthy at all.
          *
          * Eleven positions, and until now all eleven were reachable from the API and from nothing
          * else. They are folds here rather than an eighth screen because the list they are about is
          * directly above them — the same argument that put the access point's settings under its
          * readings on Network.
          */}
        <FailoverPolicy document={document} />
      </Card>

      <PendingBar editing={editing} target={target} />
    </Screen>
  );
}

/**
 * `running` is whether the profile on this screen is the one the device runs. Reconnecting is offered
 * only then: a tunnel in a profile being prepared may share an id with a running one, and the button
 * would restart a tunnel other than the one it is drawn beside.
 */
function TunnelListCard({ document, running }: { document: Record<string, unknown>; running: boolean }): ReactElement {
  const draft = useDraft();
  const tunnels = (readAt(document, '/tunnels') as Tunnel[] | undefined) ?? [];
  /*
   * A tunnel's health is the watchdog's last reading of it, asked of its own protocol. It used to be
   * read off the document — "measured" when the profile named a probe URL — which described the profile
   * rather than the tunnel, and after 2026-09-24 there is no such field to read.
   */
  const observers = useQuery({ queryKey: ['observers'], queryFn: api.observers, refetchInterval: 30_000 });
  const looked = observers.data?.observers?.find((observer) => observer.name === 'tunnel-watchdog')?.lastLooked;
  const readings = new Map((looked?.items ?? []).map((item) => [item.subject, item]));
  const healthOf = (id: unknown): string => {
    const item = typeof id === 'string' ? readings.get(id) : undefined;
    if (item === undefined) return t('tunnels.healthUnread');
    return item.method === undefined ? item.state : `${item.state}, by ${item.method}`;
  };
  /*
   * "Since" is worked out here, on the viewer's clock, from two monotonic durations the device sends —
   * how long it had been falling through at the reading, and how old the reading is. The board has no
   * RTC, so a time of day from it could be days out.
   */
  const fallingSince = (id: unknown): string | null => {
    const item = typeof id === 'string' ? readings.get(id) : undefined;
    if (item?.fallingThroughSeconds === undefined) return null;
    const seconds = item.fallingThroughSeconds + (looked?.ageSeconds ?? 0);
    return new Date(Date.now() - seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <Card title={t('tunnels.list')}>
      {tunnels.length === 0 ? (
        <p className="note">{t('tunnels.none')}</p>
      ) : (
        <p className="muted">{t('tunnels.listIs')}</p>
      )}

      {/*
        * Blocks rather than `RowList`, because a tunnel carries an editor and a row does not. The
        * editor is a `Fold` — the same mechanism as every other advanced setting on every screen,
        * never a second one — and that is also what makes the 360 px bench able to reach it: the
        * bench opens every fold, and a control behind a component's own open/closed state is a
        * control nothing measures.
        */}
      {/*
        * The list carries the pointer for `/tunnels`, because adding and removing write that position
        * as a whole and this element is the control that does it.
        *
        * Two positions on a tunnel deliberately have no control at all, and neither is an oversight.
        * `id` is an identity a routing rule may name, so editing it would silently detach every rule
        * pointing at this tunnel. `derivedFrom` is a mark the refresh owns; it is shown on the row and
        * never typed.
        *
        * `protocol` was in that list and does not belong in it. It is not a field nobody fills — it is
        * a field filled **once, by the add control below**, and changing it afterwards would pair one
        * catalogue entry's literal with another's configuration, which is precisely the shape the
        * schema's union was written to make unstateable. So the position is covered where the choice is
        * actually made, and the add control carries its pointer.
        */}
      <ol className="tunnel-list" data-pointer="/tunnels">
        {tunnels.map((tunnel, index) => (
          <li key={String(tunnel['id'] ?? index)} className="tunnel-item">
            <div className="row-head">
              <span className="row-title">{String(tunnel['name'] ?? tunnel['id'] ?? '')}</span>
              <span className="row-badge pill">{protocolTitle(tunnel['protocol'])}</span>
            </div>

            <dl className="row-fields">
              <div className="row-field">
                <dt>{t('tunnels.carries')}</dt>
                <dd>{tunnel['role'] === 'resource' ? t('tunnels.roleResource') : t('tunnels.roleAlternative')}</dd>
              </div>
              <div className="row-field">
                <dt>{t('tunnels.state')}</dt>
                <dd>{tunnel['enabled'] === false ? t('tunnels.off') : t('tunnels.on')}</dd>
              </div>
              <div className="row-field">
                <dt>{t('tunnels.health')}</dt>
                <dd>{healthOf(tunnel['id'])}</dd>
              </div>
              {tunnel['derivedFrom'] === undefined ? null : (
                <div className="row-field">
                  <dt>{t('tunnels.from')}</dt>
                  {/*
                    * Stated on the row rather than only inside the editor: a refresh of that
                    * subscription replaces this tunnel, so an edit made here is an edit with an expiry
                    * date, and somebody about to make one should know before they open it.
                    */}
                  <dd>{t('tunnels.fromSubscription')}</dd>
                </div>
              )}
            </dl>

            {fallingSince(tunnel['id']) === null ? null : (
              <p className="note bad" role="alert">
                {tf('tunnels.fallingThrough', fallingSince(tunnel['id'])!)}
              </p>
            )}

            <div className="row-actions">
              {/*
                * Only beside a tunnel the watchdog has a reading for, which is a tunnel the running
                * configuration has. One a person has just added in the draft has nothing to restart yet.
                */}
              {running && typeof tunnel['id'] === 'string' && readings.has(tunnel['id']) ? (
                <TunnelRestart id={tunnel['id']} />
              ) : null}
              <button
                type="button"
                onClick={() => draft.set('/tunnels', tunnels.filter((_unused, other) => other !== index))}
              >
                {t('tunnels.remove')}
              </button>
            </div>

            <Fold summary={t('tunnels.edit')}>
              <TunnelCommonFields index={index} tunnel={tunnel} />
              <TunnelEditor index={index} tunnel={tunnel} />
            </Fold>
          </li>
        ))}
      </ol>

      {/*
        * The catalogue in the owner's own words, derived from it rather than written out again, so
        * the list on this screen cannot disagree with the list the device runs.
        */}
      <Fold summary={t('tunnels.add')} count={TUNNEL_PROTOCOLS.length}>
        <p className="muted field-help">{t('tunnels.addIs')}</p>
        {/*
          * Stamped with `/tunnels/-/protocol`, because this **is** the control that fills it.
          *
          * The tempting alternative was to exclude the position in the schema, and it would have been
          * a lie told to make a check quiet: a person genuinely chooses between three catalogue
          * entries here, and the annotation records where a value comes from rather than which shape
          * of control supplies it. A choice made by pressing one of three buttons is still a choice.
          */}
        <div className="row-actions" data-pointer="/tunnels/-/protocol">
          {TUNNEL_PROTOCOLS.map((protocol) => (
            <button
              key={protocol}
              type="button"
              onClick={() => draft.set('/tunnels', [...tunnels, blankTunnel(protocol, tunnels)])}
            >
              {TUNNEL_PROTOCOL_TITLES[protocol]}
            </button>
          ))}
        </div>
      </Fold>
    </Card>
  );
}

/**
 * Reconnecting one tunnel by hand.
 *
 * It exists because a path can break **behind** a live peer: measured on the bench board on
 * 2026-10-09, `office` kept its keepalive and its gateway while one office host stopped answering
 * through it, so neither OpenVPN, systemd nor the watchdog had any reason to restart it. A reconnect
 * landed on another of its servers and the host answered again.
 *
 * One tap, unlike switching off: nothing is lost that the tunnel does not get back by itself within
 * seconds. The answer is read for `restarted`, not for the status — the device answers 200 for a
 * restart whose unit did not come back — and the watchdog reading is asked for again, because that
 * is where "did it connect" is answered.
 */
function TunnelRestart({ id }: { id: string }): ReactElement {
  const queries = useQueryClient();
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const restart = useMutation({
    mutationFn: () => api.restartTunnel(id),
    retry: false,
    onSuccess: (answer) => {
      setOutcome(answer.restarted ? { ok: true, text: t('tunnels.restartDone') } : { ok: false, text: answer.message });
      void queries.invalidateQueries({ queryKey: ['observers'] });
    },
    onError: (error: unknown) => {
      const text = error instanceof ApiFailure ? error.error.message : error instanceof Error ? error.message : String(error);
      setOutcome({ ok: false, text });
    },
  });
  return (
    <>
      <button
        type="button"
        title={t('tunnels.restartIs')}
        disabled={restart.isPending}
        onClick={() => {
          setOutcome(null);
          restart.mutate();
        }}
      >
        {restart.isPending ? t('tunnels.restarting') : t('tunnels.restart')}
      </button>
      {outcome === null ? null : (
        <p className={outcome.ok ? 'note' : 'note bad'} role="status">
          {outcome.text}
        </p>
      )}
    </>
  );
}

/*
 * `protocolTitle` was correct here and copied incorrectly onto Routing, which is the shape the
 * duplicate-control defect takes in code rather than on a screen. It lives in `components/tunnel`
 * now, beside the map it reads and the editors that map joins to the catalogue.
 */
