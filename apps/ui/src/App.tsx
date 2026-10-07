/**
 * Shell: the authentication gate, navigation, and one event-stream subscription that invalidates
 * queries rather than each screen polling on its own.
 *
 * **There is no second gate.** Signing in is the only thing that stands between a browser and this
 * interface. The device ships with a documented default password and changing it is optional, so
 * `setupComplete` — which says only that the default is still in place — must never be turned back
 * into a shutter here. A gate that outlived its removal on the server would be invisible from both
 * sides: the API would accept every route while the panel refused to draw them.
 */
import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, subscribeToEvents, type StatusResponse } from './lib/api.ts';
import { t } from './lib/i18n.ts';
import { useProfileTarget } from './lib/target.ts';
import { EditingElsewhere } from './components/EditingElsewhere.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { Status } from './pages/Status.tsx';
import { Clients } from './pages/Clients.tsx';
import { Network } from './pages/Network.tsx';
import { Routing } from './pages/Routing.tsx';
import { Tunnels } from './pages/Tunnels.tsx';
import { Events } from './pages/Events.tsx';
import { Settings } from './pages/Settings.tsx';
import { PoweredOff, usePowerOff } from './components/PowerOff.tsx';

type Gate = 'loading' | 'signed-out' | 'ready';

export function App(): ReactElement {
  const queryClient = useQueryClient();
  const [gate, setGate] = useState<Gate>('loading');
  const [live, setLive] = useState<StatusResponse | null>(null);
  /*
   * Set once the device has accepted a switch-off. From then on every request fails, so the page asks
   * nothing: the stream is closed, what is in flight is cancelled, and the screens that would each draw
   * their own failure are replaced by one that says what is happening.
   */
  const off = usePowerOff((state) => state.off);

  const probe = useCallback(async () => {
    // One authenticated call decides everything: it answers, or it does not. Nothing about the
    // password's age or its default-ness is consulted, because nothing about it gates anything.
    try {
      await api.system();
      setGate('ready');
    } catch {
      setGate('signed-out');
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  useEffect(() => {
    if (!off) return;
    void queryClient.cancelQueries();
  }, [off, queryClient]);

  useEffect(() => {
    if (gate !== 'ready' || off) return undefined;
    // One stream for the whole application. A `status` event carries the snapshot, so screens read
    // live state from here and use queries only for the things that do not change on their own.
    return subscribeToEvents((event, data) => {
      if (event === 'status') setLive(data as StatusResponse);
      if (event === 'unit' || event === 'station') {
        void queryClient.invalidateQueries({ queryKey: ['status'] });
      }
    });
  }, [gate, off, queryClient]);

  if (off) return <PoweredOff />;
  if (gate === 'loading') return <p className="muted" style={{ padding: 24 }}>{t('common.loading')}</p>;
  if (gate === 'signed-out') return <SignIn onSignedIn={() => void probe()} />;

  return <Shell live={live} />;
}

/**
 * Exported for the test that asserts the editing banner, in both of its states.
 *
 * `App` itself cannot be mounted for that: it gates on an authenticated call and then subscribes to
 * the event stream, so a test of the banner would be a test of the sign-in probe with the banner
 * somewhere behind it.
 */
export function Shell({ live }: { live: StatusResponse | null }): ReactElement {
  const system = useQuery({ queryKey: ['system'], queryFn: api.system });
  const target = useProfileTarget();

  return (
    <div className="layout">
      <header className="top">
        <span className="brand">{t('app.title')}</span>
        <nav className="tabs">
          {/*
            * Seven entries, which is the whole set: the bar went from eight to six when Profiles,
            * Devices and Password each got a place on Settings, and Tunnels is the seventh, arriving
            * with the editor rather than before it.
            *
            * The rule those three removals followed is the one this addition completes: an entry is
            * removed only in the change that gives its capability another way in, and added only when
            * there is something behind it. A destination that answers with an empty screen and a
            * capability with no destination at all are the same defect from opposite sides.
            */}
          <NavLink to="/status" className={({ isActive }) => (isActive ? 'active' : '')}>{t('nav.status')}</NavLink>
          <NavLink to="/tunnels" className={({ isActive }) => (isActive ? 'active' : '')}>{t('nav.tunnels')}</NavLink>
          <NavLink to="/routing" className={({ isActive }) => (isActive ? 'active' : '')}>{t('nav.routing')}</NavLink>
          <NavLink to="/network" className={({ isActive }) => (isActive ? 'active' : '')}>{t('nav.network')}</NavLink>
          <NavLink to="/clients" className={({ isActive }) => (isActive ? 'active' : '')}>{t('nav.clients')}</NavLink>
          <NavLink to="/events" className={({ isActive }) => (isActive ? 'active' : '')}>{t('nav.events')}</NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>{t('nav.settings')}</NavLink>
        </nav>
        <span className="spacer" />
        <span className="state">
          {system.data ? `${system.data.deviceName} · ${system.data.version} · ${system.data.runtime}` : ''}
        </span>
        <button
          onClick={() => {
            void api.logout().then(() => window.location.reload());
          }}
        >
          Sign out
        </button>
      </header>

      {/*
        * Which profile the editing screens are pointed at, said in the shell and on every screen.
        *
        * It is here rather than on each screen because the hazard is exactly that a person does not
        * remember: the choice is made on Settings and then survives every navigation, so a banner
        * that lived on the screen where the choice was made would be absent on the four screens where
        * the editing happens. **Silently editing a document that is not running is how somebody
        * changes the wrong thing and finds out later**, and a bar that is only on one screen is the
        * silent case wearing a warning.
        *
        * Drawn only when it is *not* the active profile, so the common visit carries no extra line —
        * a banner that is always there is a banner nobody reads on the day it changes.
        */}
      {target.isActive ? null : <EditingElsewhere name={target.name ?? ''} mode="shell" />}

      <Routes>
        <Route path="/status" element={<Status live={live} />} />
        <Route path="/tunnels" element={<Tunnels />} />
        <Route path="/clients" element={<Clients live={live} />} />
        <Route path="/routing" element={<Routing />} />
        <Route path="/network" element={<Network live={live} />} />
        <Route path="/events" element={<Events />} />
        <Route path="/settings" element={<Settings live={live} />} />
        <Route path="*" element={<Navigate to="/status" replace />} />
      </Routes>
    </div>
  );
}
