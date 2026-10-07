/**
 * The coverage manifest, **derived from the rendered interface rather than written down.**
 *
 * ## Why this is a harvest and not a list
 *
 * The question it answers is Epic E's own: *which positions in the profile document can a person edit
 * here?* Three ways to answer it were available and two of them are worse than nothing.
 *
 * A **hand-kept list** declares coverage. It is correct on the day it is written and goes stale the
 * first time somebody deletes a control and not its entry — and it goes stale silently, which is the
 * property that matters, because the list is what anybody would quote.
 *
 * **Grepping the source** for `pointer=` is worse, because it looks mechanical. JSX that a grep finds
 * can be present and never rendered: behind a condition that is always false, in a component nobody
 * mounts, inside a screen that was removed from the router. It would have passed on exactly the day it
 * mattered.
 *
 * So the manifest is read off a **rendered** DOM. A field that leaves a screen leaves the DOM, leaves
 * the harvest, and changes this file — and the change is both written to disk, where a diff shows it,
 * and failed here, so nothing lands quietly.
 *
 * ## An attribute is not a control, and the harvest used to accept one
 *
 * The rendered DOM answers *was this pointer stamped onto something*, and parity asks *can a person
 * supply this value*. Which gate separates the two is in `lib/harvest.ts`, together with the
 * measurement that showed the old one accepted a caption where a passphrase belonged.
 *
 * ## The file is not rewritten when it disagrees
 *
 * Why not, and what replaced it, is in `lib/manifest.ts`. The short of it: a write that happens
 * before the comparison makes the second run green with no code change, which for every pointer the
 * parity comparison does not separately require is a guard that fires once and never again.
 *
 * ## Indices are normalised, because the manifest is about the schema
 *
 * A rendered control writes `/routing/rules/0/suffixes` — an instance path, true of one fixture. What
 * parity is about is the *position in the document*, so every numeric segment becomes `-`, the JSON
 * Pointer append token this repository already uses for the same purpose elsewhere. Two rules do not
 * make two covered fields.
 *
 * ## What this file does not claim
 *
 * It is the interface half only. Whether every field a person must fill is reachable **from both** the
 * interface and the API is E7, asserted over the schema; this produces the side of that comparison that
 * cannot otherwise be trusted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeParity, parityReport, parityRequirements } from '@wayfarer/schemas';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { Status } from './pages/Status.tsx';
import { Clients } from './pages/Clients.tsx';
import { Events } from './pages/Events.tsx';
import { Network } from './pages/Network.tsx';
import { Routing } from './pages/Routing.tsx';
import { Tunnels } from './pages/Tunnels.tsx';
import { Settings } from './pages/Settings.tsx';
import { useDraft } from './lib/draft.ts';
import { harvestScreen, normalisePointer } from './lib/harvest.ts';
import { compareManifest, describeManifest, type Manifest, type ManifestEntry } from './lib/manifest.ts';
import type { StatusResponse } from './lib/api.ts';
import {
  extremeCapabilities,
  extremeEventLog,
  extremeFleet,
  extremeInventory,
  extremeLogs,
  extremeProfileDocument,
  extremeProfiles,
  extremeStatus,
  extremeSystem,
} from './dev/fixtures.ts';

afterEach(() => {
  cleanup();
  // The draft is a module-level store and outlives a render; left in place it hands the next screen the
  // previous screen's document, which reads as a screen that loaded.
  useDraft.getState().clear();
  vi.unstubAllGlobals();
});

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'parity-manifest.json');

export { normalisePointer };

/**
 * The screens, each with a value only a **loaded** one can draw.
 *
 * The anchor is not decoration. A harvest run against a screen that never loaded finds no pointers, and
 * "no pointers" is indistinguishable from "this screen edits nothing" — so the manifest would shrink,
 * this test would report the shrinkage as a change to accept, and the interface would have lost a field
 * with the file agreeing. Every screen states something it can only say once its data has arrived.
 */
const SCREENS: {
  name: string;
  element: () => React.ReactElement;
  loaded: string | RegExp;
  /**
   * Whether this screen edits the profile document, and so must have it before anything is harvested.
   *
   * This is waited for on the **store**, never on one of the controls. Anchoring on a control would make
   * the harvest circular: delete the control and the test fails with "could not find that text" instead of
   * showing a manifest that lost a pointer — which is the one thing this file exists to show.
   */
  editsProfile?: boolean;
}[] = [
  { name: 'status', element: () => <Status live={null} />, loaded: 'wlan0-the-longest-interface-name' },
  { name: 'clients', element: () => <Clients live={null} />, loaded: /aa:bb:cc:dd:ee:00/ },
  { name: 'events', element: () => <Events />, loaded: /rows kept/ },
  {
    name: 'network',
    element: () => <Network live={null} />,
    loaded: 'wlan0-the-longest-interface-name',
    editsProfile: true,
  },
  { name: 'routing', element: () => <Routing />, loaded: /Matched from the top/, editsProfile: true },
  /*
   * Anchored on a tunnel's name from the fixture, not on the screen's own heading. The heading renders
   * while the profile is still loading, so a Tunnels screen whose document never arrived would satisfy
   * it and then contribute nothing to the harvest — and a manifest that lost every tunnel pointer would
   * be written out as the new truth.
   */
  { name: 'tunnels', element: () => <Tunnels />, loaded: /^01 Amsterdam egress/, editsProfile: true },
  /*
   * `editsProfile` since the profile's own name and note moved here. Without it the harvest can run
   * before the document arrives, and Settings contributes nothing — which reads as "this screen edits
   * nothing" and is exactly the silent shrinkage this file exists to make impossible.
   */
  { name: 'settings', element: () => <Settings live={null} />, loaded: /Fill secrets first/, editsProfile: true },
];

function stubDevice(): void {
  const answer = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.includes('/api/system')) return answer(extremeSystem());
    if (url.includes('/api/status')) return answer(extremeStatus());
    if (url.includes('/api/fleet')) return answer(extremeFleet());
    if (url.includes('/api/capabilities')) return answer(extremeCapabilities());
    if (url.includes('/api/inventory')) return answer(extremeInventory());
    if (url.includes('/api/eventlog')) return answer(extremeEventLog());
    if (url.includes('/api/logs')) return answer(extremeLogs());
    if (/\/api\/profiles\/[^/]+$/.test(url)) return answer({ document: extremeProfileDocument(), missingSecrets: [] });
    if (url.includes('/api/profiles')) return answer(extremeProfiles());
    return answer({ empty: true, findings: [], humanDiff: [], notes: [], bindings: [] });
  });
}

/** Pointers that rendered with no control anybody can fill, kept for the failure message. */
let inert: string[] = [];

async function harvest(): Promise<Manifest> {
  const fields: ManifestEntry[] = [];
  const inertSeen = new Set<string>();
  for (const entry of SCREENS) {
    stubDevice();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{entry.element()}</MemoryRouter>
      </QueryClientProvider>,
    );
    /*
     * Proof that what follows was harvested from a screen with its **data** on it, not from one that
     * merely mounted. `findAll` rather than `find`: the assertion is "at least one", and several of these
     * values legitimately appear more than once — a station in the list and again in the arrivals — so a
     * single-match query would fail for a reason that has nothing to do with the property.
     */
    await screen.findAllByText(entry.loaded);
    if (entry.editsProfile === true) {
      await waitFor(() => expect(useDraft.getState().draft).not.toBeNull());
    }
    /*
     * A pointer counts when a person can supply the value, which for two shapes on these screens is
     * only knowable by tapping: a credential the device already holds hides its input behind
     * **Replace**, and a tunnel's protocol is filled by pressing one of three add buttons. The
     * argument, and the measurement of what tapping the wrong thing costs, is in `lib/harvest.ts`.
     */
    const { pointers, inert: blank } = harvestScreen(container, {
      click: (node) => fireEvent.click(node),
      document: () => useDraft.getState().draft,
    });
    for (const pointer of pointers) fields.push({ pointer, screen: entry.name });
    for (const pointer of blank) inertSeen.add(`${pointer} (${entry.name})`);
    cleanup();
    useDraft.getState().clear();
    vi.unstubAllGlobals();
  }
  /*
   * Sorted by pointer first and screen second, which is what makes the second question askable at all:
   * **the same pointer on two screens is two adjacent entries.** A control duplicated across screens is
   * one of the four defects this epic deletes, and in a file keyed by screen it would have been two
   * entries nobody puts side by side.
   */
  fields.sort((left, right) =>
    left.pointer === right.pointer ? left.screen.localeCompare(right.screen) : left.pointer.localeCompare(right.pointer),
  );
  inert = [...inertSeen].sort();
  return {
    generatedBy: 'apps/ui/src/parity.test.tsx — derived from the rendered DOM, never edited by hand',
    // Every screen that was harvested, including the ones that edit nothing. A consumer has to be able to
    // tell "this screen has no editable fields" from "this screen was not looked at".
    screens: SCREENS.map((entry) => entry.name),
    fields,
  };
}

describe('what the interface can edit, harvested from the rendered screens', () => {
  it('regenerates the manifest, and fails when it has changed', async () => {
    const harvested = await harvest();

    /*
     * Compared without rewriting the file it compares against — the argument is in `lib/manifest.ts`,
     * along with the two runs that measured the difference. The diff a reader wants is still a file
     * diff; it is just between the committed manifest and the harvest beside it, so that running the
     * suite a second time cannot be what makes the failure go away.
     */
    const verdict = compareManifest(MANIFEST, harvested);
    if (verdict.status === 'unchanged') return;
    throw new Error(describeManifest(MANIFEST, verdict, inert));
  });

  /**
   * The other half of the question, **compared in the same run that builds the manifest.**
   *
   * The comparison could have lived in the daemon's run, where the schema side already is. It must
   * not, and the reason is the direction of its failure: that run would read the manifest **from
   * disk**, so a stale file — one written before a control was deleted — fails towards the reassuring
   * answer. A field that left a screen would stay green. Detecting staleness would be one more thing
   * that can silently not work; comparing here, against the object just harvested from the rendered
   * DOM, removes the possibility rather than watching for it.
   *
   * The harvested object is passed directly and never re-read from the file. The file exists so a
   * person can read it and a diff can show it; routing the comparison through it would close the
   * circle back onto exactly what this avoids.
   */
  it('renders every position a person is required to fill', async () => {
    const harvested = await harvest();
    const report = parityReport(parityRequirements(), harvested);
    if (report.faults.length > 0) {
      throw new Error(
        `${report.requiredCount} positions must be fillable; ${report.renderedCount} are fillable ` +
          `across ${report.screenCount} screen(s).\n${describeParity(report)}` +
          // Named here as well as in the manifest failure, because this is the message somebody
          // reads when a control became a caption: the pointer is on the screen and the fault says
          // it is on no screen, which without this line reads as the check being wrong.
          (inert.length > 0
            ? `\n${inert.length} pointer(s) rendered with no control a person can fill: ${inert.join(', ')}`
            : ''),
      );
    }
  });

  it('harvested something, because an empty harvest agrees with every manifest', async () => {
    /*
     * The failure this file would otherwise have: every screen breaking at once produces an empty
     * harvest, an empty harvest is written to the manifest, and from then on the comparison passes
     * forever against a file that says the interface edits nothing.
     *
     * So the count is asserted separately from the contents, and against a floor rather than a number:
     * the exact figure is the manifest's job, and repeating it here would mean editing two places for
     * every ordinary change.
     */
    const harvested = await harvest();
    expect(harvested.fields.length).toBeGreaterThan(0);
  });

  it('counts a position once, however many rows a fixture happens to have', () => {
    // Two rules are not two covered fields. The manifest is about the document's shape.
    expect(normalisePointer('/routing/rules/0/suffixes')).toBe('/routing/rules/-/suffixes');
    expect(normalisePointer('/tunnels/12/resources/domainSuffix')).toBe('/tunnels/-/resources/domainSuffix');
    // A segment that merely contains a digit is a name, not an index.
    expect(normalisePointer('/uplinks/0/config/dns1')).toBe('/uplinks/-/config/dns1');
  });
});
