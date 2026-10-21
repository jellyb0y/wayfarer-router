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

**Result.** Pending.

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
