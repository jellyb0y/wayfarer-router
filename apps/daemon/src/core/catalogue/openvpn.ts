/**
 * **OpenVPN** — what the owner has is an `.ovpn` file.
 *
 * The simplest entry there is, and the one that shows what an entry owns: a binary it does not ask
 * about, a configuration file whose name *and format* it decides, one unit, and an interface it
 * declares so the planner can route through it before it exists. Nothing here is a field.
 */

import type { OpenVpnConfig } from '@wayfarer/schemas';
import { interfaceNameFromTag } from '../binding.ts';
import type { CatalogueEntry, EntryPlanContext, EntryPlanResult, LivenessSubjectInput } from './index.ts';
import type { LivenessMethod } from '../liveness.ts';
import { ovpnFiles } from './ovpn.ts';
import { secretText } from './values.ts';

/** The binary this entry runs. Named once, here, and never in a profile. */
export const OPENVPN_BINARY = 'openvpn';

/** The unit shape, which is this entry's and not the planner's. */
export function openVpnUnit(tunnelId: string): string {
  return `wf-openvpn@${tunnelId}.service`;
}

/**
 * The interface name.
 *
 * Generated, never taken from a profile: this is where the 15-character and no-hyphen rules are
 * enforced, because it is where the name is made. The owner's `interfaceSuffix` is a hint for
 * reading diagnostics, so a missing one falls back to the tunnel's position rather than refusing.
 */
export function openVpnInterface(config: { interfaceSuffix?: string }, index: number): string {
  return interfaceNameFromTag('wfvpn', config.interfaceSuffix ?? `${index}`);
}

export function planOpenVpnBody(
  config: OpenVpnConfig,
  context: EntryPlanContext,
  extra: { remotes: Parameters<typeof ovpnFiles>[0]['remotes']; extraFiles?: ReturnType<typeof ovpnFiles>; extraUnits?: never },
): EntryPlanResult {
  const interfaceName = openVpnInterface(config, context.tunnel.index);
  const unit = openVpnUnit(context.tunnel.id);

  const password = config.auth === undefined ? '' : secretText(config.auth.password);
  const files = ovpnFiles({
    tunnelId: context.tunnel.id,
    tunnelName: context.tunnel.name,
    interfaceName,
    profile: secretText(config.profile),
    ...(config.auth === undefined ? {} : { auth: { username: config.auth.username, password } }),
    remotes: extra.remotes,
    unit,
  });

  return {
    ok: true,
    plan: {
      target: 'outbounds',
      // A tunnel of any nature reduces to a tag: the routing engine and the interface never learn
      // what is inside, which is why one shape serves every daemon that produces an interface.
      object: { type: 'direct', bind_interface: interfaceName },
      files: [...(extra.extraFiles ?? []), ...files],
      units: [
        {
          name: unit,
          enabled: true,
          active: true,
          purpose: `runs the OpenVPN client for "${context.tunnel.name}"`,
        },
      ],
      interfaces: [interfaceName],
    },
  };
}

/**
 * How an OpenVPN tunnel is asked whether it is alive — shared with `Cloak + OpenVPN`, which is the same
 * client behind a transport.
 *
 * OpenVPN has a session and a keepalive of its own: a peer pushing `ping 10`–`15` sends something at
 * least that often, and the client counts every byte it reads from the link. So the question is asked
 * of the protocol — how long since the peer last sent anything — and confirmed by an echo to the
 * gateway the peer pushed, over the tunnel's own interface. See `core/liveness.ts`.
 *
 * The interface comes from what the last plan recorded, so it is the one the device was configured
 * with rather than one recomputed here.
 */
export function openVpnLiveness(subject: LivenessSubjectInput): LivenessMethod {
  if (subject.interfaces === undefined) {
    return {
      kind: 'none',
      why: 'which interface this tunnel creates is not recorded yet (every plan records it; the next one will)',
    };
  }
  if (subject.interfaces.length !== 1) {
    return {
      kind: 'none',
      why: `its last plan records ${String(subject.interfaces.length)} interfaces for it, and which one carries its peer is not known`,
    };
  }
  return { kind: 'peer-keepalive', interfaceName: subject.interfaces[0]! };
}

/**
 * The outbound is `{ type: 'direct', bind_interface: <its interface> }` (see `planOpenVpnBody`). A socket
 * bound to a device leaves by that device or not at all — the kernel assumes the destination is on-link
 * there rather than consulting another route — and while the tunnel is down the device is either gone,
 * so the bind fails, or it is a tun with nobody reading the other end.
 */
export function openVpnFailsClosed(subject: LivenessSubjectInput): string {
  const name = subject.interfaces?.length === 1 ? subject.interfaces[0]! : 'its own interface';
  return (
    `its outbound is bound to ${name}, so while the tunnel is down its traffic fails with a connection ` +
    'error and cannot leave another way'
  );
}

export const openVpnEntry: CatalogueEntry<'openvpn'> = {
  id: 'openvpn',
  title: 'OpenVPN',

  availability: ({ installed }) =>
    installed.has(OPENVPN_BINARY)
      ? { available: true }
      : {
          available: false,
          reason: 'The OpenVPN client is not installed on this device.',
          requires: [{ binary: OPENVPN_BINARY, neededFor: 'running an OpenVPN tunnel' }],
        },

  plan: (config, context) =>
    // No remotes of ours: a plain OpenVPN profile dials what its own `remote` lines say, and
    // rewriting them would change where somebody's traffic goes without telling them.
    planOpenVpnBody(config as OpenVpnConfig, context, { remotes: [] }),

  liveness: openVpnLiveness,
  failsClosed: openVpnFailsClosed,
};
