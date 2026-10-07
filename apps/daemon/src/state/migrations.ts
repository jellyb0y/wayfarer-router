/**
 * Schema migrations, embedded in the bundle as strings.
 *
 * They are not files on disk on purpose: the daemon ships as one bundled JavaScript file,
 * so a migration read from a directory at start-up would be a second artefact to deploy and
 * keep in step with the bundle — and a version mismatch between the two is a database the
 * code does not understand. Embedded, they cannot diverge from the code that needs them.
 *
 * Rules for adding one: append, never edit an existing entry, and keep each migration
 * idempotent where SQLite allows it. `user_version` records the applied level, so a
 * downgrade is visible rather than silently destructive.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'device, sessions, tokens, events',
    sql: `
      -- Exactly one row, enforced by the primary key. The device identity and the settings
      -- that belong to this box rather than to a configuration document.
      CREATE TABLE device (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        device_name        TEXT    NOT NULL DEFAULT 'wayfarer',
        admin_password_hash TEXT   NOT NULL DEFAULT '',
        -- False until the default credentials have been replaced. While false the API
        -- refuses every route except login, the password change and a minimal status.
        setup_complete     INTEGER NOT NULL DEFAULT 0,
        -- The machine API is off until a human turns it on.
        api_enabled        INTEGER NOT NULL DEFAULT 0,
        active_profile_id  TEXT,
        created_at         TEXT    NOT NULL,
        updated_at         TEXT    NOT NULL
      ) STRICT;

      CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        user_agent  TEXT
      ) STRICT;

      CREATE TABLE api_tokens (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        -- Only the hash is stored; the value is shown once, at creation.
        token_sha256 TEXT NOT NULL UNIQUE,
        scopes       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_used_at TEXT,
        expires_at   TEXT
      ) STRICT;

      -- The persistent ring: significant events only, so this stays a few kilobytes of
      -- writes a day rather than a stream. Telemetry is never written here.
      CREATE TABLE events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        at      TEXT NOT NULL,
        level   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail  TEXT
      ) STRICT;

      CREATE INDEX events_at_idx ON events (at);
      CREATE INDEX events_kind_idx ON events (kind);

      -- Convenience only, re-derivable from the hardware at any time. Kept so the interface
      -- has something to show before discovery finishes on a cold start.
      CREATE TABLE inventory_cache (
        id       INTEGER PRIMARY KEY CHECK (id = 1),
        at       TEXT NOT NULL,
        document TEXT NOT NULL
      ) STRICT;

      -- Login attempts, for rate limiting and for the event ring. Rows older than the
      -- window are deleted on each check, so this does not grow.
      CREATE TABLE login_attempts (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       TEXT NOT NULL,
        source   TEXT NOT NULL,
        succeeded INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX login_attempts_source_idx ON login_attempts (source, at);
    `,
  },
  {
    version: 2,
    name: 'profiles and transactions',
    sql: `
      -- A profile is one complete configuration document. Exactly one is active, which is what makes
      -- switching a single action and rollback a re-apply of a document we already hold rather than
      -- an inverse operation to compute.
      --
      -- The document's own schemaVersion lives inside the JSON as well as in this column: an exported
      -- profile has to carry its version, because a document outlives the device that wrote it.
      CREATE TABLE profiles (
        id            TEXT PRIMARY KEY,
        name          TEXT    NOT NULL,
        document      TEXT    NOT NULL,
        schema_version INTEGER NOT NULL,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
      ) STRICT;

      CREATE INDEX profiles_name_idx ON profiles (name);

      -- Transactions. The full state machine is in the CHECK below and only part of it is reachable
      -- in this slice: staged, applying, committed and failed. The awaiting-confirm, reverting and
      -- reverted states belong to the confirmation window, which does not exist yet — and they are declared
      -- now rather than added later so the API contract does not change shape between slices.
      --
      -- document_before holds a FULL copy of the previous profile. It costs a few kilobytes and it is
      -- the entire reason rollback is simple: reverting is not an inverse to compute, it is a document
      -- we already have being applied again through the same planner and reconciler.
      CREATE TABLE transactions (
        id             TEXT PRIMARY KEY,
        profile_id     TEXT,
        document_before TEXT,
        kind           TEXT    NOT NULL,
        blast_radius   TEXT    NOT NULL CHECK (blast_radius IN ('hot','service','network','boot')),
        state          TEXT    NOT NULL CHECK (state IN (
                         'staged','applying','awaiting-confirm','committed','reverting','reverted','failed'
                       )),
        plan           TEXT,
        created_at     TEXT    NOT NULL,
        deadline_at    TEXT,
        confirmed_at   TEXT,
        reverted_at    TEXT,
        reason         TEXT
      ) STRICT;

      CREATE INDEX transactions_state_idx ON transactions (state);
      CREATE INDEX transactions_created_idx ON transactions (created_at);
    `,
  },
  {
    version: 3,
    name: 'the revert path: what to go back to, what was armed, what was moved aside',
    sql: `
      -- The document that WAS successfully applied, as opposed to the one this transaction is
      -- installing. The previous slice stored only document_before and set it to the active
      -- profile's document, which for a plain apply is the same document being installed — so a
      -- revert would have re-applied the thing that had just broken the device. A revert that
      -- reverts nothing is worse than none, because the log says recovery happened.
      --
      -- The revert target for a new transaction is therefore the document_after of the most recent
      -- COMMITTED transaction: device state, derived from this table, rather than anything in a
      -- profile. When there is none — the very first apply a device has ever performed — the target
      -- is the built-in recovery profile, and the event says so, so that a device found running the
      -- recovery configuration is not read as a mysterious factory reset.
      ALTER TABLE transactions ADD COLUMN document_after TEXT;

      -- The transient unit that was actually armed, recorded rather than re-derived. A name computed
      -- twice is a name that can be computed differently twice, and the failure mode of getting it
      -- wrong is a revert timer that nothing can cancel. It also lets the fallback naming style be
      -- used on a systemd that refuses an instantiated transient name without the confirm path
      -- needing to know which style was chosen.
      ALTER TABLE transactions ADD COLUMN revert_unit TEXT;

      -- Files moved aside to take an interface over from another network manager, as a JSON array of
      -- { from, to } pairs. This lives on the transaction because the undo has exactly the same
      -- lifetime as the confirmation window, and because the profile model has no way to express
      -- "somebody else's file was disabled" — a revert re-applies a document, and no document says
      -- that. Nothing is ever deleted: we do not know what another program's file is for, the user
      -- may need it, and deletion is the one action no revert can undo.
      ALTER TABLE transactions ADD COLUMN takeover TEXT;

      -- Rows are pruned on insert, oldest first. Each row holds up to two complete profile
      -- documents, so an unbounded table is a slow leak onto the one component of this device that
      -- wears out — the same shape as the session rows that were never deleted. The newest committed
      -- row is exempt from pruning because it is the revert target for everything that follows it,
      -- and a failure loop could otherwise push it out of any fixed window.
      CREATE INDEX transactions_state_created_idx ON transactions (state, created_at);
    `,
  },
  {
    version: 4,
    name: 'a profile revision, so "which configuration was this attempt about" is not a clock question',
    sql: `
      -- Safe mode counts consecutive failed applies *of the current configuration*, and had to decide
      -- which attempts were about a configuration the operator has since changed. It did that by
      -- comparing the attempt's wall-clock timestamp against the profile's updated_at — two instants
      -- written at different moments by a device with no clock battery, whose clock is stepped by the
      -- timesyncd restart that the apply itself performs. A backward step made every attempt look
      -- older than the edit, the run broke at the first row, the count was zero, and the device could
      -- not enter safe mode however many times the apply failed.
      --
      -- "Was this attempt about the configuration I have now?" is a question about identity, not about
      -- time, and it is answered here by a counter that only ever increases. Existing rows start at 0,
      -- which is correct: they predate this column and no attempt claims a revision, so none of them is
      -- credited to the current one.
      ALTER TABLE profiles ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

      -- The revision the transaction was applying, stamped when the transaction is created. Null for
      -- rows written before this migration, which is how they are excluded rather than by a guess.
      ALTER TABLE transactions ADD COLUMN profile_revision INTEGER;
    `,
  },
  {
    version: 5,
    name: 'the confirmation deadline in the frame that acts on it',
    sql: `
      -- The moment the armed revert timer will actually fire, as seconds since boot: the same number
      -- given to the transient timer's OnBootSec, stored rather than recomputed.
      --
      -- deadline_at stays, because a row a human reads later should say the wall-clock time. It is no
      -- longer what the countdown is computed from. The two are different frames, and this device has
      -- no clock battery — worse, the apply that opens the window deliberately restarts
      -- systemd-timesyncd, so a wall-clock step inside the window is the designed path and not a
      -- corner case. A forward step made the API report "0 seconds left, it is being undone" while the
      -- timer still had the whole window to run; a backward step reported time remaining after the
      -- revert had already happened. Both are wrong at the one moment the operator has lost access and
      -- is reading the screen to decide whether to intervene.
      ALTER TABLE transactions ADD COLUMN fires_at_uptime_seconds INTEGER;
    `,
  },
  {
    version: 6,
    name: 'credentials and lockouts anchored to boot identity plus uptime, not to the wall clock',
    sql: `
      -- Boot identity plus uptime: durable across a restart, and immune to any wall-clock step.
      --
      -- A login attempt counts towards a lockout only if it is from THIS boot. Across boots its age is
      -- unknown, and the two resolutions are not symmetric: treating undatable rows as recent locks a
      -- legitimate operator out of a device whose management surface is its own access point, while
      -- ignoring them means a reboot clears an in-progress lockout — and nobody reboots this device
      -- without already holding the access a lockout protects. See core/credential-expiry.ts.
      ALTER TABLE login_attempts ADD COLUMN boot_id TEXT;
      ALTER TABLE login_attempts ADD COLUMN uptime_seconds REAL;

      -- A session's life is now a duration since last use, anchored the same way. expires_at stays as a
      -- long backstop and is enforced only when the clock is trusted: a forward step used to retire
      -- every session minted before the first resync, which logged the operator out during the
      -- confirmation window the resync happens inside.
      ALTER TABLE sessions ADD COLUMN boot_id TEXT;
      ALTER TABLE sessions ADD COLUMN last_seen_uptime_seconds REAL;

      -- Which credential opened this transaction, so the one narrow expiry exemption can be exactly
      -- that narrow: a session or token is never expired while a transaction IT opened is awaiting
      -- confirmation. Any broader rule would be a way to keep a credential alive indefinitely.
      ALTER TABLE transactions ADD COLUMN opened_by TEXT;
    `,
  },
  {
    version: 7,
    name: 'device identity, and the peers an aggregate view reads from',
    sql: `
      -- An identity for THIS INSTALLATION, generated once and stored.
      --
      -- Not /etc/machine-id: measured on the bench board, that file was written when the image was
      -- created and travels with the image, so two devices flashed from one card would claim the same
      -- identity and an aggregate view would show one row where there are two. Not the SoC serial
      -- either: that identifies the board rather than the installation, is not available on every
      -- platform, and would change under a card moved to a replacement board while everything the
      -- operator configured stayed the same.
      --
      -- Generated on first read rather than in this migration, because SQL has no good randomness here
      -- and a migration that writes a constant would give every device the same one.
      ALTER TABLE device ADD COLUMN device_id TEXT;

      -- Peers, for the aggregate view. ADDITIVE AND READ-ONLY BY CONSTRUCTION: this table says where to
      -- ask and with what credential, and nothing here can change another device. There is no central
      -- controller, no enrolment, and no peer that is authoritative over another -- each device holds
      -- its own list, and two devices can hold different lists without either being wrong.
      CREATE TABLE peers (
        id          TEXT PRIMARY KEY,
        label       TEXT    NOT NULL,
        base_url    TEXT    NOT NULL,
        -- An API token issued BY THE PEER, with read scope. Stored because there is nowhere else to put
        -- it, and never returned by any route: the API reports whether one is set, exactly as it does
        -- for every other secret in this system.
        token       TEXT    NOT NULL,
        created_at  TEXT    NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 8,
    name: 'the management surfaces the last apply resolved',
    sql: `
      -- Which interfaces the control panel and API were bound to, as JSON { accessPoint, uplinks }.
      --
      -- Recorded rather than recomputed, because the names are only knowable once the hardware bindings
      -- resolve. The profile says "the built-in radio hosts the access point" and "this uplink is pinned";
      -- what comes out is wlan1 or wfwan0 or wlx90de8047b4b4, and only the apply that resolved it knows.
      --
      -- The alternative was to derive the names at bind time from the profile, which produced the expected
      -- name (wfwan0) rather than the resolved one (wlan0 when the uplink is not pinned) -- so an unpinned
      -- uplink was never bound and nothing said why. Comparing a profile's intent with a kernel's answer is
      -- the seam this whole table exists to avoid.
      --
      -- The stored uplinks are still filtered by services.management.onUplinkNetwork when they are read, so
      -- turning the setting off takes effect on the next address change rather than needing an apply.
      ALTER TABLE device ADD COLUMN management_surfaces TEXT;
    `,
  },
  {
    version: 9,
    name: 'the units each of the last plan\'s tunnels is made of',
    sql: `
      -- Which units belong to which tunnel, as JSON [{ id, units }].
      --
      -- Recorded rather than recomputed for the same reason as management_surfaces one row above: the
      -- names come from per-protocol rules in the planner's catalogue, and the alternative was for the
      -- reader to rebuild them from the tunnel's protocol -- a second copy of a naming convention that
      -- agrees with the first exactly until one of them changes.
      --
      -- A tunnel is not one unit. An OpenVPN tunnel has one; the same tunnel behind an obfuscation
      -- transport has a transport unit as well; a VLESS tunnel has its client. So this is a list per
      -- tunnel, and the rule for combining several units into one verdict belongs to whoever reads it.
      --
      -- NULL means no plan has recorded anything yet, which is why the column is read as "unknown"
      -- rather than as "this device has no tunnels". An empty JSON array is the second of those.
      ALTER TABLE device ADD COLUMN tunnel_units TEXT;
    `,
  },
  {
    version: 10,
    name: 'the last drift report, whichever process made it',
    sql: `
      -- The latest comparison of this device with its stored profile, as JSON, stamped with the boot id
      -- and the uptime it was made at.
      --
      -- In the database rather than in the daemon's memory, because the daemon is not the only process
      -- that makes one: the timer that reverts an unconfirmed transaction runs \`way revert\` in a process
      -- of its own, and its report used to reach only the event ring. GET /api/drift then kept serving a
      -- finding the revert had already resolved (bench board, 2026-09-23). One row, whoever wrote last.
      ALTER TABLE device ADD COLUMN last_drift TEXT;
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * How many transaction rows are kept.
 *
 * Enough to read the recent history of a device during an incident, few enough that two profile
 * documents per row stay negligible. Pruning happens on insert rather than on a timer, for the same
 * reason the event ring does: a timer on a device that is switched off abruptly may never run.
 */
export const TRANSACTION_RING_SIZE = 200;
