# 7. API

One HTTP surface serves the SPA, the operator and automation. Same origin, same
port; only the authentication mechanism differs.

## Principles

**The API is the only way to change anything.** The SPA is a client with no
privileges of its own. If a thing cannot be done through the API it cannot be done
in the interface, which keeps automation a first-class path rather than an
afterthought.

**The API is disabled by default.** Machine access is switched on by `way machine-api on`,
on the device, as root; tokens are created, listed and revoked on Settings → *API tokens*.
A fresh device has no token and no way to be driven remotely until a human enables it.

*Corrected 2026-10-07.* This paragraph said the switch was in the interface, where tokens
were also created. Neither was true: the switch has only ever been the CLI (by decision —
see [10-security.md](10-security.md)), and no screen called the token routes at all, so the
only way to mint a token was a `curl` against the login route carrying the password. The
sentence described the plan in [08-ui.md](08-ui.md) as if it had been built. The tokens
card now exists; the switch stays a command, and the card shows which way it is set.

**Schemas are the contract.** Request and response schemas are defined once in
TypeBox, used for validation, for response serialisation, and to generate an
OpenAPI document. There is no hand-written API reference to fall out of date.

## Authentication

| Client | Mechanism |
|---|---|
| Browser | Password login, then an opaque session id in an `HttpOnly; SameSite=Lax` cookie. Sessions live in the database, so revoking one is immediate. |
| Automation | `Authorization: Bearer <token>`. Only the SHA-256 of the token is stored; the value is shown once at creation. |

Passwords are hashed with `scrypt` from the runtime's own crypto module — chosen
over Argon2 and bcrypt because those are native modules, and native modules on this
architecture are a build problem waiting to happen.

Tokens carry scopes and an optional expiry:

| Scope | Grants |
|---|---|
| `read` | Every `GET`, the event stream |
| `apply` | Profile edits, activation, applying, confirming transactions |
| `admin` | Tokens, password, factory reset, full export including secrets, adding and removing peers, switching the device off |

A `read` token is what one device is given to appear in another's aggregate view, and it is enough
because nothing in that view changes anything.

Login is rate-limited per source address, and failures are recorded as events. The window is counted in
**uptime within one boot**, not wall-clock time, and attempts from an earlier boot take no part in the
decision — so a reboot clears a lockout in progress. That is a deliberate trade with its reasoning in
[10-security](10-security.md#the-lockout-trade-a-reboot-clears-an-in-progress-lockout): nobody can reboot
this device without already holding the access a lockout protects, and locking a legitimate operator out
of a device whose only management surface is its own access point is the worse outcome.

**A credential is never expired while a transaction it opened is awaiting confirmation.** The one moment
an operator must not lose their session is while a timer counts down on a change only they can confirm.
The exemption is narrow: that transaction, that credential.

## Where it listens

Every **local** channel: loopback, the **wire**, the **access point** this device hosts,
and — by default — the Wi-Fi network this device is a **client of**. Never a tunnel
interface, and never the proxy core's own dashboard, which stays on loopback.

The wire is named explicitly because it was missing. An earlier revision of this section
listed loopback, the access point and the uplink, and the implementation matched it: the
bind set was built from what the last apply had recorded, and **no plan touches the
wire** — it is the lifeline every plan leaves alone — so it could never appear there.
Measured on the bench board, 2026-09-21: the panel answered on `192.168.77.8` (the
wireless uplink) and refused on `192.168.77.7` (the wire), two addresses in one subnet.
The reasoning that produced the gap is worth more than the gap: the requirement was
verified against the interfaces already in the list, which proves the list and says
nothing about what it omits.

**The prohibition is enforced, not inherited.** No tunnel was ever bound before this, but
nothing refused one — the positive half simply never named a tunnel, and the guarantee was
a side effect of a short list. Widening that list to include the wire would have dissolved
it in the same change. So the refusal is a separate final step over the names already
chosen, it consults tunnel names from every source that knows one — including tunnels this
device did not create — and it records an event if it ever has anything to remove, because
reaching it means something upstream called a tunnel a local channel.

The uplink surface is a profile setting, `services.management.onUplinkNetwork`, defaulting
to on. An earlier revision of this document said *"never to the uplink"* and treated it as
an invariant; that was **a narrower reading of the requirement than the owner's**, not a
mistake — see [10-security.md](10-security.md#correction-the-earlier-position-was-narrower-than-intended-not-wrong)
for why the switch is what lets both readings be true.

Enforced twice on purpose: by the **bind address**, which is what makes the socket exist,
and by an **input rule** in the generated firewall, which survives a profile change that
alters which interface is which and which is also what keeps the panel reachable while the
kill-switch is active. Both come from the same resolved interface list.

**By interface name, never by address.** The names are recorded by the plan that resolved
them — a profile names a radio and a role, and what comes out is `wlan1` or `wfwan0`. On the
bench board the uplink and a separate Ethernet management path share a subnet, so binding by
address would have caught both and there would have been no way to tell from the result which
one was asked for.

## Shape

**This list is a convenience and not the contract.** The contract is `GET /api/docs`, which is
generated from the schemas and the live route table on the device in front of you; this one is
typed by hand and can go stale, and has. Read as of 2026-09-21 from the route table of a server
built with every route registered — 38 operations, which is what `test/api-docs` compares the
documentation page against.

Five entries were removed from this list on that date, because they are **not registered**:
`PATCH /api/profiles/:id`, `GET /api/schemas/field-meta`, `POST /api/wifi/scan`,
`ALL /api/clash/*` and `POST /api/device/factory-reset`. `/api/docs` had always omitted them
correctly — a generated page cannot invent a route — so the prose was the stale side. The two that
are worth a sentence rather than a deletion: there is **no JSON Merge Patch**, a write replaces the
document and resolves `{"$keep": true}` at secret positions, and there is **no proxy to the core's
own API**, which went with the generic path in E4.

```
GET    /api/health                    liveness; no credential at all
GET    /api/system                    versions, uptime, clock, core detection, management channels
POST   /api/system/poweroff           switch the device off; body exactly {"confirm":"poweroff"}
POST   /api/tunnels/:id/restart       restart one running tunnel's own units; no body
GET    /api/inventory                 discovered hardware, capabilities, binding candidates
GET    /api/status                    assembled live state

GET    /api/profiles                  list; a row this build cannot read carries its fault
POST   /api/profiles                  create
GET    /api/profiles/:id              full document (secrets redacted)
PUT    /api/profiles/:id              replace document; {"$keep": true} keeps a stored secret
DELETE /api/profiles/:id              the one path that does not read the document
POST   /api/profiles/:id/activate     switch active profile      → transaction
GET    /api/profiles/:id/export       ?secrets=include for the full form
POST   /api/profiles/import           validate, migrate, store; reports gaps and refusals

POST   /api/apply                     apply the active profile   → transaction
                                      ?dryRun=1 returns the plan only
GET    /api/plan                      plan for the active profile without applying

GET    /api/transactions              recent attempts
GET    /api/transactions/:id
POST   /api/transactions/:id/confirm
POST   /api/transactions/:id/revert   revert now, without waiting

GET    /api/schemas/profile           JSON Schema for the document
GET    /api/protocols                 every catalogue protocol and whether this device can run it

POST   /api/subscriptions/parse       body: { text }; returns catalogue configurations

GET    /api/events                    SSE; a query, or no Accept: text/event-stream, is refused (see Events)
GET    /api/observers                 every mechanism that watches the world: last look, last act, running?
GET    /api/logs                      journal lines from RAM: ?unit=&level=&since=&grep=&limit=
GET    /api/eventlog                  the persistent ring from the database: ?limit=&kind=&level=&since=
POST   /api/debug/log-level           raise the level for a bounded period

GET    /api/docs                      every endpoint, generated, rendered for a person; no credential
GET    /api/openapi.json              the same document, for a tool; needs the read scope

GET    /api/capabilities              what this device can do, and the command for each gap
GET    /api/fleet                     this device and its peers, each peer's own summary
GET    /api/peers · POST · DELETE /api/peers/:id

POST   /api/auth/login
POST   /api/auth/logout
POST   /api/auth/password
GET    /api/tokens · POST · DELETE /api/tokens/:id
```

### Switching the device off: `POST /api/system/poweroff` (2026-09-23)

Asked for by the owner in these words: *a button in the control panel that switches the device off,
doing `poweroff`*. It is the one route whose success means the device answers nobody — not the panel,
not the access point, not a tunnel — until somebody cycles its power, because the board has no power
button and nothing turns it back on. So every guard is ordered to fail before anything is written:

| order | guard | refusal |
|---|---|---|
| 1 | `admin` scope | 403 `insufficient_scope` |
| 2 | the body is exactly `{"confirm":"poweroff"}` — no body, `{}`, another word, another key (`dryRun` included) | 400 `confirmation_required`, with the body to send in `hint` |
| 3 | no transaction is `awaiting-confirm` | 409 `confirmation_pending`, naming it, with `secondsRemaining` from `windowCountdown` |

Then, in this order: a `system.poweroff` row in the event ring naming who asked (a token by id and
name; a browser session by source address, **never by its id**, which is the credential), with the
boot id, the uptime and whether the clock was synchronised — the board has no clock battery, so the
wall-clock `at` alone cannot be trusted after the power cycle that ends the outage; a `202`; and,
**after the reply has finished** plus three seconds, `systemctl poweroff` through
`platform.systemd.poweroff`. A second request while one is under way gets the same 202 and writes
nothing. If systemd refuses, a `system.poweroff-failed` row says so, so the ring never claims a
switch-off beside a device that is still running.

**Why `admin` and not `apply`.** `apply` changes and confirms configurations, and the device can undo
every one of those by itself. Switching off cannot be undone from any network: a leaked `apply` token
must not be able to take the device away from everyone until somebody walks up to it.

**Why the window is a refusal and not a warning.** Switching off inside a window does not keep the
change. The start-up sweep reverts every unconfirmed transaction at the next boot — which here is
whenever the power is next cycled, hours later, with nobody watching the revert.

**Why this is on the API when factory reset is not.** Factory reset destroys state with no undo;
switching off destroys nothing, and the way back is physical. The exposure is the same short published
password on the same networks, so it is `admin`, confirmed in the body, and recorded — and the owner
asked for it. **Verified on the bench board by the owner, 2026-09-23 21:19:** the power-off button in
the panel switched the board off; the board was then rebooted. (Until then this read as an
assumption: `systemctl poweroff` from inside the daemon's unit had not been run on the board, and relies on
the same privilege path as the `systemctl reboot` fallback in `host.reboot`.)

**Proving the route exists on a device without calling it.** `GET /api/docs` lists it under the anchor
`op-post-api-system-poweroff`, with no credential. Or `POST /api/system/poweroff` with an `admin`
credential and **no body**: the handler's first statement is the body check, and nothing before it
reads or writes anything, so the answer is `400 confirmation_required` and the device stays on.

### Reconnecting one tunnel: `POST /api/tunnels/:id/restart` (2026-10-09)

Asked for by the owner as a button, after a tunnel stayed broken behind a live peer and nothing on the
device restarted it (the measurement is in
[04-tunnels-and-protocols](04-tunnels-and-protocols.md#a-path-broken-behind-a-live-peer-is-restarted-by-nobody-2026-10-09)).

| order | guard | refusal |
|---|---|---|
| 1 | `apply` scope | 403 `insufficient_scope` |
| 2 | the id is in the running plan's `tunnelUnits` | 404 `tunnel_not_running` |
| 3 | the tunnel has units of its own | 409 `tunnel_has_no_units` |
| 4 | no transaction is `applying` | 409 `apply_in_progress` |
| 5 | no restart of the same tunnel is under way | 409 `restart_under_way` |

Then each unit the plan recorded for the tunnel is restarted in the recorded order, each job awaited,
each unit's state read back, and a `tunnel.restarted` or `tunnel.restart-failed` row written naming who
asked. The answer is `200` either way, with `restarted` true only when every job ended `done` **and**
every unit read back active.

* **Unit names come from the plan, never from the request.** The id is only a key into what the last
  apply recorded; an id it does not hold restarts nothing.
* **`apply`, not `admin`.** Nothing persistent changes, and the tunnel reconnects by itself or not at
  all — the same as a reconnection its peer can force at any moment. Switching off is `admin` because
  nothing brings the device back; here everything does.
* **A tunnel inside the core is refused.** It has no process of its own, and restarting the core would
  interrupt every tunnel to reconnect one.
* **Not during an apply**, which restarts the same units; two restarts racing leave a state neither chose.
* **"Restarted" is not "connected".** That is the watchdog's next reading in `GET /api/observers`, which
  the panel asks for again after the answer.

### The countdown a client should watch is `secondsRemaining`, not `deadlineAt`

Both are returned. `deadlineAt` is a wall-clock instant, and it is there so a row a human reads later
says when something was due. **It is not what a countdown should be computed from.**

This device has no clock battery, and the apply that opens the window deliberately restarts the time
service — so a wall-clock step of days *inside the window* is the designed path rather than bad luck. A
client subtracting its own `Date.now()` from the device's `deadlineAt` is subtracting across two clocks,
and the answer is wrong by however far apart they are. `secondsRemaining` is a **duration**, which means
the same thing in both frames, and it is derived on the device from the boot-relative deadline the revert
timer will actually act on. `deadlineAnchored: false` means the row predates that anchor and the figure
fell back to the wall clock — a client showing a countdown should say so rather than presenting it as
exact.

### Capability gaps, and why the command is in the response

`GET /api/capabilities` returns each capability with its state (`available`, `missing`, or **`unknown`** —
a question the device could not answer, which is not a gap), what is missing, and a remedy per missing
piece. The remedy carries the command because the package name is usually **not** the binary name — `nft`
is in `nftables`, `dnsmasq` in `dnsmasq-base` — and a client that generated `apt install <binary>` would
be wrong most of the time. Some gaps carry `command: null` with a note instead: a radio whose driver does
not report AP mode is not fixed by installing anything.

### Binding candidates answer a question about hardware, not about a plan

`GET /api/inventory` carries `candidates`, with two lists: `radios` and `interfaces`. Each entry is a
piece of hardware with the selector that would bind a role to it, whether that selector actually
**distinguishes** it from its siblings, and — where a distinguishing selector had to replace one that
follows the device — what that costs, in words.

**Two lists rather than one.** The question a chooser asks is always about one kind: an access point
binds to a radio, a wired uplink to a port. A single merged list would be answerable only by the
client deciding which entries are radios, and the kernel makes that easy to get wrong — it reports a
radio with the same link type as a wired port. That classification stays on the device. With two
lists, an empty `radios` beside a non-empty `interfaces` is an answer *about radios* rather than
about the inventory.

**The key is optional, and absent is not `[]`.** Absent means nobody looked; an empty list means this
device was asked and has no hardware of that kind. The same distinction as `channels`, `refused` and
`withheld` on `/api/system`, for the same reason: an empty list is the reassuring answer given in
exactly the case where nothing was checked. `consequence` inside a candidate is optional on different
grounds — its absence means there is nothing to say, not that nobody looked.

It is answered here rather than only inside a plan because the list was previously reachable only
through the plan of the **active** profile, which is a plan review and is not available while editing
the binding of any other profile — the moment the chooser is needed.

### The aggregate view is read-only, and that is a safety property

`GET /api/fleet` asks each peer for its own summary with a read-scoped token **the peer issued**, and
there is no route anywhere that changes a peer. The confirmation window protects the operator of the
device being changed; a change arriving from another device has no such operator, so allowing one would
mean rewriting the recovery design. Peer state is three-valued — `answered`, `refused` (it is working and
will not accept the credential) and `unreachable` (nothing came back) — because the last two call for
entirely different actions and a single error hides which.

### Why activation and apply return transactions

Both can change the network, so both go through the transaction machinery in
[06-apply-and-rollback.md](06-apply-and-rollback.md). The response is the
transaction, including `blastRadius`, `state` and, when confirmation is required,
`deadlineAt`. A client that ignores `deadlineAt` will see its change reverted three
minutes later, which is the correct outcome for a client that is not paying
attention.

For `hot` and `service` classes the transaction comes back already `committed`, so a
simple client does not need to special-case anything.

## Logs: two sources, one surface

Both are readable through the API and both are shown in the interface. They are
different things and the distinction is visible to the caller rather than hidden.

| Endpoint | Source | Volume | Survives power loss |
|---|---|---|---|
| `GET /api/logs` | systemd journal, RAM-backed, capped at 200 MB | Everything the daemon and the managed services emit | **No** |
| `GET /api/eventlog` | database ring, about 5000 rows | Significant events only: apply, revert, profile switch, tunnel transitions, authentication | **Yes** |

`/api/logs` pages with an opaque cursor. A request with no cursor returns the newest entries; a
request with one returns the entries **immediately after it**, in order, with no gap. That
distinction is worth stating because the obvious implementation does not have it: `journalctl -n N`
is tail-anchored, so asking for "N lines after this cursor" with `-n` returns the newest N of the
matches and silently drops everything between — and a log viewer that skips the middle tells the
operator that nothing happened there. The response carries `hasMore`, which means *more entries
exist beyond this page*, not merely that the page came out full; the two look identical to a caller
and mean opposite things.

`/api/logs` supports filtering by unit, level, time window and a substring, because
200 MB is far too much to page through. `/api/eventlog` is small enough to browse.

After an abrupt power loss `/api/logs` is empty for everything before the current
boot, and `/api/eventlog` is the only record of what happened. The interface says so
on the diagnostics screen rather than letting an empty log look like an absence of
events.

A debug switch raises the log level for a bounded period and lowers it again on its
own, so a forgotten debug session cannot fill the 200 MB and evict what mattered.

## Events

One SSE stream, `GET /api/events`. SSE rather than WebSocket because the traffic is
one-directional, browsers reconnect on their own, and `Last-Event-ID` lets a client
catch up on what it missed. A WebSocket will be added only if something genuinely
duplex appears, such as an interactive console.

```
event: hello           the stream is open, with the id to resume from
event: status          incremental live state
event: unit            { unit, active, enabled, sub }
event: station         { ap, mac, action: "connected" | "disconnected", signal }
event: log             { level, msg, at }         (rate-limited)
```

Two details that make this usable. Events are coalesced — a burst of interface
changes becomes one `status` event rather than forty. And the stream sends a
snapshot on connect, so a client never needs a separate "get current state" call to
initialise.

**The stream is not the list, and says so.** Measured 2026-09-22: `GET /api/events?limit=25`
from a laptop did not return in 120 s. Nothing was stuck — the stream answers `200` and stays
open for as long as the client does, and it took no parameters, so `limit` was ignored. The
stored events are `GET /api/eventlog?limit=25`. Since 2026-09-23 a request carrying any query
is refused `400 stream_not_list`, and one without `Accept: text/event-stream` (every
`EventSource` sends it; `curl` sends `*/*`) is refused `406 stream_not_list`, both naming
`/api/eventlog`. Proved in `apps/daemon/test/api-scopes.test.ts`, which also holds a real socket
open to show the stream still streams.

## Observers

`GET /api/observers` lists every mechanism in the daemon that watches or waits for something — as
written on 2026-09-23, `index.ts` registers the resolver watch and follower, the drift check, the
rule-set age reader, the tunnel watchdog, the address watch, the radio-role follower and the session
sweep; `main()` cannot be reached by a test, so the device's own answer is the authority — each with when it last looked
and what it saw, when it last acted and what it did, and a `state` of `ok`, `stale` (has not
looked within one and a half times its own cadence) or `not-running` (a watch that did not arm,
a loop never started or stopped) or `failing` (running and looking, and what it watches is failing —
the tunnel watchdog with a guard on `block`), with the reason as `problem`. `problems` counts the ones not
`ok`. Ages are from the daemon's monotonic clock; `at` is for reading. The Status screen draws it
under *What this device is watching*. The confirmation-window watcher is not in the list yet.

Since 2026-09-24 (plan row G30) the tunnel watchdog is `failing` when any destination tunnel **reads
dead**, whether or not anything was done about it — and under `onUnavailable: block` nothing is. Its
`lastLooked.items` carry one entry per destination tunnel: `state` (`alive`, `DEAD n round(s)`, `not
measurable`, or `BLOCKED` if a selector is on `block`), `method` (`peer keepalive`, `gateway echo`,
`traffic through it`, `neutral endpoints`, `not measured`), `note` (the reading, up to 400 characters),
`action` (what the watchdog did, including nothing and why) and `tone` (`ok`, `warn`, `bad`). See
`docs/04`, *The guard asks the tunnel, and blocks nothing*.

The reason it exists: a mechanism that is silent while idle cannot be told apart from a dead
one, and the resolver follower was exactly that for ten hours on 2026-09-22.

Two corrections from the first on-device check, 2026-09-23. The tunnel watchdog's reading named only
the failover group, which on the bench board is empty — every tunnel is `resource` + `block` — so it
said "0 of 0 tunnel(s) healthy" while a guard it probes had blocked `partner`; it now names every guard
and its standing, and a blocked guard is `failing`. And the resolver watch could not notice losing
its directory: renaming or deleting a watched directory delivers `rename`/`change` and never `error`
(measured on the board's own node), so the watch followed the old inode while reading `ok`. The path
is now stat'ed after every event and every 30 s, and a missing or different inode is `not-running`
until the watch is re-armed on the directory at the path.

Three more from the second on-device check, the same day. The resolver watch recorded a look only
when a capture changed — `lastLooked` was null for eighteen minutes after start-up — because its 30 s
inode check had no way to say what it saw; every check is now a look, and the observer has that
cadence, so one that stops looking goes stale. The watchdog's one-string reading was cut at 300
characters and hid the fourth guard; a reading now carries `items`, one per subject, never truncated as
a list, and the summary names every guard by id and standing only. And a probe to an unreachable
address made the watchdog read `stale` for 51 s against a 30 s interval: a look is now recorded when a
round **starts** as well as when it ends, so the longest gap is the longer of one interval and one
round — a round that never ends still goes stale.

`GET /api/drift` serves the newest stored report **from any process** — the daemon's, or the one the
timer's `way revert` wrote — with `checkedAt` (boot id and seconds since boot, the clock every process
on the device shares) and `ageSeconds` computed from it; `null` age for a report from an earlier boot.

### Two events this document used to promise, and why they are not listed

This block previously listed `event: tunnel { id, state, latencyMs, jitterMs, loss }`
and `event: transaction { id, state, secondsRemaining }`. Neither is emitted.
`TelemetryEvent` carries exactly the five names above, and a client written from the
old list would have waited for a tunnel event for ever without anything reporting an
error — the same silent shape as a field the response schema strips.

The `transaction` case is a plain omission and is tracked as one. The `tunnel` case is
worth more than that, because of *what* it promised: `latencyMs`, `jitterMs` and `loss`
are three measurements, and nothing on the device takes any of them per tunnel. They
were written from an intended design rather than from a reading, which is the failure
this repository records against itself most often.

They are not restored as a plan. When per-tunnel health reaches the API it will be
listed here with the fields that are actually measured and the measurement each one
comes from — and anything not measured will be absent rather than optimistic. See
"Tunnel health" below for what that presently blocks on.

## Where the panel listens, as a report rather than a log line

`GET /api/system` carries three fields beside `listen`:

```jsonc
"channels": [ { "interface": "end0", "class": "wired",
                "addresses": ["192.168.77.7"], "listening": false } ],
"refused":  [ { "interface": "wfvpnprt", "class": "wired", "reason": "misread as ether" } ],
"withheld": [ { "interface": "wfwan0", "class": "wirelessUplink",
                "reason": "the uplink recorded by the last apply" } ]
```

**Why they exist.** The bind policy computed `refused` and `withheld` and discarded them: the log saw
a refusal and nothing else could. A refusal is not a lucky save — it means the positive half offered
a tunnel, so something upstream is broken — and the only screen where that could have been seen was
structurally unable to mention it. A screen that is blank where a refusal belongs reports that there
were none.

**`listening` is not derivable from the list.** It comes from the addresses the daemon is answering
on, not from membership of the chosen set. Measured on the bench board, 2026-09-21: `end0` was in
the configuration and bound to nothing. "Named and silent" is a state a view must be able to draw,
and a list of chosen names draws it exactly like a working wire.

**The class is decided on the device.** Linux reports `ether` for a radio exactly as for a wire, so
the driver has to be asked — a client deciding classes would be a second source of truth about the
one question the classifier exists to answer once. `class` is the classifier's own vocabulary:
`loopback`, `wired`, `accessPoint`, `wirelessUplink`, `tunnel`, `unknown`.

**`reason` is a sentence, not a code.** It is the classifier's `why` verbatim, read by somebody whose
panel did not open. `kind=wireguard` tells them what happened; an enumeration tells them only that we
have a constant for it.

**Null is not empty.** All three are `null` before the policy has run. "Not decided yet" and "nothing
was refused" are different facts, and only one of them means nobody needs to look. Measured through
`app.inject` on a device that has never applied anything, 2026-09-21: the three keys are present and
`null`. Present matters as much as null — see below.

**A response schema is a serializer, so an undeclared key is dropped in silence.** The handler
returned these three fields before `SystemResponse` declared them, and they reached nobody: no error,
no warning, no log line. They are declared as of 2026-09-21, and what keeps them declared is
`apps/daemon/test/management-visibility.test.ts`, which reads them off the wire rather than from the
reporting function. Proved by mutation the same day: deleting the three keys from `SystemResponse`
turns those tests red with the cause named, and collapsing the handler's `?? null` to `?? []` turns
the first of them red on its own.

## Tunnel health

`GET /api/status` reports tunnels as of 2026-09-21, in a `tunnels` key. This section records
what the field means, what it deliberately does not mean, and what the record said before.

### What it carries

One entry per tunnel of the last recorded plan:

```jsonc
"tunnels": [
  { "id": "work", "service": "running", "restarts": 1, "since": "2026-09-21T11:59:00.000Z" },
  { "id": "home", "service": "unknown", "restarts": null, "since": null }
]
```

**`service` is an aggregate over the tunnel's units and says nothing about whether traffic
passes.** The field is named for what it reads. Nothing on this device measures a handshake, a
key negotiation or a byte through a tunnel. Measured on the bench board, 2026-09-21: one
tunnel's unit stayed `active` for an hour while never once completing key negotiation, and
another answered its own resource in half a second while the guard in front of it refused every
connection. Both read `running` here and both readings are correct — of the wrong question. A
tunnel's real condition, once something measures it, gets a field of its own.

### A tunnel is not one unit, so the combining rules are part of the contract

An OpenVPN tunnel has one unit; the same tunnel behind an obfuscation transport has a transport
as well; a VLESS tunnel has its client. Decided 2026-09-21, each against the obvious
alternative:

* **`service`** — any unit stopped → `stopped`; otherwise any unit unknown → `unknown`;
  otherwise `running`. An empty unit list → `unknown`. Stopped outranks unknown because a
  component known to be down is a stronger fact than one nobody could read, and reporting
  `unknown` for a tunnel with a dead transport hides the one thing worth acting on behind the
  one thing nobody can act on. "Every unit is active" over an empty list is vacuously true, which
  is why the empty case is written out rather than left to fall through.
* **`restarts`** — the **maximum** across the tunnel's units, never the sum. A reconnection
  restarts the transport and the tunnel together, so a sum counts every reconnection twice and
  crosses the warning threshold of three at two reconnections instead of three.
* **`since`** — the **most recent** active-enter among the units, derived from
  `ActiveEnterTimestampMonotonic` and the machine's uptime, never from the wall-clock
  `ActiveEnterTimestamp`. This board has no battery-backed clock, so a step of years the moment a
  time source appears is ordinary; after one, the wall-clock property is in the old frame while a
  client's `now` is in the new one, and the difference is a duration that never happened.
* **`null` for `restarts` and `since`** — `0` restarts means "systemd has restarted this unit no
  times", which is news; a unit nobody could read has no restart count, and reporting the
  reassuring number there is the failure this whole section is about.

**`tunnels` itself is `null` until the first reading, and `[]` only when the profile genuinely
has no tunnels.** Same distinction as the management channels above, for the same reason: a
client that draws nothing for an empty list draws the same nothing for a device nobody has
asked, and "no tunnels configured" is the reassuring one of the two. Measured through
`app.inject`, 2026-09-21: the key is present and `null` on a device whose tunnels have never
been read.

**`unknown` is an answer.** Not measured yet, no unit, a failed read and a tunnel that is
genuinely down are not the same fact. The interface classifier holds the same line for the same
reason: a confident wrong answer costs more than an admitted gap, because nobody investigates a
confident answer.

### Where the numbers come from, and why not from the units already being polled

`UnitState` — what the status view's `units` map carries — has neither a restart count nor a
start timestamp. `systemctl show` returns both in one call, so a tunnel reading is one spawn per
unit. It runs on the clock's reduced cadence rather than on every poll: four tunnels, two of them
behind a transport, is an ordinary configuration here and would be six process spawns per poll on
a 4×Cortex-A53. A change to the watched set reads immediately regardless, because the moment
somebody most wants to know what a tunnel is doing is just after they changed it.

**The unit names come from the plan, never from a naming rule applied twice.** The planner
records `{ id, units }` per tunnel on the desired state, the daemon stores it, and telemetry
reads what was recorded — exactly as the tunnel interface names on the management surfaces are
handled, and for exactly the same reason: the names are produced by per-protocol rules in
`core/catalogue/`, and a second copy of a convention agrees with the first until one of them
changes.

### What the record said before, and why it was not enough

This section previously stated that the endpoint does not report tunnels, and named the two
things it blocked on: a per-tunnel source on the live snapshot, and a key for it on
`StatusResponse`. That diagnosis was right and the pairing is the part worth keeping: **a source
without the schema key is serialized away in silence, and a schema key without a source is
serialized as absent in silence.** Either one alone reproduces the exact appearance of a device
with nothing to report. They landed in one change for that reason, and the tests that hold them
together read the wire through `app.inject` rather than the snapshot — `apps/daemon/test/tunnel-status.test.ts`.

Proved by mutation, 2026-09-21: deleting the `tunnels` key from `StatusResponse` turns the three
wire tests red; declaring its items as an object with no properties turns exactly the one red
that asserts the entries arrive with their fields, which the other two cannot see; initialising
the snapshot's `tunnels` to `[]` turns red the test that a device nobody has asked reports
`null`.

## Errors

```jsonc
{
  "error": {
    "code": "invariant_violation",
    "message": "Radio phy0 cannot host an access point and a client at the same time.",
    "pointer": "/accessPoints/0/bind",
    "detail": { "phy": "phy0", "combination": "#{ managed, AP } <= 1" },
    "hint": "Assign the access point to the USB radio, or use Ethernet for the uplink."
  }
}
```

**Every `404` under `/api/` carries a link to the documentation**, in `detail.documentation`
as an absolute URL and named again in `hint` when the route did not set one of its own. It is
added by one hook on the way out rather than at each place that answers 404: there are five
such places today and the next one will be written by somebody who has not read this
paragraph. A rule applied at the seam every response already passes through cannot be
forgotten by a route that does not know it exists.

`pointer` is a JSON Pointer into the profile document, which lets the interface put
the message on the right field without pattern-matching on text. `hint` is
deliberately part of the contract: for a device where a wrong configuration can cost
access, an error that does not say what to do instead is only half an error.

## The proxy core's own API

The core exposes a Clash-compatible control API with its own token, bound to loopback.

**There is no `/api/clash/*` proxy in this build, and this section said there was.** Corrected
2026-09-21, when the route table was compared against this document for the first time: the proxy
went with the generic path in E4 and the prose did not follow it. The design it described — one port
and one password rather than two management surfaces with separate keys — is still the reason there
is no *second* listener, so it is kept here as the argument rather than deleted as a mistake; what
was wrong is the tense.

The consequence the proxy would have had is stated anyway, because it is what decided against
reinstating it: when our daemon is down, a dashboard reachable only through it is unreachable too.
That is precisely the case somebody wants it in. So the escape hatch is local and does not require
the daemon at all:

```sh
way debug expose-core-api        # says how to reach it; does not expose it
```

**It does not bind the API to anything**, and the name is kept only because the plan and this document
already used it. An earlier draft of this section said "binds it to the LAN until the next restart",
and that was the wrong design: the core's control API has no authentication of its own and full control
over routing, so putting it on a routable address hands anyone on that network the ability to redirect
every client's traffic — in exchange for the operator not typing an SSH flag. It would also outlive the
debugging session that seemed to justify it.

What the command does instead is print the bind address, confirm the core is actually running, and give
the `ssh -L` line that reaches a loopback-bound port from the operator's own machine. The case it exists
for — a healthy core behind an unhealthy daemon — is served exactly as well, and nothing is left open
afterwards.

## Versioning

`/api/*` is unversioned while the project is pre-1.0; the OpenAPI document is the
reference and it is generated. `GET /api/docs` renders that same document for a person and
`GET /api/openapi.json` serves it for a tool — one producer, two presentations, so the two
cannot disagree. Both carry `x-wayfarer-access`, the scope each route's guard requires,
read back out of the live route table because it lives in the handler and no schema can
express it. The page is rendered on the device and fetches nothing: an operator reading it
is often on a network with no route out, which is frequently this device's whole purpose.

**`GET /api/docs` needs no credential; `GET /api/openapi.json` needs the `read` scope.** That
asymmetry is a decision, taken 2026-09-21 and asserted by a test so it cannot drift. The page is
what every 401 and 404 hands the caller, and the caller who has mistyped a path and has not logged
in is the one who most needs it — a documentation link that answers 401 is a wall with a signpost on
it. What it exposes is shapes and never data: paths, parameter names, schemas and the scope each
route requires, none of which is absent from this repository, which is published. Nothing links to
the machine document from a refusal and its reader is a client that is already integrating, so it
was left alone; if the split ever needs resolving, the resolution is to open the machine document
rather than to close the page. After 1.0, additive changes stay in place and
breaking ones move to `/api/v2`. The profile document carries its own
`schemaVersion` independently, because documents outlive API versions — an export
taken today should still import in a year.

## Two HTTP idioms, kept separate on purpose

The routes in this API use Fastify's schema-driven style — a declared body and response schema, compiled
validators, and a typed handler. The peer fan-out uses the runtime's `fetch`, by hand, with an
`AbortController`.

They look like something that wants unifying. It was considered and **declined**, and this is the decision
rather than an oversight a reader should file a finding about.

They are doing genuinely different jobs on opposite sides of a trust boundary. An inbound route validates a
body **we** defined against a schema **we** own, and rejects what does not match. An outbound request to a
peer talks to a device that may be running a different version of this software, so its answer is read field
by field and nothing is assumed about its shape — the opposite discipline. A shared helper would have to
straddle that boundary, which is the one place in this codebase where a shared abstraction would make the
weaker guarantee look like the stronger one.

The cost of leaving them apart is two idioms to learn. The cost of joining them is a validated-looking path
to data nobody validated. The second is worse.
