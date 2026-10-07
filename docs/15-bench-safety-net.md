# 15. Bench safety net

A development board that configures its own network can lock itself out, and this
one has no serial console and no clock battery. The safety net is a deadman:
snapshot the configuration that is known to work, arm a timer, and if the timer is
not disarmed in time the configuration is restored and the board reboots.

`deploy/bench/wayfarer-deadman`, installed as `/usr/local/sbin/wayfarer-deadman`.

```sh
wayfarer-deadman snapshot          # record the current configuration as good
wayfarer-deadman arm [minutes]     # default 5
wayfarer-deadman disarm
wayfarer-deadman status            # armed or not, seconds left, snapshot age
wayfarer-deadman fire              # what the timer runs; not called by hand
```

## Why it is plain shell and a transient systemd timer

It has to work when the daemon is dead. A deadman that runs inside the process
whose change broke the network is not a deadman, so this one shares nothing with
Wayfarer: no runtime, no bundle, no database, no library. Arm is one
`systemd-run --unit=wayfarer-deadman --timer-property=OnBootSec=<uptime+N>s`, disarm is
`systemctl stop wayfarer-deadman.timer`.

### The deadline is anchored to boot, and the first version was not

An earlier revision armed with `--on-active=<N>min`, which is the obvious spelling and
was wrong in the worst possible direction.

**Measured on systemd 257.13, 2026-09-21.** `OnActiveSec` is relative to the *activation
of the timer unit*, and `systemctl daemon-reload` re-bases it to the moment of the
reload. Every Wayfarer apply that writes a unit file runs a `daemon-reload`. So the
deadman was postponed by its full interval by the very operation it was armed to
protect — and an apply that retries would postpone it again, indefinitely, so on a
board whose network an apply had just broken it would never fire at all. Observed for
real: armed at 02:02:50 for twenty minutes, an apply at 02:18:12, and the timer then
due at 02:38:12.

`OnBootSec` is anchored to boot, which does not move. Verified the same way: a timer
set to `OnBootSec=4561s` still reported `NextElapseUSecMonotonic=4561s` after three
`daemon-reload`s and nine seconds of elapsed time.

This also repaired the *status* line, which had been reading the deadline from the
deadman's own record and so reported `armed: -604s left` — overdue by ten minutes —
about a timer with four minutes still to run. A person acting on that line would
conclude the safety net had failed. The record is now the same number that is handed
to `OnBootSec`, so it is the deadline rather than a copy of it, and `status` carries a
derived contradiction check: an armed transient timer past its own deadline should not
exist, so if one is seen, status says the two numbers disagree and names both instead
of reporting either as fact.

The general lesson is in
[16-implementation-notes.md](16-implementation-notes.md#the-dominant-failure-mode-of-this-codebase):
this was the catalogued failure mode inside the safety net built to catch it.

The unit name is **fixed rather than suffixed with a timestamp**. With a fixed
name, a second arm fails loudly because the unit already exists, and disarm needs
nothing looked up. With a generated name, a second arm succeeds and there are two
timers where the operator believes there is one.

## What is snapshotted

Directories restored to match the snapshot exactly:
`/etc/netplan`, `/etc/systemd/network`, `/etc/systemd/resolved.conf.d`,
`/etc/hostapd`, `/etc/wpa_supplicant`, `/etc/dnsmasq.d`.
Files copied back: `/etc/nftables.conf`.

Address service is included deliberately: restoring a radio without the DHCP
configuration that gives clients addresses is a half-restore that looks like a
working access point nobody can use.

`/etc/resolv.conf` is **not** snapshotted. Measured on the bench board it is a
symlink to `/run/systemd/resolve/stub-resolv.conf`, so the content is regenerated
at boot and capturing the target would only let a stale resolver be restored later.
What it was at snapshot time is recorded in `manifest.json` instead.

## Restore is exact, not a merge

Unpacking an archive over `/etc` leaves behind any file added after the snapshot
was taken, and a stray `/etc/netplan/40-*.yaml` or an extra `systemd.link` is
exactly the kind of leftover that keeps a board unreachable. So each snapshotted
directory is made to match the snapshot with `rsync -a --delete`, and every deleted
path is recorded.

**The cost, stated plainly:** if anything else on the board adds a file to one of
those directories after the snapshot was taken, a fire deletes it. That is
acceptable on a bench and it is why the snapshot is never taken automatically.

## Three refusals

* **arm** refuses when no snapshot exists, and verifies the archive reads back
  before arming. An armed deadman with nothing to restore is worse than none: it
  reboots and changes nothing.
* **snapshot** refuses while a deadman is armed. An armed deadman means the current
  configuration is under test and has not been proven good; blessing it as the
  fallback would turn the safety net into a way to make a broken configuration
  permanent.
* **snapshot never happens on its own.** Only an explicit command, for the same
  reason.

## The fire path

1. Restore, recording removals and changes.
2. `sync`, then write `/var/lib/wayfarer-deadman/last-fire.json`, then `sync` again.
3. Arm a backstop, then reboot.

The record goes to the card rather than the journal. Measured on the bench board:
`journalctl --header` reports the active journal file under
`/run/log/journal/…/system.journal`, and `/run` is `tmpfs`, 197.3 MB. A journal
entry written by the deadman is therefore the one entry guaranteed not to survive
the reboot the deadman is about to perform. Older boots *are* listed by
`journalctl --list-boots` because `/var/log/journal` is a symlink to
`/var/log.hdd/journal` and `armbian-ramlog` copies `/var/log` to the card on a clean
shutdown (`USE_RSYNC=true` in `/etc/default/armbian-ramlog`) — a clean shutdown
only, so this is not a substitute for writing the record to the card.

**Backstop before reboot, in that order.** `systemctl reboot` can hang
indefinitely on a unit that is already wedged, which is one of the states the
deadman exists for. So a transient unit is started first:

```
systemd-run --unit=wayfarer-deadman-backstop \
  --property=DefaultDependencies=no --property=KillMode=none --corp --no-block \
  /bin/sh -c "sleep 60; sync; echo b > /proc/sysrq-trigger"
```

`DefaultDependencies=no` keeps it out of the shutdown ordering, so systemd does not
stop the unit that is watching the shutdown; `KillMode=none` keeps it alive while
its siblings are torn down. `reboot -f` was considered for the main path and
rejected: the moment the deadman fires is the worst possible moment to abandon the
card mid-write, so the clean reboot goes first and the forced reset is the fallback.

## Traps found while building this

**`systemctl show -p NextElapseUSecMonotonic` does not print microseconds.**
Measured on systemd 257.13, it prints a rendered timespan — `3h 36min 23.335852s` —
in spite of the name, and `NextElapseUSecRealtime` is *empty* for an `--on-active`
timer. Arithmetic on either is a bug; the first version of this script died with
`value too great for base (error token is "3h")`. The deadline is therefore recorded
at arm time in `armed.json`, against the monotonic clock from `/proc/uptime`, because
this board has no clock battery and its wall clock can jump by days after a power
cycle. `systemctl list-timers --json=short` is not available in this version either.

**rsync pads the filename in `--itemize-changes` output.** `*deleting` is followed
by padding to a fixed column, so the path has to be trimmed or every recorded path
carries stray spaces. Observed in the first real fire record:
`"/etc/systemd/network/  99-wayfarer-deadman-test.network"`.

**A test script that arms and then exits under `set -e` leaves the deadman armed.**
This is how the first real fire happened: the status command crashed on the
timespan bug above, the shell aborted before `disarm`, and 45 seconds later the
board restored and rebooted. The behaviour was correct — that is the whole point —
but any automation that arms must disarm in a trap, not on the happy path.

## Verification on the bench board, 2026-09-19

Run 1, unintended and therefore the most convincing: armed for 1 minute, not
disarmed, fired at 16:35:45Z. Boot id changed from `dc52d830…` to `5dc5e1d2…`.
Nothing had drifted, so `removed` and `changed` were empty. SSH was reachable again
50 seconds later. All sixteen services that had been running before the reboot came
back on their own (`systemctl --failed` empty), and every address returned:
the access point, the uplink and all three tunnel interfaces.

Run 2, deliberate, with three perturbations chosen to be inert if the restore had
failed:

| Perturbation | Result |
|---|---|
| `/etc/dnsmasq.d/99-wayfarer-deadman-test.conf` added | deleted, recorded in `removed` |
| `/etc/systemd/network/99-wayfarer-deadman-test.network` added | deleted, recorded in `removed` |
| comment appended to `/etc/nftables.conf` | content restored, md5 back to the snapshot value, recorded in `changed` |

Fired at 16:38:23Z, new boot id `115aeddb…`, reachable again within 50 seconds,
`systemctl --failed` empty, all services and addresses back, and the fire record
present on the card after the reboot. `/proc/sysrq-trigger` was not used in either
run, so the clean reboot completed well inside the 60-second backstop.

## Where the safety net is protected from us

State lives in `/var/lib/wayfarer-deadman/`, deliberately **not** under
`/var/lib/wayfarer`, so a factory reset cannot remove it. The script lives in
`/usr/local/sbin/`, which the installer does not own. Enforcement is by omission
and it has to stay that way: the installer's removal path must never list
`/usr/local/sbin/wayfarer-deadman` or `/var/lib/wayfarer-deadman`, and that
exclusion is asserted in the installer's tests rather than left to memory.

## The deploy arms it, and that is not optional

Added 2026-09-20, after a deploy left the bench board unreachable.

Arming used to be a flag on `scripts/deploy.sh`. It was passed for an apply that looked risky and
left off for a deploy that had been done before without incident; that deploy died mid-copy, and the
board had to be power-cycled by a human. **A safety net that depends on somebody remembering is not
a safety net.** Every deploy reconfigures a device that may only be reachable over the network it is
about to touch, so every deploy now arms, and `--no-deadman` is an explicit opt-out that says in
words what it costs.

Three properties of how it arms, each of which is asserted by a test against a stand-in device
(`apps/daemon/test/deploy-deadman.test.ts`) rather than left to a reading of the script:

**It arms from the existing snapshot and never takes one.** This is the rule above — *snapshot never
happens on its own* — meeting the new default, and the two only fit one way. Taking a snapshot at the
start of a deploy would bless whatever state the board is in, including a half-applied one from a
deploy that just failed, as the state to fall back to. A device with no snapshot therefore makes the
deploy **refuse**, naming the command a human runs once they have looked at the board.

**Disarming happens only after the daemon has answered**, not on exit. The previous version disarmed
in an unconditional `EXIT` trap, which meant a deploy that broke the network cancelled the thing that
would have fixed it. Now any exit without a verified daemon leaves the deadman armed and says so,
with the remaining time read from the device and the disarm command spelled out — the person reading
that message is already having a bad day.

**The refusals happen before anything with a consequence.** Free space is checked, and the snapshot
and armed state are read, before the deadman is armed and before a single artefact is copied. A test
asserting that a refusal copies nothing caught the opposite ordering: the deadman was armed, then
space was checked, then the deploy refused — so an out-of-space board would restore and reboot over a
deploy that never started. See [16-implementation-notes.md](16-implementation-notes.md).

An arm already in progress is also a refusal rather than a second arm. The unit name is fixed on
purpose so a second arm fails at systemd; refusing here turns that into a sentence, and an arm
already running means somebody else is mid-change on the board.

## A fire masks the daemon, and that is the principle rather than a precaution

Added 2026-09-20.

The deadman restores the network configuration and reboots. That is sufficient only while the thing
that locked the operator out is a *network configuration*. If it is our own daemon — half-installed,
crash-looping, leaking something once per restart — then restoring somebody's network and letting the
daemon start again hands the board straight back to the state it was just rescued from, and the
deadman fires again, and the board oscillates.

So a fire **masks `wayfarer.service` before rebooting**. Stated as the principle, because the change
follows from it rather than the other way round:

> The safety net's job is to return the device to a state a human can reach. That means removing our
> software from the boot path, not just our configuration from the network.

Masked rather than disabled, deliberately. A mask survives something else calling `enable` — including
our own installer, which a half-finished deploy may well run again, and which is one of the more
plausible ways to arrive in this situation in the first place.

What it costs, stated rather than discovered: after a fire the board comes back with no Wayfarer
running, and nothing will start it until a human says so. That is the intended outcome and it is the
opposite of a silent one:

* `wayfarer-deadman status` reports the mask on every run;
* `last-fire.json` records `maskedUnit`, whether the mask succeeded, and `undoWith`;
* `wayfarer-deadman release` unmasks it and prints the command to start it.

`release` deliberately does **not** start the daemon. It was masked because it may have been the
reason the board needed rescuing, and starting it again unattended is the one decision that belongs to
a person looking at the evidence.

A mask that fails is reported and does not stop the reboot. A board that reboots with the daemon still
enabled is no worse than one that never reboots at all, and the fire record says which happened.

## A snapshot is only a fallback for the configuration it covers

Added 2026-09-20, after watching a snapshot become stale within minutes.

The snapshot is **re-blessed whenever the board reaches a new verified-good state** — not on a
schedule, and not automatically. Concretely: after the distribution packages, after our install is
proven to answer, and after the first confirmed profile.

The failure it prevents, stated plainly: reverting to a snapshot older than the software installed
leaves a board whose packages exist and whose configuration does not mention them. Measured on the
bench board, the two snapshots taken twenty minutes apart:

```
bare board      40960 bytes  captured: /etc/netplan /etc/systemd/network /etc/wpa_supplicant
after packages  51200 bytes  captured: /etc/netplan /etc/systemd/network /etc/hostapd
                                       /etc/wpa_supplicant /etc/dnsmasq.d /etc/nftables.conf
```

The first snapshot did not cover `/etc/hostapd`, `/etc/dnsmasq.d` or `/etc/nftables.conf`, because
those directories did not exist yet. Restoring it after the packages were installed would have left
their configuration untouched by a restore that believes it is exact — which is the one thing an exact
restore is supposed to rule out.

And re-blessing happens **before** the apply that can cost access, not after it succeeds. The fallback
has to be current when the risk starts, not once it has passed.

## A fire masks the generated units, not only the daemon

Corrected 2026-09-20, after a fire rescued the board and the board locked itself out again ninety seconds
later.

The fire restored `/etc/netplan`, masked `wayfarer.service` and rebooted. The board came back, and
`wf-hostapd@wlan0.service` — still **enabled** — started at boot and took the radio a second time.

Masking the daemon stops the **control plane** from re-applying a configuration. It does nothing about
the **data-plane** units that already hold the hardware, and those are deliberately independent of the
daemon precisely so a configuration survives a reboot without it. That independence is correct, and it is
exactly what makes those units the thing a rescue has to stop.

So a fire stops and masks every `wf-*` unit as well. One detail carries the whole correction and a future
reader will be tempted to simplify it away:

> **The units are enumerated from `systemctl list-unit-files`, not only from `systemctl list-units`.**
> The two answer different questions — what is loaded now, and what is enabled for the next boot — and it
> is the second set that turns a rescue into a loop. A unit that is enabled and inactive is invisible to
> the first listing and is the one that will take the radio when the board comes back.

Template files (`wf-hostapd@.service`) are skipped: they are not units that run, and masking one would
block the instances a later release needs. `wayfarer-deadman release` unmasks everything a fire masked,
enumerated from what is masked now rather than from the fire record, so it also cleans up after a fire
whose record was lost.

## A second management path is a prerequisite for the hardware scenarios

Not advice. The C16 scenarios deliberately destroy a management path, so running them with only one is a
test that cannot be observed and a board that cannot be recovered without a human.

Before running them: **connect Ethernet, and confirm the board is reachable over it while the radio is
under test.** The scenarios do not start until that is true.

This is recorded here rather than in a report because it was learned by getting it wrong: a scenario was
run that took the only way in, the deadman recovered the board, and "the safety net worked" was mistaken
for "the test was designed properly". They are different claims.

## Masking works now, and the reason it did not is where units were installed

Measured on the bench board, 2026-09-20, after generated units moved out of
`/etc/systemd/system`:

```
# systemctl is-enabled wayfarer.service
enabled
# systemctl mask wayfarer.service
Created symlink '/etc/systemd/system/wayfarer.service' → '/dev/null'.
# systemctl is-enabled wayfarer.service
masked
```

Previously this failed with `File '/etc/systemd/system/wayfarer.service' already exists`, because
systemd masks a unit by creating a symlink **at that exact path** and our own unit file occupied it.
The deadman's central action — taking our software out of the boot path — silently did not happen.

The same measurement, repeated for every unit this project generates, one at a time:

| unit | maskable |
|---|---|
| `wf-firewall.service`, `wf-firewall-ready.target`, `wf-core.service` | yes |
| `wf-hostapd@<iface>.service`, `wf-dhcp@<iface>.service` (instances) | yes |
| `wf-hostapd@.service`, `wf-dhcp@.service`, `wf-openvpn@.service`, `wf-transport@.service`, `wf-socks@.service` (templates) | yes |

An earlier note in this repository claimed templates could not be masked. **That was wrong in its
generalisation**: the obstacle was never the template, it was `/etc/systemd/system` being occupied.
Moving the unit directory fixed the whole rescue path at once rather than only the daemon.

### `unmask` removes enablement, and for a template it removes every instance's

Two measurements, both on the bench board, 2026-09-20:

* `systemctl unmask wayfarer.service` left it `disabled` — the mask symlink and the
  `multi-user.target.wants` link live in the same directory, and unmasking removes both.
* `systemctl unmask wf-hostapd@.service` left `wf-hostapd@wlx90de8047b4b4.service` **`disabled` while
  it was still running**. An instance's enablement link points at the template file, so sweeping the
  template's links sweeps the instances' too.

The consequence is the one this document keeps meeting from different directions: a device that works
now and is gone after the next reboot. So `wayfarer-deadman release` states it, and any rescue that
masks must `systemctl enable --now` afterwards **and read the result back** — the asymmetry is
invisible in the command's exit code.

## The five-step rescue chain, written as a sequence rather than an apology

One lockout, five distinct failures, each of which had to be worked around by hand before the next
became visible. Recorded in order because the order is the lesson: every step was a mechanism that
existed, was believed to work, and had never been run in the situation it was built for.

1. **The takeover took the interface carrying management.** The profile moved the access point onto the
   radio holding the SSH session. The plan knew which interfaces were management interfaces; nothing
   refused on that basis. → `affectsManagementInterfaces`, and a refusal rather than a warning.
2. **Our revert did not restore the effect.** The file went back; the displaced manager was not asked
   to re-apply, so nothing configured the radio to rejoin. → the second undo, in
   [06](06-apply-and-rollback.md).
3. **The deadman's mask of the daemon could not work.** `systemctl mask` was refused because our unit
   file occupied the path a mask needs. → the unit directory move, above.
4. **The data-plane unit kept the radio across reboots.** Masking the control plane stops it
   *re-applying*; it does nothing about the units already holding the hardware, which are deliberately
   independent of the daemon so a configuration survives a reboot. That independence is correct and it
   is exactly what makes them the thing a rescue must stop. → a fire masks the generated units too.
5. **The tunnel captured the return path to the local network.** The generated core configuration did
   not exclude the network the management session arrived on. → the exclusion covering every network
   the device holds an address on, and the boot guard that re-derives it.

The generalisation, which is the only part worth carrying forward: **a rescue step must verify its own
effect, not its own exit code.** Four of the five above returned success. `systemctl mask` was the one
that reported failure, and it was reported into a log nobody was reading at the time.

## The other bench instrument: the soak

`deploy/bench/wayfarer-soak`, installed as `/usr/local/sbin/wayfarer-soak`. It is not a
safety net; it is what the shipped resource limits are derived from, and it sits in this
chapter because it has the same property: it must be reproducible from this repository,
not set up by hand on one board.

```
scp deploy/bench/wayfarer-soak <device>:/usr/local/sbin/wayfarer-soak
ssh <device> 'chmod 0755 /usr/local/sbin/wayfarer-soak && wayfarer-soak install'
ssh <device> 'wayfarer-soak report'
```

`install` writes both units and enables the timer, verifying by result that it is
running. The unit text lives inside the script rather than in files beside it, because
the script is what gets copied to a device and units that travel separately are units
somebody recreates by hand.

It samples every thirty seconds into **tmpfs** and appends **one line per hour** to the
card, and `report` states that footprint as part of its output, because a measurement
that changes what it measures has to say so.

### Three things learned from building the instrument rather than from the numbers

* **The card's device name must be resolved at every sample.** It is not stable across
  boots on this image — see [12-hardware-invariants.md](12-hardware-invariants.md). A
  sampler with the name written into it would have reported zero card writes for the
  whole soak and been believed, which is the failure this repository has catalogued most
  often, occurring inside the instrument built to measure it.
* **`bash` printf silently reuses its format string.** A twelfth value against an
  eleven-conversion format does not fail: it writes each sample as two lines, the second
  holding one value and ten empty columns. Every statistic then averaged those rows in,
  and the report announced `card written -38.61 MiB over the window` — a negative
  quantity of bytes, to two decimal places. `report` now refuses a series whose rows do
  not match its header, and refuses to print a cumulative counter that has gone
  backwards as though it were a difference. A measuring tool that reports a
  plausible-looking number from input it could not parse is worse than one that stops.
* **`NRestarts` is not the number of times the daemon started.** It counts restarts
  systemd performed *after a failure*, so a window containing a deploy — which stops and
  starts the unit — reported `daemon restarts 0` and read as a window of undisturbed
  running, while `memory.current min` described a process that had just booted. The
  series now carries the unit's start timestamp and the report derives the count of
  starts from it, saying so when the window contains more than one.

### The window is the number

The first hour sampled on the bench board reported **35.61 MiB written to the card**,
against a documented steady-state baseline of 650–750 B/s, which is 2.3–2.6 MiB in an
hour. Almost all of the difference was our own work inside the window: two deploys, an
installer run and a deadman snapshot. That figure is not evidence of a regression and
must not be quoted as one. `reset` exists so a window can be started deliberately and
said out loud, rather than a polluted one being quietly reinterpreted.

## The bench board's own configuration, and what has deliberately changed

Kept here so that a difference found later is read as a recorded decision rather than as drift.

| what | value | why it is that |
|---|---|---|
| management path | Ethernet `end0`, `192.168.77.7/24` | The lifeline. Never reconfigured, never taken over, and a plan that reports it under `affectsManagementInterfaces` is refused rather than applied. |
| access point channel | **36** (5 GHz) | It is the radio channel that gets changed whenever a genuine `network`-class apply is needed for a proof, because it is the smallest such change that cannot touch `end0`. It went 36 → 40 proving the revert timer's deadline survives `daemon-reload`, and 40 → 36 proving the countdown is anchored to that deadline, so it is back where it started. If it is ever found on another valid channel for the band, that is a proof in progress rather than drift. |
| profile tunnels | none | The two tunnels used to prove the health watchdog (`deadfirst`, `worksecond`) were removed once it was proved. They ran against a transient `systemd-run --corp` SOCKS proxy, so nothing was left behind in `/etc/systemd/system`. |
| soak sampling | running, window reset 2026-09-21 | A window containing our own deploys measures our own deploys — see above. |

An earlier attempt at the same proof set the channel to 1, which the **plan** refused (422): channel 1
is a 2.4 GHz channel and the access point's band is 5 GHz. Worth recording because the profile store
accepted the document and only the planner objected, which is the intended layering — a profile states
a request, and the device reports what it can do with it — rather than a validation gap.

## The recovery scenarios, measured

Four failures were caused deliberately on the board, each with a `network` change applied and left
unconfirmed. These are the measurements the recovery promise rests on, and each one names the mechanism
that actually did the work — because three different mechanisms cover three different failures and only
one of them is the timer.

### Scenario 1 — a broken uplink, the ordinary path

```
applied at      T+0.0s   uplink pointed at NO-SUCH-NETWORK-HERE, network class,
                         window 180s, deliberately not confirmed
access lost at  T+3.3s
access back at  T+53.7s
outage          50.5s
mechanism       reverted by an early health check: "the selected uplink has neither
                carrier nor address after 45s"
```

**50.5 s against a three-minute requirement, and it did not wait for the deadline.** This is the first
time the `Observation` machinery and the 45-second uplink-settle threshold ran on hardware.

**Correction, 2026-09-23: this did not prove what it was read as proving.** The uplink check that
reverted here compared `operstate` with a lower-case `'up'` that `ip` never prints, so it reported
*every* uplink as carrier-less — it would have reverted at the same moment had the uplink been
perfect. The 50.5 s measured the settle allowance, not a detection. The check no longer reverts at all
(see *Early revert — withdrawn* in [06](06-apply-and-rollback.md)); re-run today, this scenario is
recovered by the transient timer at the deadline, which is scenario 2b's path and inside the promise.

*What it does not prove:* the uplink broken here is the wireless one. Ethernet is the lifeline and was
never touched, so this says nothing about recovery when the **management path itself** is what broke —
that is what the deadman exists for, and it has been proved separately by firing twice.

### Scenario 2a — the daemon killed

```
daemon killed   T+3.3s   SIGKILL to wayfarer.service
access lost at  T+3.4s
daemon back at  T+15.7s  restarted by systemd (Restart=on-failure)
access back at  T+17.8s
outage          14.4s
mechanism       the start-up sweep: "the daemon restarted while this change was still
                unconfirmed, so nobody ever confirmed it"
```

**2a does not test what it appears to.** systemd restarts a killed daemon within seconds and the sweep
recovers, so the transient timer never gets its turn. That is why 2b exists.

### Scenario 2b — the daemon *stopped*, so only the timer outside it can act

First attempt **failed**, and the mechanism had never once worked — see
[the revert that stopped itself](#the-revert-that-stopped-its-own-transient-unit) below. After the fix,
and then again under the derived window:

```
first pass      window 180s   access back T+191.1s   outage 187.5s   ← missed the promise
re-run          window 150s   access back T+170.0s   outage 166.4s   ← fits
mechanism       the confirmation window expired, with no daemon in existence
```

**T+170.0 s against a 180 s promise.** The worst case — daemon dead, the deadline the only trigger — now
fits, by measurement rather than by reasoning about a constant. The first pass is kept here because it is
the evidence for why the window is derived from the budget rather than equal to it: the window was 180 s,
the revert took 11 s, and the device came back at T+191 s. The revert ran to completion with full
verification, every unit checked `active=true enabled=true` in its own journal.

### Scenario 3 — a hard reset inside the window

```
applied at       23:56:07   uplink pointed at a network that does not exist, window 150s,
                            NOT confirmed
hard reset at    23:56:07   sync; echo b > /proc/sysrq-trigger
board answered   23:56:55   48s after the reset
sweep found it              "found a transaction still inside its confirmation window at
                            start-up: this daemon did not survive the window"
revert completed            durationMs 4075, target previous-document
uplink restored             ssid="VINTAGE ", wpa_state=COMPLETED, addressed
```

Afterwards: all eight units `active` **and** `enabled`, all four interfaces up, only
`table inet wayfarer`, plan empty. The boot guards ran too — `rederive: 2 artefact(s) checked, 2
unchanged, 0 rewritten` and `check-routes: 2 address(es) checked, none captured`.

**The `sync` before the reset is deliberate, and it is what makes this a test of the right thing.** The
root filesystem is mounted `commit=120`; without the `sync` the transaction row itself might not have
reached the card, and the board would have come back with nothing to sweep — a failure attributable to
the substitute rather than to the design. The Ethernet lifeline was verified untouched before the reset,
so a board that came back and never reverted would still have been reachable.

*What it does not prove:* anything about losing voltage mid-write. A real plug-pull is one of the two
items that still need a person — see
[14-open-questions](14-open-questions.md#a-real-power-cut).

### The allowance is measured on every revert, not believed

Every revert records its own `durationMs`, and one that exceeds `REVERT_ALLOWANCE_MS` is reported at
`error` as eating into the promise, with both numbers in the event detail. It is **not** a failure — the
device is back — but the next revert on a slower device or a larger profile may finish after the promise
is already broken, and that is worth a line before it happens rather than after.

Measured, both comfortably inside the 30 s allowance: **4075 ms** (hard reset, via the start-up sweep)
and **2376 ms** internal, about 20 s since the deadline (transient timer). The judgement is made on time
**since the deadline** where there is one, not on the function's own duration: a revert that ran *before*
its deadline — an operator's revert, or the start-up sweep — is never called late for being early.

### The revert that stopped its own transient unit

Scenario 2b's first attempt, and the reason it is recorded rather than quietly fixed.

```
Started wayfarer-revert@bdea2a8355f810a3.service
  … two seconds later …
Stopping wayfarer-revert@bdea2a8355f810a3.service
Deactivated successfully. Consumed 2.550s CPU time.
```

The revert's first act is to disarm its own timer, and `stopTransient` stopped both the `.timer` **and**
the `.service`. When the revert runs *inside* that service — which is the only situation the transient
unit exists for — it stopped itself two seconds in. The transaction was left `reverting` for ever and the
uplink never came back.

It was invisible because every revert ever observed had run inside the daemon, where stopping a transient
unit the daemon is not in is exactly right. **The one path the mechanism exists for was the one path
nobody had run.**

The fix never stops the unit this process is running inside. The unit is read from `/proc/self/cgroup`
rather than passed as a flag, because the caller that most needs it is several layers from the platform
call that would kill it — and a flag threaded through those layers is one somebody will forget on the
single path that matters. The timer is always stopped; the service only when we are not it.

## Do not arm it before a reboot: a guard that cannot survive the event is a ritual

**The deadman's timer is transient, so it does not exist after a reboot.** `arm` creates it with
`systemd-run --unit=…`, and a transient unit is gone the moment the machine restarts. Arming before a
deliberate reboot therefore protects only the seconds before the reboot and then silently evaporates —
leaving the appearance of a guard and none of the substance. The on-disk armed record survives, which
makes it look worse than it is: a file saying "armed" and no timer behind it.

This is worth stating plainly because the instinct is so natural, and it was acted on here: arm the safety
net before the risky thing. **The question that instinct skips is whether the guard can still exist when
the risky thing is over.** For a reboot it cannot, and for anything that restarts systemd it cannot.

`OnBootSec` is what makes the deadman trustworthy *within* a boot — it cannot be deferred by a
`daemon-reload`, which is the defect that made an `--on-active` deadman postponable by the very applies it
guarded. The same anchoring is what makes it meaningless *across* boots: a deadline measured from this
boot has no meaning in the next one, and systemd does not carry the transient unit over anyway.

**So what actually guards a reboot?** A second path that does not depend on the thing being restarted. On
this bench that is the Ethernet lifeline, which every hardware verification here has used and which is
deliberately never reconfigured. A cold-start test is safe because the board comes back on Ethernet
whatever happens to the wireless configuration — not because a timer was armed beforehand.

The general form, which applies well beyond this script:

> A guard is only a guard if it outlives the failure it is meant to catch. Before arming anything, ask
> what state it will be in *after* the dangerous operation, not just before it.

And the corollary for the deadman specifically: **arm it for applies, not for reboots.** An apply happens
within a boot, which is exactly the window the timer covers.
