/**
 * The resolver watch as the daemon runs it: the file-system watch, and the observer that reports it.
 *
 * Built here rather than inline in `index.ts`, because inline is where it went wrong without a test
 * noticing. On the bench board, 2026-09-23, the observer's last look was `null` for eighteen minutes
 * after start-up and then stood still for three while the 30 s inode check kept running: the check had
 * no way to record a look, and `index.ts` recorded one only when a capture changed. The round-two tests
 * built the watch and an observer of their own, asserted only `ok` / `not-running`, and gave the
 * observer no cadence — so an observer that never looked could never read stale, and nothing asked
 * whether it had looked at all. The test for this module builds the observer through this function,
 * which is the one `index.ts` calls, and asserts that its last look advances with no capture changing.
 */

import { watchCapturedResolvers, CAPTURED_RESOLVER_DIR, type ResolverWatch } from '../platform/captured-resolvers.ts';
import type { ObserverRegistry } from './observers.ts';

export const RESOLVER_WATCH_CHECK_MS = 30_000;

export function observeCapturedResolvers(input: {
  observers: ObserverRegistry;
  onCapture: () => void;
  onUnavailable?: (reason: string) => void;
  onEstablished?: (afterRetry: boolean) => void;
  directory?: string;
  /** The inode check and the retry share one cadence, so the observer's cadence is that one number. */
  checkMs?: number;
  debounceMs?: number;
}): ResolverWatch {
  const directory = input.directory ?? CAPTURED_RESOLVER_DIR;
  const checkMs = input.checkMs ?? RESOLVER_WATCH_CHECK_MS;
  const observer = input.observers.register({
    name: 'resolver-watch',
    watches: `${directory}, where the tunnel up-script writes the resolver each peer pushed`,
    // A cadence, now: every check is a look, so an observer that stops looking goes stale.
    everyMs: checkMs,
  });
  return watchCapturedResolvers(
    () => {
      observer.looked(`a capture changed in ${directory}`);
      observer.acted('asked the resolver follower to compare');
      input.onCapture();
    },
    {
      directory,
      verifyMs: checkMs,
      retryMs: checkMs,
      ...(input.debounceMs === undefined ? {} : { debounceMs: input.debounceMs }),
      onChecked: (saw) => observer.looked(saw),
      onUnavailable: (reason) => {
        observer.notRunning(`the watch is not established and is retried every ${String(Math.round(checkMs / 1000))}s: ${reason}`);
        input.onUnavailable?.(reason);
      },
      onWatching: (afterRetry) => {
        observer.armed();
        input.onEstablished?.(afterRetry);
      },
    },
  );
}
