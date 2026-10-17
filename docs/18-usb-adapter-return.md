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

### A trap found before applying: the inactive profile had gone stale

The first plan for the original profile also rewrote `/etc/wayfarer/socks/claude-1.json` and restarted
`wf-socks@claude-1`. Nothing about the radio explains that. A diff of the two stored documents showed why:
while the copy was active, the subscription refresh of 2026-10-17 14:51 updated `claude-1`'s `realityShortId`
in the copy, and the original kept the value from 2026-10-16. Its own last refresh, at 06:58 that day, had
failed with "the refreshed profile does not plan" because the adapter had already been unplugged. Applying it
as it stood would have put a node parameter the provider no longer serves back on a Claude tunnel. Traffic
would not have left the tunnel, because the `claude` group has no `direct` member, but one of its two tunnels
would have stopped working.

The fix was data, not code. The original's `groups` were replaced with the copy's through
`PUT /api/profiles/:id`, with `{"$keep": true}` at every secret position. Before that, the stored secrets of
both documents were compared on the board by hash, and all 17 were equal. The next plan no longer touched
`claude-1`.

**Rule for every switch back to a profile that sat inactive:** read its plan, and if it touches anything the
switch is not about, diff the stored documents before applying. Refreshes write only to the active profile.

### What this settles about 3 dBm

The figure is there **at 34 °C**, a minute after the radio started. **Explanation 2 (thermal back-off) is
ruled out** as the cause of the figure itself: it does not wait for heat.

Explanation 3 does not match the board as it is now either. `iw reg get` lists only `phy#0`, the built-in radio,
as self-managed with domain `00`. The adapter (`phy1`) follows the global `DE`, and its channel 36 limit is
23 dBm (`iw phy phy1 info`). That leaves explanation 1, a reporting artefact, or something in how the driver
applies the limit. Client-side RSSI is the test that is still open.

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
