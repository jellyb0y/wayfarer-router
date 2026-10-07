/**
 * Resolver addresses captured from tunnel peers, and the notification that they changed.
 *
 * ## Why this exists at all
 *
 * A corporate peer chooses the resolver at connection time and may choose a different one depending on
 * which of its gateways answered. Measured on the bench board, 2026-09-21, from one tunnel in one
 * evening: `10.184.100.5`, `10.184.40.5` and `10.184.48.5`, with only the current one reachable through the
 * tunnel and the other two silent. Over the same evening that tunnel reconnected **six times in forty
 * minutes** — a peer with a short inactivity timeout and several sites to choose from moves a device
 * regularly, including at night with nobody watching.
 *
 * So a profile cannot hold this value. It is a runtime reading, like the network an uplink is on.
 *
 * ## Why a watcher and not a read at apply time
 *
 * Reading the captured file when a plan is generated would produce the right answer only when a plan
 * happens to be generated after a move. With reconnections at that rate and applies at human rate, that
 * is close to a coin toss — which is precisely the state this replaces, where a hardcoded address was
 * right about half the time. **The write has to provoke the read**, or the value is merely stored.
 *
 * The producer already writes atomically — a temporary file and a rename — so a watcher sees whole
 * values and never a half-written one.
 */

import { statSync, watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where the up script puts what a peer pushed. One definition, shared with the script's own path. */
export const CAPTURED_RESOLVER_DIR = '/run/wayfarer/tunnel';

/**
 * Every captured resolver, by tunnel id.
 *
 * A missing directory is not an error: it is the normal state before any tunnel has connected, and an
 * empty map is the honest answer to "what have peers pushed so far". The caller decides what to do with
 * the absence — see the planner, which falls back to the profile's value and says so in a finding.
 */
export async function readCapturedResolvers(directory = CAPTURED_RESOLVER_DIR): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return found;
  }

  for (const name of names) {
    if (!name.endsWith('.dns')) continue;
    const id = name.slice(0, -'.dns'.length);
    if (id === '') continue;
    try {
      const text = await readFile(join(directory, name), 'utf8');
      // The producer may write several addresses, newline separated; the first is the one in use.
      const first = text.split('\n').map((line) => line.trim()).find((line) => line !== '');
      if (first !== undefined) found.set(id, first);
    } catch {
      // A file that vanished between listing and reading is a tunnel going down mid-read, which is a
      // thing that happens rather than a fault. It is absent from the map, which is what it now is.
    }
  }
  return found;
}

/**
 * Call `onChange` when a captured resolver appears, changes or disappears.
 *
 * **Debounced**, because a reconnection writes the file as part of a burst of other activity and a peer
 * that is flapping would otherwise drive a reconverge per flap. The delay is deliberately longer than a
 * single reconnection takes: it is better to act once on the settled value than three times on values
 * that are already stale.
 *
 * ## The directory does not exist when the daemon starts, and that used to be the end of it
 *
 * Measured by reading the shipped script, and it explains a mechanism that did nothing on a board
 * where every other part of it worked. `/run/wayfarer/tunnel` is created by `tunnel-up`, which runs
 * when a tunnel first connects — *after* the daemon has started, on every boot, because `/run` is
 * empty at boot and the daemon comes up before any tunnel. `watch()` then throws `ENOENT`, this
 * function returned `null`, the daemon recorded that it was not watching, and **nothing ever looked
 * again**. The comment at the call site said it was retried once the stack was up. It was not: the
 * returned handle was assigned to a variable nobody read again.
 *
 * So an absent directory is now a state this lives through rather than dies of. It retries, and the
 * caller is told both when watching stops and when it starts — a claim of "watching" that nobody can
 * check is the shape this file's own catalogue entry is about.
 *
 * ## Why becoming available fires `onChange`
 *
 * A watcher is blind to everything that happened before it existed. Between a daemon start and the
 * moment a watch is established, a peer can push a resolver and the up script can write it, and no
 * event will ever be delivered for a write that already happened. So establishing the watch is itself
 * treated as a change: the caller compares what is captured with what the core was given and does
 * nothing when they agree, which makes an unnecessary check free and a missed one impossible.
 */
export interface ResolverWatch {
  stop: () => void;
  /** Whether a watch is established right now, rather than whether one was ever asked for. */
  watching: () => boolean;
}

export function watchCapturedResolvers(
  onChange: () => void,
  options: {
    directory?: string;
    debounceMs?: number;
    /** How long to wait before looking for the directory again. */
    retryMs?: number;
    /** How often to check that the watch still follows the directory at this path. */
    verifyMs?: number;
    /**
     * Told what every check saw — the same inode, a replaced directory, a missing one, or a failed
     * attempt to watch. Measured on the bench board, 2026-09-23: the 30 s check ran and recorded
     * nothing, so the observer's last look was null for eighteen minutes after start-up and then stood
     * still while the check went on running. A check that says nothing is indistinguishable from none.
     */
    onChecked?: (saw: string) => void;
    /** Called when a watch could not be established or was lost, with the reason, each time. */
    onUnavailable?: (reason: string) => void;
    /** Called when a watch is established. `afterRetry` is false only for the very first attempt. */
    onWatching?: (afterRetry: boolean) => void;
  } = {},
): ResolverWatch {
  const directory = options.directory ?? CAPTURED_RESOLVER_DIR;
  const debounceMs = options.debounceMs ?? 3000;
  const retryMs = options.retryMs ?? 30_000;
  const verifyMs = options.verifyMs ?? 30_000;

  let debounce: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | null = null;
  let stopped = false;
  let attempted = false;
  let reportedUnavailable = false;
  /** The inode the watch was established on. See `verify`. */
  let watchedInode: number | null = null;
  let verifier: NodeJS.Timeout | undefined;

  /**
   * **Is the watch still on the directory at this path?**
   *
   * Measured on the bench board's own node, 2026-09-23: renaming or deleting a watched directory
   * delivers a `rename` (or `change`) event and **never** `error`. The watch then follows the old
   * inode — renamed away, or deleted and gone — and a directory recreated at the path is watched by
   * nobody, while this reported itself as watching. So the path is stat'ed after every event and on a
   * cadence, and an inode that is missing or different is a lost watch: closed, reported, re-armed.
   */
  function verify(): void {
    if (stopped || watcher === null) return;
    let inode: number | null = null;
    try {
      inode = statSync(directory).ino;
    } catch {
      inode = null;
    }
    if (inode !== null && inode === watchedInode) {
      options.onChecked?.(`watching ${directory}; the watch is on the directory at the path (inode ${String(inode)})`);
      return;
    }
    options.onChecked?.(
      inode === null
        ? `${directory} is gone: the watch had followed it away`
        : `${directory} is a different directory (inode ${String(inode)}, watched ${String(watchedInode)})`,
    );
    const dead = watcher;
    watcher = null;
    watchedInode = null;
    dead.close();
    scheduleRetry(
      inode === null
        ? `the watched directory ${directory} was removed or renamed; the watch followed it away`
        : `${directory} was replaced by another directory; the watch was on the old one`,
    );
  }

  function schedule(): void {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(onChange, debounceMs);
  }

  function scheduleRetry(reason: string): void {
    // Reported on the **transition** into unavailability, not on every attempt. A retry every thirty
    // seconds that records a line every thirty seconds is a log nobody reads, and a log nobody reads
    // is how the last one of these hid.
    if (!reportedUnavailable) {
      reportedUnavailable = true;
      options.onUnavailable?.(reason);
    }
    if (stopped || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      attempt();
    }, retryMs);
    // The retry must not be what keeps the process alive; the watch itself is not persistent either.
    retry.unref?.();
  }

  function attempt(): void {
    if (stopped || watcher !== null) return;
    const first = !attempted;
    attempted = true;
    try {
      watchedInode = statSync(directory).ino;
      watcher = watch(directory, { persistent: false });
    } catch (error) {
      watcher = null;
      options.onChecked?.(`${directory} cannot be watched yet, retrying every ${String(Math.round(retryMs / 1000))}s: ${String(error)}`);
      scheduleRetry(String(error));
      return;
    }
    options.onChecked?.(`watch established on ${directory} (inode ${String(watchedInode)})`);

    // Every event is also a moment to check the watch is still on this path — see `verify`.
    watcher.on('change', () => {
      schedule();
      verify();
    });
    // A watcher that errors is stopped rather than left half-alive: a dead watcher that still looks
    // installed is the same defect as everything else in this file's catalogue entry. It is retried
    // for the same reason — the directory can come back, and a device that gave up on it silently
    // stops following its peers' resolvers for as long as the daemon runs.
    watcher.on('error', (error) => {
      const dead = watcher;
      watcher = null;
      dead?.close();
      scheduleRetry(String(error));
    });

    reportedUnavailable = false;
    options.onWatching?.(!first);
    // Everything captured while nobody was watching is delivered as one change. See above.
    if (!first) schedule();
  }

  attempt();
  verifier = setInterval(verify, verifyMs);
  verifier.unref?.();

  return {
    stop(): void {
      stopped = true;
      if (verifier !== undefined) clearInterval(verifier);
      if (debounce !== undefined) clearTimeout(debounce);
      if (retry !== undefined) clearTimeout(retry);
      watcher?.close();
      watcher = null;
    },
    watching: () => watcher !== null,
  };
}
