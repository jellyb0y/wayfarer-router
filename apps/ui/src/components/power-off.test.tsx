/**
 * The switch-off control on Settings, and the page that is left once the device has accepted it.
 *
 * Driven through the screens a person uses — Settings, and the whole `App` for the quiet page — rather
 * than through `PowerOffControl` alone, because the failures that matter are about what reaches the
 * device: a first tap that sends, a double tap that sends, a button that sends while a change is
 * awaiting confirmation, a page that keeps asking a device that has gone.
 */
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Settings } from '../pages/Settings.tsx';
import { App } from '../App.tsx';
import { usePowerOff } from './PowerOff.tsx';
import { extremeCapabilities, extremeFleet, extremeProfiles, extremeStatus, extremeSystem } from '../dev/fixtures.ts';

interface Sent {
  url: string;
  method: string;
  body: string | null;
}

/** Answers every request the screens make; records what was sent, so a test can see what reached the device. */
function stubDevice(
  options: { openTransaction?: string; windowOpensLate?: string } = {},
): { sent: Sent[]; closed: () => number } {
  const sent: Sent[] = [];
  let closed = 0;
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    sent.push({ url, method, body: typeof init?.body === 'string' ? init.body : null });
    // Before `/api/system`, which is a prefix of it.
    if (url.includes('/api/system/poweroff')) {
      if (options.windowOpensLate !== undefined) {
        // An apply from another tab, between the list being read and the second tap.
        options.openTransaction = options.windowOpensLate;
        return answer(
          {
            error: {
              code: 'confirmation_pending',
              message: `Transaction ${options.windowOpensLate} is inside its confirmation window with 97 seconds left. Nothing was done.`,
              hint: `POST /api/transactions/${options.windowOpensLate}/confirm to keep it, or /revert to undo it, then switch off.`,
              detail: { transaction: options.windowOpensLate, secondsRemaining: 97 },
            },
          },
          409,
        );
      }
      return answer(
        { accepted: true, poweringOffInSeconds: 3, message: 'The device is switching off. It stays off until its power is cycled.' },
        202,
      );
    }
    if (url.includes('/api/transactions')) {
      return answer({
        transactions:
          options.openTransaction === undefined
            ? [{ id: 'c0ffee0000000001', state: 'committed', secondsRemaining: null }]
            : [{ id: options.openTransaction, state: 'awaiting-confirm', secondsRemaining: 97 }],
      });
    }
    if (url.includes('/api/system')) return answer(extremeSystem());
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
      close(): void {
        closed += 1;
      }
    },
  );
  return { sent, closed: () => closed };
}

function mount(element: ReactElement, route = '/settings'): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{element}</MemoryRouter>
    </QueryClientProvider>
  );
}

const powerOffs = (sent: Sent[]) => sent.filter((entry) => entry.url.includes('/api/system/poweroff'));

/** A mutation reaches `fetch` on a microtask, so "nothing was sent" is only true once the queue has drained. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  usePowerOff.setState({ off: false });
});

describe('switching the device off', () => {
  it('says inside the button that it will not come back on its own', async () => {
    stubDevice();
    render(mount(<Settings live={null} />));
    const button = await screen.findByRole('button', { name: /^Turn off/ });
    // The consequence is in the control's own name, where a screen reader and a thumb both meet it.
    expect(button.textContent).toMatch(/Wi-Fi and every tunnel go too/);
    expect(button.textContent).toMatch(/will not come back on its own, only when its power is cycled/);
  });

  it('sends only on a second tap, never on the first, and never on the other half of a double tap', async () => {
    const { sent } = stubDevice();
    render(mount(<Settings live={null} />));
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(2_000_000);

    fireEvent.click(await screen.findByRole('button', { name: /^Turn off/ }));
    await settled();
    expect(powerOffs(sent)).toEqual([]);

    // The confirming control repeats what it costs.
    const confirm = screen.getByRole('button', { name: /^Turn off now/ });
    expect(confirm.textContent).toMatch(/stays off until someone cycles its power/);

    clock.mockReturnValue(2_000_200);
    fireEvent.click(confirm);
    await settled();
    expect(powerOffs(sent)).toEqual([]);

    clock.mockReturnValue(2_000_700);
    fireEvent.click(confirm);
    await waitFor(() => expect(powerOffs(sent)).toHaveLength(1));
    // The exact body the device requires, and nothing else.
    expect(powerOffs(sent)[0]).toEqual({ url: '/api/system/poweroff', method: 'POST', body: '{"confirm":"poweroff"}' });
  });

  it('can be stepped back from', async () => {
    const { sent } = stubDevice();
    render(mount(<Settings live={null} />));
    fireEvent.click(await screen.findByRole('button', { name: /^Turn off/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it on' }));
    await settled();
    expect(screen.getByRole('button', { name: /^Turn off/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Turn off now/ })).toBeNull();
    expect(powerOffs(sent)).toEqual([]);
  });

  it('says why it cannot be used while a change awaits confirmation, and sends nothing', async () => {
    const { sent } = stubDevice({ openTransaction: 'b6f0c4a29d7e1835' });
    render(mount(<Settings live={null} />));
    const blocked = await screen.findByRole('button', { name: /^Confirm change first/ });
    expect(blocked.hasAttribute('disabled')).toBe(true);
    // Names the change, and what switching off would do to it.
    expect(blocked.textContent).toMatch(/b6f0c4a29d7e1835/);
    expect(blocked.textContent).toMatch(/undo it at the next start/);
    expect(screen.queryByRole('button', { name: /^Turn off/ })).toBeNull();

    fireEvent.click(blocked);
    await settled();
    expect(powerOffs(sent)).toEqual([]);
  });

  it('answers a window that opened after the list was read with the blocked state, not a paragraph', async () => {
    const { sent } = stubDevice({ windowOpensLate: 'd00dfeed12345678' });
    render(mount(<Settings live={null} />));
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(4_000_000);
    fireEvent.click(await screen.findByRole('button', { name: /^Turn off/ }));
    clock.mockReturnValue(4_000_700);
    fireEvent.click(screen.getByRole('button', { name: /^Turn off now/ }));

    const blocked = await screen.findByRole('button', { name: /^Confirm change first/ });
    expect(blocked.textContent).toMatch(/d00dfeed12345678/);
    // The device's own sentence is for a script; the page does not print it as well.
    expect(screen.queryByText(/inside its confirmation window/)).toBeNull();
    expect(powerOffs(sent)).toHaveLength(1);
    // Refused, so the page is still asking the device things: nothing was switched off.
    expect(usePowerOff.getState().off).toBe(false);
  });

  it('once accepted, says the device is turning off and stops asking it anything', async () => {
    const { sent, closed } = stubDevice();
    render(mount(<App />));
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(3_000_000);

    fireEvent.click(await screen.findByRole('button', { name: /^Turn off/ }));
    clock.mockReturnValue(3_000_700);
    fireEvent.click(screen.getByRole('button', { name: /^Turn off now/ }));

    await screen.findByRole('heading', { name: 'Turning off' });
    expect(screen.getByRole('status').textContent).toMatch(/stays off until its power is cycled/);
    // The event stream is closed, and no screen is left to poll or to draw its own failure.
    expect(closed()).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('link', { name: 'Status' })).toBeNull();

    const before = sent.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent.slice(before)).toEqual([]);
  });
});
