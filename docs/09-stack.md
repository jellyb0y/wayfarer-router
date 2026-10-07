# 9. Stack

Chosen for a 4×Cortex-A53 board with 2 GB RAM booting from an SD card, running for
months at a time. Two constraints drove most of it: **no native modules**, because
compiling them on this CPU is slow and prebuilt binaries for this architecture go
missing; and **few writes to the card**.

## Runtime

**Node 24 LTS**, from the official tarball into `/opt`, symlinked.

Not the distribution package: Debian 13 ships Node 20, which reaches end of life in
April 2026. Not `nvm`, which is per-user and does not survive being launched by
systemd. A newer LTS can be adopted on its own schedule; the D-Bus binding requires
at least 22.12, which this satisfies comfortably.

**Not a single executable application.** It is still experimental, the binary is
around 110 MB, and every update rewrites 110 MB onto the card. Instead: bundle the
daemon with esbuild into one 1–3 MB JavaScript file and run it on the system Node.
Same "one artefact to deploy" property, updates measured in megabytes.

Bun and Deno have working builds for this architecture, but the plugin ecosystem
and multi-month stability record favour Node here. Bun is worth using as a build
accelerator on the development host.

Start-up is roughly 80–150 ms on this CPU. For memory, read
[The shipped limits](#the-shipped-limits-and-the-window-they-rest-on), which carries the figures with the
window each came from rather than a single number: the highest cgroup-accounted peak measured is
**145.1 MiB**, under load with tunnels configured and probing. Against 2 GB none of it matters, which is
the only conclusion this evidence supports.

## Backend

| Concern | Choice | Reasoning |
|---|---|---|
| HTTP | **Fastify 5** | Compiles JSON Schema into validators and serialisers, which is a real win on a slow CPU; mature static-file, SSE and OpenAPI plugins; proper graceful shutdown. v6 is in alpha and not for this. |
| Schemas | **TypeBox** | JSON Schema is the primary artefact, which is exactly what schema-driven forms and OpenAPI need; types come out with `Static<T>`; Fastify feeds the schema straight to its validator with no conversion. |
| Foreign-schema validation | **Ajv**, the 2020-12 build (`ajv/dist/2020`) | The schema a proxy core emits declares Draft 2020-12, and the default Ajv build implements draft-07 — compiling a 2020-12 schema with it does not fail loudly, it silently ignores the keywords it does not implement, so a configuration that should be rejected is accepted and the failure surfaces as a service that will not start. Pure JavaScript, no native module. Strict mode is **off**, because the schema legitimately carries `x-tag-reference`, our stamped `x-secret`, and whatever the next release invents; strict mode would turn a new annotation into a device that cannot validate any tunnel at all. Compiled validators are cached per schema identity, since compiling 445 KB is not free on a four-core Cortex-A53. TypeBox's own `Value` was not used for this: it is built for schemas we author, not arbitrary foreign documents. |
| Database | **The runtime's built-in SQLite** | No native module at all — no compilation on the board, no missing prebuilt. Functionally sufficient: pragmas, prepared statements, iteration, backup. |
| Query layer | **Plain SQL over the built-in driver**, behind one repository module | Drizzle was the original choice and does not support this driver; see the correction below. |
| Events | **SSE**, WebSocket only if duplex appears | Browser reconnects for free, `Last-Event-ID` for catch-up, far less code. |
| Sessions | **Cookie + opaque id in the database** | Immediate revocation, no token-expiry games on a device with an unreliable clock. |
| Hashing | **`scrypt` from the runtime** | Argon2 and bcrypt are native modules. |
| Logging | **pino to stdout** | systemd captures it. No log files, no rotation on the card. |
| Tests | **The runtime's test runner** for the daemon, **Vitest** for the interface | Zero dependencies on one side; Vitest comes with Vite anyway. Its type stripping is erase-only, so `erasableSyntaxOnly` is set — see [16-implementation-notes.md](16-implementation-notes.md). |

`TypeBox` over `Zod` deserves a note, because Zod would be the more common choice
and its developer experience is better. The deciding factor is direction: we need
JSON Schema as the *output* that drives form generation and OpenAPI, and with
TypeBox the schema is the source rather than something derived — nothing can be
expressed that will not round-trip. Zod 4 can emit JSON Schema and there is a
Fastify provider for it; if the ergonomics of TypeBox become a drag in practice
this is the fallback, and the boundary is narrow enough to swap.

### Correction: Drizzle does not support the built-in driver

An earlier revision of this document chose Drizzle for the query layer and stated that
it "supports the built-in driver". **Measured on drizzle-orm 0.45.2 (2026-09-19): it does
not.** The driver entry points it ships are:

```
better-sqlite3  bun-sqlite  durable-sqlite  expo-sqlite  op-sqlite  sqlite-proxy
node-postgres
```

There is no entry point for the runtime's own SQLite. The wrong reasoning is the part
worth keeping: two constraints made the original claim look safe, and both of them now
point the other way.

* **No native modules.** This is why the built-in driver was chosen in the first place.
  The only first-class SQLite driver Drizzle offers is `better-sqlite3` — exactly the
  native module the constraint exists to avoid, and the one whose prebuilt binaries for
  this architecture have gone missing before.
* **Migrations we own.** Drizzle was wanted for a typed schema *and* file-based
  migrations. The one route to the built-in driver, `sqlite-proxy`, has no migration
  support at all, and it turns a synchronous API into an asynchronous callback bridge.
  Paying a dependency for the half of it that does not work is worse than either
  alternative.

Waiting for a Drizzle release with a built-in-driver entry point was also considered and
rejected: it blocks the state layer on someone else's schedule for a component this
project does not need.

**Decision: plain SQL over `node:sqlite`,** with a file-based migration runner of our own
and prepared statements held in one module. The reasoning that survives from the original
entry is that the query layer must be narrow: all SQL lives in
`apps/daemon/src/state/`, so adopting a query builder later — if one gains support for
this driver — is a change to that directory and to nothing above it.

### SQLite settings

```
journal_mode = WAL
synchronous  = NORMAL
wal_autocheckpoint = 256
busy_timeout = 5000
temp_store   = MEMORY
```

More important than any pragma: **do not write hot data.** Live status, station
lists, signal strength and traffic counters stay in memory. The database sees
profiles, tokens, sessions, transactions and a rate-limited event log. Nothing else.

## System access

Detailed in [05-platform-layer.md](05-platform-layer.md). Summary of the choices:

| Task | Mechanism |
|---|---|
| systemd state and events | D-Bus (`dbus-native`, pure JavaScript, active again since mid-2026) |
| systemd enable/disable | the `systemctl` CLI |
| Network state | `ip -j`, with `ip monitor` as a debounced change trigger |
| Wi-Fi client control and events | `wpa_cli` on our own control socket — **not** D-Bus, whose bus name has one owner per system and is already taken; see [05](05-platform-layer.md) |
| Signal, rate, channel width | `iw` (text output, parsed in one place, best-effort) |
| Radio capabilities | `iw phy` |
| Access point events | long-lived `hostapd_cli` on the control socket |
| Firewall | generate a file, `nft -c -f`, then `nft -f`; read with `nft -j` |

Deliberately avoided: Netlink bindings for Node (none maintained), the
wpa_supplicant control socket (Unix datagram, needs a native module),
NetworkManager (takes ownership of interfaces), `libnftables` through FFI
(unnecessary at this update rate).

## Frontend

Vite 7, React, TanStack Query for server state, Zustand for the profile draft,
Tailwind with a headless component set, own form renderer over field descriptors,
and the same TypeBox schemas as the backend for validation.

## Repository layout

```
wayfarer/
├── apps/
│   ├── daemon/            Fastify, core, platform, state
│   └── ui/                React + Vite
├── packages/
│   ├── schemas/           TypeBox: profile, API, events — shared
│   ├── protocols/         providers, transports, subscription parsers
│   └── field-meta/        UI metadata overlay keyed by JSON Pointer
├── deploy/
│   ├── install.sh
│   ├── systemd/
│   └── units/             templated units the daemon manages
└── docs/
```

**pnpm workspaces.** Turborepo is not worth it at four packages. Cross-compilation
is a non-problem precisely because there are no native modules: build on the
development host, copy the bundle and the static files, restart the unit.

## Logging, and the memory budget it does not consume

Two separate budgets, and conflating them is the mistake to avoid.

**Up to 200 MB of logs, in RAM.** pino writes structured JSON to stdout; systemd
routes it to the journal, whose runtime storage is RAM-backed and capped:

```
RuntimeMaxUse=200M
```

This is the journal's memory, not the daemon's heap. The daemon keeps only a small
ring of recent lines for the interface to display. A process memory limit and the
log budget therefore do not compete, which is worth stating because it looks like
they should.

**Only significant events on the card.** A ring of about 5000 rows in the database:
apply started, succeeded or failed; revert; profile switch; tunnel up and down
transitions; safe mode; authentication and lockouts. It survives power loss, and it
is a few kilobytes of writes a day rather than a stream.

**Retention is by count, not by age**, and the difference is worth stating because
nobody guesses it correctly: *a busy day holds less history than a quiet one.* An
earlier revision of this document said "roughly a week or two of ordinary history",
which was an estimate dressed as a figure — the real span depends entirely on the
event rate, and a device that spends an afternoon failing to apply a bad profile can
evict a week of ordinary history in an hour, exactly when somebody wants to see what
preceded the trouble.

So the number is not documented here at all. The diagnostics screen reads the oldest
row the ring still holds and reports the reach-back from that, and says whether the
ring is full — because "nothing has been evicted yet" and "the oldest events are going
now" are different facts and only the device knows which applies.

Nothing else is written. No request log, no periodic status lines, no telemetry. The
measured baseline for the whole device is 650–750 B/s and the log path must not
move that number.

**Do not spam.** Per-request logging and periodic heartbeat lines are off by
default. A debug switch in the interface raises the level for a bounded period and
lowers it again on its own, so a forgotten debug session cannot fill 200 MB and
push out the lines that mattered.

**Process limits are configurable**, like the choice of radio for the access point,
because a sensible default is not the same as a correct one on unknown hardware:

```
MemoryHigh   = 384M    (soft: reclaim pressure, logged)
MemoryMax    = 768M    (hard: the process is killed and restarted)
```

**Measure the cgroup, not `ps`.** Both limits act on the control group, and the two numbers are not
the same quantity: file-backed pages of the runtime binary count towards RSS, while the cgroup also
charges page cache, socket buffers and kernel memory incurred on the process's behalf. Only the cgroup
figure is what `MemoryMax` is enforced against, so it is the only one worth sizing a limit from —
setting a limit against a number the limit does not measure is how a service is killed at a value its
own monitoring called healthy.

### Measured, and the estimate it replaces

| | value | how |
|---|---|---|
| `memory.current`, at rest | **113.0 – 113.6 MiB** | cgroup v2, sampled every 30 s |
| `memory.peak` | **145.1 MiB** | cgroup v2, since the unit started |
| `pids.current` / `pids.peak` | **14 / 39** | cgroup v2 |

**Window: the first samples of the bench soak, 2026-09-21.** A short window, said plainly because the
numbers are only worth what the window is worth — this is minutes, not days, and the figures are at
**rest** rather than under load. The peak under load is what should decide the limits, and the soak
continues.

**This replaces a documented expectation of 45–70 MB, which was an estimate rather than a
measurement.** Nothing regressed: the earlier figure was never observed at this scope. It appears to
have described *process* resident memory, and the sentence claiming "the 45–70 MB figure holds when
measured the way the limits measure it" cited `MemoryCurrent` 63.5 MB from a single reading of an idle
daemon shortly after a restart — before the first journal read, the first inventory collection or the
first plan had charged anything to the cgroup. Anyone reconciling the two numbers should read the
difference as an estimate being corrected, not as a leak.

Against the shipped limits, 145 MiB of peak sits at 38% of `MemoryHigh` and 19% of `MemoryMax`, so
both are generously sized on this evidence. Whether that generosity is right depends on the peak under
load, which is not yet measured — so the limits are **left as they are** for now rather than tightened
against a figure taken at rest. A leak still becomes visible in the journal long before either limit is
reached, which is the point of having a soft one.

A 2000-line journal read added about 10 MB that was not returned promptly, which is why that endpoint
is capped and paginated — see [16-implementation-notes.md](16-implementation-notes.md).

## The shipped limits, and the window they rest on

**Every limit below is left where it was**, and that is the finding rather than an absence of one. Two of
them are now derived from measurement instead of judgement, and the other two are shown to have so much
headroom that changing them on this evidence would be fiddling.

### The window, stated first because it is the whole basis

**1.86 hours of continuous sampling, 222 samples, 2026-09-21** — and it contains daemon restarts from every deploy made inside it,
because eleven deploys happened inside it while the rest of this work was being done. The sampler says so
itself, in the report, without being asked:

```
daemon starts     11   (distinct start times seen; a deploy or an apply causes one)
                  NOTE: the daemon restarted during this window, so memory.current
                  min and the early samples describe a freshly started process.
```

That is under two hours of a device being repeatedly interrupted. **It is not grounds for tightening a memory limit**, and it is not presented as though it were. A limit lowered against a peak that was never
under load is a limit that kills the service the first time somebody uses it properly.

### What the window does support

| limit | measured | headroom | verdict |
|---|---|---|---|
| `MemoryHigh = 384M` | `memory.peak` **106.5 MiB** at rest; **145.1 MiB** earlier with two tunnels and probing | 28% / 38% used | left alone |
| `MemoryMax = 768M` | same | 14% / 19% used | left alone |
| `TasksMax = 512` | `pids.peak` **40** with tunnels running, 22 at rest | 8% used | left alone |
| `RuntimeMaxUse = 200M` | journal at **34.2 MiB** after a night of work | 17% used | left alone |

The two memory figures are worth reading together: **145.1 MiB is the higher one and it is the one under
load**, taken while two tunnels were configured and the watchdog was probing every ten seconds. The
106.5 MiB figure is a quiet device with no tunnels. So the load-bearing number is the larger, it sits at
38% of the soft limit, and there is no case for moving either.

### Two ring sizes, now derived rather than chosen

These are the ones where measurement replaced a guess, because their cost is bytes on the card and bytes
are countable:

```
events        168 rows, mean 179 bytes/row, widest payload 424 bytes
              -> EVENT_RING_SIZE = 5000 costs about 0.9 MiB of row data

transactions   10 rows, mean 3573 bytes/row  (each carries two whole profile documents)
              -> TRANSACTION_RING_SIZE = 200 costs about 0.7 MiB
```

Both stay. Together they are under two megabytes on a card measured in gigabytes, which answers the only
question that was ever open about them — whether the ring sizes are affordable — with a number instead of
a shrug. The transaction rows are twenty times the size of an event row, and that is expected: a
transaction stores the document to go back to, which is the entire reason rollback needs no inverse.

### What is still not known, said plainly

* **No multi-day window.** Everything above is under an hour. A leak that takes a day to become visible
  would not appear in it, and nothing here should be quoted as evidence against one. The soft limit exists
  precisely so that a slow leak shows up in the journal long before the hard one is reached.
* **No sustained-traffic window.** The peak under load was measured with tunnels *configured and probed*,
  not with clients pushing traffic through them for hours. That is the measurement most likely to move the
  memory figures, and it has not been taken.
* **The card-write figure in this window is meaningless** — 45.14 MiB, almost all of it eleven deploys and
  their snapshots. The steady-state figure measured in a quiet window earlier was **0.22 MiB over 0.08
  hours, about 800 B/s**, which sits on the documented 650–750 B/s baseline. That is the number to quote.

## Testing

**The planner is pure, so the interesting logic tests on a laptop.** Given a profile
document and a synthetic hardware inventory, assert the desired state: exact file
contents, unit lists, the generated core configuration, the generated ruleset. This
is where invariant violations and ordering regressions get caught, with no board
involved.

**The platform layer is tested against fixtures.** Real captured output of `ip -j`,
`iw phy`, `iw dev link`, `nft -j list ruleset`, `hostapd_cli all_sta` — including
the truncated reply and the odd driver that omits a field.

**Integration tests are run by hand on the bench board**, through the API, with the
transaction watchdog doing exactly what it does in production. There is no automated
hardware runner: the logic that would benefit from one is already covered by
fixtures, and a simulated radio is not a real driver.

`child_process` is never mocked globally. The platform layer is a narrow interface
and the tests substitute a fake implementation of it.
