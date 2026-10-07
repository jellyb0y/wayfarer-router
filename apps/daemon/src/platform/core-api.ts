/**
 * The proxy core's own control interface, which is how a tunnel is measured and how one is chosen.
 *
 * ## Why the probe goes through the core and not through us
 *
 * The task's hardest requirement is that a probe must measure **the tunnel it is probing**. If this
 * daemon fetched a probe URL itself, the packet would leave by whatever the routing table decided — which
 * is the *currently selected* tunnel, or direct, or nothing. Every tunnel would then be measured over the
 * same path, the numbers would agree with each other, and they would all describe something other than
 * the tunnel they were attributed to. A measurement that is confidently of the wrong path is worse than
 * no measurement.
 *
 * The core's per-outbound delay test does not have that problem by construction: it dials **through the
 * named outbound**, so asking about `t-hq` measures `t-hq`. That is the entire reason this module
 * exists rather than an HTTP client in the watchdog.
 *
 * Measured on the bench board, 2026-09-21, sing-box 1.14.0:
 *
 * ```
 * GET /proxies                                      -> {"proxies":{"wf-selector":{"type":"Selector","now":"block","all":["block"]}, …}}
 * GET /proxies/direct/delay?url=…&timeout=5000       -> {"delay":387}
 * GET /proxies/wf-selector/delay?url=…&timeout=5000  -> 503
 * ```
 *
 * That last line is the second rule: **never probe the selector.** It answers for whatever it currently
 * points at, which is one tunnel out of the set — and 503 when it points at `block`. Probing the selector
 * measures the current choice and calls it the health of the group, which is how a failover mechanism
 * comes to believe every option is as good as the one it already picked.
 *
 * ## Why this is what makes the `hot` class reachable
 *
 * Changing the selection is a `PUT` that the running core applies immediately. Nothing restarts, no
 * connection through the other tunnels is disturbed, and the tunnel device stays up. That is the
 * definition of the `hot` class, which has been documented and unreachable since there was nothing to
 * talk to.
 */

import { request as httpRequest } from 'node:http';
import type { CheckOutcome, CoreConnection } from '../core/liveness.ts';

export interface ProxyEntry {
  name: string;
  /** `Selector`, `Direct`, `Reject`, or a protocol name. */
  type: string;
  /** For a selector: which member is currently chosen. */
  now: string | null;
  /** For a selector: the members it can choose between. */
  all: string[] | null;
}

export interface CoreApi {
  /** Whether the control interface answers at all. */
  available(): Promise<boolean>;
  proxies(): Promise<ProxyEntry[]>;
  /**
   * Round-trip time through **one named outbound**, in milliseconds, or `null` when it did not answer.
   *
   * `null` is a lost probe and is reported as one. It is never returned as a large number, because a
   * timeout is not a slow answer: a series containing the timeout value has a median that means nothing.
   */
  delay(outbound: string, url: string, timeoutMs: number): Promise<number | null>;
  /** Points a selector at one of its members. Applied by the running core; nothing restarts. */
  select(selector: string, member: string): Promise<{ ok: boolean; message: string }>;
}

/**
 * The two readings a session-less tunnel's liveness needs (`core/liveness.ts`), kept off `CoreApi` so the
 * failover path and its many stand-ins are untouched by them.
 */
export interface CoreLivenessApi {
  /**
   * One request through one named outbound, three ways, from the core's delay test.
   *
   * Measured against sing-box 1.14.1, 2026-09-24 (`test/fixtures/core-api/`): `200 {"delay":N}` when the
   * request came back; `503 {"message":"An error occurred in the delay test"}` when the outbound could not
   * reach its server; `504 {"message":"Timeout"}` when it did not answer in time. Those two are a lost
   * check. `404 {"message":"Resource not found"}` — the core has no such outbound — and a control
   * interface that does not answer are **not** evidence about the tunnel, and read as `error`.
   */
  check(outbound: string, url: string, timeoutMs: number): Promise<CheckOutcome>;
  /** Every connection the core carries, or null when the list could not be read whole. */
  connections(): Promise<CoreConnection[] | null>;
}

/**
 * The connection list, from `GET /connections`.
 *
 * The shape measured on sing-box 1.14.1 (`test/fixtures/core-api/connections-*.json`): `connections` is an
 * array (empty when idle), each entry carrying `id`, `chains` — the outbound that carries the bytes
 * first, then the selectors in front of it — and cumulative `upload` and `download`. Anything that is not
 * that shape is dropped rather than guessed at: a connection with no chain cannot be attributed.
 */
export function parseConnections(text: string): CoreConnection[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const list = (parsed as { connections?: unknown }).connections;
  // Idle is `[]` on 1.14.1; a `null` list is read as idle too rather than as a failure.
  if (list === null) return [];
  if (!Array.isArray(list)) return null;
  const connections: CoreConnection[] = [];
  for (const entry of list as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const { id, chains, download } = entry as { id?: unknown; chains?: unknown; download?: unknown };
    if (typeof id !== 'string' || !Array.isArray(chains) || typeof download !== 'number' || !Number.isFinite(download)) continue;
    connections.push({ id, chains: chains.filter((tag): tag is string => typeof tag === 'string'), download });
  }
  return connections;
}

export interface CoreApiOptions {
  /** `host:port`, from the profile rather than assumed. */
  bind?: string;
  /** Replaces the transport, so the client can be tested without a core. */
  fetchJson?: (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    maxBytes?: number,
  ) => Promise<{ status: number; text: string }>;
}

export function createCoreApi(options: CoreApiOptions = {}): CoreApi & CoreLivenessApi {
  const bind = options.bind ?? '127.0.0.1:9090';
  const call =
    options.fetchJson ??
    ((method, path, body, timeoutMs, maxBytes) => plainRequest(bind, method, path, body, timeoutMs, maxBytes));

  return {
    async available() {
      const result = await call('GET', '/version', undefined, 3000).catch(() => null);
      return result !== null && result.status === 200;
    },

    async proxies() {
      const result = await call('GET', '/proxies', undefined, 5000);
      if (result.status !== 200) return [];
      const parsed = JSON.parse(result.text) as { proxies?: Record<string, { type?: unknown; now?: unknown; all?: unknown }> };
      return Object.entries(parsed.proxies ?? {}).map(([name, info]) => ({
        name,
        type: typeof info.type === 'string' ? info.type : 'unknown',
        now: typeof info.now === 'string' ? info.now : null,
        all: Array.isArray(info.all) ? info.all.filter((entry): entry is string => typeof entry === 'string') : null,
      }));
    },

    async delay(outbound, url, timeoutMs) {
      /*
       * The timeout is given to the core **and** to the transport, the latter with headroom.
       *
       * The core's own timeout is what decides whether the probe failed; ours only stops a hung socket
       * outliving the round. If ours were the shorter one we would record a lost probe for a tunnel that
       * answered, and attribute our own impatience to it.
       */
      const path = `/proxies/${encodeURIComponent(outbound)}/delay?url=${encodeURIComponent(url)}&timeout=${timeoutMs}`;
      const result = await call('GET', path, undefined, timeoutMs + 2000).catch(() => null);
      if (result === null || result.status !== 200) return null;
      try {
        const parsed = JSON.parse(result.text) as { delay?: unknown };
        return typeof parsed.delay === 'number' && Number.isFinite(parsed.delay) ? parsed.delay : null;
      } catch {
        return null;
      }
    },

    async check(outbound, url, timeoutMs) {
      const path = `/proxies/${encodeURIComponent(outbound)}/delay?url=${encodeURIComponent(url)}&timeout=${timeoutMs}`;
      let result: { status: number; text: string };
      try {
        result = await call('GET', path, undefined, timeoutMs + 2000);
      } catch (error) {
        return { kind: 'error', why: `the core's control interface did not answer: ${String(error)}` };
      }
      if (result.status === 200) {
        try {
          const parsed = JSON.parse(result.text) as { delay?: unknown };
          if (typeof parsed.delay === 'number' && Number.isFinite(parsed.delay)) return { kind: 'answered', ms: parsed.delay };
        } catch {
          // Fall through: a 200 that is not a delay is not an answer.
        }
        return { kind: 'error', why: `the core answered 200 without a delay: ${result.text.trim().slice(0, 120)}` };
      }
      if (result.status === 503 || result.status === 504) {
        return { kind: 'lost', why: `${String(result.status)}: ${result.text.trim().slice(0, 120)}` };
      }
      return { kind: 'error', why: `${String(result.status)}: ${result.text.trim().slice(0, 120)}` };
    },

    async connections() {
      // Bounded, but far above the 64 KB every other call gets: one entry is about 400 bytes, and a list
      // cut short is unparseable — which reads as "could not be read", never as fewer connections.
      const result = await call('GET', '/connections', undefined, 5000, 8 * 1024 * 1024).catch(() => null);
      if (result === null || result.status !== 200) return null;
      return parseConnections(result.text);
    },

    async select(selector, member) {
      const result = await call('PUT', `/proxies/${encodeURIComponent(selector)}`, { name: member }, 5000).catch(
        (error: unknown) => ({ status: 0, text: String(error) }),
      );
      // The core answers 204 for an accepted selection.
      const ok = result.status === 204 || result.status === 200;
      // Trimmed because the core's error body ends in a newline, and this string is a single-line
      // event summary: an untrimmed one puts a line break in the middle of the event list.
      return {
        ok,
        message: ok ? `selected ${member}` : `${result.status}: ${result.text.trim().slice(0, 200)}`,
      };
    },
  };
}

/** One request, on loopback, with no dependency beyond the runtime. */
async function plainRequest(
  bind: string,
  method: string,
  path: string,
  body: unknown,
  timeoutMs = 5000,
  maxBytes = 64 * 1024,
): Promise<{ status: number; text: string }> {
  const [host, port] = bind.split(':');
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: host === undefined || host === '' ? '127.0.0.1' : host,
        port: Number(port ?? 9090),
        path,
        method,
        headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          // Bounded: this is a control interface on loopback, but an unbounded read is an unbounded read.
          if (text.length < maxBytes) text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`no answer from the core within ${timeoutMs} ms`));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
