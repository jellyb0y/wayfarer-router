/**
 * The four behaviours `x-secret` drives, derived mechanically from the annotation.
 *
 * ## Why matchers rather than a lockstep walk
 *
 * The obvious implementation walks the schema and the document together. It breaks on the first
 * union: a profile's `uplinks` holds either shape, and deciding which branch a value belongs to
 * means re-implementing discrimination for a schema that has no discriminator keyword.
 *
 * So the schema is reduced *once* to a list of **matchers** — JSON Pointers in which `-` stands for
 * any array index, which is the pointer form for "any element" anyway. `/uplinks/-/config/psk`
 * matches the Wi-Fi branch and matches nothing in the Ethernet branch, because an Ethernet uplink
 * simply has no `psk` key. The union question disappears instead of being answered.
 *
 * It also gives the provider layer somewhere to stand: a tunnel's `config` is opaque to the profile
 * schema by design, so secrets inside it arrive as extra matchers computed from whatever schema the
 * provider serves.
 *
 * ## The one behaviour that needs none of this
 *
 * The logger redactor works **structurally** on the storage wrapper: anything shaped
 * `{"$secret": …}` is replaced, whatever it is called, wherever it came from, and whether or not
 * any schema describes it. That is the only one of the four that is safe by construction, and it is
 * deliberately not routed through the matchers — a redactor that depends on a schema lookup fails
 * open exactly when an unexpected document reaches the log.
 */

import type { TSchema } from '@sinclair/typebox';
import {
  isEmptySecretValue,
  isKeepSecret,
  isRecord,
  isReadSecret,
  isRedactedSecret,
  isSecretSchema,
  isSecretValue,
  isStoredSecret,
  secretKindOf,
  secretPointers,
  type SecretKind,
} from './secrets.ts';

/** A JSON Pointer in which `-` matches any array index. */
export type SecretMatcher = string;

export interface SecretSite {
  /** The concrete pointer into the document, array indices included. */
  pointer: string;
  kind: SecretKind;
}

/**
 * Reduces a schema to the matchers its secrets live at, keyed by matcher so a kind can be recovered
 * later without walking the schema again.
 */
export function secretMatchers(schema: TSchema | Record<string, unknown>): Map<SecretMatcher, SecretKind> {
  const matchers = new Map<SecretMatcher, SecretKind>();
  const pointers = secretPointers(schema);
  for (const pointer of pointers) {
    matchers.set(pointer, kindAt(schema as Record<string, unknown>, pointer));
  }
  return matchers;
}

/** Whether a concrete pointer matches a matcher, treating `-` as any array index. */
export function matchesPointer(matcher: SecretMatcher, pointer: string): boolean {
  const a = matcher.split('/');
  const b = pointer.split('/');
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] === '-') continue;
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function kindFor(matchers: Map<SecretMatcher, SecretKind>, pointer: string): SecretKind | null {
  // An exact matcher wins over one containing `-`: a field described specifically is described
  // better than a field described for every element of an array.
  const exact = matchers.get(pointer);
  if (exact !== undefined) return exact;
  let wildcard: SecretKind | null = null;
  for (const [matcher, kind] of matchers) {
    if (!matcher.includes('-')) continue;
    if (matchesPointer(matcher, pointer)) wildcard ??= kind;
  }
  return wildcard;
}

/* ── walking a document ──────────────────────────────────────────────────────────────────── */

type Transform = (value: unknown, kind: SecretKind, pointer: string) => unknown;

/**
 * Rebuilds `document`, replacing every value at a secret position with `transform`'s result.
 *
 * Returns a new structure; the input is never mutated. That matters more than it looks: the
 * exporter and the read path both run over the *stored* document, and a transform that mutated it
 * would redact the copy the daemon is about to apply.
 */
function mapSecrets(
  document: unknown,
  matchers: Map<SecretMatcher, SecretKind>,
  transform: Transform,
  pointer = '',
): unknown {
  const kind = pointer === '' ? null : kindFor(matchers, pointer);
  if (kind !== null) return transform(document, kind, pointer);

  if (Array.isArray(document)) {
    return document.map((entry, index) => mapSecrets(entry, matchers, transform, `${pointer}/${index}`));
  }
  if (isRecord(document)) {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document)) {
      output[key] = mapSecrets(value, matchers, transform, `${pointer}/${escapeSegment(key)}`);
    }
    return output;
  }
  return document;
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/* ── the four behaviours ─────────────────────────────────────────────────────────────────── */

/**
 * Storage. A bare string at a secret position becomes `{"$secret": "…"}`.
 *
 * The wrapper is not decoration. Code that walks a document generically — the differ, the exporter,
 * the logger — has no schema in hand, and a wrapper is the only thing that stops it treating a
 * private key as an ordinary string it may print.
 */
export function wrapSecrets(document: unknown, matchers: Map<SecretMatcher, SecretKind>): unknown {
  return mapSecrets(document, matchers, (value) => {
    if (isStoredSecret(value)) return value;
    // A list of strings as readily as a string: a key given as several lines is still one secret.
    if (isSecretValue(value)) return { $secret: value };
    // A redacted marker survives storage untouched: an imported profile keeps its gaps visible
    // until someone fills them, which is what the import checklist reads.
    if (isRedactedSecret(value)) return value;
    return value;
  });
}

/**
 * A fifth shape, and it is not a behaviour: **the document as the canonical schema describes it**.
 *
 * The canonical schema holds a plain string at a secret position. Storage holds `{"$secret": …}`,
 * and an imported redacted export holds `{"$redacted": …}` — both correct documents at their own
 * moment. A validator that knew only the canonical form would refuse every stored profile and every
 * redacted import, and the second of those is a designed feature with `missingSecrets` as its
 * report. So a validator reads the wrappers *through*, and only at secret positions: a
 * `{"$redacted"}` anywhere else is still a value of the wrong type, which is the whole reason this
 * goes through the matchers rather than matching the wrapper structurally.
 *
 * A stored list of strings becomes one string joined by newlines, which is the same reading the
 * migration's `readable()` gives it — a key supplied as several lines is one secret, and validating
 * it as a list would refuse a document every consumer reads correctly.
 *
 * A gap keeps its length rather than becoming an empty string: `minLength` on a secret would
 * otherwise turn "this import is missing a value, and the checklist says so" into a refusal.
 */
export function unwrapForValidation(document: unknown, matchers: Map<SecretMatcher, SecretKind>): unknown {
  return mapSecrets(document, matchers, (value) => {
    if (isStoredSecret(value)) {
      return Array.isArray(value.$secret) ? value.$secret.join('\n') : value.$secret;
    }
    // Deliberately not `''`: a gap is a value that is not here yet, not a value that is empty.
    if (isRedactedSecret(value) || isKeepSecret(value)) return 'a value that is not in this document';
    // Anything else — a read-shaped `{"$set": …}`, a number, an object — is left as it is, so the
    // schema refuses it. Laundering an unrecognised shape here is how a validator stops validating.
    return value;
  });
}

/** What a `GET` returns: whether a value is set, never the value. */
export function redactForRead(document: unknown, matchers: Map<SecretMatcher, SecretKind>): unknown {
  return mapSecrets(document, matchers, (value) => ({
    $set: isStoredSecret(value) && !isEmptySecretValue(value.$secret),
  }));
}

/**
 * The sharing format. The value is replaced by what a person has to go and find.
 *
 * A kind label rather than free text, because the checklist on the importing device has to name the
 * missing thing and free text is neither translatable nor checkable. The JSON Pointer already says
 * which field it is.
 */
export function redactForExport(document: unknown, matchers: Map<SecretMatcher, SecretKind>): unknown {
  return mapSecrets(document, matchers, (value, kind) => {
    if (isRedactedSecret(value)) return value;
    return { $redacted: kind };
  });
}

/**
 * A write. Each secret position takes a literal value, or `{"$keep": true}` to leave the stored one
 * alone, and anything else at that position is an error the caller must report with its pointer.
 *
 * `$keep` exists because the interface never receives the value it is editing — it receives
 * `{"$set": true}` — so a form that saved what it was given would blank every secret on the first
 * save of an unrelated field. That failure is silent until a tunnel stops connecting.
 */
export function applyWrite(
  incoming: unknown,
  stored: unknown,
  matchers: Map<SecretMatcher, SecretKind>,
): { document: unknown; errors: { pointer: string; message: string }[] } {
  const errors: { pointer: string; message: string }[] = [];

  const document = mapSecrets(incoming, matchers, (value, kind, pointer) => {
    if (isKeepSecret(value)) {
      // By identity, not by position: see `counterpartPointer`.
      const counterpart = counterpartPointer(incoming, stored, pointer);
      const existing = counterpart === null ? undefined : valueAt(stored, counterpart);
      if (isStoredSecret(existing) || isRedactedSecret(existing)) return existing;
      errors.push({
        pointer,
        message: `"$keep" was given for a ${kind} that has no stored value to keep`,
      });
      return value;
    }
    if (isSecretValue(value)) return { $secret: value };
    if (isStoredSecret(value) || isRedactedSecret(value)) return value;
    if (value === null || value === undefined) return value;

    /**
     * The read shape, written back.
     *
     * Named specifically because it is **the** mistake at this position, not one of many: a `GET`
     * returns `{"$set": true}`, so the most natural automation there is — read the document, change one
     * field, write it back — fails on every secret the profile has. Measured against the running
     * daemon on the bench board while doing exactly that.
     *
     * The generic message stated the rule correctly and still left the caller to work out which rule
     * they had broken. An error that names the mistake costs one branch and saves the reader the step
     * of comparing two shapes character by character.
     */
    if (isReadSecret(value)) {
      errors.push({
        pointer,
        message:
          `this is the shape a GET returns ({"$set": …}), not a shape a write accepts. A read never ` +
          `reveals a ${kind}, so send the value itself to change it, or {"$keep": true} to leave the ` +
          'stored one alone.',
      });
      return value;
    }

    errors.push({
      pointer,
      message: `expected a ${kind} as a string or a list of strings, or {"$keep": true}`,
    });
    return value;
  });

  /**
   * A secret the write simply **left out**, which until now was the one way to lose one silently.
   *
   * Everything above walks the *incoming* document, so a position the caller omitted is a position
   * this function never visits: no value to check, no `$keep` to resolve, no error — and the merged
   * document is written without it. Measured on the owner's live profile, 2026-09-21: an API write
   * dropped six stored secrets this way, five of them the `uid` of an obfuscation entry point. The
   * device kept running because nothing had been applied, and the stored document was wrong from
   * that moment on; applying it would have stopped six services.
   *
   * The sequence that produces it is ordinary, not exotic: a client reads the document, finds
   * `{"$set": …}` where a value should be, learns that `{"$keep": true}` is refused at that pointer,
   * and does the only remaining thing — omits the field. Every step is reasonable and the result is
   * data loss, which is why the refusal has to be here rather than in a client's good manners.
   */
  for (const dropped of droppedSecrets(document, stored, matchers)) {
    errors.push({
      pointer: dropped.pointer,
      message:
        `this write leaves out a ${dropped.kind} that is stored here, which would delete it. Send ` +
        'the value itself to change it, or {"$keep": true} to leave the stored one alone. Removing ' +
        'the whole thing it belongs to is how a secret is deliberately discarded.',
    });
  }

  return { document, errors };
}

/**
 * Stored secrets that a candidate document no longer carries, although the thing holding them
 * survived.
 *
 * The qualification is the whole of it. Deleting a tunnel deletes its credentials and that is the
 * point; **dropping a field out of a tunnel that is still there** is a loss nobody asked for. So a
 * position is only reported when its parent still exists in the candidate — an entry point removed
 * from a list takes its `uid` with it and says nothing, while an entry point that stayed and lost
 * its `uid` is reported.
 *
 * Exported so the check can be exercised directly, in both directions: a write that omits a stored
 * secret must fail, and a write that removes its container must not.
 */
export function droppedSecrets(
  candidate: unknown,
  stored: unknown,
  matchers: Map<SecretMatcher, SecretKind>,
): SecretSite[] {
  const dropped: SecretSite[] = [];

  mapSecrets(stored, matchers, (value, kind, pointer) => {
    // Nothing is stored there, so nothing can be lost. An empty secret is the same case: the import
    // checklist already reports it as a gap to fill, and refusing a write over it would make a
    // profile with a known gap impossible to edit at all.
    if (!isStoredSecret(value) || isEmptySecretValue(value.$secret)) return value;

    // The same element in the candidate, found by identity: after a reorder the stored position holds
    // a different tunnel, and comparing positions would report — or miss — the wrong one.
    const counterpart = counterpartPointer(stored, candidate, pointer);
    if (counterpart === null) return value;
    const parent = counterpart.slice(0, counterpart.lastIndexOf('/'));
    const survivingParent = valueAt(candidate, parent);
    if (survivingParent === undefined) return value;

    if (valueAt(candidate, counterpart) === undefined) dropped.push({ pointer: counterpart, kind });
    return value;
  });

  return dropped;
}

/**
 * The import gap checklist: every secret position whose value is a redaction marker, so the
 * interface can list exactly what must be filled in before the profile can be activated.
 *
 * This is the reason a redacted export is imported rather than rejected. The structure is the
 * valuable part and it transfers; the gaps become explicit instead of hidden.
 */
export function missingSecrets(document: unknown, matchers: Map<SecretMatcher, SecretKind>): SecretSite[] {
  const missing: SecretSite[] = [];
  mapSecrets(document, matchers, (value, kind, pointer) => {
    if (isRedactedSecret(value)) missing.push({ pointer, kind: value.$redacted as SecretKind });
    else if (value === null || value === undefined) missing.push({ pointer, kind });
    else if (isStoredSecret(value) && isEmptySecretValue(value.$secret)) missing.push({ pointer, kind });
    return value;
  });
  return missing;
}

/* ── the logger redactor ─────────────────────────────────────────────────────────────────── */

export const REDACTED = '[redacted]';

/**
 * Replaces every stored secret in an arbitrary value, structurally.
 *
 * No schema, no matchers, no list of field names: anything shaped `{"$secret": …}` is replaced. A
 * redactor that needed to look a field up would fail open on precisely the document nobody
 * anticipated, which is the one most likely to end up in a log line during an incident.
 *
 * Cycles are tolerated because a log call is not a place to throw — a logger that can crash the
 * caller is worse than a log line that says `[cyclic]`.
 */
export function redactForLog(value: unknown, seen = new WeakSet<object>()): unknown {
  if (isStoredSecret(value)) return { $secret: REDACTED };
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[cyclic]';
    seen.add(value);
  }
  if (Array.isArray(value)) return value.map((entry) => redactForLog(entry, seen));
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) output[key] = redactForLog(entry, seen);
    return output;
  }
  return value;
}

/* ── helpers ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The field that identifies an element of a list, where the list has one.
 *
 * Every list in a profile that can hold a secret — tunnels, uplinks, entry points, transports — keys
 * its elements by `id`, and the identity is what a secret belongs to. The position is not: it is
 * where the element happens to sit in this particular write.
 */
const ELEMENT_KEY = 'id';

function keyOf(element: unknown): string | null {
  if (!isRecord(element)) return null;
  const key = element[ELEMENT_KEY];
  return typeof key === 'string' && key !== '' ? key : null;
}

/**
 * The pointer, in `to`, of the thing `pointer` names in `from` — following list elements by their key
 * rather than by their index. `null` when `to` has no such element.
 *
 * ## Why positions had to go
 *
 * Measured on the bench board, 2026-09-23: inserting a tunnel anywhere but last was refused with
 * `invalid_secret_write` at `/tunnels/1/…`, because `{"$keep": true}` was resolved at the same index
 * in the stored document, and every tunnel after the insertion had moved down one place. Reordering
 * was worse: where two neighbours both held a credential at the same field, each kept the *other's*,
 * and nothing said so. A position is where an element sits in this write; the key is what it is.
 *
 * An element with no key is matched by index, as before — there is nothing else to match it by — but
 * only against another element with no key, so a keyed element can never be matched by position.
 */
export function counterpartPointer(from: unknown, to: unknown, pointer: string): string | null {
  if (pointer === '') return '';
  let source: unknown = from;
  let target: unknown = to;
  const out: string[] = [];
  for (const raw of pointer.split('/').slice(1)) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(source)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || !Array.isArray(target)) return null;
      const element = source[index];
      const key = keyOf(element);
      const matched =
        key === null
          ? keyOf(target[index]) === null && index < target.length
            ? index
            : -1
          : target.findIndex((candidate) => keyOf(candidate) === key);
      if (matched < 0) return null;
      out.push(String(matched));
      source = element;
      target = target[matched];
    } else if (isRecord(source)) {
      out.push(raw);
      source = source[segment];
      target = isRecord(target) ? target[segment] : undefined;
    } else {
      return null;
    }
  }
  return `/${out.join('/')}`;
}

function valueAt(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  let current: unknown = document;
  for (const raw of pointer.split('/').slice(1)) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Recovers the kind declared at a matcher, by walking the schema to that position.
 *
 * The walk keeps **every** candidate node rather than one, and that is the whole correctness of it.
 * An optional secret is written `Type.Union([Secret({ kind: 'psk' }), Type.Null()])`, and an array of
 * unions — `uplinks` — means a pointer like `/uplinks/-/config/psk` passes through a union *before*
 * the leaf. A walk that committed to the first branch containing `config` chose the Ethernet branch,
 * found no `psk` under it, and returned the generic kind. The symptom was an import checklist saying
 * "a secret is missing here" where it could have said "a pre-shared key" — most of the value the kind
 * label exists for, lost silently.
 */
function kindAt(schema: Record<string, unknown>, pointer: string): SecretKind {
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

  let frontier: unknown[] = [schema];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const node of frontier) next.push(...descendAll(node, segment));
    if (next.length === 0) return 'secret';
    frontier = next;
  }

  // Among everything the pointer can reach, the one that declares a secret is the answer. There is at
  // most one in practice; taking the first is stated rather than incidental.
  for (const node of frontier) {
    const branch = secretBranchOf(node);
    if (branch !== null) return secretKindOf(branch);
  }
  return 'secret';
}

/** The branch of a union that declares the secret, when the node itself is a union. */
function secretBranchOf(node: unknown): unknown {
  if (!isRecord(node)) return null;
  if (isSecretSchema(node)) return node;
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const found = secretBranchOf(branch);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Every node one segment can lead to, following unions rather than choosing between them. */
function descendAll(node: unknown, segment: string): unknown[] {
  if (!isRecord(node)) return [];

  const found: unknown[] = [];

  if (segment === '-') {
    if (isRecord(node['items'])) found.push(node['items']);
  } else {
    const properties = node['properties'];
    if (isRecord(properties) && isRecord(properties[segment])) found.push(properties[segment]);
  }

  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) found.push(...descendAll(branch, segment));
  }

  return found;
}
