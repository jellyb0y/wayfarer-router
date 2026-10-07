/**
 * The one planning context for this device, built the same way by the daemon and by `way`.
 *
 * ## Why it is one function
 *
 * Measured on the bench board, 2026-09-23: the daemon's `GET /api/drift` said `converged` while
 * `way drift` said the core configuration differed at `/dns/servers/3/server` and `wf-core` was out
 * of date. Both were asked the same question about the same device. The daemon's context read the
 * resolvers the tunnel peers had pushed; the CLI built its own context by hand and left that reader
 * out, so it derived the profile's starting value `10.184.100.5` and called the running configuration
 * wrong. The timer-driven `way revert` used the same hand-built context, so the drift event it wrote
 * after an undo was false in the same way whenever a capture differed from the profile.
 *
 * Two answers from one device about one question is what Epic G exists to end. So there is now one
 * constructor, and the only things a caller supplies are the things that really do differ between a
 * long-running daemon and a one-shot command: where the management surface is bound, and what to do
 * with the two notifications a plan emits.
 *
 * `capturedResolvers` defaults to the shipped reader rather than to nothing, for the reason
 * `core/drift.ts` gives for its own optional dependency: a default meaning "none" is how the CLI
 * silently lost it.
 */

import type { PipelineContext } from './pipeline.ts';
import type { Platform } from '../platform/index.ts';
import { collectFacts, collectReality } from '../platform/facts.ts';
import { collectInventory } from '../inventory/index.ts';
import { readCapturedResolvers } from '../platform/captured-resolvers.ts';

/** Units that might be a proxy core this device did not start. Claims about the host, named once. */
export const CORE_CANDIDATES = [
  { unit: 'sing-box.service', binary: 'sing-box' },
  { unit: 'xray.service', binary: 'xray' },
];

/** Directories another network manager may claim an interface in. */
export const CLAIM_DIRECTORIES = [
  { path: '/etc/netplan', by: 'netplan', extensions: ['.yaml', '.yml'] },
  { path: '/etc/systemd/network', by: 'systemd-networkd', extensions: ['.network', '.link'] },
  { path: '/etc/NetworkManager/system-connections', by: 'NetworkManager', extensions: ['.nmconnection'] },
];

export const UP_SCRIPT_PATH = '/opt/wayfarer/bin/tunnel-up';

export function devicePipeline(input: {
  platform: Platform;
  config: { listen: { port: number }; timePorts: number[]; wayBinary: string };
  /** The addresses the management surface is bound to, read at each call. */
  boundAddresses: () => string[];
  /** Overridable for a test; the default is the reader the up-script writes for. */
  capturedResolvers?: () => Promise<Map<string, string>>;
  onManagementSurfaces?: PipelineContext['onManagementSurfaces'];
  onTunnelUnits?: PipelineContext['onTunnelUnits'];
}): PipelineContext {
  const { platform, config } = input;
  return {
    platform,
    inventory: async () => await collectInventory(platform),
    facts: async () =>
      await collectFacts({
        systemd: platform.systemd,
        net: platform.net,
        coreCandidates: CORE_CANDIDATES,
        claimDirectories: CLAIM_DIRECTORIES,
        boundAddresses: input.boundAddresses(),
        binaries: (await collectInventory(platform)).binaries.map((entry) => ({
          name: entry.name,
          present: entry.present,
          version: entry.version,
        })),
      }),
    reality: async (paths, units, sysctlKeys) =>
      await collectReality({
        systemd: platform.systemd,
        net: platform.net,
        paths,
        units,
        sysctlKeys,
        boundAddresses: input.boundAddresses(),
      }),
    managementPort: config.listen.port,
    timePorts: config.timePorts,
    upScriptPath: UP_SCRIPT_PATH,
    // What peers have actually pushed, read fresh for every plan — by every caller.
    capturedResolvers: input.capturedResolvers ?? (() => readCapturedResolvers()),
    wayBinary: config.wayBinary,
    ...(input.onManagementSurfaces === undefined ? {} : { onManagementSurfaces: input.onManagementSurfaces }),
    ...(input.onTunnelUnits === undefined ? {} : { onTunnelUnits: input.onTunnelUnits }),
  };
}
