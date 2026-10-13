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
 */

export type FetchTextResult = { ok: true; text: string } | { ok: false; reason: string };

/** A feed is a few kilobytes; this is a ceiling against a server that answers with something else. */
export const FETCH_TEXT_MAX_BYTES = 1_000_000;
export const FETCH_TEXT_TIMEOUT_MS = 20_000;

export async function fetchText(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchTextResult> {
  const maxBytes = options.maxBytes ?? FETCH_TEXT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TEXT_TIMEOUT_MS);
  try {
    // A subscription client is expected to identify itself; some panels answer an anonymous request
    // with a web page instead of the feed. Assumption, not measured on the feeds in use here: both
    // answered `curl`'s default agent with the feed.
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'wayfarer' } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `the server answered HTTP ${String(response.status)}` };
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `the answer is ${String(declared)} bytes, over the ${String(maxBytes)} this reads` };
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) return { ok: false, reason: `the answer is over the ${String(maxBytes)} bytes this reads` };
    return { ok: true, text: new TextDecoder().decode(body) };
  } catch (error) {
    return { ok: false, reason: describeFailure(error, controller.signal.aborted) };
  } finally {
    clearTimeout(timer);
  }
}

/** The error code only — see the file comment for why never the message. */
function describeFailure(error: unknown, timedOut: boolean): string {
  if (timedOut) return 'no answer within the time limit';
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : null;
  return code === null ? 'the request failed before an answer arrived' : `the request failed (${code})`;
}
