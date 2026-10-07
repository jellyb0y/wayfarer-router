/**
 * The tunnel editor, and the four claims it makes that are worth nothing unless they can fail.
 *
 * Each test below was proved by mutation in both directions before it was kept — the mutation is
 * named in the comment above it, because a test whose failure nobody has seen is a test whose
 * failure nobody has seen.
 *
 * The document arrives the way it does on a device: through the profile route, into the draft by the
 * shared editing hook. Pushing it into the store directly would skip the wiring the screen depends
 * on and would pass against a screen that never loads anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TUNNEL_PROTOCOL_TITLES } from '@wayfarer/schemas';

import { Tunnels } from './Tunnels.tsx';
import { Routing } from './Routing.tsx';
import { Network } from './Network.tsx';
import { useDraft } from '../lib/draft.ts';

afterEach(() => {
  cleanup();
  useDraft.getState().clear();
  vi.unstubAllGlobals();
});

type Tunnel = Record<string, unknown>;

function documentWith(tunnels: Tunnel[]): Record<string, unknown> {
  return {
    meta: { name: 'bench' },
    tunnels,
    policy: { onAllDown: 'block' },
    firewall: { killSwitch: false },
    routing: { rules: [], ruleSets: [] },
  };
}

async function renderScreen(
  element: React.ReactElement,
  document: Record<string, unknown>,
  observers?: unknown,
): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const answer = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (/\/api\/profiles\/[^/]+$/.test(url)) return answer({ document, missingSecrets: [] });
    if (url.includes('/api/profiles')) return answer({ activeProfileId: 'p1', profiles: [] });
    if (url.includes('/api/system')) return answer({ deviceName: 'bench', version: '0', runtime: 'x', listen: { port: 8088, addresses: [] } });
    if (url.includes('/api/status')) return answer({ units: [], interfaces: [], accessPoints: [], stations: [] });
    if (url.includes('/api/inventory')) return answer({ radios: [], interfaces: [], notes: [] });
    if (url.includes('/api/observers') && observers !== undefined) return answer(observers);
    return answer({ empty: true, findings: [], humanDiff: [], notes: [], bindings: [] });
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(useDraft.getState().draft).not.toBeNull());
}

const openvpn = (over: Tunnel = {}): Tunnel => ({
  id: 't1',
  name: 'Amsterdam egress',
  role: 'alternative',
  enabled: true,
  protocol: 'openvpn',
  config: { profile: { $set: true } },
  ...over,
});

describe("a tunnel's health is its own protocol's answer, never a field in the profile", () => {
  /*
   * 2026-09-24: `probe.endpoints` was removed from the profile. Its help text advised giving a tunnel
   * "something behind it", the guard on `partner` fetched one of that tunnel's own resources, and one
   * closed port blocked every destination behind a healthy tunnel. The screen offers no such control,
   * and the list row shows the watchdog's reading instead of whether the document named a URL.
   *
   * Mutation: put the probe control back in `TunnelCommonFields` and the first test fails; read the
   * row's health off the document again and the second fails, because the document here carries a
   * stale `probe` that would read "measured" while the watchdog reads it dead.
   */
  it('offers no control for what to fetch through a tunnel', async () => {
    await renderScreen(<Tunnels />, documentWith([openvpn()]));
    expect(await screen.findByText('Amsterdam egress')).toBeTruthy();
    for (const fold of Array.from(document.querySelectorAll('details'))) fold.open = true;
    expect(document.querySelector('[data-pointer$="/probe/endpoints"]')).toBeNull();
    expect(screen.queryByText(/Check by fetching/)).toBeNull();
  });

  it("shows the watchdog's reading of each tunnel, with how it was measured", async () => {
    await renderScreen(
      <Tunnels />,
      documentWith([openvpn({ id: 'partner', probe: { endpoints: ['http://172.30.0.212/'] } })]),
      {
        problems: 1,
        observers: [
          {
            name: 'tunnel-watchdog',
            watches: 'tunnels',
            everySeconds: 30,
            state: 'failing',
            problem: 'partner (3 round(s)) reads dead',
            lastActed: null,
            lastLooked: {
              at: '2026-09-24T00:00:00.000Z',
              ageSeconds: 4,
              what: 'no failover group; guards: partner DEAD 3 round(s) (peer keepalive)',
              items: [
                {
                  subject: 'partner',
                  state: 'DEAD 3 round(s)',
                  note: 'nothing has arrived',
                  method: 'peer keepalive',
                  action: 'not blocked',
                  tone: 'bad',
                },
              ],
            },
          },
        ],
      },
    );
    expect(await screen.findByText('DEAD 3 round(s), by peer keepalive')).toBeTruthy();
  });

  it('says it has not been read yet rather than inventing a health', async () => {
    await renderScreen(<Tunnels />, documentWith([openvpn()]));
    expect(await screen.findByText('Amsterdam egress')).toBeTruthy();
    expect(await screen.findByText('Not read yet')).toBeTruthy();
  });
});

describe('the obfuscation entry points, which nothing ever walked', () => {
  const cloak = (): Tunnel => ({
    id: 't1',
    name: 'Corporate',
    role: 'resource',
    enabled: true,
    protocol: 'cloak-openvpn',
    config: {
      profile: { $set: true },
      entryPoints: [
        { id: 'e1', name: 'First site', host: 'a.example', port: 443, uid: { $set: true }, publicKey: 'k', serverName: 'www.example' },
        { id: 'e2', name: 'Second site', host: 'b.example', port: 443, uid: { $set: true }, publicKey: 'k', serverName: 'api.example' },
      ],
    },
  });

  /*
   * The order is the order of the generated `remote` lines, which is the order the client tries them
   * in — so moving one up is a change to failover. Mutated to swap the wrong pair, this fails; mutated
   * to write the reordered list at the wrong pointer, it fails with the original order still there.
   */
  it('reorders failover, and the order is what is stored', async () => {
    await renderScreen(<Tunnels />, documentWith([cloak()]));
    await screen.findByText('Corporate');
    const second = screen.getByText(/2 · Second site/).closest('li') as HTMLElement;
    fireEvent.click(within(second).getByRole('button', { name: 'Up' }));
    const entries = ((useDraft.getState().draft!['tunnels'] as Tunnel[])[0]!['config'] as Record<string, unknown>)[
      'entryPoints'
    ] as Tunnel[];
    expect(entries.map((entry) => entry['id'])).toEqual(['e2', 'e1']);
  });

  /*
   * Each entry point's account identifier is its own control at its own position. Five of these left
   * the bench in a redacted export because they lived inside one unmarked string and nothing descended
   * into the list; a screen that shows one of them and not the others repeats that in the interface.
   */
  it('gives every entry point its own credential control', async () => {
    await renderScreen(<Tunnels />, documentWith([cloak()]));
    await screen.findByText('Corporate');
    expect(document.querySelector('[data-pointer="/tunnels/0/config/entryPoints/0/uid"]')).toBeTruthy();
    expect(document.querySelector('[data-pointer="/tunnels/0/config/entryPoints/1/uid"]')).toBeTruthy();
    // And the value itself is never on the screen, whatever the state says.
    expect(screen.queryByDisplayValue(/\$set/)).toBeNull();
  });

  /*
   * A Cloak tunnel with no entry points cannot connect at all, and the file's own remote lines are not
   * used. Mutated to draw nothing in that state, the screen shows a tunnel that looks configured.
   */
  it('says what a tunnel with no entry points can do, which is nothing', async () => {
    const empty = cloak();
    (empty['config'] as Record<string, unknown>)['entryPoints'] = [];
    await renderScreen(<Tunnels />, documentWith([empty]));
    expect(await screen.findByText(/This tunnel cannot connect at all/)).toBeTruthy();
  });
});

describe('VLESS: a link, and never a question about what runs it', () => {
  const vless = (): Tunnel => ({
    id: 't1',
    name: '',
    role: 'alternative',
    enabled: true,
    protocol: 'vless',
    config: { server: 'old.example', port: 1, id: { $set: true }, network: 'tcp', security: 'tls' },
  });

  /*
   * The parser is the daemon's own. Mutated to hand the link to a second parser written here, the two
   * agree today and would diverge on the first provider that emitted something only one understood —
   * which no test can catch, so the property asserted is that the fields arrive filled from the shared
   * one at all.
   */
  it('fills the fields from a pasted link', async () => {
    await renderScreen(<Tunnels />, documentWith([vless()]));
    await screen.findByText(/Paste a link/);
    fireEvent.change(screen.getByPlaceholderText('vless://…'), {
      target: { value: 'vless://11111111-2222-3333-4444-555555555555@node.example:8443?type=ws&security=tls&path=%2Fws#Tokyo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fill from link' }));

    const config = (useDraft.getState().draft!['tunnels'] as Tunnel[])[0]!['config'] as Record<string, unknown>;
    expect(config['server']).toBe('node.example');
    expect(config['port']).toBe(8443);
    expect(config['network']).toBe('ws');
    // The link's own label takes a name only where there is none to overwrite.
    expect((useDraft.getState().draft!['tunnels'] as Tunnel[])[0]!['name']).toBe('Tokyo');
  });

  /*
   * A refusal is printed in the parser's own words. Its value is that it names **both** halves — the
   * scheme that was not accepted and the ones that are — and a paraphrase on the way to the screen
   * keeps the first and loses the second. Asserted on both halves for that reason.
   */
  it('prints a refusal verbatim, and changes nothing', async () => {
    await renderScreen(<Tunnels />, documentWith([vless()]));
    await screen.findByText(/Paste a link/);
    const before = JSON.stringify(useDraft.getState().draft);
    fireEvent.change(screen.getByPlaceholderText('vless://…'), {
      target: { value: 'ss://YWVzLTEyOC1nY206cGFzcw@somewhere.example:8388#Node' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fill from link' }));

    const refusal = screen.getByText(/does not run/);
    expect(refusal.textContent).toMatch(/shadowsocks/i);
    expect(refusal.textContent).toMatch(/OpenVPN/);
    expect(JSON.stringify(useDraft.getState().draft)).toBe(before);
  });

  /*
   * **The owner is never asked which client runs his subscription.** The entry establishes the carrier
   * from the configuration and states it in the plan; a control or a sentence here would re-open, in
   * the one place a person would believe it, a decision the catalogue makes.
   *
   * Asserted over the rendered text rather than over the source, because a sentence in a component
   * nobody mounts is not on the screen and a grep cannot tell the difference.
   */
  it('names no program anywhere on the screen', async () => {
    await renderScreen(<Tunnels />, documentWith([vless()]));
    await screen.findByText(/Paste a link/);
    const text = document.body.textContent ?? '';
    // The programs that can carry a VLESS account, named individually rather than by a pattern: a
    // pattern loose enough to catch them also catches "Client signature", which is a TLS fingerprint
    // to imitate and not a program this device starts.
    for (const program of [/xray/i, /sing-?box/i, /v2ray/i, /\bcore\b/i]) expect(text).not.toMatch(program);
    // And no control asks the question in any wording.
    expect(text).not.toMatch(/which client/i);
    expect(text).not.toMatch(/runs? (it|this)/i);
  });
});

describe('the catalogue is the only thing a tunnel can be', () => {
  /*
   * Offered from `TUNNEL_PROTOCOLS` rather than written out here, so a fourth entry in Epic F appears
   * without an edit to this screen. Mutated to a hardcoded list of three, this still passes today and
   * fails the day the catalogue grows — which is why the assertion is over the catalogue's own values.
   */
  it('offers exactly what the device runs, in the owner’s words', async () => {
    await renderScreen(<Tunnels />, documentWith([]));
    await screen.findByText(/No tunnels yet/);
    for (const title of Object.values(TUNNEL_PROTOCOL_TITLES)) {
      expect(screen.getByRole('button', { name: title })).toBeTruthy();
    }
  });

  /*
   * A stored tunnel naming something outside the catalogue. Storage refuses these, so reaching this
   * means one got past — and drawing nothing would report a tunnel with no settings, after which
   * somebody fills in the fields above and saves a tunnel that still cannot run.
   */
  it('refuses to pretend it can edit a protocol it does not run', async () => {
    await renderScreen(<Tunnels />, documentWith([openvpn({ protocol: 'hysteria2' })]));
    expect(await screen.findByText(/names a protocol this device does not run/)).toBeTruthy();
  });
});

describe('what happens when a tunnel fails is on the screen about tunnels', () => {
  /*
   * A move, asserted at **both** ends. A test on Tunnels alone would pass just as happily on a copy,
   * and two controls for one field in two places is one of the four defects this epic deletes.
   */
  it('is here', async () => {
    await renderScreen(<Tunnels />, documentWith([openvpn()]));
    expect(await screen.findByText(/If all fail/)).toBeTruthy();
  });

  it('and is on neither of the other two screens that edit the profile', async () => {
    await renderScreen(<Routing />, documentWith([openvpn()]));
    // Anchored on something only a loaded Routing can draw, so the absence is not the absence of
    // everything.
    expect(await screen.findByText(/Matched from the top/)).toBeTruthy();
    expect(screen.queryByText(/If all fail/)).toBeNull();
    cleanup();
    useDraft.getState().clear();
    vi.unstubAllGlobals();

    await renderScreen(<Network live={null} />, documentWith([openvpn()]));
    expect(await screen.findByText(/Reachable from uplink/)).toBeTruthy();
    expect(screen.queryByText(/If all fail/)).toBeNull();
  });
});

describe('where tunnels come from, which is not the same act as pasting one', () => {
  const feed = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'subscription-01',
    name: 'Provider feed',
    enabled: true,
    url: { $set: true },
    refreshHours: 24,
    ...over,
  });

  const withFeeds = (feeds: Record<string, unknown>[], tunnels: Tunnel[] = []): Record<string, unknown> => ({
    ...documentWith(tunnels),
    subscriptions: feeds,
  });

  /*
   * The count on the feed is the other side of the badge on a tunnel. Mutated to count every tunnel
   * rather than the ones naming this feed, it reports two where one is true — which is the number
   * somebody reads before removing a feed.
   */
  it('says how many of the tunnels above it made', async () => {
    await renderScreen(
      <Tunnels />,
      withFeeds(
        [feed()],
        [
          openvpn({ id: 't1', derivedFrom: { subscription: 'subscription-01', node: 'a' } }),
          openvpn({ id: 't2', name: 'By hand' }),
        ],
      ),
    );
    expect(await screen.findByText(/1 above/)).toBeTruthy();
  });

  /*
   * Never read *here* is a fact about this device, and a profile carried from another board arrives
   * honest about it. Mutated to a dash, the row reads as a refresh that failed and said nothing.
   */
  it('says it has never been read rather than leaving a blank', async () => {
    await renderScreen(<Tunnels />, withFeeds([feed()]));
    expect(await screen.findByText(/Never, on this device/)).toBeTruthy();
  });

  /*
   * The two acts must not read as one. A person who confuses them pastes a feed into a tunnel and
   * wonders why it never updates, or stores a one-off link and finds an edited tunnel replaced
   * overnight. Asserted as: the feed's address control and the tunnel's paste box are different
   * controls with different words, and only one of them writes to the document.
   */
  it('keeps the stored feed and the one-off paste apart', async () => {
    await renderScreen(<Tunnels />, withFeeds([feed()], [{ ...openvpn(), protocol: 'vless', config: { server: 'a', port: 1, network: 'tcp', security: 'tls' } }]));
    await screen.findByText('Provider feed');
    // The paste box is not a position in the document, so it is not a `Field` and carries no pointer
    // of its own. Asserted against `.field-block` rather than against any `[data-pointer]` ancestor,
    // because the list containing the tunnel is one — and climbing to it would pass for the wrong
    // reason on a paste box that had been stamped.
    expect(screen.getByPlaceholderText('vless://…').closest('.field-block')).toBeNull();
    expect(document.querySelector('[data-pointer="/subscriptions/0/url"]')).toBeTruthy();
    // And neither control borrows the other's words.
    expect(screen.getByText('Feed address')).toBeTruthy();
    expect(screen.getByText('Paste a link')).toBeTruthy();
  });

  /*
   * Zero hours is "only when you ask", which is a value and not an empty box. Mutated to write `0`
   * as undefined, the field falls back to the schema's 24-hour default and the device refreshes a
   * feed somebody deliberately stopped.
   */
  it('stores a refresh interval of zero as a choice', async () => {
    await renderScreen(<Tunnels />, withFeeds([feed()]));
    await screen.findByText('Provider feed');
    const hours = document.querySelector('[data-pointer="/subscriptions/0/refreshHours"] input');
    fireEvent.change(hours as HTMLInputElement, { target: { value: '0' } });
    expect((useDraft.getState().draft!['subscriptions'] as Record<string, unknown>[])[0]!['refreshHours']).toBe(0);
  });
});

describe('one proxy screen, three things it can speak', () => {
  /*
   * **Every value invented.** The owner holds the real address, port, user name and password.
   *
   * The configuration exercised hardest is SOCKS with a sign-in and no TLS, because that is the one
   * this entry was written for.
   */
  const proxy = (config: Record<string, unknown>): Tunnel => ({
    id: 'ru',
    name: 'Russian proxy',
    role: 'alternative',
    enabled: true,
    onUnavailable: 'block',
    protocol: 'proxy',
    config,
  });

  it('draws the TLS fields for HTTPS and for nothing else', async () => {
    /*
     * Not cosmetic, and mutated in both directions. The daemon **refuses** a configuration that sets
     * either of these on a proxy with no handshake — it will not silently drop a field somebody wrote
     * down — so a screen offering them beside SOCKS would be leading a person into a refusal it drew
     * for him.
     */
    await renderScreen(<Tunnels />, documentWith([proxy({ type: 'socks', server: 'proxy.example.invalid', port: 1080 })]));
    await screen.findByText('Russian proxy');
    expect(document.querySelector('[data-pointer="/tunnels/0/config/tlsServerName"]')).toBeNull();
    expect(document.querySelector('[data-pointer="/tunnels/0/config/tlsCertificate"]')).toBeNull();

    cleanup();
    useDraft.getState().clear();
    vi.unstubAllGlobals();

    await renderScreen(
      <Tunnels />,
      documentWith([proxy({ type: 'https', server: 'proxy.example.invalid', port: 8443 })]),
    );
    await screen.findByText('Russian proxy');
    expect(document.querySelector('[data-pointer="/tunnels/0/config/tlsServerName"]')).toBeTruthy();
    expect(document.querySelector('[data-pointer="/tunnels/0/config/tlsCertificate"]')).toBeTruthy();
  });

  it('offers no way to turn certificate checking off', async () => {
    /*
     * This product refuses `allowInsecure` in a subscription link, naming the parameter, because the
     * switch removes the only check distinguishing a tunnel from a pipe to whoever answered. The
     * proxy screen is the obvious place for it to come back, so its absence is asserted rather than
     * assumed — and the need behind it is answered by the certificate control instead.
     */
    await renderScreen(
      <Tunnels />,
      documentWith([proxy({ type: 'https', server: 'proxy.example.invalid', port: 8443 })]),
    );
    await screen.findByText('Russian proxy');
    expect(screen.queryByText(/insecure/i)).toBeNull();
    expect(screen.getByText('Trusted certificate')).toBeTruthy();
  });

  it('creates and removes the sign-in as a pair, never half of one', async () => {
    // A user name with no password is an account that cannot authenticate, and it validates. The
    // pair is one control for that reason, exactly as an OpenVPN account is.
    await renderScreen(<Tunnels />, documentWith([proxy({ type: 'socks', server: 'proxy.example.invalid', port: 1080 })]));
    await screen.findByText('Russian proxy');
    expect(document.querySelector('[data-pointer="/tunnels/0/config/auth/username"]')).toBeNull();

    const toggle = document.querySelector('[data-pointer="/tunnels/0/config/auth"] input');
    fireEvent.click(toggle as HTMLInputElement);
    expect(document.querySelector('[data-pointer="/tunnels/0/config/auth/username"]')).toBeTruthy();
    expect(document.querySelector('[data-pointer="/tunnels/0/config/auth/password"]')).toBeTruthy();

    const username = document.querySelector('[data-pointer="/tunnels/0/config/auth/username"] input');
    fireEvent.change(username as HTMLInputElement, { target: { value: 'invented-user' } });
    const tunnels = useDraft.getState().draft!['tunnels'] as Record<string, unknown>[];
    expect((tunnels[0]!['config'] as Record<string, Record<string, unknown>>)['auth']!['username']).toBe('invented-user');

    fireEvent.click(toggle as HTMLInputElement);
    expect((useDraft.getState().draft!['tunnels'] as Record<string, unknown>[])[0]!['config']).toEqual({
      type: 'socks',
      server: 'proxy.example.invalid',
      port: 1080,
    });
  });

  it('clears the TLS fields when the type stops being HTTPS, so the refusal cannot be stranded', async () => {
    /*
     * **The screen produced a refusal nobody could clear.**
     *
     * Fill in a certificate on HTTPS, switch to SOCKS: the controls disappear and the draft keeps
     * the values, so the plan is refused pointing at `/tunnels/0/config/tlsCertificate` — a field
     * with no control on any screen. The entry's own header said reaching that refusal meant a
     * document had arrived some other way, while this screen was the thing producing it.
     *
     * The clearing is an ordinary draft write, so it joins the same pending change as the choice
     * that caused it and Review shows both.
     */
    await renderScreen(
      <Tunnels />,
      documentWith([proxy({ type: 'https', server: 'proxy.example.invalid', port: 8443 })]),
    );
    await screen.findByText('Russian proxy');

    const serverName = document.querySelector('[data-pointer="/tunnels/0/config/tlsServerName"] input');
    fireEvent.change(serverName as HTMLInputElement, { target: { value: 'proxy.example.invalid' } });
    const certificate = document.querySelector('[data-pointer="/tunnels/0/config/tlsCertificate"] textarea');
    fireEvent.change(certificate as HTMLTextAreaElement, {
      target: { value: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' },
    });
    const filled = (useDraft.getState().draft!['tunnels'] as Record<string, unknown>[])[0]!['config'] as Record<string, unknown>;
    // Proof the values went in, or what follows would be a test of an empty draft.
    expect(filled['tlsServerName']).toBe('proxy.example.invalid');
    expect(filled['tlsCertificate']).toEqual([
      '-----BEGIN CERTIFICATE-----',
      'AAAA',
      '-----END CERTIFICATE-----',
    ]);

    // Switching away. The radio for SOCKS is the control a person actually taps.
    const socks = [...document.querySelectorAll('[data-pointer="/tunnels/0/config/type"] input')].find(
      (node) => (node as HTMLInputElement).value === 'socks',
    );
    fireEvent.click(socks as HTMLInputElement);

    const after = (useDraft.getState().draft!['tunnels'] as Record<string, unknown>[])[0]!['config'] as Record<string, unknown>;
    expect(after['type']).toBe('socks');
    expect(after['tlsServerName']).toBeUndefined();
    expect(after['tlsCertificate']).toBeUndefined();
    // And the controls are gone, so nothing on screen contradicts the draft.
    expect(document.querySelector('[data-pointer="/tunnels/0/config/tlsCertificate"]')).toBeNull();
  });

  it('is offered by the word the owner holds, not by what carries it', async () => {
    expect(TUNNEL_PROTOCOL_TITLES.proxy).toBe('Proxy');
    await renderScreen(<Tunnels />, documentWith([]));
    // The add button exists, so a proxy can be created from the interface and not only from the API.
    expect(await screen.findByText(/Proxy/)).toBeTruthy();
  });
});
