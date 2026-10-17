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

* The radio watchdog the owner approved on 2026-10-16: restart the access point when the radio stops moving
  frames while hostapd says `ENABLED`, then reinitialise the USB device, and reboot only as a last resort.
* Every result above goes into [12-hardware-invariants.md](12-hardware-invariants.md) with its numbers and date.
