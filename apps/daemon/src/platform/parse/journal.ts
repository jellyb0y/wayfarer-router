/**
 * Parser for `journalctl -o json`, one JSON object per line.
 *
 * Three properties of that format that the obvious reader gets wrong:
 *
 * 1. **Timestamps are microsecond strings, not numbers.** `__REALTIME_TIMESTAMP` is a
 *    decimal string of microseconds since the epoch, wide enough to lose precision as
 *    a double if it were ever treated as one. Kept as a string, converted to
 *    milliseconds only for display.
 * 2. **`MESSAGE` is not always a string.** When a line contains bytes that are not
 *    valid UTF-8, journald emits it as an array of byte values. A reader that assumes
 *    a string produces `[object Object]` in the interface.
 * 3. **`_BOOT_ID` is the only way to know whether a line is from this boot.** On this
 *    board the live journal is RAM-backed, so after an abrupt power loss everything
 *    before the current boot is gone; the interface must say that rather than let an
 *    empty log look like an absence of events.
 */

export interface JournalEntry {
  /** Opaque cursor, used for pagination — never parsed. */
  cursor: string | null;
  /** Microseconds since the epoch, as the string journald emitted. */
  realtimeUsec: string | null;
  /** Milliseconds since the epoch, for display. Null when the field was missing. */
  atMs: number | null;
  bootId: string | null;
  /** syslog priority 0–7; null when absent. */
  priority: number | null;
  unit: string | null;
  identifier: string | null;
  pid: number | null;
  message: string;
  /** True when MESSAGE arrived as a byte array and was decoded here. */
  messageWasBinary: boolean;
}

export interface JournalPage {
  entries: JournalEntry[];
  /** Cursor of the last entry, for the next request. */
  nextCursor: string | null;
  /** Boot ids present in this page, so a caller can report a boundary. */
  bootIds: string[];
  /** Lines that were not valid JSON, counted rather than thrown. */
  skipped: number;
}

export function parseJournalJsonLines(output: string): JournalPage {
  const entries: JournalEntry[] = [];
  const bootIds = new Set<string>();
  let skipped = 0;

  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isRecord(raw)) {
      skipped += 1;
      continue;
    }

    const realtime = asString(raw['__REALTIME_TIMESTAMP']);
    const decoded = decodeMessage(raw['MESSAGE']);
    const bootId = asString(raw['_BOOT_ID']);
    if (bootId) bootIds.add(bootId);

    entries.push({
      cursor: asString(raw['__CURSOR']),
      realtimeUsec: realtime,
      atMs: realtime === null ? null : Math.floor(Number(realtime) / 1000),
      bootId,
      priority: asInt(raw['PRIORITY']),
      unit: asString(raw['_SYSTEMD_UNIT']) ?? asString(raw['UNIT']),
      identifier: asString(raw['SYSLOG_IDENTIFIER']),
      pid: asInt(raw['_PID']) ?? asInt(raw['SYSLOG_PID']),
      message: decoded.text,
      messageWasBinary: decoded.binary,
    });
  }

  return {
    entries,
    nextCursor: entries.length > 0 ? (entries[entries.length - 1]!.cursor ?? null) : null,
    bootIds: [...bootIds],
    skipped,
  };
}

function decodeMessage(value: unknown): { text: string; binary: boolean } {
  if (typeof value === 'string') return { text: value, binary: false };
  if (Array.isArray(value)) {
    const bytes = value.filter((v): v is number => typeof v === 'number');
    return { text: Buffer.from(bytes).toString('utf8'), binary: true };
  }
  if (value === undefined || value === null) return { text: '', binary: false };
  return { text: String(value), binary: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
