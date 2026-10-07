/**
 * Editing a profile: the draft, the plan, the apply and the confirmation, as one mechanism.
 *
 * **This is a hook rather than code inside a screen because there is now more than one screen that
 * edits the profile.** Routing edits rules, Settings edits the device, the tunnel editor edits
 * tunnels — and each of them needs saving, a plan, an apply and a confirmation window. Written
 * again per screen, the second copy would differ from the first in some detail nobody chose, and
 * "duplicate controls for the same field in different places" is one of the four things this epic
 * deletes. A second *mechanism* for the same act is the same defect one floor up.
 *
 * Everything here was lifted from the first screen that had it, comments included, because the
 * comments are the expensive part. Four of them record a defect that reached a person.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, profileApi, type ApplyResponse, type PlanResponse } from './api.ts';
import { pendingChanges, toWriteBody, useDraft } from './draft.ts';

export interface EditingFailure {
  code: string;
  message: string;
  hint?: string;
  refused?: ApplyResponse['refused'];
}

/** Turns anything thrown by the client into the shape the plan review renders. */
export function toFailure(error: unknown): EditingFailure {
  const withError = error as { error?: EditingFailure } | undefined;
  if (withError?.error) return withError.error;
  return { code: 'unknown', message: String(error) };
}

export function useProfileEditing(id: string | undefined) {
  const queryClient = useQueryClient();
  const draft = useDraft();
  const [review, setReview] = useState<PlanResponse | null>(null);
  const [outcome, setOutcome] = useState<ApplyResponse | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  /**
   * Whether this page can still reach the device.
   *
   * `unknown` until something has succeeded or failed, so the page does not announce a lost
   * connection on the strength of having just opened. Set from the health poll below rather than
   * from the apply request, because the apply is the thing that may have broken the path and its own
   * reply arrived before it did.
   */
  const [contact, setContact] = useState<'ok' | 'lost' | 'unknown'>('unknown');
  const [failure, setFailure] = useState<EditingFailure | null>(null);

  const profile = useQuery({
    queryKey: ['profile', id],
    queryFn: () => profileApi.get(id!),
    enabled: id !== undefined,
  });

  useEffect(() => {
    if (id !== undefined && profile.data) draft.load(id, profile.data.document);
    // Loading is keyed on the document the device returned, so a refetch replaces the baseline and
    // any unsaved edit is lost — deliberately: silently merging a remote change into a local draft is
    // how somebody applies a configuration they never read.
  }, [id, profile.data]);

  const changes = useMemo(() => pendingChanges(draft.baseline, draft.draft), [draft.baseline, draft.draft]);

  const save = useMutation({
    mutationFn: () => profileApi.save(id!, toWriteBody(draft.draft!)),
    onSuccess: () => {
      setFailure(null);
      void queryClient.invalidateQueries({ queryKey: ['profile', id] });
      void queryClient.invalidateQueries({ queryKey: ['profiles'] });
      void queryClient.invalidateQueries({ queryKey: ['drift', id] });
    },
    onError: (error) => setFailure(toFailure(error)),
  });

  const dryRun = useMutation({
    mutationFn: () => profileApi.dryRun(),
    onSuccess: (result) => {
      setFailure(null);
      setOutcome(null);
      setReview(result);
      void queryClient.invalidateQueries({ queryKey: ['drift', id] });
    },
    onError: (error) => setFailure(toFailure(error)),
  });

  /**
   * Whether the device is actually running this profile.
   *
   * **This exists because of what a first-time user did.** They edited a setting, pressed Save, and
   * the pending-changes bar said "No pending changes" — which was true about their *draft* and said
   * nothing about the device. Saving stores a document; applying is a separate act. Their change was
   * applied on a second attempt, opened a confirmation window they did not know to answer, and the
   * device undid itself at the deadline — after which the bar said "No pending changes" again, while
   * the device was running a configuration the screen was not showing.
   *
   * So the bar reports two different things, because they *are* different: unsaved edits, and a
   * saved profile the device has not adopted. The plan is the only honest source for the second — it
   * is the comparison between this profile and the running state — and it is the same call Review
   * makes.
   *
   * Not on a timer. Each plan collects an inventory and reads reality, so it runs when something
   * could have changed it: on opening the page, and after a save, an apply or a confirmation.
   */
  const drift = useQuery({
    queryKey: ['drift', id],
    queryFn: () => profileApi.dryRun(),
    refetchOnWindowFocus: false,
    retry: false,
    enabled: id !== undefined,
  });

  /**
   * A confirmation, and only ever from a click.
   *
   * Never retried automatically: a retry that succeeded after the operator had walked away would
   * keep a change nobody agreed to, which is the one thing the window exists to prevent.
   */
  const confirm = useMutation({
    mutationFn: (transactionId: string) => profileApi.confirmTransaction(transactionId),
    onSuccess: () => {
      setConfirmed(true);
      setContact('ok');
      void queryClient.invalidateQueries({ queryKey: ['profile', id] });
      void queryClient.invalidateQueries({ queryKey: ['drift', id] });
    },
    onError: () => setContact('lost'),
  });

  /*
   * A liveness poll that runs only while a window is open.
   *
   * Its purpose is not to confirm anything — it is to notice that this page can no longer reach the
   * device, so the countdown can say so instead of silently freezing. Cheap, frequent, and pointed
   * at the one route that needs no authentication and touches nothing.
   */
  const windowOpen = outcome?.transaction.state === 'awaiting-confirm' && !confirmed;
  useEffect(() => {
    if (!windowOpen) return;
    let cancelled = false;
    const probe = async (): Promise<void> => {
      try {
        await api.health();
        if (!cancelled) setContact('ok');
      } catch {
        if (!cancelled) setContact('lost');
      }
    };
    void probe();
    const timer = setInterval(() => void probe(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [windowOpen]);

  const apply = useMutation({
    mutationFn: (classes?: ('hot' | 'service')[]) => profileApi.apply(classes),
    onSuccess: (result) => {
      setFailure(null);
      setOutcome(result);
      setConfirmed(false);
      // Deliberately not 'ok': the apply's reply left the device before the change took effect, so
      // it says nothing about whether this page can still reach it. The poll decides.
      setContact('unknown');
      void queryClient.invalidateQueries({ queryKey: ['profile', id] });
      void queryClient.invalidateQueries({ queryKey: ['drift', id] });
    },
    onError: (error) => {
      setOutcome(null);
      setFailure(toFailure(error));
    },
  });

  return {
    profile,
    draft,
    changes,
    save,
    dryRun,
    apply,
    confirm,
    review,
    setReview,
    outcome,
    confirmed,
    contact,
    failure,
    /** A saved profile the device has not adopted — the second of the two things the bar reports. */
    notApplied: drift.data?.empty === false,
  };
}
