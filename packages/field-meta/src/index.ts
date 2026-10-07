/**
 * The metadata overlay for generated forms, keyed by JSON Pointer.
 *
 * The schema a proxy core emits has no `description` or `title` fields at all, so labels are ours.
 * They live in an overlay rather than in the schema because the schema comes from the installed
 * binary and is replaced whenever that binary changes.
 *
 * The property that makes the whole approach work: **the overlay is optional, per field.** A field
 * with no entry renders with its raw schema key as the label, in the advanced group, with a plain
 * widget for its type. A protocol released this morning therefore produces a usable form with no
 * work, and a pleasant one after ten lines here. Degrading to "usable" instead of "broken" is the
 * design goal.
 */

export type FieldLevel = 'basic' | 'advanced' | 'expert';

export interface FieldMeta {
  label?: string;
  help?: string;
  /** Group heading to render the field under. */
  group?: string;
  /** Sort order within its group; unspecified fields follow schema order. */
  order?: number;
  /** Widget hint. The schema decides first: an enum is a select whatever this says. */
  widget?: 'text' | 'number' | 'switch' | 'select' | 'password' | 'textarea' | 'tag-reference';
  level?: FieldLevel;
  /** Marks a secret when the schema does not. Redaction itself derives from the schema. */
  secret?: boolean;
}

/**
 * Keys are JSON Pointers with one wildcard form: a `*` segment matches any single segment, so
 * `#/outbound/*​/server` labels the server field of every protocol at once. Exact matches win over
 * wildcard matches, and a more specific wildcard wins over a less specific one.
 */
export type FieldMetaOverlay = Record<string, FieldMeta>;

export interface ResolvedFieldMeta extends FieldMeta {
  /** The overlay key that matched, or null when nothing did. Useful for debugging a form. */
  matchedBy: string | null;
}

const EMPTY: ResolvedFieldMeta = { matchedBy: null };

/**
 * Looks up the metadata for one pointer. Never throws and never returns undefined: a missing entry
 * is a resolved value with nothing in it, which is what lets a form render a field nobody has
 * described yet.
 */
export function resolveFieldMeta(overlay: FieldMetaOverlay, pointer: string): ResolvedFieldMeta {
  const exact = overlay[pointer];
  if (exact) return { ...exact, matchedBy: pointer };

  const segments = pointer.split('/');
  let best: { key: string; meta: FieldMeta; wildcards: number } | null = null;

  for (const [key, meta] of Object.entries(overlay)) {
    if (!key.includes('*')) continue;
    const keySegments = key.split('/');
    if (keySegments.length !== segments.length) continue;

    let wildcards = 0;
    let matches = true;
    for (let index = 0; index < keySegments.length; index += 1) {
      const keySegment = keySegments[index]!;
      if (keySegment === '*') {
        wildcards += 1;
        continue;
      }
      if (keySegment !== segments[index]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    // Fewer wildcards is more specific; a tie keeps the first entry, so the overlay's own order is
    // the tiebreak rather than object key order mattering somewhere else.
    if (best === null || wildcards < best.wildcards) best = { key, meta, wildcards };
  }

  return best === null ? EMPTY : { ...best.meta, matchedBy: best.key };
}

/** Fields grouped for rendering, with anything ungrouped last under a neutral heading. */
export function groupFields<T extends { pointer: string }>(
  fields: T[],
  overlay: FieldMetaOverlay,
  fallbackGroup = 'Advanced',
): { group: string; fields: (T & { meta: ResolvedFieldMeta })[] }[] {
  const groups = new Map<string, (T & { meta: ResolvedFieldMeta })[]>();

  for (const field of fields) {
    const meta = resolveFieldMeta(overlay, field.pointer);
    const group = meta.group ?? fallbackGroup;
    const bucket = groups.get(group) ?? [];
    bucket.push({ ...field, meta });
    groups.set(group, bucket);
  }

  for (const bucket of groups.values()) {
    bucket.sort((a, b) => (a.meta.order ?? Number.MAX_SAFE_INTEGER) - (b.meta.order ?? Number.MAX_SAFE_INTEGER));
  }

  return [...groups.entries()].map(([group, grouped]) => ({ group, fields: grouped }));
}
