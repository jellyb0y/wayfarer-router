# Research notes and sources

Background that produced the decisions in the design documents. Conclusions are
already folded into [05-platform-layer.md](../05-platform-layer.md),
[09-stack.md](../09-stack.md) and
[04-tunnels-and-protocols.md](../04-tunnels-and-protocols.md); this file keeps the
sources so a decision can be re-examined without repeating the search.

Surveyed in September 2026. Package versions are Debian 13.

## Runtime and backend

| Question | Finding | Source |
|---|---|---|
| Which Node to run | 24 LTS is Active LTS to April 2028; the distribution ships 20, end of life April 2026 | [Node releases](https://nodejs.org/en/about/previous-releases) |
| Single executable | Still experimental; ~110 MB binary, so every update rewrites 110 MB to the card | [Single executable applications](https://nodejs.org/api/single-executable-applications.html), [build improvements](https://joyeecheung.github.io/blog/2026/01/26/improving-single-executable-application-building-for-node-js/) |
| SQLite without a native module | Built-in driver is release-candidate stability and functionally sufficient: pragmas, prepared statements, iteration, user functions, backup | [node:sqlite](https://nodejs.org/api/sqlite.html) |
| Native SQLite alternative | Prebuilt binaries for new ABI and arm64 combinations have been missing repeatedly, forcing source builds | [better-sqlite3 issue 1384](https://github.com/WiseLibs/better-sqlite3/issues/1384) |
| HTTP framework | Fastify 5 is current; v6 is alpha and not suitable | [Fastify v6 alpha](https://github.com/fastify/fastify/releases/tag/v6.0.0-alpha.4) |
| Schema to JSON Schema | Zod 4 can emit JSON Schema natively; the older converter package is retired | [Zod JSON Schema](https://zod.dev/json-schema), [Fastify type provider](https://github.com/fastify/fastify-type-provider-zod) |
| Query layer | Drizzle supports the built-in SQLite driver | [Drizzle SQLite drivers](https://orm.drizzle.team/docs/sqlite/get-started-sqlite) |
| Events over HTTP | Server-sent events give browser reconnection and catch-up by event id for far less code than a socket | [SSE versus WebSocket](https://ably.com/blog/websockets-vs-sse) |
| SQLite durability on flash | Write-ahead logging and its interaction with power loss on SD cards | [WAL](https://www.sqlite.org/wal.html), [SQLite, power loss and flash](https://oneuptime.com/blog/post/2026-09-08-sqlite-power-loss-sd-cards-flash-storage/view) |
| Logging destination | Journal configuration, including keeping the journal in memory with a size cap | [systemd-journald](https://www.freedesktop.org/software/systemd/man/latest/systemd-journald.service.html) |
| Test runner | The built-in runner needs no dependency and strips types in current LTS | [comparison](https://www.pkgpulse.com/guides/node-test-vs-vitest-jest-native-test-runner-2026) |

## System control from Node

| Question | Finding |
|---|---|
| D-Bus binding | `dbus-native` returned to active development in mid-2026 (0.10 → 0.15.2), pure JavaScript, TypeScript definitions, promise API, type generation from introspection; requires Node 22.12 or newer. `dbus-next` has had no release since 2021. |
| systemd over the CLI | No events, and `show` ignores the JSON output flag, so state would be polled and parsed from key-value text. `StartUnit` over D-Bus returns a job; completion requires waiting for the job-removed signal. |
| Netlink from Node | No maintained binding. The most promising is 0.3.0 from 2023, is a native addon, and is described by its author as early stage. `ip -j` is the practical answer, with `ip monitor` as a debounced change trigger. |
| Wi-Fi client control | wpa_supplicant exposes a D-Bus interface and the distribution unit enables it. It does not expose signal strength, rate, modulation index or channel width — those come from `iw`, which has no JSON output. Its control socket is a Unix datagram socket, which needs a native module, and the existing wrappers are abandoned. |
| Access point control | hostapd has no D-Bus interface; the D-Bus support in that source tree is built only for wpa_supplicant. A long-lived control-socket client is the event source. The all-stations reply truncates near 4 KB, so iteration is required with many clients. |
| Firewall | Generate a file, check it, apply it as one transaction, read it back as JSON. An FFI binding to the library is only justified at hundreds of updates per second. |
| Privileges | Comparable system daemons run as a single root process with a systemd sandbox rather than splitting privileges, because the required capability set is effectively all of network root. A setuid helper conflicts with `NoNewPrivileges`. The engine needs writable-executable pages, so that particular hardening option cannot be used. |

Versions observed: systemd 257.13, iproute2 6.15, nftables 1.1.3, wpa_supplicant and
hostapd 2.10, iwd 3.8.

## How comparable projects model protocols

The finding that shaped [04-tunnels-and-protocols.md](../04-tunnels-and-protocols.md).

| Project | Model | Cost of one protocol |
|---|---|---|
| [homeproxy](https://github.com/immortalwrt/homeproxy) | Flat record with protocol-prefixed fields; ~130 dependency declarations in a 1465-line view; generator builds a single object with every protocol's fields and strips empties, resolving name collisions with conditionals. Field list duplicated in the form, the client generator, the server generator and the subscription parser. | 5 files, +86/−5 lines |
| [passwall2](https://github.com/Openwrt-Passwall/openwrt-passwall2) | Cores pluggable by dropping a file into a directory, each namespacing its options with a prefix; availability gated on detected binary features and versions. Generation still imperative: ~600-line function with 40-plus protocol branches, duplicated per core; 2600-line subscription parser. | 3 files, ~100 lines |
| nikki | **No protocol model at all.** Profile view is 90 lines. Configuration is the provider's own document, with user and generated layers merged over it. A profile is a switchable unit. | Not applicable |
| OpenClash | Profiles are files; switching is a path change; subscriptions go through an external converter, then merge, validate, swap. | Not applicable |
| podkop | Typed builders for four protocols, and a raw-JSON escape hatch for everything else. | Not applicable for the escape hatch |

Schemas:

* **sing-box publishes an official JSON Schema generated from its own types**, and the
  binary emits the schema for its own build tags. Confirmed on the target board:
  445 KB, Draft 2020-12, 94 definitions, outbounds as a `oneOf` discriminated by
  `type` across 21 types, with enums, defaults and bounds, plus an annotation marking
  fields that reference another outbound's tag. It contains no descriptions or
  titles, so labels must come from elsewhere.
* Xray has no official schema; the de-facto one is community-maintained with
  descriptions extracted from documentation. mihomo likewise.
* **No project generates forms from these schemas.** They are used for editor
  autocompletion only; every graphical interface writes forms by hand per protocol.

Subscriptions: the best-organised implementation is
[Sub-Store](https://github.com/sub-store-org/Sub-Store) — a registry of parsers each
with a test predicate and a parse function, one normalised internal representation,
and separate producers per output format. Published packages in this area are small
and young.

## Alternatives to building this

| Option | Why it was not taken |
|---|---|
| OpenWrt with LuCI plus a proxy application | OpenWrt supports the target board since 24.10 **without the built-in Wi-Fi**; the driver is out-of-tree vendor code, the [official request was closed as not planned](https://forum.openwrt.org/t/orange-pi-zero-3-wireless-driver/218157/4), and the [community patch](https://github.com/rizkirmdhnnn/openwrt-orangepi-zero3-wifi) has a known "stops working after a while" defect. No project integrates an OpenVPN obfuscation transport. LuCI has no switchable whole-configuration profile. |
| A Clash-API dashboard | The mutable surface of that API is ports, LAN permission, mode, log level and IPv6. Routing rules are read-only. Nothing for the access point, uplink, DHCP or firewall. |
| Existing single-developer travel-router projects | Flat configuration, one tunnel of one kind, no split routing, no profiles. Their HTTP surface is a useful reference for the system layer. |
