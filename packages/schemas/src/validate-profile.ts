/**
 * The profile schema, **applied**.
 *
 * `profile.ts` says a document naming something outside the catalogue "matches no branch at all —
 * which is what makes the refusal in E5 a consequence of the schema rather than a check somebody
 * remembered to write." That sentence describes a property of the schema object. It was not a
 * property of the system, because **nothing ran the schema against a document being written.** The
 * three write routes declared `body: Type.Unknown()`, and the only thing between a request and the
 * database was a four-key structural check whose own comment claimed Fastify was compiling the
 * union for request bodies. It was not: a body schema of `Unknown` compiles to a validator that
 * accepts everything, and `PUT /api/profiles/:id` with `protocol: "wireguard"` answered 200.
 *
 * This module is what makes that sentence true. It is the schema, run.
 *
 * ## Three passes, in this order, and each stops the next
 *
 * 1. **The protocol.** A tunnel naming something the catalogue does not have is E5's refusal, and it
 *    has to come first because it is the only one that can name *what is accepted*. Handed to
 *    TypeBox instead, the same document produces `Expected union value` at `/tunnels/0` — true,
 *    unactionable, and silent about the three protocols that would have worked.
 * 2. **Each tunnel**, against the one union branch its protocol names. Also ahead of the document
 *    pass, and for the same reason: `Tunnel` is a union, and a union reports its failure at the
 *    union — `Expected union value` at `/tunnels/0`, which is true, unactionable, and identical for
 *    a missing `onUnavailable` and a malformed server address. Once the protocol is known there is
 *    exactly one branch it could have matched, so validating against that branch alone puts the
 *    pointer on the field that caused it.
 * 3. **The whole document**, for everything that is not a tunnel.
 *
 * ## Secrets are normalised first, and that is not a loophole
 *
 * The canonical schema holds a plain string at a secret position; storage holds `{"$secret": …}`
 * and an imported redacted export holds `{"$redacted": …}`. All three are correct documents at
 * different moments, so a validator that knew only the first would refuse every stored profile and
 * every redacted import — the second of which is a designed feature, with `missingSecrets` as its
 * report. The wrappers are therefore read *through*, at secret positions only, located by the same
 * matchers redaction uses. A `{"$redacted"}` anywhere else is still a value of the wrong type.
 */

import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { ProfileDocument, TUNNEL_BRANCHES } from './profile.ts';
import { TUNNEL_CONFIGS, isTunnelProtocol, tunnelProtocolList, type TunnelProtocol } from './tunnel-configs.ts';
import { secretMatchers, unwrapForValidation } from './secret-transforms.ts';
import { isRecord } from './secrets.ts';

/**
 * One reason a document cannot be stored, in the API's own error vocabulary.
 *
 * `hint` is not optional here for the reason the error contract gives: on a device where a wrong
 * configuration costs access, an error that does not say what to do instead is half an error.
 */
export interface ProfileFault {
  code: string;
  message: string;
  /** JSON Pointer into the document that was submitted. */
  pointer: string;
  hint: string;
  detail?: Record<string, unknown>;
}

/** A write refused because the document is not one this schema describes. */
export class ProfileInvalidError extends Error {
  readonly faults: ProfileFault[];

  constructor(faults: ProfileFault[]) {
    super(faults[0]?.message ?? 'this document is not a profile');
    this.name = 'ProfileInvalidError';
    this.faults = faults;
  }
}

/** At most this many schema complaints are reported at once; a form shows fields, not a novel. */
const MAX_FAULTS = 20;

/**
 * Every reason this document could not be stored, or an empty list.
 *
 * Accepts a document with its secrets in any of the three legitimate shapes; see the note above.
 */
export function profileFaults(document: unknown): ProfileFault[] {
  if (!isRecord(document)) {
    return [
      {
        code: 'invalid_request',
        message: 'a profile must be a JSON object',
        pointer: '',
        hint: 'Start from POST /api/profiles with no body, which returns a complete empty profile.',
      },
    ];
  }

  const protocolFaults = tunnelProtocolFaults(document);
  if (protocolFaults.length > 0) return protocolFaults;

  const branchFaults = tunnelBranchFaults(document);
  if (branchFaults.length > 0) return branchFaults;

  return documentFaults(document);
}

/** Throws unless the document is one this schema describes. The single gate on a write. */
export function assertProfileDocument(document: unknown): void {
  const faults = profileFaults(document);
  if (faults.length > 0) throw new ProfileInvalidError(faults);
}

/* ── 1. the protocol, which is E5 ────────────────────────────────────────────────────────── */

function tunnelProtocolFaults(document: Record<string, unknown>): ProfileFault[] {
  const tunnels = document['tunnels'];
  if (!Array.isArray(tunnels)) return [];

  const faults: ProfileFault[] = [];
  tunnels.forEach((tunnel, index) => {
    if (!isRecord(tunnel)) {
      faults.push({
        code: 'invalid_request',
        message: `tunnel ${index + 1} is not an object`,
        pointer: `/tunnels/${index}`,
        hint: 'A tunnel is an object with an id, a protocol and a configuration for that protocol.',
      });
      return;
    }
    const protocol = tunnel['protocol'];
    if (isTunnelProtocol(protocol)) return;

    const named = typeof tunnel['name'] === 'string' && tunnel['name'] !== '' ? tunnel['name'] : tunnel['id'];
    const what = typeof protocol === 'string' && protocol !== '' ? `"${protocol}"` : 'nothing';
    faults.push({
      code: 'tunnel_protocol_unknown',
      message:
        `Tunnel ${typeof named === 'string' ? `"${named}"` : index + 1} names ${what}, which is not ` +
        // Derived, never a second list: the sentence a person is given at the moment they are stuck
        // is exactly the one that must not have drifted from what the device runs.
        `something this product runs. What it runs is ${tunnelProtocolList()}.`,
      pointer: `/tunnels/${index}/protocol`,
      hint:
        `Change this tunnel to one of ${tunnelProtocolList()}, or remove it. Nothing has stopped: ` +
        'tunnels already running are independent of this daemon.',
      detail: { protocol: protocol ?? null, accepted: Object.keys(TUNNEL_CONFIGS) },
    });
  });

  return faults.slice(0, MAX_FAULTS);
}

/* ── 2. each tunnel, against the one branch its protocol names ───────────────────────────── */

function tunnelBranchFaults(document: Record<string, unknown>): ProfileFault[] {
  const tunnels = document['tunnels'];
  if (!Array.isArray(tunnels)) return [];

  const faults: ProfileFault[] = [];
  tunnels.forEach((tunnel, index) => {
    if (!isRecord(tunnel)) return;
    const protocol = tunnel['protocol'];
    if (!isTunnelProtocol(protocol)) return;

    /*
     * A field that existed, by name, before the generic refusal. Every object in this schema refuses a
     * property it does not describe, and TypeBox words that `Unexpected property` — true, and silent
     * about the one thing a person holding an old draft or an old script needs to know: that the field
     * was removed on purpose and nothing replaces it. See `profile-migrations.ts`, step 7.
     */
    if ('probe' in tunnel) {
      faults.push({
        code: 'tunnel_field_removed',
        message:
          'A tunnel no longer takes "probe". Whether a tunnel is alive is asked of its own protocol — an ' +
          "OpenVPN peer's keepalive and gateway, or requests through a VLESS or proxy outbound to neutral " +
          'connectivity checks — and never of something the tunnel carries.',
        pointer: `/tunnels/${index}/probe`,
        hint: 'Remove "probe" from this tunnel. Nothing replaces it; stored profiles lose it by migration.',
      });
      return;
    }

    for (const fault of errorsAgainst(TUNNEL_BRANCHES[protocol], tunnel, `/tunnels/${index}`)) {
      faults.push({ ...fault, code: 'tunnel_invalid' });
    }
  });

  return faults.slice(0, MAX_FAULTS);
}

/**
 * Why a configuration is not one its own catalogue entry would accept.
 *
 * Exported because the *producers* need it as well as the writes: a producer checked only against
 * its own intent is untested where it matters, which is the shape this project already paid for
 * once with `parseSubscription`. `migrateToCatalogue` is the other producer.
 */
export function catalogueConfigFaults(
  protocol: TunnelProtocol,
  config: unknown,
  pointer: string,
): ProfileFault[] {
  const schema = TUNNEL_CONFIGS[protocol];
  return errorsAgainst(schema, config, pointer).map((fault) => ({
    ...fault,
    code: 'tunnel_config_invalid',
    hint: `Correct this field, or remove it. ${fault.hint}`,
  }));
}

/* ── 3. the whole document ───────────────────────────────────────────────────────────────── */

function documentFaults(document: Record<string, unknown>): ProfileFault[] {
  // The four top-level sections are answered first and by name. TypeBox reports them as
  // `Expected required property`, which is correct and tells a person nothing about where a
  // complete document comes from.
  const missing = (['schemaVersion', 'meta', 'network', 'firewall'] as const).filter(
    (key) => !(key in document),
  );
  if (missing.length > 0) {
    return missing.map((key) => ({
      code: 'invalid_request',
      message: `a profile must have "${key}"`,
      pointer: `/${key}`,
      hint: 'Start from POST /api/profiles with no body, which returns a complete empty profile.',
    }));
  }

  return errorsAgainst(ProfileDocument, document, '').map((fault) => ({
    ...fault,
    code: 'invalid_request',
  }));
}

/* ── the validator ───────────────────────────────────────────────────────────────────────── */

function errorsAgainst(schema: TSchema, value: unknown, pointer: string): ProfileFault[] {
  const normalised = unwrapForValidation(value, secretMatchers(schema));
  if (Value.Check(schema, normalised)) return [];

  const faults: ProfileFault[] = [];
  for (const error of Value.Errors(schema, normalised)) {
    faults.push({
      code: 'invalid_request',
      message: error.message,
      pointer: `${pointer}${error.path}`,
      hint: 'The pointer names the field this is about.',
    });
    if (faults.length >= MAX_FAULTS) break;
  }

  // `Value.Check` said no and `Value.Errors` named nothing: a state that must not report "fine".
  if (faults.length === 0) {
    faults.push({
      code: 'invalid_request',
      message: 'this document is not one this schema describes, and the validator could not say where',
      pointer,
      hint: 'Export a working profile and compare the two, or start from POST /api/profiles with no body.',
    });
  }
  return faults;
}
