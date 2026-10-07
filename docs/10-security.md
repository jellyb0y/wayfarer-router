# 10. Security

## Trust boundary

The trust boundary is **the password, not the network.** Whoever can reach the management
port can try to sign in; nothing about network position grants access.

The surfaces the panel and API answer on are:

| surface | always? |
|---|---|
| loopback | yes |
| the **wire** (the wired port) | yes, and without waiting for a profile |
| the **access point** this device hosts | yes |
| the network this device is a **client of** (its uplink) | **yes by default**, and a profile setting turns it off |
| an interface the classifier **could not decide** | never, and it is reported as undecided rather than as a tunnel |
| a **tunnel** interface | never, and there is no setting |
| the proxy core's own dashboard | loopback only, never anywhere else |

The wire's row is listed first among the physical surfaces because it is the one this
table used to leave out, while the prose below it named the wire as a requirement. The
omission was not cosmetic: the wire is the interface no plan touches, so it is the one
every record, every fixture and — as it turned out — every summary forgets.

### Correction: the earlier position was narrower than intended, not wrong

An earlier revision of this document said *"the interface is **never** reachable from the
uplink"* and treated that as a safety invariant. It is worth being precise about what
happened, because "this was a mistake" teaches the wrong lesson here.

It was not a mistake. It was **a narrower reading of a requirement than the one the owner
actually had.** The reasoning behind it was sound as far as it went — an uplink can be a
hotel's wireless, and publishing a management surface there exposes it to everyone in the
building — but it applied that caution unconditionally, to the home network as well as the
hotel, and so removed a capability the owner wanted: reaching the panel from a laptop on
their own network without a forwarded port.

**The switch is what lets both readings be true.** The default is the owner's requirement;
the setting is the caution, available for the situation that motivated it. Neither reading
had to lose.

What has *not* changed, and is not a policy question:

* **A tunnel is never a management surface.** Whatever is at the far end of a tunnel is not
  somebody this device should accept management traffic from, and no configuration makes
  that a good idea.
* **The proxy core's own dashboard stays on loopback.** It has no authentication of its own
  and full control over routing, so it is reached only through our authentication at
  `/api/clash/*`, or over an SSH forward.

### What stands behind the default, given the network may be untrusted

Not an assumption that it is safe. These do:

* **A password is always required**, on every surface including the access point. "It is
  only my own Wi-Fi" is a tempting argument and a bad one: a travel router's access point
  is exactly the network where a guest device, a compromised phone, or somebody who once
  had the passphrase ends up. Full control over routing is not something to hand to network
  position.
* **A lockout counted in uptime, not wall-clock time** — ten failures from one address
  inside fifteen minutes, and a clock step cannot clear it. See the trade below.
* **The machine API is off until a human turns it on** — `way machine-api on`, on the device,
  as root — and then needs a token created in the interface, scoped, and revocable immediately.
  A valid token presented while it is off is refused `403 machine_access_off`, naming that
  command; it used to be told to "log in first" (`docs/13-plan.md` row F8). Nothing turned the
  switch on before 2026-09-23 but an `UPDATE` typed into the database by hand.
* **Secrets are never returned by any read**, so a session that does get in cannot harvest
  credentials it did not already have.

### What turning the uplink surface off costs

The panel then answers only on the access point and on the device itself. Reaching it from
the network the device is connected to requires `ssh -L`. That is the right choice when the
owner does not know who else is on that network, and the interface says so in those words
rather than with a warning symbol — see [08-ui.md](08-ui.md).

Two layers enforce the choice, from one source: the **bind address**, which is what makes
the socket exist, and an **input rule** in the generated firewall, which survives a profile
change that alters which interface is which. Both are derived from the same resolved
interface list, because a rule enforced at one door and not the other is a defect this
project has already paid for once.

## Enforcement

| Control | Where |
|---|---|
| Listener binds only to loopback and local channels | Daemon configuration, plus a policy over what the **kernel** reports each interface to be |
| Firewall rejects the management port arriving on the uplink | Generated ruleset |
| Firewall accepts the management port from LAN, even with the kill-switch on | Generated ruleset |
| Proxy core's own API bound to loopback only | Generated core configuration |

That first row used to read "derived from the active profile", and the wording was the
defect rather than a description of it. A profile records the surfaces it resolved —
its access point, its uplinks, its tunnels — and it records nothing about the wire,
because no plan touches the wire. A bind set derived from the profile alone therefore
could not contain `end0` under any configuration, which is precisely how the wire went
unbound for months while both halves of the requirement looked satisfied. The set is
now decided from the kernel's own report of every interface, with the profile as a
second source and never the only one.

The listener and the firewall enforce the same rule twice on purpose. A profile
change can alter which interface is which, and a bug in role resolution should not
become an exposed management port.

Binding the core's API to loopback is a change from the common default of exposing it
on all interfaces. Its own token is separate from ours, and a second control API on a
routable address with its own key is a large amount of power in the open. It is
reachable through `/api/clash/*` under our authentication instead.

The trade is that when our daemon is down, that dashboard is down with it. For the
case where the core is healthy and the daemon is not, a local command re-exposes it
until the next restart — deliberately local-only, so it cannot be triggered by
anything reaching the network.

## Authentication details

Session cookies: `HttpOnly`, `SameSite=Lax`, `Secure` when TLS is in use. Session
records live in the database, so revocation is immediate and does not depend on
expiry — which matters on a device whose clock can be days wrong after being switched
off.

Passwords: `scrypt`, per-user salt, parameters recorded with the hash so they can be
raised later without invalidating existing hashes.

Tokens: 32 random bytes, presented once, stored as SHA-256 only. Scoped
(`read` / `apply` / `admin`), optional expiry, last-used timestamp recorded so stale
tokens are visible.

Rate limiting on login, per source address, with lockout after repeated failures.
Failures are events.

## Expiry on a device whose clock cannot be trusted

This board has no clock battery, so its wall clock can be days wrong after being switched
off. Worse, the apply that opens a confirmation window **deliberately restarts the time
service** — so a wall-clock step of days *inside that window* is the designed path, not bad
luck. Every rule below follows from that, and the earlier versions of all three were wrong
in the direction of locking the operator out.

### The rule that overrides the others

**A session or token is never expired while a transaction it opened is awaiting
confirmation.**

The single moment an operator must not lose their credentials is while a timer is counting
down on a change only they can confirm. Losing the credential there means the change
reverts for want of a click nobody could make — and the operator, who has very likely just
lost their connection to the device, gets the failure mode the window exists to prevent.

The exemption is narrow on purpose: only while a transaction is *awaiting confirmation*,
and only for the session or token that **opened that transaction**. Either relaxation would
be a way to keep a credential alive indefinitely — "any window is open" lets a forgotten
window do it, "any credential" lets a leaked one ride along.

### Sessions have no absolute expiry, and that was decided rather than overlooked

There is no wall-clock deadline on a session. The reasons, in order of weight:

* **It was unenforceable.** A wall-clock instant on a board with no clock battery cannot be judged against a
  clock that can be days out — and the one place still enforcing it was doing so *incorrectly*, retiring
  sessions in continuous use because `expires_at` is set at creation and never moved.
* **Nothing authorised from it.** Once sessions became idle-based, the absolute expiry was read only by the
  sweep. An unread stored value that looks like a control is a control nobody is maintaining.
* **The control that replaces it is strictly better.** A **password change revokes every session**,
  immediately, with no clock involved. That is what bounds a session's life now, and it is the right bound:
  a credential change should end everything issued under the old credential.

`expires_at` is still written and still shown, because a row saying when a session was created and what life
it was given is worth having in an incident. It is **descriptive**, and a test greps the authorisation
sources to prove nothing judges by it — because the way this went wrong the first time was an unread value
that looked like a rule.

The sweep that removes idle rows now calls **the same function the request path calls**, with the same boot
anchor and the same open-window exemption. One rule, both doors. See
[16](16-implementation-notes.md#a-third-remedy-an-invariant-enforced-at-one-door-and-not-at-the-other) for
why that mattered: the previous sweep could delete the session holding an open confirmation window, which is
precisely what the exemption exists to prevent, and the trigger was the designed path rather than bad luck.

### Sessions: a duration since last use

Not a lifetime from creation. An operator who has been working on this device for a week
has not become less authorised; one who signed in and walked away has. The duration is
anchored to **boot identity plus uptime**, which is durable across a daemon restart and
immune to any wall-clock step. A session whose anchor is from another boot has an unknown
age and is re-stamped on use rather than retired.

Revocation is unchanged and is still the strongest control here: a row deletion, immediate,
and dependent on no clock at all.

### Tokens: an absolute expiry, enforced only against a trustworthy clock

A token's expiry is an instant the operator chose — "stop working after the end of the
month" — and cannot be turned into an idle duration without changing what they asked for.
So it must be judged against the wall clock, which means it can only be *enforced* when the
wall clock is worth judging against. When the clock is unsynchronised, or its state cannot
be read, the token is reported as **unverifiable** rather than expired: it keeps working,
and an `auth.expiry-unverifiable` event records that its expiry was not checked.

### Two "cannot tell" answers that point in opposite directions

This looks inconsistent until the cost of each mistake is named, so it is named here.

| question | when it cannot be answered | why |
|---|---|---|
| is this certificate valid? | treat as **untrusted** | A certificate wrongly trusted exposes the operator's traffic to a stranger. |
| has this credential expired? | treat as **usable**, and log it | A credential wrongly expired locks the owner out of their own device. |

The principle is not "always fail closed". It is **fail towards the smaller loss**, and
which direction that is depends on what is on the other side of the mistake.

### The lockout trade: a reboot clears an in-progress lockout

Login attempts are counted by boot identity and uptime, like everything else here. Attempts
from an earlier boot have an unknown age and take no part in the decision — which means a
reboot clears a lockout in progress.

That is deliberate. **Nobody can reboot this device without already holding the access a
lockout is protecting**, the management surface is the device's own access point rather than
the open internet, and the alternative — treating undatable attempts as recent — locks a
legitimate operator out of a device they may be holding in a hotel room with no other way
in. Losing management of this device is a worse outcome than a slower brute force.

History is pruned **by count and insertion order, never by time**. The previous version
deleted rows older than a cutoff computed from the current clock, which made a forward step
erase the evidence a lockout was based on — a way to clear a lockout by moving a clock — and
a backward step leave future-dated rows that satisfied every later cutoff and locked out a
legitimate operator.

## TLS

Off by default, and the reason is honest rather than comfortable: on a LAN with no
name and no public certificate authority, the options are a self-signed certificate
that trains people to click through browser warnings, or a private authority nobody
will install. Both are worse than plain HTTP inside the trust boundary already
established by the Wi-Fi passphrase.

What is provided instead: a place to install a certificate and key for anyone who has
one, and a documented statement of the exposure — session cookies and the password
travel in the clear over the local Wi-Fi link, which is itself encrypted by WPA2 or
WPA3 between the client and the access point.

Decided: no TLS by default. Revisit when there is a second user, not before.

## Secrets at rest

Profiles contain VLESS UUIDs, OpenVPN private keys, obfuscation pre-shared keys and
Wi-Fi passphrases. The honest description of what protects them:

**File permissions and process isolation.** The database is `0600`, owned by root,
under a directory the sandbox restricts. Generated configuration files carry the
permissions their consumers require and no more.

**Not encryption at rest.** A key that must be available to an unattended daemon at
boot has to live on the same card as the data. Encrypting with it protects against
nothing except a lost card that was also powered off — and for that, full-disk
encryption is the right tool and it is not this project's job. Claiming otherwise
would be theatre, and theatre in a security document is worse than an admission.

What *is* done, and is real:

* Secrets never appear in `GET` responses — only whether a value is set.
* Secrets never appear in logs. The redactor works **structurally** on the storage
  wrapper: anything shaped `{ "$secret": … }` is replaced, whatever it is called,
  wherever it came from, and whether or not any schema describes it. That is the one
  behaviour of the four that is safe by construction, and it is deliberately not
  routed through any schema lookup — a redactor that had to look a field up would fail
  open on exactly the unexpected document most likely to reach a log during an
  incident.
* Secrets are excluded from exports by default. A full export requires the `admin`
  scope and is recorded as an event.
* Secrets are excluded from diffs shown in the interface; a changed secret shows as
  "changed", not as its value.

### Finding the secrets in a schema nobody annotated

`x-secret` works because we write the schemas we control. A proxy core's schema is not
one of those: measured on the bench board, `sing-box schema` is 444 895 bytes across 93
definitions and contains **zero** `x-secret` annotations. A tunnel's configuration is
opaque to our own schema by design, so without something else a VLESS `uuid`, a Trojan
`password` and a WireGuard `private_key` would be stored unwrapped, returned by `GET`,
written into a shareable export, and printed in a log line.

The metadata overlay can mark a field secret, and it does — but the overlay is optional
per field, deliberately, so a protocol released this morning still renders. "A field
with no overlay entry still renders" is correct; "a field with no overlay entry is not
a secret" is the same rule pointed at a much worse outcome, and it fails silently in
the leaking direction.

So the annotation is **stamped onto the foreign schema from two sources, unioned**:
curated overlay entries, and a name rule applied to every string-bearing field.

**The asymmetry is the design.** Over-redaction is a nuisance: a field unluckily named
like a secret becomes write-only, and somebody re-enters a value that never needed
protecting. Under-redaction is a leak nobody notices until the document is in a chat
log. The rule therefore fails towards redaction, and that cost is stated here rather
than discovered.

Three properties of the rule, each of which exists because the obvious version was
wrong:

* **Whole path segments, never substrings.** `domain_keyword` contains `key`, and it is
  a field whose entire purpose is to be read and edited. The matcher compares the final
  segment exactly, case-insensitively, plus a short list of explicit suffixes, and
  there is a test naming `domain_keyword` so nobody simplifies it back.
* **A short list of published values is excluded** — `public_key`, `host_key` — by exact
  segment only, never by suffix pattern. This is part of the rule, not an escape from
  it: the invariant that matters is that nothing *outside the source* can unmark a
  secret, and a fixed list reviewed in the same diff as everything else does not
  weaken it. WireGuard forced the question: redacting a peer's public key puts a value
  on the import checklist that the importer cannot look up, because it belongs to the
  other end — and a checklist naming things that are not missing is one people skim,
  which hides the single entry that really is.
* **The coverage is a checked-in artefact.** A test walks the whole real schema and
  writes out every field the rule marks, so adding a word is a visible diff somebody
  approves, and a core release that renames a field shows up as a change in coverage
  rather than as silence. That file found three real leaks within minutes of existing;
  they are in [16-implementation-notes.md](16-implementation-notes.md).

### One chokepoint, because remembering is not a control

The store cannot be constructed without a `SecretPlan`, the plan is the only thing that can produce
matchers, and every write and every read goes through it. That shape is deliberate and it is the
correction of a real leak: the matchers used to be reduced once from the static profile schema, which
covered nothing inside a tunnel's opaque configuration, and no amount of remembering to call
something extra would have fixed it — the value itself was wrong.

The plan takes the **document**, not nothing, because the answer depends on it: which pointers exist
under `/tunnels/2/config` depends on tunnel 2's provider and protocol. Two tunnels of different
protocols in one profile have different secret positions, so a matcher covering "any tunnel" would
mark fields that exist in only one of them.

**Writes fail closed.** When no provider schema is available — no core installed, or one whose schema
will not parse — opaque configurations cannot be covered, and a profile containing tunnels is refused
rather than stored. Storing a credential in clear because a binary is missing is a leak caused by an
unrelated fault, and the unrelated fault is the one that gets fixed while the leak stays.

### What a generated artefact does, and does not, get

Everything above protects the *profile document*. The generated configuration on disk
necessarily contains the real values in clear — hostapd cannot be handed a redaction
marker — so two rules are structural rather than remembered:

* **A generated artefact is never logged, never returned by an API route, and never put
  in an error message.** A generator that throws must not carry the document it was
  building.
* **Every human-facing surface renders the profile document**, where secrets are still
  wrapped — never the resolved output. A plan review that printed the generated
  configuration would defeat redaction completely while looking like a safety feature.
  Plan review therefore shows paths, purposes and the classified diff, and there is a
  test asserting no secret reaches it.

**The invariant is "nothing that can carry a resolved secret", not "no contents".** That
distinction is worth stating precisely, because the shorter version is the one somebody
will remember and it forbids things it should not.

The routing editor shows a **preview of the rules the profile produces** — what each
entry matches and where it sends traffic — and that is correct. A routing rule is a
domain, a suffix, a subnet and a target; there is nothing secret in one, and the warning
about moving an anchor below a tunnel rule is much harder to trust when nobody can see
what the order produces. A core configuration holds real credentials and cannot be
shown at all.

Two rules keep that from eroding:

* The preview is rendered **from the profile document**, through the same generator the
  planner uses, and never by reading back a generated file. One implementation, so the
  preview cannot drift from what is emitted — a preview that disagrees with reality is
  worse than none, because somebody would believe it.
* Anything derived from the *resolved* output stays out of the interface, whatever it
  contains. The test is where the value came from, not whether this particular field
  happens to look sensitive.

A full export adds one more check, and it is a human: because the name rule cannot be
complete for a protocol nobody has annotated, an export with secrets included **lists
the opaque-configuration fields that will leave in clear** before the file is produced.
Under-redaction then becomes visible at the moment it matters.

Reading a secret back into the interface is **not** provided. `$keep` means an edit
never needs the value, so nothing is lost; what is not available is seeing a field you
pasted. That is a real cost and it is smaller than a paste-shaped path around
redaction, and whether to add a reveal mechanism is a decision to make deliberately
rather than as a footnote to this one.

## Privileges

One root daemon with a hardened systemd sandbox, rather than a privileged helper.
The reasoning is in [05-platform-layer.md](05-platform-layer.md): the required
capability set is effectively all of network root, so splitting it adds an IPC
boundary without reducing what a successful attacker gains.

The sandbox is where the real reduction is: `NoNewPrivileges`, an explicit capability
bounding set, `ProtectSystem=strict` with a narrow list of writable paths, restricted
address families, a system call filter, and a watchdog.

**The writable list must shrink when the code stops needing a path**, and that is easy
to forget because nothing fails when it does not. Three paths were removed once all
generated configuration moved under `/etc/wayfarer`: `/etc/hostapd`, `/etc/dnsmasq.d`
and `/etc/nftables.conf`. Nothing writes to them any more, and on the bench board two
of the three hold the live configuration of a system this project must not touch — a
write capability nothing uses is one that can only ever be exercised by mistake. `MemoryDenyWriteExecute`
cannot be used because the JavaScript engine needs writable-executable pages, and
that limitation should be stated in the unit file rather than silently omitted.

## What the API can do, and what it deliberately cannot

The API can reconfigure the network, which means a token with `apply` is powerful.
Accepted, because that is the point. Three things it cannot do, chosen to limit the
damage:

* **It cannot fetch or run executable code.** Cores are installed by the installer.
  A compromised token cannot make the device download a binary.
* **It cannot disable the revert watchdog.** There is no parameter for "apply without
  confirmation". A token that breaks the network gets three minutes and then the
  device comes back.
* **It cannot read secrets** without the `admin` scope, and doing so is logged.

## Threats considered, and the response

| Threat | Response |
|---|---|
| Someone on the access point reaching the interface | Password, rate limiting, lockout |
| Someone on the uplink reaching the interface | Not bound there; firewall rejects |
| A leaked token | Scopes, revocation, last-used visibility, no code execution |
| A shared profile leaking secrets | Redacted by default; full export gated and logged |
| A misconfiguration locking out the operator | Three-minute transaction with revert outside the daemon, plus revert on start |
| A card lost while powered off | Out of scope; use full-disk encryption |
| A malicious profile document | Schema validation, invariant checks, foreign validators, and no code path that executes anything from the document |
| Traffic sniffed on the LAN | Acknowledged; WPA2/WPA3 covers the radio link, TLS is available for anyone who wants it |

## Supply chain

Few dependencies, and none of them native. Lockfile committed, versions pinned,
`npm audit` in continuous integration, and a deliberate bias towards the runtime's
own facilities — its SQLite driver, its crypto, its test runner — over a package.
Every dependency on this list is one that has to be trusted on a device with
privileged network access.

## Blocking a service by address: declared, never discovered

Assigning a service to a tunnel with refusal on gives a guarantee **for names that are visible on the
wire**, and nothing more. Measured on the bench board, 2026-09-21, with a deliberately dead tunnel and a
forwarded client: a rule naming `example.com` served the request `HTTP/1.1 200 OK` three times out of three
until a `sniff` action was added, because a client resolves a name and then connects to an **address** — the
core saw the address and the name rule matched nothing. With sniffing the same request is refused three
times out of three.

Sniffing reads a TLS `server_name` or an HTTP `Host`. So four things remain outside any name rule:

* a connection to a **literal address**, which carries no name to read;
* **encrypted client hello**, which hides the name and is becoming the default;
* any protocol carrying neither SNI nor `Host`;
* a name nobody put on the list — a CDN host, an API subdomain, a regional endpoint.

The obvious second layer is a stateless block by address, and it is worth building. **It must be declared
by the operator, not discovered by the device**, and discovered addresses may be *offered* as a reviewable
suggestion but never applied on their own.

The reason is the one this whole project is organised around. A blocked address produces a failure with no
explanation attached to it: the request does not arrive, and nothing in the symptom says which rule stopped
it or why that rule exists. If the device wrote those rules itself from DNS answers, then the day a service
moves to a new network the device blocks something legitimate — and the operator is debugging a failure
whose cause is a decision nobody made, recorded nowhere they would look, based on an observation that has
since expired. **That converts a visible failure into an invisible one**, which is the exact trade this
repository refuses everywhere else: a check that describes a truth instead of deriving it will eventually
describe a truth that has changed, and keep enforcing it.

A declared range is different in the way that matters: it is wrong in a way somebody chose, it appears in
the diff before it is applied, and it can be read back and understood a month later. When it blocks
something legitimate, the operator can see why.

The asymmetry that makes offering suggestions acceptable is that a suggestion is inert until confirmed. The
device may say *these addresses answered for that name* — which is a measurement, and a useful one — as long
as it never turns that measurement into enforcement on its own.

**What must be on the screen, not only here:** an operator who assigns a service to a tunnel and sets
refusal believes they have bought a guarantee. What they have bought is a guarantee for names visible on the
wire, and that guarantee **erodes over time without anything changing on the device**, as more traffic hides
its names. Telling them that where they make the choice is the difference between a limitation and a
surprise.

## The default password is short, by decision (2026-09-21)

The shipped default becomes `adminpass`, and there is **no forced change** on first sign-in.
Recorded here rather than argued, because it is the owner's call and it is already taken —
but recorded, because the exposure is real and should not have to be rediscovered.

What it means concretely: the panel answers on the device's own access point **and** on
whatever local network the device is plugged into, so until the owner changes it, anyone who
can reach either network and has read any documentation can sign in. The trust boundary in
this document is the password, not the network; a password everybody knows moves that boundary
to nothing.

Two properties that were kept, and that carry more weight now than they did:

* The change-password screen is reachable from the interface, so changing it costs one screen
  rather than a file on the card.
* Nothing else about the login weakens: sessions, scrypt storage and the rate limit are
  unchanged. The short default is a default, not a mode.

If this is revisited, the cheapest improvement that does not cost the first-run experience is
to require a change **before the panel answers on anything other than its own access point** —
considered and not taken, because it makes the panel behave differently on different
interfaces, which is one more rule to remember and explain.

### The default and the minimum disagree, deliberately, and the valve runs one way

`adminpass` is nine characters. `ChangePasswordRequest` requires a new password of at least twelve.
The two do not agree, and that is the design rather than an oversight nobody noticed.

The consequence is the useful half: **leaving the default is one screen; returning to it is
impossible.** A device cannot be put back on a published credential by an operator experimenting,
by a script restoring a value it read from a document, or by someone who half-remembers what it
shipped with. The one direction that matters is the one that is free, and the direction that would
undo the decision is closed by the schema before the handler is reached.

Stated here because the pair is easy to read as a defect. A reviewer meeting a default that fails
its own validator will reasonably suspect one of the two numbers is wrong. Neither is: the default
is what the installer prints, the minimum is what an operator may choose, and a default is not a
choice.

### Where the management surface listens: the negative half is now enforced, not inherited

The requirement, in the owner's words: listen on the wire, on this device's own access point, on the
Wi-Fi network this device is a client of, and on loopback — and **on no tunnel interface at all**.

Both halves are obligations. The negative one is a prohibition rather than a preference, because
tunnel interfaces reach networks that never asked to have a management panel offered to them; on the
bench board four are up, two of them corporate. With a short published default password that is not
a theoretical exposure.

**What was measured, 2026-09-21.** `ss -tln` on port 8088 reported three sockets — loopback,
`10.44.0.1` (the access point) and `192.168.77.8` (`wfwan0`, the wireless uplink) — and nothing on
`192.168.77.7`, which is `end0`, the wire. Two addresses in one subnet with opposite answers, which
is also why the evidence for this is a socket list **per interface** and never "the page opened".

**Why the wire was missing, and why nobody saw it.** The bind set was built from what the last apply
had *recorded*: the access point plus the uplinks a profile names. No plan touches the wire — it is
the lifeline every plan is written to leave alone — so it could not appear in that record under any
configuration. A previous fix verified the behaviour against the interfaces that were in the list,
which is the shape of the mistake rather than a lapse in care: the check was proved where it was
looking.

**Why widening the positive half broke the negative one.** No tunnel was ever bound, but nothing
refused one. The positive half simply never named a tunnel, and the guarantee was a side effect of a
list that happened to be short. A guarantee that holds because control never reaches it stops being
a guarantee the moment the list gets longer — and lengthening that list is exactly what fixing the
wire does. So the refusal is now a separate, final step over the names already chosen, it consults
tunnel names from every source that knows one (including tunnels this device did not create, such as
the bench board's `tun0`), and it **records an event when it has anything to remove**. Reaching it
means something upstream called a tunnel a local channel, which is a defect to hear about rather
than one to repair in silence.

`unknown` is a third answer and not a synonym for "tunnel": an interface the classifier could not
decide is never bound, and is reported differently from one known to be a tunnel, because "we could
not tell" and "we know" call for different actions.
