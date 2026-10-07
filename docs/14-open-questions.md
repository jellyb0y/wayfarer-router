# 14. Open questions

Almost nothing is left. Kept as a file because a recorded question is cheaper than
a rediscovered one.

## Deferred deliberately

**Ask mode (connection quarantine).** Holding a new connection for a few seconds
and asking where to route it. Not being built now; the idea is kept. Everything
else in the design is the foundation it would need, so adding it later is additive
rather than a rewrite: a quarantine outbound, a decision queue, and incremental
rule-set updates.

**Several networks, guest networks, per-client routing.** One subnet, no
separation. The data model carries a single network and a single access point
rather than lists, because a list of one with no interface behind it is dead
weight, and one-to-many is a schema migration and those are cheap here.

**Full IPv6.** Blocked at the access point entirely. The profile field exists with
one value today; adding `direct` and `tunnelled` later touches routing, DNS, the
firewall and the interface at once, which is exactly why it is not being done
speculatively.

**Simulated radios for automated hardware tests.** Integration tests are run by
hand on the bench board. The planner and every invariant are covered by fixtures,
which is where the logic actually lives.

## Genuinely undecided

**Where the metadata overlay for protocol fields comes from.** The schema emitted
by the core has no descriptions at all, so labels are ours. Two community-maintained
schemas carry descriptions extracted from documentation and could seed the overlay
instead of writing it by hand. Whether importing from them is worth the dependency,
and how to keep it current, is unresolved. It does not block anything: a field with
no overlay entry still renders.

**Whether to publish.** MIT is chosen, so the option is open. Publishing brings
issues, questions and other people's hardware — which is the fastest way to find
out where the capability detection is wrong, and also work. No decision needed until
there is something worth publishing.

## The boot path has no guard, and it is a design problem rather than a bug

**Not implemented, and not to be implemented without a decision.** Recorded here because it is the one
gap in the recovery design that the three mechanisms built for it do not cover, and the reason is
structural rather than accidental.

The daemon is enabled, starts at boot, and reconciles to the stored active profile. None of that is
conditional on the device being on a network it has seen before. So a profile that was correct where it
was confirmed can be wrong where the device now is, and nothing notices:

| mechanism | what it answers | why it does not cover a boot |
|---|---|---|
| the transaction with the previous document | did **this change** work? | a boot is not a change |
| the transient revert unit | is this change confirmed? | nothing arms one at boot |
| the start-up sweep | was a transaction left inside its window? | a device that booted cleanly has none |

All three answer *"did this change work?"*. **None answers "is this configuration still appropriate to
where the device now is?"**

### Why this is not the daemon's problem to solve at start-up

Established on the board rather than assumed, when the device became unreachable after a reboot. Two
plausible accounts were refuted:

* **Not the daemon reconciling at boot.** `index.ts` calls `sweepUnconfirmed` at start-up and nothing
  else. There is no apply-at-boot; a boot does not re-assert the stored profile.
* **Not the stored profile being the lockout document.** It had already been repaired.

The actual mechanism: the **data-plane units are enabled and independent of the daemon by design**. At
boot `wf-core.service` started and installed its route capture. Its configuration excluded
`10.44.0.0/24`, `192.168.1.0/24` and `172.19.0.0/30` — read off the disk on the board — and
`192.168.1.0/24` **is the network the device used to be on**. The board held a correct DHCP address and
answered nothing.

The exclusion code is not at fault and was not changed. The defect is that the value is a **snapshot of
where the device was when the plan was made**. And the conclusion that relocates any fix: **it cannot
live in the daemon's start-up path, because the thing that takes the network is not the daemon.**

### Three candidate guards, and what each costs

1. **Do not reconcile a profile that has never been confirmed.** Narrow and cheap, and it would have
   prevented the original lockout. Useless for the case above, because that profile *was* confirmed — on
   a network that no longer exists.
2. **Treat "no management path reachable after N seconds" as a reason to fall back.** The more dangerous
   of the two: "reachable" has no honest definition on a device with no console, and a wrong answer tears
   down a working configuration because nobody happened to be connected. The `Observation<T>` discipline
   applies with full force here.
3. **Decline to bring up a configuration whose uplink cannot be found at all.** Much more conclusive than
   "nobody has connected to me" — closer to an observation and further from a guess. This is the most
   promising of the three and still not a decision anybody has taken.

An accidental proof of the fail-safe direction, from the same period: `wf-rederive` failed (its
`ExecStart` named `way.cjs`, which the kernel cannot exec), so the core did not start, and the board came
back fully reachable on both paths. **A device with no tunnel is inconvenient; a device with a tunnel
built on a stale picture of the network is unreachable.** Whatever guard is eventually chosen should fail
in that direction.

## Not undecided, just not done: the two things that need a person

These are not design questions. They are the two verifications nobody can perform without being in the
room with the board, and they are recorded here so that "unproven" does not quietly become "fine".

### A real power cut

The confirmation window's cover for a machine that dies mid-window has been proved with a **hard reset**
— `echo b > /proc/sysrq-trigger`, no clean shutdown, no unmount, no service stop — and the device came
back in 48 s and reverted from the start-up sweep. That is the strongest test that can be run over a
network.

It is not the same as **pulling the power**. A `sysrq` reset leaves the card's own write cache and the
SoC in a state a real outage does not, and the failure mode that matters — a filesystem that comes back
needing repair, or a transaction row that never reached the card — is specific to losing the supply. A
`sync` was issued immediately before the reset precisely so the test measured *no clean shutdown* rather
than *unsynced writes*; a real cut removes that courtesy.

**What to do:** apply a `network` change, leave it unconfirmed, and pull the supply at the wall inside
the window. Then check the device comes back, the filesystem is clean, the transaction was found by the
sweep, and access is restored. Repeat it several times — once is an anecdote about one moment in the
write cycle.

### Taking over the Ethernet interface the device is managed through

Every hardware verification in this repository has used the Ethernet lifeline as the management path, and
that path has deliberately never been touched: a plan that reports it under
`affectsManagementInterfaces` is refused rather than applied.

So the case where the device **takes over the interface it is being managed through** — Ethernet as the
uplink — is the one arrangement the confirmation window exists for and has never been exercised on. The
takeover machinery is built and tested, and the file-moving-aside path has been exercised on a wireless
interface; the Ethernet case has not.

**What to do:** have a second management path in place first — the device's own access point, with a
client already associated and the interface confirmed reachable — then apply the takeover, and watch it
from the access point rather than from Ethernet. The deadman covers the case where both paths go.

Both are listed in the README's *State of the evidence* section, which is where somebody deciding whether
to trust this will look.

### Resolved: the access point is back on 5 GHz, and the regulatory premise is measured

The 2.4 GHz channel recorded here as a workaround is gone; the bench board is on **5 GHz channel 36**
again, and the sequence that put it there is the evidence for the regulatory fix. Kept because it settles
what the fix rests on, and because it corrects where the defect actually lives.

**Cold start on channel 6** (2026-09-21, 08:53:59 kernel): access point came up by itself, no apply.

**Moved to channel 36** through the API, applied and confirmed. Note the width: 80 MHz was requested and
the driver negotiated **40 MHz**, which the profile does not reflect.

**Cold start on channel 36** (08:57:48 reboot): access point came up by itself on 5 GHz, and hostapd
stated the mechanism in its own state machine —

```
wlx90de8047b4b4: interface state UNINITIALIZED->COUNTRY_UPDATE
wlx90de8047b4b4: interface state COUNTRY_UPDATE->HT_SCAN
wlx90de8047b4b4: interface state HT_SCAN->ENABLED
wlx90de8047b4b4: AP-ENABLED
```

`COUNTRY_UPDATE` is hostapd establishing the regulatory domain **before it can even scan**. That is
exactly the premise the invariant fix is built on, and it is now a measurement rather than an assumption.

**And a correction to where the defect lives.** Both cold starts show the access point active long before
the control plane:

| | hostapd active | `wayfarer.service` active | gap |
| --- | --- | --- | --- |
| cold start #1 | 08:54:01 | 08:55:45 | 104s |
| cold start #2 | 08:57:53 | 08:59:45 | 112s |

The generated units are enabled and systemd starts them on their own, so **the invariant check is not
consulted at boot at all.** A cold start was therefore never able to reproduce the defect, and the reason
it showed up when it did is that the deadman had *masked* the units — with nothing started, the only way
back was an apply, and the apply is the path the check guards.

So the refusal was never "the access point cannot start after a reboot". It was "the access point cannot
be brought back by an apply while no country is established" — which is the state every deadman fire
leaves behind, and therefore the state of every recovery.

**The gap is closed. Measured 2026-09-21, by reproducing the recovery state rather than waiting for it.**

The nine units a fire masks were masked by hand, the board rebooted so nothing could establish a country,
and the state was confirmed to be the real one:

```
country 00: DFS-UNSET
	(5170 - 5250 @ 80), (N/A, 20), (N/A), AUTO-BW, PASSIVE-SCAN
```

Channel 36's band marked `PASSIVE-SCAN`, no access point, every unit inactive, lifeline intact. That is
what every firing of the safety net leaves behind.

Then the recovery an operator would actually perform — release the mask, start the control plane, apply:

| | before the fix | after |
| --- | --- | --- |
| plan | refused | `usable: True` |
| channel 36 finding | **error** `channel_no_initiating_radiation` | **warning**, saying the mark comes from the world domain and who resolves it |
| apply | refused outright | `awaiting-confirm`, then committed |
| access point | never started | `channel 36 (5180 MHz)` |
| regulatory domain | stayed `00` | `00` → **`DE`**, *because* the access point started |

with hostapd stating the mechanism itself:

```
interface state UNINITIALIZED->COUNTRY_UPDATE
interface state COUNTRY_UPDATE->HT_SCAN
interface state HT_SCAN->ENABLED
AP-ENABLED
```

A forwarded client then resolved names, connected, fetched `HTTP/1.1 200 OK`, and got `204` from a
connectivity-check host. Units were left enabled for the next boot and nothing remained masked.

So the logic and the premise are joined on hardware, in the exact state that made the defect matter. The
`regulatory_mismatch` warning appears alongside, correctly: the profile asks for `DE` while the kernel
still applies `00`, which is true at that moment and stops being true seconds later.

**Why this one was worth closing rather than noting.** The fault sat on the **recovery** path: the net
masks the units, nothing is left running to establish a regulatory domain, and the operation that would
restore service is the one that refused. That is the rescue path failing — the fourth time in this
project — and it was found by accident rather than by testing, which is the part that should not be
repeated. A recovery path that has never been walked is not a recovery path.

### The management-interface warning fires on changes that touch no interface

Measured on the bench board, 2026-09-21. A plan whose only live change was one sysctl — `conf.all.rp_filter`
from `0` to `2`, with no unit change and no interface change — was classed `network` and reported:

```
affectsManagementInterfaces: ['wlx90de8047b4b4', 'wfwan0']
WARNING: this change reconfigures wlx90de8047b4b4, wfwan0, which is carrying the connection you are
using right now. You will probably lose access while it applies.
```

Neither interface was reconfigured and nothing about either differed. The flag came from the **phase**
running — sysctls are applied in the network phase — rather than from anything the plan does to those
interfaces. The apply was in fact invisible: the effective value was already loose, and the user's client
stayed connected throughout.

**Why this is worth fixing rather than tolerating.** That warning is the most serious sentence this product
ever puts on a screen. It appears on the one operation that can leave a device unreachable, and it asks the
operator to confirm that they have a second way in before continuing. Every time it appears on a change that
could not possibly cost them access, it gets a little cheaper — and the cost is paid on the day it is
telling the truth. **A frightening warning on a harmless change is how people learn to click past
warnings.** This project already refuses to spend that credit elsewhere: warnings that are usually wrong
teach people to ignore warnings, which is why the invariant checks distinguish refusing from warning at all.

It is also the same shape as several defects already catalogued: the flag **describes** what the phase
touches instead of being **derived** from what the change disturbs. A sysctl change disturbs no interface,
and nothing in the plan needed to know that except the thing computing this flag.

**What to do:** derive `affectsManagementInterfaces` from the interfaces a change actually reconfigures —
address, link, or unit — rather than from which phase the plan enters. A sysctl-only plan should report an
empty list and be classed on what it really risks. Left open deliberately rather than fixed in passing,
because the blast-radius computation is load-bearing for the confirmation window and deserves its own pass.

### A generated file's name is our convention; a client's parser may disagree with it

Every external client's configuration is written as `<tunnel id>.conf`, and every transport's as
`<transport id>.conf`. That is a reasonable convention and it is ours.

Measured on the bench board, 2026-09-21: one client infers its configuration **format from the file
extension** and refuses anything it does not recognise —

```
core: Failed to get format of /etc/wayfarer/socks/relay.conf
```

It reads `.json`. The file was correct in every other respect. Two reasonable decisions — a generator that
names files consistently, and a client that parses by extension — and the operator pays for the collision
with a client that will not start and says nothing about why in its unit state.

**The workaround in place:** the operator's own command carries the flag that overrides it
(`-format json`). That works, and it is unsatisfying for the reason it always is: every operator using
that client now has to know this, and the first symptom they meet gives no hint of it.

**The better fix, deferred deliberately:** let the provider declare the configuration file's name, or just
its extension, alongside the command. The provider descriptor already knows what software it is starting,
which is exactly the thing that knows what the file should be called. It looks small — one optional field,
one join — but it touches the emission path for both external clients and transports, and it was found in
the middle of bringing four tunnels up for someone who needed them working. Changing a file-naming
convention under a running configuration at that moment is how a working device becomes a broken one.

**What to do:** add the optional declaration, default it to the present `.conf` so nothing existing moves,
and let a provider that needs `.json` say so.

### Deferred: one tunnel whose failure was diagnosed twice and attributed wrongly both times

A destination tunnel behind an obfuscation transport — one server, no alternates — failed to come up for
part of the evening of 2026-09-21. It is working now. **Why it recovered is not established**, and this is
written so nobody re-derives the evening from scratch tomorrow.

**The symptom, exactly:** the masking transport connected, and OpenVPN's key negotiation behind it timed
out after sixty seconds, every attempt, with nothing returned. `TLS Error: TLS key negotiation failed to
occur within 60 seconds`, then a soft restart, repeatedly.

**What was measured, and with what:**

* The masking client's own journal reported `Session established` four times, with times — that is the
  client stating its authentication with the server succeeded, not our inference from a socket.
* The server's address was reachable from the board directly.
* A control: the *other* tunnel behind the *same* masking binary, same version, same code path, a
  different server — its VPN came up and carried traffic throughout. This is the strongest single piece
  of evidence available and it is what rules out our packaging and our configuration of that layer.

**Ruled out, each by a measurement:** the masking layer itself and our configuration of it (it
authenticated, four times, and the control tunnel works); the profile's parameters and the client version
(the server accepted them repeatedly); our own emission of the transport (the control).

**Not ruled out:** the peer's VPN service behind the authenticated session; the path beyond
authentication; anything nobody thought to check.

**The most likely cause, unproven:** the window in which it failed **overlaps the window in which a defect
of ours had broken the board's own outgoing traffic** — a policy rule keyed on a firewall mark, which sent
root-owned packets out of the physical interface carrying an address nothing could route a reply to. The
masking transport runs as root. That produces precisely this shape: an authenticated session that stands,
and a negotiation behind it that never hears anything. **This was not measured at the time and is not
proof.**

**Two wrong attributions on the way, recorded because the third explanation looks like luck without them:**

1. "External" — concluded from two established TCP sockets. An established socket proves a TCP handshake
   and nothing about the protocol riding on it.
2. "The service on the far side" — concluded from the client journal. Better evidence, still wrong about
   the cause, because it did not account for our own concurrent defect.

**Open question, for the owner of that service rather than for this device:** does it answer from anywhere
else. Not being pursued.

**Why there is nothing to try:** that tunnel has exactly one server. The other has four.

### The panel cannot express three things the schema asks a person for

Found on 2026-09-21, and not by a test, a review or a code sweep. The owner asked whether a tunnel could be
configured entirely from the panel. Checking produced a wider answer than the question.

**`transports` has no interface at all.** The word does not appear once in `apps/ui/src`. The schema has it,
the daemon expands it into a listener per transport, generates the units, honours the order, and the plan
review names them — and `TunnelList.tsx` does not draw them. The JSON escape hatch does not help: it writes
`/tunnels/<i>/config` and never reaches `/tunnels/<i>/transports`, and the panel has no whole-document
editor.

Checking the rest of the tunnel object found two more. Every field on a tunnel, against whether the
interface mentions it anywhere:

| field | in the panel? |
| --- | --- |
| `id`, `name`, `role`, `enabled`, `provider`, `config`, `onUnavailable`, `dns` | yes |
| `transports` | **no** |
| `resources` | **no** |
| `probe` | **no** |
| `derivedFrom` | no — correct, it is written by subscription refresh and never by a person |

`resources` is the most serious of the three and was not part of the original question. It is *what a
destination tunnel is for* — the domains and address ranges it reaches. The routing editor renders
`domainSuffix` and `ipCidr` for **routing rules**, at `/routing/rules/<i>/suffixes` and `/cidrs`, which
look like the same fields and are not: a tunnel's own `resources` is a different pointer and nothing writes
it.

**The practical consequence, stated plainly:** a destination tunnel cannot be given its destinations, its
masking transport, or its health probe from the panel. All three are API-only. The owner's standing
instruction to configure profiles through the API was being honoured for a reason nobody had noticed —
there was no alternative. Neither they nor we knew that until they asked.

#### What to build

A transport list inside the tunnel editor, with the three fields the provider schema already declares:

* **command** — how the transport is started, run as given;
* **configFile** — the contents of its configuration file, which is a secret position;
* **localPort** — the loopback port it listens on, and it is **required here** unlike elsewhere, because
  the tunnel in front of it dials that port from inside an opaque profile blob this project does not
  rewrite. A port chosen by the daemon would not be the port the tunnel connects to.

Then the same for `resources` and `probe`, which are plain lists and a list of URLs.

The estimate is small, and **that is what makes it dangerous**: a small unfinished piece of work does not
appear in any plan, so it is never scheduled and never noticed, and the gap is discovered by whoever first
tries to do the obvious thing.

#### The class, and it is the seventh in a day

The other six are gaps between producing a value and consuming it, inside the system. This one is different
in kind: **the schema offers a field and no consumer displays it.** The gap is between the data model and
the one party who can fill that field in — a person.

And the detection method is the point. Not a test, not a review, not a sweep: **"can I do this with the
mouse?"** There is no check anywhere that every schema field a human is required to fill is presented to
them somewhere. Until there is, holes of this shape are found only by the owner, at the moment they try to
use the product for what it is for.

That is the whole reason this deserves a place beside the register's questions rather than only a line in a
backlog, and it is written there as one.

## The safety net does not cover the state database, and migration is write-on-read

Found while writing the verification plan for the largest change this project has made, 2026-09-21.
Not a defect in the deadman, which does what it says; a gap between what it protects and what a
rollback now has to undo.

**What the deadman snapshots:** `/etc/netplan`, `/etc/systemd/network`, `resolved.conf.d`,
`/etc/hostapd`, `/etc/wpa_supplicant`, `/etc/dnsmasq.d`, `/etc/nftables.conf`. Network configuration,
which is what it was built for.

**What it does not:** `/var/lib/wayfarer`, which holds the profile documents.

**Why that now matters.** `migrateProfile` runs on **every read** and writes the result back
(`state/profiles.ts`, `toRow`). So a profile is migrated the first time a new build reads it — not
when anybody applies anything — and it throws when it meets a document newer than the build
understands, from a call site with no guard.

**The consequence, which reverses the usual order:** rolling back the binary does not roll back the
profile. An older build meets a document it cannot read and fails on the calls that list and fetch
profiles. **The database must be restored before the binary, always** — not the other way round,
which is the order anybody would reach for.

It is handled procedurally for this deployment: the database is copied out with the daemon stopped
and the copy verified by reading rows from it rather than by the file existing. That is enough for a
deployment somebody is watching. It is not enough as a standing property, and the question left open
is whether the net should cover the state directory too — with the cost stated: a snapshot of the
database is a snapshot of credentials, and the net writes where the recovery path can reach it.

The general form, which is the part worth keeping: **a safety net is scoped to the failures its
author had in mind.** This one was built for a network change that locks the operator out. It was
never wrong; the system grew a second way to become unrecoverable, and nothing re-examined the net
when it did.

## `allowInsecure` in a subscription link: refused, and not a field waiting to be added (2026-09-21)

VLESS links in the wild carry `allowInsecure=1` or `insecure=true`. The parser this product had
carried it into a `tls.insecure` flag. The catalogue has no field for it, and when the parsers were
translated into catalogue configurations a decision had to be made rather than inherited.

**A link that sets either parameter is refused, naming the parameter.** The two alternatives both
lost, and it is worth writing down why, because the losing one looks like the accommodating choice.

**Dropping it silently** was the obvious path — the link still has a server, a port and a UUID, so a
configuration can be built from what is left. It produces **a tunnel which looks complete and fails
certificate verification**: the owner sees a saved, valid-looking tunnel and gets a failure whose
cause was stated in the link and discarded by us. That is exactly the class of silent failure this
codebase spends its comments forbidding.

**Adding a field for it** is the accommodating-looking choice, and is the one to be most careful
about. It is not a field. **It is a switch that turns off the only check distinguishing a tunnel from
a pipe to whoever answered.** With verification off, a tunnel to an impostor is indistinguishable
from a tunnel to the intended server — which is the single property the whole product exists to
provide.

**What is actually open**, and it is narrow: whether the owner ever asks for such a switch in his own
words, knowing that price. If he does, it is a decision about what the product does, taken
deliberately and named as what it is. It arrives that way, or not at all.

**What is not open** is adding it because a link carried a parameter. That is the difference between
a product decision and an accommodation made by whoever was reading somebody else's link format that
afternoon. This entry exists so that a later reader finds the reasoning rather than an obvious-looking
gap, and fills it in.

## Two questions raised by marking every field's source, 2026-09-21

Layer 3 of the parity check asks of every field in the profile document: *what is the only thing
that could have produced this value?* The answers are a closed set — `person`, `device`,
`subscription`, `catalogue` — and an unmarked field fails the check rather than passing it, so the
annotation is loud by construction. Marking all 133 positions produced two things the marks could
not settle. **One is now decided and is recorded below as resolved**; the other is still open,
because a mark changed to tidy a distribution is a mark changed for the wrong reason.

### `catalogue` now has one member, and the member is not what the name meant

After marking, and after the fifth source below was decided: **120 `person`, 6 `generated`, 4 `device`, 2 `subscription`, 1 `catalogue`, 0 unmarked** — 133 positions, of which 120 are required (112 by a `person` mark, 8 by the missing-secret refusal). Measured 2026-09-21.

Re-measured later the same day, after `/tunnels/-/config/entryPoints/-/id` was marked `generated` as
well: **119 `person`, 7 `generated`, 4 `device`, 2 `subscription`, 1 `catalogue`, 0 unmarked** — 133
positions, of which 119 are required (111 by a `person` mark, 8 by the refusal). Both lines are kept
rather than one replacing the other: each was true when it was made, and the first is the number the
commit that produced it reports. Nothing below changes — `catalogue` still has one member and the
question is still about the model around it, not about the count.

The one `catalogue` field is `/services/clashApi/bind`, the loopback address of the proxy core's own
control API. The mark is right on its own terms — the address is fixed by how the core is run and
read back by the daemon, and a person typing a different one would be typing over a running process.

What is wrong is the category around it. Everything that was genuinely the catalogue's — the binary,
the configuration file's name and format, the loopback port a tunnel is allocated — **left the
profile document in E4, which was the purpose of that task.** `catalogue` is now the name of a
compartment in a model we no longer have, kept alive by one field that arguably belongs to the
services section rather than to any catalogue entry.

Three ways out, and none is obviously right:

- **Rename the source** to what the field actually is (`runtime`, or `the-core-owns-it`), which
  keeps the mark honest and admits the model changed.
- **Re-home the field**: if `clashApi.bind` is really the core's business and not the profile's, it
  could follow `command`, `configFile` and `localPort` out of the document, and `catalogue` would
  then have no members at all — which is a clean answer, not an embarrassing one.
- **Leave it**, on the grounds that Epic F adds catalogue entries and may bring catalogue-owned
  fields back into the document.

The reason to record it rather than act: a source with one member is a signal, and the signal is
about the *model*, not about the field. Deleting or renaming the category to make the distribution
look better would erase the signal and keep the situation.

### Resolved: six fields the closed set had no answer for, and a fifth source for them (2026-09-21)

`/schemaVersion`, `/meta/createdAt`, `/meta/updatedAt`, `/uplinks/-/id`, `/tunnels/-/id`,
`/subscriptions/-/id` were left **unmarked on purpose**, so the parity check failed on all six.

Read before being left so, rather than assumed:

- `schemaVersion` is written by `state/profiles.ts` when a migration runs.
- `meta.createdAt` and `meta.updatedAt` are written by **nobody on the device**. The profile row
  carries its own `created_at` / `updated_at` columns, maintained on every write; these two travel
  inside the document a client sends. `core/apply.ts` records that it once depended on
  `meta.updatedAt` and had to stop, for exactly that reason.
- The three identifiers are generated by the interface — `uplink-2`, `tunnel-3`, `subscription-1` —
  and become outbound tags, systemd template instances and parts of generated file names.

**The decision: a fifth source, `generated`** — this product produced the value; no person, no peer
and no measurement did. The six are marked with it. It is an exemption, like `device`,
`subscription` and `catalogue`, so it never descends from a container and must be written on the
leaf itself.

**And a seventh, later the same day: `/tunnels/-/config/entryPoints/-/id`.** It is generated by the
interface exactly as the three identifiers above are, and it satisfies the same criterion — this
product is the only possible author of the value. It was missed because the task had been *mark
these six*, and it inherited `person` from its container, so nothing was red and nothing asked. The
criterion was applied to it by somebody going back over what that diff had not looked at. Worth
recording as the shape rather than as the field: **a new criterion is not applied by the diff that
introduces it.** The positions it was not run against are exactly the ones nobody will think to
check again, because the diff that introduced the rule reads as the moment the rule was applied.

#### Why the alternatives lost

- **`device`, widened to *produced by this device and not by a person*.** `device` means the device
  measured something about itself, and a schema version is not a measurement. The widening absorbs
  the timestamps and fits the identifiers badly, since the interface generates them.
- **`person` for the three identifiers, on the grounds that a control renders.** The one to be most
  careful about, and refused: marking a field by whether a control happens to exist is the exception
  list in disguise, arriving through the annotation that exists to prevent exception lists. An
  identifier a person edits is an identifier that breaks a reference.
- **Leaving all six red.** The costly option, and the reason the fifth word is worth its price: **a
  check that is permanently red for a legitimate reason gets ignored, and then it is worth nothing
  on the day it is right.** Six known-good failures teach every future reader that this check's red
  is background noise — which converts a mechanism that finds tomorrow's omission into a formality.
  The reasoning is written beside the kind in `source.ts`, because the next reader will see five
  words where the design said four and wonder why.

#### What was accepted with it, named rather than glossed

This is an exemption, and every exemption makes the next one easier. What keeps `generated` narrow
is its criterion, which is deliberately **not** *no person types this* — that would swallow every
field the device is merely good at guessing. It is **this product is the only possible author of the
value.** A field whose value could have come from anywhere else, including from a person who wanted
it different, is not `generated`, whatever writes it today.

#### Still open, and not settled by the mark

`meta.createdAt` and `meta.updatedAt` duplicate columns that *are* maintained, and a duplicate that
nothing maintains is a value that will be wrong. `generated` records where the value comes from; it
does not argue that the field should be in the document at all. Taking them out remains the fourth
option and is still worth taking.

#### The consequence that had to be handled in the same change

Marking the six emptied the `unmarked` layer: **no position in the document reaches it any more.**
That layer is the loud default the whole annotation rests on, and a branch no input reaches is a
branch nothing proves — it would now survive its own deletion in silence. This is the shape this
repository keeps finding, arriving for once as a consequence of a correct decision rather than of a
mistake. `parityRequirements()` therefore takes a root, exactly as the walk already did, and the
layer is proved in both directions against a schema built to reach it. Verified by mutation:
deleting the branch turns that test red and nothing else.

A second, quieter consequence is recorded in `parity.ts`: `Source()` copies the schema, so wrapping
four of the five uses of `Identifier` stopped them being the *same object*, and the walk's
shared-declaration guard now has four positions left to catch instead of eight — all in the
`accessPoint` branch. Nothing about the walk changed. **A mark added for an unrelated reason
silently reduced what an unrelated guard has left to catch.**

## `becauseOf` is produced and not yet consumed, and that is the open half (2026-09-21)

`UnitChange.becauseOf` landed with the differ that produces it, the boundary written beside the
field, and nine tests proving both directions. **Nothing reads it yet.**

That is stated here rather than left to be noticed, because it is the mirror of the trap the tunnel
status field was landed to avoid. A schema key with no producer is serialized as absent, silently; a
field with no consumer is computed and dropped, silently. Both look from outside exactly like a
device with nothing to report.

**What the consumer would be.** The reconciler computes `refused` before it touches anything —
per change, from the blast radius against the requested classes — and then filters the *unit* changes
by that same class. A refused **file** change stops nothing: the restart that depended on it is still
ordered and still reports success. That is the six-in-a-row defect exactly, and the fix is one filter
in `apps/daemon/src/core/reconciler.ts`, over the units it is about to order:

> Skip a step only when `becauseOf` is present, non-empty, and **every** path in it appears among
> the refused file changes — and record the skip as a refusal of its own, so the caller is told the
> restart did not happen rather than being told nothing.

**Why it was not done in the same change.** The task named the differ. The rules above are settled
and written down; what is not settled is whether a skipped restart is a *refusal* (the caller gets a
list naming it and can re-run with wider classes) or a *step that reports `ok: false`*. The first is
consistent with how the reconciler already reports what it would not do; the second is consistent
with how it reports what it tried. They differ in what a script sees, so it is the owner's call.

**Until it is decided, `becauseOf` costs nothing and claims nothing.** It is absent on every step
that has no file cause, non-empty on every step that has one, and no code branches on it. The risk
of leaving it is that it stays unread; the risk of guessing the reporting shape is that a script is
written against the wrong one.

### And a related measurement, recorded because it is invisible from a green suite

The third of the three cause rules — the path-shape net that predates the `consumedBy` declarations
— **catches nothing today**. Measured 2026-09-21 by deleting it: the whole daemon suite stays green.
Every file it would match is also declared. It is kept as a fall-back for a file that arrives without
a declaration, which has not happened rather than cannot, and the number is written beside it in
`differ.ts`. If it is ever edited, no test will object; that is the fact worth carrying forward.

### Resolved: it is consumed, and a skip is a refusal (2026-09-21)

Both halves are closed.

**The consumer exists.** One filter in `apps/daemon/src/core/reconciler.ts`, over the unit changes it
is about to order, applying the rule exactly as it was written above: skip when `becauseOf` is
present, non-empty, and every path in it was refused. The refused paths are accumulated **as paths**
in the loop that already computes the refusal, rather than parsed back out of the `what` sentence —
otherwise the phrasing of a message written for a person would become a data format, and the join
would break the first time somebody improved the wording.

**The owner's decision on the open half: a skipped restart is a refusal of its own, with the reason,
and not a step reporting `ok: false`.** The argument, recorded because it is the part worth keeping:
a skip is a *decision not to act*, not an attempt that failed. A step reporting failure says "I tried
and it did not work", which did not happen — a report of an action that never took place, the same
family of untruth this mechanism was built to remove, arriving from the other side. The reconciler
already has a channel for what it would not do, so the skip joins it rather than inventing a second
way to say one thing. And practically: a caller shown a refusal with its reason can re-run with wider
classes; one shown a failed step cannot, because nothing told it there was nothing to succeed at.

The contract now lives in `docs/06-apply-and-rollback.md` beside apply and rollback, rather than only
in the catalogue.

#### Correction to the measurement above

The section above says `becauseOf` "costs nothing and claims nothing" while unread. That was true and
is now the wrong frame to leave standing: an unread field does cost something, because from outside
it is indistinguishable from a field that is read and always says no. That is why it was written down
as an open question rather than left, and the resolution is the point — **a produced field with no
consumer is not a neutral state to rest in.**

#### And a second unmeasurable guard, found while proving this one

The `causes.length > 0` test — the one that reads an empty list as absent rather than as a set whose
every member was vacuously refused — **was unreachable from any plan the differ produces**. A restart
is planned only once a cause has been found, so the list is absent or non-empty and never `[]`.
Measured 2026-09-21 by deleting the length test: the whole daemon suite stayed green, which is the
same green a working guard reports.

It is now proved against a `Plan2` assembled by hand in the test. That is not a contrivance: a plan
is what `reconcile` accepts, and the boundary beside the field is explicitly about steps assembled
elsewhere, including ones written later by something that does not track causes at all. The general
form, which this repository has now met three times in two days: **a rule standing behind another
rule, a fall-back that catches nothing, and a guard no real input reaches all report exactly the
colour a working one does.**

## What does this setting actually change, and is it what its name says? (2026-09-21)

Raised as a register question rather than a defect, because the defect behind it is fixed and the
question is not: it is the one three of this repository's findings have been circling from different
sides, and nothing in the suite asks it on anyone's behalf.

The finding that named it is in `docs/16` — a wireless uplink's *get the address automatically* flag
that was not ignored but **contradicted**. Turning it off produced automatic addressing anyway and
silently disabled that uplink's failover priority, because the metric lived inside the block the flag
suppressed. Three separate answers were wrong, and only one of them was about addressing:

1. **Does it change anything?** An ignored setting. Visible to an operator who tries it.
2. **Does it change what its name says?** A contradicted setting. Visible only if the operator
   checks the thing the name promised rather than the thing that broke.
3. **Does it change anything else?** Invisible, always. Nobody checks for a consequence they did not
   ask about, and no test asserts the absence of a change nobody predicted.

The third is the one worth carrying forward, and it has a cheap partial answer: **when a setting is
proved, assert the neighbour it should not have touched.** The test for this one asserts the route
metric explicitly, and that assertion is the only reason the second defect did not survive the fix
for the first — a test that checked the addressing alone would have passed with the priority still
lost.

### The open half: two fields that are produced and read by nothing

An uplink's `config.dns` is written by the owner, stored, exported, and **read by no generator**. It
now exists on both kinds of uplink, because the wireless uplink was given the wired one's addressing
fields as a set and splitting the set would have recreated the drift that caused all of this.

It is not an oversight, and that is why it is a question rather than a fix. The proxy core is this
device's resolver; a resolver learned from the uplink and written into the host configuration would
be a second answer nobody asked for — which is exactly the reasoning already recorded beside
`UseDNS=no` on the DHCP path. So the field is coherent as a *record of what the operator was given*
and incoherent as a *setting*, and from outside there is no way to tell which it is.

This repository has already resolved that an unread field is not a neutral state to rest in: from
outside, a field that is never read is indistinguishable from one that is read and always says no.
The options, and this is the owner's call:

* **Write it.** `DNS=` on the static path, host-side. Coherent only if the decision that the core is
  the sole resolver is being narrowed, and it would need saying where that decision is recorded.
* **Drop it from both kinds.** Honest, and it discards a value the operator was given by a network
  and cannot recover once thrown away.
* **Keep it and say what it is** — a note carried with the profile rather than a setting — which
  means it should not be sitting in `config` beside fields that do change the device.

Until it is decided it is documented in `profile.ts` as read by nothing, with the reason, so the next
reader is not told by a comment that something reads it. That is the specific mistake this whole
entry came from.

#### Decided: write it, and not yet — because the field closes a loop that is currently open by accident (2026-09-21)

The owner's call is the first option, **write it**, deferred until the Ethernet takeover above is
done, because they are one scenario seen from two sides. What settled it was not the argument but a
measurement, and the measurement reversed the view recorded here — including mine, which was to drop
it.

Read off the bench board while it was running:

* `/etc/resolv.conf` points at `127.0.0.53`, so every name the device resolves goes through
  `systemd-resolved`.
* `resolvectl status` shows **`end0`** carrying `DNS Servers: 192.168.77.1`, learned by DHCP.
* The uplink this project actually manages, **`wfwan0`**, carries none. `UseDNS=no` is in force there
  exactly as documented.
* The only other resolver on the device is `172.19.0.2` on `tun0` — the proxy core itself.

So the device's ability to resolve a name today rests entirely on `end0` being configured *outside*
this project. That is not a design; it is the lifeline's stock configuration doing unpaid work.

The loop this closes is concrete. Of the four tunnels on the bench profile, the HQ tunnel's four
Cloak entry points are **hostnames, not address literals** (the other tunnels' remotes, and every
`remote` line inside the `.ovpn` blobs, are literals). To bring that tunnel up the device must
resolve a name; to resolve a name it needs a resolver; and once `end0` is taken over as an uplink
with `UseDNS=no`, the only resolver left is the proxy core, which is reachable only *through* the
tunnels. The uplink's `dns` is what breaks the circle, and there is nothing else on the device that
can.

This also answers the objection recorded above — that writing the resolver would be "a second answer
nobody asked for". It is not a second answer competing with the core. It is the **bootstrap** answer,
used before the core can be reached at all, and the two never apply at the same moment. That
distinction is what was missing, and it is why the field looked incoherent from outside.

Cost, stated before it is agreed rather than after: the code is small — one generator writing the
resolvers for the uplink's link, and the differ already classes such a change as `network`. The
expense is the proving, because it is a `network`-class change to the one interface that is also the
way onto the device. It must therefore be done **with** the Ethernet takeover, with the deadman
armed, and not on its own.

Until then the field stays, and the interface must say what it is rather than imply what it is not:
recorded, not applied. A control that silently does nothing is the failure shape this entry exists
to name, and leaving it unlabelled while the decision is deferred would be committing it knowingly.

## A test whose budget starts at process spawn, 2026-09-22

`apps/daemon/test/review-fixes.test.ts:333` — *"journal paging: a read cut short by its own timeout"* —
failed once during a full parallel run with `0 !== 2` and passed three times out of three in isolation
and on two later full runs. It is not a logic fault. The test spawns a stand-in `journalctl` and
measures a 400 ms budget **from the spawn**, then asserts two entries arrived; under full load the
child's start-up and first write can eat the budget, and the reader times out having read nothing.

Two ways out, and the first is better for a reason beyond flakiness: start the budget at the **first
byte** rather than at the spawn, because a read that has produced nothing has not been *cut short* —
the name of the test is already the argument for the change. The alternative is to have the stand-in
signal readiness and start the clock there, which fixes the flake and leaves the misnomer.

Left open rather than fixed inside Epic F's commit, because it is a pre-existing defect in a test of
unrelated behaviour, and folding it in would have hidden it inside a diff nobody would look for it in.
