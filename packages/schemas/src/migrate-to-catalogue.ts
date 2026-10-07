/**
 * The step from schema version 6 to 7: every tunnel becomes a catalogue entry, or the document is
 * refused by name.
 *
 * Kept in its own file because it is the only migration step with real work in it, and because the
 * translations are the only place in this repository that still knows what the *old* shape meant.
 * The rules for a step apply here unchanged: pure, dependent on nothing outside the document, and
 * never edited once shipped.
 *
 * ## What is being translated away
 *
 * Version 6 stored a tunnel as `provider` plus an opaque `config`, with obfuscation layers in a
 * separate `transports` list of the same opaque shape. In practice the opaque part held a command
 * line, a local port and an entire client configuration as a JSON string. Measured from a redacted
 * export of the bench profile, 2026-09-21: four tunnels, and five `UID` credentials sitting in clear
 * in a *redacted* export, because a credential inside a string field is a credential nothing can
 * find.
 *
 * The four shapes on that board translate cleanly, and they are the four this step was written
 * against:
 *
 * | stored as | becomes |
 * |---|---|
 * | `openvpn`, no transports | `OpenVPN` |
 * | `openvpn` + 1 transport | `Cloak + OpenVPN`, one entry point |
 * | `openvpn` + 4 transports | `Cloak + OpenVPN`, four entry points |
 * | `external-socks` running a VLESS client | `VLESS` |
 *
 * **The bench has no interchangeable tunnel at all** — all four are `role: 'resource'` — so this
 * step is not evidence about the failover group. That is stated here rather than discovered later by
 * somebody assuming the migration covered everything the schema allowed.
 *
 * ## Refusing
 *
 * There are no tombstones and no quarantine shape: the owner ruled that old profiles do not matter,
 * and a half-translated tunnel is a tunnel nobody can reason about. A document containing anything
 * this step cannot translate is **refused whole**, naming every offending tunnel, its protocol and
 * the reason — and saying in the same breath that the data plane is still running, because that is
 * true and because the opposite is what a person assumes when a message arrives from their router.
 *
 * Units are independent of the daemon. A profile that cannot be read means there is nothing to
 * manage with, not that the network fell over.
 */

import { isRecord, isStoredSecret } from './secrets.ts';
import { TUNNEL_PROTOCOL_TITLES, TUNNEL_PROTOCOLS, type TunnelProtocol } from './tunnel-configs.ts';
import { catalogueConfigFaults } from './validate-profile.ts';

/** One tunnel this step could not translate, and why. */
export interface UntranslatableTunnel {
  /** The tunnel's id, or its position when it has no usable id. */
  tunnel: string;
  /** What the document said it was — the old `provider`, which is the word the operator will recognise. */
  protocol: string;
  reason: string;
}

export class ProfileCatalogueError extends Error {
  readonly tunnels: UntranslatableTunnel[];

  constructor(tunnels: UntranslatableTunnel[]) {
    const lines = tunnels.map(
      (entry) => `  • tunnel "${entry.tunnel}" (${entry.protocol}): ${entry.reason}`,
    );
    super(
      `This profile cannot be brought forward, because ${tunnels.length === 1 ? 'one tunnel names' : `${tunnels.length} tunnels name`} ` +
        'something this product does not run:\n' +
        `${lines.join('\n')}\n` +
        `What it runs is ${TUNNEL_PROTOCOLS.map((protocol) => TUNNEL_PROTOCOL_TITLES[protocol]).join(', ')}.\n` +
        'Nothing has stopped. The tunnels, the access point and the firewall are run by units that do ' +
        'not depend on this daemon, so this is a profile that can no longer be managed — not a network ' +
        'that has failed.',
    );
    this.name = 'ProfileCatalogueError';
    this.tunnels = tunnels;
  }
}

/* ── reading the old shape ───────────────────────────────────────────────────────────────── */

/**
 * A string that may be stored wrapped as a secret.
 *
 * Returns `null` for a value that is present but unreadable — a redacted export's `{ $redacted }`
 * marker most of all. That is a genuine refusal rather than an empty string: a redacted export has
 * had the very content this step needs removed from it, and translating it to an empty
 * configuration would produce a tunnel that looks configured and cannot connect.
 */
function readable(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isStoredSecret(value)) {
    const inner = (value as { $secret: string | string[] }).$secret;
    return Array.isArray(inner) ? inner.join('\n') : inner;
  }
  return null;
}

/** Keeps a value in whatever wrapped form it already had, so a secret stays a secret. */
function carried(value: unknown): unknown {
  return value;
}

/** Wraps a value pulled *out* of a blob, because it is now a field of its own and must be stored as one. */
function wrapped(value: string): { $secret: string } {
  return { $secret: value };
}

function parsedJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The client writes ports as strings and this project as integers; both shapes were measured. */
function port(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/* ── the three translations ──────────────────────────────────────────────────────────────── */

/** The fields both OpenVPN-bearing entries share. */
function openVpnFields(config: Record<string, unknown>): Record<string, unknown> | null {
  if (readable(config['profile']) === null) return null;
  const out: Record<string, unknown> = { profile: carried(config['profile']) };

  const suffix = text(config['interfaceSuffix']);
  if (suffix !== undefined) out['interfaceSuffix'] = suffix;

  const auth = config['auth'];
  if (isRecord(auth)) {
    const username = text(auth['username']);
    // A username with no readable password is not a state anything can use, so it is dropped rather
    // than migrated into a half-credential the owner would have to discover by failing to connect.
    if (username !== undefined && readable(auth['password']) !== null) {
      out['auth'] = { username, password: carried(auth['password']) };
    }
  }

  return out;
}

/**
 * One obfuscation entry point, out of the client configuration that used to hold it.
 *
 * `LocalPort`, `LocalHost`, `command` and `configFile` are **not** carried: the catalogue entry
 * allocates the port and writes both files from that one value. On the bench those two numbers had
 * to be kept in step by hand, in two different strings forty lines apart.
 */
function entryPointFrom(
  id: string,
  client: Record<string, unknown>,
): Record<string, unknown> | null {
  const host = text(client['RemoteHost']);
  const uid = readable(client['UID']);
  const publicKey = text(client['PublicKey']);
  const serverName = text(client['ServerName']);
  const remotePort = port(client['RemotePort']);
  if (host === undefined || uid === null || publicKey === undefined || serverName === undefined) return null;

  const out: Record<string, unknown> = {
    id,
    host,
    port: remotePort ?? 443,
    uid: wrapped(uid),
    publicKey,
    proxyMethod: text(client['ProxyMethod']) ?? 'openvpn',
    encryptionMethod: text(client['EncryptionMethod']) ?? 'aes-gcm',
    serverName,
    browserSignature: text(client['BrowserSig']) ?? 'chrome',
    transport: text(client['Transport']) ?? 'direct',
  };

  const connections = port(client['NumConn']);
  if (connections !== null) out['connections'] = connections;
  const timeout = port(client['StreamTimeout']);
  if (timeout !== null) out['streamTimeoutSeconds'] = timeout;
  if (typeof client['UDP'] === 'boolean') out['udp'] = client['UDP'];

  return out;
}

/**
 * A VLESS account, out of the external client's configuration.
 *
 * The loopback inbound is discarded with the rest of the carrier's arrangements. Which client runs
 * this is not recorded either, and deliberately: the catalogue entry establishes that from the
 * configuration every time it plans, so a decision frozen into a document at migration time would be
 * a stale answer to a question that is asked again anyway.
 */
function vlessFrom(client: Record<string, unknown>): Record<string, unknown> | null {
  const outbounds = client['outbounds'];
  if (!Array.isArray(outbounds)) return null;

  const outbound = outbounds.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate['protocol'] === 'vless',
  );
  if (outbound === undefined) return null;

  const settings = outbound['settings'];
  const vnext = isRecord(settings) ? settings['vnext'] : undefined;
  const peer = Array.isArray(vnext) && isRecord(vnext[0]) ? (vnext[0] as Record<string, unknown>) : null;
  if (peer === null) return null;

  const users = peer['users'];
  const user = Array.isArray(users) && isRecord(users[0]) ? (users[0] as Record<string, unknown>) : null;
  const server = text(peer['address']);
  const serverPort = port(peer['port']);
  const account = user === null ? null : readable(user['id']);
  if (server === undefined || serverPort === null || account === null) return null;

  const stream = isRecord(outbound['streamSettings']) ? outbound['streamSettings'] : {};
  const tls = isRecord(stream['tlsSettings']) ? stream['tlsSettings'] : {};
  const ws = isRecord(stream['wsSettings']) ? stream['wsSettings'] : {};

  const out: Record<string, unknown> = {
    server,
    port: serverPort,
    id: wrapped(account),
    network: text(stream['network']) ?? 'tcp',
    security: text(stream['security']) ?? 'none',
  };

  const encryption = user === null ? null : readable(user['encryption']);
  // `none` is the absence of the feature spelled out. Carrying it would make every ordinary account
  // look like one the proxy core cannot run, and the carrier decision reads exactly this field.
  if (encryption !== null && encryption !== '' && encryption !== 'none') out['encryption'] = wrapped(encryption);

  const flow = user === null ? undefined : text(user['flow']);
  if (flow !== undefined) out['flow'] = flow;

  const serverName = text(tls['serverName']);
  if (serverName !== undefined) out['serverName'] = serverName;
  const fingerprint = text(tls['fingerprint']);
  if (fingerprint !== undefined) out['fingerprint'] = fingerprint;
  if (Array.isArray(tls['alpn'])) out['alpn'] = tls['alpn'].filter((item) => typeof item === 'string');

  const path = text(ws['path']);
  if (path !== undefined) out['path'] = path;
  const headers = ws['headers'];
  const host = isRecord(headers) ? text(headers['Host']) : undefined;
  if (host !== undefined) out['host'] = host;

  return out;
}

/* ── the step ────────────────────────────────────────────────────────────────────────────── */

interface Translation {
  protocol: TunnelProtocol;
  config: Record<string, unknown>;
}

/** The old fields that do not survive, so the new tunnel is built by naming what it keeps. */
const DROPPED = new Set(['provider', 'config', 'transports']);

function translate(tunnel: Record<string, unknown>): Translation | string {
  const provider = tunnel['provider'];
  const config = isRecord(tunnel['config']) ? tunnel['config'] : {};
  const transports = Array.isArray(tunnel['transports']) ? tunnel['transports'] : [];

  if (provider === 'openvpn') {
    const shared = openVpnFields(config);
    if (shared === null) {
      return 'its OpenVPN profile is missing or was removed by redaction, and a tunnel with no profile cannot be run';
    }
    if (transports.length === 0) return { protocol: 'openvpn', config: shared };

    const entryPoints: Record<string, unknown>[] = [];
    for (const [index, transport] of transports.entries()) {
      if (!isRecord(transport)) return `entry point ${index + 1} is not readable`;
      const id = text(transport['id']) ?? `entry-${index + 1}`;
      const client = parsedJson(readable(isRecord(transport['config']) ? transport['config']['configFile'] : null));
      if (client === null) {
        return `the obfuscation entry point "${id}" has no readable client configuration, so its host, account and disguise cannot be recovered`;
      }
      const entryPoint = entryPointFrom(id, client);
      if (entryPoint === null) {
        return `the obfuscation entry point "${id}" is missing one of the four fields it cannot run without: host, account, public key, disguised name`;
      }
      entryPoints.push(entryPoint);
    }
    return { protocol: 'cloak-openvpn', config: { ...shared, entryPoints } };
  }

  if (provider === 'external-socks') {
    const client = parsedJson(readable(config['configFile']));
    if (client === null) {
      return 'its client configuration is missing or was removed by redaction, and the account it carries cannot be recovered';
    }
    const vless = vlessFrom(client);
    if (vless === null) {
      return 'its client configuration is not a VLESS account, and VLESS is the only thing this shape is now allowed to be';
    }
    return { protocol: 'vless', config: vless };
  }

  return 'this product no longer runs that, and there is no escape hatch to keep it in';
}

/**
 * The 6 → 7 step.
 *
 * Throws `ProfileCatalogueError` naming **every** untranslatable tunnel rather than the first. A
 * person fixing a profile should learn what is wrong with it once, not one tunnel per attempt.
 */
export function migrateToCatalogue(document: Record<string, unknown>): Record<string, unknown> {
  const tunnels = document['tunnels'];
  if (!Array.isArray(tunnels)) return document;

  const refusals: UntranslatableTunnel[] = [];
  const migrated: Record<string, unknown>[] = [];

  for (const [index, raw] of tunnels.entries()) {
    if (!isRecord(raw)) {
      refusals.push({ tunnel: `#${index + 1}`, protocol: 'unreadable', reason: 'it is not an object' });
      continue;
    }

    const name = text(raw['id']) ?? `#${index + 1}`;
    const result = translate(raw);
    if (typeof result === 'string') {
      refusals.push({
        tunnel: name,
        protocol: text(raw['provider']) ?? 'nothing',
        reason: result,
      });
      continue;
    }

    /*
     * **The gate on the producer**, and it is the shape this project has already paid for once.
     *
     * The translations below build catalogue configurations by hand, and nothing compared the result
     * against the entry that has to accept it. Each translation was tested against its own intent,
     * and the schema was tested against documents somebody wrote out; no test put one into the
     * other, because that seam is not inside either file. The same gap was found and closed for
     * `parseSubscription` — *an invariant enforced at the consumer is not enforced, it is detected
     * there* — and the discipline was not carried across to here.
     *
     * It is not hypothetical: `interfaceSuffix` is carried straight through, and the catalogue
     * narrowed that field from 1–8 characters to 1–6, so a seven-character suffix produced a
     * version-7 document that was invalid the moment it was written.
     *
     * **Refused, not repaired.** A truncation would be a silent rename of the tunnel's interface,
     * which the differ then classifies as a network-class change — a consequence nobody asked for,
     * arriving under the heading of a schema migration. The refusal is whole-document like every
     * other one here, and names the field.
     */
    const faults = catalogueConfigFaults(result.protocol, result.config, '');
    if (faults.length > 0) {
      const first = faults[0]!;
      const where = first.pointer === '' ? 'its configuration' : `"${first.pointer.replace(/^\/config\//, '')}"`;
      refusals.push({
        tunnel: name,
        protocol: text(raw['provider']) ?? 'nothing',
        reason:
          `it translates to ${TUNNEL_PROTOCOL_TITLES[result.protocol]}, and the result is not one ` +
          `that entry accepts: ${where} ${first.message}`,
      });
      continue;
    }

    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!DROPPED.has(key)) kept[key] = value;
    }
    migrated.push({ ...kept, protocol: result.protocol, config: result.config });
  }

  // Refuse before producing anything. A step that returned a document with the translatable tunnels
  // in it and reported the rest separately would be a quarantine shape by another name, and the
  // ruling was that there is none.
  if (refusals.length > 0) throw new ProfileCatalogueError(refusals);

  return { ...document, tunnels: migrated };
}
