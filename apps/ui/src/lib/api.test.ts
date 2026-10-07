/**
 * What the client puts on the wire, for the one header the daemon refuses a request over.
 *
 * Every bodyless write used to declare `content-type: application/json` with nothing behind it, and the
 * daemon answers that `400` before the route runs — so revoking a token, deleting or activating a
 * profile, removing a peer and signing out all failed from the panel (found 2026-10-07, revoking a
 * token on the bench board).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, profileApi } from './api.ts';

function capture(): { method: string; url: string; contentType: string | null; body: unknown }[] {
  const seen: { method: string; url: string; contentType: string | null; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ method: init?.method ?? 'GET', url: String(input), contentType: headers.get('content-type'), body: init?.body });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('the content type goes with a body, and only with one', () => {
  it('sends no content type on a write that has no body', async () => {
    const seen = capture();
    await api.deleteToken('1c76f2d90dacb27f');
    await api.removePeer('peer-1');
    await api.logout();
    await profileApi.remove('profile-1');
    await profileApi.activate('profile-1');
    expect(seen.map((entry) => [entry.method, entry.contentType])).toEqual([
      ['DELETE', null],
      ['DELETE', null],
      ['POST', null],
      ['DELETE', null],
      ['POST', null],
    ]);
  });

  it('still declares JSON on a write that carries it', async () => {
    const seen = capture();
    await api.createToken({ name: 'script', scopes: ['read'], expiresAt: null });
    expect(seen[0]).toMatchObject({ method: 'POST', contentType: 'application/json' });
  });
});
