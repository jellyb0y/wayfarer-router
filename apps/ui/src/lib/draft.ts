/**
 * The profile draft: one store, with dirty tracking.
 *
 * **Editing is local; Apply is explicit.** Every edit mutates a draft held here, and nothing reaches
 * the device until the operator saves and applies. That prevents the class of accident where
 * adjusting one field unexpectedly restarts a tunnel — and it is why a persistent bar shows how many
 * changes are pending rather than a toast that has already gone.
 *
 * The baseline is the document as the device last returned it, so "pending" is a comparison rather
 * than a counter somebody has to remember to increment.
 */

import { create } from 'zustand';

/** A pointer into the document, plus what it was and what it became. */
export interface PendingChange {
  pointer: string;
  from: unknown;
  to: unknown;
}

interface DraftState {
  profileId: string | null;
  /** The document as the device returned it. Secrets are `{ $set: boolean }` here. */
  baseline: Record<string, unknown> | null;
  /** The document as edited. */
  draft: Record<string, unknown> | null;
  load(profileId: string, document: Record<string, unknown>): void;
  /** Replaces the value at a pointer. Creates intermediate objects, never arrays. */
  set(pointer: string, value: unknown): void;
  discard(): void;
  clear(): void;
}

export const useDraft = create<DraftState>((set) => ({
  profileId: null,
  baseline: null,
  draft: null,

  load(profileId, document) {
    // Two independent copies: comparing the draft against a baseline that shares structure with it
    // would report nothing pending, because both sides would have changed together.
    set({
      profileId,
      baseline: structuredClone(document),
      draft: structuredClone(document),
    });
  },

  set(pointer, value) {
    set((state) => {
      if (state.draft === null) return state;
      return { draft: writeAt(structuredClone(state.draft), pointer, value) };
    });
  },

  discard() {
    set((state) => (state.baseline === null ? state : { draft: structuredClone(state.baseline) }));
  },

  clear() {
    set({ profileId: null, baseline: null, draft: null });
  },
}));

/**
 * Every position where the draft differs from the baseline.
 *
 * Compared **structurally** rather than by a change counter: a value edited and edited back is not a
 * pending change, and a counter would say it is. That matters because the bar's number is what an
 * operator uses to decide whether to press Review.
 */
export function pendingChanges(
  baseline: Record<string, unknown> | null,
  draft: Record<string, unknown> | null,
): PendingChange[] {
  if (baseline === null || draft === null) return [];
  const changes: PendingChange[] = [];
  walk(baseline, draft, '', changes);
  return changes;
}

function walk(before: unknown, after: unknown, pointer: string, changes: PendingChange[]): void {
  if (Object.is(before, after)) return;

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      changes.push({ pointer, from: `${before.length} entries`, to: `${after.length} entries` });
      return;
    }
    for (let index = 0; index < before.length; index += 1) {
      walk(before[index], after[index], `${pointer}/${index}`, changes);
    }
    return;
  }

  // A secret is compared as a whole and its *value* is never shown. Checked before the
  // record-versus-record branch and on **either** side, because the interesting case is asymmetric:
  // the baseline holds `{ $set: true }` and the draft holds the string the operator just typed. An
  // earlier version only looked at two records, so that case fell through to a raw value comparison
  // and put the new passphrase straight into the pending list — a plaintext credential on the one
  // surface whose whole job is to be read before applying.
  if (isSecretShaped(before) || isSecretShaped(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ pointer, from: describeSecret(before), to: describeSecret(after) });
    }
    return;
  }

  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      walk(before[key], after[key], `${pointer}/${escape(key)}`, changes);
    }
    return;
  }

  if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ pointer, from: before, to: after });
}

/** Reads the value at a pointer, or undefined. */
export function readAt(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  let current: unknown = document;
  for (const raw of pointer.split('/').slice(1)) {
    const segment = unescape(raw);
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Writes a value at a pointer, creating intermediate objects.
 *
 * It never creates an *array*, and that is deliberate rather than a limitation: growing an array by
 * writing to an index beyond its end produces holes, and a document with holes in `uplinks` fails
 * validation in a way whose message points at the wrong thing. Adding to a list is its own action.
 */
export function writeAt(
  document: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  const segments = pointer.split('/').slice(1).map(unescape);
  if (segments.length === 0) return document;

  let current: Record<string, unknown> | unknown[] = document;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (Array.isArray(current)) {
      const position = Number(segment);
      if (!Number.isInteger(position) || current[position] === undefined) return document;
      current = current[position] as Record<string, unknown>;
      continue;
    }
    const next = current[segment];
    if (!isRecord(next) && !Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }

  const last = segments[segments.length - 1]!;
  if (Array.isArray(current)) {
    const position = Number(last);
    if (Number.isInteger(position)) current[position] = value;
  } else if (value === undefined) {
    delete current[last];
  } else {
    current[last] = value;
  }

  return document;
}

/**
 * Turns the draft into a body the API will accept.
 *
 * Every secret the operator did not touch becomes `{ $keep: true }`. The read shape `{ $set: … }` is
 * refused by the write path on purpose — accepting it there would let a value that means "something
 * is stored" overwrite the thing that is stored.
 */
export function toWriteBody(draft: Record<string, unknown>): Record<string, unknown> {
  return convert(structuredClone(draft)) as Record<string, unknown>;
}

function convert(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convert);
  if (!isRecord(value)) return value;
  if ('$set' in value) return { $keep: true };
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = convert(entry);
  return output;
}

function escape(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescape(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Whether this position holds a secret, in any of the shapes it can take here.
 *
 * A bare string counts only when the *other* side was secret-shaped, which the caller establishes; on
 * its own a string is an ordinary value. So this covers the three wrappers, and the caller's `||`
 * covers the typed-value case.
 */
function isSecretShaped(value: unknown): boolean {
  return isRecord(value) && ('$set' in value || '$keep' in value || '$redacted' in value || '$secret' in value);
}

/** What a secret looks like in a diff: its state, never its value. */
function describeSecret(value: unknown): string {
  if (isRecord(value)) {
    if ('$redacted' in value) return 'missing';
    if ('$set' in value) return (value as { $set: boolean }).$set ? 'set' : 'not set';
    if ('$keep' in value) return 'unchanged';
  }
  if (value === undefined || value === null || value === '') return 'not set';
  // A string here is a value the operator just typed. It is never printed.
  return 'a new value';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
