/**
 * Switching the device off, and the page that is left when it has been.
 *
 * ## Why two taps, and why the second one can be refused
 *
 * It is the same shape as deleting a profile, and for the same reason: a double tap is an ordinary
 * movement on a phone, so the confirming state refuses anything inside `ARMING_MS`. The difference is
 * what is lost. A deleted profile is gone from a device that is still answering; a device switched off
 * answers nobody — not this page, not the access point, not a tunnel — until somebody is standing next to
 * it. So the consequence is inside **both** buttons, and the clause that matters most is the last one:
 * it does not come back on its own.
 *
 * ## Why the button knows about the confirmation window
 *
 * The device refuses while a transaction is awaiting confirmation, because the start-up sweep would
 * revert it at the next boot, hours later. A button that let a person press it and then read that
 * refusal is a button that says "go and find the other screen" after the fact, so the button says it
 * first, naming the change. The device's refusal is still the authority: a window that opened after the
 * list was read is refused there and the refusal is shown here.
 *
 * ## Why the page goes quiet afterwards
 *
 * Once the device has accepted, every request this page could make is going to fail, and a page that
 * drew each failure would greet the person who just did the right thing with a wall of red. So the
 * acceptance is held in a store the shell reads: it closes the event stream, cancels what is in flight
 * and replaces every screen with one that says what is happening and that nothing more is being asked.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { ApiFailure, api } from '../lib/api.ts';
import { ARMING_MS } from '../lib/arming.ts';
import { t, tf } from '../lib/i18n.ts';
import { Card } from './ui/index.tsx';

/** Whether the device has accepted a switch-off. Read by the shell, which stops asking it anything. */
export const usePowerOff = create<{ off: boolean; accept: () => void }>((set) => ({
  off: false,
  accept: () => set({ off: true }),
}));

export type PowerOffState =
  | { kind: 'idle' }
  | { kind: 'armed' }
  | { kind: 'sending' }
  | { kind: 'blocked'; transaction: string };

/** The id of a transaction inside its confirmation window, from the device's own list; null otherwise. */
export function openWindow(data: unknown): string | null {
  const list = (data as { transactions?: unknown } | undefined)?.transactions;
  if (!Array.isArray(list)) return null;
  const open = (list as { id?: unknown; state?: unknown }[]).find((row) => row.state === 'awaiting-confirm');
  return typeof open?.id === 'string' ? open.id : null;
}

export function PowerOffCard(): ReactElement {
  const accept = usePowerOff((state) => state.accept);
  const transactions = useQuery({ queryKey: ['transactions'], queryFn: api.transactions });
  const open = openWindow(transactions.data);
  /** When the control was armed. The instant matters as much as the fact: see `ARMING_MS`. */
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const turnOff = useMutation({
    mutationFn: api.powerOff,
    retry: false,
    onSuccess: () => accept(),
    onError: (error: unknown) => {
      setArmedAt(null);
      /*
       * A window that opened after the list was read. The device's sentence is written for a script and
       * runs to eight lines at 360 px; the blocked state says the same thing in two and names the same
       * change, so the list is read again and the button takes over rather than a paragraph appearing.
       */
      if (error instanceof ApiFailure && error.error.code === 'confirmation_pending') {
        setFailure(null);
      } else {
        setFailure(describe(error));
      }
      void transactions.refetch();
    },
  });

  const state: PowerOffState =
    open !== null
      ? { kind: 'blocked', transaction: open }
      : turnOff.isPending
        ? { kind: 'sending' }
        : armedAt !== null
          ? { kind: 'armed' }
          : { kind: 'idle' };

  return (
    <PowerOffControl
      state={state}
      failure={failure}
      onArm={() => {
        setFailure(null);
        setArmedAt(Date.now());
        // Read again at the moment of deciding: a window may have opened since the screen was drawn.
        void transactions.refetch();
      }}
      onConfirm={() => {
        // The other half of a double tap is refused; the device never hears about it.
        if (armedAt === null || Date.now() - armedAt < ARMING_MS) return;
        turnOff.mutate();
      }}
      onCancel={() => setArmedAt(null)}
    />
  );
}

/**
 * The card in each of its states, with no data of its own — so the 360 px bench can draw every state
 * at once, which a card that only ever shows one of them could not be measured in.
 */
export function PowerOffControl({
  state,
  failure,
  onArm,
  onConfirm,
  onCancel,
}: {
  state: PowerOffState;
  failure: string | null;
  onArm(): void;
  onConfirm(): void;
  onCancel(): void;
}): ReactElement {
  return (
    <Card title={t('power.title')}>
      {failure ? <p className="note bad">{failure}</p> : null}
      {state.kind === 'blocked' ? (
        <button type="button" className="consequential" disabled>
          <span className="consequential-title">{t('power.blocked')}</span>
          <span className="consequential-text">{tf('power.blockedWhy', state.transaction)}</span>
        </button>
      ) : state.kind === 'idle' ? (
        <button type="button" className="consequential danger" onClick={onArm}>
          <span className="consequential-title">{t('power.turnOff')}</span>
          <span className="consequential-text">{t('power.consequence')}</span>
        </button>
      ) : (
        <div className="consequential-pair">
          <button
            type="button"
            className="consequential danger"
            onClick={onConfirm}
            disabled={state.kind === 'sending'}
          >
            <span className="consequential-title">
              {state.kind === 'sending' ? t('power.sending') : t('power.confirm')}
            </span>
            <span className="consequential-text">{t('power.confirmConsequence')}</span>
          </button>
          <button type="button" onClick={onCancel} disabled={state.kind === 'sending'}>
            {t('power.cancel')}
          </button>
        </div>
      )}
    </Card>
  );
}

/** What is left of the panel once the device has accepted. Asks the device for nothing. */
export function PoweredOff(): ReactElement {
  return (
    <main className="screen">
      <div className="panel warn" role="status">
        <h3>{t('power.off')}</h3>
        <p>{t('power.offIs')}</p>
        <p className="muted">{t('power.offDone')}</p>
      </div>
    </main>
  );
}

/**
 * The device's message, without its hint: every hint this route writes is addressed to a script — the
 * body to send, the route to confirm by — and this page already sends the one and shows the other.
 */
function describe(error: unknown): string {
  if (error instanceof ApiFailure) return error.error.message;
  return error instanceof Error ? error.message : String(error);
}
