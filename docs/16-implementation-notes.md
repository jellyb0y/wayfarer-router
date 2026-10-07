# 16. Implementation notes: the catalogue

Every entry is something that cost time on real hardware, with the command that produced it and the
numbers. Each of them looks obviously correct until it is run.

## How to use this document

It is long, and reading it end to end is not the intended use. There are three ways in, and the second
is the one that earns the length.

**1. You have a symptom.** Use the headings. They are written as the symptom, not as the fix — *"A unit
that succeeded was reported as a 90-second timeout"*, *"The live ruleset on a fresh board is empty"* — so
scanning them works.

**2. You are about to write something, and want to know how it will go wrong.** Read two sections and
nothing else:

* [The dominant failure mode of this codebase](#the-dominant-failure-mode-of-this-codebase) — one
  sentence, twenty-six numbered instances, and a remedy written as actions.
* [A different remedy, for defects that live at a seam](#a-different-remedy-for-defects-that-live-at-a-seam)
  — for the family the first one cannot catch, because every side of the defect is locally correct.

Then ask [the ten questions](#the-questions-collected) of the thing you are building. Each of them has
found a real defect in code that was passing every test.

**3. You want to know what is unproven.** Two places:
[Predicates that gate rare actions](#predicates-that-gate-rare-actions-and-whether-anyone-has-seen-them-fire)
lists every refusal and whether anyone has watched it fire, and the README's *State of the evidence*
section is the shorter version.

## What this is for, which is not what it looks like

It reads like a list of mistakes. **It is an instrument for finding the ones that have not happened
yet.**

A defect written down as a *class* becomes a question you can ask of code that is currently passing every
test and causing no symptoms. That is not a hope: it is the only thing in this document with evidence
behind it. Instance 22 — a deadline recorded in one place while systemd acted on another — was found by
taking instance 19 seriously as a class and asking *where else is a deadline recorded that something else
independently maintains?* The answer was the confirmation window's own revert timer, which had never
failed a test and was silently postponing the single promise this project makes. Instance 25, the
watchdog's fallback latching for ever, was found the same way.

So the working instruction is not "read this and feel chastened". It is: **when you fix something, state
the class, then go and look for its other instances before they announce themselves.**

## The board every measurement comes from

Measured on the bench board unless stated otherwise: Orange Pi Zero3, Armbian (Debian 13
trixie), kernel 6.18.49-current-sunxi64, systemd 257.13, hostapd and wpa_supplicant 2.10,
`iw` 6.9, iproute2 6.15.0, nftables 1.1.3, 4 cores, 1973 MB RAM, Node 24.21.0. Dated
2026-09-19 unless a later date is given.

**One board.** Every hardware fact here is from that device, that image, that pair of radios. Where a
fact is about software rather than hardware — a systemd behaviour, a SQLite comparison — it is likely to
hold anywhere; where it is about a driver or a timing, it is one data point.

## systemd

### `LoadUnit` plus a `UnitNew` subscription is a feedback loop

The first version of the systemd platform module subscribed to `JobRemoved`, `UnitNew` and
`UnitRemoved`, and read unit state in the handler with `LoadUnit`. `LoadUnit` makes systemd
*load* a unit, which emits `UnitNew`, which the handler answered with another `LoadUnit`.

What it produced, in about three minutes:

```
$ journalctl -b -u dbus.service | grep -c "pending replies"
54458
$ journalctl -b -u dbus.service | tail -1
dbus-daemon[586]: [system] The maximum number of pending replies for ":1.41"
  (uid=0 pid=5266 comm="/usr/local/bin/node /opt/wayfarer/daemon.cjs") has been reached
  (max_replies_per_connection=128)
```

The visible symptom was not a loop: it was that the daemon could not read *its own* unit
state — `GET /api/status` reported `activeState: null, known: false` for a unit that
`systemctl is-active` called `active` — while three unrelated units it had never asked about
appeared in the response. The D-Bus connection had run out of pending replies, and the
failure surfaced as missing data rather than as an error.

It also filled the RAM journal with another service's complaints about us, which is worth
noting on its own: the 200 MB journal budget is shared with every other unit on the device.

**Fixed by:** no unit-lifecycle subscription at all; an explicit watched set; `GetUnit`
(which does not load) on the read path and `LoadUnit` only when a caller explicitly asks
about one unit; per-unit `PropertiesChanged` for state changes that produce no job; one
refresh in flight per unit; and cached interface proxies so a poll is one round trip rather
than three. After the fix, over a clean 60-second window: **0** pending-reply warnings.

### `systemctl show -p NextElapseUSecMonotonic` does not print microseconds

It prints a rendered timespan — `3h 36min 23.335852s` — in spite of the name, and
`NextElapseUSecRealtime` is *empty* for any monotonic timer, which is what both of this
project's timers are. The first version of the deadman script died with
`value too great for base (error token is "3h")`. `systemctl list-timers --json=short` does
not exist in this version either.

Deadlines are therefore recorded by the code that sets them, against the monotonic clock
from `/proc/uptime` — and that is only sound because the recorded number is now *the same
number* given to `OnBootSec`, rather than a second copy of it. See
[A deadline expressed as an interval from activation is not a deadline](#a-deadline-expressed-as-an-interval-from-activation-is-not-a-deadline)
for what happened when it was a copy.

### This runtime cannot send systemd notifications directly

`sd_notify` is a datagram on an `AF_UNIX` socket. The runtime's `dgram` module supports UDP
only and `net` supports `SOCK_STREAM` only, so `Type=notify` and `WatchdogSec` are
impossible without help. The same limitation is why wpa_supplicant is driven over D-Bus and
not through its control socket.

**Done instead:** notifications are sent by running `systemd-notify`, which owns such a
socket. That requires `NotifyAccess=all` in the unit, because the datagram then arrives from
a helper process rather than from the main one — with the default `NotifyAccess=main`
systemd ignores it and kills the unit at `TimeoutStartSec` with no explanation. The watchdog
interval is 60 s and is pinged at a third of it, because each ping costs a process.

## Sandboxing versus the tools being driven

### `ProtectSystem=strict` and `PrivateTmp=yes` each break `hostapd_cli`, differently

`hostapd_cli` creates its own client socket under `/tmp`, and hostapd replies to that path.
Both obvious hardening choices therefore break access-point control, and neither says so:

```
$ systemd-run --pipe -p ProtectSystem=strict -p ReadWritePaths=/run \
    hostapd_cli -i <ap> status
Failed to connect to hostapd - wpa_ctrl_open: Read-only file system

$ systemd-run --pipe -p PrivateTmp=yes hostapd_cli -i <ap> status
'STATUS' command timed out.

$ systemd-run --pipe -p ProtectSystem=strict -p "ReadWritePaths=/run /tmp" \
    hostapd_cli -i <ap> status
state=ENABLED
phy=phy0
```

The `PrivateTmp` failure is the more expensive one: the command exists, the control socket
exists, the permissions are right, and the reply simply goes into a mount namespace nobody
is listening in. Through the API it looked like an access point with no state and no
clients — `{"wlanap": {"state": null, "channel": null, "stations": 0}}` — next to a link
report that was working perfectly.

`hostapd_cli` 2.10 has no option to move its client socket, so the unit keeps a writable
shared `/tmp` and does not set `PrivateTmp`. The hardening lost is small; the alternative is
no access-point control at all.

Second-order effect, also measured: while the calls were timing out, one-shot `hostapd_cli`
processes accumulated (`pgrep -c hostapd_cli` climbing) because each call sat until its
timeout. With the sandbox corrected, the count is exactly one — the long-lived subscriber.

### `MemoryDenyWriteExecute` cannot be used

The JavaScript engine needs writable-executable pages. Stated in the unit file rather than
silently omitted, so nobody adds it back as an obvious improvement.

## Talking to hostapd

### The event subscriber must hold stdin open, and action mode prints nothing

Three ways to subscribe were tried against hostapd 2.10:

| Command | Result |
|---|---|
| `hostapd_cli -i <ap> -a /bin/true` | Attaches, prints **nothing** to stdout: events go to the action script. |
| `hostapd_cli -i <ap>` with stdin closed | Prints its banner and exits within milliseconds. |
| `hostapd_cli -i <ap>` with stdin held open | Stays attached; unsolicited events print to stdout. |

The middle case is the dangerous one: with `stdio: ['ignore', …]` the subscriber dies a
millisecond after it starts, and an access point that produces no events looks exactly like
an idle one. The platform layer therefore keeps an open pipe on the child's stdin and never
writes to it.

**Unverified, and stated as such:** no client associated to the bench access point during
this work, so the parsing of a real `AP-STA-CONNECTED` line has not been exercised against
hostapd's own output. The attach is verified, the parser is covered by tests, and the two
have not met.

### `sta_first` and `sta_next` are not hostapd_cli commands

The fallback for a truncated `all_sta` was written against `STA-FIRST` / `STA-NEXT`, which are
*control-interface* commands. `hostapd_cli` does not expose them and rejects them locally, before
anything reaches the socket — measured on the bench board, hostapd_cli 2.10:

```
$ hostapd_cli -i <ap> sta_first
Unknown command 'sta_first'
$ hostapd_cli -i <ap> help | grep sta
  sta <addr> = get MIB variables for one station
  all_sta = get MIB variables for all stations
  list_sta = list all stations
```

So the fallback would have failed in exactly the situation it exists for: an access point with
enough clients to truncate `all_sta` would have reported no clients at all. The table is now rebuilt
with `list_sta` followed by `sta <mac>` per station — and `list_sta` is the right entry point for a
second reason: it returns one address per line, so the reply that decides how many stations there
are is the one that cannot lose a station inside a truncated record.

Found by probing the tool on hardware rather than by reading about it, which is the argument for
having done that at all.

## wpa_supplicant over D-Bus: reachable, with nothing registered on it

Measured on the bench board by calling the platform layer directly:

```
supplicant.available():  true
supplicant.interfaces(): []
```

The service `fi.w1.wpa_supplicant1` is on the bus, but it owns no interfaces — because the Wi-Fi
client on this board is run by a *separate* supplicant instance started per interface by the
network configuration tool (`netplan-wpa-wlan0.service`), and that instance does not register with
the D-Bus service.

Two consequences worth writing down before the uplink work starts:

* "The supplicant is available" is not the same as "this interface can be driven". The check has to
  be per interface, and an interface that is associated and working may still be invisible here.
* Driving a Wi-Fi uplink means owning the supplicant instance for that interface, which is a change
  to how the host starts it — a reconciler decision, not something the platform layer can paper
  over.

The link quality for such an interface still reads correctly, because that comes from `iw` and not
from D-Bus: the same interface reported SSID, −49 dBm and a 351 Mbit/s VHT rate at the same moment
the supplicant listed no interfaces at all.

## Verified on hardware, with the numbers

* **`nft -c -f`** accepts a well-formed ruleset (`{ ok: true, message: '' }`) and rejects a
  malformed one with nftables' own message naming line and column. Neither touched the live
  ruleset: the probe table was absent afterwards.
* **Foreign tables survive.** `nft -j list ruleset` on the bench board: 4 tables, 63 rules,
  nftables 1.1.3 — and with an empty owned set, all four are reported as foreign, which is what the
  generator's guard compares against.
* **The proxy core's schema** is fetched from the binary and cached per version and build tags:
  444 891 bytes, 93 definitions, `fromCache: false` on the first call and `true` on the second.
* **A unit that does not exist** answers `inactive` / `dead` / `not-found` rather than failing, so
  existence is read from `LoadState`. A check based on the active state calls every typo a stopped
  service, and capability reporting depends on telling "installed but not running" from "not
  installed".

## Probing binaries

### A version probe can manufacture failures, and an empty argument list can start a daemon

The first version of binary detection tried a bare `version` argument first. `dnsmasq`
treats that as junk:

```
dnsmasq[6449]: junk found in command line
dnsmasq[6449]: FAILED to start up
```

Two of those per inventory read, in the journal, attributed to **our** unit because the
process was our child. Nothing was broken and the journal said otherwise.

Worse, and avoided by never doing it: probing a daemon with an *empty* argument list.
`dnsmasq` with no arguments does not print a version — it starts serving DNS.

**Fixed by:** a per-tool table of version arguments, `--version` as the default, and a bare
`version` only for the tools that use that form (the proxy core, `xray`).

## Shell

### `set -o pipefail` plus `grep -q` reports failure when the match succeeds

`grep -q` exits as soon as it matches, the producer dies of `SIGPIPE` with status 141, and
`pipefail` reports the pipeline as failed — *because* the match succeeded. The installer
printed "no radio reports AP mode support" on hardware with two AP-capable radios:

```
$ set -o pipefail
$ if iw phy | grep -q '^\s*\*\s*AP$'; then echo matched; else echo "failed rc=$?"; fi
failed rc=141
$ iw phy | grep -cE '^[[:space:]]*\*[[:space:]]*AP$'
2
```

Counting with `grep -c … || true` and testing the number has no such failure mode.

### A test script that arms a safety net and exits leaves it armed

This is how the deadman's first real firing happened: a status command crashed on the
timespan bug above, the shell aborted under `set -e` before `disarm`, and 45 seconds later
the board restored its configuration and rebooted. The behaviour was correct. Automation
that arms must disarm in a trap, never on the happy path — which is what
`scripts/deploy.sh` does.

## The runtime

### Type stripping is erase-only: no parameter properties

`node --test --experimental-strip-types` refuses TypeScript that needs a code transform:

```
x TypeScript parameter property is not supported in strip-only mode
```

It surfaced as three unrelated tests failing to import a module whose error class used
`constructor(readonly command: string, …)`. `erasableSyntaxOnly: true` is now set in
`tsconfig.base.json`, so this class of mistake fails at type-check time instead of at the
first test run.

### `import.meta` is empty in a CommonJS bundle

The daemon bundles to CommonJS, where `import.meta.url` is empty — so a path resolved that
way is always missing on the device and always present in development, which is the worst
way round. esbuild warns about it (`empty-import-meta`) and the warning is worth reading.

### Memory: measure the cgroup, not RSS

Measured on the board with a fresh restart:

| After | RSS | cgroup `MemoryCurrent` |
|---|---|---|
| start, idle | 98.0 MB | 63.5 MB |
| one login (scrypt, N=2^15) | 98.3 MB | — |
| three inventory reads | 99.5 MB | — |
| thirty status reads | 99.9 MB | — |
| a 2000-line journal read | 109.7 MB | — |
| 30 s idle afterwards | 109.7 MB | peak 83.8 MB |
| steady state, after the D-Bus and polling fixes | — | **51.2 MB** |

Two conclusions. **RSS overstates what the limits act on**: `MemoryHigh` and `MemoryMax`
are cgroup limits, and the cgroup figure is 35 MB below RSS because file-backed pages of the
runtime binary are counted in RSS. The 45–70 MB figure in
[09-stack.md](09-stack.md) is about right when measured the way the limits measure it, and
misleading if compared against `ps`. **And a large journal read is not free**: 2000 lines
cost about 10 MB that is not returned promptly, which is why that endpoint is capped and
paginated rather than open-ended.

## Parsing

### Interface combinations wrap across lines

The constraint that decides whether an access point may share a radio with a client —
`#channels <= 1` — arrives on a *continuation* line indented with spaces rather than tabs:

```
	valid interface combinations:
		 * #{ managed, P2P-client } <= 2, #{ AP } <= 1, #{ P2P-device } <= 1,
		   total <= 3, #channels <= 1
```

A line-by-line parser reports that radio as having no channel limit, which is exactly the
configuration that silently fails to start. The same section also proves that a radio's
capability is the *union* of its combinations: this radio publishes two, and only the second
permits AP mode.

### `iw reg get` has a global block, per-radio overrides, and omissions

The global block reported `country US: DFS-FCC`; `phy#1` reported `country 00: DFS-UNSET` —
a different channel set and different power limits. And `phy#0` did not appear at all, while
it existed, was up, and was hosting the access point. Absence means "follows the global
domain", so a lookup falls back rather than reporting no domain.

### Bullet indentation is inconsistent within one command's output

`Supported interface modes` prints `"\t\t * managed"` (a space before the asterisk) while
`Supported Ciphers` prints `"\t\t* CCMP-128"`. A reader that matches on `* ` after the tabs
finds the ciphers and none of the modes — which showed up as a radio that supported no
modes at all.

### Empty output is a state, not an error

`iw dev wlan0 station dump` returns **nothing** on the built-in radio while that interface
is associated and has received 1.9 GB. The driver does not populate the report. Likewise
`iw dev wlan0 link` prints a transmit bitrate and no receive bitrate. A status view that
defaults a missing value to zero shows a working link as a broken one.

### Sysfs can report an unusable MAC for a radio

`/sys/class/ieee80211/phy1/macaddress` reads `00:00:00:00:00:00` for the built-in radio,
while the interface on it has a real address; the other radio on the same board reports its
address correctly. An all-zero value is treated as absent, and a radio's identity comes from
its bus path instead — `/sys/devices/platform/unisoc_wifi` for the built-in one,
`/sys/devices/platform/soc/5310000.usb/usb2/2-1/2-1:1.0` for the dongle.

### What two associated clients showed that no amount of reading would have

Captured on 2026-09-19 with two devices on the bench access point, which is the first time any of
this project's station code met a real station.

**The absent-not-zero discipline survives contact with the data, for a better reason than expected.**
This radio *does* populate `tx retries` and `tx failed`, and both read `0` on a healthy link — so a
zero here is a real measurement on this driver, which is exactly why a parser must not invent one on
a driver that prints nothing. And in the same output, at the same moment, from the same driver:

```
	tx bitrate:	234.0 MBit/s VHT-MCS 3 80MHz VHT-NSS 2      ← one client
	tx bitrate:	26.0 MBit/s MCS 3                           ← the other
```

The HT client's rate line carries no width and no spatial-stream count. A parser that defaulted
either to zero would report a working client as being on a 0 MHz channel with no streams. The
difference is not between drivers, it is between two clients of one driver.

**Two disagreements between the capture and the parsers**, both since fixed, with the real output
kept as the regression test in `apps/daemon/test/parse-system.test.ts`:

1. **The first event line after attach carries the interactive prompt.** The subscriber's own
   output, verbatim:

   ```
   > <3>AP-STA-CONNECTED aa:bb:cc:00:0d:02
   <3>EAPOL-4WAY-HS-COMPLETED aa:bb:cc:00:0d:02
   <3>AP-STA-DISCONNECTED aa:bb:cc:00:0d:02
   ```

   `hostapd_cli` prints its prompt and the first unsolicited event lands on the same line. The
   parser stripped the `<3>` priority and not the `> `, so the first client to join after the daemon
   started produced no station event. The five-second poll still finds it, so the arrival was late
   rather than lost — which is exactly why this survived until a real client joined at the right
   moment.

   The general shape is worth more than the fix: **the parser was written against what the tool
   prints once it is settled, not against what it prints when you attach to it.** A long-lived
   reader's first line is shaped differently from every line after it, and the first line is the one
   nobody captures — so every test that starts mid-stream passes. The other long-lived reader here
   was checked against the same suspicion: `ip monitor` prints nothing at all on attach and its
   first event line is shaped like every other (verified on the board by adding and removing a
   loopback address while attached), and in any case its output is used only as a trigger.

2. **`rate_info` is in units of 100 kbps, and the fields were named `kbps`.** Cross-checked against
   `iw` on the same stations at the same moment: `tx_rate_info=2340` ↔ `234.0 MBit/s`,
   `tx_rate_info=260` ↔ `26.0 MBit/s`, `rx_rate_info=390` ↔ `39.0 MBit/s`. Nothing read those fields
   yet, which was the argument for fixing the name before something did: a field named `kbps`
   holding hundreds of kbps is a unit error waiting for its first reader. They are now `txRateMbps`
   and `rxRateMbps`, converted at the parse boundary, with the raw values still reachable verbatim
   under `fields`. The test asserts both tools' figures against each other rather than against a
   constant — two independent programs agreeing at the same instant is a stronger fixture than
   either alone.

**`hostapd_cli raw STA-FIRST` works.** The earlier note stands — `sta_first` is not a `hostapd_cli`
verb — but the control interface does accept the command through the `raw` passthrough, and it
returns the same block as `sta <mac>`. The `list_sta` + `sta <mac>` fallback is kept anyway: it
needs no passthrough, and `list_sta` returns one address per line, so the reply that decides how
many stations exist is the one that cannot lose a station inside a truncated record.

**An accidental proof of the restart path.** While removing the capture tooling from the board, the
`pkill` pattern also matched the daemon's own `hostapd_cli` subscriber. It was restarted by the
daemon within seconds and the access point's station list kept reporting both clients. That is the
restart-on-exit path working on hardware — recorded as accidental, because it was: nobody set out to
test it, and it should not be counted as a deliberate test in anyone's coverage.

**A client's address is not a device.** The same phone appeared under two different addresses across
two associations — address randomisation, not an artefact of redaction. Anything that treats a
station address as a stable identity will be wrong about it.

## Found in review, and why each one was worth a change

### A failed read is not an observed absence

`rebind()` read the kernel's address table with `.catch(() => [])` and then closed the listener for
every address not in the result. That turns "I could not ask" into "the interface has no addresses",
and the teardown pass then closes the listener on the only interface anyone can reach the device
through — on a board with no console, a trip to fetch the memory card.

The rule now has its own module (`src/api/listeners.ts`) and its own tests: **a listener is torn
down only on a positively observed absence, never on a read that failed.** On a failed read every
listener stays, the literal addresses from the configuration are still brought up because they do
not depend on the reading, and the next successful read does the tidying. An address that really
went away is still gone then, so waiting costs nothing and guessing costs the board.

The same shape appears one screen further out in telemetry, where a failed station read used to
blank a healthy access-point status; both now keep their last known-good value.

### Scopes were documented and not enforced

The authentication hook proved that *a* credential authenticated and no read route asked for a
scope, so a token issued with `['apply']` could read the inventory, the live status and both log
surfaces. `docs/07-api.md` describes a scope table and `docs/10-security.md` counts scopes as the
mitigation for a leaked token — documentation promising a control the code does not implement is
worse than no control, because someone relies on it.

Every route now carries a scope guard, and the server **refuses to start** if one does not: an
`onRoute` hook collects any route under `/api/` without a guard and `buildServer` throws with their
names. Fail-closed by construction beats remembering, and the alternative — a central table of route
patterns — is a second place to forget.

### `journalctl -n` is tail-anchored, so forward paging skipped the middle

`--after-cursor X -n 200` returns the *newest* 200 of the entries after the cursor and silently drops
everything between. In a diagnostic surface that is the worst kind of wrong: the operator reads a
continuous log and concludes nothing happened in the gap. Forward paging now reads without `-n` and
stops one line past the page, which also makes "there is more" a fact rather than an inference from
a full page — the response field is `hasMore`, not `limitReached`.

### A cap in characters is not a cap in bytes

The subprocess output limit compared `string.length`, which counts UTF-16 code units. Non-ASCII
output — an SSID, a log line in any language — therefore occupied up to four times the intended
budget before anything stopped it, on exactly the input nobody controls. Output is now accumulated
as buffers, capped by byte count, and decoded once at the end, which also removes the question of a
multi-byte character split across two chunks.

### The only sanctioned write path could not fix an owner

`writeAtomic` compared content and mode but not ownership, so a file with the wrong uid or gid
reported `changed: false` for ever. Latent today and load-bearing from the next epic on, where
generated files carry the permissions their consumers require and an owner is half of that.

### Smaller, same family

* The device-tree read sat in the inventory module, directly under a header promising that every
  conclusion is traceable through the platform abstraction. It is now `platform/host.ts`.
* `defaultRoute(routes, family)` filtered `destination === 'default'` and then asked whether that
  same string contained a colon — a condition that can never be true, so the argument did nothing.
  The family is now carried on the route, stated by the caller that chose the command.
* Expired sessions were never deleted: an unbounded table on a device that runs for months. Swept at
  start-up, hourly, and on the lookup that finds one expired.
* The installer told the operator to join an access point this slice does not create and to sign in
  as a user the schema has no field for. A correctly installed board that looks broken produces the
  worst bug reports there are.

### The gap came back through the timeout

The forward-paging fix removed `-n`, and the gap returned by another door: `runLines` returned
`{ lines, hasMore, timedOut }`, and the caller read `hasMore` and never looked at `timedOut`. A read
cut short by its own 20-second timeout — a heavy `-g` filter, a wide gap since the cursor, a busy
board — was reported as a complete page, and a client paging through that answer walked across the
hole without noticing.

The fix is the shape rather than the symptom. `runLines` now returns **one** discriminated value:

```ts
type LineReadOutcome =
  | { kind: 'complete'; lines: string[] }
  | { kind: 'more'; lines: string[] }
  | { kind: 'cut-short'; lines: string[]; reason: 'timeout' };
```

There is no field to read while ignoring the other, and the compiler pointed at the one caller the
moment the type changed. `GET /api/logs` carries `incomplete` and `incompleteReason` alongside
`hasMore`, and the diagnostics screen says so in words. An incomplete diagnostic window that
announces itself is fine; one that does not is a trap.

The general rule, worth applying to the next result type of this kind: **if one field means "there
is more" and another means "I gave up early", they must not be separately readable.**

### A stopped child can be held open by its own grandchild

Found while testing the timeout path above: a 300 ms bounded read took **30 seconds**. `stop()`
killed the direct child, but the child's own `sleep` survived and kept the stdout pipe open, and the
reader was waiting on `close` — which waits for every pipe to close, not for the process to exit.

Two changes, both of which matter on a device rather than only in a test: long-lived readers are
spawned detached so `stop()` can signal the whole process group (with a `SIGKILL` follow-up for a
child that ignores `SIGTERM`), and the reader settles on whichever of `exit` and `close` comes
first. The same shape governs the `ip monitor` and `hostapd_cli` subscribers, which are restarted
whenever they exit — a restart that waits on a grandchild is a restart that does not happen.

### A fixed-rate timer over a variable-cost job

Telemetry polled every 5 s with nothing preventing a second poll from starting while the first was
in flight, and a poll walks one child process per station plus several D-Bus calls. With enough
clients or one slow driver, each tick piled another full round onto the previous one — unbounded
accumulation on a 2 GB board, which presents as a leak and is not.

The interval is now measured from the **end** of a poll, there is a reentrancy guard for any other
caller, and skips are counted and surfaced in the status payload rather than swallowed: a poller
that has quietly wedged and a poller with nothing to do look identical from outside, and only the
counter tells them apart.

### The installer printed the file instead of the configuration

`mergeConfig` always adds loopback to the bind set, and the installer printed what the JSON file
literally contained — so a configuration without `127.0.0.1` produced a daemon listening on it and a
message that did not mention it. It under-stated rather than over-stated, so it was not a lockout
risk, but this was the second time that file printed something the software does not do, and it is
the file whose entire purpose is to tell a human the truth. It now asks `way listen --json`, which
loads the configuration through exactly the code the daemon uses, and says plainly when it cannot.

## Tooling

### `@vitejs/plugin-react` 6.x requires Vite 8

With the chosen Vite 7 it fails at build time with
`Package subpath './internal' is not defined by "exports" in … vite/package.json`. Version
5.2.0 declares support for Vite 4 through 8 and is what this repository pins. Recorded
because the error names neither package's version and reads like a broken install.

## Found while building the configuration model

Measured on the bench board, 2026-09-19, against `sing-box` 1.14.0 and systemd 257.13.

### The generated unit files were never written, and no mock could show it

The desired state carried unit definitions as `content` on each unit, and the reconciler wrote
`files` and `networkFiles` — but not those. `install` therefore ran `daemon-reload` for a unit
file that did not exist, and the `enable` immediately after it failed:

```
enable of wf-firewall-ready.target failed: Failed to enable unit:
  Unit wf-firewall-ready.target does not exist
```

Every test passed. The recording stand-in for systemd answered `enable` with success, because a
stand-in answers what it was told to answer — and the missing write was in a step the stand-in
had no reason to model. This is the argument for running one real apply on hardware even when
the class is supposed to be safe: the mock agreed with the code, and both were wrong.

**Fixed by** routing unit definitions through the ordinary managed-file path: they are
`ManagedFile` entries, so they are written atomically, compared by content for idempotency, and
classified with the unit they define. `install` is now only the reload, and the step is named for
what it does.

*Corrected later:* the path was `/etc/systemd/system/<name>` when this was written and is now
**`/usr/local/lib/systemd/system/<name>`**. `/etc/systemd/system` belongs to the administrator, and —
the reason that matters here — `systemctl mask` needs `/etc/systemd/system/<unit>` free for its symlink,
so a unit *file* of ours sitting there made our own units unmaskable. The deadman's rescue path depends
on masking both the daemon and every `wf-*` unit, so the location is a safety property. The two sections
below still describe the sandbox work as it happened at the older path.

### The daemon's own sandbox made `/etc/systemd/system` read-only

With that fixed, the next apply failed one step earlier:

```
Could not write /etc/systemd/system/wf-firewall-ready.target:
  Error: EROFS: read-only file system, open '/etc/systemd/system/.wf-firewall-ready.target.wayfarer-8644f9af7441'
```

`ProtectSystem=strict` with a narrow `ReadWritePaths` is doing exactly what it is for. The path
was simply absent, because nothing in the previous slice generated a unit.

**Fixed by** adding `/etc/systemd/system` — and, in the same change, **removing three paths**:
`/etc/hostapd`, `/etc/dnsmasq.d` and `/etc/nftables.conf`. Nothing writes to them any more, since
all generated configuration lives under `/etc/wayfarer` and the firewall is applied from a file of
ours. On the bench board two of those three hold the live access-point and address-service
configuration of a system this project must not touch, so a write capability nothing uses is one
that can only ever be exercised by mistake. The list of writable paths should shrink when the code
stops needing one, and that is easy to forget because nothing fails when it does not.

### `{ "outbound": "any" }` in a DNS rule is fatal, not deprecated

The generated core configuration was accepted by the schema and by every fixture, and rejected by
the binary:

```
$ sing-box check -c /var/lib/wayfarer/plan-test/etc/wayfarer/core/config.json
ERROR outbound DNS rule item is deprecated in sing-box 1.12.0 and will be removed in sing-box 1.14.0
FATAL to continuing using this feature, set environment variable ENABLE_DEPRECATED_OUTBOUND_DNS_RULE_ITEM=true
exit=1
```

A catch-all DNS rule written as a rule *item* is refused outright on this version. The same run
also warned that `independent_cache` is deprecated and will be removed in 1.16.0.

The lesson is about where validation has to happen rather than about DNS. **A schema check is not a
validity check**: the schema the binary emits describes the shape it can parse, not the
configuration it will accept, and deprecations live in the second set. So the apply order keeps the
core's own `check` as a gate before anything starts, and the generated configuration is validated by
the binary rather than only against the binary's schema.

**Fixed by** expressing the default as `dns.final` and adding `route.default_domain_resolver`, which
is also more correct: `final` is the tunnel resolver, matching `route.final`, so an unmatched name
does not leak — and `default_domain_resolver` is direct, because resolving a tunnel's own endpoint
through that tunnel is circular and the tunnel never comes up. Confirmed afterwards: `sing-box check`
exit 0, `nft -c -f` exit 0, `dnsmasq --test` "syntax check OK", and `openvpn --config` parsed.

### A secret inside a union lost its kind label, silently

`uplinks` is an array of a union, and the pre-shared key is an *optional* secret inside one branch —
so the pointer `/uplinks/-/config/psk` passes through a union before reaching the leaf. The schema
walk that recovered the kind committed to the first branch containing `config`, found the Ethernet
one, found no `psk` under it, and fell back to the generic kind.

Nothing failed. The import checklist said "a secret is missing here" where it could have said "a
pre-shared key", which is most of what the label exists for — and a checklist that is vaguer than it
needs to be is one people skim. **Fixed by** keeping every candidate node the pointer can reach
rather than one, and taking the branch that declares the secret.

The general shape, worth applying to the next walk of a schema with unions in it: **a pointer into a
document with unions does not identify one node in the schema.** Any code that treats it as though it
does will be right most of the time and quietly wrong at the branch that matters.

### Two private keys were stored in clear because a predicate was wrong about *shapes*

The name rule that marks secrets in a foreign schema required every non-null branch of a field to be
a plain string. `ssh.private_key` and `tls.client_key` are declared
`anyOf: [string, array<string>]` — the form a PEM block takes when it may be given as several lines —
so both went unmarked: stored unwrapped, returned by `GET`, and written into an export meant to be
shared. `ssh.private_key_passphrase` went unmarked too, because `passphrase` was in the exact-match
list and `_passphrase` was not in the suffix list.

All three were found by the coverage golden file rather than by reading the code, within minutes of
that file existing. That is the argument for it: a heuristic hidden inside a function is one nobody
audits.

The instructive part is that the predicate was not wrong about secrets, it was wrong about **shapes**.
A rule that inspects types will keep meeting shapes nobody anticipated, so the shape half is now
explicit and tested, and the storage wrapper was widened to `string | string[]` at the same time —
detection without a wrapper that can hold the value is detection that changes nothing.

### Piping a large CLI output through ssh truncated it at exactly 64 KiB

```
$ ssh <board> 'way inventory --json' > inventory.json
$ wc -c inventory.json
65536
$ ssh <board> 'way inventory --json > /tmp/inv.json'; ssh <board> 'wc -c /tmp/inv.json'
69561
```

Not a bug in the command: the same output written to a file on the device is complete and parses.
It is the pipe. Worth writing down because the truncated file is *valid-looking* JSON text that
fails to parse at a plausible-looking place, and the first assumption is a cap in the tool.
Automation that captures a large output should redirect on the device and copy the file.

## Found by loading the interface in a browser for the first time

Every test was green and every screen had been written but none had ever been rendered.

### No protocol form rendered at all

`GET /api/schemas/tunnel/:provider` returned `$defs.Outbound` on its own. Its branches are full
of local references — `#/$defs/Duration` is in nearly every one — and those resolve against the
*document root*, which was not sent. So the form resolver refused every protocol, and the
interface showed this in place of every form:

```
This protocol cannot be shown as a form.
reference #/$defs/Duration does not resolve: no $defs
```

The resolver behaved correctly: it refused rather than guessing, said why, and offered the raw
editor. The interface was usable and the feature was entirely absent.

**Why no test caught it.** The resolver takes the root and the union as *two arguments*, and every
test passed both. The API has one thing to return. That difference — between a function's
signature and a route's response — is the whole bug, and it exists in the gap that unit tests by
construction cannot see.

**Fixed by** making a served schema self-contained: the union carries the `$defs` it needs, and is
stamped with `x-secret` in the same step. Two regression tests now cover it, and both were checked
to fail without the fix — one asserts every `$ref` in a served schema resolves inside that same
schema, the other resolves a form for every protocol the device offers from the served document
alone. The first of those had to be pointed at `singbox-outbound` rather than one of our own
schemas: ours contain no references, so it passed whatever the route did.

### A test that proved nothing

The first version of the regression test used a stand-in whose `coreSchema()` returned null. Every
schema route then answered 404, the loop over protocols had nothing to iterate, and the test
passed by skipping. **A test that proves nothing is worse than a missing one**, because it reports
that the thing is covered. The stand-in now serves the real 444 895-byte schema.

### The plan review was quietly about a different configuration

The pending bar said "1 pending change" while the review below it showed a plan that did not
contain that change. A plan is computed from the *stored* active profile, because that is what an
apply would act on — which is correct, and saying nothing about it is not. A review that is
silently about something else is the exact failure the review screen exists to prevent, arriving
through the screen itself. It now says so and refuses to apply until the changes are saved.

### `.field.row` inherited `flex-direction: column`

A checkbox stacked above its own label, reading as a stray tick mark floating over unrelated text.
Trivial, and worth recording for what it shows: the component tests added alongside these findings
assert that a screen *mounts*, which is not the same as asserting it *looks right*. Mounting is
what they can defend; the rest still needs eyes.

### What the browser pass cost and returned

One SSH port-forward to the device's **loopback** — `-L 8088:127.0.0.1:8088` — and about twenty
minutes. The daemon was not rebound to make this easier: publishing the management interface on
the wrong network is the one mistake this project is built to prevent, and doing it for
convenience during a test is how it becomes normal.

Console output across every screen: **zero messages from our own page.** The six that appeared all
came from a browser extension. That is stated as a result rather than assumed, because "no errors"
and "no errors we looked for" are different claims.

## Found in review of the configuration model

Six of these are one shape: a mechanism that was built, tested, and then not connected to the path it
was built for. The tests proved the mechanism worked. Nothing proved it was used.

### Tunnel credentials were stored, returned and exported in clear

The matchers that drive wrapping and redaction were reduced from the **static** profile schema. A
tunnel's `config` is an opaque record by design — it belongs to the provider — so that reduction
produced pointers for `/accessPoint/passphrase` and `/uplinks/-/config/psk` and **nothing at all**
for `/tunnels/-/config/*`. A VLESS `uuid` and a Trojan `password` were stored bare, returned by
`GET`, and shipped by the export that exists to be shared.

Detection for foreign schemas existed, was tested, and has a checked-in coverage file proving it
finds these exact fields. It was never called from the storage path. Every secret test passed,
because every one of them exercised `accessPoint.passphrase` — the one field the static schema
declares.

**Fixed structurally rather than by adding a call.** A `SecretPlan` is now a required constructor
argument of the profile store, it is the only thing that can produce matchers, and every write and
read goes through `matchersFor(document)` — a document, because which pointers exist under
`/tunnels/2/config` depends on tunnel 2's provider and protocol. There is deliberately no exported
way to get "just the static matchers": that value is what the defect was.

Two consequences worth stating. When no provider schema is available the plan says so and writes of
profiles **with tunnels are refused**, because storing a credential in clear on account of a missing
binary is a leak caused by an unrelated fault. And the export-time check was pointed the right way
round: it listed values that were already wrapped — warning about the safe ones and staying silent
about the dangerous ones — and now reports **unwrapped** values in opaque configurations, on both
export modes. That is the defence in depth: a detector somebody forgets to wire in announces itself
instead of leaking.

### A hardcoded reality read forced every plan to the `network` class

The caller read a fixed list of sysctl keys — `['net.ipv4.ip_forward']` — while the generator emits
two more whenever IPv6 is blocked. Those two were never read, so the differ saw them as changed for
ever, every plan was classified `network`, and the whole-apply refusal fired on **every** apply,
including immediately after a successful one.

The leak is not the false classification. An operator or a script that meets a spurious refusal every
time learns to pass the narrowing automatically, and from then on a real network change goes through
the path that exists to stop it. **A safety mechanism that cries wolf trains the bypass**, which is
worse than not having it.

**Fixed by** deriving the keys from the desired state. A key the generator emits and nobody reads is
a difference that can never be resolved.

The test that catches the whole class, rather than this instance: apply a profile, immediately
re-plan, assert the diff is empty — across every synthetic scenario. A plan that is not empty right
after its own apply is always a bug, whatever produced it.

That test found a second one on its first run. Two roles on one radio resolve to the same address, so
the planner emitted **two `.link` files matching it** with different names. systemd applies the first
in lexical order and the other silently never takes effect, so such a device would report a pending
rename for ever and one of the two names was a fiction. The first role to claim an address now pins
it and the second is reported as a note.

### The core-configuration validation step was theatre

It called the firewall checker on an empty ruleset, discarded the result, and reported success
unconditionally:

```ts
const result = await platform.nft.check('');   // an empty ruleset
void result;                                    // discarded
steps.push({ step: 'validate: core configuration', ok: true, … });
```

So a malformed configuration was written to disk with `validate: core configuration … ok` in the
log, and the truth arrived later as a generic unit failure — after files were written and other units
restarted. **A step that reports success without consuming a result is worse than no step**, because
the log then testifies to a check that never happened. In the very epic that wrote down *a schema
check is not a validity check*.

**Fixed three ways.** The step runs the core's own `check` against the generated file and derives its
outcome from it. A schema pass with Ajv now runs *before* the object is embedded, so a bad field
produces a JSON Pointer into the profile rather than a unit that will not start. And the shape was
changed so the lie is hard to write again: every step goes through one recorder that takes a function
returning a `ToolOutcome`, `ok` comes from that outcome and nowhere else, a throw is a failed step,
and there is exactly one `steps.push` in the file.

### The capability lookup took the first band, not the configured one

Both the invariant check and the hostapd generator used `bands.find(b => b.frequencyCount > 0)`. On a
dual-band radio that is the 2.4 GHz band, so a 5 GHz access point was validated against — and
generated from — the wrong band's HT and VHT capabilities.

Masked entirely by the hardware: the bench board's radios each publish one band, so the first is
always right there. It needs somebody else's dual-band radio to appear, and it appears as an access
point that will not start. Fixed as **one** function, with a dual-band synthetic inventory in the
golden set whose 2.4 GHz report has no VHT and whose 5 GHz report does — the asymmetry is what makes
the wrong lookup visible.

Two copies of a wrong lookup is also the signal that it wanted to be one function.

### Smaller, same family

* **The port-collision check inspected a subset of reality.** It walked the profile for ports it
  recognised, so a port a provider *allocated* was invisible unless that provider happened to be one
  it knew about. Every claim — allocated or stated — is now registered by the emission and the check
  reads that registry. An invariant that inspects a subset of reality is one that passes on the day it
  matters.
* **A blocked endpoint could be dropped without a word.** An IPv6 entry was filtered out silently, so
  an operator added a block, saw it in the profile and in plan review, and it did not exist. The
  address is now validated by shape in the schema; an IPv6 entry is a warning saying it is *redundant*
  because IPv6 is already rejected at the access point; an unparseable one is an error. The user is
  entitled to know a rule is unnecessary rather than to believe it is working.
* **`uplinkIndexOf` parsed an index out of an id.** `Number(role.split(':')[1])` on `uplink:wan-eth`
  is `NaN`, which fell back to zero — so every unbound-role finding pointed at the first uplink. A
  pointer that is confidently wrong sends somebody to fix a configuration that was never broken.
* **The routing preview built its interface list from all uplinks** while the generator used only the
  enabled ones. Rule generation had been unified so the two could not drift; the interface list had
  not, and a preview naming an interface that will not exist undermines the trust it exists to create.
* **`unwrap()` had a ternary whose branches were identical** — an intention nobody had written down.
  There is none: a secret's value is `string | string[]`, the core accepts either, and joining or
  splitting it here would change what the user typed. Deleted, with that stated, so nobody "fixes" it
  into a behaviour change.

## The bench board stopped accepting sessions, and the first theory was wrong

Dated 2026-09-20. Recorded while the cause is still **unknown**, because the part that is already
settled is a claim we made and had to withdraw, and that is the half worth writing down early.

### The symptom

The board accepted TCP on port 22 and closed the connection before sending a banner:

```
$ nc -z -G 3 <board> 22
Connection to <board> port 22 [tcp/ssh] succeeded!
$ ssh <board>
kex_exchange_identification: Connection closed by remote host
```

A listener answering and no banner following is sshd unable to create a session — the daemon is
running and accepting, and the child that would serve the connection never starts. It survived a
power cycle, which rules out a transient shortage that a restart would clear.

### The theory, and the measurement that killed it

The first explanation reached for was a full root filesystem, on the grounds that a deploy had died
mid-copy shortly before. That was wrong. The card was read directly, out of the board:

| Measured | Value |
|---|---|
| Filesystem size | 57.65 GiB |
| Used | 2.57 GiB (4.5%) |
| Inodes free | 99% |
| Filesystem state | clean |

Arithmetic settles it independently of the card. The **entire** deploy payload is 10 MB:

```
$ du -ch apps/daemon/dist apps/ui/dist deploy | tail -1
 10M	total
```

of which 6.6 MB is sourcemaps. A 10 MB write cannot exhaust 55 GiB of free space, so the full-card
explanation was never arithmetically available and should have been checked before it was believed.
The wrong reasoning is the useful part: *a deploy died during a copy* was treated as evidence about
**disk space** when it was only evidence about **a copy not finishing**, and those have many causes.
The superblock also showed the last write happening with the clock unset and the root mounted at
01:00, which is consistent with the board booting normally and sshd running.

**So the cause is not established.** What the evidence does narrow it to is a failure to fork or
allocate, not a failure to write. The candidates worth measuring when a board is next in this state,
in the order they can be checked:

* process-table exhaustion — `ps -eLf | wc -l`, `cat /proc/sys/kernel/pid_max`, and
  `systemctl show -p TasksCurrent wayfarer.service`. Two traps already in this document are about
  child processes accumulating in this daemon, which makes it the leading candidate;
* memory exhaustion or an out-of-memory kill — `journalctl -k -b -1 | grep -i "out of memory"`,
  `systemctl show -p MemoryCurrent`;
* a full `/run` — it is `tmpfs`, sized at 197.3 MB on this board, and sshd needs to write there;
* `/var/log` filling its own RAM-backed mount, which is separate from the card.

A note on what cannot be recovered afterwards: the journal for the boot in question is RAM-backed,
so it is gone. The persistent event ring is the only record, which is exactly the argument for
having it — and the reason the list above is about *live* commands rather than about reading logs
after the fact.

### What changed anyway, because each of these is correct regardless of the cause

**A ceiling on this unit's process count.** `TasksMax=512` in `wayfarer.service`. `MemoryMax`
already bounded what runaway children cost in memory; nothing bounded how many could exist, and the
process table is shared with the rest of the system. The symptom of exhausting it is precisely a
machine that accepts a connection on port 22 and cannot fork a session. This is a guard, not a
diagnosis, and it is labelled that way in the unit.

**The deploy no longer sends a source tree, and never did.** The staging directory was called
`/opt/wayfarer-src`, which was never accurate — only build artefacts and the installer's own scripts
have ever been copied — and a misleading name on a device is how somebody later concludes the board
runs from a checkout. It is now `/opt/wayfarer-install`, it carries an explicitly listed set of
artefacts rather than a mirrored directory, and it is **removed once the install succeeds**: a
payload left behind is a second copy of every artefact that nothing will read again and that the
next reader will mistake for the running version. The old path is deleted on every run, so boards
deployed before this change are cleaned up without anybody having to read a note.

**Sourcemaps are opt-in.** They are two thirds of the payload (5.6 MB for a 3.0 MB bundle, 1.1 MB
for a 0.5 MB CLI) and the device behaves identically without them. The card is the only part of this
device that wears out, so an artefact that doubles every deploy's write volume is one to ask for.

**Free space is checked before anything is written**, against `df -kP` on the device, and the
refusal names both numbers. `-P` matters: the default format wraps a long device name onto its own
line, so a reader taking field 4 gets a mount point instead of a number. Losing a connection is a
terrible way to discover a full filesystem even when that is not what happened this time.

### An ordering defect the tests found, which a human reading the script would not

The free-space check was placed where it read naturally — just before the copy — and the deadman was
armed above it. A test asserting that a refusal copies **nothing** failed, and the transcript showed
why: the deadman was armed, then space was checked, then the deploy refused. So a board with no
space would get an armed deadman over a deploy that never started, restore its configuration and
reboot for nothing, while the operator read a message about disk space and watched the device
disappear.

The check is a pure read, so it now runs first, before the deadman is installed or armed. The
general shape is worth keeping: **a refusal must be reachable before anything with a consequence
happens**, and the only way to know where that line falls is a test that asserts the transcript, not
the outcome.

## Five guards against an unbounded failure, none of them a fix

Added 2026-09-20, alongside the entry above about the board that stopped accepting sessions. **The
cause of that incident is still not established**, and each item here is written as a guard with its
own justification rather than as a remedy — a guard labelled as a fix gets removed the day somebody
finds the real cause, and these are worth keeping whatever that turns out to be.

The constraint that shaped them, and it was under-weighted at first: **the symptom survived a full
power cycle.** An exhausted process table does not. So whatever consumed the resource was being
re-created at every boot, which points away from "the deploy did something" and towards "something
that runs at boot does it again" — a shape worth designing against independently of what happened.

### `Restart=always` with no bound is an infinite loop written as configuration

The unit had `Restart=always`, `RestartSec=2` and no start limit of its own. systemd's defaults do
apply — `DefaultStartLimitIntervalSec=10s`, `DefaultStartLimitBurst=5` — and the reason that is not
enough is counter-intuitive enough to be worth stating: **a 10-second window catches a fast loop and
misses a slow one entirely.** A daemon that runs for thirty seconds before dying never trips it, and
restarts all day.

Now `StartLimitIntervalSec=300`, `StartLimitBurst=5`, `RestartSec=5`, `StartLimitAction=none`. At most
five starts in five minutes, then the unit stays `failed`. A daemon that has stopped trying is a
device somebody can diagnose; one that retries for ever is a brick.

Two limits stated rather than implied. The give-up does **not** survive a reboot, so a device booting
into the same fault gets five more attempts per boot — bounded per boot, which is the property that
matters. And the journal recording it is RAM-backed, which is the argument the persistent event ring
already answers.

`StartLimitAction` is `none` on purpose: a unit that reboots the machine on failure turns one fault
into a boot loop, and on a board with no console that is indistinguishable from dead hardware.

### `KillMode` is stated even though it is the default

`control-group` is systemd's default and the unit did not say so. With `process`, children this daemon
started survive each restart, so a bounded-looking failure accumulates processes across restart cycles
without limit — and this daemon always has children, because it drives several tools by running them.

Written down and asserted by a test that reads the shipped unit file. A default that is load-bearing
and invisible is one somebody changes while reasoning about something else.

### `TasksMax`, and why the number is the least interesting part

`TasksMax=512`. `MemoryMax` already bounded what runaway children cost in memory; nothing bounded how
many could exist, and the process table is shared with the rest of the system. The point is that **a
human can still get a login shell while our software is misbehaving** — the symptom of losing that is
a machine which accepts TCP on port 22 and closes it without a banner, because sshd cannot fork.

Measured on the bench board 2026-09-20 (Armbian 26.11.0-trunk.36, kernel 6.18.49-current-sunxi64,
systemd 257.13):

| Reading | Value |
|---|---|
| `kernel.pid_max` | 4 194 304 |
| `kernel.threads-max` | 15 537 |
| `DefaultTasksMax` | 2 330 |
| whole system at idle, `ps -eLf \| wc -l` | 156 |

So 512 is **22% of the cap that would otherwise apply** and 3.3% of the kernel's thread ceiling,
against a whole-system idle load of 156.

**A correction, and it is the kind of thing that gets repeated from memory:** `DefaultTasksMax` is
15% of **`threads-max`**, not of `pid_max`. An earlier version of this note said `pid_max`, which on
this board is 4.2 million and completely irrelevant to the limit that actually applies — 2 330 is
exactly 15% of 15 537. Reasoning from the wrong one would put the headroom out by two orders of
magnitude in the dangerous direction.

### The installer enables the daemon only after it has answered

It used to enable, then start, then check. That inverts the usual rule on purpose, and the reason the
two do not conflict is *which unit has already been seen working*.

"Enable before restart" protects a unit whose behaviour is known: a failing restart aborts a sequence,
and if enable has not run the unit is left disabled and the fault appears only after the next reboot.
That still holds, and it is still what the reconciler does.

An installer is the other case. It is putting a **new** bundle on the device, and enabling before
verifying hands the next boot a service that has never once been observed to work. With
`Restart=always` that is a board which fails the same way at every power cycle. So the installer
starts it, asks `/api/health` — the daemon, not systemd, because `is-active` is true of a process that
started, failed to bind and sat there — and enables only on the strength of the answer. A daemon that
cannot answer is left not-enabled, which is a device that boots clean and can be reached.

It also keeps **one previous bundle** beside the new one and restores it when the new one does not
answer, re-enabling it once it does: leaving a working bundle installed but not enabled produces a
device that recovers now and comes up dead later.

### The deadman masks the daemon before rebooting

In [15-bench-safety-net.md](15-bench-safety-net.md), with the principle: the safety net's job is to
return the device to a state a human can reach, which means taking our software out of the boot path
and not only our configuration off the network.

### Why these are asserted by tests that read the shipped files

Every property above is **silent when wrong**. There is no error, no warning, and no other failing
test — the result is a device that works for a while and then cannot be logged into, at which point
the evidence is in a RAM-backed journal about to be lost to the reboot somebody performs to fix it.
`apps/daemon/test/shipped-units.test.ts` parses the unit file, the deadman and the installer and
asserts each one. Checked against the previous revision of all three: every assertion fails there,
so none of them is vacuous.

## The dominant failure mode of this codebase

Not a trap among the others. **This is the way this project fails**, and it has now done so often
enough that it should be treated as the default suspicion rather than a recurring surprise. In almost
every instance below, *the tests passed and the system was wrong*.

### The three that were found by looking, not by failing

Most entries below were found the expensive way. Three were not, and they are the evidence that the
question at the end of this section works on code nobody has complained about:

* **Instance 15.** The boot guard's hand-written list of environment-dependent artefacts was recognised
  as the copy-of-a-truth shape and replaced while it still happened to be correct.
* **Instance 22.** Instance 19 was understood as a class rather than as a bug in a script, which made the
  next question obvious — *where else is a deadline recorded that something else independently
  maintains?* The answer was the confirmation window's revert timer, which had never failed a test and
  was silently postponing the single promise this project makes.
* **Instance 25.** *Has the path out of the fallback ever been observed?* It had not, and it did not
  work: a device that fell back would never have recovered by itself, in the mechanism whose whole
  purpose is recovering by itself.

> **A check that describes the truth instead of deriving it from the truth will eventually describe a
> truth that has changed, and it will keep passing while it does.**

The shape is always the same: something that *stands for* the real system — a stand-in, a mock, a
hand-written list, a literal in an assertion, a duplicated table — is easier to satisfy than the system
it represents. It answers the question it was told to answer. When the real system moves, the stand-in
does not, and nothing announces the gap: the suite is green, the file reads correctly, and the
behaviour is broken.

### The instances, in the order they were found

Each is recorded in full where it belongs; this is the index, not a retelling.

1. **A schema check is not a validity check.** The schema a binary emits describes what it can
   *parse*, not what it will *accept*. See *Probing binaries* below.
2. **A stand-in answers what it was told to answer.** The recording stand-in for systemd answered
   `enable` with success for a unit file that had never been written, so every test passed while the
   apply path was broken. See *Found in review, and why each one was worth a change*.
3. **A directive in the wrong section is a no-op.** `StartLimitIntervalSec` under `[Service]` parses,
   is ignored, and reads correctly in the file. See *systemd* below.
4. **A mock can prove only its own arguments.** A test substituted the whole `hostapd_cli` call and
   then asserted the arguments its own substitute had built — so it could not fail whatever the real
   argument list did. The fix was to extract the argument builder and assert *that*. See *Talking to
   hostapd*.
5. **A validation step that validated nothing.** The core-configuration check ran the firewall
   checker against an empty ruleset, discarded the result and reported success unconditionally, so a
   malformed configuration reached the disk under a log line saying it had been validated.
6. **A stand-in that answered a question the real system refuses.** The golden convergence helper
   marked every desired unit `known: true`, including templates — and systemd will not report a
   template's state at all, it fails outright. The invariant "a plan is empty after its own apply" was
   therefore proved against a reality that cannot exist, and the real device never converged. The full
   cost is recorded under
   [A plan that never converged](#a-plan-that-never-converged-and-what-it-cost).
7. **A list copied instead of derived.** The test written precisely so the runtime writability check
   would be a *backstop* enumerated the generators' directories by hand. Two new ones were added, it
   kept passing, and the runtime check became the discoverer instead. It now iterates the paths table.
8. **Two tables, stale in opposite directions, inside the function that decides how much protection a
   change deserves.** `classifyPath` still tested `/etc/systemd/system/` after generated units had
   moved, so every generated unit file silently stopped taking its unit's class; and a directory added
   later fell through to the class that gets **no confirmation window and no revert timer**. A change
   that took the uplink down committed instantly with nothing watching. This is the worst location the
   failure mode has found: the thing deciding how much safety a change gets was itself out of date.
9. **A measurement that reassured instead of measuring.** The revert allowance was compared against
   how long `revertTransaction` spent inside itself — 2 376 ms — while the cost the promise actually
   depends on, from the deadline to the device being reachable, was about twenty seconds. The missing
   eighteen were systemd starting the transient unit, the runtime booting, and the radio
   re-associating: everything outside the function's own view. The same shape as a stand-in answering
   a question the real world would answer differently, and worse than having no number, **because a
   number gets quoted** — anyone reading "the revert takes two seconds" would have sized the allowance
   from it. It is now judged on time since the deadline.
10. **Two settings, each correct, jointly defeating their purpose.** A different shape from the rest,
    and worth its own entry because no test of either one alone can see it: these are not stand-ins
    lying about reality, they are **two true statements whose conjunction is false**. The generated
    OpenVPN configuration carried `route-noexec` *and* `route-nopull`. The first stops the peer's routes
    being installed. The second discards **every** pulled option — including the `dhcp-option DNS` that
    the whole up-script arrangement exists to capture. Route suppression worked perfectly and the
    resolver capture returned an empty file.

    **The tell is that the second reads like a stronger form of the first**, which is exactly why
    somebody added it. So the remedy is behavioural rather than structural: *when two settings look like
    degrees of the same intention, find out what each one actually does, rather than assuming the
    stronger implies the weaker.* Nothing in a type system or a review checklist catches this; only
    reading the manual for both, or running them against something real.
11. **A rescue path that disabled itself while tracking whether it should run.** Safe mode recorded its
    own attempt with an illegal state transition (`staged → committed`), the error was swallowed on the
    way, and the row stayed `staged` — which, not being a failure state, **ended the consecutive-failure
    walk** and set the count back to zero. The most self-defeating failure found so far: the mechanism
    broke in the act of deciding whether to act.
12. **The pattern in the tooling rather than the product.** An exercise script reported "SAFE MODE WAS
    NOT ENTERED" for two runs in which it had entered perfectly, because it read a response field that
    exists only on the failure path. Indexed here deliberately: the pattern does not respect the
    boundary between the thing being tested and the thing doing the testing, and a harness that lies
    costs more than a product that does, because it is trusted while debugging.
13. **A guard that can never fire, because its arithmetic mixed two clocks.** `way doctor` computed a
    tunnel's uptime as `process.uptime()` — seconds since *the command* started — minus
    `ActiveEnterTimestampMonotonic` — microseconds since *boot* — and clamped the result at zero. The
    value was therefore always zero, every restarting tunnel looked freshly started, and the guard meant
    to exclude a long-running tunnel could not fire. A sharper instance than the earlier ones because
    **the arithmetic looks plausible until the units are named**: two numbers, both called uptime, both
    in seconds after a division, and nothing in the expression admits they are measured from different
    origins. The pure function was well tested with hand-written values, which is exactly why nobody
    looked at the numbers going in — the test at the *call site* is the one that was missing.
14. **Asking "did this end in a revert" instead of "did this fail".** Safe mode counted twice as
    failures things that were not: a plan refused before anything was attempted, and then a revert **the
    operator asked for**. Three deliberate changes of mind on a healthy device switched its tunnels off.
    A revert is a mechanism, not a verdict — it runs when a change failed *and* when somebody decided
    against it — and the field that distinguishes them was written to the row and then dropped by the
    query feeding the decision. The code was deciding while looking away from the one thing that mattered.
15. **Caught before it bit, for the first time.** The boot guard's list of environment-dependent
   artefacts was hand-written — the same copy-of-a-truth shape — and was replaced before it cost
   anything: artefacts now carry an `environmentDependent` mark **where they are generated**, and the
   allowlist is derived from that mark instead of being a second list. The test is the part worth copying:
   it plans the **same profile** against two different environments (`192.168.1.0/24` and
   `192.168.77.0/24`) and requires every file whose content differs to carry the mark. Removing the mark
   from the core configuration makes it fail with the exact sentence a maintainer needs.
16. **A stand-in's convenience swallowed the case the test existed for.** A test double for the probe
   client returned `series[index] ?? series[series.length - 1] ?? null`, so that a short series would
   keep answering. A deliberate `null` in the middle of the series — a *lost probe*, the whole point of
   the test — is falsy, so the `??` treated it as "past the end" and substituted the last real sample.
   The round that was written to fail passed. The fallback was there to make the double tolerant, and
   tolerance in a stand-in is indistinguishable from lying: it turned the one input that mattered into
   a different input. Doubles now bounds-check and return exactly what they were given.
17. **A migration tested as a pure function, and never invoked where it was needed.** The version 1→2
   profile migration had its own test, which passed, and ran only on the *import* path. Profiles
   already on a device are not imported; they are read. So the migration could never run on the
   documents that needed it, and the health watchdog threw on every round against a stored profile
   that predated the probe fields. Same shape as instance 13: **the pure function was well tested,
   and the test at the call site was the one that was missing.** Every read now migrates.
18. **A component that reported an intention rather than an outcome.** `decideSelection` was tested
   and correctly returned the fallback when every tunnel was unhealthy. Nothing tested that the
   fallback was a *member of the generated selector*, and it was not one whenever alternatives
   existed, so the core answered `400 Selector update error: not found` every round. The device went
   on **passing traffic through a tunnel the watchdog had already condemned, while reporting a
   decision it had not carried out.** That is the same shape as instance 5, the validation step that
   validated nothing, and belongs beside it: in both, a stage of the system announced a result for
   work it had not done, and everything downstream believed the announcement. A decision is not an
   outcome, and the only way to tell them apart is to check the thing that carries it out. The test
   that was missing reads the generated configuration and asserts the fallback is in the member
   list.
19. **In the safety net itself, and the sharpest instance so far.** The deadman recorded its own
   deadline at arm time and reported the remaining seconds from that record, because systemd's
   rendered `NextElapseUSecMonotonic` is awkward to do arithmetic on. The record was a copy of the
   truth, and the truth moved: `--on-active` deadlines are re-based by `systemctl daemon-reload`, and
   **every apply runs one**, so the deadman was postponed by its full interval by the operation it
   existed to protect — indefinitely, if the apply retried. Two failures for the price of one: the
   safety net would not have fired on the board it was watching, and its status line said
   `armed: -604s left` about a timer with four minutes to go, so a person reading it would have
   concluded the net had already failed and acted accordingly. The remedy is the general one:
   `OnBootSec` anchors the deadline to boot, which makes the recorded number *the same quantity
   systemd acts on* rather than a second copy — and because that equivalence is itself a thing that
   can quietly stop being true, `status` now checks the contradiction (an armed transient timer past
   its own deadline cannot exist) and reports the disagreement rather than either number. Found by
   reading a status line that did not make sense, not by a test. **This one has its own section**,
   because the same defect turned out to be in the revert timer as well: see *A deadline expressed as
   an interval from activation is not a deadline* below, and
   [15-bench-safety-net.md](15-bench-safety-net.md).
20. **Met again while writing the guard against it, within the hour.** The test asserting that the
   deadman no longer uses `--on-active` searched the whole script, and the comment explaining why
   `--on-active` is wrong contains the string `--on-active`. The test failed on its own prose. This
   is the third time a check in this repository has matched an explanation of the thing it forbids,
   and the fix is the same each time: strip comments before asserting. Worth recording precisely
   because it happened inside a deliberate attempt to be careful about this exact family.
21. **`NRestarts` answers a different question than the one it was read as.** The soak reported
   `daemon restarts 0` for a window that contained two deploys, because `NRestarts` counts restarts
   *systemd performed after a failure* and not `systemctl restart`, which is what an install does. So
   a window of repeatedly interrupted running read as a window of undisturbed running, and the
   `memory.current` minimum in it described a process that had just started. The name of the property
   is what made it look like the answer. The series now carries the unit's start timestamp and the
   count of starts is derived from that, which is the thing that actually happened. See
   [15-bench-safety-net.md](15-bench-safety-net.md).
22. **The same defect in the timer the operator's access depends on — found by looking, not by
   failing.** Once instance 19 was understood as a *class* rather than a bug, the question "where
   else is a deadline recorded that something else maintains" had an immediate answer: the
   confirmation window. Its revert timer was armed with `--on-active` **before** the reconcile ran,
   and the reconcile calls `daemonReload()` once per unit it installs — so a `network` apply
   postponed its own revert by the whole window, repeatedly. The promise made to somebody
   reconfiguring the network they are connected over was being broken by the apply in progress. It
   had never fired late in testing because every test that exercised it installed no units. Fixed and
   verified on hardware; see the section below.
23. **A countdown computed across two clocks.** The interface took the device's absolute
   `deadlineAt` and subtracted the browser's `Date.now()`. This device has no clock battery and its
   wall time can be days out after a power cycle, so the countdown was wrong by the whole difference
   — "0s left, undoing the change" on a device that had not begun undoing anything, or minutes
   apparently remaining on a window about to fire. The component's own reasoning was sound and
   documented (never decrement locally, always derive from a deadline); the deadline it derived from
   was simply in someone else's frame. **A duration means the same thing in every clock; an instant
   does not.** The device now sends how long is left and the browser anchors it once, on arrival.
24. **Two values that had to move together, one of them throttled.** A session's life is an idle
   duration, measured against an uptime anchor; "last seen" is also displayed to a person. The write
   that updates them is throttled to once a minute, because one write per request would be one card
   write per request. A version that moved only the displayed timestamp and not the anchor would have
   expired **every session at the idle limit however hard it was being used** — silently, totally, and
   with nothing in either value looking wrong on its own. Caught while writing it rather than by a test,
   which is luck, and the reason it is indexed is that the shape is general: *two values that must stay
   consistent, updated on different schedules.* The remedy has two halves, and both matter: **write
   them in one statement**, so no code path can move one without the other; and **assert the
   relationship between their constants**, not the constants — here `SESSION_IDLE_SECONDS >
   TOUCH_THROTTLE_SECONDS * 100`, which fails if either is ever changed towards the other, rather than
   two numbers a reader has to hold in their head and compare.
25. **The fallback was a one-way door, and the question found it.** Asked of the watchdog — *has the
   path out of the fallback ever been observed?* — the answer was no, and it did not work. `block` and
   `direct` are not tunnels and are never probed, so `block` was never "healthy" and its fail streak
   never advanced past zero; with `failStreak` at 2 the watchdog reported every round that "the current
   choice failed 0 round(s); 2 in a row are needed before switching" and stayed on `block` with a
   healthy tunnel measuring 196 ms beside it. **A device that fell back, or that came up before any
   tunnel was healthy, would never have recovered by itself** — in the mechanism whose entire purpose is
   to recover by itself. Every earlier test drove the fallback from the *other* direction, which worked,
   so the suite was green and the feature was absent. The cause is a guard applied outside the set it
   was written for: stickiness protects a working tunnel from one bad sample, and applied to something
   that is not measured it is not caution but a latch. The same fix covers a tunnel deleted from the
   profile while selected. Found by asking the question, not by a failure; observed fixed on the board,
   `traffic moved from block to probe-t`, with `wf-core` unrestarted.
26. **A failed read treated as a fact, in the cheapest possible place.** `touchSession` wrote the boot
   anchor unconditionally, so a single failed read of `/proc/uptime` stored `null` — and `sessionVerdict`
   reads a null anchor as "age unknown, re-anchor on this use". One hiccup therefore discarded up to the
   entire accumulated idle age: a session idle for six days was handed a fresh six days. Its sibling three
   lines away was already guarded, which is the part worth noticing — the rule was known and applied next
   door. This is the **absent-data rule** again (instances 3 and 14 of the same family in spirit): a read
   that failed is never evidence, and the old anchor remained the best thing known about that session.
27. **A measuring tool printed a number from input it could not parse.** After a field was added to
   the soak's sample row without adding a conversion to its `printf` — bash silently *reuses* the
   format rather than failing — half the rows held one value and ten empty columns. Nothing stopped:
   the report averaged them in and announced `card written -38.61 MiB over the window`, a negative
   quantity of bytes to two decimal places, alongside `memory.current min 0.0 MiB` and a database
   that had shrunk to nothing. The statistics were computed exactly as written; the input was
   rubbish, and nothing in the path had any opinion about that. `report` now refuses a series whose
   rows disagree with its header, and refuses to print a difference of a cumulative counter that has
   gone backwards. The generalisation is narrower than the rest of this list and worth stating
   anyway: **a tool whose output is evidence must refuse bad input rather than summarise it**, because
   its numbers get quoted and a plausible one is never questioned.

### The remedy, and how to tell whether you have applied it

Derive the check from the thing it checks. In practice:

* **Iterate the source of truth** rather than listing its members — the paths table, the generated unit
  list, the artefacts a plan emits.
* **Make the fall-back visible and safe.** An unrecognised case should be loud and should get the
  cautious answer, not the convenient one. See *blast radius* in
  [06](06-apply-and-rollback.md#the-class-is-computed-from-what-differs-not-from-which-file-was-touched):
  the default was the class with no safety net, which reads as caution
  and is its opposite.
* **Assert the property, not the literal.** A hardcoded `180` became `> 150` became unsatisfiable when
  the window was derived from the promise; two such assertions had to be rewritten against the
  constant, and one of them failed as a *hang* rather than a failure because an armed watcher was still
  polling when the test threw.
* **Compare two descriptions mechanically** when there must be two — the sandbox's writable set against
  the generators' paths, the shipped unit's directives against the units we generate.
* **Ask what the real system would refuse to answer.** If a stand-in can answer something the real one
  cannot, the stand-in is a different system.

Where none of that is possible in a unit test, run it once on hardware per epic and say plainly which
claims rest on which kind of evidence.

One more question to ask of any number this project records: **is it measuring the thing that is
promised, or a proxy that happens to be easy to reach from where the code is standing?** A proxy
smaller than the real cost is the dangerous direction, because it will be quoted as headroom.

### A third remedy: an invariant enforced at one door and not at the other

A new shape, found in the Epic D review, and it is not the seam family — every side of it was correct, and
the rule itself was right.

**The confirmation-window exemption was implemented, documented and tested.** A credential is never expired
while a transaction it opened is awaiting confirmation. The per-request check honoured it. And the session
**sweep** — a `DELETE … WHERE expires_at <= ?`, a few hundred lines away and written earlier — reached the
same state by a different route and honoured nothing.

So there was a rule, a check, a test, and a second path to the state the rule exists to prevent. Nothing was
inconsistent *within* either path. The sweep was not wrong about what it did; it was wrong about being the
only writer.

And the trigger was the designed path rather than bad luck: the apply restarts the time service, so a
forward clock jump of days inside the window is expected on this board — after which the sweep removed every
session created before the resync, refusing the operator inside their own countdown. If the re-login lost
the race, the change they were about to keep was reverted.

> **Where else is this state reachable from?**

Ask it of every invariant. "Is the rule right?" and "is the check right?" are both satisfiable while the
answer is still no, because an invariant is a property of *all* the paths into a state, and a test exercises
the path the author was thinking about. The specific smells:

* a rule enforced in a **read** path, with a **write** or **delete** path to the same state;
* a guard in a request handler, with a background job, a timer or a CLI command beside it;
* a condition expressed as SQL in one place and as code in another — they cannot share the rule, so they
  will diverge. The fix here was to make the sweep call the same function the request path calls, and
  accept row-by-row iteration to get it.

The secondary finding is worth as much: the sweep was **the last enforcer of a model the rest of the system
had abandoned.** Sessions had become idle-based; `expires_at` was read by nothing that authorises. An unread
stored value that looks like a control is a control nobody is maintaining, so when it fires it enforces
whatever was true when it was written. That is now asserted rather than trusted: a test greps the
authorisation sources and fails if any of them judges a session by its absolute expiry.

### A different remedy, for defects that live at a seam

Everything above assumes the defect is *inside* something, so that reading that thing carefully will
find it. One family in this catalogue does not work that way, and it took three instances to see it.

The deadline defects — instances 19, 22 and 23 — survived review because **every piece of them was
locally correct**:

* the interval handed to `--on-active` was a correct interval;
* the instant stored as `deadlineAt` was a correct instant;
* the countdown's own reasoning was not only sound but *documented*, with a good argument for why it
  must never decrement locally.

No amount of careful reading on either side of any of those boundaries would have found the problem,
because on each side there was no problem. The defect existed only at the seam: a quantity produced in
one frame and consumed in another, where the two frames can disagree. A reviewer checking the
producer sees a correct producer. A reviewer checking the consumer sees a correct consumer.

> **Name the frame a quantity is expressed in, at every boundary it crosses.**

Not "verify by result" — the result looks right on both sides. The question is a different one, and it
has to be asked *at the join*:

* **Which clock, which origin, which units?** Wall clock or monotonic; since boot, since unit
  activation, or since the epoch; seconds or milliseconds; this machine's clock or another's.
* **Can the two frames diverge, and by how much?** On this hardware the answer is days, because there
  is no clock battery. "They are usually the same" is the condition under which this defect hides.
* **Prefer a quantity that is frame-free.** A *duration* means the same thing in every clock; an
  *instant* does not. Three of the four fixes here were simply "send how long is left instead of when
  it ends". Where an instant must cross a boundary, carry the frame with it in the name —
  `firesAtUptimeSeconds` rather than `deadline` — so that the next person cannot read it as the other
  kind without noticing.
* **Where a number is recorded beside one that something else maintains, make them the same number.**
  Not two values kept in step, which is a promise nobody can keep, but one value with one owner.

The instance-13 unit mismatch — a container's uptime subtracted from the host's, both called uptime,
both in seconds — is the same family seen before it was understood, and it belongs here too.

### The questions, collected

These are the whole practical output of this document. Asked of something that is currently working, they
have each found a real defect.

The first one is first because it generalises further than any of the others: the rest are questions about
a *class of code*, and this one is a question about **every measurement**, including the ones used to check
the others. It was derived last, from the cheapest mistake in the set and the one that invalidated the most
work — a whole evening of plan previews fetched with the wrong HTTP method, printing `empty: None` from an
error object, reported upward as readings.

1. **If this call had failed, what would I see — and could I tell that apart from a real answer?** If the
   answer is no, the reader is missing a control, whatever it is reading. `None`, `0`, `[]` and `false` are
   all values a genuine answer can take, so an absent field and a real one are indistinguishable unless
   something that *must* succeed succeeds beside it. This caught a probe binary that did not exist on the
   board (twice — `dig` and `tcpdump`), a `timeout` that does not exist on macOS, and a plan route that was
   a `GET` being called as a `POST`. Every one of those produced confident silence rather than an error.
2. **What is the cheapest reading here, and does some component say this about itself directly?** We
   repeatedly prove through the *state of the system* something a subsystem is ready to state plainly
   about itself. Established sockets instead of the masking client's own journal, which said "session
   established" four times. A unit's `active`/`failed` instead of the client's error text, which named
   three different causes while the unit said one word. A station list from a tool that could not reach
   its socket, instead of an independent probe. Each time the direct reading existed, was cheaper, and
   was not used — five times in one day. A subsystem's own account of itself is usually both nearer the
   truth and less work than inferring it from what the system looks like from outside.
3. **Is every field this schema asks a person to fill presented to them somewhere?** A field the model
   offers and no screen renders is API-only, and nothing says so — not a test, not a type, not the plan.
   Measured on 2026-09-21: three fields on a tunnel (`transports`, `resources`, `probe`) were invisible in
   the panel, including the one that says what a destination tunnel is *for*. It was found by the owner
   asking whether the thing could be done with the mouse. Until this is checked mechanically, gaps of this
   shape are discovered by whoever first tries to use the product for its purpose, which is the worst
   possible reviewer to leave it to. See
   [the panel cannot express three things](14-open-questions.md).
4. **Is this check derived from the thing it checks, or is it a description of it?** A description will
   eventually describe a truth that has changed, and keep passing while it does.
5. **Where else does this shape occur?** Asked after every fix, of code nobody has complained about. It
   found instances 15, 22 and 25.
6. **What frame is this quantity in, and can it differ from the frame that acts on it?** Which clock,
   which origin, which units — asked *at the boundary*, because every side of a seam defect is locally
   correct.
7. **Where else is this state reachable from?** A rule, a check and a test can all be right while a second
   path to the same state honours none of them. Ask it of every invariant — especially where a read path
   guards something a write, delete, timer or CLI path can also reach. See
   [an invariant enforced at one door](#a-third-remedy-an-invariant-enforced-at-one-door-and-not-at-the-other).
8. **For any predicate that gates a rare action, has it ever been observed to be true?** If the answer is
   "presumably", it has not been tested. A predicate that is constantly false produces no anomaly to
   investigate — only a feature that quietly never happens. See
   [the register](#predicates-that-gate-rare-actions-and-whether-anyone-has-seen-them-fire).
9. **Is this number measuring the thing that was promised, or a proxy that was easy to reach from where
   the code was standing?** A proxy smaller than the real cost is the dangerous direction, because it
   gets quoted as headroom.
10. **Which way does this fail when it cannot tell?** Not "fail closed" — *fail towards the smaller loss*,
   and which direction that is depends on what is on the other side of the mistake. A certificate wrongly
   trusted exposes traffic to a stranger; a credential wrongly expired locks the owner out of their own
   device. See [10-security](10-security.md).

## Found on a bare board, 2026-09-20

The board was re-imaged, so everything below is from a **fresh Armbian 26.11.0-trunk.36** install
(kernel 6.18.49-current-sunxi64, systemd 257.13, OrangePi Zero3), not from the previous device. Every
measurement here carries that provenance, because the previous entries did not and one of them was
copied into a design decision it did not support — see the ruleset correction below.

### `StartLimitIntervalSec` in `[Service]` is silently ignored

The guard was written, the file was correct to read, and a test that parsed the file passed. On the
device:

```
$ systemctl show wayfarer.service -p StartLimitIntervalUSec
StartLimitIntervalUSec=10s          ← the untouched default, not the 300 in the file
```

`StartLimitIntervalSec`, `StartLimitBurst` and `StartLimitAction` are **`[Unit]`** directives. In
`[Service]` systemd parses them without a word and ignores them, so the crash-loop bound did not
exist. After moving them:

```
StartLimitIntervalUSec=5min
StartLimitBurst=5
StartLimitAction=none
TasksMax=512
KillMode=control-group
```

The test now keys every directive by `Section.Directive` and asserts the section it expects. A test
that checks for presence proves the text is there; only `systemctl show` proves it is honoured.

### The live ruleset on a fresh board is **empty**

An earlier note recorded "4 tables, 63 rules" as though it described this hardware. It described one
device on one day, after that device had accumulated software. On a fresh board with `nftables`
installed and nothing configured, `nft list ruleset` is empty and `nft list tables` prints nothing.

The rule that follows, and it is the reason this correction matters more than the number: **every
measurement in these notes names the device and the state it came from.** A figure without provenance
gets copied into a design decision, which is what happened here and what happened to the regulatory
domain below.

### The regulatory domain is per radio, and the earlier figures were another device's

Measured with `iw reg get`:

```
global            country DE: DFS-ETSI
phy#1 (built-in)  country 00: DFS-UNSET
phy#0 (USB)       absent → follows the global domain
```

An earlier revision recorded `country US: DFS-FCC` globally with `phy#1` at `00`, and listed the 5 GHz
limits that follow from US. Those were correct for that device and are wrong here: under DE,
5150–5250 permits 80 MHz at 20 dBm indoor-only, 5250–5350 and 5470–5725 require radar detection, and
5725–5875 is capped at 13 dBm — different numbers and a different channel set from the US figures.

`way doctor` on this board reports 38 usable channels for the built-in radio (its own `00` domain) and
64 for the dongle (the global DE domain), across 2.4, 5 and 6 GHz. **A channel list copied from a
document rather than read from the driver is the exact failure this project exists to prevent**, which
is why the correction belongs here in full rather than as a note.

### The roles are forced by the driver, not chosen

```
phy1 built-in   #{ managed, AP } <= 1          → exclusive: access point OR client, never both
phy0 USB dongle #{ managed, P2P-client } <= 2, #{ AP } <= 1, #channels <= 1
```

So on this hardware the arrangement is **access point on the dongle, client uplink on the built-in
radio** — and it is not a preference. The built-in radio is the one already associated to the upstream
network and carrying the management session, and it cannot host an access point without giving that up.

Two consequences for the profile, both worth stating because they are easy to get backwards.
`acceptChannelFollowsUplink` is **irrelevant** in this arrangement: the roles are on different radios,
so nothing constrains them to a shared channel. And the dongle's `#channels <= 1` limit only bites if
both roles ever land on it, which is the case the invariant check must keep refusing.

### A first install on a bare board: what is missing, and that the refusal works

`hostapd`, `hostapd_cli`, `dnsmasq`, `nft`, `openvpn`, `sing-box` and `node` are all absent on a fresh
image. The installer stops at the prerequisite check:

```
[wayfarer] error: prerequisites are missing:
  - nft
  - hostapd
  - hostapd_cli
  - dnsmasq
Install the distribution packages first:
  apt install hostapd dnsmasq nftables iproute2 iw wpasupplicant openvpn jq rsync
EXIT=1
```

**A refusal path that has never been exercised is an intention, not a feature**, so this was run before
anything was installed. One flaw found by running it: the script exits before reporting the *optional*
gaps, so `sing-box` and `xray` go unmentioned on the run where the operator is reading the list. One
run should tell them everything.

`apt install hostapd dnsmasq nftables openvpn` then gave hostapd 2.10, dnsmasq 2.91, nftables 1.1.3,
openvpn 2.6.14. **`sing-box` is not in the Debian archive**, so a bare board cannot be brought to a
working tunnel state by `apt` alone.

### Installing our own prerequisites leaves foreign units behind

| Unit | After `apt install` |
|---|---|
| `hostapd.service` | **masked** by the package itself |
| `dnsmasq.service` | **enabled and failed** — `systemd-resolved` holds port 53 |
| `openvpn.service` | active and enabled |
| `nftables.service` | installed, disabled, inactive |

We must not touch any of them, and that rule is unchanged. But the line *we* print telling the operator
to install those packages is the line that creates this, so it has to say in the same breath what the
packages will leave enabled and how to quieten them.

The real damage is not the overlap, it is that `systemctl --failed` is now permanently non-empty. **A
permanently failed unit trains everyone to ignore the one place the system says something is wrong.**

### The transient revert unit accepts an instanced name

The open question was whether systemd would accept a transient unit whose name contains `@` with no
template on disk. Measured, systemd 257.13:

```
Started wayfarer-revert@896dc6661337a779.timer - Wayfarer: revert transaction 896dc6661337a779 …
```

It works, so the documented name stands and the flat fallback was never needed. Recorded either way,
because "we reasoned it would work" and "we watched it work" are different claims.

One piece of noise to tidy: after a revert, stopping the already-gone service logs
`Unit … not loaded` as a warning. Stopping a unit that is not loaded is success, not a warning.

### The revert path fired on its own, unplanned, and worked

The first network-class apply this device ever performed failed verification —
`wf-dhcp@wlx90de8047b4b4.service is active=false enabled=true` — and the code reverted it without
being asked, moving the transaction to `reverted` with the reason recorded. Nobody set out to test
that; it is recorded as accidental rather than counted as a deliberate test.

The second attempt succeeded, which is consistent with `Restart=on-failure` covering the race the
dependency cannot: the address service had no address to bind the first time.

### An access-point interface has no carrier until hostapd starts

The settle step waited the full twenty seconds and then reported a healthy interface as broken:

```
wait for addressing to settle (up to 20s) — not settled in time —
  wlx90de8047b4b4: carrier=false address=10.44.0.1   (20128ms)
```

The address was there; the carrier was not, because **an access point has no carrier until the radio is
hosting**, and hostapd starts later in the apply order. So demanding a carrier there can never succeed,
wastes twenty seconds on every apply, and calls a working interface broken. The generated `.network`
file already carries `RequiredForOnline=no` for exactly this reason, which is the same fact written
down in a different place.

Fixed by making the expectation part of the plan: an access-point interface settles on an **address**,
a DHCP uplink on **carrier and address**. One definition of "up" is wrong for half of them.

### The device reported its own configuration as a foreign claim

The most valuable thing the apply-then-re-plan check found, and it would have made the product
unusable in a way no synthetic test could see.

The claim scanner reads `/etc/systemd/network` looking for interfaces another manager configures. The
apply writes `/etc/systemd/network/10-wayfarer-lan.network` into that directory. So from the **second**
plan onwards, every plan carried:

```
[error] interface_claimed_elsewhere — wlx90de8047b4b4 is already configured by
        systemd-networkd (/etc/systemd/network/10-wayfarer-lan.network)
```

An error, so `usable: false`, so **the device became un-appliable immediately after the one apply that
had worked.** And it is the worst kind of false alarm: a safety check that fires on correct operation
teaches the operator to bypass it, which is the same trap already recorded for the spurious
`network`-class refusal.

Fixed by skipping files that carry the generated header. Recognised by the header rather than by file
name, because the header exists precisely so a file found on a device can be traced to what wrote it,
and a name pattern stops matching silently the day a generator picks a different prefix.

### Writing back what a read returned fails, on every secret

Doing the most natural thing an automation client does — read the profile, change one field, write it
back — fails, because a read gives `{"$set": true}` and a write takes a literal or `{"$keep": true}`.
That is the intended contract and it is correct; what was wrong was the message, which stated the rule
and left the caller to work out which rule they had broken by comparing two shapes character by
character. It now names the mistake:

```
this is the shape a GET returns ({"$set": …}), not a shape a write accepts. A read never
reveals a psk, so send the value itself to change it, or {"$keep": true} to leave the
stored one alone.
```

### Epic B's outstanding check, on hardware

Apply a network-class profile, confirm it, re-plan immediately:

```
re-plan: empty True  usable True  blastRadius hot
  nothing to do: the device already matches this profile
```

It had never been run on a board, because until the network-class reconciler existed **every** plan on
every device was `network` — even the emptiest possible profile, since every plan contains the firewall
ruleset. Verified afterwards that the access point is genuinely up: `type AP`, SSID as configured,
`10.44.0.1/24`, `wf-hostapd@`, `wf-dhcp@` and `wf-firewall` all active and enabled, and `nft list
tables` showing only our own table.

One thing not yet explained: the profile asked for channel 36 at 80 MHz and the radio came up on
**channel 40 at 40 MHz** (`center1: 5190`). Not investigated, recorded so it is not lost.

## Rescue paths are the least-run code in the system

A pattern rather than a single trap, and it is worth stating at this length because it has now produced
three separate defects in this project — each of which would have appeared for the first time at the exact
moment it was needed.

| Path | What was wrong | When it would have been discovered |
|---|---|---|
| The deadman's fire path | `systemctl show -p NextElapseUSecMonotonic` prints a timespan, so the arithmetic died | On the first real lockout |
| The installer's prerequisite refusal | Never exercised; exits before reporting optional gaps | On the first bare board |
| The **recovery profile** | `country_code=00` is rejected by hostapd, so its access point could not start | On the first apply failure that needed recovery |
| The takeover's revert | Restores the file, not the effect; the device stays unreachable | On the first takeover that went wrong — which is what happened |

The common shape: code that exists to save the device runs **only** when something has already gone
wrong, so it is the least-exercised code in the system, and its failure arrives at the worst possible
moment and is indistinguishable from the original fault.

> **Anything that exists to recover the device gets exercised deliberately, on purpose, before we rely on
> it.** Not as a side effect of something else going wrong.

That means: fire the deadman on purpose. Run the installer on a board with nothing on it. **Apply the
recovery profile as an ordinary profile and watch it come up.** Revert a takeover while somebody is
watching. Each of those is cheap; each of them found something.

The `country_code=00` case is the sharpest illustration. The recovery profile takes its country from the
radio's reported regulatory domain, the built-in radio reports `00`, hostapd rejects `00` outright — so on
this board the one document whose entire job is to make the device reachable could not start its access
point. Nothing in any test saw it, because no test applied the recovery profile. It was found by looking
at a stray failed unit left behind by an unrelated experiment.

## A profile states a request; the device reports what happened

Generalised from the channel investigation above, because it is not about channels.

The profile asked for channel 36 and the radio came up on 40, for correct standards-required reasons. The
wrong responses are equally available and both are worse: refuse the request (an access point that fails
to start for behaving correctly), or show the requested value as though it were the outcome (a profile
that lies about the radio, undermining every diagnosis built on it).

> **Wherever a request and an outcome can legitimately differ, both are shown.** A single value that is
> sometimes the request and sometimes the result is worse than either, because a reader cannot tell which
> one they are looking at.

So the interface shows the effective channel and width beside the requested ones. The same reasoning
applies anywhere else the hardware gets the last word — negotiated width, transmit power, the regulatory
domain actually in force.


## A diagnosis offered with false confidence is worse than none

The certificate warning for a tunnel that keeps resetting names **the clock first** whenever the clock
is not known to be correct, and only then the certificate. The ordering is the whole value of the
message.

A board with no battery-backed clock, powered on somewhere with no working time source, reads a date
years in the past and therefore **rejects every certificate it is shown**. It reports a TLS failure for
each one. An operator reading "the certificate has expired" goes to their provider to argue about
credentials that were never wrong, and the actual fault — a clock — is the one thing they will not
check, because the device did not mention it.

So:

* when the clock is not trusted, the message says so first and the hint says *check the date before
  anything else, and if it is wrong nothing about the tunnel is at fault*;
* when the clock is trusted, the certificate becomes the suspect, which is then the likely answer.

**"Cannot tell" counts as not trusted.** An unverified clock and a wrong one produce identical
certificate failures, so a warning that named the clock only when it was *proved* wrong would stay
silent in precisely the case it exists for. This is the `Observation` discipline applied to a
diagnostic: the third value is not "fine".

## Never identify a process by a pattern that can match the thing carrying it

Measured on the operator's side rather than the device's, twice in one night:
`pkill -f "openvpn --config"`, sent over SSH, matched the remote shell's **own command line** — because
that command line contains the pattern — and killed the session along with the target.

On a workstation this costs a round trip. On a device reachable only over the network it could kill the
process that was about to put things back.

Audited in response, 2026-09-21: **nothing this project ships matches processes by pattern.** There is
no `pgrep`, `pkill`, `killall`, or `ps | grep` anywhere in the daemon, the platform layer, the installer
or the deploy scripts. Processes are addressed by systemd unit, and foreign software is found by asking
about named units rather than by searching a process table. That is the right arrangement and this note
exists so it stays that way: a unit name is an identifier the system guarantees, and a pattern is a
guess that includes the searcher.

## A deadline expressed as an interval from activation is not a deadline

This is the most serious defect found in this project, and it deserves to be stated without
softening.

**Every risky step taken on this device was guarded by a deadman that could be postponed
indefinitely by the very thing it was guarding.** The three recovery scenarios, the factory
reset, every network apply, every deploy — all of them ran behind a safety net that would not
have fired on a board it had just watched break. It never came to matter. That is luck, not
design, and the distinction is the entire reason this section exists.

### The mechanism

`systemd-run --on-active=<N>` creates a timer whose deadline is an offset from the **activation
of the timer unit**. `systemctl daemon-reload` re-bases that offset to the moment of the reload.
Measured on systemd 257.13, 2026-09-21: a timer armed for twenty minutes at 02:02:50, a reload
at 02:18:12, and the timer then due at 02:38:12.

Both timers this project depends on were armed that way, and both are reloaded by the operation
they protect:

| timer | what reloads it | consequence |
|---|---|---|
| the bench deadman | every apply and every install runs `daemon-reload` | postponed by its full window, repeatedly; an apply that retried would postpone it forever |
| the **revert timer** for a `network` apply | armed *before* the reconcile; the reconcile reloads once per unit it installs | the confirmation window's promise — "do nothing and the device comes back" — deferred by the apply itself |

The second is worse than the first. The revert timer is the promise made to somebody who is
reconfiguring the network they are connected over, and it was being broken by the apply in
progress at the exact moment it mattered.

### The class, which is the part worth keeping

> **A deadline expressed as an interval from activation is not a deadline. It is a delay, and
> anything that touches the unit can restart it.**

The remedy is an anchor to something that does not move — here `OnBootSec`, measured from boot,
on a board whose wall clock cannot be trusted. But the anchor is not the fix. **The fix is the
identity it creates**: the number the caller computed and recorded is now the same quantity
systemd acts on, rather than a second copy maintained alongside it. That is the general form,
and it is the same remedy as everywhere else in this document — derive the check from the thing
it checks — applied to a promise instead of to a test.

**Anywhere a number is recorded that something else independently maintains has this problem.**
Two were found by looking:

* The deadman recorded its own deadline and reported the countdown from that record.
* The confirmation window records `deadlineAt` as a wall-clock instant while systemd holds a
  monotonic one, and **the interface computed the countdown from that instant against the
  browser's clock** — a third copy, in a third frame, on a device with no clock battery whose
  wall time can be days out after a power cycle. The device now hands over *how long is left*,
  because a duration means the same thing in both frames and an instant does not.

### The reporting half is the same failure, and it is the one that hurts people

`wayfarer-deadman status` read the deadline from its own record and printed
`armed: -604s left` — overdue by ten minutes — about a timer with four minutes still to run. A
copy consulted instead of the source, in the half of the system whose entire job is to tell a
person what is true.

Consider what that line does at two in the morning. It says the safety net has failed. The
reasonable response is to stop trusting it and intervene by hand on a board that was fine and
about to recover on its own — and on this project's record, intervening by hand on a board
nobody can see is how boards get bricked. **A status line that is wrong is not a cosmetic
defect; it is an instruction to do the wrong thing.**

The remedy there is a contradiction check rather than a better copy: an armed transient timer
past its own deadline cannot exist, because it should have fired and collected itself. When
`status` sees one it now says the two numbers disagree and prints both, instead of presenting
either as fact.

### What was changed

* `deploy/bench/wayfarer-deadman` arms with `OnBootSec` and `status` reports drift. Verified on
  the board: `4937s` recorded, `4937s` in systemd, unmoved by three reloads.
* `apps/daemon/src/platform/systemd.ts` — `runTransient` takes `withinSeconds` (a deadline, not
  a delay) and anchors it to boot. An unreadable `/proc/uptime` is a **refusal**, not a fallback:
  the caller treats a refusal as "do not apply", which is the safe direction, and a deadline that
  cannot be anchored is a delay. Verified on the board with a real `network` apply: the revert
  timer sat at `1h 30min 39s` and was unmoved by three `daemon-reload`s, then cancelled by the
  confirmation.
* `apps/ui/src/components/ConfirmationWindow.tsx` counts down from a duration anchored once
  against its own clock. It still never decrements locally — a frozen tab must tell the truth
  when it is looked at again — but the deadline it derives from is now in the frame it is
  compared against.

## The clock-frame audit, and how all of it was closed

After the third instance of a duration living in a clock that was not the one acting on it, the class
was taken seriously enough to search for the rest rather than wait for them. This is the record of
that search: **fourteen candidates, all fourteen closed.** Each is recorded with what went wrong, both
so nobody rediscovers them and so that the two which were deliberate trades rather than corrections can
be argued with on the reasoning rather than re-decided by accident.

One fact reframes most of the list. **`reconciler.ts` restarts `systemd-timesyncd` inside the apply
that opens the confirmation window** — deliberately, and after the firewall, so the first time query is
not lost in the tunnel. Combined with a board that has no clock battery, that means *a wall-clock step
of days inside a confirmation window is the designed path, not a corner case.* Every window figure
derived from the wall clock was therefore wrong in the situation it exists for.

### Fixed

| what | frame problem | now |
|---|---|---|
| bench deadman deadline | recorded instant vs `--on-active` interval | `OnBootSec`, one number, drift check |
| revert timer | same | `OnBootSec` from `/proc/uptime`, refuses if unreadable |
| confirmation countdown in the page | device's instant minus browser's `now` | a duration, anchored once on arrival |
| confirmation countdown at its **source** | wall-clock deadline minus wall-clock now | `fires_at_uptime_seconds`, the number given to the timer |
| settle allowance (`window-watch`) | wall-clock delta **gating early reverts** | `performance.now()`, monotonic |
| safe-mode failure run | two stored wall-clock instants, and ordering by one of them | a profile `revision`, and `ORDER BY rowid` |
| `/api/health` daemon uptime | two wall-clock readings | `process.uptime()` |
| login lockout window | wall-clock cutoff, and it **deleted** history | boot identity + uptime; pruned by count |
| session expiry | absolute instant from creation | idle duration since last use, anchored to boot + uptime |
| token expiry | absolute instant enforced against any clock | enforced only when the clock is trusted, else **unverifiable** |
| revert overrun alarm | wall-clock instant minus wall-clock now, raising a false `error` | the anchored deadline; `null` is not judged at all |
| the soak's own window | two `date +%s` readings | the series' uptime column, and the wall clock only labels it |
| the soak's hourly rollup gate | wall clock across boots, failing towards **losing** the series | uptime, marker in tmpfs, failing towards one extra line |
| `logLevelRevertsAt` | an instant stored beside a monotonic `setTimeout` | a monotonic remainder, rendered on read |
| snapshot age | wall clock minus a file mtime across a power cycle | uptime within the boot, or "taken during an earlier boot" |
| inventory cache, unclaimed jobs, telemetry duration | wall-clock deltas inside one process | `performance.now()` |

Two of those were wrong *decisions*, not wrong numbers: the settle allowance could revert a network
that was still coming up, and safe mode could not be entered at all after a backward clock step,
however many applies failed in a row.

### One that was not about clocks at all, and was verified broken

`UPDATE sessions SET last_seen_at = ? WHERE … last_seen_at < datetime(?, '-60 seconds')`.

Two *representations* of one quantity. JavaScript writes `2026-09-21T00:15:28.634Z`; SQLite's
`datetime()` returns `2026-09-21 00:14:28`. The comparison is a string comparison, and at index 10
`'T'` (0x54) sorts after `' '` (0x20) — so the predicate was false for **every** ISO value, however
old. Verified against `node:sqlite`: a row two minutes stale, zero rows updated; comparing ISO to ISO,
one row. "Last seen" and "last used" have therefore been pinned to the moment of creation on every
device since the column existed, for sessions and for API tokens alike.

It belongs in this section because it is the same seam: one quantity, two producers, two formats, and
each side locally correct. Both are now written and compared by the same code in the same
representation.

**And it deserves more prominence than its size suggests, because of how it hid.** A predicate that is
*constantly* false is invisible in a way an intermittently wrong one is not. An intermittent fault
produces an anomaly — a value that is sometimes right, a report that disagrees with itself, something
that worked yesterday — and an anomaly is a thing to investigate. A predicate that answers the same way
for every input produces no anomaly at all. There is nothing inconsistent to notice, no failing case to
compare against a passing one, no moment when it changed. There is only a feature that quietly never
happens, and a column that holds a plausible timestamp.

Nothing in the system was wrong *except* the answer. The write was correct, the throttle was correct,
the schema was correct, the value stored was a real timestamp of a real event. The only symptom was an
absence, and absences are not reported. Add to the questions this catalogue asks: **for any predicate
that gates a rare action, has it ever been observed to be true?** If the answer is "presumably", it has
not been tested — and a test that only ever exercises the false branch passes forever.

### How the last five were closed, and one that needed a different answer

The remaining five were all wrong *numbers* rather than wrong decisions, and four of them became
monotonic without argument. The fifth could not.

**The soak's window mattered most of the five**, because it prints as "the whole basis for every number
below" and the shipped resource limits are set from those numbers — a wrong window discredits the lot.
It now comes from the series' own uptime column. That is unqualified rather than boot-scoped for a
reason worth naming: the series lives in `/run`, which is tmpfs, so it cannot survive a reboot and
every row in it is from the same boot by construction. The wall-clock start is still printed, labelled
`a note for a reader; the window above is not computed from it`.

**Its rollup gate was failing in the wrong direction**, which is worse than being wrong. It compared
the wall clock against the epoch of the last line written to the card — across boots — so a backward
step of an hour stalled rollups, and a reboot then discarded the tmpfs series that the hourly line
exists to preserve. An instrument whose entire output is a series must not fail towards losing the
series. The marker now lives in tmpfs, so a reboot means "write at once", and the cost of erring is a
few dozen bytes against a budget measured in megabytes an hour.

**The snapshot age needed a different answer, not a different clock.** It is the current wall clock
minus a file mtime written before a possible power cycle, and no monotonic reading spans that. But the
question a reader actually has is not "how many seconds" — it is "does this snapshot predate the
configuration I am running?" The manifest now records the boot identity and the uptime at capture, so
within a boot the age is exact, and across one `status` says **"taken during an EARLIER BOOT, so its
age cannot be measured here"**. That is both true and more useful than the number it replaces. The
general point: when a quantity cannot be measured in any available frame, the fix is often to ask the
question the reader had rather than to keep answering the one the code was written around.

### What the audit found sound, which is the other half of the result

Worth stating, because "we looked and these are fine" is a result and an unrecorded search gets
repeated. Clock-free by construction: event ring eviction is by `rowid` and retention is by **count**,
not age, so no clock can evict anything; the unconfirmed-transaction sweep at daemon start reverts on
the **existence** of a row rather than on any comparison, which is what makes it the correct cover for
power loss; the subscription refresh pipeline carries no timestamp at all, keying on the feed's node
id, and reads no `Date` or `Expires` header. Correctly framed already: `cli.ts` subtracts
`ActiveEnterTimestampMonotonic` from `/proc/uptime`, both `CLOCK_MONOTONIC`, and skips the calculation
entirely when uptime is unreadable; `platform/clock.ts` treats clock trust as an *input*, so the
certificate warning is gated on `synchronized === true` rather than on an assumption; `apply.ts` reads
the profile row's `updatedAt` rather than `meta.updatedAt` because the latter travels through a client.
Timestamps rendered for display in the interface are formatted, never differenced. No generated unit
uses `OnActiveSec` or `OnCalendar`, and no table takes a `CURRENT_TIMESTAMP` default, so SQLite is not
a second writer of time anywhere except the one comparison fixed above.

## Predicates that gate rare actions, and whether anyone has seen them fire

> **For any predicate that gates a rare action, has it ever been observed to be true?**

The question came out of the string-comparison defect, which was constantly false and therefore
invisible: no anomaly to investigate, just a feature that quietly never happened. A refusal nobody has
ever seen fire is a refusal we do not have, and the only way to know the difference is to make it fire.

This register is filled in as each is exercised. "Not observed" is an honest entry and stays until it
is replaced by a measurement; it is not a synonym for "probably fine".

| predicate | observed true? | how |
|---|---|---|
| session/token throttled touch (`last_seen_at < ?`) | **yes**, 2026-09-21 | Was constantly false and shipped that way. On the board: created `00:31:45`, last seen `00:32:55`. |
| soak report refuses a series it cannot describe | **yes**, 2026-09-21 | Truncated the live series to the previous sampler's twelve columns: refused, naming `uptime_seconds`. |
| soak report refuses a malformed series | **yes**, 2026-09-21 | Fired for real when a `printf` wrote every sample as two lines. |
| deadman snapshot age, "this boot" branch | **yes**, 2026-09-21 | Fresh snapshot: `1s old (this boot)`. |
| deadman snapshot age, "earlier boot" branch | **yes**, 2026-09-21 | The snapshot surviving a reboot: `taken during an EARLIER BOOT`. |
| deadman refuses to arm with no snapshot | **yes** | Covered by a test that runs the shipped script. |
| deadman status reports record/timer drift | **yes**, 2026-09-21 | This is how the `--on-active` defect was found: `armed: -604s left`. |
| revert timer refuses to arm when uptime is unreadable | **not observed** | Needs `/proc/uptime` to fail, which cannot be arranged without lying to the process. |
| kill-switch + fail-open refusal | **not observed on hardware** | Covered by tests; the pair has not been applied to the board. |
| deploy refuses an unreachable device | **yes**, 2026-09-21 | Fired with the wrong ssh key, which is how the misleading message was found. |
| deploy refuses when free space is short | **not observed** | The board has never been near full. |
| revert-overrun `error` event | **not observed, and here is why** | It needs a revert that genuinely takes longer than its allowance. Before the clock fix it was reachable by a clock step, which is exactly the false alarm that was removed; arranging a real overrun means slowing the revert path itself, which tests a delay rather than the device. Unproven — and at least no longer reachable by accident. |
| invariant refuses a foreign proxy core | **yes**, 2026-09-21 | A foreign `sing-box.service` started beside a profile with an enabled tunnel: `foreign_core_running`, naming the unit and the binary. The first attempt saw nothing and the code was right — the check is gated on the profile *wanting* to run our own core, because a foreign one contends only then. |
| invariant refuses a claimed interface | **yes**, 2026-09-21 | A foreign `.network` file written for the access-point interface: `interface_claimed_elsewhere`, naming the file. Cleared when the file was removed. |
| safe mode falling back to documented defaults with no usable access point | **not observed, and here is why** | It needs a device whose radio cannot host an access point *and* three consecutive failed applies. The bench board's radio can host one, so the branch is unreachable here without lying to the inventory — and a stand-in reporting a different radio would be testing the stand-in. Covered by a unit test against the pure function; the hardware path is honestly unproven. |
| capability gap reported with its command | **yes**, 2026-09-21 | `external-client` reported missing for `xray`, with the non-package remedy rather than an `apt` line that would not have worked. |
| capability gap **falsely** reported | **yes — it was, and that was the defect** | `revert-timer` read as unavailable on a device where it works, because `systemd-run` was required by a capability and never looked for by the inventory. Found by reading the report on hardware, not by a test. |
| the watchdog's path **out** of the fallback | **yes**, 2026-09-21 — and it was broken | `block` latched the selection forever. Asking the question is what found it. Now observed: `traffic moved from block to probe-t`. |
| probe destination blocked while the probe still measures | **yes**, 2026-09-21 | `{"domain":["cp.cloudflare.com",…],"outbound":"block"}` in the generated routing, and `GET /proxies/probe-t/delay` returned `196`. |
| sweep keeps a session whose absolute expiry is long past | **yes**, 2026-09-21 | Planted `expires_at 2020-01-02` with a fresh anchor: kept. The old sweep deleted any such row, which is the defect itself. |
| sweep keeps a session from an earlier boot | **yes**, 2026-09-21 | Unknown age, so re-anchored on use rather than retired. |
| sweep removes a session past the idle limit | **not observed on hardware, and here is why** | The limit is seven days *within one boot*, and the board has been up for hours — the branch is unreachable without either waiting a week or lying about the anchor, and a planted negative uptime would be testing the plant. Covered by unit tests against the pure verdict. |
| sweep spares a session holding an open confirmation window | **not observed on hardware** | Reachable only once the idle branch is, for the same reason. Covered by a test that asserts both directions of the exemption. |
| a password change revokes every session | **yes**, 2026-09-21 | 51 sessions before, 0 after, and the cookie that made the change then answered `401`. |
| a migration carries a blocked endpoint's suffix meaning forward | **yes**, 2026-09-21 | Planted a version-2 profile; on read it became version 3 with an explicit `domainSuffix` block rule, a `profile.migrated` warning in the ring, and both rules in the generated routing. |
| the panel answers on the access point | **yes**, 2026-09-21 | `10.44.0.1:8088` → 200, and the socket list shows it bound. |
| the panel answers on the uplink network | **yes**, 2026-09-21 | `192.168.77.8:8088` → 200 **from the workstation**, which is the witness that matters. |
| the panel does **not** answer on a tunnel | **yes**, 2026-09-21 | `172.19.0.1:8088` silent, and no socket bound to it. |
| the panel does **not** answer on the Ethernet lifeline | **yes**, 2026-09-21 | Same subnet as the uplink, and `ss` shows `.8` bound while `.7` is absent — per-interface, not per-subnet, proved by the socket list because a response could not distinguish them. |
| the core's dashboard is refused from the network | **yes**, 2026-09-21 | `9090` silent on `.7` and `.8` from the workstation; answers on loopback with `sing-box 1.14.0`. |
| a client on the access point reaches the internet | **yes**, 2026-09-21 — and it did not, until today | `https://example.com` → HTTP 200, 559 B, through the core on the unmarked (client) path, `tun0` packets rising. Before the empty-rule fix: every connection reset. |
| the confirmation countdown is actually seen | **it was not** | Rendered above the Apply button, off screen on a phone. Two applies reverted unconfirmed. Now scrolled into view and focused. |
| rule set refused as unfetchable | **not observed on hardware** | Covered by tests. It is a plan-time refusal, so it can be observed with a profile edit and no apply — worth doing if this register is revisited. |

## Three defects the board found that no build could

Each of these passed every test, on a suite that was green, and was found only by running the thing on
hardware. They are grouped because the reason they were invisible is the same in all three: the passing
path and the failing path differ by timing, by which process the code is running inside, or by a unit
state that only exists on a real system.

### A unit that succeeded was reported as a 90-second timeout

`wf-firewall.service` is a `Type=oneshot` running two `nft` invocations. The journal said `Finished` in
the same second it was started, and `systemctl` said `active (exited)`. The apply refused with
`timeout after 90000 ms` and reverted.

The cause is in `runJob`. `StartUnit`'s reply and that job's `JobRemoved` signal are two messages on one
socket, and the D-Bus binding dispatches everything it reads in **one synchronous pass**. Resolving the
method reply only *queues* the caller's continuation, so the signal was handled first, found nothing
registered for that job path, and **discarded the result**.

**Every unit ever started here before was slow enough to lose that race**, which is why a long run of
successful applies proved nothing about it. A unit that finishes inside one dispatch pass is the only one
that loses.

Two fixes, and the second is the important one:

* Results arriving with no waiter are kept briefly in `unclaimedJobs`, bounded by age and by count,
  because most such results really do belong to jobs queued by other software and nobody will collect
  them.
* **A timeout is no longer taken at face value.** The unit's own state is read before the job is called a
  failure — judged against `inactive` for a stop and `active` otherwise — and the step log says when the
  evidence was the unit rather than a completion signal. A missed signal is otherwise indistinguishable
  from a unit that never finished.

Proved by a test first, with an injectable bus: identical unit, only the message order differing
(`apps/daemon/test/systemd-jobs.test.ts`).

### A revert that undid nothing reported that it had reverted the device

The refusal ended *"The device has been reverted to the previous configuration."* The device was in fact
running the new configuration in full — every unit active and enabled, the access point up.

`documentBefore` was the document being moved *to*, because an earlier session had already applied it. The
revert planned it, found nothing to do, and correctly recorded `reverted`. **The sentence was the
defect**: it asserted what the revert was asked to do rather than what it did.

`RevertOutcome` now carries `changedNothing`, decided from the revert plan's own emptiness before the
reconcile runs. The durable point: on a device whose last committed document equals the one being applied,
a revert is inherently a no-op. The confirmation window still protects the device — its job is to undo a
*change*, and there is none — but a reader must not be told a rescue happened when none did.

### A plan that never converged, and what it cost

After a committed apply, re-planning still produced five `install` steps, one per template. The costs
compounded quietly:

* Epic B's invariant — *a plan is empty after its own apply* — violated on the real device.
* Every apply spent about **4.5 s** on pointless `daemon-reload`s.
* The interface would always show pending changes on a settled device.
* **The blast radius was permanently `network`**, so every trivial change dragged a three-minute
  confirmation window behind it.

Measured cause: `systemctl show -p LoadState wf-hostapd@.service` does not answer `loaded`, it **fails
outright** — *Unit name wf-hostapd@.service is neither a valid invocation ID nor unit name*. Only its
instances are units. So the answer was "not loaded" for ever.

`install` is now a `daemon-reload` and nothing else, planned when systemd's copy of the definition is out
of date. The same change fixed a second, unmeasured bug: for a plain unit already known to systemd the old
condition was false, so editing a generated unit planned a write and a restart with **no reload between
them** — and the restart then ran the definition systemd still held in memory.

Why no test caught it: `realityAfterApplying` in `planner-golden.test.ts` set `known: true` for every
desired unit **including templates**, so the invariant was proved against a reality that cannot exist.
With the old differ condition restored, the faithful helper fails 14 of the golden scenarios. This is
instance 6 of [the dominant failure mode](#the-dominant-failure-mode-of-this-codebase).

### A unit the profile no longer asks for

Found while exercising transports, and the same shape one level up. Removing a tunnel left **both** its
units running and enabled, holding their loopback ports, while the plan reported `empty`.

The differ only ever iterated the units the *desired state* names, so it structurally could not see one
that should no longer exist. The device reported itself converged while doing more than the profile asked.

`Reality.ownedUnits` now carries every `wf-*` unit systemd knows about, and the differ plans a stop and a
disable for any the profile has dropped. It is **optional**, so a caller that cannot enumerate units
degrades to the old behaviour rather than concluding that everything owned should be stopped — **an empty
list and "I could not look" must not mean the same thing.** Templates are skipped: a template has no
state.

On the board it immediately caught a third stray by itself: `wf-openvpn@certtest`, still **enabled** and
due to start at the next boot.

### A generated unit could crash-loop for ever

`systemctl show wf-supplicant@wlan0` reported **`NRestarts=20` with `StartLimitBurst=5`**. The limit was
never reached because systemd's default window is ten seconds and `RestartSec=2` means five restarts need
more than ten seconds — so no five of them ever fall inside one window.

`StartLimitIntervalSec=60` and `StartLimitBurst=5` are now in `[Unit]` on every generated unit that
restarts; `wf-core.service` already had them and the other six did not. The bounds are one
`RESTART_BOUNDS` constant, and the goldens were byte-identical afterwards.

The test is deliberately general rather than about the unit that failed: `shipped-units.test.ts` walks
**every** unit this project generates and, for each one with `Restart=`, asserts the directives are in
`[Unit]` and that `interval > RestartSec × burst` — the arithmetic, not the presence. Removing the bounds
from one generator produces *"wf-supplicant@.service restarts but has no start limit in [Unit]"*.

### A false refusal, caught by the check meant to catch real ones

The first apply carrying a supplicant refused with `/etc/wayfarer/supplicant — ENOENT`. The refusal was
**safe** — nothing touched, no revert timer spent — and wrong: the writer creates directories recursively,
so the directory would have existed a step later.

`directoryWritable` now probes the nearest **existing ancestor**, which is where the `mkdir` actually
happens and therefore where permission is actually decided, and names that ancestor when it is not the
directory asked about.

## Debugging the board itself: two traps and one thing still unexplained

### Do not poll a board with failing SSH credentials

OpenSSH 10 on this image has **`persourcepenalties` active by default** (`noauth:1`, `authfail:5`,
accumulating to `max:600`). Repeated authentication failures from one source earn escalating refusals that
present client-side as `kex_exchange_identification: Connection closed` — which looks exactly like a board
that has stopped accepting sessions.

So a loop that retries SSH with a wrong key **creates** the symptom it is diagnosing. Probe TCP/22 with
`nc -z` and back off.

Ruled out by reading the image rather than by guessing: OpenSSH's `PerSourceMaxStartups` bug. It is unset,
so the default is unlimited.

### A reachability probe can confirm a board that is switched off

From a workstation on `192.168.77.6`, `nc -z 192.168.1.84 22` **succeeds**. It is not the board.
`route -n get 192.168.1.84` shows the route leaving through `utun5`, a VPN interface — something at the
far end of an unrelated tunnel is answering on that address.

**A reachability check on a private address is worthless without checking which interface carries it**, and
on a workstation with a VPN up it will cheerfully confirm a device that is unplugged.

The check that does not lie about this: **ARP**. The kernel answers ARP whatever nftables or the routing
table say, so *no ARP reply on a subnet means the board holds no address on that subnet at all.*

### Still unexplained, and recorded as unexplained

During the lockout the board **accepted TCP on port 22** (closing before the banner) while **ICMP was
silent**. Both are kernel paths that need no `fork()`, so process exhaustion does not explain the lost
pings — and the board's firewall did not drop echo requests: the input chain's policy was `accept` and the
only rejections applied to traffic leaving through the uplink from access-point clients.

`PerSourcePenalties` matches the client-side symptom exactly and explains recurrence after a reboot
without needing anything to survive one, so it is the leading candidate. But **any story built only on
fork exhaustion is incomplete**, and this is written down as an open contradiction rather than resolved by
picking the tidier half. The full-card theory was killed separately by measurement: 57.65 GiB, 2.57 GiB
used, inodes 99% free, filesystem clean.

## `ReadWritePaths` is resolved when the unit starts, not when it is read

Found by running factory reset twice, and it is a first-class systemd trap rather than a detail of ours.

The installer creates `/etc/wayfarer` and `/var/lib/wayfarer`. The reset removed them and did not put them
back, so the first apply afterwards refused with `/etc/wayfarer — EROFS at /etc` — correct, since the
sandbox makes `/etc` read-only apart from the paths named in `ReadWritePaths`.

**And once the directories *were* recreated it still refused.** The daemon had been running while its
directory was removed, so its mount namespace still carried the old binding, and recreating the directory
on the host could not reach into it. A namespace is built at unit start and is not a view of the
filesystem afterwards.

So the reset now recreates both directories with the installer's own modes (`0750`, `0700`) and **restarts
the daemon last** — a service restart, deliberately *not* a reboot, being the smallest thing that rebuilds
the namespace.

A second defect from the same run: **a second reset reported five failures for work it had already done.**
Stopping a unit that no longer exists makes systemd *throw* — `DBusError: Unit wf-core.service not
loaded.` — rather than return a result, so testing the returned string missed it and the command exited
non-zero. A unit that is not loaded is already stopped.

## A backstop that always passes is worse than none

Four defects from one session, grouped because each one had the same character: the code was right and the
*conditions it ran in* were not what it assumed.

1. **The route-check backstop was vacuous at boot.** `After=wf-core.service` orders against the unit
   *starting*; the core creates its tun device a moment later. So the check reported "no tunnel device
   exists, so nothing can be captured" — a pass, every boot, before the thing it exists to catch existed.
   It now waits up to 30 s for a tunnel. **A backstop that always passes is worse than none, because it is
   also reassuring.**
2. **The core configuration depended on whether the core was running.** The tunnel's transfer network
   `172.19.0.0/30` was *discovered* from `tun0` rather than stated, so planning with the core stopped
   produced a different file. Harmless in an apply; not harmless for the boot guard, which runs before the
   core **by design** and would have rewritten the file on every single boot. It is a value we choose, so
   it is now stated from one definition.
3. **Verification sampled a converging system once.** Restarting the access point takes its interface away
   for a moment; `dnsmasq` starts into `unknown interface`, exits, and `Restart=on-failure` brings it back
   two seconds later. Verification read it in the gap and failed two applies that had in fact worked. It
   now samples over a bounded 10 s window and reports how long a unit took — which is *not* "wait until it
   passes": a unit still wrong at the end is still a failure. The underlying ordering was fixed too
   (`After=wf-hostapd@%i.service` on the address service).
4. **Kernel settings did not survive a reboot.** `sysctl` changes the running kernel and nothing else, so
   after every power cycle the plan wanted `net.ipv4.ip_forward` set back to 1 — meaning an unattended
   device loses its clients' route to the internet at every boot and nothing says why. A generated drop-in
   at `/etc/sysctl.d/90-wayfarer.conf` now persists them, **and** the live write still happens: either
   alone is a device that is right only before or only after a reboot.

## A probe that could not succeed, reporting the same thing as a probe that failed

Found while proving where the management surface answers, and it invalidated a set of results I had
already reported as proof.

Every check run from the development workstation was written as:

```sh
timeout 5 curl -s -o /dev/null -w "%{http_code}" "http://$address:8088/api/health" || echo "no answer"
```

**`timeout` does not exist on macOS.** So the command failed before `curl` ever ran, the `||` branch fired,
and every single address reported `no answer` — including `192.168.77.7:22`, which was carrying the SSH
session running the test at that moment. That last result is what exposed it: a port cannot be closed while
you are connected to it.

The results happened to be *correct* beforehand, because the addresses genuinely were not bound. That is
the dangerous part. **A broken probe and a true negative are indistinguishable**, so a harness that cannot
succeed will confirm every negative you ask it for, and it will do so most convincingly when you already
expect the answer.

Two things follow:

* **Prove a negative with a control that must come back positive.** The same harness, pointed at something
  known to work, is the only thing that separates "it refused" from "I never asked". Here the control was
  `192.168.77.8:8088`, which had to answer 200; when it did, the negatives beside it meant something.
* Use the tool's own bound (`curl --max-time`) rather than wrapping it in one that may not be installed. A
  dependency that is absent on the machine running the test is a dependency the test cannot report on.

This is the fourth entry in this document about a check that cannot fail, and the first where the check was
a shell command rather than code.

## A credential quoted from a record of how the device used to be configured

The access-point passphrase was passed on from a report written before a factory reset and a rebuild. It
had been correct when it was written. The device now carried a different one, so the client's four-way
handshake never completed — an association at `aid=0` with no flags, which is what a wrong passphrase looks
like from the other side and does not say so.

Small, and the same shape as the rest of this document: **a value read from a record of the past rather
than from the present state.** The remedy is the one already written down half a dozen times here — read
the state, do not quote a memory of it — and the reason it is worth its own entry is that this time the
record was a *report*, not a hand-written list or a mock. The class does not care what the copy is made of.

The generated configuration is the state for this purpose: `grep ^ssid /etc/wayfarer/hostapd/*.conf` and
the `wpa_passphrase` line beside it answer the question in one command, and cannot be out of date.

## One reader, but the two it replaced were not identical

A review finding said this codebase had two readers of `/proc/uptime` and should have one — correctly, since
it also carries a warning about confusing *process* uptime with *machine* uptime, and a fix for that has to
be applied wherever the readers are.

Collapsing them broke the apply:

```
cannot store REAL value in INTEGER column transactions.fires_at_uptime_seconds
```

The copy that was deleted did `Math.floor`. The survivor returns `/proc/uptime` as the float it actually is.
So unifying two functions that *looked* equivalent changed a value's type, and a STRICT table caught it
where nothing else would have.

**Removing a duplicate is a behaviour change until the two have been compared line by line.** The fix keeps
the reader honest — it reports what the file says — and puts the rounding where the integer is required,
which is also where the requirement is visible.

## The most basic change the product offers did not work for the person it was built for

A first-time user opened the panel, changed one setting, and got nothing. They could not say whether it
had failed to apply or whether the internet had failed to come up. **Both had happened**, for two
independent reasons, and neither was visible from the screen.

This is the most valuable evidence this project received, because it came from somebody with no knowledge
of any of the reasoning above.

### What the evidence said

From the transaction table and the event ring on the board, not from reasoning about the code:

```
03:55:25  ef228ed0  network  reverted   rev6   the confirmation window expired without …
03:56:13  2684668e  network  reverted   rev6   the confirmation window expired without …
```

Two `network` applies, at the same profile revision, **both reverted because nobody confirmed them.** So
the change was saved *and* applied; it then undid itself, twice, exactly as designed — and the person who
made it did not know a confirmation was owed.

### Defect one: a panel that is rendered is not a panel that is seen

The Apply button lives in the plan-review panel. The confirmation countdown renders **above** that panel.
On a phone, pressing Apply therefore put the countdown off screen above the finger that had just pressed
the button. Nothing scrolled to it and nothing took focus.

The countdown itself was correct, well argued and thoroughly tested — its four safety properties are
documented in the component. All of that was true and none of it reached the user.

`scrollIntoView` plus focus, and `aria-live="assertive"` rather than `polite`: a countdown that undoes
itself is not an aside. Guarded, because a missing browser API must not take down the panel whose whole
job is to be visible.

### Defect two: "No pending changes" was true about the draft and silent about the device

After saving, the bar read **"No pending changes"**. That is a statement about the *draft* — and the user
reasonably read it as "the device has my change". Saving stores a document; applying is a separate act.

Worse after the revert: the device had put the old configuration back, the stored profile still held the
edit, and the bar still said "No pending changes" — actively misleading, because the saved profile and the
running device now disagreed and nothing on the screen said so.

The interface already refuses to apply an *unsaved* edit and says why. **The mirror case had no such
clarity.** It now reports the two states separately, because they are different questions:

* `N unsaved changes` — the draft differs from the saved profile;
* `Saved — not applied yet`, with a banner explaining that saving and applying are separate *because
  applying can change the network you are reading this over*, and that a confirmation will be asked for
  and the device will put everything back if it does not arrive.

The second comes from the **plan**, which is the only honest source: it is the comparison between this
profile and what is actually running. A flag set when the save button was pressed would have been a copy
of a truth, and would have been wrong after a revert.

### Defect three: even when applied, no client could reach anything

Covered in its own entry above — the `tunnel-resources` anchor emitted `rule: {}` as a *preview note*,
which the generator wrote into the routing list, where the core matched it against everything and reset
every connection with `outbound not found`. So even a confirmed apply would have left the user with no
internet.

### What this costs, stated plainly

Three defects, on the ordinary path, for the most basic change the product offers. Every one of them was
invisible from the configuration, from the tests and from the code: the transactions were correct, the
countdown was correct, the generated file did not look wrong, and the suite was green.

**All three were found by one person pressing the buttons the screen offered.** Nothing in this document
is a substitute for that, and the register of unobserved predicates is the closest this project had come
to admitting it.

## A local process is not a client, and the substitution is how this reached a user

The access point served addresses, the phone associated, and no site loaded. Three faults were stacked,
and each one was hidden by the probe used to check the one above it.

**1. The resolver clients were told to use did not exist.** The generated `dnsmasq` configuration carried
`port=0` — DNS off — while handing out `dhcp-option=6,10.44.0.1`. The stated reason was that the proxy
core would answer instead. It cannot: the core's only inbound is a `tun` with `auto_route`, which captures
**forwarded** traffic, and a query addressed *to the device's own address* is input, not forwarded, so the
`hijack-dns` rule never fires. Nothing listened on port 53 at all.

That was checked before shipping by resolving a name **on the board**, which goes to `/etc/resolv.conf` →
`127.0.0.53` → systemd-resolved, and works. A locally-generated packet, a forwarded packet, and a packet
*addressed to the device itself* are three different paths. The first was proved and the second was
claimed.

**2. The probes that were supposed to catch it could not have succeeded.** `dig` is not installed on the
board, and neither is `tcpdump`. Both were invoked, both printed nothing, and the silence was read as
evidence — once as "the resolver gives no answer", once as "the query never left the box". This is the
third time in this project a probe that could not succeed was reported as a measurement; the first was
`timeout` on the workstation, which does not exist on macOS. The rule that would have caught all three is
the same one: **a probe is only evidence when a control that must succeed succeeds beside it.** Rewriting
the DNS check in `python3` with a `127.0.0.53` control that had to return an answer produced the real
reading immediately.

**3. Clients could not reach their own connectivity-check hosts, so a working network reported itself
as dead.** The watchdog's probe destinations — `cp.cloudflare.com`, `connectivitycheck.gstatic.com` —
were blocked for *everything*. Blocking them for the device is right: a probe answers "does this tunnel
carry traffic?" only if the endpoint cannot be reached any other way. Blocking them for clients is a
different act entirely, because those are the exact hosts a phone asks before deciding whether a network
works. Blocked, the phone shows "No Internet" and leaves for cellular **while the network is working**.

One list, two paths, and the rule did not say which path it was acting on. It does now, by source
address: the device's own traffic arrives at the core bearing the tun's address, a forwarded client's
bears the client's. The naive reading that produced the fault — *these hosts are blocked, therefore
block them* — is wrong because the list is not a list of hosts to block; it is a list of hosts whose
reachability must mean something specific **for this device**.

**And a fourth thing, which is a lesson about the first three.**

Between fault 2 and fault 3 sat a conclusion that was wrong, held with confidence, shipped, and then
reverted by the control that should have preceded it: that the tun's `stack: "system"` could not carry
forwarded traffic at all.

It came from a real forwarded client — a `veth` pair in a network namespace, built deliberately so as not
to substitute a local process for a client again. The client was at `10.99.0.2`. Every website timed out
from it while a local process on the same board reached the same address. The contrast looked decisive and
a table of it went into the source.

`10.99.0.2` is not in `route_exclude_address`. The core's replies to that client were therefore captured
by `auto_route` and sent back into the tunnel instead of to the client, so no handshake could ever
complete — **whatever the stack did.** A real associated station at `10.44.0.x` is inside the excluded
range and has no such problem.

Two controls, run in this order:

| stack | client | result |
| --- | --- | --- |
| gvisor | `10.99.0.2`, outside the excluded ranges | fails |
| gvisor | `10.44.0.240`, inside them | works |
| system | `10.44.0.240`, inside them | **works** |

The first two hold the stack constant and vary the subnet: the result flips, so the subnet was the
variable. The third is the one that should have been run before changing anything — it shows the original
setting was never at fault. `system` is now restored, and the only lasting change is this record.

So the second stand-in was broken more subtly than the first and produced a **more confident** wrong
answer *because* it was more realistic. Avoiding one substitution is not the same as testing the real
thing, and a probe built specifically to escape a known trap is exactly the probe nobody re-examines.

Two aggravating details worth naming, because both were available at the time:

* The core had already logged, under `system`, `open connection to …:80 using outbound/direct` — it was
  dialling out for a **forwarded** connection, which the claim could not account for. It was read and not
  weighed.
* The fix was written with a long confident comment before the control existed. Prose does not make a
  claim true, and a well-argued comment is harder to doubt later than a bare line of code would be.

**The practical rule this leaves:** a test client for this device must live inside the LAN the profile
serves. Anywhere else it cannot complete a connection, and the failure is indistinguishable from a broken
tunnel.

**And a fourth time, in the same session, after the rule had been written down.**

Every plan preview reported while diagnosing all of this was fetched with `POST /api/plan`. That route is
a `GET`. The response was `{"error":{"code":"not_found",…}}` each time, and the reader printed
`empty: None` — because the key was absent, not because the plan said nothing. It was reported upward as
though it were a reading.

Nothing was damaged: `/api/apply` is a `POST` and did work, so the device did what was asked. But the
preview that was supposed to show what an apply *would* do was vacuous for hours, and it was vacuous in
the one way that looks like data — a field printing `None` rather than an error printing loudly.

The rule that catches it is the one already stated twice in this document, and the reason it failed again
is worth more than the rule: **a control was never added to the plan reader**, because a plan is not a
network probe and the trap was filed as being about `dig` and `tcpdump`. It is not about network tools. It
is about *any* reading whose absence is indistinguishable from a legitimate value. `None`, `0`, `[]` and
`false` are all values a real answer could take.

So the register of unobserved predicates needs a companion question, asked of every reader rather than
every probe: **if this call failed, what would I see — and could I tell that apart from a real answer?**
If the answer is no, the reader is missing a control, whatever it is reading.

**The questions this adds to the collection:** *whose packet am I actually testing with* — mine, or one
I am only standing in for? And, once a stand-in is built: *in what way is my stand-in still not the
thing* — what does the real client have that this one does not?

## A permission decided by the domain the apply itself establishes

After a reboot the device would not bring its own access point back up, and the apply was refused with
`channel_no_initiating_radiation` for channel 36 — the channel it had been serving clients on minutes
earlier.

`iw reg get` reported `country 00: DFS-UNSET`, and under the world domain every 5 GHz band is published as
`PASSIVE-SCAN`, which is `no-IR`. So every 5 GHz channel reads as forbidden for an access point. But `00`
is the kernel saying **no country has been established** — a question still open, not an answer of
"forbidden". The country is established by hostapd, from the `country_code` the generator already writes,
when hostapd starts; and hostapd is started by the apply that was being refused.

The check was deciding a question against the only action that could answer it. It is self-locking in
exactly the shape already recorded for the clock — correcting a wrong clock needs a time query, and
transports that authenticate on a timestamp refuse to connect while the clock is wrong — and it is worse
in one respect: it is silent until a reboot, and its symptom from the other side of the radio is not an
error message but **a network that stopped existing**.

The finding is now reported as a *warning* whenever no country has been established and the profile names
one, with a message saying which question is open and who answers it. It stays an error once a country
**is** established, because then it is a real refusal. It is not hidden, because if the access point does
fail to start, that line is the one that explains why.

**The question:** *is this a fact about the world, or a fact about a state my own action changes?*

## The safety net fired for real, and nobody had arranged it

Every recovery claim in this repository until now rested on scenarios someone wrote. On 2026-09-21 the
deadman fired on its own, against a fault nobody staged.

What happened: the deadman was armed inside a diagnostic script and never disarmed, because the person
running it was chasing a different problem and forgot. The window expired. The deadman did what it is
for — masked `wayfarer.service` and every generated unit, took the whole stack out of the boot path, and
rebooted. The board came back on the Ethernet lifeline by itself, reachable, with `removed: []` and
`changed: []` in `last-fire.json` and the configuration fix from minutes earlier still on disk.

Three properties were demonstrated rather than asserted:

* **It fired on a real failure to confirm**, not a simulated one, and the failure was inattention — the
  most likely cause there is, and the one no scenario models well.
* **Recovery needed no hands.** No console, no card reader, no power cycle. The device rescued itself and
  waited.
* **It cost nothing it was not supposed to cost.** Configuration survived; only the running state was
  taken down, which is exactly the trade the design makes.

The detail worth keeping, and the reason this is recorded rather than quietly fixed: **the person who
forgot to disarm it is the person who built it.** Knowing precisely how a guard works, and why it must be
armed before every dangerous change, provides no protection at all against forgetting to turn it off.
That is the argument for a safety net that acts on its own rather than one that asks — and it is an
argument this project can now make from an accident instead of from a scenario.

It also produced a second finding immediately, because the reboot is what exposed the regulatory-domain
defect above: the access point could not come back up, and until the board was rebooted by something
nobody planned, nothing had ever asked it to.

## A class of its own: we depend on a value we do not set

Reverse-path filtering must be **loose** for a tunnel reached by `bind_interface`, or the kernel discards
the replies — the return packet arrives on the tunnel interface while the route back to that source would
be chosen elsewhere. The tunnel comes up, the route is right, the resource never answers. It reads as a
broken tunnel and is not one, which is the worst possible disguise.

Measured on the bench board, 2026-09-21: every interface already reported `rp_filter=2`, and **nothing set
it.** No line in `/etc/sysctl.d`, none in `sysctl.conf`. It was the operating-system image's default
(`conf.default = 2`, `conf.all = 0`). The dependency held, and this repository had no part in it.

> **A dependency that happens to hold is not configured; it is one nobody has noticed yet.**

That sentence is the class, and the class is worth more than the fix. It is not the same as a check that
describes a truth instead of deriving it — here there was no check at all, and nothing to notice. The
device worked, the tests passed, and the property it relied on was supplied by something outside the
repository that never promised to keep supplying it. On an image shipping the common strict default of `1`,
every interface-bound tunnel would have failed on the first attempt.

**The question to ask:** *what does this depend on that nothing here sets?* Not "is this configured
correctly" — configured **by whom**.

### The siblings, found by asking it once

Asked of this device immediately, the question produced three more, all measured on the bench board on
2026-09-21 and all currently supplied by the image rather than by us:

| depended on | supplied by | what breaks if it stops, and how it looks |
| --- | --- | --- |
| `systemd-networkd` enabled | the image | Every `.network` and `.link` file this project generates is read by networkd and **by no unit of ours** — the source says so. Disabled, the files are all present and correct and the access-point interface simply never gets an address. The symptom is "the access point exists and nobody can get an address". |
| `systemd-resolved` enabled | the image | `/etc/resolv.conf` is a symlink to its stub and the device's own resolution goes to `127.0.0.53`. Every health probe fetches a URL by name, as does every subscription refresh. Disabled, all probes fail — and with blocking defaults that refuses traffic on the strength of a resolver outage. |
| `systemd-timesyncd` enabled | the image | This project has a whole design for a clock it cannot trust, and exempts time synchronisation from the tunnel by destination port. The thing that actually **sets** the clock is timesyncd, which nothing here enables or verifies. |

A fourth was found the same day by a different route and belongs in the same list: **the wireless
regulatory domain**, which the channel check reads and `hostapd` establishes. That one was found because a
reboot exposed it; the other three were found by asking the question.

None of the three is fixed yet, and saying so is the point — they are recorded here as what they are, four
dependencies with an external owner, rather than quietly repaired one at a time. The repair is a
requirement check in the same shape as the binary checks: state what must be true, read whether it is, and
refuse with a sentence naming who is supposed to provide it.

### Why this is not paranoia

The device is meant to be reproducible from this repository alone. Every one of these is a case where it is
not: the same repository on a different image produces a different device, and the difference appears as a
tunnel that will not carry traffic, an access point nobody can join, a probe that fails everything, or a
clock that never gets set. All four look like faults in this project, and none of them would be.

## The confirmation that mattered most was not the one that was designed

The `sniff` fix — without which no rule naming a domain matches a client's traffic — was proved by a
controlled experiment: a deliberately dead tunnel, a forwarded client in a network namespace, three attempts
per configuration, a gateway-ping control, and a control destination that had to keep working. It refused
the request three times out of three where it had previously served it. That is a good measurement.

The better one arrived by accident. While checking something unrelated after a sysctl apply — whether the
access point had survived — the core's live connection table was read, and it contained this:

```
10.44.0.103 -> host=i.instagram.com        ip=157.240.234.63:443  chains=[direct, wf-selector] rule=final
10.44.0.103 -> host=gateway.instagram.com  ip=157.240.234.19:443  chains=[direct, wf-selector] rule=final
```

A real phone, over the air, on a 5 GHz access point, with the **host field populated** on forwarded TLS
connections. That is the sniff action doing its work on traffic nobody arranged, at a moment nobody was
testing it.

**Why it is worth more than the designed experiment.** The controlled test was built by the same person who
had just been wrong twice about this exact area — once by substituting a local process for a client, once by
substituting a client outside the excluded ranges for one inside them. A test built to confirm a belief
shares the belief's blind spots, and both earlier mistakes were invisible *to the test that was supposed to
catch them*. The phone was not constructed by anyone, had no idea what was being measured, and could not
share the assumption. It is the difference between a witness and a reconstruction.

**The habit this names, which is the transferable part:**

> Look at what the device is actually doing, even when you are there for something else.

A live system is continuously producing evidence about questions nobody asked it. The connection table was
open for thirty seconds to answer "is the access point still up"; it also answered "does name matching work
for real clients", which had cost hours and two wrong answers to establish. Reading it cost nothing. The
cost is entirely in the habit of looking.

This pairs with the register of unobserved predicates and points the opposite way. The register asks *has
anyone ever seen this fire?* — a question about the gaps in what has been watched. This asks *what is the
system telling me right now that I did not come here to ask?* One is an audit; the other is attention.

## Three defects behind one symptom, each invisible until the last was fixed

An external client — a proxy client this project starts and then talks to over a loopback port — refused
to start. Getting it running took three separate fixes, in three different places, and **every one of them
presented as exactly the same thing: a unit that would not start.**

| # | what was actually wrong | what `systemctl` said |
| --- | --- | --- |
| 1 | The provider's schema advertised a `configFile` field and **no generator ever wrote one**. | `failed` |
| 2 | The file was written, but the field is `x-secret`, so the generator saw a `{ $secret: … }` wrapper. The writer unwrapped it; the script that must point at the file tested `typeof === 'string'`, concluded there was no configuration, and never exported the variable. **The file existed and nothing referred to it.** | `failed` |
| 3 | Both halves correct, and the client parses its configuration format **from the file extension**. Our convention names it `<id>.conf`; that client only reads `.json`. | `failed` |

Each fix revealed the next. Nobody could have found the third while the first was in the way, and no amount
of staring at the unit's state would have distinguished them, because the unit's state was identical in all
three cases.

**The general form, which is the part worth keeping:**

> When every cause of a failure presents identically, the failing component's *state* carries no
> information. Only the component's own error text discriminates between them.

The three messages, in order, each naming its own cause precisely:

```
WAYFARER_CONFIG_FILE: parameter not set          <- nothing was written, or nothing pointed at it
core: Failed to get format of …/relay.conf      <- written, pointed at, unreadable by name
core: Xray 26.3.27 started                       <- correct
```

`active`/`failed` said the same word three times. The client said three different sentences, and each one
named its own defect exactly. **Read the thing that failed, not the thing that supervises it.**

This sits directly under the register's first question — *if this call had failed, what would I see, and
could I tell that apart from a real answer?* — and extends it. There, the danger was an absent reading
indistinguishable from a real one. Here, the readings are all present, all real, and all identical: a
supervisor reporting `failed` is a true statement that happens to carry no bits. A symptom shared by every
cause is worth exactly nothing as evidence, however faithfully it is reported.

**The habit:** when a component fails, go to its own log before its supervisor's status, and keep going
back to it after each fix — because the message changes even when the status does not.

## The dominant class: a gap between producing a value and consuming it, invisible from both sides

Four defects found in one night, in four different subsystems, by four different routes. They are one
defect wearing four costumes.

| # | what was produced | what was supposed to consume it | what it looked like |
| --- | --- | --- | --- |
| 1 | The firewall marked the device's own traffic `0x1e7`. | A policy rule acting on the mark. **There was none.** | Everything worked — the traffic reached its destination through the tunnel instead of around it, so nothing looked wrong. The time-sync exemption was inert and the clock trap it exists to prevent was unguarded. |
| 2 | The external-client provider's schema offered a `configFile` field. | A generator writing that file. **There was none.** | A client that would not start. |
| 3 | The transport's configuration file was written to disk. | A start script exporting its path. It tested `typeof === 'string'` on a stored-secret wrapper and concluded there was no file. | A client that would not start — the same symptom as #2, for a different reason. |
| 4 | The up script captured the peer's pushed resolver into `/run/wayfarer/tunnel/<id>.dns`. | The core generator, which used the profile's static value instead. | Internet worked and internal names went silent. **A user found this one, not us.** |

| 5 | Nothing. `hostapd_cli` could not reach its control socket. | Everything that asks this device about its own access point. It printed `Failed to connect to hostapd` **to stdout and exited zero**, so the caller received an empty list. | "No clients are connected" — reported confidently, all evening, while two were. |
| 6 | The client's DNS question. | Any measurement on this device able to see it. There was none: no packet capture, no connection-tracking file on this kernel build, no query log. | An internal name that would not open, with no way to tell "the client never asked" from "we answered badly". |

Each was present, correct, and complete on its own side. Each had a counterpart that did not exist, did not
run, or tested the wrong thing. And in every case the missing half was invisible **because the system kept
working**: marked traffic still arrived, a config file still sat on disk, a captured value was still
accurate. The only one that announced itself did so as a unit refusing to start, and then did it three
times for three different reasons.

> **Every produced value names its consumer, and the write must provoke the read.**

The first half is the existing rule — every generated artefact declares `consumedBy` — extended from files
to *values*. A mark, a schema field, a captured measurement and a file are all things one part of the
system produces for another, and only the file had the rule applied to it.

The second half is the one this night actually taught, and it is the sharper one. **A consumer that only
runs when something else happens to trigger it is not a consumer.** Reading the captured resolver at
generation time would have "fixed" case #4 while leaving it broken: the peer moves the device to another
gateway on a Wednesday afternoon, the file updates, and nothing reads it until the next apply — which may
be a week away, or never. That is the same defect with a longer fuse, and it would have been shipped as a
fix. So a produced value must either be read on every use, or its production must notify the thing that
reads it.

**The question to ask of anything a component writes:** *who reads this, when, and what makes them?* If the
answer to the third part is "somebody runs an apply", the value is not wired up — it is merely stored.

### The same gap from the other side

The first four are one shape: **a value exists and nothing reads it.** The last two are its mirror, and
noticing that they are the same defect is what turned a list of incidents into a class.

Case 5 is **a reader with no value, which does not know it.** Something asks the access point who is
connected; the command cannot reach its control socket, says so on standard output, and exits zero. The
caller sees an empty list and cannot distinguish "nobody is connected" from "I could not ask". That is the
register's first question — *if this call had failed, what would I see, and could I tell that apart from a
real answer?* — answered "no", in code rather than in a report.

Case 6 is **a value nobody can observe at all.** When a client's name lookup failed, there was no
measurement anywhere on this device that could see the question arrive: no packet capture installed, no
connection-tracking file in this kernel build, no query log. So "the client never asked us", "we answered
wrongly" and "we answered correctly and the client ignored it" were one appearance with three causes and
nothing between them. An hour went into guessing about someone else's phone.

> **When a question and its answer have no common witness, diagnosis becomes a search over hypotheses
> about somebody else's machine.**

So the class is not "a value is written and never read". It is **any break between producing a value and
consuming it that neither side can see** — the producer because its output leaves correctly, the consumer
because what it receives is indistinguishable from a real answer. Six instances in one night, in six
subsystems, found by six different routes, and every one of them looked like something else first.

### And the author fell into it the same hour

While writing this rule down, the same evening, I reported that the dynamic-resolver handling "has now
been seen working on real traffic". It had not. What I had seen was OpenVPN's own log line reporting that
*it* had received the peer's second resolver value. That is the peer's behaviour and our capture — the
production half. The consumption half, the part that was broken, produced no log line at all, and I read
the presence of the first as evidence of the second.

That is "a report of an action is not the action", committed by the person who had just been told to write
it into this document, against the very feature the rule was about.

It is recorded here deliberately. A rule that has only ever caught other people is a rule nobody has
tested. This one caught its author within the hour, on the same subsystem, which is the only evidence
worth having that it is sharp enough to be worth keeping — and the reason the entry above is written as a
question to ask rather than as a lesson to have learned.

## Our own defect, wearing somebody else's costume

A destination tunnel stopped completing its key negotiation. The evidence pointed outward at every step:
the transport connected, the masking layer reported an authenticated session four times, the server's
address answered from the board, and an identical tunnel to a different server worked perfectly. Two
separate diagnoses concluded the fault was on the far side — first from established sockets, then, better,
from the masking client's own journal.

It recovered without anyone touching it, in the same window in which **a defect of ours was fixed**: a
policy rule keyed on a firewall mark had been sending the board's own outgoing packets out of the physical
interface carrying a source address nothing could route a reply to. The transport runs as root. That
produces exactly the observed shape — an authenticated session that stands, and a negotiation behind it
that hears nothing back.

It is not proven; it was not measured at the time. What is certain is the cost: **an hour of diagnosis
aimed at somebody else's server, and a question very nearly asked of the person who owns it.**

> A defect of ours, appearing inside someone else's component, is indistinguishable from a fault of theirs
> — and every instinct points away from us.

The general shape is worse than an ordinary wrong diagnosis. When a fault presents *inside a subsystem we
did not write*, the natural reading is that the subsystem is broken, and every measurement taken inside
that subsystem agrees, because it is genuinely not working. The masking client really could not complete
its negotiation. The server really did not answer. Both observations were correct and both were effects.

**What would have caught it, and it is cheap:** when something outside our control appears to break,
establish what *we* changed in that window before concluding anything about them. The board's own outgoing
traffic had been broken for part of the evening by a change made that evening, and nothing in the
diagnosis of the tunnel ever asked that question.

It also argues for a narrower habit: **a change that alters how this device's own traffic leaves should be
treated as capable of breaking every tunnel**, because every tunnel client is a local process whose
transport leaves the same way. That is not obvious from the change itself, which looked like a routing
nicety about marks.

## A different class: the gap between the system and the person

Every plan this device produces carries this note:

```
Access-point control uses the socket at /run/wayfarer/hostapd. Running hostapd_cli by hand needs
`-p /run/wayfarer/hostapd`, or it reports a working access point as absent.
```

It is there because the trap was found once already on this board, fixed in the platform layer — which
passes `-p` on every call, in a function extracted so a test can assert the real arguments — and written
down for the next person.

The next person then ran `hostapd_cli -i <ap> all_sta` by hand, without `-p`, got the tool's default
directory, and reported "no clients are connected" repeatedly over an evening while two were, including
while diagnosing a fault for a user who was sitting on that very access point.

This is not the class the rest of this document collects. There was no gap between producing a value and
consuming it: the value was produced, surfaced at the right moment, in the right place, in plain words.
**It was read past.**

Which is the failure mode every note in this repository is exposed to, and worth stating plainly next to
all of them:

> A warning is only worth what it costs to ignore. Writing it down protects the next person only if the
> next person is not in a hurry — and the one time it matters most is the one time they are.

It sharpens the second collected question rather than adding a new one. *What is the cheapest reading
here?* — here the cheapest reading was not a different command. It was the output already on the screen.

### The conclusion, which is about design and not about attentiveness

The tempting repair is a better note. That is not available: **the note was already as good as a note can
be.** It appeared in every plan, named the exact command, gave the exact flag, and described exactly what
the failure would look like. A second copy of it would not have been read either, for the same reason the
first was not — the moment it matters is the moment somebody is in a hurry and types what they always type.

> **A warning that can be ignored is weaker than a mechanism that cannot be bypassed.** Every note of the
> form *"when doing X by hand, remember Y"* is an admission that we did not finish Y.

The right repair is to make the obvious action correct, rather than to document that the obvious action is
wrong. Here that means putting a wrapper on the device's `PATH` that always supplies our socket path, so
somebody typing the habitual command at three in the morning gets the right answer instead of an empty
list — beside the original tool rather than shadowing it, so nobody is surprised by what they invoked. The
note then becomes a hint rather than the only defence.

**How many such admissions does this repository contain?** Counted on 2026-09-21: **two**, and they are
the same shape —

| note | what the human has to remember |
| --- | --- |
| `platform/ap.ts` | `hostapd_cli` run by hand needs `-p /run/wayfarer/hostapd` |
| `platform/supplicant-cli.ts` | `wpa_cli` run by hand needs `-p /run/wayfarer/supplicant` |

Both exist for the same good reason — this device does not share a socket namespace, because a socket in a
shared directory is one another instance can collide with — and both push the cost of that decision onto a
person at the worst possible moment. One mechanism closes both.

Two is a small number, and that is worth saying plainly rather than dramatising: this repository does not
lean on the reader much. It leant on them exactly twice, and one of those two cost an evening.

### And it happened to the person writing the notes

The evening this was found, the same person had written six catalogue entries about defects that hide, had
added a question to the register about choosing the cheapest reading, and had just finished documenting a
trap in the very subsystem concerned. Then ran the habitual command without the flag, six times, and
reported the empty result as a measurement to somebody making decisions on it.

That is the only reason the conclusion above is worth trusting. A claim that notes are insufficient, made
by someone who has not been failed by their own, is a preference. Made by someone who wrote the note,
published it, read past it, and then acted on the wrong answer for an evening, it is evidence.

## A command's danger is set by its neighbours, not by itself

Reading a profile off a running board meant assembling a short list of commands and having it approved
before any of it was typed. The list was four invocations, all reads. Writing it out surfaced something
the list itself did not contain.

The device's own CLI advertises twelve subcommands in one block of help text
(`apps/daemon/src/cli.ts`). Three of them destroy state: `factory-reset` removes all configuration,
`rederive` rewrites the generated values, and `credentials reset` puts the admin password back to the
documented default. That list is where one goes to find out whether the device can export a profile at
all — it cannot, which is why the approved list reaches the API over loopback instead. So the three
destructive subcommands were read, in full, by somebody about to type against a live device, and they sit
in the same block, in the same shape, one word apart from each other.

None of those three is dangerous in isolation — each is deliberate, each is documented, and two of them
exist precisely as recovery paths. What makes them dangerous is **proximity to something that had to be
typed anyway**, at the moment somebody is working against a device carrying live traffic.

The same shape had already been paid for in the other direction: a chain of commands joined on one line
continued to its last part — a reboot — after an earlier part had failed. Each part was defensible.
The chain was not, because joining them made the failure of one the precondition of the next rather than
a stop.

> **The danger of a command is a property of the list it appears in and the line it is joined to, not of
> the command.** A read is not made safe by being a read, if the thing next to it is not one.

Two consequences, both cheap:

* **When a list of commands is proposed for a live device, name the neighbours that are not being run.**
  Not all of them — the ones a slip of one word would reach. The value is not in the naming; it is that
  writing the sentence forces the author to look at what is beside their own cursor.
* **Do not join commands against a live device with `;` or `&&` when one of them changes state.** Separate
  invocations fail separately, and a failure that stops is worth more than a chain that completes.

This belongs next to the register's first question. That one asks whether a failed reading could be told
apart from a real one. This asks the same thing about intent rather than about data: *if my finger slipped
by one word here, would the result be recoverable, and would I know?*

## The redaction was right and the marking was wrong, and the report inherited the blindness

A redacted export of the bench profile, taken 2026-09-21 to write a migration against real shapes,
carried credentials in clear.

**Nothing was disclosed.** The owner had never sent a profile export anywhere, so no credential left the
device and none needed rotating. That is worth stating plainly and worth attributing correctly: the
export feature is new and simply had not been used yet. **This is a record of an incident that did not
happen, and the reason it did not is luck rather than foresight** — the defect was found because a real
export was needed for an unrelated task, not because anything was checking. Read in six months as a
story about catching something, this entry would teach the wrong lesson.

The export mechanism was not at fault at any point. It redacts what the
matchers say is secret, and the matchers were wrong in two independent ways.

**First: the same field, marked in one schema and bare in its neighbour.** `TRANSPORT_SCHEMA` declares
`configFile` as `x-secret`; `EXTERNAL_SOCKS_SCHEMA` declared the identical field as a plain string. The
two schemas sit forty lines apart in one file and describe the same thing — the contents of a client's
own configuration file. Nothing justified the difference; it reads as a schema written by copying its
neighbour and losing a line. The consequence was a client's real user identifier at
`/tunnels/2/config/configFile`, in a file whose entire purpose is to be shared.

**Second, and worse: a correct marking that nothing ever read.** The document walk that builds matchers
descended into `/tunnels/-/config` and stopped. It never entered `/tunnels/-/transports/`, so the
transport's correct `x-secret` was never consulted. Five transport blobs carrying `UID` and `PublicKey`
left in clear.

The second half is the part worth keeping, and it is not about secrets:

> The export **lists what leaves in clear**, so a person can judge the risk before sending the file. That
> list is built from the same matchers. So it did not mention the transports either — it named six
> pointers, confidently, and all six were the ones that were already covered.

A report built from the same source as the thing it reports on cannot see that source's blind spot. It
does not fail; it agrees.

And agreeing is worse than being silent. Had the owner sent that file, the device would have handed him
a list confirming that everything else was redacted — so the leak would not merely have been quiet, it
would have been **certified**. A person checks what they are told to check; a product that answers the
question convincingly and wrongly removes the last opportunity anyone had to notice. That is a stronger
argument for the guards below than any amount of reasoning about test coverage. A wrong answer invites a second look, and an answer that is merely incomplete
in exactly the way the reader cannot detect does not. This is the register's first question — *if this
call failed, what would I see, and could I tell that apart from a real answer?* — applied to a summary
rather than to a reading: **a summary derived from a mechanism cannot be used to audit that mechanism.**

### What the guard had to be, and what it could not be

A test asserting "every field is marked today" is a test that must be edited whenever a field is added,
which means it is a test that records history rather than one that catches anything.

Two were written instead, in `apps/daemon/test/secret-coverage.test.ts`:

* **Marking consistency, derived from our own markings.** A property name we call secret in one schema
  must be secret in every schema that has it. It needs no maintained list of dangerous names — the list
  is discovered from where we already said so — and it is exactly the asymmetry that caused the leak.
* **A planted credential, searched for as text.** An invented value of credential shape is put into every
  opaque blob of a bench-shaped profile, and the serialised export is searched for it. This one asks the
  only question the person attaching the file cares about: *is it in here, anywhere.* A pointer-by-pointer
  assertion would have been written from the same understanding that produced the defect — the author who
  did not know transports existed would not have checked them.

Both were verified by reintroducing each defect separately and observing each test fail, then restoring.
A third test asserts the planted value **does** survive when no matchers are supplied, so the guard cannot
pass for a reason unrelated to marking.

**The general form:** when one declaration drives both a behaviour and the report about that behaviour,
the report is not evidence about the declaration. Something outside the declaration has to check it.

## Found while building `GET /api/docs` and the bind set

### Documentation generated from schemas is silent about everything that lives in a handler

`/api/openapi.json` was generated by `@fastify/swagger` from the TypeBox schemas on the routes, which
is the right design and was working. The document named every path, and it was complete, internally
consistent, derived from the source of truth, and **missing the single fact an operator most needs
about an endpoint**: which scope a credential must carry to reach it.

The scope is not in any schema. It is in the route's `preHandler` — `requireScope('admin')` — which
the generator neither reads nor knows exists. So the omission was invisible from both ends. The
generator had nothing to complain about, because it faithfully rendered what it was given; a reader
had nothing to complain about, because a document that lists every endpoint looks finished.

> The value exists, the reader exists, and there is no channel between them. Nothing reports that
> kind of absence, because nothing is failing.

The fix that does not work is annotating the scope onto each route's schema by hand: that is a second
source of truth, one forgotten annotation away from a document that states the wrong permission —
worse than one that states none. The fix is to read the scope back out of the **live route table**,
from the same guard object the build-time "every route has a scope" check already inspects. Both
halves of the page then come from the routes as registered. In `apps/daemon/src/api/docs.ts`, with
`/api/docs` and `/api/openapi.json` built by one function so a person and a tool cannot be shown
different facts.

**The class, for anyone generating documentation from schemas:** the document describes exactly what
is in the schemas and says nothing about what the route puts anywhere else — guards, hooks,
middleware, rate limits, side conditions. Ask of every generated reference: *what does this route
decide outside its schema, and who tells the reader?*

### Fastify drops a field that is not in the response schema, without a word — in both directions

A response is serialised through its schema. A field the handler returns that the schema does not
declare is removed silently: the reply is valid, the status is 200, nothing is logged.

This is the first register question — *if this call failed, what would I see, and could I tell that
apart from a real answer?* — with an unusually bad answer: **nobody could tell.** The response
arrives, it is well formed, and it simply lacks the field.

It caught us pointing both ways within an hour.

* **Adding.** A new field was to be carried into `/api/status`. The obvious implementation — return it
  from the handler — produces exactly the silence the requirement was written against, because
  `StatusResponse` would not have declared it. A field must reach the schema, not only the code.
* **Removing.** `mustChangePassword` was removed from `LoginResponse` when the forced password change
  went. The two producers in `api/server.ts` kept computing it and nothing broke: the serialiser was
  dropping it. A producer computing a value no serialiser emits is not harmless — it is a
  working-looking expression that the next reader either restores to the schema, believing that was
  the intent, or spends an afternoon chasing.

**Silent coercion to a schema hides the extra and the missing alike.** A test that asserts a field is
*absent* is worth writing for exactly this reason; "we stopped sending it" and "it is still computed
and dropped" look identical from outside.

### A contract promised an event to people outside this project, and nothing emitted it

`docs/07-api.md` documents an SSE stream including `event: tunnel { id, state, latencyMs, jitterMs,
loss }`. Searching `apps/daemon/src` for `latencyMs` returns nothing. No such event is emitted, and
no per-tunnel health exists to emit: `core/tunnel-health.ts` is a pure function turning one
`ResetObservation` into one warning, and its only caller is the CLI.

This is the same class as the entries above — a reader exists, the value does not, and nobody
complains — with one difference that makes it worse. **The other instances promise a value inside the
system, where the only victim is the next person to read the code. This one promises it outward**, in
the published API reference, to people who will write clients against it. They will implement a
handler for an event that never arrives, and conclude their tunnels are healthy, or that their SSE
connection is broken, or that this device is. None of those is true and none of them is diagnosable
from outside.

Found by being asked to carry tunnel health into `/api/status` and going to read the source of it
first. Worth stating as a habit: **a contract document is a place to look for this class, not only a
place to describe what exists.** Every event, field and status code a document promises is a reader
with no complaint mechanism.

### Where the management surface listens: proved on the interfaces that were in the list

The panel and the API must answer on every local channel — the wire, this device's own access point,
the Wi-Fi network it is a client of, loopback — and on no tunnel interface. Measured on the bench
board, 2026-09-21, `ss -tln` on port 8088:

```
127.0.0.1:8088        loopback
10.44.0.1:8088        wlx90de8047b4b4, the access point
192.168.77.8:8088    wfwan0, the wireless uplink
```

`end0` — the wire, `192.168.77.7/24` — was answering nothing. The bind set was built from what the
last apply had *recorded*: the access point plus the uplinks a profile names. **No plan touches the
wire**, because it is the lifeline every plan is written to leave alone, so it could not appear in
that record under any configuration. An earlier fix had verified the behaviour against the interfaces
that were in the list, and passed.

Two entries for the catalogue, not one.

**First: a check proved where it was looking.** The verification enumerated the bind set and confirmed
each member answered. That is a true statement about the set and says nothing about what the set
omits. The question it could not ask is the one that mattered — *what should be here that is not?* —
and answering it requires a source outside the mechanism under test. Same shape as the export that
listed what leaves in clear using the matchers that had the blind spot.

**Second: a guarantee that holds because control never reaches it is not a guarantee.** No tunnel was
ever bound — and nothing refused one. The positive half simply never named a tunnel, so the negative
half of the requirement was a side effect of a short list. Lengthening that list is exactly what
fixing the wire does, and the prohibition would have evaporated in the same commit that satisfied the
other half of the same requirement. The refusal is now a separate final step in
`apps/daemon/src/api/bind-policy.ts`, it consults tunnel names from every source that knows one
(including foreign tunnels such as the bench board's `tun0`, which no profile of ours created), and
it records an event when it has anything to remove.

The test for it is the part worth copying. Handing a correctly classified tunnel to the policy and
observing that nothing binds it passes just as well with no refusal in the code at all — the positive
half would never have chosen it. So the load-bearing case hands over a tunnel the classifier got
**wrong**, labelled `wired`, and requires the refusal to disagree with the verdict that selected it.
Verified by deleting the filter: that case fails and the three around it still pass, which is also
the measurement that tells you which of your tests were doing nothing.

Ask it of any prohibition: *can the thing it forbids actually be offered to it in a test?* If not,
the prohibition is untested however green the suite is.

## A catalogue named after what we run, not after what the owner has

The catalogue that replaces the generic protocol form was defined with six entries, one of them `Xray`.
The owner read the list and asked one question: *isn't Xray just VLESS — isn't that tunnel a VLESS
subscription?*

It is. The configuration behind that tunnel is a VLESS client over WebSocket over TLS. `Xray` is the
program that happens to run it.

What the owner has is **a link or a subscription**. `Xray` is an implementation detail of this device,
and putting it in the catalogue put our vocabulary into his. That is precisely the defect the catalogue
was created to remove — the product asking a person to know how it works internally — committed one
floor up, in the definition of the fix itself, in the same document that states the principle.

The corrected entries are named after what a person holds:

| entry | what the owner has |
| --- | --- |
| OpenVPN | a `.ovpn` file |
| Cloak + OpenVPN | a `.ovpn` file plus the entry points of an obfuscation layer |
| VLESS | a link or a subscription |

**The consequence is not only a rename.** Once the entry is named for the thing rather than the runner,
*which* runner carries it stops being a question the owner can be asked, because he has no way to
answer it — it depends on the configuration. A known case: post-quantum VLESS encryption is understood
by one client and not by the proxy core, which rejects the field outright. So the entry has to
establish what the core can carry, choose the runner itself, **state the choice and its reason in the
plan**, and — where it cannot establish the answer — refuse rather than pick the one more likely to
work. A silently chosen runner is the confident answer nobody can explain afterwards.

### The part that makes this evidence rather than a moral

Three defects in two days were found by **the owner asking a question about his own device**, not by any
check this project runs:

* the interface its own authors routed around, found by asking why nobody used the panel;
* a redacted export carrying credentials, found because a real export was needed for another task;
* this one, found by asking what one of his own tunnels actually is.

The register of unobserved predicates asks *has anyone ever seen this fire?* The attention question asks
*what is the system telling me that I did not come here to ask?* This adds a third, and it is the one
with the best record so far:

> **What does the person who owns this thing call it?** If the answer differs from what we call it, the
> difference is not vocabulary — it is a place where our implementation has leaked into their model, and
> it will keep leaking until the name is changed.

Neither of the first two questions would have caught it. Both are asked of the system by the people who
built it, and this class of defect is invisible from inside for the same reason a house smells of
nothing to the people who live in it.

## The fix for an unreachable guarantee contained an unreachable guarantee

Found on 2026-09-21 by mutation-testing `apps/daemon/src/api/bind-policy.ts` against
`apps/daemon/test/bind-policy.test.ts`, one deliberate break at a time. Seventeen mutants; fifteen died.
Two of the survivors were the interesting ones, and they were in the gate that refuses tunnels:

```ts
if (tunnels.has(entry.name) || entry.class === 'tunnel' || entry.class === 'unknown') {
```

Delete the first clause and a test goes red. Delete either of the other two and **the whole suite stays
green** — twelve tests, including four written specifically to prove that no tunnel is ever bound.

### Why, and why it is not a missing assertion

The gate ran over `chosen`, the list the positive half had already built. The positive half only ever
puts `wired`, `accessPoint` and `wirelessUplink` entries into that list. So no input to
`decideManagementInterfaces` could put an entry whose class is `tunnel` or `unknown` in front of those
two clauses. They were not weakly tested. They were **unreachable**, and no test written against that
function could have reached them.

The file's own header argues, at length and correctly, that *a guarantee which holds because control
never reaches it stops being a guarantee the moment the list gets longer*. That is the lesson of the
wire, and the gate exists to remove that shape from the bind path. The gate had grown the same shape
inside itself, in the same commit, under the paragraph explaining why it must not. A comment three lines
above the loop stated the opposite as fact — that `tunnel` and `unknown` "still pass through the refusal
below" — and it had been read many times by people who agreed with it.

### What made it visible, and what did not

Nothing made it visible by reading. The comment was wrong, the tests passed, the behaviour on the board
was correct, and the behaviour on the board *stayed* correct under both mutations — because on today's
inputs the clauses do nothing. Only mutation asked the question that reading cannot: **if I break this
rule, does anything notice?**

This is the third form of the same defect in this catalogue, and the forms are worth keeping apart:

* a value produced and never consumed;
* a check proved on the subset it was already looking at;
* and now **a check placed downstream of a filter that removes everything it is written to catch**.

The third is the hardest to see, because the code is correct, the comment is confident and the test is
green. Each of the three answers "yes" to *does this work?* and "no" to *has anyone ever seen this fire?*

### What was done

The clauses are right, and they are the only thing that would hold if somebody widened `ALWAYS_LOCAL`.
What was missing was a way for a test to reach them. So the gate became its own exported function,
`refuseNonLocal`, taking the candidate list as an argument — and the tests hand it a `tunnel` and an
`unknown` directly, each with an **empty name list**, so the surviving clause cannot cover for the one
under test. Both mutations now die. This is the same move as making the seam a function: where a guard
cannot be reached through its caller, give the guard a caller.

Two mutants still survive, and are recorded rather than papered over. In `localChannelsFor` the tunnel
names are united from two sources — the classifier's verdict and the profile's list — and *either* term
can be deleted with the suite staying green, because each covers the other. Neither is load-bearing on
today's inputs; each guards a different future change. There is no input that can force either to fire,
so there is no test that can honestly claim them, and the comment at the union says so.

### The question this adds to the register

The register of unobserved predicates asks *has anyone ever seen this fire?* That question was asked
here, and the answer looked like yes — the gate does fire, the name clause fires, the tests prove it. It
was the wrong granularity. So:

> **Which clause fired?** A guard with several conditions is several guards, and a test that proves the
> guard fired has proved one of them. The rest may be unreachable, and the surrounding prose will defend
> them all the more confidently for never having been contradicted.

The cheapest way to ask it is not to read the code. It is to break each clause in turn and see whether
anything turns red.

## A guard added for a reason that turned out to be false, caught by mutating it

The 360 px check drives real Chrome because jsdom has no layout engine. Advanced settings on the
rebuilt screens are **folded, not absent**, so the check was extended to open every `<details>`
before measuring — on the belief that a closed fold's contents are not laid out at all, and that a
folded section could therefore overflow by any amount while the check reported the page as clean.

The belief was not tested; the guard was. An element inside a *closed* fold was deliberately made
755 px wide on a 360 px viewport, and the check was run twice:

| run | result |
| --- | --- |
| opening pass enabled | `FAIL: 6 element(s) reach past the viewport` |
| opening pass disabled | `FAIL: 3 element(s) reach past the viewport` |

Measured on Google Chrome 153.0.8010.48, 2026-09-21. **Both runs failed.** Chrome lays out the
contents of a closed `<details>` and the rectangles are real, so the new pass caught nothing that
was not already caught. The guard was inert on the day it was added, and nothing about a green run
would have said so.

It is kept, with the comment rewritten to say what it is actually worth: it makes the check
independent of a browser's private decision about whether to lay out hidden content — a behaviour
that has changed before — and it covers the case where a fold's body is *mounted* on open rather
than merely revealed, which no amount of laying out can reach. The comment now states outright that
a mutation run against it will not fail today.

**The transferable part is the order of operations.** This project's rule is that a test which
cannot produce the failure it excludes proves nothing; the same is true of a *guard*, and a guard is
harder to catch because it lives inside a check that does work. The only way to tell an inert guard
from a load-bearing one is to break the thing it exists to catch and watch **which** assertion
fires. Here the answer was "the one that was already there", and that is worth more than the guard.

## A mechanism wired to a gate it could never pass

The captured-resolver mechanism — write the value a peer pushed, and let the write cause a
reconvergence — was built on 2026-09-21 against exactly the disease it then failed to cure. Later the
same day the board showed what it looked like when it did not work.

**Measured on the bench board, 2026-09-21:**

| time | what happened |
|---|---|
| 11:41:10 | `/etc/wayfarer/core/config.json` written, carrying resolver `10.184.40.5` and the tunnel's subnet `10.164.0.0/20` |
| 12:41:32 | the corporate tunnel reconnected; the peer pushed resolver `10.184.100.5` and moved the interface to `10.165.5.67/20` |
| 12:41:39 | the captured value was written and the watcher fired — *resolver reconverged* |
| 12:57, 12:59, 13:02, 13:05, 13:07 | five more reconvergences, each recording success |
| 13:07 | the core restarted |

And `config.json` had not been rewritten since **11:41:10**. Every reconvergence restarted the core
from the stale file and reported that it had worked. The planner was not confused: it said plainly
that the hq tunnel was using the resolver the peer had sent rather than the one in the profile.
The value was correct everywhere except in the file the core reads.

### The cause, which is not where anybody looked first

The first hypothesis was that the watcher does not re-read what was captured when it starts, so a
value written while no reader existed is never picked up. It is a good hypothesis — a mechanism of the
form *we react to changes* is blind to changes that happened in its absence, and absence happens at
every upgrade — and it was **wrong here**. The evidence above rules it out: the watcher fired, six
times.

The real cause is a **deadlock between two safety rules that are each correct alone.**

Reconvergence from a captured value applies with the `hot` and `service` classes only. That is
deliberate and it should stay: a value a peer supplied must never be able to change this device's
network. The core configuration's path classifies as `service`, which would pass — but
`classifyContentChange` **promotes** it to `network` when the difference touches `/inbounds` or any
`ip_cidr` list, because those are what decide whether the board can still be reached.

The closing of the circle: **the same reconnection that changed the resolver changed the tunnel's own
subnet**, from `10.164.0.0/20` to `10.165.0.0/20`. That subnet appears in the inbound's exclusion list
and in a direct-routing rule, so the difference touched both, the class was promoted, the file write
was refused — and the unit restart, which is not a file, was not.

So the promotion fired **on precisely the event the mechanism exists for**. An OpenVPN reconnection
that changes the pushed DNS almost always changes the pushed subnet too. The mechanism was not
connected to nothing; it was connected to a gate that nothing it produces could ever pass. Both
halves of the symptom — the stale resolver and the stale subnet — were one defect, and the subnet was
the cause of the resolver.

### The fix, which is a rule this project already had, one level deeper

The class already comes from **what differs** rather than from which file was touched. The same rule
was needed one level further in: not *which pointer* the difference landed on, but **what the
difference means**.

Two things were being counted as one:

* **a subnet the peer assigned and we are catching up with.** The network has already moved. Refusing
  to write it down protects nothing and preserves something stale.
* **our own reachability exclusions** — the served LAN, the transfer network we choose, the network
  the board is actually reached through. Caution is what those are for, and they keep `network`.

So the planner now hands the differ two lists, `followed` and `defended`, because it is the only
layer that knows which interface an address was read from; the differ sees two JSON documents and can
derive neither. The softening then needs *both* of: the reachability region identical once the
address lists are set aside — so `auto_route`, `strict_route` and the shape of the rules still
escalate — and every address that **appeared** being one we positively follow, every address that
**departed** not being one we defend.

Two asymmetries in that sentence are deliberate. An address being written down must be positively
recognised, because an unrecognised address arriving in an exclusion list is the case to decline;
an address leaving need only not be defended, because a stale value from an older plan belongs to no
current reading of the device.

### What made this checkable rather than argued

The lists are only sound if **every** address the generator can emit is on exactly one of them, so
that is asserted against what the generator really emits rather than promised in a comment. It failed
on its first run and found a second, older inconsistency: the exclusion list normalises the served
LAN to `10.44.0.0/24` while the `protect-own-networks` rule emits the raw `10.44.0.1/24`, and the two
are different strings. That one is **recorded and not fixed here** — normalising what the core is
given is a network-class change and does not belong in a classification fix — and both forms are
listed meanwhile.

Four mutations, each failing exactly its own test and nothing else: removing the new clause (the
board's behaviour of that afternoon), softening unconditionally, dropping the shape comparison, and
accepting any address that is merely not defended. The pair that matters is the first two: a test
that only proves the gate opens, and one that only proves it still closes, are worth nothing apart.

### The class, which is the part worth keeping

**A safety rule that is correct in isolation can be wired to a mechanism whose whole purpose is the
event the rule refuses.** Neither half looks wrong when read on its own, and both were written by
people who understood them. What exposes it is asking the second question rather than the first: not
*is this guard correct?* but **what does it do on the exact event the thing it guards exists for?**

The register of unobserved predicates asks whether anyone has ever seen a predicate fire. This is its
mirror image and it is worth adding beside it: **has anyone ever seen this mechanism succeed?** A
mechanism that fires, logs, and reports success every time while changing nothing is harder to see
than one that never fires at all — and this one had a success message for each of its six failures.

## Three silences in one day, and the cheapest one cost the most

Recorded on 2026-09-21 because the three arrived within hours of each other and are the same defect
wearing three costumes. In each, the mechanism worked and the **record** of it did not.

**One — a report that held the evidence and did not read it.** Re-deriving after a peer pushes a new
resolver recorded `resolver.reconverged` the moment the apply returned without throwing. It had
`outcome.result.refused` in hand — a list whose declaration says *"never silently dropped"* — and did
not look. On the board a tunnel reconnected at 12:41, the peer pushed a new resolver, and the file
write was refused as `network` while the core was restarted anyway. Six "reconverged" lines, one
resolver an hour stale, and corporate names that did not resolve for the owner. `outcome.ok` was
ignored too, so a failure reported by return value also read as success.

**Two — a decision computed and dropped.** The bind policy produced `refused` and `withheld` and
nothing carried them to the wire. `GET /api/system` reported a port and some addresses, so the one
screen where a refusal belongs could not mention one. A blank space where a refusal belongs is not
neutral: it asserts that there were none.

**Three — a guard that decided and did not say.** A working tunnel's watchdog had it blocked from
10:08. Three hours of an owner's tunnel down produced one line in the journal. (Fixed elsewhere;
recorded here because it is the third instance in a day.)

### What connects them

Each is the catalogue's own rule — *a report of an action is not the action* — but sharpened. The
usual form is a report that never checked. These are worse: in one and two the evidence was **in the
function's own hand**, one field away, and the report did not consult it. Writing the check would
have cost a line.

The common shape is that **the absent record is cheaper to produce than the wrong one.** Nothing
fails when a refusal is not reported. No test goes red, no log line looks odd, the device behaves
correctly in every respect except the one that lets a person find out. So the defect is selected
*for*: it survives review, it survives the suite, and it survives the board.

### The question

> **If this decision goes the other way, who finds out, and how?** Not "is it handled" — handled is
> the easy half. If the answer is "it appears in no event, no field and no screen", the decision has
> not been made; it has only been taken.

And its corollary, learned from all three: a screen or a response that *cannot express* a bad
outcome is not neutral about it. It reports the good one.

## The kill switch that a performance policy fired, and the one that could not fire at all

The requirement, in the owner's words: *if the tunnel carrying this traffic is not working, that traffic
must be blocked entirely, not sent another way.* It is implemented as a per-tunnel selector whose only
members are the tunnel and `block`, moved by the health watchdog. Four things were wrong with it at once,
all measured on the live board on 2026-09-21, and the shape of the four is more instructive than any one.

### 1. A ranking threshold was answering an availability question

`policy.probes.maxLatencyMs` exists to order **interchangeable** tunnels for failover. Over the limit means
*prefer another one*, which is a sensible thing to say when there is another one. A guarded destination
tunnel has no other one, so "prefer another one" resolved to **refuse the traffic**.

The value is 500 ms. Measured, dialling from the board:

| dialled through | result |
| --- | --- |
| `partner` (the tunnel itself) | 519 / 528 / 521 / 643 ms, answers every time |
| `wf-guard-partner` (the guard in front of it) | error, three times out of three |

`summarise` set `healthy: false` on the median, so every round computed `want: block`. The tunnel had been
blocked since 10:08 MSK. That pair of rows is the whole defect: **the tunnel works and the guard in front
of it refuses every connection**, and the only thing standing between the two is a performance policy.

The fix is to ask the question the field's own documentation says this is — *whether its own traffic may
flow*. `judgeReachability` in `core/health.ts` judges answered-or-not and loss, and **never** latency or
jitter. Loss belongs and latency does not, and the difference is not one of degree: a lost probe is the
tunnel failing to carry a request, a slow probe is the tunnel carrying it.

The alternative considered and rejected was per-guard thresholds — a `maxLatencyMs` on the tunnel rather
than borrowed from the failover group. It loses because it keeps the category error and merely re-tunes it:
there is still no answer to *how slow is too slow to be allowed to exist*, because that question only has
an answer when something else can be chosen instead.

The probe **timeout** was the same mistake one level down. It was `maxLatencyMs * 4` — two seconds at the
default — so any destination tunnel answering slower than that became a lost probe, and the ranking
threshold decided availability by the back door. It is now a generous absolute floor.

### 2. The guard for the tunnel that mattered most could never fire

With no probe endpoints, `runGuards` fell back to what it called liveness:

```ts
const known = proxies.some((entry) => entry.name === guard.tunnelId);
allowed = known ? true : null;
```

`GET /proxies` is the core's list of **configured** outbounds, generated from the config file this daemon
wrote. It carries no health whatever. So for a tunnel without a probe this was `true` in every round, for
as long as the config named it, no matter what the tunnel was doing — and the guard could never reach
`block`. The `relay` tunnel has `probe: null`.

This is worth naming precisely, because it reads as a measurement and is not one: **a positive answer that
was never looked for, handed to a decision documented three lines above as three-valued.** The comment
beside it was honest that the evidence was weak. It was not weak; it was absent. "The core lists an
outbound we ourselves asked it to list" is a fact about our own config file, and it was being reported as a
fact about the network.

A guard with nothing to probe now returns `null` and moves nothing in either direction.

### 3. A blocked guard is an outage, not a steady state

The watchdog's rule is that a round changing nothing writes nothing, which is right for a tunnel's health
and exactly wrong for a guard sitting on `block`. Three hours of refused traffic produced **one** event, at
the beginning, and then silence — so the record of the longest outage the device had ever had was a single
line timestamped at its start, and the ring said the same thing whether the cut had lasted a minute or a
day.

An abnormal guard standing is now restated every 15 minutes: `guard.still-blocked` while traffic is being
refused, `guard.unmeasurable` while nothing is being measured about it. Deliberately *not* conditioned on
this process having caused it — a selector parked on `block` by hand, or left there across a restart, is
the same outage and is the version with nothing at all in the ring to explain it.

### 4. What the requirement was actually resting on

Because the guard could not fire for `relay`, if that tunnel had died nothing would have been blocked and
nothing recorded. Traffic still would not have leaked — but not for any reason the watchdog supplied. The
selector's only members are the tunnel and `block`, so the *worst* it can do is fail the connection.

> **The owner's requirement was met by the shape of the selector, not by the kill switch.** The moving part
> contributed nothing on the day it was examined. The static part — a selector with no `direct` member —
> carried the entire guarantee.

That is the answer to "what happens if it dies right now", and it is a better answer than the one that was
believed, because it does not depend on anything working. It also sets the honest value of the moving part:
it converts a silent connection failure into a recorded refusal, which is worth having, and it is not what
stops the leak.

### How long it now takes, corrected

The first version of this section said "about 70 s", which was an estimate stated as a number. It was
neither derived nor measured, and it left out the largest term: **a dead tunnel's probes cost the round
their full timeout each.** Probes are sequential by design, so a round against something that does not
answer costs `count × timeout`, and the interval is counted *after* the round finishes rather than between
starts.

Measured against the real watchdog with a core whose every probe runs to its timeout (`count: 4`,
timeout floor 4000 ms, `intervalSeconds: 30`, `failStreak: 2`):

```
round 1: 17.0s of probing, streak 1, ring: guard.unreachable, nothing selected
round 2: 17.0s of probing, streak 2, ring: guard.blocked,     selector -> block
```

So, from the tunnel dying to its traffic being refused:

| | |
| --- | --- |
| best case, it dies as a round is about to start | 17 + 30 + 17 ≈ **64 s** |
| worst case, it dies just after a round finished | 30 + 17 + 30 + 17 ≈ **94 s** |
| if the dead outbound refuses dials immediately rather than hanging | **30–60 s** |

Before this work it was about 40 s — one round, because guards had no streak, and an 8 s round because the
timeout was `maxLatencyMs * 4` = 2 s. Both of the things that made it fast were the defects: it cut working
tunnels on one bad sample, and it called any tunnel slower than two seconds dead.

**Decision: the streak stays at two rounds, shared with the failover group, and no separate knob is added.**
The reasoning is that the cost is paid *only* in refusal arriving later and never in traffic going
somewhere else, because this selector has no `direct` member. The choice is therefore between "say no
sooner" and "do not flinch at one bad minute" — and on the day this was written, one bad minute had already
cost three hours of a disconnected working tunnel. A per-guard `failStreak` field was considered and
rejected: it is an extra control surface bought for a thirty-second difference, and control surfaces cost
something too.

### What happens if the guarded tunnel dies right now

For a tunnel **with** a probe, the table above. For one **without** — which is the state of the tunnel
carrying the owner's own traffic — the honest number is that the guard **never acts**, because nothing
about it is measured and nothing may therefore be asserted. What actually happens is:

* **Traffic does not go anywhere else, at any point, for zero seconds of exposure.** The selector's members
  are the tunnel and `block`; there is no third place for it to go. This is the static guarantee, and it
  does not depend on the watchdog running at all.
* **Applications see a connection error from the first dial after the tunnel dies** — immediately, not
  after a minute. What they do not get is a *refusal*, which behaves differently on retry and would have
  been recorded.
* **The ring says nothing about the death.** It says something better than the old silence, though: within
  15 minutes at the latest — and on the first round after a start, at once — `guard.unmeasurable` states
  that nothing is being measured about this tunnel and that its guard cannot move in either direction.
  That is the difference the fix bought here. Not detection: *an admission that there is none.*

The real remedy for that tunnel is to give it a probe of its own in the profile. A listener check is a
second line for the case where no probe exists, and is not a substitute for one.

### The question this adds to the register

Defects 1 and 2 are the same defect facing opposite ways, which is why they survived together: one judged
a question it had no business judging, the other asserted an answer it had never looked for. Both read
fluently. Both had a comment beside them explaining a reasonable-sounding thing that was not the thing the
code did.

> **What is this value *for*, and is that the question being asked of it?** A threshold borrowed from a
> decision with different consequences is not a conservative default — it is a different decision wearing
> the same number. Ask what happens when it fires, not what it measures.

The paired form, for the other direction:

> **Would this answer have been different if the world were different?** If a check returns the same value
> whatever the thing it describes is doing, it is not a check. `known ? true : null` against a list we
> generated ourselves cannot come back false, and no amount of tests over it will say so, because the tests
> supply the same list.

Both were caught the same way the register says to catch them: by breaking the rule in each direction and
watching which test — if any — turned red. Judging guards on latency again turns exactly the two latency
and jitter tests red and nothing else; making the judgement unconditionally positive turns the loss and
streak tests red instead. Restoring the liveness assertion turns the four unmeasurable-guard tests red.
Removing the restatement turns the outage tests red; restating unconditionally turns the steady-state test
red. A rule with a test that fails in only one direction is half a rule.

## A decision you cannot call is a decision you cannot check

Three times in one day the fix for a defect was the same move: take a verdict out of a closure and
give it a caller. Recorded as a class, because the third was found by looking for the shape rather
than by waiting for it to hurt.

* **The bind policy's gate.** Its class clauses sat downstream of a filter that removed everything
  they were written to catch. Extracted as `refuseNonLocal`, which a test can hand a tunnel directly.
* **The resolver re-derive verdict.** It lived inside a closure in `main()`, and `main()` runs on
  import, so nothing in it could be reached by a test. Extracted as `resolverReconvergeEvent`.
* **The wireless role decision.** Same closure, same module, same reason — and this one was also
  wrong, which is the part worth dwelling on.

### What the third one was

Which interfaces telemetry watches was decided by
`platform.wifi.phys().catch(() => [])`. A failed read became "this device has no radios". The watch
calls *replace* their sets, so one `iw` timeout stopped all wireless telemetry: the station list went
empty and the panel reported nobody connected. The only record was a `debug` line, which nothing
prints by default, and a sixty-second timer meant it could recur indefinitely.

This repository had already paid for this exact confusion on the station list, where "nobody is
connected" and "we could not finish asking" were the same empty list. Here it was the same mistake
one layer up — in the code deciding what the station list is even about.

**The detail that makes this evidence rather than a moral:** thirty lines away in the same file, the
bind path reads the same driver as `.catch(() => null)`, on purpose, documented, precisely so an
`ether` link is never guessed to be a wire. Two readings of one driver, in one file, with opposite
discipline, for years. The careful one was in code with tests. The careless one was in a closure
nothing could call.

### The claim

Untestable code is not merely code whose defects are undetected. It is code whose defects are
**undeterred**. The same author, on the same day, in the same file, applies a rule where a test is
watching and forgets it where none can — not from carelessness, but because the rule is only made
real by something that can contradict it. Review does not do that job: every one of these three read
correctly, and two of them carried a confident comment asserting the behaviour they did not have.

> **Where does this decision live, and can anything call it?** If the answer is "inside a closure, in
> a module that runs on import", the decision has no test and will not get one, whatever anyone
> intends. Move it before arguing about whether it is right — the argument cannot be settled where it
> currently sits.

The sweep that found the third is worth repeating: list the modules with top-level side effects
(`void main()` and the like), then find every branch in them that produces a verdict. In this tree
that is two files, and everything in them was unreachable.

## A listener check for a guard with no probe: the shape, and the one question it must answer

**Not built.** This records what it would have to be, so that it is not built wrongly — the obvious
version of it repeats the defect it replaces.

A guard whose tunnel has no probe endpoint currently returns `null` and moves nothing, which is honest and
is not useful. The weakest *real* measurement available is whether the tunnel's own loopback listener
**accepts a TCP connection**: the client is not merely configured, it is running and bound. That is still
not reachability — nothing behind the tunnel has answered — but unlike the list of configured outbounds it
can come back negative, which is the whole difference.

It belongs in the platform layer, because it opens a socket, and the watchdog would take it as a dependency
alongside the core's delay test.

Three outcomes, and the middle one is the trap:

| observation | means | guard does |
| --- | --- | --- |
| the connect succeeds | the client is running and bound | allow, basis `listener` |
| the connect is **refused** | nothing is listening on that port: the client is down | block, after the streak |
| anything else | we could not ask | nothing, basis `unknown` |

> **The whole design is in the third row.** `ECONNREFUSED` from a loopback address is a *positive
> observation that nothing is there*: the kernel answered on behalf of a port with no listener. A timeout,
> `EACCES`, `EMFILE`, an unresolvable address, or a check that never ran are none of them observations
> about the tunnel — they are this daemon failing to look. Collapsing them into "not reachable, so block"
> would refuse the owner's traffic because the daemon ran out of file descriptors, and collapsing them the
> other way would reproduce exactly the defect above: a positive answer nobody measured.

So the check must return a three-valued result and never a boolean, and the errno must be inspected rather
than the presence of an error. On loopback the refusal is immediate, which also means this costs nothing
and needs no timeout budget of its own — but a timeout must still exist, and hitting it is the third row,
not the second.

Two things it cannot do, which must stay written down next to it so it is not later credited with them: a
bound listener says nothing about whether the far end of the tunnel is up, and a client that has hung
while still holding its socket accepts connections all day. It is a floor under the guard, not a
measurement of the path. **The actual remedy for a destination tunnel is a probe endpoint behind it in the
profile;** this is for the profiles that do not have one.

### Two independent sources for one symptom, and a closed investigation

The reason this entry matters beyond its own class. The evening before it was found, half an evening
went into reports of *"connected stations: 0"* while two clients were demonstrably associated. A
mistyped command was found, it explained a reproduction, and the investigation closed.

The role-discovery defect above produces **the same symptom** — an emptied watch set makes the
station list go blank — and it was present the whole time. Some of those zeros may have come from
here. Which ones is no longer knowable: the readings were not kept, and this is written as the
open question it is rather than as a conclusion.

> **Having explained the symptom, did we explain all of it?** A cause that reproduces the report is
> not the same as the cause of the report. One confirmed explanation ends the search, and a second
> source of the same symptom survives precisely because the first one was found — it inherits the
> first one's alibi.

This is a different trap from an untestable decision, and it is not fixed by testing. It is fixed by
noticing that "we found *a* cause" and "we found *the* cause" are different claims, and that the
first is what closes investigations.

### Why the sweep matters more than what it found

The three cases were not stumbled on. The last was found by asking the tree a question with a
finite answer: **which modules execute on import?** Two — `index.ts` and `cli.ts`. Every verdict
inside them was unreachable by construction; everywhere else in the daemon is importable and can be
tested.

So the result is not "three were found". It is that **the class is exhausted**: there is no third
module where this can hide, and a new one would have to be created for the defect to recur. That is
worth more than the fixes, because a count of findings says nothing about what remains, and this
says there is nothing.

The sweep is two commands and should be repeated whenever an entry point is added.

### Consciously left: `cli.ts` and the route probe

`routeTo(host).then(() => true).catch(() => false)` collapses "there is no route" into "the probe
failed", which is the same shape as the defect above. It is **left as it is, deliberately**, and
recorded here so the next sweep does not find it again as though it were new.

The reason it is not the same defect: the collapse points the other way. A failed probe prints *"the
bind address could not be resolved locally"*, which sends the operator to look rather than
reassuring them. The dangerous direction is the one that produces the calming answer when nobody
measured; this one produces the alarming answer, and its wording already claims only what it knows.

## Test execution order as a hidden input

Four tests for the routing screen passed when run alone and failed when run together. The screen
reads the profile from `useDraft`, a module-level store, and the store outlives a render:
`cleanup()` unmounts the components and leaves the document in place. So the second test rendered
against **the first test's document**, matched its "loaded" text immediately, and asserted against
rules nobody had put there.

Fixed by clearing the store in `afterEach`, alongside `cleanup()`:

```ts
afterEach(() => {
  cleanup();
  useDraft.getState().clear();
  vi.unstubAllGlobals();
});
```

**Why this belongs in this catalogue rather than in a note about test hygiene.** The failure wears
the same costume as everything else here: a wrong state indistinguishable from a right one. A screen
rendering the previous test's document does not look like a screen that failed to load — it looks
like a screen that loaded. Every assertion about *presence* passes on it. Only an assertion about
the specific content disagrees, and only when the two documents differ in the field being checked.
Reorder the file, or make the documents similar enough, and the suite is green while proving nothing.

**The shape it adds, which is new here: execution order is an argument the author does not know
about.** A test that is green alone and red in a pair has an input nobody declared — the state left
behind by whatever ran before it. The dangerous direction is the other one: **red alone and green in
a pair**, where an earlier test happens to leave exactly the state this one needed, and the test
documents a behaviour the code does not have. Nothing in a green run distinguishes the two.

Two questions to ask of any suite that touches a module-level store, a singleton client, a global
stub or a real timer:

* *what does this test depend on that it did not set up itself?*
* *would it still pass as the only test in the file, and as the last one?*

Running a single test in isolation is cheap and answers both. The related trap already recorded here
— a check that proved where it was looking rather than what was missing — is the same question asked
of a reader instead of a test.

## One defect, two opposite harms: it showed what it should have hidden, then erased what it should have kept

Happened, on the owner's live device, 2026-09-21. Written by the coordinator, because the
responsibility is the coordinator's: the profile edit that triggered it was directed through a write
whose defect was already recorded here as deferred.

**The defect.** An obfuscation transport's configuration blob and an external client's configuration
blob are credentials. The transport's schema has always declared its field secret. **Nothing ever
read that declaration** — the walk that collects secret pointers descended into a tunnel's own
configuration and stopped short of its transports.

**The first harm, found in the morning.** A *redacted* profile export carried five obfuscation
identities and a user id in clear. The redaction machinery was working perfectly; it had simply never
been told these were secrets. And the export's own list of what it leaves in clear is built from the
same matchers, so it inherited the blind spot — it did not fail, it **agreed**. Had that file been
sent anywhere, the device would have handed the owner a list confirming everything else was
redacted. The leak would not have been quiet. It would have been **certified**.

**The second harm, found in the afternoon, from the same cause.** A write to the profile through the
API erased those same six values. A secret that is not covered by a matcher reads back as *nothing
stored*; `$keep` against such a field is rejected; so a caller returning the document it just read
cannot preserve what it cannot see and cannot name. Six credentials left the stored profile. The
running device was unharmed — nothing had been applied — but any apply, by anyone, would have
rewritten six service scripts without the variable they need and stopped six tunnels.

**So the same missing reader produced both halves.** First it exposed what should have been hidden,
then it destroyed what should have been preserved, and in between it certified its own correctness.
That is the argument for treating an unread declaration as a defect in its own right, rather than as
a cosmetic inconsistency waiting for someone to notice.

### What made recovery possible was not designed for recovery

The profile table keeps one row and overwrites it; its `revision` column is a counter, not a
history. The document was gone from the only place that is supposed to hold it.

It survived in the transaction ring, which stores the full document before and after every apply
because that is what a revert re-applies — and whose pruning rule **exempts the newest committed row
forever**, deliberately, for the same reason. A property written to serve rollback turned out to be
the only reason a write defect was recoverable at all. Worth knowing, and worth not relying on: the
next such accident is one committed apply away from having nothing behind it.

### Two decisions taken in the repair, and why

**The values were never read.** Recovery copies the document column-to-column inside the database, so
the credentials move without any person, agent or context window seeing them. The alternative —
reading six secrets out of generated files and writing them back — was refused by the environment's
permission system, correctly, and would have been worse even if allowed.

**The row's timestamp was deliberately not corrected.** It still points at the damaging write. Moving
it would have replaced one inaccuracy with another that nobody would ever notice. The truth about a
repair belongs in a record somebody reads, not in metadata that quietly reads as though nothing
happened.

### The register question this earns

**A deferred defect is not a defect that is absent.** It is a cost agreed to without knowing the
size. This one was recorded as a modelling inconvenience — reordering an array and keeping a secret
cannot both be expressed by pointer — and it was true, dull and deferred for a week. Then it leaked
five credentials before breakfast and erased six after lunch, on a device somebody depends on.

So: **when deferring, write down what it would cost if it fired, not only what it is.** If that
sentence cannot be written, the deferral has not been reasoned about — it has been postponed.

## A guard built against one shape of risk becomes an obstacle when the shape changes

Found while moving the emission path onto the catalogue, 2026-09-21.

`state/secret-plan.ts` was written to close a real leak. The matchers that say where a profile's
secrets are came from the static document schema, a tunnel's `config` was an opaque record, and so
nothing covered `/tunnels/-/config/*` at all — an account id was stored bare, returned by `GET` and
shipped in clear by the export that exists to be shared. The fix consulted the provider registry so
the opaque half could be covered too, and it came with a rule written into the file in its own words:

> there is deliberately no exported helper that returns "just the static matchers", because that is
> precisely the value the previous code computed and the whole defect was using it.

That rule was correct. It also outlived its premise by exactly one schema version. Version 7 makes a
tunnel a union of typed catalogue configurations, so every credential a tunnel can hold is declared
here with `Secret()`, and the static walk now yields five pointers inside `/tunnels/-/config` —
including `/tunnels/-/config/entryPoints/-/uid`, the one that leaked five times. The insistence that
the registry be consulted had stopped defending anything. What it still did was refuse to **store** a
profile with tunnels on a device whose proxy core had not been unpacked: a refusal about credentials,
with no remaining cause, blocking configuration because an unrelated download had not finished.

**The failure mode is the shape of the guard, not its correctness.** A guard phrased as *always go
through X* outlives the reason X was necessary, because the reason lives in a paragraph and the rule
lives in a signature. Nothing about the registry's absence became less detectable; the thing it was
detecting stopped existing, and the check went on charging for it.

This is the second instance in one day. The boot guard clears the network configuration directories
because the failure it was built against was network lockout — and the system has since grown a
second way to become unrecoverable, through the database, which that guard does not touch. Same
shape: a mechanism aimed at the one failure that was understood when it was written, still aimed
there after the target moved.

So, when a guard is written: **state what it is defending against, in the file, as a condition that
could stop being true.** "The registry must be consulted because a tunnel's configuration is opaque"
is a sentence that expires visibly. "The static matchers must never be used alone" is a sentence that
does not, and the next reader has no way to tell whether it still applies or is merely still there.

### And the smaller one, worth its own line

When the premise did change, the correction had to be written as a *correction* — naming the previous
reasoning, in the same file, beside the rule it removes. A file that simply stopped consulting the
registry would read, to the next person, exactly like a file where somebody forgot to. The paragraph
explaining why a prohibition was lifted is the only thing that distinguishes a decision from a
regression.

## A measuring harness fed nothing is green forever

Found while building the Settings screen, 2026-09-21.

The 360 px check drives a real browser because jsdom has no layout engine, and it opens a bench page
that mounts every screen against the longest realistic value in every field. The bench stubs `fetch`
from a table of fixtures. What it did with a request that matched no entry was return `{}`.

The Devices fold asks `GET /api/fleet`. No fixture answered it. So the fold rendered an empty list, an
empty list fits comfortably inside 360 px, and the check printed its three oks — *no horizontal
scrolling, nothing past the viewport, every control at least 44 px* — about a screen with nothing on
it. Every one of those statements was true and none of them was about the thing being measured.

This is the same shape as a check written in jsdom, which the bench itself exists to avoid: **an
instrument that cannot produce the failure it claims to exclude.** The difference is where the
emptiness enters. A jsdom check is blind by construction and that is arguable from the code. This one
had a real browser, a real viewport and real layout — and was handed nothing to lay out, by a default
that looks like politeness. It would have gone on reporting success for every screen added afterwards,
and the report would have been quoted.

**The fix is to make the silence audible rather than to add the missing fixture.** The bench records
every request it could not answer; the check fails on a non-empty list and names the routes. Adding
the fleet fixture alone would have fixed today's screen and left the next one to discover this again.

One exception is written into the bench in its own words rather than left implied: the plan a screen
requests on opening describes a device, there is no device here, and a fixture for it would be a
fiction about a board nobody read.

### Proved by mutation, in the direction that matters

With the fleet fixture removed the check fails, naming `/api/fleet` — **and the three layout
measurements still print ok.** That output is the finding itself: the checks that a reader would quote
are exactly the ones that stay green while the screen is empty.

### The register question this earns

Three of the failures in this file are the same sentence from different directions: a blank where a
refusal belongs reads as *nothing was refused*; a missing clients count drawn as zero reads as
*nobody is connected*; an unanswered query drawn as an empty list reads as *measured and fine*. The
new one is that the reader can be a **program**.

So: **for every check, ask what it prints when it is given nothing.** If the answer is "the same thing
it prints when everything is correct", it is not yet a check, whatever it measures.

### The question run over the rest of the checks, the same day

The register question above was applied mechanically to every check this stream owns. It found three
more instances, two of them in tests that had been passing all along.

**The bench could name a screen that rendered nothing.** "No screen mounted" catches the whole page
failing; it does not catch *one* anchor being empty, which is what a component returning early on
absent data looks like. Its anchor is still in the list, still printed in the output, and every
measurement is true of the nothing inside it. The check now prints each screen's element count and
height — `settings: 411 elements, 6045 px tall` beside `confirmation: 5 elements, 237 px tall` — and
fails on an empty one. The floor is *not empty* rather than a number, because any number would be a
guess about screens not yet written; what makes zero unambiguous is that there is nothing to measure
at all.

**A negative assertion anchored on a loading state.** The test that the device inventory is on Settings
and no longer on Status waited for "No access point" before asserting the fold's absence — and that is
the text Status shows **while it is loading**. A Status whose data never arrived would have satisfied
the wait and then trivially satisfied "the Device fold is not here", because nothing is there. It now
waits for an interface name that only a loaded screen can draw. Proved by mutating the screen to
receive data that never arrives: the test fails, where before the mutation it would have passed.

**A pointer harvest anchored on a static heading.** The test that Settings renders zero `data-pointer`
attributes waited for the word "Device", which is a fold's own summary and renders before any query
answers. A screen with no profile rows has no pointers either, so the assertion could pass for exactly
the wrong reason. It now waits for a control built from a fixture row. Mutated to render an empty
profile list, it fails.

The shape common to all three: **a positive anchor that the failure case also satisfies.** A negative
assertion is worth precisely as much as the positive one standing beside it, and a positive one that a
blank or half-drawn page can satisfy is not standing there at all.

And the two components this sweep started from — the plan review and the confirmation window — were
never measured at 360 px, because E15 says "every screen, every form" and they are neither. They render
only after a review or an apply, which on a bench never happens. They are now mounted with a plan that
writes thirty files, three refusals each with its own reason, an unbound role, an interface rename that
carries the management address, and a window with two minutes left. Every value on them is a path, a
pointer or a unit name, none of which may be broken across lines, and the reader has a countdown
running.

## A confirmation the same gesture can answer is not a confirmation

Found while giving the profile list a delete control, 2026-09-21.

The requirement was ordinary: a destructive act with no undo should not be one tap away, so the button
arms on the first tap and deletes on the second. The obvious implementation has a defect that is
invisible on a workstation and certain on the device this is built for. **A double tap is an ordinary
movement on a phone** — it is how people zoom, and how they recover from a tap they believe missed —
and a two-step control with no floor between its steps is answered by one gesture. The reader never
sees the second label at all; the profile is simply gone, by a movement they did not think of as two
decisions.

So the confirming state refuses anything that arrives within 500 ms. The figure is chosen against the
**gesture**: the two taps of a double tap land within roughly 300 ms wherever the platform defines one,
and 500 ms is nowhere near the time a person needs to read a name.

The second half is the wording. The confirming label names the profile that will disappear, rather than
saying "for good". Somebody who has tapped one row lower has made a mistake that is still recoverable
at that instant, and the only thing that can tell them is the label. There is no help sentence beside
it, because the name has already said everything a sentence would.

### And the flaw in the test that was written for it

The first version asserted "nothing was sent" in the same tick as the click. A mutation reaches `fetch`
on a microtask, so the assertion described a request that was about to be sent — and **both** negative
assertions would have passed whatever the control did. It is the register question's own shape wearing
a clock: an expectation that the failure case satisfies. The assertions now run after the queue has
drained, and the guard was proved by mutating it in both directions — remove the floor and the second
tap deletes at 200 ms; make the first tap fire and it deletes with no confirmation at all.

## "We will not apply it" is not a safeguard, because the device applies by itself

Measured on the bench, 2026-09-21, while restoring six units that had been dead for two and a
half hours.

A write to the profile dropped six credentials. The damage was latent: nothing had been applied,
the running device was healthy, and a freeze was declared — **no writes, and no applies, by
anybody** — until the defect was fixed in code.

Twenty minutes later six units were dead, killed by an apply nobody ordered.

**What ordered it.** A tunnel's peer moved the session to a different gateway, as that peer does
several times an hour. The daemon re-derives when that happens — correctly, because a reconnection
changes the address, the pushed routes and the pushed resolver, and a device that did not follow
would hold a configuration describing a network that no longer exists. The transactions are in the
ring with `openedBy: null`, which is the record saying **no person opened this**.

So the freeze covered the two doors we knew about and not the one the device opens for itself. A
damaged document is not inert while it sits unapplied. It is **queued**, and the trigger belongs to
somebody else's network.

### The two things this changes

**A latent defect in stored configuration has a deadline you do not control.** The interval between
storing something wrong and it reaching the hardware is not decided by the operator's caution; it is
decided by whatever the device reacts to. Here it was under half an hour, on a peer that reconnects
on its own schedule. Any reasoning of the form *it is only stored, we will fix it before it matters*
requires knowing what can apply it, and that list is longer than it looks.

**The automatic path used the same generator and produced a file that could not run.** The scripts
it wrote reference a variable nothing exports, so six services exited immediately and systemd gave
up after five attempts. There is nothing wrong with re-deriving. What is missing is that the
re-derivation had no reason to ask whether the document it was deriving from had become *less*
complete than the one already running — and a generator cannot notice, because a missing credential
renders as an absent field, not as an error.

### The rule

**Before declaring a freeze, enumerate what can act without a person.** Timers, watchers,
reconnections, peers, the reconciler's own re-derivation. A freeze that names only the human paths
is a freeze on the doors with handles.

And the register question it earns: **what applies this, other than me?** If the answer is "nothing"
without a list, the answer is not known.

## A producer nothing could consume, and the four refusals that were riddles

Found while translating the subscription parsers into catalogue configurations, 2026-09-21.

The catalogue had been enforced everywhere a tunnel is **stored**: schema 7 is a union over three
entries, and a document naming anything else is refused at the write. Six subscription parsers went
on producing proxy-core outbounds, and `POST /api/subscriptions/parse` wrapped each one as
`{ provider: 'singbox-outbound', … }` — a shape with no branch in the schema.

**Every draft that route returned was unstorable.** Parse a subscription, get a list of nodes, try to
keep one, and the write refuses it. The route worked. Its tests passed. Its output had exactly one
possible fate.

### Why nothing caught it

Both halves were tested, and each half was tested against itself. The parser tests asserted that a
`vless://` link produced the outbound the parsers were written to produce. The profile tests asserted
that schema 7 refused a document naming an unknown protocol. Both were right. **No test put the
output of the first into the input of the second**, because that seam is not inside either file, and
a seam with no owner has no test.

The general form: **an invariant enforced at the consumer is not enforced.** It is *detected* there.
Everything upstream is free to keep producing what will be refused, and will look correct doing it,
because its tests compare it against its own intent rather than against the thing that has to accept
it. *Outside the catalogue there is nothing* was true of writes and false of the producer feeding
them — the same rule, broken from the other end.

What that argues for, and what was done: the check moved into the producer. `parseSubscription` now
validates every draft against `TUNNEL_CONFIGS[protocol]` before a caller sees it, so a parser that
drifts fails at the line that caused it, with the line number and the excerpt still in hand, rather
than two layers away at a profile write.

### The second defect, which is about sentences rather than types

Five of the six parsers were for protocols this product does not run. Deleting them makes a
`vmess://` line fall through to the default path, which said: *no parser here handles this scheme.*

That sentence is a lie of omission. It describes a **gap in our coverage** — something we have not
got round to — when the truth is a **decision about what the product runs**. A person reading it
waits for a fix that is never coming, or files it as a bug. The two situations are genuinely
different and the message could not tell them apart.

So the five parsers' `test` predicates were kept, with their bodies deleted, purely so the refusal can
name the scheme: *a VMess link names something this product does not run.*

### The rule, which the other refusals were then checked against

**A refusal naming both what was rejected and what is accepted is an answer. A refusal naming only
the first is a riddle.** Checking the rest of the file against it found three more: an unrecognised
transport, an unrecognised transport security, and the fall-through for an unknown scheme all named
what they would not take and left the person to discover what they would.

The accepted halves are now **derived** — read off the catalogue and off the schemas, never written
out a second time. Two lists of the same set drift, and the one that drifts is whichever was not
updated; here the drifted one would be the sentence a person is given at the moment they are already
stuck.

### Mutation, because green is not evidence

The three guards were each broken on purpose and the suite run:

| mutation | result |
| --- | --- |
| parser emits a field the catalogue entry does not have | 13 failures |
| `configFault` neutered to always return "fine" | 1 failure, and it names the guard |
| the derived catalogue sentence blanked | 2 failures |

The second is the one worth keeping. A validating guard whose deletion changes nothing is the shape
this project has now found several times, and only running without it distinguishes a guard that
works from a guard that is never reached. The first mutation passing is not evidence for the second.

And the register question it earns: **who has to accept what this produces, and does anything compare
the two?** A producer tested only against its own intent is untested where it matters.

## A generalisation that looks like stronger cover can switch the cover off

Found while proving E7's parity check by mutation, 2026-09-21.

The check's first layer requires that every position a **missing-secret refusal** can name is
reachable from some screen. That list is worth having only if it really is the refusal's own
vocabulary, so it is asserted in both directions: the positions parity requires and the positions
`missingSecrets` produces must be the same set.

The mutation that justifies the second direction is the one worth recording. `state/secret-plan.ts`
was given **one extra matcher, `/tunnels/-/config`**, sitting above the five it already had beneath
it. Read as a diff that is an improvement: one line covering a whole subtree instead of five lines
covering its leaves, exactly the tidying a reviewer would approve.

It removes the cover. `mapSecrets` walks the document and **stops descending the moment a position
matches** — it hands the value to the transform and returns. So a matcher on the parent means the
walk never reaches `/tunnels/-/config/id`, `/profile`, `/encryption`, `/auth/password` or
`/entryPoints/-/uid` again. The refusal can no longer name any of them. Redaction on read, the
redacted export and `$keep` on write all run through the same walk, so all of them would have
started treating a tunnel's whole configuration object as a single opaque secret — and the five
pointers that leaked once already would have been the five that stopped being named.

Parity caught it as the *other* failure: five requirements the refusal could no longer name, which
is a requirement nothing can satisfy. Without the second direction the assertion would have been
written as "everything the refusal names is required", and that stays true — the refusal names
fewer things, and fewer things are all still required.

### The shape, which is new here

**A generalisation that looks like stronger cover can switch the cover off, wherever the mechanism
underneath stops at the first match.** The seductive part is that it reads as *more* protection: one
rule where there were five, a smaller file, nothing obviously removed. Nothing about the old
behaviour is deleted in the diff; it is shadowed by something added above it.

This file already holds a guard no input could reach and a mechanism wired to a gate it could never
pass. Those were built wrong. This one would be built wrong *by being tidied*, some afternoon, by
somebody with every reason to believe they were improving it.

> **Does this walk stop at the first match, and does anything here sit above anything else?** Ask it
> of every matcher list, route table, rule set, pattern list and dispatch table in the tree. Where
> the answer to both is yes, an entry added above an existing one silently disables it, and no test
> that only checks "the general rule fires" will disagree.

The direction of the assertion is the lesson. Checking that every produced value is permitted leaves
a producer free to produce less. **Both directions, or the comparison only constrains one side.**

## A deletion that would have committed the complaint it was written to remove

Found 2026-09-21, building the tunnel editor, by reading the screen that had been ordered deleted before
deleting it.

The instruction was exact and its reason was sound: delete the old profile editor in the same commit as
the new tunnel screen, so the tree never passes through a state where a tunnel cannot be edited. The
reason given was about tunnels, and it was complete about tunnels.

**The screen also held thirty positions that were reachable from nowhere else.** The Wi-Fi network name
and passphrase, the range of addresses handed to clients, the radio's band, channel, width and country,
the uplink bindings and credentials, both resolvers, the profile's own name. E10 had placed the access
point and the uplink on the Network screen; that screen was built to answer *what is true right now* and
was read-only, and no task in the plan owned moving the controls.

So the deletion as ordered would have left all of it configurable through the API alone — **the owner's
original complaint, performed by the change written to remove it.** Not temporarily: no later task
covered it.

### What made it visible, and what did not

Not the plan, which named the file. Not review, which read the diff. It came from one question asked of
the *existing* code before removing it: **what else is reachable only from here?** Answered mechanically —
the screen's pointers, grepped, minus the pointers every other screen renders, which the coverage manifest
already lists.

That the manifest could answer it is worth its own line. The manifest exists to say what the interface can
edit; asked from the other direction it says what the interface is about to *stop* being able to edit.

### The rule

**A deletion must enumerate what was reachable only through the thing being deleted, and the enumeration
belongs to the task rather than to the judgement of whoever executes it.** "Delete X" is a complete
instruction about X and says nothing about X's other tenants. A screen, a route, a module and a package
all have them.

The register question: **what did this hold that nothing else holds?** If the answer is "nothing" without
a list, the answer is not known.

## Two controls the coverage manifest could not see, and they were the two that matter most

Found the same day, by the mechanical parity comparison on its first run.

`LeakPolicy` — whether traffic may leave this device outside a tunnel — was built with hand-written radio
and checkbox elements rather than with the shared `Field`. It therefore carried no `data-pointer`, and the
coverage manifest, which is harvested from the rendered DOM, reported that **nothing in this interface
edits `/policy/onAllDown` or `/firewall/killSwitch`.**

Every human review of that screen passed. The control was visible, correct, well-worded and measured at
360 px. What was missing was invisible by construction: an attribute whose only reader is a check.

**The shape.** A convention enforced by a check is enforced only where the check can see. A control built
outside the mechanism that carries the convention is not a violation anybody can notice — it simply does
not appear, and absence is what the check was built to detect in the *other* direction. The manifest could
say "this field left the screen"; it could not say "this field was never on the screen the way I read
screens".

**Why the mechanical comparison caught it and four passes of people did not.** It asks a question no
reader asks: not *is this screen right* but *is every position a person must fill rendered somewhere*. A
position nothing renders and nothing claims to render is a gap with no edge — there is no wrong line to
read.

### And a third instance of the same width rule, in a third control

The bench reported `66 control(s) below 44 px` within a minute of the tunnel screen landing: every radio
in a consequence-bearing choice. The cause is the rule recorded earlier for checkboxes — the global
`input { width: 100% }`, written for controls a value is typed into, reaching a control that is a button.
The fix is the same: intrinsic width, and the 44 px floor kept, because the floor is about the target and
not about the paint.

Twice now this rule has surfaced in a new control, and **both times a machine found it, not an eye.** The
general form is worth stating: a global rule written for one kind of element is a latent defect in every
kind of element that is not that kind, and it becomes visible only when somebody adds one.

## A number that stopped being true, and a count that survived the swap

Found 2026-09-21, pinning the parity walk's two fixes by mutation — the fixes themselves having
landed unpinned in the commit before.

### The number

Commit `58a48ab` states that the walk yielded **123 positions where it should yield 133**, and
attributes the ten to one defect: a walk-wide set of visited nodes, which memoises on object
identity and so returns early at the second use of a declaration written once and reused by
reference. The comment left in `parity.ts` repeated the ten.

Measured by mutation, three ways, against the same tree:

| walk | array rule | positions |
|---|---|---|
| global visited set | old (descend into every array) | 123 |
| ancestor chain | old | 133 |
| global visited set | current (objects only) | 125 |
| ancestor chain | current | 133 |

So **the ten was a net across two defects that landed fixed in the same commit.** The visited set
cost ten under the old array rule and costs eight under the current one. The two extra were
`/policy/excluded/-` and `/policy/priority/-` — positions the new array rule correctly never creates
at all, because a list of scalars is filled by one control that writes the whole array.

The number was not wrong when it was written. **It stopped being true**, in the same commit that
made it, and those are different things: nothing was measured carelessly, and nothing would have
caught it except measuring again. The record is corrected in both places because a commit message
cannot be edited — the comment in `parity.ts` now carries the eight, the derivation and the fact
that `58a48ab` says ten. Two sources that disagree are resolved by whichever is read first, and the
commit will be read first by anyone following `git log`.

> The register question: **when a fix and a measurement land together, is the measurement still
> about the thing being fixed?** A count taken before a commit describes the tree the commit
> replaced. If two changes are in it, the count belongs to neither of them alone.

### The count that survived the swap

The second mutation is the one worth carrying further. The array rule was inverted the other way —
descend into arrays of scalars — and the total came back **133, exactly as before.** Fourteen
fillable positions had been replaced by fourteen that nothing can fill: `/policy/excluded/-`,
`/routing/rules/-/suffixes/-`, `/tunnels/-/config/alpn/-` and eleven more, each demanding a control
for the third string in a list that one control writes whole. That is the mirror of a guard no input
can reach, and **an assertion on the count would have passed straight through it.**

This is a new shape here. This file already holds checks that pass on nothing and checks nothing can
reach; this is a check watching a *size* while the contents are exchanged underneath it. It is worse
than the usual case because a count looks like an objective quantity — the sort of thing a reviewer
accepts without asking what it is a count *of*.

> **A measure of quantity is blind to a substitution of equal size.** Ask of any assertion on a
> length, a total, a row count or a file size: what would an exchange of the same size look like
> from here? If the answer is "identical", the assertion is not measuring the property it is named
> after.

What closes it is a property rather than a list: **no position may end in an array element.** Stated
that way it covers the fourteen, and covers the fifteenth list added next year by somebody who never
reads this. The same choice was made for the families above — assert the whole family of a shared
declaration rather than the positions that happened to vanish, because which use survives depends on
the order of properties in the document, and a list of casualties would agree with a reordering that
had only moved the hole. **Both times the enumeration was the weaker form of the same check.**

## A correct decision can empty a guard, and nothing says so

Found 2026-09-21, adding a fifth source (`generated`) to the field-provenance annotation and marking
the six positions that had been left deliberately unmarked.

The decision itself is argued in `docs/14-open-questions.md` and beside the kind in `source.ts`. The
one line of it worth repeating here is the reason a fifth word beat six red lines: **a check that is
permanently red for a legitimate reason gets ignored, and then it is worth nothing on the day it is
right.** Six known-good failures do not stay six known-good failures; they teach every future reader
that this check's red is background noise.

What the change then did to the machinery around it is the part that is new.

### The layer that stopped having members

Parity's `unmarked` layer is the loud default the whole annotation rests on: a field nobody
classified is **required**, so that forgetting the mark is louder than getting it wrong. Six
positions exercised it. Marking them emptied it — and an empty layer is **a branch no input can
reach**, which this file already records in three other forms. The branch would have survived its
own deletion in silence, and the test that covered it would have gone on passing by having nothing
to test.

It is not that the decision was wrong. It is that *the decision was right and the guard became
unreachable as a direct consequence*, in the same diff, with nothing in the diff pointing at it. The
fix is the one already used for the inheritance rule: `parityRequirements()` now takes a root, and
the layer is proved against a schema built to reach it, in both directions — an unmarked leaf is
required and names its layer; the same leaf marked is not. Deleting the branch turns exactly that
test red and nothing else.

> **When a change removes the last real instance of something, what was watching that something?**
> Ask it of every category, branch, error kind and failure path whose last member a diff removes.
> Emptying a bucket is indistinguishable, from inside the check, from the bucket working.

### And the wrapper that dissolved a reference

The second effect was quieter and nobody was looking for it. `Source()` returns a **copy** of the
schema. Three identifier positions gained a mark, so `Identifier` stopped being the *same object* at
four of its five pointers.

`documentPositions()` carries a guard against a walk that memoises on object identity — the defect
that once erased eight positions by returning early at the second use of a declaration written once
and used many times. Measured by restoring the global visited set: it cost **ten** when it was
fixed, **eight** once a second defect in the same commit was separated out, and **four** after this
change. The `Identifier` family is no longer part of what that guard catches at all, and the test
that pins it would now stay green on that family under the very mutation it was written against.

Nothing about the walk, the test or the guard changed. A mark added for an unrelated reason reduced
what the guard has left to catch.

> **Whenever a wrapper is applied to a declaration, ask what was relying on that declaration being
> shared by reference.** Any helper that spreads — `Source()`, `Secret()`, the next one — dissolves
> sharing wherever it is applied, and sharing is a property of the declarations rather than of the
> code that walks them.

Both shapes are the same shape seen from two sides: **the strength of a guard is a property of the
tree it is run against, not of the guard.** It can therefore be reduced to nothing by a change that
is correct, reviewed, and about something else entirely. A guard is only as strong as its last
measurement, and the measurement has to be retaken when the tree moves — which is why the three
numbers above are all recorded, with their dates, rather than the last one silently replacing the
others.

## A guard whose last member left, and the number that did not move

Found 2026-09-21, marking `/tunnels/-/config/entryPoints/-/id` as `generated` — the seventh position
to carry that mark, a commit after the six that introduced it.

The mark itself is not the interesting part; it is the same argument as the other three identifiers,
made in `docs/14-open-questions.md` and beside the kind in `source.ts`. Two things around it are.

### The criterion was not applied by the diff that introduced it

The field inherited `person` from its container, so it was required, so the check was green, so
nothing asked the question of it. The task that day had been *mark these six*, and six were marked.
Nothing in the tree, the suite or the diff pointed at the seventh.

> **A new criterion is not applied by the diff that introduces it.** That diff applies it to the
> positions somebody was already looking at. The rest are then the hardest to revisit, because the
> diff reads — to its author and to everyone after — as the moment the rule was applied everywhere.

### And the measurement that stayed the same, which is why it is recorded

`documentPositions()` carries a guard against a walk that memoises on object identity. Its strength
is measured by restoring the defect and counting what disappears: **ten**, then **eight**, then
**four** after three identifiers were wrapped, each recorded with its date because each was true when
it was made.

Measured again after this mark, by the same method: **four, and the same four —
`/accessPoint/bind/by`, `/accessPoint/bind/value`, `/accessPoint/pinName`,
`/accessPoint/takeOverInterface`.** The last raw use of `Identifier` at a walked position left, and
it cost nothing, because a declaration used at one position cannot collide with itself. The family
had already stopped catching anything one commit earlier; this commit only removed the appearance
that it might.

That is the reason to write down a number that did not move. From the total, a family that catches
nothing and a family that catches something are the same number. The guard had four members listed
and three of them load-bearing, and no run of anything would have said which.

> **An unchanged measurement is evidence about the tree, not about the guard.** Retake it when the
> tree moves and record it even when it is the same, or the next reader will take the old number as
> still describing the same thing.

So the question the notes told a reader to ask by hand — *what was relying on that declaration being
shared by reference?* — is now asked mechanically. A test asserts **which declarations the document
still shares by reference**, whole and exhaustively, so a wrapper that dissolves the next one goes
red in the diff that applies it. Two details of it were each got wrong first and are worth the words:

- **distinct pointers, not occurrences.** A union's branches all sit at their container's pointer, so
  `/routing/rules/-/action` is reached five times and `/tunnels/-/config/auth` twice. Counting
  occurrences makes the assertion a statement about unions rather than about sharing.
- **the walk's own array rule, imported rather than restated.** Raw `Identifier` is *still* the same
  object at `/policy/priority/-` and `/policy/excluded/-`. Those are arrays of scalars, which the
  walk deliberately never enters, so neither is a position and neither can be lost to a memo. A
  descent that entered them would report a shared family the guard cannot be proved on — a
  requirement nothing can satisfy, in the test that exists to measure the guard.

Proved in both directions, 2026-09-21, against the real document: wrapping `/accessPoint/pinName`
dissolves that family and the assertion goes red while the family test above it stays green — which
is exactly the gap it was written to close; and giving two unrelated fields one shared declaration
makes a family appear and it goes red the other way.

## A response schema is a serializer, and an undeclared key leaves no trace

Found 2026-09-21, putting the management channels, the refusals and the withholdings on the wire.

The daemon had computed all three for some time and they died in the process. The handler for
`GET /api/system` was changed to return them — correctly — and they arrived nowhere. Fastify uses
the response schema to **serialize**, not only to validate: a key the schema does not declare is
dropped. No error, no warning, no log line, and a 200 with a well-formed body.

That is the same failure the fields were added to fix, one level down. A refusal died in the process
because nothing carried it; the report of the refusal then died in the serializer because the schema
did not declare it. In both cases the surface said *nothing is wrong* and was structurally incapable
of saying anything else.

> **Ask of every field added to a response: what, mechanically, would carry it to the client, and
> what would it look like from the client if that thing were missing?** If the answer to the second
> is "exactly like a device with nothing to report", the field needs a test that reads the wire.

So the tests for these three go through `app.inject` rather than calling the function that builds the
report. There is a unit test of that function, and it proves the report is right while saying nothing
about whether it leaves the process. Proved by mutation, both directions, 2026-09-21:

- deleting the three keys from `SystemResponse` turns all three wire tests red, naming the serializer
  as the cause rather than the handler;
- collapsing the handler's `?? null` to `?? []` turns exactly the first one red — the device that has
  never applied anything.

### Null, and never an empty list, before the policy has run

The three fields are `null` until the bind policy has run once. An empty list is a **reassuring**
answer — *nothing was refused* — delivered in precisely the case where nobody has looked yet, and a
client that draws nothing for `[]` would draw nothing for a device that has decided nothing.

This is the third shape of the same thing found in one day, which is why it is worth stating as a
rule rather than as a decision about three fields: a guard no input reaches, a category whose last
member left, and now a value whose absence is rendered as its own good news.

> **The default value of a not-yet-known answer must not be the value that means "all clear".**

### And the class travels in the classifier's own word

`class` is `wirelessUplink` on the wire, which is what `core/interface-class.ts` calls it. Renaming
it at the boundary to something friendlier would create a second vocabulary for one fact, and the
translation between them would be written by whoever was least sure what the classifier meant.

The schema restates the six classes because `packages/schemas` cannot depend on the daemon — the
dependency runs the other way. What keeps the two lists together is not discipline: the handler
returns the classifier's own type, so a class added there and missing here stops compiling. Proved by
mutation, 2026-09-21: adding a seventh class to `ChannelClass` fails `apps/daemon`'s typecheck at the
route, naming the response type. The reverse direction — a literal in the schema the classifier
cannot produce — is **not** caught by that, and is the direction to be careful in when editing the
list.

## The tool that checks the guards can itself be decorative

Found 2026-09-21, while proving the tunnel status field by mutation.

The method this repository has used all day to tell a real check from a decorative one is to break
the thing on purpose and watch the test go red. Inverting the precedence rule — making `unknown`
outrank `stopped` — produced **no failing test**. That is the signature of a guard no input reaches,
and the guard had been written an hour earlier specifically to be reachable.

It was not the guard. The substitution had not matched, the file was unchanged, and the run was
reporting on unmutated code. Re-done with the replacement asserted before the run, the same mutation
turns the test red immediately.

> **A mutation harness that cannot fail loudly when the mutation did not apply proves the same thing
> as a guard that cannot fire: nothing, convincingly.** Every mutation run asserts its anchor is
> present *before* it writes, and a missing anchor aborts the run rather than producing a green
> result. This is a requirement of any future mutation pass in this repository, not a detail of that
> one.

**And it is recursive.** Every instrument used to check something is a candidate for the same
question. The day's earlier findings were all about guards whose inputs could not reach them; this
one is one level up — about the instrument used to find those. The next level up is the same
question asked of the anchor assertion, and the answer there is that it fails closed: an absent
anchor raises, and a raised assertion cannot be mistaken for a passing suite.

## `service`, and the word that had to stay narrower than the thing

Landed 2026-09-21 with the tunnel source and its schema key.

`GET /api/status` now reports tunnels. The field is `service`, deliberately, and the note beside it
says it is an aggregate over the tunnel's units and says nothing about whether traffic passes.

**Nothing on this device measures a tunnel.** Measured on the bench board, 2026-09-21: one tunnel's
unit stayed `active` for an hour while never once completing key negotiation; another answered its
own resource in half a second while the guard in front of it refused every connection. Both read
`running`. A field named `state`, `health` or `up` would have been wrong in both cases and would
have read as an answer; `service` is narrow enough to be true.

> **When the honest reading is narrower than the word a reader wants, name the field for the
> reading.** The wider name gets no field until something measures it, and the narrower one carries a
> sentence saying what it does not cover.

### A tunnel is not one unit, and nothing in the tree said what to do about that

An OpenVPN tunnel has one unit; the same tunnel behind an obfuscation transport has a transport as
well; a VLESS tunnel has its client. Four combining rules were decided, each against the shape it
would otherwise take by default:

* **stopped outranks unknown.** A component known to be down is a stronger fact than one nobody could
  read.
* **the maximum restart count, never the sum.** A reconnection restarts a transport and the tunnel it
  carries together, so a sum crosses the three-restart warning threshold at two reconnections.
* **the most recent active-enter**, from the monotonic timestamp and the machine's uptime. This board
  has no clock battery; after a step, the wall-clock property is in the old frame and a client's
  subtraction yields a duration that never happened. `TunnelUnitReading` has no wall-clock field at
  all — making the wrong value unavailable is stronger than a comment asking for the right one.
* **an empty unit list is `unknown`.** "Every unit is active" over an empty list is vacuously true, so
  the obvious implementation reports a tunnel with no units as healthy.

The last of those is the day's rule in a new place, and it appeared **four** times before the field
reached the wire: the snapshot's initial value, an unwatched set, an unwritten database column, and a
restart count nobody could read. Each one defaults to something reassuring unless it is written out.

> **Every "not yet known" on the path from a reading to a screen is a separate decision.** Fixing it
> at the wire does not fix it at the source, in the store, or in the accumulator, and each of those
> renders as the same good news.

### The unit names come from the plan, and that argument now has two instances

The planner records `{ id, units }` per tunnel; the daemon stores it; telemetry reads what was
recorded. The alternative — rebuilding the unit names from the tunnel's protocol at the point of use
— is the second copy of a naming rule, which is the same argument already written beside the tunnel
*interface* names on the recorded management surfaces. Two instances of one argument, in two places,
is the point at which it is worth stating as a rule rather than as a decision about one field.

## A restart that can say what it is for

Landed 2026-09-21. `UnitChange.becauseOf` carries the file paths whose change is why a restart is in
the plan.

Six times in a row the core was restarted with a configuration file whose rewrite had been refused,
and the caller recorded success every time. The plan was right and the refusal was right. What did
not exist was the one fact joining them: a restart could not say what it was for, so nothing could
notice that the reason had not happened.

**Paths, not a flag.** A refusal is per path, so a path is the only key the two sides share. A boolean
says a restart has causes and leaves a caller unable to check whether *its* causes survived.

**A unit's own definition counts as its own cause.** A unit file is consumed by systemd, not by one of
our units, so no `consumedBy` declaration names it and the consumer walk cannot reach it — the same
blind spot as the defect already fixed here, where a unit whose definition changed was reloaded and
never restarted. A restart whose only reason is a rewritten definition would otherwise arrive with no
causes, which reads as "not recorded".

**A step planned because the unit is down carries no cause at all**, and not the files it happens to
share an apply with. It is permanently unskippable, which is the safe direction: a unit that is down
still has to be brought up.

**Skip only when present, non-empty, and *every* path refused.** "All", not "any": a restart may have
been needed for a second file in the same apply, and skipping on one refused cause leaves that second
file written and never in force — the original defect with the sides swapped.

### A rule with a second rule standing behind it is a rule nothing measures

The first version of the test file used `wf-core.service` with a configuration under `/core/`. That
pair is matched by **two** of the three cause rules: the file's own `consumedBy` declaration, and the
legacy path-shape net that predates declarations. Deleting the declaration rule entirely left every
test in the file green.

The fix is a fixture the net cannot reach — a unit with no instance name, that is not the core, whose
file lives nowhere the net looks — so the declaration is the only thing that can produce the cause.
Proved both ways, 2026-09-21: deleting the declaration rule turns exactly that test red, and the
assertions that the fixture stays out of the net's reach are in the test body rather than in prose, so
a net that later grows to cover it cannot quietly reduce the test to proving nothing again.

> **When a test fixture satisfies two rules at once, it measures neither.** Ask of every new rule:
> which fixture reaches it *and nothing else*? The overlap is invisible from a green suite, and it is
> the reason a deletion can be reviewed, merged and cost nothing.

**And the net itself, measured the same way: deleting it turns nothing red in the whole daemon
suite.** Every file it would catch today is also declared, so it currently catches nothing. It is kept
— it is a fall-back for a file that arrives with no declaration, which has not happened rather than
cannot — and the number is written beside it, because from a green suite a fall-back that catches
nothing and one that catches something are indistinguishable.

## The fault list a fixture wrote, beside the one a missing control wrote

Found 2026-09-21, building the controls for the four positions the fixed requirement walk had just
made visible. The parity check names positions that are reachable from the API and from no screen, and
it cannot distinguish **two different defects that print the same line**:

* a position with no control anywhere — `/accessPoint/pinName`, `/accessPoint/takeOverInterface` and
  their uplink twins, which had never been written;
* a position whose control exists, is correct, and **is never rendered by the fixture the harvest runs
  against** — `/routing/rules/-/sets`, drawn only for `kind === 'ruleSet'`, in a document holding five
  rule kinds and both anchors and not that one.

The second is the dangerous one, because the obvious response to the line is to write a control — and
a second control for a field that already has one is precisely the duplicate this epic deletes. It was
told apart by adding one rule of that kind to the fixture and re-running: the pointer reappeared in the
manifest with no code change at all.

> **Before building a control for a position the parity check names, add the value to the fixture.**
> If the pointer appears, the control existed and the measurement was about nothing. The check reports
> what the DOM contains, and a fixture that never reaches a branch is indistinguishable from a branch
> nobody wrote.

This is the same failure as the bench answering `{}` for a route no fixture matched, and as a document
with no subscriptions and no uplinks — third instance, in the check one level out. The bench's own
answer to it exists (it fails on any request it could not answer); the harvest has no equivalent,
because there is nothing to detect: the document is complete and simply says `domainSuffix` where it
could have said `ruleSet`.

### And the shape it leaves behind

The remaining fault list was then classified by the same method rather than by reading it. Thirty-three
positions remain, and they are not one task: `/tunnels/-/protocol` and `/routing/rules/-/kind` are
**chosen when the row is added** and carry no stamped pointer, so they may be a third category again —
fillable, uncountable — while `/policy/probes/*`, `/firewall/blockedEndpoints/*` and
`/routing/ruleSets/-/*` are whole sections with no screen. A single number over three kinds of cause is
a number nobody can act on, which is the reason this note exists rather than a count.

## A field with no consumer, closed — and the collision found while closing it (2026-09-21)

Landed 2026-09-21. `UnitChange.becauseOf` now has a reader: one filter in
`apps/daemon/src/core/reconciler.ts`, over the unit changes it is about to order. A step is skipped
when its cause list is present, non-empty, and **every** path in it was refused, and the skip is
reported as a refusal of its own with the files it was waiting on. The contract is in
`docs/06-apply-and-rollback.md`; the decision behind the reporting shape is in
`docs/14-open-questions.md`, where the question was left open for the owner.

### Two details in the implementation worth keeping

**The refused paths are accumulated as paths.** They are added to a `Set` in the loop that already
computes the refusal, rather than recovered later from the `what` sentence each refusal carries. The
alternative would have made the phrasing of a message written for a person into a data format, and
the join would have broken silently the first time somebody improved the wording.

**The skip goes into the refusal channel that already exists** rather than into a second one. One
thing said one way. A step reporting `ok: false` would have been the other option and is a report of
an attempt that was never made — the same family of untruth this whole mechanism exists to remove,
arriving from the other side.

### The mutation that mattered was not the obvious one

Four mutations, each with its anchor asserted before the substitution, against 665 tests:

| Mutation | Red |
| --- | --- |
| `every` → `some` ("any cause refused") | 1 — the partial-refusal test, alone |
| drop the `length > 0` test | 1 — the absent/empty test, alone |
| absent read as skippable | 13 |
| filter removed entirely | 2 — the two that assert a skip happens |

The first line is the finding. **A suite containing only the fully-refused case passes against "any
cause refused".** That rule is wrong — a restart may have been needed for a second file in the same
apply that *was* written, and skipping on one refused cause leaves that file on disk and never in
force, which is the original defect with the sides swapped. It is also the version that *looks*
safer, because it skips more and skipping reads as caution. The test that separates them asserts its
own premise first: that exactly one of the two causes was refused and the other really was written.

The second line was green until the test was written for it. The differ plans a restart only once a
cause has been found, so `becauseOf` is absent or non-empty and never `[]`; the guard that reads an
empty list as absent was unreachable from any real plan, and deleting it turned nothing red. It is
now proved against a `Plan2` built by hand — which is the input `reconcile` accepts, and the boundary
is explicitly about steps assembled elsewhere. Third instance in two days of the same shape: a rule
standing behind another rule, a fall-back that catches nothing, and a guard no input reaches all
report the colour a working guard reports.

Asked of the new test as well, because the question keeps paying: **what does it print when given
nothing** — no refusals, no unit changes, a restart with no causes? An empty refusal list, and every
step still run. Recorded as a test rather than as a sentence.

### The collision, and the mechanics of it

Two agents were given this one task at the same time — the owner answered the open question to the
predecessor that had raised it and started a second stream on the same file. It was noticed from
inside the file rather than from the dispatch: a string replacement failed to match in
`reconciler.ts`, on a line read minutes earlier from a tree that `git status` had reported clean.
The evidence was assembled before the conclusion — clean tree at start, the file read, a green
baseline of 660, then the mismatch and a diff in someone else's naming (`refusedFilePaths`,
`runnableUnitChanges`) — and the hypothesis that the predecessor was alive and had received the same
answer was correct.

The implementation was kept, because it was right and rewriting it would have been churn. **It was
kept because it was read and taken apart, not because it was found in place**: code that turns up in
the tree is not verified by having turned up there, and the mutations above were run without regard
to who wrote the lines.

The mechanical lesson, which is the reusable part: **two agents on one task are not double speed,
they are two authors of one file.** Both had also written tests — a dedicated file and a block
appended to `reconciler.test.ts` — covering the same rule with different fixtures. Two suites for one
rule read as more coverage than exists, which is exactly the illusion the rest of this document is
about, so they were consolidated into one file and the duplicate block was reverted. What each
fixture could reach differed and both were kept in substance: a unit whose causes are its ruleset and
its own definition, and the boundary cases only a hand-built plan can express.

**The one that was missing from both, and is the reason the merge was worth doing rather than
picking a winner:** neither author had covered the same ground. One had "a restart whose reasons were
all written runs normally" — the control that stands between this filter and a blanket one — and the
other had the absent-and-empty boundary. Kept separately, each suite would have looked complete.

## The suggestion that produced the state it was there to prevent (2026-09-21)

The interface's binding field is a text box today, and the value belongs in a chooser: the value is
measured — an address, a USB vendor and product, a sysfs path — but *which* piece of hardware a role
gets is a person's assignment, and no amount of enumeration answers it. Building that list in the
browser was refused, correctly: the kernel reports a radio with the same link type as a wired port,
so a classifier on that side would be a second source of truth about what a piece of hardware is.

Building it on this side exposed a defect in the list that already existed.

**`radioCandidates` suggested `phy-usb` for every removable radio.** A USB identifier names a vendor
and a product, not a device, so two identical dongles report the same one — and the suggested
selector then matched both. Accepting the suggestion produced an `ambiguous` binding: the exact state
the chooser exists to resolve, arrived at by taking the chooser's advice. The same function also
built `{ by: 'bus-path', value: '' }` for a removable radio with no identifier, which is a selector
that matches nothing and which the profile schema rejects outright (`minLength: 1`).

### The rule that replaced it, and why it is measured rather than written twice

The suggestion is now chosen to be one that **distinguishes**: the identifier when nothing else
answers to it, the bus path when something does. Whether something else answers is not decided by
comparing identifiers here — it is decided by running the candidate selector back through
`matchRadios`, the same matcher that will resolve it later. A candidate cannot then predict a
resolution different from the one it will get, and the same fallback covers a device with two
built-in radios, where `phy-builtin` matches both for an unrelated reason.

`distinct: false` is reported rather than hidden, for the candidates nothing can separate at all.
**The screen must never offer a choice that does not choose**, and the honest form of that is a flag
on the candidate, not a candidate quietly missing from the list.

The fallback carries its consequence in the candidate, next to the suggestion, because it is a real
trade in both directions: **an identifier follows the device into another port; a bus path follows
the port and stops matching when the device is moved.** A selector that silently changes meaning is
worse than one that asks. This is the same shape as the unit changes' consequences — set in one pass
over the built list rather than at each site, because a consequence that is right at seven sites and
forgotten at the eighth teaches the reader that its absence means the step is harmless.

A radio that reports no identifier, no bus path and no address is left out of the list entirely. A
candidate nothing can select is not a choice, and an unusable selector in the list is worse than a
shorter list.

### The fixture without which none of this could fail

A fixture with one dongle cannot fail this rule, in the same way a family of one cannot collide with
itself. The assertions are made against `two-identical-dongles` — two radios sharing `0e8d:7961` and
differing only by port — and the anchor is asserted before them: that the identifiers really are
equal and the paths really do differ. Then the suggestion is not merely inspected but **resolved**,
and each one binds to exactly the radio it came from.

Evidence, 2026-09-21: 673 tests green. Making the builder suggest the identifier anyway turned
exactly one test red — `two dongles sharing a USB identifier get suggestions that separate them` —
and nothing else in the suite noticed. Asked of the new surface as well, because the question keeps
paying: **what does it report when given nothing?** No radios on a device that has wired ports:
empty, and the wired list non-empty beside it, so the emptiness is an answer about radios rather than
about the inventory. No hardware at all: empty in both directions. A role that bound with no
ambiguity: the full list, which is the point of hoisting it onto the bound variant — a chooser that
appears only once the binding has broken is a chooser nobody reaches in time.

### A correction to the record, found by reading the route rather than the resolver

It was reported that the resolver's candidates reach no client at all. That is not what the tree
does. `renderPlan` spreads each resolution into `bindings[]`, `GET /api/plan` declares **no response
schema**, so nothing is dropped on the way out, and `PlanReview.tsx` already prints the labels for
unbound roles. What was actually missing is narrower and still real: **a bound role carried no
candidates** (it does now), and the only way to obtain the list is to ask for the plan of the
**active** profile — which is not available while editing the binding of any other profile, and is a
plan review rather than a question about hardware. That is what the new surface is for, and it is a
smaller claim than the one it replaces.

## A setting that is not ignored but contradicted (2026-09-21)

The question asked was whether a wireless uplink's *get the address automatically* flag was being
ignored, since the schema offered the flag and no address fields to go with it.

**It was not ignored. It was contradicted, which is worse.** An ignored setting disappoints: it does
nothing, the operator sees no change, and they go looking. A contradicted setting does *something
else* — and the something else is invisible, because nobody checks for a consequence they did not
ask about.

### What the flag actually did

`apps/daemon/src/core/generate/networkd.ts` branched on the *kind* of uplink after branching on the
flag. The wired arm read the flag; the wireless arm had no static branch at all and fell through to
one that wrote `DHCP=ipv4` whatever the flag said. So turning automatic addressing **off** on a
wireless uplink did not produce a static address.

What it produced instead is the part worth naming. The failover metric —
`RouteMetric=100 + priority`, the line that carries the profile's stated failover order into the
kernel's routing table — lived inside the `[DHCPv4]` block, which is exactly the block the flag
suppresses. The wireless fall-through wrote neither the static block nor the DHCP one, so **the
metric was dropped**. An operator who turned off a setting named *get the address automatically* got:
no static address, automatic addressing anyway, and **their uplink's failover priority silently
disabled**. Nothing reported any of the three.

The failover priority is not addressing. That it moved with addressing is a second defect hiding
inside the first, and a fix that only corrected the addressing would have left it — which is why the
test asserts the metric explicitly rather than the addressing alone. A test that checked only
`DHCP=no` and `Address=` passes with the metric still lost.

### The comment that kept anyone from looking

Underneath it, a third, and it is the one that could leave a device unable to reach anything.

`packages/schemas/src/profile.ts` carried this beside the wired uplink's address field:

> Used only when `dhcp` is false. Both must then be present; the invariant checks say so.

**No such invariant existed.** The address and gateway were read by the generator and by nothing
else. So a **wired** uplink with the flag off and no address was a valid profile that activated
cleanly and generated an interface with `DHCP=no`, no address and no route — a link that comes up,
reports carrier, and can reach nothing. The state was reachable from the interface, from the API and
from an imported profile, and the device's own answer to *is this configuration sound* was yes.

**A comment claiming a check exists is worse than no comment, because it stops the next reader
looking.** A reader who wonders whether the pair is enforced, reads that line, and moves on has been
told the answer by the file itself. This one survived for months on exactly that. Its replacement
names the check by code, so the claim can be searched for and found — or found missing.

### What was done

* The three addressing fields — address, gateway, resolvers — are defined once and shared by both
  kinds of uplink. Nothing about a radio makes a static address meaningless: once the supplicant has
  associated, the network layer sees one interface and knows nothing about how it joined. The two
  kinds differ in how they *join* a network, not in how one is addressed, and two copies of the
  addressing fields would drift — they already had, with the wireless copy simply absent.
* `uplink_static_without_address` and `uplink_static_without_gateway` exist, as errors. Both states
  have a consequence and neither has a working reading: no address is an interface that is inert, and
  an address with no gateway is an interface that reaches its own subnet and nothing beyond it. The
  second is the one it would be tempting to make a warning, and that is backwards — it half-works, so
  the failure looks like anything but addressing.
* The generator reads the flag once, from the same module that enforces it, and writes the same
  static block for both kinds. The `[Route]` section carrying the metric is written whether or not a
  gateway was given: **a route section that appears only alongside a gateway is a metric that
  disappears with a field nobody connected to failover** — the same defect again, one field over.

### Proof, and what a green suite was worth before it

The daemon suite was 673 green before any of this and **673 green after all three fixes**. Nothing in
it exercised a statically addressed uplink of either kind, so the generator rewrite, the new check
and the schema change turned nothing red. That number is the measurement: the suite had no opinion
about the whole feature.

Nine tests now do, and each fix was proved by mutation on 2026-09-21, with the anchor asserted before
every mutation — a fixture that silently fails to be what the test thinks it is reports exactly what a
working guard reports:

* restoring the wireless fall-through (`DHCP=ipv4` regardless of the flag): **3 red**;
* removing the new check from `checkInvariants`: **3 red**;
* emitting `[Route]` only when a gateway is present — addressing correct, metric lost: **1 red**,
  and it is the test that exists for it;
* removing the three fields from the wireless config again: **1 red**, on the schema check.

Asked of the new check as well, because the question keeps paying: **what does it report when given
nothing?** No uplinks: nothing. An uplink with no addressing stated at all: nothing, and for the
right reason — absent means the schema's `default: true`, which is automatic addressing, which needs
no address. Both kinds spell that default differently and are asked separately. An uplink that is
switched off: nothing, because refusing activation over the configuration of something switched off
makes the switch useless.

### The register question this belongs to

**What does this setting actually change, and is it what its name says?** Three questions, not one,
and the middle one is the one that gets skipped: *does it change anything*, *does it change what it
says*, and *does it change anything else*. This project has now found a setting that changed nothing,
several fields that were produced and never read, and — here — a setting that changed something it
was never about. Only the first of those is visible to an operator who tries it.

## Two lists that could not be built, and a server that would not start (2026-09-21)

The candidate list was carried on every resolution and reachable only through the plan of the
**active** profile — a plan review, not available at all while editing the binding of any other
profile, which is the moment the chooser is needed. It now answers on `GET /api/inventory`, which is
where a question about hardware belongs.

Two lists under one key, `radios` and `interfaces`, rather than one merged list. A merged list would
be answerable only by a client deciding which entries are radios, and the kernel makes that easy to
get wrong — it reports a radio with the same link type as a wired port. That classification is the
thing this contract exists to keep on the device. With two lists, an empty `radios` beside a
non-empty `interfaces` is an answer *about radios* rather than about the inventory.

The key is optional, and **absent is not `[]`**: absent means nobody looked, an empty list means this
device was asked and has no hardware of that kind. Same distinction as `channels`, `refused`,
`withheld` and `becauseOf`; fifth time it has been landed, same shape each time.

### The trap, which stops the daemon rather than spoiling a reply

Writing the response schema found one that no amount of checking an object would show. **A schema
carrying an `$id` that is embedded twice inside one route's response makes Fastify refuse to compile
the serializer**, throwing during route registration: *reference "HardwareBinding" resolves to more
than one schema*. That is a daemon that does not start. It appeared here because the candidate list
is carried twice — once per kind of hardware — so the `HardwareBinding` inside it is embedded twice.

The fix is to embed the selector with its `$id` stripped, derived from the one definition rather than
restated, since serialisation is the only use and validation keeps the identified schema. Both
identified schemas involved were given the same treatment for the same reason.

It was caught only by asking the route through `app.inject`. This is the same family as the trap
already recorded here — a response schema is a **serializer**, and a key it does not declare is
dropped from the reply in silence — and the two together are the argument for testing a wire through
the wire: one failure mode is a field that vanishes without a word, and the other is a server that
never comes up. Neither is visible from the object the handler returns.

Both are pinned by mutation, 2026-09-21: dropping `candidates` from `InventoryResponse` turns the
route test red; deleting one field from the candidate schema turns the parity test red, naming the
field that would have been dropped. That parity is asserted in both directions, because each names a
different defect — a field a candidate carries and the schema does not is stripped from the reply,
and a field the schema declares that no candidate produces is a promise to a screen that nothing
keeps.

## The longest value in the fixture was not the hardest one (2026-09-21)

The 360 px bench is run against "the longest realistic value in each field", and the profile-name constant
is 64 characters, which is the schema's ceiling. It reads
`Amsterdam egress, evening failover, do not xxxxxxxxxxxxxxxxxxxxx` — and it has **spaces in it**.

A new notice naming the profile being edited was benched against that constant and measured clean. It was
also wrong. Re-benched against the same 64 characters with every space and hyphen replaced, the page went
to **504 px wide at a 360 px viewport** and the check named the element. Nothing about the first run said
the second was waiting.

**A length ceiling is not the worst case for a layout; a break-opportunity count is.** Two values of
identical length lay out completely differently, and the fixture had been carrying the forgiving one. The
fixture's own comments already knew this about *other* fields — the second profile is deliberately named
`amsterdam-evening-failover-with-cloak-and-subscription` because "a name with no spaces in it is what a
layout engine cannot break anywhere" — and the constant that is described as the longest name had never
been held to it.

The bench block now builds its own unbreakable name rather than reusing the constant, and says why. The
general form, for the next field: **when a field's failure mode is width, the fixture needs the longest
value *and* the least breakable one, and they are usually not the same string.**

## A shared renderer writes the wrong type, three times now (2026-09-21)

This is the third instance of one shape, and it is worth naming as a shape rather than as three
coincidences.

| shared renderer | what the DOM gives it | what the schema wanted | how it was caught |
| --- | --- | --- | --- |
| `BooleanChoiceField` over `RadioChoice` | a radio's `value`, always a string | a boolean | mutation test, earlier |
| `NumberList` over `TextList` | a textarea's `value`, always a string | an array of integers | mutation test, here |
| `SelectField`'s no-answer option | a select's `value`, always a string | `null`, or an absent key | mutation test, here |

The rule that produces all three: **every value the DOM hands back is a string, and a renderer shared
across types is a renderer that will hand a string to a position that does not take one.** The result is
the worst class of configuration defect — a document that looks right in the panel, is written into the
draft without complaint, and is refused on save with a message about a field the reader did not think they
had touched.

Two details worth keeping.

**Dropping is better than coercing.** `NumberList` drops a line that is not a whole number rather than
writing `NaN`. `NaN` validates as nothing, serialises to `null`, and lands in a field that then reads as
*no ports* — which blocks the address on **every** port rather than on none. The mutation that keeps the
unparseable entries produces `[443, NaN, 8443]`, which is a strictly more dangerous document than the one
the operator was trying to write.

**`""` is not "no answer".** The reflex empty `<option>` writes an empty string into a union that has no
empty string in it. And the two spellings of absence are not interchangeable: a field declared as a union
containing `Type.Null()` wants `null`, and a `Type.Optional` field wants the key gone. The control now
carries which one to write instead of guessing, and the test asserts `'band' in config` rather than
falsiness — because a written `null` and an absent key are the same falsy reading, and a test written
against truthiness passes on the defect it exists to catch.

## A bench that mounts every screen at once cannot hold two selections (2026-09-21)

The 360 px bench mounts all seven screens into one page, which is what makes it cheap. E6b added a state
that is **not a property of a screen**: which profile the editing screens are pointed at, held in a
module-level store so it survives navigation.

That state cannot be set for one block and not another on a page that mounts every block simultaneously.
Choosing a non-active profile for the bench would have put every screen into the Save-only state and taken
the Review button out of the measurement; leaving it alone would have left the new notice unmeasured
entirely — and unmeasured is how `PlanReview` and `ConfirmationWindow` went unmeasured for as long as they
did, because "every screen, every form" does not reach something that renders only in a state the bench
never enters.

The resolution was to make the notice **one component used by both places it appears**, and to mount that
component directly in a block of its own. That is not a workaround dressed up: two copies of this
particular sentence would drift in the worst available direction — a shell that stops warning while the
bar still refuses to apply reads as a broken button rather than as a profile that is not running.

The limitation is recorded rather than hidden, because the next module-level state added to this interface
will hit it: **a bench page that mounts everything at once can only measure one value of a global.** A
state that has two interesting values needs either a second bench page or a component small enough to
mount twice with different props.

## What the parity fault list could not tell apart, and the order that resolves it (2026-09-21)

The interface half of the parity check reports one sentence for three different defects: *this position is
reachable from the API and from no screen*. The twenty-seven it named were two unstamped controls, seven
absent controls, and twenty-four absent sections — and one other kind, found the day before: a control that
exists, is correct, and is drawn only for a branch the fixture does not contain.

The check cannot separate them, and the reverse of the obvious procedure is what does:

> **Put the value in the fixture and look again, before building the control the check seems to be asking
> for.**

Done for all thirty-three positions in this pass. Seven and twenty-four survived it and were genuinely
missing; the two unstamped ones survived it and needed a pointer rather than a control. Had any been the
fourth kind, it would have vanished from the fault list with no code written at all — which is exactly what
happened to `/routing/rules/-/sets` the day before, where one rule of the missing kind made the pointer
reappear in the DOM, the manifest and the layout measurement at once.

The cost of doing it in the other order is a **duplicate** control: a second editor for a field that
already had one, passing every check, and indistinguishable afterwards from a field that needed two.

## Where the uplink addressing fixes actually landed

`29181db` is titled for a layout finding and contains, unannounced, the whole of the uplink
addressing work: the missing invariant, the shared static-addressing fields, the generator no longer
contradicting the flag, and the binding candidates reaching the inventory route.

The coordinator staged everything in the tree rather than the interface stream's files, and two
streams had finished within a minute of each other. A commit message cannot be edited, so the record
goes here: somebody reading the history for when the addressing check appeared will find it under a
title about the width of a profile name.

Worth keeping for the same reason the "ten positions" correction is: **the history is a record only
as far as it is true**, and a mixed commit is not a tidiness problem — it is a search that will fail
for the next person, silently, in the direction of concluding the work was never done.

## An address that answers is not evidence that the right host answered

Two minutes before deploying the largest change this project has made, the board stopped responding.
Ping to both of its addresses: total loss. And `ssh` to its management address returned

    Connection closed by 192.168.77.7 port 22

which is not a timeout and not a refusal. Something accepted the connection and dropped it before a
banner — the textbook symptom of a host whose filesystem is full, where `sshd` accepts and then
cannot create a session. This repository even carries a superblock decoder written for that exact
diagnosis on this exact board.

**The board was healthy.** Four tunnels up, the panel answering on all four channels, ten hours of
uptime.

What had changed was the workstation. It had joined the device's own access point, so it was no
longer on the network those addresses belong to — and its default route belongs to a VPN client, so
`192.168.77.7` was carried into somebody else's network, where a stranger's `sshd` answered and
closed the connection.

So the evidence was real, the symptom was real, the decoder was ready, and the conclusion would have
been about the wrong machine entirely.

### The rule

**An address is not a host.** It is a host only relative to a routing table, and the routing table
belongs to the machine asking, not to the machine being asked. Before diagnosing a device from its
silence, establish that the question reached it: check which interface the question left by, and
prefer an address the answer cannot be borrowed from.

The near-miss has a shape this catalogue already knows — a measurement that is correct about the
wrong subject. It has appeared as a stand-in that was not the thing, as a probe through a path the
real traffic does not take, and as a reading taken from the device rather than from a forwarded
client. This is the same error with the subject one layer further out: not the wrong path to the
right host, but the right path to a different one.

### And the deployment rule it enforces

Do not deploy over the link the deployment might break. The wired lifeline exists for this and is
deliberately touched by no plan; a deployment driven over the device's own access point is a
deployment whose rollback path is the thing being changed.

## A clean tree before the build is not evidence the tree was clean during it (2026-09-21)

Two agents shared one checkout. One was running mutation tests on the parity check — the correct
discipline: delete a field, assert the check goes red, restore. Each mutation lived for seconds. The
other was deploying, and `scripts/deploy.sh` builds from the **working tree**, not from a commit.

The first deploy shipped a mutated interface. The board carried `index-BBxAtaVo.js`; a rebuild at the
same `HEAD` with `git status --porcelain` empty on **both** sides of the build produced
`index-CBfvlnc0.js`. The difference was one occurrence of `psk` — four on the board against five in
the clean build — and `/uplinks/-/config/psk` is a pointer the parity manifest declares. The deploy
reported success. The parity check was green before the build and green after it.

The shape is not "someone edited a file during a build". It is that **a reading taken beside an
operation is not a reading taken during it**. This catalogue already holds the same error about
liveness — a config file read in place of a health check — and about reachability, where an address
that answers is not evidence the right host answered. Here the subject is time rather than identity:
the observation and the thing observed did not overlap.

What it costs to defend against is small, and it is now the rule: read `git status --porcelain` and
`git rev-parse HEAD` on **both** sides of the build; compare the artefact's hash on the device
against a rebuild from the recorded commit; and once verified, redeploy with `--no-build` so the
bytes that ship are the bytes that were checked. A deploy that builds and ships in one step has no
moment at which the artefact can be examined.

The general form, which is why this belongs here rather than in the deployment document: **a shared
working tree is shared mutable state, and every discipline this project applies to shared mutable
state applies to it.** Two agents were told not to modify each other's files, and neither did. The
collision was not over a file; it was over the tree as a whole, at an instant.

## `deploy.sh` installs a binary; it never applies a profile (2026-09-21)

Measured on the bench board while deploying Epic E. After a successful deploy — new build live,
health endpoint answering, profile migrated to `schemaVersion` 7 — the data plane was still running
the **previously applied plan**: the five Cloak transports under their old instance names, on their
old ports, from the old unit files.

Nothing in the deploy is at fault, and nothing in the daemon is either. The daemon deliberately does
not reconcile at boot: the only `applyDocument` on the start-up path belongs to the resolver watcher,
and boot otherwise sweeps unconfirmed transactions and rehydrates telemetry from the *stored last
plan*. `POST /api/profiles/:id/activate` returns `{nextStep: 'POST /api/apply'}` without applying.
That is the correct design — a device that re-derives its whole data plane every time it is
restarted is a device whose network changes when the power flickers, and this board has no RTC
battery and reboots more often than most.

The defect was in the **plan**, which described renamed units appearing after the deploy. They cannot.
Between the deploy and the apply the device runs a new control plane against a migrated document
while the old plan still carries traffic, and that intermediate state is stable, legitimate, and
invisible to every check that asks whether the daemon is healthy.

Two consequences, both now rules. A deployment plan that expects any change to units, files or routes
must contain an **explicit `POST /api/apply`** as a numbered step, with its confirmation window
budgeted. And verification written to run "after the deploy" must say which of the two it means: the
binary is live immediately, the plan is not live until someone applies it.

The shape is one this catalogue keeps meeting from new directions: **a step that was believed to
happen as a side effect of another step.** It has appeared as an enable that never ran because a
sequence assumed it, and as a mechanism wired to a gate it could never pass. Here nothing was wired
wrongly at all — the step was simply never written down, and the plan read as though it had been.

## An annotation is not the thing it annotates (2026-09-21)

The parity check read `data-pointer` off the rendered DOM and concluded that a person could fill the
field. It measured that somebody had written the marker.

Substituting the Wi-Fi passphrase control for a `<div>` carrying the same `data-pointer` and a
`<span>` holding its label left six files and 113 tests green — the parity comparison among them —
with a credential the daemon refuses to activate a profile without rendered as **inert text**.
Deleting the same block failed loudly and by name.

That asymmetry is the shape: **the check failed on the mutation nobody would commit and passed on
the one anybody would.** A deletion is what a careless hand does; a control quietly becoming a label
is what a refactor does.

The cure is to stop reading the claim and start exercising the behaviour — tap the control, compare
the document — because a second annotation saying "this really is a control" is the first one again
with more words. The cost of exercising it is part of the shape too, and it was found by getting it
wrong: the first attempt tapped any button inside a block with no control, and the buttons inside a
container are *Remove*. Twenty-seven required positions left the draft and the check cheerfully
reported an interface that edits almost nothing.

## A guard that writes what it is about to read disarms itself on the second run (2026-09-21)

The coverage manifest was written from the rendered DOM and then compared against what had been read
a moment earlier. Delete a field and run 1 fails twice; run 2, with no code change, fails once,
because run 1 rewrote the file. For any pointer a second check did not separately require, it was
green from then on — and green on the **first** run of a fresh checkout, once the rewritten file was
committed.

The reason for writing first was sound: the diff belongs in the working tree where somebody can read
it. That is satisfied by writing *beside* the committed file rather than over it. Then every run
reproduces the failure, and accepting a change becomes an act somebody performs.

## A default meaning "assume everything" turns a missing wire into silence (2026-09-21)

`checkInvariants` takes an optional `core`. Absent means `known: false`, which every catalogue entry
must read as *everything is offered* — correct, and deliberately so: a missing binary must not block
configuration that has nothing to do with it.

`pipeline.ts` computed the capabilities for `emitTunnels` and **omitted the field from the
`computePlan` call directly below it**. Every production plan therefore ran with capabilities
unknown, and `protocol_unavailable` / `binary_missing` could not fire once. There was no anomaly to
notice, because where absence is defined as the permissive answer, the only possible symptom is a
check that never fires.

Every availability test called `checkInvariants` directly with an explicit `core`, so nothing ever
went through the caller. **A test that bypasses the wiring cannot see that the wiring is missing.**

Register question: *for every optional input whose absence is the permissive answer, does at least
one test reach it through the caller that is supposed to supply it?*

## A whole-document refusal on a path that iterates is an outage (2026-09-21)

`migrateToCatalogue` refuses a document it cannot translate, whole, with no partial result. That
design is right and is documented as such. Migration is lazy-on-read, so the refusal came out of
`toRow` — which `list()` calls once per row.

One legacy tunnel therefore made `GET /api/profiles` answer 500 for **every profile on the device**,
and the operator could not learn which id was at fault, because `delete` was the only path that did
not read a document. Not corruption, either: v6 allowed an open-string `provider`, so this is
ordinary state written by the previous epic.

The shape: **a whole-object refusal is safe only while the thing raising it is the whole request.**
When a refusal moves onto a path that iterates it needs an identity and a per-item catch, or it stops
being a refusal and becomes an outage. Lazy migration is exactly the mechanism that moves it there
without anyone deciding to.

## A field named for a promise, computed from a proxy (2026-09-21)

`activatable` answered `missingSecrets.length === 0` under a name that says *this will run*. The two
agreed for as long as no document could be stored that the planner would refuse — and the moment the
write path turned out to accept protocols outside the catalogue, an import of a WireGuard profile
replied `201 {"activatable": true}` about a profile the planner rejects at
`/tunnels/0/protocol`.

**A name is a claim.** When the computation behind it is not that claim, the result is a false
statement with a `true` in it, which is worse than no field: a caller who checks it is more confident
than a caller who does not. Distinct from the proxy-measurement question already in this register —
that is a number standing in for a quantity; this is a *word* asserting something nothing checked.

### And the recurrence that came with it

A length ceiling is not the worst case for a layout — a break count is. That was recorded here on the
morning of the same day from a fixture; it is now measured from the rendered page, and the numbers
are worse than the shape suggested. At 360 px, with **no overflow anywhere** and every target over
44 px, 299 runs of text painted four line boxes or more; the worst was a 389-character row title laid
out as **sixteen lines in a 222 px box**. A box that wraps is a box that fits, so every width
assertion reported ok.

Two corollaries, both found by getting them wrong first. A **clipped** line box was not painted, and
counting it made the remedy measure worse than the defect — a clamped title reported twenty-one lines
from a box showing three. And a height measured after a bench has opened every fold is a height
nobody has: it must be taken in the state a person arrives in.

## A requirement the inventory never looks for is reported missing for ever — second occurrence (2026-09-21)

Measured on the bench board, build `b40ad4a`: `/api/inventory` listed eleven binaries, none of them
`ck-client`, and `/api/plan` answered `usable: false` with an error-severity `binary_missing` at
`/tunnels/0/protocol` — *"ck-client is not installed"* — on a device where `/usr/local/bin/ck-client`
was executable and **carrying five live transports at that moment**. Because the finding is severity
`error`, `planner.ts` set `usable: false` and `apply.ts` refused with 422 before opening a
transaction. The profile could not be applied at all.

The safety machinery behaved correctly throughout: it refused rather than applying half of something.
The defect was upstream of it.

This is the same shape already recorded here for `systemd-run`, and **it recurred in the very file
whose comment records that lesson** — because the guard had been written in one direction only. Every
binary *probed* had to have a stated remedy. Every binary a *capability* required had to be probed.
Nothing asserted the same of a *catalogue entry's* requirement, and the catalogue is where the three
protocols state what they need.

It only became visible today. Until `pipeline.ts` began passing `core` to `computePlan` — a fix made
this morning — the availability invariants could never fire at all. **Repairing the wiring exposed a
defect that had been latent behind it**, which is the expected consequence of making a check able to
fire, and the reason a check that has never once fired should be treated as unproven rather than as
evidence of health.

The fix is one line in `BINARIES` plus a guard that walks `CATALOGUE_LIST`, asks each entry's
`availability` on a device with nothing installed, and asserts every binary it names is probed. Both
sides are derived from the catalogue: a hand-written list of names would have been a third copy, and
a copy is what drifted. The list is exported for this, rather than scraped out of the source text as
the two older guards do.

Adding `ck-client` to the probe list then turned the **existing** remedy guard red — "looked for but
has no remedy" — which was the correct second answer rather than an obstacle. The capability report
would otherwise have named a missing binary with nothing a person could do about it. `ck-client` is a
release binary, not a package, and now says so. That is the pair of guards working as a pair.

## The guard was derived from the catalogue, and the generator was never asked (2026-09-21)

Found by the re-acceptance pass, hours after the `ck-client` fix, and it is the same shape one layer
further down.

`platform/binaries.ts` searches five directories — `/usr/bin`, `/usr/sbin`, `/usr/local/bin`,
`/usr/local/sbin`, `/opt/bin` — and reports a binary as `present` from wherever it lands. That is
right, and it is why `ck-client` at `/usr/local/bin` is now correctly found. But
`core/generate/units.ts` writes `ExecStart` with **hardcoded absolute paths**: `/usr/sbin/openvpn`,
`/usr/sbin/hostapd`, `/usr/sbin/wpa_supplicant`, `/usr/sbin/dnsmasq`. The proxy core, `nft` and `ip`
already use the discovered path; these four were missed.

So a binary installed in `/usr/local/bin` passes discovery, passes the availability invariant, passes
the new catalogue-requirement guard — and produces a unit whose `ExecStart` does not exist. Every
check answers yes and the unit cannot start.

The morning's fix added a guard derived from `CATALOGUE_LIST`, which was the right direction for the
defect in front of it. **Nothing derives a guard from the generator**, and the generator is the last
place a binary is named before systemd tries to run it. Two guards now cover "probed without a
remedy" and "required without being probed"; the third direction — *named in a unit without being the
path that was found* — is still open, and is recorded as F3.

Neighbouring, from the same reading: no generated unit sets `Environment=PATH`, so the transport and
SOCKS shell scripts (`exec ck-client …`, `exec xray …`) depend on systemd's default `PATH`, which
nothing in this project asserts. And `/usr/bin/systemctl` and `/usr/bin/systemd-notify` in the
platform layer are neither probed nor remedied.

Not live on the bench board, where `openvpn` is in `/usr/sbin`. That is luck, not design, and the
distinction is the reason this is written down rather than closed.

### Two corrections to entries above, from the same pass

**The profile-list outage now surfaces as 409, not 500.** The entry recording it describes a bare
500. With the fault typed and mapped at the seam, removing the per-row catch again gives a 409 that
names the profile — still whole-request, so the defect is unchanged in kind, but a reader comparing
the catalogue against a reproduction should expect the newer code.

**"103 labels" is 103 distinct strings, not 103 rendered labels.** The 360 px bench deduplicates by
text. Mutating one of two identical `Network name` labels moved the total to 104, which is how this
was found. The check still catches a long label; what it does not support is reading the number as
coverage. A long label that happened to repeat an existing short one would be counted once — the
same shape as the count that was blind to a substitution of equal size, already in this register.

## A measurement is only valid for as long as the thing measured stays put (2026-09-22)

Three times in one investigation a conclusion was drawn about a board whose state had changed between
the change and the reading, and each time the conclusion was confidently wrong.

What happened. A rule was added to the core's routing and read back out of the file — present. A
client test minutes later showed no effect, and two mechanisms were proposed to explain it, each
disproved by a further experiment. Only on reading the transaction table did the actual sequence
appear: the change committed at 04:35:22Z, an unrelated transaction opened at 04:40:18Z and reverted
at 04:41:08Z, and the rule went with it. Every measurement after 04:41 was taken on a board with no
rule. The second attempt repeated it exactly — applied 05:06:28Z, reverted 05:07:18Z — so the
re-test was invalid too, and the question it was asked to settle is **still open**.

The shape is not "the board changed". It is that **nothing in the reading said when it was taken, and
nothing in the board said when it last changed.** A configuration file's presence answers "is it there
now", and the answer expires without notice. This register already holds the same error about time
from the other direction — a clean tree observed on either side of a build is not a clean tree during
it — and about subject — an address that answers is not evidence the right host answered. This is the
third face: a correct reading of a state that no longer holds.

Two disciplines follow, and they are cheap.

**Bracket a behavioural test with a re-read of the thing it depends on.** Not before it: *after* it,
and compared. If the rule was present before and absent after, the test measured nothing, and that is
a result worth having rather than a mystery to theorise about.

**When an explanation fails, suspect the premise before inventing a second mechanism.** Two plausible
mechanisms were designed and tested here while the premise — that the rule was in force — was never
rechecked. A theory built to explain a measurement is worth less than one more look at whether the
measurement holds.

### And the design defect it uncovered, which is the more serious half

The revert was not wrong to exist. What is wrong is that a committed change vanished and **no event,
finding or screen said so**: the stored profile still held the six entries, the running configuration
held none, and the only way to learn it was to read both by hand. Recorded as `G1` and `G4` in
`docs/13-plan.md`. A safeguard that can undo a person's committed work silently is not a safeguard
with a rough edge; it is a safeguard that has to be told to speak.

## What wakes this mechanism, and in which ordinary states will nothing ever wake it? (2026-09-22)

The captured-resolver mechanism failed a second time and the cause had moved. Measured on the bench
board: `/run/wayfarer/tunnel/hq.dns` held `10.184.100.5`, `/etc/wayfarer/core/config.json` named
`10.184.40.5`, `wplan.hq.lan` resolved for nobody on the network, and `resolver.reconverged` had
been recorded twice while that file's mtime never moved. The tunnel was healthy throughout.

**The fix of the day before held.** Re-planning by hand — with the stale value deliberately left in
the profile — produced a configuration carrying the *captured* address, and the classification of
that difference is `service`, which a narrowed apply writes. Capture, planner, classification and
apply all worked. **Nothing asked them.**

Two ways the trigger could never fire. Both are ordinary life, not edge cases.

**A retry that was only ever claimed.** `/run/wayfarer/tunnel` is created by `tunnel-up` when a tunnel
first connects. `/run` is empty at boot and the daemon starts before any tunnel, so at the moment the
watch is attempted the directory is normally absent, `fs.watch` throws, and the function returned
`null`. The daemon recorded once that it was not watching and never looked again for the life of the
process. The comment at the call site said the watch is retried once the stack is up. It was not: the
handle was assigned to a variable nobody read a second time. **A comment is not a mechanism** — this
register's fourth instance of that sentence — and it adds a sibling to the question about unobserved
predicates: *is the thing this handle represents ever consulted again?*

**A watcher is blind to what happened before it existed.** A capture written while the daemon is
restarting — every deploy, every upgrade, every reboot — delivers no event, ever, and nothing compared
capture with configuration at start-up. That is precisely the state found in the morning: a capture
hours older than a configuration nobody had regenerated.

This second hypothesis was raised on 2026-09-21, correctly ruled out *for that incident* on the
evidence that the watcher had fired six times, and then filed as wrong. It was not wrong. It was not
yet the cause. **Ruling a hypothesis out for one occurrence does not retire it**, and a register of
discarded explanations is worth keeping for exactly this reason.

### The class, which is one step earlier than the entry above it

The first occurrence asked *what does this guard do on the exact event the thing it guards exists
for?* This one asks: **what wakes this mechanism, and what are the ordinary states of the system in
which nothing ever will?** Boot order was one. A restart was the other. In neither was the mechanism
broken — it was unasked.

### And the third writing-down of the same half

`resolver.reconverged` was concluded from the **absence of refusals**. An apply that refuses nothing
and writes nothing is indistinguishable, from its outcome alone, from one that worked. Success is now
read back out of `config.json` and compared with the capture, tunnel by tunnel; where no comparison
was possible the event is `resolver.reconverge-unverified`, because *nobody checked* is not *it
worked*.

The convergence check reports in **both** directions — naming the resolvers in use when they agree,
not only when they differ — because a mechanism that is silent while it agrees cannot be told apart
from one that is not running. That is the same reason this whole epic exists.

## A comment that argued the gap was covered, and the indicator it named (2026-09-22)

`core/apply.ts` explained why the active-profile pointer is not moved back after an undo, and closed
with: *"the interface honestly shows pending changes: what is stored is not what is running."*

That sentence stood for months, and it is the reason nobody built the comparison.

It was wrong twice over. The indicator it meant is `apps/ui/src/lib/draft.ts`, which diffs a **draft
being edited** against the stored document — it is about unsaved work and says nothing whatever about
the files on disk. And after an undo there is no draft, so in the one case the comment was written to
excuse, it shows nothing at all.

Measured the day it was found: six entries in `profile.firewall.blockedEndpoints`, none in
`/etc/wayfarer/core/config.json`, discoverable only by reading the file and the database by hand.

The shape, and it is new here: **an assertion that a gap is covered is itself a claim, and it was
never checked against the mechanism it named.** This register already holds *an annotation is not the
thing it annotates*, about a `data-pointer` on a `<div>` that a person could not fill. This is the
same error written in prose, where nothing can fail and no test can reach it. A comment saying some
other thing handles a case **names** that other thing, and the naming is the part to verify;
otherwise it is a check with no input, and the only symptom is a question nobody asks a second time.

Corrected in place rather than deleted, because the reasoning it hid — why the active-profile pointer
stays put — is worth keeping and remains true.

### What was built instead, and the one decision inside it

A comparison that re-derives the **stored** profile and measures it against what is actually on disk
and in systemd, at boot, after every undo, and every fifteen minutes. It reports and does not repair,
and that was the deliberate choice: a device that quietly re-applies is how a change nobody ordered
happens, which this board has now done twice in a week; repair would also destroy the evidence on a
fifteen-minute cadence, and it would be the one apply on the device with no confirmation window.

It reports in **both** directions — naming what it compared when everything agrees, not only when
something differs. A mechanism that is silent while it agrees cannot be told apart from one that is
not running, which is the mistake this entry is about, one layer up.

Two consequences accepted rather than hidden. After an undo the device is *expected* to diverge, so
the check is legitimately red until somebody re-applies; that is handled by recording on change, not
by softening the verdict. And no severity is split between "somebody's unapplied edit" and "nobody
ordered this", because both are literally *not running the stored profile*, and separating them would
mean guessing intent — which would have made the flagship case the quiet one.

### A shared cache file gives a lower bound on age, and the first version said the opposite (2026-09-22)

`experimental.cache_file` holds every remote rule set the core fetches. Its modification time is
therefore the instant of the **most recent** write by **any** of them, so each individual set was last
refreshed at or before it and its true age is **at least** `now − mtime`. Measured: two remote sets
sharing a cache written an hour ago, one of them genuinely thirty days stale — both reported
`fresh, 3600s`. **One set refreshing keeps every other set in the cache looking healthy**, which is the
silent-stale-list failure the check was built to catch, alive inside the check for it.

The code shipped with the reverse written into it, in four places, in the confident form: *"it can only
overstate an age and never understate one — the direction that fails safe."* The user-facing sentence
said the right thing at the same time (*"at most this fresh"*), so the product contradicted its own
documentation and nothing noticed, because every test asserted a **number** and the inversion lived in
the **words**.

Two general points. **When a figure is a bound, write down which way it errs and what an answer at each
end is worth** — here a red verdict is always true and a green one only means "nothing here proves
otherwise", and that asymmetry is the entire reason a bound is worth comparing at all. And **a claim
about the direction of an error is a claim, so it needs an assertion**: the test that now holds it checks
the sentence a person reads, not the integer.

### Checking the clock at reading time says nothing about the clock at writing time (2026-09-22)

An age computed from a file's modification time was gated on `NTPSynchronized`, which closes only half
the class on a board with no RTC battery. The board boots to a fallback time, something writes the file
and stamps it with that, NTP then steps the clock forward, and the age is computed across the jump.
Measured: `mtime` 0 with the clock synchronised produced *"last refreshed 11574d ago"* and a red finding
naming a set that had been refreshed minutes earlier — the kind of false alarm that is somebody's first
meeting with a feature.

One rule closes it with no second clock: **a file cannot predate the software that wrote it.** A
timestamp below this build's own instant is clock damage rather than age, and yields no number. Its cost
is real and belongs in the same sentence: an upgrade moves the floor forward, so a genuinely old file
reads as unmeasurable until it is rewritten — a *lost* finding and never a false one, which is the same
direction the rest of the mechanism already fails in.

Add to the questions this catalogue asks of any duration built from a stored instant: **was the clock
trustworthy when the instant was recorded**, and not only when it is read?

### `.catch(() => null)` on a reader that distinguishes "absent" from "failed" throws the distinction away (2026-09-22)

`fileModifiedMs` returns `null` for `ENOENT` and throws for every other error — deliberately, so a caller
can tell *there is no file* from *I could not look*. The caller wrote `.catch(() => null)` and collapsed
the two, and the result was a report saying *"never fetched onto this device, so the rules that point at
it match nothing"* about a file that was sitting right there, with a hint sending the operator to check a
network when the fault was a permission on the device.

The same file argued the opposite rule two paragraphs above, about the clock: `null` is a third answer and
not a quiet `false`. **A codebase can hold the right rule and the wrong code within thirty lines of each
other**, and the thing that separates them is whether a test exercises the failing read. The wrong
instruction is the expensive half: a hint is followed, so a confidently wrong one costs more than no hint
at all.

### A test that derives its expectation from the constant it is meant to pin agrees with any value (2026-09-22)

The staleness threshold is `updateIntervalHours × MISSED_REFRESHES`. Its test computed the window from
`MISSED_REFRESHES` and built its failure-message regex from it too, so mutating `3 → 1` killed **zero
tests in the repository**: the test simply agreed with the new policy. It read as a thorough test — both
branches, a boundary, a message check — and pinned nothing.

The bracket has to be literal: *a daily list is overdue after 73 hours and not after 71*, and the same at
a second cadence so the policy is still pinned as a multiple rather than as one duration that happens to
fit. Add to the catalogue's questions: **for any constant that encodes a policy, does a test name a number
the constant does not?**

### A finding that carries both values carries the credential too (2026-09-22)

The drift check names the two sides of every divergence — the whole reason it replaces reading a file by
hand — and its findings are served by `GET /api/drift`, drawn on a screen and written into the
**persisted** event ring. The generated core configuration holds real credentials in clear by necessity,
so a divergence at a proxy's `password` or a VLESS account's `uuid` published it to all three and wrote it
to disk in a table nothing redacts.

The generator's own comment said this file was *"never logged, never returned by an API route, and never
rendered in a diff"*, and it had been rendered in a diff since the drift check landed. **A comment
asserting a safety property that nothing checks is how the property gets lost**: the comment survives the
change that breaks it, and it is what the next reader trusts.

Two things made the repair durable rather than local. The values are withheld **at the pointer** and
nowhere else, so the check keeps naming ordinary values and stays useful. And the list of
credential-bearing key names is checked **from the other end**: every catalogue entry is planned with a
sentinel in each marked field, and a sentinel appearing under a key the withholder does not recognise
fails the build — because no mechanical link joins a profile's `x-secret` marks to the names a catalogue
entry hands the core, and `auth.password → password` beside `id → uuid` is exactly the renaming a
schema-derived list would miss.

### Hiding a field does not remove it, and the screen produced the refusal it was written to avoid (2026-09-22)

The proxy editor draws two TLS fields for HTTPS and for nothing else, and the daemon refuses a
configuration that sets either on a proxy with no handshake — deliberately, because dropping a stated
field silently is the failure this product has a catalogue of. Filling one in and then switching the type
to SOCKS hid the control and **left the value in the draft**, so the plan was refused pointing at a
position with no control on any screen: the least clearable error a product can have.

The entry's own header said that reaching that refusal meant a document had arrived through the API rather
than the interface. It said so while the interface was the thing producing it. **An explanation of why a
branch is unreachable is worth exactly as much as the check that it is**, and there was none.

The rule that falls out: **whatever draws a field conditionally owns clearing it**, and the clearing is an
ordinary write into the same pending change, so the person sees it in Review beside the choice that caused
it.

### A bench that answers a route with nothing measures nothing, and says "ok" (2026-09-22)

`check-360.mjs` records every request a screen made that the fixtures did not answer, and fails on a
non-empty list — added because an unanswered query renders an empty fold, an empty fold fits inside
360 px, and every measurement below it is true of the nothing inside it. It worked, and nobody read it:
`GET /api/drift` was added to the Status screen in `b4f0d7a` with no fixture beside it, so `check:360` had
been failing on that one route ever since and the drift panel had never been measured at any width. The
guard fired for weeks into a report nobody was failing a build on. **A check that reports a failure is only
half a check; the other half is something that stops on it.**

### A fixture that deals its cases round by index changes every case when a case is added (2026-09-22)

The 360 px fixture assigns protocols to sixteen tunnels with `protocols[index % protocols.length]`, and one
tunnel is singled out by index — `index === 5` — because the Reality fields render for that choice alone.
Adding `proxy` as a fourth entry moved tunnel 5 from VLESS to Cloak, and the two Reality controls left the
rendered DOM, the coverage manifest and the 360 px measurement together. Nothing about it looked wrong: the
fixture still had sixteen tunnels, still had VLESS tunnels, and still compiled. The parity harvest named it
— *no longer fillable: `/tunnels/-/config/realityPublicKey`, `/tunnels/-/config/realityShortId`* — in the
same run that added the three new proxy pointers, which is only possible because the manifest is read off a
rendered DOM rather than kept by hand. **An index-derived fixture couples every case to the number of
cases; the singled-out one has to be pinned to what makes it special, not to where it happens to sit.**

The correction was made once and then made again: the same commit that fixed index 5 introduced
`index === 3` and `index === 7` for the new proxy types, correct only while there were four protocols.
Pinning by `Math.floor(index / protocols.length)` also exposed two more: `role`, `resources` and `dns` were
dealt `% 4` against four protocols and so correlated role with protocol perfectly, and an `enabled` flag
claimed the same index as a protocol case. **Where one index-coupled case is found, the file has others.**

### A store that resolves `{"$keep": true}` by reading itself back can take away the means of repairing it (2026-09-22)

Writing a profile does not carry secrets in the clear: a position the caller leaves alone arrives as
`{"$keep": true}`, and the write path resolves it by reading the **stored** document and copying the
value across. That is the right design for secrets and it has a consequence nobody had stated. The
corrective write — the one that would fix a bad stored document — is itself a write, and it depends on
reading that same document back. **If an invalid document can ever be stored, the repair is the
operation that may no longer work.**

This surfaced as a refusal rather than a failure. An agent was asked whether the product accepts a
tunnel deleted while a routing rule still names it, declined to find out on the live board, and gave
this as the reason. The refusal was worth more than the finding: the probe would have written a
document to a device the owner was using, to learn something that can be learned on a copy.

The rule it leaves behind: **where a write depends on reading the current state, the validity of that
state is a precondition of every future write**, and it has to be established before the store, not
after. Probing what an invalid document does belongs on a copy, always.

### A deadline the device reports and a deadline the device enforces (2026-09-22)

An apply answers with `secondsRemaining: 148` of a 180-second confirmation window. The number a caller
must actually beat is **45 seconds**, because an early health check fires there and reverts anything
still unconfirmed. Measured: a transaction created at 19:03:20 was gone at 19:04:10, well inside the
deadline the device had just quoted; the retry, confirmed five seconds after the apply, survived.

The two numbers were built by different mechanisms for different reasons and neither is wrong on its
own terms. What is wrong is that only one of them is published. **A deadline is a promise, and a
promise that is reported but not the one enforced is worse than no promise**: it is precise, it is
believed, and it is followed all the way into the failure.

Add to the questions this catalogue asks of any window, budget or timeout a system reports: **is this
the number that will actually end the thing, or only one of several that can?**

### A stand-in in lower case, and a reader that could not see one real carrier (2026-09-23)

The window's uplink check read `link.operstate === 'up'`. `ip -j link` prints `"UP"`; the board's own
capture in `test/fixtures/ip/link.json` says so. Every uplink on the board therefore read as having no
carrier, and every unconfirmed windowed change with an uplink was reverted at 45 s — four times on the
bench, once measured beside `wfwan0` at `UP, LOWER_UP`, −28 dBm, `192.168.77.8/24`. The window tests
passed throughout because their stand-in snapshot was written `operstate: 'up'`, a shape the real tool
never produces: the catalogued *mock that answers what the real system would refuse*, from the other
side — here the mock answered what the real system never *says*. The same comparison sat in
`waitForSettle`, which is why every network apply ran out its settle timeout. The false reading also
retro-actively casts doubt on evidence built on it: `docs/15` scenario 1 ("recovered by the early check
at 50.5 s") and the four 2026-09-20 reverts cited for safe mode would have happened on a healthy uplink.
**Parse a tool's vocabulary in one place, test that place against a captured fixture, and build every
stand-in from the same fixture — never type the tool's words by hand into a test.**

### A missing value read as a negative one, through optional chaining (2026-09-23)

`link?.operstate === 'up'` is `false` when the link is absent, exactly as when it is down. A name
resolved before a rename, or an `ip` that printed nothing, became "no carrier" — the three-valued
`Observation` the module was built around was bypassed one expression below it. **`?.` followed by a
comparison is a boolean that cannot say "I don't know"; where absence must be distinguishable, test for
it first.**

### A verdict on the device delivered as a verdict on the change (2026-09-23)

The window's checks judged the whole device and acted on the transaction: a change of one core file
and a `wf-core` restart was reverted for the uplink, which it could not have touched. The check now
takes its scope from the change set the reconciler executes (`windowScopeOf`), and every finding names
the part of the change that put the component in scope and what was read. **A check inside a
transaction must be scoped to what the transaction did, or it becomes a random-failure injector for
whatever happens to be open.**

### The resolution of "a deadline the device reports and a deadline the device enforces" (2026-09-23)

The early check could not be given an honest number: 148 was false while it could act at 45, and the
earliest moment it could act — the first 5-second tick, for a failed unit — is useless as a deadline.
So it stopped being a trigger. It records a finding with evidence; the window ends at the reported
deadline (transient timer), by a person, or at a daemon restart (start-up sweep — the one remaining
early path, recorded, not fixed). `test/window-deadline.test.ts` holds a transaction open through a
genuine, in-scope, conclusive failure with every allowance at zero. **When a conditional action cannot
be expressed as a number, the fix is to stop it being an action, not to find a number.** Folding the
finding into the revert's reason then broke a string-equality check in safe mode (operator reverts
counted as failures); it matches the shared constant as a prefix now — the *copy of a truth across a
boundary* shape, caught before it shipped by asking who else reads `reason`.

### A list position mistaken for a meaning (2026-09-23)

`classifyContentChange` asked whether any differing JSON pointer was a reachability pointer, and a
pointer into a list is a position. Removing one `domain_suffix` routing rule shifted the hq's
`ip_cidr` rule down one index, so `/route/rules/6/ip_cidr` read as an address list that had appeared,
and an outbound removal came out `network` with a lock-out warning. The same shape as *a fixture that
deals its cases round by index*: identity derived from position changes every later item when one is
added or removed. The fix reads the list as the subsequence of entries that carry the meaning. It also
exposed the inverse defect the shift had been hiding: removing the *last* address rule differs at
`/route/rules/N`, a pointer with no leaf in its name, and was classified `service` — a real network
change with no window. **When a classifier reads pointers, check both an insertion above the thing and
the removal of the thing itself; one hides the other.**

### A warning computed from the whole desired state instead of the change (2026-09-23)

"This change reconfigures wlx90de8047b4b4, wfwan0 … you will probably lose access" fired when any
*desired* `.network` file named a management interface — every profile with an uplink — so it
accompanied every plan, including three core-only applies on 2026-09-22. **A warning that is always
present is a warning nobody reads on the day it is true; compute it from the same condition the
executor uses to decide whether to act** (here: a networkd file changed, or a takeover).

## A mechanism whose every failure is terminal is edge-triggered, and nothing says so (2026-09-23)

The resolver follower was built on 2026-09-22 for exactly this case and, in its first real one, did
nothing for ten hours. At 23:03:39 an apply wrote `config.json` naming `10.184.40.5`; the tunnel it had
restarted came up and wrote `10.184.48.5` to `hq.dns` at 23:03:49. The journal held no line.

From the code: the follower acted once per file-system event and once at start-up. Every outcome other
than success ended it — `confirmation_pending` because the apply that restarted the tunnel held its
window, a throttle whose message "leaving it for now" meant for ever, a failure. One line went to the
event ring, none to the journal, and nothing ever looked again. **The capture changes during an apply
because the apply restarts the tunnel, so the terminal case was the ordinary one.** Fixed by comparing
every minute as well as on events (level, not edge), deferring to an open transaction, and backing off
rather than stopping.

The third writing-down of *what wakes this mechanism?* (above) — the answer this time was "one event,
and if that one is refused, nothing ever". Ask also: **after a refusal, what wakes it?**

Two further shapes found on the way:

* **The value came from a capture outliving its connection.** `hq.dns` is written on connect and
  removed by nothing, so the apply at 23:03:39 planned from the previous connection's resolver. Harmless
  only if something corrects it within a minute — which is what the terminal failure prevented. Not
  closed: removing it at tunnel stop means changing `wf-openvpn@.service`, which restarts every OpenVPN
  instance on the next apply, `relay` included. A decision for the owner.
* **A mechanism that is silent while idle cannot be told apart from a dead one.** Every watcher now
  reports last look, last act, and not-running as a problem (`core/observers.ts`, `GET /api/observers`).

## A derivation that reads live state must be ordered, and a list whose order means nothing compared as a set (2026-09-23)

The drift report was red seconds after an apply from the very profile it compared against:
`/inbounds/0/route_exclude_address/3` "derives 10.164.0.0/20, the device holds 10.136.0.0/24 (and 4 more)".
Both halves were defects. The exclusions were built from `ip addr` in interface-index order, and a
recreated tunnel interface gets a higher index — so two derivations from one document differed. And
the comparison went by index, so one element moving made every later position a "difference".

A check that is always red hides the divergence that is real: the same report carried the stale hq
resolver, and nobody could see it for the noise. The same shape as an alarm nobody can act on.

Fixed at both ends: observed networks in one canonical order; `ManagedFile.observed` marks values read
off the device, `unordered` lists compare as sets, and a real change says what the next apply would drop.

## The switch the refusal must name did not exist (2026-09-23)

F8 asked for a sentence naming where `apiEnabled` is turned on. Nothing turned it on — no route, no
screen, no CLI; only an `UPDATE` typed into the database. A refusal cannot name a switch that is
nowhere, and a hint naming a place that does not have it is the confidently wrong instruction this
register already warns about. `way machine-api on` was written first, then the sentence.

## A stream one word from a list (2026-09-23)

`GET /api/events?limit=25` hung for 120 s. It is the SSE stream: `200`, a snapshot, then open for ever,
parameters ignored. The list is `/api/eventlog`. A request plainly asking for a list — a query, or no
`Accept: text/event-stream` — is now refused at once, naming it.

### Permission read from a state a failure empties (2026-09-23)

The fence softening asked whether a departing network was *defended*, and defended was a reading of
the interfaces at plan time. An uplink flap empties exactly that reading, so at the moment the check
mattered most — an uplink that has just lost its address — its network was "not defended" and the
fence could drop it with no window. The tester found it by classifying the board's own configuration,
not by breaking the uplink. The fix records, beside the fence and in the same change, which of its
networks were followed, and grants permission to narrow only from that record. **A permission to do
something dangerous must come from a record of the running state, never from a live reading that the
failure being guarded against would itself change.** The record is classed with what it describes, so
a partial apply cannot write one without the other: a record ahead of reality grants permissions
nobody earned.

### A list position mistaken for a meaning — again, in the store (2026-09-23)

The same shape as the classifier's index shift, one layer down: `{"$keep": true}` and the
"left-out secret" check both looked up the stored document at the incoming array index. Inserting a
tunnel anywhere but last was refused at `/tunnels/1/…`; reordering two tunnels swapped their
credentials silently; a tunnel with no credential moved above one with a credential made the kept one
look deleted. Keyed by `id` now. **Once a shape is found in one place, search for it in every place
that joins two versions of a list: differ, store, drift, export.** The store is where it costs most,
because a person reordering in the interface loses secrets without an error.

### One number, two answers, from a row that keeps its history (2026-09-23)

A committed transaction keeps `deadline_at` and `fires_at_uptime_seconds` as history. The confirm
response said `secondsRemaining: null`; `GET /api/transactions` derived a countdown from any row
carrying a deadline and counted it down. Same shape as G13: a value reported by two paths with two
rules. **When a field is meaningful only in one state, compute it in one function that takes the
state** (`windowCountdown`); a second derivation from the raw columns will not know the rule.
`way transactions` still has the second derivation and is left to its owner.

### Two constructors of one context answer one question twice (2026-09-23)

`GET /api/drift` said converged while `way drift` said `/dns/servers/3/server` and `wf-core` were out of
date. Same device, same question. The daemon's planning context read the resolvers the peers had
pushed; the CLI built its own by hand and left that reader out, so it derived the profile's starting
value and called the running configuration wrong. The timer-driven `way revert` used the CLI's context,
so the drift event it wrote after an undo was false in the same way.

The earlier entry about a reader that was accepted, never supplied, and whose absence was the
permissive answer is the same shape one level up: here the absent reader produced a confident red
rather than a quiet green. The fix is structural, not a missing line: one constructor
(`core/device-pipeline.ts`), with a test that fails if either entry point assembles a context of its own.

### A report kept in one process's memory is stale to every other (2026-09-23)

The drift report lived in the daemon's memory and ran at boot, after an undo, and every fifteen
minutes — never after an apply. So after the resolver follower fixed the device 4 s into start-up, the
Status screen showed the boot-time red for fifteen minutes. And the timer's `way revert` is a separate
process: its report reached the event ring, not the daemon, whose comment said the opposite. Now every
apply and confirm is followed by a check, every report is stored with the boot id and uptime it ran at,
and the daemon serves the newest stored one. `performance.now()` is monotonic inside a process and
meaningless across two; `/proc/uptime` qualified by the boot id is the clock they share.

### An observer that reports the empty half of what it watches (2026-09-23)

The tunnel watchdog's observer said "0 of 0 tunnel(s) healthy" every round on a board whose four
tunnels are all guarded destinations — the failover group it reported is empty there by design — and
read exactly the same at 19:50:46, when the guard on `partner` had really blocked its traffic. It
described the half of the round that had nothing in it. The class: **an observer that is running and
looking can still be looking at the wrong thing**, so "is it running" and "what does it see" are not
enough; it must also say when what it watches is failing. A fourth state, `failing`, carries that.

### A file-system watch follows an inode, not a path (2026-09-23)

Measured on the board's own node: renaming or deleting a watched directory delivers `rename`/`change`,
never `error`. The watch then follows the old inode, and a directory recreated at the path is watched by
nobody while the watcher reports itself as watching. The first round's `error` handler could never fire
for the one event that mattered. The path is now stat'ed after every event and on a cadence, and an
inode that is missing or different is a lost watch.

---


### A wait that ends must wake the waiter (2026-09-23)

The follower correctly refused to change the device while a window was open — and then learned that
the window had closed only at its next one-minute round. `hq.lan` failed for about 80 s after a
confirm. Waiting on a condition means being told when it ends; polling for it is a latency paid by the
owner. The end of a transaction now has one exit in the code, and it tells the follower. When the end
happens in another process (the timer's `way revert`), that process signals the daemon unit's main
process; a poll of the transaction table would have been a new mechanism for a one-line notification.

### A test that builds its own observer tests its own observer (2026-09-23)

The resolver watch recorded a look only when a capture changed: on the board `lastLooked` was null for
eighteen minutes after start-up and stood still for three while the 30 s inode check ran. The check
had no way to report, and `index.ts` called `looked()` only from the change handler. The round-two tests
passed throughout, for three reasons that each hid it: they built a watch and a registry by hand
rather than through the wiring `index.ts` uses; they asserted only `ok` and `not-running`, never that a
look had happened; and the observer was registered with no cadence, so one that never looked could not
go stale. **A test of an observer must assert the look itself, through the constructor production
calls**, and an observer that does something on a schedule must have that schedule as its cadence.

### A bounded reading hides whatever comes last (2026-09-23)

The watchdog's reading was one string, cut at 300 characters so a reading could not become a document.
With four guards whose "not measured (no probe target …)" notes are long, the fourth guard never
appeared: the reading ended "guard offi…". A bound on the whole is a bound that drops the tail, and the
tail is a subject. The summary now names every subject in a few words, and the detail travels one item
per subject, each item bounded and the list not.

### An observer's gap is the interval plus its own work (2026-09-23)

The watchdog read `stale` once — 51 s without a look against a 30 s interval — while a probe to an
unreachable address ran. Rounds are sequential with the interval between them, so two end-of-round
looks are an interval **plus a round** apart. A look at the start of each round as well makes the gap
the longer of the two, and a round is bounded by the probe budget; widening the threshold instead would
also have hidden a round that really hangs.

### A reading a person asks for is a reading of the device (2026-09-23)

`way drift` printed its comparison and stored nothing, so the daemon served an older answer for five
minutes after a person had been told a different one. Every check, whoever runs it, is now stored with
its origin.

### A layout check that measures labels by class is blind to a control that is not a field (2026-09-23)

The 360 px check enforced the interface's rule 3 — a label of at most three words, help of one short
sentence — by measuring `.field-label`, `.field-help` and `.choice-consequence`. A button that carries its
own consequence is none of those, so the first draft of the power-off control passed with **two sentences**
inside it. The rule was never about fields; it was about anything a person reads before acting, and a check
keyed to class names protects exactly the classes somebody remembered. Fixed by adding
`.consequential-title` and `.consequential-text` to what is measured, and shown by restoring the old string:
the check fails with *"2 sentence(s)"*. **A check scoped by selector covers the selectors, not the rule.**

### An API refusal is written for a script, and a screen that prints it verbatim inherits the wrong reader (2026-09-23)

The power-off route refuses while a confirmation window is open, with a message and a hint written for
whoever called the API. Printing both in the panel measured **8 line boxes in 338 px** at 360 px — correct,
complete, and unreadable on the device it was for. The screen already had a state that says the same thing in
three words and a sentence, so it shows that state instead. **When the interface has its own way of saying a
refusal, use it; the API's words are for a program, which reads everything and minds nothing.**

### A credential used as an identifier leaks wherever the identifier is shown (2026-09-23)

A transaction records who opened it in `openedBy`. For a browser session that value is the **session id —
the cookie itself** — and `GET /api/transactions` and the apply response return it, to any caller with
`read` scope, including the read-only tokens peers are given for the fleet view. So a read token could lift
the operator's full admin session out of a list of past changes. Found while building an unrelated button;
not yet fixed. **An identifier that is also a credential cannot be shown anywhere; record who acted by
something that names them and grants nothing.**

### A flag named for its mechanism, read as the answer to the reader's question (2026-09-23)

The platform layer's station read returned `iterated` — *"`all_sta` was truncated, so the list was rebuilt
with `list_sta` + `sta <mac>`"*. Telemetry carried it to the wire as `stationsIterated`, and both screens read
it as *"the list is complete"*. The two meanings are nearly opposite, so every ordinary, whole reply showed
*"did not finish listing its clients"* and *"at least N"*. Measured on the bench board: `all_sta` exit 0,
7 ms, 1755 bytes, two stations, the same two in `iw`, `list_sta` and `ip neigh`. The owner's missing third
device had been disassociated for inactivity eight minutes earlier — so the product's false caveat sent him
looking for a listing bug when the answer was a sleeping phone.

The test that allowed it passed `iterated: false` by hand to mean "not finished", which agreed with the
screen and with nothing the daemon ever produced. The fix names the field for the reader's question
(`stationsComplete`) and carries the reason in words (`stationsIncomplete`), and the test runs the real
controller on a captured reply. The question to ask of any boolean that crosses a boundary: **is it named
for what the producer did, or for what the consumer wants to know? If the first, the consumer will guess,
and a guess on a boolean is wrong half the time.**

### A tunnel's network woke nothing, and a dead tunnel read like a live one (2026-09-23)

`corp` was down from at least 22:15 to 07:32:27. Its unit was active all night, with 93 TLS handshake
failures. The watchdog read it every round as *not measured (no probe target)* — the same as the working
`relay`. When it came up with `10.122.0.0/24`, the fence written at 23:00 never took it, and drift stayed red.
The fence had moved once in the night only because a resolver changed at the same moment. **A mechanism that
follows one value gets credit for another only by coincidence. Ask of every value read off the device: what
wakes the thing that carries it into the configuration?** And: *nothing measured* must never read the same as
*fine*.

### A default must be the thing's own, or it reaches the wrong thing (2026-09-23)

The obvious default for an unmeasured guard is "whatever address exists for it". For the tunnel this session
runs over, that would have been a file that merely happened to exist. The default now needs two readings that
are both the tunnel's own: an interface it creates and an address its peer pushed. A tunnel without an
interface cannot get one.

### Removing on every flap is a restart on every flap (2026-09-23)

Following a network in both directions would have cost a core restart each time a tunnel flapped — and a core
restart interrupts every connection through it. Adding is prompt; removing waits for a rewrite that happens
anyway. **Answer "is this in step?" in exactly one place.** Drift and the follower both plan through
`planDocument`, so the retained network is expected by both.

### A probe that could not run is not a lost probe (2026-09-23)

`ping` exit 2 covers both "the interface is gone" and "ping could not run". The first is a dead tunnel. The
second, counted as lost, would block a tunnel because a binary is missing.

### A fixture that leaves out what the device has tests a device that does not exist (2026-09-23)

The follower's tests passed and the board refused itself at 09:07:52. The board's `corp` routes its own
network — `10.122.0.0/24` sits in its resource rule — and the fixture's tunnel had no rule. The classifier
gathered every address in the reachability region into one set, so the network already sat in the set before
it entered the fence; adding it read as nothing moving, and a change that moved nothing was refused its
softening. The live case had been kept on the board deliberately, unapplied, as the test for this fix, and it
caught in one minute what 1185 tests had not. **Judge a value in the list it enters, not in a pool of every
list it could be in. And build a fixture from the device's own file:** the shape nobody thought to include is
the shape that breaks.

### A record of a class nothing performed (2026-09-23)

The follower's start-up attempt opened a transaction recorded `network`, committed without a window, which
wrote nothing. The class was the whole plan's; the caller had permitted only hot and service, and the one
`service` step was a restart whose only causes were refused. The history then claimed the one thing the window
exists to prevent. **A transaction records what it does, and a caller permitted to do nothing opens none.** The
same rule that decides whether a restart runs has to decide what the record says, or the two disagree about
one apply.

### A measurement of something a tunnel carries is a measurement of that thing (2026-09-24)

`partner`'s guard used `http://172.30.0.212/`, one of its own resources, because the field's documentation said to give a tunnel "something that exists behind it". That server closed port 80. The guard blocked every destination behind a tunnel whose gateway answered in 95 ms. **The documentation of a field is an instruction, and people follow it.** The advice made the misfire the normal case. A liveness reading must be a property of the tunnel. Anything the owner can point at is something the tunnel carries.

### A default that is the tunnel's own can still be about something else (2026-09-24)

The 2026-09-23 fix measured an unconfigured guard by echoing the resolver its peer pushed. That value does come from the tunnel's own peer. For `partner` it was `77.88.8.8` and `8.8.8.8`, public resolvers reachable from anywhere. The rule written that day, *a default must be the thing's own*, was necessary but not sufficient. **Ask also whether the value is about the thing:** the gateway is, and the resolver is not.

### The URL you give the core is not the URL it fetches (2026-09-24)

Measured against sing-box 1.14.1: `/proxies/<name>/delay` replaces any `http://` URL with its own default and dials `www.gstatic.com:443`. That held for Cloudflare's URL, for a blackhole address, and for no URL at all. It answered 200 every time. Only `https://` URLs are dialled as given.

Every probe this project configured was `http://`. That covers the device-wide `policy.probes.endpoints` and `partner`'s probe. So every one of them measured Google through the tunnel. The night's outage may not have involved `172.30.0.212` at all. Whether the board's 1.14.0 behaves the same is still an assumption until checked there.

**A tool that silently substitutes an input answers confidently about the wrong thing. Capture which host it actually dialled, not only its status code.**

### A pushed value can be in the reply and absent from the environment (2026-09-24)

Measured with OpenVPN 2.6.14. The PUSH_REPLY carried `route-gateway 10.136.0.1`, yet `route_vpn_gateway` was absent from the up-script's environment. The client builds no route list when the peer's routes are filtered and the configuration has no `route` of its own. One never-installed TEST-NET-1 route (`route-noexec`) makes it appear: `10.136.0.1` with `subnet`, and the point-to-point peer with `net30`. **Read the environment a real client produced. Do not infer it from what the peer sent.**

### A file rewritten every few seconds must not live where a watcher wakes on change (2026-09-24)

The obvious home for OpenVPN's status file was `/run/wayfarer/tunnel`, beside the captures. The resolver watch wakes on every change in that directory, so it would have woken every five seconds per tunnel. The file went to `/run/wayfarer/openvpn` instead. That directory is created by the unit's `RuntimeDirectory=`, because OpenVPN opens the status file once at start and a missing directory means no status for the life of the process. **Before writing a file, ask what already watches its directory.**

### A cumulative counter reads as alive for as long as the connection is open (2026-09-24)

A connection opened before a path died keeps the bytes it received while the path worked. Measured on sing-box 1.14.1: a 20 KB/s reader behind about 4 MB of buffers kept `download` flat at 4247568 for ten seconds. **Evidence of liveness is growth between two samples, never a total.** A connection that has disappeared contributes nothing, and uploaded bytes never count, because a dead path accepts whatever is sent into it.

### A setting whose promise nothing implements (2026-09-24)

`onUnavailable: fall-through` is documented as "the traffic takes the ordinary route". No selector is generated for it, and its rule points straight at the tunnel's own outbound. While the tunnel is down its traffic fails exactly as under `block`. Tests asserted that the rule points at the tunnel. None asserted what happens to the traffic when the tunnel is dead. **For every option, test the behaviour it promises, not the configuration it writes.**

### Removing a behaviour leaves its state behind (2026-09-24)

The core keeps a selector's choice in its cache file across restarts. A guard parked on `block` by the previous build would stay there for ever under a build that never moves it. The new guard puts a selector it finds on `block` back on its tunnel, once, and records `guard.unparked`. **When a mechanism stops doing something, ask what it already did that is still in force.**

### A response schema is a filter, and it filters without a word (2026-09-24)

The watchdog produced `method`, `action` and `tone` for every tunnel. `GET /api/observers` served only `subject`, `state` and `note`, because the route's response schema listed three fields and Fastify's serialiser drops undeclared keys silently. Every test passed, because each one read the registry directly and none read a response. The panel therefore showed no colour, no method and no "done about it" on the device.

This is the same shape as *a test that builds its own observer*, one layer out. **A value is on the wire only if a test read it off the wire.** The daemon's test script now sets `WAYFARER_SERIALISER_CHECK=1`. With it, every response in the suite is compared with what its handler produced, and anything the schema dropped becomes a 500 that names the paths. Its first run found one more: drift's `checkedAtMonotonicMs`. That field is meaningless outside the process, so leaving it off was correct. But it had been left off by accident, and it is now left off by name.

### A sampled clock starts when the sample notices (2026-09-24)

The first liveness build read OpenVPN's counter once per 30 s round. Its silence clock therefore started when a round noticed the counter had stopped, not when the counter stopped.

Measured on the board: `corp`'s transport stopped at 08:39:27, the counter froze from then on, and the first dead reading came at 08:41:22. The claimed 90 s was really about 115 s. Meanwhile the confirming echo already said "stopped", and nothing listened to it.

**Sample at the rate the source changes, and start a clock from the sample that saw the last change.** The counter is now read every 5 s, which is the rate OpenVPN rewrites its status file. A sample that changes a tunnel's standing runs a round at once. A gateway that had answered and stops, together with a counter flat across two writes, reads dead immediately.

### A limit that is someone else's number should be read, not remembered (2026-09-24)

A fixed 60 s silence limit was four missed pings for one peer and six for another. Each peer states its own keepalive in its PUSH_REPLY (`ping 15`, `ping 10`), so the limit is now three of those intervals. The value appears in no environment variable, only in the client's journal line, so it is read from there. When that line is gone the limit is 60 s, and the reading says the interval is unknown.

### A warning that fires on every run is a warning about the check (2026-09-24)

Every redacted export logged `profile.export-incomplete-redaction`: 20 unwrapped values. The check was written when tunnel configurations were opaque blobs, and it reported every unmarked string. Once the catalogue typed every field and marked every secret, "unmarked" came to mean "ordinary": host names, interface suffixes, Cloak's public key, method names.

It was not a leak. A sentinel in every secret position came back from the redacted export in none of them, and the test proves this through the real route. The check was wrong, not the export.

The check now reports three things, which are what it should have meant:
- a marked position holding a value in clear;
- a field named like a secret that the schema did not mark;
- key material in a field that is not marked.

**When a check's premise changes, its alarm threshold must change with it. Otherwise it keeps firing, and the one real alarm reads like all the others.**

### A race you are winning is still a race (2026-09-24)

The distribution's `dnsmasq.service` was enabled on the bench board and failed at every boot. Nothing noticed, because nothing was broken: `wf-dhcp@<ap>` — the same binary with our configuration only — bound first and served the access point. The stock configuration listens on the wildcard address, ours binds the access point's interface, and no `After=` orders the two. The failure was therefore a property of boot timing, and the day the order flips it is every client of the access point associating and getting no address, with our unit restarting into its start limit.

**A failed unit you did not write is not noise until you know what it was trying to take.** The installer now stops, disables and masks the conflicting stock units, persistently: a `--runtime` mask is gone at the next boot, which is exactly when the race happens.

### "Nothing foreign is touched" needs a list of exceptions, not a second rule (2026-09-24)

The project's rule is that nothing foreign is stopped, masked or contended for, and the supplicant was built around it (our instance runs without `-u` so it never contends for `fi.w1.wpa_supplicant1`). A stock unit that contends for the same sockets cannot be designed around — two servers cannot both own port 53 on the access point — so the rule gets an exception. The exception is one list with a reason per entry (`STOCK_UNITS_TO_MASK` in `deploy/install.sh`), not a pattern, and each candidate was checked on its own merits:

- `dnsmasq.service`: contends for the sockets. Masked.
- `wpa_supplicant.service`: serves every radio and holds a global D-Bus name ours deliberately does not use. No contention. Left alone.
- `hostapd.service`: holds no port or global name, and reads a configuration file this project never writes. It contends only for a radio configured for it by hand. Left alone.

### An installer's decision is a state the daemon must watch (2026-09-24)

A mask can be undone by one command, by a package's maintainer script, or by a how-to followed at the console, and after that the installer's decision stays undone until the next deploy. So the same list lives in the daemon (`platform/stock-units.ts`), and the drift check reports a listed unit that is no longer masked as `unit-conflicting`. The two copies are bash and TypeScript and cannot import each other; a test parses the installer's array and fails when a name or a reason differs. "systemd could not be asked" is its own finding, never "still masked".

### Verify a mask by reading it back (2026-09-24)

`systemctl mask` refuses when a unit file sits at `/etc/systemd/system/<unit>` — the same trap that once made the daemon itself unmaskable. The installer reads `is-enabled` back after masking and warns when it is not `masked`, instead of trusting the exit status of the call. A refused mask warns and does not abort the install.

### A flag that deploy always passes cannot gate a fix deploy must apply (2026-09-24)

Masking a stock unit looks like a "host setting", and `--skip-host-settings` exists for exactly that. But `scripts/deploy.sh` always passes `--skip-host-settings`, so gating the mask on it would have made the fix a no-op on every device deployed the normal way. The mask runs regardless of that flag.

## G31: shapes from building `fall-through` for real (2026-09-24)

**An option whose promise was only a sentence.** `onUnavailable: fall-through` existed in the schema, had
a control and a consequence written under it ("Traffic goes out the ordinary way instead"), and had no
routing behind it: its rule pointed at the tunnel's own outbound, so a dead fall-through tunnel failed
exactly like a `block` one. Every layer a person could read agreed with the promise; only the generated
configuration did not, and nothing compared the two. **A consequence written under a choice is a claim
about the generated configuration, and it needs a test that reads the configuration** — the one that
existed asserted the rule pointed straight at the tunnel, and so held the defect in place.

**"The ordinary way" has no exact form in the core.** The honest meaning is *what this traffic would do if
the tunnel's rule did not exist*. A routing rule is final and a selector cannot choose "skip this rule", so
the nearest defined member is `route.final`. The difference is real on the board: `hq`'s `10.0.0.0/8`
sits below `corp`'s rule and covers `corp`'s networks, so a fallen-through `corp` goes `direct`,
not into `hq`. Written into the preview sentence rather than left for someone to discover.

**A selector changes the path to a DNS server, never its address.** The obvious design — detour the
tunnel's resolver through the same fall-through selector — is permitted by the core and useless for the
resolvers the board has: `10.122.0.1` and `10.184.100.5` exist only behind their tunnels, and sending the
query to the same address the ordinary way puts it on the uplink towards an address that is not there, or
is somebody else's. The switch had to change *who answers*, not *which way the packet goes*, and the only
static, selector-driven way found was a loopback SOCKS loop into the core's own DNS router.

**A fallback on failure is not a fallback on a verdict.** Read in sing-box 1.14.0's `dns/router.go`: a DNS
rule whose exchange *fails* returns the error and does not fall to the next rule; only a *rejected* response
does. And any failure-driven fallback would fire on one resolver hiccup, which is the false reading G30
exists to avoid. The owner's condition — only the liveness verdict may send traffic outside a tunnel —
applies to names as much as to connections.

**A file the guard rewrites is state the plan does not own.** A local rule-set is watched and reloaded by
the core, which made it tempting as a runtime flag. It fails before it starts: `sing-box check`, run by the
reconciler before anything is written, refuses a configuration naming a rule-set file that does not exist
yet — so the first apply introducing it would be refused — and a file the watchdog rewrites is drift the
drift check would report or undo.

**The core remembers a selector's choice; the daemon does not.** After a daemon restart the core's cache
file can hold the fall-through position with no reading in this process to justify it. Trusting it would
continue a leak on a verdict nobody holds any more; so a position found on the ordinary route without a
dead reading from this process stays only if the tunnel reads dead now, and otherwise — alive *or not
measurable* — goes back to the tunnel, the direction that cannot leak.

**Two more places that drop a field without a word.** `fallingThroughSeconds` had to be added in three
places to reach the panel: the watchdog's item, the response schema (G30's lesson), and the observer
registry's `looked`, which copies each item field **by name** and silently drops the rest. The serialiser
check would not have caught the third: the field was never in the object the serialiser saw.

**A duration re-shown is a duration that has aged.** The watchdog's observer shows the last round's items
again at the start of the next round, under a fresh look. A "for N seconds" carried unchanged would be
stamped as read now, and the panel's "since" would creep forward by a round at every round start. It is
advanced by the time since the round that produced it.

**"About 10 s" was one window read as the whole.** docs/04 said a stopped gateway plus a counter flat across
two status writes (10 s) reads dead "at once", which was taken as ~10 s detection. The 10 s is the flat
window inside one reading; a reading happens when a round runs. Measured on the board: ~27–32 s with the
gateway echo confirming, ~45–52 s on the keepalive alone.

## G31 acceptance: "the direction that cannot leak" was the wrong question (2026-09-24)

**The failure.** On the board, `corp` fallen through and still dead, `systemctl restart wayfarer` (the
core did not restart): both fall-through selectors went back to `corp` within 5 s and stayed there ~60 s
(12 samples) before moving out again. The rule was: a position found on the ordinary route with no dead
reading from this process is kept only if the tunnel reads dead *this* round, and otherwise — alive or not
measurable — put back on the tunnel. A fresh process has no earlier keepalive sample, so its first rounds
read not measurable, and every daemon restart or deploy put a dead tunnel's traffic back into it for a
minute.

**The wrong reasoning.** "The tunnel is the direction that cannot leak" was true, so a move toward it felt
free. It is not free under `fall-through`: the owner chose that setting so this traffic would be carried
rather than lost, and a minute of blackhole is exactly the outage the setting exists to prevent. The
rule G30 set — *not measurable is not evidence, and moves nothing* — had been applied to the move *out*
and quietly dropped for the move *back*, because one direction looked safe. **A three-valued reading has to
be three-valued in both directions**; the moment one direction gets "and unknown counts as yes", the
unknown that every fresh process starts with becomes an action.

**The shape to recognise.** A decision made at start-up from state the process has not rebuilt yet.
Every restart begins in the least-informed state there is; a rule that acts on "I have not seen evidence"
fires on every restart by construction, which is why it passed every test built on a warm process and
failed on the first cold one.

**The fix.** A position found on the ordinary route is kept while the tunnel cannot be read, confirmed by a
dead reading (then back only after the full three alive rounds), and put back at once by an alive reading —
this process never justified it, and it must not keep traffic outside a tunnel that reads alive. The test
replays the board's sequence: fallen through, restart, not measurable three times, dead — no selector is
written across the restart, and "since" counts from the first round of the new process.

**Measured timings replace the arithmetic.** Out at ~45 s after the transport stopped (the arithmetic said
60–90 s), back ~60 s after the tunnel returned (three alive rounds). The resolver loop — a query handed over
a loopback SOCKS5 UDP associate into the core's own DNS router — worked on the real core: NXDOMAIN for
`corp.internal` in 12–17 ms while fallen through, against 324 ms through the tunnel.

## Shapes from the tokens card (2026-10-07)

### A header that describes a body the request does not have

The panel's one `request()` set `content-type: application/json` on every call. The daemon answers a
request that declares JSON and carries nothing with `400 "Body cannot be empty when content-type is set
to 'application/json'"`, before the route runs. So every bodyless write the panel makes failed: revoking
a token (where it was found), deleting and activating a profile, removing a peer, signing out. Measured
on the bench board: the same `DELETE /api/tokens/:id` answered 400 with the header and reached the route
(403, wrong scope) without it. Nothing caught it because every UI test stubs `fetch` and none looked at
the headers; `lib/api.test.ts` now does. The header goes with a body and only with one.

### A check that leaves its browser behind

`check-360.mjs` started Chrome with `--user-data-dir=${TMPDIR}wayfarer-check-360-<pid>` and never
removed it: each run left a profile of 44 entries, and a `TMPDIR` without a trailing slash would have put
it beside the temporary directory rather than in it. It is now `join(tmpdir(), …)`, removed in the
`finally` once Chrome has exited — Chrome writes to its profile until then.

### Documentation that described a plan as if it had been built

`docs/07` said machine access is switched on in the interface "where tokens are also created". The
switch has only ever been `way machine-api on` (by decision, `docs/10`), and no screen called the token
routes at all; the sentence was `docs/08`'s plan restated in the present tense. Corrected in both, with
the card that now exists.
