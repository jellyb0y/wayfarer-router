# 5. Platform layer

The only module that knows an operating system exists. Everything above it takes
and returns plain data. Recommendations below come from a survey of what is
actually maintained in 2026; package versions are from Debian 13.

## Interface shape

```ts
interface Platform {
  systemd: { start; stop; restart; enable; disable; isActive; isEnabled;
             show; watch(unit): AsyncIterable<UnitState> }
  net:     { links(); addresses(); routes(); watch(): AsyncIterable<NetEvent> }
  wifi:    { phys(); scan(iface); connect(iface, cfg); signal(iface);
             watch(): AsyncIterable<WifiEvent> }
  ap:      { status(iface); stations(iface); watch(iface): AsyncIterable<ApEvent> }
  nft:     { check(ruleset); apply(ruleset); list() }
  files:   { readManaged(path); writeAtomic(path, content, mode, owner) }
  clock:   { status(); resync() }
  binaries:{ detect(name): { path, version, features } | null }
}
```

Every method is either a query or a mutation, never both, and mutations are only
ever called from the reconciler.

## systemd

**Use D-Bus for state and events; use the CLI for enable and disable.**

The maintained pure-JavaScript D-Bus binding is `dbus-native` (sidorares), which
returned to active development in mid-2026 — 0.10 to 0.15.2, TypeScript
definitions included, a promise API, and a type generator from introspection. It
needs Node 22.12 or newer, which the chosen runtime satisfies. Two alternatives
were considered and rejected: `dbus-next` has had no release since 2021, and going
through `sd-bus` with an FFI layer buys nothing here.

Why not simply shell out to `systemctl` for everything: the CLI gives no events,
so unit state would have to be polled, and `systemctl show` ignores
`--output=json`, which means parsing key-value text. Events matter because the
interface should show a tunnel dropping the moment it drops.

Why still use the CLI for `enable`/`disable`: the D-Bus methods for these are
awkward and the CLI is exact, and these are rare operations where latency is
irrelevant.

One trap in the D-Bus path: `StartUnit` returns a *job* object, not a result. The
call succeeding means the job was queued. Waiting for the `JobRemoved` signal with
the matching job path is what tells you whether the unit actually started.

Two ordering rules that belong in the reconciler, not here, but are worth stating
next to the API that makes them possible:

* Enable before restart. A restart that fails aborts a sequence, and if enable has
  not happened yet the unit is left disabled — a fault that only appears after the
  next reboot. Check both `is-active` **and** `is-enabled` when verifying.
* A unit whose configuration names a network interface needs a dependency on that
  interface's device unit plus `Restart=on-failure`, because it can otherwise start
  before the interface has an address and fail permanently.

## Network state

**`ip -j` for reading, `ip monitor` as a change trigger.**

iproute2 6.15 emits JSON for the queries we need, which removes a whole class of
text-parsing bugs. Netlink bindings for Node were examined and none is viable: the
most promising is at 0.3.0 from 2023, is a native addon, and is described by its
own author as early stage.

`ip monitor` is used only as a *signal that something changed*, debounced, after
which the full state is re-read with `ip -j`. Parsing the monitor stream itself is
not reliable across versions, and a full re-read is cheap at this scale. This also
makes the code idempotent against missed events.

## Wi-Fi

Three different mechanisms, because no single one covers the need.

**Control and events: `wpa_cli` on our own control socket.**

An earlier revision of this document said *"wpa_supplicant over D-Bus
(`fi.w1.wpa_supplicant1`) — the Debian unit already runs with the D-Bus interface
enabled"*, and that is exactly why it does not work.

**Measured on the board:** `wf-supplicant@wlan0` failed with
`dbus: Could not request service name: already registered`. The distribution's own
`wpa_supplicant.service` (PID 687, started with `-u`) owns `fi.w1.wpa_supplicant1`,
and **that name has exactly one owner on a system**. It is a namespace, and this
project does not share a namespace.

Three alternatives were rejected, each with its cost:

* *Stop the foreign unit.* It is not per-interface, so it affects radios no profile
  mentions — a device could lose a wireless connection this project was never asked
  to touch.
* *Drop `-u` from the foreign unit and poll.* Loses the event source, and edits
  somebody else's unit.
* *Declare wireless uplinks unsupported.* Not a serious answer for a travel router.

**The ruling: do not contend for a global name, take our own.** Our supplicant runs
**without `-u`**, writes its control socket to `/run/wayfarer/supplicant`, and is read
with `wpa_cli` — exactly as the access point is read with `hostapd_cli`, and with the
same four hard-won details: no empty interface argument, `-p` before `-i`, stdin held
open, the banner ignored rather than counted. Nothing foreign is stopped, masked or
contended for.

The objection recorded against the control socket — that it is a Unix *datagram*
socket and would need a native module — is answered by not opening it ourselves.

**Proved on hardware:** `wpa_state=COMPLETED`, `ssid=VINTAGE ` read back through our
own socket, `key_mgmt=WPA2-PSK`, `ip_address=192.168.77.8`.

### The SSID is written in hexadecimal, and the key is derived

The bench network is `VINTAGE ` — with a trailing space. **An SSID is 32 bytes of
anything**, and only the hex form carries every byte unambiguously; the readable form
goes above it as a comment with the space spelled out as `␠`. This is not a way around
the trailing-space problem, it is the encoding that does not have one. Confirmed on the
device: `ssid=56494e5441474520`, final byte `20`. The plan's diff reads
`associates wlan0 with "VINTAGE␠", 8 bytes (␠ marks a space…)`.

**The passphrase is derived, not copied.** `psk=<64 hex>` from PBKDF2 over the
passphrase and the SSID, so there is no quoted string to escape and the operator's
passphrase never reaches the card. Checked against the IEEE 802.11i test vector.

**Signal quality: `iw dev <if> link` and `iw dev <if> station dump`.** Neither the
control socket nor the D-Bus interface exposes signal strength, negotiated rate, MCS
index or channel width. `iw` has no JSON output, so this is text parsing — kept in one place, with
fixtures, and treated as best-effort: fields missing on some drivers must not break
the caller.

**Capabilities: `iw phy`.** Per-radio bands, channels with their DFS and
no-initiate-radiation flags, HT/VHT/HE capabilities, antenna masks, and — the part
that matters most — the interface combinations. See
[12-hardware-invariants.md](12-hardware-invariants.md).

Rejected: NetworkManager, because it takes ownership of interfaces we need to drive
directly. `iwd` has the cleanest D-Bus API of the three and is a reasonable
fallback, but its access-point mode is weaker.

Two operational cautions:

* **Scanning on a radio that is hosting an access point interrupts that access
  point.** A scan triggered from the interface while clients are connected is
  visible to them. Scan requests must be gated on whether the target radio carries
  an AP, and the interface must say why it is refusing.
* The wpa_supplicant control socket is a Unix **datagram** socket, which Node does
  not support natively. Reaching it needs a native module, and the ready-made
  wrappers are long abandoned. This is a second reason to go through D-Bus.

## Access point

**hostapd has no D-Bus interface** — the D-Bus support in that source tree is built
only for wpa_supplicant — and there are no usable Node libraries. So:

* **Events:** run `hostapd_cli` as a long-lived child process subscribed to the
  control socket, and read `AP-STA-CONNECTED` / `AP-STA-DISCONNECTED` from its
  output. This turns client arrival and departure into events.
* **Periodic state:** `all_sta` for the station table. Its reply is truncated at
  roughly 4 KB, so with many clients the `STA-FIRST` / `STA-NEXT` iteration must be
  used instead. A naive `all_sta` silently returns a short list.
* The configuration must define a control interface path, or none of this works.
* A `hostapd_cli` invocation with an empty interface argument hangs forever rather
  than failing. Any code path that can produce an empty interface name must be
  eliminated, and calls need a timeout.

## Firewall

**Generate a ruleset file, validate it, apply it atomically.**

```
nft -c -f <file>     # check only — no changes
nft -f <file>        # apply as one transaction
nft -j list ruleset  # read back as JSON
```

`nft -c -f` before `nft -f` is the single most valuable habit here: a syntax error
in a generated ruleset is caught before anything is touched.

Two rules about the ruleset itself:

* **Never `flush ruleset`.** The proxy core creates its own table when it manages
  redirection, and a global flush removes it, silently disabling tunnelling on any
  restart of the firewall service. Use the `table` / `delete table` / `table`
  idiom to recreate only the tables this project owns.
* **A snapshot of the live ruleset is not a rollback plan.** `nft -s list ruleset`
  output that includes another program's tables cannot be re-applied cleanly.
  Rollback re-applies *our generated file* for the previous profile, which we
  already have.

`libnftables` through an FFI layer was considered and is only worth it for hundreds
of updates per second, which is not this workload. Frequent, small changes — a
blocklist, for example — belong in named sets whose elements are updated instead of
regenerating the ruleset.

## Atomic file writes

Configuration files are written by creating a temporary file **in the same
directory as the target**, syncing it, renaming, and syncing again.

This is not pedantry. `/tmp` is a tmpfs, so a temporary file created there is on a
different filesystem, and moving it to `/etc` is a copy followed by an unlink — not
an atomic rename. Losing power during that copy leaves a truncated configuration
file, and a truncated core configuration means the core does not start: the device
comes up with an access point and no tunnel, which is the worst of both outcomes
because it looks like it is working. The sync before the rename is needed because
the root filesystem is mounted with a long commit interval, so the rename can
otherwise reach the card before the content does.

`files.writeAtomic` is the only sanctioned way to write a managed file.

## Binary detection

```ts
binaries.detect("sing-box")  // → { path, version: "1.14.0", features: […] }
```

Cores are installed by the installer, never by the daemon. Detection exists so the
interface can say "this tunnel type needs a core that is not installed, here is the
command" instead of failing at apply time with something cryptic. For the proxy
core, detection also fetches and caches the JSON Schema keyed by version and build
tags — the mechanism described in
[04-tunnels-and-protocols.md](04-tunnels-and-protocols.md).

## Facts about the running system

Two readers exist only to feed invariant checks, and they live here because reading them
means knowing what an operating system looks like. Everything above takes the result as
plain data, which is what lets each refusal be reproduced from a fixture instead of from
a board in a particular state.

**Foreign proxy cores.** Candidate unit names are asked about by name rather than found
by scanning every unit: a scan on a device with 200 units is expensive, and the case that
matters is a distribution's own unit for the same binary. The candidate list is
configuration, because which cores exist is not something this project should claim to
know. Only the *active* state is consulted — a core that is installed and stopped
contends for nothing.

**Interfaces another manager claims.** Configuration directories are given by the caller,
for the same reason: a hardcoded list would be a claim about which distribution this is.
The name extraction is deliberately **over-inclusive**, and that asymmetry is the design.
This feeds a refusal, so a false positive costs an operator being told to look at a file —
annoying, recoverable in one step. A false negative is two managers configuring one
interface, which is a device nobody can reach.

Both are detection only. Taking an interface over belongs to the layer that has a
confirmation window to survive it going wrong.

Note the shape this shares with the listener rule: a directory that does not exist is not
a claim, and neither is a read that failed. Here the two may be treated alike, because the
consequence of missing a claim is a refusal that does not happen rather than a teardown
that does. That is the opposite of the listener case, and the difference is worth stating
rather than inferring.

## Privileges

**One root daemon with a hard systemd sandbox**, not a privileged helper with an
unprivileged main process.

The reasoning is that the required capability set — `CAP_NET_ADMIN`, `CAP_NET_RAW`,
writing configuration under `/etc`, root-owned control sockets, and managing units
— is effectively all of network root. Splitting it adds an IPC boundary and a
serialisation format without reducing what an attacker who wins gets. This is also
what the comparable system daemons do.

The sandbox is where the actual reduction lives: `NoNewPrivileges`, an explicit
`CapabilityBoundingSet` with matching `AmbientCapabilities`, `ProtectSystem=strict`
with a narrow `ReadWritePaths`, `RestrictAddressFamilies` including `AF_NETLINK`, a
system call filter, and `WatchdogSec`.

One incompatibility to remember: `MemoryDenyWriteExecute=yes` cannot be used, because
the JavaScript engine needs writable-executable pages.

A setuid helper is the worst of the options — it conflicts with `NoNewPrivileges`.
If a privilege split is ever wanted, it should be a separate service behind a Unix
socket with peer credential checks, not setuid.
