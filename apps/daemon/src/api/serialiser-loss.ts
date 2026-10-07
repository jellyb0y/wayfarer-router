/**
 * What a route's response schema silently removed from what its handler returned.
 *
 * ## Why this exists
 *
 * Fastify serialises a response through its declared schema, and a key the schema does not declare is
 * **dropped without an error**. Found on the bench board, 2026-09-24: the tunnel watchdog produced
 * `method`, `action` and `tone` for every tunnel, and `GET /api/observers` served none of them, because
 * `ObserverReadingSchema.items` listed three fields. Every test passed. They read the registry directly
 * and never went through the serialiser, so the field existed in every test and on no screen.
 *
 * A schema and the type its handler returns are two descriptions of one shape, and nothing compared them.
 * This compares them on the real response, for every route, in every test that makes a request: the test
 * script sets `WAYFARER_SERIALISER_CHECK=1`, and `buildServer` then answers a lossy response with a 500
 * that names the paths that were dropped. Production does not pay for the second serialisation.
 */

import type { FastifyInstance } from 'fastify';

/** JSON pointers present in `before` (as JSON would render it) and absent from `after`. */
export function droppedPaths(before: unknown, after: unknown, pointer = ''): string[] {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return [];
    return before.flatMap((entry, index) => droppedPaths(entry, after[index], `${pointer}/${String(index)}`));
  }
  if (before === null || typeof before !== 'object') return [];
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(before)) {
    const path = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (!(key in after)) found.push(path);
    else found.push(...droppedPaths(value, (after as Record<string, unknown>)[key], path));
  }
  return found;
}

/**
 * Compare every response the app sends with what its handler produced. `onLoss` returns the text to
 * send instead, or undefined to send the response as it was.
 */
export function watchSerialiserLoss(
  app: FastifyInstance,
  onLoss: (route: string, paths: string[]) => string | undefined,
): void {
  const produced = new WeakMap<object, unknown>();
  app.addHook('preSerialization', async (request, _reply, payload) => {
    // What JSON makes of it — `undefined` members and `toJSON` resolved — so that only what the schema
    // removed is reported, not what JSON itself would never have carried.
    produced.set(request, JSON.parse(JSON.stringify(payload ?? null)) as unknown);
    return payload;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (!produced.has(request) || typeof payload !== 'string') return payload;
    let sent: unknown;
    try {
      sent = JSON.parse(payload);
    } catch {
      return payload;
    }
    const paths = droppedPaths(produced.get(request), sent);
    if (paths.length === 0) return payload;
    const route = `${request.method} ${request.routeOptions.url ?? request.url}`;
    const replacement = onLoss(route, paths);
    if (replacement === undefined) return payload;
    void reply.code(500);
    return replacement;
  });
}
