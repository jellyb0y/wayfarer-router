/**
 * The database: the runtime's own SQLite, plain SQL, one module.
 *
 * All SQL in this project lives under `src/state/`. That is the whole reason a query builder
 * is not used here — see the correction in docs/09-stack.md — and it is what keeps the option
 * of adopting one later to a change in this directory.
 *
 * Pragmas are chosen for a card that should outlast the project, and the rule that matters
 * more than any of them: **hot data is never written.** Live status, station lists, signal
 * strength and traffic counters stay in memory. This file sees the device row, sessions,
 * tokens and a bounded ring of significant events.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.ts';

export interface OpenOptions {
  /** Path to the database file, or `:memory:` in tests. */
  path: string;
  /** Applied after opening; overridable only so tests can turn durability down. */
  pragmas?: Record<string, string | number>;
}

export const DEFAULT_PRAGMAS: Record<string, string | number> = {
  // Write-ahead logging: a reader never blocks the writer, and a crash costs the last
  // transaction rather than the file.
  journal_mode: 'WAL',
  // NORMAL rather than FULL: with WAL this loses at most the last transaction on power loss,
  // and this database holds configuration, not money.
  synchronous: 'NORMAL',
  // Checkpoint after roughly 1 MB of WAL rather than the 4 MB default, so the WAL does not
  // sit large on a card with a long commit interval.
  wal_autocheckpoint: 256,
  busy_timeout: 5000,
  temp_store: 'MEMORY',
  foreign_keys: 'ON',
};

export interface Database {
  raw: DatabaseSync;
  /** Applied schema version, from `user_version`. */
  version(): number;
  close(): void;
}

export function openDatabase(options: OpenOptions): Database {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  }

  const raw = new DatabaseSync(options.path);
  const pragmas = { ...DEFAULT_PRAGMAS, ...(options.pragmas ?? {}) };
  for (const [key, value] of Object.entries(pragmas)) {
    // Pragma names and values here are ours, never user input — parameters are not allowed
    // in a PRAGMA statement, so this is the only form available.
    raw.exec(`PRAGMA ${key} = ${typeof value === 'number' ? String(value) : String(value)};`);
  }

  migrate(raw);

  return {
    raw,
    version(): number {
      return readUserVersion(raw);
    },
    close(): void {
      raw.close();
    },
  };
}

/**
 * Applies pending migrations in order, each in its own transaction.
 *
 * A database at a *higher* version than the code is an error and not something to repair:
 * it means an older bundle was deployed over a newer one, and letting old code write to a
 * newer schema is how a configuration is silently corrupted. The update flow's answer is to
 * roll the bundle forward again, which is why it keeps the previous one.
 */
export function migrate(raw: DatabaseSync): { from: number; to: number; applied: number[] } {
  const from = readUserVersion(raw);
  const target = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

  if (from > target) {
    throw new Error(
      `database schema is at version ${from} but this build knows ${target}. A newer ` +
        'version of the daemon has already migrated it; deploy that build again rather than ' +
        'letting this one write to a schema it does not understand.',
    );
  }

  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    raw.exec('BEGIN IMMEDIATE');
    try {
      raw.exec(migration.sql);
      raw.exec(`PRAGMA user_version = ${migration.version};`);
      raw.exec('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      raw.exec('ROLLBACK');
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${String(error)}`);
    }
  }

  return { from, to: readUserVersion(raw), applied };
}

function readUserVersion(raw: DatabaseSync): number {
  const row = raw.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}
