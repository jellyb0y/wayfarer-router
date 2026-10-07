# 2. Architecture

## Layers

```
┌──────────────────────────────────────────────────────────────────┐
│  React SPA (Vite build, served as static files by the daemon)     │
│  status · profiles · tunnels · routing · radio · clients · logs   │
└──────────────────────────────┬───────────────────────────────────┘
                               │  REST (JSON) + SSE (one event stream)
                               │  same origin, same port, cookie session
┌──────────────────────────────┴───────────────────────────────────┐
│  wayfarer daemon — one Node process, root, systemd-sandboxed  │
│                                                                   │
│  api/         Fastify: routes, schema validation, auth, OpenAPI   │
│  core/                                                            │
│    registry/  providers: tunnels, transports, uplinks, access pts │
│    planner/   profile + inventory → DesiredState        (pure)     │
│    differ/    DesiredState vs reality → Plan            (pure)     │
│    reconciler/ applies a Plan: ordered, validated, checkpointed    │
│    txn/       transactions, confirmation, auto-revert              │
│    policy/    tunnel health watchdog, selector decisions           │
│  platform/    the ONLY code that knows about the operating system  │
│    systemd · net · wifi · hostapd · nft · files · clock            │
│  inventory/   runtime hardware discovery and capabilities          │
│  state/       SQLite: profiles, tokens, sessions, event log        │
│  telemetry/   pollers + event sources → in-memory bus → SSE        │
└──────────────────────────────┬───────────────────────────────────┘
                               │  files in /etc, systemd units, control sockets
┌──────────────────────────────┴───────────────────────────────────┐
│  sing-box (data plane)  ·  hostapd  ·  dnsmasq  ·  nftables       │
│  wpa_supplicant  ·  openvpn  ·  obfuscation clients  ·  xray      │
│  systemd-timesyncd  ·  systemd-networkd                           │
└──────────────────────────────────────────────────────────────────┘
```

Two rules keep this honest, and they are worth enforcing in review.

**Only `platform/` knows about the operating system.** Everything above it works
with plain data. This is what makes the planner testable on a laptop, and what
makes a second platform implementation possible without touching anything else.

**Only `reconciler/` has side effects.** Planning, diffing and validation are
pure. Any code path outside the reconciler that writes a file, restarts a unit or
shells out is a bug.

## The central loop

```
   ┌── Profile document (JSON, from SQLite, validated)
   │
   ├── Hardware inventory (phys, capabilities, interfaces, regulatory domain)
   │
   └── Runtime facts (subscription contents, DNS pushed by a tunnel, core versions)
                    │
                    ▼   planner — pure, no I/O
        DesiredState {
          files:   [{ path, mode, owner, content }]
          units:   [{ name, enabled, active }]
          network: [{ ... }]                    // systemd-networkd
          checks:  [{ kind, input }]            // what to validate before applying
        }
                    │
                    ▼   differ — pure
        Plan { create[], update[], delete[], unitsToStart[], unitsToStop[],
               blastRadius: hot | service | network | boot,
               humanDiff: string[] }            // shown before Apply
                    │
                    ▼   validate — still no mutation
        sing-box check · nft -c -f · schema validation · capability invariants
                    │
                    ▼   reconciler — the only mutating step
        Reality
```

### Why desired state and not a handler per settings page

The obvious alternative is a save handler per screen: "save access point
settings" writes the hostapd configuration and restarts hostapd. It loses on four
counts, each of which costs real debugging time when configuring these components
by hand.

**Ordering is a property of the whole change, not of one page.** The firewall
ruleset must be in place before the time synchronisation service is restarted,
because the rule that lets NTP bypass the tunnel has to exist before the first
query goes out. A unit must be enabled before it is restarted, because a failing
restart under `set -e` semantics aborts the sequence and leaves the unit disabled
at boot — a fault that only shows up after a reboot. Network configuration must
settle before hostapd starts, or hostapd binds an interface that has no address
yet. None of this fits in per-page handlers.

**Idempotency comes free.** Re-applying a profile is a no-op when reality already
matches. Hand-written apply scripts have to be made idempotent one case at a time,
and the cases you miss are the ones that bite after a reboot.

**A dry run is free**, and a dry run is the difference between an interface you
trust and one you are afraid of. The operator sees the exact diff before pressing
Apply.

## Processes and units

| Unit | Role |
|---|---|
| `wayfarer.service` | The daemon. `Restart=always`, `WatchdogSec`, hardened sandbox. Must not depend on the proxy core. |
| `wayfarer-revert@<txn>.service` | Transient, created with `systemd-run --timer-property=OnBootSec=<uptime+window>s`. Runs `way revert --txn <id>` in a fresh process. Deliberately outside the daemon, and deliberately anchored to boot — see below. |
| `wf-core.service`, `wf-hostapd@<if>.service`, `wf-dhcp@<if>.service`, `wf-firewall.service` | System components under our own unit names, managed by the reconciler. Never the distribution's units for the same binaries: the stock `dnsmasq.service` contends with `wf-dhcp@` and is masked by the installer — see [11-deployment.md](11-deployment.md), *Distribution units the installer masks*. (Corrected 2026-09-24: this row named the distribution's units; the generators in `core/generate/units.ts` write only `wf-` units.) |
| `wf-openvpn@<tag>.service`, `wf-transport@<endpoint>.service`, `wf-socks@<tag>.service` | Templated units the daemon ships and manages, one instance per configured tunnel or transport. |
| `wf-rederive.service` | **Boot guard.** Re-derives every generated artefact marked environment-dependent and rewrites any that no longer matches where the device now is. Runs before the core, by design. |
| `wf-route-check.service` | **Boot guard.** Checks that no address the device must answer on has been captured by the tunnel. Waits up to 30 s for a tunnel device to exist first — see the catalogue entry on backstops that always pass. |

Generated unit definitions live at **`/usr/local/lib/systemd/system`**, not `/etc/systemd/system`. That
directory belongs to the administrator, and leaving it free is what makes `systemctl mask` work on our own
units — masking needs `/etc/systemd/system/<unit>` available for the symlink, and a unit *file* sitting
there blocks it. The deadman's rescue path depends on being able to mask both the daemon and every `wf-*`
unit, so this is a safety property rather than tidiness.

### Why the revert timer lives outside the daemon

If the daemon applies a change that breaks the network and then crashes — or the
board loses power inside the confirmation window — an in-process timer is gone and
the device is stranded with a configuration nobody can reach. **The revert must
not depend on the process that caused the problem.**

So, before applying a change classified `network`:

1. the daemon writes the transaction to SQLite, including a full copy of the
   previous profile document and a deadline;
2. it arms a transient systemd unit whose deadline is **anchored to boot**
   (`--timer-property=OnBootSec=<uptime+window>s`), never expressed as an interval
   from the timer's activation — `--on-active` is re-based by `systemctl
   daemon-reload`, and the reconcile that follows reloads once per unit it installs,
   so the apply would postpone its own revert. See
   [06-apply-and-rollback.md](06-apply-and-rollback.md);
3. a confirmation cancels that unit;
4. expiry starts a *fresh* process which reads the transaction from the database
   and re-applies the previous document.

On top of that, every daemon start looks for an unconfirmed transaction and
reverts it. That is what covers power loss inside the window, which a timer alone
cannot.

The full state machine is in [06-apply-and-rollback.md](06-apply-and-rollback.md).

## Availability requirements

The control plane has to be reachable in precisely the situations where a router
is normally unreachable. Three requirements, each traceable to a measurement.

**Independent of the proxy core.** Stopping the core must not affect the
interface. Today, with a dashboard served by the core, it does: both go to HTTP
000 together. The daemon is its own process with its own listener.

**Reachable with the kill-switch active.** The kill-switch rejects new
connections from the LAN towards the WAN interface; traffic from the LAN to the
device itself is an `input` decision and unaffected. The planner emits an explicit
accept rule for the management port anyway, so the guarantee is written in the
ruleset instead of inferred from it.

**Reachable when the active profile fails to apply.** After repeated apply
failures, or when a start-up check finds no working management path, the daemon
activates the built-in recovery profile: access point, DHCP, interface, no
tunnel. See [11-deployment.md](11-deployment.md).

## Live state

Status is never stored. It is assembled in memory and pushed over one SSE stream.

```
systemd D-Bus signals ──────────┐
ip monitor (debounced) ─────────┤
hostapd control socket events ──┼──► in-memory store ──► SSE /events ──► SPA
wpa_supplicant D-Bus signals ───┤       (ring buffers,
Clash API, proxied ─────────────┤        no disk writes)
periodic tunnel probes ─────────┘
```

Deliberately **not** written to the database: interface state, station lists,
signal strength, traffic counters, connection lists, log lines. The memory card is
the only part of this device that wears out, and telemetry is the one thing
guaranteed to be written constantly. Measured baseline write rate on the target
board is 650–750 B/s, about 55 MiB per day; that is the budget to stay inside.

Written to the database: profiles, the active profile pointer, transactions, API
tokens, sessions, and a ring of about 5000 significant events — apply started,
succeeded or failed; revert; profile switch; tunnel up and down transitions;
authentication. Log lines themselves go to the journal, which is RAM-backed and
capped at 200 MB; see [09-stack.md](09-stack.md).
