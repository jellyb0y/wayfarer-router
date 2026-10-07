/**
 * Clients answers one question: **who is connected?**
 *
 * It used to be two tables with four columns each, which at 360 px is a table with a horizontal
 * scrollbar — the shape that does not fit, with the cost moved onto the reader. A MAC address is 17
 * unbreakable characters and an interface name on this hardware reaches thirty, so the first two
 * columns alone are wider than the screen before a single reading is shown.
 *
 * The same readings are now rows that carry their own labels. Nothing is dropped and nothing is
 * hidden behind a breakpoint: a row read halfway down a long list still says what its values are,
 * because there is no header that has scrolled away.
 *
 * Renders from the last snapshot the event stream delivered, so a device whose uplink is down still
 * shows who is on its access point.
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type StatusResponse } from '../lib/api.ts';
import { t, tf } from '../lib/i18n.ts';
import { Card, Fold, RowList, Screen, type Row } from '../components/ui/index.tsx';

export function Clients({ live }: { live: StatusResponse | null }): ReactElement {
  const fetched = useQuery({ queryKey: ['status'], queryFn: api.status, enabled: live === null });
  const status = live ?? fetched.data ?? null;

  const stations = Object.entries(status?.accessPoints ?? {}).flatMap(([name, ap]) =>
    ap.stations.map((station) => ({ ...station, accessPoint: name })),
  );

  /*
   * A station list that was not read to the end is not an empty station list.
   *
   * The daemon reports whether it got through the whole list, and why not when it did not. "Nobody
   * is connected" and "we could not ask" look identical on a screen that only draws rows, and the
   * first of those is the answer this screen exists to give.
   *
   * `stationsComplete`, not the old `stationsIterated`: that field meant "the reply was truncated and
   * rebuilt one station at a time", and reading it as "complete" put this caveat over every whole
   * list on the bench board (2026-09-23, two stations, a 1755-byte reply in 7 ms).
   */
  const unfinished = Object.entries(status?.accessPoints ?? {})
    .filter(([, ap]) => !ap.stationsComplete)
    .map(([name, ap]) => ({ name, reason: ap.stationsIncomplete ?? t('clients.noReason') }));

  const history = status?.stationHistory ?? [];

  return (
    <Screen title={t('clients.title')}>
      <Card title={t('clients.connected')}>
        {unfinished.map(({ name, reason }) => (
          <p key={name} className="note">
            {tf('clients.notCounted', reason)}
          </p>
        ))}
        <RowList rows={stationRows(stations)} empty={t('clients.none')} />
      </Card>

      {/*
        * Folded, because the question on this screen is who is connected *now*. Who left twenty
        * minutes ago is a different question and it has its own screen — this fold is the short
        * answer for the case where somebody is watching a device drop off and back on.
        */}
      <Fold summary={t('clients.recent')} count={history.length}>
        <RowList rows={historyRows(history)} empty={t('clients.noHistory')} />
      </Fold>
    </Screen>
  );
}

interface Station {
  mac: string;
  signalDbm: number | null;
  connectedSeconds: number | null;
  accessPoint: string;
}

function stationRows(stations: Station[]): Row[] {
  return stations.map((station) => ({
    id: `${station.accessPoint}-${station.mac}`,
    title: <span className="mono">{station.mac}</span>,
    /*
     * The signal is the badge and it is nowhere else on the row. Drawn in both places it would be
     * the same reading twice, which is the duplicate-control defect at the scale of one row: two
     * copies of a value that can only ever disagree by mistake, and a reader who then wonders which
     * of them is the current one.
     */
    badge: <span className="pill">{signalWords(station.signalDbm)}</span>,
    fields: [
      { label: t('clients.accessPoint'), value: <span className="mono">{station.accessPoint}</span> },
      { label: t('clients.connectedFor'), value: durationWords(station.connectedSeconds) },
    ],
  }));
}

function historyRows(history: StatusResponse['stationHistory']): Row[] {
  return history.map((entry, index) => ({
    id: `${entry.at}-${entry.mac}-${index}`,
    title: <span className="mono">{entry.mac}</span>,
    badge: (
      <span className={`pill ${entry.action === 'connected' ? 'ok' : ''}`}>
        {entry.action === 'connected' ? t('clients.arrived') : t('clients.left')}
      </span>
    ),
    fields: [
      { label: t('clients.when'), value: new Date(entry.at).toLocaleTimeString() },
      { label: t('clients.accessPoint'), value: <span className="mono">{entry.accessPointInterface}</span> },
    ],
  }));
}

/**
 * A missing counter reads as unknown, never as a measurement.
 *
 * Several drivers do not populate every station counter, and a default of zero is indistinguishable
 * from a reading of zero — which here would be a station with a perfect signal, the opposite of what
 * an absent value means.
 */
export function signalWords(dbm: number | null): string {
  return dbm === null ? t('common.unknown') : `${dbm} dBm`;
}

export function durationWords(seconds: number | null): string {
  if (seconds === null) return t('common.unknown');
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}
