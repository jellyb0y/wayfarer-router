/**
 * The follower as the daemon runs it: what it reads, how it applies, and the observer it reports to.
 *
 * Built here rather than as a closure in `index.ts` for the reason `core/resolver-watch.ts` gives: a
 * test that assembles its own follower tests its own follower. The tests for the network half build it
 * through this function, against the real `applyDocument`, planner and differ.
 *
 * ## Two subjects, one mechanism
 *
 * It follows the values this device reads off itself into the core's configuration: the resolver each
 * peer pushed (since 2026-09-22) and the network each peer handed a tunnel interface (since 2026-09-23,
 * after `corp` came up at 07:32:27 with `10.122.0.0/24` and nothing re-derived — see
 * `core/followed-networks.ts`). Both are compared on the same cadence, re-derived through the same
 * narrowed apply, deferred to the same open transaction, woken by the same end of a transaction, and
 * reported on the same observer. The address watch wakes it when an address changes, so a network is
 * followed in seconds; the minute's round catches one whose event was missed.
 */

import type { ProfileDocument } from '@wayfarer/schemas';
import type { Platform } from '../platform/index.ts';
import type { ProfileStore } from '../state/profiles.ts';
import type { Store } from '../state/store.ts';
import { applyDocument, type ApplyDeps } from './apply.ts';
import { PATHS } from './desired-state.ts';
import { followedNetworkDivergence } from './followed-networks.ts';
import type { ObserverRegistry } from './observers.ts';
import { readConvergence } from './resolver-convergence.ts';
import { createResolverFollower, RESOLVER_FOLLOW_INTERVAL_MS, type FollowerEvent, type ResolverFollower } from './resolver-follower.ts';
import { interfaceNetworks } from '../platform/facts.ts';
import { CAPTURED_RESOLVER_DIR, readCapturedResolvers } from '../platform/captured-resolvers.ts';

export function followDevice(input: {
  platform: Platform;
  store: Store;
  profiles: ProfileStore;
  applyDeps: ApplyDeps;
  observers: ObserverRegistry;
  record: (event: FollowerEvent) => void;
  log: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string) => void;
  /** Overridable for a test; the default is the reader the up-script writes for. */
  capturedResolvers?: () => Promise<Map<string, string>>;
  /** Overridable for a test that must not wait a minute; production passes none of these. */
  timing?: { everyMs?: number; minApplyIntervalMs?: number; monotonicMs?: () => number };
}): ResolverFollower {
  const { platform, store, profiles } = input;
  const captured = input.capturedResolvers ?? (() => readCapturedResolvers());
  const read = async (path: string): Promise<string | null> => await platform.files.readManaged(path).catch(() => null);

  return createResolverFollower({
    // The last applied document, never the active profile: see `core/resolver-follower.ts` and G3.
    document: () => (profiles.lastAppliedDocument() as ProfileDocument | null) ?? null,
    profileId: () => store.device().activeProfileId,
    verify: async (document) => {
      const resolvers = await readConvergence(document, { captured, coreConfig: () => read(PATHS.coreConfig) });
      const addresses = await platform.net.addresses().catch(() => null);
      if (addresses === null) return resolvers;
      return {
        ...resolvers,
        networks: followedNetworkDivergence({
          // The reading the planner is given, through the same function, and the tunnel interfaces the
          // last plan recorded — so "followed" means here what it means in the plan.
          networks: interfaceNetworks(addresses),
          tunnelInterfaces: store.device().managementSurfaces?.tunnels ?? [],
          coreConfig: await read(PATHS.coreConfig),
          fenceRecord: await read(PATHS.coreFence),
        }),
      };
    },
    apply: async ({ profileId, document }) =>
      await applyDocument(input.applyDeps, {
        profileId,
        document,
        // Never anything that could take the device off the network: a captured value can never
        // reconfigure an interface, move the access point, or reboot anything.
        classes: ['hot', 'service'],
        openedBy: null,
      }),
    openTransaction: () => {
      const open = profiles
        .recentTransactions(10)
        .find((row) => row.state === 'applying' || row.state === 'awaiting-confirm' || row.state === 'reverting');
      return open === undefined ? null : { id: open.id, state: open.state };
    },
    record: input.record,
    log: input.log,
    observer: input.observers.register({
      name: 'resolver-follower',
      watches:
        `whether the core is configured with the resolver each tunnel's peer pushed (${CAPTURED_RESOLVER_DIR} ` +
        `against ${PATHS.coreConfig}), and whether its exclusion list holds every network a peer handed a tunnel interface`,
      everyMs: input.timing?.everyMs ?? RESOLVER_FOLLOW_INTERVAL_MS,
    }),
    ...(input.timing?.everyMs === undefined ? {} : { everyMs: input.timing.everyMs }),
    ...(input.timing?.minApplyIntervalMs === undefined ? {} : { minApplyIntervalMs: input.timing.minApplyIntervalMs }),
    ...(input.timing?.monotonicMs === undefined ? {} : { monotonicMs: input.timing.monotonicMs }),
  });
}
