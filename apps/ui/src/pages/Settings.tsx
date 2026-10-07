/**
 * Settings answers one question: **password, profiles, device.**
 *
 * The seventh screen, and the one that collects what used to be four separate destinations —
 * Profiles, Devices, Password, and the device inventory that sat folded on Status because there was
 * nowhere else to put it. Each of those was one tap away from the others and none of them was the
 * thing anybody arrived looking for.
 *
 * ## Three things that are not on this screen, each for a different reason
 *
 * **Device name and time servers.** `GET /api/system` is read-only and there is no write route; there
 * is no time-server field in the profile schema at all. Neither the interface nor the API can set
 * them, so nothing is configurable in one place and not the other — parity is satisfied, and adding
 * them would be new capability rather than the removal of an asymmetry. Recorded in
 * [13-plan](../../../../docs/13-plan.md).
 *
 * **Factory reset.** Deliberately not in the API. The panel answers on the wire, on the access point
 * and on the joined network, behind a short password that is published documentation; the one action
 * with no undo should not be one request away from anybody who can reach either network. It stays a
 * command that requires being on the device.
 *
 * **Duplicating a profile.** The reasoning is in [08-ui](../../../../docs/08-ui.md) and it is not an
 * unfinished control: a copy assembled in the browser has to pull every credential through the page,
 * and a button labelled "duplicate" turns the one operation that deliberately needs a separate scope
 * and writes a warning to the journal into an unnamed routine. Copying belongs inside the store, where
 * nothing travels, and that is a route this device does not have.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiFailure, api, profileApi, type MissingSecret, type StatusResponse } from '../lib/api.ts';
import { useProfileEditing } from '../lib/editing.ts';
import { pendingChanges, useDraft } from '../lib/draft.ts';
import { useChosenProfile, useProfileTarget } from '../lib/target.ts';
import { t, tf } from '../lib/i18n.ts';
import { Card, LongValue, RowList, Screen, type Row } from '../components/ui/index.tsx';
import { ConfirmationWindow } from '../components/ConfirmationWindow.tsx';
import { PlanReview } from '../components/PlanReview.tsx';
import { DeviceFold } from '../components/DeviceFold.tsx';
import { ProfileIdentityEditor } from '../components/ProfileFields.tsx';
import { DeviceList } from '../components/DeviceList.tsx';
import { PowerOffCard } from '../components/PowerOff.tsx';
import { TokensCard } from '../components/TokensCard.tsx';
import { ARMING_MS } from '../lib/arming.ts';

export function Settings({ live }: { live: StatusResponse | null }): ReactElement {
  const fetched = useQuery({ queryKey: ['status'], queryFn: api.status, enabled: live === null });
  const target = useProfileTarget();
  const editing = useProfileEditing(target.id);

  return (
    <Screen title={t('nav.settings')}>
      <PasswordCard />
      <TokensCard />
      <ProfilesCard />

      {/*
        * The profile's own name and note, which had no control anywhere once the old editor was
        * deleted — and which belong beside the list where that name is read rather than on a screen
        * about the network. They are the only two positions in the profile document this screen
        * writes; everything else on it (the password, a peer's token, a new profile's name) is not a
        * position in that document at all and carries no pointer, which a test asserts by naming the
        * two rather than counting to zero.
        *
        * Save and discard are the same hook as everywhere else; the bar below already carries them.
        */}
      {editing.draft.draft === null ? null : (
        <Card title={target.isActive ? t('settings.thisProfile') : tf('editing.elsewhere', target.name ?? '')}>
          <ProfileIdentityEditor document={editing.draft.draft} />
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
          </div>
        </Card>
      )}

      {/*
        * Activating a profile records a choice; the device keeps running what it was running until a
        * plan is applied. So the screen that activates is the screen that has to be able to finish the
        * act — otherwise the one control this screen adds ends in "now go and find the other screen",
        * which is how this product came to be configurable through the API alone.
        *
        * It is the same mechanism Routing uses, not a copy of it: `useProfileEditing` is a hook for
        * exactly this reason. Save and discard are absent because nothing here edits the document.
        */}
      {/*
        * Only ever about the profile the device is running. `notApplied` is a comparison between a
        * stored document and reality, and reality is not running the others — so on a profile that is
        * merely being prepared this card would be reporting a difference that is the whole point of
        * the profile, and offering the one act that profile must not reach.
        */}
      {target.isActive && (editing.notApplied || editing.review !== null || editing.outcome !== null) ? (
        <Card title={t('settings.notApplied')}>
          <p className="muted">{t('settings.notAppliedHelp')}</p>
          <div className="row-actions">
            <button type="button" disabled={editing.dryRun.isPending} onClick={() => editing.dryRun.mutate()}>
              {t('routing.review')}
            </button>
          </div>

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
      ) : null}

      <DeviceFold status={live ?? fetched.data ?? null} document={editing.draft.draft} />
      <DeviceList />
      {/*
        * Last, and on this screen rather than on Status: it is the one act here that acts on the whole
        * device and cannot be undone from the panel, and Status answers "is it working" — a question
        * nobody should be one tap from ending. Below both folds so that a thumb scrolling for the
        * inventory does not land on it.
        */}
      <PowerOffCard />
    </Screen>
  );
}

/* ── password ────────────────────────────────────────────────────────────────────────────── */

/**
 * Changing the password, by choice.
 *
 * **The default-password row is information and nothing else.** It once gated the whole API, and the
 * owner removed that gate: the default is short on purpose and changing it is never forced. The fact
 * is worth reporting, so it is reported — as a row in a card, beside the version and the uptime in
 * kind. Not a banner, not an alarm colour, and nothing on this screen is disabled by it.
 *
 * That restraint is the point. A polite reminder turns quietly back into compulsion when nobody
 * decided it should, and this project has already deleted one.
 */
function PasswordCard(): ReactElement {
  const system = useQuery({ queryKey: ['system'], queryFn: api.system });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setChanged(true);
      setError(null);
      setCurrent('');
      setNext('');
    },
    onError: (failure: unknown) =>
      setError(failure instanceof ApiFailure ? failure.error.message : t('common.error')),
  });

  return (
    <Card title={t('settings.password')}>
      <dl className="row-fields">
        <div className="row-field">
          <dt>{t('settings.defaultPassword')}</dt>
          <dd>
            {system.data === undefined
              ? t('common.unknown')
              : system.data.setupComplete
                ? t('settings.defaultChanged')
                : t('settings.defaultInPlace')}
          </dd>
        </div>
      </dl>

      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          change.mutate();
        }}
      >
        <label>
          {t('password.current')}
          <input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} />
        </label>
        <label>
          {t('password.new')}
          <input type="password" value={next} minLength={12} onChange={(event) => setNext(event.target.value)} />
        </label>
        {/* The one thing the labels cannot say, and the reason the button is disabled. */}
        <p className="muted">{t('password.rule')}</p>
        {error ? <p className="note bad">{error}</p> : null}
        {changed ? <p className="note ok">{t('password.changed')}</p> : null}
        <div className="row-actions">
          <button
            className="primary"
            type="submit"
            disabled={current === '' || next.length < 12 || change.isPending}
          >
            {t('password.submit')}
          </button>
        </div>
      </form>
    </Card>
  );
}

/* ── profiles ────────────────────────────────────────────────────────────────────────────── */

/**
 * Profiles: the list, and the actions on a whole document.
 *
 * Export and import are the interesting half. A redacted export is the sharing format, and an import
 * of one is **accepted with its gaps listed** rather than rejected — the structure is the valuable
 * part and it transfers, so the gaps become explicit instead of hidden. A profile with a gap cannot be
 * activated, and the refusal names the fields.
 *
 * **Activation is not an apply.** Making a profile active records the choice; the device keeps running
 * what it was running until a plan is reviewed and applied. The button says so, because a person who
 * reads "active" as "running" has been told the opposite of what happened — and that exact confusion
 * is on record here from a first-time user.
 */
function ProfilesCard(): ReactElement {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: profileApi.list });
  const target = useProfileTarget();
  const choose = useChosenProfile((state) => state.choose);
  const draft = useDraft();
  /*
   * Whether the draft currently open has edits nobody has saved.
   *
   * Switching profiles replaces the draft, and a replacement is a silent loss: the person who picks
   * another profile with six unsaved changes behind them does not get a chance to notice. So the
   * chooser refuses while there are any, and **names the reason** rather than being a control that
   * does nothing — the same shape as the plan that stops and names the file rather than writing over
   * another manager's interface.
   */
  const unsaved = pendingChanges(draft.baseline, draft.draft).length;
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [imported, setImported] = useState<{ name: string; missing: MissingSecret[]; migratedFrom: number } | null>(
    null,
  );
  /**
   * The profile whose delete control is in its confirming state, and when it entered it.
   *
   * The instant matters as much as the identity. A confirmation that the **same gesture** can answer is
   * not a confirmation: a double tap is an ordinary movement on a phone — it is how people zoom, and how
   * they recover from a tap they think missed — and a two-step control with no floor between the steps
   * passes both of them without the reader ever seeing the second label. So the confirming state refuses
   * anything that arrives within `ARMING_MS`, which is long enough to break a double tap and short
   * enough that a person who meant it does not notice.
   */
  const [armed, setArmed] = useState<{ id: string; at: number } | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['profiles'] });
  };

  const create = useMutation({
    mutationFn: () => profileApi.create(name.trim() === '' ? t('settings.newProfile') : name.trim()),
    onSuccess: () => {
      setName('');
      setFailure(null);
      setMessage(t('settings.created'));
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const activate = useMutation({
    mutationFn: (id: string) => profileApi.activate(id),
    onSuccess: () => {
      setFailure(null);
      setMessage(t('settings.activated'));
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => profileApi.remove(id),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const download = async (id: string, withSecrets: boolean): Promise<void> => {
    setFailure(null);
    try {
      // Narrowed by the call rather than by inspecting the result: the two routes return different
      // shapes, and `in` on a union does not narrow the property's own type.
      const result = withSecrets ? await profileApi.exportFull(id) : await profileApi.exportRedacted(id);
      await navigator.clipboard?.writeText(JSON.stringify(result.document, null, 2)).catch(() => undefined);
      const leaving = withSecrets ? (result as Awaited<ReturnType<typeof profileApi.exportFull>>).leavingInClear : [];
      if (withSecrets && leaving.length > 0) {
        // The last check is a human: the rule that finds secrets in a protocol nobody has annotated
        // cannot be complete, so a full export says what is leaving in clear before it is used.
        setMessage(tf('settings.exportedLeaking', leaving.length, leaving.map((entry) => entry.field).join(', ')));
      } else {
        setMessage(withSecrets ? t('settings.exportedFull') : t('settings.exportedRedacted'));
      }
    } catch (error) {
      setFailure(describe(error));
    }
  };

  const importFromClipboard = async (): Promise<void> => {
    setFailure(null);
    setImported(null);
    try {
      const text = await navigator.clipboard.readText();
      const report = await profileApi.import(JSON.parse(text));
      setImported({ name: report.name, missing: report.missingSecrets, migratedFrom: report.migratedFrom });
      refresh();
    } catch (error) {
      setFailure(describe(error));
    }
  };

  const rows: Row[] = (profiles.data?.profiles ?? []).map((profile) => ({
    id: profile.id,
    title: profile.name,
    badge: profile.active ? <span className="pill ok">{t('settings.active')}</span> : undefined,
    fields: [
      ...(profile.description === undefined || profile.description === null
        ? []
        : [{ label: t('settings.note'), value: profile.description }]),
      {
        label: t('settings.missing'),
        value:
          profile.missingSecrets.length === 0 ? (
            '—'
          ) : (
            <LongValue
              value={profile.missingSecrets.map((entry) => entry.pointer).join(' ')}
              label={t('settings.missing')}
            />
          ),
      },
      { label: t('settings.updated'), value: new Date(profile.updatedAt).toLocaleString() },
    ],
    actions: (
      <>
        {/*
          * Picking a profile to edit is not activating it, and the two buttons sit side by side so
          * the difference is readable rather than remembered. This one changes what the four editing
          * screens are pointed at; the one beside it changes what the device will run.
          */}
        {profile.id === target.id ? (
          <span className="pill">{t('editing.editingThis')}</span>
        ) : (
          <button
            type="button"
            disabled={unsaved > 0}
            onClick={() => choose(profile.active ? null : profile.id)}
          >
            {unsaved > 0 ? t('editing.saveFirst') : t('editing.choose')}
          </button>
        )}
        {profile.active ? null : (
          <button
            type="button"
            onClick={() => activate.mutate(profile.id)}
            disabled={profile.missingSecrets.length > 0}
          >
            {/* The consequence in the control that causes it: this records the choice, and the device
                keeps running what it is running until a plan is applied. */}
            {profile.missingSecrets.length > 0 ? t('settings.activateBlocked') : t('settings.activate')}
          </button>
        )}
        <button type="button" onClick={() => void download(profile.id, false)}>
          {t('settings.export')}
        </button>
        <button type="button" onClick={() => void download(profile.id, true)}>
          {t('settings.exportSecrets')}
        </button>
        {profile.active ? null : (
          <button
            type="button"
            onClick={() => {
              if (armed?.id !== profile.id) {
                setArmed({ id: profile.id, at: Date.now() });
                return;
              }
              // The second tap, and only if it did not arrive as the other half of a double tap.
              if (Date.now() - armed.at < ARMING_MS) return;
              setArmed(null);
              remove.mutate(profile.id);
            }}
          >
            {armed?.id === profile.id ? tf('settings.deleteConfirm', profile.name) : t('settings.delete')}
          </button>
        )}
      </>
    ),
  }));

  return (
    <Card title={t('settings.profiles')}>
      <p className="muted">{t('settings.profilesHelp')}</p>
      <p className="muted">{t('editing.chooseHelp')}</p>
      <p className="muted">{t('settings.exportHelp')}</p>

      {message ? <p className="note ok">{message}</p> : null}
      {failure ? <p className="note bad">{failure}</p> : null}

      {imported ? (
        <div className={`note ${imported.missing.length > 0 ? 'warn' : 'ok'}`}>
          <p>{tf('settings.imported', imported.name)}</p>
          {imported.migratedFrom > 0 ? <p className="muted">{tf('settings.migrated', imported.migratedFrom)}</p> : null}
          {imported.missing.length === 0 ? (
            <p>{t('settings.importComplete')}</p>
          ) : (
            <>
              <p>{tf('settings.importMissing', imported.missing.length)}</p>
              <RowList
                rows={imported.missing.map((entry) => ({
                  id: entry.pointer,
                  title: <LongValue value={entry.pointer} label={t('settings.missing')} />,
                  fields: [{ label: t('settings.kind'), value: entry.kind.replace(/-/g, ' ') }],
                }))}
                empty=""
              />
            </>
          )}
        </div>
      ) : null}

      <RowList rows={rows} empty={profiles.isLoading ? t('common.loading') : t('settings.noProfiles')} />

      <div className="filters">
        <label>
          {t('settings.newName')}
          <input type="text" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
        </label>
      </div>
      <div className="row-actions">
        <button type="button" onClick={() => create.mutate()} disabled={create.isPending}>
          {t('settings.create')}
        </button>
        <button type="button" onClick={() => void importFromClipboard()}>
          {t('settings.import')}
        </button>
      </div>
    </Card>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiFailure) {
    const detail = error.error.detail as { missingSecrets?: MissingSecret[] } | undefined;
    const missing = detail?.missingSecrets;
    const listed = missing && missing.length > 0 ? ` (${missing.map((entry) => entry.pointer).join(', ')})` : '';
    return `${error.error.message}${listed}${error.error.hint ? ` — ${error.error.hint}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
