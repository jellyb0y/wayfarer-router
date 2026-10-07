/**
 * **VLESS** — what the owner has is a link or a subscription.
 *
 * This entry was called *Xray* until the owner read the catalogue and asked why, since Xray is
 * merely the program that happens to run his VLESS subscription. He was right, and the correction is
 * larger than a rename: once the entry is named for the thing the owner holds, **which program
 * carries it stops being a question he can be asked**, because the answer depends on the
 * configuration and he has no way to know it.
 *
 * So the entry establishes the carrier itself, states the choice and its reason in the plan, and
 * refuses rather than guessing.
 *
 * ## How the carrier is established
 *
 * Not by a version table and not by asking the core. **Every field in the configuration is
 * classified**, once, in the two lists below:
 *
 * * `CORE_FIELDS` — fields the proxy core's own VLESS outbound defines.
 * * `EXTERNAL_ONLY_FIELDS` — fields it does not, each with the sentence that explains why.
 *
 * A configuration using only the first list gets the **native outbound** and no second process runs.
 * A configuration touching the second gets an **external client** on a loopback port. A
 * configuration carrying a field in *neither* list is one whose carrier cannot be established, and
 * it is **refused by name**.
 *
 * That third branch is the part worth keeping. It fires the day somebody adds a field to
 * `VlessConfig` and does not say which carrier understands it — which is exactly the omission that
 * cannot be caught by a check written against today's fields.
 *
 * ## The measured case
 *
 * Bench board, 2026-09-21, fourth tunnel: the account carries
 * `encryption: "mlkem768x25519plus.native.0rtt.<1.6 KiB of key material>"`. That is post-quantum
 * VLESS encryption, an Xray feature; the proxy core defines no `encryption` field on a VLESS account
 * and rejects it outright. So this tunnel is carried externally — established from the configuration,
 * not guessed, and not asked of anybody.
 *
 * **The core-schema fetch is not consulted here, deliberately.** It survives for availability
 * discovery ("this core was built without QUIC") and nothing else. A carrier decision that waited on
 * a fetch would be a configuration that cannot be written down while a binary is missing, which is
 * the defect this epic removes elsewhere and would reintroduce here.
 */

import type { VlessConfig } from '@wayfarer/schemas';
import { PATHS, type ManagedFile } from '../desired-state.ts';
import type { CarrierChoice, CatalogueEntry, EntryPlanContext, EntryPlanResult } from './index.ts';
import { secretText } from './values.ts';
import { sessionLessFailsClosed, sessionLessLiveness } from './session-less.ts';

/** The external client, for the configurations the core cannot carry. Named once, here. */
export const XRAY_BINARY = 'xray';

/**
 * Fields the proxy core's VLESS outbound defines.
 *
 * A list rather than a shrug, so that adding a field to `VlessConfig` is a decision about the
 * carrier and not an accident.
 */
const CORE_FIELDS: ReadonlySet<string> = new Set([
  'server',
  'port',
  'id',
  'flow',
  'network',
  'security',
  'serverName',
  'fingerprint',
  'alpn',
  'path',
  'host',
  'realityPublicKey',
  'realityShortId',
]);

/** Fields it does not, each with the reason the plan will show the owner. */
const EXTERNAL_ONLY_FIELDS: ReadonlyMap<string, string> = new Map([
  [
    'encryption',
    'the link carries an encryption parameter, and the proxy core defines no encryption field on a ' +
      'VLESS account — it rejects it outright',
  ],
]);

/** Which keys of this configuration actually carry something. */
function presentFields(config: VlessConfig): string[] {
  return Object.entries(config)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key]) => key);
}

/**
 * The carrier, or nothing when it cannot be established.
 *
 * Exported because both the plan and its test read it, and because a decision this consequential
 * should be answerable without building a whole plan around it.
 */
export function establishCarrier(
  config: VlessConfig,
): { ok: true; carrier: CarrierChoice } | { ok: false; field: string } {
  const external: string[] = [];

  for (const field of presentFields(config)) {
    if (CORE_FIELDS.has(field)) continue;

    const reason = EXTERNAL_ONLY_FIELDS.get(field);
    if (reason === undefined) return { ok: false, field };

    // `encryption: "none"` is the absence of the feature spelled out, and the core carries it.
    if (field === 'encryption' && config.encryption === 'none') continue;
    external.push(reason);
  }

  if (external.length > 0) {
    return {
      ok: true,
      carrier: {
        kind: 'external',
        reason: `Carried by ${XRAY_BINARY} on a local port, because ${external.join('; and because ')}.`,
      },
    };
  }

  return {
    ok: true,
    carrier: {
      kind: 'native',
      reason:
        'Carried by the proxy core itself, because every field in this configuration is one its ' +
        'VLESS outbound defines. No second process runs.',
    },
  };
}

/* ── the native outbound ─────────────────────────────────────────────────────────────────── */

function nativeOutbound(config: VlessConfig): Record<string, unknown> {
  const object: Record<string, unknown> = {
    type: 'vless',
    server: config.server,
    server_port: config.port,
    uuid: secretText(config.id),
  };

  if (config.flow !== undefined) object['flow'] = config.flow;

  if (config.security === 'tls' || config.security === 'reality') {
    const tls: Record<string, unknown> = { enabled: true };
    tls['server_name'] = config.serverName ?? config.server;
    if (config.alpn !== undefined) tls['alpn'] = config.alpn;
    if (config.fingerprint !== undefined) tls['utls'] = { enabled: true, fingerprint: config.fingerprint };
    if (config.security === 'reality') {
      tls['reality'] = {
        enabled: true,
        ...(config.realityPublicKey === undefined ? {} : { public_key: config.realityPublicKey }),
        ...(config.realityShortId === undefined ? {} : { short_id: config.realityShortId }),
      };
    }
    object['tls'] = tls;
  }

  // `tcp` is the absence of a transport wrapper rather than a kind of one, which is why it is not
  // written out: the core reads a `transport` object as "there is one".
  if (config.network !== 'tcp') {
    const transport: Record<string, unknown> = { type: config.network };
    if (config.path !== undefined) transport['path'] = config.path;
    if (config.host !== undefined) transport['headers'] = { Host: config.host };
    object['transport'] = transport;
  }

  return object;
}

/* ── the external client ─────────────────────────────────────────────────────────────────── */

/**
 * The external client's configuration, in its own format.
 *
 * Written as `.json`, and the extension is not cosmetic: a generator naming a file `.conf` met a
 * client that infers format from the extension and did not start, silently. The format is also named
 * on the command line below rather than left to be inferred, because one statement of it is cheap
 * and a silent non-start is not.
 */
function xrayConfig(config: VlessConfig, port: number): string {
  const user: Record<string, unknown> = { id: secretText(config.id) };
  if (config.encryption !== undefined) user['encryption'] = secretText(config.encryption);
  if (config.flow !== undefined) user['flow'] = config.flow;

  const streamSettings: Record<string, unknown> = {
    network: config.network,
    security: config.security,
  };
  if (config.security === 'tls') {
    streamSettings['tlsSettings'] = {
      serverName: config.serverName ?? config.server,
      ...(config.fingerprint === undefined ? {} : { fingerprint: config.fingerprint }),
      ...(config.alpn === undefined ? {} : { alpn: config.alpn }),
    };
  }
  /*
   * Reality, in the external client's own field names.
   *
   * This branch did not exist. `streamSettings.security` was written as `reality` — so the client
   * was told to do a Reality handshake — and the parameters it needs to do one were dropped on the
   * floor, because only the `tls` case wrote a settings block. The unit file is written cleanly, the
   * unit starts, and the handshake fails against the real server: *applies with no refusal, cannot
   * pass traffic*, which is the failure class this epic exists to remove.
   *
   * Reachable because the carrier is established from the configuration, not chosen: any field that
   * forces the external client — `encryption` is the measured one — sends a Reality link down this
   * path. The bench board's VLESS tunnel is `security: "tls"`, so it is latent there and not live,
   * which changes who finds it and not whether it is broken.
   *
   * `publicKey` / `shortId` rather than the core's `public_key` / `short_id`: the two carriers name
   * the same two values differently, and mirroring `nativeOutbound` field-for-field is exactly how
   * the values would have been dropped a second time.
   */
  if (config.security === 'reality') {
    streamSettings['realitySettings'] = {
      serverName: config.serverName ?? config.server,
      ...(config.fingerprint === undefined ? {} : { fingerprint: config.fingerprint }),
      ...(config.realityPublicKey === undefined ? {} : { publicKey: config.realityPublicKey }),
      ...(config.realityShortId === undefined ? {} : { shortId: config.realityShortId }),
    };
  }
  if (config.network === 'ws') {
    streamSettings['wsSettings'] = {
      path: config.path ?? '/',
      ...(config.host === undefined ? {} : { headers: { Host: config.host } }),
    };
  }

  const document = {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        // Loopback only. A listener on any other address is a proxy open to whatever network this
        // device is plugged into, and nothing about the tunnel would look wrong.
        listen: '127.0.0.1',
        port,
        protocol: 'socks',
        settings: { udp: true, auth: 'noauth' },
        sniffing: { enabled: false },
      },
    ],
    outbounds: [
      {
        protocol: 'vless',
        tag: 'proxy',
        settings: { vnext: [{ address: config.server, port: config.port, users: [user] }] },
        streamSettings,
      },
    ],
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}

function xrayScript(configPath: string, port: number): string {
  return [
    '#!/bin/sh',
    '# Generated by Wayfarer. Edits here are overwritten on the next apply.',
    '#',
    '# The port below was allocated by this daemon so two external clients cannot collide. A fixed',
    '# port in a profile is how that collision happens, and it is only found when the second client',
    '# fails to bind.',
    'set -eu',
    `WAYFARER_LOCAL_PORT=${port}`,
    'export WAYFARER_LOCAL_PORT',
    `exec ${XRAY_BINARY} run -config ${configPath} -format json`,
    '',
  ].join('\n');
}

/* ── the entry ───────────────────────────────────────────────────────────────────────────── */

export const vlessEntry: CatalogueEntry<'vless'> = {
  id: 'vless',
  title: 'VLESS',

  /**
   * Available when *either* carrier could run: the core speaks VLESS, or the external client is
   * present. A device with both offers the entry unconditionally; a device with neither cannot.
   *
   * An unknown core schema counts as offering everything. Absent knowledge is not a negative answer,
   * and treating it as one is how a fetch blocks configuration.
   */
  availability: ({ core, installed }) => {
    const coreSpeaksVless = !core.known || core.outboundTypes.has('vless');
    if (coreSpeaksVless || installed.has(XRAY_BINARY)) return { available: true };
    return {
      available: false,
      reason:
        'This device’s proxy core was built without VLESS, and no external client is installed to ' +
        'carry it instead.',
      requires: [{ binary: XRAY_BINARY, neededFor: 'carrying a VLESS subscription this core cannot' }],
    };
  },

  plan: (rawConfig, context: EntryPlanContext): EntryPlanResult => {
    const config = rawConfig as VlessConfig;

    const established = establishCarrier(config);
    if (!established.ok) {
      return {
        ok: false,
        refusal: {
          protocol: 'vless',
          tunnelId: context.tunnel.id,
          pointer: `/tunnels/${context.tunnel.index}/config/${established.field}`,
          reason:
            `Tunnel "${context.tunnel.name}" sets "${established.field}", and this build cannot ` +
            'establish which client understands it — the proxy core does not define it and it is not ' +
            'one of the external client’s known fields. Choosing one would be a guess, and a guess ' +
            'here is the confident answer nobody can explain afterwards. ' +
            'Nothing has stopped: tunnels already running are independent of this daemon.',
        },
      };
    }

    const { carrier } = established;

    if (carrier.kind === 'native') {
      return {
        ok: true,
        plan: {
          target: 'outbounds',
          object: nativeOutbound(config),
          files: [],
          units: [],
          interfaces: [],
          carrier,
        },
      };
    }

    const unit = `wf-socks@${context.tunnel.id}.service`;
    const configPath = `${PATHS.socksDir}/${context.tunnel.id}.json`;
    const port = context.allocatePort({
      owner: `tunnel "${context.tunnel.name}"`,
      pointer: `/tunnels/${context.tunnel.index}`,
    });

    const files: ManagedFile[] = [
      {
        path: configPath,
        content: xrayConfig(config, port),
        // 0600: this file carries the account id, and the encryption parameter is key material.
        mode: 0o600,
        credentials: true,
        purpose: `the external client configuration for "${context.tunnel.name}"`,
        consumedBy: { kind: 'unit', unit },
      },
      {
        path: `${PATHS.socksDir}/${context.tunnel.id}.sh`,
        content: xrayScript(configPath, port),
        mode: 0o700,
        purpose: `starts the external client for "${context.tunnel.name}"`,
        consumedBy: { kind: 'unit', unit },
      },
    ];

    return {
      ok: true,
      plan: {
        target: 'outbounds',
        object: { type: 'socks', server: '127.0.0.1', server_port: port },
        files,
        units: [
          {
            name: unit,
            enabled: true,
            active: true,
            purpose: `the external client for "${context.tunnel.name}" on 127.0.0.1:${port}`,
          },
        ],
        interfaces: [],
        carrier,
      },
    };
  },

  liveness: sessionLessLiveness,
  failsClosed: sessionLessFailsClosed,
};
