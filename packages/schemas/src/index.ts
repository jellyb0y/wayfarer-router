/**
 * Schemas are the contract.
 *
 * Defined once in TypeBox and used for request validation, response serialisation and the
 * generated OpenAPI document, so there is no hand-written API reference to fall out of date.
 * TypeBox rather than a validator that can emit JSON Schema, because here JSON Schema is the
 * *output* that drives form generation and OpenAPI: the schema is the source, and nothing can
 * be expressed that will not round-trip.
 */

import { Type, type Static } from '@sinclair/typebox';
import { HardwareBinding } from './profile.ts';

/**
 * The error contract.
 *
 * `pointer` is a JSON Pointer into the document the request was about, which lets the
 * interface put a message on the right field instead of pattern-matching on text. `hint` is
 * deliberately part of the contract: on a device where a wrong configuration can cost access,
 * an error that does not say what to do instead is only half an error.
 */
export const ErrorBody = Type.Object(
  {
    code: Type.String({ description: 'Stable machine-readable code, e.g. invariant_violation.' }),
    message: Type.String(),
    pointer: Type.Optional(Type.String({ description: 'JSON Pointer into the submitted document.' })),
    detail: Type.Optional(Type.Unknown()),
    hint: Type.Optional(Type.String({ description: 'What to do instead.' })),
  },
  { $id: 'ErrorBody' },
);

export const ErrorResponse = Type.Object({ error: ErrorBody }, { $id: 'ErrorResponse' });
export type ErrorResponse = Static<typeof ErrorResponse>;

export const HealthResponse = Type.Object(
  {
    ok: Type.Boolean(),
    /** Seconds since the daemon started, not since boot. */
    uptimeSeconds: Type.Number(),
    /**
     * Whether the default password has been replaced. **Information, not permission.**
     *
     * It gated the API until the password was changed, and the owner removed that gate: the default
     * password is short on purpose and changing it is never forced. The field stays because the fact is
     * worth reporting — a device still carrying the shipped credential is a thing an operator should be
     * able to see — but nothing refuses a request on it, and a client that treats it as a barrier is
     * reinventing the one that was deliberately taken out.
     */
    setupComplete: Type.Boolean({
      description:
        'False while the device still carries the default password. Reported so it can be seen, not ' +
        'enforced: nothing is refused on this value.',
    }),
  },
  { $id: 'HealthResponse' },
);
export type HealthResponse = Static<typeof HealthResponse>;

/**
 * What an interface is, in the classifier's own words.
 *
 * `wirelessUplink` rather than a friendlier `wifi` or `client`: this is the vocabulary
 * `core/interface-class.ts` decides in, and the value on the wire is that decision travelling
 * unchanged. Renaming it at the boundary would create a second vocabulary for one fact, and the
 * translation between them would be a place for the two to disagree about a device.
 *
 * Restated here rather than imported because this package cannot depend on the daemon — the
 * dependency runs the other way. What keeps the two from drifting is not discipline: the handler
 * returns the classifier's own type, so a class added there and not here stops compiling. Proved by
 * mutation, 2026-09-21: adding a seventh class to `ChannelClass` fails `apps/daemon`'s typecheck
 * with the response type named. The reverse — a literal here that the classifier cannot produce —
 * is not caught by that, and is the direction to be careful in when editing this list.
 */
const ChannelClass = Type.Union([
  Type.Literal('loopback'),
  Type.Literal('wired'),
  Type.Literal('accessPoint'),
  Type.Literal('wirelessUplink'),
  Type.Literal('tunnel'),
  Type.Literal('unknown'),
]);

/** An interface that was not bound, with the classifier's own words for why. */
const ChannelExclusion = Type.Object({
  interface: Type.String(),
  class: ChannelClass,
  /**
   * The reason, as a sentence rather than a code.
   *
   * It is read by somebody whose panel did not open: `kind=wireguard` tells them what happened,
   * where `TUNNEL_EXCLUDED` tells them only that we have a constant for it.
   */
  reason: Type.String(),
});

export const SystemResponse = Type.Object(
  {
    /**
     * This installation's own identity, generated once and stored.
     *
     * Exposed so an aggregate view can tell two devices apart — and so that two devices flashed from one
     * card, which share everything they did not generate themselves, show up as the duplicate they are
     * rather than as a single row.
     */
    deviceId: Type.String(),
    deviceName: Type.String(),
    /** The active profile's name, or null. Part of the summary a peer reports about itself. */
    activeProfile: Type.Union([Type.String(), Type.Null()]),
    version: Type.String(),
    buildAt: Type.Union([Type.String(), Type.Null()]),
    runtime: Type.String(),
    startedAt: Type.String(),
    uptimeSeconds: Type.Number(),
    /**
     * Whether the default password has been replaced. **Information, not permission.**
     *
     * It gated the API until the password was changed, and the owner removed that gate: the default
     * password is short on purpose and changing it is never forced. The field stays because the fact is
     * worth reporting — a device still carrying the shipped credential is a thing an operator should be
     * able to see — but nothing refuses a request on it, and a client that treats it as a barrier is
     * reinventing the one that was deliberately taken out.
     */
    setupComplete: Type.Boolean({
      description:
        'False while the device still carries the default password. Reported so it can be seen, not ' +
        'enforced: nothing is refused on this value.',
    }),
    apiEnabled: Type.Boolean(),
    schemaVersion: Type.Number(),
    /**
     * Every interface the kernel reports, with the device's verdict on each.
     *
     * ## Why the panel needs this and not a list of names
     *
     * The management surface must answer on the wire, the access point, the joined wireless network
     * and loopback, and on **no tunnel interface** — the last being the owner's explicit
     * prohibition. `listen` reports a port, the addresses in use and the names that resolved to
     * nothing, which is enough to say that the daemon is up and not enough to say what it decided.
     *
     * `listening` is its own field rather than membership of this list, and it is computed from the
     * addresses actually bound. Measured on the bench board, 2026-09-21: `end0` was named in the
     * configuration and bound to nothing, and a view drawing the names the policy chose rendered
     * that identically to a working wire. **A screen that cannot express a defect reports that
     * there is none.**
     *
     * ## Null, and never an empty list, until the policy has run
     *
     * An empty list is a reassuring answer — *nothing was refused* — given in exactly the case where
     * nobody has looked yet. These two facts must stay distinguishable on the wire, so a client that
     * draws nothing for an empty list does not also draw nothing for a device that has decided
     * nothing. This project has now met that same shape from three directions in one day.
     */
    channels: Type.Union([
      Type.Array(
        Type.Object({
          interface: Type.String(),
          class: ChannelClass,
          /** Every address the kernel reports for it, whether or not anything is listening on one. */
          addresses: Type.Array(Type.String()),
          /** Whether the daemon is answering on one of those addresses — bound, not merely chosen. */
          listening: Type.Boolean(),
        }),
      ),
      Type.Null(),
    ]),
    /**
     * Refused by the final gate, which is the gate that will not bind a tunnel.
     *
     * **A name in this list is never good news.** The gate is a last line; reaching it means the
     * positive half of the policy offered a tunnel interface as a management channel, which is a
     * defect upstream rather than a lucky save. It is on the wire so that the one screen where a
     * person could see it stops printing, in words, that this device does not report refusals.
     *
     * Null until the policy has run, for the reason given on `channels`.
     */
    refused: Type.Union([Type.Array(ChannelExclusion), Type.Null()]),
    /**
     * Local channels deliberately left out — today only the uplink, when the operator turns it off.
     *
     * Separate from `refused` because the two mean opposite things about the health of the device:
     * one is a choice the operator made and the other is a defect that was caught. Collapsing them
     * into one list would make the refusal that matters unfindable among the routine ones.
     *
     * Null until the policy has run, for the reason given on `channels`.
     */
    withheld: Type.Union([Type.Array(ChannelExclusion), Type.Null()]),
    listen: Type.Object({
      port: Type.Number(),
      addresses: Type.Array(Type.String()),
      /** Configured interfaces that currently resolve to no address. */
      unresolvedInterfaces: Type.Array(Type.String()),
    }),
    clock: Type.Object({
      timezone: Type.Union([Type.String(), Type.Null()]),
      ntpEnabled: Type.Union([Type.Boolean(), Type.Null()]),
      synchronized: Type.Union([Type.Boolean(), Type.Null()]),
    }),
    binaries: Type.Array(
      Type.Object({
        name: Type.String(),
        present: Type.Boolean(),
        path: Type.Union([Type.String(), Type.Null()]),
        version: Type.Union([Type.String(), Type.Null()]),
        features: Type.Array(Type.String()),
        neededFor: Type.String(),
      }),
    ),
    warnings: Type.Array(Type.String()),
  },
  { $id: 'SystemResponse' },
);
export type SystemResponse = Static<typeof SystemResponse>;

/**
 * The binding selector, with its `$id` removed, for embedding rather than referencing.
 *
 * **The trap, and it stops the daemon from starting rather than producing a bad reply.** A schema
 * carrying an `$id` that appears twice inside one route's response makes Fastify refuse to compile
 * the serializer — *reference "HardwareBinding" resolves to more than one schema*, thrown during
 * route registration. `InventoryResponse` carries the candidate list twice, once per kind of
 * hardware, so the selector inside it is embedded twice. Nothing about the shape is wrong and no
 * amount of checking the object would show it; only asking the route does.
 *
 * Derived from the one definition rather than restated, so the two cannot drift. Serialisation is
 * the only use — validation and the profile document keep the identified schema.
 */
const { $id: _hardwareBindingId, ...HardwareBindingInline } = HardwareBinding;

/**
 * One piece of hardware a role could be bound to, and the selector that would bind it.
 *
 * Declared here because a Fastify response schema is a **serializer**: a key the schema does not
 * name is dropped from the reply silently — no error, no log line. That is the trap recorded in
 * `docs/16`, and it is the reason this is a written-out schema rather than `Type.Unknown()`. Every
 * field below is one the chooser needs and would otherwise lose on the way out.
 *
 * The list itself is built in one place on the device and never re-derived here. A classifier on the
 * client's side of this contract would be a second source of truth about what a piece of hardware
 * is, and the kernel makes that easy to get wrong: it reports a radio with the same link type as a
 * wired port.
 */
export const BindingCandidate = Type.Object(
  {
    suggestion: HardwareBindingInline,
    /**
     * False when the suggestion also matches a sibling.
     *
     * On the wire rather than filtered out, because the screen must never offer a choice that does
     * not choose: picking such a candidate produces exactly the ambiguity the chooser exists to
     * resolve, and a candidate quietly missing from the list is the dishonest form of that.
     */
    distinct: Type.Boolean(),
    /**
     * What the suggestion costs, when a distinguishing selector had to replace one that follows the
     * device.
     *
     * **Optional, and its absence means there is nothing to say** — not that nobody looked. It is
     * present only on the trade it describes: an identifier follows the device into another port, a
     * bus path follows the port and stops matching once the device is moved.
     */
    consequence: Type.Optional(Type.String()),
    label: Type.String({ description: 'One line a person can read; the fields below are the same facts, separately.' }),
    currentName: Type.Union([Type.String(), Type.Null()]),
    mac: Type.Union([Type.String(), Type.Null()]),
    busPath: Type.Union([Type.String(), Type.Null()]),
    usbId: Type.Union([Type.String(), Type.Null()]),
    phy: Type.Union([Type.String(), Type.Null()]),
    /** Null is *nothing measured it*, which is not `false`. A USB Ethernet adapter is the case a `false` here would get wrong. */
    removable: Type.Union([Type.Boolean(), Type.Null()]),
    bands: Type.Array(Type.String()),
  },
  /*
   * **No `$id`, deliberately.** It appears twice inside `InventoryResponse` — once per kind of
   * hardware — and a registered `$id` embedded twice in one document makes Fastify refuse to build
   * the serializer at all: *reference "BindingCandidate" resolves to more than one schema*, thrown
   * while the route is being registered. That is a server that does not start, not a bad reply, and
   * it is invisible to anything that only checks the shape of the object. `test/binding-candidates`
   * asks the route itself, which is the only way this is caught.
   */
);
export type BindingCandidateWire = Static<typeof BindingCandidate>;

/**
 * The inventory document.
 *
 * Deep driver output is typed as `Unknown` on purpose: the whole point of the inventory is
 * that it carries what the driver said, and a schema that enumerates the fields of `iw phy`
 * would be a second description of somebody else's output — the exact mistake this project
 * avoids in its protocol model. The *shape* is fixed (reported versus derived, combinations
 * kept structurally); the leaves are whatever the hardware reported.
 */
export const InventoryResponse = Type.Object(
  {
    at: Type.String(),
    system: Type.Object({
      kernel: Type.String(),
      architecture: Type.String(),
      cpuCount: Type.Number(),
      memoryMb: Type.Number(),
      boardModel: Type.Union([Type.String(), Type.Null()]),
    }),
    radios: Type.Array(
      Type.Object({
        phy: Type.String(),
        reported: Type.Unknown({ description: 'Exactly what the driver and the kernel reported.' }),
        derived: Type.Unknown({ description: 'Conclusions, each naming the observation behind it.' }),
      }),
    ),
    interfaces: Type.Array(Type.Unknown()),
    binaries: Type.Array(Type.Unknown()),
    clock: Type.Unknown(),
    notes: Type.Array(Type.String()),
    /**
     * The same hardware again, as choices a role can be bound to.
     *
     * **Optional, and the two empty answers are not the same answer.** Absent means nobody looked —
     * a producer of this document that does not build candidates says so by leaving the key out. An
     * empty list means this device was asked and has no hardware of that kind, which is a finding a
     * screen can state. `[]` in place of absence is the reassuring answer given in exactly the case
     * where nothing was checked.
     *
     * Two lists rather than one, because the question a chooser is asking is always about one kind:
     * an access point is bound to a radio and a wired uplink to a port. An empty `radios` beside a
     * non-empty `interfaces` is then an answer *about radios* rather than about the inventory —
     * which a single merged list could not say without the client classifying, and classifying is
     * the thing this contract exists to keep on the device.
     */
    candidates: Type.Optional(
      Type.Object(
        { radios: Type.Array(BindingCandidate), interfaces: Type.Array(BindingCandidate) },
        { additionalProperties: false },
      ),
    ),
  },
  { $id: 'InventoryResponse' },
);
export type InventoryResponse = Static<typeof InventoryResponse>;

export const StatusResponse = Type.Object(
  {
    at: Type.String(),
    network: Type.Union([Type.Unknown(), Type.Null()]),
    units: Type.Record(Type.String(), Type.Unknown()),
    accessPoints: Type.Record(Type.String(), Type.Unknown()),
    links: Type.Record(Type.String(), Type.Unknown()),
    clock: Type.Union([Type.Unknown(), Type.Null()]),
    /**
     * One entry per tunnel — `{ id, service, restarts, since }` — or `null` before the first reading.
     *
     * **`service` is an aggregate over the tunnel's units and says nothing about whether traffic
     * passes.** Nothing on this device measures a handshake or a byte through a tunnel. Measured on
     * the bench board, 2026-09-21: one tunnel's unit stayed `active` for an hour while never once
     * completing key negotiation, and another answered its own resource in half a second while the
     * guard in front of it refused every connection. A tunnel's real condition, when something
     * measures it, gets a field of its own; this one is named for what it reads.
     *
     * **`null` is not `[]`.** `[]` means the profile has no tunnels; `null` means none have been read
     * yet. Declared here because a response schema is a serializer: a key this object does not name
     * is dropped from the body without an error, a warning or a log line — which is the same silence
     * that hid this field's absence in the first place.
     */
    tunnels: Type.Union([Type.Array(Type.Unknown()), Type.Null()]),
    /** Poll counts, skips and the last duration: a status view that stops changing has a reason. */
    poller: Type.Unknown(),
    stationHistory: Type.Array(Type.Unknown()),
  },
  { $id: 'StatusResponse' },
);
export type StatusResponse = Static<typeof StatusResponse>;

/**
 * Whether this device is running what its stored profile says it should be.
 *
 * `report` is `null` before the check has run once, and that is a third answer rather than a
 * reassuring one: a client must be able to tell "nobody has looked yet" from "nothing diverged".
 * `state: "unreadable"` is the same distinction one level in — the check was attempted and could not
 * be made, which is not a healthy device.
 *
 * Every field is declared. A response schema is a serializer here: a key this object does not name is
 * dropped from the body with no error and no log line, which is how a field that nobody could see
 * stayed invisible once before in this file.
 */
export const DriftFindingSchema = Type.Object(
  {
    severity: Type.String(),
    code: Type.String(),
    kind: Type.String(),
    /** The generated file path, the unit name, or the sysctl key. */
    subject: Type.String(),
    /** A JSON Pointer **inside** `subject` when it is JSON both sides parsed, otherwise null. */
    pointer: Type.Union([Type.String(), Type.Null()]),
    /** What re-deriving the stored profile produces. */
    stored: Type.Union([Type.String(), Type.Null()]),
    /** What the device actually holds. */
    running: Type.Union([Type.String(), Type.Null()]),
    message: Type.String(),
    hint: Type.String(),
    /** The file paths whose divergence is why a unit finding exists. Absent means "not recorded". */
    becauseOf: Type.Optional(Type.Array(Type.String())),
  },
  { $id: 'DriftFinding' },
);
export type DriftFindingSchema = Static<typeof DriftFindingSchema>;

export const DriftResponse = Type.Object(
  {
    report: Type.Union([
      Type.Object({
        state: Type.String(),
        reason: Type.String(),
        findings: Type.Array(DriftFindingSchema),
        checked: Type.Object({ files: Type.Number(), units: Type.Number(), sysctl: Type.Number() }),
        omitted: Type.Number(),
        error: Type.Optional(Type.String()),
        /**
         * When the report was made, for a person reading it.
         *
         * **Not for arithmetic.** This board has no clock battery and the wall clock can step by days;
         * `ageSeconds` below is the same fact from a monotonic clock and is the one to compute with.
         */
        at: Type.String(),
        durationMs: Type.Number(),
        /**
         * When the check ran, as the boot it ran in and the seconds since that boot — the clock every
         * process on the device shares. Null when either could not be read; absent in a report stored
         * before this field existed.
         */
        checkedAt: Type.Optional(
          Type.Union([Type.Object({ bootId: Type.String(), uptimeSeconds: Type.Number() }), Type.Null()]),
        ),
      }),
      Type.Null(),
    ]),
    /** Seconds since the report was made, from a monotonic clock. Null when there is no report. */
    ageSeconds: Type.Union([Type.Number(), Type.Null()]),
    /** One sentence, in the terms the question was asked in. */
    summary: Type.String(),
  },
  { $id: 'DriftResponse' },
);
export type DriftResponse = Static<typeof DriftResponse>;

/**
 * One reading an observer took, or one thing it did.
 *
 * `at` is for a person and **never for arithmetic** — this board has no clock battery. `ageSeconds`
 * is the same fact from the daemon's monotonic clock and is the one to compute with.
 */
const ObserverReadingSchema = Type.Object({
  at: Type.String(),
  ageSeconds: Type.Number(),
  what: Type.String(),
  /** The reading one subject at a time — one per guard — when the observer has several. Never truncated as a list. */
  //
  // Every field `ObserverItem` carries must be listed here. The response serialiser drops a key the schema
  // does not declare, silently: until 2026-09-24 this listed three, and the device served every tunnel's
  // reading without how it was measured, what was done, or its colour.
  items: Type.Optional(
    Type.Array(
      Type.Object({
        subject: Type.String(),
        state: Type.String(),
        note: Type.Union([Type.String(), Type.Null()]),
        /** How it was measured: for a tunnel, peer keepalive, gateway echo, traffic or neutral endpoints. */
        method: Type.Optional(Type.String()),
        /** What the mechanism did about it — including nothing, and why. */
        action: Type.Optional(Type.String()),
        /** `bad` is red. A tunnel that reads dead is `bad` even when nothing acted on it. */
        tone: Type.Optional(Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('bad')])),
        /**
         * Present only while a `fall-through` tunnel's traffic is leaving outside it: whole seconds on the
         * daemon's monotonic clock from when it first saw that, to this reading. "Since" is the client's
         * clock minus this plus the reading's `ageSeconds` — never a timestamp from a board with no RTC.
         */
        fallingThroughSeconds: Type.Optional(Type.Number()),
      }),
    ),
  ),
});

/**
 * Every mechanism on the device that watches or waits for something, and whether it is doing so.
 *
 * A mechanism that is silent while idle cannot be told apart from a dead one, so each reports when it
 * last looked and what it saw, when it last acted and what it did, and — as a problem, never as an
 * absence — when it is not running or has not looked within its own cadence.
 */
export const ObserversResponse = Type.Object(
  {
    observers: Type.Array(
      Type.Object({
        name: Type.String(),
        watches: Type.String(),
        /** The longest it should go without looking. Null for a mechanism woken only by events. */
        everySeconds: Type.Union([Type.Number(), Type.Null()]),
        state: Type.Union([Type.Literal('ok'), Type.Literal('stale'), Type.Literal('not-running'), Type.Literal('failing')]),
        /** Why the state is not `ok`. Null exactly when it is. */
        problem: Type.Union([Type.String(), Type.Null()]),
        lastLooked: Type.Union([ObserverReadingSchema, Type.Null()]),
        lastActed: Type.Union([ObserverReadingSchema, Type.Null()]),
      }),
    ),
    /** How many observers are not `ok`. Zero is a statement about every one of them, not an absence. */
    problems: Type.Number(),
  },
  { $id: 'ObserversResponse' },
);
export type ObserversResponse = Static<typeof ObserversResponse>;

/**
 * How old this device's copy of each rule set is.
 *
 * A separate route from `/api/drift` for the same reason drift is separate from `/api/status`: drift
 * answers *what is wrong*, and this answers *how old is each list*, which has a reading for every
 * set and not only for the ones in trouble. A screen that showed only the bad ones would leave a
 * person unable to tell "this list is fine" from "this list was not looked at".
 *
 * **`ageSeconds` is null whenever no honest number exists** — an unsynchronised clock, a file that
 * is not there, a file that could not be read, a timestamp this device's clock cannot support. It is
 * never a zero and never a guess; `state` and `summary` say which of those it is. This board has no
 * clock battery, and the argument for refusing to compute rather than computing badly is in
 * `apps/daemon/src/core/rule-set-age.ts`.
 *
 * **On a remote set the figure is a LOWER bound and understates.** The core keeps every remote set in
 * one cache file, so its modification time is the most recent write by *any* of them: a fresh-looking
 * figure says something in the cache was refreshed, not that this set was. `exact: false` carries
 * that. The one property that survives is the useful one — a bound already past the threshold means
 * the true age is too, so the overdue verdict never false-alarms and only misses.
 */
export const RuleSetAgeSchema = Type.Object(
  {
    tag: Type.String(),
    type: Type.String(),
    /** `fresh`, `overdue`, `never-fetched`, `unreadable`, `no-cadence` or `unmeasurable`. */
    state: Type.String(),
    ageSeconds: Type.Union([Type.Number(), Type.Null()]),
    /**
     * The same number in words, formatted **on the device**, so the product has one formatter for it.
     *
     * A client prints this rather than dividing `ageSeconds` itself. Two formatters for one quantity
     * had already drifted once: a pill reading `1h` above a sentence reading `83m ago`.
     */
    ageLabel: Type.Union([Type.String(), Type.Null()]),
    intervalHours: Type.Union([Type.Number(), Type.Null()]),
    overdueAfterSeconds: Type.Union([Type.Number(), Type.Null()]),
    /** The file the answer was read from, so a person can look at the same thing the device did. */
    observedFrom: Type.Union([Type.String(), Type.Null()]),
    /**
     * False when the figure is a **lower** bound shared with every other remote set.
     *
     * Declared because it changes what the number means. The core keeps every remote set in one
     * cache file and this device cannot read inside it, so the timestamp is the most recent write by
     * any of them: every set was refreshed at or before it, and a set may be very much older than
     * the figure says. It understates, and a client that renders it as a measured age is telling
     * somebody a list is fresh on evidence that says only that *something* was refreshed.
     */
    exact: Type.Boolean(),
    /** One sentence, and the whole of what a screen needs when there is no number. */
    summary: Type.String(),
  },
  { $id: 'RuleSetAge' },
);
export type RuleSetAgeSchema = Static<typeof RuleSetAgeSchema>;

export const RuleSetAgesResponse = Type.Object(
  {
    /**
     * The profile these ages are about, which is always the **active** one.
     *
     * Declared, and a client must check it. The ages describe files this device actually holds, and
     * the only profile that caused a file to be written is the one that was applied; a client
     * editing a different profile that happens to reuse a tag would otherwise be shown the running
     * profile's freshness for a set this device may never have fetched — a false "this list is
     * fine", produced by a join on a string.
     *
     * `null` means no profile is active, and then `sets` is empty.
     */
    profileId: Type.Union([Type.String(), Type.Null()]),
    /** Only the sets a routing rule points at: an unused set costs nobody traffic. */
    sets: Type.Array(RuleSetAgeSchema),
  },
  { $id: 'RuleSetAgesResponse' },
);
export type RuleSetAgesResponse = Static<typeof RuleSetAgesResponse>;

export const LoginRequest = Type.Object(
  {
    password: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { $id: 'LoginRequest' },
);
export type LoginRequest = Static<typeof LoginRequest>;

/**
 * `mustChangePassword` was removed from this contract, deliberately and not by oversight.
 *
 * It answered `!setupComplete` and told a client to show the change-password screen and nothing else.
 * The owner removed the forced change, so the field would now answer `false` for ever — a value that
 * has stopped varying while every reader still believes it varies. That is the failure this codebase
 * has already paid for repeatedly: a producer and a consumer that disagree about whether a value still
 * carries information, invisible from both sides. Keeping it "just in case" leaves that mine for
 * whoever writes the next client. Whether the default password is still in place is reported by
 * `setupComplete`, as a fact rather than an instruction.
 */
export const LoginResponse = Type.Object(
  {
    /**
     * Whether the default password has been replaced. **Information, not permission.**
     *
     * It gated the API until the password was changed, and the owner removed that gate: the default
     * password is short on purpose and changing it is never forced. The field stays because the fact is
     * worth reporting — a device still carrying the shipped credential is a thing an operator should be
     * able to see — but nothing refuses a request on it, and a client that treats it as a barrier is
     * reinventing the one that was deliberately taken out.
     */
    setupComplete: Type.Boolean({
      description:
        'False while the device still carries the default password. Reported so it can be seen, not ' +
        'enforced: nothing is refused on this value.',
    }),
  },
  { $id: 'LoginResponse' },
);
export type LoginResponse = Static<typeof LoginResponse>;

export const ChangePasswordRequest = Type.Object(
  {
    currentPassword: Type.String({ minLength: 1, maxLength: 512 }),
    // Twelve characters rather than eight: this is the only credential protecting full control
    // over routing, and it is typed once into a browser that can remember it.
    newPassword: Type.String({ minLength: 12, maxLength: 512 }),
  },
  { $id: 'ChangePasswordRequest' },
);
export type ChangePasswordRequest = Static<typeof ChangePasswordRequest>;

export const TokenScope = Type.Union([Type.Literal('read'), Type.Literal('apply'), Type.Literal('admin')], {
  $id: 'TokenScope',
});

export const CreateTokenRequest = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    scopes: Type.Array(TokenScope, { minItems: 1 }),
    expiresAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { $id: 'CreateTokenRequest' },
);
export type CreateTokenRequest = Static<typeof CreateTokenRequest>;

export const TokenSummary = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    scopes: Type.Array(TokenScope),
    createdAt: Type.String(),
    lastUsedAt: Type.Union([Type.String(), Type.Null()]),
    expiresAt: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'TokenSummary' },
);
export type TokenSummary = Static<typeof TokenSummary>;

export const CreateTokenResponse = Type.Object(
  {
    token: Type.String({ description: 'Shown once. Only its SHA-256 is stored.' }),
    summary: TokenSummary,
  },
  { $id: 'CreateTokenResponse' },
);

export const LogsQuery = Type.Object(
  {
    unit: Type.Optional(Type.String({ maxLength: 256 })),
    /** Maximum syslog priority to include: 3 is errors and worse, 7 is everything. */
    level: Type.Optional(Type.Integer({ minimum: 0, maximum: 7 })),
    since: Type.Optional(Type.String({ maxLength: 64, description: 'journalctl -S value, e.g. -1h.' })),
    grep: Type.Optional(Type.String({ maxLength: 256 })),
    cursor: Type.Optional(Type.String({ maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  },
  { $id: 'LogsQuery' },
);
export type LogsQuery = Static<typeof LogsQuery>;

export const LogsResponse = Type.Object(
  {
    source: Type.Literal('journal'),
    entries: Type.Array(
      Type.Object({
        at: Type.Union([Type.String(), Type.Null()]),
        atMs: Type.Union([Type.Number(), Type.Null()]),
        priority: Type.Union([Type.Number(), Type.Null()]),
        unit: Type.Union([Type.String(), Type.Null()]),
        identifier: Type.Union([Type.String(), Type.Null()]),
        message: Type.String(),
        bootId: Type.Union([Type.String(), Type.Null()]),
        cursor: Type.Union([Type.String(), Type.Null()]),
      }),
    ),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    currentBootId: Type.Union([Type.String(), Type.Null()]),
    /**
     * True when entries from an earlier boot are included. The journal here is RAM-backed, so
     * after an abrupt power loss everything before the current boot is gone and an empty log
     * would otherwise look like an absence of events.
     */
    containsEarlierBoots: Type.Boolean(),
    /** More entries exist beyond this page — not merely that the page came out full. */
    hasMore: Type.Boolean(),
    /**
     * This page is a fragment: the read was abandoned before the page filled, so the window has a
     * hole in it that no cursor will reveal. Shown to the operator rather than hidden, because a log
     * viewer that skips silently is worse than one that says it stopped early.
     */
    incomplete: Type.Boolean(),
    incompleteReason: Type.Union([Type.String(), Type.Null()]),
    /** True when the journal holds nothing at all for the current boot. */
    currentBootEmpty: Type.Boolean(),
  },
  { $id: 'LogsResponse' },
);
export type LogsResponse = Static<typeof LogsResponse>;

export const EventLogQuery = Type.Object(
  {
    kind: Type.Optional(Type.String({ maxLength: 64 })),
    level: Type.Optional(Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')])),
    since: Type.Optional(Type.String({ maxLength: 64 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
  },
  { $id: 'EventLogQuery' },
);
export type EventLogQuery = Static<typeof EventLogQuery>;

export const EventLogResponse = Type.Object(
  {
    source: Type.Literal('database'),
    /** The ring's capacity, so the interface can state the retention rule rather than imply it. */
    capacity: Type.Number(),
    count: Type.Number(),
    entries: Type.Array(
      Type.Object({
        id: Type.Number(),
        at: Type.String(),
        level: Type.String(),
        kind: Type.String(),
        summary: Type.String(),
        detail: Type.Unknown(),
      }),
    ),
  },
  { $id: 'EventLogResponse' },
);
export type EventLogResponse = Static<typeof EventLogResponse>;

export const DebugLevelRequest = Type.Object(
  {
    level: Type.Union([Type.Literal('trace'), Type.Literal('debug'), Type.Literal('info')]),
    /**
     * Minutes after which the level returns to normal on its own, so a forgotten debug session
     * cannot fill the 200 MB journal and evict the lines that mattered.
     */
    minutes: Type.Integer({ minimum: 1, maximum: 120 }),
  },
  { $id: 'DebugLevelRequest' },
);
export type DebugLevelRequest = Static<typeof DebugLevelRequest>;

export const DebugLevelResponse = Type.Object(
  {
    level: Type.String(),
    revertsAt: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'DebugLevelResponse' },
);

/**
 * The body `POST /api/system/poweroff` accepts, declared for the documentation.
 *
 * The route checks it by hand rather than trusting this schema, and the reason is the refusal: a
 * validation failure answers with the validator's wording, and a caller who sent nothing, or the wrong
 * word, must be told exactly what to send. Only `{"confirm":"poweroff"}` is accepted — any other key is
 * refused rather than ignored, so a caller expecting a dry run cannot get the real thing.
 */
export const PowerOffRequest = Type.Object(
  {
    confirm: Type.Optional(
      Type.String({ description: 'Exactly `poweroff`. Anything else, or no body, is refused and nothing is done.' }),
    ),
  },
  { $id: 'PowerOffRequest' },
);
export type PowerOffRequest = Static<typeof PowerOffRequest>;

export const PowerOffResponse = Type.Object(
  {
    accepted: Type.Boolean(),
    /** How long after this answer the power-off is asked for, so a client can stop expecting replies. */
    poweringOffInSeconds: Type.Number(),
    message: Type.String(),
  },
  { $id: 'PowerOffResponse' },
);
export type PowerOffResponse = Static<typeof PowerOffResponse>;

export const ALL_SCHEMAS = [
  ErrorBody,
  ErrorResponse,
  HealthResponse,
  SystemResponse,
  InventoryResponse,
  StatusResponse,
  LoginRequest,
  LoginResponse,
  ChangePasswordRequest,
  TokenScope,
  CreateTokenRequest,
  TokenSummary,
  CreateTokenResponse,
  LogsQuery,
  LogsResponse,
  EventLogQuery,
  EventLogResponse,
  DebugLevelRequest,
  DebugLevelResponse,
  PowerOffRequest,
  PowerOffResponse,
];

/* ── the profile document and its secrets ────────────────────────────────────────────────── */

export * from './identifier.ts';
export * from './tunnel-configs.ts';
export * from './secrets.ts';
export * from './secret-transforms.ts';
export * from './profile.ts';
export * from './profile-migrations.ts';
export * from './migrate-to-catalogue.ts';
export * from './profile-defaults.ts';
export * from './validate-profile.ts';
export * from './routing-rules.ts';
export * from './parity.ts';
export * from './source.ts';
