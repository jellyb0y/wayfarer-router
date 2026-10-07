/**
 * The shell has exactly one gate, and this file exists to keep it that way.
 *
 * A device that still has its default password reports `setupComplete: false`, and the interface
 * used to answer that by refusing to draw anything but the password form. The owner decided the
 * default may stay, so the server stopped refusing — and a shutter left behind in the browser would
 * have survived that removal invisibly from both sides: every route accepted by the API, none of
 * them reachable in the panel, and nothing anywhere reporting a contradiction.
 *
 * So the first test below drives the exact condition that used to trigger the shutter. It fails if
 * the redirect comes back, which is the only reason to have it.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App.tsx';

/**
 * A device with the default password still in place, signed in.
 *
 * `setupComplete: false` is the whole point: it is the value that used to close the interface, and
 * every authenticated route answers normally beside it, which is what makes the old behaviour a
 * defect rather than agreement with the server.
 */
function stubDeviceWithDefaultPassword(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = url.includes('/api/health')
      ? { ok: true, uptimeSeconds: 1, setupComplete: false }
      : url.includes('/api/system')
        ? {
            deviceId: 'd', deviceName: 'bench', version: '0.0.0', buildAt: null, runtime: 'node',
            startedAt: new Date().toISOString(), uptimeSeconds: 1, setupComplete: false, apiEnabled: true,
            schemaVersion: 7, listen: { port: 8088, addresses: ['127.0.0.1'], unresolvedInterfaces: [] },
            clock: { timezone: null, ntpEnabled: null, synchronized: null }, binaries: [], warnings: [],
          }
        : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener(): void {}
      close(): void {}
    },
  );
}

function mount(route: string): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  // `globals` is off in the Vitest configuration, so the automatic teardown never runs and a second
  // render lands beside the first. The symptom is "multiple elements found" for a unique control —
  // which reads as a duplicated control in the application rather than as leftover DOM in the test.
  cleanup();
  vi.unstubAllGlobals();
});

describe('the shell on a device that still has its default password', () => {
  it('opens the ordinary interface rather than the password form', async () => {
    stubDeviceWithDefaultPassword();
    render(mount('/status'));

    // The navigation is what the shutter removed; its presence is the assertion.
    await waitFor(() => expect(screen.getByRole('link', { name: 'Status' })).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Change password' })).toBeNull();
  });

  it('still offers the password control, reachable and not forced', async () => {
    /*
     * The other half, and the reason it is in the same file: removing a forced change must not also
     * remove the voluntary one. A test for the shutter alone would pass on an interface that had
     * simply lost the feature.
     *
     * It follows the control rather than the route. The password screen was its own destination while
     * Settings did not exist; it is now a card on Settings, and what has to survive that move is the
     * ability to change the password, not the URL it used to live at.
     */
    stubDeviceWithDefaultPassword();
    render(mount('/settings'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Change password' })).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Status' })).toBeTruthy();
  });

  it('reports the default password as a field, and never as a barrier', async () => {
    /*
     * The field that says the device still carries its shipped credential is information. This asserts
     * both halves, because only the pair is the property: the fact is **reported**, and nothing on the
     * screen is refused, hidden or disabled on the strength of it.
     *
     * Written as an assertion about the whole screen rather than about a banner, because the defect it
     * guards against is a polite reminder growing back into compulsion — and that reappears as a
     * disabled control or a shutter, not as a banner nobody added on purpose.
     */
    stubDeviceWithDefaultPassword();
    render(mount('/settings'));

    await waitFor(() => expect(screen.getByText('Still in place')).toBeTruthy());
    // Every navigation entry is present, so nothing was closed off; and the profile list, which is the
    // one thing on this screen that a shutter would have taken away, is drawn.
    expect(screen.getByRole('link', { name: 'Routes' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Profiles' })).toBeTruthy();
  });
});
