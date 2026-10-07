/**
 * The 360 px bench: every screen, mounted against the longest realistic value in every field.
 *
 * This is a separate entry point rather than a route, and that is the point of it. It never appears
 * in a build — `vite build` builds `index.html` alone — so nothing here can reach a device, and it
 * needs no authentication, no daemon and no bench board to run. `pnpm check:360` opens it in a
 * headless browser at 360 px and measures whether the page scrolls sideways.
 *
 * Why a browser at all, when there are component tests beside this: **jsdom has no layout engine.**
 * `scrollWidth` is `0` for every element it renders, so a test there cannot produce the failure it
 * would be claiming to exclude. It would pass on a page that overflows by a thousand pixels, which
 * is worse than having no check, because it would be quoted as one.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Status } from '../pages/Status.tsx';
import { Clients } from '../pages/Clients.tsx';
import { Events } from '../pages/Events.tsx';
import { Network } from '../pages/Network.tsx';
import { Routing } from '../pages/Routing.tsx';
import { Tunnels } from '../pages/Tunnels.tsx';
import { Settings } from '../pages/Settings.tsx';
import { PlanReview } from '../components/PlanReview.tsx';
import { ConfirmationWindow } from '../components/ConfirmationWindow.tsx';
import { EditingElsewhere } from '../components/EditingElsewhere.tsx';
import { PowerOffControl, PoweredOff } from '../components/PowerOff.tsx';
import {
  LONGEST_NAME,
  extremeApply,
  extremeCapabilities,
  extremeDrift,
  extremeObservers,
  extremeRuleSetAges,
  extremeFleet,
  extremePlan,
  extremeInventory,
  extremeProfileDocument,
  extremeEventLog,
  extremeLogs,
  extremeProfiles,
  extremeStatus,
  extremeSystem,
  extremeTransactions,
  extremeTokens,
  EXTREME_POWER_OFF_FAILURE,
} from './fixtures.ts';
import type { StatusResponse } from '../lib/api.ts';

/** The longest profile name the schema allows, with nothing in it a layout engine may break at. */
const UNBREAKABLE_NAME = LONGEST_NAME.replace(/[ ,-]/g, 'x');
import '../styles.css';

/**
 * Every request a screen makes, answered from the fixtures — and every request it makes that these
 * fixtures do not answer, **recorded rather than answered with nothing.**
 *
 * The first version returned `{}` for anything it did not recognise, and that is the failure mode this
 * whole bench exists to prevent, one level up from the screens. A fold whose query is unanswered
 * renders empty, an empty fold fits inside 360 px, and the check reports "ok" — on data that does not
 * exist. The Devices fold was measured that way for exactly as long as it took to notice.
 *
 * So an unmatched route lands on `window.__unanswered`, and `check-360.mjs` fails on a non-empty list.
 * `DELIBERATELY_UNANSWERED` is the one exception, stated rather than implied: the plan a screen asks
 * for on opening describes a device, there is no device here, and a fixture for it would be a fiction
 * about a board nobody read.
 */
const DELIBERATELY_UNANSWERED = [/\/api\/apply/, /\/api\/plan/];

const ROUTES: [RegExp, () => unknown][] = [
  [/\/api\/system/, extremeSystem],
  [/\/api\/status/, extremeStatus],
  [/\/api\/profiles\/[^/]+$/, () => ({ document: extremeProfileDocument(), missingSecrets: [] })],
  [/\/api\/profiles/, extremeProfiles],
  [/\/api\/eventlog/, extremeEventLog],
  [/\/api\/logs/, extremeLogs],
  [/\/api\/fleet/, extremeFleet],
  [/\/api\/capabilities/, extremeCapabilities],
  [/\/api\/inventory/, extremeInventory],
  /*
   * Both added 2026-09-22. `/api/drift` had been unanswered since the Status panel started asking
   * for it, so that panel was never measured at any width and this check had been failing on it —
   * which is the bench catching exactly the failure it exists for, about itself.
   */
  [/\/api\/drift/, extremeDrift],
  // Added 2026-09-23 with the card it feeds.
  [/\/api\/observers/, extremeObservers],
  [/\/api\/rule-sets/, extremeRuleSetAges],
  // Added 2026-09-23 with the switch-off control on Settings, which asks it whether a window is open.
  [/\/api\/transactions/, extremeTransactions],
  // Added 2026-10-07 with the tokens card on Settings.
  [/\/api\/tokens/, extremeTokens],
];

declare global {
  interface Window {
    __unanswered?: string[];
  }
}

window.__unanswered = [];

window.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const matched = ROUTES.find(([pattern]) => pattern.test(url));
  if (matched === undefined && !DELIBERATELY_UNANSWERED.some((pattern) => pattern.test(url))) {
    window.__unanswered!.push(url);
  }
  const body = matched === undefined ? {} : matched[1]();
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {/* Each screen is mounted under its own anchor so the checker can name which one overflowed. */}
        <div data-screen="status">
          <Status live={extremeStatus() as unknown as StatusResponse} />
        </div>
        <div data-screen="clients">
          <Clients live={extremeStatus() as unknown as StatusResponse} />
        </div>
        <div data-screen="events">
          <Events />
        </div>
        <div data-screen="network">
          <Network live={extremeStatus() as unknown as StatusResponse} />
        </div>
        <div data-screen="routing">
          <Routing />
        </div>
        {/*
          * Sixteen tunnels, every fold opened by the checker: three designed editors, four obfuscation
          * entry points on each Cloak tunnel with their own folds inside them, a full `.ovpn` file, a
          * 253-character domain in a resource list and a 1.6 KiB key behind a secret control. This is
          * the densest screen in the interface and the one the epic exists for.
          */}
        <div data-screen="tunnels">
          <Tunnels />
        </div>
        <div data-screen="settings">
          <Settings live={extremeStatus() as unknown as StatusResponse} />
        </div>
        {/*
          * Not screens, which is exactly how they were missed: E15 says "every screen, every form", and
          * these two are neither — they appear inside a screen only after a review or an apply, which on
          * this bench never happens. They are also the surface with the least forgiving content on it,
          * read by somebody with a countdown running.
          *
          * Mounted with every panel at once. Some of these states do not co-occur on a device — an error
          * and a finished apply, say — and that is deliberate here: this page measures boxes, and a
          * combination is strictly more content than any single one of them. Nothing on it is a claim
          * about what a device does.
          */}
        <div data-screen="plan-review">
          <PlanReview
            plan={extremePlan() as never}
            outcome={extremeApply() as never}
            error={{
              code: 'apply_failed',
              message:
                'The apply stopped after the tunnel unit refused to stay running, and the device is putting ' +
                'the network changes back.',
              hint: 'Fix the tunnel configuration and review again; nothing needs to be undone by hand.',
              refused: extremeApply()['refused'] as never,
            }}
            pendingChanges={3}
            onApply={() => undefined}
          />
        </div>
        {/*
          * The two places the panel says the profile being edited is not the one running.
          *
          * Neither is a screen, which is how the plan review and the confirmation window below were
          * missed for as long as they were: "every screen, every form" does not reach something that
          * renders only in a state this bench never enters. This one is a *selection*, held in a
          * module-level store, so it cannot be set for one block and not another on a page that
          * mounts every screen at once — which is why the notice is one component used by both places
          * and measured here directly, rather than measured in situ on a screen.
          *
          * The name is the longest one the field accepts **with every break opportunity taken out of
          * it**, rather than the fixture's own longest name, which has spaces in it. A profile name is
          * typed by a person who writes `amsterdam-evening-failover-with-cloak`, and a layout engine
          * cannot break a run with no space and no hyphen anywhere — which is the case that decides
          * whether these two lines fit, and the case a name with spaces never produces.
          */}
        <div data-screen="editing-elsewhere">
          <EditingElsewhere name={UNBREAKABLE_NAME} mode="shell" />
          <EditingElsewhere name={UNBREAKABLE_NAME} mode="bar" />
        </div>
        {/*
          * The switch-off control in every state it has, and the page left after it.
          *
          * Settings above draws only one of them — the fixture has a window open, so it is the blocked
          * state — and the others appear only after a tap, which this bench never makes. The same trap
          * as the plan review: a state that renders only after an act is a state nothing measured. The
          * refusal is the device's own sentence, word for word — the longest one the card prints, and it
          * arrives from the daemon rather than from this file.
          */}
        <div data-screen="power-off">
          <PowerOffControl state={{ kind: 'idle' }} failure={null} onArm={() => undefined} onConfirm={() => undefined} onCancel={() => undefined} />
          <PowerOffControl state={{ kind: 'armed' }} failure={EXTREME_POWER_OFF_FAILURE} onArm={() => undefined} onConfirm={() => undefined} onCancel={() => undefined} />
          <PowerOffControl state={{ kind: 'sending' }} failure={null} onArm={() => undefined} onConfirm={() => undefined} onCancel={() => undefined} />
          <PowerOffControl state={{ kind: 'blocked', transaction: 'b6f0c4a29d7e1835' }} failure={null} onArm={() => undefined} onConfirm={() => undefined} onCancel={() => undefined} />
          <PoweredOff />
        </div>
        <div data-screen="confirmation">
          <ConfirmationWindow secondsRemaining={118} contact="ok" onConfirm={() => undefined} />
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
