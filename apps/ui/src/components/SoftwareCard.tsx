/**
 * **Software**: which version runs, and replacing it without a shell.
 *
 * The file is a bundle built and signed on the owner's machine (`scripts/bundle.ts`). The device checks the
 * signature against the key installed on it, keeps the version that runs now, installs the new one and
 * asks it whether it answers; if it does not within half a minute, the kept version goes back. This card
 * only uploads and then watches: it waits for the device to answer again and reads which version runs,
 * because a reply sent just before the daemon restarted says nothing about how the restart went.
 */
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiFailure, api } from '../lib/api.ts';
import { Card } from './ui/index.tsx';

type Phase = { kind: 'idle' } | { kind: 'uploading' } | { kind: 'waiting'; expected: string; since: number } | { kind: 'done'; text: string; ok: boolean };

export function SoftwareCard(): ReactElement {
  const queries = useQueryClient();
  const system = useQuery({ queryKey: ['system'], queryFn: api.system });
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const upload = useMutation({
    mutationFn: (bundle: File) => api.uploadUpdate(bundle),
    retry: false,
    onMutate: () => setPhase({ kind: 'uploading' }),
    onSuccess: (answer) => setPhase({ kind: 'waiting', expected: answer.version, since: Date.now() }),
    onError: (error: unknown) =>
      setPhase({ kind: 'done', ok: false, text: error instanceof ApiFailure ? error.error.message : error instanceof Error ? error.message : String(error) }),
  });
  const rollback = useMutation({
    mutationFn: api.rollbackUpdate,
    retry: false,
    onSuccess: () => setPhase({ kind: 'waiting', expected: '', since: Date.now() }),
    onError: (error: unknown) => setPhase({ kind: 'done', ok: false, text: error instanceof ApiFailure ? error.error.message : String(error) }),
  });

  // While the device restarts: ask until it answers, then read what runs and how the update ended.
  useEffect(() => {
    if (phase.kind !== 'waiting') return undefined;
    const timer = setInterval(() => {
      void api
        .system()
        .then((answer) => {
          const last = answer.update?.last ?? null;
          const finished = last !== null && last.phase !== 'staged' && last.phase !== 'installing' && Date.parse(last.at) >= phase.since - 60_000;
          if (!finished) return;
          void queries.invalidateQueries({ queryKey: ['system'] });
          const ok = last.phase === 'installed';
          setPhase({
            kind: 'done',
            ok,
            text: ok
              ? `${answer.version} is running.`
              : `${last.to ?? 'The new version'} did not answer, so ${answer.version} is running again.${last.detail === undefined ? '' : ` ${last.detail}.`}`,
          });
        })
        .catch(() => undefined);
    }, 3000);
    // Five minutes is far past the thirty seconds the installer waits; after that the page says so.
    const give = setTimeout(() => setPhase({ kind: 'done', ok: false, text: 'The device has not answered for five minutes. Do not unplug it; read Events once it does.' }), 300_000);
    return () => {
      clearInterval(timer);
      clearTimeout(give);
    };
  }, [phase, queries]);

  const info = system.data;
  const update = info?.update;
  return (
    <Card title="Software">
      <p>
        {info === undefined ? 'Reading…' : `${info.version}${info.buildAt === null ? '' : `, built ${info.buildAt}`}`}
      </p>
      {update === undefined ? null : update.keyInstalled ? (
        <>
          <label>
            <span className="field-label">Bundle file</span>
            <input type="file" accept=".bundle" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <p className="muted field-help">
            Signed with your key. The device keeps the version running now and goes back to it by itself if the new one does not start.
          </p>
          <div className="row-actions">
            <button type="button" disabled={file === null || phase.kind === 'uploading' || phase.kind === 'waiting'} onClick={() => file !== null && upload.mutate(file)}>
              {phase.kind === 'uploading' ? 'Uploading…' : phase.kind === 'waiting' ? 'Installing…' : 'Install'}
            </button>
            {update.rollbackAvailable ? (
              <button type="button" disabled={phase.kind === 'uploading' || phase.kind === 'waiting'} onClick={() => rollback.mutate()}>
                Go back to the previous version
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="muted">This device has no update signing key, so it accepts no update from here. It is installed once, with the installer.</p>
      )}
      {phase.kind === 'waiting' ? <p className="muted" role="status">The device is restarting with the new version; this page reconnects by itself.</p> : null}
      {phase.kind === 'done' ? (
        <p className={phase.ok ? 'note' : 'note bad'} role="status">
          {phase.text}
        </p>
      ) : null}
      {update?.last != null && phase.kind === 'idle' ? (
        <p className="muted">
          Last update: {update.last.phase}, {update.last.from ?? '?'} → {update.last.to ?? '?'} ({update.last.at})
        </p>
      ) : null}
    </Card>
  );
}
