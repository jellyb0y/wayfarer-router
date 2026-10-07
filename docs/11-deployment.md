# 11. Deployment

## Prerequisites

The installer checks all of these and refuses with a specific message rather than
failing halfway.

**Hardware**

* An arm64 or amd64 single-board computer or machine.
* At least one network interface for the uplink.
* At least one Wi-Fi radio capable of access-point mode. **Two radios are needed to
  run an access point and a Wi-Fi uplink at the same time** — see
  [12-hardware-invariants.md](12-hardware-invariants.md) for why this is a hardware
  fact rather than a configuration choice.
* 512 MB RAM minimum, 1 GB comfortable.

**Operating system**

* Debian 13 or a derivative, with systemd.
* `systemd-networkd` or netplan for network configuration.

**Packages from the distribution**

```
hostapd dnsmasq nftables iproute2 iw wpasupplicant openvpn jq
```

**Proxy cores — installed by the installer, never by the daemon**

| Binary | Needed for |
|---|---|
| `sing-box` ≥ 1.14.0 | The data plane. 1.14.0 is the floor because that is where `sing-box schema` appears, and the whole protocol model depends on it. |
| `xray` | Only for tunnels using another client behind a local SOCKS port. |
| An obfuscation client | Only for tunnels using that transport. |

Missing optional binaries are not an error. The interface reports what is absent and
which tunnel types are therefore unavailable, with the command to install them. This
is the whole reason for binary detection: a capability gap should be a sentence in
the interface, not a cryptic failure at apply time.

**Runtime**

Node 24 LTS, installed into `/opt` from the official tarball by the installer. Not
taken from the distribution, which ships a version reaching end of life.

## Installation

```sh
curl -fsSL https://…/install.sh | sh     # or run the script from a clone
```

The installer is idempotent and may be re-run. In order:

1. Verify prerequisites; stop with a specific message if anything is missing.
2. Install the runtime into `/opt` if it is not already the right version.
3. Install the bundle, the static files and the templated units.
4. Create `/etc/wayfarer` and `/var/lib/wayfarer` with restrictive modes.
5. Create the initial device state with the default credentials below.
6. Stop, disable and **mask** the distribution units that contend with ours — see
   *Distribution units the installer masks* below. Applied even with
   `--skip-host-settings`, because `scripts/deploy.sh` always passes that flag and the
   conflict is the same on every device.
7. Apply two host settings the daemon needs and cannot set for itself:
   * unattended filesystem repair, so a check at boot cannot stop and wait for a
     human on a device with no console — see
     [12-hardware-invariants.md](12-hardware-invariants.md);
   * a periodic filesystem check interval.
8. Install and enable `wayfarer.service`.
9. Print the default access point name, passphrase and admin password, and say
   plainly what leaving them costs. Nothing forces a change — see *Initial
   credentials* below.
10. Install the `hostapd_cli` / `wpa_cli` wrapper as `wayfarer-hostapd_cli` and
    `wayfarer-wpa_cli`, beside the real tools and never over them.

The installer does **not** configure the network. That is the daemon's job, from the
recovery profile, on first start.

### Distribution units the installer masks

**The symptom.** Observed on the bench board, 2026-09-24: the distribution's
`dnsmasq.service` was enabled and failed at every boot, while `wf-dhcp@<ap>.service` — the
same binary, run with `--conf-file=/etc/wayfarer/dhcp/<ap>.conf` and nothing else — served
addresses and names to the access point's clients. The stock configuration listens on the
wildcard address; ours binds the access point's interface; nothing orders the two, so
whichever binds first wins. Today ours does. Expected, not observed: the boot on which the
order flips, the stock unit holds the sockets, ours restarts into its start limit, and every
client associates and gets no address.

**The decision.** The installer is the one place that may touch a unit it did not install,
and only the units in one list: `STOCK_UNITS_TO_MASK` in `deploy/install.sh`, mirrored by
`CONFLICTING_STOCK_UNITS` in `apps/daemon/src/platform/stock-units.ts`. A test fails when
the two differ in a name or a reason. Each is stopped, disabled and masked **persistently**
(never `--runtime`: the race happens at boot, when a runtime mask is gone), checked by
reading `is-enabled` back, and logged with its reason:

```
[wayfarer] masked dnsmasq.service: wf-dhcp@ serves DHCP/DNS on the AP; the stock unit races it for ports 53/67
```

A re-run logs `kept … masked`; a unit that is not installed is skipped without a word; a
mask systemd refuses (a unit file at `/etc/systemd/system/<unit>`) is a warning and does
not abort the install.

| unit | masked | why |
|---|---|---|
| `dnsmasq.service` | yes | Contends with `wf-dhcp@` for the DNS and DHCP sockets on the access point. |
| `wpa_supplicant.service` | **no** | Owns `fi.w1.wpa_supplicant1` and serves every radio on the device, including ones no profile names. Our uplink runs its own instance without `-u` precisely so the two never contend ([05-platform-layer.md](05-platform-layer.md), *Wi-Fi*). Masking it would take away a connection this project was never asked to touch. |
| `hostapd.service` | **no** | Holds no port and no global name. It reads `/etc/hostapd/hostapd.conf`, which this project never writes, and can contend only for a radio somebody configured it for by hand. |

**If one comes back.** A mask is undone by one command, by a package's maintainer script
or by a how-to followed on the device. The drift check reads each listed unit on every
round (boot, every fifteen minutes, after a revert, and `way drift`) and reports one that
is no longer masked as a `unit-conflicting` finding on the Status screen and in
`GET /api/drift`, naming the unit, its state (`enabled, active`, `disabled, inactive`,
`masked-runtime, …`), the reason and the command that masks it again. "systemd could not be
asked" is a finding too, never silence.

**Undo.** There is no uninstaller. To have a masked unit back:

```sh
systemctl unmask dnsmasq.service && systemctl enable --now dnsmasq.service
```

The drift check will then report it, which is correct: it contends with the access point.

## First start

There is no configuration yet, so the daemon activates the built-in **recovery
profile**:

* access point on the first detected AP-capable radio, 2.4 GHz, a channel chosen
  from what the regulatory domain permits;
* LAN `10.99.0.1/24` with DHCP;
* the management interface listening;
* **no uplink**, no tunnel, and the kill-switch off.

Three deliberate choices here.

**No uplink.** The recovery profile does not guess. It brings up the access point so
the interface is reachable and stops there; the operator states what the uplink is.
Probing for a cable would be the implicit behaviour this design avoids everywhere
else.

**Kill-switch off.** Its default is off in every profile, not only this one. A device
with no tunnel configured has nothing to protect, and a kill-switch would make a new
install look broken. It is a switch in the interface and the API, and the interface
states plainly whether traffic is tunnelled.

**IPv6 blocked** even here, because the cost is nil and the failure mode it prevents
is invisible.

The operator connects to the access point, opens the interface and logs in. Nothing
is refused at that point: they can create their first profile — or paste one someone
shared — immediately, and change the password whenever they choose to.

## Initial credentials

Fixed defaults, printed by the installer, with **no forced change**.

```
access point : Wayfarer
passphrase   : wayfarer
login        : admin
password     : adminpass
```

The alternative — generating random values at install time — is stronger on paper
and was considered. It was rejected because the recovery story matters more here
than the window it closes: a documented default is something the operator can act
on when they have forgotten everything and are standing in front of a device with
no console, and a generated value printed once during an install months ago is not.

**The window is real and it is no longer closed by force.** An earlier revision of
this section said the daemon marks the device as unconfigured until both values have
changed, that the interface shows only the change-password screen, and that the API
refuses every scope until it is done. That was true and it is no longer: the forced
change was removed by the owner's decision, recorded with its exposure in
[10-security.md](10-security.md#the-default-password-is-short-by-decision-2026-09-21).
The paragraph is corrected rather than deleted, because a reader who remembers the
old behaviour needs to know it went, not to find the claim quietly absent.

What this means concretely: until the owner changes it, anyone who can reach this
device's access point or the local network it is plugged into, and who has read any
documentation, can sign in. Nothing about the login is weaker otherwise — sessions,
`scrypt` storage and the rate limit are unchanged. The short default is a default,
not a mode.

One property is worth stating because it is easy to miss and it runs the right way:
`adminpass` is nine characters and a new password must be at least twelve, so the
default **cannot be set back**. Leaving it is one screen; returning to it is
impossible. `way credentials reset` returns the device to its defaults wholesale,
which is a factory action and not a password change.

```sh
way credentials reset     # back to the defaults above
```

## Driving the radios by hand

This device keeps its control sockets to itself — hostapd on
`/run/wayfarer/hostapd`, wpa_supplicant on `/run/wayfarer/supplicant` — so the
stock tools need `-p` and report a working access point as absent without it. The
installer therefore puts one wrapper on `PATH` under two names:

```sh
wayfarer-hostapd_cli -i <ap interface> status
wayfarer-wpa_cli -i <uplink interface> status
```

`hostapd_cli` and `wpa_cli` themselves are untouched and still on `PATH`, which is
deliberate: anyone driving a foreign hostapd needs them, and they are the sanctioned
way to reach a different socket — the wrapper refuses an explicit `-p` rather than
honouring it, and points at them when it does.

## Updates

```sh
way update --from <path>
```

1. Verify the new bundle.
2. Keep the current bundle as a rollback copy — and **never overwrite an existing one**, because its
   presence means an earlier update never finished, so the bundle in place is the one that failed.
3. Stop the daemon.
4. Replace the bundle and the static files; run database migrations.
5. Start the daemon; it re-applies the active profile, which is idempotent.
6. If the daemon does not answer, restore the rollback copy and leave the unit **disabled**, so the
   device boots without it rather than into software never seen to work.

### A path, never a URL — and this is a decision, not an omission

`--from` takes a local path only. There is no `--from https://…`, there will not be one, and the
reason is worth stating plainly rather than leaving as a gap somebody helpfully fills later:

> **A daemon that downloads and executes its own replacement is a remote-code-execution feature with a
> friendly name.**

Everything that would have to be right for it to be safe — certificate validation, a pinned signing
key, a signature check before execution, a trustworthy clock to judge the certificate by, and a
rollback if the downloaded thing is hostile rather than merely broken — is a larger and more delicate
mechanism than the update itself, on a device that by design has no operator present. And the clock is
the part that cannot be assumed: this board has no battery-backed clock, so on first boot it cannot
validate a certificate at all.

Copying a file to the device is one command the operator already knows and already trusts, and it puts
the decision about *what* this device runs where it belongs: with the person, before the transfer,
rather than with the daemon, after it.
5. On failure, restore the previous bundle and start it again.

Configuration is never migrated destructively: profile documents carry their own
`schemaVersion` and migrations are pure functions, so an old export still imports
after an upgrade.

Updates do not touch the cores. They are the installer's responsibility, and the
interface reports when a detected version no longer satisfies what the active
profile needs.

## Verifying the largest apply this project has made

Written for the person performing it, because this one goes onto a device somebody is working on:
a phone on the access point, four tunnels carrying real traffic, one of them corporate. It carries
the catalogue, the profile migration to v7, guards that judge by reachability, resolver
re-derivation and the bind policy.

Every step below names **how the check itself can pass while the thing is broken**, because three
checks that did exactly that were found on 2026-09-21 alone. A step without that line is not a step.

### Step 0 — the safety net, and what it does not cover

`wayfarer-deadman snapshot` then `wayfarer-deadman arm 10`. This is proven and independent of the
daemon: a fire restores the network directories, masks `wayfarer.service` and the generated `wf-`
units, and reboots.

**What it does not cover, and this is the important sentence in this whole section.** It snapshots
`/etc/netplan`, `/etc/systemd/network`, `/etc/systemd/resolved.conf.d`, `/etc/hostapd`,
`/etc/wpa_supplicant`, `/etc/dnsmasq.d` and `/etc/nftables.conf`. It does **not** snapshot
`/var/lib/wayfarer` — the profile database — or `/etc/wayfarer`. A fire returns the network and
leaves the database exactly as this apply left it.

*How this check lies:* `wayfarer-deadman status` reporting `armed` proves a timer exists, not that a
fire would restore anything useful. The snapshot is only as good as the moment it was taken, and
`snapshot` refuses while armed precisely so a broken state cannot be blessed. Confirm the snapshot
age in `status` is from **before** any of today's work, not from a re-snapshot taken to clear a
warning.

### Step 1 — the backup the deadman does not take, before the new binary runs once

This is first because it is the only genuinely irreversible part of the apply.

`migrateProfile` runs **on every read** and writes the result back
(`state/profiles.ts`, `toRow`). So the profile document is rewritten to v7 the first time the new
daemon reads it — not at apply, not on confirmation, on *read*. And `migrateProfile` throws
`ProfileVersionError` when the stored version is newer than the build understands, with `toRow`
calling it unguarded.

**Therefore: putting the old binary back does not put the old profile back.** A downgraded daemon
meets a v7 document and throws on `get()` and `list()`. Rolling back the software without rolling
back the database leaves a device whose profiles cannot be read at all.

```
systemctl stop wayfarer.service
sqlite3 /var/lib/wayfarer/wayfarer.db ".backup '/root/wayfarer-preV7.db'"
cp -a /etc/wayfarer /root/wayfarer-etc-preV7
```

*How this check lies:* `cp` of a live SQLite file returns 0 while copying a torn write — which is why
the daemon is stopped and `.backup` is used rather than `cp` on the database. And a backup that
exists is not a backup that restores. **Verify by reading it, not by listing it:**

```
sqlite3 /root/wayfarer-preV7.db 'select id, name, schema_version from profiles;'
```

If that prints the expected rows, the backup is real. If it prints nothing, the rest of this plan has
no floor under it — stop.

### Step 2 — rehearse the migration on the real document, off the board

The coordinator's requirement, and the reason it is separate from Step 1: a fixture proves the
migration handles the shapes somebody imagined. The bench profile is the shape that exists.

Export the active profile **with secrets** before the upgrade, copy it off the device, and run the
migration against it on a workstation. Confirm it produces a document that validates, and read the
`applied` list: each entry names a change in meaning, and `profile.migrated` is recorded at `warn`
for exactly that reason.

*How this check lies:* a migration that "succeeds" only proves the document parses afterwards. It
cannot tell you the result means what the owner meant — a rule that survives migration and now
matches differently is a successful migration and a changed device. Read the `applied` list as
prose and decide, one entry at a time, whether each is what was intended. This is a judgement, not a
check, and it belongs to the owner where a tunnel's routing is involved.

### Step 3 — install, then prove the panel is reachable on all four channels

Per interface, not "the page opened". Two addresses in one subnet gave opposite answers on this
board on 2026-09-21, which is the whole argument:

```
ss -tln | grep :8088
```

Expect loopback, the wire, the access point and the wireless uplink — four — and **no tunnel
address**. Then probe each tunnel address and require a refusal, with a control on loopback
returning 200. A refusal that is actually "no route" proves nothing, so the control is what makes
the refusals evidence.

`way listen` now reports the resolved set rather than the configured one, and prints the same
`ss -tln` line as the thing that measures.

*How this check lies:* opening the panel from a laptop proves one path and hides the other three. A
count of four sockets passes while one of them is the wrong interface. **Name them one by one and
compare addresses**, because the wire went unbound for months behind a check that looked only at the
interfaces already in the list. And `ss` immediately after start can catch the listener mid-bind —
re-run it once after thirty seconds.

### Step 4 — the guards, because a changed judgement can block traffic silently

Guards now judge by reachability. A guard that flips to blocked cuts traffic, and on
2026-09-21 a working tunnel's guard sat blocked for three hours producing one journal line.

For every guard: record its state **before** the upgrade, then compare after. Look for any guard
that moved to blocked, and for any that reports `guard.unmeasurable` — that event means the decision
could not be made, which is not the same as a decision to allow.

*How this check lies:* "no guard is blocked" passes on a device where no guard was evaluated at all.
Check that each guard produced a *reading*, not merely that none produced a refusal — absence of a
blocked guard and absence of guards are the same empty list, which is the defect this project has
now paid for twice.

**How long to wait before a silent guard means something.** Read from the watchdog code rather than
estimated: a round's probes run **in sequence**, so a round against an unresponsive tunnel costs
the probe count times the timeout, and the interval is counted **after** the round finishes, not
from its start. That missing term is why an earlier figure of "about 70 seconds" was wrong — it was
an estimate presented as a measurement.

* **64 s** best case, **94 s** worst, for a tunnel whose probes hang to timeout.
* **30–60 s** when a dead endpoint refuses the connection immediately instead of hanging.

So a guard that has not moved after **two minutes** is a finding. Before that it is only a guard
that has not finished a round, and treating it as a verdict would be reading an unfinished
measurement as an answer — which is the shape this whole plan is written against.

Note also that a tunnel whose probes fail *fast* reaches its verdict sooner than one that hangs, so
the quickest verdicts and the slowest come from the same mechanism. Do not infer health from
promptness.

### Step 5 — all four tunnels, by carriage rather than by unit state

`systemctl is-active` is not the check. A tunnel was observed `active` for an hour on this board
while never completing key negotiation.

For each of the four: confirm the unit is running **and** that something crossed it — a name that
only resolves through it, or a route probe to an endpoint only reachable inside it. The corporate
one is the one to check by name resolution, because that is the failure the owner felt.

*How this check lies:* `active` is the check that hid the hour-long dead tunnel. A DNS query that
succeeds from cache proves nothing either — use a name not asked for recently, or clear the cache
first.

### Step 6 — resolver re-derivation, which now tells the truth about itself

This is the one part where the new code makes verification easier. Watch the event log for
`resolver.reconverged` versus `resolver.reconverge-refused` and `resolver.reconverge-unverified`.
The second names the path, the class and what the change would have needed; the third means the
apply refused nothing and the file the core reads still does not name what the peer pushed.

`resolver.reconverged` is now emitted **from the file**, not from the attempt: the daemon reads
`/etc/wayfarer/core/config.json` back after the apply and compares the address under each tunnel's
`dns-<id>` tag with what is in `/run/wayfarer/tunnel/<id>.dns`. A success line therefore carries the
address the core is configured with, and an apply that changed nothing can no longer produce one.

**What triggers it, which is the part that failed on 2026-09-22.** Three things, and nothing else:

* a peer pushing a resolver while the daemon is watching — the up script writes the file,
  `/run/wayfarer/tunnel` is watched, the change is debounced three seconds and applies at most once
  a minute;
* the watch becoming available later. The directory is created by `tunnel-up` when a tunnel first
  connects, so on a normal boot it does not exist when the daemon starts. That used to end the
  mechanism for the life of the process; it is now retried every thirty seconds, and establishing
  the watch is itself treated as a change, because a watcher is blind to what happened before it;
* **daemon start.** What is already captured is compared with what the core was given, once, and
  re-derived if they differ. This is what covers a deploy, an upgrade and a reboot — every case
  where the capture was written while nobody was listening.

So after a deploy, the daemon says in the event log what it compared, whether or not it found
anything: `resolver.convergence-checked` when the captured resolvers are the ones in use — naming
them — and `resolver.convergence-needed` when they are not, immediately followed by the apply. A
mechanism that is silent when it agrees cannot be told apart from one that is not running.

Then confirm by result, not by event: check the modification time of
`/etc/wayfarer/core/config.json` and the resolver inside it against what the peer pushed in
`/run/wayfarer/tunnel`.

*How this check lies:* `resolver.convergence-checked` on a board where the two already agree proves
the comparison ran, not that a stale value would have been corrected — for that the peer has to push
a different address, which means bouncing the tunnel. And a reconnection that also moves the
tunnel's subnet is no longer refused (the class promotion was narrowed to networks the device
follows rather than defends), but a refusal for any *other* reason still leaves the resolver stale:
a `reconverge-refused` line is the mechanism working and the resolver not applied. Do not read it as
a pass.

### Step 7 — disarm only after all of the above

`wayfarer-deadman disarm`, then `wayfarer-deadman snapshot` to bless the new state — in that order,
because `snapshot` refuses while armed on purpose.

### The rollback, decided now rather than at the time

**Network lost, board unreachable:** do nothing. The deadman fires, restores, masks and reboots. Then
`wayfarer-deadman release` to unmask, once you know what happened. This is the proven path and it
needs no decisions taken under pressure.

**Board reachable, apply wrong, profile still readable:** `way transactions` for the id, then
`way revert --txn <id>`. A `network`-class apply arms a transient unit outside the daemon, so the
revert runs even if the daemon is dead; the window is 150 s out of a 180 s budget, the remaining 30 s
being the measured cost of the undo itself.

**Board reachable, profiles unreadable or the migration wrong:** this is the case the backup exists
for, and the only correct order is:

```
systemctl stop wayfarer.service
cp -a /root/wayfarer-preV7.db /var/lib/wayfarer/wayfarer.db
cp -a /root/wayfarer-etc-preV7/. /etc/wayfarer/
# then, and only then, put the old binary back
systemctl start wayfarer.service
```

Restoring the binary **before** the database leaves an old build reading a v7 document, which throws
rather than degrading. The database goes back first, every time.

**What is never the rollback:** `way factory-reset`. It removes all configuration and state and has
no undo. It is not a recovery step and it is not on this path.

### What cannot be checked before applying, and is therefore risk rather than oversight

Named separately because a plan that implies everything was verified is worse than one that admits
what was not.

* **Whether the migrated profile still means what the owner meant.** Validity is checkable;
  intent is not. Any rule whose matching changed is the owner's decision.
* **Whether a peer pushes a resolver during the window.** That is the far end's behaviour. The
  resolver path cannot be exercised on demand — it can only be watched for.
* **Whether the guards' new reachability judgement is right for endpoints only reachable from the
  board.** The judgement can be inspected; the endpoints cannot be reached from anywhere else to
  check the answer against.
* **The confirmation window under real load.** 150 s was measured on an idle bench board. A board
  carrying four tunnels and a phone may take longer to become reachable again, and the only way to
  learn that is to spend it.
* **The clock.** A board with no battery-backed clock that has just been powered on rejects valid
  certificates and reports TLS failures that look exactly like broken tunnels. Check
  `way status` for clock synchronisation **first**, because every tunnel symptom below it is
  untrustworthy until it is right.
* **Interactions between the five changes.** Each was tested alone. They arrive together, and
  nothing here has run with all five at once on hardware.

## Recovery

Three levels, in increasing severity.

**Automatic revert.** A change that costs access reverts after three minutes without
confirmation, from a timer outside the daemon, and an unconfirmed transaction found
at start-up is reverted too. This covers the ordinary mistake and it covers power
loss during the confirmation window.

**Safe mode.** After three consecutive failed applies of the same profile, the daemon
applies a **derivation of that profile** rather than the recovery profile: tunnels off,
kill-switch off, and the access point, the listener and the local network kept exactly as
they are. The profile itself is not touched — it is usually two fields away from correct,
and the operator's own edit must still be there when they come back to it.

It keeps the **current access-point name and passphrase** where they are usable. The
documented fixed defaults are for a *fresh* device only: changing the network name
mid-incident stops the operator's phone reconnecting at the moment they need the device,
and a published default passphrase on an unsupervised device is a security regression
introduced by the recovery path.

The count resets on a success, on a profile edit, or on activating a different profile —
and "which configuration was this an attempt at" is decided by a profile **revision**, not
by comparing timestamps. See
[03-data-model](03-data-model.md#device-identity-and-the-aggregate-view-built-on-it) for why,
and [16](16-implementation-notes.md) for the four defects found by causing safe mode rather
than by calling the function.

**Factory reset.** From the interface with the `admin` scope, or
`way factory-reset` locally. Clears profiles, tokens and sessions, regenerates
credentials, and returns to first-start state. It does not remove the runtime, the
cores or the daemon.

## Power loss

The device is expected to be unplugged without a clean shutdown; a travel router
rarely gets one. What that costs, measured on the target hardware:

* **The filesystem survives.** ext4 with a journal and write barriers replays on the
  next boot.
* **Up to a couple of minutes of recently written data can be lost**, because the
  root filesystem is mounted with a long commit interval. Since almost nothing is
  written, this is nearly always nothing.
* **The journal from that boot is gone**, because it lives in RAM. This is why
  significant events are also written to the database.
* **Configuration files are not corrupted**, because every managed file is written to
  a temporary file in the same directory, synced, and renamed. This matters: a
  truncated core configuration means the core does not start, and the device then
  comes up with a working access point and no tunnel, which looks like success.
* **The clock is wrong on the next boot** on a board without a battery-backed clock.
  Time synchronisation must therefore bypass the tunnel, or timestamp-authenticated
  transports never establish. The planner emits that firewall rule as part of every
  profile.

## Operator CLI

`way` is the same bundle with a different entry point. It exists for the cases
where the interface cannot help.

```sh
way status                       # summary
way revert --txn <id>            # what the transient timer runs
way profile export <id> [--secrets]
way profile import <file>
way profile activate <id>
way safe-mode                    # why the device stopped using its tunnels: the same
                                 #   decision the daemon makes, from the same inputs
way credentials show | reset
way doctor                       # prerequisites, binaries, invariants, capabilities
way factory-reset
```

`way doctor` is the first thing to ask anyone reporting a problem for.

## The one prerequisite satisfied by hand, and exactly how

`sing-box` is not in the Debian archive, and **this daemon never downloads an executable**. It is the one
step the installer cannot do for you.

Installed on the bench board as:

```
sing-box 1.14.0 -> /usr/local/bin/sing-box
from   sing-box-1.14.0-linux-arm64.tar.gz
sha256 04d9b40bc98dc55b6f509ce3292145c65478f65866bea64826ebb2f382385088
```

Its emitted JSON schema is **444 895 bytes**, which is worth recording because that schema is what every
generated tunnel configuration is validated against, and a build that cannot parse it refuses to store a
profile with tunnels rather than writing credentials it cannot identify.

Choosing the version is deliberately a person's decision: this binary runs as root and carries every
client's traffic.

## `way debug expose-core-api` prints instructions rather than opening a port

The earlier intention — *"binds the core's API to the LAN until the next restart"* — is **refused**.

That API has no authentication of its own and full control over routing. Putting it on a routable address
hands anyone on the network the ability to redirect every client's traffic, in exchange for not typing an
SSH flag, and leaves a hole that outlives the debugging session.

So the command prints the bind address, confirms the core is running, and gives the `ssh -L` line. Both
halves were proved on the board: `HTTP 200 {"version":"sing-box 1.14.0"}` on loopback, and refused from
the network.
