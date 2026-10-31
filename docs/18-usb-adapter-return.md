# 18. Returning the USB adapter to the access point

A runbook for one pending event on the bench board, and the measurements it is meant to produce. Kept in the
repository because what it measures belongs in [12-hardware-invariants.md](12-hardware-invariants.md) once known,
and the steps are the ones a person needs to repeat it on any board with the same adapter.

## Where this starts (2026-10-16)

* The mt7921u USB adapter that hosted the access point hung twice; the second time its firmware reset left the
  radio silent for six hours while hostapd reported `ENABLED`
  ([12](12-hardware-invariants.md#an-mt7921u-access-point-can-go-silent-while-everything-above-it-reports-healthy)).
* Its own sensor read **76 °C** with almost no traffic, against 41–44 °C on the SoC, and `iw` reported
  `txpower 3.00 dBm` against a 23 dBm channel limit. The owner unplugged it and ordered a heatsink.
* The access point runs on the built-in radio from a **temporary copy** of the active profile: `phy-builtin`,
  5 GHz channel 36, 20 MHz, `wpa3: false`
  ([12](12-hardware-invariants.md#the-built-in-radio-as-the-access-point-what-it-took-2026-10-16)). The
  original profile is untouched and still binds the adapter (`phy-usb 0e8d:7961`, 80 MHz, WPA2+WPA3).

## What is new for the adapter since it last ran

`vht_capab` was corrected on 2026-10-16. The adapter's line gains `[SU-BEAMFORMEE]`, which its driver reports
and which had never been offered before. It is the one untested change on this path: if hostapd refuses it,
the confirmation window reverts to the built-in radio.

## The switch

Only this step takes the network away from clients. The board, its uplink and its tunnels keep working
throughout; clients lose the access point for about 10–30 s and rejoin by themselves — same name, same
passphrase.

1. Plug the adapter in, with the heatsink on.
2. **Before anything else, cold:** read `hwmon` `mt7921_phy0` and `iw dev <adapter> info` (`txpower`). These two
   numbers, taken before the radio has worked, are the baseline the rest is compared with.
3. Activate the original profile with apply (`POST /api/profiles/:id/activate?apply=1`, or "Activate and apply").
   It is a `network` change: a window opens and the traffic check runs.
4. Confirm only after: `AP-ENABLED` in the hostapd journal, the traffic check `passed`, and a client has joined.
   If the access point does not come up, do nothing — the window reverts to the built-in radio by itself.
5. Delete the temporary copy once the original has held for a day.

## The switch as it ran (2026-10-17)

The adapter came back with a heatsink at 15:42 UTC. Transaction `ef3a4fa1f5738228`, committed at 15:51.

* **Cold, before the radio worked:** `mt7921_phy1` read **32 °C** (SoC sensors 46–48 °C). `txpower` could not
  be read: the interface was `DOWN`, and `iw dev … info` prints no `txpower` for a down interface. It was not
  brought up by hand to get the number.
* **Right after `AP-ENABLED`:** **34 °C**, `channel 36, width 80 MHz`, **`txpower 3.00 dBm`**. Five clients
  joined within the window; the traffic check `passed` in 288 ms. hostapd accepted the corrected `vht_capab`
  with `[SU-BEAMFORMEE]`.
* On plug-in the kernel logged `usb 2-1: device descriptor read/64, error -71` once, then enumerated the
  adapter normally.
* **The `POST /api/apply` answer never arrived** (client timeout at 60 s), while the transaction reached
  `awaiting-confirm` on its own. The change set rewrote a networkd file, which reconfigures every managed link,
  `end0` included, and the request came in over `end0`. Following the transaction by id
  (`GET /api/transactions`) is what works; a lost answer is not a failed apply.

* **The plan said `restart wf-firewall.service`, and the core restarted too.** `wf-core` started at
  monotonic 118409.17 s, 0.57 s after `wf-firewall` (118408.60 s), and `wf-openvpn@collect-vpn` with it. The
  chain on the board: `wf-core` has `Requires=wf-firewall-ready.target`, the target has
  `Requires=wf-firewall.service`, and systemd propagates an explicit restart along `Requires=`.
  `wf-openvpn@collect-vpn` is `PartOf=wf-core.service`. So every firewall restart is also a core restart,
  and the plan does not say so. No traffic leaves outside the tunnel while this happens. The ruleset deletes
  and recreates `table inet wayfarer` inside one `nft -f`, which is one transaction, and the unit has no
  `ExecStop`. Clients lose connections through the core for the length of its restart. Making the plan name
  this consequence is open.

### A trap found before applying: the inactive profile had gone stale

The first plan for the original profile also rewrote `/etc/wayfarer/socks/claude-1.json` and restarted
`wf-socks@claude-1`. Nothing about the radio explains that. A diff of the two stored documents showed why:
while the copy was active, the subscription refresh of 2026-10-17 14:51 updated `claude-1`'s `realityShortId`
in the copy, and the original kept the value from 2026-10-16. Its own last refresh, at 06:58 that day, had
failed with "the refreshed profile does not plan" because the adapter had already been unplugged.

**Corrected the same night.** The first version of this paragraph said that applying the original would have
put back "a node parameter the provider no longer serves", which would break a Claude tunnel. That conclusion
was drawn from one difference, without asking whether the feed holds the value still. It does not: a manual
refresh at 15:57:48 reported `updated claude-1` again, with no new node. The feed hands out a different
`realityShortId` for that node on each read, so "stale" here means "from another read", not necessarily
"refused by the server". Whether an older short id still connects was not tested: `claude-1` fails its test
with either value (`504` through it, 2026-10-17 18:57). The reason for diffing before applying stands. The
plan touched a Claude tunnel for a reason unrelated to the radio, and that is enough to stop and look.

The fix was data, not code. The original's `groups` were replaced with the copy's through
`PUT /api/profiles/:id`, with `{"$keep": true}` at every secret position. Before that, the stored secrets of
both documents were compared on the board by hash, and all 17 were equal. The next plan no longer touched
`claude-1`.

**Rule for every switch back to a profile that sat inactive:** read its plan, and if it touches anything the
switch is not about, diff the stored documents before applying. Refreshes write only to the active profile.

* **A day later (2026-10-19 09:37 MSK):** hostapd still running since the switch, about 39 h. The adapter reads
  **34 °C** with five clients after 24.9 GB sent and 2.6 GB received (`statistics/{tx,rx}_bytes`). The SoC
  reads 41–42 °C. No `mt7921u … timeout` line is in the kernel log since the plug-in, and the radio watch has
  not acted. `txpower` still reads 3.00 dBm. The temporary copy `684f1e7e079408a3` was deleted. The plan for
  the active profile is empty, and drift shows no findings.

### What this settles about 3 dBm

The figure is there **at 34 °C**, a minute after the radio started. **Explanation 2 (thermal back-off) is
ruled out** as the cause of the figure itself: it does not wait for heat.

Explanation 3 does not match the board as it is now either. `iw reg get` lists only `phy#0`, the built-in radio,
as self-managed with domain `00`. The adapter (`phy1`) follows the global `DE`, and its channel 36 limit is
23 dBm (`iw phy phy1 info`). That leaves explanation 1, a reporting artefact, or something in how the driver
applies the limit. Client-side RSSI is the test that is still open.

### The adapter stops sending beacons while data still flows (2026-10-20/21)

**Symptom.** From 2026-10-19 15:40 MSK the owner reported Wi-Fi dropping "for a few minutes", mostly on Apple
devices, once also on the PlayStation. On the board nothing was wrong. hostapd had run without a restart since
2026-10-17 18:49, and the kernel logged no error. hostapd never deauthenticated a client: every rejoin was
started by the client. DHCP answered at once, and the core and the `germany` tunnel showed no gap in traffic.
The radio watch did not act, and could not have: interface packet counters kept moving throughout.

**The client says why.** The owner's MacBook (`cc:08:fa`) is a client of this access point, and its unified
log records the reason for every link loss (`/usr/bin/log show`, process `kernel`). All three of its drops in
four days start the same way:

```
04:36:11.942 kernel: handleLink: f/w reason = 1 Link down because of beacon loss
04:36:12.001 kernel: leaveNetworkCommand: ask to leave network due to <link down indication> isDisconnectInVoluntary=<1>
```

Its link-quality reports from `airportd`, every 5 s, count the beacons received from its own BSS
(`rxBeaconMbss`) and the unicast data frames from it (`rxDataUcastMbss`). At a 100 TU beacon interval the
normal count is about 50 beacons per 5 s, and that is what they show for hours. Around each drop:

| Drop | Beacons per 5 s | Data frames per 5 s in the same reports | Link quality just before |
|---|---|---|---|
| 2026-10-20 17:11 | 18, then 0–2 for 30 s (17:10:32–17:11:02) | 63–104 | |
| 2026-10-20 21:48 | 35–40, then 15, then disconnect | 86 | |
| 2026-10-21 04:36 | 35, 6, 1, then 0 for 15 s (04:35:53–04:36:08) | 51 at 04:35:58 | RSSI −69 dBm, noise −90, SNR 28, CCA 8 %, `txFail=0` |

**Finding.** The adapter stops transmitting beacons for 15–30 s while it keeps transmitting data to the same
client. The client then leaves on beacon loss. The other Apple devices drop at the same second. After the
rejoin the count returns to about 50. What restarts the beacons was not established. It happens without any
action on the board, within about a minute.

**Corrected the same night.** Before this was measured, the explanation offered to the owner was a weak link:
clients near the board show −72 to −78 dBm at the access point with MCS 4–6, and a metal heatsink over the
adapter was named as a possible cause. The client-side numbers contradict it. The link is clean right up to
the moment the beacons stop, and data keeps arriving after. Signal level as the board reports it was the wrong
metric; the client's beacon count is the right one.

**What rules out the easy causes on the board.** `runtime-pm` 0, doze time 0, and USB autosuspend off
(`power/control` = `on`) on phy1 (`/sys/kernel/debug/ieee80211/phy1/mt76/`). Kernel `6.18.49-current-sunxi64`.

**Why the radio watch is blind to it.** The watch reads kernel errors and interface packet counters. Beacons
are sent by the adapter's firmware and appear in neither, and data keeps flowing. Detecting this on the board
needs a receiver that counts the access point's beacons over the air. Not built; recorded as the gap.

*Corrected 2026-10-21:* this paragraph first named the built-in radio in monitor mode as that receiver. It
cannot be: `iw phy phy0 info` lists no monitor interface type, and a passive scan on it
(`iw dev wfwan0 scan freq 5180 passive`) hung for more than two minutes and had to be killed. The claim was
made from "idle and supports channel 36" without reading the interface modes.

**Open.** Whether the PlayStation's drop at 2026-10-20 19:58:04 (12 s, rejoined by itself) is the same event
was not established: it logs nothing the board can read.

### How often, and what does not end it (2026-10-21)

Measured from the same MacBook's `airportd` reports, read live by a script on the Mac. A report is counted
only when the Mac also heard other networks' beacons (`rxBeaconObss` ≥ 25 per 5 s); below that the Mac itself
was off channel or asleep, and its own-BSS count means nothing.

**Stalls.** Between 13:00 and 14:40 there were five, each with other networks heard at 90–145 beacons per 5 s
and this access point at 0–5:

| Start | Length |
|---|---|
| 13:02:14 | ~50 s |
| 13:37:28 | ~60 s |
| 13:58:27 | ~25 s |
| 14:19:36 | ~60 s |
| 14:34:23 | ~2 min, with short recoveries to 10–20 |

Over the 22 h before, 28 stalls longer than 15 s were counted in the same reports. Nothing on the board changes
around them: no kernel message, no hostapd event, the mt76 queue heads, `acq` and BA-miss counters
(`/sys/kernel/debug/ieee80211/<phy>/mt76/`) read every 2 s show no step.

**Re-sending the beacon template does not end a stall.** The mt7921 driver hands beacons to the firmware as a
template (`UNI_BSS_INFO_BCN_CONTENT`), resent on `BSS_CHANGED_BEACON`. `hostapd_cli update_beacon` triggers
exactly that: tracepoint `mac80211:drv_link_info_changed` showed `changed:0x100` for it. The script ran it
over ssh whenever a trusted report showed ≤ 12 beacons, at most every 20 s; data still flows during a stall,
so the command reached the board each time (`OK`, 1.4–1.7 s). It fired 3, 4, 2, 3 and 5 times in the five
stalls above, and the next reports stayed at 0–5 every time; each stall lasted as long as the unattended ones
before. So the firmware is not missing the template; it is not transmitting. A periodic beacon refresh in
the radio watch is therefore not a repair, and was not built. Whether the repeated commands lengthened the
2-minute stall was not established.

**The steady deficit is a different thing, and smaller.** Outside stalls the count averages 44–46 against
~49, falling as the client's own traffic rises (trusted reports, 22 h):

| Data frames per 5 s | Mean beacons per 5 s |
|---|---|
| < 50 | 46.1 |
| 50–200 | 45.7 |
| 200–1000 | 44.6 |
| ≥ 1000 | 42.3 |

Whether the beacons are late at the adapter or missed by a busy client was not established. `update_beacon`
fired on this deficit (mean of six reports < 44) did not change it either. It was first reported to the owner
as "about 20 % of beacons lost" from one morning hour; the day-long figure is 6–8 %.

**What others report.** No public report matches stalls of this length with data flowing (searched
2026-10-21). The closest setup is openwrt/mt76 issue 1141 (kernel 6.18.50, channel 36, VHT80), where the
adapter dies outright. The driver's beacon path has not changed since 2022. linux-firmware has nine releases
of `WIFI_RAM_CODE_MT7961_1.bin` after the 20230526 build in the distribution package, without release notes;
one (2026-03) is reported to fix a 6 GHz access point that sent no beacons at all on the 2025 builds. Single
reports name `disable_usb_sg=1` on `mt76_usb` and enabling 802.11ax as having helped beaconing. 802.11ax is not
tried here: the owner recalls the PlayStation dropping with it on.

### Newer firmware (2026-10-21 15:16)

`deploy/mt7921-radio.sh firmware-install <ap-interface>` places the patch and RAM code from linux-firmware commit
`ced02591a802` (2026-03-13, build 20260224, checksums pinned in the script) in `/lib/firmware/updates/mediatek`,
reloads the driver, and restarts the access point units, which are bound to the interface and stay down
otherwise. If the access point is not `ENABLED` within the deadline it removes the files and reloads again;
`firmware-remove` does the same on request. It is not part of the installer: it is a hardware-specific experiment and
stays opt-in until the result is known. Run detached (`systemd-run`), because the ssh session may be riding
the access point it reloads.

As it ran: files placed at 15:16:40, access point `ENABLED` at 15:16:44, kernel log
`HW/SW Version … Build Time: 20260224110909a` and `WM Firmware Version: ____010000, Build Time: 20260224110949`,
6 of 7 clients back within a minute, no kernel error.

**Trap: the phy number is not stable.** After the reload the adapter came back as `phy2`, not `phy1`.
Anything that addresses the radio by phy number — a debugfs path, a script — silently reads nothing. Address it
through the interface (`/sys/class/net/<iface>/phy80211`).

**Trap: the board's journal holds about seven hours.** On 2026-10-21 at 10:40 the oldest entry was from 03:41
the same day. The 200 MB runtime budget is filled by the core's access log (one `accepted` line per
connection, unit `wf-socks@germany`), so an incident from the previous evening is already gone from the board
by morning. The client-side log above is what survived. Not changed here.

**Result: not cured.** Seven minutes later the same stall: 15:22:56–15:24:46, own beacons 1–13 per 5 s while
other networks were heard at 82–169. The new firmware is kept while the next candidate is tried, so that only
one setting changes at a time.

### `disable_usb_sg=1` (2026-10-21 15:53)

`deploy/mt7921-radio.sh sg-disable <ap-interface>` writes `options mt76_usb disable_usb_sg=1` to
`/etc/modprobe.d/wayfarer-mt76-usb.conf` and reloads the driver down to `mt76_usb`; `sg-restore` removes the
file and reloads. The explicit unload is there because `modprobe -r -n -v mt7921u` lists only `mt7921u`, so it
was not relied on to take `mt76_usb` with it.

As it ran: file written at 15:53:07, access point `ENABLED` at 15:53:12,
`/sys/module/mt76_usb/parameters/disable_usb_sg` = `Y`, firmware still 20260224, no kernel error.

**Result: not cured.** The next stall began at 15:59:09, six minutes later: own beacons 0–3 per 5 s until
15:59:59 while other networks were heard at 77–117. The client stayed associated (no `beacon loss` line in its
log); a single report at 15:59:34 with every counter at 0 was the client off channel, not a disconnect, and was
first misread as one. Both settings are still in place on the board.

### Another channel (2026-10-21 16:27)

**Why.** Wayfarer does not choose the channel: `accessPoint.radio.channel` is a fixed number in the profile, and
hostapd is not run with automatic selection. A scan from the client at 16:10 (`system_profiler
SPAirPortDataType`) listed three other networks at 80 MHz on 40, 44 and 48 — the same 80 MHz block as this
access point on 36 — and none in 149–161. The regulatory rules on the board (`iw reg get`, DE) allow 149–165
without radar detection at 13 dBm; the adapter transmits at 3 dBm anyway.

**A bug found on the way.** The first apply of channel 149 at 80 MHz reverted by itself. `centreChannel` in
`core/generate/hostapd.ts` counted the 5 GHz groups from 36 all the way up, but the plan steps from 144 to 149,
so it wrote `vht_oper_centr_freq_seg0_idx=154` instead of 155. hostapd stopped at `Interface initialization
failed` right after `HT_SCAN`, the address service failed with it, the traffic check failed, and the window
reverted (transaction `8d8cf2fa40bb6b13`). The golden file for the channel-149 scenario had recorded the wrong
centre, so no test caught it. Fixed by counting the upper groups from 149, with a test of the centres and a
check that the test fails on the old formula; deployed as `5929c5d`.

**Trap: the generated hostapd file names the phy.** Its header carries `# Radio: phyN`. After the two driver
reloads above the adapter was `phy3`, so the plan showed the file as changed and wanted to restart the access
point although nothing in the profile had changed. Harmless here, because the channel change rewrote the file
anyway; a reload alone would have shown up as drift.

**As it ran.** Second apply (`ec15607dd9610703`): window open at 16:27:03 with the traffic check `passed` and
the access point `ENABLED` on 149, confirmed at 16:27:05. `iw dev` shows `channel 149 (5745 MHz), width: 80 MHz,
center1: 5775 MHz`. Within a minute five of six clients were back: both iPhones, both Macs and the Yandex
Station Max. The PlayStation (`c8:4a:a0`) was not.

**Measuring on a quiet channel.** With few neighbours the client hears few other beacons, so "other networks
heard" stops telling whether it was on channel. A report also counts as trusted when it carries data frames from
this access point (`rxDataUcastMbss` ≥ 20): data arriving with no beacons is the stall itself.

**Result: no stall in three hours.** From 16:27:05 to 19:28:18 the client logged 1807 reports, own beacons
44.4 per 5 s on average. 28 reports were at 5 or fewer, and every one stood alone between normal reports on
either side, spaced two to four minutes apart: the client's own background scans, not the access point. No two
low reports in a row, and no `beacon loss` or `leaveNetwork` in the client's log
(`/usr/bin/log show --start "2026-10-21 16:27:00" --predicate 'process == "airportd"'`). On 36 the stalls had
come back within six and seven minutes of each of the two earlier changes.

This points at the shared 80 MHz block on 36–48, not at the adapter, the firmware or USB. It is not proof:
three hours is one evening, and the newer firmware and `disable_usb_sg=1` are still on the board, so the
result belongs to the three together. Whether either is needed on 149 is untested.

## The firmware hang of 2026-10-22, 19:28

A different failure from the beacon stalls: everything stopped, not only beacons. Channel 149, firmware
20260224, `disable_usb_sg=1`, adapter at 36 °C, load 0.47, 1.5 GB free, runtime-pm and USB autosuspend off.

| Time | What | Source |
|---|---|---|
| 19:28:50 | every listed client goes silent at once; `rx_packets` stops at 12370693 and does not move again | `inactive_msec` 171908–177128 for all five at 19:31:40; sysfs counters |
| 19:28–19:29 | proxied connections fall from 116 a minute to the 23–28 the board makes itself | `journalctl`, `accepted` lines per minute |
| to 19:34:06 | `tx_packets` creeps up about one a second, nothing received, nothing in the kernel log, hostapd `ENABLED` with five clients, the device still on the bus | `iw`, `hostapd_cli`, `lsusb -t` |
| 19:34:06 | hostapd drops `6e:ab:ba` for 300 s of inactivity | hostapd journal |
| 19:34:10 | `Message 00020003 (seq 3) timeout`, then `timed out waiting for pending tx`, a `kthread_park` warning in `mt76u_stop_tx` from `mt7921u_mac_reset`, and the firmware reloaded | kernel journal |
| 19:34:31 | the radio watch restarts `wf-hostapd@` on the kernel errors; clients rejoin | observer `lastActed` |

**What it shows.** The firmware stopped both the data path and its command channel while the device's USB
side stayed enumerated. The driver noticed only when it next had to ask the firmware something: removing a
station is a firmware command, and it was the first in five minutes. No ssh session to the board ran between
19:32:33 and 19:36:33, so nothing from outside prompted it. The same lines after a speed test on the same
chip are reported in an OpenWrt forum thread, "mt7921u AP mode crashes on 23.05.0"; that thread is not a
measurement of this board. Not established: what inside the firmware stops, and what triggers it — the owner
reports no speed test or other unusual load at 19:28.

**Correction.** In the moment the 19:34:31 restart was taken for a manual one. It was the watch's; the manual
restart came at 19:36:36, with the radio already back, and only made the clients rejoin a second time.

**Why the watch took 5 min 40 s.** It fired on the kernel errors, not on the silence. Its silence rule wanted
neither counter to move for five minutes, and `tx_packets` kept moving. The rule now judges received packets
alone, for a minute.

## What to measure afterwards

| Question | How | Pass |
|---|---|---|
| Does the heatsink help? | adapter temperature idle, then during a sustained speed test, every minute for 10 min | clearly below 76 °C idle, and a plateau under load |
| Is 3 dBm real? | `txpower` cold vs warm; client RSSI at the same spot, built-in radio vs adapter | see below |
| Does the access point work? | throughput, ping loss to the board from a client, the Wi-Fi 6 console joining | no loss, throughput near the earlier 468 Mbit/s |
| Does it hang again? | kernel log for `mt7921u … timeout` / `timed out waiting for pending tx`, daily, for several days | none |
| Does the traffic check revert a broken change? | the live test deferred from the 2026-10-14 session: a network change that breaks traffic which worked before | `apply.data-plane-failed`, reverted, internet back within 1–2 min |

### The 3 dBm question

Three explanations, each with its own test; none is established:

1. **A reporting artefact.** The driver reports one number and transmits at another. Test: client-side RSSI.
   If the adapter is as loud as the built-in radio or louder, the figure is wrong and nothing else is.
2. **Thermal back-off.** The firmware lowers power when hot. Test: `txpower` cold (step 2 above) against warm,
   with and without the heatsink. A figure that falls as the temperature rises answers it.
3. **The regulatory domain.** The adapter applies its own domain, `00`, not the profile's `DE`
   (`iw reg get`, `phy#1`). Test: the per-channel limit under that domain against what hostapd applies.

Whatever the cause, a fix lands in the profile or the generator, never by hand on the board, so it survives a
reboot.

## Also pending on that day

* The radio watch (`access-point-radio`, in place since 2026-10-17) covers the adapter from the moment it hosts
  the access point. If the adapter hangs again, the event log shows `radio.restarted` and possibly
  `radio.usb-rebound` — and the kernel lines are in the journal of that boot: copy them out before it
  rotates, and check the priority they were logged at, which the watch assumes is `err`.
* Every result above goes into [12-hardware-invariants.md](12-hardware-invariants.md) with its numbers and date.

**The flight recorder.** `deploy/radio-blackbox.sh install <ap-interface>` installs
`wayfarer-radio-blackbox.service`, which records, in memory under `/run/wayfarer-blackbox`, one line a second
(counters, the USB device's URB count, the driver's host-side queues, temperature, every client's inactivity and
signal) and the usbmon text trace of the radio's bus. When clients are listed and nothing has been received for
20 s — before the watch's minute — it writes one `.tgz` to `/var/lib/wayfarer/blackbox`, and a second once
packets flow again; the newest 20 are kept, none older than 14 days, at most 200 MB in all, and no new record within 10 min of the last. Sizes, measured on 2026-10-22:
11 MB of memory for the service, about 11 % of one core, nothing on the card in normal running, a few MB per record. One sample took 48 ms on the
board. Only host-side driver files are read: `acq` and `tx_stats` read the chip's registers, and reading a hung
chip could set off the very reset being recorded. `remove` takes it out and keeps the records.

## 2026-10-30: a hang the watch did not see, and a recovery that left clients without addresses

**Symptom.** At about 14:36 MSK the network vanished from every client's list. hostapd reported
`ENABLED` with three stations; the flight recorder took `20261030T143556-silent.tgz` and, at 14:38:14,
`…-recovered.tgz`. Clients were dropped for inactivity at 14:38–14:39. Adapter temperature 36–38 °C
throughout (hwmon `temp1_input`), the board 45–47 °C — heat is not the cause.

**Why the radio watch did nothing.** Its rule was "clients listed and the received-packet counter has
not moved for a minute". The recorder's per-second samples show the counter did move: 17 packets in
about 250 s (rx 67381998 → 67382015), one every 10 to 30 s. Each one reset the minute. The rule now
judges a rate — fewer than 6 packets received over a minute with clients listed is silence — with 6
taken from the earlier 13 h record, in which a working radio never stood still for 10 s
(`core/radio-watch.ts`, `MIN_RX_PACKETS_PER_WINDOW`).

**Why clients then got no address.** Restarting hostapd did not help (tx +3, rx 0 in 10 s); unloading
and loading `mt7921u` did. But the access point's units were `BindsTo=` the interface and
`WantedBy=multi-user.target` only: the reload stopped hostapd and the DHCP/DNS service with the
interface, and nothing started them when it came back, so clients joined and were never answered.
The templates for the access point, its DHCP and the wireless client are now also wanted by their
interface's device unit, and an instance is enabled again when its template is rewritten — `enable`
creates the install links, and an already-enabled instance would otherwise keep the old set.
Verified on the bench by result: after `modprobe -r mt7921u; modprobe mt7921u`, both units were
stopped at 14:56:06 and started on their own at 14:56:11; five clients rejoined and got leases.

## 2026-10-31: the first rung looked like a recovery because nobody could rejoin

**Symptom.** The network vanished again; the last client was dropped at 15:59:17 MSK. The rate rule
from the day before fired: the watch restarted `wf-hostapd@wlx90de8047b4b4` at 16:01:08. hostapd came
back `ENABLED`, but the adapter stayed hung — `rx_packets` stood at 5348665 from 16:02 to past 16:03,
`iw station dump` listed nobody — and the watch reported `enabled, 0 client(s)`, state `ok`.

**Why it stopped there.** After a repair it judged recovery by the same rules as always, and "no
clients" is not a fault under them: an access point nobody uses stands still honestly. But a hung radio
nobody can join also has no clients, so the first rung was always read as a success, the ladder was
reset, and the USB rebind — the rung that works on this adapter — was never reached.

**What changed.** The watch counts the clients listed when the ladder starts. If there were any, and
by the time the rung has settled (`REPAIR_SETTLE_MS`, 2 min) none is listed while hostapd says
`ENABLED`, that is a fault too, and the next rung is taken. A ladder started with no clients listed (a
kernel error at night, say) is not held to it: there is nobody to come back.

**Verified by result.** Unbinding `2-1:1.0` from `mt7921u` and binding it again by hand at 16:03:58 —
what the second rung does — brought the units back on their own, the channel back to 36, two clients
within 20 s and 283 received packets in the next 20 s.

**Still open.** Two hangs on consecutive days in the afternoon (2026-10-30 ≈14:35, 2026-10-31 ≈15:59);
the owner reports a third the day before at about the same time, which the journal no longer holds.
Whether the time of day means anything — a neighbour's load on the channel, a client's schedule — is
not established.
