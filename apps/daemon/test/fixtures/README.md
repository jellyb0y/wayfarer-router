# Parser fixtures: where each one came from

A parser that has never seen real output is worse than no parser, so every fixture
here is captured from running hardware unless the table says otherwise. Provenance is
recorded per file because the value of a fixture is entirely in whether it is real.

Captured on 2026-09-19 from the bench board: Orange Pi Zero3, Armbian (Debian 13
trixie), kernel 6.18.49-current-sunxi64, `iw` 6.9, iproute2 6.15.0, nftables 1.1.3,
hostapd 2.10, wpa_supplicant 2.10, systemd 257.13, 4 cores, 1973 MB RAM. Two radios:
`phy1` is the built-in radio (a platform device), `phy0` is a USB radio which was
hosting the access point at capture time.

| File | Command | Real? | Why it is interesting |
|---|---|---|---|
| `iw/phy-two-radios.txt` | `iw phy` | yes, verbatim | Two radios with different capabilities; non-contiguous band numbering (1, 2, 4); wrapped interface-combination lines; `(radar detection)` and `(no IR)` frequency flags; disabled frequencies with no power figure. `iw list` produced a byte-identical 26568 bytes. |
| `iw/reg-get-global-and-phy.txt` | `iw reg get` | yes, verbatim | A `global` block plus a per-phy override with a *different* country and different power limits — and one existing phy missing from the output entirely. |
| `iw/dev-ap-and-managed.txt` | `iw dev` | yes, identifiers replaced | Contains an `Unnamed/non-netdev interface` entry with no interface name at all (a P2P device), which breaks any parser that assumes a name. |
| `iw/dev-info-managed.txt` | `iw dev wlan0 info` | yes, identifiers replaced | A client interface: no channel block on this driver. |
| `iw/dev-info-ap.txt` | `iw dev wlanap info` | yes, identifiers replaced | An access-point interface: channel, width, `center1`, txpower, and a multicast TXQ table underneath. |
| `iw/dev-link-connected.txt` | `iw dev wlan0 link` | yes, identifiers replaced | Associated client with signal, byte counters and a VHT bitrate line carrying MCS, width and NSS. |
| `iw/station-dump-empty.txt` | `iw dev wlan0 station dump` | yes, empty file | **Empty output from an associated, traffic-passing interface.** The driver does not populate this report. Empty is not an error and not "no peers". |
| `iw/station-dump-two-clients.txt` | `iw dev wlanap station dump` | yes, identifiers replaced | **Two real clients.** One negotiated VHT (`234.0 MBit/s VHT-MCS 3 80MHz VHT-NSS 2`), the other HT with **no width and no NSS** (`26.0 MBit/s MCS 3`) — the shape the earlier synthetic fixture was guessing at. Per-chain signal in brackets, `last ack signal:` printed with no space after the colon, and a label containing brackets (`associated at [boottime]`). |
| `ip/link.json`, `ip/addr.json`, `ip/route.json` | `ip -j link/addr/route show` | yes, identifiers replaced | Seven links including tun devices with `link_type: none`, an Ethernet link in `NO-CARRIER`, `altnames`, and a default route with a metric. |
| `nft/list-ruleset.json` | `nft -j list ruleset` | yes, table names and comments replaced | Four tables in one family, only some of which could be ours. This is the fixture behind "never flush the whole ruleset". |
| `hostapd/status-ap-5ghz.txt` | `hostapd_cli -i <ap> status` | yes, identifiers replaced | A live 5 GHz access point: `cac_time_left_seconds=N/A`, per-BSS indexed fields, VHT operating width. |
| `hostapd/all-sta-empty.txt` | `hostapd_cli -i <ap> all_sta` | yes, empty file | No clients associated: an empty reply, which must not be confused with a truncated one. |
| `hostapd/all-sta-two-clients.txt` | `hostapd_cli -i <ap> all_sta` | yes, identifiers replaced | The same two clients, 1597 bytes — comfortably under the truncation limit, so this is the "complete reply" case against which truncation is judged. Carries the RSN counters, `supp_op_classes`, capability words and `*_rate_info` fields. |
| `hostapd/all-sta-two-clients-usb-radio.txt` | `hostapd_cli -p /run/wayfarer/hostapd -i <ap> all_sta` | yes, addresses replaced | Captured 2026-09-23 from the access point on the USB radio: exit 0, 7 ms, 1755 bytes, two stations, the same two `list_sta` and `iw station dump` named. Only the second station carries `supp_op_classes`, and both carry `sae_group`, `min_txpower`/`max_txpower` and `ext_capab`. **A whole reply** — the fixture behind the Clients screen no longer calling an unfinished list what is a finished one. |
| `hostapd/list-sta-two-clients.txt` | `hostapd_cli -i <ap> list_sta` | yes, identifiers replaced | One address per line: the reply the truncation fallback iterates over. |
| `hostapd/sta-one-client-vht.txt`, `hostapd/sta-one-client-ht.txt` | `hostapd_cli -i <ap> sta <mac>` | yes, identifiers replaced | The per-station reply the fallback assembles from, one for each of the two clients. |
| `hostapd/subscriber-events.txt` | `hostapd_cli -i <ap>` with stdin held open | yes, identifiers replaced | **A real association and disassociation** through the long-lived subscriber: banner, `Interactive mode`, the prompt, then `AP-STA-CONNECTED`, `EAPOL-4WAY-HS-COMPLETED` and `AP-STA-DISCONNECTED`. Everything the tool writes to stdout, because that is what the reader receives — including the prompt that shares a line with the first event. |
| `hostapd/status-ap-5ghz-with-clients.txt` | `hostapd_cli -i <ap> status` | yes, identifiers replaced | The same access point with `num_sta[0]=2`. |
| `hostapd/all-sta-truncated.txt` | — | **synthetic** | A reply cut off **mid-line**, at 3999 bytes, ending in `sup` — a partial key with no `=`. The control interface truncates near 4 KB *silently*, and no bench capture could produce it without many associated clients. |
| `hostapd/all-sta-truncated-midfield.txt` | — | **synthetic** | The dangerous shape: the cut lands **inside a value** (`signal=-5` where the full value was `-54`), so the record parses cleanly and is simply wrong. This is why truncation is detected from the reply as a whole and the parsed list is discarded rather than repaired. |
| `systemd/show-hostapd-instance.txt` | `systemctl show hostapd@<if>.service` | yes, identifiers replaced | A template instance: properties containing `=` inside their values, which is why the parser splits on the first `=` only. |
| `systemd/timedatectl-show.txt` | `timedatectl show` | yes, verbatim | `NTPSynchronized=yes` on a board with no clock battery. |
| `journal/journalctl-json-3-lines.json` | `journalctl -o json -n 3` | yes, identifiers replaced | Microsecond timestamps as decimal *strings*, `__CURSOR`, `_BOOT_ID`. |
| `openvpn/status-*.txt` | the client's `status <file> 5` output, copied at intervals | yes, verbatim | OpenVPN 2.6.14 (Debian trixie, 2026-09-24) against a local 2.6.14 server pushing `ping 15`, `ping-restart 120`. `t0` is the first write (all zero), `t20`/`t40` idle (4927 → 5039: the server's keepalive), `silent-t30`/`silent-t60` with the server's UDP dropped (5363 twice). The fixture behind the keepalive reading in `core/liveness.ts`. |
| `openvpn/up-env-*.txt` | `env \| sort` from the `--up` script | yes, throwaway PKI | Without a `route` line of our own there is no `route_vpn_gateway` (`subnet-no-route-line`); with one it is `10.136.0.1` (subnet) or `10.136.0.5` (net30). Run through the shipped `tunnel-up` in `guard-liveness.test.ts`. |
| `openvpn/push-reply-subnet.txt` | the client's log line | yes | The PUSH_REPLY carrying `route-gateway 10.136.0.1` that the environment did not. |
| `core-api/connections-*.json` | `GET /connections` | yes, verbatim | sing-box 1.14.1: `chains` lead with the carrying outbound; `active-t0`/`t10` grow (7788224 → 13636696), `stalled-t0`/`t10` do not (4247568 twice, a 20 KB/s reader behind 4 MB of buffers) — the fixture behind "only growth counts". |
| `core-api/delay-*.txt` | `GET /proxies/<name>/delay` | yes, verbatim | 200 / 503 (dead outbound) / 504 (timeout) / 404 (no such outbound), and `delay-http-url-ignored.txt`: an `http://` URL is replaced by the core's default `www.gstatic.com:443`. |

## What was replaced, and why

Network names, MAC addresses and unit names belonging to unrelated software running on
the bench board are replaced with neutral placeholders, consistently across files, so
these fixtures can be published. Structure, field order, whitespace, empty values and
oddities are untouched — those are the whole point. Where a value was replaced the
replacement keeps the original's shape (a MAC is still a MAC, an SSID is still a
string that needs no quoting).

## What is still synthetic, and why

Exactly one fixture: `hostapd/all-sta-truncated.txt` and its mid-value variant. Reproducing the
~4 KB truncation needs roughly thirty associated clients, which a bench does not have, so those two
files are cut from generated records. They are labelled synthetic here and in the test names, and
what they exercise is the truncation *boundary* — a record cut mid-line and a record cut mid-value —
rather than any claim about what a driver prints.

Everything else on this page is a real capture. The station fixtures were taken on 2026-09-19 with
two devices associated to the bench access point.

## The client addresses are substituted, and they were random to begin with

The two client addresses are replaced with `aa:bb:cc:00:0d:01` and `aa:bb:cc:00:0d:02`, consistently
across every file, and the access point's own address and both network names are replaced as
described above. No hostname appears in any of these reports, so none needed replacing.

Worth knowing for anyone reading the capture: the addresses in the original output were already
randomised by the client devices themselves — the same phone appeared under two different addresses
across two associations, which is why the event log and the station dump do not share an address.
That is a property of modern clients, not an artefact of the redaction, and any code that treats a
station address as a stable identity for a device will be wrong about it.

## Which counters each radio on the bench actually populates

Measured 2026-09-19 with the commands shown. This is the evidence behind representing an
absent counter as absent rather than as zero: collapsing the two makes a radio that cannot
report a counter indistinguishable from a perfect link.

```
iw dev wlan0 link          # built-in radio, phy1, associated as a client
iw dev wlan0 station dump  # same interface, same moment
iw dev wlanap station dump # USB radio, phy0, hosting the access point
hostapd_cli -i wlanap all_sta
```

| Report | Built-in radio (`phy1`) | USB radio (`phy0`) |
|---|---|---|
| `iw dev <if> link` while associated | present: `signal`, `freq`, `SSID`, `RX`/`TX` byte and packet counters, `tx bitrate` with `VHT-MCS 9 80MHz VHT-NSS 1` | not applicable: no client interface on this radio |
| `rx bitrate` in `link` | **absent entirely** | not applicable |
| `iw dev <if> station dump` | **empty output**, while associated and passing 1.9 GB of received traffic | **fully populated** with two clients: 31 labelled fields per station |
| `tx retries`, `tx failed` in `station dump` | not reported at all (the whole report is empty) | **present**, both `0` while the link was healthy |
| `signal` / `signal avg` in `station dump` | not applicable | present, with a per-chain breakdown in brackets: `-78 [-81, -81] dBm` |
| `tx bitrate` width and NSS | not applicable | present for the VHT client, **absent for the HT client** — same driver, same command, same moment |
| `connected time`, `authorized`, `authenticated` | not applicable | present |
| `hostapd_cli all_sta` | not applicable | present: 1597 bytes for two clients, with RSN counters and `*_rate_info` |
| `hostapd_cli status` | not applicable | present: `state`, `freq`, `channel`, VHT width, `max_txpower`, per-BSS fields; `cac_time_left_seconds=N/A` |

Two conclusions the code depends on:

* A driver returning **nothing** from `station dump` is a real state, not an error and not
  "no peers". The built-in radio does it while the link is up and carrying traffic.
* A field that a driver does not print is unknown. `rx bitrate` above is the concrete
  example: the built-in radio reports a transmit rate and no receive rate, so a status view
  that defaults a missing rate to zero shows a working link as a broken one.

Measured with two clients associated, 2026-09-19: **this radio does populate the retry counters**,
and both read `0` on a healthy link. So a zero here is a real measurement on this driver — which is
precisely why the parser must not invent one on a driver that prints nothing. The absent-not-zero
discipline survives contact with the data for a second reason found in the same capture: the HT
client's rate line carries no width and no spatial-stream count while the VHT client's does, from
the same driver at the same moment. A parser that defaulted either to zero would report a working
client as being on a 0 MHz channel.
