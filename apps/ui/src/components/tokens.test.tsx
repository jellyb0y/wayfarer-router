/**
 * The API tokens card on Settings, driven through the screen a person uses.
 *
 * What matters is what reaches the device and what is left on the screen: the exact body a create
 * sends, that the value is shown once and can be put away, that a revoke needs a second, deliberate tap,
 * and that a switched-off machine API is said out loud with the command that turns it on.
 */
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Settings } from '../pages/Settings.tsx';
import { extremeCapabilities, extremeFleet, extremeProfiles, extremeStatus, extremeSystem } from '../dev/fixtures.ts';
import type { TokenSummary } from '../lib/api.ts';

interface Sent {
  url: string;
  method: string;
  body: string | null;
}

const EXISTING: TokenSummary = {
  id: '1c76f2d90dacb27f',
  name: 'automation-token',
  scopes: ['read', 'apply'],
  createdAt: '2026-10-07T16:41:31.537Z',
  lastUsedAt: null,
  expiresAt: null,
};

function stubDevice(options: { apiEnabled?: boolean } = {}): { sent: Sent[] } {
  const sent: Sent[] = [];
  let tokens: TokenSummary[] = [EXISTING];
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    sent.push({ url, method, body });
    if (url.includes('/api/tokens/') && method === 'DELETE') {
      const id = decodeURIComponent(url.split('/api/tokens/')[1] ?? '');
      tokens = tokens.filter((token) => token.id !== id);
      return answer({ ok: true });
    }
    if (url.includes('/api/tokens') && method === 'POST') {
      const request = JSON.parse(body ?? '{}') as { name: string; scopes: TokenSummary['scopes']; expiresAt: string | null };
      const summary: TokenSummary = {
        id: 'abcdef0123456789',
        name: request.name,
        scopes: request.scopes,
        createdAt: '2026-10-07T17:00:00.000Z',
        lastUsedAt: null,
        expiresAt: request.expiresAt,
      };
      tokens = [...tokens, summary];
      return answer({ token: 'secret-value-shown-once', summary });
    }
    if (url.includes('/api/tokens')) return answer(tokens);
    if (url.includes('/api/transactions')) return answer({ transactions: [] });
    if (url.includes('/api/system')) return answer({ ...extremeSystem(), apiEnabled: options.apiEnabled ?? true });
    if (url.includes('/api/status')) return answer(extremeStatus());
    if (url.includes('/api/fleet')) return answer(extremeFleet());
    if (url.includes('/api/capabilities')) return answer(extremeCapabilities());
    if (/\/api\/profiles\/[^/]+$/.test(url)) return answer({ document: {}, missingSecrets: [] });
    if (url.includes('/api/profiles')) return answer(extremeProfiles());
    return answer({ empty: true, findings: [], humanDiff: [] });
  });
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener(): void {}
      close(): void {}
    },
  );
  return { sent };
}

function mount(element: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings']}>{element}</MemoryRouter>
    </QueryClientProvider>
  );
}

const writes = (sent: Sent[]) => sent.filter((entry) => entry.url.includes('/api/tokens') && entry.method !== 'GET');
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('API tokens on Settings', () => {
  it('lists the tokens that exist, without any value, and says machine access is on', async () => {
    stubDevice();
    render(mount(<Settings live={null} />));
    expect(await screen.findByText('automation-token')).toBeTruthy();
    expect(screen.getByText('read, apply')).toBeTruthy();
    expect(screen.queryByText(/way machine-api on/)).toBeNull();
  });

  it('names the command when machine access is off, because every token is refused until then', async () => {
    stubDevice({ apiEnabled: false });
    render(mount(<Settings live={null} />));
    expect(await screen.findByText(/way machine-api on/)).toBeTruthy();
  });

  it('creates with exactly the name, scopes and expiry chosen, and shows the value once', async () => {
    const { sent } = stubDevice();
    render(mount(<Settings live={null} />));
    const create = await screen.findByRole('button', { name: 'Create token' });
    // No name, no token: the device would refuse it, so the button does not offer it.
    expect((create as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'backup script' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'apply' }));
    fireEvent.click(create);

    await waitFor(() => expect(writes(sent)).toHaveLength(1));
    expect(JSON.parse(writes(sent)[0]!.body ?? '')).toEqual({ name: 'backup script', scopes: ['read', 'apply'], expiresAt: null });

    expect(await screen.findByText('secret-value-shown-once')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByText('secret-value-shown-once')).toBeNull();
  });

  it('turns a chosen lifetime into an instant that far ahead', async () => {
    const { sent } = stubDevice();
    render(mount(<Settings live={null} />));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Token name' }), { target: { value: 'for an hour' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Expires after' }), { target: { value: 'hour' } });
    const before = Date.now();
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(writes(sent)).toHaveLength(1));
    const expiresAt = Date.parse((JSON.parse(writes(sent)[0]!.body ?? '') as { expiresAt: string }).expiresAt);
    expect(expiresAt - before).toBeGreaterThanOrEqual(3_600_000 - 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(3_600_000 + 5000);
  });

  it('revokes only on a second tap, never on the first, and never on the other half of a double tap', async () => {
    const { sent } = stubDevice();
    render(mount(<Settings live={null} />));
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(3_000_000);

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await settled();
    expect(writes(sent)).toEqual([]);

    const confirm = screen.getByRole('button', { name: 'Revoke “automation-token” now?' });
    clock.mockReturnValue(3_000_200);
    fireEvent.click(confirm);
    await settled();
    expect(writes(sent)).toEqual([]);

    clock.mockReturnValue(3_000_700);
    fireEvent.click(confirm);
    await waitFor(() => expect(writes(sent)).toHaveLength(1));
    expect(writes(sent)[0]).toMatchObject({ method: 'DELETE' });
    expect(writes(sent)[0]!.url).toMatch(/\/api\/tokens\/1c76f2d90dacb27f$/);
  });
});
