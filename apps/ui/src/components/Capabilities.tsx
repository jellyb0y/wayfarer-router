/**
 * What this device can do, and for each gap, the command that closes it.
 *
 * The report is worth showing because of the second half. "hostapd is not installed" is only actionable
 * to somebody who already knows what to do about it, and the searching they do instead is where the
 * wrong answer comes from.
 *
 * ## Three states, and the middle one is not a failure
 *
 * `unknown` means the device could not answer — no radios were detected, so whether one could host an
 * access point is not a question it has the information to answer. Drawing that as a gap would be a
 * confident claim about hardware from a device that failed to look at its hardware, and it is drawn and
 * worded differently for that reason.
 *
 * ## Some gaps have no command, and saying so is the point
 *
 * A radio whose driver does not report the AP mode cannot be fixed by installing anything. Offering a
 * command there would waste somebody's evening; the note says what the real remedy is — different
 * hardware — and where to look at what each radio reports.
 */

import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { Fold, LongValue, RowList } from './ui/index.tsx';

export interface CapabilityRow {
  id: string;
  title: string;
  state: 'available' | 'missing' | 'unknown';
  missing: string[];
  remedies: { command: string | null; note?: string }[];
  detail?: string;
}

/** The state in words. Never a bare colour: a colour cannot say "could not be answered". */
export function capabilityWords(state: CapabilityRow['state']): string {
  switch (state) {
    case 'available':
      return 'available';
    case 'missing':
      return 'not available';
    case 'unknown':
      return 'could not be answered';
  }
}

export interface CapabilitiesProps {
  query?: () => Promise<{ capabilities: CapabilityRow[]; summary: { available: number; missing: number; unknown: number } }>;
}

export function Capabilities({ query }: CapabilitiesProps = {}): ReactElement {
  const report = useQuery({
    queryKey: ['capabilities'],
    queryFn: query ?? (() => api.capabilities()),
  });

  const rows = report.data?.capabilities ?? [];
  const summary = report.data?.summary;

  return (
    <Fold summary="What this device can do" count={rows.length}>
      {summary ? (
        <p className="muted">
          {summary.available} available, {summary.missing} not available
          {summary.unknown > 0 ? `, ${summary.unknown} that could not be answered` : ''}.
        </p>
      ) : null}

      <RowList
        rows={rows.map((row) => ({
          id: row.id,
          title: row.title,
          badge: (
            <span className={`pill ${row.state === 'missing' ? 'bad' : row.state === 'unknown' ? 'warn' : 'ok'}`}>
              {capabilityWords(row.state)}
            </span>
          ),
          /*
           * A gap's remedy is a field of the gap's own row rather than a paragraph beside the list.
           * The command is the actionable half — "hostapd is not installed" only helps somebody who
           * already knows what to do about it — and a command is an unbreakable run of characters,
           * so it is a `LongValue` with a copy control rather than something made to wrap.
           */
          fields:
            row.state === 'available'
              ? []
              : [
                  ...(row.detail ? [{ label: 'Why', value: row.detail }] : []),
                  {
                    label: 'Missing',
                    value: (
                      <>
                        {row.missing.map((what, index) => {
                          const remedy = row.remedies[index];
                          return (
                            <div key={what}>
                              <div>{what}</div>
                              {remedy?.command ? <LongValue value={remedy.command} label="the command" /> : null}
                              {remedy?.note ? <div className="muted">{remedy.note}</div> : null}
                            </div>
                          );
                        })}
                      </>
                    ),
                  },
                ],
        }))}
        empty={report.isLoading ? 'Loading…' : 'Nothing was reported.'}
      />

      <button type="button" onClick={() => void report.refetch()} disabled={report.isFetching}>
        {report.isFetching ? 'Looking…' : 'Look again'}
      </button>
    </Fold>
  );
}
