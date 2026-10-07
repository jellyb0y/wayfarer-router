/**
 * The end of a transaction reaches the daemon's resolver follower even when another process ended it,
 * and `way transactions` counts down only an open window.
 *
 * The revert timer runs `way revert` in a process of its own. Nothing it does reaches the daemon's
 * memory, so it signals the daemon unit's main process and the daemon's handler runs the follower's
 * ordinary check. Both halves are exercised here with the shipped functions; only systemd's delivery of
 * the signal between the two processes is stood in for — by emitting it on this process, which is what
 * the kernel does to the daemon.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import {
  TRANSACTION_ENDED_SIGNAL,
  listenForTransactionsEndedElsewhere,
  signalDaemonOnEnd,
} from '../src/core/transaction-ended.ts';
import { transactionLine } from '../src/core/transaction-line.ts';
import type { TransactionState } from '../src/core/transactions.ts';

test('`way revert` tells the daemon unit, by name, with the signal the daemon listens for', async () => {
  const sent: { unit: string; signal: string }[] = [];
  const lines: string[] = [];
  const notify = signalDaemonOnEnd(
    {
      signal: async (unit, signal) => {
        sent.push({ unit, signal });
        return { ok: true, message: '' };
      },
    },
    'wayfarer.service',
    (message) => lines.push(message),
  );
  await notify({ transaction: 't1', how: 'reverted' });
  assert.deepEqual(sent, [{ unit: 'wayfarer.service', signal: TRANSACTION_ENDED_SIGNAL }]);
  assert.match(lines[0]!, /told wayfarer\.service that t1 reverted/);
});

test('a signal that could not be sent is said, and the follower’s next round is named as the fallback', async () => {
  const lines: string[] = [];
  await signalDaemonOnEnd(
    { signal: async () => ({ ok: false, message: 'Unit wayfarer.service not loaded.' }) },
    'wayfarer.service',
    (message) => lines.push(message),
  )({ transaction: 't2', how: 'reverted' });
  assert.match(lines[0]!, /could not tell .* next round: Unit wayfarer\.service not loaded/);
});

test('the daemon runs its follower within a second of the signal, and stops listening when told', async () => {
  const target = new EventEmitter() as unknown as NodeJS.Process;
  let ran = 0;
  const stop = listenForTransactionsEndedElsewhere(target, () => (ran += 1));
  const sentAt = performance.now();
  // What systemd's `kill --signal=SIGUSR2` does to the daemon's main process.
  (target as unknown as EventEmitter).emit(TRANSACTION_ENDED_SIGNAL);
  assert.equal(ran, 1);
  assert.ok(performance.now() - sentAt < 1000);

  stop();
  (target as unknown as EventEmitter).emit(TRANSACTION_ENDED_SIGNAL);
  assert.equal(ran, 1, 'a daemon shutting down must not act on it');
});

test('the listener is installed for the signal Node leaves to applications, on the real process', () => {
  // SIGUSR1 is Node's debugger; a handler on it would not be what runs. SIGUSR2 is free.
  assert.equal(TRANSACTION_ENDED_SIGNAL, 'SIGUSR2');
  let ran = false;
  const stop = listenForTransactionsEndedElsewhere(process, () => (ran = true));
  try {
    process.emit(TRANSACTION_ENDED_SIGNAL as 'SIGUSR2');
    assert.equal(ran, true);
  } finally {
    stop();
  }
});

/* ── `way transactions` ─────────────────────────────────────────────────────────────────── */

// A row that keeps both halves of its deadline as history: the wall-clock instant and the uptime anchor.
const row = (state: TransactionState) => ({
  createdAt: '2026-09-23T10:00:00.000Z',
  id: 'abc',
  blastRadius: 'network',
  state,
  deadlineAt: new Date(Date.now() + 120_000).toISOString(),
  firesAtUptimeSeconds: 5_120,
  reason: null,
});

test('a committed transaction prints no countdown, though its row still holds a deadline', () => {
  for (const state of ['committed', 'reverted', 'failed', 'applying', 'reverting'] as const) {
    assert.doesNotMatch(transactionLine(row(state), 5_000, new Date()), /left/, `${state} printed a countdown`);
  }
});

test('an open window prints its countdown, from the uptime anchor the timer fires on', () => {
  assert.match(transactionLine(row('awaiting-confirm'), 5_000, new Date()), / 120s left/);
});
