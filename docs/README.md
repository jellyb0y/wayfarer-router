# Design documentation

## Read in this order

| Document | What it answers |
|---|---|
| [01-scope.md](01-scope.md) | What this is, what it is not, decisions already taken |
| [02-architecture.md](02-architecture.md) | Layers, processes, the desired-state model |
| [03-data-model.md](03-data-model.md) | Profiles, database, export and import, device identity and peers |
| [04-tunnels-and-protocols.md](04-tunnels-and-protocols.md) | How a protocol is added — the core extensibility design |
| [05-platform-layer.md](05-platform-layer.md) | How the daemon talks to the operating system |
| [06-apply-and-rollback.md](06-apply-and-rollback.md) | Planner, reconciler, blast radius, the confirmation window and the revert |
| [07-api.md](07-api.md) | REST, SSE, authentication, machine tokens |
| [08-ui.md](08-ui.md) | React SPA, schema-driven forms, screens |
| [09-stack.md](09-stack.md) | Library choices, and the shipped limits with the evidence for each |
| [10-security.md](10-security.md) | Trust boundary, privileges, secrets |
| [11-deployment.md](11-deployment.md) | Prerequisites, install, first boot, recovery |
| [12-hardware-invariants.md](12-hardware-invariants.md) | Measured facts the planner must enforce |
| [14-open-questions.md](14-open-questions.md) | Deferred and undecided |
| [13-plan.md](13-plan.md) | Epics, tasks, critical path |
| [15-bench-safety-net.md](15-bench-safety-net.md) | The deadman that makes breaking a board recoverable |
| [16-implementation-notes.md](16-implementation-notes.md) | **The catalogue.** Traps found while building, and the failure modes to look for next |
| [17-publishing.md](17-publishing.md) | What has to be true before this is made public |

Supporting research is in [research/](research/).

## The shortest possible summary

Three ideas carry the whole design.

**1. A profile is one complete configuration document, and exactly one profile is
active.** This makes switching a single action, makes sharing a copy-paste, and
makes rollback almost free — reverting is re-applying the previous document rather
than computing an inverse.

**2. The daemon never mutates the system directly. It computes desired state and
reconciles.** `profile + hardware inventory → DesiredState` is a pure function, so
it is testable without a board and a dry-run diff costs nothing. A separate
reconciler makes reality match, in a known order, validating before it touches
anything.

**3. Protocol support is declarative, and the schema comes from the binary.**
`sing-box schema` emits JSON Schema generated from the installed binary's own Go
types — verified on the target board: 444 895 bytes, 93 definitions, outbounds as a
`oneOf` on `type` that flattens to 21 branches. A tunnel is stored as that object
verbatim and validated against that schema, so a protocol the core gains needs no
code here. Providers exist only for tunnels that are *not* plain outbounds:
OpenVPN, obfuscation transports, and external clients behind a local SOCKS port —
plus a second plain shape, `singbox-endpoint`, for the protocols the core configures
as endpoints rather than outbounds.

The schema is treated as **input**, not as a fact. It also carries no descriptions,
no titles and no secret annotations, so labels come from an overlay and the secret
annotation is stamped on — see [10-security.md](10-security.md), because that second
gap has a security consequence rather than a cosmetic one.
