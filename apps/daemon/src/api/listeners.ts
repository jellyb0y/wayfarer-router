/**
 * The set of addresses the daemon listens on, reconciled against what the kernel reports.
 *
 * The rule this module exists to enforce, and the reason it is a separate testable unit:
 *
 * > **A listener is torn down only on a positively observed absence, never on a read that failed.**
 *
 * The first version read addresses with `.catch(() => [])`, which turns "I could not ask" into "the
 * interface has no addresses" — and the teardown pass then closes the listener on the only
 * interface anyone can reach the device through. On a board with no console that is not a bug that
 * costs a restart, it is a bug that costs a trip to fetch the memory card. An address that really
 * went away is still gone at the next successful read, so waiting costs nothing and guessing costs
 * the board.
 */

import { resolveBindAddresses, type ListenConfig } from '../config.ts';

export interface AddressEntry {
  name: string;
  address: string;
  family: string;
}

/** A reading of the kernel's address table, which can fail as a distinct outcome. */
export type AddressReading = { ok: true; addresses: AddressEntry[] } | { ok: false; error: string };

export interface ListenerHost {
  /** Binds one address. Resolves with the outcome rather than throwing. */
  start(address: string, port: number): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Closes the listener for one address. Only ever called on an observed absence. */
  stop(address: string): void;
}

export interface ReconcileResult {
  /** Addresses currently listening. */
  bound: string[];
  /** Configured interfaces that resolved to no address. Empty when the reading failed. */
  unresolved: string[];
  /** True when the reading failed and the teardown pass was therefore skipped. */
  teardownSkipped: boolean;
  /** Addresses closed during this pass. */
  closed: string[];
  /** Addresses that could not be bound, with the reason. */
  failed: { address: string; error: string }[];
}

export interface ListenerSet {
  reconcile(reading: AddressReading): Promise<ReconcileResult>;
  addresses(): string[];
  stopAll(): void;
}

export function createListenerSet(options: {
  listen: ListenConfig;
  host: ListenerHost;
  /**
   * Interface names from the **active profile**, read at every reconcile rather than captured once.
   *
   * The management surfaces are a property of the configuration, not of a file somebody edited: the
   * access point the profile hosts, and the uplink it is a client of when `services.management`
   * allows it. Read per reconcile so switching profiles or turning the setting off takes effect on the
   * next address change rather than at the next restart.
   *
   * Returning names, never addresses. That distinction is doing real work on a device where the uplink
   * and a separate management path can share a subnet — binding by address would catch both and there
   * would be no way to tell from the result which one was asked for.
   */
  profileInterfaces?: () => string[];
  log?: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string) => void;
}): ListenerSet {
  const { listen, host } = options;
  const profileInterfaces = options.profileInterfaces ?? ((): string[] => []);
  const log = options.log ?? ((): void => undefined);
  const bound = new Set<string>();

  return {
    addresses(): string[] {
      return [...bound];
    },

    async reconcile(reading: AddressReading): Promise<ReconcileResult> {
      const closed: string[] = [];
      const failed: { address: string; error: string }[] = [];

      if (!reading.ok) {
        // Literal addresses from the configuration do not depend on the reading, so they are still
        // worth binding — a daemon that has never managed to read the address table must at least
        // come up on loopback. Nothing is closed.
        log('warn', { error: reading.error }, 'could not read addresses; keeping every listener and retrying');
        for (const address of listen.addresses) {
          if (bound.has(address)) continue;
          const result = await host.start(address, listen.port);
          if (result.ok) bound.add(address);
          else failed.push({ address, error: result.error });
        }
        return { bound: [...bound], unresolved: [], teardownSkipped: true, closed, failed };
      }

      /*
       * The configured interfaces and the profile's, as one list.
       *
       * `listen.interfaces` stays: it is how an operator adds a surface the profile does not describe, and
       * removing it would break a device somebody has already configured that way. The profile's are added
       * to it rather than replacing it.
       */
      const effective: ListenConfig = {
        ...listen,
        interfaces: [...new Set([...listen.interfaces, ...profileInterfaces()])],
      };
      const { bind, unresolved } = resolveBindAddresses(effective, reading.addresses);

      for (const address of bind) {
        if (bound.has(address)) continue;
        const result = await host.start(address, listen.port);
        if (result.ok) {
          bound.add(address);
          log('info', { address, port: listen.port }, 'listening');
        } else {
          failed.push({ address, error: result.error });
          log('error', { address, error: result.error }, 'could not listen on address');
        }
      }

      for (const address of [...bound]) {
        if (bind.includes(address)) continue;
        // Reached only after a successful reading that did not contain this address: an observed
        // absence. A stale listener would also keep the port occupied for a later configuration.
        log('info', { address }, 'address gone, closing its listener');
        host.stop(address);
        bound.delete(address);
        closed.push(address);
      }

      return { bound: [...bound], unresolved, teardownSkipped: false, closed, failed };
    },

    stopAll(): void {
      for (const address of bound) host.stop(address);
      bound.clear();
    },
  };
}
