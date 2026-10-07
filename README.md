# Wayfarer

A travel router whose entire network state is **one document** — uplink, access point, addresses,
firewall, routing and tunnels — edited through a web interface the device serves itself, on the access
point it hosts and on the network it is connected to. It configures the hardware it finds rather than
hardware it assumes: radios are asked what they can do, and the answer is enforced instead of hoped for.

One Node.js daemon owns that state. A change is planned, reviewed, applied, and — if it can cost you
your connection to the device — **undone by itself unless you confirm it**.

## The recovery promise, and how it was proved

> **A network change that is not confirmed is undone.**

The budget is **180 seconds** from applying a change to having access back. The confirmation window is
150 seconds, which is the budget minus the 30 seconds a revert is allowed to take, and the window is
derived from the budget in code rather than written down twice.

Four failures were caused deliberately on the board, with the change applied and left unconfirmed each
time. These are measured recovery times, not targets:

| what was done to it | recovered in | what brought it back |
|---|---|---|
| Uplink pointed at a network that does not exist | **50.5 s** | the health check, before the deadline |
| Daemon killed with `SIGKILL` | **14.4 s** | systemd restarted it; the start-up sweep reverted |
| Daemon **stopped**, so only the timer outside it could act | **170.0 s** | the transient `systemd-run` timer |
| Hard reset — `echo b > /proc/sysrq-trigger`, no clean shutdown, no unmount | **48 s** to answer | the start-up sweep |

The third row is the worst case and the one worth reading twice: **170.0 s against a 180 s budget**, with
the daemon deliberately stopped so that nothing inside the process could help. That is why the revert
timer lives outside the daemon as a transient systemd unit — an in-process timer dies with the process
that broke the network.

The fourth row is the cover for a machine that dies inside the window: an unconfirmed transaction is
found at start-up and reverted. No timer survives a power cut; a row in the database does.

Sitting behind all of it, on the bench, is a deadman that restores a known-good configuration and
reboots if everything above fails — see [docs/15](docs/15-bench-safety-net.md). It is a bench tool, not
part of the product.

## Where the panel answers

| surface | |
|---|---|
| the access point this device hosts | always |
| the network this device is connected to | by default; a setting in the profile turns it off |
| the device itself | always |
| a tunnel | never, and there is no setting |

The second row is a choice with a cost, and the interface states it in words rather than with a warning
symbol: at home that network is yours and reaching the panel from a laptop on it is what you want; in a
hotel it is the hotel's, and everyone else there is on it too. What stands behind leaving it on is a
required password, a lockout after repeated failures that a wrong clock cannot clear, and a machine API
that is off until you turn it on — not any assumption that the network is safe.

Nothing here exposes the proxy's own control interface, which never leaves loopback.

## What it needs

A 64-bit ARM single-board computer running Debian 13 — measured on **Armbian (Debian 13 "trixie"),
kernel 6.18.49-current-sunxi64** — and these:

```
apt-get install --no-install-recommends \
  hostapd wpasupplicant dnsmasq-base nftables iw iproute2 openvpn
```

**Those package names are not the binary names**, which is where a stranger loses the first five
minutes. Measured with `dpkg -S`:

| binary | package |
|---|---|
| `dnsmasq` | **`dnsmasq-base`** |
| `wpa_supplicant` | `wpasupplicant` |
| `nft` | `nftables` |
| `ip` | `iproute2` |
| `hostapd_cli` | `hostapd` — same package, different binary |
| `systemd-run` | `systemd` |

Two things are **not installed for you**, and will not be downloaded by the daemon under any
circumstances:

- **`sing-box`** — the data plane, needed for every tunnel type it speaks natively. Put the release
  binary at `/usr/local/bin/sing-box`. Everything here was run against **1.14.0**; the generated
  configuration is validated against the schema the installed binary emits, so a different version is
  checked rather than assumed.
- **`xray`** — only needed for tunnels that run another client behind a local SOCKS port.

The daemon never fetches an executable. Choosing a version of something that will run as root on your
network is a decision for a person. The device reports each gap on its own diagnostics screen with the
command that closes it, and says plainly when there is no command — a radio whose driver does not report
AP mode cannot be fixed by installing anything.

Node 24 is installed into `/opt` by `deploy/install.sh`.

## What the kill-switch does and does not cover

It **does** stop traffic being forwarded from your local network out to the uplink around the tunnel
software — a rule in the `forward` chain, rejecting only *new* connections, so turning it on breaks
nothing already running.

It **does not** stop traffic the tunnel software itself sends out. That traffic leaves through the
`output` chain, where the device's own packets are marked rather than rejected. So a kill-switch combined
with "keep passing traffic when every tunnel is down" is a kill-switch that will not hold in the more
likely of the two failures — and that combination is **refused**, in those words, rather than quietly
accepted. Deciding between the two losses is yours: everyone offline, or everyone unprotected without
being told.

## Which tunnel kinds have actually been run

Against real peers, on the board:

- **OpenVPN**, against a real OpenVPN **2.6.14** peer pushing `redirect-gateway def1`,
  `dhcp-option DNS` and a route for the management network — which is how the routing exclusion and the
  pushed-route rules came to be written the way they are.
- **An external client behind a local SOCKS port**, with a process that really listens.
- **A pluggable transport**, with a script that really listens on its port.

Everything else the schema accepts is **untested**, not supported. The generated configuration is
validated against the schema the installed `sing-box` binary emits, so a configuration it would reject
is refused before anything restarts — but validation is not the same as a connection to a real endpoint,
and this README will not pretend otherwise.

## State of the evidence

This matters more than any feature list, so it is here rather than only in `docs/`.

### Proven on hardware

- The four recovery scenarios above, with the measured times.
- Safe mode, entered by **causing** three consecutive apply failures rather than by calling the
  function; and factory reset, run for real, with the full circle back to a working device.
- Failover: a selector moved between tunnels with nothing restarting, the fallback reached when every
  tunnel failed, and the path **back out** of the fallback — which was broken, and was found by asking
  whether anyone had ever seen it work.
- A probe destination blocked for every path except the probe's own, with the probe still measuring
  through it.
- Boot reproducibility: the device re-derives its own generated state across a reboot and reports what
  changed.
- Refusals seen firing: a foreign proxy core, an interface another manager already configures, a
  deadman with no snapshot, a deploy to an unreachable device, a malformed measurement series.
- OpenVPN, one external SOCKS client, one transport — as above.
- **A real client, over the air, end to end — 2026-09-21, 5 GHz channel 36.** A phone associated to the
  access point on the USB radio and reached the internet. This is the one claim no bench probe on the
  board could establish, because a process on the device is not a client, and it settles a set of them
  together: the access point on the USB radio at **5 GHz** (the harder band, and the one a world
  regulatory domain forbids until a country is established), the address service, the resolver that now
  exists on the device's own address, the connectivity-check block scoped so it no longer makes a working
  network report itself as dead, the forwarded-client path under the **host** network stack, and the
  direct egress policy. Observed from the client, not inferred from the board.

### Covered by tests only

- Every tunnel protocol and transport the schema accepts, apart from the three named above.
- The kill-switch with fail-open refusal: correct in tests, never applied to the board.
- Safe mode's fallback for a device whose radio cannot host an access point — unreachable on a board
  whose radio can.
- The platform layer, against captured real output of `ip -j`, `iw phy`, `nft -j` and `hostapd_cli`,
  including truncated replies and drivers that omit fields. These are real recordings, but they are
  recordings.

### Not known

- **It has run on one device.** One Orange Pi Zero3, one Debian 13 image, one built-in radio and one USB
  radio. Every hardware number in this repository comes from that board. There is no list of supported
  boards because there is no evidence for one.
- **No throughput figure exists.** It has never been measured on this build. An estimate would be worse
  than the silence.
- **No multi-day window.** The longest continuous measurement is **1.86 hours**, with daemon
  restarts from every deploy inside it. A leak that takes a day to show would not have appeared.
- **No sustained-traffic window.** Memory was measured with tunnels configured and probed, not with
  clients pushing traffic for hours — which is the measurement most likely to move the numbers.
- **Two things a person must still do**, and they are the last two items on the list: a **real power
  cut**, pulled at the wall rather than simulated with `sysrq`; and an **Ethernet uplink takeover**,
  where the device takes over the interface it is being managed through. Both need somebody in the room
  with the board.
- Unobserved refusals, each recorded with the reason it could not be triggered, in
  [docs/16](docs/16-implementation-notes.md#predicates-that-gate-rare-actions-and-whether-anyone-has-seen-them-fire).

Every number in this repository carries the window it came from, including the awkward ones. Where a
figure came from fifty minutes of sampling, it says fifty minutes.

## The catalogue, and why it is the most useful thing here

[docs/16-implementation-notes.md](docs/16-implementation-notes.md) holds a catalogue of the way this
project fails:

> A check that describes the truth instead of deriving it from the truth will eventually describe a
> truth that has changed, and it will keep passing while it does.

It reads like a list of mistakes and that is not what it is for. **A failure mode written down as a
*class* becomes a question you can ask of code that is currently passing every test.** The clearest
instance: a deadline recorded in one place while systemd acted on another was understood as a class
rather than as a bug in a script, which made the next question obvious — *where else is a deadline
recorded that something else maintains?* The answer was the confirmation window's own revert timer. It
had the identical defect, had never failed a test, and was silently postponing the one promise this
project makes, by up to the whole window, every time an apply installed a unit.

It was found by looking. If you take one thing from this repository, take that.

## Design

| | |
|---|---|
| [01-scope](docs/01-scope.md) | what this is for, and what it refuses to be |
| [02-architecture](docs/02-architecture.md) | pure planner, pure differ, reconciler, platform layer |
| [03-data-model](docs/03-data-model.md) | the profile document, device identity, peers |
| [04-tunnels-and-protocols](docs/04-tunnels-and-protocols.md) | providers, transports, rule sets |
| [05-platform-layer](docs/05-platform-layer.md) | the only code that knows about the operating system |
| [06-apply-and-rollback](docs/06-apply-and-rollback.md) | blast radius, the confirmation window, the revert |
| [07-api](docs/07-api.md) | routes, scopes, errors |
| [08-ui](docs/08-ui.md) | generated forms, the event ring, plain-words choices |
| [09-stack](docs/09-stack.md) | dependencies, and the shipped limits with their evidence |
| [10-security](docs/10-security.md) | secrets, sessions, expiry on a device with no clock battery |
| [11-deployment](docs/11-deployment.md) | the installer and the update path |
| [12-hardware-invariants](docs/12-hardware-invariants.md) | facts about this board, each with its measurement |
| [13-plan](docs/13-plan.md) | the epics |
| [14-open-questions](docs/14-open-questions.md) | decisions deliberately not made yet |
| [15-bench-safety-net](docs/15-bench-safety-net.md) | the deadman and the soak, for development |
| [16-implementation-notes](docs/16-implementation-notes.md) | the catalogue, and every trap found |

## Working on it

```sh
pnpm install
pnpm test          # 622 tests, no hardware needed
pnpm typecheck
pnpm build
WAYFARER_HOST=root@<device> WAYFARER_SSH_KEY=~/.ssh/id_ed25519 ./scripts/deploy.sh
```

The deploy arms the bench deadman before it copies anything and disarms it only after the daemon has
answered. It refuses if the device has no known-good snapshot, and it will not take one for you: a
snapshot is a claim that the configuration is good.

## Licence

MIT. See [LICENSE](LICENSE).
