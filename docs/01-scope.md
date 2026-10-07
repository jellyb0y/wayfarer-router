# 1. Scope

## The problem

Building a tunnelling router on a single-board computer is well-trodden ground
right up to the moment you want to *operate* it. The pieces all exist — sing-box
routes and speaks modern proxy protocols, hostapd runs the access point, dnsmasq
hands out addresses, nftables does NAT and the kill-switch, OpenVPN and its
pluggable transports handle the tunnels those protocols cannot — and every one of
them is configured by editing a file and restarting a unit.

That is fine on a desk with an SSH session open. It is not fine for a device you
carry, where the configuration you want depends on where you are.

Two gaps in particular motivate this project.

**Proxy dashboards cannot configure a router.** sing-box exposes a Clash-compatible
API and there are good dashboards for it. Probed on a running instance, the entire
mutable surface of that API is:

```
port, socks-port, redir-port, tproxy-port, mixed-port,
allow-lan, bind-address, mode, log-level, ipv6, tun
```

Routing rules are read-only. There is nothing for the access point, the uplink,
DHCP, the firewall, or any tunnel that is not a sing-box outbound. It is a monitor
with a single switch.

**The control plane must not share fate with the data plane.** When the dashboard
is served by the proxy core itself, it disappears exactly when it is needed.
Measured by stopping the core on a live device: the dashboard returns HTTP 000 at
the same instant client internet access returns HTTP 000. A router you cannot
reach while it is broken is a router you fix by pulling the memory card.

## What we are building

A single Node.js daemon on the device that:

* owns the complete configuration state, in a local database;
* serves a React single-page application over the device's own access point;
* serves an HTTP API for automation, disabled until explicitly enabled;
* renders every configuration file the system needs and drives systemd;
* keeps running and reachable when the data plane is down or the kill-switch is
  active;
* reverts automatically if a change costs the operator their own access.

## Decisions already taken

These are settled and the rest of the design depends on them.

| Decision | Consequence |
|---|---|
| **The daemon on the device is the only source of truth.** | No configuration management from outside, no two-master problem. |
| **Factory state is an access point with default credentials.** Everything else the user configures. | A built-in recovery configuration must be reachable with no setup at all. |
| **A profile is a complete configuration; exactly one is active.** Several exist so they can be switched, for example when travelling. | Profiles are whole documents, not overlays. Switching and rollback are the same operation. |
| **A configuration must be copy-pasteable as a single JSON document**, including to another person. | The profile document *is* the export format. No second serialisation to keep in sync. |
| **Export redacts secrets by default**; a full export is a separate explicit action. | Secrets are marked in the schema, and redaction is derived from that mark. |
| **Universal software.** Someone else will install it on their own board with their own dongles, and it must work. | Hardware discovered at runtime; capabilities enforced from what the driver reports; no constants describing hardware. |
| **English everywhere**, interface and documentation. | i18n scaffolding from the first commit. |
| **Web interface from the access point only, with a password. API off by default, tokens created in the interface.** | Two enforcement points — bind address and firewall rule. Token scopes in the data model from the start. |
| **Proxy cores are installed by the installer.** The daemon verifies presence and version and reports. | The daemon never downloads executable code. Features gate on detected versions. |
| **Logs live in RAM; only significant events reach the card**, and the RAM log is size-capped. | Structured logging to the journal with a cap, plus a separate rate-limited event log in the database. |
| **A change that can cost access auto-reverts after three minutes** unless confirmed in the interface or through the API. | A transaction model, and a revert path that does not depend on the daemon staying alive. |
| **Nothing is cut from the feature set.** Everything described is built; speed came from ordering, not from scope reduction. | Milestones were working slices rather than feature subsets. |
| **MIT licence.** | Code cannot be taken from copyleft projects in this space — ideas and protocol knowledge only. |
| **No TLS on the local network** by default; a place to install a certificate is provided. | Session security rests on the Wi-Fi passphrase plus the password. Stated plainly rather than papered over with a self-signed certificate. |
| **Fixed default credentials, with a mandatory change at first login.** | The installer prints them; the interface refuses to do anything else until the password is changed. |
| **Which radio serves the access point and which serves the uplink is configured, with a default.** Default: a USB dongle for the access point, the built-in radio for a Wi-Fi uplink. | Role assignment is a profile field resolved against discovered hardware, never an assumption. |

## What is built, and what is only tested

Everything in *What we are building* above exists and runs. What varies is the **evidence** behind each
part, and that distinction is the one worth carrying out of this document: it is kept in one place, the
README's [State of the evidence](../README.md#state-of-the-evidence) section, rather than sprinkled through
the design as status notes that go stale.

The short version: the recovery design is proved on hardware with measured times; the protocol range is
validated against the installed core's own schema but only three kinds have been connected to a real
peer; every hardware fact comes from **one board**; and there is no throughput figure because none has
been measured. Two verifications need somebody in the room with the device and are listed in
[14-open-questions](14-open-questions.md#not-undecided-just-not-done-the-two-things-that-need-a-person).

## Non-goals

**Not a general-purpose Linux admin panel.** No package management, no user
accounts, no storage, no containers. Cockpit exists and is better at that.

**Not a replacement for the proxy dashboard.** The live connection map, traffic
graph and rule inspector are already good. The Clash API stays enabled, bound to
loopback, and is proxied under our own authentication so an existing dashboard can
be embedded as an expert view. Reimplementing it would be waste.

**Not a packet router.** All routing decisions stay in sing-box's `route.rules`.
This project generates configuration; it does not touch packets.

**Not portable to OpenWrt in v1.** The platform layer sits behind a narrow
interface so a second implementation is possible, but writing it speculatively is
not worth it. Worth knowing for anyone considering the alternative: OpenWrt has
supported the Orange Pi Zero3 since 24.10 but *without* the built-in Wi-Fi — the
`uwe5622` driver is out-of-tree vendor code, the official support request was
closed as not planned, and the community patch has a known "stops working after a
while" defect. Putting both the access point and the uplink on that driver is a
poor trade.

**No cloud, no telemetry, no remote access in v1.** The device is managed from its
own network.

## Why not adopt something existing

The landscape was surveyed. Nothing covers this combination.

* **OpenWrt + LuCI + homeproxy or passwall2** is the closest. LuCI natively
  handles the uplink, Wi-Fi client and access point configuration; homeproxy
  (1.1k stars, sing-box based) handles the proxy side. But no project integrates
  an OpenVPN obfuscation transport such as Cloak, LuCI has no concept of a
  switchable whole-configuration profile, and the Wi-Fi driver problem above
  applies.
* **Clash-API dashboards** (metacubexd, zashboard, yacd) all share the API
  ceiling measured above.
* **Single-developer travel-router projects** on Debian handle an access point,
  a Wi-Fi client and one WireGuard or Tailscale tunnel with a flat configuration
  file. No proxy core, no split routing, no profiles. Their HTTP surface —
  status, scan, connect, config, clients, logs — is a useful reference for the
  system layer, and their scope is the reason they are not a base.
