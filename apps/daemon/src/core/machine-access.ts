/**
 * The device's machine-access switch: whether any bearer token is accepted at all.
 *
 * Off by default, and a token is refused while it is off however valid it is — a fresh device cannot
 * be driven remotely until somebody who can already reach it decides it may be. That default is
 * right and is not changed here.
 *
 * What was missing, found while fixing the refusal (`docs/13-plan.md` row F8, 2026-09-23): **nothing
 * could turn it on.** No route, no screen and no CLI command wrote `device.api_enabled`; the only
 * way was an `UPDATE` typed into the database by hand, which is a device configured outside this
 * repository. A refusal cannot name where the switch is when the switch is nowhere, so the switch
 * had to exist before the sentence could be true. It is a CLI command on the device, run as root,
 * because that is a person who already holds the device — the same standing `way credentials reset`
 * relies on.
 */

import type { Store } from '../state/store.ts';

export function machineAccess(store: Store, args: string[]): { code: number; text: string } {
  const [verb] = args;
  if (verb === 'status' || verb === undefined) {
    return {
      code: 0,
      text: store.device().apiEnabled
        ? 'machine access is ON: API tokens are accepted, each within its scopes\n'
        : 'machine access is OFF: every API token is refused until `way machine-api on`\n',
    };
  }
  if (verb !== 'on' && verb !== 'off') {
    return { code: 2, text: 'way machine-api [status|on|off]\n' };
  }
  const enabled = verb === 'on';
  store.setApiEnabled(enabled);
  store.recordEvent({
    level: 'warn',
    kind: enabled ? 'auth.machine-access-on' : 'auth.machine-access-off',
    summary: enabled
      ? 'machine access turned on from the CLI: API tokens are now accepted within their scopes'
      : 'machine access turned off from the CLI: every API token is now refused',
  });
  // Read back rather than assumed: the answer is what the database now holds.
  const now = store.device().apiEnabled;
  return {
    code: now === enabled ? 0 : 1,
    text: now ? 'machine access is ON\n' : 'machine access is OFF\n',
  };
}
