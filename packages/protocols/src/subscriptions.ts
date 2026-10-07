/**
 * Subscription links: the one place in this project where imperative code is the right answer.
 *
 * Everywhere else a protocol's shape comes from the schema the installed binary emits, and adding a
 * protocol costs nothing. Subscription link formats are the exception, and the reason is that **they are
 * not specified anywhere**. They differ between clients, several are base64-wrapped JSON, and most have
 * client-specific variants. No schema can be derived from a format nobody wrote down, so this is parsing,
 * and parsing is code.
 *
 * The shape is a registry: one parser per scheme, each with a test predicate and a parse function,
 * normalising into a **catalogue configuration** — the same `{ protocol, config }` pair a tunnel is made
 * of. That keeps the imperative part contained: a new link format is one parser and its fixtures, and
 * nothing else in the project learns about it.
 *
 * ## The catalogue is the destination, and that is what makes a draft storable
 *
 * These parsers used to emit the proxy core's own outbound object, and **nothing in this product could
 * store one**. Schema 7 is a union with one branch per catalogue entry and no branch for a core outbound,
 * so `POST /api/subscriptions/parse` returned drafts whose only possible fate was a refusal at the write.
 * *Outside the catalogue there is nothing* was true of import and of storage and false here, which is the
 * same rule broken from the other end.
 *
 * The consequence is that **one scheme survives as a parser**. OpenVPN and Cloak + OpenVPN arrive as an
 * `.ovpn` file, never as a link, so of the three catalogue entries only VLESS has a link form. The other
 * five schemes keep their predicates and lose their bodies, so that a `vmess://` line is refused *by
 * name* rather than falling into "nothing here parses that", which reads as missing coverage instead of a
 * decision.
 *
 * ## What these parsers are, and are not, evidence of
 *
 * **Every fixture here is synthetic.** They encode what this project *believes* each format to be, from
 * the structure the schemes are documented and widely used with — they are **not** captures of links
 * produced by a real provider. That distinction is load-bearing and is repeated in the test names: a
 * fixture encodes what we believed, and the tool encodes what is true, and when those disagree the
 * fixture is wrong while the test suite stays green.
 *
 * So the honest claim is narrow: these parsers handle the shapes described below, and they refuse rather
 * than guess on anything else. The first real subscription this meets will almost certainly produce a
 * variant that is not here, and that is expected — which is why an unparseable line is reported with its
 * scheme and its position rather than skipped. "Skipping unsupported format" is the failure mode this
 * design exists to avoid.
 *
 * ## Credentials
 *
 * A parsed configuration contains real credentials — a VLESS account is one. It is returned **unwrapped**,
 * exactly as the schema declares them, because wrapping is the storage layer's job and it derives its
 * matchers from the catalogue's schemas at the write. Nothing here may log a parsed object.
 *
 * ## Every refusal names what is accepted
 *
 * A refusal saying only what was rejected is a riddle. Every one below ends with the catalogue, or with
 * the list of values the field takes, so that a person whose link did not take learns what to do next
 * from the one line they were given rather than from documentation they have to go and find.
 */

import {
  TUNNEL_CONFIGS,
  TUNNEL_PROTOCOL_TITLES,
  VlessNetwork,
  VlessSecurity,
  tunnelProtocolList,
  type TunnelDraft,
  type TunnelProtocol,
  type VlessConfig,
} from '@wayfarer/schemas';

import type { JsonSchemaNode } from './json.ts';
import { createValidatorCache } from './validate.ts';

/**
 * A normalised result: a catalogue draft, plus what the link called itself.
 *
 * `TunnelDraft` is the `{ protocol, config }` pair a stored tunnel is made of, and it is a union rather
 * than a literal beside a record — so a consumer that switches on the protocol gets the configuration
 * typed, and a parser cannot hand back a VLESS literal beside an OpenVPN configuration. That pairing is
 * what schema 7 exists to make unstateable, and a draft is one profile write away from being a document.
 *
 * The configuration is additionally checked against `TUNNEL_CONFIGS[protocol]` by `parseSubscription`
 * before it is returned, because the compiler cannot see the schema's *bounds*: a 300-character path
 * from a real provider type-checks and cannot be stored, which would reproduce the defect this file was
 * rewritten to remove, arriving from data instead of from code.
 */
export type ParsedNode = {
  /** The scheme that produced it, for reporting and for tests. */
  scheme: string;
  /**
   * The name the link carried, from its fragment. Used as the tunnel's display name, never as its id:
   * a provider's label is arbitrary text and an id has to satisfy the identifier rules.
   */
  label: string | null;
} & TunnelDraft;

export interface SubscriptionParser {
  id: string;
  /** The catalogue entry every node from this parser becomes. */
  protocol: TunnelProtocol;
  test(line: string): boolean;
  /** Throws on a line it cannot parse. The registry turns that into a reported failure with context. */
  parse(line: string): ParsedNode;
}

/** A scheme recognised only so that it can be refused by name. See `RECOGNISED_NOT_RUN`. */
export interface RecognisedScheme {
  id: string;
  /** What a person calls it, for the refusal to use. */
  name: string;
  test(line: string): boolean;
}

export interface SubscriptionFailure {
  /** One-based, so it matches what a person counting lines in a pasted blob would say. */
  line: number;
  /** The scheme if one was recognisable, so the report says "a vless link" rather than "a line". */
  scheme: string | null;
  reason: string;
  /**
   * The offending text, **truncated and with any userinfo removed**.
   *
   * A link is a credential. An error message that quoted one verbatim would put it in a log, in an API
   * response and on a screen — which is precisely what the redaction rules exist to prevent, arriving
   * through an error path where nobody is looking for it.
   */
  excerpt: string;
}

export interface SubscriptionResult {
  nodes: ParsedNode[];
  failures: SubscriptionFailure[];
  /** True when the body as a whole was base64, which is the common case and worth reporting. */
  wasBase64: boolean;
}

/* ── the body ────────────────────────────────────────────────────────────────────────────── */

/**
 * Decodes a subscription body, which is usually base64 and sometimes not.
 *
 * Detected by trying rather than by inspecting: a base64 blob of links and a plain list of links are both
 * printable ASCII, so a heuristic on the characters present cannot separate them. Decoding and checking
 * whether the result contains a scheme we recognise is a direct test of the thing that matters.
 *
 * Both alphabets are accepted. Providers use standard and URL-safe base64 interchangeably and some omit
 * the padding, so a decoder that insisted on one form would reject a body for a reason unrelated to its
 * contents.
 */
export function decodeSubscriptionBody(text: string): { body: string; wasBase64: boolean } {
  const trimmed = text.trim();
  if (trimmed === '') return { body: '', wasBase64: false };

  // Already a list of links: nothing to decode.
  if (SCHEME_PATTERN.test(trimmed)) return { body: trimmed, wasBase64: false };

  const decoded = tryBase64(trimmed);
  if (decoded !== null && SCHEME_PATTERN.test(decoded)) return { body: decoded, wasBase64: true };

  // Neither. Returned as-is so the per-line parse reports what is actually wrong, rather than this
  // function inventing a diagnosis about encoding for a body that may simply be a wrong paste.
  return { body: trimmed, wasBase64: false };
}

/**
 * Which schemes make a body look like a subscription.
 *
 * It still lists the five this product refuses, and that is deliberate: a base64 body of `vmess://`
 * links must still be *decoded*, so that the answer is five refusals each naming its line, rather than
 * one message about a body that did not look like a subscription. Detecting the wrapper and running the
 * catalogue are different questions and this one is the wider of the two.
 */
const SCHEME_PATTERN = /(^|\n)\s*(vless|vmess|ss|trojan|hysteria2|hy2|tuic):\/\//i;

/**
 * Parses a whole subscription.
 *
 * Every line is attempted and every failure is reported with its position. A subscription with one bad
 * line out of forty yields thirty-nine nodes and one named failure — not an exception, because refusing
 * the whole body would make one provider's oddity block a configuration that is otherwise fine, and not
 * a silent skip, because a node that vanishes without a word is how somebody ends up with a routing
 * policy pointing at nothing.
 */
export function parseSubscription(
  text: string,
  parsers: readonly SubscriptionParser[] = BUILT_IN_PARSERS,
  recognised: readonly RecognisedScheme[] = RECOGNISED_NOT_RUN,
): SubscriptionResult {
  const { body, wasBase64 } = decodeSubscriptionBody(text);
  const nodes: ParsedNode[] = [];
  const failures: SubscriptionFailure[] = [];

  body.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const report = (scheme: string | null, reason: string): void => {
      failures.push({ line: index + 1, scheme, reason, excerpt: safeExcerpt(line) });
    };

    const parser = parsers.find((candidate) => candidate.test(line));
    if (parser === undefined) {
      // Recognised-and-refused first, so the answer names the scheme and the catalogue rather than
      // reading as a gap in coverage. The two are different things and a person cannot tell them apart
      // from "no parser here handles this".
      const known = recognised.find((candidate) => candidate.test(line));
      if (known !== undefined) {
        report(known.id, `a ${known.name} link names something this product does not run. ${CATALOGUE_SENTENCE}`);
        return;
      }
      const scheme = schemeOf(line);
      report(
        scheme,
        scheme === null
          ? `this line is not a link. ${CATALOGUE_SENTENCE}`
          : `nothing here parses a ${scheme} link. ${CATALOGUE_SENTENCE}`,
      );
      return;
    }

    let node: ParsedNode;
    try {
      node = parser.parse(line);
    } catch (error) {
      report(parser.id, error instanceof Error ? error.message : String(error));
      return;
    }

    /*
     * The draft is checked against the schema that will have to accept it.
     *
     * A parser that drifts from its catalogue entry, and a link whose values exceed the bounds the
     * entry sets, produce the same thing: a draft nothing can store. That was the defect this file was
     * rewritten to remove, and leaving the check to the profile write would move it two layers away
     * from the line number and the excerpt that make it diagnosable.
     */
    const invalid = configFault(node);
    if (invalid !== null) {
      report(parser.id, invalid);
      return;
    }
    nodes.push(node);
  });

  return { nodes, failures, wasBase64 };
}

/**
 * The first reason a parsed configuration would not be accepted by its own catalogue entry, or null.
 *
 * Compiled once per catalogue entry and cached, because these schemas change only when this repository
 * does — and compiling is not free on the board this runs on.
 */
function configFault(node: ParsedNode): string | null {
  const schema = TUNNEL_CONFIGS[node.protocol];
  const result = CATALOGUE_VALIDATORS.forSchema(
    `catalogue\u0000${node.protocol}`,
    () => schema as unknown as JsonSchemaNode,
  ).validate(node.config as Record<string, unknown>);
  if (result.valid) return null;

  const issue = result.issues[0];
  if (issue === undefined) return 'this link produced a configuration this product cannot store';
  // The pointer names the field; without it the reason is true and unactionable.
  const where = issue.pointer === '' ? 'the configuration' : `"${issue.pointer.replace(/^\//, '')}"`;
  const allowed = issue.allowed === undefined ? '' : ` (accepted: ${issue.allowed.join(', ')})`;
  return `this link produced a configuration this product cannot store: ${where} ${issue.message}${allowed}`;
}

const CATALOGUE_VALIDATORS = createValidatorCache();

/* ── comparing one refresh against the last ──────────────────────────────────────────────── */

export interface SubscriptionDiff {
  /** Nodes present now and not before, by the identity below. */
  added: ParsedNode[];
  /** Nodes that were there and are not any more. */
  vanished: string[];
  /** Nodes whose identity is unchanged. */
  unchanged: string[];
}

/**
 * What changed between two refreshes.
 *
 * Identity is **server, port and protocol**, deliberately not the label: a provider renames nodes freely,
 * and treating a rename as "one node vanished and another appeared" would produce a warning on every
 * refresh — and a warning that is usually wrong teaches people to ignore warnings.
 *
 * This exists for one rule: a refresh must never silently change *which* endpoint the policy prefers. If
 * a node the priority order names disappears, the stored node is kept, the tunnel keeps working, and the
 * interface reports that the subscription no longer offers it. Re-pointing the policy is a decision, not
 * a side effect of a background fetch.
 */
export function diffSubscription(previous: ParsedNode[], next: ParsedNode[]): SubscriptionDiff {
  const before = new Map(previous.map((node) => [nodeIdentity(node), node]));
  const after = new Map(next.map((node) => [nodeIdentity(node), node]));

  return {
    added: [...after.entries()].filter(([key]) => !before.has(key)).map(([, node]) => node),
    vanished: [...before.keys()].filter((key) => !after.has(key)),
    unchanged: [...after.keys()].filter((key) => before.has(key)),
  };
}

/**
 * `protocol://server:port`. Stable across a rename, which is the point.
 *
 * Two fields rather than a function per catalogue entry, and that is not laziness: an entry that does
 * not name an endpoint in `server` and `port` is an entry no link produces. OpenVPN carries its remotes
 * inside the `.ovpn` file, which is why it arrives as a file and not as a subscription line — so a
 * catalogue entry reachable from here always has these two.
 */
export function nodeIdentity(node: ParsedNode): string {
  const endpoint = endpointOf(node);
  return `${node.protocol}://${endpoint.server}:${endpoint.port}`;
}

/**
 * What to call a node when the provider's label is missing or empty.
 *
 * Here rather than at the route, because it reads the configuration and the reasoning about which
 * catalogue entries have an endpoint belongs beside `nodeIdentity`, not duplicated wherever a name is
 * wanted. A label is a display name and never an id: arbitrary text cannot satisfy the identifier rules.
 */
export function nodeName(node: ParsedNode): string {
  if (node.label !== null && node.label.trim() !== '') return node.label;
  return `${TUNNEL_PROTOCOL_TITLES[node.protocol]} ${endpointOf(node).server}`;
}

function endpointOf(node: ParsedNode): { server: string; port: string } {
  const config = node.config as { server?: unknown; port?: unknown };
  return { server: String(config.server), port: String(config.port) };
}

/* ── the parsers ─────────────────────────────────────────────────────────────────────────── */

/**
 * The catalogue in one sentence, for a refusal to end with.
 *
 * **Every refusal in this module names both what it rejected and what is accepted.** A refusal that
 * names only the first is a riddle: the person whose link did not take has to go and read
 * documentation to learn what would have. Derived from the catalogue rather than written out, so an
 * addition cannot leave this sentence stale.
 */
const CATALOGUE_SENTENCE =
  `This product runs ${tunnelProtocolList()}, and of those only VLESS arrives as a link — ` +
  'OpenVPN and Cloak + OpenVPN are an .ovpn file, plus its entry points for Cloak.';

/**
 * The values `network` and `security` take, read **off the schemas** rather than written out again.
 *
 * Two lists of the same set drift, and the one that drifts is whichever was not updated. Here the cost
 * of drift is specific: a refusal that names a value the schema accepts, or accepts one it does not, and
 * the second produces a draft nothing can store.
 */
const VLESS_NETWORKS = literalsOf(VlessNetwork);
const VLESS_SECURITIES = literalsOf(VlessSecurity);

function literalsOf(union: { anyOf: readonly { const: unknown }[] }): readonly string[] {
  return union.anyOf.map((entry) => String(entry.const));
}

/** `a, b or c` — a list a person reads, for a refusal that has to say what is accepted. */
function orList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]!}`;
}

/**
 * VLESS. `vless://<uuid>@<host>:<port>?<params>#<label>`, into `TUNNEL_CONFIGS.vless`.
 *
 * The query carries transport and TLS under the names the wider ecosystem uses — `type` for the
 * transport, `security` for TLS, `sni` for the presented name, `pbk`/`sid` for REALITY — and
 * translating those into the catalogue's field names is the whole job.
 *
 * **What this parser used to produce, and why that was a defect rather than a difference.** It
 * emitted a proxy-core outbound: `{ type, server, server_port, uuid, tls: {…}, transport: {…} }`.
 * Nothing in this product can store one. Schema 7 has a branch per catalogue entry and no branch for
 * a core outbound, so `POST /api/subscriptions/parse` handed back drafts whose only possible fate was
 * refusal at the write. A parser whose output nothing can save is *outside the catalogue there is
 * nothing*, broken from the other end — which is why translating them is E5 and not tidying.
 */
const vless: SubscriptionParser = {
  id: 'vless',
  protocol: 'vless',
  test: (line) => /^vless:\/\//i.test(line),
  parse(line) {
    const url = asUrl(line, 'vless');
    const account = decodeURIComponent(url.username);
    if (account === '') throw new Error('a vless link must carry a UUID before the @');

    refuseInsecure(url);

    const config: Record<string, unknown> = {
      server: hostOf(url),
      port: portOf(url),
      // In VLESS the account *is* the credential. Returned in clear, like every other value here: the
      // caller has to be able to check what they pasted, and the storage wrapper goes on at the write.
      id: account,
      network: networkOf(url),
      security: securityOf(url),
    };

    // `none` is the absence of the feature spelled out. Carrying it would make an ordinary account
    // look like one the proxy core cannot run — and the carrier decision reads exactly this field.
    const encryption = url.searchParams.get('encryption');
    if (encryption !== null && encryption !== '' && encryption !== 'none') config['encryption'] = encryption;

    put(config, 'flow', url.searchParams.get('flow'));
    put(config, 'serverName', serverNameOf(url));
    put(config, 'fingerprint', url.searchParams.get('fp'));
    put(config, 'path', url.searchParams.get('path'));
    put(config, 'host', url.searchParams.get('host'));

    const alpn = url.searchParams.get('alpn');
    if (alpn !== null && alpn !== '') {
      config['alpn'] = alpn.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
    }

    if (config['security'] === 'reality') {
      put(config, 'realityPublicKey', url.searchParams.get('pbk'));
      put(config, 'realityShortId', url.searchParams.get('sid'));
    }

    // The one cast in this file, and it is backed rather than asserted: `parseSubscription` validates
    // every draft against this same schema before a caller sees it, and reports a failure when it does
    // not hold. A cast with a runtime check behind it is a different thing from a cast instead of one.
    return { scheme: 'vless', label: labelOf(url), protocol: 'vless', config: config as VlessConfig };
  },
};

/** Sets a field when the link actually carried it. An absent field is not an empty one. */
function put(config: Record<string, unknown>, key: string, value: string | null): void {
  if (value !== null && value !== '') config[key] = value;
}

/** The presented name, under either of the two spellings producers use for it. */
function serverNameOf(url: URL): string | null {
  const name = url.searchParams.get('sni') ?? url.searchParams.get('peer');
  return name === null || name === '' ? null : name;
}

/**
 * The transport, refused by name when it is not one of the five.
 *
 * The old code carried an unrecognised transport through untyped, on the reasoning that the core
 * would say what was wrong with it more precisely than a guess here could. Under the catalogue that
 * reasoning inverts: an unrecognised transport produces a configuration nothing can store, so the
 * refusal has to happen here, where the link and the line number are still in hand.
 *
 * `h2` is the same transport as `http` under an older spelling, which is a translation rather than a
 * guess.
 */
function networkOf(url: URL): string {
  const asked = (url.searchParams.get('type') ?? '').toLowerCase();
  if (asked === '') return 'tcp';
  const normalised = asked === 'h2' ? 'http' : asked;
  if (!VLESS_NETWORKS.includes(normalised)) {
    throw new Error(
      `this link asks for the transport "${asked}", which this product does not run. ` +
        `A VLESS link may use ${orList(VLESS_NETWORKS)}.`,
    );
  }
  return normalised;
}

function securityOf(url: URL): string {
  const asked = (url.searchParams.get('security') ?? '').toLowerCase();
  // A bare `sni` with no `security` is common, and means TLS in every producer that emits it.
  if (asked === '') return serverNameOf(url) === null ? 'none' : 'tls';
  if (!VLESS_SECURITIES.includes(asked)) {
    throw new Error(
      `this link asks for "${asked}" transport security, which this product does not run. ` +
        `A VLESS link may use ${orList(VLESS_SECURITIES)}.`,
    );
  }
  return asked;
}

/**
 * Refuses a link that asks for certificate verification to be turned off.
 *
 * The parameter exists in the wild and the old parser carried it into a `tls.insecure` flag. There is
 * no field for it in the catalogue, and this is a **decision rather than an omission**: a switch that
 * stops checking the server is who it claims to be removes the one guarantee that distinguishes a
 * tunnel from a pipe to whoever answered. Such a thing gets added because the owner asked for it in
 * his own words, knowing the price — not because a parameter turned up in somebody else's link and we
 * accommodated it. Dropping it silently was the other option and is worse: a configuration that looks
 * complete and fails certificate verification, for a reason the link stated and the product discarded.
 */
function refuseInsecure(url: URL): void {
  const asked = ['allowInsecure', 'insecure'].find((name) => {
    const value = url.searchParams.get(name);
    return value === '1' || value?.toLowerCase() === 'true';
  });
  if (asked === undefined) return;
  throw new Error(
    `this link sets ${asked}, which turns off checking that the server is who it claims to be. ` +
      'This product has no such switch, and adding one is a decision about what the product does ' +
      'rather than a consequence of reading a link. A link whose certificate verifies is taken as it stands.',
  );
}

/**
 * **The parsers. One, because the catalogue offers one thing that arrives as a link.**
 *
 * Epic F adds Shadowsocks, and on that day this list gains an entry while the list below loses one.
 */
export const BUILT_IN_PARSERS: readonly SubscriptionParser[] = [vless];

/**
 * Schemes this module **recognises in order to refuse them by name.**
 *
 * Their parse bodies are deleted; their predicates are not, and that difference is the whole reason
 * this list exists. A scheme with no entry here falls through to *nothing here parses a … link*,
 * which reads as missing coverage — a gap somebody might one day fill in. These five are not a gap.
 * They are a product decision, and a refusal naming the scheme and the catalogue in one breath says
 * so. Deleting them outright would make the two indistinguishable, which is the confusion this
 * project has now found in four separate places wearing four different costumes.
 *
 * These are exactly the shapes the old core-outbound parsers handled. Shadowsocks returns as a
 * catalogue entry in Epic F.
 */
export const RECOGNISED_NOT_RUN: readonly RecognisedScheme[] = [
  { id: 'vmess', name: 'VMess', test: (line) => /^vmess:\/\//i.test(line) },
  { id: 'shadowsocks', name: 'Shadowsocks', test: (line) => /^ss:\/\//i.test(line) },
  { id: 'trojan', name: 'Trojan', test: (line) => /^trojan:\/\//i.test(line) },
  { id: 'hysteria2', name: 'Hysteria 2', test: (line) => /^(hysteria2|hy2):\/\//i.test(line) },
  { id: 'tuic', name: 'TUIC', test: (line) => /^tuic:\/\//i.test(line) },
];

/* ── shared pieces ──────────────────────────────────────────────────────────────────────── */

function asUrl(line: string, scheme: string): URL {
  let url: URL;
  try {
    url = new URL(line);
  } catch {
    throw new Error(`not a usable ${scheme} URI`);
  }
  if (url.hostname === '') throw new Error(`the ${scheme} link has no host`);
  return url;
}

/** The host, with IPv6 brackets removed: they are URI syntax, and the core wants the address. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function portOf(url: URL): number {
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('the link has no usable port, and a default must not be invented for it');
  }
  return port;
}

function labelOf(url: URL): string | null {
  const fragment = url.hash.replace(/^#/, '');
  if (fragment === '') return null;
  return safeDecode(fragment);
}

/**
 * Base64 in either alphabet, with or without padding, or null when it is not base64 at all.
 *
 * Returns null rather than throwing because callers use it as a *test*: "is this a base64 blob?" is
 * answered by trying, since a base64 body and a plain one are both printable ASCII.
 */
export function tryBase64(value: string): string | null {
  const cleaned = value.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (cleaned === '' || /[^A-Za-z0-9+/=]/.test(cleaned)) return null;
  const padded = cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, '=');
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    // A decode that produced replacement characters decoded something that was not text, which for this
    // purpose means it was not base64-encoded text.
    return decoded === '' || decoded.includes('�') ? null : decoded;
  } catch {
    return null;
  }
}

function schemeOf(line: string): string | null {
  return /^([a-z0-9+.-]+):\/\//i.exec(line)?.[1]?.toLowerCase() ?? null;
}

/**
 * A quotable fragment of a link, with the credentials taken out.
 *
 * A subscription link **is** a credential. An error that quoted one verbatim would put it into a log, an
 * API response and a screen — through an error path, where nobody is looking for a leak. So the userinfo
 * is replaced and the rest is truncated.
 */
export function safeExcerpt(line: string, limit = 80): string {
  const withoutUserinfo = line.replace(/^([a-z0-9+.-]+:\/\/)[^@/?#]*@/i, '$1<redacted>@');
  // For the base64 forms there is no `@` to find, and the whole payload is the secret — so anything that
  // still has no recognisable structure is reduced to its scheme alone.
  const scheme = schemeOf(line);
  const safe = withoutUserinfo.includes('<redacted>') ? withoutUserinfo : `${scheme ?? 'unknown'}://<redacted>`;
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A label with a stray percent sign is not a reason to reject a node. The raw text is a better answer
    // than a failure, because the label is only ever shown to a person.
    return value;
  }
}
