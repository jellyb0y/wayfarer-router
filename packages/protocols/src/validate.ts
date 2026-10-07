/**
 * Validating a configuration against a schema we did not write.
 *
 * The schema comes out of a binary, which makes it **input**, not a fact. A malformed, cyclic or
 * enormous one must fail the fetch cleanly and never wedge the daemon, and nothing here may assume
 * the shape of a document it has not inspected. That framing decides most of the choices below.
 *
 * Three requirements, each with a reason rather than a preference:
 *
 * * **Strict mode off.** Ajv's strict mode rejects keywords it does not recognise, and a foreign
 *   schema legitimately carries `x-tag-reference`, our stamped `x-secret`, and whatever the next
 *   core release invents. Strict mode would turn a new annotation into a device that refuses to
 *   validate any tunnel at all.
 * * **Compiled validators cached per `(schema identity)`.** Compiling a 445 KB schema is not free
 *   on a four-core Cortex-A53, and the schema changes only when the binary does.
 * * **Bounded.** A size ceiling before parsing, and a compile that fails is reported, never thrown
 *   past the caller as something unhandled.
 *
 * Errors carry a **JSON Pointer**, because the error contract promises one and the interface puts
 * the message on the field rather than pattern-matching on text.
 */

// The 2020-12 build, not the default one: the schema this validates declares
// `$schema: "https://json-schema.org/draft/2020-12/schema"`, and the default Ajv build implements
// draft-07. Compiling a 2020-12 schema with a draft-07 validator does not fail loudly — it silently
// ignores the keywords it does not implement, so a configuration that should be rejected is
// accepted and the failure surfaces as a service that will not start.
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { JsonSchemaNode } from './json.ts';

/**
 * CommonJS interop. `ajv/dist/2020` is CommonJS with its constructor on `module.exports.default`,
 * and under this module resolution the namespace object arrives instead of the constructor. Reading
 * `.default` when it is there is the only portable form; the alternative fails at run time with
 * "not constructable", which is a build-shaped error for a plain import.
 */
type AjvLike = { compile(schema: unknown): ValidateFunction };
type AjvConstructorType = new (options: Record<string, unknown>) => AjvLike;

const AjvConstructor = ((Ajv2020 as unknown as { default?: unknown }).default ??
  Ajv2020) as unknown as AjvConstructorType;

export interface ValidationIssue {
  /** JSON Pointer into the validated document. */
  pointer: string;
  message: string;
  /** Ajv's own keyword, e.g. `required`, `enum`, `type`. Useful for choosing a hint. */
  keyword: string;
  /** Allowed values, when the failure was an enumeration or a const. */
  allowed?: unknown[];
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export class SchemaCompileError extends Error {
  // Not a parameter property. The runtime strips types rather than compiling them, so a parameter
  // property fails to import at all — `erasableSyntaxOnly` turns that into a type error instead of
  // a test run that cannot load the module.
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'SchemaCompileError';
    this.reason = reason;
  }
}

/** Refuse anything larger than this before parsing. The measured core schema is 445 KB. */
export const MAX_SCHEMA_BYTES = 16 * 1024 * 1024;

/**
 * Parses a schema that arrived as text.
 *
 * The size check happens **before** `JSON.parse`, because parsing is where an oversized document
 * costs memory, and the point of the bound is not to find out afterwards.
 */
export function parseForeignSchema(text: string): JsonSchemaNode {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_SCHEMA_BYTES) {
    throw new SchemaCompileError(
      `refusing a schema of ${bytes} bytes: the limit is ${MAX_SCHEMA_BYTES}. A schema this large ` +
        'is more likely to be the wrong output than a real schema.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SchemaCompileError('the schema is not valid JSON', error);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SchemaCompileError('the schema is not a JSON object');
  }
  return parsed as JsonSchemaNode;
}

export interface Validator {
  validate(document: unknown): ValidationResult;
}

export interface ValidatorCache {
  /**
   * `key` identifies the schema — in practice the core's version and build tags, which is exactly
   * what the platform layer already keys its schema cache on.
   */
  forSchema(key: string, schema: () => JsonSchemaNode): Validator;
  size(): number;
  clear(): void;
}

export function createValidatorCache(): ValidatorCache {
  const compiled = new Map<string, Validator>();

  return {
    forSchema(key, schema) {
      const existing = compiled.get(key);
      if (existing) return existing;

      let validateFn: ValidateFunction;
      try {
        // `strict: false` — see the note at the top. `allErrors` because a form shows every field
        // that is wrong at once; stopping at the first would make correcting a configuration a
        // sequence of round trips.
        const ajv = new AjvConstructor({
          strict: false,
          allErrors: true,
          // Formats this schema uses are not declared to Ajv, and an unknown format must be ignored
          // rather than rejected: the alternative is a device that cannot validate a protocol
          // because the core annotated a field with a format string we have never seen.
          validateFormats: false,
          // A schema from a binary can be recursive. Ajv handles that; the guard is that nothing
          // here follows a reference itself.
          allowUnionTypes: true,
        });
        validateFn = ajv.compile(schema());
      } catch (error) {
        throw new SchemaCompileError(`the schema could not be compiled: ${String(error)}`, error);
      }

      const validator: Validator = {
        validate(document) {
          const valid = validateFn(document) as boolean;
          return {
            valid,
            issues: valid ? [] : (validateFn.errors ?? []).map(toIssue),
          };
        },
      };
      compiled.set(key, validator);
      return validator;
    },
    size: () => compiled.size,
    clear: () => compiled.clear(),
  };
}

/**
 * Ajv's error shape into ours.
 *
 * `instancePath` is already a JSON Pointer, which is why this is a rename rather than a
 * translation — and it is the reason the error contract could promise a pointer in the first place.
 * A missing required property is reported at the *parent*, so the property name is folded into the
 * pointer: an interface that highlighted the object rather than the field would be pointing at the
 * whole form.
 */
function toIssue(error: ErrorObject): ValidationIssue {
  let pointer = error.instancePath;
  if (error.keyword === 'required') {
    const missing = (error.params as { missingProperty?: string }).missingProperty;
    if (missing) pointer = `${pointer}/${missing.replace(/~/g, '~0').replace(/\//g, '~1')}`;
  }

  const issue: ValidationIssue = {
    pointer,
    message: error.message ?? 'is not valid',
    keyword: error.keyword,
  };

  const allowed = (error.params as { allowedValues?: unknown[]; allowedValue?: unknown }).allowedValues;
  if (Array.isArray(allowed)) issue.allowed = allowed;
  return issue;
}
