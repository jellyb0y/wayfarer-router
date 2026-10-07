/**
 * Reading the journal, which is one of the two log surfaces (the other is the persistent
 * event ring in the database).
 *
 * The journal on this board is RAM-backed and capped, so it holds everything the daemon
 * and the managed services emit and survives nothing. Measured: `journalctl --header`
 * reports the live journal under `/run/log/journal/…`, and `/run` is a tmpfs. Whether a
 * requested window predates the current boot is therefore a fact the caller must be told,
 * not a detail to hide — after an abrupt power loss an empty log would otherwise look like
 * an absence of events.
 *
 * Every read is paginated and capped. An unbounded journal read on a board with 1973 MB of
 * RAM is a memory hazard in the one component that must never fall over.
 */

import { run, runLines } from './exec.ts';
import { parseJournalJsonLines, type JournalEntry } from './parse/journal.ts';

export interface JournalQuery {
  /** Unit to filter by. Any unit is allowed: this is an authenticated diagnostic surface. */
  unit?: string;
  /** Maximum syslog priority, 0–7. 6 is informational, 3 is error. */
  maxPriority?: number;
  /** `-S` value: an absolute timestamp or a relative one such as `-1h`. */
  since?: string;
  /** Substring filter, applied by journalctl with `-g` (a regular expression). */
  grep?: string;
  /** Opaque cursor from a previous page. */
  afterCursor?: string;
  /** Hard cap, clamped to `maxLimit`. */
  limit?: number;
}

export interface JournalResult {
  entries: JournalEntry[];
  nextCursor: string | null;
  /** The boot the daemon is running in. */
  currentBootId: string | null;
  /**
   * True when at least one returned entry came from an earlier boot. The interface says
   * so, rather than presenting a mixed list as if it were continuous.
   */
  containsEarlierBoots: boolean;
  /**
   * True when more entries exist beyond this page — not merely that the page came out full.
   *
   * The distinction matters because the two look identical to a caller and mean opposite things: a
   * full page with nothing behind it is the end of the log, and a full page with more behind it is
   * a paging obligation. It is answered by reading one entry past the page and throwing it away.
   */
  hasMore: boolean;
  /**
   * True when this page is a **fragment**: the read was abandoned before the page filled, so the
   * window has a hole in it that no cursor will reveal.
   *
   * Reported separately from `hasMore` because collapsing the two is how the gap came back after it
   * was fixed: a read cut short by its own timeout looked exactly like a complete page, and a client
   * paging through it walked across the hole. An incomplete diagnostic window that announces itself
   * is fine; one that does not is a trap.
   */
  incomplete: boolean;
  /** Why the page is incomplete, in words the interface can show. Null when it is not. */
  incompleteReason: string | null;
  skippedLines: number;
}

export interface JournalReader {
  read(query: JournalQuery): Promise<JournalResult>;
  /** Boot id of the running kernel, read from the kernel rather than from journalctl. */
  currentBootId(): Promise<string | null>;
}

const JOURNALCTL = '/usr/bin/journalctl';
const MAX_LIMIT = 2000;

export function createJournalReader(journalctlPath = JOURNALCTL, readTimeoutMs = 20_000): JournalReader {
  let bootIdCache: string | null | undefined;

  const currentBootId = async (): Promise<string | null> => {
    if (bootIdCache !== undefined) return bootIdCache;
    const result = await run('/bin/cat', ['/proc/sys/kernel/random/boot_id'], { timeoutMs: 2000 });
    // journalctl prints the boot id without dashes, so the comparison is done on the
    // dash-free form throughout.
    const raw = result.stdout.trim().replace(/-/g, '');
    bootIdCache = raw === '' ? null : raw;
    return bootIdCache;
  };

  return {
    currentBootId,

    async read(query) {
      const limit = Math.min(Math.max(query.limit ?? 200, 1), MAX_LIMIT);
      const cursor = query.afterCursor?.trim() ?? '';
      const forward = cursor !== '';

      const args = ['-o', 'json', '--no-pager'];
      if (query.unit !== undefined && query.unit.trim() !== '') args.push('-u', query.unit.trim());
      if (query.maxPriority !== undefined) args.push('-p', String(Math.min(Math.max(query.maxPriority, 0), 7)));
      if (query.since !== undefined && query.since.trim() !== '') args.push('-S', query.since.trim());
      if (query.grep !== undefined && query.grep.trim() !== '') args.push('-g', query.grep.trim());

      let text: string;
      let hasMore: boolean;
      let incomplete = false;
      let incompleteReason: string | null = null;

      if (forward) {
        // Forward paging: NO `-n`. `-n` is tail-anchored, so `--after-cursor X -n 200` returns the
        // newest 200 matching entries and silently omits everything between the cursor and them —
        // the caller sees a continuous log and concludes that nothing happened in the gap. Reading
        // forward and stopping one line past the page keeps each page contiguous from where the
        // last one ended.
        args.push('--after-cursor', cursor);
        const result = await runLines(journalctlPath, args, { maxLines: limit, timeoutMs: readTimeoutMs });
        text = result.lines.join('\n');
        switch (result.kind) {
          case 'complete':
            hasMore = false;
            break;
          case 'more':
            hasMore = true;
            break;
          case 'cut-short':
            // More almost certainly exists — but the honest part is that this page stops at an
            // arbitrary point rather than at a page boundary, and the caller has to be told.
            hasMore = true;
            incomplete = true;
            incompleteReason =
              `the journal read was stopped after ${Math.round(readTimeoutMs / 1000)} s with ` +
              `${result.lines.length} of ${limit} entries; ` +
              'narrow the filter or the time window';
            break;
        }
      } else {
        // First page: the newest entries, which is what `-n` is for. One extra line is requested so
        // "there is more, older" can be reported rather than guessed from a full page.
        const result = await run(journalctlPath, [...args, '-n', String(limit + 1)], {
          timeoutMs: readTimeoutMs,
          // A generous but finite ceiling: the line count is bounded above and this bounds the
          // damage a single enormous line can do.
          maxOutputBytes: 16 * 1024 * 1024,
        });
        const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
        hasMore = lines.length > limit;
        if (result.timedOut) {
          incomplete = true;
          incompleteReason =
            `the journal read was stopped after ${Math.round(readTimeoutMs / 1000)} s; ` +
            'narrow the filter or the time window';
        } else if (result.truncated) {
          // The byte cap fired: the last line is very likely a fragment, and the page is short.
          incomplete = true;
          incompleteReason = 'the journal read hit its output size limit; narrow the filter or lower the limit';
        }
        // journalctl prints oldest first, so the extra line is the oldest one and is dropped from
        // the front.
        text = (hasMore ? lines.slice(lines.length - limit) : lines).join('\n');
      }

      const page = parseJournalJsonLines(text);
      const boot = await currentBootId();

      return {
        entries: page.entries,
        nextCursor: page.nextCursor,
        currentBootId: boot,
        containsEarlierBoots:
          boot !== null && page.entries.some((entry) => entry.bootId !== null && entry.bootId !== boot),
        hasMore,
        incomplete,
        incompleteReason,
        skippedLines: page.skipped,
      };
    },
  };
}
