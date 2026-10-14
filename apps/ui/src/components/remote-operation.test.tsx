/**
 * The controls that replace a shell: the traffic check inside the confirmation window, "Test" on a
 * tunnel, and the Software card. Each is checked for the sentence a person acts on, because on 2026-10-11
 * each of these answers was available only to someone reading a terminal.
 */
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ConfirmationWindow } from './ConfirmationWindow.tsx';
import { TunnelTest } from './tunnel/test.tsx';
import { SoftwareCard } from './SoftwareCard.tsx';
import { extremeSystem } from '../dev/fixtures.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function withDevice(element: ReactElement, answer: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify(answer(url, init)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

describe('the traffic check in the confirmation window', () => {
  it('says when traffic works, which this page could not measure for itself', () => {
    render(<ConfirmationWindow secondsRemaining={120} contact="ok" onConfirm={() => {}} dataPlane={{ state: 'passed', detail: 'answered', latencyMs: 170 }} />);
    expect(screen.getByText(/Traffic works through the new configuration \(170 ms\)/)).toBeTruthy();
  });

  it('says a failure that predates the change is left to the person, with what was read', () => {
    render(<ConfirmationWindow secondsRemaining={120} contact="ok" onConfirm={() => {}} dataPlane={{ state: 'advisory', detail: 'no endpoint answered' }} />);
    expect(screen.getByText(/did not work before this change either/)).toBeTruthy();
    expect(screen.getByText(/no endpoint answered/)).toBeTruthy();
  });

  it('replaces the countdown with what happened once the device has undone the change', () => {
    render(
      <ConfirmationWindow secondsRemaining={120} contact="ok" onConfirm={() => {}} reverted dataPlane={{ state: 'failed', detail: 'ECONNRESET' }} />,
    );
    expect(screen.getByRole('heading', { name: 'Undone' })).toBeTruthy();
    expect(screen.getByText(/client traffic stopped working after the change: ECONNRESET/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Keep this change/ })).toBeNull();
  });
});

describe('Test on a tunnel', () => {
  it('sends the configuration with its stored-secret markers and shows the client’s words on a failure', async () => {
    const sent: unknown[] = [];
    withDevice(<TunnelTest subject={{ tunnelId: 'germany', protocol: 'vless', config: { id: { $set: true }, server: '5.39.255.51' } }} />, (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return { ok: false, failure: { stage: 'request', message: 'No endpoint answered through it.' }, log: ['xray: connection reset by peer'] };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('No endpoint answered through it.')).toBeTruthy();
    expect(screen.getByText(/connection reset by peer/)).toBeTruthy();
    expect(sent[0]).toEqual({ tunnelId: 'germany', protocol: 'vless', config: { id: { $set: true }, server: '5.39.255.51' } });
  });
});

describe('the Software card', () => {
  it('offers no upload on a device without a signing key, and says why', async () => {
    withDevice(<SoftwareCard />, () => ({ ...extremeSystem(), update: { keyInstalled: false, rollbackAvailable: false, last: null } }));
    expect(await screen.findByText(/no update signing key/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('with a key, offers the upload and the way back, and names the version that runs', async () => {
    withDevice(<SoftwareCard />, () => extremeSystem());
    expect(await screen.findByRole('button', { name: 'Install' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go back to the previous version' })).toBeTruthy();
    expect(screen.getByText(/^0\.9\.0-rc\.4\+build\.20260921\.1330, built /)).toBeTruthy();
  });
});
