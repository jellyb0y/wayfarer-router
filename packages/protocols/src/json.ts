/**
 * Small JSON Schema helpers shared by the resolver and the secret stamper.
 *
 * Deliberately not a schema library. The only schema operations this project performs on somebody
 * else's document are "follow a local reference" and "walk the properties", and both have to behave
 * predictably on a document that is input rather than something we authored — which means bounded,
 * cycle-safe, and failing with a message that names the position.
 */

export type JsonSchemaNode = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 6901 escaping for one segment. */
export function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export class SchemaResolutionError extends Error {
  readonly pointer: string;

  constructor(message: string, pointer: string) {
    super(message);
    this.name = 'SchemaResolutionError';
    this.pointer = pointer;
  }
}

/**
 * Follows a local `$ref` such as `#/$defs/Duration`.
 *
 * Only same-document references are supported, and a remote one is an error rather than a fetch: a
 * schema that could pull in a URL would turn a binary's output into a network request made by a
 * root daemon, which is not a capability this project wants to have.
 */
export function resolveRef(root: JsonSchemaNode, ref: string): JsonSchemaNode {
  if (!ref.startsWith('#')) {
    throw new SchemaResolutionError(`only same-document references are supported, got ${ref}`, ref);
  }
  const path = ref.slice(1);
  if (path === '' || path === '/') return root;

  let node: unknown = root;
  for (const raw of path.split('/').slice(1)) {
    const segment = unescapeSegment(raw);
    if (!isRecord(node) || !(segment in node)) {
      throw new SchemaResolutionError(`reference ${ref} does not resolve: no ${segment}`, ref);
    }
    node = node[segment];
  }
  if (!isRecord(node)) {
    throw new SchemaResolutionError(`reference ${ref} resolves to something that is not a schema`, ref);
  }
  return node;
}

/**
 * Inlines every `$ref` reachable from `node`, up to `maxDepth`.
 *
 * The depth bound is not defensive programming for its own sake. A schema generated from Go types
 * can be recursive — a rule that contains rules — and inlining such a thing without a bound does
 * not terminate. Reaching the bound leaves the `$ref` in place rather than throwing, because a form
 * that renders every field but one is useful and a form that fails to build is not.
 */
export function inlineRefs(root: JsonSchemaNode, node: JsonSchemaNode, maxDepth = 12): JsonSchemaNode {
  const visit = (current: unknown, depth: number, chain: readonly string[]): unknown => {
    if (Array.isArray(current)) return current.map((entry) => visit(entry, depth, chain));
    if (!isRecord(current)) return current;

    const ref = current['$ref'];
    if (typeof ref === 'string') {
      // A reference already on the stack is a cycle; leaving it unexpanded terminates and keeps the
      // information that there was a reference there at all.
      if (depth >= maxDepth || chain.includes(ref)) return { ...current };
      const target = resolveRef(root, ref);
      const rest = { ...current };
      delete rest['$ref'];
      return { ...(visit(target, depth + 1, [...chain, ref]) as JsonSchemaNode), ...rest };
    }

    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) output[key] = visit(value, depth, chain);
    return output;
  };

  return visit(node, 0, []) as JsonSchemaNode;
}
