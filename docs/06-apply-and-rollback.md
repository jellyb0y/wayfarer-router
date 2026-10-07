# 6. Applying changes, and getting back

## Blast radius

Every plan is classified by what it can break. The class determines whether a
confirmation window is required, and it is computed from the plan, not declared by
the caller.

The classes are defined by **what they disturb**, not by which call is made. The
mechanism is the wrong axis, and defining them by it produces a false answer at once:
the proxy core cannot reload its configuration, so "reload the core" is not something
that exists. What matters to the operator is not the call but what stops working while
it happens.

| Class | What it disturbs | Can it cost the operator access? | Confirmation |
|---|---|---|---|
| `hot` | **Nothing restarts.** A running component is told something through its own API: the selected tunnel, a rule-set refresh. **Reachable, and measured — see below.** | No | No |
| `service` | Processes we own restart. Link layer, addressing and radios untouched; clients keep their association and their lease; the management session survives. | No | No |
| `network` | Links, addresses, radios, reachability. | **Yes** | **Yes, three minutes** |
| `boot` | Effective only after a reboot (link naming, kernel command line). | Deferred | Warning, plus a reboot prompt |

A single Apply can contain several classes; the plan takes the highest.

**Correction, and the reason the table above changed.** An earlier revision put routing
rules, DNS rules and rule sets in `hot`, on the stated basis that a `hot` change
"reloads the core's configuration and nothing else". The core has no configuration
reload — verified against the installed binary — so editing a routing rule rewrites the
generated configuration and restarts the core. That is `service`, not `hot`. `hot` is
therefore narrower than it was: the selector switch and a rule-set refresh, both of
which go through the running core's own API. Reordering a routing rule does restart a
daemon, and the interface should say so rather than promising it will not.

**`hot` is reachable as of the health watchdog, and this is what made it so.**

Choosing a different exit does not go through a plan. The watchdog reads the failover policy live and
points the core's selector through the core's own control interface, which the running core applies
immediately. Measured on the bench board, 2026-09-21: the selector moved from one tunnel to another
with `wf-core`'s `MainPID` unchanged, the `tun0` device unchanged and `NRestarts` at zero — nothing
restarted, and connections through the other tunnels were not disturbed.

The same measurement covers the fallback. With every tunnel broken, the selector moved to `block` —
the policy this profile chose — and again nothing restarted: `wf-core`'s `NRestarts` stayed at zero
across the whole sequence. That case is worth naming because it failed first: the fallback member was
not in the generated selector's member list when alternatives existed, so the core answered
`400 Selector update error: not found` every round and the device kept sending traffic through a
tunnel the watchdog had already judged dead. The generator now always lists the fallback as a member,
last. A failover mechanism whose fallback is unreachable is worse than one with no fallback, because
it reports a decision it did not carry out.

The classification followed without a special case. A profile edit that changes only the failover
order, the exclusions or the probe thresholds produces **no artefact changes at all**, so the plan is
empty and takes the lowest class by the ordinary rule. The one part still honestly absent is a path
whose *contents* a running component can be told about — a rule set, say — which nothing supplies yet,
so such a change is still `service`.

That remaining gap fails in the safe direction: `service` is a stricter class than `hot`, so nothing
is applied more readily than it should be. It is left as `service` rather than given a hot path with
nothing to talk to — which would be a feature that reports success without doing anything, the same
shape as a validation step that consumes no result.

What the interface must not do meanwhile is promise an instant switch. Reordering a routing rule and
selecting a different tunnel both restart a daemon today, and the plan review says so because it is
computed rather than declared.

Two rules that follow from the definitions and are not obvious from the table:

* **Restarting the access point is `network`**, even though nothing about addressing
  changes. "Clients keep their association" is part of what `service` means, and a
  radio restart breaks it.
* **Renaming the interface that currently carries the management session is `network`,
  never `service`.** A rename needs the link down, and a link going down is
  indistinguishable from losing the board.

### Correction: renaming is a choice, and it is off by default

An earlier revision had the planner rename every bound interface to a deterministic name of
ours — `wfap0`, `wfwan<n>`, `wfvpn<n>` — and pin it with a `systemd.link` file, for every
profile, unconditionally. That was confirmed as a decision without following through on two
consequences, and both are serious enough to change the behaviour rather than document
around it.

**A rename takes effect only at the next boot.** A `.link` file is read when the link
appears, so the name a profile spells out is not the name the device has until it restarts.
That made first-time setup on *any* device demand a reboot before the configuration it had
just been given became real — and in the meantime every generated artefact named an
interface that did not exist, so the units depending on it could not start.

**And the rename most likely to be wanted is the riskiest change in the system.** It is the
one on the interface carrying the operator's own session, which the rule directly above
classifies `network` for exactly the right reason.

What renaming buys is real and is kept: a `.link` file matched on the permanent address
means a unit file and a generated configuration keep referring to the same hardware after a
USB device re-enumerates, including before this daemon has run at all. So the scheme is
unchanged and the *trigger* moved: `pinName` is a field per role, **off by default**.

| `pinName` | Name used | `.link` file | Class |
|---|---|---|---|
| absent or false | whatever the kernel already calls the interface | none | no rename at all |
| true | `wfap0` / `wfwan<n>` / `wfvpn<n>` | written | `boot`, or `network` for the management interface |

A user who never wants a reboot gets a device that works. A user who wants deterministic
names asks for them and accepts a change that arrives through the confirmation window like
any other that can cost access.

**The practical consequence, which is the reason this is not merely a default.** Taking over
a device that already works is then **two transactions rather than one**. The first
reproduces what the device already does, under the names it already has, and is confirmed.
The second introduces the pinned names, with its own window and its own reboot. Bundling the
riskiest irreversible change together with the one that carries everything else means that
if the device does not come back, nobody can tell which half did it — and that is the
difference between a finding and a mystery.

The field is in [03-data-model.md](03-data-model.md); the one case where an unpinned role
still gets a generated name — a radio with no interface at all, where there is no current
name to keep — is reported as a note rather than silently pinned.

### The class is computed from what differs, not from which file was touched

**The fall-back is `network`.** It was `service` — the class that gets no confirmation window and no
revert timer — which reads as caution and is its opposite. The costs are asymmetric: a needless
three-minute window wastes somebody's time, a missing one can cost them the device. An unknown artefact is
by definition one whose blast radius nobody has reasoned about, which is exactly when the safety net
should be on. Unclassified paths are reported by `unclassifiedArtefactPaths()` rather than absorbed
silently.

`classifyPathExplicitly` returns `null` for anything it does not recognise and `classifyPath` applies the
`service` default on top, so **the fall-back is visible instead of indistinguishable from a deliberate
classification**. Every path predicate is built from `PATHS`. A test plans a full profile and asserts that
**no artefact it emits reaches the fall-back at all**.

The core configuration is the case that forces the rule. It holds both kinds of content in one document:
the tunnel inbound and its exclusion list decide whether a host on our own network can still get a reply
from us, while the outbounds and the rules between them decide only where captured traffic goes. So the
file cannot carry a class.

* `classifyContentChange` diffs the two documents to leaf pointers and asks whether any of them is a
  **reachability** pointer.
* `classifyUnitAction` does the same for units: starting `wf-firewall` when nothing was enforcing the
  ruleset is `network`; re-asserting an identical ruleset is `service`.

The tests are derived rather than written down: the **same profile** generated twice, differing only in an
exclusion (asserted `network`) and only in an outbound (asserted `service`), each with a guard that the two
fixtures really do differ — so the assertion cannot quietly become vacuous.

The supplicant configuration and `wf-supplicant@` are `network`: a wireless client owns a radio exactly as
an access point does.

#### Permission to narrow the fence comes from the fence, not from a reading — 2026-09-23

A change to the core's exclusion list (the fence) is softened to `service` when the only networks
moving are ones the device *follows* — a subnet a peer handed one of our tunnel interfaces. That is
right, and on the bench board it moved `10.164.0.0/20` to `10.164.96.0/20` for `wfvpnhq` without a
window. But the rule for a network **leaving** the fence was "not defended", and *defended* was read
from the interfaces at plan time. The acceptance tester reproduced, on the board's own before/after
configuration: with the uplink momentarily unaddressed — which is what an uplink flap is — its network
was on neither list, and the fence dropping it was also `service`. No window, no revert timer, and the
core's return path to the network the board is reached through gone. The bench board was saved only
because `end0` also held an address on `192.168.77.0/24`.

A reading a flap can empty cannot grant permission to narrow the fence. So the planner now writes
`/etc/wayfarer/fence.json` beside the core configuration — the followed networks and the interface
each was read from — and a network may leave the fence without a window only if **the running fence's
record** lists it as followed (and it is not defended now). Everything else leaves through `network`.

* The record is classed **with the fence** in `diff`, so a narrowed (`hot`/`service`) apply that is
  refused the fence is refused the record too; a record describing a fence that was never written
  would grant the next change a permission nobody earned.
* It is outside `core/` on purpose: the restart-cause net restarts `wf-core` for any changed path
  containing `/core/`, and the core does not read it.
* Absent or unreadable means no permission. **Deployment consequence:** until one ordinary apply has
  written the record, a follower move is classified `network` and the automatic re-derive (which
  applies only `hot` and `service`) is refused — the conservative direction. One ordinary apply after
  deploying (it is `service`: only the record is new) restores it.

Asserted in `test/fence-memory.test.ts` through the real planner and differ: the flap is `network`,
the flap plus a follower move is `network`, a follower move with the record is `service`, and with no
record or an unreadable one it is `network`.

#### A tunnel's network is followed in, and leaves lazily — 2026-09-23

Measured on the bench board: `corp` came up at 07:32:27 with `10.122.0.2/24` on `wfvpncrp`, after a
night down. The fence and `fence.json` had been written around 23:00, while it was down, and named only
`wfvpnhq` and `wfvpnprt`. Nothing re-derived; the drift check read `diverged` (8 findings) and would have
stayed red until somebody applied. The fence had moved once in the night only because a resolver changed at
the same moment and the resolver follower swept it along.

The follower (`core/device-follower.ts`) now has two subjects. Besides the captured resolvers it asks
whether every network on a tunnel interface — the reading the planner is given (`interfaceNetworks`), split
by the tunnel interfaces the last plan recorded — is in the running `route_exclude_address`. A missing one
is re-derived through the same narrowed (`hot`, `service`) apply of the last applied document, with the same
deferral to an open transaction, the same wake-up when a transaction ends, the same observer, and the same
classification: adding a followed network is `service`, so no window. The address watch that re-binds the
management interface also wakes it, so a network is followed in seconds; the minute's round is the backstop.

**Removal is lazy, and that is the part that bounds the restarts.** A core restart interrupts every
connection through the core, the owner's session included. `corp` failed every six minutes for nine
hours; hq has handed out `10.164.96.0/20`, then `10.165.0.0/20`, then the first again. So a network the
running `fence.json` records as followed is **retained** by every plan while merely absent — only while the
interface it was read from is still one of the plan's tunnel interfaces, and never one that is on an
interface now — and it leaves only when the core configuration is being rewritten for another reason
(`planDocument`: the derivation with the retained networks is kept when the running file differs from it in
nothing but values read off the device; otherwise the plan without them is used). A tunnel flapping with one
network costs one restart in all; one alternating between k networks costs k. The follower also re-derives at
most once a minute.

*Remove after a long settle* lost: it needs a clock and a memory of when each network went absent, which the
planner does not have and a restart loses, and whatever the settle, a peer alternating more slowly than it
pays a restart per alternation for ever.

**Drift and the follower answer "in step" by the same rule**, because the drift check plans through the same
`planDocument`: with `corp` down its retained network is expected, not a divergence. A network in the
fence that the record does not call followed is still reported. Asserted in
`test/follow-tunnel-networks.test.ts` through `followDevice`, the real `applyDocument`, planner, differ and
drift monitor.

**Corrected the same day, on the board.** The first build of this refused itself at 09:07:52:
`fence.follow-refused`, `config.json` and `fence.json` classed `network`. The rule above was right; the
classifier under it was not. `corp`'s own resource rule (`wf-guard-corp`) already names
`10.122.0.0/24`, and `onlyFollowedNetworksMoved` pooled every address in the reachability region into one
set, so the network entering the fence read as nothing appearing and nothing departing — and a change that
moved nothing was refused its softening. The tests had passed because their tunnel had no rule naming its own
network; the board's has. Appearing and departing are now computed **list by list**, and only the fence's own
lists may move under the softening: the exclusion list, and a rule sending addresses `direct`. Any other
rule's addresses changing stays `network`. Reproduced from the board's configuration and record, reduced to
a credential-free fixture, in `test/fence-board-shape.test.ts`.

**And the attempt that could do nothing opened a transaction.** The same start-up attempt was recorded as
`a36badb1d45169a9`: `apply`, blast `network`, committed with no deadline, opened by nobody, writing nothing
(mtimes and the `wf-core` PID unchanged). The recorded class was the whole plan's, not of anything performed.
A narrowed apply now records the class of what it performs — by the reconciler's own rule, so a restart whose
only causes are refused files does not count — and when nothing in the plan is permitted it opens no
transaction and answers `nothing_permitted`, which the follower reports as a refusal.

The boot re-derive (`way rederive`) plans through the same function, so by the code a boot no longer drops
the tunnel networks from the fence only for the follower to add them back as each tunnel connects. That is
read from the code, not yet observed across a reboot of the board.

#### A list position is not a reachability pointer — 2026-09-23

Removing the `russia` tunnel on 2026-09-22 moved its two outbounds, its one `domain_suffix` routing
rule, and its name in `wf-selector`'s members — nothing on the reachability list — and was classified
`network`. The cause was positional: removing one routing rule shifts every later rule down by one, so
the hq tunnel's `{ ip_cidr: ["10.0.0.0/8"] }` rule landed at an index that had held a rule without
addresses, and `/route/rules/6/ip_cidr` read as an address list that had appeared. Adding an outbound
above an address rule did the same.

`classifyContentChange` now reads the core configuration through `reachabilityView`: `/route/rules` is
reduced to the rules that carry an address (`ip_cidr`), in their order among themselves. A rule
without addresses leaves the view, so adding, removing or moving one cannot shift anything the
classification reads; adding, removing or reordering an address rule is still `network`. The same
change closed a gap the index shift had been hiding: removing the *last* address rule differs at
`/route/rules/N`, a pointer with no leaf in it, and was classified `service`. A differing pointer now
counts when the value on either side carries a reachability leaf.

#### The warning that named the management interfaces on every plan — 2026-09-23

*"This change reconfigures wlx90de8047b4b4, wfwan0, which is carrying the connection you are using
right now"* was attached to three applies on 2026-09-22 whose change set was one core file and a
`wf-core` restart. The condition asked whether any **desired** `.network` file named the interface —
true of every profile with an uplink or an access point. It now asks what the reconciler asks before it
runs `networkctl reconfigure` over every managed link: did a networkd file change, or is a takeover
planned. Asserted both ways in `test/blast-radius-shapes.test.ts`.

## The health round is bounded, and probes stay sequential

Probes are sequential and the round is bounded by the probe interval. Both halves are deliberate, and the
reasoning is here because the review's real finding was that it had never been written down.

**Why not concurrent.** Every probe leaves through the same uplink. Probing several tunnels at once puts
them in contention and inflates exactly the two numbers being measured — with a 500 ms median and a 250 ms
mean-deviation threshold, the measurement would start failing tunnels *because of the measurement*.
Sequential probing measures one path at a time, which is the only arrangement in which the numbers mean what
they say.

**Why the round is bounded.** The cost of sequential probing is that a round can outlast its interval, and
the alternative to bounding it is a cadence that stretches silently: a device whose links are slow checks its
tunnels less often than its configuration says, and nothing reports that.

So the round stops at the interval and records which candidates went unmeasured. Those are left **absent
from the health list entirely** — not recorded as failing — so nothing decides on them and their fail
streaks are neither advanced nor cleared. Incrementing would push an unmeasured tunnel towards being
switched away from; clearing would forgive real failures. Neither is evidence, which is the same rule the
confirmation window and the core-unavailable branch already follow.

The event is `health.round-incomplete`, and it is recorded **every** round it happens rather than only on a
transition. Unlike a tunnel's health this is not a steady state worth suppressing: a device where it is
normal is a device whose interval is too short for its links, and the repetition in the ring is the signal.

**A slow round therefore degrades the watchdog's coverage, visibly, instead of degrading its timing,
invisibly.**

## Apply order

Fixed, and derived from failures that are silent when the order is wrong:

```
1.  validate everything            (nft -c -f, core check, schema, invariants)
2.  write managed files            (atomic, same-directory temp + sync)
3.  network configuration          (then wait for it to settle)
4.  sysctl
5.  firewall                       (nft -f, one transaction)
6.  time synchronisation restart   ← after the firewall, never before
7.  access point                   (enable, then restart)
8.  DHCP                           (enable, then restart)
9.  tunnel transports              (listeners first)
10. tunnel daemons
11. proxy core                     (restart, not "enable --now")
12. verify                         (is-active AND is-enabled, plus a reachability probe)
```

The three entries with arrows earned their position:

* **Time before tunnels, firewall before time.** Timestamp-authenticated
  obfuscation protocols refuse a session when the clock is wrong, and on a board
  with no battery-backed clock the clock *is* wrong after any period switched off.
  Correcting it requires the time query to bypass the tunnel, which requires the
  firewall rule to exist first. Restarting the time service before the firewall is
  applied sends the first query into the tunnel, where it is lost.
* **Enable before restart.** A failing restart aborts the sequence; if enable has
  not run, the unit stays disabled and the fault only surfaces after a reboot.
* **Restart, not `enable --now`.** For a unit that is already running, `--now` does
  nothing, and a new configuration is silently not applied.

Verification checks `is-active` **and** `is-enabled`. Checking only the first
produces a device that works until it is power-cycled. The two are reported
separately rather than as one verdict, because a single boolean hides exactly the
fault the check exists for.

Verification covers only the units this apply was **allowed** to act on. A unit whose
change was refused has not been brought to its desired state by design, and verifying
it would report the refusal a second time as a failure — which makes every narrowed
apply look broken.

## We never share a namespace with anything else on the device

The rule, and it is worth stating next to the apply order because that is where it is
enforced: **the reconciler may only stop, restart or delete a unit whose name it
generated.** A unit it did not generate is not its business, ever.

* `wayfarer.*` — installed by the installer, never generated. The daemon itself.
* `wf-*` — generated by the planner and owned exclusively: `wf-core.service`,
  `wf-hostapd@<iface>`, `wf-dhcp@<iface>`, `wf-supplicant@<iface>`, `wf-openvpn@<tag>`,
  `wf-transport@<endpoint>`, `wf-socks@<tag>`.
* `wayfarer-revert@<txn>` — a **transient** unit, created by the transaction layer with
  `systemd-run` and never written to disk. It is the third case and it is stated
  explicitly rather than left as an apparent violation of the two above: it is not
  installed by the installer and not generated by the planner, the reconciler never sees
  it, and the reconciler's rule is unchanged — it still touches only `wf-*`. The
  transaction that armed it is the only thing that stops it. See "Why the revert timer is
  a separate unit" below.

The firewall is applied with `nft -f` after `nft -c -f`, from a file of ours, and it
deletes and recreates **only our own table**.

### The configuration rule, stated precisely

An earlier revision of this section said all generated configuration lives under
`/etc/wayfarer/`, "never in a shared include directory". That phrasing was too blunt, and
correcting it matters because taken literally it forbids something that is both safe and
necessary.

What the rule is actually protecting against is two things: **fighting another program for
the same file**, and **putting our configuration where a package reinstall will replace it
or where nobody can tell whose it is**. So:

> We never write a file another program owns, and never write where our file would be
> indistinguishable from theirs.

A uniquely named drop-in in a `.d` directory violates neither. A drop-in directory is
precisely the mechanism the system provides for a third party to add configuration without
collision: `10-wayfarer.conf` is unmistakably ours, it replaces nothing, and a package
upgrade of the program that reads it leaves it alone. Adopting that program's *main*
configuration file, by contrast, is exactly the accident the rule exists to prevent.

The one place this is used is the clock, and it is used because there is no alternative:
`systemd-timesyncd` accepts no configuration path on its command line, so IP-literal time
servers can only reach it through `/etc/systemd/timesyncd.conf.d/10-wayfarer.conf`. The
path is in the daemon's writable set for that reason, and **uninstall and factory reset
remove the file** — a drop-in left behind is the orphan the rule is meant to prevent.

Everything else generated does live under `/etc/wayfarer/`, and where a program supports it
its own include-directory scanning is disabled, so a stray file elsewhere cannot reach our
instance.

This removes a whole category of accident, including the one with no other defence:
adopting a distribution's unit for the same binary, and having the configuration
silently replaced by the distribution's own on the next package upgrade. It also means
the daemon's own writable-path list should *shrink* when the code stops needing a
path — see [16-implementation-notes.md](16-implementation-notes.md) for the three that
were removed once nothing wrote to them.

Two invariant checks enforce the same boundary before anything is planned: a **foreign
proxy core already running** is refused, naming the unit, because two cores contend for
the same tunnel device and ports; and an **interface another network manager already
configures** is refused, naming the file that claims it. Detection is all that happens
here. Taking an interface over belongs to the epic that has a confirmation window to
survive it going wrong, because writing a second claim leaves two sources disagreeing
and the one that wins is whichever ran last.

## A schema check is not a validity check

**This is a rule of the architecture, not a note about one field.**

The schema a binary emits describes the shape it can *parse*. It does not describe the
configuration it will *accept*: deprecations, removals and semantic refusals live in the
second set and are invisible to the first. The two diverge on every release, and they
diverge silently.

Measured, and it is the clearest possible form of the argument. A generated core
configuration satisfied the emitted schema, satisfied every fixture, and passed every
test in this repository — and the binary refused to run it:

```
$ sing-box check -c …/core/config.json
ERROR outbound DNS rule item is deprecated in sing-box 1.12.0 and will be removed in sing-box 1.14.0
FATAL to continuing using this feature, set environment variable ENABLE_DEPRECATED_OUTBOUND_DNS_RULE_ITEM=true
exit=1
```

Not a warning. The process exited.

Three things follow, and they apply to every foreign tool this project drives, not just
to the proxy core:

* **Every generated artefact is validated by the tool that will consume it**, before
  anything is started — `nft -c -f` for the ruleset, the core's own `check` for its
  configuration, `dnsmasq --test` for the address service. Validating against a schema
  is a cheap first pass, never the gate.
* **That validation is part of the apply order**, at step 1, because a configuration
  that will not parse must fail with the tool's own message rather than as a service
  that flaps.
* **A fixture cannot replace it.** Fixtures encode what we believed the tool accepts.
  The tool encodes what it accepts. When those disagree, the fixture is wrong and the
  test suite is green.

The same reasoning is why the generated configuration is checked on real hardware at
least once per epic rather than only in a test.

## A mock that answers what the real system would refuse

The companion failure, and it cost the same kind of time. Unit definitions were carried
in the desired state but never written to disk; `install` reloaded systemd for a file
that did not exist, and the `enable` after it failed with "Unit wf-firewall-ready.target
does not exist".

**Every test passed.** The recording stand-in for systemd answered `enable` with
success, because a stand-in answers what it was told to answer — and the question it was
never asked was whether the unit file existed. The fixtures were not merely incomplete;
they were *wrong in the same direction as the code*, which is the only kind of wrongness
a test cannot catch.

Two habits follow:

* **A stand-in must refuse what the real thing would refuse**, at least for the
  preconditions the code under test depends on. A stand-in that only records calls tests
  that the calls were made, which is not the same as testing that they would work.
* **An apply path that has never run has not been tested.** One real apply per epic, on
  hardware, with the safety net armed — even when the class is supposed to be safe,
  because that belief is exactly what wants testing.

## Transactions

```
                    ┌───────────────────────────────┐
                    │           staged              │
                    │  plan computed, not applied   │
                    └───────────────┬───────────────┘
                                    │ apply
                    ┌───────────────▼───────────────┐
                    │          applying             │
                    └───────┬───────────────┬───────┘
                  success   │               │  failure at any step
                            │               │
        ┌───────────────────▼──┐    ┌───────▼────────────────┐
        │  awaiting-confirm    │    │       reverting        │
        │  (network class only)│    │  re-apply previous doc │
        │  deadline = +150 s   │    └───────┬────────────────┘
        └───┬──────────────┬───┘            │
 confirmed  │              │ deadline,      ▼
            │              │ or early  ┌─────────┐
            ▼              │ failure   │ reverted│
       ┌─────────┐         │  detected └─────────┘
       │committed│         └───────────────┐
       └─────────┘                         ▼
                                    (reverting, as above)
```

`hot` and `service` classes go straight from `applying` to `committed`.

### The window is derived from the promise, not chosen

```
RECOVERY_BUDGET_MS     = 180_000   the promise: access back within three minutes
REVERT_ALLOWANCE_MS    =  30_000   reserved for the undo itself to run
CONFIRMATION_WINDOW_MS = RECOVERY_BUDGET_MS - REVERT_ALLOWANCE_MS = 150_000
```

The promise is **three minutes to be back**, not three minutes of window, and an earlier version set the
window equal to the whole budget — which guaranteed missing the promise in the one case the budget exists
for. Measured in scenario 2b: the window was 180 s, the revert took 11 s, and the device returned at
**T+191 s**. Re-run with the derived window it returned at **T+170.0 s**. See
[15](15-bench-safety-net.md#the-recovery-scenarios-measured) for both transcripts.

The test asserts the **arithmetic** — window plus allowance must fit inside the promise — rather than the
literal, so changing the budget cannot leave a window that no longer fits behind it.

### Four decisions about reverting, and why each is that way

**The revert target is the last successfully applied document**, not the one being installed. It is
device state derived from the transaction history rather than anything in a profile. Setting it from the
active profile, as an earlier version did, makes the revert target and the apply target the same
document — so a revert re-applies whatever just broke the device. On the very first apply there is no
target at all, so it is the built-in recovery profile, and that is recorded **loudly**, because a device
found running the recovery configuration must not be misread as a mysterious factory reset.

**One unconfirmed transaction at a time.** A second apply is refused, naming the transaction and the
seconds left. Two open windows mean two armed revert timers, and the second fires against a document the
operator has already abandoned, at a moment they have stopped expecting anything to happen.

**A health check may record a finding only on a positively observed failure, never on absent data.**
Enforced by a three-valued `Observation` type, so "I could not read it" is not representable as `false`.
The moment a probe is most likely to fail is *during an apply*. It no longer reverts at all — see
*Early revert* below for why.

**A revert does not move the active profile pointer.** The interface then honestly shows pending changes;
moving the pointer back would silently discard the operator's edit. The event ring and `way transactions`
say *why* there are pending changes.

### What counts as confirmation

An explicit action: the Confirm button in the interface, or
`POST /api/transactions/:id/confirm`.

**Not** the client merely reconnecting. That sounds attractive but it is wrong in a
way that matters: a change can restore the operator's own path while breaking
everyone else's, or restore the access point while leaving the uplink dead. A
human or an agent asserting "this is correct" is the signal, and it is what was
asked for.

The countdown is visible in the interface the whole time, and the remaining seconds
are in the SSE stream so a reconnecting client picks the countdown back up rather
than discovering it at second 179.

### Early revert — withdrawn, 2026-09-23

This section said: *waiting the full three minutes when the outcome is already known is needless
downtime, so the daemon reverts immediately when a check fails conclusively.* Two things were wrong
with it, and the second is the one that decided.

**The outcome was not known.** The uplink check compared `ip -j link`'s `operstate` with lower-case
`'up'`; `ip` prints `"UP"`. So every uplink on the bench board read as carrier-less, and every
unconfirmed windowed change with an uplink was reverted at 45 s whatever the uplink was doing.
Measured 2026-09-22: apply `6110779e063cfb9f` reverted 50 s after creation for *"the selected uplink has
neither carrier nor address after 45s"* while `wfwan0` was `UP, LOWER_UP`, associated at −28 dBm,
holding `192.168.77.8/24` — and the change was one core-configuration file and a `wf-core` restart,
which cannot reach a carrier at all. The tests passed because their stand-in snapshot was written in
lower case. The reading is now `linkCarrier` (`platform/parse/ip-json.ts`): the kernel's `LOWER_UP` /
`NO-CARRIER` flags first, `operstate` without regard to case after, and "not in the snapshot" is
unknown rather than down. And the checks judge **the change**: an uplink or access-point finding is
possible only when the plan acted on that component (`windowScopeOf` in `core/window-watch.ts` — a
networkd file, a takeover or a rename for both; the supplicant for the uplink; hostapd for the access
point).

**A check that reverts is a second deadline nobody reported.** `POST /api/apply` answered
`secondsRemaining: 148`; the check could act at 45 s (uplink), 30 s (access point) or the first
five-second tick (a failed unit). No number can honestly be reported for a revert that fires *if*
something is observed: 148 is false when it may act at 45, and the earliest moment it may act — the
first tick — is useless as a deadline. The deadline is a promise, so the check stopped being a
trigger:

* the checks still run, and a conclusive failure becomes a **finding** — code, sentence, and what was
  read (`wfwan0: operstate DOWN, flags NO-CARRIER,…, inet none`) — on the transaction's `reason` and
  as an `apply.window-finding` event;
* the window ends at the deadline the device reported, by the transient timer, or sooner only when a
  person asks (`POST /api/transactions/:id/revert`) — or when the daemon restarts, whose start-up sweep
  still reverts anything unconfirmed;
* the revert at the deadline folds the finding into what it records, so the record says what was
  read and not only that time ran out.

What this costs: a change that really breaks what it touched now stays broken until the deadline
instead of about 45 s. That is inside the promise — `CONFIRMATION_WINDOW_MS` was derived for exactly
this path, the deadline as the only trigger — and it is paid once per genuinely broken change. What it
bought, measured on this board, was four healthy changes destroyed and diagnoses sent the wrong way.
Asserted by `test/window-deadline.test.ts`: the uplink genuinely down, a change that did touch it,
every allowance at zero and ticks every 5 ms — the transaction is still `awaiting-confirm`, the timer is
still armed, and the remaining time is what was reported less the time that passed.

The checks still never trigger a *confirmation* — a working uplink does not prove the configuration
is what the operator wanted.

### Why the revert timer is a separate unit

Stated in [02-architecture.md](02-architecture.md), repeated because it is the
load-bearing part: an in-process timer dies with the process. If the daemon crashes
after applying a bad change, or the board loses power inside the window, nothing
would bring the device back.

So:

1. before applying, write the transaction with a full copy of the previous profile
   document and the deadline;
2. arm a transient unit anchored to boot:
   `systemd-run --unit=wayfarer-revert@<id> --timer-property=OnBootSec=<uptime+150>s
   way revert --txn <id>`;
3. confirmation stops that unit;
4. expiry runs `way` as a **fresh process**, which reads the transaction from the
   database and re-applies the previous document.

#### The anchor in step 2 is not a detail, and the first version was wrong

It was `--on-active=<window>`, which is the obvious spelling and which broke the promise
this whole mechanism exists to make.

`OnActiveSec` counts from the activation of the timer unit, and **`systemctl daemon-reload`
re-bases it to the moment of the reload.** The revert timer is armed in step 2, *before*
the reconcile begins, and the reconcile calls `daemonReload()` once for every unit it
installs. So a `network` apply postponed its own revert by the whole confirmation window,
once per installed unit — and the person it was protecting is, by definition, somebody
reconfiguring the network they are connected over.

It never fired late in testing because the tests that exercise the window install no units.

`OnBootSec` is measured from boot, which does not move, and a monotonic clock is right here
anyway: this board has no clock battery and its wall time can jump by days. **If
`/proc/uptime` cannot be read the arm is refused rather than falling back**, because the
caller treats a failed arm as "do not apply" — and a deadline that cannot be anchored is not
a deadline, it is a delay that anything can restart.

Verified on the bench board, 2026-09-21, with a real `network` apply: the armed timer sat at
`NextElapseUSecMonotonic = 1h 30min 39s` and was unchanged after three `daemon-reload`s, then
was cancelled by the confirmation. The general form of the mistake is in
[16-implementation-notes.md](16-implementation-notes.md#a-deadline-expressed-as-an-interval-from-activation-is-not-a-deadline).

#### The countdown the operator watches is a duration, not an instant

The transaction records `deadlineAt` as a wall-clock instant, which is the right thing to
store in a row a human may read later. It is **not** what the interface counts down from.
The device also reports `secondsRemaining`, and the page anchors that against its own clock
once, on arrival.

The reason is the same clock that made `OnBootSec` correct: an interface running in a browser
subtracting `Date.now()` from a timestamp produced by a device whose wall clock is days out
shows a countdown wrong by the whole difference — `0s left, undoing the change` on a device
that has not begun undoing anything. A duration means the same thing in both frames. The page
still never decrements a counter locally, because a backgrounded tab must tell the truth when
it is looked at again; it derives from a deadline, and that deadline is now in the frame it is
compared against.

**A countdown exists only while the window is open.** The row keeps `deadline_at` and
`fires_at_uptime_seconds` after a confirmation, as history, and `GET /api/transactions` derived a
countdown from any row carrying them — so, measured on the bench board 2026-09-23, it counted a
**committed** transaction down while the confirm response for the same transaction had said `null`.
Every surface now goes through `windowCountdown` (`core/transactions.ts`), which answers `null` in every
state but `awaiting-confirm`; `test/api-profiles.test.ts` asserts the confirm, the list and the view
agree. (`way transactions` in `cli.ts` still prints a wall-clock countdown for any row with a deadline;
it is the same defect and is left to that file's owner.)

And independently of the timer: **every daemon start looks for a transaction in
`awaiting-confirm` and reverts it.** This is the only thing that covers power loss
inside the window, and it costs one query at start-up.

Reverting is not an inverse operation. It is re-applying a document that is already
stored, through exactly the same planner and reconciler. That is the single largest
benefit of the whole-profile model: there is no second code path to get wrong, and
no partial-inverse to reason about.

## Dry run

Every mutating endpoint accepts `?dryRun=1` and returns the `Plan` without
applying. The interface uses this for the confirmation screen, so the operator sees
the diff — which files change, which units restart, the blast radius, and any
warnings — before anything happens.

Because the planner is pure, this is not a special mode with its own risks. It is
the normal path with the last step omitted.

## Validation before mutation

In order, cheapest first:

1. **Schema.** The profile document against its own schema; each tunnel's config
   against its provider's schema, which for native outbounds is the schema emitted
   by the installed core binary.
2. **Invariants.** Capability checks against the discovered hardware — see
   [12-hardware-invariants.md](12-hardware-invariants.md). This is where an
   impossible radio assignment is rejected with a sentence the operator can act on,
   rather than becoming a service that will not start.
3. **Cross-references.** Every tunnel referenced by policy and routing exists; no
   duplicate tags; no port collisions among local listeners; every required
   hardware role is bound.
4. **Foreign validators.** The generated core configuration through its own
   `check`; the generated ruleset through `nft -c -f`.
5. **Requirements.** Binaries the plan needs are installed, with a sufficient
   version.

A failure at any stage aborts before anything is written, and the message names the
field.

## Correction: a mixed plan is no longer refused whole

An earlier revision of this document said a mixed plan is refused whole, with the safe part available
only by asking for it explicitly. That was correct while the `network` class could not be applied at
all. It is now wrong in both halves, and the replacement is worth stating carefully because the
reasoning is what changed.

**A plan containing a `network` change is applied**, in full, inside the confirmation window. That is
what the window is for. There is nothing left to refuse.

**A caller that narrows to the safe classes gets the safe part and a named list of what was left out**,
and it *succeeds* rather than being refused. Refusing would mean a caller who wants only the safe half
has no way to obtain it, which was the point of offering the narrowing in the first place.

Two rules that follow, and the second one is subtle enough that it was got wrong first:

* **A window is armed only when a `network` change will actually be performed.** A caller that narrowed
  the network class away is not performing one, so arming a window would start a countdown for
  something that was refused — and if nobody confirmed it, the revert would undo the safe part that
  *did* apply.
* **The decision comes from what the plan *contains*, never from its highest class.** `boot` orders
  above `network`, so a plan that renames an interface *and* changes addressing classifies as `boot` —
  and `boot` needs no window, because nothing happens until the device restarts. Deciding from the
  highest class would therefore give the plan most in need of a window no window at all. The highest
  class is the right thing to *show* an operator and the wrong thing to make a safety decision from.

## A restart whose every reason was refused is not performed

The third rule that follows from narrowing, and the one that had to be learned from an incident
rather than deduced from the other two.

**The symptom.** Six times in a row `wf-core.service` was restarted with a configuration file whose
rewrite had been refused, and the caller recorded success every time. Each half was right on its own:
the refusal named the file and its class, systemd answered `done`, and the step was reported honestly
as a restart that succeeded. Nothing joined them. The restart *did* happen — it simply did not do the
thing it was in the plan for, and the next plan, reading the same unwritten file, planned it again.

**The join.** A unit change carries `becauseOf`: the file paths whose change is why the restart is in
the plan. Paths and not a flag, because a refusal is per path, so a path is the only key the two
sides share. A boolean would say a restart has reasons and leave the reconciler unable to ask whether
*those* reasons survived.

> **A step is skipped when `becauseOf` is present, non-empty, and every path in it was refused.**

**All, not any.** A restart may have been planned for a second file in the same apply that *was*
written. Skipping on one refused cause would leave that file on disk and never in force — the same
defect with the sides swapped, reached by the route that looks more careful, because "any" skips more
and skipping reads as caution.

**Absent means "not recorded", never "no causes".** A step with no `becauseOf` is never skippable,
however much was refused around it. The case is a real one and not a formality: a unit that is
**down** is started because it is down, not because a file changed, so it carries no file cause at
all — and a unit that is down still has to be brought up. An empty list is read the same way as an
absent one, because `[].every(…)` is `true` and an empty list read as a set would make a step vanish
for the reason that it had no reasons.

**A skip is reported as a refusal, not as a step that failed.** A step reporting failure says "I
tried and it did not work", and that did not happen; a report of an attempt that was never made is
the same kind of untruth this mechanism exists to remove, arriving from the other side. The apply
already has one channel for what it declined to do, and the skip goes there rather than inventing a
second way to say one thing. It is also the difference between a caller that can act and one that
cannot: a refusal names the files and what they need, so a script can re-run with wider classes,
while "the step failed" tells it nothing — nothing said there was anything to succeed at.

**Verification is deliberately unchanged by this.** A restart is planned only for a unit that is
already running, so a skipped restart leaves a unit that is active and enabled, and verification says
so truthfully. It reports the unit's state, not the freshness of the configuration behind it; the
refusal is where "written, and not in force" is said.

**One measurement, recorded because it is invisible from a green suite.** The `becauseOf` list can
be absent or non-empty and never empty — the differ plans a restart only once a cause has been found
— so the guard that treats an empty list as absent is unreachable from any plan the differ produces.
Measured 2026-09-21 by deleting it: the whole daemon suite stayed green. It is now proved instead
against a plan assembled by hand, which is not a contrivance — a `Plan2` is what the reconciler
accepts, and the contract is about plans assembled anywhere, including ones written later by
something that does not track causes at all.

## Every generated artefact names the unit that loads it

A rule of the architecture, and it exists because of a fault that every check we had was structurally
unable to see.

The firewall ruleset was generated, written atomically, compared by the differ, classified, and shown
in the plan review — and **nothing ever loaded it**. There was no unit running `nft -f`, and
`wf-firewall-ready.target` was an ordering marker with no dependencies. So a device that had applied a
profile and then been power-cycled had no kill-switch, no IPv6 rejection, no management-port rules and
no time-sync bypass, while every file on disk said otherwise.

The `is-active` **and** `is-enabled` discipline could not catch it, because that discipline starts from
units and this fault was a *file with no unit*. So:

> **Every generated artefact declares what consumes it, and the planner refuses to emit one whose
> declared consumer it did not also generate.**

Three kinds of consumer, because not every artefact is read by a unit of ours and pretending otherwise
would make the check a formality: a `wf-*` unit (checked against the units in the same desired state),
an external program named so a reader can go and look (`systemd` for unit files, `systemd-networkd` for
`.network` and `.link` files), or a person (the directory README, and nothing else).

An orphan artefact is a file documenting an intention the system does not have, and a plan review that
shows it makes the lie more convincing rather than less. The check is an **error**, not a warning.

It found a second instance on its first run, which is the argument for having it: the core
configuration was generated on every device while `wf-core.service` was generated only when a tunnel
was enabled. The fix was to start the core rather than to stop writing the file, because the file was
right and the gate was wrong — **the core is this device's resolver**, since the generated address
service runs with `port=0` and hands clients DHCP option 6 pointing at the device itself. Gating it on
tunnels meant a tunnel-free access point whose clients got a lease and could not resolve a name.

The consequence, now true on every device rather than only ones with tunnels, and worth knowing before
somebody meets it while debugging something else: **with the core stopped there is no name resolution
for clients.**

## Restoring a file is not restoring an effect

A rule of the architecture. It stands on its own reasoning, which is set out below; the incident once
cited for it turned out not to demonstrate it, and the correction is recorded at the end of this
section rather than quietly removed.

Taking an interface over moves the claiming file aside, and the revert puts it back. That is correct and
it is **half** of the undo. The other half is the *effect*: the manager we displaced had already lost the
radio, its own generated files live in `/run` where only it regenerates them, and its supplicant was not
going to recover on its own. So the files said the device was configured and the device was unreachable —
which is worse than either being true alone, because it is the state in which nothing looks wrong.

> **Any change whose consequence lives in another program's running state needs two undos recorded, not
> one: the file we moved, and the action that restores the effect.**

The transaction's takeover record therefore carries both — the paths, and the **manager** whose
configuration has to be re-applied. A record with only the paths is a record that cannot complete the
undo it exists for.

### Why running another manager's reload is not a breach of the namespace rule

The rule exists to stop us **adopting, owning or fighting over** another program's units and
configuration. Running the command that manager publishes, in order to complete our own undo of our own
change, is none of those: it is the difference between managing somebody else's system and putting back
what we moved.

That argument only holds while it cannot grow, so it is constrained on five sides:

* only ever while **reverting a takeover we performed** — never in a forward apply;
* only the command that manager publishes, from a **closed table** in the platform layer keyed by the
  manager we displaced, which a caller cannot add to;
* bounded by a **timeout**, because the situation it runs in is one where the device may already be
  unreachable and a hung command would consume the confirmation window;
* **recorded** in the transaction and the event ring: which command, its result, and whether the fallback
  was used;
* and on failure or absence, it **falls through to a reboot** — the one thing that reliably makes another
  manager's configuration take effect again, because that is how it took effect in the first place.

A revert that put the files back and left the running state broken is the worst of both outcomes. A
reboot is a blunt instrument and it is the correct last resort.

## A change that touches the interface the request arrived on must say so

The daemon knows which interface a request came in on. When a plan reconfigures that interface — moves a
radio's role, renames it, changes its addressing — the plan review says so **first**, before the list of
changes, because it is the one line that changes what the operator should do before pressing anything.

It is in the API response as `affectsManagementInterfaces` as well as in the human-readable diff, so a
script can act on it rather than pattern-matching on English.

This is a product feature rather than a note in a test procedure, and the distinction is the whole point:
the warning exists for the operator who is about to lose the only means of answering the confirmation
prompt the device is about to show them. A confirmation is a human act, so a change that removes the
human's ability to act is a change that will always be reverted — correctly, and expensively.

Three ways a plan can reach such an interface, and all three count: a rename of it, a `.network` file
that configures it, and a **unit instanced on it** — an access point started on the interface currently
carrying a client association takes that association with it, which is precisely the change that cost
this project a locked-out board.

### The rule's own argument

A revert that puts the files back and leaves another program's running state broken has produced the
worst available outcome: a device that looks correctly configured, is unreachable, and reports nothing
wrong. That is the argument, and it does not need an incident to support it — a file is a description
and an effect is a state, and putting a description back does not re-run whatever read it.

Two consequences worth stating separately, because they are the same rule seen from each end:

* **Restoring a file is not restoring an effect.** The manager we displaced has already lost the radio;
  its own generated files live in `/run`, where only it regenerates them. Putting our moved file back
  gives it a description it is not reading.
* **Displacing a file is not displacing an effect.** Measured on the bench board, 2026-09-20: a
  takeover moved `/etc/netplan/20-wifi.yaml` aside and asked netplan to re-apply, and netplan then
  started `/sbin/wpa_supplicant -c /run/netplan/wpa-wlan0.conf -iwlan0` from a generated runtime file
  the moved-aside source no longer backed. The claiming file was gone and the claiming *program* was
  running. A takeover that only moves files is a takeover that leaves a competitor on the hardware.

## Nothing compared the running configuration with the stored one

Added 2026-09-22 as `G1`. Every mechanism above is about *making* a change safely. None of them ever
asked the question that comes after: **is this device still doing what the profile says it should
be?**

The audit that opened Epic G found no comparison at any moment. Not at boot — `core/boot-guard.ts`
re-derives the artefacts marked `environmentDependent` and looks at nothing else, and `way rederive`
compares those against `lastAppliedDocument()` rather than against the stored profile. Not after an
undo — the undo deliberately leaves the profile pointer where it is, so afterwards the stored document
and the running one are *expected* to differ, and nobody was told. Not periodically — the daemon ran a
resolver watcher and a confirmation-window watcher and no third thing.

A comment in `core/apply.ts` argued the gap was covered, because "the interface honestly shows pending
changes". It does not: that indicator is `apps/ui/src/lib/draft.ts` comparing a **draft being edited**
with the stored document. It is about unsaved work and says nothing about the files on disk. The
comment is part of what hid this.

### What it cost, measured

* **2026-09-22.** `profile.firewall.blockedEndpoints` held six entries while
  `/etc/wayfarer/core/config.json` held none. An unrelated transaction's window had expired and the
  undo — which was correct, and was investigated and cleared — took the change with it. The only way
  to learn this was to read the file and the database by hand.
* **2026-09-21.** The core kept asking `10.184.40.5` while the daemon had captured `10.184.100.5` to
  `/run/wayfarer/tunnel/hq.dns`. `wplan.hq.lan` stopped resolving for every client on the
  network, the tunnel was healthy throughout, and nothing reported the mismatch.
* **2026-09-22, found in passing.** `route_exclude_address` still listed `10.164.0.0/20`, a subnet the
  hq tunnel had left for `10.165.0.0/20`, so the exclusion protected nothing and the network
  actually in use was not excluded at all.

### The check

`core/drift.ts`. It re-derives from the **stored profile** — the active profile's document, through
the same `planDocument` every apply and undo uses — and compares the result against the files on disk,
the units systemd reports, and the sysctl keys the plan sets. A difference is a finding naming the
file path, the JSON Pointer **inside that file** when both sides parse as JSON, and **both values**.
The unit findings carry the differ's own `becauseOf`, so a unit reported stale says which file went
stale rather than sending somebody to read every file it consumes.

**It does not compare against `lastAppliedDocument()`.** That records the full intended document even
when the apply narrowed what was reconciled (row `G4`), so it can name a document the device never
fully ran, and a baseline that may be fiction cannot answer a question about reality.

**It does not look at pending interface renames.** The `.link` file is an artefact we write and it is
checked; the kernel applying it is a boot event, and calling a device that has not rebooted yet
"diverged" would make the check permanently red for a reason nobody can act on except by rebooting.

It runs at the three moments the audit found empty:

| Moment | Where | Why there |
|---|---|---|
| Boot | `index.ts`, after the unconfirmed-transaction sweep | The sweep may have undone something; the answer wanted is about the configuration the device settled on. A file edited while the daemon was down shows up here and nowhere else |
| After an undo | `core/apply.ts`, on the success path, the failed-undo path and the nothing-to-go-back-to path | The moment the two are most likely to differ, and the one place nothing ever asked |
| After every apply that opened a transaction, and after every confirm | `core/apply.ts`, `applyDocument` and `confirmTransaction` | Added 2026-09-23: the follower fixed the resolver 4 s after start-up and `/api/drift` served the boot-time red for fifteen minutes |
| Every 15 minutes | `index.ts`, `setInterval` | Below |

**Every report is stored in `device.last_drift`**, stamped with the boot id and uptime, and `/api/drift`
serves the newest one whichever process made it — including a hand-run `way drift` (`reason: operator`),
which until 2026-09-23 called the comparison directly and stored nothing: it said `diverged` at 22:13
while `/api/drift` said `converged` until the periodic round at 22:18. Before 2026-09-23 the timer's `way revert` wrote its
report only to the event ring and the daemon kept serving a finding the revert had resolved. `way` and
the daemon plan through one constructor, `core/device-pipeline.ts`: the CLI's hand-built context left
out the captured resolvers, so `way drift` reported `/dns/servers/3/server` and `wf-core` out of date
while the daemon said converged — two answers from one device to one question.

**Fifteen minutes, and the number comes from the fastest divergence this device can produce on its
own.** Measured on the bench board, 2026-09-21: one OpenVPN peer reconnected six times in forty
minutes — about seven apart — handing out a different resolver and a different transfer subnet each
time. The resolver follower (`core/resolver-follower.ts`) compares captures with the core's file every
minute and on every capture event, waits for an open transaction rather than giving up on it, and
re-derives at most once a minute, so this is not the mechanism that catches it; it is the backstop for
the case where the follower's write was refused, silently changed nothing, or never ran. A backstop must be slower than the thing
it backs up or it competes with it, and fast enough that a divergence is never more than a coffee
break old.

**Nothing here does wall-clock arithmetic.** This board has no RTC battery. The age of a report comes
from `performance.now()`, the schedule is a `setInterval`, and both count on the monotonic clock. The
ISO instant on a report is for a person reading it and is never subtracted from anything.

### Report, never repair — decided, not defaulted

The check has no side effect on the configuration and is not permitted one. Three reasons, in order of
weight:

1. **A device that silently re-applies performs a change nobody ordered.** This project has already
   suffered that twice: an automatic re-derive that applied a whole staged plan nobody asked for (row
   `G3`), and a narrowed apply that recorded a document in full (`G4`). Repair would be a third
   instance, on a fifteen-minute cadence, with no confirmation window behind it.
2. **Re-applying destroys the evidence.** Whatever caused the divergence would be papered over on
   every round and never investigated. The first divergence this check reports is worth more as a
   question than as a silently corrected file.
3. **Repair is an apply, and an apply is a thing a person asks for.** Every safeguard above — the
   window, the armed transient unit, the start-up sweep — exists because a change to this device can
   cost access. A repair path that skipped them would be the one apply on the device with no way back.

The `hint` on every finding says what to do, and the action is the ordinary apply.

### What it costs

Measured 2026-09-22 with `apps/daemon/test/drift.test.ts`, on a development machine, with the
inventory and the device reading supplied by the bench: **2.1 ms per round**, and nothing retained
between rounds (−11 KiB across twenty rounds under `--expose-gc`, which is the collector's noise
rather than a figure). That is the part this change adds: generating the desired state from the stored
profile, diffing it, and wording the differences.

**What that measurement does not cover, stated rather than implied.** On the board the round is
dominated by the two readings it shares with every plan — `collectInventory` (which shells out to `iw`
and `ip`) and `collectReality` (one `readManaged` per generated file and one `systemctl show` per
unit). Those are not new work introduced here; they are what a plan already costs, and a plan already
happens on every dry run and every look at the plan review. No figure from the H618 is recorded here,
because none was taken: the bench board was not touched for this change. Four rounds an hour of the
same work a plan review does is the claim being made, and it is the one to re-check if the periodic
round ever shows up in the journal as slow.

### Where the answer appears

* `GET /api/drift` — the report whole, with both values on every finding. `report: null` means the
  check has not run once, and is declared in the response schema so it reaches the client as null: a
  key a schema does not name is dropped from the body with no error and no log line, and the
  reassuring reading of a missing key is "nothing diverged".
* The Status screen — a panel beside the verdict, drawing each divergence with the pointer, what the
  profile derives, and what the device holds.
* The event ring — `config.diverged`, `config.converged`, `config.unreadable`, `config.no-profile`,
  with the findings in the detail. **Recorded only when the answer changes**, not every round: a
  device left diverged is the normal state after an undo, and the same entry every fifteen minutes is
  a ring that has evicted the reason for it.
* `way drift [--json]` — the same comparison from the operator CLI, non-zero on a divergence *and on
  a check that could not be made*, because a caller reading only the exit code must not learn
  "healthy" from "I could not look".

### A value read off the device is compared as a reading, and a key is never printed

Added 2026-09-23, from a report that was red on a device that matched. `ManagedFile` carries two marks
the generator sets, because the generator is the only code that knows what it wrote:

* **`observed`** — JSON Pointers whose value was read off the running system when the file was generated:
  the core's `route_exclude_address` and its direct `ip_cidr` rule (the networks on the interfaces) and
  each dynamic tunnel resolver (the capture). A list marked `unordered` is compared **as a set**. Measured
  on the bench board, 2026-09-22: the report said `/inbounds/0/route_exclude_address/3` differed — "the
  profile derives 10.164.0.0/20 and the device holds 10.136.0.0/24 (and 4 more)" — about a file written seconds
  after an apply from that very profile. The derivation followed the kernel's address order, which changes
  whenever a tunnel's interface is recreated, and the comparison went by index. The generator now puts
  those networks in one canonical order, and a real change is one finding at the list, saying what a
  derivation now would **drop** from the fence and what it would add. Proved in `test/drift.test.ts`.
* **`credentials`** — the file's contents are credentials (`.ovpn`, its `.auth`, the obfuscation entry
  point, the external VLESS client, `hostapd`, the supplicant). A divergence names the file, and for JSON
  the pointer, and withholds every value and every line. `catalogue-secrets.test.ts` and
  `planner-golden.test.ts` fail if a credential lands in an unmarked file. Row G12.

### The states are four, and three of them are not "fine"

`converged`, `diverged`, `no-profile`, `unreadable`. The last is the one worth naming: a check that
threw is not a device that matches. Collapsing it into `converged` would be the same defect as the
optional `core` argument that made two invariant checks unable to fire — where absence is defined as
the permissive answer, the only possible symptom is a check that never fires.

## The record of an undo must not live inside the thing being undone

A second rule, next to the one above because it is the same mistake seen from a different angle: the
first is about restoring the wrong *half* of a change, this is about not being able to restore at all.

> **Wherever the means of recovery is stored in the same place as the state being recovered from,
> there is no recovery.**

Measured on the bench board, 2026-09-21, in the one operation with no undo. A takeover records what it
moved aside in the transaction table so a revert can put it back. A factory reset **deletes the
transaction table** — so it asked our own records which files to restore, was told none, and left
another program's configuration displaced for good. The reset completed every step successfully. The
records were empty at precisely the moment they existed for.

The fix there was to stop asking the records: moved-aside files are found by scanning the directories
for the suffix, which is evidence that survives because it lives on the thing itself.

Two other places this shape appears, both checked:

* **The bundle rollback.** The previous bundle is kept as a copy beside the current one, which
  survives an update because the update writes a different filename. But `keep_previous_bundle` used
  to overwrite that copy unconditionally — so a second attempt, after an installer that was
  interrupted, would save the **broken** bundle over the last known-good one and leave nothing to go
  back to, exactly when a second attempt is being made because the first went wrong. It now refuses to
  replace an existing rollback copy and says why.
* **Safe mode.** Its applied document is recorded as a committed transaction rather than being applied
  silently, so `lastAppliedDocument()` — which is the revert target of every apply that follows — names
  the rescue rather than the configuration the device was rescued from.

The question to ask of any recovery mechanism: *if the thing I am recovering from destroys its own
surroundings, does the instruction for recovering survive?* If the answer is "it is in the database",
it does not.

### Correction: the incident this rule was first attributed to

**The rule is right and the story attached to it was wrong.** This section previously said the rule had
been learned from a revert that did everything the design said and left a board unreachable anyway,
and it counted the cost as "a person at a keyboard, twice".

Re-reading the evidence — the event ring and the transaction row, which had been on the card the whole
time — the revert in that incident **completed successfully, in 95 seconds**. The takeover it was meant
to undo had never taken effect: it failed with `EROFS` because `/etc/netplan` was missing from the
daemon's `ReadWritePaths`, so there was no displaced manager and no second undo to perform. The board
was unreachable for an unrelated reason: the generated core configuration did not exclude the network
the management session arrived on, so the tunnel captured the reply path.

Two facts were joined by an unchecked causal claim: the revert ran, and the device was unreachable.
Both were true and neither caused the other.

What the corrected record costs is the *evidence* for the rule, not the rule. The reasoning above is
the reason it exists. The missing-writability defect produced the `paths-writable` check, and the
missing exclusion produced the boot re-derivation guard — each recorded where it belongs rather than
borrowed as support for this one.
