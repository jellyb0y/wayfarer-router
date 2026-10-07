/**
 * E6b: a profile that is not the active one can be edited again, and the screen says so.
 *
 * ## The defect this covers
 *
 * Deleting the old profile editor left the four editing screens working on the **active** profile
 * alone. So the API could edit any stored profile and the interface exactly one — the asymmetry this
 * epic exists to remove, pointing the other way — and preparing an alternative meant activating it
 * first, which is the step before applying it.
 *
 * ## What is asserted, and why each half is here
 *
 * Every one of these is a pair. A test that only proves the warning *appears* on a non-active profile
 * passes just as well on a panel that shows it always, which is a banner nobody reads on the day it
 * changes; a test that only proves Review is *absent* passes on a panel where Review never renders at
 * all, which would be a worse defect than the one being fixed. So each property is asserted in both
 * states, and the state is the only thing that differs between the two runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { Shell } from './App.tsx';
import { Routing } from './pages/Routing.tsx';
import { Settings } from './pages/Settings.tsx';
import { useDraft } from './lib/draft.ts';
import { useChosenProfile, useProfileTarget } from './lib/target.ts';
import {
  extremeCapabilities,
  extremeFleet,
  extremeProfileDocument,
  extremeProfiles,
  extremeStatus,
  extremeSystem,
} from './dev/fixtures.ts';

afterEach(() => {
  cleanup();
  // Both stores are module-level and outlive a render. Left in place, the next test inherits the
  // previous one's selection — and a test that inherits its precondition is a test that stops being
  // about what it says it is about.
  useDraft.getState().clear();
  useChosenProfile.getState().choose(null);
  vi.unstubAllGlobals();
});

function stub(): void {
  const answer = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.includes('/api/system')) return answer(extremeSystem());
    if (url.includes('/api/status')) return answer(extremeStatus());
    if (url.includes('/api/fleet')) return answer(extremeFleet());
    if (url.includes('/api/capabilities')) return answer(extremeCapabilities());
    if (/\/api\/profiles\/[^/]+$/.test(url)) return answer({ document: extremeProfileDocument(), missingSecrets: [] });
    if (url.includes('/api/profiles')) return answer(extremeProfiles());
    // A plan with nothing in it, so `notApplied` is false and the bar's two facts stay separable.
    return answer({ empty: true, findings: [], humanDiff: [], notes: [], bindings: [] });
  });
}

function mount(element: ReactElement): void {
  stub();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A probe that renders what `useProfileTarget` resolved to, so the resolution can be read. */
function Probe(): ReactElement {
  const target = useProfileTarget();
  return <p>{`${target.id ?? 'none'} · ${target.isActive ? 'active' : 'not-active'} · ${target.name ?? '—'}`}</p>;
}

describe('which profile the editing screens are pointed at', () => {
  it('is the active one when nothing has been chosen', async () => {
    mount(<Probe />);
    await screen.findByText('p1 · active · —');
  });

  it('is the chosen one, and says it is not the active one', async () => {
    useChosenProfile.getState().choose('p2');
    mount(<Probe />);
    await screen.findByText(/^p2 · not-active · /);
  });

  /*
   * A chosen id that is no longer in the list resolves **back to the active profile**, not to nothing.
   *
   * The alternative is four screens loading a document for a profile that does not exist, which never
   * answers and renders as a screen that is permanently still loading — a failure that looks exactly
   * like a slow device. It happens for real: the profile can be deleted from another browser, or on
   * the device.
   */
  it('falls back to the active profile when the chosen one has gone', async () => {
    useChosenProfile.getState().choose('a-profile-that-was-deleted');
    mount(<Probe />);
    await screen.findByText('p1 · active · —');
  });
});

describe('the bar on a profile the device is not running', () => {
  /*
   * The pair. Both runs mount the same screen against the same fixtures; the only difference is which
   * profile is selected, which is what makes the second run evidence about the selection rather than
   * about the screen.
   *
   * Proved by mutation: forcing `isActive` true in `PendingBar` makes the second half of each of
   * these fail and leaves the first half green — so neither is passing because the control it looks
   * for never renders.
   */
  it('offers Review on the active profile', async () => {
    mount(<Routing />);
    await screen.findByRole('button', { name: 'Review' });
    expect(screen.queryByText(/applying is a step that belongs/)).toBeNull();
  });

  it('offers Save only on any other profile, and says which act is missing', async () => {
    useChosenProfile.getState().choose('p2');
    mount(<Routing />);

    // The anchor first: the bar is on the screen and has loaded. Asserted before the absence below,
    // because "Review is not here" is also what a screen that never rendered the bar would report.
    await screen.findByRole('button', { name: 'Save' });
    await screen.findByRole('button', { name: 'Discard' });
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();

    /*
     * Said in words, not left as a gap. The confirmation window's entire safety property is an
     * operator watching a countdown on the device being changed; a profile that is not running has no
     * plan, no blast radius and no window, so reusing "review and apply" here would blur activating
     * with applying — two different acts, and a first-time user has already been recorded reading one
     * as the other.
     */
    await screen.findByText(/applying is a step that belongs to the profile in use/);
  });
});

describe('the shell, which is where a person finds out', () => {
  /*
   * The banner is in the shell and not on the screens, because the hazard is that a person does not
   * remember: the choice is made on Settings and survives every navigation, so a warning that lived
   * where the choice was made would be absent on the four screens where the editing happens.
   *
   * Both directions, and the negative one is the one that matters most: a banner that is always there
   * is a banner nobody reads on the day it changes, and a test for its presence alone passes on
   * exactly that panel.
   */
  it('says nothing while the running profile is the one being edited', async () => {
    mount(<Shell live={null} />);
    await screen.findByRole('link', { name: 'Status' });
    expect(document.querySelector('.editing-elsewhere')).toBeNull();
  });

  it('names the profile whenever it is not the running one', async () => {
    useChosenProfile.getState().choose('p2');
    mount(<Shell live={null} />);
    await screen.findByRole('link', { name: 'Status' });
    await waitFor(() => expect(document.querySelector('.editing-elsewhere')).not.toBeNull());
    await screen.findByText(/not the running profile/);
    // And a way back to it from wherever the reader is, rather than a sentence they have to act on
    // by remembering where the choice was made.
    expect(screen.getByRole('link', { name: 'Edit the running one' })).toBeTruthy();
  });
});

describe('choosing which profile to edit', () => {
  it('names the profile being edited on its own row, and offers the choice on the others', async () => {
    mount(<Settings live={null} />);
    // Exactly one row says it is the one being edited; the other two offer to become it. Asserted as
    // both counts, because "one badge" alone passes on a panel where every row has the badge too.
    await screen.findByText('Being edited');
    expect(screen.queryAllByText('Being edited')).toHaveLength(1);
    expect(await screen.findAllByRole('button', { name: 'Edit this one' })).toHaveLength(2);
  });

  /*
   * Switching replaces the draft, and a replacement is a silent loss. So the chooser refuses while
   * anything is unsaved and **names the reason** — a control that is merely disabled is a control
   * somebody presses twice and then distrusts.
   *
   * The unsaved edit is made through the store rather than by typing into a field, because what is
   * being asserted is the refusal, not the route the edit took; anchoring on a particular control
   * would make this fail for an unrelated reason the day that control moves.
   */
  it('refuses to switch while an edit is unsaved, and says why', async () => {
    mount(<Settings live={null} />);
    // The draft has to be loaded before an edit can be pending: `set` on an empty store is a no-op,
    // and a test that made its edit first would be asserting the refusal against no change at all.
    await waitFor(() => expect(useDraft.getState().draft).not.toBeNull());
    const before = await screen.findAllByRole('button', { name: 'Edit this one' });
    expect(before).toHaveLength(2);
    for (const button of before) expect(button.hasAttribute('disabled')).toBe(false);

    useDraft.getState().set('/meta/description', 'an edit nobody has saved');
    const after = await screen.findAllByRole('button', { name: 'Save or discard first' });
    expect(after).toHaveLength(2);
    for (const button of after) expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.queryAllByRole('button', { name: 'Edit this one' })).toHaveLength(0);
  });

  /*
   * Picking the active profile clears the selection rather than storing its id.
   *
   * Stored, the id would keep pointing at a profile that stops being the active one the moment
   * somebody activates another — and the screens would go on editing it while the shell said nothing,
   * which is this task's own defect reintroduced by the control that fixes it.
   */
  it('clears the selection rather than pinning the active profile by id', async () => {
    useChosenProfile.getState().choose('p2');
    mount(<Settings live={null} />);
    // The active profile's own row: the one whose button puts the selection back to "whichever is
    // running" rather than pinning `p1` by id.
    const rows = await screen.findAllByRole('button', { name: 'Edit this one' });
    const active = rows.find((button) => button.closest('.row-item')?.querySelector('.pill.ok') !== null);
    expect(active).toBeTruthy();
    active!.click();
    await waitFor(() => expect(useChosenProfile.getState().chosen).toBeNull());
  });
});
