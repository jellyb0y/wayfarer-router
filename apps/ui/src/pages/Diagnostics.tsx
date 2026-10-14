/**
 * **Diagnostics**: the readings that took a shell on 2026-10-11, on one screen.
 *
 * That evening the internet was gone after a reboot. Finding out why took `ip rule`, `ip route get` to the
 * tunnel server, the proxy core's selectors and the external client's journal, all read over ssh: the
 * device's own-traffic rules were missing, the tunnel clients' connections looped into the tunnel, and
 * every selector stood on `block`. Each of those is here, beside what the device expects it to be, and
 * the client's log can be made talkative for a while without editing a file.
 *
 * Read-only apart from the log level, which lowers itself again. Nothing here repairs anything: the
 * policy-rules watch does that, and its last reading is shown so a person can see it is looking.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiFailure, api, type RoutingDiagnostics } from '../lib/api.ts';
import { t } from '../lib/i18n.ts';
import { Card, Screen } from '../components/ui/index.tsx';

export function Diagnostics(): ReactElement {
  const routing = useQuery({ queryKey: ['diagnostics', 'routing'], queryFn: api.routingDiagnostics, refetchInterval: 15_000 });
  const data = routing.data;
  return (
    <Screen title={t('nav.diagnostics')}>
      <Card title="Policy rules">
        {data === undefined ? (
          <p className="muted">{routing.isError ? 'Could not be read.' : 'Reading…'}</p>
        ) : (
          <>
            <p className={data.rules.summary === 'all policy rules present' ? 'note' : 'note bad'}>{data.rules.summary}</p>
            <ul className="row-list">
              {data.rules.bypass.map((rule) => (
                <li key={rule.priority}>
                  {rule.priority} · <code>{rule.selector}</code> ·{' '}
                  <span className={rule.present === true ? 'ok' : 'bad'}>
                    {rule.present === null ? 'not read' : rule.present ? 'present' : 'missing'}
                  </span>
                </li>
              ))}
              <li>
                core capture ·{' '}
                {data.rules.coreActive ? (
                  <span className={data.rules.coreCaptureMissing === true ? 'bad' : 'ok'}>{data.rules.coreCaptureMissing === true ? 'missing' : 'present'}</span>
                ) : (
                  <span className="muted">the core is not running</span>
                )}
              </li>
            </ul>
            {data.watch?.lastLooked ? <p className="muted">Watch: {data.watch.lastLooked.what}</p> : null}
          </>
        )}
      </Card>

      <Card title="Route to each tunnel server">
        {data === undefined ? null : data.servers.length === 0 ? (
          <p className="muted">The active profile has no tunnel with an address.</p>
        ) : (
          <ul className="row-list">
            {data.servers.map((entry) => (
              <li key={entry.id}>
                {entry.id} · {entry.server} ·{' '}
                {entry.route === null ? (
                  <span className="muted">{entry.note ?? 'not answered'}</span>
                ) : (
                  <span className={entry.throughTunnel === true ? 'bad' : 'ok'}>
                    via {entry.route.device ?? '?'}
                    {entry.throughTunnel === true ? ' — through a tunnel: the client’s own connection loops back into it' : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Selectors">
        {data === undefined ? null : data.selectors === null ? (
          <p className="muted">The proxy core is not running or does not answer.</p>
        ) : (
          <ul className="row-list">
            {data.selectors.map((selector) => (
              <li key={selector.name}>
                {selector.name} → <span className={selector.now === 'block' ? 'bad' : 'ok'}>{selector.now ?? '?'}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CarrierLog ids={data?.servers.map((entry) => entry.id) ?? []} />
    </Screen>
  );
}

/**
 * One tunnel client's journal, and a switch that makes every client talkative for ten minutes. The level
 * goes back by itself; raising it restarts the clients, which drops their connections for a moment, and
 * the button says so.
 */
function CarrierLog({ ids }: { ids: string[] }): ReactElement {
  const [chosen, setChosen] = useState<string | null>(null);
  const id = chosen ?? ids[0] ?? null;
  const unit = id === null ? null : `wf-socks@${id}.service`;
  const journal = useQuery({
    queryKey: ['diagnostics', 'journal', unit],
    queryFn: () => api.logs(`?unit=${encodeURIComponent(unit!)}&limit=60`),
    enabled: unit !== null,
    refetchInterval: 10_000,
  });
  const [said, setSaid] = useState<string | null>(null);
  const raise = useMutation({
    mutationFn: () => api.raiseCarrierLogLevel(10),
    retry: false,
    onSuccess: (answer) => setSaid(`Tunnel clients log at ${answer.level} until ${answer.revertsAt ?? 'the next apply'}.`),
    onError: (error: unknown) => setSaid(error instanceof ApiFailure ? error.error.message : String(error)),
  });
  return (
    <Card title="Tunnel client log">
      {ids.length === 0 ? <p className="muted">No tunnel client to read.</p> : null}
      {ids.length > 1 ? (
        <label>
          <span className="field-label">Client</span>
          <select value={id ?? ''} onChange={(event) => setChosen(event.target.value)}>
            {ids.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {journal.data === undefined ? null : journal.data.entries.length === 0 ? (
        <p className="muted">Nothing logged. A tunnel the proxy core carries itself has no client of its own.</p>
      ) : (
        <pre className="log">{journal.data.entries.map((entry) => entry.message).join('\n')}</pre>
      )}
      <div className="row-actions">
        <button
          type="button"
          title="Restarts the tunnel clients with a talkative log for ten minutes; their connections drop for a moment."
          disabled={raise.isPending}
          onClick={() => raise.mutate()}
        >
          {raise.isPending ? 'Restarting clients…' : 'Detailed client log for 10 min'}
        </button>
      </div>
      {said === null ? null : <p className="note" role="status">{said}</p>}
    </Card>
  );
}
