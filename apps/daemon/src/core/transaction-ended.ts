/**
 * How the daemon learns that a transaction ended, whichever process ended it.
 *
 * The resolver follower waits while a confirmation window is open — correctly: it must not change the
 * device a person is judging. But it then picked the deferred resolver up only at its next round,
 * up to a minute later. Measured on the bench board, 2026-09-23: `hq.lan` failed to resolve for
 * about 80 s after a confirm. So the end of a transaction is itself a trigger for the follower.
 *
 * Inside the daemon that is a call (`ApplyDeps.transactionEnded`). The revert timer, however, runs
 * `way revert` in a process of its own, and nothing it does reaches the daemon's memory. It tells the
 * daemon with a signal to the daemon unit's main process — `SIGUSR2`, the signal Node leaves to the
 * application — and the daemon's handler runs the follower's ordinary check. No file, no poll, no
 * socket: the one thing the second process needs is the unit name it already has.
 */

import type { SystemdController } from '../platform/systemd.ts';

export const TRANSACTION_ENDED_SIGNAL = 'SIGUSR2' as const;

/** For `way revert`: after the transaction ends, wake the daemon. A failure is reported, never fatal. */
export function signalDaemonOnEnd(
  systemd: Pick<SystemdController, 'signal'>,
  unit: string,
  log: (message: string) => void,
): (event: { transaction: string; how: string }) => Promise<void> {
  return async (event) => {
    const result = await systemd.signal(unit, TRANSACTION_ENDED_SIGNAL);
    log(
      result.ok
        ? `told ${unit} that ${event.transaction} ${event.how}`
        : `could not tell ${unit} that ${event.transaction} ${event.how}; its follower will look at its next round: ${result.message}`,
    );
  };
}

/** For the daemon: run `onEnded` whenever another process says a transaction ended. Returns a remover. */
export function listenForTransactionsEndedElsewhere(
  target: Pick<NodeJS.Process, 'on' | 'off'>,
  onEnded: () => void,
): () => void {
  const listener = (): void => onEnded();
  target.on(TRANSACTION_ENDED_SIGNAL, listener);
  return () => target.off(TRANSACTION_ENDED_SIGNAL, listener);
}
