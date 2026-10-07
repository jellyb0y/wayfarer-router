# 13. Plan: epics and tasks

Six epics, each a slice that works on its own. The riskiest layer is exercised
first, read-only, so later work debugs one thing at a time.

Sizes are relative: **S** under half a day, **M** one to two days, **L** three or
more. `∥` marks work that can run in parallel with its siblings.

Cut from scope by decision, and recorded so nobody re-adds it by accident: ask mode,
several networks, guest networks, per-client routing, full IPv6 (blocked at the
access point instead), automated hardware tests, and drift detection.

---

## Epic A — Foundation and observability

*Read-only. If this works, the part that could hurt most is behind us.*

| # | Task | Size | Notes |
|---|---|---|---|
| A1 | Monorepo: pnpm workspaces (`apps/daemon`, `apps/ui`, `packages/schemas`, `packages/protocols`, `packages/field-meta`), TypeScript, esbuild single-bundle, Vite skeleton | S | |
| A2 | Dev loop: one command to build on the workstation, copy to the board, restart the unit | S | No native modules, so no cross-compilation |
| A3 | **Bench safety net**: arm/disarm deadman on the board, independent of our code, restoring the last good network configuration on a timer | S | **Before any network code.** Development will break the bench board repeatedly |
| A4 | systemd unit: sandbox, `Restart=always`, watchdog, configurable `MemoryHigh`/`MemoryMax`; journal capped at 200 MB in RAM | S | No `MemoryDenyWriteExecute` — the engine needs writable-executable pages |
| A5 | Platform: systemd over D-Bus — state, signals, start/stop/restart; CLI for enable/disable | M | `StartUnit` returns a job; completion is `JobRemoved` |
| A6 | Platform: network — `ip -j` readers, `ip monitor` as a debounced trigger with full re-read | M | ∥ |
| A7 | Platform: Wi-Fi capabilities — `iw phy`: bands, channels with flags, HT/VHT/HE, antennas, **interface combinations**; `iw reg get`; `iw dev link`, `station dump` | L | ∥ Highest-value parsing in the project |
| A8 | Platform: wpa_supplicant over D-Bus — scan, association state, events | M | ∥ |
| A9 | Platform: hostapd control socket — long-lived event subscriber, station iteration handling the ~4 KB truncation | M | ∥ Never call it with an empty interface argument; it hangs forever |
| A10 | Platform: firewall (`nft -c -f`, `nft -f`, `nft -j`), `writeAtomic`, clock, binary detection including fetching and caching the core's JSON Schema per version and build tags | M | ∥ |
| A11 | Inventory: assemble the hardware model with capabilities; `GET /api/inventory` | M | Needs A6, A7 |
| A12 | State: SQLite, migrations, device row; password login, sessions, forced-credential-change gate | M | ∥ |
| A13 | API skeleton: Fastify, TypeBox, generated OpenAPI, error contract with JSON Pointer, SSE with snapshot-on-connect and coalescing | M | |
| A14 | Logs surface: `GET /api/logs` over the RAM journal with filters, `GET /api/eventlog` over the persistent ring, bounded debug-level switch | M | Both sources readable; the interface says when the journal predates the current boot |
| A15 | Telemetry: in-memory store with ring buffers; wire every platform event source | M | Needs A5–A10 |
| A16 | UI: shell, routing, auth, i18n scaffolding, TanStack Query with SSE invalidation; Status, Clients, Radio (read-only), Diagnostics with the expert dashboard proxied through our auth | L | ∥ once A13 exists |
| A17 | Installer v1: prerequisite checks, runtime install, unit install, unattended-repair kernel setting and check interval, default credentials | M | ∥ |
| A18 | Fixtures and tests for every parser, captured from real output including the awkward cases | M | Written alongside A5–A10 |

**Done when** the bench board shows its complete live state in a browser over its own
access point, nothing about the hardware is hardcoded, both log sources are readable,
and stopping the proxy core leaves the interface fully working.

---

## Epic B — Profiles, planner, protocols

*The configuration model and every change that cannot cost access.*

| # | Task | Size | Notes |
|---|---|---|---|
| B1 | Profile schema in TypeBox: uplinks (possibly empty), one access point, one network, tunnels, policy, routing, DNS, firewall, services; `x-secret`; `schemaVersion`; migrations with a fixture per version | L | |
| B2 | Secret handling end to end: storage wrapper, redaction on read, `$keep` on write, logger redactor, both export modes | M | All four behaviours derive from one annotation |
| B3 | Profile CRUD, activate, import, export; unbound-role reporting and the import gap checklist | M | |
| B4 | Hardware binding resolver; `systemd.link` generation; name validation — 15 characters, no hyphen | M | Enforced where names are generated |
| B5 | **Planner**: pure `profile + inventory → DesiredState`; generators for the core configuration, firewall ruleset, hostapd, DHCP, network configuration, units | L | The heart. Pure, so testable without a board |
| B6 | Invariant checks from [12](12-hardware-invariants.md): interface combinations and the explicit-acknowledgement path, channels against the regulatory domain, driver capabilities, naming, cross-references, port collisions | L | ∥ with B5. Each carries a JSON Pointer and a suggested fix |
| B7 | Differ, human-readable diff, blast-radius classification | M | |
| B8 | Reconciler for `hot` and `service` classes: fixed apply order, validation gate, verification of both active and enabled | L | The order in [06](06-apply-and-rollback.md) is not negotiable |
| B9 | Protocol layer: provider registry; `singbox-outbound` and `raw` providers; schema resolution against the installed binary | M | |
| B10 | Field-descriptor resolver (resolve the discriminated union ourselves, inline references), metadata overlay by JSON Pointer, generic form renderer, raw JSON editor | L | No prior art. A field with no overlay entry must still render |
| B11 | Routing rule editor: ordered list, movable anchors, warning in plan review when one is moved below a tunnel rule, preview of generated rules | M | |
| B12 | UI: Profiles, Profile editor, Tunnels, Routing; pending-changes bar; plan review | L | |
| B13 | Planner tests: golden files for every generated artefact across several synthetic inventories | M | Written with B5/B6 |

**Done when** a profile can be built in the interface from nothing, applied, exported
with secrets redacted, and imported on a second device that then lists exactly which
secrets are missing.

### Decisions taken during Epic B

Recorded here so they are not re-litigated, each with the document that carries the
reasoning.

| Decision | Where |
|---|---|
| **We never share a namespace.** All generated configuration under `/etc/wayfarer`; generated units named `wf-*`; the reconciler may only act on a unit whose name it generated. | [06](06-apply-and-rollback.md) |
| **`systemd-networkd` files, never netplan YAML.** An interface another manager claims is *refused* by an invariant check naming the file; taking it over belongs to Epic C, which has a revert window. | [06](06-apply-and-rollback.md) |
| **DHCP only, resolver off (`port=0`).** Option 6 points at the device and the core answers. The stated cost: with the core stopped, clients lose name resolution. | [03](03-data-model.md) |
| **Classes are defined by what they disturb.** The core cannot reload, so routing-rule edits are `service`, not `hot`. | [06](06-apply-and-rollback.md) |
| **A mixed plan is refused whole**, with every network-class change named and what it needs. The safe part is available only by asking for it explicitly. | [06](06-apply-and-rollback.md) |
| **Interface names** `wfap0` / `wfwan<n>` / `wfvpn<n>`, ≤15 characters, no hyphen, enforced where generated. A rename of the interface carrying the management session is `network`. | [06](06-apply-and-rollback.md), [12](12-hardware-invariants.md) |
| **Three new routing rule kinds** — `domain`, `domainSuffix`, `ipCidr` — because expressing "send this domain direct" through a resource tunnel was a modelling lie. | [03](03-data-model.md) |
| **`firewall.blockedEndpoints`** replaces `stunBlock` and D3's probe-endpoint list: one concept, structured entries, with the enforcing layer stated per entry shape. | [03](03-data-model.md) |
| **`accessPoint` is nullable.** A device with no radio must hold a valid, shareable profile; an unconfigured access point is a state. | [03](03-data-model.md) |
| **`singbox-endpoint` alongside `singbox-outbound`.** WireGuard is an endpoint in the measured build, not an outbound. Only client-shaped types are offered. | [04](04-tunnels-and-protocols.md) |
| **The external OpenVPN provider stands**, although the core speaks it natively: the pushed-DNS capture and the certificate warning need the client's own control channel. | [04](04-tunnels-and-protocols.md) |
| **`x-secret` is stamped onto the foreign schema** from the overlay and a name rule, unioned, failing towards redaction; coverage is a checked-in golden file. | [10](10-security.md) |
| **Ajv (2020-12 build) for foreign-schema validation**, strict mode off, compiled validators cached per schema identity, schema treated as input. | [09](09-stack.md) |
| **The transactions table exists now**, with the full state machine declared and only `staged → applying → committed \| failed` reachable, and `documentBefore` written from the first row. | [06](06-apply-and-rollback.md) |
| **A schema check is not a validity check.** Every generated artefact is validated by the tool that will consume it, before anything starts. A schema pass is a cheap first filter, never the gate. | [06](06-apply-and-rollback.md) |
| **The routing preview is rendered from the profile**, through the same generator the planner uses — never by reading back a generated file. The invariant is "nothing that can carry a resolved secret", not "no contents". | [10](10-security.md) |

### What Epic B leaves for Epic C

Stated plainly, because these are the gaps a reader will otherwise assume are bugs.

* **No network-class change is applied.** The planner plans them and the diff shows
  them; the reconciler refuses and says what each one needs. That is the whole point of
  the split.
* The `awaiting-confirm`, `reverting` and `reverted` transaction states are declared in
  the schema and unreachable.
* Taking over an interface another manager claims is detected, not performed.
* `way revert`, the transient revert unit and the revert-at-start sweep do not exist.

### Verified in a browser

Every screen was loaded and walked in Chrome against the bench board over an SSH forward to the
device's loopback, 2026-09-19: sign-in, Status, Clients, Radio, Diagnostics, Profiles, the profile
editor, the generated form against the installed core's real schema, the raw editor, the routing
editor and its preview, the pending bar and plan review. **Console clean on every screen** — the
only messages present came from a browser extension.

That pass found three real defects that every test had missed, including one that meant no protocol
form rendered at all. They are in [16](16-implementation-notes.md), along with why the tests could
not have seen them. Component tests against a DOM now cover mounting, so a screen that renders today
cannot silently stop; they do not cover appearance, and that limit is stated rather than implied.

---

## Epic C — Network changes, safety, deployment

*The dangerous half with its safety net, plus the full tunnel breadth.*

| # | Task | Size | Notes |
|---|---|---|---|
| C1 | Transaction model: states, persistence with a full copy of the previous document, deadline | M | |
| C2 | Transient revert unit via `systemd-run --on-active=3min`; `way revert --txn`; cancellation on confirm | M | A fresh process, deliberately outside the daemon |
| C3 | Revert of an unconfirmed transaction at daemon start | S | The only thing covering power loss inside the window |
| C4 | Early-revert health checks during the window: access point state, uplink carrier and address, failed units, core running | M | These trigger a revert, never a confirmation |
| C5 | Reconciler for the `network` class: uplinks, access point radio, LAN addressing, firewall | L | |
| C6 | Uplink providers (`ethernet`, `wifi-sta` with scan gating on radios hosting an access point), access point provider, failover between uplinks by priority | M | Empty uplink list is valid and is the default |
| C7 | Firewall generation: kill-switch on new connections only and off by default, IPv6 rejected at the access point, time-sync bypass by destination port, management-port accept, routing exclusions, own-traffic mark, MSS clamping | M | Never flush the whole ruleset — the core owns a table in it |
| C8 | Clock: time servers as IP literals, restart strictly after the firewall, clock state surfaced in status and in tunnel diagnostics | S | A wrong clock presents as broken tunnels |
| C9 | Recovery profile, safe mode after repeated apply failures, factory reset | M | |
| C10 | OpenVPN provider: route pulling disabled, pushed-DNS capture with atomic resolver update, reset-triggered shared-certificate warning | M | |
| C11 | Transport providers: several per tunnel, local keepalive overriding a pushed one, failover between endpoints | M | |
| C12 | `external-socks` provider with managed port allocation | S | |
| C13 | Subscription parsers as a registry with fixtures; timer-driven refresh; warn when a referenced node vanishes without re-pointing policy | M | ∥ |
| C14 | UI: countdown and confirmation, safe-mode page, radio configuration, uplink configuration with scanning | L | |
| C15 | Installer v2, `way doctor`, update flow with bundle rollback, `way debug expose-core-api` | M | ∥ |
| C16 | Hardware verification by hand: break the uplink; kill the daemon right after applying; cut power inside the window | M | All three must self-heal |

**Done when** deliberately breaking the uplink from the interface brings the device
back within three minutes — and the same holds with the daemon killed immediately
after applying, and with power cut during the window.

---

## Epic D — Policy and polish

*Autonomy, then the things that make it somebody else's software too.*

| # | Task | Size | Notes |
|---|---|---|---|
| D1 | Health watchdog: probes, latency, jitter, loss, failure streaks, stickiness, priority order, exclusions; selector control through the core's API | L | Latency alone is not enough — a channel with a low median and large spread otherwise beats a steady one |
| D2 | Kill-switch and fail-open as an explicit policy choice with the consequence stated in the interface | S | |
| D3 | Rule-set based direct routing as profile fields; the probe-endpoint blocking list | M | ∥ |
| D4 | Event ring surfaced in the interface with filtering and its retention rule | M | ∥ |
| D5 | Device identity in the model and an aggregate view across devices | M | Additive; no central controller |
| D6 | Capability reporting: missing binaries, insufficient versions, unavailable tunnel types, with the command to fix | M | ∥ |
| D7 | Documentation pass, README for people outside the project, publishing checklist | M | |
| D8 | A long soak on the bench board: measure resident memory and card writes over days, then set the shipped defaults for the limits | M | Replaces guessing at numbers |

**Done when** blocking one tunnel's endpoint causes a switch within the configured
window with the reason visible in the event ring, and a stranger can install the
thing from the README.

### What D8 delivered, and what it did not

The soak was instrumented first, because it is the only clock-bound task in the epic, and it produced two
things worth more than the numbers: a sampler that resolves the card's device name at **every sample**
because it is not stable across boots on this image, and a report that refuses to describe a series it
cannot parse rather than averaging it.

**It did not deliver a measurement over days.** The longest continuous window is **1.86 hours**, and it
contains eleven daemon restarts because eleven deploys happened inside it while the rest of the epic was
being done. The sampler says so in its own report without being asked. Two of the four shipped limits are
now derived from measurement — the two whose cost is countable bytes on the card — and the two memory
limits are **left where they are**, with the headroom stated and the window named, because a limit
lowered against a peak that was never under load is a limit that kills the service the first time
somebody uses it properly.

That is recorded as an unmet goal rather than a met one. See
[09-stack](09-stack.md#the-shipped-limits-and-the-window-they-rest-on) for the figures and
[the README's State of the evidence](../README.md#state-of-the-evidence) for the short version.

---

## Epic E — The product the owner actually uses

*A reversal, taken deliberately, with its cost written down.*

### The decision being reversed

Epic B was built on **zero code per protocol**: the core publishes a schema describing
what it speaks, a generic renderer draws a form from it, the validator checks against it,
and adding a protocol costs nothing here. [04-tunnels-and-protocols](04-tunnels-and-protocols.md)
argues it at length.

That sentence is true about this repository and false about the person using the thing.
What the owner meets is a text field asking for a command line with flags. Get a flag
wrong and the client does not start, silently — which is exactly how the fourth tunnel
failed on the bench, and the collision that caused it (a generator naming a file `.conf`,
a client inferring format from the extension) was paid for by the operator, not by us.

**We did not remove code per protocol. We moved it out of the repository and into the
owner's configuration**, where it is neither tested nor versioned nor reviewed, and called
that an economy. Three further findings say the same thing from other directions: the
obfuscation transport, a tunnel's destinations and its health probe are each a field a
person must fill and no screen shows, so every tunnel on the bench was configurable
through the API alone.

**What replaces it:** a curated catalogue of protocols the product knows how to run by
itself, each with a designed screen. Outside the catalogue there is nothing — no escape
hatch in the interface and none in the API.

**What that costs, stated plainly so it is not rediscovered as a surprise:** a protocol
the core gains does not appear by itself; it is work here. A profile naming anything
outside the catalogue cannot be imported or stored. The generic renderer, the provider
registry's open-endedness and the `raw` provider are deleted rather than hidden — hiding
them behind an advanced section keeps precisely the inconsistency this epic exists to
remove.

### The catalogue

**Three entries**, decided by the owner and narrowed from six on 2026-09-21:
**OpenVPN**, **Cloak + OpenVPN**, **VLESS**.

The third was called *Xray* until the owner asked why, since his VLESS subscription is
what Xray happens to run. He was right, and the correction matters more than the name: a
catalogue named after what we start is a catalogue named from our side of the product.
What an owner holds is an `.ovpn` file, an `.ovpn` file plus entry points, or a link. So
the VLESS entry **chooses its own carrier** — the core's native outbound, or a third-party
client on a loopback port when the configuration uses something the core does not
understand — establishes that rather than asking, states the choice and its reason in the
plan, and refuses rather than guessing when it cannot establish it. These are exactly what the bench board
actually runs, so every entry can be written against a measured configuration rather than
a reconstructed one. **Shadowsocks** and **WireGuard** move to Epic F, where they are
additions to a mechanism that exists rather than part of building it.

VLESS was in that sentence until 2026-09-21 and should not have been: it is one of the
three entries built here, and the paragraph above describes it choosing its own carrier.
The owner had to point out that xray and VLESS are the same thing, which is what the
mistake came from — a protocol and one of its carriers counted as two.

Each entry owns its binary, its arguments, its configuration file's name and format, its
unit shape and its ordering against the others. A local port, where one is needed, is
allocated by the daemon and never typed by a person.

The narrowing is a schedule decision and not a design one, and the catalogue is built so
that it stays that way: the number of entries changes nothing about how the catalogue
works, and the set is one list. Epic F should be additions, not a second mechanism — if it
turns out to need one, that is a defect in this epic rather than a discovery in that one.

| # | Task | Size | Notes |
|---|---|---|---|
| E1 | Protocol catalogue: one entry per protocol owning binary, arguments, config file name **and format**, unit shape, ordering, and local-port allocation. Three entries | L | `command`, `configFile` and `localPort` leave the profile entirely |
| E2 | Cloak + OpenVPN as **one** catalogue entry rather than a tunnel composed with a transport: the two are configured together because they are chosen together | M | The composition survives internally; it stops being the owner's problem |
| E3 | Profile schema **v7**: a typed configuration per catalogue entry, replacing the opaque `config` record; one migration step from v6, covering every tunnel shape on the bench | L | An earlier revision of this row said v8 from v7. The repository is at 6 with migrations from 1–5, measured. Corrected rather than reconciled |
| E4 | Delete the generic path: `raw` provider, the schema-driven renderer, core-schema fetching for form rendering, the JSON escape hatch | M | Deletion, not concealment |
| E5 | Import and storage refuse a profile naming anything outside the catalogue, saying which tunnel and which protocol | S | The refusal is the feature |
| E6 | Tunnel editor rebuilt: one designed screen per catalogue entry — three of them — plus the three fields no screen has ever shown: `resources`, `probe`, and the obfuscation entry points | L | See [14-open-questions](14-open-questions.md) |
| E6a | **Everything else the deleted profile editor was the only editor for**: the access point and its radio, the uplinks and their credentials, the served network and its address range, the DNS strategy, the profile's own name — onto Network and Settings, in the same commit that deletes it | M | Found when E6 came to delete that screen; see the correction below |

| E6b ✓ | **A profile that is not the active one can be edited again.** Deleting the old editor left the four editing screens working on the active profile alone, so preparing an alternative now requires activating it first — that is, applying it | M | Found by the agent performing the deletion, reporting a consequence rather than a completion |

### The correction E6a exists for, 2026-09-21

E10 put *"the access point, and the uplink it is using"* on the Network screen, and the screen was
built to answer that question — as rows that **report**. Nothing in the plan said to carry the
**editing** controls across, and nothing noticed, because the screen that still held them was
scheduled for deletion by a different task.

So deleting the old editor would have made roughly thirty fields — the network's name, its
passphrase, the address range handed to clients, the uplink's credentials, the DNS strategy —
**permanently reachable only through the API**. That is the owner's original complaint, committed
by the epic written to remove it.

It was found by the agent about to perform the deletion, checking what else lived on the screen it
was told to delete. Not by the plan, not by a review. The general form is in
[16](16-implementation-notes.md): **a task that deletes something must enumerate what else was
reachable only through it**, and the enumeration belongs in the task rather than in the judgement of
whoever executes it.
| E7 | **Parity check as a test**: every field a person must fill is reachable from the interface *and* from the API, asserted mechanically over the schema | M | Register question 3, made into a check rather than a habit |
| E8 | `GET /api/docs`: complete documentation of every endpoint, generated from the TypeBox schemas that already define them | M | Generated, so it cannot drift from the routes |
| E9 | Every `404` names the documentation endpoint in its body as a link | S | |
| E10 | **Information architecture**: seven screens, each answering one question, each one tap away; Status becomes what opens | M | See [08-ui](08-ui.md#the-screens-and-what-each-answers) |

### Correction to Settings' contents, 2026-09-21

The Settings row above was written listing device name, time servers and factory reset. Checked
against the code when the screen came to be built: **`/api/system` is read-only and there is no write
route; there is no time-server field in the profile schema at all** (`ntpBypass` is a firewall
leak-policy boolean, a different thing); and **factory reset exists only as a command on the device**.

So two of those three were specified for the interface without existing anywhere, which is the same
planning error as sequencing E3 before E4 — a requirement written from what the screen ought to hold
rather than from what the device has.

**Device name and time servers leave this epic.** Parity is the requirement, and parity is satisfied:
neither the interface nor the API can set them, so nothing is configurable in one place and not the
other. Adding them is new capability, not the removal of an asymmetry, and it goes to
[14-open-questions](14-open-questions.md).

**Factory reset stays out of the API deliberately, and this is a decision rather than a gap.** The
panel now answers on the wire, on the access point and on the joined network, with a short default
password that is published documentation. The most destructive action this device has — the one with
no undo — should not be one HTTP request away from anybody who can reach either network and has read
the installer's output. It remains a command that requires being on the device. Recorded here so it is
not later filled in as an oversight.

Where a control has no backing, the screen says so in the words the Network screen already uses: this
device does not support that yet, and a blank would have read as an answer.
| E11 | **Layout rebuilt at 360 px**: no horizontal scrolling anywhere, tables become row lists, long values truncate with a copy control instead of wrapping | L | The design width is the phone; the desktop gets the same layout with room |
| E12 | **Text pass**: labels of at most three words, one short sentence of help only where the label would mislead, consequences moved into the controls that cause them | M | Every explanatory paragraph leaves the panel and lands in these documents |
| E13 | **Touch pass**: 44 px targets, nothing hover-only, no control that needs a pointer to discover | S | ∥ |
| E14 | Advanced settings folded rather than removed, and never a second mechanism | S | ∥ |
| E15 | **Verified at 360 px with the longest realistic value in every field** — a full OpenVPN profile, a 253-character domain, a sixteen-tunnel list | M | The reported defects are all length defects; short test values would prove nothing |
| E16 | Password: default `adminpass`, changed from the interface, no forced change | S | Decided by the owner; the exposure is recorded in [10-security](10-security.md) |
| E17 | One wrapper on `PATH` so `hostapd_cli` and `wpa_cli` are correct when typed by hand | S | The only two places this repository leans on its reader |

**Done when** every tunnel running on the bench can be created, edited and diagnosed from
a phone browser, with no command line anywhere in a profile, and no capability exists in
the API that the interface lacks or the reverse — asserted by E7 rather than believed.

### The measurement that decides whether E10–E15 worked

Not a screenshot and not an opinion. **Every configuration change of the last two days was
made through the API, by people who wrote the interface.** An interface its own authors
route around is not slow, it is unused. The epic has worked when the next change of this
kind is faster to make in the panel than in a request — and the honest way to find that
out is to make the next one there and notice whether anybody reaches for the API instead.

### A note on the size column

Four items in this epic were previously estimated as small and were never scheduled: the
configuration file's name, the control-socket wrapper, the missing transport control, and
the missing `resources` control. Each was genuinely small. **That is why none of them was
in a plan** — small unfinished work does not compete for a place in an epic, and this
project has now lost track of four pieces of it, one of which cost an evening and one of
which made the whole product API-only without anybody noticing. Sizing is not the filter
that should decide what gets written down.


---

## Epic F — The rest of the catalogue

*Additions to a mechanism, not the building of one.*

Split out of Epic E on 2026-09-21 to shorten it. VLESS returned to Epic E on the same day, once it was clear it is what the bench's fourth
tunnel already runs. The two protocols left here are not running on any board this project
manages, so each would have been written against a
reconstructed configuration rather than a measured one — which is the failure this
project has a catalogue of.

| # | Task | Size | Notes |
|---|---|---|---|
| F1 | **Shadowsocks** as a catalogue entry with its designed screen | M | Native to the proxy core; an outbound |
| F2 | **WireGuard** as a catalogue entry with its designed screen | M | ∥ An endpoint rather than an outbound in the measured build |
| F4 | A real configuration for each, obtained before it is written | S | The point of the split. A protocol written from documentation is a protocol written against a shape nobody has |
| F5 ✓ | **`Proxy` as a catalogue entry: one entry covering HTTP, HTTPS and SOCKS** — **done 2026-09-22** | S | The owner holds *a proxy*; which of the three it speaks is a field, not a separate screen — decided 2026-09-22. The smallest entry in the catalogue by a distance: the core speaks `http` and `socks` **natively**, so there is no binary, no external process, no allocated port and **no systemd unit** — `TunnelEmission` already makes `units`, `files` and `interfaces` optional, so an entry that emits only an outbound object is structurally allowed. Fields: type, server, port, optional user and password (`x-secret`), and the TLS fields for HTTPS. Availability is unconditional; nothing can be missing |
| F6 ✓ | **Route a whole country through a tunnel, with the list's age visible** — **done 2026-09-22** | S | Needs no routing work: `routing.ruleSets` and the `ruleSet` rule kind already exist, `core-config.ts:354` already emits `route.rule_set`, and `experimental.cache_file` is already enabled — which is what makes a downloaded set survive a restart and a failed refresh fall back to the copy on disk. So `geosite-ru` + `geoip-ru` → the proxy tunnel is **two entries in a profile**, and the same two fields serve any geography, since a set is a tag and a URL. What is missing is the one thing the owner's choice obliges: **the age of the set in use must be visible.** A stale list does not know newly allocated addresses, so traffic leaves unproxied while everything looks healthy — the failure this project wrote Epic G about |
| F3 | **A generated unit's `ExecStart` must name a path the inventory found** | S | `core/generate/units.ts` hardcodes `/usr/sbin/openvpn`, `/usr/sbin/hostapd`, `/usr/sbin/wpa_supplicant`, `/usr/sbin/dnsmasq`; `platform/binaries.ts` searches five directories and reports `present` from wherever it lands. A binary in `/usr/local/bin` therefore passes every availability check and yields a unit that cannot start. The core, `nft` and `ip` already use the discovered path — these four were missed. Found 2026-09-21; not live on the bench board, where `openvpn` is in `/usr/sbin`. Same shape as the `ck-client` omission, one layer down: no guard is derived from the generator. Also unprobed and unremedied: `/usr/bin/systemctl`, `/usr/bin/systemd-notify`; and no generated unit sets `Environment=PATH`, so `exec ck-client` in the transport scripts leans on systemd's default |

| F7 | **The daemon fetches each remote rule set itself, so the age is per set and exact** | M | Opened 2026-09-22, out of F6. The age of a remote set is read from `experimental.cache_file`, and that one file holds every remote set: its modification time is the most recent write by **any** of them, so the figure is a **lower bound** on each set's age and understates. Measured: two sets sharing a cache written an hour ago, one genuinely thirty days stale — both reported `fresh, 3600s`. One set refreshing keeps the rest looking healthy, which is the failure F6 exists to catch, alive inside F6's own check. No reading of that file fixes it: the daemon cannot see inside a format the core does not publish and must not guess at one. **The only truthful answer is to stop asking the core.** The daemon fetches each `remote` set's URL itself into `/var/lib/wayfarer/rule-sets/<tag>.srs` and hands the core a `local` set pointing at that path — then the timestamp is that set's own, it is exact, and it was written by the process reporting it. What it costs, stated so the decision is informed rather than discovered: **(1)** a fetcher with its own schedule, which must be monotonic (`OnBootSec`-style, never a wall-clock deadline) for the reason every other timer here is; **(2)** an atomic write per set — a half-written set file is a core that will not start, so it is write-to-temporary-and-rename, with the same care `platform/files.ts` already takes; **(3)** a decision about what happens when a set file is **missing at start-up**, which is new: today a failed fetch falls back to the core's cache and the core starts, and with a `local` set a missing file is a start-up failure rather than a stale list. That third one is the real design question and it is the reason this is `M` and not `S` — the answer has to keep the property the owner chose, which is that a device with a stale list still routes |
| F8 ✓ | **A refusal must name the thing that has to change** — **done 2026-09-23**: a valid token refused only by the switch gets `403 machine_access_off` naming `way machine-api on`; the command had to be written first, because nothing turned the switch on but a hand-typed `UPDATE` | S | Found 2026-09-22 while deploying F5/F6. A bearer token minted through the product, correctly scoped, is refused by every route while `device().apiEnabled` is false (`api/server.ts:502-510`) — machine access is off until a human turns it on in the interface, which is the right default. The defect is the refusal: it answers verbatim `{"error":{"code":"unauthenticated","message":"log in first","hint":"POST /api/auth/login…"}}`, which says nothing about machine access, so the holder of a valid token is told to do the one thing that will not help and has no way to learn what will. The token and the switch that disables it live on different screens and nothing joins them. **The fix is a sentence, not a mechanism**: when a presented token is well-formed and in scope and the only thing standing in its way is the device flag, say so and name where the flag is. Same shape as the entries in `docs/16-implementation-notes.md` about a hint that sends the operator to the wrong subsystem — a confidently wrong instruction costs more than no instruction |
| F9 | **An apply cannot record why it was made** | S | Found 2026-09-22. The transaction API has no free-text note, so a change carries what it did and never why. The hq resolver fixture was restored inside the same apply as the proxy, and that reasoning could only be written down outside the device — in a chat, to a person, where the device's own history will never find it. Every other record here is built on the opposite principle: the event ring, the plan review and the drift report all exist so the device can answer for itself without somebody remembering. A note is the cheapest of those and the only one missing. It belongs on the transaction, not on the profile, because it explains an **act** and not a state |

**Done when** each is created, edited and diagnosed from a phone exactly as the first
three are, and adding each one touched the catalogue's list and its own files — nothing
else. **If any of them requires a change to how the catalogue works, that is a defect in
Epic E**, and it is recorded as one rather than absorbed here.

### What F5 and F6 built, 2026-09-22

**F5 cost a line in three lists and one new file on each side, and nothing else** — which is
the property Epic E claimed and had not yet been asked to demonstrate. `proxy` was appended
to `TUNNEL_CONFIGS`, to `TUNNEL_PROTOCOL_TITLES`, to `TUNNEL_BRANCHES` and to the daemon's
`CATALOGUE`, with `core/catalogue/proxy.ts` and `components/tunnel/proxy.tsx` beside them.
The compiler enforced the pairing in both directions and was **observed doing it**: with the
schema key added and the editor missing, `apps/ui` failed to typecheck with four errors
naming `proxy`; with the daemon entry unregistered, seven of its tests failed rather than
none. No document migration, because a union that gains a branch accepts more documents and
invalidates none — asserted, with `PROFILE_SCHEMA_VERSION` still 7.

The entry emits an outbound and starts nothing: no binary, no process, no file, no unit, no
allocated port. `https` is the core's `http` outbound with TLS enabled, which is a fact about
the core and not a question for the owner, so one screen carries all three. `tlsServerName`
and `tlsCertificate` are drawn for HTTPS only, and set on a proxy with no handshake they are
**refused by name** rather than dropped — the same ruling as `allowInsecure`, which stays
absent. The honest need behind that switch is answered by supplying the certificate, with
verification still on.

**F6's work was not the routing**, which already existed, but establishing what the age can
honestly be read from. The answer is smaller than hoped and is written down as such in
`core/rule-set-age.ts`: the core's management API carries no rule-set timestamps and is
optional besides, and the cache file is the core's own format, so the only observation is a
**file modification time**. A local set's file *is* the set, so its timestamp is exact. For a
remote set the only timestamp is the cache file's, and that file holds every remote set at
once.

**That figure is a LOWER bound and it understates — corrected 2026-09-22.** This paragraph
said *"it can only overstate an age, never understate one"*, and so did three other places.
The cache file's timestamp is the most recent write by **any** set in it, so every set was
refreshed at or before it and a set may be far older than the figure says. Measured: two
remote sets sharing a cache written an hour ago, one genuinely thirty days stale — both
reported `fresh, 3600s`, which is the silent-stale-list failure this row exists to catch,
surviving inside the check for it. What survives, and the only reason the finding is worth
having: a lower bound already past the threshold means the true age is too, so the overdue
verdict **never false-alarms and only misses**. Every sentence for a remote set now says
what the number is not, and the real fix is row F7 below.

Because a modification time is a wall clock and this board has no RTC battery, **an age is
computed only when `NTPSynchronized` is true**, and otherwise the answer is that it cannot be
measured, with the reason. A timestamp in the future is treated as evidence about the clock.

**Synchronised now is not synchronised then**, and the first version closed only half the
class. Measured: the board boots to a fallback time, the core refreshes a set and stamps the
file with it, NTP then steps the clock forward, and the age is computed across the jump —
`mtime` 0 with a synchronised clock produced *"last refreshed 11574d ago"* and a red finding
naming a set refreshed minutes earlier, which would very likely have been the owner's first
meeting with this feature. One rule closes it without a second clock: **a file cannot predate
the software that wrote it**, so a timestamp below this build's own instant is clock damage
and yields no number. What that costs, written down rather than discovered: an upgrade moves
the floor forward, so a genuinely old cache reads as unmeasurable until the next refresh
rewrites it — a *lost* finding and never a false one, the same direction of failure as the
bound above.

**"I could not look" is not "there is nothing there."** `fileModifiedMs` returns `null` only
for a file that is not there and throws for everything else, and flattening the throw made an
unreadable cache report *"never fetched onto this device, so the rules that point at it match
nothing"* with a hint sending the operator to check a network when the fault was a local
permission. A failed read is its own state with its own sentence and its own hint — and the
hint now reads `set.type`, so a stale `local` set is no longer sent to an uplink and a URL it
does not have.
"Unreasonably old" is `updateIntervalHours × 3` and not a constant: one missed refresh is the
designed path the fallback exists for, three in a row is a pattern, and deriving it from the
owner's own number keeps it proportionate to how fast he said each list goes stale. A set
with no stated interval gets an age and no verdict, and the control that leaves that field
empty says so.

The threshold is pinned with **literal** hours in the tests — 71 and 73 against a daily list,
500 and 505 against a weekly one — because the first version computed its expectation from
`MISSED_REFRESHES` and so agreed with whatever that constant said: `3 → 1` killed no test in
the repository. Both `3 → 1` and `3 → 4` are now red.

It is reported as a **drift finding**, in the report G1 built, because it is that report's own
question: the profile says refresh this list every N hours and the device holds a copy older
than that allows. Every set in use also has its age on the Routing screen, where the sets are
named, since a screen showing only the bad ones cannot tell "this list is fine" from "this
list was not looked at" — and the answer names the profile it is about, because the join
between a stored set and a file is a **tag string**: a screen editing a not-yet-applied
profile that reuses `geoip-ru` was being shown the running profile's freshness for a list the
device may never have fetched.

### Two more found in review, and both were in F5

**A drift finding at a credential printed it.** `contentFindings` puts both differing values
into a finding that `GET /api/drift` serves, the Status screen draws and the **persisted**
event ring keeps, and the core configuration holds a proxy's `password` and a VLESS account's
`uuid` in clear by necessity. The pointer path now withholds both values at a credential and
keeps everything else, and `catalogue-secrets.test.ts` plans every catalogue entry with a
sentinel and fails if one comes out under a key the withholder does not recognise — so a
protocol added without a thought about this is a red test rather than a password on somebody's
device. `planner.ts` had claimed this file was "never rendered in a diff" while it was; the
comment is corrected to what is now true. **Still open and recorded at `lineFinding`:** the
line-by-line half prints the differing line of a non-JSON generated file, and the `.ovpn` blob
and a `hostapd` configuration carry a private key and a passphrase. Closing it needs a mark on
`ManagedFile` saying *this artefact's contents are credentials*; the file mode cannot decide it,
because every generated file here is `0600` including the core configuration this check exists
to compare pointer by pointer.

**The proxy screen produced a refusal nobody could clear.** Fill a certificate on HTTPS, switch
to SOCKS: the control disappears, the draft keeps the value, and the plan is refused pointing at
a field on no screen. The editor now clears the two TLS fields when the type stops being HTTPS,
as an ordinary draft write in the same pending change. The entry's header had said that reaching
that refusal meant a document arrived some other way — it said so while the screen was the thing
producing it, which is what a sentence explaining why a branch is unreachable is worth without a
check that it is.

---

## Critical path and parallelism

The long pole is **A7 → A11 → B5 → B6 → B8 → C5**: capability discovery, inventory,
planner, invariants, reconciler, network changes. Everything else hangs off it.

Runs alongside from the start: the interface shell (A16), the installer (A17), the
subscription parsers (C13), and the form renderer (B10) once the schema is being
fetched (A10).

Two things to resist, both of which look like speed and are not:

**Do not start the profile model before the platform layer reads real hardware.** The
invariants are the valuable part of the model and they can only be written against
what the driver actually reports.

**Do not defer A3.** A development loop that reconfigures a board's network with no
automatic way back turns every mistake into a trip to fetch the memory card.

### E6b, and why a capability loss counts as a defect here

The old profile screen edited whichever profile its route named. The screens that replaced it edit
the **active** one, because that is what each of them was written against. So the epic that exists to
remove "configurable in one place only" introduced the reverse of it: the API can edit any stored
profile and the interface can edit exactly one.

It also makes the dangerous path the only path. Profiles exist so that an alternative can be prepared
before it is used; with this, preparing one means activating it first, and activating is applying.

The shape to build, so it is not discovered again in the design: a profile being edited is chosen,
and **the shell says which one whenever it is not the active profile**. Silent editing of a document
that is not running is how somebody changes the wrong thing and learns about it later.

It was found because the agent performing the deletion reported a consequence it had noticed rather
than only what it had completed.

## Epic G — The device must be able to say what it is actually doing

*Every claim about state must rest on a reading of state.*

Opened 2026-09-22. Not one item here was designed from an idea; every one is a thing the bench board
did while somebody was watching, on 2026-09-21 and the morning after. They were found while trying to
block a handful of STUN servers — a task since abandoned, and irrelevant to all of this. What the
attempt exposed is that this device reports outcomes it has not measured.

The shared shape, stated once because it is the epic: **"applied", "reconverged", "guarded" and
"protocol set" are all words this system says without having read anything back.** The catalogue in
`docs/16-implementation-notes.md` already holds this under several names — a mechanism wired to a gate
it could never pass, an event that claimed more than the result showed, a count blind to a
substitution of equal size, an annotation mistaken for the thing it annotates. It recurs because each
instance was fixed as an instance. This epic fixes the class.

| # | Task | Size | Notes |
|---|---|---|---|
| G1 | **Nothing compares the running configuration with the stored profile** — **done 2026-09-22** | M | The root item. Measured: `profile.firewall.blockedEndpoints` held six entries while `/etc/wayfarer/core/config.json` held none, and the divergence was discoverable only by reading the file and the database by hand. No check exists at any moment — not after a revert, not at boot, not periodically. Until one does, every future divergence is equally silent, whatever caused this one. A divergence must be a finding a person sees, naming the pointer and both values. **Built:** `core/drift.ts` re-derives the **stored** profile through the same `planDocument` every apply uses and compares it with the files on disk, the units systemd reports and the sysctl keys the plan sets — never with `lastAppliedDocument()`, for the reason G4 gives. Each difference is a finding naming the path, the JSON Pointer inside it when the file is JSON, and both values; unit findings carry the differ's own `becauseOf`. It runs at boot (after the unconfirmed sweep), after every undo including the two failure paths, and every 15 minutes on a monotonic `setInterval`. It **reports and never repairs** — see `docs/06` for the argument and the measured cost. Answers at `GET /api/drift`, on the Status screen, in the event ring on a change of answer, and from `way drift`. Proved by editing `/etc/wayfarer/core/config.json` out from under the daemon in `test/drift.test.ts` and asserting it goes red on that pointer and green again when restored |
| G2 | **The confirmation window is decided by the caller's promise, not by what went in** | M | `core/apply.ts:169-170`: `performsNetworkChange = classes.includes('network') && containsClass(classified, 'network')`. A caller that narrows to `['hot','service']` gets no window whatever the plan contains. The resolver watcher (`index.ts:558-563`) is exactly such a caller and is the only unattended one. Transaction `2b7b61418065302e` came from it, was recorded `blast_radius: network`, and had `deadline_at: null` — but see G4: the recorded radius is computed from the full intended document, so it is **not** proof that a network change went in. What needs establishing is whether a narrowed apply can ever install a network-class artefact; if it cannot, this is a reporting defect rather than a safety one, and the column is the thing to fix |
| G3 | **An automatic re-derive applies the whole pending plan, not the thing it woke up for** | M | The resolver watcher exists to reconverge one resolver. At 19:26:22Z on 2026-09-21 it applied the entire prepared Epic E plan — five transports renamed, a port moved, the core restarted — which a person had staged and not ordered (`opened_by: null`). Worse, the only thing that had been holding it back was an unrelated **error**: while `binary_missing` made the plan unusable the automatic apply could not proceed, and fixing that error the same morning removed the brake. A mechanism must act on its own subject or refuse |
| G4 | **A narrowed apply records a document the device never fully ran** | M | Replaces what was written here first, which was wrong — see the correction below. `core/apply.ts:151` vs `:179`: `document_after` stores the **full intended** document even when `classes` narrowed what was actually reconciled. `lastAppliedDocument()` (`state/profiles.ts:678-688`) then names a document the device never ran in full, and that document is what the next revert re-derives from. Nothing reconciles the difference and nothing reports it. Neither `docs/06-apply-and-rollback.md` nor the failure catalogue holds this shape |
| G5 | **The early health check judges the device, not the change** | S | Both reverts above fired at **50 s**, for *"the selected uplink has neither carrier nor address after 45s"* — while the change under test was one file of core routing plus a `wf-core` restart, which cannot affect an uplink's carrier. A brief flap on an unrelated interface therefore destroys any windowed change. The check must be scoped to what the plan touched, or state plainly that it is a device-wide gate so nobody mistakes it for a verdict on their change **Fixed 2026-09-23.** The reading was false, not the device: `ip -j` prints `operstate` as `"UP"` and the check compared it with `'up'`, so every uplink read carrier-less (its stand-in snapshots were lower case). Now `linkCarrier` reads `LOWER_UP`/`NO-CARRIER` first and `operstate` case-insensitively, and a link absent from the snapshot is unknown. The check judges only what the change acted on (`windowScopeOf`), records what it read, and no longer reverts at all — see G13 and `docs/06`, *Early revert — withdrawn* |
| G6 | **Blast radius does not track actual risk** | S | Renaming five transports on the traffic path, moving a listening port and restarting the core classified as `service` and opened **no window at all** (`5cff1d8e65cc28f5`, `105bc54216206268`). Editing one core-config file classified as `network` and opened one. The ordering is defensible per class; what is not is that the class nobody confirms is the one that stops and starts the units carrying traffic. Decide the policy deliberately — it is a policy change, not a repair, and it needs the owner **Class and warning fixed 2026-09-23; the policy half stays open.** The outbound-only diffs came out `network` because removing or adding a routing rule shifted every later rule's index, so a later `ip_cidr` rule read as an address list that appeared; `classifyContentChange` now reads `/route/rules` as the subsequence of address-carrying rules. The warning named the management interfaces whenever any desired `.network` file did; it now requires a networkd change or takeover. Neither fix touches the rename-and-restart case, which is `service` by the table's definition and remains the owner's policy decision |
| G7 | **A running guard's inertness is nowhere visible, and a guard with nothing to probe is accepted** | S | Corrected 2026-09-22: the first wording claimed the only trace was an event nobody reads. That is wrong — the tunnel editor does say it in words (`apps/ui/src/components/tunnel/common.tsx:153-157`, tested `pages/tunnels.test.tsx:85`). But that notice is driven by the **draft** being edited, so it speaks about a profile, never about a guard that is running inert right now; no screen reads guard state at all. And a profile that names a guard without giving it a probe target is still stored and applied. Three of the bench's four tunnels are in that state (`watchdog.ts:197,309`) |
| G8 | **`resolver.reconverged` is emitted from the attempt, not from the write** | S | Corrected 2026-09-22: the first wording overstated it. Epic E already fixed the worse half — `api/resolver-reconverge.ts:97-130` downgrades to `reconverge-refused`/`-failed` when anything was refused, with tests. What remains is narrower and still real: success is concluded from the **absence of refusals**, and nothing reads `config.json` back, so a write that silently changed nothing still reports `resolver.reconverged`. Closing this is G1 applied to one event |
| G9 | **`protocol` and `ports` are silently dropped from a `blockedEndpoints` entry given by name** | S | `routing-rules.ts:292-294` maps only `entry.domain`; the rendered rule carries no network restriction, so `protocol: "udp"` blocks TCP as well. Honour them, or refuse the combination and say which layer could enforce it |
| G10 | **The control states one limit of a `domain` entry and not the one that bites** | S | Corrected 2026-09-22: a limit *is* in the control — *"Blocked in the routing, not the firewall, so a client using a literal address goes past it"* (`apps/ui/src/components/NetworkRules.tsx:93-96`). So the row was right by accident and wrong in its evidence. The measured limit is a different one: a client that **did** resolve through this device still sends a UDP flow that reaches the core with `host=''`, so a rule written about a name has nothing to match. TCP escapes this only because sniffing supplies the name. Say the limit that bites, in the control and in a plan finding |
| G11 | **Write down who owns the clients' DNS, and what follows from it** | S | This board resolves clients' names in `dnsmasq` (`dhcp-option=6,10.44.0.1`, forwarding upstream itself), so the core never learns a name→address mapping. `~/smart-router` chose the opposite — `port=0`, clients handed an external resolver, `hijack-dns` pulling the query into the core — and therefore *can* apply name rules to nameless flows. Both choices are defensible; the consequence was never carried across, and its absence cost two wrong explanations in a row before anyone measured. The decision and its consequence go in `docs/04` and `docs/16` |
| G12 ✓ | **A drift finding prints the differing line of a non-JSON generated file, credentials and all** — **done 2026-09-23** with `ManagedFile.credentials`, set by each generator that writes one and enforced from the catalogue and planner tests | S | Half-fixed 2026-09-22: a divergence at a JSON pointer whose last segment names a credential now reports *that* the values differ and withholds both, and the list of such names is checked from the catalogue end — every entry is planned with a sentinel and a sentinel under an unrecognised key fails the build. The other half stands: `lineFinding` compares `.ovpn` and `hostapd` configurations **by line**, and those files hold credentials in clear with no pointer to key on. A mode rule was tried and rejected for a good reason — every generated file is `0600`, including the core configuration this check exists to diff, so permissions separate nothing. What is needed is a mark on the `ManagedFile` itself saying its contents are credentials, which is also the honest place for it: the generator knows what it wrote, and the comparer should not have to guess from a path |
| G13 | **The window the device reports is not the window that governs** | S | Opened 2026-09-22. An apply answers with `secondsRemaining: 148` out of 180, and that number is not the budget a caller actually has: the early health check of `G5` fires at **45 s** and reverts an unconfirmed transaction outright. So the device states one deadline and enforces another, three times shorter, and a caller who believes the stated one loses the change. Measured the same day: `6110779e063cfb9f` created 19:03:20, reverted 19:04:10. What defeats it is confirming long before the stated deadline — the retry was confirmed at **t+5 s** and the 45 s check then had no unconfirmed transaction to act on. Whatever `G5` decides about the check itself, the number the device reports must be the number it will honour, because a deadline is a promise and this one is not kept **Fixed 2026-09-23 by making the reported deadline the only unattended one**: the window's health check records findings and never ends a window; `test/window-deadline.test.ts` holds the transaction open through a conclusive finding and checks the reported and armed deadlines are one number. Remaining divergence, recorded rather than fixed: a daemon restart inside the window still reverts through the start-up sweep before the timer would have |
| G14 | **The resolver follower's reading lags its own action by one round** | S | Measured on the board 2026-09-23: for about 84 s after the follower reconverged hq to `10.184.48.5`, its observer reading still said *"not converged … 10.184.100.5"* while its state read `ok`. The look is recorded **before** the follower acts and the next look corrects it, so the reading is true of the moment before and false of every moment after. Small, and exactly the class this epic is about: after acting, record what the device now is, not what it was when the round began |
| G15 | **Two observer branches are proven only by tests, never on the device** | S | The resolver watch's *replaced or missing directory* branch and any observer's *stale* state were accepted on 2026-09-23 on tests built through the production wiring (`core/resolver-watch.ts`), because neither can be provoked safely on a live board: moving `/run/wayfarer/tunnel` was refused, and stopping the daemon removes the API that would report `stale`. A bind mount over the path is the likeliest safe provocation for the first; the second wants a test-only stall that does not trip the systemd watchdog. Also noted, probably by design: the `drift` observer's `lastActed` tracks the daemon's own monitor, so a hand-run `way drift` — which is persisted and served by `/api/drift` — does not move it |

| G16 ✓ | **A tunnel's network appearing woke nothing** — **done 2026-09-23** | M | Measured on the bench board: `corp` came up at 07:32:27 with `10.122.0.0/24` on `wfvpncrp`; the fence written at 23:00 while it was down never took it, and drift stayed `diverged` (8 findings). The follower (`core/device-follower.ts`) now also compares the networks on tunnel interfaces with the running fence and re-derives through the same narrowed apply; the address watch wakes it. Removal is lazy — a followed network the fence recorded is retained while absent and leaves only on a core rewrite for another reason — so a flap is not a restart; drift plans through the same rule. `docs/06`, *A tunnel's network is followed in, and leaves lazily*. The follower also now records a look **after** it acts, which is G14's shape closed for this observer. **Reopened and closed again the same day:** the first build refused itself on the board (09:07:52) because the classifier pooled every address in the region and `corp`'s own resource rule already named `10.122.0.0/24`; now judged list by list. Its start-up attempt had also committed `a36badb1d45169a9` as a `network` transaction with no window that wrote nothing — which answers G2's open question for this caller: a narrowed apply now records the class of what it performs and opens no transaction when nothing is permitted |
| G17 ✓ | **A guard with no probe target is never measured, so a dead tunnel reads like a live one** — **done 2026-09-23; its resolver echo replaced by G30 on 2026-09-24** | S | `corp` was unreachable from at least 22:15 to 07:32 and the watchdog read it *not measured (no probe target)* all night. A guard without `probe.endpoints` is now measured by an echo, bound to its own interface, to the resolver its OpenVPN peer pushed — only when the tunnel has an interface of its own and a capture, so `relay` (VLESS via xray) never gets one. An unreachable guard fails the observer from its first round. `docs/04`, *When nothing is given, the peer's own address is measured* |
| G18 | **The Uplink card shows a standby link as the uplink, and never shows the one carrying the traffic** | S | Found 2026-09-23. The card lists only uplinks in the profile, so it shows `wfwan0` (Wi-Fi to `VINTAGE `) as *connected* with signal and rate. Measured on the board: `end0` holds `192.168.77.7/24` at route metric **100**, `wfwan0` holds `192.168.77.8/24` at metric **110**, both to the same router `192.168.77.1` — so **every** packet the board sends, tunnels and Cloak included, leaves by the cable, and the Wi-Fi uplink carries nothing. `end0` is configured by Armbian's stock `10-netplan-all-wan-interfaces.network` and deliberately left unmanaged as the lifeline (the Ethernet takeover is deferred in `docs/14`). That decision is fine; hiding its consequence is not. The card must show every interface holding a default route, managed or not, say which one the kernel actually uses, and say plainly when the managed uplink is standby. Related: G5's uplink check judged `wfwan0`, an interface carrying no traffic |
| G19 | **A network name with a trailing space is shown, and copied, as `VINTAGE\x20`** | S | Found 2026-09-23. `iw` escapes a trailing space in an SSID as `\x20`, and the Uplink card prints it verbatim — and its *copy* button copies the escape sequence, which is not the network's name and will not join it. Decode `iw`'s escapes where they are read, show a trailing or leading space visibly (a marker, not an invisible character), and copy the real bytes. Test against a captured `iw` line, never a hand-typed one |
| G20 | **Review shows standing notes as if they were the change** | S | Found 2026-09-23. With one pending change (a tunnel's network entering the fence), Review showed *"8 things worth knowing"* — a radio width the chip chose, five `resource_tunnel_covers_own_network` explanations, a dynamic-resolver note — each ending *"nothing to change"*. The owner read them as eight changes nobody had applied. Notes about the profile belong beside the profile, collapsed, and not under the change; Review leads with **what applying will do**, and the count it shows is a count of changes |
| G21 | **"This can make the device unreachable" is shown for a change that cannot** | S | Found 2026-09-23, same Review. The only change was adding `10.122.0.0/24` to the core's exclusion list — widening what stays out of the tunnel — and the screen led with the red lock-out warning. The class is `network` because an address rule was added (G6's classifier asserts that on purpose), but a warning about losing access must be about losing access: adding an exclusion does not narrow any path the management session uses. Either split the class, or keep the class and word the warning by what the diff does. Same shape as G6: a warning that cries wolf is not read on the day it is true |
| G22 | **Save is drawn as the primary action when nothing is unsaved** | S | Found 2026-09-23. The pending bar read *"Nothing unsaved."* while **Save** was the highlighted blue button beside it. The primary action should be the one that does something now — here Review, or nothing — and Save should be disabled or absent when there is nothing to save |
| G23 | **"Saved but not running" does not say why, so the world changing reads as the owner's unfinished work** | S | Found 2026-09-23. The banner said *"This profile is saved but the device is not running it. Review, then apply."* No one had edited anything: the tunnel `corp` came back at 07:32 with a new network, so the saved profile now derives a different configuration. The owner reasonably asked who made these changes and why they were never applied. The device knows the cause — drift and the follower compute it — so the banner must name it (*"Corp came back with a new network; applying adds it"*), and distinguish **the owner's unapplied edit** from **the device's own state having moved**, which after G16 it should usually be settling by itself |
| G30 ✓ | **The guard asks the tunnel whether it is alive, and knows nothing about what the tunnel carries** — **done 2026-09-24** | M | Found 2026-09-24. `partner`'s guard fetched `http://172.30.0.212/` — one of the tunnel's own **resources**, written into `probe.endpoints` because the field's own documentation advised *"give a destination tunnel something that exists behind it"*. Overnight that server stopped answering on port 80 (it still answers 443 with `202`); the tunnel itself was healthy (its gateway `10.136.0.1` answered in 95 ms with no loss), and because `onUnavailable` is `block`, one closed port on one server blocked **every** `partner` destination until the probe was removed by hand. The design the owner chose: **(1)** liveness is a property of the tunnel, answered by its catalogue entry — OpenVPN and Cloak+OpenVPN by the protocol's own keepalive (time since the last packet from the peer) confirmed by an echo to the `route-gateway` the peer pushed; WireGuard by handshake age; VLESS and proxies by a request through the outbound to two or three neutral connectivity-check endpoints (`generate_204`), decided by majority; *not measurable* is a third answer, never *dead*. **(2)** `probe.endpoints` is **removed** from the profile, with a schema migration — the guard never learns what a tunnel carries. **(3)** Under `onUnavailable: block` the guard **measures and reports only** and switches nothing: every OpenVPN outbound is already bound to its own interface and a proxy outbound fails closed, so a dead tunnel cannot leak, and blocking bought only a faster error at the price of turning any false reading into a full outage. It switches only under `fall-through`, where it is the thing that decides traffic may leave outside the tunnel. **(4)** The resolver-echo default added on 2026-09-23 is replaced by the gateway: `partner`'s pushed resolvers are public (`77.88.8.8`, `8.8.8.8`), which says nothing about the tunnel. **Done:** as designed, with three findings — sing-box 1.14.1's delay test ignores `http://` URLs and dials `www.gstatic.com` (so the checks are HTTPS, and the night's probe may never have reached `172.30.0.212`); OpenVPN exports no `route_vpn_gateway` without a route list of its own (so the generated file carries an uninstalled TEST-NET-1 route); and `fall-through` has no selector, so there was nothing for the guard to switch. `docs/04`, *The guard asks the tunnel, and blocks nothing* |
| G31 ✓ | **`fall-through` promises a route around a dead tunnel and has none** — **done 2026-09-24** | S | Found 2026-09-24 while building G30: a tunnel on `onUnavailable: fall-through` gets no selector at all — its routing rule points straight at the tunnel's outbound — so a dead fall-through tunnel fails exactly like `block`. The profile's doc comment has been corrected; the interface still says *"Let it through: Traffic goes out the ordinary way instead"*, which is false. Owner's decision: build a real fall-through (a selector the guard moves to the ordinary route when the tunnel reads dead, by the G30 liveness answer only, since a false reading here leaks traffic outside the tunnel), or remove the option. No tunnel on the bench uses it. **Done:** built, not removed. Each fall-through tunnel gets `wf-fall-<id>` (the tunnel, then `wf-selector` — `route.final`, the way traffic no rule names goes; rules below the tunnel's are not consulted while it falls through, which on the board means `hq`'s `10.0.0.0/8` is bypassed for `corp`'s networks), and a tunnel with its own resolver gets `wf-fall-dns-<id>` (the tunnel, then a loopback SOCKS loop that hands the query to `dns-tunnel`), because a resolver that exists only behind the tunnel cannot be reached the ordinary way. The guard moves both after **2** strictly consecutive dead rounds and back after **3** strictly consecutive alive ones; not measurable moves nothing and resets both counts; a position found on the ordinary route with no dead reading from this process is put back on the tunnel unless the tunnel reads dead now. `block` tunnels unchanged. The panel says *"Falling through — traffic is leaving outside the VPN since HH:MM"* from a monotonic `fallingThroughSeconds`, and the choice warns first. Findings: sing-box 1.14.0's DNS router does not fall to the next rule when an exchange fails, only when a response is rejected; and the dead-tunnel detection claimed as about 10 s is ~27–32 s (echo) and ~45–52 s (keepalive only) measured, corrected. On-device acceptance pending. `docs/04`, *`fall-through`: a route around a dead tunnel* |
| G32 | **The core's delay test silently replaces `http://` URLs with its own default** | S | Found 2026-09-24, measured on sing-box 1.14.1: a probe URL starting `http://` is not fetched; the core dials `www.gstatic.com:443` instead, and only `https://` URLs are used as given. So a probe that names an internal HTTP service may have been measuring Google through the tunnel all along — which reopens the cause of the 2026-09-24 `partner` block (G30) — and the device-wide failover probes (`policy.probes.endpoints`, both `http://`) are affected the same way. G30 removes per-tunnel probe URLs; the device-wide ones remain. Verify on the board's 1.14.0, then refuse or rewrite `http://` probe URLs where they are accepted, and record the measured behaviour in the protocol fixtures |
| G33 ✓ | **The distribution's `dnsmasq.service` races `wf-dhcp@` for the access point's sockets** — **done 2026-09-24** | S | Found 2026-09-24: the stock unit was enabled on the board and failed at every boot, because `wf-dhcp@<ap>` bound first; nothing orders the two, so a boot on which the order flips leaves the access point's clients with no address. The installer now stops, disables and masks (persistently) every unit in `STOCK_UNITS_TO_MASK`, logging each with its reason; the daemon holds the same list in `platform/stock-units.ts` (a test fails when the two differ), and the drift check reports a listed unit that is no longer masked as a `unit-conflicting` finding. `wpa_supplicant.service` and `hostapd.service` were checked and deliberately left alone — see [11-deployment.md](11-deployment.md), *Distribution units the installer masks* |

### Uplink failover in five seconds (opened 2026-09-23)

The owner's requirement, verbatim in substance: **if the cable is pulled, the device falls back to Wi-Fi on its own, with at most five seconds of downtime, and every tunnel is back inside those five seconds.** Measured on the board the same day, the device is nowhere near it, and not for one reason but five:

* `end0` (cable, metric 100) and `wfwan0` (Wi-Fi to `VINTAGE `, metric 110) are two DHCP routes to the **same router** `192.168.77.1`. Pulling the cable makes systemd-networkd drop `end0`'s route and the kernel falls through to Wi-Fi — by configuration, not by anything Wayfarer does, and not measured.
* The board's **only** resolver comes from the cable (`resolvectl`: `end0 → 192.168.77.1`; `wfwan0` has `UseDNS=no`). HQ's `intra.ovpn` names all four servers by hostname, so after a failover hq may never come back. This is the chicken-and-egg already recorded in `docs/14`.
* Every OpenVPN tunnel runs **`ping-restart 120`, pushed by its server** (hq, partner, corp). Their UDP sockets were opened from the cable's address; after the switch the router's NAT mapping changes and the servers stop hearing them, and nothing notices for up to **two minutes**.
* TCP transports (Cloak for `corp`, VLESS for `relay`) die with the old source address and reconnect only when something next asks.
* Only carrier loss is detected at all. A cable that stays plugged into a dead upstream, or Wi-Fi associated to a router with no internet, is never noticed.

What already helps: the core has `auto_detect_interface: true`, so it follows the default route by itself; and Wi-Fi is **already associated and holding a lease**, so the standby path costs no association time. The budget below is therefore spent almost entirely on detection and on the tunnels.

| # | Task | Size | Notes |
|---|---|---|---|
| G24 | **Failover drill: a measured, repeatable test of the five-second budget** | M | The acceptance criterion for this group, built first so every row below is judged against a number and not a belief. A drill that takes the active uplink away — `ip link set end0 down` under an armed deadman is the safe stand-in for a pulled cable, and a real pull with the owner present is the final proof — while probes run **through every tunnel** at 100–200 ms (a request that can only succeed via that tunnel), and reports per tunnel: last success before, first success after, gap. Pass: every gap ≤ 5 s, `relay` included, and the AP never drops. Also run it the other way (failback) and with the upstream silently dead rather than the link down. Recorded in the event log, shown on the Uplink card (G18) as *last failover, measured downtime* |
| G25 | **Name resolution must not depend on one uplink** | S | Today the board resolves only through the cable's DHCP DNS. Take resolvers from **every** live uplink (Wi-Fi's `UseDNS=no` was set to keep the router's DNS out of clients' path — that is a client concern and must not starve the device itself), and additionally **pre-resolve every tunnel endpoint given by name** and keep the last good addresses, so a tunnel can reconnect in the first second after a failover without asking anyone. HQ's four `*.opennetw.com` servers are the live case. Closes the circle recorded in `docs/14` for the failover path; the Ethernet-takeover half stays there |
| G26 | **Two uplinks on one subnet need source routing** | S | `end0` (`192.168.77.7`) and `wfwan0` (`192.168.77.8`) share `192.168.77.0/24` and one gateway. With one main table, a packet from `.7` can leave by Wi-Fi and a packet from `.8` by cable, replies can arrive on the other interface, and an active probe `-I wfwan0` does not prove what it claims. Per-uplink routing tables with `ip rule from <addr> table <uplink>`, so each uplink's address always leaves by its own interface, and the health probe of each uplink tests that uplink and nothing else. Prerequisite for G27 |
| G27 | **Detect a dead uplink in about a second, including a silent one** | M | Carrier loss is instant through netlink and must trigger immediately. A **silent** failure — link up, upstream dead — needs an active probe per uplink, sourced from that uplink (G26), at ~0.5–1 s with failover on 2–3 consecutive misses, against more than one target so one dead host is not a dead uplink. Budget: detection ≤ 1.5 s so the tunnels keep ~3.5 s. Must reuse the observer and monotonic-time machinery (and record *what it read*, the lesson of G5, where a reader that saw `"UP"` as down reverted healthy changes for a month) |
| G28 | **Kick every tunnel on failover instead of waiting for its own timeout** | M | The biggest term in today's downtime. On a switch, the device restarts or soft-restarts each tunnel's transport at once and in parallel rather than waiting for `ping-restart 120`: `SIGUSR1` to each OpenVPN client (a soft restart re-handshakes from the new source), restart of each Cloak client, and a reset of the VLESS/xray connection pool for `relay`. Client-side OpenVPN timers can also be tightened without the server (`pull-filter ignore "ping-restart"` plus a local `ping 1`/`ping-restart 4`) as a backstop for failures the uplink monitor misses. Measure each tunnel's reconnect time with G24; the one at risk is `corp`, whose Cloak server is in Singapore at ~300 ms RTT and needs a TCP, a TLS and an OpenVPN handshake in sequence — if it cannot make 5 s, say so with the number rather than widen the budget quietly |
| G29 | **Failback policy, and whether Wayfarer takes the cable over — owner's decisions** | S | Returning to the cable when it comes back is a second interruption of up to five seconds. Options: return only after the cable has been stable for N seconds; return only when traffic is idle; or stay on Wi-Fi until told (sticky). Separately: all of G24–G28 can be done by **observing** `end0` and orchestrating routes, resolvers and tunnels, without taking over its configuration — which keeps the cable as an untouched lifeline, the reason the takeover was deferred in `docs/14`. Recommend observe-and-orchestrate first; decide the takeover only if a measured gap proves it necessary |

### Correction, 2026-09-22, before any of this was built

The first version of G4 read *"a revert can discard a change committed after it opened"*. It does not.
Tracing the code settled all three candidate causes:

* There is **no configuration snapshot** — a revert re-derives from a document (`apply.ts:683`,
  `:719-733`), so nothing can be restored from a stale file.
* `document_before` is a **live SQL read at transaction-open time** (`apply.ts:178` →
  `state/profiles.ts:678-688`), not an in-memory copy, so it cannot predate a commit by another caller.
* `2b7b61418065302e` was the **resolver watcher**, not an operator apply; the rule reached
  `config.json` inside `4e6da66` itself, whose revert then correctly restored the document from before
  it. **The revert did exactly what it is for.**

What remains true, and is the whole point of this epic: a person's committed work disappeared and
**nothing said so**. The defect was never in the undo. It is in G1 — that no one compares the running
state with the stored one — and in G5, that the gate which triggered it was watching an interface the
change could not touch.

Recorded because the wrong version was written down with confidence and evidence attached, and the
evidence was real. It was the reasoning over it that was invented.

**Done when** a person can ask the device what it is doing and disbelieve nothing in the answer:
the running state is compared with the stored state and a divergence is visible; a safeguard is armed
by what changed rather than by what a caller intended; an automatic mechanism touches only its own
subject; and every event that asserts a result is emitted from the result.

**Deliberately not here.** The WebRTC and STUN work that exposed all of this: the owner solved it in
the browser on 2026-09-22 and the router no longer needs to. G9 and G10 stay because they are defects
in a field that remains, not steps toward that goal. G3's kinship with F3 is worth noting — both are
a guard derived from one source while a second source names the same thing — but they are separate
changes.

### Measured a third time, 2026-09-22, while removing the Russia tunnel

`G5`'s reason string was already recorded from September. What was added today is the part that
turns it from a suspicion into a defect: the verdict was checked **against the interface at the same
moment** and was false. Apply `6110779e063cfb9f` was reverted 50 s after it was created, for *"the
selected uplink has neither carrier nor address after 45s"*, while `wfwan0` was `UP, LOWER_UP`,
associated at −28 dBm and holding `192.168.77.8/24`. The check did not observe a flap. It read the
uplink wrongly and destroyed a change on the strength of it.

`G6` gained its cleanest instance in the same sitting, and it is a negative one, which is worth more
than another example. Removing an outbound classified as `network` and warned that the owner would
probably lose the connection he was using — while the change set was one file and one `wf-core`
restart. The leaf pointers that moved were the two `russia` outbounds, one `route.rules` entry, and
`russia` leaving `wf-selector`'s members. **None of them is a reachability pointer**, so by the rule
`docs/06` states the class should have been `service`. The board does still emit `service` for other
diffs (`ce91935ea0d28060`), so the mechanism is not simply stuck — this diff shape specifically is
misclassified. Three applies on 2026-09-22 (`1b87739bc7c85899`, `c77ac7f27f86a096`,
`d03414ffe34327ff`) carried the same warning naming the same two interfaces, and the access point
never went down in any of them.
