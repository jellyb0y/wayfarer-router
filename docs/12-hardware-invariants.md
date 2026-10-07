# 12. Hardware invariants

Facts measured on real hardware that the planner must enforce, so that an
impossible configuration is refused with an explanation instead of becoming a
service that will not start.

The rule throughout: **discover, do not assume.** Every value below is read from the
driver, the kernel or the regulatory database at runtime. None of it is a constant
in the source. The numbers quoted are what was observed on the development hardware
and are there to explain *why* the check exists.

## Radio

### One radio cannot be an access point and a client at the same time

`iw phy` reports valid interface combinations. Measured on the development board's
built-in radio (`iw` 6.9, kernel 6.18.49-current-sunxi64, 2026-09-19) — one
combination, printed across two lines:

```
#{ managed, AP } <= 1, #{ P2P-client, P2P-GO } <= 1, #{ P2P-device } <= 1,
total <= 3, #channels <= 2
```

An earlier revision of this document recorded this as `#{ managed, AP } <= 1,
total <= 2`. The group limit was right and the total was not: the driver allows three
interfaces in total, two of them channels, provided at most one is managed-or-AP. The
wrong reasoning was reading the group limit as if it bounded the whole combination —
worth keeping because it is the mistake this check exists to prevent, one line higher
up.

What matters is unchanged and is the group limit: managed and AP share a budget of
one. This is a hard limit, not a policy. An access point plus a Wi-Fi uplink requires
**two separate radios** — typically the built-in one plus a USB dongle.

**Check:** if the same physical radio is bound to both an access point and a
`wifi-sta` uplink, reject, naming the combination string from the driver, and suggest
either a second radio or an Ethernet uplink.

### Some radios can host both roles, but only on one channel

A USB Wi-Fi 6 dongle observed on the same board publishes **two** combinations, and
only the second one permits an access point (measured 2026-09-19):

```
#{ managed, P2P-client } <= 2, #{ P2P-GO } <= 1, #{ P2P-device } <= 1,
total <= 3, #channels <= 2
#{ managed, P2P-client } <= 2, #{ AP } <= 1, #{ P2P-device } <= 1,
total <= 3, #channels <= 1
```

The access-point combination is the one limited to `#channels <= 1`. Two consequences
for the code: a radio's capability is the union of its combinations, so a check must
find the combination that satisfies the requested roles rather than reading the first
one; and both limits arrive on a *continuation line* indented with spaces rather than
tabs, so a line-by-line parser reports no channel limit at all.

So access point and client on that one radio must share a channel. The client
follows whatever channel the upstream network is on, which means the access point
does too — and the upstream can change channel without asking.

**Check:** this configuration is allowed **only** when the driver reports it is
possible, and **only** with an explicit acknowledgement in the profile
(`accessPoint.acceptChannelFollowsUplink`). Without that flag the planner refuses
and explains why. With it, the access point channel field is ignored and the
interface shows that the channel follows the upstream network.

Refusing outright was considered and rejected: it would make a Wi-Fi uplink
impossible for anyone with a single capable dongle, which is a common way to build
one of these.

### Scanning breaks an access point on the same radio

A scan requires the radio to leave its channel. Clients notice.

**Check:** a scan request for a radio that currently hosts an access point is
refused, with the reason. If the profile has a second radio, offer that one.

### Capabilities must come from the driver, never from a table

An access point configuration that claims capabilities the driver does not have
simply fails to start. Observed on the built-in radio: VHT capabilities `0x01b07031`
— 80 MHz supported, 160 MHz and 80+80 not. Another radio on the same board has a
different set.

**Check:** band, channel, width and the capability list are derived from `iw phy` for
the bound radio. The interface only offers what is supported. An empty capability
line is omitted from the generated configuration entirely, because an empty value is
a syntax error rather than a default.

### The regulatory domain gates channels and power

Read from `iw reg get`; it can also change at runtime, because some drivers accept
regulatory hints from the surrounding cellular network and others ignore them.

Two things about that output, both measured on the development board (2026-09-19),
both of which change the answer rather than the formatting:

* **There is a global block and per-radio blocks, and a radio's own block wins.** The
  global block reported `country US: DFS-FCC`; the built-in radio reported
  `country 00: DFS-UNSET` — a different channel set and a different power limit.
  Reading only the first block applies US limits to a radio the kernel is treating as
  world-domain.
* **A radio can be missing from the output entirely.** The USB radio did not appear at
  all, while it existed, was up, and was hosting an access point. Absence means it
  follows the global domain, so a lookup must fall back rather than report that the
  radio has no domain.

Observed for one domain: 5150–5250 MHz permits 80 MHz at 23 dBm but is indoor-only
and has no radar requirement; 5250–5350 and 5470–5725 require radar detection;
5725–5875 is limited to 13 dBm.

**Check:** the channel list offered comes from the driver's current view of the
regulatory domain. Radar-requiring channels are only offered when the driver
advertises the capability. The interface shows the power limit for the chosen
channel, because the difference between 23 and 13 dBm is the difference between good
and unusable coverage.

### `iw dev … info` does not report transmit power on this USB radio

The access point on the USB radio (MediaTek MT7921AU, `0e8d:7961`, driver `mt7921u`,
kernel 6.18.49) reports `txpower 3.00 dBm` from `iw dev <ap> info` while the same radio's
`iw phy` lists the channel at 23.0 dBm and `hostapd_cli status` says `max_txpower=23`.
The 3 dBm is not a measurement and not a setting. It is a constant.

Measured on the development board, 2026-10-01, channel 36, 40 MHz, `country DE`:

* `/sys/kernel/debug/ieee80211/phy0/mt76/txpower_sku` — the per-rate table the firmware
  actually applies — shows `tmac` 38 (19 dBm) for HT/VHT/HE MCS0–4, down to 26–29
  (13–14.5 dBm) for HE MCS10–11. The `user` row is `N.A` throughout, so no limit is in
  force; the ceiling is the dongle's own EEPROM calibration, about 4 dB under what DE
  permits on this channel.
* `iw dev <ap> set txpower fixed 300`, `fixed 1500` and `auto` changed nothing: the
  `txpower_sku` table stayed identical, `iw` kept saying `3.00 dBm`, and a stationary
  client 3 m away kept reporting −55…−64 dBm through all three (and −59…−55 dBm,
  median −57, over 36 samples in two minutes with no commands at all).
* Why: in `mt76_get_txpower()` the value is `(phy->txpower_cur + nss_delta) / 2`, and
  nothing in the mt7921 code path ever writes `txpower_cur`, so with two chains it is
  always `(0 + 6) / 2 = 3`. The mac80211 of this kernel no longer passes a requested
  power through `IEEE80211_CONF_CHANGE_POWER` at all (it warns if anyone tries); it goes
  per link via `BSS_CHANGED_TXPOWER`, which this driver does not handle. `iw set txpower`
  is therefore a no-op here, in either direction.

**Consequences.** The `txPowerDbm` the inventory takes from `iw dev` must not be shown
as the power the access point runs at, and must not be compared against the channel's
regulatory limit as if it were — the comparison would always say the radio is 20 dB
under what it is allowed. The number that means something is the regulatory limit from
`iw phy` and, where it exists, the `txpower_sku` table. Range on this dongle is bounded
by its calibration, not by a setting that can be raised.

### Antenna separation is a physical constraint, not a setting

Measured on hardware: moving antennas apart raised throughput from 160 to 205 Mbit/s
while the signal strength stayed at −54 dBm and the modulation index went from 9 to
10. The gain came from decorrelating the paths, not from more signal — which is how
multiple-antenna radios work, and why a stronger signal is not the metric to chase.

Separately, a front-end band filter passes the whole 5 GHz band and the channel
filter sits after the amplifier, so two antennas close together on *different* 5 GHz
channels can still desensitise each other.

**Not a check** — nothing in software can measure it. It belongs in the interface as
guidance on the radio page, and it is the reason the diagnostics page shows
modulation index and negotiated rate rather than only signal strength.

### Retry counters are not universally implemented

One driver reported zero transmit retries across 18 000 packets at −89 dBm, which is
not physically possible. The counter is simply not populated.

**Check:** treat a zero retry count as "unknown" unless a non-zero value has been
seen from that interface at least once. Never draw a conclusion from it alone.

## Interface naming

### At most 15 characters

The kernel limit. A generated name that exceeds it is rejected at creation.

**Check:** validate generated interface names before emitting them.

### No hyphen in a name used in a systemd template instance

systemd escapes `-` as `\x2d` in unit names. A template instance for an interface
called `wlan-ap` refers to a device unit `sys-subsystem-net-devices-wlan-ap.device`,
while the unit that actually exists is `…-wlan\x2dap.device`. A `BindsTo=` dependency
then never resolves and stops the service immediately — with no useful error.

**Check:** generated names contain no hyphen. Enforced where the name is generated,
not where it is used.

### A radio's own MAC address is not readable from the radio

Measured on the development board: `/sys/class/ieee80211/phy1/macaddress` reads
`00:00:00:00:00:00` for the built-in radio, while the interface on that radio has a
real address. The other radio on the same board reports its address correctly in the
same file.

**Action:** a radio's identity comes from its bus path (`/sys/class/ieee80211/*/device`
resolves to a platform path for a built-in radio and a USB path for a dongle) and from
the addresses of the interfaces on it. An all-zero MAC is treated as absent, never as a
value that can be matched on.

### Names must be pinned by MAC address

USB devices can be enumerated in a different order between boots, so a name derived
from enumeration order is not stable.

**Action:** the reconciler writes a `systemd.link` file matching on MAC address for
every radio with a role, so the name in unit names and configuration files is stable.

## Ordering and timing

### A unit configured against an interface can start before that interface exists

A DHCP server bound to a specific interface fails permanently if it starts before
the interface has an address.

**Action:** the generated unit gets a dependency on the interface's device unit plus
`Restart=on-failure`. The dependency handles the ordinary case; the restart policy
handles the race.

### Enable before restart, and verify both

A failing restart aborts a sequence. If enable has not run yet, the unit is left
disabled, and the fault only appears after the next reboot: the service works now and
is gone in the morning.

**Action:** enable first, tolerate a first-start failure, verify `is-active` **and**
`is-enabled`.

### Restart, not "enable now"

For a unit that is already running, an "enable and start" call does nothing, and the
new configuration is silently not applied.

## Clock

### No battery-backed clock, and some transports authenticate on time

The board has no clock battery. After being switched off, the clock starts from the
last timestamp written before shutdown, which can be days in the past. Observed:
4 days 14 hours behind, with the hardware clock reading 1970.

Obfuscation transports that authenticate on a timestamp reject the session in that
state, so **every tunnel using such a transport fails while direct tunnels work
normally.** It looks like broken tunnels and it is a broken clock.

Worse, it is self-locking: fixing the clock needs a time query, and the time query
goes into the tunnel because the time synchronisation service does not run as root
and therefore misses a bypass rule written in terms of the root user.

**Actions, all three needed:**

1. The generated firewall bypasses the tunnel **by destination port** for time
   synchronisation, not by user. By port because the resolver name must be resolved
   at load time if a user name is used, and renaming a system user would silently
   break the rule.
2. Time servers are configured as **IP literals**, because the resolver also does not
   run as root and name resolution is exactly what is unavailable when the clock is
   needed.
3. Time synchronisation is restarted **after** the firewall is applied, never before.

**Check:** before reporting a transport-based tunnel as failing, report clock
synchronisation state. `timedatectl` is one call and it is the first thing to look at.

An early symptom worth surfacing: package signature verification complaining that a
signature is "not valid until" a future date is always a clock problem, never a
repository problem.

## Filesystem and power

### Temporary files must be in the target directory

`/tmp` is a tmpfs. A temporary file created there is on another filesystem, so moving
it into `/etc` is a copy and unlink, not an atomic rename. Power loss during the copy
leaves a truncated configuration file. A truncated core configuration means the core
does not start, and the device comes up with a working access point and no tunnel —
which looks like success.

**Action:** `writeAtomic` creates the temporary file in the target directory, syncs,
renames, syncs again. The second sync matters because the root filesystem is mounted
with a long commit interval, so the rename can otherwise reach the card before the
content.

### Unattended filesystem repair

The default repair mode fixes only what is unconditionally safe and **stops to ask a
human** for anything else. On a board with no console and no serial port that is an
unbootable device, recoverable only by removing the card.

**Action:** the installer sets the kernel command line to repair without asking, and
sets a periodic check interval. Both are host settings the daemon cannot apply to
itself.

### Logs and swap should not be on the card

Measured baseline write rate: 650–750 B/s, about 55 MiB per day, because the log
directory is RAM-backed and swap is compressed RAM. That is the budget, and the
logging design must not move it.

**Action:** the journal stays in RAM with a 200 MB cap, telemetry is never written
to the database, and only a ring of about 5000 significant events reaches the card.
The consequence — the journal for the current boot is lost on power failure — is
exactly why that ring exists, and both are readable through the API.

## Throughput ceilings

### USB 2.0 caps a dongle around 280–300 Mbit/s

Regardless of the dongle's own class. A Wi-Fi 6 2×2 dongle on a USB 2.0 port is
limited by the port.

**Action:** report the bus generation next to the radio in the interface, so nobody
spends an afternoon tuning a radio to beat a bus limit.

### Routing happens in user space

Traffic traverses a user-space tunnel interface, so hardware offload is irrelevant
and the CPU is the limit. Stated as a fact in the interface rather than presented as
something tunable.

## Tunnel daemons

### Pulled routes must be ignored

A server pushing a default-route redirect takes over routing, and several tunnels
then fight over it. A server pushing a large private range captures the management
network and the device becomes unreachable. Observed: servers pushing both
`10.0.0.0/8` and `192.168.0.0/16`.

**Action:** tunnel daemons are started with route pulling disabled. They provide an
interface; the core decides routing. A pushed DNS server address is *not* filtered,
because it is needed — see below.

### A pushed DNS address can change between reconnections

Observed on one network: two different resolver addresses depending on which gateway
the session landed on, alternating across reconnections. A value fixed at
configuration time is right about half the time, and the failure presents as "the
tunnel is up but names do not resolve".

**Action:** an up-script captures the actually-pushed address and updates the
resolver entry for that tunnel, atomically.

### One client certificate, one connection

Servers that do not allow duplicate common names assign the same address to a second
client, and the two then evict each other in a loop. Measured: with two clients,
repeated resets on both ends; with one, zero over the same interval.

**Check:** warn **only when reset counts actually rise** on a tunnel whose
certificate is also used by another enabled tunnel. The configuration alone does not
distinguish a server that tolerates two clients from one that does not, and a warning
that is usually wrong teaches people to ignore warnings.

## Firewall

### A kill-switch must reject only new connections

A rule rejecting all connection states tears down every established session at the
moment it is applied. Measured at idle with clients connected: zero packets in the
`new` state versus 460 established — so rejecting only `new` closes the leak and
breaks nothing. With the tunnel healthy there are no new connections on that path at
all, because redirection has already moved them; with the tunnel dead, no new
connections are created, so there is nothing left to leak.

`reject` rather than `drop`, so an application fails immediately and retries instead
of hanging in a timeout. The LAN's own network is exempt: traffic from clients to the
local network does not go through the tunnel and must not be blocked.

### Never flush the whole ruleset

The core creates its own table when it manages redirection. A global flush removes
it, silently disabling tunnelling on any restart of the firewall service. Recreate
only owned tables.

### The routing exclusion must contain the management network

The core's tunnel interface takes over routing. Without an explicit exclusion for the
management network, replies to management traffic go into the tunnel and the device
becomes unreachable.

**Check:** the generated exclusion list contains the LAN, the tunnel's own transfer
network, and **every non-loopback IPv4 network this device currently holds an address
on** — not only the ones a profile calls uplinks. The list is not a user-editable field.

Deliberately over-inclusive, and the asymmetry is the argument: including a network
that did not need protecting costs some traffic going direct that could have been
tunnelled, and the anchor sends our own served network direct anyway. Omitting one
costs the device.

**Correction, 2026-09-20.** This section previously claimed the check was in force. It
was not implemented when it was written, and the cost of the gap was paid twice on the
bench board, in both of the ways it can be paid:

* **It was absent.** A board was left unreachable while fully up and correctly
  addressed, because nothing excluded the network the management session arrived on.
  From outside, a device that holds a DHCP lease and answers nothing is
  indistinguishable from a dead one; it cost a person a trip to the device's own access
  point to find out.
* **It was stale.** Once implemented, the list is derived from the addresses the device
  holds *at plan time* — so it is a snapshot of where the device was standing. The board
  was moved to a different network and came back excluding `192.168.1.0/24`, a network
  that no longer existed, with nothing excluding the one it was now plugged into. The
  generated artefacts were internally consistent and describing a world that had moved.

The second failure is the interesting one, because no check of the artefact could have
caught it: the file was exactly what the generator would produce from the facts it was
given, and the facts had expired. That is what the boot re-derivation guard in
[06](06-apply-and-rollback.md) exists for — an artefact that encodes the environment is
re-derived when the environment may have changed, and a boot is exactly that moment.

A claim about an unimplemented check is worse than no claim: it is read as coverage and
it stops anybody looking. Recorded here rather than silently fixed, because the wrong
reasoning is the part worth keeping.

### IPv6 must be blocked at the access point, not merely unrouted

A tunnel that carries only IPv4 while IPv6 reaches the internet directly leaks the
real address of every client, and it does so invisibly — pages load, so nothing looks
wrong. The observed uplink has no IPv6 default route at all, which makes this easy to
miss during development and guaranteed to appear on somebody else's connection.

**Action:** IPv6 is dropped at the access point: no router advertisements are
accepted or forwarded, no IPv6 addresses are handed out, and forwarded IPv6 is
rejected. Rejected rather than dropped, so a client falls back to IPv4 immediately
instead of waiting out a timeout.

### Traffic from the device itself needs an explicit bypass, by mark

The documented per-user exclusion in the tunnel inbound does not take effect in the
chains generated for forwarded traffic — verified by inspecting the generated chains,
which contain no user-matching rules at all. A separate table marks the device's own
traffic with the value the core treats as already handled.

Note the limitation this creates, and which the clock section above resolves:
marking by root user covers only processes running as root, and several system
daemons do not.

## The access point may not be on the channel the profile asked for

Measured on the bench board 2026-09-20 (Armbian 26.11.0-trunk.36, hostapd 2.10, MediaTek USB radio
`0e8d:7961`, regulatory domain DE from the global block).

The profile asked for **channel 36 at 80 MHz**. The radio came up on **channel 40**:

```
$ iw dev <ap> info
	channel 40 (5200 MHz), width: 40 MHz, center1: 5190 MHz
```

That is not a fault, and chasing it produced three facts worth keeping.

**hostapd decided, and it said so in its own log:**

```
interface state UNINITIALIZED->COUNTRY_UPDATE
interface state COUNTRY_UPDATE->HT_SCAN
Switch own primary and secondary channel to get secondary channel with no Beacons from other BSSes
```

With `ht_capab=[HT40+]` on channel 36 the secondary channel is 40. hostapd performs the HT40
co-existence scan the standard requires, found beacons from other networks, and **swapped primary and
secondary** so that the secondary is the quieter of the pair.

**Only the primary 20 MHz channel moved; the 80 MHz block did not.** From the control interface:

```
$ hostapd_cli -p /run/wayfarer/hostapd -i <ap> status
state=ENABLED
freq=5200
channel=40
secondary_channel=-1          ← the secondary is now *below* the primary, i.e. 36
vht_oper_chwidth=1            ← still 80 MHz
vht_oper_centr_freq_seg0_idx=42
```

`vht_oper_chwidth` and the centre index are unchanged, so the access point occupies the same 36–48
block centred on 5210 MHz that was asked for. `iw dev info` reporting "width: 40 MHz" is showing the
**HT** operating width, not the VHT one — which is why the discrepancy looked larger than it is.

**So the request is not refused, and refusing it would be wrong.** This is standards-required behaviour
that avoids interfering with neighbours, and an access point that failed to start because it did the
right thing would be a worse product. The correct response is the other one: **report the effective
channel alongside the requested one** rather than letting the profile imply a channel the radio is not
on.

The rule this is an instance of: **a profile states a request, and the device reports what actually
happened.** Anywhere the two can differ legitimately, both are surfaced — a profile that silently
implies the wrong radio state undermines every diagnosis built on top of it, and the operator has no
way to notice.

### The control socket has to be given to `hostapd_cli`, and was not

Found while investigating the above, and far more serious than the channel.

```
$ hostapd_cli -i <ap> status
Failed to connect to hostapd - wpa_ctrl_open: No such file or directory
```

hostapd was running and healthy. The generated configuration sets
`ctrl_interface=/run/wayfarer/hostapd` — deliberately ours rather than the shared `/var/run/hostapd`,
because this project does not share a namespace — while **every** call in the platform layer invoked
`hostapd_cli -i <iface>` with no `-p`, so it looked in the tool's default directory and failed.

The consequence is the one already recorded for a `PrivateTmp` sandbox, arriving through a different
door: the access point reports **no state and no clients** next to a radio that is working perfectly.
Status, the client list and the event subscriber were all affected, and nothing about it looks like an
error from outside.

**Fixed by there being one definition.** The path lives in the platform layer and the generator imports
it, so the code that writes `ctrl_interface=` and the code that connects to it cannot name different
directories. Two copies is how they came to disagree.

The general shape, and it is the same one that found the unloaded firewall ruleset: **ask who consumes
an artefact.** A socket is an artefact too. The check that catches this class is not "is this value
correct" but "does the thing that produces it and the thing that consumes it agree", and that can be
made structural rather than remembered.

**Consequence for anyone running the tool by hand**, including in a diagnosis: `hostapd_cli` needs
`-p /run/wayfarer/hostapd`, or it will report a working access point as absent.


## The card's device name is not stable across boots

Measured on the bench board, 2026-09-21. The same physical SD card, the same image, two boots:

```
boot A   findmnt -n -o SOURCE /     /dev/mmcblk0p1
boot B   findmnt -n -o SOURCE /     /dev/mmcblk1p1
         ls /sys/block/             ... mmcblk1 ...   (no mmcblk0 at all)
```

Nothing was changed between them but a restart. The MMC host controllers are enumerated by the kernel in
whatever order they probe, and the index that ends up on the card is not a property of the card.

**Anything that reaches the card by name is therefore wrong on some boots**, and wrong silently: a
statistics path reads zeros rather than failing, so a measurement built on it looks like a healthy result.
The bench soak was written with `mmcblk0` in a first draft and would have reported **zero card writes for
its entire run** — in the instrument built to measure card wear.

**Resolve it, never write it down.** The root filesystem's own device is the fact that is true on every
boot:

```sh
dev="$(findmnt -n -o SOURCE /)"          # /dev/mmcblk1p1
dev="$(basename "$dev" | sed -E 's/p?[0-9]+$//')"   # mmcblk1
cat "/sys/block/$dev/stat"
```

A corollary worth stating because it inverts the obvious accounting: on this image `/var/log` is mounted
on **zram**, so journal growth costs no card writes at all. `RuntimeMaxUse` bounds memory here rather
than wear.

## A binary's name is not its package's name

Measured on the bench board, 2026-09-21, with `dpkg -S` against the resolved path of each binary this
project looks for:

| binary | path | package |
|---|---|---|
| `hostapd` | `/usr/sbin/hostapd` | `hostapd` |
| `hostapd_cli` | `/usr/sbin/hostapd_cli` | `hostapd` — same package, different binary |
| `wpa_supplicant` | `/usr/sbin/wpa_supplicant` | `wpasupplicant` — no underscore |
| `dnsmasq` | `/usr/sbin/dnsmasq` | **`dnsmasq-base`**, not `dnsmasq` |
| `nft` | `/usr/sbin/nft` | `nftables` |
| `iw` | `/usr/sbin/iw` | `iw` |
| `ip` | `/usr/sbin/ip` | `iproute2` |
| `openvpn` | `/usr/sbin/openvpn` | `openvpn` |
| `systemd-run` | `/usr/bin/systemd-run` | `systemd` |
| `sing-box` | `/usr/local/bin/sing-box` | **not from a package** |
| `xray` | absent | **not in the distribution** |

**Five of the ten differ from the binary name, and two cannot be installed with the package manager at
all.** So the obvious implementation of a capability report — "hostapd is not installed, run
`apt install hostapd`" — is confidently wrong most of the time, and a wrong instruction is worse than
none: somebody runs it, gets "no such package", and concludes the report is broken rather than that the
package has a different name.

The mapping is therefore a table of measured facts rather than a template, and where the two names differ
the report says so, because otherwise the command looks like a typo. `sing-box` and `xray` get no command
at all: they are release binaries, **this daemon never downloads executables**, and the remedy names the
step and leaves the fetching to a person who chose the version.

### The report can also invent a gap, and did

A capability may require a binary the inventory never looks for — and then `present` is never true for it,
so the gap is reported for ever. That happened: `systemd-run` was required by the revert-timer capability
and absent from the inventory's list, so the report said *the revert timer is unavailable* on a device
where it demonstrably works. Found by reading the report on hardware.

Two assertions now hold the lists against each other in both directions, because one direction was
already covered and the missing one was the direction that bit:

* every binary the inventory looks for has a remedy — or the report names a gap and says nothing about it;
* every binary a capability requires is one the inventory looks for — or the report invents a gap that can
  never be closed.

## An interface name is not stable across reboots

After a reboot the built-in radio came back as **`wlan1`**, not `wlan0`. Every per-interface artefact
moved with it — the configuration file name, the unit instance, the `.network` file — so the wireless
uplink simply did not come up.

This is what `pinName` exists for. It is now set for the bench board's uplink, and the radio is pinned to
**`wfwan0`** by MAC address.

The same instability is the card's, recorded above: `mmcblk0` on one boot and `mmcblk1` on the next, same
card and same image. **Nothing on this board should be identified by the name the kernel happened to give
it this time.**

### And the ordering gap the rename exposed

A plan that renames an interface also wanted to *start* the units instanced on the new name, in the same
apply. The rename is `boot` class — the `.link` file takes effect when the device next appears — so **the
new name does not exist yet**, and the apply spent ninety seconds failing to start a unit bound to a device
that would not exist until the next boot, then reverted.

Units bound to an interface this plan renames are now **enabled but not started**, with a note in the plan
saying they start after the reboot the rename needs. Enabling is what makes the reboot finish the job.

## A host address with a prefix is not a network

`10.44.0.1/24` and `10.44.0.0/24` are different things, and `nft` happens to accept the host form and
normalise it — which is the kind of luck that stops being luck in a different field.

So: **normalise the host-address-with-a-prefix form everywhere, and reject it where exclusions are
generated.** An exclusion list is the one place the difference decides whether a host on the device's own
network can still get a reply from it, and there the value must be the network.
