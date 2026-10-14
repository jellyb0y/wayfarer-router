/**
 * "Test": does this configuration connect, asked of the device before anything is saved or applied.
 *
 * The device stands up a throwaway client for the configuration as it is in the form, makes one request
 * through it and answers with the delay or with the client's own last lines (`POST /api/tunnels/test`).
 * Built for the failure that had no other answer on 2026-10-11: a tunnel parsed from a link that could
 * never connect, found only by applying it and reading a log over a shell.
 *
 * Secrets the form holds as "set" are sent as that marker, and the device reads the stored value itself,
 * so a stored credential is tested without coming back through the page.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiFailure, api, type TunnelTestResult } from '../../lib/api.ts';

type Subject = { tunnelId: string; protocol: string; config: unknown } | { groupId: string; memberId: string };

export function TunnelTest({ subject }: { subject: Subject }): ReactElement {
  const [outcome, setOutcome] = useState<TunnelTestResult | { error: string } | null>(null);
  const run = useMutation({
    mutationFn: () => api.testTunnel(subject),
    retry: false,
    onSuccess: (result) => setOutcome(result),
    onError: (error: unknown) =>
      setOutcome({ error: error instanceof ApiFailure ? error.error.message : error instanceof Error ? error.message : String(error) }),
  });
  return (
    <div className="tunnel-test">
      <button
        type="button"
        title="Tries this configuration through a temporary client. Nothing is saved or applied."
        disabled={run.isPending}
        onClick={() => {
          setOutcome(null);
          run.mutate();
        }}
      >
        {run.isPending ? 'Testing…' : 'Test'}
      </button>
      {outcome === null ? null : 'error' in outcome ? (
        <p className="note bad" role="status">{outcome.error}</p>
      ) : outcome.ok ? (
        <p className="note" role="status">
          Connects: {outcome.endpoint} answered in {outcome.latencyMs} ms
          {outcome.carrier === undefined ? '' : ` (${outcome.carrier.kind === 'external' ? 'external client' : 'proxy core'})`}.
        </p>
      ) : (
        <div role="status">
          <p className="note bad">{outcome.failure?.message ?? 'It did not connect.'}</p>
          {outcome.log.length === 0 ? null : <pre className="log">{outcome.log.join('\n')}</pre>}
        </div>
      )}
    </div>
  );
}
