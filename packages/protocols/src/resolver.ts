/**
 * The field-descriptor resolver: a discriminated union in, a flat list of fields out.
 *
 * Generic JSON Schema form libraries struggle exactly where this schema is hardest — a union of
 * twenty-odd branches — because a generic renderer either asks the user to pick a branch by index
 * or infers one by validating against each. We do not have that problem: the branches carry a
 * `const` on `type`, so the union can be resolved here and the renderer only ever sees a flat list.
 *
 * ## The shape is not what the design assumed, and this is why the resolver refuses
 *
 * Measured against the schema from the bench board (`sing-box` 1.14.0, 444 895 bytes, 93 `$defs`):
 *
 * * `$defs/Outbound.oneOf` has **20** entries, but entry 11 is **itself a `oneOf`**. Flattened, the
 *   union is 21 branches. A resolver that reads one level finds 20 and silently loses one.
 * * **`snell` occupies two of those branches**, separated by a second `const` (`version: 4` on one
 *   of them). `type` alone is therefore *not* a unique discriminator, and a first-match lookup
 *   quietly produces the wrong field list for that protocol — the failure is a form that looks
 *   right and rejects what the user types.
 *
 * So: flatten recursively, then, when a discriminator selects more than one branch, look for a
 * property that carries a differing `const` across them and use it as a secondary discriminator. If
 * no such property exists, **refuse** with a message naming the type. Guessing here produces a form
 * that is wrong in a way nobody can see; refusing produces a message somebody can act on.
 *
 * `$ref`s are inlined because the renderer must not have to resolve anything, and because the
 * secret stamper and the validator walk the same resolved document.
 */

import { inlineRefs, isRecord, SchemaResolutionError, type JsonSchemaNode } from './json.ts';

export interface FieldDescriptor {
  /** JSON Pointer into the value this form edits, e.g. `/transport/path`. */
  pointer: string;
  /** The last path segment: what a form shows when the overlay has nothing to say. */
  name: string;
  jsonType: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null' | 'unknown';
  required: boolean;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /** Set when the field is a secret, from the union of the overlay and the name rule. */
  secret?: boolean;
  /**
   * From the schema's own `x-tag-reference`. It marks a field that names another object's tag,
   * which is enough to render a picker without knowing anything about the protocol. Measured: 171
   * occurrences in the board's schema, with values such as `outbound` and `network_namespace`.
   */
  tagReference?: string;
  /** The value of a `const`, for a field the branch pins. The discriminator is one of these. */
  const?: unknown;
  /** Nested object and array fields keep their children, so a renderer can group them. */
  children?: FieldDescriptor[];
}

export interface ResolvedBranch {
  /** The discriminator value, e.g. `vless`. */
  type: string;
  /** Present when a secondary discriminator was needed to separate branches of one type. */
  discriminatedBy?: { property: string; value: unknown };
  fields: FieldDescriptor[];
  /** The branch schema with references inlined; what a validator is compiled from. */
  schema: JsonSchemaNode;
}

export class AmbiguousBranchError extends Error {
  readonly type: string;
  readonly branchCount: number;

  constructor(type: string, branchCount: number) {
    super(
      `the schema has ${branchCount} branches for "${type}" and no property whose const separates ` +
        `them, so a form for "${type}" cannot be built without guessing which one is meant`,
    );
    this.name = 'AmbiguousBranchError';
    this.type = type;
    this.branchCount = branchCount;
  }
}

/**
 * Flattens a union, following nested `oneOf` and `anyOf` to any depth.
 *
 * `anyOf` is followed as well as `oneOf` because a generator may emit either for the same intent,
 * and a resolver that handles only one of them fails on the next core release for no reason the
 * reader could have predicted.
 */
export function flattenUnion(node: JsonSchemaNode, maxDepth = 8): JsonSchemaNode[] {
  const output: JsonSchemaNode[] = [];

  const visit = (current: JsonSchemaNode, depth: number): void => {
    if (depth > maxDepth) {
      throw new SchemaResolutionError(`union nesting exceeded ${maxDepth} levels`, '');
    }
    const branches = current['oneOf'] ?? current['anyOf'];
    if (Array.isArray(branches) && branches.length > 0) {
      for (const branch of branches) if (isRecord(branch)) visit(branch, depth + 1);
      return;
    }
    output.push(current);
  };

  visit(node, 0);
  return output;
}

/** The value a branch pins on `property`, or undefined when it pins nothing. */
function constAt(branch: JsonSchemaNode, property: string): unknown {
  const properties = branch['properties'];
  if (!isRecord(properties)) return undefined;
  const field = properties[property];
  if (!isRecord(field)) return undefined;
  if ('const' in field) return field['const'];
  // A single-element enum is a const written the long way, and generators emit both.
  const enumeration = field['enum'];
  if (Array.isArray(enumeration) && enumeration.length === 1) return enumeration[0];
  return undefined;
}

/** Every discriminator value the union offers, in schema order and without duplicates. */
export function unionTypes(node: JsonSchemaNode, discriminator = 'type'): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const branch of flattenUnion(node)) {
    const value = constAt(branch, discriminator);
    if (typeof value !== 'string') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

export interface ResolveOptions {
  discriminator?: string;
  /** A second `const` to pin, when the caller already knows which of several branches it wants. */
  secondary?: { property: string; value: unknown };
  /** Pointers the caller considers secret, in this branch's pointer space. */
  secretPointers?: Iterable<string>;
  maxDepth?: number;
}

/**
 * Resolves one branch of a discriminated union into flat field descriptors.
 *
 * Throws `AmbiguousBranchError` when the discriminator selects several branches and nothing
 * separates them. That is a refusal, not a fallback: see the note at the top of this file.
 */
export function resolveBranch(
  root: JsonSchemaNode,
  union: JsonSchemaNode,
  type: string,
  options: ResolveOptions = {},
): ResolvedBranch {
  const discriminator = options.discriminator ?? 'type';
  const candidates = flattenUnion(union).filter((branch) => constAt(branch, discriminator) === type);

  if (candidates.length === 0) {
    throw new SchemaResolutionError(`no branch in this union has ${discriminator} = "${type}"`, `/${discriminator}`);
  }

  let chosen = candidates[0]!;
  let discriminatedBy: ResolvedBranch['discriminatedBy'];

  if (candidates.length > 1) {
    if (options.secondary) {
      const matching = candidates.filter(
        (branch) => constAt(branch, options.secondary!.property) === options.secondary!.value,
      );
      if (matching.length !== 1) {
        throw new AmbiguousBranchError(type, candidates.length);
      }
      chosen = matching[0]!;
      discriminatedBy = options.secondary;
    } else {
      const separator = findSecondaryDiscriminator(candidates, discriminator);
      if (separator === null) throw new AmbiguousBranchError(type, candidates.length);
      // With no instruction from the caller, the first branch is taken and the property that
      // separates them is reported, so the caller can offer the choice instead of the resolver
      // inventing one.
      chosen = candidates[0]!;
      discriminatedBy = { property: separator, value: constAt(chosen, separator) };
    }
  }

  const schema = inlineRefs(root, chosen, options.maxDepth ?? 12);
  const secretPointers = new Set(options.secretPointers ?? []);
  const fields = describeObject(schema, '', secretPointers);

  return {
    type,
    ...(discriminatedBy ? { discriminatedBy } : {}),
    fields,
    schema,
  };
}

/**
 * A property whose `const` differs across the candidates, so it can tell them apart. Null when the
 * branches are genuinely indistinguishable by any pinned value.
 */
function findSecondaryDiscriminator(candidates: JsonSchemaNode[], primary: string): string | null {
  const names = new Set<string>();
  for (const branch of candidates) {
    const properties = branch['properties'];
    if (isRecord(properties)) for (const key of Object.keys(properties)) names.add(key);
  }

  for (const name of names) {
    if (name === primary) continue;
    const values = candidates.map((branch) => constAt(branch, name));
    if (values.some((value) => value === undefined)) continue;
    const distinct = new Set(values.map((value) => JSON.stringify(value)));
    if (distinct.size === candidates.length) return name;
  }
  return null;
}

/* ── describing a resolved object ────────────────────────────────────────────────────────── */

function describeObject(node: JsonSchemaNode, pointer: string, secrets: Set<string>, depth = 0): FieldDescriptor[] {
  const properties = node['properties'];
  if (!isRecord(properties)) return [];
  const required = new Set(Array.isArray(node['required']) ? (node['required'] as unknown[]).map(String) : []);

  const fields: FieldDescriptor[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue;
    fields.push(describeField(raw, `${pointer}/${name}`, name, required.has(name), secrets, depth));
  }
  return fields;
}

function describeField(
  node: JsonSchemaNode,
  pointer: string,
  name: string,
  required: boolean,
  secrets: Set<string>,
  depth: number,
): FieldDescriptor {
  const descriptor: FieldDescriptor = {
    pointer,
    name,
    jsonType: jsonTypeOf(node),
    required,
  };

  if (Array.isArray(node['enum'])) descriptor.enum = node['enum'];
  if ('const' in node) descriptor.const = node['const'];
  if ('default' in node) descriptor.default = node['default'];
  if (typeof node['minimum'] === 'number') descriptor.minimum = node['minimum'];
  if (typeof node['maximum'] === 'number') descriptor.maximum = node['maximum'];
  if (typeof node['minLength'] === 'number') descriptor.minLength = node['minLength'];
  if (typeof node['maxLength'] === 'number') descriptor.maxLength = node['maxLength'];
  if (typeof node['x-tag-reference'] === 'string') descriptor.tagReference = node['x-tag-reference'];
  if (node['x-secret'] === true || secrets.has(pointer)) descriptor.secret = true;

  // Nesting is bounded for the same reason inlining is: the schema is input, and a form that
  // renders eight levels deep is already unusable, so the bound costs nothing real.
  if (depth < 6) {
    if (descriptor.jsonType === 'object') {
      const children = describeObject(node, pointer, secrets, depth + 1);
      if (children.length > 0) descriptor.children = children;
    } else if (descriptor.jsonType === 'array' && isRecord(node['items'])) {
      const item = node['items'];
      const children = describeObject(item, `${pointer}/-`, secrets, depth + 1);
      if (children.length > 0) descriptor.children = children;
    }
  }

  return descriptor;
}

/**
 * The JSON type of a node, tolerating the shapes a generator actually emits: a plain string, an
 * array of types including `null`, and a union whose branches agree on a type. `unknown` is a real
 * answer and the renderer must handle it — a field with no declared type still renders, as a text
 * input, rather than vanishing.
 */
export function jsonTypeOf(node: JsonSchemaNode): FieldDescriptor['jsonType'] {
  const type = node['type'];
  if (typeof type === 'string') return normaliseType(type);
  if (Array.isArray(type)) {
    const usable = type.filter((entry) => entry !== 'null').map(String);
    if (usable.length === 1) return normaliseType(usable[0]!);
    return 'unknown';
  }
  if (isRecord(node['properties'])) return 'object';
  if (isRecord(node['items'])) return 'array';

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    const types = new Set(
      branches
        .filter((branch): branch is JsonSchemaNode => isRecord(branch) && branch['type'] !== 'null')
        .map((branch) => jsonTypeOf(branch)),
    );
    if (types.size === 1) return [...types][0]!;
  }
  return 'unknown';
}

function normaliseType(type: string): FieldDescriptor['jsonType'] {
  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'object':
    case 'array':
    case 'null':
      return type;
    default:
      return 'unknown';
  }
}
