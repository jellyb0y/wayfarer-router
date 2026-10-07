/**
 * Factory reset: the one operation in this project with no undo.
 *
 * ## The list is derived, not written down
 *
 * A hand-written inventory of what a reset removes is a copy of a truth that lives in the code, and a
 * copy stops matching. In every other place that has bitten us the cost was a test that passed while
 * the system was wrong; here the cost would be **deleting something we do not own**, on a device whose
 * owner cannot undo it. So the plan below is built from `PATHS` and from the units this project
 * generates, which means a new managed path appears in it without anybody remembering to add it.
 *
 * ## What it removes, and what makes that safe
 *
 * Everything it removes is something that can stand *between* an operator and the device: our
 * configuration, our units, our firewall table, our routing files. The paths that keep the board
 * reachable — SSH, and whatever manager configures the wired interface — are not ours and are not
 * touched. So the expected outcome of a reset is "reachable but unconfigured", which is recoverable
 * without hands.
 *
 * ## What it deliberately does not remove
 *
 * * **The installation** (`/opt/wayfarer`, `wayfarer.service`). A factory reset returns the device to
 *   freshly-installed, not to bare. Removing the install would need an installer to put it back, and
 *   the thing asking for the reset is usually the installed software.
 * * **The bench safety net**, its script and its snapshot. They live outside our state directory
 *   precisely so that this operation cannot take away the thing that rescues the board from this
 *   operation. `FORBIDDEN` below asserts it rather than assuming it.
 * * **Anything belonging to another program.** Files moved aside by a takeover are *restored*, not
 *   deleted: they were never ours, and a reset that discarded them would leave the previous manager's
 *   configuration permanently gone.
 */

import { CONFIG_ROOT, OWNED_TABLE, PATHS } from './desired-state.ts';

export type ResetStep =
  | { kind: 'stop-unit'; target: string; why: string }
  | { kind: 'disable-unit'; target: string; why: string }
  | { kind: 'unmask-unit'; target: string; why: string }
  | { kind: 'remove-path'; target: string; why: string }
  | { kind: 'create-path'; target: string; mode: number; why: string }
  | { kind: 'remove-nft-table'; target: string; why: string }
  | { kind: 'restore-aside'; target: string; why: string }
  | { kind: 'restart-daemon'; target: string; why: string };

/**
 * Paths a reset must never touch, with the reason each one is here.
 *
 * Asserted against every step, so a future edit that widened the plan would fail rather than delete
 * somebody else's system. The list is about *ownership*, not about danger: `/etc/netplan` is harmless
 * to write and catastrophic to remove, because removing it is how a board loses the wired address that
 * is the only way back to it.
 */
export const FORBIDDEN: readonly { prefix: string; why: string }[] = [
  { prefix: '/etc/netplan', why: 'the wired address comes from here, and it is the way back to the board' },
  { prefix: '/etc/ssh', why: 'the only remote access to a device with no console' },
  { prefix: '/root/.ssh', why: 'the keys that access is granted with' },
  { prefix: '/home', why: "somebody else's files" },
  { prefix: '/var/lib/wayfarer-deadman', why: 'the safety net that rescues a board from this very operation' },
  { prefix: '/usr/local/sbin', why: 'the safety net script lives here' },
  { prefix: '/etc/systemd/system', why: "the administrator's own directory: overrides and masks live here" },
  { prefix: '/opt', why: 'the installation; a reset returns the device to freshly installed, not to bare' },
  { prefix: '/etc/NetworkManager', why: 'another network manager, which may be what configures the wired link' },
  { prefix: '/boot', why: 'self-evident' },
];

export class ResetWouldTouchForbiddenPath extends Error {
  constructor(target: string, why: string) {
    super(
      `a factory reset would remove ${target}, which it must never touch: ${why}. This is a bug in the ` +
        'plan rather than a configuration problem — the reset is refused whole rather than partially run.',
    );
    this.name = 'ResetWouldTouchForbiddenPath';
  }
}

/**
 * Everything a factory reset does, in order, derived from the managed paths and the generated units.
 *
 * Ordered deliberately: units are stopped and disabled **before** their definitions are removed, or
 * systemd is left with enablement links pointing at files that no longer exist — which reports as a
 * warning at every boot and leaves the units in a state nothing can clean up.
 */
export function factoryResetPlan(input: {
  /** The generated units, from the same builders the planner uses. */
  generatedUnits: readonly string[];
  /** Instances currently present, which the templates alone do not name. */
  liveInstances?: readonly string[];
  /** Files a takeover moved aside, discovered rather than assumed. */
  movedAside?: readonly { from: string; to: string }[];
  /** The daemon's own state directory, from configuration rather than hardcoded. */
  stateDir: string;
}): ResetStep[] {
  const steps: ResetStep[] = [];

  const units = [...new Set([...input.liveInstances ?? [], ...input.generatedUnits])].filter(
    (name) => !name.includes('@.'),
  );

  for (const unit of units) {
    steps.push({ kind: 'stop-unit', target: unit, why: 'it is configuring the network from a profile that is being removed' });
    steps.push({ kind: 'disable-unit', target: unit, why: 'or it starts again at the next boot with no configuration to read' });
    // A unit masked by a rescue would otherwise stay masked after the reset, and the next install would
    // look broken for a reason nobody can see.
    steps.push({ kind: 'unmask-unit', target: unit, why: 'a mask left by a rescue must not outlive the configuration it was rescuing from' });
  }

  steps.push({
    kind: 'remove-nft-table',
    target: `${OWNED_TABLE.family} ${OWNED_TABLE.name}`,
    why: 'our own table only; other tables on this device belong to other software',
  });

  // Every generated artefact, from the paths table rather than from a list kept here.
  for (const [name, value] of Object.entries(PATHS)) {
    if (typeof value !== 'string' || !value.startsWith('/')) continue;
    // The unit directory and the networkd directory are shared with other software: only our own files
    // go, never the directory.
    if (value === PATHS.unitDir || value === PATHS.networkdDir) continue;
    steps.push({ kind: 'remove-path', target: value, why: `generated: PATHS.${name}` });
  }

  for (const unit of input.generatedUnits) {
    steps.push({ kind: 'remove-path', target: `${PATHS.unitDir}/${unit}`, why: 'a unit definition we generated' });
  }

  steps.push({
    kind: 'remove-path',
    target: `${PATHS.networkdDir}/*wayfarer*`,
    why: 'our own .network and .link files; the directory and other software files stay',
  });

  steps.push({ kind: 'remove-path', target: CONFIG_ROOT, why: 'the whole generated configuration tree' });
  steps.push({ kind: 'remove-path', target: input.stateDir, why: 'the database: profiles, transactions, events, sessions' });

  /**
   * Put the empty directories back, with the modes the installer gives them.
   *
   * "As it was immediately after installation" is the claim this command makes, and the installer
   * creates these. Without them the claim is false in a way that bites immediately: the daemon's
   * sandbox grants write access to `/etc/wayfarer`, and `ReadWritePaths` pointing at a directory that
   * does not exist leaves `/etc` read-only to the daemon — so it cannot create it either.
   *
   * Measured on the bench board, 2026-09-21: after a reset, the first apply refused with
   * `/etc/wayfarer — EROFS at /etc`. The device was reachable and could not be configured by anything
   * except a reinstall, which is precisely the "needs hands" outcome a reset must not produce.
   */
  steps.push({ kind: 'create-path', target: CONFIG_ROOT, mode: 0o750, why: 'the installer creates it; the daemon cannot' });
  steps.push({ kind: 'create-path', target: input.stateDir, mode: 0o700, why: 'the database directory, empty' });

  for (const entry of input.movedAside ?? []) {
    steps.push({
      kind: 'restore-aside',
      target: entry.to,
      why: `put ${entry.from} back: it was never ours, and a reset that discarded it would lose another program configuration for good`,
    });
  }

  /**
   * Last, and not optional: the daemon must be restarted before it can use the directories above.
   *
   * `ReadWritePaths` is resolved by systemd **when the unit starts**. The daemon was running while its
   * configuration directory was removed, so its mount namespace still carries the binding from before —
   * and a `ReadWritePaths` entry for a path that did not exist at start time leaves the parent read-only
   * to that process. Recreating the directory does not reach into a namespace that is already set up.
   *
   * Measured on the bench board, 2026-09-21: with the directories correctly recreated, the first apply
   * after a reset still refused with `/etc/wayfarer — EROFS`. The device was reachable, freshly reset,
   * and unable to configure itself by any means short of somebody restarting a service — which is the
   * "needs hands" outcome this whole operation is supposed to avoid.
   *
   * A service restart, deliberately not a reboot: it is the smallest thing that rebuilds the namespace.
   */
  steps.push({
    kind: 'restart-daemon',
    target: MANAGED_UNIT,
    why: 'its sandbox still refers to the directories as they were before the reset',
  });

  return steps;
}

/**
 * The daemon's own unit.
 *
 * Named here rather than passed in because a factory reset that restarted the wrong service would be
 * worse than one that restarted nothing, and this is the one unit this project installs itself.
 */
export const MANAGED_UNIT = 'wayfarer.service';

/**
 * Refuses a plan that would touch anything outside our ownership.
 *
 * Checked over the plan rather than at each deletion site, so that the answer is knowable **before**
 * anything is removed — the same reason the writability check runs at step one of an apply.
 */
export function assertResetPlanIsOurs(steps: readonly ResetStep[]): void {
  for (const step of steps) {
    if (step.kind !== 'remove-path') continue;
    for (const forbidden of FORBIDDEN) {
      if (step.target === forbidden.prefix || step.target.startsWith(`${forbidden.prefix}/`)) {
        throw new ResetWouldTouchForbiddenPath(step.target, forbidden.why);
      }
    }
  }
}
