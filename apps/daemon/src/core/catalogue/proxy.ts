/**
 * **Proxy** — what the owner has is an address, a port, and sometimes a user name and a password.
 *
 * The smallest entry in the catalogue by a distance, and worth stating why rather than leaving the
 * emptiness to be read as an oversight: **there is no binary, no external process, no generated
 * file, no allocated port and no systemd unit.** The installed proxy core speaks `http` and `socks`
 * as outbounds of its own — both are in the outbound union of the schema this project keeps a
 * measured copy of (`packages/protocols/test/fixtures/core-schema-sing-box-1.14.0.json`, entries 4
 * and 12) — so this entry emits an outbound object and nothing else. `TunnelEmission` already makes
 * `units`, `files` and `interfaces` optional, so that is a shape the planner allows rather than one
 * this entry had to be given.
 *
 * ## One entry, three types, and the translation that is ours rather than his
 *
 * The core has no `https` outbound. An HTTPS proxy is its `http` outbound with TLS enabled, and that
 * is exactly the kind of fact a person should never have to hold: his provider told him *HTTPS
 * proxy*, he picks HTTPS, and the pair is assembled here.
 *
 * ## Availability is unconditional, and that is not laziness
 *
 * `availability` exists to answer *what would have to be installed*. Nothing would: no binary is
 * consulted, and the two outbound types this entry uses are the most basic the core has. An entry
 * that reported itself unavailable would be reporting a state nobody can act on — and refusing
 * configuration on a core-schema fetch is the defect this epic removed elsewhere.
 *
 * ## What it refuses, and why refusing beats dropping
 *
 * `tlsServerName` and `tlsCertificate` describe a handshake. On a `socks` or plain `http` proxy
 * there is no handshake to describe, so a configuration carrying either is **refused by name**
 * rather than emitted without them. The alternative — write the outbound and drop the fields — is
 * the shape this repository already ruled against once, for `allowInsecure` in a subscription link:
 * it produces a tunnel that looks complete and fails for a reason its author stated and we
 * discarded.
 *
 * **Corrected 2026-09-22.** This paragraph used to end *"the interface only draws those two controls
 * for HTTPS, so reaching this refusal means a document arrived some other way"*. That was wrong, and
 * wrong in the direction that matters: the editor hid the controls on a type change and **kept the
 * values in the draft**, so the screen itself produced a refusal at a pointer with no control on it —
 * the least clearable error there is. The editor now clears the two fields when the type stops being
 * HTTPS. A sentence explaining why a branch is unreachable is worth exactly as much as the check that
 * it is, and there was none.
 *
 * Two more refusals, both for a value that validates and cannot work:
 *
 * * **A sign-in with an empty password.** `Secret()` sets no minimum length, so `password: ""` is a
 *   legal document; a proxy handed it fails to authenticate and nothing in the configuration looks
 *   wrong. Refused here rather than by adding a minimum to `Secret()`, because that declaration is
 *   shared by every credential in the product and tightening it is a decision about all of them.
 * * **A certificate that is obviously not PEM.** No parser — the core has one and a second would
 *   disagree with it eventually — only the cheap check that some line opens a PEM block. Without it
 *   a mistyped paste travels to the core's start-up and fails in a journal, about a file nobody
 *   wrote by hand.
 *
 * A refusal here is **not** an outage: a profile that cannot be planned means there is nothing to
 * manage with, not that the network fell over.
 */

import type { ProxyConfig } from '@wayfarer/schemas';
import type { CatalogueEntry, EntryPlanContext, EntryPlanResult } from './index.ts';
import { secretText } from './values.ts';
import { sessionLessFailsClosed, sessionLessLiveness } from './session-less.ts';

/**
 * The fields that only mean something once there is a TLS handshake, with the words the refusal
 * uses.
 *
 * A list rather than two `if`s, so that adding a TLS field to `ProxyConfig` and forgetting to decide
 * what it means on a SOCKS proxy is a gap in one visible place instead of a silent drop.
 */
const TLS_ONLY_FIELDS: ReadonlyMap<keyof ProxyConfig, string> = new Map([
  ['tlsServerName', 'the name a certificate would be checked against'],
  ['tlsCertificate', 'a certificate to trust'],
]);

/** Which keys of this configuration actually carry something. */
function present(config: ProxyConfig, field: keyof ProxyConfig): boolean {
  const value = config[field];
  if (value === undefined || value === null || value === '') return false;
  return !(Array.isArray(value) && value.length === 0);
}

/**
 * The outbound, in the core's own vocabulary.
 *
 * Exported because the test reads it directly: an assertion about the object that joins the
 * generated configuration is the only assertion here that could catch a wrong field name, and
 * rebuilding a whole plan around it would hide the one line that matters.
 */
export function proxyOutbound(config: ProxyConfig): Record<string, unknown> {
  const object: Record<string, unknown> = {
    // `https` is not an outbound type. It is `http` plus TLS, and the pair is assembled below.
    type: config.type === 'socks' ? 'socks' : 'http',
    server: config.server,
    server_port: config.port,
  };

  if (config.type === 'socks') {
    /*
     * Written out rather than left to the core's default.
     *
     * The version decides whether the user name and password beside it mean anything at all: SOCKS4
     * has no user-name/password authentication, so a proxy negotiated as v4 would drop the
     * credentials and fail to authenticate with nothing in the configuration looking wrong. The
     * entry states the version it assembled the rest of the object for, so the two cannot disagree
     * and no default has a say.
     */
    object['version'] = '5';
  }

  if (config.auth !== undefined) {
    object['username'] = config.auth.username;
    /*
     * `secretText` **unwraps**: a stored secret arrives as `{ "$secret": "…" }` on a dry run and as
     * a plain string once resolved, and this turns both into the text the core is handed. One reader
     * for both stages, so no entry has to know which stage it is in.
     *
     * It is not a redaction and must not be credited as one. What keeps a dry run from publishing
     * this value is `renderPlan`, which never returns generated file content at all; if that is ever
     * relaxed, nothing here is standing behind it.
     */
    object['password'] = secretText(config.auth.password);
  }

  if (config.type === 'https') {
    const tls: Record<string, unknown> = {
      enabled: true,
      // Absent means the address is the name, which is right whenever the proxy is reached by the
      // name its certificate was issued for.
      server_name: config.tlsServerName ?? config.server,
    };
    /*
     * The certificate this device should trust for this proxy, and **verification stays on.**
     *
     * This is the field that answers the need behind `allowInsecure` without being it: the core
     * still checks the presented certificate, it just checks it against what the owner supplied.
     * Nothing here writes `insecure`, and nothing should.
     */
    if (config.tlsCertificate !== undefined && config.tlsCertificate.length > 0) {
      tls['certificate'] = config.tlsCertificate;
    }
    object['tls'] = tls;
  }

  return object;
}

export const proxyEntry: CatalogueEntry<'proxy'> = {
  id: 'proxy',
  title: 'Proxy',

  /** Nothing can be missing. See the note above; this is a decision, not an unwritten check. */
  availability: () => ({ available: true }),

  plan: (rawConfig, context: EntryPlanContext): EntryPlanResult => {
    const config = rawConfig as ProxyConfig;

    if (config.type !== 'https') {
      for (const [field, what] of TLS_ONLY_FIELDS) {
        if (!present(config, field)) continue;
        return {
          ok: false,
          refusal: {
            protocol: 'proxy',
            tunnelId: context.tunnel.id,
            pointer: `/tunnels/${context.tunnel.index}/config/${field}`,
            reason:
              `Tunnel "${context.tunnel.name}" gives ${what}, and it speaks ${config.type.toUpperCase()}, ` +
              'which has no TLS handshake to use it in. Either choose HTTPS or remove the field — ' +
              'this device will not quietly drop a setting somebody wrote down. ' +
              'Nothing has stopped: tunnels already running are independent of this daemon.',
          },
        };
      }
    }

    const refuse = (field: string, reason: string): EntryPlanResult => ({
      ok: false,
      refusal: {
        protocol: 'proxy',
        tunnelId: context.tunnel.id,
        pointer: `/tunnels/${context.tunnel.index}/config/${field}`,
        reason: `${reason} Nothing has stopped: tunnels already running are independent of this daemon.`,
      },
    });

    if (config.auth !== undefined && secretText(config.auth.password) === '') {
      return refuse(
        'auth/password',
        `Tunnel "${context.tunnel.name}" is set to sign in and its password is empty. A proxy handed ` +
          'an empty password refuses the session and nothing in the configuration looks wrong — so ' +
          'either type the password or turn the sign-in off.',
      );
    }

    if (config.tlsCertificate !== undefined && config.tlsCertificate.length > 0) {
      // Not a parser: only that a PEM block was opened somewhere. Anything stricter would be a second
      // implementation of what the core already does, and the two would disagree eventually.
      const opensPem = config.tlsCertificate.some((line) => line.trimStart().startsWith('-----BEGIN'));
      if (!opensPem) {
        return refuse(
          'tlsCertificate',
          `Tunnel "${context.tunnel.name}" gives a certificate with no "-----BEGIN" line in it, so it ` +
            'is not PEM and the core will refuse to start with it. Paste the certificate whole, ' +
            'including its first and last lines.',
        );
      }
    }

    return {
      ok: true,
      plan: {
        target: 'outbounds',
        object: proxyOutbound(config),
        files: [],
        units: [],
        interfaces: [],
        // No `carrier`: there is only one possible carrier, and an entry with no choice to make
        // states nothing rather than inventing a sentence about it.
      },
    };
  },

  liveness: sessionLessLiveness,
  failsClosed: sessionLessFailsClosed,
};
