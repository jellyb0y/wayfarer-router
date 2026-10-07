/**
 * The address watch as the daemon runs it: one `ip monitor` subscription, the observer that reports it,
 * and the two things an address change wakes.
 *
 * It existed to re-bind the management interface when an address arrives late. Since 2026-09-23 the
 * same event also wakes the follower (`core/device-follower.ts`), because an address appearing on a
 * tunnel interface is how a tunnel's network first becomes visible: measured on the bench board, `corp`
 * came up at 07:32:27 with `10.122.0.2/24` and nothing woke. One watcher with two consumers rather than a
 * second subscription to the same kernel events. It is the trigger only — whether anything is missing
 * from the fence is the follower's comparison, rate limited there — so a burst of events is harmless.
 *
 * Built here so a test wires it through the same function `index.ts` calls.
 */

import type { NetReader } from '../platform/net.ts';
import type { StreamHandle } from '../platform/exec.ts';
import type { ObserverRegistry } from './observers.ts';

export function observeAddresses(input: {
  observers: ObserverRegistry;
  net: Pick<NetReader, 'watch'>;
  /** Re-resolves the management listeners; answers with what is bound afterwards. */
  rebind: () => Promise<string[]>;
  follower: { check: (reason: string) => Promise<unknown> };
  log: (level: 'error', fields: Record<string, unknown>, message: string) => void;
}): StreamHandle {
  const observer = input.observers.register({
    name: 'address-watch',
    watches:
      'the kernel’s links, addresses and routes, to re-bind the management interface and to have the ' +
      'follower look for a tunnel network the fence does not hold, when they change',
    everyMs: null,
  });
  const handle = input.net.watch((snapshot) => {
    observer.looked(`${String(snapshot.addresses.length)} address(es) on ${String(snapshot.links.length)} link(s)`);
    void input
      .rebind()
      .then((bound) => observer.acted(`re-bound the management interface: ${bound.join(', ') || 'nothing'}`))
      .catch((error: unknown) => input.log('error', { error: String(error) }, 'rebind failed'));
    void input.follower.check('addresses-changed');
  });
  observer.armed();
  return handle;
}
