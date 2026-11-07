/**
 * **Hysteria 2** — a QUIC tunnel the proxy core runs itself.
 *
 * Like the proxy entry, there is no binary, no generated file, no allocated port and no unit: the core
 * has a `hysteria2` outbound (entry 6 of the outbound union in the measured copy of its schema,
 * `packages/protocols/test/fixtures/core-schema-sing-box-1.14.0.json`, with `server_ports`, `obfs` and
 * `tls`), so this entry emits one object.
 *
 * ## One outbound is one QUIC connection, and that is why two identical nodes are not one
 *
 * Every `hysteria2` outbound is its own client and holds its own QUIC connection. The feed this entry
 * was written for offers each server twice under different tags, byte for byte the same configuration,
 * so that game traffic (UDP) and bulk downloads (TCP) never share one connection; its operator measured
 * UDP datagrams being lost under load when they did. Nothing in this entry merges anything, and nothing
 * upstream may either — see `nodeIdentity` in the protocols package.
 *
 * ## `insecure` is written only because a feed asked for it
 *
 * The invariants refuse it on a person's tunnel (`insecure_outside_feed`), so reaching this entry with it
 * set means a subscription stated it. Written as the feed wrote it, never inferred.
 */

import type { Hysteria2Config } from '@wayfarer/schemas';
import type { CatalogueEntry, EntryPlanContext, EntryPlanResult } from './index.ts';
import { secretText } from './values.ts';
import { sessionLessFailsClosed, sessionLessLiveness } from './session-less.ts';

/** The outbound, in the core's own vocabulary. Exported so a test can assert on the object itself. */
export function hysteria2Outbound(config: Hysteria2Config): Record<string, unknown> {
  const object: Record<string, unknown> = {
    type: 'hysteria2',
    server: config.server,
    server_port: config.port,
    password: secretText(config.password),
  };
  if (config.serverPorts !== undefined && config.serverPorts.length > 0) object['server_ports'] = config.serverPorts;
  if (config.obfsPassword !== undefined) {
    object['obfs'] = { type: 'salamander', password: secretText(config.obfsPassword) };
  }
  // Hysteria 2 is QUIC, and QUIC has no plaintext mode: TLS is always on, so it is not a field.
  const tls: Record<string, unknown> = { enabled: true, server_name: config.serverName ?? config.server };
  if (config.alpn !== undefined && config.alpn.length > 0) tls['alpn'] = config.alpn;
  if (config.insecure === true) tls['insecure'] = true;
  object['tls'] = tls;
  return object;
}

export const hysteria2Entry: CatalogueEntry<'hysteria2'> = {
  id: 'hysteria2',
  title: 'Hysteria 2',

  /**
   * Only the core can carry it: no external client is wired for Hysteria 2. An unknown core schema
   * counts as offering it, for the reason the VLESS entry gives — absent knowledge is not a refusal.
   */
  availability: ({ core }) => {
    if (!core.known || core.outboundTypes.has('hysteria2')) return { available: true };
    return { available: false, reason: 'This device’s proxy core was built without Hysteria 2.' };
  },

  plan: (rawConfig, context: EntryPlanContext): EntryPlanResult => {
    const config = rawConfig as Hysteria2Config;
    const refuse = (field: string, reason: string): EntryPlanResult => ({
      ok: false,
      refusal: {
        protocol: 'hysteria2',
        tunnelId: context.tunnel.id,
        pointer: `/tunnels/${context.tunnel.index}/config/${field}`,
        reason: `${reason} Nothing has stopped: tunnels already running are independent of this daemon.`,
      },
    });

    // `Secret()` sets no minimum length, so an empty password is a valid document and a server that
    // refuses every session, with nothing in the configuration looking wrong.
    if (secretText(config.password) === '') {
      return refuse('password', `Tunnel "${context.tunnel.name}" has an empty Hysteria 2 password.`);
    }
    if (config.obfsPassword !== undefined && secretText(config.obfsPassword) === '') {
      return refuse(
        'obfsPassword',
        `Tunnel "${context.tunnel.name}" turns obfuscation on with an empty password. Either give the ` +
          'password or remove the field.',
      );
    }
    for (const [index, range] of (config.serverPorts ?? []).entries()) {
      const [low = 0, high = low] = range.split(':').map(Number);
      if (low < 1 || high > 65535 || low > high) {
        return refuse(
          `serverPorts/${String(index)}`,
          `Tunnel "${context.tunnel.name}" gives the port range "${range}", which is not one: a range is ` +
            'two ports from 1 to 65535, the first no larger than the second, like 18020:18039.',
        );
      }
    }

    return {
      ok: true,
      plan: { target: 'outbounds', object: hysteria2Outbound(config), files: [], units: [], interfaces: [] },
    };
  },

  liveness: sessionLessLiveness,
  failsClosed: sessionLessFailsClosed,
};
