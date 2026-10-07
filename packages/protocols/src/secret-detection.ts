/**
 * Finding the secrets in a schema nobody annotated.
 *
 * `x-secret` drives storage, redaction, `$keep` and the log redactor, and it works because we write
 * the schemas we control. A proxy core's schema is not one of those. Measured on the bench board:
 * `sing-box schema` is 444 895 bytes across 93 definitions and contains **zero** `x-secret`
 * annotations — it has no `description` and no `title` either, but the missing annotation is the
 * one with a security consequence. Left alone, a VLESS `uuid`, a Trojan `password` and a WireGuard
 * `private_key` would be stored unwrapped, returned by `GET`, written into an export meant to be
 * shared, and printed in a log line.
 *
 * The metadata overlay can mark a field secret, and it does — but the overlay is optional per
 * field, deliberately, so that a protocol released this morning still renders. "A field with no
 * overlay entry still renders" is correct. "A field with no overlay entry is not a secret" is the
 * same rule pointed at a much worse outcome, and it fails silently in the leaking direction.
 *
 * So the annotation is stamped onto the foreign schema from **two sources, unioned**: curated
 * overlay entries, and a name rule applied to every string field. The overlay may *add* a secret;
 * it can never remove one the name rule found.
 *
 * ## The asymmetry is the design
 *
 * Over-redaction is a nuisance: a field unluckily named like a secret becomes write-only and
 * somebody re-enters a value that never needed protecting. Under-redaction is a leak nobody
 * notices until the document is in a chat log. The rule therefore fails towards redaction, and that
 * cost is stated rather than discovered.
 *
 * ## Segments, never substrings
 *
 * The matcher compares the **final path segment**, exactly and case-insensitively, plus a short list
 * of explicit suffixes. It must never become a substring search, because `domain_keyword` contains
 * `key` — and `domain_keyword` is a field whose entire purpose is to be read and edited. There is a
 * test naming it as the negative case so the matcher cannot be "simplified" back into a substring
 * search by someone who has not met that field.
 */

import { isRecord } from './json.ts';

/**
 * Field names that are secrets wherever they appear. Exact segment matches, case-insensitive.
 *
 * Adding a word here changes what is redacted across every protocol at once, so the coverage this
 * list produces over the real schema is checked in as a golden file: a change becomes a diff
 * somebody approves rather than a silent widening.
 */
export const SECRET_FIELD_NAMES: readonly string[] = [
  'auth',
  'auth_str',
  'certificate_key',
  'key',
  'password',
  'passphrase',
  'private_key',
  'psk',
  'pre_shared_key',
  'secret',
  'secret_key',
  'token',
  'uuid',
];

/**
 * Suffixes that make a field a secret whatever it is prefixed with, so `reality_private_key` and
 * `obfs_password` are covered without listing every protocol's spelling.
 */
export const SECRET_FIELD_SUFFIXES: readonly string[] = [
  '_key',
  '_password',
  '_passphrase',
  '_secret',
  '_token',
  '_psk',
];

/**
 * Field names that are **not** secrets although the suffix rule would catch them.
 *
 * This is part of the rule, not an escape from it. The invariant that matters is that nothing
 * *outside the source* can unmark a secret: no overlay entry, no profile field, no API input. A
 * fixed list here is reviewed in the same golden diff as every other change to coverage, so a
 * future entry appears as a line that stopped being redacted. There is deliberately no mechanism
 * for reaching this list from configuration, and a test asserts that.
 *
 * Exact final segments only — never suffix patterns. A suffix rule pointing the other way is how
 * `certificate_key` eventually becomes public by accident.
 *
 * Each entry says why the value is public, not merely that it is.
 */
export const PUBLIC_FIELD_NAMES: readonly string[] = [
  // A peer's public key, and the public half of a REALITY key pair. Published to be given out; the
  // holder of a redacted profile cannot look it up, because it belongs to the other end. Redacting
  // it puts a value on the import checklist that was never secret — and a checklist naming things
  // that are not missing is one people skim, which hides the single entry that really is missing.
  'public_key',
  // An SSH server's host key: presented by the server to every client that connects, and pinned by
  // the client precisely because it is public and stable.
  'host_key',
];

/**
 * Whether a field name looks like a secret.
 *
 * `name` is one path segment, never a path. Passing a path in would reintroduce the substring
 * problem through the back door.
 */
export function looksLikeSecretField(name: string): boolean {
  const lower = name.toLowerCase();
  if (PUBLIC_FIELD_NAMES.includes(lower)) return false;
  if (SECRET_FIELD_NAMES.includes(lower)) return true;
  return SECRET_FIELD_SUFFIXES.some((suffix) => lower.endsWith(suffix) && lower.length > suffix.length);
}

export interface StampOptions {
  /**
   * Pointers the overlay marks secret, in the resolver's pointer space. Unioned with the name rule;
   * it can add, never remove.
   */
  overlaySecretPointers?: Iterable<string>;
  /** Predicate override, for tests. Production always uses `looksLikeSecretField`. */
  isSecretName?: (name: string) => boolean;
}

export interface StampResult<T> {
  schema: T;
  /** Every pointer marked, and why — so the coverage can be reviewed rather than trusted. */
  marked: { pointer: string; by: 'name' | 'overlay' }[];
}

/**
 * Returns a copy of `schema` with `x-secret: true` on every field the union identifies.
 *
 * A copy, not a mutation: the schema is cached per core version and build tags, and stamping the
 * cached object would make the result depend on how many times it had been read.
 *
 * Only string-bearing fields are marked — a string, a nullable string, or **a string or list of
 * strings**, which is the shape a PEM-style field takes when it may be given as several lines.
 * Marking an object would make the redactor replace a subtree with a scalar, which is a shape
 * change rather than a redaction and cannot be rendered back.
 *
 * That last shape is not hypothetical: it is how `ssh.private_key` and `tls.client_key` are
 * declared in the schema measured on the bench board, and an earlier version of this predicate
 * required *every* branch to be a plain string, so both went unmarked. A private key in clear, in
 * an export meant to be shared. It was found by the coverage golden file below rather than by
 * reading the code, which is the argument for having that file at all.
 */
export function stampSecrets<T>(schema: T, options: StampOptions = {}): StampResult<T> {
  const isSecretName = options.isSecretName ?? looksLikeSecretField;
  const overlay = new Set(options.overlaySecretPointers ?? []);
  const marked: { pointer: string; by: 'name' | 'overlay' }[] = [];

  const visit = (node: unknown, pointer: string, name: string | null, seen: WeakSet<object>): unknown => {
    if (Array.isArray(node)) {
      if (seen.has(node)) return node;
      seen.add(node);
      return node.map((entry) => visit(entry, pointer, name, seen));
    }
    if (!isRecord(node)) return node;
    // The schema comes from a binary: it is input, and a cyclic or self-referential document must
    // fail cleanly rather than exhaust the stack.
    if (seen.has(node)) return node;
    seen.add(node);

    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && isRecord(value)) {
        const properties: Record<string, unknown> = {};
        for (const [property, child] of Object.entries(value)) {
          properties[property] = visit(child, `${pointer}/${property}`, property, seen);
        }
        copy[key] = properties;
        continue;
      }
      copy[key] = visit(value, key === 'items' ? `${pointer}/-` : pointer, null, seen);
    }

    const byOverlay = overlay.has(pointer);
    const byName = name !== null && isSecretName(name);
    if ((byOverlay || byName) && isStringSchema(copy)) {
      copy['x-secret'] = true;
      copy['x-secret-kind'] ??= 'secret';
      marked.push({ pointer, by: byOverlay ? 'overlay' : 'name' });
    }

    return copy;
  };

  return { schema: visit(schema, '', null, new WeakSet()) as T, marked };
}

/**
 * Whether this node describes a value that can carry a secret: a string, `["string", "null"]`, an
 * array of strings, or a union of those. Every one of these occurs in the measured schema.
 */
export function isStringSchema(node: Record<string, unknown>): boolean {
  const type = node['type'];
  if (type === 'string') return true;
  if (Array.isArray(type) && type.every((entry) => entry === 'string' || entry === 'null')) return true;

  // An array whose items are strings: the multi-line form of a PEM block.
  if (type === 'array' && isRecord(node['items']) && isStringSchema(node['items'])) return true;

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = node[keyword];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const usable = branches.filter((branch): branch is Record<string, unknown> => isRecord(branch) && branch['type'] !== 'null');
    // `some`, not `every`: `anyOf: [string, array<string>]` is exactly how a key that may be given
    // as one line or several is declared, and requiring every branch to be a plain string leaves it
    // unmarked. That was a real leak, found by the coverage file.
    if (usable.length > 0 && usable.some((branch) => isStringSchema(branch))) return true;
  }
  return false;
}

/**
 * Every secret position in an already-stamped schema, as JSON Pointers into a value that schema
 * describes.
 *
 * The counterpart to `stampSecrets`: that marks the fields, this reports where they are, so a caller
 * holding a document rather than a schema can wrap, redact or list them. Array items contribute a `-`
 * segment, which is the pointer form for "any element".
 *
 * Only marked fields are reported. A schema that was never stamped yields nothing, which is the
 * honest answer — and the reason the export path separately warns about *unwrapped* values it finds,
 * rather than trusting this to have been called.
 */
export function secretPointersIn(schema: unknown): { pointer: string; kind: string }[] {
  const found: { pointer: string; kind: string }[] = [];

  const visit = (node: unknown, pointer: string, seen: WeakSet<object>): void => {
    if (Array.isArray(node)) {
      if (seen.has(node)) return;
      seen.add(node);
      for (const entry of node) visit(entry, pointer, seen);
      return;
    }
    if (!isRecord(node)) return;
    // The schema is input: a cyclic document must terminate rather than exhaust the stack.
    if (seen.has(node)) return;
    seen.add(node);

    if (node['x-secret'] === true) {
      const kind = typeof node['x-secret-kind'] === 'string' ? node['x-secret-kind'] : 'secret';
      found.push({ pointer, kind });
    }

    const properties = node['properties'];
    if (isRecord(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        visit(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, seen);
      }
    }

    if (isRecord(node['items'])) visit(node['items'], `${pointer}/-`, seen);

    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = node[keyword];
      // Branches share the pointer of the node they belong to: a value there matches one of them, and
      // which one is not knowable from the schema alone.
      if (Array.isArray(branches)) for (const branch of branches) visit(branch, pointer, seen);
    }
  };

  visit(schema, '', new WeakSet());
  return found;
}
