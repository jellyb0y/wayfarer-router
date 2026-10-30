/**
 * Fetching a document over HTTP: today, a subscription feed.
 *
 * Here because a request leaves the device, and only this layer knows a network exists. The caller gets
 * the body or a short reason, and **never a message that could carry the URL**: a feed's URL is a
 * credential, and the error text of the runtime's `fetch` names the host and sometimes the whole URL.
 * The reason is built here from the status or the error code alone.
 *
 * The request goes out the way the daemon's own traffic does — directly over the uplink, past the
 * tunnels (the policy rules at 8000–8002 send root's traffic to `main`). Measured on the bench board,
 * 2026-10-14: both feeds the active profile names answered `200` this way, in 85 ms and 182 ms, one of
 * them over HTTPS with a certificate that verified.
 *
 * **The name is resolved past the tunnels too, not only the route.** The system resolver sends every
 * query (`~.`) to the core's resolver on `tun0`, and that one answers through the egress. Measured on
 * the bench board, 2026-10-30, with every member of the egress group unreachable and the group on
 * `block`: `resolvectl query <feed host>` answered "does not have any RR", the same query with
 * `-i end0` answered at once, and the feed fetched by that address answered `200` in 0.15 s. So a
 * refresh — the one thing that could bring new nodes — was blocked by the outage it was meant to end.
 * The resolvers asked here are the ones the uplinks learned (`DNS=` in networkd's link state), which
 * never include the core's. With none known, the system resolver is used, as before.
 */

import { readdir, readFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Resolver } from 'node:dns/promises';
import { lookup as systemLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { join } from 'node:path';

const NETWORKD_LINKS = '/run/systemd/netif/links';
const MAX_REDIRECTS = 5;

export type FetchTextResult = { ok: true; text: string } | { ok: false; reason: string };

/** A feed is a few kilobytes; this is a ceiling against a server that answers with something else. */
export const FETCH_TEXT_MAX_BYTES = 1_000_000;
export const FETCH_TEXT_TIMEOUT_MS = 20_000;

export async function fetchText(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number; linksDirectory?: string } = {},
): Promise<FetchTextResult> {
  const maxBytes = options.maxBytes ?? FETCH_TEXT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TEXT_TIMEOUT_MS);
  try {
    const lookup = uplinkLookup(await uplinkResolvers(options.linksDirectory ?? NETWORKD_LINKS));
    let target = new URL(url);
    for (let hop = 0; ; hop += 1) {
      const response = await get(target, lookup, controller.signal);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location !== undefined) {
        response.resume();
        if (hop >= MAX_REDIRECTS) return { ok: false, reason: 'the server redirected too many times' };
        target = new URL(location, target);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return { ok: false, reason: `the server answered HTTP ${String(status)}` };
      }
      const declared = Number(response.headers['content-length'] ?? '0');
      if (declared > maxBytes) {
        response.destroy();
        return { ok: false, reason: `the answer is ${String(declared)} bytes, over the ${String(maxBytes)} this reads` };
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          response.destroy();
          return { ok: false, reason: `the answer is over the ${String(maxBytes)} bytes this reads` };
        }
        chunks.push(chunk);
      }
      return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
    }
  } catch (error) {
    return { ok: false, reason: describeFailure(error, controller.signal.aborted) };
  } finally {
    clearTimeout(timer);
  }
}

type Lookup = LookupFunction;

function get(url: URL, lookup: Lookup | undefined, signal: AbortSignal): Promise<IncomingMessage> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return Promise.reject(new Error('unsupported scheme'));
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    // A subscription client is expected to identify itself; some panels answer an anonymous request
    // with a web page instead of the feed. Assumption, not measured on the feeds in use here: both
    // answered `curl`'s default agent with the feed.
    const request = send(url, { signal, headers: { 'user-agent': 'wayfarer' }, ...(lookup === undefined ? {} : { lookup }) }, resolve);
    request.on('error', reject);
    request.end();
  });
}

/** The resolvers the uplinks learned, in link order. Unreadable state is "none known", not a failure. */
export async function uplinkResolvers(directory: string): Promise<string[]> {
  const found: string[] = [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return found;
  }
  for (const name of names.sort((a, b) => Number(a) - Number(b))) {
    try {
      const text = await readFile(join(directory, name), 'utf8');
      const line = text.split('\n').find((entry) => entry.startsWith('DNS='));
      for (const address of (line ?? '').slice('DNS='.length).split(/\s+/)) {
        if (isIP(address) !== 0 && !found.includes(address)) found.push(address);
      }
    } catch {
      // A link that went away between listing and reading has nothing to offer.
    }
  }
  return found;
}

function uplinkLookup(servers: string[]): Lookup | undefined {
  if (servers.length === 0) return undefined;
  const resolver = new Resolver({ timeout: 5_000, tries: 2 });
  resolver.setServers(servers);
  return (hostname, options, callback) => {
    if (isIP(hostname) !== 0) {
      systemLookup(hostname, options, callback);
      return;
    }
    resolver.resolve4(hostname).then(
      (addresses) => {
        const first = addresses[0];
        if (first === undefined) callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '');
        else if (options.all === true) callback(null, addresses.map((address): LookupAddress => ({ address, family: 4 })));
        else callback(null, first, 4);
      },
      (error: unknown) => {
        callback(error as NodeJS.ErrnoException, '');
      },
    );
  };
}

/** The error code only — see the file comment for why never the message. */
function describeFailure(error: unknown, timedOut: boolean): string {
  if (timedOut) return 'no answer within the time limit';
  const failure = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const raw = failure?.cause?.code ?? failure?.code;
  const code = typeof raw === 'string' ? raw : null;
  return code === null ? 'the request failed before an answer arrived' : `the request failed (${code})`;
}
