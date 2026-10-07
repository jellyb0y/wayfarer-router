/**
 * Where the secrets in a profile are.
 *
 * ## A correction, and the reasoning that has to be kept
 *
 * This file used to consult the provider registry, and it said so at length: a tunnel's `config` was
 * an opaque record belonging to a provider, so reducing the *static* profile schema to matchers
 * produced pointers for `/accessPoint/passphrase` and **nothing at all** for `/tunnels/-/config/*`.
 * The consequence was measured and it was serious — a VLESS `uuid` stored bare, returned by `GET`,
 * and shipped in clear by the export that exists to be shared. It ended with a rule in this file's
 * own words: *there is deliberately no exported helper that returns "just the static matchers",
 * because that is precisely the value the previous code computed and the whole defect was using it.*
 *
 * **That rule is now removed on purpose, and it is removed because its premise is gone.** Schema
 * version 7 makes a tunnel a union of typed catalogue configurations, so every credential a tunnel
 * can hold is declared with `Secret()` in a schema this repository owns. Measured against the v7
 * document schema, the static walk yields:
 *
 * ```
 * /tunnels/-/config/profile            config-blob
 * /tunnels/-/config/auth/password      password
 * /tunnels/-/config/entryPoints/-/uid  token
 * /tunnels/-/config/id                 uuid
 * /tunnels/-/config/encryption         private-key
 * ```
 *
 * The third of those is the `uid` that leaked from five obfuscation entry points, and the static
 * schema now covers it. The old rule was correct against an opaque `config` and is exactly backwards
 * against a typed one.
 *
 * The general lesson, which is worth more than either version of this file: **a guard built against
 * one shape of risk becomes an obstacle when the shape changes.** Insisting the registry be
 * consulted stopped being a defence against leaking secrets and became a reason a profile could not
 * be *saved* on a device with no core — a refusal with no remaining cause, blocking configuration
 * because of an unrelated missing binary. Recorded in
 * [16-implementation-notes](../../../../docs/16-implementation-notes.md).
 *
 * ## What this is now
 *
 * The matchers for a document, from the document schema and nothing else. It remains a type rather
 * than a bare function because the store takes one and every caller therefore gets the same answer;
 * there is no longer a second kind of plan, so there is no longer a way to get a weaker one.
 */

import { ProfileDocument, secretMatchers, type SecretKind, type SecretMatcher } from '@wayfarer/schemas';

/** Matchers for one document. */
export type SecretMatchers = Map<SecretMatcher, SecretKind>;

export interface SecretPlan {
  /**
   * Every secret position in this document.
   *
   * Still takes the document, although the answer no longer depends on it: the matchers use `/-` for
   * "any element", so one map describes every profile. Kept as a parameter because the store's
   * contract is per-document and a signature that stops needing its argument is a signature somebody
   * will re-derive from the wrong place later.
   */
  forDocument(document: unknown): SecretMatchers;
}

/** Computed once. The document schema does not change under a running process. */
const MATCHERS: SecretMatchers = secretMatchers(ProfileDocument);

export function createSecretPlan(): SecretPlan {
  return {
    // A copy, so a caller that mutates what it was given cannot narrow the coverage for every other
    // caller in the process. The map is small and this happens once per write.
    forDocument: () => new Map(MATCHERS),
  };
}
