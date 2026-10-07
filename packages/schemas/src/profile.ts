/**
 * The profile document: one complete configuration, and the only serialisation there is.
 *
 * It is simultaneously the storage format, the API payload and the export format, so there is no
 * second description of a profile that can drift from this one. Exactly one profile is active at a
 * time, which is what makes switching a single action and rollback a re-apply of a document we
 * already hold rather than an inverse operation to compute.
 *
 * Three shapes in here are decisions rather than conveniences, and each one is load-bearing:
 *
 * * **`uplinks` is a list and it is empty by default.** A device with no uplink configured is a
 *   valid, expected state, not a half-finished one. The list exists because the order between
 *   uplinks is failover priority; it is not a list because several are normal.
 * * **`accessPoint` and `network` are single objects, not arrays.** One access point, one subnet,
 *   no guest networks and no per-client routing. A list of one with no interface behind it is dead
 *   weight, and one-to-many is a schema migration, which is cheap here.
 * * **`routing.rules` is ordered, and the order is data.** Two of the entries are anchors that
 *   expand from elsewhere in the document. They are movable, including below a tunnel rule, which
 *   raises a warning in plan review rather than being prevented.
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Identifier } from './identifier.ts';
import { TUNNEL_CONFIGS, type TunnelProtocol } from './tunnel-configs.ts';
import { Secret } from './secrets.ts';
import { Source } from './source.ts';

/**
 * The document's own version, carried inside the document rather than only in the database, so an
 * exported profile knows what it is and can be migrated on import a year later.
 */
export const PROFILE_SCHEMA_VERSION = 8;

/* ── hardware binding ────────────────────────────────────────────────────────────────────── */

/**
 * How a role finds its hardware.
 *
 * Never an interface name: `wlan0` is not portable to another device and is not even stable on one,
 * because plugging in a dongle can renumber things. Resolution yields a concrete interface at apply
 * time, and an unresolved binding is a *state* the interface reports, not an error.
 *
 * **A person's, and this is the sharpest case in the whole annotation.** The *value* is measured —
 * a hardware address, a USB vendor and product, a sysfs path — so the reflex is to call it `device`.
 * The reflex is wrong, because the field is not the measurement: it is the **choice** of which
 * measured thing this role gets. The device can enumerate every piece of hardware attached to it and
 * still cannot know which of two identical dongles the owner meant for the access point and which he
 * meant for the uplink; a bus path is documented above as *the only selector that separates two
 * identical dongles*, which is a sentence about a person's assignment, not about a reading.
 *
 * Marked here on the declaration rather than at each use, because the answer is the same wherever it
 * is used: the access point's binding and an uplink's binding are the same act.
 */
export const HardwareBinding = Source('person', Type.Union(
  [
    Type.Object(
      {
        by: Type.Literal('mac'),
        value: Type.String({
          pattern: '^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$',
          description: 'Lower or upper case; compared case-insensitively.',
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { by: Type.Literal('phy-builtin') },
      {
        additionalProperties: false,
        description: 'The non-removable radio: its bus path resolves to a platform device.',
      },
    ),
    Type.Object(
      {
        by: Type.Literal('phy-usb'),
        value: Type.String({
          pattern: '^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$',
          description: 'USB vendor:product, e.g. 0e8d:7961.',
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { by: Type.Literal('bus-path'), value: Type.String({ minLength: 1, maxLength: 512 }) },
      {
        additionalProperties: false,
        description: 'An exact sysfs device path. The only selector that separates two identical dongles.',
      },
    ),
    Type.Object(
      { by: Type.Literal('any-ethernet') },
      { additionalProperties: false, description: 'The first wired interface, in kernel index order.' },
    ),
  ],
  { $id: 'HardwareBinding', description: 'A portable selector for a piece of hardware.' },
));
export type HardwareBinding = Static<typeof HardwareBinding>;

/**
 * Whether this role's interface is renamed to a deterministic name of ours.
 *
 * **Off by default, and an earlier revision of this model had it always on.** The correction is worth
 * keeping because the reasoning that changed is the useful part.
 *
 * What pinning buys is real: a `systemd.link` file matching on the permanent address means the name
 * in a unit file and in a generated configuration keeps referring to the same hardware after a USB
 * device re-enumerates, including before this daemon has run at all. That argument is sound and the
 * scheme is unchanged.
 *
 * What it was wrong about is the cost. A rename needs the link down, so it takes effect only at the
 * next boot — which made *first-time setup on any device* demand a reboot before the configuration it
 * had just been given was real. And the rename most likely to be needed is the one on the interface
 * carrying the operator's own session, which is the single riskiest change in the system: a link
 * going down is indistinguishable from losing the board.
 *
 * So it is a choice per role rather than something the planner does to everybody. Left off, the role
 * uses whatever the kernel already calls the interface and no `.link` file is written, so a profile
 * applies and works without a reboot. Turned on, the role gets `wfap0` / `wfwan<n>` / `wfvpn<n>` and
 * the change is classified `boot` — or `network` when it is the management interface — so it arrives
 * through the confirmation window like any other change that can cost access.
 *
 * The practical consequence, and the reason this is not merely a default: taking over a working
 * device is then **two** transactions rather than one. The first reproduces what the device already
 * does, under the names it already has, and is confirmed. The second introduces the pinned names,
 * with its own window and its own reboot. Bundling the riskiest irreversible change with the one
 * carrying everything else means that if the device does not come back, nobody can tell which half
 * did it.
 */
// A person's: nothing about the hardware says whether its name should be pinned, and the two-
// transaction consequence described above is a decision about risk that only the operator can take.
const PinName = Type.Optional(
  Source('person', Type.Boolean({
    default: false,
    description:
      'Rename this role’s interface to a deterministic name and pin it with a link file. Takes ' +
      'effect at the next boot.',
  })),
);

/**
 * Whether this role may take its interface over from another network manager.
 *
 * Off by default, and the default is a refusal rather than a warning. An interface configured by two
 * managers has two sources disagreeing about it, and the one that takes effect is whichever ran last
 * — so the device works until the other side runs, which is the worst kind of working.
 *
 * Turned on, the planner clears the claim as part of the apply: the file holding it is **moved
 * aside, never deleted**, and the move is recorded on the transaction so a revert inside the
 * confirmation window puts it back. It is a per-role field because taking over the one interface you
 * mean is a different act from taking over everything the device has, and because the consequences
 * land on that role's traffic.
 *
 * This is the field that makes the whole thing survivable: clearing a claim is exactly the kind of
 * change that can cost access, so it happens inside a window with a timer outside this process
 * waiting to undo it.
 */
// A person's, for the same reason and more strongly: the device can see that another manager holds
// the interface, and cannot decide that the claim may be cleared. That is consent, not a reading.
const TakeOverInterface = Type.Optional(
  Source('person', Type.Boolean({
    default: false,
    description:
      'Clear another network manager’s claim on this interface by moving its configuration file ' +
      'aside. The file is never deleted, and a revert puts it back.',
  })),
);

/* ── identifiers ─────────────────────────────────────────────────────────────────────────── */

/**
 * An identifier used inside the document and, for tunnels, as the tag the proxy core routes on.
 *
 * Constrained rather than free-form because these values leave the document: a tunnel id becomes an
 * outbound tag, a systemd template instance and part of a generated file name. A value that is fine
 * as a JSON key and catastrophic as a unit instance is exactly the kind of thing that is discovered
 * on a device rather than in a test.
 */
// Defined in `identifier.ts` so the catalogue's typed configurations can share it without
// importing this module, which imports them.

/* ── uplinks ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The address, gateway and resolvers an uplink uses when it is not taking them from DHCP.
 *
 * Defined once and spread into both uplink kinds, because the two differ in how they *join* a
 * network and not in how one is addressed: once a radio has associated, the network layer treats it
 * exactly as it treats a wired port. Two copies would drift, and they did — the wireless copy was
 * simply missing, so `dhcp: false` on a wireless uplink offered no way to say what to use instead.
 *
 * Required together when `dhcp` is false, and that requirement is an invariant check
 * (`uplink_static_without_address`, `uplink_static_without_gateway`) rather than a schema rule,
 * because it is conditional on a sibling field. **The check exists; it did not until 2026-09-21,
 * while a comment here said it did.**
 */
const StaticAddressing = {
  /** Used only when `dhcp` is false. */
  address: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  gateway: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  /**
   * Read by no generator today: the proxy core is this device's resolver, and a resolver learned
   * from the uplink and written into the host configuration would be a second answer nobody asked
   * for — which is the same reason `UseDNS=no` is set on the DHCP path. Kept because it is the
   * owner's to state and the value is not recoverable once discarded; see `docs/14`.
   */
  dns: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 8 })),
};

// Every field here is the owner's: whether to take an address by DHCP, and the address, gateway and
// resolvers to use when he does not. The device can read what it was given; it cannot know what it
// should have been given.
const EthernetUplinkConfig = Source('person', Type.Object(
  {
    dhcp: Type.Boolean({ default: true }),
    ...StaticAddressing,
  },
  { additionalProperties: false },
));

// The network to join and how to join it. The device can list the networks it can hear; which one is
// the owner's, and its passphrase, are not in that list.
const WifiStationUplinkConfig = Source('person', Type.Object(
  {
    ssid: Type.String({ minLength: 1, maxLength: 32 }),
    psk: Type.Optional(Type.Union([Secret({ kind: 'psk' }), Type.Null()])),
    /** Null means "whichever band the network is on". */
    band: Type.Optional(
      Type.Union([Type.Literal('2.4GHz'), Type.Literal('5GHz'), Type.Literal('6GHz'), Type.Null()]),
    ),
    /** Pins the association to one access point, for a network with several. */
    bssid: Type.Optional(
      Type.Union([Type.String({ pattern: '^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$' }), Type.Null()]),
    ),
    dhcp: Type.Optional(Type.Boolean({ default: true })),
    ...StaticAddressing,
    hidden: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
));

export const Uplink = Type.Union(
  [
    Type.Object(
      {
        // `generated`, like every other identifier in this document: the interface produces these
        // (`uplink-2`, `tunnel-3`, `subscription-1`) and they leave the document as outbound tags,
        // systemd template instances and parts of generated file names. An identifier a person
        // edits is an identifier that breaks a reference. The argument for the fifth source, and
        // for why it is not six permanently red lines, is in `source.ts`.
        id: Source('generated', Identifier),
        // The owner's, and symmetric with a tunnel's `protocol`: it answers *what is this uplink*,
        // which the device cannot infer from the hardware — a USB Ethernet dongle and a USB radio
        // are both USB devices, and the role this one is being given is the owner's assignment.
        kind: Source('person', Type.Literal('ethernet')),
        /** Lower wins. Failover order, stated rather than inferred from array position. */
        priority: Source('person', Type.Integer({ minimum: 0, maximum: 1000 })),
        enabled: Type.Optional(Source('person', Type.Boolean({ default: true }))),
        bind: HardwareBinding,
        pinName: PinName,
        takeOverInterface: TakeOverInterface,
        config: EthernetUplinkConfig,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        // Marked on both branches of the union, not only the first. The two collapse to the single
        // position `/uplinks/-/id`, and the walk lets a declared source on any branch win — so a
        // mark here is redundant *today* and stops being redundant the moment the branches are
        // reordered or the first one is deleted.
        id: Source('generated', Identifier),
        kind: Source('person', Type.Literal('wifi-sta')),
        priority: Source('person', Type.Integer({ minimum: 0, maximum: 1000 })),
        enabled: Type.Optional(Source('person', Type.Boolean({ default: true }))),
        bind: HardwareBinding,
        pinName: PinName,
        takeOverInterface: TakeOverInterface,
        config: WifiStationUplinkConfig,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'Uplink' },
);
export type Uplink = Static<typeof Uplink>;

/* ── access point ────────────────────────────────────────────────────────────────────────── */

export const AccessPointRadio = Type.Object(
  {
    band: Type.Union([Type.Literal('2.4GHz'), Type.Literal('5GHz'), Type.Literal('6GHz')]),
    channel: Type.Integer({ minimum: 1, maximum: 233 }),
    width: Type.Union([
      Type.Literal(20),
      Type.Literal(40),
      Type.Literal(80),
      Type.Literal(160),
    ]),
    /**
     * ISO 3166-1 alpha-2, or `00` for the world domain. Not validated against a list here: the
     * regulatory domain a radio is actually subject to is read from the driver at plan time, and a
     * list in the source would be a second description of the kernel's database.
     */
    country: Type.String({ pattern: '^[A-Z0-9]{2}$' }),
    hidden: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

/**
 * Marked `person` as a whole, because every field in it is an answer only the owner has: the network
 * he is choosing to publish, its passphrase, the band, channel, width and regulatory country he is
 * operating under, whether it is hidden, and the acknowledgement below.
 *
 * `radio.country` is the one that invites a second look. The *regulatory domain a radio is subject
 * to* is read from the driver at plan time and is a measurement — but this field is not that. It is
 * the country the owner declares he is in, which is what the driver's reading is then checked
 * against. Two facts, one of them measured, and a control over the declared one is not a control
 * over the measured one.
 *
 * Inheriting rather than marking each leaf is safe in the only direction that matters: a field added
 * inside this object is required by default, and a mistake shows up as a missing control.
 */
export const AccessPoint = Source('person', Type.Object(
  {
    bind: HardwareBinding,
    pinName: PinName,
    takeOverInterface: TakeOverInterface,
    radio: AccessPointRadio,
    ssid: Type.String({ minLength: 1, maxLength: 32 }),
    passphrase: Secret({ kind: 'psk' }),
    /**
     * Required only when this radio also carries a `wifi-sta` uplink *and* the driver publishes a
     * combination that permits both. Such a combination is limited to one channel, so the access
     * point follows whatever channel the upstream network is on — and the upstream can change
     * channel without asking. This flag is the operator saying they understand that; without it the
     * planner refuses and explains why, rather than producing an access point that moves on its own.
     */
    acceptChannelFollowsUplink: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false, $id: 'AccessPoint' },
));
export type AccessPoint = Static<typeof AccessPoint>;

/* ── the local network ───────────────────────────────────────────────────────────────────── */

/**
 * The owner's throughout. The subnet this device hands out is a decision about the network he is
 * building — it has to avoid colliding with whatever the uplink is on, and only he knows what that
 * will be in the places this device travels to.
 */
export const NetworkConfig = Source('person', Type.Object(
  {
    /** The device's own address with its prefix, e.g. `10.44.0.1/24`. */
    cidr: Type.String({ minLength: 9, maxLength: 43 }),
    dhcp: Type.Object(
      {
        enabled: Type.Boolean({ default: true }),
        from: Type.String({ maxLength: 15 }),
        to: Type.String({ maxLength: 15 }),
        leaseHours: Type.Integer({ minimum: 1, maximum: 720, default: 12 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'NetworkConfig' },
));
export type NetworkConfig = Static<typeof NetworkConfig>;

/* ── tunnels ─────────────────────────────────────────────────────────────────────────────── */

/*
 * `TunnelTransport` was here, and it is **deleted rather than hidden**.
 *
 * It was `{ id, provider, config }`, where `config` was an opaque record that in practice carried a
 * command line and an entire client configuration as a string. An obfuscation layer is no longer a
 * thing a person assembles beside a tunnel: it is part of the `Cloak + OpenVPN` catalogue entry, as
 * `config.entryPoints`, with every field typed and the credential among them marked. See
 * `tunnel-configs.ts`.
 */

/**
 * What a tunnel reaches that nothing else does. Only meaningful for a `resource` tunnel: it is what
 * the `tunnel-resources` routing anchor expands into.
 */
export const TunnelResources = Source('person', Type.Object(
  {
    domainSuffix: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: 256 })),
    ipCidr: Type.Optional(Type.Array(Type.String({ maxLength: 43 }), { maxItems: 256 })),
  },
  { additionalProperties: false },
));

// The owner's: which resolver to use behind this tunnel and which names belong to it. `dynamic` says
// the address is pushed by the peer — but whether to *accept* the pushed one is still his statement
// about the peer, made before any connection exists to observe.
export const TunnelDns = Source('person', Type.Object(
  {
    /** A resolver reachable only through this tunnel. */
    server: Type.String({ minLength: 1, maxLength: 64 }),
    /**
     * True when the address is pushed by the peer rather than fixed here. A pushed address can
     * differ between reconnections depending on which gateway answered, and a value fixed at
     * configuration time is right about half the time — the failure looks like "the tunnel is up
     * but names do not resolve".
     */
    dynamic: Type.Optional(Type.Boolean({ default: false })),
    domainSuffix: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: 256 })),
  },
  { additionalProperties: false },
));

/**
 * The two roles, declared rather than inferred from the protocol.
 *
 * An **alternative** is interchangeable with other alternatives: it joins the failover group and
 * unmatched traffic goes to whichever is selected. A **resource** is not interchangeable —
 * substituting a public proxy for a corporate tunnel is meaningless — so it never joins the group
 * and is reached only by explicit rules. Two endpoints of the same protocol can be one of each,
 * which is why this is a field.
 */
export const TunnelRole = Source(
  'person',
  Type.Union([Type.Literal('alternative'), Type.Literal('resource')]),
);

const TunnelCommon = {
    /** `generated`, like every identifier here — the argument is at `/uplinks/-/id` and in `source.ts`. */
    id: Source('generated', Identifier),
    name: Source('person', Type.String({ minLength: 1, maxLength: 64 })),
    role: TunnelRole,
    enabled: Source('person', Type.Boolean({ default: true })),
    resources: Type.Optional(TunnelResources),
    /**
     * What happens to traffic assigned to this tunnel when the tunnel is **not available**.
     *
     * The field is on the tunnel rather than on the rule because a tunnel exists for a set of
     * destinations, and what should happen to that set when the tunnel cannot carry it is a property of
     * the assignment, not of one rule that happens to express it.
     *
     * **`block` is the default, and the default is the point.** Traffic was assigned to a tunnel because
     * it must not go anywhere else; falling through to the ordinary route is the opt-in. This is the same
     * principle the credential rulings follow — fail towards the smaller loss — and the arithmetic here is
     * not close: an application that cannot connect is an error somebody sees and retries, while a request
     * that leaks onto the open network is the exact outcome the tunnel was paid for, and nobody sees it at
     * all.
     *
     * `fall-through` sends the traffic to the ordinary route instead — which for most profiles means
     * direct. Choose it only for destinations where reaching them by any path is better than not reaching
     * them, and where being seen asking for them costs nothing.
     *
     * **How `block` is kept, corrected 2026-09-24.** This said the traffic is enforced by a per-tunnel
     * selector (this tunnel and `block`) that the health watchdog moves. The selector is still generated,
     * and the watchdog no longer moves it towards `block`: every tunnel outbound this build generates
     * fails closed by itself — an OpenVPN outbound is bound to the tunnel's interface, a proxy outbound
     * fails the connection when its server is unreachable — so a dead tunnel's traffic fails rather than
     * leaving another way whether or not the selector moves. What moving it bought was a faster refusal,
     * and the price was that a false reading became an outage of everything the tunnel carries: on
     * 2026-09-24 one closed port on one of `partner`'s resources blocked all of it. A dead reading is now
     * reported, red, and the traffic keeps its connection error. See `core/watchdog.ts`, `runGuards`.
     *
     * **How `fall-through` is kept (G31, 2026-09-24).** Until then it was not: no selector was generated
     * and the rule pointed at the tunnel's own outbound, so a dead fall-through tunnel failed exactly like
     * a `block` one. Now its rule points at `wf-fall-<id>` (this tunnel, then the main selector — the route
     * traffic no rule names takes), and its own resolver, if it has one, is reached through
     * `wf-fall-dns-<id>`, whose other member hands the query to the ordinary resolver. The watchdog moves
     * both to the ordinary side after two consecutive dead readings of the tunnel itself and back after
     * three consecutive alive ones; a reading that could not be taken moves nothing. Rules below the
     * tunnel's are not consulted while it falls through. See `core/watchdog.ts`, `runFallThrough`.
     */
    onUnavailable: Source('person', Type.Union([Type.Literal('block'), Type.Literal('fall-through')], {
      default: 'block',
      description:
        'When this tunnel is unavailable: block its traffic, or let it take the ordinary route. Blocking ' +
        'is the default because traffic assigned to a tunnel was assigned so it would not go elsewhere.',
    })),
    /*
     * There is no `probe` here, and that is a decision (2026-09-24, schema 8), not an omission.
     *
     * The field was `probe.endpoints`, and its documentation advised "give a destination tunnel something
     * that exists behind it". On the bench board `partner` was given `http://172.30.0.212/`, one of its own
     * resources. Overnight that server stopped answering on port 80 while still answering 443, the guard
     * read the tunnel as dead, and with `onUnavailable: block` every destination behind a healthy tunnel —
     * its gateway answered in 95 ms — was refused until the field was removed by hand. A measurement of
     * one thing a tunnel carries is a measurement of that thing.
     *
     * A tunnel's liveness is now asked of its own protocol by its catalogue entry (OpenVPN: its peer's
     * keepalive and pushed gateway; VLESS and proxies: bytes back through the outbound, or neutral
     * connectivity checks when idle), and nothing the owner writes can point it at something else. The
     * migration from schema 7 removes the field from stored documents; a document at schema 8 that
     * carries it is refused by name — see `validate-profile.ts`.
     */
    dns: Type.Optional(TunnelDns),
    /**
     * Present when this tunnel came from a subscription rather than from a person.
     *
     * The mark is what makes a refresh safe: it may replace the derived tunnels of **its own**
     * subscription and must never touch a hand-authored one. Without it a refresh would have to guess
     * which tunnels it owns, and the failure mode of guessing is deleting somebody's work.
     *
     * `node` is the feed's identity for the entry, not its display name: names change between
     * refreshes for cosmetic reasons and an identity that moves is an identity that cannot be matched.
     */
    // Both marked `subscription`, leaf by leaf, because an exempting mark must never be inherited.
    // Written by `core/subscriptions.ts` on every refresh and by nothing else; a control over either
    // would be overwritten by the next refresh, and a person editing `node` would break the identity
    // match that keeps a refresh from deleting somebody's work. Note that `subscription` here is a
    // *reference to* a subscription the owner created — the reference is still the feed's to write.
    derivedFrom: Type.Optional(
      Type.Object(
        {
          subscription: Source('subscription', Identifier),
          node: Source('subscription', Type.String({ minLength: 1, maxLength: 256 })),
        },
        { additionalProperties: false },
      ),
    ),
} as const;

/**
 * One tunnel, and **the catalogue is the only thing it can be.**
 *
 * A union per catalogue entry rather than one object with a loose `config`, because the pairing is
 * the part that matters: `protocol: 'vless'` beside an OpenVPN configuration validated cleanly under
 * the old shape and could not run. Here each branch fixes its own `protocol` literal and its own
 * configuration, so the two cannot disagree, and a document naming anything else matches no branch
 * at all — which is what makes the refusal in E5 a consequence of the schema rather than a check
 * somebody remembered to write.
 *
 * Built by mapping the catalogue, so **the count stays a line**. Epic F appends to `TUNNEL_CONFIGS`
 * and the branches follow; the total map below is what makes forgetting one a compile error.
 */
/*
 * `protocol` is marked `person` in every branch, and the reflex to call it `catalogue` is worth
 * answering because it is a good reflex.
 *
 * The catalogue owns the *consequences* of the choice — the binary, the shape of the configuration,
 * the file's name and format, the loopback port — and none of those are asked of anybody. It does
 * not own the choice. The field answers **what is this**, which is a fact about what the owner
 * holds: he has an OpenVPN profile, or a VLESS link, and no amount of catalogue knowledge produces
 * that. It is symmetric with an uplink's `kind` for the same reason, and both had to be marked in
 * each branch rather than once, since a literal per branch is what makes protocol and configuration
 * impossible to pair wrongly.
 */
export const TUNNEL_BRANCHES = {
  openvpn: Type.Object(
    { ...TunnelCommon, protocol: Source('person', Type.Literal('openvpn')), config: TUNNEL_CONFIGS.openvpn },
    { additionalProperties: false, $id: 'Tunnel_openvpn' },
  ),
  'cloak-openvpn': Type.Object(
    {
      ...TunnelCommon,
      protocol: Source('person', Type.Literal('cloak-openvpn')),
      config: TUNNEL_CONFIGS['cloak-openvpn'],
    },
    { additionalProperties: false, $id: 'Tunnel_cloak_openvpn' },
  ),
  vless: Type.Object(
    { ...TunnelCommon, protocol: Source('person', Type.Literal('vless')), config: TUNNEL_CONFIGS.vless },
    { additionalProperties: false, $id: 'Tunnel_vless' },
  ),
  proxy: Type.Object(
    { ...TunnelCommon, protocol: Source('person', Type.Literal('proxy')), config: TUNNEL_CONFIGS.proxy },
    { additionalProperties: false, $id: 'Tunnel_proxy' },
  ),
} as const satisfies { [P in TunnelProtocol]: TSchema };

export const Tunnel = Type.Union(
  [TUNNEL_BRANCHES.openvpn, TUNNEL_BRANCHES['cloak-openvpn'], TUNNEL_BRANCHES.vless, TUNNEL_BRANCHES.proxy],
  {
    $id: 'Tunnel',
    description: 'A tunnel, which is one of the protocols this product runs. There is nothing else.',
  },
);
export type Tunnel = Static<typeof Tunnel>;

/* ── policy ──────────────────────────────────────────────────────────────────────────────── */

/**
 * The owner's throughout, including the thresholds.
 *
 * The thresholds invite a `device` mark because latency, jitter and loss are measured quantities —
 * but a *threshold* is not a measurement, it is the line the owner draws across one. The comments
 * below argue each line's default; a default is not a source. The probe endpoints are his too, and
 * the constraint recorded there — that they must not be reachable around the tunnel under test —
 * is a statement about his own routing that nothing else can make.
 */
export const Policy = Source('person', Type.Object(
  {
    /** Tunnel ids in preference order. Only `alternative` tunnels belong here. */
    priority: Type.Array(Identifier, { maxItems: 64, default: [] }),
    /** Alternatives kept out of the failover group without deleting them. */
    excluded: Type.Array(Identifier, { maxItems: 64, default: [] }),
    /** Stay on the current choice while it is healthy, rather than returning to the top on recovery. */
    sticky: Type.Boolean({ default: true }),
    probes: Type.Object(
      {
        count: Type.Integer({ minimum: 1, maximum: 32, default: 4 }),
        maxFails: Type.Integer({ minimum: 1, maximum: 32, default: 2 }),
        maxLatencyMs: Type.Integer({ minimum: 1, maximum: 60_000, default: 500 }),
        /**
         * Jitter is a first-class threshold, not decoration: a channel with a low median and a wide
         * spread is worse to use than a steadier one with a higher median, and latency alone cannot
         * tell them apart.
         */
        maxJitterMs: Type.Integer({ minimum: 1, maximum: 60_000, default: 250 }),
        /**
         * Loss carries its own weight, for the same reason jitter does.
         *
         * A channel that answers quickly nine times in ten is not a fast channel: every lost probe is a
         * retransmission and a stall somewhere above it, and the median of the answers that *did* arrive
         * says nothing about the ones that did not. A single lost probe out of four is 25% — high enough
         * that the default is deliberately not zero, because a threshold nothing can satisfy is a
         * watchdog that reports everything as broken.
         */
        maxLossPercent: Type.Integer({ minimum: 0, maximum: 100, default: 34 }),
        failStreak: Type.Integer({ minimum: 1, maximum: 32, default: 2 }),
        /** How often the whole set is probed, in seconds. */
        intervalSeconds: Type.Integer({ minimum: 5, maximum: 3600, default: 30 }),
        /**
         * What the probe fetches, through the tunnel being measured.
         *
         * A list rather than one address, because a single endpoint makes the watchdog's opinion of every
         * tunnel depend on one third party's availability: when it goes down, every tunnel is reported
         * unhealthy at once and the device fails over to nothing. Several unrelated endpoints turn that
         * into one bad sample among several.
         *
         * **These addresses must not be reachable by a route that bypasses the tunnel under test.** An
         * endpoint inside a network the profile sends direct is measured over the direct path, and the
         * number that comes back is a true measurement of the wrong thing — which is worse than no
         * measurement, because it is believed. The invariant checks enforce it.
         */
        endpoints: Type.Array(Type.String({ minLength: 3, maxLength: 200 }), {
          minItems: 1,
          maxItems: 8,
          default: ['http://cp.cloudflare.com/generate_204', 'http://connectivitycheck.gstatic.com/generate_204'],
        }),
      },
      { additionalProperties: false },
    ),
    /** What unmatched traffic does when no alternative is healthy. */
    onAllDown: Type.Union([Type.Literal('block'), Type.Literal('direct')], { default: 'block' }),
  },
  { additionalProperties: false, $id: 'Policy' },
));
export type Policy = Static<typeof Policy>;

/* ── routing ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Where a rule sends what it matches. `direct` and `block` are reserved words rather than tunnel
 * ids; anything else must name a tunnel that exists, which the cross-reference checks enforce.
 */
export const RuleAction = Type.Object(
  { outbound: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: false },
);

/**
 * The ordered rule list.
 *
 * Two kinds are **anchors**: they expand from other parts of the document rather than being written
 * out by hand. `protect-own-networks` sends the LAN, the uplink network and loopback direct;
 * `tunnel-resources` emits one rule per `resource` tunnel in the order the tunnels are listed.
 *
 * Anchors can be moved freely, including below a tunnel rule. Doing so raises a warning in plan
 * review naming what will be lost, and is not prevented: private address space overlaps heavily, so
 * a rule sending `192.168.0.0/16` into a tunnel above the protect anchor takes the operator's own
 * management traffic with it — but a locked rule would eventually stand between someone and a
 * configuration they actually need, and the revert window already makes the mistake recoverable
 * rather than fatal.
 */
export const RoutingRule = Type.Union(
  [
    Type.Object({ kind: Type.Literal('protect-own-networks') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('tunnel-resources') }, { additionalProperties: false }),
    Type.Object(
      { kind: Type.Literal('private'), action: RuleAction },
      { additionalProperties: false, description: 'RFC 1918 and equivalent space.' },
    ),
    Type.Object(
      {
        kind: Type.Literal('ruleSet'),
        sets: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 64 }),
        action: RuleAction,
      },
      { additionalProperties: false },
    ),
    // The three direct kinds below exist because the alternative was a modelling lie. Sending one
    // domain direct is close to the most common thing anyone asks this device to do, and the only
    // other way to express it was to invent a `resource` tunnel that tunnels nothing — which then
    // shows up as a tunnel in the tunnel list, in the export, and in the diff a person reads before
    // confirming a change. Three more branches in a generator that already emits rules is the
    // cheaper half of that trade.
    Type.Object(
      {
        kind: Type.Literal('domain'),
        // Exact hosts, not suffixes. A suffix is not a correct way to express an exact host, and
        // someone will try it: `example.com` as a suffix also matches `notexample.com`.
        domains: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { minItems: 1, maxItems: 1024 }),
        action: RuleAction,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('domainSuffix'),
        suffixes: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { minItems: 1, maxItems: 1024 }),
        action: RuleAction,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('ipCidr'),
        cidrs: Type.Array(Type.String({ minLength: 1, maxLength: 43 }), { minItems: 1, maxItems: 1024 }),
        action: RuleAction,
      },
      { additionalProperties: false },
    ),
  ],
  // Keyword and regular-expression matching are deliberately absent: both are reachable through a
  // rule set, and that indirection is fair because a rule set is exactly a list of match terms.
  { $id: 'RoutingRule' },
);
export type RoutingRule = Static<typeof RoutingRule>;

export const RuleSet = Type.Object(
  {
    tag: Type.String({ minLength: 1, maxLength: 64 }),
    type: Type.Union([Type.Literal('remote'), Type.Literal('local')]),
    url: Type.Optional(Type.String({ maxLength: 2048 })),
    path: Type.Optional(Type.String({ maxLength: 512 })),
    format: Type.Optional(Type.Union([Type.Literal('binary'), Type.Literal('source')])),
    /**
     * How often the core may refetch this set, in hours.
     *
     * Optional, and its absence is read rather than ignored: it is the **only** statement in the
     * document of how fast this list goes out of date, so it is what decides when a stale copy
     * becomes a finding (`apps/daemon/src/core/rule-set-age.ts`). A set with no interval gets an age
     * and no verdict, because there is nothing to judge it against and a number picked here would
     * be a policy nobody chose.
     */
    updateIntervalHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
  },
  { additionalProperties: false },
);
export type RuleSet = Static<typeof RuleSet>;

/**
 * Authored, all of it. A rule and a rule set are statements about where the owner wants his traffic
 * to go; nothing on the device or in any feed produces one. `ruleSets` was unread by anybody until
 * now: a tag he names, whether the set is fetched or on disk, the URL or path it comes from, its
 * format, and how often it may be refetched — six fields, six of his answers. That the *contents* of
 * a remote set arrive from elsewhere does not make the pointer to it anything but his.
 */
export const Routing = Source('person', Type.Object(
  {
    rules: Type.Array(RoutingRule, { maxItems: 256, default: [] }),
    ruleSets: Type.Array(RuleSet, { maxItems: 64, default: [] }),
  },
  { additionalProperties: false, $id: 'Routing' },
));
export type Routing = Static<typeof Routing>;

/* ── DNS, firewall, services ─────────────────────────────────────────────────────────────── */

// The owner's: which resolvers to use on each path, how to order address families, and whether to
// keep a record of what everyone on the network looked up. `direct: 'auto'` defers to the uplink at
// runtime, but choosing to defer is still the choice.
export const DnsConfig = Source('person', Type.Object(
  {
    /** `auto` means whatever the uplink provides. Otherwise a literal server address. */
    direct: Type.String({ minLength: 1, maxLength: 128, default: 'auto' }),
    overTunnel: Type.String({ minLength: 1, maxLength: 128, default: '1.1.1.1' }),
    strategy: Type.Union(
      [
        Type.Literal('ipv4_only'),
        Type.Literal('prefer_ipv4'),
        Type.Literal('prefer_ipv6'),
        Type.Literal('ipv6_only'),
      ],
      { default: 'ipv4_only' },
    ),
    /**
     * Record every name each client looks up, in the system journal, with the client's address.
     *
     * **Off by default, and the default is a privacy decision rather than a debugging one.** The list of
     * names a device asks for is a record of what the person using it was doing, minute by minute — often
     * more revealing than the traffic itself, which is at least encrypted. A router that keeps that by
     * default keeps it for everyone on it, including people who never chose this device.
     *
     * It exists because without it a whole class of fault is unanswerable. When an internal name does not
     * open, "the client never asked us", "the client asked and we answered wrongly" and "the client asked,
     * we answered correctly, and it ignored the answer" are three different faults with one appearance, and
     * nothing else on the device distinguishes them: this kernel build has no connection-tracking file to
     * read and the usual packet tools are not installed. Measured on the bench board, 2026-09-21, while a
     * real client could not open an internal name and no available reading could say why.
     *
     * So: turn it on to answer a question, and turn it off again. The interface says as much.
     */
    logQueries: Type.Boolean({
      default: false,
      description:
        'Record every name each client looks up, with their address, in the journal. Off by default: that ' +
        'list is a record of what people did. Turn it on to diagnose a name that will not resolve, then off.',
    }),
  },
  { additionalProperties: false, $id: 'DnsConfig' },
));
export type DnsConfig = Static<typeof DnsConfig>;

/**
 * The owner's throughout: what may leave without a tunnel, what time synchronisation is allowed to
 * bypass, and which endpoints are blocked outright.
 *
 * `ipv6` is worth a line because it has exactly one legal value today and so looks like a constant.
 * It is not a constant, it is a policy with one option so far — and its provenance is the owner's,
 * which is why parity asks for somewhere it can be *seen*. A prohibition nobody can find is
 * indistinguishable from one that is not in force, and this one costs every client's real address
 * when it is not.
 */
export const FirewallConfig = Source('person', Type.Object(
  {
    /**
     * Off by default, and configurable rather than baked in: a device with no tunnel configured yet
     * would otherwise look broken. When on it rejects only *new* connections from the LAN towards
     * the uplink — measured at idle with clients connected, zero packets were in the `new` state
     * against 460 established, so rejecting only `new` closes the leak and tears nothing down —
     * and it rejects rather than drops, so an application fails at once instead of hanging.
     */
    killSwitch: Type.Boolean({ default: false }),
    /**
     * `block` is the only value today. IPv6 is rejected *at the access point* rather than merely
     * left unrouted: a tunnel carrying only IPv4 while IPv6 reaches the internet directly leaks the
     * real address of every client, invisibly, because pages still load. Rejected rather than
     * dropped so a client falls back to IPv4 immediately instead of waiting out a timeout.
     */
    ipv6: Type.Literal('block', { default: 'block' }),
    /**
     * Lets time synchronisation bypass the tunnel, matched by destination port rather than by user.
     * By port because the time service does not run as root, so a rule written in terms of the root
     * user misses it — and this is self-locking, since fixing a wrong clock needs a time query and
     * timestamp-authenticated transports refuse to connect while the clock is wrong.
     */
    ntpBypass: Type.Boolean({ default: true }),
    /**
     * Endpoints that reveal the real address — address-discovery servers and reachability probes.
     * One field rather than two, because "the STUN block list" and "the probe-endpoint blocking
     * list" were the same concept under two names.
     *
     * Entries are structured rather than bare ports or bare hostnames, and the reason is worth
     * stating because it changes what the feature can promise. A bare port number blocks far more
     * than intended: a whole well-known UDP port carries things nobody asked to break. A bare
     * hostname cannot be enforced by a firewall at all, because a firewall matches addresses.
     *
     * **Which layer enforces which, and the limit that follows:** entries with `ipCidr` or `ports`
     * become firewall rules; entries with `domain` become reject rules in the core's routing, which
     * means a domain entry does nothing for a client that resolved the name somewhere else and is
     * connecting to a literal address. Written down because the feature otherwise looks stronger
     * than it is.
     */
    blockedEndpoints: Type.Array(
      Type.Object(
        {
          domain: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
          // Validated by shape, not merely by length. A length check accepts "not an address at all",
          // which then reaches the firewall generator and is dropped there — so the operator sees the
          // entry in the profile and in plan review, and it does not exist.
          //
          // IPv6 is accepted by the pattern and refused by an invariant check that says why, rather
          // than being filtered out silently. A rule the user can see must either work or explain
          // itself.
          ipCidr: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 43,
              pattern:
                '^((\\d{1,3}\\.){3}\\d{1,3}(/\\d{1,2})?|[0-9a-fA-F:]+(/\\d{1,3})?)$',
              description: 'An IPv4 or IPv6 address, with an optional prefix length.',
            }),
          ),
          ports: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), { maxItems: 32 })),
          protocol: Type.Optional(
            Type.Union([Type.Literal('tcp'), Type.Literal('udp'), Type.Literal('any')], { default: 'any' }),
          ),
          /** Free-text label so a list of addresses is readable a year later. */
          note: Type.Optional(Type.String({ maxLength: 128 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 256, default: [] },
    ),
  },
  { additionalProperties: false, $id: 'FirewallConfig' },
));
export type FirewallConfig = Static<typeof FirewallConfig>;

export const ServicesConfig = Type.Object(
  {
    clashApi: Type.Object(
      {
        // Whether to run the core's own control API at all is the owner's call: it is power that
        // exists or does not, and the sentence below is about where it listens once it does.
        enabled: Source('person', Type.Boolean({ default: true })),
        /**
         * Loopback only. A second control API on a routable address with its own key is a large
         * amount of power in the open; it is reached through our own authentication instead.
         *
         * **Marked `catalogue`, and the category now rests on this one member — awkwardly.** The
         * address is the proxy core's own, fixed by how the core is run and read back by the daemon
         * that talks to it; a person typing a different one would be typing over the running
         * process. That reasoning is sound and the mark is right.
         *
         * What is not sound is the category around it. Everything that was genuinely the catalogue's
         * — the binary, the configuration file's name and format, the loopback port a tunnel is
         * allocated — **left the profile document in E4**, which was the purpose of that task. So
         * `catalogue` now describes one field, and a category with one member is usually the name of
         * a model we no longer have. Raised in `docs/14-open-questions.md`; not decided here,
         * because renaming a source or re-homing this field is the owner's call and a mark changed
         * to tidy up a distribution is a mark changed for the wrong reason.
         */
        bind: Source(
          'catalogue',
          Type.String({ minLength: 3, maxLength: 64, default: '127.0.0.1:9090' }),
        ),
      },
      { additionalProperties: false },
    ),
    /**
     * Where this device's own control panel and API can be reached.
     *
     * The access point is always one of them: it is the surface the whole design is built around, and a
     * device whose panel cannot be reached from the network it hosts is a device nobody can configure.
     * Loopback is always there too.
     *
     * `onUplinkNetwork` adds the network the device is a *client* of — the home or office it is plugged
     * into. On by default, because reaching the panel from a laptop on the same network as the device is
     * what an owner expects, and requiring a forwarded port for it is a barrier without a matching gain
     * at home.
     *
     * It is a switch because "the network the device is a client of" is a hotel's wireless when its owner
     * travels, and then everyone on that network can reach the panel. See the interface for what turning
     * it off costs and what stands behind leaving it on.
     *
     * A **tunnel** interface is never a management surface and there is no setting for it. Nor is the
     * proxy core's own dashboard, which stays on loopback: it has no authentication of its own and full
     * control over routing.
     */
    management: Source('person', Type.Object(
      {
        onUplinkNetwork: Type.Boolean({ default: true }),
      },
      { additionalProperties: false, default: { onUplinkNetwork: true } },
    )),
  },
  { additionalProperties: false, $id: 'ServicesConfig' },
);

/* ── the document ────────────────────────────────────────────────────────────────────────── */

export const ProfileMeta = Type.Object(
  {
    name: Source('person', Type.String({ minLength: 1, maxLength: 64 })),
    description: Type.Optional(Source('person', Type.String({ maxLength: 512 }))),
    // `generated`: nobody types a timestamp. Measured 2026-09-21 before marking them: the profile
    // *row* carries its own `created_at` / `updated_at`, maintained by `state/profiles.ts` on every
    // write; these two travel inside the document a client sends and are never written by the
    // daemon at all (`core/apply.ts` records that it once depended on `meta.updatedAt` and had to
    // stop, for exactly that reason). So they are not the device's, not a person's to type, not a
    // feed's and not the catalogue's — they are this product's own bookkeeping.
    //
    // Still open, and not settled by the mark: these two duplicate columns that *are* maintained,
    // and a duplicate nothing maintains is a value that will be wrong. `generated` records where
    // the value comes from; it does not argue that the field should exist. See
    // `docs/14-open-questions.md`.
    createdAt: Source('generated', Type.String({ maxLength: 32 })),
    updatedAt: Source('generated', Type.String({ maxLength: 32 })),
  },
  { additionalProperties: false },
);

/* ── subscriptions ───────────────────────────────────────────────────────────────────────── */

/**
 * A feed of tunnel definitions, kept **in the profile** rather than in device state.
 *
 * It is configuration: it must travel with the document to another device, survive an export and be
 * reported as missing on an import that cannot see its secret. Device state is for what this
 * particular board has observed, and a subscription is not that.
 *
 * The URL carries the secret annotation because it almost always embeds a credential — the token is
 * in the path or the query. That single annotation buys the four behaviours the secret machinery
 * provides: redaction on read, a redacted export, an import that names what is missing, and a write
 * that can say `{"$keep": true}` rather than blanking it.
 */
export const Subscription = Type.Object(
  {
    /** `generated`, like every identifier here — the argument is at `/uplinks/-/id` and in `source.ts`. */
    id: Source('generated', Identifier),
    name: Source('person', Type.String({ minLength: 1, maxLength: 64 })),
    enabled: Source('person', Type.Boolean({ default: true })),
    /** The feed. Annotated as a secret: the credential is usually inside the URL itself. */
    url: Source('person', Secret({ kind: 'subscription-url' })),
    /**
     * How often the device may refresh unasked, in hours. `0` means never — refresh only when a person
     * asks for it.
     *
     * Bounded below at one hour rather than allowing minutes: a feed polled aggressively is a feed
     * that gets the device blocked, and the device edits its own configuration on every refresh.
     */
    refreshHours: Source('person', Type.Integer({ minimum: 0, maximum: 24 * 30, default: 24 })),
    /**
     * What the device has learned by fetching it. Observations, not intent — kept here so a profile
     * moved to another device arrives honest about never having been refreshed *there*.
     */
    // Marked leaf by leaf and `device`, never on the object, because an exempting mark must not be
    // inherited by a field added here later. The declaration above says what these are: what this
    // board learned by fetching, kept in the profile so a document moved elsewhere arrives honest
    // about never having been refreshed *there*. `nodeCount` comes from the feed's answer but the
    // count is this device's reading of it, and all four are overwritten by the next refresh.
    lastRefresh: Type.Optional(
      Type.Object(
        {
          at: Source('device', Type.String({ format: 'date-time', maxLength: 40 })),
          ok: Source('device', Type.Boolean()),
          /** Never the response body, and never the URL: a feed's error text can echo the token back. */
          detail: Source('device', Type.String({ maxLength: 200 })),
          nodeCount: Source('device', Type.Integer({ minimum: 0, maximum: 10_000 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, $id: 'Subscription' },
);
export type Subscription = Static<typeof Subscription>;

export const ProfileDocument = Type.Object(
  {
    // `generated`, with `/meta/createdAt`, `/meta/updatedAt` and the three identifiers: written by
    // `state/profiles.ts` when a migration runs, and by nothing else. A person editing it would be
    // claiming a migration happened. See the note at `ProfileMeta` and the argument in `source.ts`.
    schemaVersion: Source('generated', Type.Integer({ minimum: 1, maximum: 1000 })),
    meta: ProfileMeta,
    /** Empty is valid and is the default. See the note at the top of this file. */
    uplinks: Type.Array(Uplink, { maxItems: 16, default: [] }),
    /**
     * Null when this device hosts no access point — a board with no radio, or one reached over
     * Ethernet only. Reported as a state, the same way an unbound role is, rather than being an
     * invalid document.
     */
    accessPoint: Type.Union([AccessPoint, Type.Null()]),
    network: NetworkConfig,
    tunnels: Type.Array(Tunnel, { maxItems: 128, default: [] }),
    /** Empty by default. See `Subscription`: these are configuration, not device state. */
    subscriptions: Type.Array(Subscription, { maxItems: 32, default: [] }),
    policy: Policy,
    routing: Routing,
    dns: DnsConfig,
    firewall: FirewallConfig,
    services: ServicesConfig,
  },
  {
    additionalProperties: false,
    $id: 'ProfileDocument',
    description: 'One complete configuration. Copy-pasteable as a single JSON document.',
  },
);
export type ProfileDocument = Static<typeof ProfileDocument>;
