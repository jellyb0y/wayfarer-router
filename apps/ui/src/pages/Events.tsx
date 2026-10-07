/**
 * Events answers one question: **what happened, and when?**
 *
 * Two sources sit behind it and the difference between them is the whole reason this screen is
 * shaped the way it is:
 *
 * * the **event ring** is on the card and **survives a power cut**. It holds only significant
 *   events, and after the kind of failure anybody actually wants to investigate — a board that
 *   stopped answering and was power-cycled — it is the whole record. So it is the screen.
 * * the **journal** lives in RAM, holds everything, and is gone after a reboot. It is folded: it is
 *   what you open when the ring has told you roughly when to look.
 *
 * ## Why the retention rule is on the screen rather than in the documentation
 *
 * Retention is by **count**, not by age: the ring holds a fixed number of rows and evicts the
 * oldest. That has a consequence nobody guesses correctly — a busy day holds less history than a
 * quiet one. A device that spent an afternoon failing to apply a bad profile can evict a week of
 * ordinary history in an hour, right when somebody needs what came before. "5000 rows" does not say
 * that.
 *
 * The reach-back figure is **derived from the oldest row on screen**, never estimated from an event
 * rate: an estimate is a guess that reads like a measurement.
 *
 * ## Filtering, and why it does not hide the count
 *
 * A filter that changes both the list and the rows-kept figure teaches the reader that narrowing a
 * view destroys history. The kept figure here always describes the **ring**; the match count is
 * reported separately, so the two questions stay separate.
 *
 * Filtering happens on the device, through parameters the API already has. Doing it in the browser
 * would mean fetching thousands of rows to show ten, over a link the device may be about to
 * reconfigure, and would be a second implementation of what `kind` means.
 */

import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type EventLogResponse, type LogsResponse } from '../lib/api.ts';
import { t, tf } from '../lib/i18n.ts';
import { Card, Fold, LongValue, RowList, Screen, type Row } from '../components/ui/index.tsx';

const LEVELS = ['error', 'warn', 'info'] as const;

/**
 * How far back the ring reaches, in words, from the rows themselves.
 *
 * Pure and exported so the sentence can be tested without a device. `null` when there is nothing to
 * say, which is not the same as "no history": a ring with one row has no span to report.
 */
export function reachBack(input: {
  oldestAt: string | null;
  count: number;
  capacity: number;
  now: Date;
}): string | null {
  if (input.oldestAt === null || input.count === 0) return null;
  const oldest = Date.parse(input.oldestAt);
  if (!Number.isFinite(oldest)) return null;

  const days = Math.floor((input.now.getTime() - oldest) / 86_400_000);
  const span = days >= 2 ? `${days} days` : days === 1 ? 'about a day' : 'less than a day';

  return input.count < input.capacity
    ? `History reaches back ${span}, to the oldest event this device has kept. The ring is not full yet, ` +
        'so nothing has been evicted.'
    : `History reaches back ${span}. The ring is full, so the oldest events are now being evicted as new ` +
        'ones arrive — a busy day holds less history than a quiet one.';
}

export interface EventsProps {
  /** Injected in tests so the screen can be rendered without a server. */
  ringQuery?: (query: string) => Promise<EventLogResponse>;
  journalQuery?: (query: string) => Promise<LogsResponse>;
  now?: () => Date;
}

export function Events({ ringQuery, journalQuery, now }: EventsProps = {}): ReactElement {
  const [level, setLevel] = useState('');
  const [kind, setKind] = useState('');

  const request = `?limit=200${level === '' ? '' : `&level=${encodeURIComponent(level)}`}${
    kind === '' ? '' : `&kind=${encodeURIComponent(kind)}`
  }`;
  const ring = useQuery({
    queryKey: ['eventlog', level, kind],
    queryFn: () => (ringQuery ?? api.eventlog)(request),
  });

  /*
   * The kinds offered come from an **unfiltered** read, and that is the whole of this query.
   *
   * They are still the kinds present in what came back rather than a fixed list — a fixed list falls
   * behind the kinds the daemon records and then silently offers no way to find the newest sort. But
   * they were read off `ring`, which is the *filtered* result, so choosing a kind narrowed the rows,
   * the rows were the source of the options, and the dropdown collapsed to the one kind already
   * chosen. Every other kind became unreachable without Clear filters, and nothing said so: a filter
   * that removes its own alternatives looks exactly like a device that has only ever recorded one
   * sort of event.
   *
   * A source a filter narrows cannot be that filter's list of choices. Cached under its own key, so
   * changing either filter does not refetch it.
   */
  const catalogue = useQuery({
    queryKey: ['eventlog', 'kinds'],
    queryFn: () => (ringQuery ?? api.eventlog)('?limit=200'),
  });

  const entries = ring.data?.entries ?? [];
  const clock = now ?? ((): Date => new Date());

  const catalogueEntries = catalogue.data?.entries ?? [];
  const kinds = useMemo(() => {
    const present = new Set(catalogueEntries.map((entry) => entry.kind));
    // The chosen kind is kept even when the unfiltered window no longer holds one, so the control
    // never shows a blank where the filter it is applying should be named.
    if (kind !== '') present.add(kind);
    return [...present].sort();
  }, [catalogueEntries, kind]);

  const oldest = entries.length > 0 ? entries[entries.length - 1]!.at : null;
  const reach = ring.data
    ? reachBack({ oldestAt: oldest, count: ring.data.count, capacity: ring.data.capacity, now: clock() })
    : null;

  const filtered = level !== '' || kind !== '';

  return (
    <Screen title={t('nav.events')}>
      <Card title={t('events.ring')}>
        {/* What it holds, named. A reader who does not know cannot tell a quiet ring from an
            incomplete one, and "nothing recorded" is the conclusion they reach. */}
        <p className="muted">{t('events.ringHolds')}</p>

        {ring.data ? (
          <p className="note">
            <strong>{tf('events.kept', ring.data.count, ring.data.capacity)}</strong>
            {reach === null ? null : <> — {reach}</>}
          </p>
        ) : null}

        <div className="filters">
          <label>
            {t('events.level')}
            <select value={level} onChange={(event) => setLevel(event.target.value)}>
              <option value="">{t('events.any')}</option>
              {LEVELS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('events.kind')}
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">{t('events.any')}</option>
              {kinds.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          {filtered ? (
            <>
              <p className="muted">
                {tf('events.matched', entries.length, ring.data?.count ?? 0)}
              </p>
              <button
                type="button"
                onClick={() => {
                  setLevel('');
                  setKind('');
                }}
              >
                {t('events.clearFilter')}
              </button>
            </>
          ) : null}
        </div>

        {/* An empty result under a filter is not an empty ring, and saying so is the whole point of
            keeping the two counts separate above. */}
        {entries.length === 0 && !ring.isLoading ? (
          <p className="note">{filtered ? t('events.noneMatch') : t('events.noneYet')}</p>
        ) : null}

        <RowList rows={ringRows(entries)} empty="" />
      </Card>

      <Journal query={journalQuery} />
    </Screen>
  );
}

function ringRows(entries: EventLogResponse['entries']): Row[] {
  return entries.map((entry) => ({
    id: String(entry.id),
    /*
     * The summary is a **value**, not a heading, and the ring holds long ones: an apply refusal
     * naming a tunnel, a pointer and a reason measured 389 characters on the bench, which at 360 px
     * painted sixteen line boxes in a 222 px column. Rule 6 is what applies — truncated with a copy
     * control, never made to wrap — and three lines rather than one because the first words are what
     * tells a reader whether this is the row they are looking for.
     */
    title: <LongValue value={entry.summary} lines={3} mono={false} label={t('events.kind')} />,
    badge: (
      <span className={`pill ${entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'warn' : ''}`}>
        {entry.level}
      </span>
    ),
    fields: [
      { label: t('events.when'), value: new Date(entry.at).toLocaleString() },
      { label: t('events.kind'), value: <span className="mono">{entry.kind}</span> },
    ],
  }));
}

/* ── the journal ─────────────────────────────────────────────────────────────────────────── */

/**
 * The RAM journal, folded because it is the second question rather than the first.
 *
 * Three things it has to say about itself, each of which turns a misleading blank into a fact: the
 * page may have a hole in it, it may reach into an earlier boot, and after a power cut it holds
 * nothing at all for the boot that is running. An empty log must never read as an absence of events.
 */
function Journal({ query }: { query?: ((request: string) => Promise<LogsResponse>) | undefined }): ReactElement {
  const [unit, setUnit] = useState('');
  const [level, setLevel] = useState('7');

  const request = `?limit=200&level=${encodeURIComponent(level)}${
    unit === '' ? '' : `&unit=${encodeURIComponent(unit)}`
  }`;
  const logs = useQuery({
    queryKey: ['logs', unit, level],
    queryFn: () => (query ?? api.logs)(request),
    refetchInterval: 10_000,
  });

  return (
    <Fold summary={t('events.journal')}>
      <p className="muted">{t('events.journalIs')}</p>

      <div className="filters">
        <label>
          {t('events.unit')}
          <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder={t('events.anyUnit')} />
        </label>
        <label>
          {t('events.level')}
          <select value={level} onChange={(event) => setLevel(event.target.value)}>
            <option value="3">{t('events.errors')}</option>
            <option value="4">{t('events.warnings')}</option>
            <option value="6">{t('events.informational')}</option>
            <option value="7">{t('events.everything')}</option>
          </select>
        </label>
      </div>

      {logs.data?.incomplete ? (
        <p className="note">
          {t('diagnostics.incomplete')}
          {logs.data.incompleteReason ? ` ${logs.data.incompleteReason}.` : ''}
        </p>
      ) : null}
      {logs.data?.containsEarlierBoots ? <p className="note">{t('diagnostics.earlierBoots')}</p> : null}
      {logs.data?.currentBootEmpty ? <p className="note">{t('diagnostics.currentBootEmpty')}</p> : null}

      {/*
        * Cut after three lines, with the whole line one tap away. Never scrolled sideways.
        *
        * **This replaces a decision recorded here, and the reasoning it was based on was right about
        * the wrong thing.** It said a journal line is prose, may be broken anywhere without changing
        * what it says, and so is not what rule 6 truncates. True of the sentence, and irrelevant to
        * the page: measured at 360 px on 2026-09-21, a line holding a 253-character name painted
        * **ten line boxes**, and two hundred of them turned the one pane somebody opens to find a
        * moment into a wall with no moments visible in it. What breaks here is not the meaning of
        * one line, it is the ability to scan a hundred.
        *
        * Three rather than one because the first words of a log line are rarely the interesting
        * ones, and the copy control is what makes the cut free.
        */}
      <div className="journal">
        {(logs.data?.entries ?? []).map((entry, index) => (
          <p key={`${entry.at}-${index}`} className={`journal-line p${entry.priority ?? 6}`}>
            <span className="muted">{entry.at ? new Date(entry.at).toLocaleTimeString() : '—'}</span>{' '}
            <LongValue value={entry.message} lines={3} mono={false} label={t('events.journal')} />
          </p>
        ))}
        {logs.isLoading ? <p className="muted">{t('common.loading')}</p> : null}
      </div>
    </Fold>
  );
}
