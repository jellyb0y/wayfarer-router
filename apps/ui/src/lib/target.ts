/**
 * Which profile the four editing screens are editing.
 *
 * ## The capability this restores, and why its loss counted as a defect
 *
 * The screen that was deleted in E6a edited whichever profile its route named. The four screens that
 * replaced it — Tunnels, Routing, Network, Settings — were each written against the **active** one,
 * because that is what each of them was answering questions about. So the epic that exists to remove
 * "configurable in one place only" introduced the reverse of it: the API could edit any stored
 * profile and the interface exactly one.
 *
 * It also made the dangerous path the only path. Profiles exist so an alternative can be prepared
 * before it is used; with one editable profile, preparing one meant activating it first — and
 * activating is the step before applying.
 *
 * ## One selection, not a route parameter
 *
 * The choice is held here rather than in the URL because it is not a property of a screen: a person
 * preparing an alternative moves between Tunnels, Routing and Network while preparing it, and a
 * per-screen route would silently put them back on the active profile every time they changed screen —
 * which is the accident this whole task exists to prevent, wearing a different hat.
 *
 * ## Absent means the active one, and a stale choice resolves to it
 *
 * `chosen` is `null` when nothing has been picked, and a chosen id that is no longer in the list —
 * deleted elsewhere, or on another device — resolves back to the active profile rather than to
 * nothing. The alternative is a set of screens editing a profile that does not exist, which renders
 * as a screen that is still loading and never stops.
 */
import { create } from 'zustand';
import { useQuery } from '@tanstack/react-query';
import { profileApi } from './api.ts';

interface TargetState {
  /** The profile picked in Settings, or `null` for "whichever is active". */
  chosen: string | null;
  choose(id: string | null): void;
}

export const useChosenProfile = create<TargetState>((set) => ({
  chosen: null,
  choose(id) {
    set({ chosen: id });
  },
}));

export interface ProfileTarget {
  /** The profile every editing screen loads. `undefined` while the list has not answered. */
  id: string | undefined;
  activeId: string | undefined;
  /**
   * Whether the profile being edited is the one the device is running.
   *
   * **`true` while the list is still loading**, deliberately. Every consequence hanging off this flag
   * is a warning or a restriction, and announcing "you are editing something that is not running"
   * against a list that has not arrived is a false alarm on the most common visit of all. The screens
   * draw nothing until the document loads anyway.
   */
  isActive: boolean;
  /** The chosen profile's name, for the sentence the shell prints. `undefined` when it is active. */
  name: string | undefined;
}

export function useProfileTarget(): ProfileTarget {
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: profileApi.list });
  const chosen = useChosenProfile((state) => state.chosen);

  const activeId = profiles.data?.activeProfileId ?? undefined;
  const listed = profiles.data?.profiles ?? [];
  // A chosen id that is not in the list is not a selection any more. Resolved here rather than at
  // each use, so no screen can be left holding an id nothing will ever return a document for.
  const found = chosen === null ? undefined : listed.find((profile) => profile.id === chosen);
  const id = found?.id ?? activeId;

  return {
    id,
    activeId,
    isActive: id === undefined || activeId === undefined || id === activeId,
    name: found && found.id !== activeId ? found.name : undefined,
  };
}
