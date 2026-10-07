/**
 * Reading a stored value that may still be wrapped.
 *
 * A secret lives in storage as `{ "$secret": "…" }` and reaches a planner resolved to a plain
 * string. Both shapes arrive here — a dry run may be planned against an unresolved document — so one
 * reader handles both and no entry has to know which stage it is in.
 */

export function secretText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && '$secret' in value) {
    const inner = (value as { $secret: unknown }).$secret;
    if (Array.isArray(inner)) return inner.join('\n');
    if (typeof inner === 'string') return inner;
  }
  return '';
}
