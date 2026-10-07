/**
 * One row of `way transactions`.
 *
 * The countdown comes from `windowCountdown`, the one function every surface reports a window
 * through: a number only while the transaction is `awaiting-confirm`. This line printed "Ns left"
 * beside `committed` rows because it computed its own countdown from a deadline the row keeps as
 * history; a second copy of the rule is how the API and the CLI disagreed in the first place.
 */

import { windowCountdown, type TransactionState } from './transactions.ts';

export function transactionLine(
  row: {
    createdAt: string;
    id: string;
    blastRadius: string;
    state: TransactionState;
    deadlineAt: string | null;
    firesAtUptimeSeconds: number | null;
    reason: string | null;
  },
  uptimeSeconds: number | null,
  now: Date,
): string {
  const left = windowCountdown(row, uptimeSeconds, now).secondsRemaining;
  return (
    `${row.createdAt}  ${row.id}  ${row.blastRadius.padEnd(7)} ${row.state.padEnd(16)}` +
    `${left === null ? '' : ` ${left}s left`}${row.reason === null ? '' : `  ${row.reason}`}\n`
  );
}
