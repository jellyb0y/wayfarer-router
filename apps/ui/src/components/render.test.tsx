/**
 * Every screen mounts, against a DOM.
 *
 * Not a browser-driving suite, and not meant to be. These exist because a React error boundary
 * swallowing a render failure looks like an empty panel and reads as "no data yet" — so a screen that
 * has stopped mounting can go unnoticed indefinitely. A component that renders today cannot silently
 * stop rendering tomorrow.
 *
 * Two real defects sit behind these, both found by loading the interface in a browser for the first
 * time after the code was written and every other test was green:
 *
 * * the schema route served `$defs.Outbound` without the `$defs` its references resolve against, so
 *   **no protocol form rendered at all** — every one refused with "reference #/$defs/Duration does not
 *   resolve";
 * * `.field.row` inherited `flex-direction: column`, so a checkbox stacked above its own label.
 *
 * The first is covered by an API test that asserts a served schema is self-contained. The second is a
 * class of thing these tests cannot catch, and that is stated rather than implied: mounting is not
 * looking right.
 */

import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PlanReview } from './PlanReview.tsx';
import { anchorDeadline, ConfirmationWindow, secondsLeft } from './ConfirmationWindow.tsx';
import { contradicts, LeakPolicy } from './LeakPolicy.tsx';
import { Events, reachBack } from '../pages/Events.tsx';
import { Clients, durationWords, signalWords } from '../pages/Clients.tsx';
import { whereThePanelAnswers } from '../pages/Network.tsx';
import { Routing, protocolTitle } from '../pages/Routing.tsx';
import { Settings } from '../pages/Settings.tsx';
import { NetworkRules } from './NetworkRules.tsx';
import { AccessPointEditor, UplinkEditor } from './ProfileFields.tsx';
import { Status } from '../pages/Status.tsx';
import { useDraft } from '../lib/draft.ts';
import {
  extremeCapabilities,
  extremeFleet,
  extremeInventory,
  extremeProfiles,
  extremeStatus,
  extremeSystem,
} from '../dev/fixtures.ts';
import type { StatusResponse } from '../lib/api.ts';
import { stateWords, uptimeWords } from './DeviceList.tsx';
import { Capabilities, capabilityWords } from './Capabilities.tsx';
import { ManagementReach } from './ManagementReach.tsx';
import { RoutingEditor } from './RoutingEditor.tsx';
import type { PlanResponse } from '../lib/api.ts';

afterEach(() => {
  cleanup();
  /*
   * The draft is a module-level store, so it outlives a render. Left in place it hands the next test
   * the previous test's document — which reads as a screen that loaded, and asserts against rules
   * nobody put there. Isolation between tests is not optional for a shared store.
   */
  useDraft.getState().clear();
  vi.unstubAllGlobals();
});

/*
 * The generated form's tests were here, and they are deleted with it.
 *
 * They asserted real properties — that a credential in a core's own schema rendered as a password
 * field, that a field with no overlay entry still rendered from its schema key, that a nested union
 * resolved by more than `type`. Every one of them was about a renderer that no longer exists: a
 * tunnel is one of three catalogue entries now, each with a designed screen, and nothing in this
 * interface reads a schema at runtime to decide what to draw.
 *
 * Kept as a note rather than silently dropped, because the union-resolution finding was expensive and
 * is still true about a proxy core's schema. It lives in docs/08-ui.md, which says in its own opening
 * that the part it describes is superseded.
 */


describe('plan review', () => {
  const plan = (overrides: Partial<PlanResponse> = {}): PlanResponse => ({
    blastRadius: 'service',
    usable: true,
    empty: false,
    humanDiff: ['write /etc/wayfarer/core/config.json — the proxy core configuration'],
    findings: [],
    notes: [],
    bindings: [],
    files: [{ path: '/etc/wayfarer/core/config.json', purpose: 'the proxy core configuration', mode: '600' }],
    units: [],
    fileChanges: [],
    unitChanges: [],
    sysctlChanges: [],
    interfaceRenames: [],
    ...overrides,
  });

  it('states the consequence in words rather than in a class name', () => {
    render(<PlanReview plan={plan({ blastRadius: 'network' })} />);
    expect(screen.getByText('This can make the device unreachable')).toBeTruthy();
  });

  it('puts an error above everything else and shows its hint', () => {
    render(
      <PlanReview
        plan={plan({
          usable: false,
          findings: [
            {
              severity: 'error',
              code: 'invariant_violation',
              message: 'phy0 cannot host an access point and a client at once.',
              pointer: '/accessPoint/bind',
              hint: 'Put the access point on a second radio.',
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/cannot be applied/)).toBeTruthy();
    // The hint is part of the error contract, not decoration.
    expect(screen.getByText('Put the access point on a second radio.')).toBeTruthy();
  });

  it('names every refused change and what it needs', () => {
    render(
      <PlanReview
        plan={plan()}
        error={{
          code: 'blast_radius_not_applicable',
          message: 'refused',
          hint: 'Apply only the safe changes.',
          refused: [{ what: 'create /etc/wayfarer/nftables.conf', blastRadius: 'network', needs: 'the confirmation window' }],
        }}
      />,
    );
    expect(screen.getByText('create /etc/wayfarer/nftables.conf')).toBeTruthy();
    expect(screen.getByText(/needs the confirmation window/)).toBeTruthy();
  });

  it('never shows the contents of a generated file', () => {
    const { container } = render(<PlanReview plan={plan()} />);
    expect(container.textContent).toContain('/etc/wayfarer/core/config.json');
    expect(container.textContent).toContain('File contents are not shown here');
  });

  it('says so when the plan excludes unsaved edits, and refuses to apply', () => {
    // Found in the browser: the bar said one change was pending while the review showed a plan that
    // did not contain it. A review that is quietly about something else is the failure this screen
    // exists to prevent, arriving through the screen itself.
    render(<PlanReview plan={plan()} pendingChanges={2} onApply={() => undefined} />);
    expect(screen.getByText(/does not include your unsaved changes/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('the routing editor', () => {
  const document = {
    network: { cidr: '10.44.0.1/24', dhcp: { enabled: true, from: '10.44.0.100', to: '10.44.0.200', leaseHours: 12 } },
    uplinks: [],
    tunnels: [{ id: 'alt-a', name: 'Warsaw', role: 'alternative', enabled: true, provider: 'singbox-outbound', config: {} }],
    policy: { priority: [], excluded: [], sticky: true, probes: {}, onAllDown: 'block' },
    firewall: { killSwitch: false, ipv6: 'block', ntpBypass: true, blockedEndpoints: [] },
    routing: {
      rules: [
        { kind: 'protect-own-networks' },
        { kind: 'tunnel-resources' },
        { kind: 'domainSuffix', suffixes: ['.example.invalid'], action: { outbound: 'direct' } },
      ],
      ruleSets: [],
    },
  } as unknown as Record<string, unknown>;

  it('renders the list with its anchors labelled', () => {
    const { container } = render(<RoutingEditor document={document} />);
    expect(container.textContent).toContain('protect-own-networks');
    expect(container.textContent).toContain('anchor');
    expect(container.textContent).toContain('Keeps this page reachable');
  });

  it('previews what the rules produce, from the profile', () => {
    const { container } = render(<RoutingEditor document={document} />);
    expect(container.textContent).toContain('What these rules produce');
    expect(container.textContent).toContain('10.44.0.1/24 and loopback go direct');
    // The automatic entries are labelled once, not twice.
    expect(container.textContent).not.toContain('(added automatically, always first)');
    expect(container.textContent).toContain('Any name ending .example.invalid → direct');
    // A draft with no probe endpoints yet must still render: the generator runs against a document
    // somebody is halfway through editing, and one that throws takes the editor down.
    expect(container.textContent).not.toContain('Blocked by exact name');
    // And where unmatched traffic ends up, which is the last thing worth knowing.
    expect(container.textContent).toContain('Everything else');
  });

  it('warns when a tunnel rule sits above the protect anchor', () => {
    const dangerous = {
      ...document,
      routing: {
        rules: [
          { kind: 'ipCidr', cidrs: ['192.168.0.0/16'], action: { outbound: 'alt-a' } },
          { kind: 'protect-own-networks' },
        ],
        ruleSets: [],
      },
    };
    const { container } = render(<RoutingEditor document={dangerous} />);
    expect(container.textContent).toContain('above');
    expect(container.textContent).toContain('this device becomes unreachable');
  });

  it('does not take the editor down when the draft is mid-edit', () => {
    // The draft is edited live and can be momentarily incomplete. A preview that threw would unmount
    // everything around it.
    const incomplete = { ...document, network: undefined } as unknown as Record<string, unknown>;
    expect(() => render(<RoutingEditor document={incomplete} />)).not.toThrow();
  });
});

describe('the shell', () => {
  it('mounts and reaches the sign-in screen without throwing', async () => {
    // The first mount is where a React application most often dies, and until this existed nothing
    // here had ever mounted one.
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: true, uptimeSeconds: 1, setupComplete: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener(): void {}
        close(): void {}
      },
    );

    const { App } = await import('../App.tsx');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { MemoryRouter } = await import('react-router-dom');

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    expect(() =>
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <App />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    ).not.toThrow();

    vi.unstubAllGlobals();
  });
});

/* ── the confirmation window ─────────────────────────────────────────────────────────────── */

describe('the confirmation window', () => {
  const soon = (): number => 100;

  it('derives the countdown from a deadline, so a frozen page cannot lie about it', () => {
    /*
     * A counter that ticks down locally is wrong in exactly the case this exists for: the tab was
     * backgrounded, the laptop slept, the request hung — and the number carried on as if no time had
     * passed. Every render recomputes from an anchored deadline.
     */
    const anchored = Date.parse('2026-09-21T12:02:30.000Z');
    expect(secondsLeft(anchored, Date.parse('2026-09-21T12:00:00.000Z'))).toBe(150);
    expect(secondsLeft(anchored, Date.parse('2026-09-21T12:02:00.000Z'))).toBe(30);
    // A page frozen for two minutes tells the truth the moment it is looked at again.
    expect(secondsLeft(anchored, Date.parse('2026-09-21T12:04:00.000Z'))).toBe(0);
    // Never negative: "-90 seconds remaining" tells a reader nothing except that something is broken.
    expect(secondsLeft(anchored, Date.parse('2026-09-21T13:00:00.000Z'))).toBe(0);
    // A non-finite anchor reads as expired rather than as infinite.
    expect(secondsLeft(Number.NaN, Date.now())).toBe(0);
  });

  it('anchors the device’s duration against this browser’s clock, not against the device’s', () => {
    /*
     * The defect this replaces: the device sent an ISO `deadlineAt` and the page subtracted
     * `Date.now()` from it — two clocks. This board has no clock battery, so its wall time can be
     * days out after a power cycle, and the countdown was then wrong by the whole difference: "0s
     * left, undoing the change" on a device that had not begun undoing anything, or minutes
     * apparently left on a window about to fire.
     *
     * A duration means the same thing in both frames. Asserted with a device clock a full day behind
     * the browser's, which is the realistic case rather than an extreme one.
     */
    const browserNow = Date.parse('2026-09-21T12:00:00.000Z');
    const anchored = anchorDeadline(150, browserNow);
    expect(secondsLeft(anchored, browserNow)).toBe(150);
    expect(secondsLeft(anchored, browserNow + 149_000)).toBe(1);
    expect(secondsLeft(anchored, browserNow + 151_000)).toBe(0);

    // Nothing about the device's own clock can enter the result, because it was never consulted.
    const deviceClockADayBehind = Date.parse('2026-09-20T12:00:00.000Z');
    expect(anchorDeadline(150, browserNow)).not.toBe(deviceClockADayBehind + 150_000);

    // A nonsense duration anchors at the moment of receipt, so the page says the revert is happening
    // rather than showing a countdown nobody should trust.
    expect(secondsLeft(anchorDeadline(Number.NaN, browserNow), browserNow)).toBe(0);
    expect(secondsLeft(anchorDeadline(-5, browserNow), browserNow)).toBe(0);
  });

  it('says doing nothing undoes the change, and does not claim it was kept', () => {
    render(<ConfirmationWindow secondsRemaining={soon()} contact="ok" onConfirm={() => {}} />);
    expect(screen.getByText(/If you do nothing, this change is undone/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Not confirmed yet/ })).toBeTruthy();
    // The countdown is the governing deadline, and the page says so (G13).
    expect(screen.getByText(/Nothing undoes this change before the countdown ends/)).toBeTruthy();
  });

  it('reports lost contact as expected, and repeats the instruction', () => {
    render(<ConfirmationWindow secondsRemaining={soon()} contact="lost" onConfirm={() => {}} />);
    /*
     * A countdown that simply freezes teaches the reader to reload, and reloading is the one action
     * that cannot help. So this says what happened, that it is expected, and what to do.
     */
    expect(screen.getByText(/can no longer reach the device/)).toBeTruthy();
    expect(screen.getByText(/Reloading this page will not help/)).toBeTruthy();
    // And confirming is disabled: a confirmation has to reach the device to mean anything.
    expect(screen.getByRole('button', { name: /Keep this change/ }).hasAttribute('disabled')).toBe(true);
  });

  it('does not draw an unknown contact state as lost', () => {
    // Before the first poll answers. Crying wolf on every open teaches the reader to ignore it.
    render(<ConfirmationWindow secondsRemaining={soon()} contact="unknown" onConfirm={() => {}} />);
    expect(screen.queryByText(/can no longer reach the device/)).toBeNull();
  });

  it('says the device is undoing it once the window has passed, and offers no button', () => {
    render(
      <ConfirmationWindow secondsRemaining={0} contact="ok" onConfirm={() => {}} />,
    );
    expect(screen.getByText(/putting the previous configuration back by itself/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Keep this change/ })).toBeNull();
  });

  it('says a change was kept only when the device has said so', () => {
    render(<ConfirmationWindow secondsRemaining={soon()} contact="ok" confirmed onConfirm={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Kept' })).toBeTruthy();
  });
});

describe('the choice about traffic leaving unprotected', () => {
  /*
   * The requirement is the wording, not the widget. An operator deciding this is choosing between two
   * losses — everyone offline, or everyone unprotected without being told — and a page that offers
   * "Kill-switch" and a select called `onAllDown` has told them neither.
   */
  const docWith = (killSwitch: boolean, onAllDown: 'block' | 'direct') => ({
    policy: { priority: [], excluded: [], sticky: true, probes: {}, onAllDown },
    firewall: { killSwitch, ipv6: 'block', ntpBypass: true, blockedEndpoints: [] },
  });

  it('asks one question and states what each answer costs', () => {
    render(<LeakPolicy document={docWith(false, 'block')} />);
    expect(screen.getByText(/If all fail/)).toBeTruthy();

    // Blocking: the loss is connectivity, and that the people affected cannot tell why.
    expect(screen.getByText(/loses their connection until a tunnel works again/)).toBeTruthy();
    expect(screen.getByText(/nothing leaves unprotected/)).toBeTruthy();

    // Failing open: the loss is the protection, silently.
    expect(screen.getByText(/unprotected and visible on the uplink/)).toBeTruthy();
    expect(screen.getByText(/nobody is told/)).toBeTruthy();
  });

  it('says what the kill-switch actually covers, rather than naming it', () => {
    render(<LeakPolicy document={docWith(false, 'block')} />);
    // The word "kill-switch" is not what tells anybody anything; the failure it covers is.
    expect(screen.getByText(/crashed or unstarted tunnel/)).toBeTruthy();
    expect(screen.getByText(/looks like a working network/)).toBeTruthy();
  });

  it('explains the contradiction in the flow of the page, and only when it exists', () => {
    const { unmount } = render(<LeakPolicy document={docWith(false, 'direct')} />);
    expect(screen.queryByText(/These answers contradict/)).toBeNull();
    unmount();

    render(<LeakPolicy document={docWith(true, 'direct')} />);
    const sentence = screen.getByText(/These answers contradict/);
    expect(sentence).toBeTruthy();
    // It must say why the kill-switch does not cover this case, or the refusal reads as our bug.
    expect(screen.getByText(/cannot stop the tunnel sending out unprotected/)).toBeTruthy();
    // Not an alert: the operator is mid-decision and has done nothing wrong yet.
    expect(sentence.getAttribute('role')).toBeNull();
  });

  it('agrees with the daemon about which pairs are legal', () => {
    // Two implementations of one rule is the shape this project fails in. They cannot share code
    // across the boundary, so the truth table is asserted on both sides instead.
    expect(contradicts(true, 'direct')).toBe(true);
    expect(contradicts(true, 'block')).toBe(false);
    expect(contradicts(false, 'direct')).toBe(false);
    expect(contradicts(false, 'block')).toBe(false);
  });
});

describe('the event ring', () => {
  /*
   * The ring is the only record that survives a power cut, so the screen owes the reader what is in it
   * and how far back it goes. These tests are about the sentences, because the sentences are the feature.
   */
  const ringOf = (overrides: Partial<{ count: number; capacity: number; entries: unknown[] }> = {}) => ({
    source: 'database',
    capacity: overrides.capacity ?? 5000,
    count: overrides.count ?? 3,
    entries:
      overrides.entries ??
      ([
        { id: 3, at: '2026-09-21T10:00:00.000Z', level: 'error', kind: 'apply.failed', summary: 'apply failed', detail: null },
        { id: 2, at: '2026-09-20T10:00:00.000Z', level: 'warn', kind: 'health.switched', summary: 'moved to hq', detail: null },
        { id: 1, at: '2026-09-18T10:00:00.000Z', level: 'info', kind: 'auth.login', summary: 'login', detail: null },
      ] as never),
  });

  it('says the retention rule is by count, not by age, and what that costs', () => {
    // "5000 rows" does not tell anybody that a busy day holds less history than a quiet one.
    expect(reachBack({ oldestAt: '2026-09-18T10:00:00.000Z', count: 5000, capacity: 5000, now: new Date('2026-09-21T10:00:00.000Z') }))
      .toContain('a busy day holds less history than a quiet one');
    // And when it is not full, nothing has been lost — a different fact, said differently.
    const partial = reachBack({ oldestAt: '2026-09-18T10:00:00.000Z', count: 12, capacity: 5000, now: new Date('2026-09-21T10:00:00.000Z') })!;
    expect(partial).toContain('not full yet');
    expect(partial).toContain('nothing has been evicted');
  });

  it('reports the reach-back from the rows rather than estimating it', () => {
    const now = new Date('2026-09-21T10:00:00.000Z');
    expect(reachBack({ oldestAt: '2026-09-18T10:00:00.000Z', count: 5000, capacity: 5000, now })).toContain('3 days');
    expect(reachBack({ oldestAt: '2026-09-20T10:00:00.000Z', count: 5000, capacity: 5000, now })).toContain('about a day');
    expect(reachBack({ oldestAt: '2026-09-21T09:00:00.000Z', count: 5000, capacity: 5000, now })).toContain('less than a day');
    // Nothing to say is said as nothing, not as "0 days".
    expect(reachBack({ oldestAt: null, count: 0, capacity: 5000, now })).toBeNull();
    expect(reachBack({ oldestAt: 'not a date', count: 5, capacity: 5000, now })).toBeNull();
  });

  /** The screen fetches, so it needs a client. Retries off, or a failure hangs the test instead of failing. */
  const renderRing = async (data: unknown) => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <Events
          ringQuery={async () => data as never}
          journalQuery={async () =>
            ({
              source: 'journal',
              entries: [],
              nextCursor: null,
              currentBootId: null,
              containsEarlierBoots: false,
              hasMore: false,
              incomplete: false,
              incompleteReason: null,
              currentBootEmpty: false,
            }) as never
          }
        />
      </QueryClientProvider>,
    );
  };

  it('names what the ring holds, and that the journal does not survive', async () => {
    await renderRing(ringOf());
    expect(await screen.findByText(/3 of 5000 rows kept/)).toBeTruthy();
    // The two sources, each saying which of the two it is. A reader who cannot tell them apart reads
    // an empty journal after a power cut as an absence of events.
    expect(screen.getByText(/Lost on the next power cut/)).toBeTruthy();
    expect(screen.getByText(/Applies, profile switches, tunnel health, safe mode/)).toBeTruthy();
  });

  it('offers the kinds it actually received rather than a list that can fall behind', async () => {
    await renderRing(ringOf());
    await screen.findByText(/rows kept/);
    for (const kind of ['apply.failed', 'health.switched', 'auth.login']) {
      expect(screen.getByRole('option', { name: kind })).toBeTruthy();
    }
  });

  it('an empty filtered result is not reported as an empty ring', async () => {
    /*
     * The trap this avoids: a filter that empties the list and also zeroes the "kept" figure teaches the
     * reader that narrowing a view destroys history. The ring count always describes the ring.
     */
    await renderRing(ringOf({ count: 412, entries: [] }));
    expect(await screen.findByText(/412 of 5000 rows kept/)).toBeTruthy();
    expect(screen.getByText(/Nothing has been recorded yet/)).toBeTruthy();
  });
});

describe('what a first-time user was not told', () => {
  /*
   * Both of these exist because a real person made the most basic change the product offers, read the screen,
   * and got nothing. The evidence was in the transaction table: two `network` applies, both reverted because
   * the confirmation window expired without an answer.
   */
  it('brings the countdown into view and takes focus, because rendered is not seen', async () => {
    /*
     * The Apply button is in the plan-review panel, which renders *below* the countdown. On a phone the
     * countdown therefore appeared above where the user was looking. Nothing scrolled, nothing took focus,
     * and two and a half minutes later the device undid the change by itself.
     */
    const scrolled: unknown[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: unknown) {
      scrolled.push(options);
    } as typeof original;
    try {
      render(<ConfirmationWindow secondsRemaining={150} contact="ok" onConfirm={() => {}} />);
      const panel = screen.getByRole('alert');
      expect(scrolled.length).toBe(1);
      expect(document.activeElement).toBe(panel);
      // Assertive, not polite: a countdown that undoes itself is not an aside.
      expect(panel.getAttribute('aria-live')).toBe('assertive');
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('survives an environment with no scrollIntoView', () => {
    // A missing browser API must not take down the panel whose whole job is to be visible.
    const original = Element.prototype.scrollIntoView;
    // @ts-expect-error deliberately removing it
    delete Element.prototype.scrollIntoView;
    try {
      render(<ConfirmationWindow secondsRemaining={90} contact="ok" onConfirm={() => {}} />);
      expect(screen.getByRole('heading', { name: /Not confirmed yet/ })).toBeTruthy();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe('where the panel can be reached from', () => {
  const docWith = (onUplinkNetwork: boolean) => ({
    services: { clashApi: { enabled: true, bind: '127.0.0.1:9090' }, management: { onUplinkNetwork } },
  });

  it('says the access point is not a choice, and why', () => {
    render(<ManagementReach document={docWith(true)} />);
    expect(screen.getByText(/cannot be turned off here/)).toBeTruthy();
    expect(screen.getByText(/a device nobody can set up/)).toBeTruthy();
  });

  it('states what is exposed and to whom, differently for each answer', () => {
    /*
     * The setting is the same at home and in a hotel and the situations are opposite, so the words have to
     * carry the difference. Not a warning symbol: that tells somebody to be careful without telling them of
     * what.
     */
    const { unmount } = render(<ManagementReach document={docWith(true)} />);
    expect(screen.getByText(/Anyone on the same network can open this panel/)).toBeTruthy();
    expect(screen.getByText(/away from home it is the café/)).toBeTruthy();
    unmount();

    render(<ManagementReach document={docWith(false)} />);
    expect(screen.getByText(/answers only on the access point and on the device itself/)).toBeTruthy();
    expect(screen.getByText(/forwarded port over/)).toBeTruthy();
  });

  it('names what protects the panel rather than implying the network is trusted', () => {
    // "This network is untrusted" is only actionable next to "and here is what protects you anyway".
    render(<ManagementReach document={docWith(true)} />);
    expect(screen.getByText(/repeated wrong guesses lock that address out/)).toBeTruthy();
    expect(screen.getByText(/needs a token you create here/)).toBeTruthy();
    expect(screen.getByText(/those are never on a network at all/)).toBeTruthy();
  });
});

describe('the capability report', () => {
  it('never draws "could not be answered" as a gap', () => {
    /*
     * The distinction the whole inventory rests on. No radios detected means the question is unanswerable,
     * not that the hardware cannot do it — and a colour cannot express that, so the words do.
     */
    expect(capabilityWords('available')).toBe('available');
    expect(capabilityWords('missing')).toBe('not available');
    expect(capabilityWords('unknown')).toBe('could not be answered');
  });

  it('shows the command for a gap that has one, and the reason for a gap that does not', async () => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Capabilities
          query={async () => ({
            summary: { available: 1, missing: 2, unknown: 0 },
            capabilities: [
              { id: 'ok', title: 'Something that works', state: 'available' as const, missing: [], remedies: [] },
              {
                id: 'dhcp',
                title: 'Hand out addresses',
                state: 'missing' as const,
                missing: ['dnsmasq'],
                remedies: [{ command: 'apt-get install --no-install-recommends dnsmasq-base', note: 'the package is called dnsmasq-base, not dnsmasq' }],
              },
              {
                id: 'ap',
                title: 'Host a wireless network',
                state: 'missing' as const,
                missing: ['a radio that can host an access point'],
                remedies: [{ command: null, note: 'a property of the driver, not a setting' }],
              },
            ],
          })}
        />
      </QueryClientProvider>,
    );

    // The command is shown verbatim, including the package name that is not the binary name.
    expect(await screen.findByText('apt-get install --no-install-recommends dnsmasq-base')).toBeTruthy();
    expect(screen.getByText(/called dnsmasq-base, not dnsmasq/)).toBeTruthy();
    // And a gap with no command says why rather than offering one that would not help.
    expect(screen.getByText(/property of the driver, not a setting/)).toBeTruthy();
  });
});

describe('the aggregate view', () => {
  it('reports the three reachability answers in words, not as colours', () => {
    /*
     * "No answer" and "refused the token" call for entirely different actions: one is a trip to look at a
     * network, the other is a new token created on a device that is working fine. A single red row hides
     * which, and the words are the feature.
     */
    expect(stateWords({ state: 'self' })).toBe('this device');
    expect(stateWords({ state: 'answered' })).toBe('answered');
    expect(stateWords({ state: 'refused' })).toContain('would not accept the stored token');
    expect(stateWords({ state: 'unreachable' })).toContain('network between here and there, not the device');
  });

  it('says nothing about an uptime a peer did not report', () => {
    // A missing figure rendered as 0 reads as "just restarted", which is a different claim entirely.
    expect(uptimeWords(undefined)).toBe('—');
    expect(uptimeWords(600)).toBe('10 min');
    expect(uptimeWords(7200)).toBe('2 h');
    expect(uptimeWords(200_000)).toBe('2 d');
  });
});

describe('the do-nothing notice on the review screen', () => {
  const plan = (overrides: Partial<PlanResponse> = {}): PlanResponse =>
    ({
      blastRadius: 'network',
      usable: true,
      empty: false,
      humanDiff: ['set something'],
      findings: [],
      notes: [],
      bindings: [],
      affectsManagementInterfaces: [],
      files: [],
      units: [],
      fileChanges: [],
      unitChanges: [],
      sysctlChanges: [],
      interfaceRenames: [],
      ...overrides,
    }) as unknown as PlanResponse;

  it('appears before the apply button, because afterwards there is no page left to explain on', () => {
    const { container } = render(<PlanReview plan={plan()} onApply={() => {}} />);
    const html = container.innerHTML;
    expect(html.indexOf('do nothing')).toBeGreaterThan(-1);
    expect(html.indexOf('do nothing')).toBeLessThan(html.indexOf('>Apply<'));
    expect(screen.getByText(/do not reload/)).toBeTruthy();
  });

  it('is not shown for a change that cannot cost access', () => {
    // A notice shown for every change is one nobody reads by the time it matters.
    render(<PlanReview plan={plan({ blastRadius: 'service' })} onApply={() => {}} />);
    expect(screen.queryByText('If this goes wrong, do nothing')).toBeNull();
  });
});

describe('who is connected', () => {
  /*
   * Two readings on this screen can be absent, and both have a value a reader would accept as a
   * measurement if we printed the default: a signal of zero is a perfect signal, and an empty
   * station list is "nobody is here". The screen exists to answer the second of those, so an
   * unanswered question must never be drawn as the answer.
   */
  const statusWith = (complete: boolean, stations: unknown[], reason: string | null = null): StatusResponse =>
    ({
      at: '2026-09-21T10:00:00.000Z',
      network: null,
      units: {},
      accessPoints: {
        'wlan0-the-longest-interface-name': {
          status: { state: 'ENABLED', channel: 149, frequencyMhz: 5745 },
          stations,
          stationsComplete: complete,
          stationsIncomplete: reason,
        },
      },
      links: {},
      clock: null,
      stationHistory: [],
    }) as unknown as StatusResponse;

  const renderClients = async (status: StatusResponse) => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <Clients live={status} />
      </QueryClientProvider>,
    );
  };

  it('says a list that was cut short was cut short, and why, rather than drawing it as nobody', async () => {
    // "Nobody is connected" and "we could not finish asking" are the same empty list to a screen
    // that only draws rows. And "some may be missing" with no cause is a warning nobody can act on.
    await renderClients(statusWith(false, [], 'hostapd_cli all_sta did not answer in time'));
    expect(
      screen.getByText(
        'This access point did not finish listing its clients, so some may be missing: hostapd_cli all_sta did not answer in time.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Nobody is connected/)).toBeTruthy();
  });

  it('prints no caveat over a whole list of real clients', async () => {
    // The bench board, 2026-09-23: two associated stations, a whole 1755-byte reply, and this
    // screen said the list was unfinished — because it read "rebuilt one station at a time" as
    // "complete". The snapshot now says `stationsComplete`, and a whole list carries no caveat.
    await renderClients(
      statusWith(true, [
        { mac: 'aa:bb:cc:00:0e:01', signalDbm: -41, connectedSeconds: 122894 },
        { mac: 'aa:bb:cc:00:0e:02', signalDbm: -55, connectedSeconds: 162589 },
      ]),
    );
    expect(screen.queryByText(/did not finish listing its clients/)).toBeNull();
    expect(screen.getByText('aa:bb:cc:00:0e:01')).toBeTruthy();
    expect(screen.getByText('aa:bb:cc:00:0e:02')).toBeTruthy();
  });

  it('does not print the caveat when the device did finish asking', async () => {
    await renderClients(statusWith(true, []));
    expect(screen.queryByText(/did not finish listing its clients/)).toBeNull();
    expect(screen.getByText(/Nobody is connected/)).toBeTruthy();
  });

  it('reports an absent counter as unknown, never as a reading of zero', () => {
    // Several drivers do not populate every station counter. Zero dBm is an excellent signal, which
    // is the opposite of what a missing value means.
    expect(signalWords(null)).toBe('unknown');
    expect(signalWords(0)).toBe('0 dBm');
    expect(signalWords(-67)).toBe('-67 dBm');
    expect(durationWords(null)).toBe('unknown');
    expect(durationWords(0)).toBe('0 s');
    expect(durationWords(7200)).toBe('2 h');
  });

  it('carries every reading of a station, each beside its own label', async () => {
    await renderClients(
      statusWith(true, [{ mac: 'aa:bb:cc:dd:ee:01', signalDbm: -55, connectedSeconds: 3600 }]),
    );
    const row = screen.getByText('aa:bb:cc:dd:ee:01').closest('li')!;
    // Labels, because there is no header row to scroll away from — that is the whole reason this is
    // a list of rows and not a table.
    expect(within(row).getByText('Access point')).toBeTruthy();
    expect(within(row).getByText('Connected for')).toBeTruthy();
    // The signal appears exactly once on the row: two copies of one reading can only ever disagree
    // by mistake, and the reader is then left choosing between them.
    expect(within(row).getAllByText('-55 dBm')).toHaveLength(1);
    expect(within(row).getByText('60 min')).toBeTruthy();
    expect(within(row).getByText('wlan0-the-longest-interface-name')).toBeTruthy();
  });
});

describe('where the panel answers, by interface', () => {
  /*
   * Against the bench board's own reading, 2026-09-21: the wire `192.168.77.7` and the wireless
   * uplink `192.168.77.8` are **one subnet, two interfaces**, and the panel answered on the second
   * and on nothing at the first. That pair is the whole reason this screen prints names, and a
   * fixture without both of them cannot produce the failure it exists to prevent.
   */
  const reach = () =>
    whereThePanelAnswers(
      extremeSystem() as never,
      extremeInventory() as never,
    );

  it('tells two interfaces in one subnet apart, which a list of addresses cannot', () => {
    const byName = new Map(reach().map((entry) => [entry.interface, entry]));

    // The uplink answers on .8.
    expect(byName.get('wfwan0')?.answering).toBe(true);
    expect(byName.get('wfwan0')?.addresses).toContain('192.168.77.8');

    // The wire, one address away in the same subnet, does not — and is listed saying so rather than
    // being dropped, because an interface named in the configuration and bound to nothing is the
    // defect, not an absence.
    expect(byName.get('end0')?.answering).toBe(false);
    expect(byName.get('end0')?.unresolved).toBe(true);
  });

  it('never lists a tunnel as somewhere the panel answers', () => {
    // `tun0` belongs to no profile this project created, and the prohibition covers it the same.
    expect(reach().some((entry) => entry.interface === 'tun0')).toBe(false);
  });

  it('keeps a bound address no interface claims, rather than dropping it', () => {
    /*
     * The panel is audible there whatever the address table says. Dropping it would make the screen
     * quietly complete — the failure mode this whole screen is written against.
     */
    const entries = whereThePanelAnswers(
      { listen: { port: 8088, addresses: ['203.0.113.9'], unresolvedInterfaces: [] } } as never,
      { interfaces: [] } as never,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.interface).toBeNull();
    expect(entries[0]!.answering).toBe(true);
  });

  it('says nothing at all when the device has not said where it listens', () => {
    // Not an empty list drawn as "nowhere": no reading and a reading of nowhere are different facts.
    expect(whereThePanelAnswers(undefined, extremeInventory() as never)).toEqual([]);
  });
});

describe('what goes where', () => {
  /*
   * The two things this screen must not get wrong. One is a configuration that takes the device off
   * the network; the other is a pair of fields that wear the same words and are not the same field.
   */
  const documentWith = (rules: unknown[]) => ({
    meta: { name: 'bench' },
    tunnels: [
      { id: 't1', name: 'Amsterdam egress', role: 'alternative', enabled: true, protocol: 'vless', config: {} },
      { id: 't2', name: 'HQ', role: 'resource', enabled: true, protocol: 'cloak-openvpn', config: {} },
    ],
    routing: { rules, ruleSets: [] },
  });

  /*
   * The document arrives the way it does on a device — through the profile route, into the draft by
   * the shared editing hook. Forcing it into the store directly would skip the wiring this screen
   * depends on, and would pass on a screen that never loads anything.
   */
  const renderRouting = async (rules: unknown[]) => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const answer = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (/\/api\/profiles\/[^/]+$/.test(url)) return answer({ document: documentWith(rules), missingSecrets: [] });
      if (url.includes('/api/profiles')) return answer({ activeProfileId: 'p1', profiles: [] });
      // The plan is fetched to answer "saved but not running"; an empty one keeps the bar quiet.
      return answer({ empty: true, findings: [], humanDiff: [] });
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Routing />
      </QueryClientProvider>,
    );
    await screen.findByText(/Matched from the top/);
    return view;
  };

  it('warns when a tunnel rule sits above the protect anchor', async () => {
    /*
     * Private space overlaps the management network. A rule sending 192.168/16 into a tunnel above
     * the anchor takes the operator's own traffic with it and the device stops answering. Allowed,
     * and said out loud.
     */
    await renderRouting([
      { kind: 'ipCidr', cidrs: ['192.168.0.0/16'], action: { outbound: 't1' } },
      { kind: 'protect-own-networks' },
    ]);
    expect(screen.getByText(/above the protect anchor/)).toBeTruthy();
    expect(screen.getByText(/becomes unreachable/)).toBeTruthy();
  });

  it('does not warn when the anchor is above the tunnel rule', async () => {
    await renderRouting([
      { kind: 'protect-own-networks' },
      { kind: 'ipCidr', cidrs: ['192.168.0.0/16'], action: { outbound: 't1' } },
    ]);
    expect(screen.queryByText(/above the protect anchor/)).toBeNull();
  });

  it('writes a rule’s suffixes at the rule’s pointer, never at a tunnel’s', async () => {
    /*
     * **The collision this epic exists to stop being invisible.** A rule's suffixes live at
     * `/routing/rules/N/suffixes`; a tunnel's live at `/tunnels/N/resources/domainSuffix`. Same words
     * on screen, different field underneath — which is how the tunnel's half went unnoticed long
     * enough to make the product API-only. The pointer on the control is what tells them apart, and
     * it is the same attribute the coverage manifest is harvested from.
     */
    const { container } = await renderRouting([
      { kind: 'domainSuffix', suffixes: ['example.test'], action: { outbound: 't1' } },
    ]);
    const pointers = [...container.querySelectorAll('[data-pointer]')].map((node) =>
      node.getAttribute('data-pointer'),
    );
    expect(pointers).toContain('/routing/rules/0/suffixes');
    expect(pointers).toContain('/routing/rules/0/action/outbound');
    expect(pointers.some((pointer) => pointer!.includes('/resources/'))).toBe(false);
  });

  it('offers a tunnel by the owner’s name for the protocol, never by what runs it', () => {
    // A catalogue named after what we start is named from our side of the product.
    expect(protocolTitle('vless')).toBe('VLESS');
    expect(protocolTitle('cloak-openvpn')).toBe('Cloak + OpenVPN');
    expect(protocolTitle('openvpn')).toBe('OpenVPN');
    // The shape changed: there is no `provider` any more, and an absent protocol is not guessed.
    expect(protocolTitle(undefined)).toBe('unknown');
  });
});

describe('how old the list this device routes on actually is', () => {
  /*
   * **The obligation that comes with falling back to the copy on disk.**
   *
   * A failed refresh keeps the old list rather than refusing, which is right and is not free: an
   * out-of-date list does not know addresses allocated since it was written, so part of the traffic
   * a rule was written for leaves by the ordinary route while the tunnel, the rule and the core all
   * look healthy. Every assertion below is about that being **said** rather than implied.
   *
   * The device words the answer and this screen prints it. No timestamp is subtracted here: the
   * browser's clock is a third clock and the board's has no battery.
   */
  const SETS = [
    { tag: 'geoip-ru', type: 'remote', url: 'https://example.invalid/ru.srs', updateIntervalHours: 24 },
  ];
  const document = {
    meta: { name: 'bench' },
    tunnels: [{ id: 't1', name: 'Russian proxy', role: 'alternative', enabled: true, protocol: 'proxy', config: {} }],
    routing: {
      rules: [{ kind: 'ruleSet', sets: ['geoip-ru'], action: { outbound: 't1' } }],
      ruleSets: SETS,
    },
  };

  const renderWithAges = async (sets: unknown[], profileId: string | null = 'p1') => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const answer = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.includes('/api/rule-sets')) return answer({ profileId, sets });
      if (/\/api\/profiles\/[^/]+$/.test(url)) return answer({ document, missingSecrets: [] });
      if (url.includes('/api/profiles')) return answer({ activeProfileId: 'p1', profiles: [] });
      return answer({ empty: true, findings: [], humanDiff: [] });
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Routing />
      </QueryClientProvider>,
    );
    await screen.findByText(/Matched from the top/);
    return view;
  };

  it('says a list is out of date, and in what words, rather than printing a number nobody reads', async () => {
    await renderWithAges([
      {
        tag: 'geoip-ru',
        type: 'remote',
        state: 'overdue',
        ageSeconds: 345_600,
        intervalHours: 24,
        overdueAfterSeconds: 259_200,
        observedFrom: '/var/lib/wayfarer/core-cache.db',
        ageLabel: '4d',
        exact: false,
        summary: 'at least 4d old — the cache holds every remote set together, and this set may be far older',
      },
    ]);
    expect(await screen.findByText('Out of date')).toBeTruthy();
    // The sentence, not only the pill: a colour alone is something a person learns to stop seeing.
    expect(screen.getByText(/the cache holds every remote set together/)).toBeTruthy();
    expect(screen.getByText(/may be far older/)).toBeTruthy();
  });

  it('a fresh remote figure is drawn as a floor, never as a measured age', async () => {
    /*
     * **The correction this whole row turned on.** The cache file's timestamp is the most recent
     * write by *any* remote set, so the figure understates: it says something in the cache was
     * refreshed, not that this set was. A pill reading `2h` is a claim this device cannot support,
     * and the one a person would quote.
     */
    await renderWithAges([
      {
        tag: 'geoip-ru',
        type: 'remote',
        state: 'fresh',
        ageSeconds: 7200,
        intervalHours: 24,
        overdueAfterSeconds: 259_200,
        observedFrom: '/var/lib/wayfarer/core-cache.db',
        ageLabel: '2h',
        exact: false,
        summary: 'at least 2h old — the cache holds every remote set together, and this set may be far older',
      },
    ]);
    expect(await screen.findByText('≥ 2h')).toBeTruthy();
    expect(screen.queryByText('2h')).toBeNull();
  });

  it('says nothing about age when the profile on screen is not the one the device answered about', async () => {
    /*
     * The join between a stored set and a file on this device is a **tag string**, and the device
     * answers about the profile it is actually running. A not-yet-applied profile reusing the tag
     * `geoip-ru` would otherwise be shown the running profile's freshness for a list this device may
     * never have fetched — a false *this list is fine*, in the one place somebody is deciding
     * whether to trust a list.
     */
    await renderWithAges(
      [
        {
          tag: 'geoip-ru',
          type: 'remote',
          state: 'fresh',
          ageSeconds: 7200,
          intervalHours: 24,
          overdueAfterSeconds: 259_200,
          observedFrom: '/var/lib/wayfarer/core-cache.db',
          ageLabel: '2h',
          exact: false,
          summary: 'at least 2h old',
        },
      ],
      'another-profile',
    );
    await screen.findByText(/Matched from the top/);
    expect(screen.queryByText('≥ 2h')).toBeNull();
    expect(screen.queryByText(/at least 2h old/)).toBeNull();
  });

  it('a file this device could not read is not reported as a list that never arrived', async () => {
    // Two different faults, two different places to go: a permission here, a network there.
    await renderWithAges([
      {
        tag: 'geoip-ru',
        type: 'remote',
        state: 'unreadable',
        ageSeconds: null,
        intervalHours: 24,
        overdueAfterSeconds: 259_200,
        observedFrom: '/var/lib/wayfarer/core-cache.db',
        ageLabel: null,
        exact: false,
        summary: 'this device could not read the file that would say how old it is (EACCES)',
      },
    ]);
    expect(await screen.findByText('Could not read it')).toBeTruthy();
    expect(screen.queryByText('Never fetched')).toBeNull();
  });

  it('a clock that has never been set produces no number and never a reassuring one', async () => {
    /*
     * The failure direction that matters. This board has no clock battery, so the state below is the
     * one it is in every time it boots without an uplink — and a blank, or a zero, would read as
     * "refreshed just now" about a list nobody has measured.
     */
    await renderWithAges([
      {
        tag: 'geoip-ru',
        type: 'remote',
        state: 'unmeasurable',
        ageSeconds: null,
        intervalHours: 24,
        overdueAfterSeconds: 259_200,
        observedFrom: '/var/lib/wayfarer/core-cache.db',
        ageLabel: null,
        exact: false,
        summary: 'the clock has not been synchronised since boot, so its age cannot be measured',
      },
    ]);
    expect(await screen.findByText('Age not reported')).toBeTruthy();
    expect(screen.getByText(/age cannot be measured/)).toBeTruthy();
    expect(screen.queryByText('Out of date')).toBeNull();
  });

  it('says so when the profile asks for no refresh interval, on the control that leaves it empty', async () => {
    // Rule 4: the consequence belongs in the control that causes it. An empty interval is the reason
    // nothing can ever call this list out of date, and the field is where that has to be said.
    await renderWithAges([]);
    expect(
      await screen.findByText('Hours; left empty, nothing can report this list as out of date.'),
    ).toBeTruthy();
  });

  it('a device that has not answered draws no badge at all, rather than a green one', async () => {
    // "Nobody has looked" and "this list is fine" are different answers and must look different.
    await renderWithAges([]);
    expect(screen.queryByText('Out of date')).toBeNull();
    expect(screen.queryByText('Age not reported')).toBeNull();
  });
});

describe('password, profiles, device', () => {
  /*
   * The seventh screen, and the three defects it is most likely to grow.
   *
   * It collects four destinations that used to be separate, so the first risk is that one of them is
   * *copied* rather than moved and two places start disagreeing. The second is that the field naming the
   * default password turns back into the shutter it used to be. The third is quieter and is the reason
   * for the last test here: a control on this screen that carried a JSON Pointer would add a field to
   * the coverage manifest that the profile document does not have.
   */
  const renderWith = async (
    element: ReactElement,
    /** Called for every request, so a test can watch what the screen actually sends. */
    watch?: (url: string, method: string) => unknown,
  ) => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const answer = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const seen = watch?.(url, init?.method ?? 'GET');
      if (seen !== undefined && seen !== null) return answer(seen);
      if ((init?.method ?? 'GET') === 'DELETE') return answer({ deleted: true });
      if (url.includes('/api/system')) return answer(extremeSystem());
      if (url.includes('/api/status')) return answer(extremeStatus());
      if (url.includes('/api/fleet')) return answer(extremeFleet());
      if (url.includes('/api/capabilities')) return answer(extremeCapabilities());
      if (/\/api\/profiles\/[^/]+$/.test(url)) return answer({ document: {}, missingSecrets: [] });
      if (url.includes('/api/profiles')) return answer(extremeProfiles());
      return answer({ empty: true, findings: [], humanDiff: [] });
    });
    const { MemoryRouter } = await import('react-router-dom');
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{element}</MemoryRouter>
      </QueryClientProvider>,
    );
  };

  /*
   * The panel that answers "is this device running what it was told to run".
   *
   * Two tests and not one, because the interesting halves are opposite: a divergence has to appear
   * **with both values**, and an absent comparison must not appear as a good one. The second is the
   * failure this whole mechanism exists to end, one level out — a screen that is quiet where a
   * divergence belongs says quietly that there were none.
   */
  const withDrift = (body: unknown, element: ReactElement) =>
    renderWith(element, (url) => (url.includes('/api/drift') ? body : null));

  it('draws a divergence with the pointer and both values, not a sentence about a file', async () => {
    await withDrift(
      {
        report: {
          state: 'diverged',
          reason: 'periodic',
          findings: [
            {
              severity: 'error',
              code: 'config_diverged',
              kind: 'file-content',
              subject: '/etc/wayfarer/core/config.json',
              pointer: '/dns/servers/0/server',
              stored: '"10.184.100.5"',
              running: '"10.184.40.5"',
              message: 'the core is asking an address its peer stopped handing out',
              hint: 'Apply the active profile.',
            },
          ],
          checked: { files: 9, units: 4, sysctl: 3 },
          omitted: 0,
          at: '2026-09-22T10:00:00.000Z',
          durationMs: 210,
        },
        ageSeconds: 42,
        summary: 'this device is not running its stored profile',
      },
      <Status live={null} />,
    );

    await screen.findByText('/etc/wayfarer/core/config.json /dns/servers/0/server');
    // Both values, on the screen, so nobody has to open a terminal to learn which way round it is.
    expect(screen.getByText('"10.184.100.5"')).toBeTruthy();
    expect(screen.getByText('"10.184.40.5"')).toBeTruthy();
  });

  /*
   * The watchers. A resolver follower did nothing for ten hours on the bench board and no screen could
   * say so; this card is where it is said. Proved both ways, because a card that can only be green is
   * the defect it exists for.
   */
  const withObservers = (body: unknown) =>
    renderWith(<Status live={null} />, (url) => (url.includes('/api/observers') ? body : null));
  const observer = (overrides: Record<string, unknown>) => ({
    name: 'resolver-follower',
    watches: 'captured resolvers against the core configuration',
    everySeconds: 60,
    state: 'ok',
    problem: null,
    lastLooked: { at: '2026-09-23T00:00:00.000Z', ageSeconds: 12, what: 'every captured resolver is in use: hq -> 10.184.48.5' },
    lastActed: null,
    ...overrides,
  });

  it('shows a watcher that is not running as a problem, with its reason', async () => {
    await withObservers({
      problems: 1,
      observers: [
        observer({
          name: 'resolver-watch',
          state: 'not-running',
          problem: 'resolver-watch is not running, so nothing is watching /run/wayfarer/tunnel: ENOENT',
          lastLooked: null,
        }),
      ],
    });
    await screen.findByText(/A watcher is not running, has stopped looking, or sees a failure/);
    expect(screen.getByText('not running')).toBeTruthy();
    expect(screen.getByText(/nothing is watching \/run\/wayfarer\/tunnel: ENOENT/)).toBeTruthy();
  });

  it('shows a watcher whose subject is failing as a problem, though the watcher itself is running', async () => {
    // Bench board, 2026-09-23: the tunnel watchdog read "ok" while a guard it probes had blocked a tunnel.
    await withObservers({
      problems: 1,
      observers: [
        observer({
          name: 'tunnel-watchdog',
          state: 'failing',
          problem: 'traffic for partner is being refused: its guard is on block',
          lastLooked: { at: '2026-09-23T19:50:46.000Z', ageSeconds: 5, what: 'no failover group; guard partner: BLOCKED' },
        }),
      ],
    });
    await screen.findByText(/A watcher is not running, has stopped looking, or sees a failure/);
    expect(screen.getByText('failing')).toBeTruthy();
    expect(screen.getByText(/partner is being refused/)).toBeTruthy();
  });

  it('lays out every guard of a reading as its own row, however long the notes', async () => {
    const note = 'no probe target is configured for this tunnel, so nothing about it was measured';
    await withObservers({
      problems: 0,
      observers: [
        observer({
          name: 'tunnel-watchdog',
          lastLooked: {
            at: '2026-09-23T22:24:11.000Z',
            ageSeconds: 3,
            what: 'no failover group; guards: hq not measured, partner not measured, lab not measured, home not measured',
            items: ['hq', 'partner', 'lab', 'home'].map((subject) => ({ subject, state: 'guard not measured', note })),
          },
        }),
      ],
    });
    for (const subject of ['hq', 'partner', 'lab', 'home']) {
      expect(await screen.findByText(`${subject}: guard not measured — ${note}`)).toBeTruthy();
    }
  });

  it('shows a dead tunnel on block in red, with how it was measured and that the guard is not blocking it', async () => {
    /*
     * Plan row G30: the guard no longer blocks a tunnel on `block`. A red word alone would be read as
     * "blocked", so the row says how the reading was taken and what was done. Mutation: drop the tone
     * from the item's pill and the first assertion fails; drop the action line and the last one does.
     */
    await withObservers({
      problems: 1,
      observers: [
        observer({
          name: 'tunnel-watchdog',
          state: 'failing',
          problem: 'partner (3 round(s)) reads dead; the guard does not block it, its traffic fails rather than leaving another way',
          lastLooked: {
            at: '2026-09-24T09:00:00.000Z',
            ageSeconds: 4,
            what: 'no failover group; guards: partner DEAD 3 round(s) (peer keepalive)',
            items: [
              {
                subject: 'partner',
                state: 'DEAD 3 round(s)',
                note: 'nothing has arrived from the peer for at least 90 s',
                method: 'peer keepalive',
                action: 'its traffic is NOT being blocked by the guard: its outbound is bound to wfvpnprt',
                tone: 'bad',
              },
            ],
          },
        }),
      ],
    });
    const pill = await screen.findByText('DEAD 3 round(s)');
    expect(pill.className).toContain('pill bad');
    expect(screen.getByText('partner: by peer keepalive — nothing has arrived from the peer for at least 90 s')).toBeTruthy();
    expect(screen.getByText(/Done about it: its traffic is NOT being blocked by the guard/)).toBeTruthy();
  });

  it('shows a watcher that is running and idle with what it last saw, not as a blank', async () => {
    await withObservers({ problems: 0, observers: [observer({})] });
    await screen.findByText(/Every watcher is running and has looked recently/);
    expect(screen.getByText(/hq -> 10\.184\.48\.5/)).toBeTruthy();
    expect(screen.queryByText(/not running/)).toBeNull();
  });

  it('says nobody has looked yet, rather than that everything is in force', async () => {
    await withDrift({ report: null, ageSeconds: null, summary: 'not compared yet' }, <Status live={null} />);
    await screen.findByText(/Not looked at yet/);
    expect(screen.queryByText(/Everything this profile describes is in force/)).toBeNull();
  });

  it('holds the device inventory, and Status no longer does', async () => {
    /*
     * The move, asserted from both ends. A test on Settings alone would pass on a copy, and a copy is
     * the defect: two inventories agree until somebody changes one of them, and "duplicate controls for
     * the same field in different places" is one of the four things this epic deletes.
     */
    await renderWith(<Settings live={null} />);
    expect(await screen.findByText('Device')).toBeTruthy();

    cleanup();
    await renderWith(<Status live={null} />);
    /*
     * Anchored on a value only a **loaded** Status can draw — the access point's interface name, from
     * the fixture — rather than on a heading the component renders before any query answers.
     *
     * The first version waited for "No access point", which is what the screen shows *while it is
     * loading*. The negative half below would then have been asserted against a page with nothing on
     * it, and "the Device fold is not here" is trivially true of a blank page. A negative assertion is
     * only worth the positive one standing beside it.
     */
    await screen.findByText('wlan0-the-longest-interface-name');
    expect(screen.queryByText('Device')).toBeNull();
  });

  it('gives every reachability answer the device reported, in words', async () => {
    /*
     * The three answers as rendered, not as a pure function — the function was already tested and the
     * screen could still draw one of them and drop the rest. The fixture carries all four states for
     * that reason, and a fixture holding only peers that answered would have measured nothing.
     */
    await renderWith(<Settings live={null} />);
    expect(await screen.findByText('this device')).toBeTruthy();
    expect(screen.getByText(/would not accept the stored token/)).toBeTruthy();
    expect(screen.getByText(/network between here and there, not the device/)).toBeTruthy();
    // And the reading that says two boards were flashed from one card, rather than one board.
    expect(screen.getByText(/means a card was copied/)).toBeTruthy();
  });

  it('does not offer to activate a profile the device would refuse, and says why in the control', async () => {
    /*
     * The device answers a profile with a missing secret with 422 and names the fields. A button that
     * offered it anyway would turn a refusal into an error message, and an access point with an empty
     * passphrase is an open network — which is why the daemon refuses rather than trying.
     */
    await renderWith(<Settings live={null} />);
    const blocked = await screen.findByRole('button', { name: 'Fill secrets first' });
    expect(blocked.hasAttribute('disabled')).toBe(true);
    // The pointers it is short of are on the row, so the reason is readable without another screen.
    expect(screen.getByTitle('/accessPoint/passphrase /uplinks/0/config/psk /tunnels/0/config/credentials/password /subscriptions/0/url')).toBeTruthy();
  });

  it('offers no way to copy a profile, because every way it could would move the secrets', async () => {
    /*
     * Not an unfinished control. A copy assembled in the browser has to pull every credential through
     * the page: the full export needs a separate scope and writes a warning to the journal precisely
     * because it is a deliberate act, and a button labelled "duplicate" would turn that into an unnamed
     * routine. The redacted export gives a copy nobody can activate. Copying belongs inside the store,
     * where nothing travels, and that route does not exist — see `docs/08-ui.md`.
     *
     * Asserted as the list of actions rather than as the absence of one word, so any control added here
     * has to be decided on rather than typed in — and one has been since, which is the test working
     * rather than the test being in the way. **"Edit this one" is not a copy.** It points the four
     * editing screens at a stored profile and moves nothing: no credential is read, nothing is
     * written, and the document it opens is the one already on the device. That it sits beside
     * Activate is the whole point of E6b — choosing what to edit and choosing what to run are two
     * acts, and before this they were one.
     */
    await renderWith(<Settings live={null} />);
    await screen.findByRole('button', { name: 'Fill secrets first' });
    const card = screen.getByRole('heading', { name: 'Profiles' }).closest('section')!;
    const actions = [...card.querySelectorAll('.row-item .row-actions button')].map((node) => node.textContent);
    expect(new Set(actions)).toEqual(
      new Set(['Activate', 'Fill secrets first', 'Edit this one', 'Export', 'Export with secrets', 'Delete']),
    );
  });

  it('says what exporting with secrets costs where a reader can see it, not in a tooltip', async () => {
    /*
     * The consequence belongs in the control that causes it. This one used to live in a `title` on the
     * button — which is to say it was written down in the one place a phone can never show it, and the
     * screen is designed for a phone. The sentence is now beside the controls, and the assertion covers
     * both halves: it is on the page, and the button carries no tooltip that could quietly become the
     * only copy again.
     */
    await renderWith(<Settings live={null} />);
    const button = await screen.findAllByRole('button', { name: 'Export with secrets' });
    expect(screen.getByText(/copies them in clear, and the device records it/)).toBeTruthy();
    expect(button[0]!.getAttribute('title')).toBeNull();
  });

  it('deletes on a second tap, and never on the one that arrives with the first', async () => {
    /*
     * Both halves, because either alone documents a control that does not exist.
     *
     * A two-step delete with no floor between the steps is answered by a **double tap**, which is an
     * ordinary movement on a phone — it is how people zoom, and how they recover from a tap they think
     * missed. The reader never sees the second label, and the profile is gone. So the confirming state
     * refuses anything inside 500 ms, and this drives the clock across that boundary in both directions.
     *
     * The first tap must also delete nothing at all, which is asserted first: a control that armed *and*
     * fired would pass the timing test and still be wrong.
     */
    const deleted: string[] = [];
    await renderWith(<Settings live={null} />, (url, method) => {
      if (method === 'DELETE') deleted.push(url);
      return null;
    });
    await screen.findByRole('button', { name: 'Fill secrets first' });

    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1_000_000);

    /*
     * Every assertion runs after the pending work has drained. A mutation reaches `fetch` on a
     * microtask, so an assertion made in the same tick as the click reports "nothing was sent" about a
     * request that is about to be sent — and the two negative assertions below would then pass whatever
     * the control did. This is the same flaw as an anchor the failure case satisfies, wearing a clock.
     */
    const settled = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const row = screen.getByText('amsterdam-evening-failover-with-cloak-and-subscription').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await settled();
    expect(deleted).toEqual([]);

    // The label now names what disappears, so a reader one row out finds out before the act, not after.
    const confirm = within(row).getByRole('button', {
      name: 'Delete “amsterdam-evening-failover-with-cloak-and-subscription” for good?',
    });

    // The other half of a double tap: 200 ms later, refused.
    clock.mockReturnValue(1_000_200);
    fireEvent.click(confirm);
    await settled();
    expect(deleted).toEqual([]);

    // A person who meant it: past the floor, accepted.
    clock.mockReturnValue(1_000_700);
    fireEvent.click(confirm);
    await waitFor(() => expect(deleted).toHaveLength(1));
    expect(deleted[0]).toContain('/api/profiles/p2');
    clock.mockRestore();
  });

  it('stamps a pointer on the three positions it writes, and on nothing else', async () => {
    /*
     * This asserted **zero** pointers until the old profile editor was deleted, and the reasoning it
     * was written for is unchanged: the coverage manifest is harvested from `data-pointer` on a
     * rendered screen, so a pointer stamped on a control that does not write the document would add a
     * field the schema does not have — the mirror image of the collision on Routing, and just as
     * invisible. The password, a peer's read token and a new profile's name are still not positions in
     * the profile document and still carry no pointer.
     *
     * What changed is that this screen now edits positions that *are* in it — the active profile's
     * name and note, which had no control anywhere else after the deletion, and the core's control
     * API, which is under Device because whether this board runs a second control interface is the
     * same kind of fact as which binaries are installed. So the assertion names them rather than
     * counting: counting would have to be relaxed to "at most a few" to keep passing, and a count with
     * slack in it stops catching the thing it was written for.
     */
    const { container } = await renderWith(<Settings live={null} />);
    /*
     * Waited on a row from the fixture, not on the fold's own summary. "Device" is a static heading that
     * renders before any query answers, so it proves the component mounted and says nothing about
     * whether the profile list, the peer list or the inventory are on the page — and **a screen with no
     * rows has no pointers either**, which is the assertion below passing for the wrong reason.
     */
    await screen.findByRole('button', { name: 'Fill secrets first' });
    await screen.findByText('Device');
    const pointers = [...container.querySelectorAll('[data-pointer]')]
      .map((node) => node.getAttribute('data-pointer'))
      .sort();
    expect(pointers).toEqual(['/meta/description', '/meta/name', '/services/clashApi/enabled']);

    // And a control that is not a profile field is not a `Field`, which is the thing that would stamp
    // it. Asserted on the control itself rather than on the total, so a fourth one appearing cannot
    // pass by arithmetic.
    expect(screen.getByLabelText(/New password/i).closest('.field-block')).toBeNull();
  });
});

/**
 * The two fields on every role that only a person can answer, and the reason they are not checkboxes.
 *
 * They reached the interface last, through the parity check rather than through anybody's reading:
 * the requirement walk memoised on object identity, `HardwareBinding`, `PinName` and
 * `TakeOverInterface` are one declaration shared by two roles, and the second role's four positions
 * were therefore never walked. Fixing the walk made them required, and they had no control at all.
 *
 * What is asserted here is the wording and the written value, because those are the two things a
 * screenshot cannot check and a refactor can quietly break.
 */
describe('pinning a name, and taking an interface over', () => {
  const documentWith = (accessPoint: Record<string, unknown>): Record<string, unknown> => ({
    accessPoint: {
      ssid: 'w',
      passphrase: { $set: true },
      radio: { band: '5GHz', channel: 149, width: 80, country: 'GE', hidden: false },
      bind: { by: 'mac', value: '90:de:80:47:b4:b4' },
      acceptChannelFollowsUplink: false,
      ...accessPoint,
    },
  });

  const mount = (document: Record<string, unknown>): void => {
    useDraft.getState().load('p', document);
    render(<AccessPointEditor document={document} />);
    for (const summary of screen.getAllByText(/Which radio/)) fireEvent.click(summary);
  };

  it('states what each answer costs, for the answer that is off as well', () => {
    mount(documentWith({}));

    // Leaving the name alone is a decision with its own consequence, and a cleared checkbox states none.
    expect(screen.getByText(/Applies now with no reboot/)).toBeTruthy();
    expect(screen.getByText(/at the next boot/)).toBeTruthy();

    // Refusing the takeover is what the device does by default, and the refusal is the thing to say.
    expect(screen.getByText(/the plan stops and names the file/)).toBeTruthy();
    expect(screen.getByText(/moved aside, never deleted/)).toBeTruthy();
  });

  /*
   * The one place a phone cannot show. `Export with secrets` had its whole consequence in a `title`
   * and nobody could read it; these two carry more consequence than that one did.
   */
  it('puts none of it in a tooltip', () => {
    mount(documentWith({ pinName: true, takeOverInterface: true }));
    for (const pointer of ['/accessPoint/pinName', '/accessPoint/takeOverInterface']) {
      const block = document.querySelector(`[data-pointer="${pointer}"]`);
      expect(block).toBeTruthy();
      expect(block?.querySelectorAll('[title]').length).toBe(0);
    }
  });

  it('draws the answer the document holds, and absent as the refusal', () => {
    const { unmount } = render(<div />);
    unmount();

    mount(documentWith({ pinName: true, takeOverInterface: true }));
    const on = document.querySelectorAll('[data-pointer="/accessPoint/pinName"] input:checked');
    expect(on.length).toBe(1);
    expect((on[0] as HTMLInputElement).value).toBe('true');
    cleanup();
    useDraft.getState().clear();

    // Absent is the schema's default, and the default is a refusal rather than an unanswered question.
    mount(documentWith({}));
    const off = document.querySelectorAll('[data-pointer="/accessPoint/takeOverInterface"] input:checked');
    expect(off.length).toBe(1);
    expect((off[0] as HTMLInputElement).value).toBe('false');
  });

  /*
   * A radio input's own value is a **string**, always. This control shares its markup with the one
   * that edits string-valued choices, so the failure it invites is writing `"true"` into a position
   * the schema declares as a boolean — a document that looks right in the panel and is refused on
   * save, or worse, stored and read as truthy in both directions.
   */
  it('writes a boolean, not the word', () => {
    mount(documentWith({}));
    const choice = document.querySelector(
      '[data-pointer="/accessPoint/takeOverInterface"] input[value="true"]',
    ) as HTMLInputElement;
    expect(choice).toBeTruthy();
    fireEvent.click(choice);
    const written = useDraft.getState().draft?.['accessPoint'] as Record<string, unknown>;
    expect(written['takeOverInterface']).toBe(true);
    expect(typeof written['takeOverInterface']).toBe('boolean');
  });

  it('asks the same two questions of an uplink, at that uplink’s position', () => {
    const uplinks = {
      uplinks: [
        { id: 'wan-eth-0', kind: 'ethernet', priority: 10, enabled: true, bind: { by: 'any-ethernet' }, config: { dhcp: true } },
      ],
    };
    useDraft.getState().load('p', uplinks);
    render(<UplinkEditor document={uplinks} />);
    for (const summary of screen.getAllByText(/^Edit$/)) fireEvent.click(summary);

    expect(document.querySelector('[data-pointer="/uplinks/0/pinName"]')).toBeTruthy();
    expect(document.querySelector('[data-pointer="/uplinks/0/takeOverInterface"]')).toBeTruthy();
    // The same sentences, from the one declaration: two copies are two copies that drift.
    expect(screen.getByText(/at the next boot/)).toBeTruthy();
    expect(screen.getByText(/the plan stops and names the file/)).toBeTruthy();
  });
});

/**
 * The two controls added for the positions that had no screen at all, and the hazard each one carries.
 *
 * Both are shared renderers — `NumberList` reuses the textarea `TextList` draws, `SelectField`'s
 * "no answer" option reuses the select every closed list draws — and sharing is what makes them worth
 * testing. A copy of a renderer is the copy that does not get the next fix; a *share* is the thing
 * that quietly writes the wrong type. Both of these are asserted on the value that reaches the draft,
 * and both were proved by mutation rather than by being read.
 */
describe('a list of numbers, and a choice that can be left unanswered', () => {
  afterEach(() => {
    cleanup();
    useDraft.getState().clear();
  });

  const blocked = {
    firewall: { blockedEndpoints: [{ ipCidr: '192.0.2.0/24', ports: [443], protocol: 'any' }] },
  };

  function mountRules(): void {
    useDraft.getState().load('p', blocked);
    render(<NetworkRules document={blocked} />);
    for (const summary of screen.getAllByText(/^(Blocked endpoints|Edit)$/)) fireEvent.click(summary);
  }

  /*
   * A textarea's value is always a string, which is the same shape of hazard as a radio input's value
   * in `BooleanChoiceField`. Written as strings, `["443", "8443"]` looks correct on screen, is written
   * into the draft, and is refused by the schema on save — at which point the reader has a document
   * they cannot see anything wrong with.
   *
   * **Proved by mutation, in both directions.** Replacing `NumberList`'s parse with the string list
   * `TextList` writes makes this fail on `typeof` and leaves every other test in this file green; the
   * anchor below asserts the control was found and the change was applied before the type is looked
   * at, so a selector that stopped matching cannot pass this as "nothing written, nothing wrong".
   */
  it('writes whole numbers, not the digits typed', () => {
    mountRules();
    const ports = document.querySelector(
      '[data-pointer="/firewall/blockedEndpoints/0/ports"] textarea',
    ) as HTMLTextAreaElement;
    expect(ports).toBeTruthy();
    expect(ports.value).toBe('443');

    fireEvent.change(ports, { target: { value: '443\n8443\n' } });
    const written = (useDraft.getState().draft?.['firewall'] as Record<string, unknown>)?.[
      'blockedEndpoints'
    ] as Record<string, unknown>[];
    expect(written[0]!['ports']).toEqual([443, 8443]);
    for (const port of written[0]!['ports'] as unknown[]) expect(typeof port).toBe('number');
  });

  /*
   * A line that is not a whole number is dropped rather than written as `NaN`. `NaN` is the worst of
   * the three available answers: it validates as nothing, it serialises to `null`, and the field it
   * lands in reads as "no ports" — which is the setting that blocks the address on *every* port.
   */
  it('drops a line that is not a number rather than writing NaN', () => {
    mountRules();
    const ports = document.querySelector(
      '[data-pointer="/firewall/blockedEndpoints/0/ports"] textarea',
    ) as HTMLTextAreaElement;
    expect(ports).toBeTruthy();
    fireEvent.change(ports, { target: { value: '443\nhttps\n8443' } });
    const written = (useDraft.getState().draft?.['firewall'] as Record<string, unknown>)?.[
      'blockedEndpoints'
    ] as Record<string, unknown>[];
    expect(written[0]!['ports']).toEqual([443, 8443]);
  });

  /*
   * The "no answer" option, and the reason it carries which absence to write rather than guessing.
   *
   * A Wi-Fi uplink's `band` is a union **with `null` in it** — "whichever band the network is on" is a
   * value. A rule set's `format` is `Type.Optional`, which is the absence of a value. They are not
   * interchangeable and the same validator refuses either one in the other's place. The reflex
   * implementation — an `<option value="">` — writes `""`, which is in neither.
   *
   * Asserted with `'band' in config`, not on the value alone: `undefined` and a written `null` are the
   * same falsy reading, so a test written against truthiness would pass on the bug.
   */
  it('writes the absence the field actually declares, and never an empty string', () => {
    const uplinks = {
      uplinks: [
        {
          id: 'wan-wifi-0',
          kind: 'wifi-sta',
          priority: 20,
          bind: { by: 'phy-builtin' },
          config: { ssid: 'net', band: '5GHz' },
        },
      ],
    };
    useDraft.getState().load('p', uplinks);
    render(<UplinkEditor document={uplinks} />);
    for (const summary of screen.getAllByText(/^Edit$/)) fireEvent.click(summary);

    const band = document.querySelector('[data-pointer="/uplinks/0/config/band"] select') as HTMLSelectElement;
    expect(band).toBeTruthy();
    expect(band.value).toBe('5GHz');

    const absent = [...band.options].find((option) => option.text === 'Whichever it is on');
    expect(absent).toBeTruthy();
    // Never the empty string: `""` is in neither half of this union and is refused on save.
    expect(absent!.value).not.toBe('');

    fireEvent.change(band, { target: { value: absent!.value } });
    const config = (useDraft.getState().draft?.['uplinks'] as Record<string, unknown>[])[0]![
      'config'
    ] as Record<string, unknown>;
    expect('band' in config).toBe(true);
    expect(config['band']).toBeNull();
  });
});
