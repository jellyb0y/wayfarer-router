/**
 * The catalogue's typed configurations: **the fields a person fills, and nothing else.**
 *
 * This file is one half of a catalogue entry — the half the owner meets. The other half (binary,
 * argument vector, configuration file name and format, unit shape, ordering, local-port allocation)
 * lives in the daemon's `core/catalogue/` and is never asked of anybody. The two halves are
 * joined by `TUNNEL_CONFIGS` below: the catalogue is typed as a total map over its keys, so a
 * protocol added here and not there does not compile. That is deliberate — it is the cheapest
 * mechanism that makes the pair impossible to half-add, and it is checked by the compiler rather
 * than by a habit.
 *
 * ## What the entries are named after
 *
 * `OpenVPN`, `Cloak + OpenVPN`, `VLESS` — named after **what the owner holds**, not after what this
 * device starts. The third was called `Xray` until the owner asked why, since Xray is merely the
 * program that runs his VLESS subscription. A catalogue named after what we start is a catalogue
 * named from our side of the product; see
 * [16-implementation-notes](../../../docs/16-implementation-notes.md), *A catalogue named after what
 * we run, not after what the owner has*.
 *
 * The consequence is not a rename. Because the entry is named for the thing rather than the runner,
 * **which runner carries it is not a question the owner can be asked** — it depends on the
 * configuration. So `vless` has no field naming a client. The entry establishes the carrier from the
 * configuration, states the choice and its reason in the plan, and refuses rather than guessing.
 *
 * ## Three fields that left the profile, and why that is the point
 *
 * `command`, `configFile` and `localPort` are gone from every shape here.
 *
 * Measured, from a redacted export of the bench profile taken 2026-09-21: four tunnels, five
 * obfuscation entry points, and every one of them carried its whole client configuration as a JSON
 * document inside a string field called `configFile`, with `command` naming a binary and a flag
 * beside it. That is how a wrong flag stops a client silently, it is how a generated file named
 * `.conf` met a client that infers format from the extension, and it is how five `UID` credentials
 * reached a *redacted* export in clear: one schema marked the field and its twin forty lines below
 * did not, and nothing ever walked the entry points at all.
 *
 * Typing the fields individually is what makes the marks checkable. It is also what lets the port be
 * allocated instead of typed: on the bench the OpenVPN profile blob had to name `127.0.0.1:12294` in
 * its own `remote` line, in step by hand with a `LocalPort` forty lines away in a different string.
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Identifier } from './identifier.ts';
import { Secret } from './secrets.ts';
import { Source } from './source.ts';

/* ── OpenVPN ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The credentials an OpenVPN peer asks for when the profile does not carry a certificate.
 *
 * Optional as a whole rather than two optional fields, because a username without a password is not
 * a state anything can use, and modelling it makes an invariant out of what a shape can say.
 */
const OpenVpnAuth = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 128 }),
    password: Secret({ kind: 'password', description: 'The password for this OpenVPN account.' }),
  },
  { additionalProperties: false, description: 'Only when the server asks for a user name and password.' },
);

/**
 * The fields common to both OpenVPN-bearing entries.
 *
 * Shared by composition rather than by inheritance of a base entry, because `Cloak + OpenVPN` is one
 * catalogue entry and not a composition the owner performs: he chooses the two together because they
 * arrive together, as one `.ovpn` file plus the entry points that front it.
 */
const OpenVpnFields = {
  /**
   * The `.ovpn` file, verbatim.
   *
   * A blob, and marked as one, because it is what the owner was given — asking him to decompose a
   * file his provider generated is asking him to do a job he cannot check. Its `remote` lines are
   * *not* authoritative: the entry writes those, from the entry points it allocated ports for.
   */
  profile: Secret({ kind: 'config-blob', description: 'The contents of the .ovpn file.' }),
  auth: Type.Optional(OpenVpnAuth),
  /**
   * Three characters appended to `wfvpn` to name this tunnel's interface.
   *
   * A person-facing field only because the name shows up in diagnostics the owner reads; when it is
   * absent the entry derives one. It is not the interface name: the 15-character and no-hyphen rules
   * are enforced where the name is made, never here.
   */
  interfaceSuffix: Type.Optional(
    Type.String({
      pattern: '^[a-z0-9]{1,6}$',
      description: 'A short tag for this tunnel’s interface name, for reading diagnostics.',
    }),
  ),
} as const;

/**
 * Every field in a catalogue configuration comes from a person, so the mark sits on the entry and
 * descends. That is this file's stated contract in its own opening line — *the fields a person
 * fills, and nothing else* — and the half a person is never asked about (binary, argument vector,
 * configuration file name and format, unit shape, ordering, local-port allocation) lives in the
 * daemon's `core/catalogue/`, where parity cannot reach it and does not need to.
 *
 * Only `person` descends; an exempting source must be written on the leaf. So a field added here
 * later inherits *a person fills this* and is required until somebody says otherwise, which is the
 * direction that fails loudly. A field belonging to the catalogue rather than the owner does not
 * belong in this file at all.
 */
export const OpenVpnConfig = Source('person', Type.Object(
  { ...OpenVpnFields },
  { additionalProperties: false, $id: 'OpenVpnConfig' },
));
export type OpenVpnConfig = Static<typeof OpenVpnConfig>;

/* ── Cloak + OpenVPN ─────────────────────────────────────────────────────────────────────── */

/**
 * One obfuscated entry point.
 *
 * **This shape is the whole of task E2.** It replaces a three-field record — `{ id, provider,
 * config }` — whose `config` was an opaque blob of a client's JSON plus a command line. Four entry
 * points at different sites is a normal configuration and the bench has exactly that, so the list is
 * the shape and a single entry point is a list of one.
 *
 * Every field here was read off a working configuration on the bench board, 2026-09-21. Nothing is
 * present because a manual documents it.
 */
export const CloakEntryPoint = Type.Object(
  {
    /**
     * Generated by the interface when an entry point is added, exactly as the tunnel, uplink and
     * subscription identifiers are, and consumed as the key that joins an entry point to the
     * outbound it produces. The criterion is the one written in `source.ts`: this product is the
     * only possible author of the value. A person naming a site types `name`, which is the field
     * that exists for it; typing this one would be supplying a key to a table he cannot see.
     *
     * It inherited `person` from the container until 2026-09-21 — the container mark is right and
     * only says *a person fills what is under here unless the leaf says otherwise*, and this leaf
     * now says otherwise.
     */
    id: Source('generated', Identifier),
    /** What the owner calls this site. Shown wherever an entry point is named. */
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    host: Type.String({ minLength: 1, maxLength: 253, description: 'The entry point’s address.' }),
    port: Type.Integer({ minimum: 1, maximum: 65535, default: 443 }),
    /**
     * The account identifier, and a credential despite the name.
     *
     * Marked, and the mark is the reason this file exists. Measured 2026-09-21: five of these reached
     * a **redacted** export in clear, because they lived inside an unmarked `configFile` string and
     * nothing walked the entry points.
     */
    uid: Secret({ kind: 'token', maxLength: 128, description: 'The account identifier from the provider.' }),
    /**
     * The server's public key.
     *
     * **Deliberately not marked.** It is public by construction — the client encrypts to it — and
     * marking things that are not credentials makes a redacted export useless for diagnosing the
     * thing it was exported to diagnose. If that reasoning is ever found to be wrong, the fix is to
     * mark it here, not to mark everything.
     */
    publicKey: Type.String({ minLength: 1, maxLength: 128, description: 'The server’s public key.' }),
    /** The name the provider gave this service on its side. Not a display name. */
    proxyMethod: Type.String({ minLength: 1, maxLength: 64, default: 'openvpn' }),
    encryptionMethod: Type.Union(
      [Type.Literal('plain'), Type.Literal('aes-gcm'), Type.Literal('aes-256-gcm'), Type.Literal('chacha20-poly1305')],
      { default: 'aes-gcm' },
    ),
    /**
     * The domain this connection pretends to be going to.
     *
     * Measured on the bench: `www.microsoft.com`, `api.ok.ru`, `tgproxy2.ok.ru`, `paymenttest3.ok.ru`
     * — four different ones across four entry points of the same tunnel, which is why it is per entry
     * point and not per tunnel.
     */
    serverName: Type.String({ minLength: 1, maxLength: 253 }),
    browserSignature: Type.Union(
      [Type.Literal('chrome'), Type.Literal('firefox'), Type.Literal('safari'), Type.Literal('ios')],
      { default: 'chrome' },
    ),
    /** `cdn` routes through a content network; `direct` reaches the host named above. */
    transport: Type.Union([Type.Literal('direct'), Type.Literal('cdn')], { default: 'direct' }),
    connections: Type.Optional(Type.Integer({ minimum: 1, maximum: 64, default: 4 })),
    streamTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, default: 300 })),
    /** OpenVPN over UDP needs this; the bench runs every entry point with it on. */
    udp: Type.Optional(Type.Boolean({ default: true })),
  },
  { additionalProperties: false, $id: 'CloakEntryPoint' },
);
export type CloakEntryPoint = Static<typeof CloakEntryPoint>;

export const CloakOpenVpnConfig = Source('person', Type.Object(
  {
    ...OpenVpnFields,
    /**
     * Where the obfuscation layer connects, in preference order.
     *
     * The order is data: it becomes the order of the `remote` lines in the generated `.ovpn`, which
     * is the order the client tries them in. Reordering here reorders failover, and nothing else
     * needs to change.
     */
    entryPoints: Type.Array(CloakEntryPoint, { minItems: 1, maxItems: 16 }),
  },
  { additionalProperties: false, $id: 'CloakOpenVpnConfig' },
));
export type CloakOpenVpnConfig = Static<typeof CloakOpenVpnConfig>;

/* ── VLESS ───────────────────────────────────────────────────────────────────────────────── */

/**
 * How the connection is wrapped. Separate from the protocol because a VLESS link carries the two
 * independently, and the carrier decision reads both.
 */
export const VlessNetwork = Type.Union(
  [Type.Literal('tcp'), Type.Literal('ws'), Type.Literal('grpc'), Type.Literal('http'), Type.Literal('quic')],
  { default: 'tcp' },
);

export const VlessSecurity = Type.Union(
  [Type.Literal('none'), Type.Literal('tls'), Type.Literal('reality')],
  { default: 'tls' },
);

/**
 * Marked `person` as a whole, **including the fields a pasted link fills in.**
 *
 * `flow`, `fingerprint`, `security`, `alpn`, `network`, `path` and the two reality fields all arrive
 * pre-filled when the owner pastes a VLESS link, and the pull towards `subscription` is strong: the
 * values did come from somewhere else. They are still his. Pasting a link is a **convenience for
 * filling** the form, not a source of record — he can edit every one of them afterwards, and the
 * cases that need editing are the ordinary ones: a link that omits `fingerprint`, a `serverName`
 * that has to differ from the host, a `path` the provider changed and the link did not.
 *
 * The distinction is *who may overwrite this next*. A `subscription` field is one the next refresh
 * replaces regardless of what anybody typed; these survive editing, because nothing refetches them.
 * (Contrast `/tunnels/-/derivedFrom/*` in the profile document, which a refresh does rewrite and
 * which is marked `subscription` leaf by leaf.)
 *
 * **If the editor is ever changed to lock these after parsing a link, they become `subscription` and
 * must be marked leaf by leaf** — not on this object, because an exempting mark must never be
 * inherited by a field added later. This sentence is here so that change cannot be made silently:
 * locking the fields and leaving the mark would leave parity demanding controls for values nobody
 * may edit, which is a requirement nothing can satisfy, and the reviewer of that diff will be
 * reading the editor rather than this file.
 */
export const VlessConfig = Source('person', Type.Object(
  {
    server: Type.String({ minLength: 1, maxLength: 253 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    /** The account, which in VLESS is the whole credential. */
    id: Secret({ kind: 'uuid', maxLength: 128, description: 'The account id from the link or subscription.' }),
    /**
     * The encryption parameter, when the link carries one.
     *
     * **This field decides the carrier**, and it is why the entry chooses rather than asks. Measured
     * on the bench, 2026-09-21: the fourth tunnel's account carries
     * `encryption: "mlkem768x25519plus.native.0rtt.<key material>"` — post-quantum VLESS encryption,
     * an Xray feature. The proxy core rejects the field outright, so this tunnel cannot be a native
     * outbound and must be carried by an external client on a loopback port. Absent or `none`, the
     * native outbound carries it and no second process runs.
     *
     * Marked as a secret because the value is key material, not a mode name: 1.6 KiB of it on the
     * bench.
     */
    encryption: Type.Optional(
      Secret({ kind: 'private-key', description: 'The encryption parameter from the link, if it has one.' }),
    ),
    /** Present on flow-controlled accounts, e.g. `xtls-rprx-vision`. */
    flow: Type.Optional(Type.String({ maxLength: 64 })),
    network: VlessNetwork,
    security: VlessSecurity,
    /** The name presented in the handshake. Absent means the server address is used. */
    serverName: Type.Optional(Type.String({ maxLength: 253 })),
    /** A TLS client signature to imitate, e.g. `chrome`. */
    fingerprint: Type.Optional(Type.String({ maxLength: 32 })),
    alpn: Type.Optional(Type.Array(Type.String({ maxLength: 16 }), { maxItems: 8 })),
    /** Used when `network` is `ws`, `grpc` or `http`. */
    path: Type.Optional(Type.String({ maxLength: 256 })),
    /** The `Host` header, when it differs from `serverName`. */
    host: Type.Optional(Type.String({ maxLength: 253 })),
    /**
     * Only when `security` is `reality`, and **both are needed together.**
     *
     * The pair cannot be expressed as a requirement here — it is conditional on a sibling field — so
     * it is enforced by `reality_without_public_key` and `reality_without_short_id` in
     * `core/invariants.ts`. Named by code rather than as "the invariants say so", because that is
     * what this line used to say while no such check existed: a Reality tunnel with no key validated,
     * stored, and reached the emission, which wrote `tls.reality` with nothing in it. A claim written
     * so it can be searched for can also be found missing.
     */
    realityPublicKey: Type.Optional(Type.String({ maxLength: 128 })),
    realityShortId: Type.Optional(Type.String({ maxLength: 32 })),
  },
  { additionalProperties: false, $id: 'VlessConfig' },
));
export type VlessConfig = Static<typeof VlessConfig>;

/* ── Proxy ───────────────────────────────────────────────────────────────────────────────── */

/**
 * **One entry, not three.** What the owner holds is *a proxy*; which of HTTP, HTTPS and SOCKS it
 * speaks is a fact about that proxy and not a different product.
 *
 * Decided 2026-09-22. Three entries would have been three screens differing by one dropdown, three
 * titles to choose between before an address can be typed, and three places to fix the next thing
 * found wrong with any of them. The catalogue is named after what the owner holds, and he holds one
 * thing.
 *
 * ## Why `https` is a type here and not a checkbox
 *
 * The proxy core has no `https` outbound: an HTTPS proxy is its `http` outbound with TLS turned on.
 * Modelling that as a boolean beside the type would put two fields in the document that can
 * disagree — `type: "socks"` with `tls: true` is a state nothing can mean — so the choice is one
 * closed set of three and the daemon's entry turns `https` into the pair the core wants. The person
 * answers what his provider told him; the translation is ours.
 *
 * ## `allowInsecure` is absent here too, and that is the same decision rather than a new one
 *
 * A subscription link carrying `allowInsecure` or `insecure` is **refused** by this repository,
 * naming the parameter, because the switch turns off the only check that distinguishes a tunnel
 * from a pipe to whoever answered — argued in `docs/14-open-questions.md`. Nothing about a proxy
 * changes that arithmetic, so there is no such field here.
 *
 * What the refusal leaves is the honest need behind it: a proxy whose certificate this device has
 * no reason to trust. `tlsCertificate` answers that need **with verification still on**, which is
 * why it exists and why it is not the refused switch under another name.
 */
export const ProxyType = Type.Union(
  [Type.Literal('http'), Type.Literal('https'), Type.Literal('socks')],
  { default: 'socks', description: 'What this proxy speaks.' },
);
export type ProxyType = Static<typeof ProxyType>;

/**
 * The credentials a proxy asks for, when it asks.
 *
 * Optional as a whole rather than two optional fields, for the reason `OpenVpnAuth` gives above: a
 * user name without a password is not a state anything can use, and a shape that can express it
 * makes an invariant out of something the schema could simply have refused.
 *
 * SOCKS user-name/password authentication is the case this entry was written against, and it is the
 * one combination the other two types also accept.
 */
const ProxyAuth = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 128 }),
    password: Secret({ kind: 'password', description: 'The password for this proxy account.' }),
  },
  { additionalProperties: false, description: 'Only when the proxy asks for a user name and password.' },
);

export const ProxyConfig = Source('person', Type.Object(
  {
    type: ProxyType,
    server: Type.String({ minLength: 1, maxLength: 253, description: 'The proxy’s address.' }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    auth: Type.Optional(ProxyAuth),
    /**
     * The name the certificate is checked against. **HTTPS only.**
     *
     * Absent means the address above is used, which is right whenever the proxy is reached by the
     * name its certificate was issued for. Set on an `http` or `socks` proxy it is not a harmless
     * extra: there is no handshake to put it in, so the daemon's entry **refuses** rather than
     * dropping it. Dropping a stated field silently is how a configuration comes to look complete
     * and then fail for a reason its author wrote down and we threw away.
     */
    tlsServerName: Type.Optional(Type.String({ maxLength: 253 })),
    /**
     * The certificate to trust for this proxy, in PEM, one line per element. **HTTPS only.**
     *
     * **Deliberately not marked as a secret.** A certificate is what the server presents to everyone
     * who connects to it; marking things that are not credentials makes a redacted export useless
     * for diagnosing the thing it was exported to diagnose — the same ruling as `publicKey` on an
     * obfuscation entry point.
     *
     * A list of lines rather than one blob because that is the shape the core accepts and the shape
     * a textarea produces, and because a PEM pasted into a single-line field loses the line breaks
     * that make it parseable at all.
     */
    tlsCertificate: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 200 })),
  },
  { additionalProperties: false, $id: 'ProxyConfig' },
));
export type ProxyConfig = Static<typeof ProxyConfig>;

/* ── the catalogue, as one list ──────────────────────────────────────────────────────────── */

/**
 * **The catalogue. Three entries, and the count is this object's length — never a structure.**
 *
 * Epic F adds Shadowsocks and WireGuard by appending a key here and the matching entry in the
 * daemon's `core/catalogue/index.ts`; the compiler requires the second. Nothing else in this project may switch on a
 * protocol name. If either of those additions turns out to need a change to how the catalogue works,
 * that is a defect in this design and is recorded as one rather than absorbed.
 *
 * The keys are what a profile stores in `tunnel.protocol`, and they are what a refusal names.
 */
export const TUNNEL_CONFIGS = {
  openvpn: OpenVpnConfig,
  'cloak-openvpn': CloakOpenVpnConfig,
  vless: VlessConfig,
  proxy: ProxyConfig,
} as const satisfies Record<string, TSchema>;

/** What the owner holds, in his words. The only strings a person should ever see for these. */
export const TUNNEL_PROTOCOL_TITLES = {
  openvpn: 'OpenVPN',
  'cloak-openvpn': 'Cloak + OpenVPN',
  vless: 'VLESS',
  proxy: 'Proxy',
} as const satisfies Record<keyof typeof TUNNEL_CONFIGS, string>;

export type TunnelProtocol = keyof typeof TUNNEL_CONFIGS;

/**
 * A catalogue entry and a configuration for it, **joined by the compiler**.
 *
 * The pair a stored tunnel is made of, without the fields a tunnel also carries — an id, a name, a role.
 * It exists because that pair is produced in more than one place: the profile schema's union, the
 * migration step, and the subscription parsers. A producer that hands back a loose protocol beside a
 * loose record can pair a VLESS literal with an OpenVPN configuration, which is exactly the shape schema
 * 7 was written to make unstateable — and a draft is a profile document one write away.
 */
export type TunnelDraft = {
  [K in TunnelProtocol]: { protocol: K; config: Static<(typeof TUNNEL_CONFIGS)[K]> };
}[TunnelProtocol];

/**
 * The catalogue in list form, in the order the interface offers it.
 *
 * Derived from the object above rather than written twice, so the two cannot disagree about which
 * protocols exist — the failure that this whole epic is a response to, in miniature.
 */
export const TUNNEL_PROTOCOLS = Object.keys(TUNNEL_CONFIGS) as readonly TunnelProtocol[];

export function isTunnelProtocol(value: unknown): value is TunnelProtocol {
  return typeof value === 'string' && Object.hasOwn(TUNNEL_CONFIGS, value);
}

/** The list, in words, for a refusal that has to say what *is* accepted. */
export function tunnelProtocolList(): string {
  return TUNNEL_PROTOCOLS.map((protocol) => TUNNEL_PROTOCOL_TITLES[protocol]).join(', ');
}
