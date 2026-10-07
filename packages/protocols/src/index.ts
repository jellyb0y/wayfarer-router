/**
 * What this package is, after the catalogue.
 *
 * It held a **plugin contract**: `TunnelProvider`, with `schema()`, `plan()`, `probe()` and
 * `requires()`, plus the eight types those methods took and returned. The argument it existed for was
 * that a tunnel which is a plain proxy-core outbound needs no provider and no code, so a protocol the
 * core gains would appear in the interface without a change anywhere — and providers would exist only
 * for the shapes that are not plain outbounds.
 *
 * **That interface was never implemented.** Not once, by anything, in either direction: no provider was
 * ever written against it, and the daemon's emission path grew its own shapes beside it. It sat here as
 * an argument rather than a mechanism, which is the same failure as an unread annotation — a declaration
 * nothing reaches is worth exactly what a missing one is worth.
 *
 * The argument itself was answered elsewhere, and against it: zero code per protocol did not remove the
 * per-protocol work, it relocated that work into the owner's configuration, where it was neither typed
 * nor tested nor reviewed. See
 * [04-tunnels-and-protocols](../../../docs/04-tunnels-and-protocols.md). A tunnel's shape is now a
 * catalogue entry in the daemon, half of it declared in `@wayfarer/schemas` and half in
 * `apps/daemon/src/core/catalogue`, and it is joined by the compiler.
 *
 * What is left here is the machinery that is still used and still earns its place: reading a schema this
 * project did not write, resolving a branch of it, finding the secrets in it, and validating a document
 * against it. All four are about **foreign** input — a binary's own schema, a subscription link — which
 * is the one place in this project where imperative code is the right answer.
 *
 * `registry.ts` is gone with E5. It had survived the catalogue holding one provider id, for one consumer:
 * the subscription route, which tagged its drafts with it. Those drafts were the last shape in this
 * product that named something schema 7 has no branch for — nothing could store one — so translating the
 * parsers into catalogue configurations took the tag's last reader, and the tag with it.
 */

export * from './json.ts';
export * from './resolver.ts';
export * from './secret-detection.ts';
export * from './validate.ts';

/* ── subscription links ──────────────────────────────────────────────────────────────────── */

export {
  BUILT_IN_PARSERS,
  RECOGNISED_NOT_RUN,
  decodeSubscriptionBody,
  diffSubscription,
  nodeIdentity,
  nodeName,
  parseSubscription,
  safeExcerpt,
  tryBase64,
  type ParsedNode,
  type RecognisedScheme,
  type SubscriptionDiff,
  type SubscriptionFailure,
  type SubscriptionParser,
  type SubscriptionResult,
} from './subscriptions.ts';
