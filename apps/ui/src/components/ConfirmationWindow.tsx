/**
 * The confirmation window: a countdown on a page that may be about to stop working.
 *
 * This is the only screen in the interface whose job is to be correct **while the connection carrying
 * it is being changed**, which is the ordinary case rather than an exotic one — the change being
 * confirmed is a `network` change, and the person confirming it is very often reaching the device over
 * the thing it is about to reconfigure.
 *
 * Five properties follow from that, and each of them is a safety property rather than a nicety.
 *
 * ## 1. Doing nothing is safe, and the page says so before anything is applied
 *
 * What a person does when a page stops responding is nothing — or worse, they reload. So "no action"
 * must be the outcome that recovers the device, and they must have been told that **before** the
 * connection went, because afterwards there is no way to tell them. `NoActionNotice` is rendered on the
 * review screen, ahead of the apply button, not here.
 *
 * ## 2. The countdown is derived from a deadline, never decremented — but the deadline is *ours*
 *
 * A counter that ticks down locally is wrong in exactly the situation this exists for: the tab is
 * backgrounded, the laptop sleeps, the request hangs — and the number carries on as if time had not
 * passed. Every render therefore computes the remaining time from a deadline rather than from a
 * decremented counter, so a page that was frozen for a minute tells the truth the moment it is looked
 * at again.
 *
 * The deadline it computes from is built **here, from a duration the device sent**, and is not the
 * device's own absolute timestamp. An earlier version took the device's `deadlineAt` and subtracted
 * `Date.now()` — two different clocks. This device has no clock battery, so its wall time can be days
 * out after a power cycle, and subtracting a browser's `now` from a device's ISO timestamp produced a
 * countdown that was wrong by however far apart the two clocks were: hours of "0s left, undoing the
 * change" on a device that had not started undoing anything, or a window that appeared to have ages
 * left when it was about to fire. The device now hands over *how long is left*, which is the same
 * quantity in both frames, and the browser anchors it against its own clock once, on arrival.
 *
 * ## 3. Losing contact is reported as expected, not as an error
 *
 * When the page can no longer reach the device this says so, says that it is what a `network` change
 * going wrong looks like, and repeats that doing nothing undoes it. A countdown that simply freezes
 * teaches the reader to reload, and reloading is the one action that cannot help.
 *
 * ## 4. The countdown is the whole promise
 *
 * The device used to undo an unconfirmed change 45 s into a window it reported as 150 s, whenever its
 * health check misread the uplink — so the number on this screen was not the one that governed. The
 * check now records what it finds and never ends the window (`windowVerdict` in the daemon, asserted
 * by `test/window-deadline.test.ts` there), and this page says so, because a person deciding how fast
 * to act needs to know the number is real.
 *
 * ## 5. It never claims the change was kept
 *
 * Only a reply from the device can say that. Until one arrives the page says "not yet confirmed".
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';

export interface ConfirmationWindowProps {
  /**
   * How many seconds the device says are left, as of the reply that carried it.
   *
   * A duration rather than an instant, on purpose: a duration means the same thing in the device's
   * clock and in the browser's, and these two clocks routinely disagree by hours on hardware with no
   * battery-backed clock.
   */
  secondsRemaining: number;
  /** True once the device has answered a confirm request. */
  confirmed?: boolean;
  /**
   * Whether the page is still in contact with the device.
   *
   * `unknown` on the first render, before any poll has succeeded or failed — which must not be drawn as
   * "lost", or the page cries wolf every time it opens.
   */
  contact: 'ok' | 'lost' | 'unknown';
  onConfirm(): void;
  busy?: boolean;
  /** Injectable so the countdown can be tested without waiting. */
  now?: () => number;
}

/**
 * Seconds left against a deadline **in this browser's own clock**, floored at zero.
 *
 * Negative is arithmetically honest and useless to a reader, and a non-finite anchor reads as expired
 * rather than as a blank: on this screen the safe thing to say is "the device is putting it back".
 */
export function secondsLeft(localDeadlineMs: number, now: number): number {
  if (!Number.isFinite(localDeadlineMs)) return 0;
  return Math.max(0, Math.ceil((localDeadlineMs - now) / 1000));
}

/** The browser-frame instant a duration from the device expires at. */
export function anchorDeadline(secondsRemaining: number, receivedAt: number): number {
  if (!Number.isFinite(secondsRemaining) || secondsRemaining < 0) return receivedAt;
  return receivedAt + secondsRemaining * 1000;
}

export function ConfirmationWindow({
  secondsRemaining,
  confirmed,
  contact,
  onConfirm,
  busy,
  now,
}: ConfirmationWindowProps): ReactElement {
  const clock = now ?? ((): number => Date.now());
  const [, setTick] = useState(0);

  // Anchored once per duration received, in this browser's clock. Re-anchoring when the device sends a
  // fresh figure is a resync and is wanted; nothing here ever decrements.
  const [localDeadline, setLocalDeadline] = useState(() => anchorDeadline(secondsRemaining, clock()));
  useEffect(() => {
    setLocalDeadline(anchorDeadline(secondsRemaining, clock()));
    // `clock` is deliberately not a dependency: re-anchoring belongs to a new figure from the device,
    // not to a re-created closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsRemaining]);

  // Re-render every second so the derived number moves. The state is a tick, not the count: the count
  // is always computed from the anchored deadline.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  /*
   * Brought into view, and given focus, the moment it appears.
   *
   * **This is here because of what a first-time user experienced.** The Apply button lives in the plan-review
   * panel, which renders *below* this one — so on a phone the countdown appeared above where they were
   * looking, off screen. They pressed Apply, saw nothing change, and two and a half minutes later the device
   * undid the change by itself. Twice.
   *
   * A panel that is rendered is not the same as a panel that is seen. `scrollIntoView` plus focus is the
   * difference between an interface that technically told somebody and one that actually did — and this is
   * the one screen in the product where missing it costs the change they were trying to make.
   *
   * Guarded, because `scrollIntoView` does not exist in every environment and a missing browser API must not
   * take down the panel whose whole job is to be visible.
   */
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = panel.current;
    if (node === null) return;
    try {
      node.scrollIntoView({ block: 'center' });
    } catch {
      /* Not available here; the panel is still rendered and still says what it says. */
    }
    try {
      node.focus();
    } catch {
      /* As above. */
    }
  }, []);

  const left = secondsLeft(localDeadline, clock());
  const expired = left === 0;

  if (confirmed === true) {
    return (
      <div className="panel ok" role="status">
        <h3>Kept</h3>
        <p>The change is confirmed and will survive a restart.</p>
      </div>
    );
  }

  return (
    <div className="panel danger" role="alert" aria-live="assertive" tabIndex={-1} ref={panel}>
      <h3>{expired ? 'Undoing the change' : `Not confirmed yet — ${left}s left`}</h3>

      {expired ? (
        <p>
          The window has passed without a confirmation, so the device is putting the previous
          configuration back by itself. Nothing further is needed from you.
        </p>
      ) : (
        <p>
          <strong>If you do nothing, this change is undone</strong> and the device returns to the
          configuration it had before. That is deliberate: it is what protects you if this change has
          just cost you access to this page.
        </p>
      )}

      {expired ? null : (
        <p className="hint">
          Nothing undoes this change before the countdown ends, unless someone asks or the device
          restarts.
        </p>
      )}

      {contact === 'lost' && !expired ? (
        <p className="contact-lost">
          <strong>This page can no longer reach the device.</strong> If the change you are confirming
          altered the connection you are reading this over, that is exactly what it looks like — and it
          is the case the countdown is for. <strong>Do nothing.</strong> The device will undo the change
          on its own in {left} seconds and come back as it was. Reloading this page will not help and
          cannot confirm anything.
        </p>
      ) : null}

      {!expired ? (
        <button type="button" onClick={onConfirm} disabled={busy === true || contact === 'lost'}>
          {busy === true ? 'Confirming…' : 'Keep this change'}
        </button>
      ) : null}

      {contact === 'lost' && !expired ? (
        <p className="hint">
          The button is disabled because a confirmation has to reach the device, and this page cannot
          reach it. A confirmation that appeared to work while going nowhere would be worse than none.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The sentence that has to be read **before** the change is applied.
 *
 * Rendered on the review screen next to the apply button, because after a `network` change goes wrong
 * there is no page left to explain anything on. A person who has read this once will do the right
 * thing — nothing — when the screen stops responding.
 */
export function NoActionNotice({ blastRadius }: { blastRadius: string }): ReactElement | null {
  if (blastRadius !== 'network') return null;
  return (
    <div className="panel warn no-action-notice">
      <h3>If this goes wrong, do nothing</h3>
      <p>
        After you apply this, you will have <strong>two and a half minutes</strong> to confirm it. If
        this change costs you access to this page — which is what the warning above means — then{' '}
        <strong>do not reload and do not try to reconnect</strong>. Wait. The device undoes the change by
        itself and comes back as it was, within three minutes of applying.
      </p>
      <p>
        Confirming is only needed to <em>keep</em> the change. Doing nothing is always the safe choice.
      </p>
    </div>
  );
}
