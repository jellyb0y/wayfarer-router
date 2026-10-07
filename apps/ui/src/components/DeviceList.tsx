/**
 * Several devices in one fold, with nothing in it able to change any of them.
 *
 * ## What this deliberately cannot do
 *
 * There is no controller here. This device asks each peer for its own summary, using a read-scoped
 * token **the peer issued**, and draws the answers. Nothing here can apply a change, activate a
 * profile or restart anything on another device — a safety property rather than a missing feature,
 * argued in [08-ui](../../../../docs/08-ui.md): the confirmation window protects the operator of the
 * device being changed, and a change arriving from another device has no such operator.
 *
 * ## Reachability has three answers and the rows give all three
 *
 * A peer that says nothing is **not reachable**, which is not the same as being in trouble: the usual
 * reason is that the link between here and there is the thing being reconfigured. A peer that answers
 * with a refusal **is working and does not accept the credential** — a different problem with a
 * different fix. Collapsed into one red row, the two send somebody to the wrong place.
 *
 * ## Why this is a row list and not the table it used to be
 *
 * Six columns at 360 px is the defect the owner reported, and the two widest values here are the
 * refusal sentences themselves. A row carries its own labels, so nothing depends on a header that has
 * scrolled out of view — and nothing scrolls sideways.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type FleetResponse } from '../lib/api.ts';
import { t, tf } from '../lib/i18n.ts';
import { Fold, LongValue, RowList, type Row } from './ui/index.tsx';

type FleetRow = FleetResponse['devices'][number];

/** The state in words an operator can act on, rather than a colour. */
export function stateWords(row: Pick<FleetRow, 'state'>): string {
  switch (row.state) {
    case 'self':
      return t('fleet.self');
    case 'answered':
      return t('fleet.answered');
    case 'refused':
      return t('fleet.refused');
    case 'unreachable':
      return t('fleet.unreachable');
  }
}

/** The one word that fits in a pill. The sentence is a row field — see `deviceRows`. */
export function badgeWords(state: FleetRow['state']): string {
  switch (state) {
    case 'self':
      return t('fleet.self');
    case 'answered':
      return t('fleet.answered');
    case 'refused':
      return t('fleet.badgeRefused');
    case 'unreachable':
      return t('fleet.badgeUnreachable');
  }
}

/** Uptime as something a person reads, or a dash when the peer did not say. */
export function uptimeWords(seconds: number | undefined): string {
  if (seconds === undefined) return '—';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

export function DeviceList(): ReactElement {
  const client = useQueryClient();
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fleet = useQuery({
    queryKey: ['fleet'],
    queryFn: () => api.fleet(),
    // Not on a timer. Every refresh is a request to every peer, and a screen left open on a laptop
    // should not keep poking devices on metered links for hours.
    refetchOnWindowFocus: false,
  });

  const add = useMutation({
    mutationFn: () => api.addPeer({ label, baseUrl, token }),
    onSuccess: () => {
      setLabel('');
      setBaseUrl('');
      setToken('');
      setError(null);
      void client.invalidateQueries({ queryKey: ['fleet'] });
    },
    onError: (cause: unknown) => setError(String(cause)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removePeer(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['fleet'] }),
  });

  const devices = fleet.data?.devices ?? [];
  const duplicates = fleet.data?.duplicateIdentities ?? [];

  return (
    <Fold summary={t('settings.devices')} count={fleet.data === undefined ? undefined : devices.length}>
      {/* The label alone reads as control. One sentence, because a reader who assumes otherwise will
          look for a button that is not there and conclude the screen is broken. */}
      <p className="muted">{t('fleet.viewOnly')}</p>

      {duplicates.length > 0 ? (
        <p className="note warn">{tf('fleet.duplicate', duplicates.join(', '))}</p>
      ) : null}

      <RowList rows={deviceRows(devices, (id) => remove.mutate(id))} empty={t('fleet.none')} />

      <div className="row-actions">
        <button type="button" onClick={() => void fleet.refetch()} disabled={fleet.isFetching}>
          {fleet.isFetching ? t('fleet.asking') : t('fleet.askAgain')}
        </button>
      </div>

      <Fold summary={t('fleet.add')}>
        <div className="filters">
          <label>
            {t('fleet.name')}
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            {t('fleet.address')}
            <input
              value={baseUrl}
              placeholder="http://192.0.2.10:8088"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            {t('fleet.token')}
            <input type="password" value={token} onChange={(event) => setToken(event.target.value)} />
          </label>
          {/* The consequence, in the control that causes it: where the token comes from, and that it
              cannot be used to change anything. Every route that changes something refuses it. */}
          <p className="muted">{t('fleet.tokenHelp')}</p>
        </div>
        {error ? <p className="note bad">{error}</p> : null}
        <div className="row-actions">
          <button
            type="button"
            onClick={() => add.mutate()}
            disabled={add.isPending || label === '' || baseUrl === '' || token === ''}
          >
            {t('fleet.addSubmit')}
          </button>
        </div>
      </Fold>
    </Fold>
  );
}

function deviceRows(devices: FleetRow[], forget: (id: string) => void): Row[] {
  return devices.map((device) => ({
    id: device.id,
    title: device.deviceName ?? device.label,
    badge: (
      <span className={`pill ${device.state === 'refused' ? 'warn' : device.state === 'unreachable' ? 'bad' : ''}`}>
        {badgeWords(device.state)}
      </span>
    ),
    fields: [
      /*
       * The sentence, and only where there is one to add.
       *
       * A pill holds a word; the two answers that need a sentence — working but refusing the token,
       * and no answer at all — get it as a row field instead, because a sentence in a pill beside a
       * title is what pushed the old table past the edge of the screen. For the other two the badge
       * has said everything, and repeating it in a field below reads as two separate readings.
       */
      ...(device.state === 'refused' || device.state === 'unreachable'
        ? [{ label: t('fleet.state'), value: stateWords(device) }]
        : []),
      ...(device.baseUrl === ''
        ? []
        : [{ label: t('fleet.address'), value: <LongValue value={device.baseUrl} label={t('fleet.address')} /> }]),
      { label: t('fleet.profile'), value: device.activeProfile ?? '—' },
      { label: t('fleet.version'), value: device.version ?? '—' },
      { label: t('fleet.up'), value: uptimeWords(device.uptimeSeconds) },
      // A fetch failure's own words. Any length, so it is truncated rather than wrapped.
      ...(device.detail === undefined
        ? []
        : [{ label: t('fleet.detail'), value: <LongValue value={device.detail} label={t('fleet.detail')} /> }]),
    ],
    actions:
      device.state === 'self' ? undefined : (
        <button type="button" onClick={() => forget(device.id)}>
          {t('fleet.forget')}
        </button>
      ),
  }));
}
