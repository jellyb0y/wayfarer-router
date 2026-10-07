/**
 * API tokens: create one, see the ones that exist, revoke one.
 *
 * The routes existed and the screen did not, so the only way to mint a token was a `curl` against the
 * login route — measured on the bench board, 2026-10-07, when an owner who wanted a script to apply a
 * profile had to be handed a shell one-liner carrying their password. `docs/08-ui.md` had listed tokens
 * under Settings all along; the list was a promise nothing kept.
 *
 * ## What is here and what is deliberately not
 *
 * **The machine-access switch is shown, not offered.** `docs/10-security.md` decides that it is turned
 * on by `way machine-api on`, on the device, as root — a session that can reach this panel from the
 * café's network must not be able to open the device to scripts as well. So the card says which way the
 * switch is and, when it is off, names the command; a token created while it is off exists and is
 * refused, which is the thing a person would otherwise find out from a 403.
 *
 * **The value is shown once, in the reply to the create, and then forgotten.** The device stores the
 * SHA-256 and nothing else, so there is no route that could show it again; the card keeps it in
 * component state only until the person says they have copied it, never in the query cache, which
 * outlives the card.
 *
 * **Revoking takes two taps, with the same floor as deleting a profile**, because the second tap of a
 * double tap is not a decision. Revocation is immediate on the device and there is no undo short of
 * creating a new token and handing it out again.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiFailure, api, type TokenScope, type TokenSummary } from '../lib/api.ts';
import { t, tf, type MessageKey } from '../lib/i18n.ts';
import { ARMING_MS } from '../lib/arming.ts';
import { Card, LongValue, RowList, type Row } from './ui/index.tsx';

const SCOPES: TokenScope[] = ['read', 'apply', 'admin'];

/**
 * Lifetimes as durations, turned into an instant when the token is created.
 *
 * The device enforces an expiry against its own clock and only while that clock is synchronised
 * (`docs/10-security.md`), so the instant is computed here from the browser's clock — the two agree to
 * within the minutes a person cares about for a lifetime counted in hours or longer.
 */
const LIFETIMES: { key: string; label: MessageKey; ms: number | null }[] = [
  { key: 'never', label: 'tokens.expiryNever', ms: null },
  { key: 'hour', label: 'tokens.expiryHour', ms: 3_600_000 },
  { key: 'day', label: 'tokens.expiryDay', ms: 86_400_000 },
  { key: 'month', label: 'tokens.expiryMonth', ms: 30 * 86_400_000 },
  { key: 'year', label: 'tokens.expiryYear', ms: 365 * 86_400_000 },
];

export function TokensCard(): ReactElement {
  const queryClient = useQueryClient();
  const system = useQuery({ queryKey: ['system'], queryFn: api.system });
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.tokens });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>(['read']);
  const [lifetime, setLifetime] = useState('never');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [armed, setArmed] = useState<{ id: string; at: number } | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['tokens'] });
  };

  const create = useMutation({
    mutationFn: () => {
      const ms = LIFETIMES.find((entry) => entry.key === lifetime)?.ms ?? null;
      return api.createToken({
        name: name.trim(),
        scopes,
        expiresAt: ms === null ? null : new Date(Date.now() + ms).toISOString(),
      });
    },
    onSuccess: (created) => {
      setIssued({ name: created.summary.name, token: created.token });
      setName('');
      setScopes(['read']);
      setLifetime('never');
      setMessage(null);
      setFailure(null);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteToken(id),
    onSuccess: () => {
      setFailure(null);
      setMessage(t('tokens.revoked'));
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const toggle = (scope: TokenScope, on: boolean): void =>
    setScopes((current) => (on ? SCOPES.filter((s) => s === scope || current.includes(s)) : current.filter((s) => s !== scope)));

  // A card on a shared screen must not take the screen down: a reply that is not a list (a proxy's
  // error page, an older daemon) would otherwise throw in `map` and blank the password and profiles too.
  const listed: TokenSummary[] = Array.isArray(tokens.data) ? tokens.data : [];
  const rows: Row[] = listed.map((token) => ({
    id: token.id,
    title: token.name,
    fields: [
      { label: t('tokens.scopes'), value: token.scopes.join(', ') },
      { label: t('tokens.created'), value: new Date(token.createdAt).toLocaleString() },
      { label: t('tokens.lastUsed'), value: token.lastUsedAt === null ? t('tokens.never') : new Date(token.lastUsedAt).toLocaleString() },
      { label: t('tokens.expires'), value: token.expiresAt === null ? t('tokens.never') : new Date(token.expiresAt).toLocaleString() },
    ],
    actions: (
      <button
        type="button"
        disabled={revoke.isPending}
        onClick={() => {
          if (armed?.id !== token.id) {
            setArmed({ id: token.id, at: Date.now() });
            return;
          }
          // The second tap, and only if it did not arrive as the other half of a double tap.
          if (Date.now() - armed.at < ARMING_MS) return;
          setArmed(null);
          revoke.mutate(token.id);
        }}
      >
        {armed?.id === token.id ? tf('tokens.revokeConfirm', token.name) : t('tokens.revoke')}
      </button>
    ),
  }));

  return (
    <Card title={t('tokens.title')}>
      <p className="muted">{t('tokens.help')}</p>
      <dl className="row-fields">
        <div className="row-field">
          <dt>{t('tokens.machine')}</dt>
          <dd>
            {system.data === undefined
              ? t('common.unknown')
              : system.data.apiEnabled
                ? t('tokens.machineOn')
                : t('tokens.machineOff')}
          </dd>
        </div>
      </dl>
      {system.data?.apiEnabled === false ? <p className="note warn">{t('tokens.machineOffHelp')}</p> : null}

      {issued ? (
        <div className="note ok">
          <p>{t('tokens.shownOnce')}</p>
          <LongValue value={issued.token} label={issued.name} />
          <div className="row-actions">
            <button type="button" onClick={() => setIssued(null)}>
              {t('tokens.dismiss')}
            </button>
          </div>
        </div>
      ) : null}
      {message ? <p className="note ok">{message}</p> : null}
      {failure ? <p className="note bad">{failure}</p> : null}

      <RowList rows={rows} empty={tokens.isLoading ? t('common.loading') : t('tokens.none')} />

      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label>
          {t('tokens.name')}
          <input type="text" value={name} maxLength={128} onChange={(event) => setName(event.target.value)} />
        </label>
        <fieldset>
          <legend>{t('tokens.scopes')}</legend>
          {/*
            * `.field-block` for the checkbox rule in styles.css (a stretched checkbox reports content
            * wider than its box — measured here too, three labels at 360 px), and no `data-pointer`:
            * a token is not a position in the profile, and the parity harvest counts pointers.
            */}
          {SCOPES.map((scope) => (
            <div key={scope} className="field-block">
              <label>
                <span className="field-label">{scope}</span>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) => toggle(scope, event.target.checked)}
                />
              </label>
            </div>
          ))}
        </fieldset>
        {scopes.includes('admin') ? <p className="note warn">{t('tokens.adminWarn')}</p> : null}
        <label>
          {t('tokens.expiry')}
          <select value={lifetime} onChange={(event) => setLifetime(event.target.value)}>
            {LIFETIMES.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {t(entry.label)}
              </option>
            ))}
          </select>
        </label>
        <div className="row-actions">
          <button
            className="primary"
            type="submit"
            disabled={name.trim() === '' || scopes.length === 0 || create.isPending}
          >
            {t('tokens.create')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiFailure) return `${error.error.message}${error.error.hint ? ` — ${error.error.hint}` : ''}`;
  return error instanceof Error ? error.message : String(error);
}
