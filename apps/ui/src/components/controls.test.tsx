/**
 * Four defects in the controls themselves, each asserted as the sequence that produced it.
 *
 * Every one of them was reachable with the whole suite green, and three of the four are invisible on
 * the screen at the moment they happen: an id that collides, a credential written into the wrong
 * document, and a filter that quietly removes its own alternatives. The sequence is the test,
 * because the end state on its own looks like a working screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TUNNEL_PROTOCOLS, TUNNEL_PROTOCOL_TITLES } from '@wayfarer/schemas';

import { CloakOpenVpnEditor } from './tunnel/cloak.tsx';
import { protocolTitle as sharedProtocolTitle } from './tunnel/index.tsx';
import { protocolTitle as routingProtocolTitle } from '../pages/Routing.tsx';
import { LongValue, SecretField } from './ui/index.tsx';
import { Events } from '../pages/Events.tsx';
import { readAt, useDraft } from '../lib/draft.ts';

afterEach(() => {
  cleanup();
  useDraft.getState().clear();
  vi.unstubAllGlobals();
});

/* ── A: an entry point's id, and the unit and file that are named after it ───────────────── */

describe('a new entry point cannot take an id another one already holds', () => {
  const documentWith = (ids: string[]): Record<string, unknown> => ({
    tunnels: [
      {
        id: 'tunnel-01',
        protocol: 'cloak-openvpn',
        config: {
          profile: { $set: true },
          entryPoints: ids.map((id) => ({
            id,
            host: `${id}.example`,
            port: 443,
            publicKey: '',
            proxyMethod: 'openvpn',
            encryptionMethod: 'aes-gcm',
            serverName: '',
            browserSignature: 'chrome',
            transport: 'direct',
          })),
        },
      },
    ],
  });

  const idsNow = (): string[] => {
    const entries = readAt(useDraft.getState().draft, '/tunnels/0/config/entryPoints') as Record<
      string,
      unknown
    >[];
    return entries.map((entry) => String(entry['id']));
  };

  /**
   * **Remove the middle one, then add one.** Adding alone passes against the defect and against the
   * fix alike, because `length + 1` is unique until something has been taken out — which is why the
   * defect survived the screen being written, reviewed and tested.
   *
   * What a repeat costs is not a duplicate string: the generated systemd unit name and the
   * obfuscation client's configuration file path are both derived from this id, so the second entry
   * overwrites the first silently, and the `.ovpn` keeps a `remote 127.0.0.1 <port>` line pointing at
   * a client that is not listening.
   */
  it('mints an id past the ones that are there, not past the length of the list', () => {
    const tunnel = documentWith(['entry-1', 'entry-2', 'entry-3'])['tunnels'] as Record<string, unknown>[];
    useDraft.getState().load('p1', documentWith(['entry-1', 'entry-2', 'entry-3']));
    const { rerender } = render(<CloakOpenVpnEditor index={0} tunnel={tunnel[0]!} />);

    const removes = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removes[1]!);
    expect(idsNow()).toEqual(['entry-1', 'entry-3']);

    const after = (useDraft.getState().draft?.['tunnels'] as Record<string, unknown>[])[0]!;
    rerender(<CloakOpenVpnEditor index={0} tunnel={after} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add an entry point' }));

    const ids = idsNow();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['entry-1', 'entry-3', 'entry-2']);
  });
});

/* ── B: a credential, and the document it is written back into ───────────────────────────── */

describe('cancelling a secret writes back into the document the control is on now', () => {
  /**
   * **The profile under the control can be replaced without a remount.** The edited profile is
   * chosen in a store rather than carried in the route, and `lib/target.ts` falls back to the active
   * profile the moment a chosen id leaves the list — so the same `SecretField` instance goes on
   * living while the document beneath it changes.
   *
   * The captured "value when the control opened" was a `useRef` set once. Cancel therefore wrote
   * profile A's placeholder into profile B, at a position holding a credential. This project has
   * already destroyed six credentials once through a write path that did not walk what it thought it
   * walked; the shape is the same and the direction is worse, because nothing on the screen changes
   * when it happens.
   */
  it('does not carry the previous profile’s value across a swap', () => {
    const pointer = '/accessPoint/passphrase';
    useDraft.getState().load('A', { accessPoint: { passphrase: { $set: true } } });

    /*
     * Queried by the word on the button rather than by its accessible name: `Field` puts the control
     * inside the `<label>`, so every button in a field is announced with the field's label glued to
     * the front of it. That is worth its own look and it is not what this test is about.
     */
    const { container, rerender } = render(
      <SecretField pointer={pointer} label="Passphrase" value={{ $set: true }} />,
    );
    fireEvent.click(screen.getByText('Replace'));
    const box = container.querySelector('input[type="password"]')!;
    fireEvent.change(box, { target: { value: 'typed-into-A' } });
    expect(readAt(useDraft.getState().draft, pointer)).toBe('typed-into-A');

    // Profile B arrives under the same component instance: no remount, no key change.
    useDraft.getState().load('B', { accessPoint: { passphrase: { $redacted: 'psk' } } });
    rerender(<SecretField pointer={pointer} label="Passphrase" value={{ $redacted: 'psk' }} />);

    fireEvent.click(screen.getByText('Cancel'));

    expect(readAt(useDraft.getState().draft, pointer)).toStrictEqual({ $redacted: 'psk' });
  });
});

/* ── C: the filter that removed its own alternatives ─────────────────────────────────────── */

describe('the kind filter keeps offering the kinds it is not showing', () => {
  const ENTRIES = [
    { at: '2026-09-21T09:00:00Z', level: 'info', kind: 'apply', message: 'one' },
    { at: '2026-09-21T09:01:00Z', level: 'info', kind: 'tunnel-health', message: 'two' },
    { at: '2026-09-21T09:02:00Z', level: 'warn', kind: 'safe-mode', message: 'three' },
  ];

  /**
   * The options were read off the **filtered** result, so choosing a kind narrowed the rows, the
   * rows were the source of the options, and the dropdown collapsed to the one kind already chosen.
   * Every other kind was then unreachable without Clear filters, and a device that had only ever
   * recorded one sort of event looks exactly the same.
   */
  it('still lists every kind after one of them is chosen', async () => {
    const ringQuery = async (query: string): Promise<never> => {
      const match = /kind=([^&]+)/.exec(query);
      const entries = match ? ENTRIES.filter((entry) => entry.kind === decodeURIComponent(match[1]!)) : ENTRIES;
      return { entries, count: ENTRIES.length, capacity: 5000 } as never;
    };
    const journalQuery = async (): Promise<never> => ({ lines: [], available: true }) as never;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Events ringQuery={ringQuery} journalQuery={journalQuery} />
      </QueryClientProvider>,
    );

    const select = await screen.findByLabelText(/kind/i);
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(3));

    fireEvent.change(select, { target: { value: 'apply' } });

    await waitFor(() => expect(screen.queryByText('two')).toBeNull());
    const options = within(select)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(options).toContain('tunnel-health');
    expect(options).toContain('safe-mode');
  });
});

/* ── rule 6: a long value is cut, and the whole of it stays reachable ────────────────────── */

describe('a value longer than the screen is cut with a copy control beside it', () => {
  /**
   * The cut is only acceptable because nothing is lost by it, so both halves are asserted together:
   * a clamp with no way back to the value would be worse than the wrapping it replaced.
   *
   * The number of lines it paints is the browser's answer and is measured by the 360 px bench; what
   * is asserted here is the contract the bench relies on — that the element declares a ceiling, that
   * the full value is on it, and that the control is drawn.
   */
  it('keeps the whole value in the tooltip and offers to copy it', () => {
    const value = `Apply refused: ${'a'.repeat(300)}`;
    const { container } = render(<LongValue value={value} lines={3} mono={false} label="this line" />);
    const text = container.querySelector('.long-value-text')!;
    expect(text.getAttribute('title')).toBe(value);
    expect(text.getAttribute('data-lines')).toBe('3');
    expect(screen.getByRole('button', { name: 'Copy this line' })).toBeTruthy();
  });

  it('says nothing rather than drawing an empty control', () => {
    const { container } = render(<LongValue value="" />);
    expect(container.querySelector('.long-value')).toBeNull();
  });
});

/* ── D: one list of protocol titles ──────────────────────────────────────────────────────── */

describe('the protocol titles come from the catalogue', () => {
  /**
   * Routing switched on three protocol names inline, beside a comment saying it must not. A fourth
   * catalogue entry would have rendered there as *unknown* for a protocol the device is carrying
   * traffic over — and it compiles, so nothing announces it.
   *
   * Asserted over `TUNNEL_PROTOCOLS` rather than over three literals: a test naming the three is a
   * second copy of the list, and would pass on the day the fourth arrives.
   */
  it('names every catalogue entry, and would name a fourth', () => {
    for (const protocol of TUNNEL_PROTOCOLS) {
      expect(sharedProtocolTitle(protocol)).toBe(TUNNEL_PROTOCOL_TITLES[protocol]);
    }
  });

  it('is one function, so a screen cannot grow a second list', () => {
    expect(routingProtocolTitle).toBe(sharedProtocolTitle);
  });

  it('says so plainly for a protocol the catalogue does not have', () => {
    expect(sharedProtocolTitle('wireguard')).toBe('unknown');
  });
});
