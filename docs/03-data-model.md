# 3. Data model

## Two kinds of state, and why the split matters

**Profile state** is what a configuration *is*: uplinks, access point, LAN,
tunnels, routing, DNS, firewall policy. It is portable and can be handed to
someone else.

**Device state** is what this particular box is: the admin password, API tokens,
active sessions, the device name, the cached hardware inventory, the event log,
and which profile is active.

The split is not cosmetic. Importing a profile from a friend must not change your
password or revoke your tokens, and switching profiles must not log you out.
Anything that would be wrong to *receive* from someone else belongs to device
state.

## The profile document

One JSON document. It is simultaneously the storage format, the API payload and
the export format, so there is no second serialisation that can drift.

```jsonc
{
  "schemaVersion": 2,
  "meta": {
    "name": "Home",
    "description": "Ethernet uplink, work tunnels on",
    "createdAt": "2026-09-19T14:00:00Z",
    "updatedAt": "2026-09-19T14:00:00Z"
  },

  // ── hardware roles, bound portably (see "Hardware binding") ──
  // Uplinks are a list because ordering between them is failover priority.
  // An EMPTY list is valid and is the default: the software configures no
  // uplink until told to. See "No uplink by default" below.
  "uplinks": [
    { "id": "wan-eth", "kind": "ethernet", "priority": 10,
      "bind": { "by": "any-ethernet" },
      "config": { "dhcp": true } },

    { "id": "wan-wifi", "kind": "wifi-sta", "priority": 20,
      "bind": { "by": "phy-builtin" },
      "config": { "ssid": "UpstreamAP", "psk": { "$secret": "…" },
                  "band": "5GHz", "bssid": null } }
  ],

  // Addressing is one set of fields for both kinds. `dhcp` defaults to true; with it false, an
  // `address` and a `gateway` are required and the invariant checks refuse the profile without
  // them (`uplink_static_without_address`, `uplink_static_without_gateway`). The requirement is a
  // check rather than a schema rule because it is conditional on a sibling field.
  //
  // The wireless uplink did not carry these fields until 2026-09-21, and the flag was not merely
  // unusable without them — the generator contradicted it. See docs/16. `config.dns` is the owner's
  // and is currently read by no generator: the proxy core is this device's resolver. That is an open
  // question in docs/14, not a gap waiting to be filled in.

  // One access point, one network — single objects, not lists.
  //
  // accessPoint may be null. A board with no radio, or one reached over Ethernet only, must be able
  // to hold a valid profile: making validity depend on hardware would mean a profile that is legal on
  // one device and illegal on another, and it could not be shared — which is the whole point of the
  // model. An unconfigured access point is reported as a STATE, like an unbound role. Invalid is for
  // configurations that are wrong; absent is for configurations that are not there yet.
  "accessPoint": {
    "bind": { "by": "mac", "value": "90:de:80:47:b4:b4" },
    "radio": { "band": "5GHz", "channel": 149, "width": 80,
               "country": "DE", "hidden": false },
    "ssid": "MyRouter", "passphrase": { "$secret": "…" },
    // Required only when this radio also carries a wifi-sta uplink and the
    // driver permits it: an explicit acknowledgement that the access point
    // channel will follow the upstream network.
    "acceptChannelFollowsUplink": false
  },

  "network": {
    "cidr": "10.44.0.1/24",
    "dhcp": { "enabled": true, "from": "10.44.0.100", "to": "10.44.0.200",
              "leaseHours": 12 }
  },

  // ── tunnels: see 04-tunnels-and-protocols.md ──
  "tunnels": [
    // `protocol` names a catalogue entry, and the pairing with `config` is fixed by
    // the schema: each entry is its own branch of a union, so `vless` beside an
    // OpenVPN configuration matches no branch at all rather than validating cleanly
    // and failing on the device. There is nothing outside the catalogue.
    { "id": "t-pl", "name": "Warsaw", "role": "alternative", "enabled": true,
      "protocol": "vless",
      "config": { "server": "…", "port": 27298, "id": { "$secret": "…" },
                  "network": "ws", "security": "tls", "path": "/" } },

    { "id": "t-hq", "name": "HQ", "role": "resource", "enabled": true,
      // One entry, not a tunnel composed with a transport: the two are configured
      // together because they are chosen together.
      "protocol": "cloak-openvpn",
      "config": { "profile": { "$secret": "…" }, "interfaceSuffix": "hq",
                  "auth": { "username": "…", "password": { "$secret": "…" } },
                  // In preference order, which is the order the generated `.ovpn`
                  // lists its remotes in — so reordering here reorders failover.
                  "entryPoints": [
                    { "id": "site-a", "host": "…", "port": 443,
                      "uid": { "$secret": "…" }, "publicKey": "…",
                      "serverName": "www.example.com", "udp": true }
                  ] },
      "resources": { "domainSuffix": [".hq.lan"],
                     "ipCidr": ["10.0.0.0/8", "192.168.0.0/16"] },
      "dns": { "server": "10.184.100.5", "dynamic": true,
               "domainSuffix": [".hq.lan"] } }
  ],

  // ── which alternative wins, and what happens when none does ──
  "policy": {
    "priority": ["t-pl"],
    "excluded": ["t-de"],
    "sticky": true,
    // Three thresholds, not one, because latency alone does not describe a usable tunnel: a link at
    // a steady 400 ms works, and one averaging 120 ms while dropping a third of its packets does not.
    // `jitter` is the mean absolute deviation from the median, not the standard deviation and not
    // max−min — one outlying sample should not by itself condemn an otherwise steady tunnel.
    "probes": { "count": 4, "maxFails": 2, "maxLatencyMs": 500,
                "maxJitterMs": 250, "maxLossPercent": 34, "failStreak": 2,
                "intervalSeconds": 30,
                // Endpoints are a list so one third party going down is a bad sample rather than the
                // watchdog's verdict on every tunnel at once. They are also blocked from being
                // reached any other way — see `firewall.blockedEndpoints`.
                "endpoints": ["http://cp.cloudflare.com/generate_204",
                              "http://connectivitycheck.gstatic.com/generate_204"] },
    "onAllDown": "block"
  },

  // ── ordered routing rules; the order is data, not an implementation detail ──
  "routing": {
    "rules": [
      { "kind": "protect-own-networks" },
      { "kind": "tunnel-resources" },
      { "kind": "private", "action": { "outbound": "direct" } },
      { "kind": "ruleSet", "sets": ["geoip-example", "geosite-example"],
        "action": { "outbound": "direct" } },

      // Three first-class matching kinds. They exist because the alternative was a modelling lie:
      // sending one domain direct is close to the most common thing anyone asks this device to do,
      // and without them the only way to express it was to invent a `resource` tunnel that tunnels
      // nothing — which then appears as a tunnel in the tunnel list, in the export, and in the diff
      // somebody reads before confirming a change.
      //
      // `domain` is exact and `domainSuffix` is not: a suffix is not a correct way to express an
      // exact host, and `example.com` as a suffix also matches `notexample.com`. Keyword and
      // regular-expression matching stay out: both are reachable through a rule set, and that is a
      // fair indirection because a rule set is exactly a list of match terms.
      { "kind": "domain", "domains": ["exact.example.com"],
        "action": { "outbound": "direct" } },
      { "kind": "domainSuffix", "suffixes": [".hq.lan"],
        "action": { "outbound": "t-hq" } },
      { "kind": "ipCidr", "cidrs": ["203.0.113.0/24"],
        "action": { "outbound": "block" } }
    ],
    "ruleSets": [ { "tag": "geoip-example", "type": "remote", "url": "…" } ]
  },

  "dns": { "direct": "auto", "overTunnel": "1.1.1.1", "strategy": "ipv4_only" },

  // killSwitch defaults to false. It is a switch in the interface and the API,
  // not a policy baked into the product: a device with no tunnel configured yet
  // would otherwise look broken. Its behaviour when on: reject only NEW
  // connections from the LAN towards the uplink, with "reject" rather than
  // "drop", exempting the LAN and the uplink network themselves.
  //
  // ipv6: "block" is the only value today — dropped at the access point so a
  // v4-only tunnel cannot leak a real v6 address. "direct" and "tunnelled" are
  // reserved; see 14-open-questions.md.
  // blockedEndpoints: endpoints that reveal the real address — address-discovery servers and
  // reachability probes. ONE field rather than two: "the STUN block list" and "the probe-endpoint
  // blocking list" were the same concept under two names.
  //
  // Entries are structured rather than bare ports or bare hostnames, and that changes what the
  // feature can promise. A bare port blocks far more than intended, since a whole well-known UDP
  // port carries things nobody asked to break; a bare hostname cannot be enforced by a firewall at
  // all, because a firewall matches addresses.
  //
  // WHICH LAYER ENFORCES WHICH, and the limit that follows: entries with `ipCidr` or `ports` become
  // firewall rules; entries with `domain` become reject rules in the core's routing. So a domain
  // entry does NOTHING for a client that resolved the name elsewhere and is dialling a literal
  // address. Stated because the feature otherwise looks stronger than it is.
  //
  // Matched as an EXACT name, not as a suffix. The core's suffix match is a literal string suffix, so
  // blocking `example.com` as a suffix also blocks `notexample.com` — a trap this document already
  // records for the `domain` routing rule kind, and which the generator here committed for a while. A
  // suffix is still expressible on purpose, as a routing rule of kind `domainSuffix` with a block action.
  //
  // THE PROBE DESTINATIONS ARE ADDED TO THIS SET AUTOMATICALLY, from `policy.probes.endpoints`, and
  // that is the point of the list rather than a side effect. A probe answers one question — does this
  // tunnel carry traffic? — and the answer is only worth having if the endpoint cannot be reached any
  // other way. The device's own probe is unaffected, and not by an exemption: the core's per-outbound
  // delay test dials through the named outbound and does not consult routing rules at all, so a reject
  // rule blocks every path except the one the watchdog measures on. Derived rather than asked for twice,
  // because the copy an operator maintains by hand is the copy that gets forgotten.
  "firewall": { "killSwitch": false, "ipv6": "block", "ntpBypass": true,
                "blockedEndpoints": [
                  { "ipCidr": "198.51.100.0/24", "ports": [3478], "protocol": "udp",
                    "note": "address discovery" }
                ] },
  "services": { "clashApi": { "enabled": true, "bind": "127.0.0.1:9090" } }
}
```

### Two roles for tunnels, and it is a field rather than an inference

An **alternative** is interchangeable with other alternatives: it joins the
failover group, the watchdog switches between them, and unmatched traffic goes to
whichever is selected. A **resource** is not interchangeable — substituting a
public proxy for a corporate tunnel is meaningless — so it never joins the group
and is reached only by explicit rules.

This is declared, not derived from the protocol. Two VLESS endpoints can be
alternatives while a third is a resource, and an OpenVPN tunnel could perfectly
well be an alternative.

### Ordered rules, and the anchor that protects your own access

Private address space overlaps heavily: corporate networks routinely occupy large
parts of `10.0.0.0/8` and `192.168.0.0/16`, which is also where the management
network and the access point live. A rule sending `192.168.0.0/16` into a tunnel
will, if it sits above the rule protecting the local networks, send the operator's
own management traffic into that tunnel. The device is then gone until the
three-minute watchdog brings it back.

`routing.rules` is therefore an ordered array and the interface presents it as a
reorderable list. Two entries are **anchors** that expand from other parts of the
profile rather than being written by hand:

* `protect-own-networks` — the LAN, the uplink network and loopback go direct.
* `tunnel-resources` — one rule per `resource` tunnel, in the order the tunnels are
  listed.

Anchors can be **moved freely, including below a tunnel rule.** Doing so raises a
warning in the plan review naming what will be lost, but it is not prevented: a
locked rule would eventually be the thing standing between someone and a
configuration they actually need, and the watchdog already makes the mistake
recoverable rather than fatal.

### No uplink by default

A fresh device configures **no uplink at all**. The operator adds one explicitly and
chooses its kind — Ethernet or Wi-Fi client — and which hardware it binds to. There
is no probing for a cable and no assumption that the built-in radio is the client.

The reason is that every implicit default here is wrong for somebody: a board with
no dongle can only put the access point on its built-in radio, a board with a
dongle usually wants the opposite, and guessing produces a device whose behaviour
cannot be predicted from its configuration. On a bare board with a single radio and
no dongle, access point on that radio plus an Ethernet uplink works, and that is a
configuration the operator states rather than one the software infers.

## Secrets

Every secret-bearing field is marked in its schema:

```jsonc
{ "type": "string", "x-secret": true }
```

A second annotation, `x-secret-kind`, carries a label from a closed set — `psk`, `password`,
`private-key`, `token`, `certificate`, `uuid`, `config-blob` — defaulting to `secret`. It exists
because `x-secret` answers "is this a secret", which is what all four behaviours need, and cannot
answer "what must a person go and find", which the import checklist has to say. Detection stays
purely `x-secret`, so the two cannot disagree about whether a field is a secret.

One annotation drives **four** behaviours, which is the point — they cannot drift apart:

| Behaviour | Derived from `x-secret` |
|---|---|
| **Export redaction** | The default export replaces the value with `{ "$redacted": "psk" }`. |
| **API reads** | `GET` never returns the value, only `{ "$set": true }` or `{ "$set": false }`. |
| **API writes** | A write accepts a literal value, or `{ "$keep": true }` to leave the stored value alone. |
| **Logging** | The logger replaces anything shaped `{ "$secret": … }`, structurally, with no schema involved. |

The four shapes are **generated** from the canonical one rather than expressed as a single
permissive union. The canonical schema holds a plain string: that is what a stored, resolved profile
contains. A union covering every shape everywhere would let a read-shaped value reach storage, and
validation that accepts the wrong context is not validation.

A secret's value is `string | string[]`. The list form is not decoration: a PEM-style key may be
given as several lines, and the schema a proxy core emits declares `ssh.private_key` and
`tls.client_key` exactly that way. A wrapper that accepted only a string left both unwrapped.

### The annotation used to be missing from the schema that mattered most

**Corrected, and the wrong reasoning is the part worth keeping.** This section said a tunnel's
`config` was opaque to this schema by design, because it belonged to a provider whose schema came
from the installed binary — a schema carrying **zero** `x-secret` annotations, counted on the bench
board's 1.14.0 binary. Left alone, a VLESS account id and a Trojan password were stored unwrapped,
returned by `GET`, and written into an export meant to be shared. The answer at the time was to stamp
the annotation onto the foreign schema from a curated overlay and a name rule, and to require that
the matchers for a document always be derived with that stamped schema in hand.

Schema version 7 removes the premise rather than improving the answer. A tunnel's configuration is a
typed catalogue entry, so **every credential a tunnel can hold is declared here**, with `Secret()`,
in a schema this repository owns. Walking the document schema alone now yields:

| pointer | kind |
| --- | --- |
| `/tunnels/-/config/profile` | `config-blob` |
| `/tunnels/-/config/auth/password` | `password` |
| `/tunnels/-/config/entryPoints/-/uid` | `token` |
| `/tunnels/-/config/id` | `uuid` |
| `/tunnels/-/config/encryption` | `private-key` |

The third is the one that leaked from five obfuscation entry points, and it is now covered by the
static walk. Two consequences follow, both measured:

* The kind is the **declared** one rather than the generic `secret` a name rule produced, so the
  import checklist names what a person has to go and find instead of saying "a secret is missing".
* A profile can be written down on a device with no core. Deriving the pointers at runtime from a
  binary's schema meant a device whose core had not been unpacked could not *store* a tunnel at
  all — a refusal about credentials, caused by an unrelated missing download.

The requirement that the matchers always be derived with a provider registry is therefore withdrawn.
It was correct against an opaque `config` and became an obstacle the moment the configuration was
typed; the general form of that lesson is in
[16-implementation-notes](16-implementation-notes.md).

### A write cannot drop a secret by leaving it out

Every secret position a write **mentions** takes a literal value or `{"$keep": true}`. A position it
does not mention is the case that was missing, and it cost six stored secrets on the owner's live
profile on 2026-09-21 — five of them an entry point's `uid`. The write path walked the incoming
document, so an omitted pointer was one nothing visited: no value to check, no `$keep` to resolve, no
error, and a stored document that was wrong from that moment on.

The sequence is ordinary rather than exotic. A client reads the document, finds `{"$set": …}` where a
value should be, discovers that `{"$keep": true}` is refused at that pointer, and does the only thing
left — omits the field. Every step is reasonable and the result is data loss, which is why the
refusal belongs in the write path and not in a client's good manners.

So a write is **refused** when it omits a secret that is stored at a position whose container still
exists. The qualification is the rule: deleting a tunnel or an entry point deletes its credentials and
that is the point, while dropping a field out of one that is still there is a loss nobody asked for. A
rule without it would make an entry point impossible to remove, and an operator would learn to work
around the refusal — which is how a safety check trains its own bypass.

### `$keep` names a secret by what holds it, not by where it sits — 2026-09-23

`{"$keep": true}` was resolved at the **same array index** in the stored document, and so was the
check above. Measured by the acceptance tester on the bench board: adding a tunnel anywhere but last
was refused with `invalid_secret_write` at `/tunnels/1/…`, because every tunnel after the insertion had
moved down one place. Reordering was worse: two neighbours with a credential at the same field each
kept the *other's*, and nothing said so; and a tunnel with no credential moved above one with a
credential made the kept secret look deleted.

Both now follow list elements by their `id` (`counterpartPointer` in
`packages/schemas/src/secret-transforms.ts`): a kept secret is looked up on the stored element with the
same `id`, a new element has nothing to keep wherever it is inserted, and a drop is reported at the
element's position in the write the caller sent. An element with no `id` is matched by index, and
only against another element with no `id`. Asserted in `packages/schemas/test/keep-by-key.test.ts`:
insert first, reorder tunnels and entry points, remove from the middle — every kept secret checked by
value, which is the only thing that shows a swap.

In storage a secret is `{ "$secret": "<value>" }`. The wrapper exists so that code
walking the document generically — the differ, the exporter, the logger — cannot
mistake a secret for an ordinary string.

### Export modes

```
GET /api/profiles/:id/export                  → redacted (default)
GET /api/profiles/:id/export?secrets=include  → full; requires the "admin" scope
                                                and is recorded as an event
```

The redacted export is the sharing format. On import, every `$redacted` marker
becomes a required field and the interface shows a checklist of what must be filled
in before the profile can be activated. This beats rejecting the import: the
structure, which is the valuable part, transfers, and the gaps are explicit
instead of hidden.

## Hardware binding, and why not interface names

A profile that says `"interface": "wlan0"` is not portable, and is not even stable
on one device — plug in a dongle and the kernel may number things differently. A
profile therefore references hardware by a *selector*, resolved at apply time:

```jsonc
"bind": { "by": "mac",          "value": "90:de:80:47:b4:b4" }
"bind": { "by": "phy-builtin" }                      // the non-removable radio
"bind": { "by": "phy-usb",      "value": "0e8d:7961" }  // USB vendor:product
"bind": { "by": "bus-path",     "value": "…-usb-0:1:1.0" }
"bind": { "by": "any-ethernet" }
```

Resolution yields a concrete interface name. Two constraints on a *generated* name, both of
which are silent failures if ignored: it must be at most 15 characters, and it must not
contain a hyphen if it will appear in a systemd template instance — systemd escapes `-` as
`\x2d` in unit names, so a template instance for `wlan-ap` looks for a device unit that does
not exist, and a `BindsTo=` dependency then stops the service immediately.

### `pinName`: whether the interface is renamed, and it is off by default

```jsonc
"accessPoint": { "bind": { … }, "pinName": false, … }
"uplinks": [ { "id": "wan-eth", "bind": { … }, "pinName": false, … } ]
```

Left off — the default — the role uses whatever the kernel already calls the interface and no
`systemd.link` file is written. Turned on, the role gets `wfap0` / `wfwan<n>` / `wfvpn<n>`
and a `.link` file matching on the permanent address, so the name survives a USB device
enumerating in a different order between boots.

**An earlier revision of this document had no such field: every role was renamed and pinned,
always.** The correction is kept with its reasoning because the reasoning is what was wrong,
not the mechanism. Pinning is genuinely valuable — a unit file and a generated configuration
both spell an interface out, and a name derived from enumeration order is not stable. What
that argument omitted is the cost: a `.link` file is read when the link appears, so a rename
takes effect only at the next boot. Applying a profile therefore did not produce a working
device until the board was restarted, and until then every generated artefact named an
interface that did not exist. On top of that, the rename most often needed is the one on the
interface carrying the operator's own session, which is the single riskiest change this
system can make.

So the benefit is opt-in and the cost is visible where it is incurred. The blast-radius
consequences, and why taking over a working device is two transactions rather than one, are
in [06-apply-and-rollback.md](06-apply-and-rollback.md).

One case is not a choice: a radio with **no interface at all** has no current name to keep,
so the generated name is used even unpinned. That is reported as a note rather than quietly
pinned, because a name with no `.link` file behind it is a name nothing will answer to until
something creates the interface.

**An unresolved binding is a state, not an error.** When a profile is imported onto
different hardware, or a dongle is unplugged, the affected roles report as
`unbound`; the interface offers the detected candidates and the operator picks. A
profile cannot be activated while a required role is unbound, and the API says
which role and why.

## Database

SQLite, one file, through the runtime's built-in driver — no native module, see
[09-stack.md](09-stack.md).

```
profiles        (id, name, document JSON, schemaVersion, createdAt, updatedAt)
device          (single row: activeProfileId, deviceName, adminPasswordHash,
                 apiEnabled, setupComplete, …)
transactions    (id, documentBefore JSON, kind, blastRadius, state,
                 deadlineAt, confirmedAt, revertedAt, reason)
api_tokens      (id, name, tokenSha256, scopes, createdAt, lastUsedAt, expiresAt)
sessions        (id, createdAt, expiresAt, lastSeenAt, userAgent)
events          (id, at, level, kind, summary, detail JSON)
inventory_cache (id, at, document JSON)        -- convenience only, re-derivable
```

Pragmas, chosen for a card that should outlast the project:
`journal_mode=WAL`, `synchronous=NORMAL`, `wal_autocheckpoint≈256`,
`busy_timeout=5000`, `temp_store=MEMORY`.

`documentBefore` holds a full copy of the previous profile. It costs a few
kilobytes and it is the whole reason rollback is simple: reverting is not an
inverse operation to compute, it is a document we already have being applied
again.

## Device identity, and the aggregate view built on it

A device has an identity of its own: sixteen random bytes, generated on the first read that finds none,
stored in the device row. Three candidates were rejected, and the reasons are the useful part.

**Not `/etc/machine-id`.** Measured on the bench board, 2026-09-21: that file was written when the image
was created, months before this software was installed, and it travels with the image. Two devices
flashed from one card carry the same one — so an aggregate view built on it would show a single row
where there are two devices, which is the exact failure identity exists to prevent.

**Not the SoC serial** (`/proc/device-tree/serial-number`, `33802000e33f2457` on the bench board). It
identifies the *board*, not the installation. A card moved to a replacement board would change identity
while everything the operator configured stayed put, and the value is not available on every platform.

**Not generated in a migration.** SQL here has no randomness worth using, and a migration writing a
constant would hand every device the same identity — the failure, again, in the code meant to prevent it.

### Two devices claiming one identity is reported, not resolved

The cloned-card case is not hypothetical, and the aggregate view is exactly where it first becomes
visible: two rows that are somehow one device. The screen says so, says that a copied card is the likely
cause, and changes nothing. Which of them should take a new identity is not a question this code can
answer, and rewriting one automatically would change the identity of a device somebody else is looking
at, while they are looking at it.

### Peers: additive, read-only, and no controller

Each device keeps **its own** list of peers — a label, a base URL, and a read-scoped API token that *the
peer issued*. Two devices holding different lists are both correct. There is no enrolment, no shared
database, no device authoritative over another, and nothing that can change a peer.

That last constraint is load-bearing rather than minimal. The confirmation window protects the operator
of the device being changed: somebody watching a countdown who can do nothing and have the change undone.
**A change arriving from another device has no such operator**, so allowing one would mean rewriting the
whole recovery argument of this project. The aggregate view is therefore a view, and the token stored for
each peer carries the read scope only — which every mutating route refuses.

Reachability has **three** answers, kept apart because they call for different actions:

| answer | what it means | what to do |
|---|---|---|
| `answered` | it replied | nothing |
| `refused` | it is working and will not accept the stored token | issue a new token on that device |
| `unreachable` | nothing came back | look at the network between here and there — most often *that* is what was being reconfigured |

Collapsing the last two into one error sends somebody to the wrong place. A peer that did not answer is
not a peer in trouble, and on this device the commonest reason for silence is that the link is the thing
being changed.

Peers are asked **together**, each with a bounded wait, so one dead link costs one timeout for the page
rather than one each — and this device's own row is filled in with no network at all, so an aggregate
view full of unreachable peers still tells the operator about the device in front of them.

An answer is read **field by field**, never copied wholesale. A peer may be running a different version
of this software, and copying whatever it sent into our own shape is how a field we no longer support
comes back as a rendered value nobody can account for — and how a peer could claim to be us.

## Migrations

`schemaVersion` lives inside the profile document, not only in the database, so an
exported document carries its own version and can be migrated on import.
Migrations are pure functions `(document, fromVersion) → document`, applied in
sequence, with a test per step and a fixture per version. Database schema
migrations are separate and run at daemon start.

**Migrate on read, not only on import.** The first real migration — version 1 to 2, adding the probe
loss threshold, the probe interval and the probe endpoints — exposed a defect in the original
arrangement: migrations ran only on the import path, so a profile already stored on a device was
handed to the daemon exactly as it was written by an older version. The symptom was the health
watchdog throwing on every round because `policy.probes.endpoints` was `undefined` on a document that
predated the field. A migration that runs only where new documents arrive will never run on the
documents that need it. Every read from the store now migrates, and persists the result once when a
step actually applied, so the cost is one write per profile per upgrade rather than one per read.

**A migration may change what a configuration means, and then the operator is told.** Version 2→3 exists
because the generated block rule for a named endpoint changed from a suffix match to an exact one. The
change was right — the core's suffix match is literal, so `example.com` as a suffix also blocked
`notexample.com` — but it **narrowed every existing entry**, and silently narrowing a *blocking* rule is a
security regression: the entry still exists, still looks right, and covers less than it did. So the step
carries the old meaning forward as an explicit `domainSuffix` rule with a `block` action, appended rather
than prepended, and the daemon records a `profile.migrated` event in the ring naming what ran. A migration
nobody is told about is a configuration that changed behind the operator's back.

**A migration step writes its literals out.** The version 1→2 step contains the default values
spelled out rather than imported from the defaults module. The defaults will change; this step must
keep producing the version-2 document it produced when it was written, otherwise a device upgraded
next year gets a different result from one upgraded today and neither is reproducible from the
repository.
