/**
 * Secrets: one annotation, four behaviours.
 *
 * A secret-bearing field is declared exactly once, as a string carrying `x-secret: true`. That
 * single mark drives storage, redaction on read, `$keep` on write and the logger's redactor. They
 * are derived mechanically rather than written four times, because four hand-maintained lists of
 * secret fields drift, and the one that drifts is whichever was not updated when a protocol gained
 * a password.
 *
 * The canonical schema — the one a stored, resolved profile is validated against — holds a plain
 * string. The other three shapes are *generated* from it:
 *
 * | Context | Shape | Produced by |
 * |---|---|---|
 * | storage, in the document | `{ "$secret": "<value>" }` | `wrapSecrets` |
 * | a `GET` response | `{ "$set": true \| false }` | `redactForRead` |
 * | a `PUT`/`PATCH` body | `string \| { "$keep": true }` | `writeSchema` |
 * | a shared export | `{ "$redacted": "<kind>" }` | `redactForExport` |
 *
 * A single permissive union covering all four everywhere was rejected: it would let a read-shaped
 * value reach storage, and validation that accepts the wrong context is not validation.
 *
 * ## Why a second annotation for the kind
 *
 * `x-secret` alone answers "is this a secret", which is what all four behaviours need. It cannot
 * answer "what must a person go and find" — and the import checklist has to say that, because a
 * JSON Pointer names the field and not the thing. `x-secret-kind` is therefore a label from a
 * closed set, defaulting to `secret`. Detection stays purely `x-secret`; the kind only decorates
 * what detection already found, so the two cannot disagree about whether a field is a secret.
 */

import { Type, type TSchema, type TString } from '@sinclair/typebox';

/**
 * What a person has to go and find, from a closed set.
 *
 * Closed rather than free text for two reasons that both showed up in the design: free text is
 * untranslatable, and it cannot be validated, so a typo becomes a checklist entry nobody can act
 * on. The JSON Pointer already identifies the field; this says what kind of thing is missing.
 */
export const SECRET_KINDS = [
  'psk',
  'password',
  'private-key',
  'token',
  'certificate',
  'uuid',
  'config-blob',
  /**
   * A subscription link, which is a URL with a credential inside it rather than a credential beside
   * one. Named as its own kind because what a person has to go and find is "the subscription link
   * from the provider", and telling them a `token` is missing sends them looking for the wrong thing.
   */
  'subscription-url',
  'secret',
] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

/** The annotation key. Exported because the logger redactor and the form renderer both read it. */
export const SECRET_ANNOTATION = 'x-secret';
export const SECRET_KIND_ANNOTATION = 'x-secret-kind';

export interface SecretOptions {
  kind?: SecretKind;
  description?: string;
  maxLength?: number;
}

/**
 * Declares a secret-bearing field. This is the only place a secret is declared, in any schema in
 * this project.
 */
export function Secret(options: SecretOptions = {}): TString {
  return Type.String({
    ...(options.description !== undefined ? { description: options.description } : {}),
    // A bound on every secret: a document is accepted over the network, and an unbounded string
    // field is an unbounded allocation. 64 KiB fits a certificate chain and an OpenVPN profile.
    maxLength: options.maxLength ?? 64 * 1024,
    [SECRET_ANNOTATION]: true,
    [SECRET_KIND_ANNOTATION]: options.kind ?? 'secret',
  }) as TString;
}

/**
 * What a secret's value can be.
 *
 * A list of strings as well as a string, because that is how a PEM-style key is declared when it
 * may be supplied as several lines — measured in the schema a proxy core emits, where
 * `ssh.private_key` and `tls.client_key` are each `string | string[]`. A definition that allowed
 * only a string left exactly those two unwrapped, which is a private key stored in clear.
 */
export type SecretValue = string | string[];

/** The stored form. The wrapper exists so generic walkers cannot mistake a secret for a string. */
export interface StoredSecret {
  $secret: SecretValue;
}

/** True when a value can carry a secret, i.e. is a string or a list of strings. */
export function isSecretValue(value: unknown): value is SecretValue {
  if (typeof value === 'string') return true;
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** True when a secret value holds nothing — an empty string, or an empty or all-empty list. */
export function isEmptySecretValue(value: SecretValue): boolean {
  if (typeof value === 'string') return value === '';
  return value.length === 0 || value.every((entry) => entry === '');
}

/** What a `GET` returns: whether a value is set, never the value. */
export interface ReadSecret {
  $set: boolean;
}

/** What a write may say instead of a value, to leave the stored one alone. */
export interface KeepSecret {
  $keep: true;
}

/** What a shared export carries in place of the value. */
export interface RedactedSecret {
  $redacted: SecretKind;
}

export function isStoredSecret(value: unknown): value is StoredSecret {
  return isRecord(value) && '$secret' in value && isSecretValue(value['$secret']);
}

export function isKeepSecret(value: unknown): value is KeepSecret {
  return isRecord(value) && value['$keep'] === true;
}

export function isRedactedSecret(value: unknown): value is RedactedSecret {
  return isRecord(value) && typeof value['$redacted'] === 'string';
}

/**
 * The shape a **read** produces: whether a value is set, never the value.
 *
 * Recognised on the write path so that writing back what a `GET` returned produces an error naming
 * that specific mistake rather than the general rule. Read-modify-write is the most natural thing an
 * automation client does, and every secret in the document fails it.
 */
export function isReadSecret(value: unknown): value is { $set: boolean } {
  return isRecord(value) && typeof value['$set'] === 'boolean';
}

/** True when this schema node declares a secret. The single detection rule. */
export function isSecretSchema(schema: unknown): boolean {
  return isRecord(schema) && schema[SECRET_ANNOTATION] === true;
}

export function secretKindOf(schema: unknown): SecretKind {
  if (!isRecord(schema)) return 'secret';
  const kind = schema[SECRET_KIND_ANNOTATION];
  return (SECRET_KINDS as readonly string[]).includes(String(kind)) ? (kind as SecretKind) : 'secret';
}

/**
 * Where the secrets are in a schema, as JSON Pointers into a document that schema describes.
 *
 * Array items contribute a `/-` segment, which is the JSON Pointer form for "any element": a
 * pointer that named an index would be wrong for every other element, and the callers here walk a
 * document alongside the schema rather than looking pointers up.
 *
 * Deliberately iterative over `$defs`-free schemas only. This project's own profile schema inlines
 * everything; the foreign schema from a proxy core is handled by the field-descriptor resolver,
 * which has to inline references for its own reasons anyway.
 */
export function secretPointers(schema: TSchema | Record<string, unknown>): string[] {
  const found: string[] = [];
  walkSchema(schema as Record<string, unknown>, '', (node, pointer) => {
    if (isSecretSchema(node)) found.push(pointer);
  });
  return found;
}

function walkSchema(
  node: Record<string, unknown>,
  pointer: string,
  visit: (node: Record<string, unknown>, pointer: string) => void,
  seen = new Set<unknown>(),
): void {
  if (!isRecord(node)) return;
  // A schema can be cyclic through `$ref`, and it is input rather than something we authored, so
  // the guard is not optional: a cyclic schema must fail cleanly, never wedge the process.
  if (seen.has(node)) return;
  seen.add(node);

  visit(node, pointer);

  const properties = node['properties'];
  if (isRecord(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      if (isRecord(child)) walkSchema(child, `${pointer}/${escapePointerSegment(key)}`, visit, seen);
    }
  }

  const items = node['items'];
  if (isRecord(items)) walkSchema(items, `${pointer}/-`, visit, seen);

  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      // Branches share the pointer of the node they belong to: a value at that position matches one
      // of them, and which one is not known from the schema alone.
      for (const branch of branches) if (isRecord(branch)) walkSchema(branch, pointer, visit, seen);
    }
  }
}

/** RFC 6901 escaping: `~` becomes `~0` and `/` becomes `~1`, in that order. */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
