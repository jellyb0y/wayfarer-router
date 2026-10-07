/**
 * Profile and transaction storage.
 *
 * A narrow repository over plain SQL, kept separate from the device store because the split between
 * profile state and device state is not cosmetic: importing someone else's configuration must not
 * change your password or revoke your tokens, and switching profiles must not log you out. Anything
 * that would be wrong to *receive* from another person belongs to the other file.
 *
 * Documents are stored with their secrets **wrapped**. The wrapper is what stops code walking a
 * document generically — the differ, the exporter, the logger — from treating a private key as an
 * ordinary string it may print, and it is applied on the way in rather than trusted from the caller.
 */

import { randomBytes } from 'node:crypto';
import {
  PROFILE_SCHEMA_VERSION,
  ProfileCatalogueError,
  ProfileVersionError,
  assertProfileDocument,
  migrateProfile,
  missingSecrets,
  redactForExport,
  redactForRead,
  wrapSecrets,
  type SecretKind,
} from '@wayfarer/schemas';
import type { Database } from './db.ts';
import { TRANSACTION_RING_SIZE } from './migrations.ts';
import type { BlastRadius } from '../core/differ.ts';
import { assertTransition, type TransactionState } from '../core/transactions.ts';
import type { SecretMatchers, SecretPlan } from './secret-plan.ts';

export interface ProfileRow {
  id: string;
  name: string;
  document: unknown;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  description: string | null;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  /** Secrets this document is still missing, from a redacted import. */
  missingSecrets: { pointer: string; kind: SecretKind }[];
  /**
   * Why this row's document could not be read, or absent when it could.
   *
   * **A row that cannot be migrated is still a row the operator owns**, and the four columns above
   * come from SQL rather than from the document, so they are readable whatever the document says.
   * Dropping such a row from the list — or letting its exception out of `list()` — leaves an
   * operator who cannot see the id, cannot name it to a refusal and cannot delete it. See
   * `ProfileUnreadableError`.
   */
  fault?: ProfileFault;
}

/**
 * A stored document this build cannot bring forward, described rather than thrown away.
 *
 * `code` matches the API error contract so a route can answer with it unchanged.
 */
export interface ProfileFault {
  code: 'profile_catalogue_unsupported' | 'profile_schema_version_unsupported' | 'profile_unreadable';
  message: string;
  hint: string;
  detail?: Record<string, unknown>;
}

/**
 * A read of one profile that could not produce a document.
 *
 * Migration is **lazy, on read** — see `toRow` — which is what made the absence of this class an
 * outage rather than a bad row. `migrateProfile` throws `ProfileCatalogueError` for a v6 tunnel
 * naming a provider the catalogue does not have, and v6's `provider` was an open string, so such a
 * document is ordinary prior state and not corruption. With nothing catching it, one such row made
 * `GET /api/profiles` answer 500 **for the whole list**, and the only path that did not go through
 * `toRow` was `delete` — so the operator could not see which id to delete either.
 *
 * Thrown by the single-profile readers, where there is no honest answer but a refusal; caught by
 * `list()`, where every other row still has one.
 */
export class ProfileUnreadableError extends Error {
  readonly profileId: string;
  readonly profileName: string;
  readonly fault: ProfileFault;

  constructor(profileId: string, profileName: string, fault: ProfileFault) {
    super(fault.message);
    this.name = 'ProfileUnreadableError';
    this.profileId = profileId;
    this.profileName = profileName;
    this.fault = fault;
  }
}

/** The fault a failed migration describes, in the API's own vocabulary. */
export function profileFaultOf(error: unknown): ProfileFault {
  if (error instanceof ProfileCatalogueError) {
    return {
      code: 'profile_catalogue_unsupported',
      message: error.message,
      hint:
        'Nothing has stopped: the tunnels, the access point and the firewall are run by units that ' +
        'do not depend on this daemon. This profile can no longer be managed, so delete it with ' +
        'DELETE /api/profiles/{id} — that path does not read the document — or recreate the tunnel ' +
        'on a protocol this build runs.',
      detail: { tunnels: error.tunnels },
    };
  }
  if (error instanceof ProfileVersionError) {
    return {
      code: 'profile_schema_version_unsupported',
      message: error.message,
      hint:
        'This document was written by a different build. Update this device, or delete the profile ' +
        'with DELETE /api/profiles/{id}, which does not read the document.',
      detail: { found: error.found, supported: error.supported },
    };
  }
  return {
    code: 'profile_unreadable',
    message: error instanceof Error ? error.message : String(error),
    hint: 'Delete the profile with DELETE /api/profiles/{id}, which does not read the document.',
  };
}

/**
 * A file another network manager owned, moved out of the way so an interface could be taken over.
 *
 * Recorded on the transaction because the undo has exactly the same lifetime as the confirmation
 * window, and because the profile model cannot express it: a revert re-applies a *document*, and no
 * document says "somebody else's file was disabled".
 */
export interface TakeoverRecord {
  /** Where the file was. */
  from: string;
  /** Where it is now. Never a deletion. */
  to: string;
  /**
   * Which manager owned it, so the undo knows whose reload to run.
   *
   * **Two undos, not one**, and that is the shape rather than an extra field: *restoring a file is not
   * restoring an effect*. Putting the file back is the first undo; asking the manager we displaced to
   * re-apply its own configuration is the second, and without it the device stays broken while every
   * file on disk says it should not be. Measured on the bench board, where a takeover was
   * configuration-reversible and not effect-reversible and the deadman had to rescue the board.
   *
   * Optional only so a record written by an earlier build still reads; anything written now sets it.
   */
  by?: string;
}

export interface TransactionRow {
  id: string;
  profileId: string | null;
  /**
   * The document to go back to: the one that was last **successfully applied**, not the one this
   * transaction is installing. Null when nothing has ever been applied on this device, in which case
   * the revert target is the built-in recovery profile.
   */
  documentBefore: unknown;
  /** The document this transaction installed. Becomes the next transaction's `documentBefore`. */
  documentAfter: unknown;
  kind: string;
  blastRadius: BlastRadius;
  state: TransactionState;
  plan: unknown;
  createdAt: string;
  /**
   * The wall-clock deadline, for a human reading this row later. **Not** what a countdown is computed
   * from: see `firesAtUptimeSeconds`.
   */
  deadlineAt: string | null;
  /**
   * The same deadline in the frame the armed timer acts on — seconds since boot, as handed to the
   * transient unit's `OnBootSec`. This is the one to derive a remaining time from, because this device
   * has no clock battery and the apply that opens the window restarts `systemd-timesyncd`, so the wall
   * clock can step by days inside the window itself.
   *
   * `null` for a row written before this was recorded, or when the platform could not read uptime.
   */
  firesAtUptimeSeconds: number | null;
  confirmedAt: string | null;
  revertedAt: string | null;
  reason: string | null;
  /**
   * The credential that opened this transaction — a session id or an API token id — or `null` for a
   * transaction the device opened itself, such as a boot-time re-derivation.
   *
   * Recorded for exactly one purpose: a credential is never expired while a transaction **it** opened
   * is awaiting confirmation. See `core/credential-expiry.ts`.
   */
  openedBy: string | null;
  /** The transient unit that was armed for this transaction, as armed rather than as re-derived. */
  revertUnit: string | null;
  takeover: TakeoverRecord[];
}

export interface ProfileStore {
  list(activeId: string | null): ProfileSummary[];
  get(id: string): ProfileRow | null;
  /** The document with secrets replaced by whether they are set. What a `GET` returns. */
  getRedacted(id: string): unknown | null;
  /** The sharing format: secrets replaced by the kind a person must go and find. */
  export(id: string, includeSecrets: boolean): { document: unknown; secretsIncluded: boolean } | null;
  create(document: unknown): ProfileRow;
  replace(id: string, document: unknown): ProfileRow;
  delete(id: string): boolean;
  /** Validates, migrates and stores. Reports which secrets the imported document is missing. */
  import(raw: unknown): { profile: ProfileRow; migratedFrom: number; applied: string[]; missing: { pointer: string; kind: SecretKind }[] };
  /** Secrets still missing, so activation can be refused with a list rather than a failure. */
  missing(id: string): { pointer: string; kind: SecretKind }[];
  /**
   * Matchers for a document, for the one caller outside this file that needs them: the write path,
   * which must resolve `{"$keep": true}` against the stored value before the document is handed back
   * here. Exposed through the store rather than computed by that caller, so there is still exactly one
   * source of matchers.
   */
  matchersFor(document: unknown): SecretMatchers;

  createTransaction(input: {
    profileId: string | null;
    /**
     * The revert target. Callers should not compute this: `lastAppliedDocument()` is the one source,
     * and passing anything else is how a revert comes to re-apply the document that broke the device.
     */
    documentBefore: unknown;
    /** The document being installed. */
    documentAfter: unknown;
    kind: string;
    blastRadius: BlastRadius;
    plan: unknown;
    /**
     * The credential that asked for this — a session id or an API token id. Omitted for work the device
     * starts by itself. Only used to keep that credential alive while this transaction awaits
     * confirmation; see `core/credential-expiry.ts`.
     */
    openedBy?: string | null;
  }): TransactionRow;
  transaction(id: string): TransactionRow | null;
  /**
   * Moves a transaction to a new state, refusing a transition the declared machine does not allow.
   *
   * The guard is here rather than at each caller because a state column that anything may overwrite
   * is a history that can contradict the device: writing `committed` over a row that was already
   * `reverted` produces a record saying the change stuck.
   */
  setTransactionState(id: string, state: TransactionState, reason?: string | null): void;
  /** Records the deadline and the unit that was armed, moving the row to `awaiting-confirm`. */
  /**
   * Opens the window, recording both the wall-clock deadline (for a human reading the row later) and
   * the boot-relative one the armed timer will actually act on. `firesAtUptimeSeconds` is `null` only
   * when the platform could not report it, and a caller that gets `null` has no anchored deadline to
   * show — see `secondsRemainingFrom`.
   */
  beginConfirmationWindow(
    id: string,
    deadlineAt: string,
    revertUnit: string,
    firesAtUptimeSeconds: number | null,
  ): void;
  /** Confirmation: an explicit human act, never inferred from a client reconnecting. */
  confirmTransaction(id: string, at?: string): void;
  /** Marks the moment a revert finished, so the row says when rather than only that. */
  finishRevert(id: string, at?: string): void;
  /**
   * Records what the window's health check currently finds about an open transaction, in `reason`, or
   * clears it with `null`. Only while the row is `awaiting-confirm`; a row in any other state is left
   * alone, because a finding arriving after a confirmation or a revert is about a window that has shut.
   *
   * On the row rather than only in memory, because the revert that acts on it at the deadline is run by
   * the transient timer in **another process** (`way revert`), and it must be able to say what the
   * check read. `revertTransaction` folds it into the reason the revert records.
   */
  noteWindowFinding(id: string, finding: string | null): void;
  recordTakeover(id: string, entries: TakeoverRecord[]): void;
  recentTransactions(limit?: number): TransactionRow[];
  /**
   * The single transaction still inside its confirmation window, if any.
   *
   * There can be at most one: a second apply is refused while one is open, because two armed revert
   * timers mean the second fires against a document the operator already abandoned, at a moment they
   * have stopped expecting anything to happen.
   */
  unconfirmedTransaction(): TransactionRow | null;
  /**
   * The document that was last successfully applied on this device, or null if none ever was.
   *
   * Device state, derived from the transaction history rather than from any profile. This is the
   * revert target for the next transaction, and the reason it is a method here rather than a
   * computation at the call site.
   */
  lastAppliedDocument(): unknown | null;
  /**
   * Recent apply attempts for one profile, newest first, as state and time only.
   *
   * The safe-mode count is **derived** from this rather than kept in a counter. A counter would have to
   * be incremented in every failure path and reset in every success path, and the day somebody adds a
   * third path it is wrong in a direction nobody notices. See `core/safe-mode.ts`.
   */
  recentAttempts(
    profileId: string,
    limit?: number,
  ): { at: string; state: string; reason: string | null; profileRevision: number | null }[];
  /**
   * The profile's revision: a counter that increases on every operator edit and never otherwise.
   *
   * Exists so that "is this apply attempt about the configuration in force now?" can be answered by
   * identity instead of by comparing two wall-clock instants on a device whose clock the apply itself
   * steps. `null` when there is no such profile.
   */
  profileRevision(profileId: string): number | null;
}

/*
 * `UncoveredSecretsError` was here, and it is **deleted** along with the condition that raised it.
 *
 * It refused to store a profile with tunnels while the provider schemas were unavailable, because a
 * tunnel's secrets then could not be identified and would be written in clear. Under schema version
 * 7 a tunnel's configuration is typed and its credentials are declared in this repository's own
 * schema, so the coverage no longer depends on a binary being installed and the refusal has no
 * remaining cause — it had become a device that could not be configured because an unrelated
 * download had not finished. See `state/secret-plan.ts` for the measurement.
 */

/**
 * The store, built around a `SecretPlan`.
 *
 * The plan is a **required** constructor argument, and it is the single chokepoint: every write wraps
 * through `matchersFor(document)`, every read redacts through it, and there is no path in this file
 * that computes matchers any other way. That shape is the fix — the previous version reduced the
 * static schema once, at construction, which silently covered nothing inside a tunnel's opaque
 * configuration and could not be corrected by remembering to call something extra.
 */
export function createProfileStore(
  database: Database,
  secretPlan: SecretPlan,
  /**
   * Called once per profile whose document a migration actually changed.
   *
   * Optional, because the store must work in a test with no event ring — but the caller in the daemon
   * supplies it, and it matters for one reason above the others: a migration can change what a stored
   * configuration *means*, and an operator who is never told has no way to notice. The blocked-endpoint
   * step is exactly that case.
   */
  onMigrated?: (event: { profileId: string; name: string; applied: string[]; from: number }) => void,
): ProfileStore {
  const db = database.raw;
  const now = (): string => new Date().toISOString();

  /** The only way matchers are obtained here. Depends on the document, because the answer does. */
  const matchersFor = (document: unknown): SecretMatchers => secretPlan.forDocument(document);

  /**
   * One stored row, **migrated to the current document version on the way out**.
   *
   * Migration used to happen only on `import`, which meant a document written by an older build stayed at
   * its old version for ever and every reader saw the old shape. An update that added fields to the
   * schema therefore left existing devices with those fields missing — which is exactly the set of
   * documents an update meets. Measured on the bench board, 2026-09-21: the health watchdog threw
   * `Cannot read properties of undefined (reading 'length')` once every thirty seconds against a profile
   * that predated the probe fields, and the migration written to fix it would never have run.
   *
   * Migrating here makes every read self-healing, and the result is written back so it happens once
   * rather than on every read. The write is guarded on the version actually changing, so an ordinary read
   * of an up-to-date document touches nothing — a read that wrote on every call would put the profile
   * table on the card in a loop.
   *
   * A document from a **newer** build is refused rather than downgraded, which `migrateProfile` does: the
   * parts this build does not understand would otherwise be dropped silently, and a dropped routing rule
   * sends traffic somewhere nobody chose.
   */
  const toRow = (row: Record<string, unknown>): ProfileRow => {
    const id = String(row['id']);
    const stored = JSON.parse(String(row['document'])) as Record<string, unknown>;

    // Lazy migration means the step runs here, inside a read, and `migrateToCatalogue` refuses a
    // whole document by design. Unwrapped, that refusal left this method as the only reader and
    // took every other profile with it. The refusal is kept — it is right — and given an identity
    // so a caller can answer with it instead of with a 500.
    let migrated;
    try {
      migrated = migrateProfile(stored);
    } catch (error) {
      throw new ProfileUnreadableError(id, String(row['name']), profileFaultOf(error));
    }

    if (migrated.applied.length > 0) {
      // Deliberately does not touch `revision` or `updated_at`: a schema migration is not a change of
      // configuration, and treating it as one would discard the failure history of the profile the
      // operator is actually running at the moment they most need safe mode to notice.
      db.prepare('UPDATE profiles SET document = ?, schema_version = ? WHERE id = ?').run(
        JSON.stringify(migrated.document),
        PROFILE_SCHEMA_VERSION,
        id,
      );
      onMigrated?.({ profileId: id, name: String(row['name']), applied: migrated.applied, from: migrated.from });
    }

    return {
      id,
      name: String(row['name']),
      document: migrated.document,
      schemaVersion: migrated.applied.length > 0 ? PROFILE_SCHEMA_VERSION : Number(row['schema_version']),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  };

  const store: ProfileStore = {
    list(activeId) {
      const rows = db.prepare('SELECT * FROM profiles ORDER BY name').all() as Record<string, unknown>[];
      return rows.map((raw) => {
        // Per row, not per list. Every column this summary needs but `description` comes from SQL,
        // so a document nothing can read still produces a row an operator can see, name and delete.
        let row: ProfileRow;
        try {
          row = toRow(raw);
        } catch (error) {
          if (!(error instanceof ProfileUnreadableError)) throw error;
          return {
            id: error.profileId,
            name: error.profileName,
            description: null,
            schemaVersion: Number(raw['schema_version']),
            createdAt: String(raw['created_at']),
            updatedAt: String(raw['updated_at']),
            active: error.profileId === activeId,
            missingSecrets: [],
            fault: error.fault,
          };
        }
        const meta = (row.document as { meta?: { description?: string } }).meta ?? {};
        return {
          id: row.id,
          name: row.name,
          description: meta.description ?? null,
          schemaVersion: row.schemaVersion,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          active: row.id === activeId,
          missingSecrets: missingSecrets(row.document, matchersFor(row.document)),
        };
      });
    },

    get(id) {
      const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? toRow(row) : null;
    },

    getRedacted(id) {
      const row = store.get(id);
      return row === null ? null : redactForRead(row.document, matchersFor(row.document));
    },

    export(id, includeSecrets) {
      const row = store.get(id);
      if (row === null) return null;
      // A full export is a separate, explicit action requiring the admin scope, and it is recorded as
      // an event by the caller. The default is the sharing format.
      return {
        document: includeSecrets ? row.document : redactForExport(row.document, matchersFor(row.document)),
        secretsIncluded: includeSecrets,
      };
    },

    create(document) {
      const id = randomBytes(8).toString('hex');
      const at = now();
      const wrapped = wrapSecrets(document, matchersFor(document)) as Record<string, unknown>;
      // The schema, applied, at the one door every write goes through — `import` comes here too.
      // It used to be enforced nowhere: the three write routes declared `body: Type.Unknown()` and
      // the only check between a request and this line was a four-key structural one. Validating
      // the *wrapped* document rather than the argument means what is checked is exactly what is
      // about to be written, rather than a value one transform away from it.
      assertProfileDocument(wrapped);
      const meta = (wrapped['meta'] ?? {}) as Record<string, unknown>;
      const name = typeof meta['name'] === 'string' ? meta['name'] : 'Untitled';

      db.prepare(
        'INSERT INTO profiles (id, name, document, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, name, JSON.stringify(wrapped), Number(wrapped['schemaVersion'] ?? 1), at, at);

      return { id, name, document: wrapped, schemaVersion: Number(wrapped['schemaVersion'] ?? 1), createdAt: at, updatedAt: at };
    },

    replace(id, document) {
      const at = now();
      const wrapped = wrapSecrets(document, matchersFor(document)) as Record<string, unknown>;
      assertProfileDocument(wrapped);
      const meta = (wrapped['meta'] ?? {}) as Record<string, unknown>;
      const name = typeof meta['name'] === 'string' ? meta['name'] : 'Untitled';

      // `revision = revision + 1` in the same statement as the document, so an edit and its new
      // identity cannot be written apart. Safe mode asks "was this attempt about the configuration I
      // have now?", which is a question about identity; answering it by comparing wall-clock instants
      // on a device whose clock steps mid-apply meant the answer was sometimes "none of them were".
      db.prepare(
        'UPDATE profiles SET name = ?, document = ?, schema_version = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
      ).run(name, JSON.stringify(wrapped), Number(wrapped['schemaVersion'] ?? 1), at, id);
      const row = store.get(id);
      if (row === null) throw new Error(`no profile ${id}`);
      return row;
    },

    delete(id) {
      const result = db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
      return Number(result.changes ?? 0) > 0;
    },

    import(raw) {
      // Migrate first, then store. A document from the future is refused rather than accepted with the
      // parts this build does not understand silently dropped — dropping a routing rule sends traffic
      // somewhere nobody intended.
      const migrated = migrateProfile(raw);
      const profile = store.create(migrated.document);
      return {
        profile,
        migratedFrom: migrated.from,
        applied: migrated.applied,
        // The gaps, listed rather than hidden. This beats rejecting the import: the structure, which is
        // the valuable part, transfers, and what is missing is explicit.
        missing: missingSecrets(profile.document, matchersFor(profile.document)),
      };
    },

    matchersFor,

    missing(id) {
      const row = store.get(id);
      return row === null ? [] : missingSecrets(row.document, matchersFor(row.document));
    },

    createTransaction(input) {
      const id = randomBytes(8).toString('hex');
      const at = now();
      db.prepare(
        // `profile_revision` is stamped from the profile row in the same statement that creates the
        // transaction, so an attempt always says which configuration it was an attempt at. Read as a
        // sub-select rather than passed in, because a value carried from the caller is a value that can
        // be stale by the time it is written.
        `INSERT INTO transactions
           (id, profile_id, document_before, document_after, kind, blast_radius, state, plan, created_at,
            profile_revision, opened_by)
         VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?,
                 (SELECT revision FROM profiles WHERE id = ?), ?)`,
      ).run(
        id,
        input.profileId,
        // The revert target, stored in full. It costs a few kilobytes and it is the entire reason
        // rollback is simple: there is no inverse to compute, only a document we already hold.
        input.documentBefore === null ? null : JSON.stringify(input.documentBefore),
        input.documentAfter === null ? null : JSON.stringify(input.documentAfter),
        input.kind,
        input.blastRadius,
        JSON.stringify(input.plan),
        at,
        input.profileId,
        input.openedBy ?? null,
      );
      pruneTransactions();
      return {
        id,
        profileId: input.profileId,
        documentBefore: input.documentBefore,
        documentAfter: input.documentAfter,
        kind: input.kind,
        blastRadius: input.blastRadius,
        state: 'staged',
        firesAtUptimeSeconds: null,
        openedBy: input.openedBy ?? null,
        plan: input.plan,
        createdAt: at,
        deadlineAt: null,
        confirmedAt: null,
        revertedAt: null,
        reason: null,
        revertUnit: null,
        takeover: [],
      };
    },

    transaction(id) {
      const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? toTransaction(row) : null;
    },

    setTransactionState(id, state, reason = null) {
      const current = store.transaction(id);
      if (current === null) throw new Error(`no transaction ${id}`);
      // The declared machine, enforced. Without this the seven states are decoration and a caller can
      // write `committed` over a row that was already `reverted`.
      assertTransition(current.state, state);
      db.prepare('UPDATE transactions SET state = ?, reason = COALESCE(?, reason) WHERE id = ?').run(state, reason, id);
    },

    beginConfirmationWindow(id, deadlineAt, revertUnit, firesAtUptimeSeconds) {
      const current = store.transaction(id);
      if (current === null) throw new Error(`no transaction ${id}`);
      assertTransition(current.state, 'awaiting-confirm');
      db.prepare(
        `UPDATE transactions
            SET state = 'awaiting-confirm', deadline_at = ?, revert_unit = ?, fires_at_uptime_seconds = ?
          WHERE id = ?`,
      ).run(deadlineAt, revertUnit, firesAtUptimeSeconds, id);
    },

    confirmTransaction(id, at) {
      const current = store.transaction(id);
      if (current === null) throw new Error(`no transaction ${id}`);
      assertTransition(current.state, 'committed');
      db.prepare("UPDATE transactions SET state = 'committed', confirmed_at = ? WHERE id = ?").run(at ?? now(), id);
    },

    noteWindowFinding(id, finding) {
      db.prepare("UPDATE transactions SET reason = ? WHERE id = ? AND state = 'awaiting-confirm'").run(finding, id);
    },

    finishRevert(id, at) {
      const current = store.transaction(id);
      if (current === null) throw new Error(`no transaction ${id}`);
      assertTransition(current.state, 'reverted');
      db.prepare("UPDATE transactions SET state = 'reverted', reverted_at = ? WHERE id = ?").run(at ?? now(), id);
    },

    recordTakeover(id, entries) {
      // Merged rather than replaced, so a reconciler that moves files in more than one step cannot
      // lose the earlier ones — and the undo has to know about every file, not the last batch.
      const current = store.transaction(id);
      if (current === null) throw new Error(`no transaction ${id}`);
      const merged = [...current.takeover];
      for (const entry of entries) {
        if (!merged.some((existing) => existing.from === entry.from)) merged.push(entry);
      }
      db.prepare('UPDATE transactions SET takeover = ? WHERE id = ?').run(JSON.stringify(merged), id);
    },

    recentTransactions(limit = 20) {
      const rows = db
        .prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?')
        .all(Math.min(Math.max(limit, 1), 200)) as Record<string, unknown>[];
      return rows.map(toTransaction);
    },

    unconfirmedTransaction() {
      const row = db
        .prepare("SELECT * FROM transactions WHERE state = 'awaiting-confirm' ORDER BY created_at DESC LIMIT 1")
        .get() as Record<string, unknown> | undefined;
      return row ? toTransaction(row) : null;
    },

    profileRevision(profileId) {
      const row = db.prepare('SELECT revision FROM profiles WHERE id = ?').get(profileId) as
        | Record<string, unknown>
        | undefined;
      return row === undefined ? null : Number(row['revision'] ?? 0);
    },

    recentAttempts(profileId, limit = 20) {
      const rows = db
        .prepare(
          // `reason` is selected because the decision depends on it: a revert the operator asked for is
          // not a failure, and the state alone cannot tell the two apart. Omitting it meant the safe-mode
          // count was deciding while looking away from the one field that distinguishes the cases.
          // Ordered by `rowid`, which is insertion order, and **not** by `created_at`. Safe mode reads
          // this list as a *consecutive run* of failures, and ordering a run by a wall clock that can
          // step backwards mid-apply scrambles the run itself — the newest row stops being first, and
          // the loop that breaks on the first non-failure breaks in the wrong place.
          `SELECT created_at, state, reason, profile_revision FROM transactions
            WHERE profile_id = ? ORDER BY rowid DESC LIMIT ?`,
        )
        .all(profileId, limit) as Record<string, unknown>[];
      return rows.map((row) => ({
        at: String(row['created_at']),
        state: String(row['state']),
        reason: row['reason'] === null || row['reason'] === undefined ? null : String(row['reason']),
        profileRevision:
          row['profile_revision'] === null || row['profile_revision'] === undefined
            ? null
            : Number(row['profile_revision']),
      }));
    },

    lastAppliedDocument() {
      const row = db
        .prepare(
          `SELECT document_after FROM transactions
            WHERE state = 'committed' AND document_after IS NOT NULL
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as Record<string, unknown> | undefined;
      if (!row || row['document_after'] === null) return null;
      return JSON.parse(String(row['document_after']));
    },
  };

  /**
   * Keeps the table bounded, oldest first.
   *
   * Each row holds up to two complete profile documents, so leaving this unbounded is a slow leak
   * onto the only component of this device that wears out — the same shape as the session rows that
   * were never deleted. Pruning happens here, on insert, rather than on a timer: a timer on a device
   * that is switched off abruptly may never run.
   *
   * The newest `committed` row is exempt, and that exemption is load-bearing rather than cautious: it
   * is the revert target for every transaction that follows it, and a long run of failures could
   * otherwise push it out of any fixed window and leave the device with nothing to go back to.
   */
  function pruneTransactions(): void {
    db.prepare(
      `DELETE FROM transactions
        WHERE id NOT IN (SELECT id FROM transactions ORDER BY created_at DESC LIMIT ?)
          AND id IS NOT (
            SELECT id FROM transactions
             WHERE state = 'committed' AND document_after IS NOT NULL
             ORDER BY created_at DESC LIMIT 1
          )`,
    ).run(TRANSACTION_RING_SIZE);
  }

  return store;
}

function toTransaction(row: Record<string, unknown>): TransactionRow {
  return {
    id: String(row['id']),
    profileId: row['profile_id'] === null ? null : String(row['profile_id']),
    documentBefore: row['document_before'] === null ? null : JSON.parse(String(row['document_before'])),
    documentAfter: row['document_after'] == null ? null : JSON.parse(String(row['document_after'])),
    revertUnit: row['revert_unit'] == null ? null : String(row['revert_unit']),
    takeover: parseTakeover(row['takeover']),
    kind: String(row['kind']),
    blastRadius: String(row['blast_radius']) as BlastRadius,
    state: String(row['state']) as TransactionState,
    plan: row['plan'] === null ? null : JSON.parse(String(row['plan'])),
    createdAt: String(row['created_at']),
    deadlineAt: row['deadline_at'] === null ? null : String(row['deadline_at']),
    firesAtUptimeSeconds:
      row['fires_at_uptime_seconds'] == null ? null : Number(row['fires_at_uptime_seconds']),
    openedBy: row['opened_by'] == null ? null : String(row['opened_by']),
    confirmedAt: row['confirmed_at'] === null ? null : String(row['confirmed_at']),
    revertedAt: row['reverted_at'] === null ? null : String(row['reverted_at']),
    reason: row['reason'] === null ? null : String(row['reason']),
  };
}

/**
 * Reads the takeover record defensively.
 *
 * Anything unreadable becomes an empty list rather than throwing, and that direction is chosen on
 * purpose: this value is read on the revert path, which runs when the device is already in trouble. A
 * malformed column must not stop a revert — the worst case is that some files are not moved back, and
 * a revert that happens is strictly better than one that throws while parsing its own bookkeeping.
 */
function parseTakeover(value: unknown): TakeoverRecord[] {
  if (value == null) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is TakeoverRecord =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as TakeoverRecord).from === 'string' &&
        typeof (entry as TakeoverRecord).to === 'string',
    );
  } catch {
    return [];
  }
}

export type { TransactionState };
