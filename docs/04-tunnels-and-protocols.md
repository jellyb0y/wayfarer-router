# 4. Tunnels and protocols

> **Superseded in part, 2026-09-21.** The argument below — that a protocol should cost
> nothing here because the core describes itself — is sound about this repository and
> wrong about the person using the device. See
> [*What the owner actually met*](#what-the-owner-actually-met-2026-09-21) at the end of
> this document, and Epic E in [13-plan](13-plan.md). The analysis of the alternatives
> stands; the conclusion drawn from it does not.

This is the document to read if you read only one. Everything else is plumbing;
this is where the project either stays cheap to extend or turns into the thing it
was built to avoid.

## What the alternatives get wrong

Four mature projects were examined to see how they model protocol configuration.
The pattern is consistent and the cost is measurable.

**homeproxy** (LuCI, sing-box based) describes a node as one flat record with
protocol-prefixed fields — `hysteria_*`, `vmess_*`, `tuic_*` — and controls
visibility with about 130 `depends()` calls in a 1465-line view file. The
generator then builds a single flat object containing the fields of *all*
protocols and strips the empty ones, resolving name collisions such as `version`,
`uuid` and `password` with conditionals on the node type. The list of fields for a
protocol therefore lives in four or five places: the form, the client generator,
the server generator, and the subscription parser. Adding one protocol
(`anytls`) was a commit touching 5 files, +86/−5 lines.

**passwall2** does better on one axis: cores are pluggable by dropping a file into
a directory, and each core namespaces its options with a prefix, so core-specific
fields cannot collide. Protocol availability is gated on detected binary features
and versions. But generation is still imperative — a ~600-line `gen_outbound` with
40-plus `if protocol ==` branches, duplicated per core, plus a 2600-line
subscription parser.

**nikki** (mihomo based) has no protocol model at all, which is the strongest
counter-argument to hand-written forms. Its profile view is 90 lines: a
subscription URL and an upload button. The configuration is the provider's own
YAML, with user and generated layers merged over it. A profile is simply a
switchable unit: `file:<name>` or `subscription:<id>`.

**OpenClash** likewise: profiles are files, switching is a path change,
subscriptions go through an external converter, then merge, then validate, then
swap.

**podkop** supports four protocols with typed builders and, for everything else,
an escape hatch: paste a raw outbound JSON.

Two failure modes recur. The field list duplicated across three to five places,
and "skipping unsupported format" where a format is simply not modelled. Both are
symptoms of the same cause: **the project maintains its own description of
somebody else's schema.**

## The decision: do not maintain that description

`sing-box schema` emits a JSON Schema generated from the binary's own Go types,
including the build tags that binary was compiled with. Verified on the target
board:

```
$ sing-box schema | wc -c
444895
```

Draft 2020-12, **93** definitions, outbounds expressed as a `oneOf` discriminated by
`type`, with enums, defaults and numeric bounds. It also carries `x-tag-reference`
(171 occurrences), which marks the fields that reference another object's tag — enough
to render a tag picker without knowing anything about the protocol. Every branch
declares `additionalProperties: false`, so validation is strict rather than permissive.

Two corrections to an earlier revision of this paragraph, both measured on the 1.14.0
binary: the definition count is 93 and not 94, and **the union is not flat.** Its
`oneOf` has 20 entries, one of which is itself a `oneOf`; flattened it is 21 branches,
and `snell` occupies two of them, separated by a second `const`. The consequences for
the form resolver are in [08-ui.md](08-ui.md).

Consequences, and they are large:

* **A tunnel is stored as a sing-box outbound object, verbatim.** No prefixes, no
  translation layer. Generating the core configuration is assembly and validation,
  not transformation.
* **Protocol availability is discovered, not declared.** The schema comes from the
  installed binary, so a build without QUIC support simply does not offer
  Hysteria. This is what passwall2 achieves with hand-maintained version checks.
* **A protocol the core gains needs no code here.** It appears in the schema, the
  generic form renders it, validation accepts it.

The schema is fetched once per `(version, build tags)` pair and cached. It has two
gaps rather than one, and only the first was known when this was written:

* It contains **no `description` or `title` fields at all**, so labels and help text
  are ours. That is addressed by a metadata overlay, below, and it is a small,
  optional, per-field cost rather than a prerequisite.
* It contains **no `x-secret` annotations either**, so nothing in it says which fields
  are credentials. That one is not cosmetic: left alone, a VLESS `uuid` and a WireGuard
  `private_key` would be stored unwrapped and written into an export meant to be
  shared. The annotation is stamped on from the overlay *and* from a name rule that
  fails towards redaction — see [10-security.md](10-security.md).

The schema is treated as **input**, not as a fact. It comes from a binary, but a
malformed, cyclic or enormous one must fail the fetch cleanly rather than wedge the
daemon: there is a size ceiling checked before parsing, references are inlined with a
depth bound, and a remote `$ref` is refused rather than fetched — a schema that could
pull in a URL would turn a binary's output into a network request made by a root
daemon.

## Providers

> **Deleted, 2026-09-21.** The registry, the five provider ids and the `raw` escape hatch below
> no longer exist. Kept because the reasoning is what the catalogue was argued against; see
> [*What the deletion actually removed*](#what-the-deletion-actually-removed-and-one-thing-it-moved-2026-09-21).


A provider is needed only where a tunnel is *not* a plain sing-box outbound.
There are three such shapes, and they cover everything encountered so far.

```ts
interface TunnelProvider<Config = unknown> {
  id: string                    // "singbox-outbound" | "openvpn" | "external-socks" | "raw"
  title: string

  /** JSON Schema for `config`. For singbox-outbound this is the schema
   *  from the installed binary; for the others it is ours. */
  schema(ctx: SchemaContext): Promise<JSONSchema>

  /** Pure. Contributes to the desired state. No I/O, no side effects. */
  plan(cfg: Config, ctx: PlanContext): TunnelPlan

  /** Optional health probe, used by the policy watchdog and the status view. */
  probe?(cfg: Config, ctx: ProbeContext): Promise<TunnelHealth>

  /** Optional: what this provider needs installed, for capability reporting. */
  requires?(cfg: Config): BinaryRequirement[]
}

interface TunnelPlan {
  outbound: object              // goes into the core configuration
  files?: ManagedFile[]         // e.g. an OpenVPN profile, a client config
  units?: DesiredUnit[]         // e.g. wf-openvpn@hq
  interfaces?: string[]         // interfaces this tunnel will create
  dnsServer?: DnsServerSpec     // a resolver reachable only through this tunnel
}
```

### The three shapes

**1. `singbox-outbound`** — the core speaks the protocol natively. VLESS, VMess,
Trojan, Shadowsocks, Hysteria2, TUIC, SSH, AnyTLS and the rest.
`plan()` returns the stored object as the outbound and nothing else. Schema comes
from the binary. **Zero code per protocol.**

**1b. `singbox-endpoint`** — the same thing, into a different array.

An earlier revision of this document listed WireGuard among the protocols an *outbound* covers.
Measured on the bench board (1.14.0): `$defs/Outbound` flattens to 21 branches and **wireguard is
not among them**. It is an `Endpoint`, alongside `openconnect`, `openvpn-client`, `openvpn-server`
and `tailscale`, and endpoints go into `config.endpoints[]` rather than `config.outbounds[]`. The
wrong reasoning was reading "the core speaks it natively" as "the core configures it as an
outbound"; the core gained a second array for the protocols that create an interface of their own.

The zero-code argument is identical, so this is a second provider and not a second code path: same
schema source, same verbatim storage, different destination. Built now rather than later, because
retrofitting a destination into the emit path, the registry and every routing reference is exactly
how one shape becomes two.

Two constraints on it:

* **Only client-shaped endpoint types are offered as tunnels.** `openvpn-server` listens. An
  endpoint that listens is a different feature with different consequences — an open port on
  whatever network the device is plugged into — and mixing the two in one picker is how somebody
  turns a travel router into a server by accident. `wireguard` is curated; everything else stays
  reachable through `raw`, for anyone who knows what they are doing.
* **Endpoints create interfaces**, so the invariant checks that care about generated names and
  collisions have to see them too.

**2. `openvpn`** — an external daemon owns the tunnel; the core binds to the
interface it creates.

The measured build speaks this protocol natively, as the `openvpn-client` endpoint above, and the
managed external provider is still the supported path. That is a choice with a cost, so both halves
are stated.

The three behaviours this provider exists for all depend on the client's own control channel and its
script hooks: suppressing pulled routes, capturing the resolver address the peer pushes, and warning
when reset counts suggest a shared certificate. From inside the core none of them is available, and
losing the pushed-DNS capture specifically produces a tunnel that comes up and resolves nothing —
intermittently, depending on which gateway answered. Two further reasons: separate processes fail
independently, where a core restart bounces every tunnel at once; and build tags vary between builds,
so a device whose core lacks `with_openvpn` still works with the external provider. Portability of
the default matters more than one fewer process.

The native endpoint remains available to anyone who wants it. It lacks the pushed-DNS capture and the
certificate warning, and that is the trade rather than a prohibition.

```jsonc
outbound: { "type": "direct", "tag": "hq", "bind_interface": "tun-hq" }
units:    [ "wf-openvpn@hq" ]
files:    [ "/etc/wayfarer/openvpn/hq.conf", "…/hq.auth" ]
```

The same shape serves any daemon that produces an interface. The reason this works
at all is that a tunnel of any nature reduces to a tag; the routing engine and the
interface never learn what is inside.

Three details that are not optional, each a silent failure otherwise:

* The daemon must be started with pulled routes ignored. A server that pushes
  `redirect-gateway` will take over the default route, and several tunnels will
  then fight over it; a server that pushes `192.168.0.0/16` will capture the
  management network and the device becomes unreachable. Routing decisions belong
  to the core, so the client is told to take the interface and nothing else.
* A pushed DNS server address is *not* filtered, because it is needed — but it
  can change between reconnections depending on which gateway the session lands
  on. An up-script captures the actually-pushed address and hands it to the
  daemon, which updates the resolver entry for that tunnel. A value hardcoded at
  configuration time is right about half the time, and the failure looks like "the
  tunnel is up but names do not resolve".
* One client certificate connects once — on some servers. Those without duplicate-CN
  allowed assign the same address to a second client and the two then evict each
  other in a loop. Measured on one such server: a second client produced repeated
  resets on both ends, zero when only one was connected. Another server assigned
  distinct addresses and tolerated both.
  Because the configuration alone cannot tell these apart, the warning is raised
  **only when reset counts actually rise** on a tunnel whose certificate is also
  used by another enabled tunnel. Warning on the configuration alone would fire on
  the servers where it is harmless, and warnings that are usually wrong teach
  people to ignore warnings.

**3. `external-socks`** — a separate client process the core cannot replace,
reached over loopback.

```jsonc
outbound: { "type": "socks", "tag": "x", "server": "127.0.0.1", "server_port": 10808 }
units:    [ "wf-socks@x" ]
```

Needed whenever a protocol or extension exists in another implementation but not
in the core — for example a post-quantum VLESS encryption mode available in one
core and not the other. Rather than wait, run the other client next to the core.
Port allocation is managed by the daemon so two such tunnels cannot collide.

**4. `raw`** — the escape hatch. A textarea taking an outbound JSON object,
validated only against the binary's schema. This is what makes the system never a
blocker: a protocol released today is usable today. Every project examined that
has this escape hatch uses it constantly; every project without one has a
"skipping unsupported format" branch instead.

## Transports: obfuscation as a separate, composable thing

> **Deleted, 2026-09-21.** A transport is not a separate thing a person composes any more: it is
> `config.entryPoints` of the `Cloak + OpenVPN` catalogue entry, chosen with the tunnel because it
> arrives with the tunnel. The composability argued for here is what put a loopback port in two files
> that an operator had to keep in agreement by hand.


An obfuscation layer is not a tunnel and not a protocol. It is a local listener
that a tunnel points at, and it belongs to its own small interface so it can be
reused by more than one tunnel type.

```ts
interface TransportProvider<Config = unknown> {
  id: string                    // "cloak", …
  title: string
  schema(ctx): Promise<JSONSchema>
  plan(cfg: Config, ctx: PlanContext): {
    files?: ManagedFile[]
    units?: DesiredUnit[]
    localEndpoint: { host: string; port: number }
  }
}
```

A tunnel lists zero or more transports. Each produces a local endpoint, and the
tunnel's remote list becomes those endpoints. One tunnel with four transports is a
normal configuration: four obfuscated entry points at different sites, and the
client rotates between them.

Two behaviours worth knowing before designing around this shape:

* **An obfuscation client can keep listening after its far end has died.** The
  local socket stays open, so the tunnel daemon sees nothing wrong and only its own
  keepalive detects the failure. Whatever keepalive the server pushes is therefore
  overridden with a shorter, local one. Measured on one such setup: recovery went
  from 120 seconds to 42 by ignoring the pushed value and setting a local one, and
  the nominal value had to be chosen by measurement — a nominal 30 produced a real
  61.
* **These protocols authenticate on a timestamp.** A device whose clock is wrong
  will fail to establish the session while every direct tunnel works normally. On
  a board without a battery-backed clock this is the default state after being
  switched off, which makes it a first-class concern rather than an edge case. See
  [12-hardware-invariants.md](12-hardware-invariants.md).

## Uplinks and access points, same pattern

```ts
interface UplinkProvider { id: "ethernet" | "wifi-sta" | …; schema; plan }
interface AccessPointProvider { id: "hostapd" | …; schema; plan }
```

`wifi-sta` additionally exposes `scan()` and `signal()` through the platform
layer. Modelling the uplink as a provider is what makes an LTE modem or USB
tethering an added file later rather than a refactor.

## Subscriptions: the one place imperative code is correct

> **Superseded in part, 2026-09-21.** The first sentence is still the whole point: this is parsing, and
> parsing is code. Everything below it about *what the parsers produce* is wrong now. They normalised
> into a sing-box outbound, which nothing in this product can store, and there were six of them for six
> schemes the product does not all run. See
> [*Six parsers for three protocols, and the output nothing could save*](#six-parsers-for-three-protocols-and-the-output-nothing-could-save-2026-09-21)
> at the end of this document. The shape of a parser — a test predicate beside a parse function — is the
> part that survived.

Subscription link formats — `vless://`, `vmess://`, `ss://`, `trojan://`,
`hysteria2://`, `tuic://` — are not specified anywhere. They differ between
clients, some are base64-wrapped JSON, and several have client-specific variants.
No schema can be derived; this is parsing, and parsing is code.

The best-organised implementation found is a registry of parsers, each with a test
predicate and a parse function, normalising into one internal representation, with
separate producers per output format. That shape is worth copying:

```ts
interface SubscriptionParser {
  id: string
  test(line: string): boolean
  parse(line: string): SingBoxOutbound
}
```

Registry, one parser per scheme, a fixture file per real-world variant, and a test
that every fixture round-trips.

**Refresh is automatic, on a timer.** A provider that moves an endpoint should not
require the operator to notice. But refreshing must never silently change *which*
endpoint the policy prefers: if a node referenced by the priority order disappears
from the subscription, the stored node is kept, the tunnel keeps working, and the
interface reports that the subscription no longer offers it. Re-pointing the policy
is a decision, not a side effect of a background fetch. The existing packages in this area are small and
young; the parsers are worth writing here with tests rather than taking on a
dependency whose failure mode is a silently mangled endpoint.

## Rule sets, and why an unfetchable one is refused rather than ignored

A rule set is a list of match terms — a geo database, a blocklist — referenced by tag from a routing
rule. `remote` sets are downloaded by the proxy core; `local` ones are read from a file on the device.

**The core resolves every rule set when it starts, and one it cannot obtain is fatal to the whole
process.** That is the fact that decides how this is validated. A `remote` set with no URL, or a
`local` set with no path, does not degrade into "that one rule matches nothing": it takes the tunnels,
the access point's routing and the management path's exemptions down with it, and the symptom is a unit
that will not start for reasons which never mention a rule set. So both are refused at plan time, where
the problem is one field with a pointer into the document, rather than at apply time where it is a
service that failed and a journal to read.

A `remote` set on a profile with **no enabled uplink** is a warning rather than a refusal. It is a
legitimate configuration on a device that has a working uplink, and refusing it would make the feature
unusable — but the failure it predicts is the confusing kind, so the warning says plainly that the core
will not start at all and that the message it gives will not mention the rule set. The hint names the
alternative that needs no network: a local set with a file on the device.

Mixed sources (`remote` with a `path`, `local` with a `url`) are warnings naming the field that is
ignored, so the profile says where something comes from without a reader having to know which field
wins.

## What adding a protocol costs

> **Superseded, 2026-09-21.** The table below prices a protocol at nothing. That price was real for
> this repository and was paid, in full, by the owner's configuration. Epic E moves it back here and
> states the new cost openly at the end of this document.


| Situation | Work required |
|---|---|
| The core gains a protocol | **Nothing.** It appears in the schema and renders. |
| …and you want nice labels for it | ~10 lines of metadata overlay, optional. |
| A protocol exists only in another client | One `external-socks` configuration; no code if the client takes a config file. |
| A new tunnel daemon that creates an interface | One provider, roughly the size of the OpenVPN one. |
| A new obfuscation layer | One transport provider. |
| A new subscription link format | One parser plus fixtures. |
| Something nobody has modelled yet | Paste the outbound JSON. Works immediately. |

Compare with the measured baseline elsewhere: one protocol, five files, and a
field list that now disagrees with itself in four places.

## Transports, and the orphan rule seen in reverse

> **Partly superseded, 2026-09-21.** The orphan lesson stands and is now enforced for every file a
> catalogue entry produces. The shape it is told through — a separate `transports` list with a
> command line in it — is gone.


The unit template `wf-transport@.service` shipped from the beginning and named `<transportDir>/%i.sh`.
**Nothing wrote that file and no instance was ever enabled** — a configured transport reserved a port and
did nothing else.

This is the mirror image of the orphan the artefact-consumer rule was written for: **a unit with no file,
rather than a file with no unit.** Both rules are needed, and the second one is easier to miss because the
artefact table is where people look.

The provider takes a command and a **required** `localPort`. Required, not chosen by the daemon, because a
transport's port appears in the tunnel's own configuration — often inside an opaque blob nothing here can
rewrite — so a port the daemon picked would not be the port the tunnel dials.

The script is `0700`, an optional configuration file `0600`, and both are emitted through their own channel
in `EmitResult` because **a transport is not a tunnel**: nothing selects it and it has no outbound object.

Proved on the board with a transport that really listens: `wf-transport@obfs` and `wf-socks@viaobfs` both
`active enabled`, `LISTEN 127.0.0.1:41000`.

## Subscriptions: where they live, and the nine rules a refresh follows

**Subscriptions live in the profile**, as a top-level list, not in device state. They are configuration,
they must travel with the document, and the URL usually embeds a credential.

That URL carries `x-secret` with a kind of its own, `subscription-url`. It is named as its own kind
because what a person must go and find is *"the subscription link from the provider"* — telling them a
`token` is missing sends them looking for the wrong thing. The consequences are the ordinary ones for a
secret here: redacted on read, redacted in an export, and an import that names what is missing.

Tunnels derived from a subscription carry `derivedFrom: { subscription, node }`, so a refresh may replace
only that subscription's derived tunnels and **never a hand-authored one**. The derived mark survives every
refresh, because it is what makes the next one safe.

`refreshSubscription` is pure — document and parsed nodes in, next document and an account out — with one
test per rule. The rules worth stating:

* **A dropped node is removed only when nothing references it.** A node that disappears from the feed but
  is named by policy or by a routing rule stays.
* **Identity is server, port and protocol**, so a rename is an *update* rather than a delete plus an add —
  which would break policy naming the old id.
* **Policy is never edited**, in either direction. A refresh does not reorder failover priority or add to
  exclusions.
* **A timer may apply `hot` and `service`, and must stop at `network`.** There is nobody at four in the
  morning to answer a confirmation window, and an unconfirmed network change reverts three minutes later —
  so an unattended refresh would take the device down and put it back, on a timer.
* **Every refresh is recorded in the event ring**, because it is the one path where the device edits its
  own configuration unasked.

### The review finding: deletion followed by refusal

A refresh could **delete a tunnel a routing rule still named**, and then refuse to apply — leaving the
tunnel already gone.

The referenced set is now built from policy **and** from the routing rules, read off `action.outbound`
wherever it appears rather than from a list of rule kinds. A list of kinds would be a second description of
the schema and would stop covering a kind added later, which is exactly how this was missed.

## OpenVPN's up-script treats the peer as hostile

The generated unit named `/opt/wayfarer/bin/tunnel-up` and **nothing in the tree wrote it** — a unit
referring to a file we never shipped. It is now `deploy/bin/tunnel-up`, installed by the installer rather
than generated, because it runs **as root, under OpenVPN, on data the peer controls**.

Everything in it assumes the peer is an attacker:

* exactly one `eval`, for the indexed variable lookup, and it cannot interpolate a value;
* only `dhcp-option DNS <ipv4>` is recognised, matched against a pattern rather than parsed;
* anything else is written to a `.rejected` file and logged, rather than silently dropped;
* the output filename is derived from the tunnel id **the unit set**, never from anything the peer said.

Tests assert it installs no routes and that the peer's text never reaches a shell.

**A name mismatch, caught before it ran:** the unit sets `WAYFARER_TUNNEL`, the script read
`WAYFARER_TUNNEL_ID`. Every captured resolver would have landed nowhere, silently, because the script
exits quietly when the id is absent rather than guessing a filename. A test now compares the two rather
than asserting either.

### The transcript a real peer produced

A peer was run pushing the three things that matter: `route 192.168.77.0 255.255.255.0` — **the
management network** — plus `redirect-gateway def1` and `dhcp-option DNS 10.99.0.1`.

Before: routing table **unchanged**, captured DNS **empty** — the route was correctly refused and the
resolver was lost with it. `route-nopull` suppresses *everything* the peer pushes, including the
`dhcp-option` the up-script exists to read.

After removing `route-nopull`, with `route-noexec` plus the two `pull-filter ignore` lines still keeping
the peer off the routing table: `OPTIONS IMPORT: --ip-win32 and/or --dhcp-option options modified`, routing
table still unchanged, `testvpn.dns 10.99.0.1` captured, and `testvpn.rejected` holding
`dhcp-option WINS 10.99.0.9`.

**Only a real peer shows this**, because the contradiction is between two options that each look correct.

### The reset-loop heuristic, and what it took to exercise

`core/tunnel-health.ts`: **three restarts with the current attempt under two minutes old** is the
connect-drop-connect pattern. A tunnel up for an hour that restarted three times last week is not
resetting.

Exercised with a real peer that rejects us: `NRestarts` climbed to 5, the apply failed verification and
reverted, and `way doctor` printed *The tunnel "certtest" has reconnected 5 times and has not stayed up…* —
naming the certificate rather than the clock, correctly, because this board's clock **is** synchronised.
The ordering matters: on a board with a wrong clock the clock is named first, because correcting it needs a
time query and every timestamp-authenticated transport fails while it is wrong.

## Probing a destination tunnel: the obvious target is the wrong one

> **Superseded 2026-09-24 (plan row G30).** This section and the next one describe a guard that was told
> what to fetch through a tunnel and blocked the tunnel when the fetch failed. Both halves are gone: see
> *The guard asks the tunnel, and blocks nothing* below. They are kept because the reasoning in them —
> and where it went wrong — is the record of how the design got here.

A tunnel's health is decided by fetching something **through** it. For a tunnel whose job is egress that is
a connectivity-check URL on the public internet, and the device-wide probe list is exactly right.

For a tunnel that exists to reach internal resources it is exactly wrong, and wrong in two separate ways.

**It has no route to the internet at all.** Probing it with a public URL reports it dead on every round.
With `onUnavailable` defaulting to `block`, that refuses precisely the traffic the tunnel exists to carry —
a tunnel that works perfectly, reported broken by a measurement of a path it was never meant to have. So
`tunnel.probe.endpoints` takes something that exists *behind* that tunnel, and when nothing is given
**nothing can be measured about that tunnel at all**: health is `null`, the watchdog stays where it is,
and it records that it cannot move.

**This reverses what this section used to say, and the old reasoning is why.** It said the watchdog falls
back to **liveness** — the client is running and the core reports the outbound usable — and called that
weaker evidence about the right path. It is not evidence about the path at all. Measured on the bench
board, 2026-09-21: a tunnel held its unit active for an hour without once completing a key exchange, and
liveness reported it healthy for the whole hour. A verdict that cannot tell a working tunnel from one that
never negotiated is not a weak measurement, it is a confident answer to a different question — and a
watchdog acting on it moves for a reason that has nothing to do with whether traffic flows. `null` and
standing still is the honest outcome, and it is what the kill switch has to be built on.

**The obvious internal target is also wrong, and this is the part that costs an afternoon.** The natural
choice is the tunnel's own bare name — the domain the tunnel exists for. Measured against a real corporate
tunnel: the bare name resolved to dozens of addresses behind a round robin, **most of which serve nothing
on 80 or 443**, so a probe against it failed most rounds while the tunnel was entirely healthy. A specific
service behind the tunnel answered every time.

So the rule is: **probe a service, not a domain.** `wplan.internal.example` rather than `internal.example`.
A name that exists to be resolved is not a name that exists to be fetched, and the two are easy to confuse
because one is a prefix of the other.

The failure has the shape this project keeps finding: the measurement was real, it was repeatable, and it
was of the wrong thing — so it was believed. See
[16-implementation-notes](16-implementation-notes.md#the-questions-collected), question 7.

### When nothing is given, the peer's own address is measured — if the tunnel has one (2026-09-23)

`null` and standing still was honest, and on the bench board it hid nine hours. `corp` (Cloak + OpenVPN,
one entry point) could not reach its entry point from at least 22:15 on 2026-09-22 until 07:32:27 the next
morning — `connect: connection timed out` from the Cloak client all night, `TLS handshake failed` 93 times
inside it, `wf-openvpn@corp` never restarted — and the watchdog read it every round as *not measured (no
probe target)*, exactly as it read the working `relay`. A dead tunnel and a live one were one reading.

So a guard with no `probe.endpoints` now gets a target **when one is knowable from the tunnel itself**: the
resolver its OpenVPN peer pushed, which `tunnel-up` already captures to `/run/wayfarer/tunnel/<id>.dns`,
sent an ICMP echo **bound to the tunnel's own interface** (`ping -I`). For `corp` the peer pushes
`dhcp-option DNS 10.122.0.1`, which is also its `route-gateway` — the peer's end of the link.

* **Why an echo and not the core's URL probe.** The URL probe (`/proxies/<name>/delay`) is the only kind that
  existed, and it needs an HTTP server at the far end. A gateway or resolver promises none, and a fetch
  refused there reads as a dead tunnel — which with `onUnavailable: 'block'` refuses its traffic on a misfire.
* **Why bound to the interface.** Root-owned traffic takes the main table on this device (`wf-firewall`'s uid
  rules), so an unbound echo with the tunnel down leaves by the default route, and a host answering there
  would read as a live tunnel. `SO_BINDTODEVICE` skips the routing decision.
* **Three outcomes, not two.** No reply, *No such device* and *Network is unreachable* are a dead tunnel. An
  echo that could not be sent at all — no `ping` binary, no permission — is not counted, and a round made only
  of those is `not measured` with the reason, so a missing binary never blocks a tunnel.
* **Both halves must be the tunnel's own.** An interface of its own, from the last plan
  (`tunnelUnits[].interfaces`), and a pushed address, from the capture. A tunnel carried through a local
  client — VLESS through xray, a proxy — creates no interface and never gets a default, whatever files
  happen to exist for it. That is what keeps this away from `relay`, the tunnel the owner's session runs
  over: asserted in `test/guard-default-target.test.ts` with a capture file named for it and every probe
  failing, and its outcome held field for field to what the watchdog produced before.
* **An explicit `probe.endpoints` always wins**, and what a failed measurement *does* is unchanged: the
  profile's `onUnavailable`, after the same `failStreak`.
* **A tunnel whose peer has pushed nothing since boot** (`/run` starts empty) stays `not measured` and says
  that is why. The capture is written on connect and never removed, so a tunnel that connected once and
  then died is measured against its last peer's address — which is the measurement wanted.

The watchdog's observer now fails from the **first** unreachable round of a guard, not only once it is
blocked: blocking waits for the streak, and never comes when the selector cannot be moved.

## The guard asks the tunnel, and blocks nothing (2026-09-24)

**The symptom.** Measured on the bench board, 2026-09-24: `partner` (OpenVPN, `onUnavailable: block`)
carried `probe: { endpoints: ["http://172.30.0.212/"] }` — one of its **own resources**
(`172.30.0.212/32` is in its `resources.ipCidr`), put there because the field's documentation said *"give a
destination tunnel something that exists behind it"*. Overnight that server stopped answering on port 80
(it still answered HTTPS with `202`). The guard read the tunnel dead and moved `wf-guard-partner` to `block`,
refusing every destination behind it — while its pushed `route-gateway` `10.136.0.1` answered pings over
`wfvpnprt` in 95 ms with no loss. It was fixed by hand by removing the probe, after which the 2026-09-23
default applied: an echo to the pushed resolver — for `partner` `77.88.8.8` and `8.8.8.8`, public
resolvers that say nothing about the tunnel.

**A finding that changes the account of the night.** Measured against sing-box 1.14.1 on 2026-09-24
(`apps/daemon/test/fixtures/core-api/delay-http-url-ignored.txt`): the core's delay test replaces any
`http://` URL with its own default and dials `www.gstatic.com:443` — for `http://cp.cloudflare.com/…`, for
a blackhole address, and with no URL at all; only an `https://` URL is dialled as given
(`delay-https.txt`). If the board's 1.14.0 does the same — **an assumption until checked there** — the
guard never fetched `172.30.0.212` at all: it measured Google through `partner`, and what failed overnight was
that path. Either way the conclusion stands, because both the URL the owner wrote and the URL the core
actually used were things the tunnel carries rather than the tunnel. The same applies to the device-wide
`policy.probes.endpoints`, which are both `http://`: every failover probe on 1.14.1 measures
`www.gstatic.com`.

### What replaced it

**1. Liveness belongs to the catalogue entry** (`CatalogueEntry.liveness`, `core/liveness.ts`). The guard
is given a tunnel's id, its protocol and the interfaces its last plan recorded, and nothing it carries.

* **OpenVPN and Cloak + OpenVPN — the peer's own keepalive.** The generated configuration ends in
  `status /run/wayfarer/openvpn/<id>.status 5`; the client rewrites that file every five seconds, and its
  `TCP/UDP read bytes` counts every byte read from the link, the peer's keepalive pings included. Measured
  with OpenVPN 2.6.14 against a peer pushing `ping 15`, `ping-restart 120`: idle, the counter went
  0 → 4927 → 5039; with the server silenced it stayed at 5363 while write bytes kept rising; at the
  120 s ping-restart it reset to 0 and the interface disappeared (`test/fixtures/openvpn/`). The tun's
  own counters are not this: a keepalive is a transport packet and never reaches the tun. The status file
  won over the management interface because the socket takes one client at a time and must be held open
  for real-time counts. A counter unchanged for three of the keepalive intervals the peer pushed reads
  dead — the `ping N` in the client's own PUSH_REPLY journal line, because it is in no environment
  variable (`ping 15` → 45 s, `ping 10` → 30 s); 60 s when that line is not found, and the reading says so.
* **Sampled every five seconds, not once a round** (corrected 2026-09-24, round 2). The first build read
  the counter only in the watchdog round, so the silence clock started when a round *noticed* the counter
  had stopped. Measured on the board: `corp`'s transport stopped at 08:39:27, the counter froze at
  10662, and the first dead reading came at 08:41:22 — about 115 s against a claimed 90. The counter is
  now sampled at the rate OpenVPN rewrites it, and a sample that changes a tunnel's standing runs a round
  at once.
* **Confirmed by an echo to the gateway the peer pushed**, over the tunnel's own interface. It counts only
  if that gateway has answered **on this connection**: a gateway that never answers ICMP is *not
  measurable*, never dead. The connection is the capture's inode — `tunnel-up` renames a new
  `<id>.gateway` into place on every connect. The confirming signal now confirms: a gateway that answered
  on this connection and has stopped, **together with** a counter flat across two status writes (10 s),
  reads dead in the round that sees both. Neither alone is — an idle peer's counter is flat between
  keepalives, and one echo can be lost on a working path.
* **Detection time, measured on the board** (corrected 2026-09-24, G31). The sentence above said such a
  tunnel "is dead at once", and it was read as "a dead tunnel is detected in about 10 s": the 10 s is only
  the counter's flat window inside one reading, and a reading happens when a round runs. Measured on the
  bench board by stopping a tunnel's transport and timing the first dead reading: **~27–32 s when the
  gateway echo confirms**, **~45–52 s on the keepalive alone**. The owner accepted ~30 s. The arithmetic
  that bounds it: with a gateway that has answered on this connection, the first round that starts 10 s or
  more after the peer's packets stop — up to the 30 s interval plus 10 s, plus up to 8 s of echoes, so at
  most about 50 s. On the keepalive alone, 3 × N + 15 s (a 5 s status write and a 5 s sample on each
  side), then an immediate round: 45 s for `ping 10`, 60 s for `ping 15`, 75 s when the interval is
  unknown; add whatever the round measures before that tunnel (up to about 8 s per OpenVPN tunnel whose
  echoes are lost). A `fall-through` tunnel's traffic moves only after **two** consecutive dead rounds
  (G31, below), so about a round later still.
* **Learning the gateway took a route of our own.** Measured with 2.6.14: with the peer's routes filtered
  and no `route` line in the client configuration, OpenVPN builds no route list and `route_vpn_gateway` is
  **absent** from the up-script's environment, although the PUSH_REPLY carried `route-gateway 10.136.0.1`.
  The generated configuration therefore carries `route 192.0.2.1 255.255.255.255` (TEST-NET-1): with it
  `route_vpn_gateway` is `10.136.0.1` for a `topology subnet` peer and the point-to-point peer (`10.136.0.5`)
  for `net30`, and `ip route` shows the route installed in neither case, because `route-noexec` stands.
* **The status directory is not `/run/wayfarer/tunnel`.** The resolver watch wakes on every change there,
  and a file rewritten every five seconds per tunnel would wake it every five seconds. It is
  `/run/wayfarer/openvpn`, created by the unit template's `RuntimeDirectory=` (preserved on stop): OpenVPN
  opens the status file once at start and, if the directory is missing, writes none for the life of the
  process.
* **VLESS and the proxy entry — no session, so traffic first and neutral checks only when idle.** Each
  round samples the core's `GET /connections` and counts only the **growth** of downloaded bytes per
  outbound since the previous sample (a connection present in both contributes its difference, a new one
  all of its bytes, a gone one nothing; uploads never count). Any growth is *alive* and no check is sent.
  Idle, the core's delay test is sent through the outbound to three neutral HTTPS checks (Cloudflare,
  Google, Mozilla), decided by majority of all three. xray's own health mechanism, Observatory, is the same
  request to a `generate_204` responder, which is why it was not added.
* **WireGuard** (F2) adds a kind — handshake age — to `LivenessMethod`; nothing in the guard changes.

**2. `tunnels[].probe` is gone** (schema 8). Stored documents lose it by migration; a document at 8 that
names it is refused by name (`tunnel_field_removed`), because every object in this schema refuses a
property it does not describe and the generic wording — `Unexpected property` — would not say it was
removed on purpose.

**3. Under `block` the guard measures and reports; it moves nothing.** Verified in the code before
relying on it: an OpenVPN outbound is `{type: direct, bind_interface: wfvpn…}` (`planOpenVpnBody`), so it
leaves by that device or fails; the VLESS outbound is either the core's own VLESS client or a SOCKS hop to a
local xray whose configuration holds one VLESS outbound and nothing else (`xrayConfig`); the proxy entry is
a SOCKS/HTTP outbound. None has a path around its server, so a dead tunnel's traffic fails whether or not
the selector moves. The selector is still generated — removing it would restart the core — and a selector
found on `block`, which nothing in this build puts there, is put back on its tunnel once and recorded
(`guard.unparked`).

**`fall-through` was not what it said** until G31, the same day: no selector was generated for it and
its rule pointed at the tunnel's own outbound, so while the tunnel was down its traffic failed exactly as
under `block`. It is now real — see *`fall-through`: a route around a dead tunnel* below.

**4. The reading.** `GET /api/observers` → `tunnel-watchdog` → one item per tunnel with `state`,
`method` (peer keepalive, gateway echo, traffic through it, neutral endpoints, not measured), `note` (the
reading), `action` (what was done — for a dead tunnel on `block`: *its traffic is NOT being blocked by the
guard* and why) and `tone` (`bad` is red). Status shows each; the Tunnels list shows `state, by method`.

## `fall-through`: a route around a dead tunnel (G31, 2026-09-24)

**The finding.** While building G30: a tunnel on `onUnavailable: fall-through` had no selector and its rule
pointed at the tunnel's own outbound, so the interface's *"Let it through: Traffic goes out the ordinary way
instead"* was false. The owner chose to build it rather than remove the option, with one condition: since a
false reading here **leaks** traffic outside the tunnel, only the G30 liveness answer may move it.

**The configuration** (`generate/core-config.ts`, `routing-rules.ts`). Per enabled `resource` tunnel on
`fall-through`:

* `wf-fall-<id>` — a selector of **the tunnel, then `wf-selector`**, default the tunnel,
  `interrupt_exist_connections: true`. The tunnel's routing rule points at it. `block` tunnels are
  untouched: `wf-guard-<id>` is still the tunnel and `block` and nothing else, so no member that could leak
  is added to them.
* **Why `wf-selector` is "the ordinary way".** The exact meaning — *what this traffic would do if the
  tunnel's rule did not exist* — cannot be expressed: a routing rule is final, the core has no "skip this
  rule" a selector could choose, and the rules below can split the tunnel's resources several ways.
  `route.final` is defined for every profile and is where the rule list ends. On the bench board it is
  `direct` (no alternative tunnel, `onAllDown: direct`). **Rules below the tunnel's are not consulted while
  it falls through**, and on the board that matters: `hq`'s `10.0.0.0/8` covers `corp`'s
  `10.148.0.0/16` and `10.122.0.0/24`, so a fallen-through `corp` sends those destinations `direct`, not
  into `hq`. The preview beside the rule says so.
* **Names.** A tunnel with a resolver of its own (`tunnels[].dns` — `corp`: `10.122.0.1` for
  `corp.internal`; `hq`: `10.184.100.5` for `hq.lan`) has its DNS server's `detour` changed
  from the tunnel to `wf-fall-dns-<id>`: the tunnel, then `wf-fall-dns-out`. The server's **address** is
  fixed in the configuration — only the path to it can be switched — and those resolvers exist only
  behind their tunnels, so sending the query to the same address the ordinary way would put it on the
  uplink towards an address that is not there (or is somebody else's). So the ordinary member is a SOCKS
  outbound to a SOCKS inbound on `127.0.0.1:10853`; the **first** routing rule answers anything arriving
  there as DNS (`hijack-dns`), and the **first** DNS rule answers anything from that inbound with
  `dns-tunnel`, the resolver unmatched names use (`dns.final`). The loop never proxies anything: whatever
  reaches the inbound is answered as DNS or not at all, and it listens on loopback only. A fall-through
  tunnel without a resolver of its own (`partner`-shaped) needs nothing: its names already resolve through
  `dns.final`. Nothing of this is generated for a profile without a fall-through tunnel, so the board's
  configuration is unchanged by this build until a tunnel is switched. That sing-box 1.14.0 carries the
  query over a SOCKS5 UDP associate to its own loopback inbound and hijacks it was an assumption until the
  acceptance run below measured it.
* **Why not the alternatives.** *A DNS server whose detour is `wf-fall-<id>`*: permitted by the core (the
  board's `dns-tunnel` already detours through `wf-selector`) and enough for a public resolver, but it
  sends the query for `10.122.0.1` out of the uplink. *A local rule-set file the guard rewrites*: the core
  watches local rule-sets and reloads them, but `sing-box check` — which the reconciler runs before writing
  anything — fails on a rule-set file that does not exist yet, and the file would be state outside the
  plan. *DNS rules on `clash_mode`*: one global mode for every tunnel. *1.14's `evaluate`/response
  matching, or an address-limited rule*: read in the core's DNS router source (1.14.0, `dns/router.go`), an
  exchange that **fails** returns its error and does not fall to the next rule — only a *rejected* response
  does — and any such fallback would fire on a resolver's hiccup rather than on the guard's verdict.

**The guard** (`watchdog.ts`, `runFallThrough`). Out after `FALL_THROUGH_DEAD_ROUNDS` = **2** strictly
consecutive dead rounds; back after `FALL_THROUGH_ALIVE_ROUNDS` = **3** strictly consecutive alive rounds.
A not-measurable round moves nothing and resets both counts, so it is never one of the dead rounds. The
resolver selector is set to match the traffic selector's settled position every round. Events:
`guard.fell-through`, `guard.fall-through-ended`, `guard.switch-failed`.

**Measured on the board** (G31 acceptance, 2026-09-24, build `37f4ec3`, tunnel `corp` switched to
`fall-through` for the run and restored to `block` after). `wf-transport@corp-corpsg` stopped at T0:
both selectors moved to the ordinary side at **~45 s** (gateway echo and keepalive), the item read
`FALLING THROUGH` with `fallingThroughSeconds`, and `guard.fell-through` was recorded — earlier than the 60–90 s the
arithmetic gave. [assumption: the keepalive sampler's nudge, which runs a round as soon as a standing
changes, brought the second dead round forward; not separated on the board] While fallen through, `corp.internal` queries to
`10.44.0.1` were answered NXDOMAIN in 12–17 ms (324 ms through the tunnel), so the resolver loop works on
the real core, and `/connections` showed `10.148.0.1:443` carried `wf-fall-corp → wf-selector →
direct`. The transport restarted: the tunnel was up at ~20 s and both selectors were back on `corp` at
**~82 s**, so **~60 s after the tunnel returned** — three alive rounds. The other guards did not move.
Restoring `block` removed `wf-fall-*` and the `10853` inbound, and drift read clean.

**Restarts.** The core keeps a selector's choice in its cache file; the daemon remembers nothing. So the
position is read back each round and judged against what this process saw. Found on the ordinary route
**without** a dead reading from this process (an earlier run, or a hand): a dead reading confirms it (it
is then an ordinary fall-through, back after three alive rounds); an **alive** reading puts it back on the
tunnel at once; a reading that could not be taken **moves nothing** and it stays out. A core restart that
forgot the choice is re-derived the same way: still dead, it falls through again at once.
`guard.unparked` for a `block` selector found on `block` is unchanged.

*Corrected after the acceptance run.* The first build put a found position back on the tunnel on *alive
or not measurable*, reasoning that the tunnel is the direction that cannot leak. Measured on the board:
`systemctl restart wayfarer` with `corp` fallen through and still dead — the core did not restart —
put both selectors back on `corp` within 5 s, where they stayed ~60 s (12 samples) before moving out
again. A fresh process has no earlier keepalive sample, so its first rounds read not measurable, and the
rule turned every daemon restart or deploy into a minute of a dead tunnel swallowing its traffic. "Cannot
leak" was true and beside the point: the owner chose `fall-through` so this traffic would not be lost,
and not measurable is not evidence either way — so it moves nothing in either direction, here as
everywhere else. `test/fall-through.test.ts` replays the sequence: restart → not measurable ×3 → dead.

**The fence.** Traffic to a tunnel's own followed networks (in `route_exclude_address`, recorded in
`/etc/wayfarer/fence.json` by `core/device-follower.ts`) never enters the core: the kernel routes it by the
tunnel's interface route. Falling through changes nothing for it, and nothing fights: while the dead
tunnel's interface still exists (OpenVPN keeps it until `ping-restart`) that traffic fails into it; once
the interface is gone its route goes with it and the kernel's default route carries it out of the uplink,
outside the core — which is what the fence already did before G31, for `block` tunnels too. The follower
adds or removes a network only when a tunnel interface gains or loses it; the fall-through selectors are
not among its inputs, so a fall-through neither adds nor removes a fence entry. The fall-through moves
only what the core routes — the tunnel's `resources` and its names.

**The reading.** Each watchdog item of a tunnel whose traffic is leaving outside it reads `FALLING
THROUGH`, `tone: bad`, and carries `fallingThroughSeconds` — monotonic seconds from when this daemon first
saw it to that reading. The panel shows *"Falling through — traffic is leaving outside the VPN since
HH:MM"*, working the time out on the viewer's clock from that and the reading's `ageSeconds`; the board has
no RTC. The field is declared in `ObserversResponse` (a field the schema does not declare is dropped) and
copied by name in `core/observers.ts` (which drops what it does not name).

## A path broken behind a live peer is restarted by nobody (2026-10-09)

**The symptom.** On the bench board, 2026-10-09 09:38–09:42, the core logged
`dial tcp 10.127.0.32:443: i/o timeout` through `office` (OpenVPN, four `remote` lines, `remote-random`)
five times. Measured at 09:44 with the same session up since 08:16: an HTTPS request to `10.127.0.32`
bound to `wfvpnoff` (bypassing the core) failed after 8 s, while the pushed gateway `10.32.128.1` and the
pushed resolver `192.168.244.5` answered pings over `wfvpnoff` in 40–47 ms and the resolver accepted TCP
on 53. The watchdog read the tunnel `alive` by peer keepalive throughout.

**Why nothing restarted it.** Each mechanism that could was answering a different question, and each
answered it correctly:

* OpenVPN's `ping-restart 120` fires on silence from the peer. The peer was not silent.
* systemd's `Restart=always` fires when the process exits. It did not.
* The watchdog measures the tunnel's own liveness (*The guard asks the tunnel, and blocks nothing*,
  above) and never restarts a unit in any case. Measuring a resource behind the tunnel was removed on
  2026-09-24 because one closed port on one server read as a dead tunnel; this is the same situation
  seen from the other side — one dead path behind a live tunnel reads as nothing.

**What fixed it.** `systemctl restart wf-openvpn@office` at 09:43: the client reconnected to another of
its servers (`213.226.70.3`; pushed subnet `10.32.192.0/20`, resolver `192.168.242.5`, where it had been
`172.255.195.138`, `10.32.128.0/20`, `192.168.244.5`). The first request straight after the restart
still failed; a minute later three requests bound to `wfvpnoff` and three through the core all
answered `200` in 0.15–0.17 s. Whether the old server's path to `10.127.0.32` was broken, or that host
is reachable only from some of the servers, was not established.

**The decision.** A manual reconnect, on the API and as a button on each running tunnel
(`POST /api/tunnels/:id/restart`, [07-api](07-api.md)). An automatic reconnect on a failing resource was
not built: it needs exactly the per-resource probe that was removed for its false readings, and a
reconnect on a misfire drops every connection through the tunnel. That remains an open question for the
owner rather than a default.

## Public resolvers are reached over TCP (2026-10-07)

**Symptom.** Through the device, a speed test was fast and pages were slow, most of all a site not opened
for a while. On the uplink's own wireless network the same laptop opened everything at once.

**What was found.** Chrome's Navigation Timing on the bench board: `www.messenger.com` spent 11 178 ms in
DNS and 64 ms connecting; `www.meta.com` 10 023 ms in DNS; 15 of 20 fresh `*.wordpress.com` names took
10.1 s each. Established connections ran at 116–150 Mbit/s. A raw capture on the access-point interface
showed the mechanism: the client sends an A and an HTTPS query for a new name 1 ms apart, the HTTPS one is
answered in 50 ms, the A one is not, the client retransmits it five times, and the answer arrives 10.0 s
after the first query.

The loss is outside the device. A capture on `end0` shows both queries leave and one answer comes back. Two
queries sent from one socket within 0–5 ms, straight out of `end0` (`SO_BINDTODEVICE`, no core involved):

| upstream | lost |
|---|---|
| `1.1.1.1`, `8.8.8.8`, `9.9.9.9`, back to back | about half of the pairs, every run |
| `1.1.1.1`, 100 ms apart | 0 |
| the ISP's resolver `198.51.100.30`, back to back | 0 |
| `1.1.1.1`, the two queries from two sockets | 0 |

Port 53 is not intercepted on the way (a query to an address with no resolver gets no answer; `1.1.1.1`
reports a site of its own, Google reports itself). The pattern — the second packet of a new UDP flow is lost
when it follows the first within a few milliseconds — is consistent with a connection-tracking race in the
NAT upstream of this device. That is an assumption: the router at `192.168.0.1` was not inspected.

The device turns that loss into the outage. The core sends **every** query to its UDP resolver from one
socket, so the browser's A and HTTPS queries become exactly that pair; then it waits 10 s for the lost one.
Without the device the laptop sends them from separate sockets to the uplink's resolver and never meets it.

**Measured, sing-box 1.14.0 on the board, resolver `1.1.1.1`, per exit** (ms; "pairs stuck" is an A + HTTPS
pair for a new name with one answer missing):

| exit (RTT) | one at a time, p50 | pairs stuck | 40 names at once |
|---|---|---|---|
| direct, `end0` (10 ms) | UDP 48 / TCP 47 | UDP **15/15** / TCP 0/15 | UDP **38 of 40 lost**, 12 s / TCP 0 lost, 75 ms |
| OpenVPN `partner` (~100 ms) | UDP 181 / TCP 203 | UDP 1/15 / TCP 0/15 | UDP 160 ms / TCP 263 ms |
| OpenVPN `corp` (~180 ms) | UDP 189 / TCP 190 | 0/15 / 0/15 | UDP 223 ms / TCP 395 ms |
| SOCKS `relay` (xray) | UDP **no answer, 25 of 25** / TCP 51 | UDP 15/15 / TCP 0/15 | UDP all lost / TCP 135 ms |

**The decision.** `dns-tunnel` (what unmatched names use) and `dns-direct` when the profile gives it a literal
address are `type: tcp`. A tunnel's own resolver stays UDP: nothing was measured to be lost inside a tunnel,
and a corporate resolver is not promised to answer TCP.

**What else was measured before deciding, because it was the risk:**

* *Connection cost.* 20 queries in a row opened one TCP connection; 40 at once opened none (they went down
  the open one). An idle connection is closed after a while, and the next query pays one round trip: +20 ms
  direct.
* *An unreachable or refusing resolver.* The core answers nothing at all, over UDP or TCP alike. TCP is no
  worse.
* *A flow that dies for good*, as when the exit changes under it: a relay that blackholes every flow that
  existed before a moment. TCP and UDP both lose two queries and open a new flow about 12 s later.
* *The path of a server with no `detour`.* Dialled straight out of the uplink: SYNs on `end0`, none on the
  tunnel that was both the first outbound and `route.final` in that test.

**Why the alternatives lost.** *Keep UDP and point it at the ISP's resolver*: no loss on this uplink, but
the address belongs to one network, and the device moves. *DNS over TLS*: the same TCP, plus encryption —
but certificate validation needs a name the profile does not have; `1.1.1.1` has an IP certificate, an
arbitrary address from the profile does not. It is the next step, as a profile option, not a silent change.
*A shorter timeout*: the core does not expose one for this, and it would make the loss cheaper, not gone.

**Verified on the board after the apply** (transaction `4b645cb4313fd280`, class `service`, 2026-10-07; `way
drift` then reported the device matching its profile). From a laptop on the access point, through
`10.44.0.1`: A + HTTPS pairs for new names 0 of 15 stuck (worst of a pair p50 59 ms, max 71 ms), 25 in a row
p50 54 ms, 40 at once 97 ms with none lost; `corp.internal` and `hq.lan` still answered through
their tunnels' resolvers. In Chrome, 20 fresh `*.wordpress.com` names took 131–312 ms each (before: 15 of 20
at 10.1 s), and `www.meta.com` spent 57 ms in DNS (before: 10 023 ms).

**The risk that is left, not measured.** A network that blocks TCP/53 and allows UDP/53 would leave
`dns-tunnel` with no answers while the selector is `direct` (inside a tunnel the uplink's filter does not
apply). Not seen on any network so far; the device could not be put on one to measure it.

**Two traps met on the way.**

* `detour` to an empty `direct` outbound: sing-box 1.14.0 exits at start with *"detour to an empty direct
  outbound makes no sense"*, and `sing-box check` passes the same file. The literal `dns-direct` had exactly
  that detour, so that configuration could never have started; the board runs `auto` and never met it.
  `dns-tunnel` detours through `wf-selector`, which contains the empty `direct`, and starts and answers.
* A test meant to bypass the core by setting the core's mark (`SO_MARK` 487) on a socket bypassed nothing:
  there is no `fwmark` rule in `ip rule`; the core leaves the tun by binding its sockets to the uplink, not
  by its mark. Every "direct" figure from that test was the core's own answer (2 ms to `1.1.1.1`, against a
  10 ms ping). The figures above are from sockets bound to `end0`.

## An internal name will not open on a phone: the client is usually why

**Symptom:** a browser says it *could not find the server's IP address* for a name that exists only
behind a tunnel — an internal corporate host, say — while everything else on that device works, and the
same name opens from a laptop on the same network.

**It is almost certainly not this device.** Modern phones resolve names through a privacy service rather
than through the network they are joined to. While that is on, a query for an internal name never reaches
this device at all: it goes to a resolver on the public internet, which has never heard of that name and
correctly says so. No configuration here can change that, because the question never arrives.

Measured on the bench board, 2026-09-21, with query logging on, over one four-minute window with both
devices joined and active:

| client | DNS queries reaching this device |
| --- | --- |
| laptop | 105 |
| phone | 13 |

The phone was associated, exchanging traffic, and asking this device for almost nothing. The laptop asked
for everything, which is exactly why the same name had always worked there.

**What fixed it**, on the user's phone, in this order:

1. turn off the network's IP-address-tracking limit for this Wi-Fi network — the per-network privacy
   relay setting;
2. turn Wi-Fi off and on again.

**Both were done at once, so which one mattered is not known**, and it is recorded that way deliberately
rather than attributed after the fact to whichever sounds better. The second step is not optional even if
the first was the cause: while a name is failing, a client caches the failure, and it will keep answering
itself from that memory for some minutes after the fault is fixed. **After any repair to name resolution
on this device, the client needs its cache cleared or it will continue to report the old failure.**

Worth stating plainly because the appearance is misleading: *a network where one device resolves internal
names and another does not* looks exactly like a broken router, and the first instinct is to reconfigure
the router. The way to tell the difference in one reading is to turn on **Record the names clients look
up** in the DNS section of the profile, watch for a query from that client's address, and turn it off
again. No query arriving is the answer.

Also check, on the client: that its DNS is set to Automatic rather than a manual address, and that no
device-management profile is supplying a resolver of its own.

### And before any of that: the obvious name is often the wrong name

A client failing on the **bare** internal domain frequently means the network is working.

Measured on the bench board, 2026-09-21, asking a corporate resolver directly through its own tunnel for
the bare name it serves: it answered, and returned **zero addresses**. The services live beneath that name,
not at it. The same is true of the other internal domain here — it does not answer on 80 or 443 either,
because the name resolves to a rotation of addresses most of which serve nothing.

So `corp.internal` failing while `something.corp.internal` works is not a fault, and a
client reporting "could not find the server's IP address" for the bare name is reporting the truth.

This is the same trap as choosing a health probe target, one layer out: **the obvious name to try is the
one the tunnel is named after, and that is usually the one name nobody serves.** Try a specific service
before concluding anything.


## What the owner actually met (2026-09-21)

The design above removes per-protocol code from this repository. It does not remove the
work — it **relocates it into the owner's configuration**, and that is a worse place for
it than the one it came from.

Configuring the four tunnels running on the bench required typing, into profile fields:
the command line that starts each client, the contents of each client's configuration
file, and the loopback port each one listens on. Three consequences followed, all
observed rather than predicted:

* **A flag error is silent.** The fourth tunnel would not start because this project
  writes a client's configuration as `<id>.conf` and that client infers its format from
  the file extension. The fix was one word in a command line. Neither side is wrong; the
  operator paid for the collision, three times over, each failure invisible until the
  previous one was fixed and all three presenting identically as *a client that will not
  start*.
* **The fields a person must fill are not all shown.** A tunnel's obfuscation transport,
  the destinations it exists to reach, and its health probe have no control in the
  interface at all. Every tunnel on the bench was therefore configurable through the API
  alone — and nothing in the product said so.
* **A command line in a profile is code**, and it is code that is not compiled, not
  typechecked, not tested, not reviewed and not versioned. The economy was accounting,
  not engineering.

**The replacement**, decided by the owner: a curated catalogue — **OpenVPN, Cloak +
OpenVPN and Xray**, narrowed from six on the day it was written, with VLESS, Shadowsocks
and WireGuard moved to a following epic because none of them runs on a board this project
manages and each would otherwise be written against a reconstructed shape — where each
entry knows its own binary,
arguments, configuration file name *and format*, unit shape and port allocation, and
each has a screen designed for it. Nothing outside the catalogue exists, in the
interface or in the API: the `raw` provider and the schema-driven renderer are deleted
rather than hidden, because a hidden inconsistency is still the inconsistency.

The cost is accepted with open eyes: **a protocol the core gains no longer appears by
itself.** It becomes work here, and a profile naming anything outside the catalogue
cannot be imported. That is the price of a device whose owner can configure it from a
phone without a manual, and the owner chose to pay it.

## What the deletion actually removed, and one thing it moved (2026-09-21)

The catalogue and the schema were two halves of one change; this is the second half, where the general
path came out. Recorded here because "deleted rather than hidden" is a claim, and a claim about
deletion should name what went.

**Gone from the daemon:** `core/providers.ts`'s five-branch emitter, the `raw` provider and its
escape-hatch schema, the two loose `command` + `configFile` + `localPort` schemas, the curated list of
endpoint types a tunnel was allowed to be, the registry's ability to report a provider nobody designed
a screen for, `transportFiles`/`transportUnits` as a second channel out of emission, and
`GET /api/schemas/tunnel/:provider` — the route that fed the generic renderer.

**Kept, reduced:** `buildRegistry` answers one question, which is genuinely discovered and cannot be a
table: *which catalogue entries can this device run, and what is missing?* It walks the catalogue and
asks each entry. `validateTunnelConfigs` still runs a schema pass before anything is embedded, because
a fault found there carries a JSON Pointer into the profile while the same fault found later arrives as
a unit that will not start — but the schema is now ours, so the check needs no binary and no fetch.

### One boundary moved, deliberately: availability is not emission's business

The old emitter **skipped** a tunnel whose provider was unavailable. The consequence was measured in
the plan review rather than in a log: an operator missing a binary was shown a finding naming it and,
beside that finding, an apparently empty change. Nothing in the diff said what would have been written.

The two questions are now separate and asked in different places:

* *Can this device run this protocol?* An invariant check, which walks the catalogue, asks each entry's
  `availability()` and turns each stated requirement into `binary_missing` naming the binary, what it
  is needed for, and the tunnel that needs it. This is also how the obfuscation client came to be
  checked at all — the old check was a single branch on `provider === 'openvpn'`, and no other
  protocol's requirement existed, because adding one meant adding another branch on another name.
* *Can this configuration be planned?* Emission's question, and the only one it asks. It refuses when a
  catalogue entry cannot decide — a VLESS configuration whose carrier cannot be established — and
  otherwise produces the full diff whether or not the binaries are present.

Planning continues through a missing binary because nothing is applied while an error stands, and the
review is more useful showing both the finding and what the apply would have done.

### The carrier is stated in the plan, not in a log

A VLESS entry establishes its own carrier, and the sentence explaining the choice becomes a **note in
the plan the owner reads before applying**. He holds a link, not a preference, so the choice is made
for him; a choice made for somebody without a sentence explaining it is the confident answer nobody can
account for afterwards. The obvious alternative — writing it at apply time — puts it where only an
incident brings anybody looking.

If notes turn out to be the wrong surface for it, that is a change of surface. It is not a reason to
stop stating it.

### A collision that can no longer be stated, and the arm of the check that is left

`localPort` left the profile, so *two tunnels naming the same port* is no longer expressible: a port is
allocated, once, by the code that needs it. That arm of the port-collision check is now unreachable by
construction, and this is stated rather than left for somebody to discover while trying to test it.

The check is still reachable, through the field that remains: the core's control API bind address is an
owner-filled value, and nothing stops it naming a port inside the range this daemon allocates from. The
two then claim the same number and the check is the only thing that notices. That arm is exercised by a
test; the allocator is deliberately **not** taught to avoid the control API's port, because an error
naming the conflict is better than a generator quietly moving a number the owner chose.

## Six parsers for three protocols, and the output nothing could save (2026-09-21)

The catalogue made a tunnel a `{ protocol, config }` pair over three entries — OpenVPN,
Cloak + OpenVPN, VLESS — and schema 7 has a branch for each and no branch for anything else. The
subscription parsers had not been told. Each returned a **proxy-core outbound**: the core's own key
names and nesting, `{ type, server, server_port, uuid, tls: {…}, transport: {…} }`, and
`POST /api/subscriptions/parse` wrapped it as `{ provider: 'singbox-outbound', … }`.

**Every draft that route returned was unstorable.** Not awkward to store — unstorable: there is no
branch of schema 7 that accepts one, so the only possible fate of a parsed node was refusal at the
profile write, two layers away from the line number and the excerpt that would have made it
diagnosable. This is *outside the catalogue there is nothing* broken from the other end. The catalogue
was enforced at the write and ignored at the producer, and a producer nothing can consume is not a
producer.

### What replaced it

`ParsedNode` is now `{ scheme, label, protocol, config }`, and `config` is a configuration for
`TUNNEL_CONFIGS[protocol]` — the pair a stored tunnel is made of, minus the id, name and role a tunnel
also carries. `parseSubscription` validates every draft against that entry's own schema **before a
caller sees it**, so a parser that drifts from its catalogue entry, and a link whose values exceed the
bounds the entry sets, both fail at the line that caused them.

The check lives in the producer rather than in a test on purpose. A test proves the parsers written
today agree with the catalogue; the check proves it for the link somebody pastes next year.

### One parser, and five refusals that are not gaps

Only `vless://` maps. OpenVPN and Cloak + OpenVPN arrive as a file plus entry points and never as a
link, so there is nothing for a parser to do. That leaves five schemes — VMess, Shadowsocks, Trojan,
Hysteria 2, TUIC — whose parsers were deleted.

**Their test predicates were kept**, as `RECOGNISED_NOT_RUN`. Deleting them outright would have been
simpler and would have produced the wrong sentence: a `vmess://` line would fall through to *nothing
here parses a vmess link*, which reads as a hole in our coverage. It is not a hole. It is a decision
about what this product runs, and the refusal says so by name.

### Every refusal names both halves

**A refusal naming both what was rejected and what is accepted is an answer. A refusal naming only the
first is a riddle** — the person whose link did not take has to go and read documentation to learn what
would have. Three refusals obey it, and the sentence they end with is *derived from the catalogue*
rather than written out, so adding an entry cannot leave it stale:

- an unrun scheme names the scheme and the three protocols;
- an unnamed transport names the transport and the five that are accepted;
- an unnamed transport security names it and the accepted set.

The two lists of accepted values are read off the schemas, not restated. Two lists of the same set
drift, and the one that drifts is whichever was not updated.

### `allowInsecure` is refused, and that is a decision rather than an omission

A link that sets `allowInsecure` or `insecure` is refused, naming the parameter. The reasoning is in
[14-open-questions](14-open-questions.md); the short form is that dropping it silently yields a tunnel
which looks complete and fails certificate verification, and adding a field for it turns off the only
check that distinguishes a tunnel from a pipe to whoever answered.

### `/api/providers` survived the word, not the concept — and is now `/api/protocols` (2026-09-21)

The route outlived the registry it was named after. What it lists is every **catalogue entry** and
whether this device can run it, walked from `CATALOGUE_LIST`; it cannot be extended from outside, and
the extensible registry that shared the name is gone.

It kept the word *providers* for one release, which was one too many. A name that lies about its
purpose outlives every comment explaining it: the comment is read by whoever is already in the file,
the name by everyone else. It is now `GET /api/protocols`, and the response key is `protocols` rather
than `providers` for the same reason — renaming the route and leaving the body would have split one
fact across two vocabularies, which is the thing being fixed.

No deprecation window, because its only client consumer was deleted along with the generic form it
fed (recorded in `apps/ui/src/lib/api.ts`). **A route nothing calls is the one moment its name can be
corrected for free**, and that moment does not come back.

The file `core/providers.ts` deliberately keeps its old name: three modules outside E4's territory
import `buildRegistry` from that path, and its header says so.

## `Proxy`: one catalogue entry for three things a proxy can speak (2026-09-22)

The fourth catalogue entry, and the smallest by a distance. What the owner holds is *a proxy*; which
of HTTP, HTTPS and SOCKS it speaks is something his provider told him, not a product he has to choose
between. Three entries would have been three screens differing by one dropdown and three places to
fix the next thing found wrong with any of them.

**It emits an outbound object and nothing else.** No binary, no external process, no generated file,
no allocated port and no systemd unit. The installed core speaks `http` and `socks` natively — both
are in the outbound union of the schema this repository keeps a measured copy of,
`packages/protocols/test/fixtures/core-schema-sing-box-1.14.0.json`, entries 4 and 12 — and
`TunnelEmission` already makes `units`, `files` and `interfaces` optional, so this is a shape the
planner allowed rather than one it had to be given. Availability is unconditional, because nothing
can be missing and a verdict nobody can act on is worse than none.

**`https` is a type on the entry and not a checkbox beside one.** The core has no `https` outbound:
an HTTPS proxy is its `http` outbound with TLS enabled. Modelling that as a boolean would put two
fields in the document that can disagree — `type: "socks"` with `tls: true` means nothing — so the
choice is one closed set of three and the translation happens in the entry. The SOCKS version is
written out as `5` rather than left to a default: SOCKS4 has no user-name/password authentication, so
a version nobody stated is a credential that may silently mean nothing.

### The TLS fields are refused where they cannot apply, and `allowInsecure` is still absent

`tlsServerName` and `tlsCertificate` describe a handshake. On a `socks` or plain `http` proxy there is
no handshake to describe, so a configuration carrying either is **refused by name**, with a JSON
Pointer at the field. Emitting the outbound and dropping the fields was the other option and it is the
shape this repository already ruled against once: it produces a tunnel that looks complete and fails
for a reason its author wrote down and we discarded.

There is no `allowInsecure` and no control that turns certificate checking off, which is the same
decision recorded above rather than a new one — the switch removes the only check distinguishing a
tunnel from a pipe to whoever answered. What that refusal leaves open is a real need: a proxy whose
certificate this device has no reason to trust. `tlsCertificate` answers it **with verification still
on**, by supplying what to verify against. A test asserts the emitted object contains no `insecure`
anywhere, on the entry that would be the obvious place for it to come back.

## The age of a rule set, and what it can honestly be read from (2026-09-22)

A remote rule set is fetched by the core and cached in `experimental.cache_file`, and a failed refresh
**falls back to the copy on disk rather than refusing**. That was chosen deliberately and it is right:
a device that stops routing because a list could not be refetched turns a network blip into an outage.

The bill is that a stale list does not know addresses allocated since it was written, so a rule meant
to send a whole country somewhere quietly stops covering part of it — with the tunnel up, the rule
present and the core healthy. Nothing looks wrong. That is the failure class Epic G exists for, so the
age had to become visible.

**What the daemon can actually observe, established rather than assumed:**

* The core's management API, as this device speaks it (`platform/core-api.ts`), offers `/version`,
  `/proxies` and a delay probe. It carries **no rule-set timestamps**, and it is optional besides —
  `services.clashApi` can be turned off — so an answer depending on it would be absent exactly when
  somebody had turned the management surface down.
* The cache file is the core's own database in the core's own format. It is not parsed here and must
  not be: a layout nobody published is a layout that changes without telling us, and an age read out
  of a guessed one is worse than no age at all.

So the observation is a **file modification time, and nothing else**. For a `local` set the file at
`path` *is* the set, so the age is exact. For a `remote` set the only timestamp is the cache file's,
and that file holds every remote set at once.

### The remote figure is a LOWER bound, and it understates — corrected 2026-09-22

This section said the opposite, in these words: *"it can only overstate an age and never understate
one — the direction that fails safe"*. It was stated confidently, in four places, and it was
inverted. The correction is recorded rather than quietly replaced, because the reasoning is the part
worth keeping.

The cache file's modification time is the instant of the **most recent** write by **any** set in it.
Every individual set was therefore last refreshed at or before that instant, so its true age is **at
least** `now − mtime`. The figure is a floor. Measured: two remote sets sharing a cache written an
hour ago, one of them genuinely thirty days stale — both reported `fresh, 3600s`. **One set
refreshing keeps every other set in the cache looking healthy**, which is exactly the
silent-stale-list failure this whole mechanism exists to catch, surviving inside it.

So a fresh-looking figure on a remote set is **not evidence of freshness**: it is evidence that
*something* in the cache was refreshed. Every sentence produced for a remote set says so — *"at least
4d old — the cache holds every remote set together, so this figure only says something in it was
refreshed then, and this set may be far older"* — and `exact: false` carries the same fact to a
client reading values rather than words. The Routing screen draws it as `≥ 4d` for the same reason.

**The one property that survives, and the only reason the finding is worth having:** if the *lower*
bound already exceeds the threshold, the true age certainly does too. So the overdue finding **never
false-alarms on a remote set; it only misses.** A red answer is always true; a green one is only
"nothing here proves otherwise". That asymmetry is what makes a bound worth comparing at all, and it
is why the threshold can be as tight as three intervals rather than needing slack for a figure that
might be an overestimate. It cannot be one.

The real fix is not a better reading of this file — there is no better reading of it. It is row F7 in
[13-plan](13-plan.md): fetch each remote set here, into its own file, and hand the core a `local` set
pointing at it.

### The clock, and why the answer is sometimes "this cannot be measured"

A modification time is a wall-clock instant and so is `now`. This board has no RTC battery, and the
apply that opens a confirmation window deliberately restarts the time service, so a step of days while
the daemon is running is a designed path. No monotonic reading spans a power cycle, and every remote
set worth asking about was fetched during an earlier boot, so measuring within this boot is not
available either.

This is the snapshot age's shape, and it takes the same answer: **an age is computed only when
`timedatectl` reports `NTPSynchronized=yes`**, and otherwise the report says the age cannot be measured
and why. A reading that failed is a third answer and not a quiet `false`; both refuse to compute. A
timestamp in the future is treated as evidence about the clock rather than as a fresh list, because a
negative age rounds to zero and reads as *refreshed just now*, which is the most reassuring possible
lie here.

### "Unreasonably old" is three of the owner's own intervals

The threshold is `updateIntervalHours × 3` (`MISSED_REFRESHES`), not a constant.

One missed refresh is the designed path — the fallback exists for it — and a finding that fires every
time an uplink blinks is a finding people learn to scroll past, which costs more than it buys. Two is
bad luck. Three in a row is a pattern: the refresh is not working rather than unlucky. Deriving it from
his own number also makes it proportionate — a list refreshed daily is complained about after three
days, one refreshed weekly after three weeks.

**A set with no stated interval gets an age and no verdict**, because the profile says nothing about
how fast it goes stale and a threshold invented for it would be the constant this paragraph avoids.
The consequence of leaving that field empty is therefore written on the control that leaves it empty.

A set no routing rule points at is not judged at all: it is fetched for nobody, and a finding about it
would be one nobody can act on.

### Where it is reported

As a **drift finding**, in the report `core/drift.ts` already makes at boot, after every undo and every
fifteen minutes — because it is that report's own question: the profile says refresh this list every N
hours, and the device holds a copy older than that allows. It therefore reaches the Status screen, the
event ring, `GET /api/drift` and `way drift` without a second mechanism.

Every set in use also has its age on the Routing screen, from `GET /api/rule-sets`, read from the files
at request time rather than out of a report up to fifteen minutes old. A screen showing only the bad
ones could not tell *this list is fine* from *this list was not looked at*, and those must not look
alike.
