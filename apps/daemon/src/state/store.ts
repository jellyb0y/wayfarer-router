/**
 * Every query this daemon makes, in one place.
 *
 * Device state is what this particular box is — the admin password, tokens, sessions, the
 * event ring — as opposed to profile state, which is a portable document. The split is not
 * cosmetic: importing someone else's configuration must not change your password or revoke
 * your tokens.
 */

import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Database } from './db.ts';
import {
  attemptCountsTowardsLockout,
  sessionVerdict,
  tokenVerdict,
  type CredentialVerdict,
  type MonotonicStamp,
} from '../core/credential-expiry.ts';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * scrypt parameters, recorded with each hash so they can be raised later without
 * invalidating existing hashes. N=2^15 with r=8 costs roughly 32 MB and a noticeable
 * fraction of a second on a Cortex-A53 — deliberately slow for a login, cheap once.
 */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keyLength: 32 } as const;

export interface DeviceRow {
  /** This installation's identity, generated on first read. See `device()` for what it is not. */
  deviceId: string;
  /**
   * The interfaces the last apply bound the management surface to, or `null` before the first apply.
   *
   * `null` on a fresh device is the truth rather than a failure: nothing has been configured, so there is
   * no access point to join and nothing to bind to beyond loopback.
   */
  managementSurfaces: { accessPoint: string | null; uplinks: string[]; tunnels: string[] } | null;
  /**
   * The units each of the last plan's tunnels is made of, or `null` before any plan has recorded them.
   *
   * `null` and `[]` are different answers and both are reachable: `null` is a device no plan has run
   * on, `[]` is a profile that genuinely has no tunnels. The consumer reports the two differently,
   * which is the whole reason the column is nullable rather than defaulting to an empty array.
   */
  tunnelUnits: { id: string; units: string[]; interfaces?: string[] }[] | null;
  deviceName: string;
  adminPasswordHash: string;
  setupComplete: boolean;
  apiEnabled: boolean;
  activeProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A peer as the API ever shows one: where it is, what it is called, and that a credential exists. */
export interface PeerRow {
  id: string;
  label: string;
  baseUrl: string;
  /** Whether a token is stored. The token itself is never returned. */
  hasToken: boolean;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  createdAt: string;
  /**
   * **Descriptive, not a control.** The instant this session would have expired under the absolute model
   * this project no longer uses.
   *
   * Nothing authorises from it and nothing deletes from it. It is kept because a row saying when a session
   * was created and what life it was given is worth having in an incident, and a test asserts that no
   * authorisation path reads it — an unread stored value that *looks* like a control is how the sweep came
   * to enforce a model the request path had abandoned.
   *
   * What actually governs a session is idle time since last use, anchored to boot identity plus uptime.
   * See `core/credential-expiry.ts`.
   */
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string | null;
}

/** What a caller must supply for a credential to be judged rather than guessed at. */
export interface CredentialCheck {
  now?: Date;
  /** Boot identity plus uptime. `null` means it could not be read; the credential is then unverifiable. */
  stamp?: MonotonicStamp | null;
  /** From the platform's clock status. `null` means the question could not be answered. */
  clockTrusted?: boolean | null;
  /**
   * Given a credential id, whether a transaction **it** opened is awaiting confirmation.
   *
   * Passed as a predicate because the transaction table belongs to another store, and because the
   * exemption has to be evaluated for the specific credential rather than for "any open window".
   */
  holdsOpenWindow?: (credentialId: string) => boolean;
}

/** A credential that was found, with the verdict on whether it may be used. */
export interface SessionLookup {
  session: SessionRow;
  /** `unverifiable` is usable; the caller logs the reason rather than silently honouring it. */
  verdict: CredentialVerdict;
}

export interface TokenLookup {
  token: TokenRow;
  verdict: CredentialVerdict;
}

export type TokenScope = 'read' | 'apply' | 'admin';

export interface TokenRow {
  id: string;
  name: string;
  scopes: TokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface EventRow {
  id: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  kind: string;
  summary: string;
  detail: unknown;
}

/** The ring is bounded: oldest rows are evicted, which is roughly a week or two of history. */
export const EVENT_RING_SIZE = 5000;

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How stale "last seen" is allowed to get before a request pays for a write.
 *
 * One write per request would be one card write per request. Named rather than inlined because the
 * predicate that uses it was silently broken for its whole existence and a named constant makes the
 * test that proves it works readable.
 */
export const TOUCH_THROTTLE_SECONDS = 60;

/**
 * How long a session may go **unused** before it stops working.
 *
 * A duration since last use rather than a lifetime from creation, and the difference is a judgement
 * about people rather than about clocks: an operator who has been working on this device for a week has
 * not become less authorised, and one who signed in and walked away has. The previous rule was seven
 * days from creation, so this is the same order of patience expressed against the thing that matters.
 *
 * Must stay far larger than `TOUCH_THROTTLE_SECONDS`, because that throttle is how often the anchor
 * moves.
 */
export const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;

/**
 * How many login attempts are kept.
 *
 * Pruned by **count and insertion order**, never by time. Pruning by time means a clock step deletes
 * the evidence a lockout is based on, which is a way to clear a lockout by moving a clock.
 */
export const LOGIN_ATTEMPT_HISTORY = 200;

export interface Store {
  device(): DeviceRow;
  setDeviceName(name: string): void;
  /**
   * Records which interfaces the last apply actually bound the management surface to.
   *
   * Device state, not configuration: the profile names a radio and a role, and only the apply that resolved
   * the bindings knows what the interfaces ended up being called.
   */
  setManagementSurfaces(surfaces: { accessPoint: string | null; uplinks: string[]; tunnels: string[] }): void;

  /**
   * Records which units each of the last plan's tunnels is made of.
   *
   * Writing `[]` is a statement — "this profile has no tunnels" — and is what clears a previous
   * recording. There is deliberately no way to write `null` back: the only `null` is the one a device
   * starts with, and a recorded absence of tunnels must not be reported as an absence of knowledge.
   */
  setTunnelUnits(tunnelUnits: { id: string; units: string[]; interfaces?: string[] }[]): void;
  /** The latest drift report, from whichever process made it. See migration 10. */
  setLastDrift(report: unknown): void;
  lastDrift(): unknown | null;

  /* ── peers, for the aggregate view ──────────────────────────────────────────────────────── */

  /** Every peer, without their tokens. A token is never returned, exactly like every other secret. */
  peers(): PeerRow[];
  /** Adds a peer and returns it, again without the token. */
  addPeer(input: { label: string; baseUrl: string; token: string }): PeerRow;
  removePeer(id: string): boolean;
  /**
   * The token for one peer, for the fan-out to use.
   *
   * Separate from `peers()` so that "list the peers" and "use a credential" are different calls. A
   * listing that carried tokens would put them in every response that ever logs or caches a peer list.
   */
  peerToken(id: string): string | null;
  setApiEnabled(enabled: boolean): void;
  /**
   * Which profile is active. This pointer is **device state**, not part of any profile: importing
   * someone else's configuration must not change what this box is running.
   */
  setActiveProfileId(id: string | null): void;
  /** Sets the password and, with it, marks first-run setup complete. */
  setAdminPassword(password: string): Promise<void>;
  verifyAdminPassword(password: string): Promise<boolean>;

  createSession(userAgent: string | null, now?: Date, stamp?: MonotonicStamp | null): SessionRow;
  /**
   * Looks a session up and judges whether it is still usable.
   *
   * The judgement is a duration since last use against `stamp`, not an absolute instant against the
   * wall clock — see `core/credential-expiry.ts` for why, and for the one exemption.
   */
  session(id: string, options?: CredentialCheck): SessionLookup | null;
  /** Records a session as used. Moves both the displayed timestamp and the uptime anchor together. */
  touchSession(id: string, now?: Date, stamp?: MonotonicStamp | null): void;
  deleteSession(id: string): void;
  /**
   * Removes sessions that are past the **idle** limit, by exactly the rule the request path uses.
   *
   * One rule at both doors. The previous version deleted on the absolute `expires_at`, which no
   * authorisation path had read since sessions became idle-based — so the sweep was the last enforcer of
   * an abandoned model, it retired sessions in continuous use, and it did not honour the open-window
   * exemption the request path honours. On this board that is not a rare race: the apply restarts the time
   * service, a forward jump of days is the designed path, and the sweep then removed every session created
   * before the resync — refusing the operator inside their own countdown.
   */
  sweepIdleSessions(options?: CredentialCheck): number;
  /**
   * Ends every session. The clock-free absolute control, used when the password changes.
   *
   * Sessions have no absolute expiry any more, so this is what bounds their life: a credential change
   * invalidates everything issued under the old one. Immediate, and it does not depend on a clock.
   */
  revokeAllSessions(): number;

  createToken(name: string, scopes: TokenScope[], expiresAt?: string | null): { token: string; row: TokenRow };
  tokens(): TokenRow[];
  /**
   * `touch: false` looks without recording a use — for a token that is about to be refused, whose
   * "last used" must not move because it was shown at a closed door.
   */
  tokenBySecret(secret: string, options?: CredentialCheck, touch?: boolean): TokenLookup | null;
  deleteToken(id: string): boolean;

  recordEvent(event: { level: EventRow['level']; kind: string; summary: string; detail?: unknown; at?: string }): EventRow;
  events(options?: { limit?: number; kind?: string; level?: string; since?: string }): EventRow[];
  eventCount(): number;
  /**
   * One page of the ring **and** the ring's total, from one call.
   *
   * The route needed both and made two store calls for them. Two calls is also two moments: a row written
   * between them makes the total disagree with the page, and the screen then says "168 of 5000 kept" above
   * a list of 169. Cheap to fold, so folded.
   */
  eventPage(options?: { limit?: number; kind?: string; level?: string; since?: string }): {
    entries: EventRow[];
    total: number;
  };

  recordLoginAttempt(source: string, succeeded: boolean, now?: Date, stamp?: MonotonicStamp | null): void;
  /** Failures from one source inside the window, for rate limiting. */
  /**
   * Failed attempts from **this boot** inside the window, for a lockout decision.
   *
   * `stamp` is required in effect: without it no age can be computed and the answer is zero, which is
   * deliberately the direction that does not lock anybody out. History is pruned by count and insertion
   * order, never by time, so no clock step can delete evidence.
   */
  recentLoginFailures(source: string, windowSeconds: number, stamp?: MonotonicStamp | null): number;

  cacheInventory(document: unknown, now?: Date): void;
  cachedInventory(): { at: string; document: unknown } | null;
}

export function createStore(database: Database): Store {
  const db = database.raw;
  const now = (value?: Date): string => (value ?? new Date()).toISOString();
  /**
   * The same instant, a fixed number of seconds earlier, in **the same representation** `now` writes.
   *
   * Every stored timestamp in this database is a JavaScript ISO string, so every comparison against one
   * must be too. SQLite's own `datetime()` returns `2026-09-21 00:14:28` — a space where ISO has a `T`,
   * and no fractional seconds — and comparing the two is a *string* comparison in which `'T'` (0x54)
   * sorts after `' '` (0x20) at index 10. `last_seen_at < datetime(?, '-60 seconds')` was therefore
   * false for every ISO value, however old, so the throttled updates below never fired at all and
   * "last seen" and "last used" stayed pinned to the moment of creation on every device. Verified
   * against `node:sqlite`: two minutes stale, zero rows updated; comparing ISO to ISO, one row.
   *
   * Two producers of one quantity in two formats is the same seam defect as a duration crossing two
   * clocks. One writer, one representation.
   */
  const staleBefore = (seconds: number, value?: Date): string =>
    new Date((value ?? new Date()).getTime() - seconds * 1000).toISOString();

  // The single device row is created on first open, with an empty password hash: a device
  // with no password is "unconfigured", which the API gate turns into "only login and the
  // password change are reachable".
  db.exec(`
    INSERT INTO device (id, created_at, updated_at)
    SELECT 1, '${now()}', '${now()}'
    WHERE NOT EXISTS (SELECT 1 FROM device WHERE id = 1);
  `);

  const store: Store = {
    device() {
      const row = db.prepare('SELECT * FROM device WHERE id = 1').get() as Record<string, unknown>;

      /*
       * The device's own identity, generated once on the first read that finds none.
       *
       * Generated here rather than in the migration because SQL has no randomness worth using, and a
       * migration writing a constant would hand every device the same identity — which is precisely the
       * failure this exists to avoid.
       *
       * Deliberately **not** `/etc/machine-id`: measured on the bench board, that file was written when
       * the image was created, so two devices flashed from one card carry the same one and an aggregate
       * view would show a single row where there are two devices. Nor the SoC serial, which identifies
       * the board rather than the installation and would change under a card moved to a replacement
       * board while everything the operator configured stayed put.
       */
      let deviceId = row['device_id'] == null ? '' : String(row['device_id']);
      if (deviceId === '') {
        deviceId = randomBytes(16).toString('hex');
        db.prepare('UPDATE device SET device_id = ? WHERE id = 1').run(deviceId);
      }

      /*
       * Read defensively. A malformed value becomes "nothing recorded" rather than throwing, because this is
       * consulted on the bind path — and a listener that throws while deciding where to listen is a device
       * nobody can reach.
       */
      let managementSurfaces: { accessPoint: string | null; uplinks: string[]; tunnels: string[] } | null = null;
      if (row['management_surfaces'] != null) {
        try {
          const parsed = JSON.parse(String(row['management_surfaces'])) as Record<string, unknown>;
          managementSurfaces = {
            accessPoint: typeof parsed['accessPoint'] === 'string' ? parsed['accessPoint'] : null,
            uplinks: Array.isArray(parsed['uplinks'])
              ? parsed['uplinks'].filter((entry): entry is string => typeof entry === 'string')
              : [],
            // Absent in a record written before this field existed, and empty is the right reading of
            // that: the consumer treats these names as a supplement to the link's own shape, never as
            // the only evidence, so a stale record loses nothing that a link can reveal by itself.
            tunnels: Array.isArray(parsed['tunnels'])
              ? parsed['tunnels'].filter((entry): entry is string => typeof entry === 'string')
              : [],
          };
        } catch {
          managementSurfaces = null;
        }
      }

      /*
       * Read as defensively as the surfaces above, and with the same distinction preserved: a column
       * that is NULL, a value that will not parse and a value that is not an array all become `null`
       * — "nothing recorded" — while a parsed empty array stays `[]`, which means "no tunnels".
       *
       * Entries are filtered rather than the whole value rejected, so one malformed entry written by
       * a future version does not erase the tunnels a reader could still report on.
       */
      let tunnelUnits: { id: string; units: string[]; interfaces?: string[] }[] | null = null;
      if (row['tunnel_units'] != null) {
        try {
          const parsed: unknown = JSON.parse(String(row['tunnel_units']));
          if (Array.isArray(parsed)) {
            tunnelUnits = parsed
              .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
              .filter((entry) => typeof entry['id'] === 'string')
              .map((entry) => ({
                id: String(entry['id']),
                units: Array.isArray(entry['units'])
                  ? entry['units'].filter((unit): unit is string => typeof unit === 'string')
                  : [],
                // Absent in a record written before interfaces were recorded: left absent, which reads
                // as "not known", never as "creates none".
                ...(Array.isArray(entry['interfaces'])
                  ? { interfaces: entry['interfaces'].filter((name): name is string => typeof name === 'string') }
                  : {}),
              }));
          }
        } catch {
          tunnelUnits = null;
        }
      }

      return {
        deviceId,
        managementSurfaces,
        tunnelUnits,
        deviceName: String(row['device_name'] ?? 'wayfarer'),
        adminPasswordHash: String(row['admin_password_hash'] ?? ''),
        setupComplete: row['setup_complete'] === 1,
        apiEnabled: row['api_enabled'] === 1,
        activeProfileId: row['active_profile_id'] === null ? null : String(row['active_profile_id']),
        createdAt: String(row['created_at']),
        updatedAt: String(row['updated_at']),
      };
    },

    setManagementSurfaces(surfaces) {
      db.prepare('UPDATE device SET management_surfaces = ?, updated_at = ? WHERE id = 1').run(
        JSON.stringify(surfaces),
        now(),
      );
    },

    setLastDrift(report) {
      db.prepare('UPDATE device SET last_drift = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(report), now());
    },

    lastDrift() {
      const row = db.prepare('SELECT last_drift FROM device WHERE id = 1').get() as Record<string, unknown> | undefined;
      if (row === undefined || row['last_drift'] == null) return null;
      return safeJson(String(row['last_drift']));
    },

    setTunnelUnits(tunnelUnits) {
      db.prepare('UPDATE device SET tunnel_units = ?, updated_at = ? WHERE id = 1').run(
        JSON.stringify(tunnelUnits),
        now(),
      );
    },

    setDeviceName(name) {
      db.prepare('UPDATE device SET device_name = ?, updated_at = ? WHERE id = 1').run(name, now());
    },

    peers() {
      const rows = db.prepare('SELECT * FROM peers ORDER BY label').all() as Record<string, unknown>[];
      return rows.map(toPeerRow);
    },

    addPeer(input) {
      const id = randomBytes(8).toString('hex');
      const createdAt = now();
      db.prepare('INSERT INTO peers (id, label, base_url, token, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        input.label,
        input.baseUrl,
        input.token,
        createdAt,
      );
      return { id, label: input.label, baseUrl: input.baseUrl, hasToken: input.token !== '', createdAt };
    },

    removePeer(id) {
      const result = db.prepare('DELETE FROM peers WHERE id = ?').run(id);
      return Number(result.changes ?? 0) > 0;
    },

    peerToken(id) {
      const row = db.prepare('SELECT token FROM peers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      const token = String(row['token'] ?? '');
      return token === '' ? null : token;
    },

    setApiEnabled(enabled) {
      db.prepare('UPDATE device SET api_enabled = ?, updated_at = ? WHERE id = 1').run(enabled ? 1 : 0, now());
    },

    setActiveProfileId(id) {
      db.prepare('UPDATE device SET active_profile_id = ?, updated_at = ? WHERE id = 1').run(id, now());
    },

    async setAdminPassword(password) {
      const hash = await hashPassword(password);
      db.prepare('UPDATE device SET admin_password_hash = ?, setup_complete = 1, updated_at = ? WHERE id = 1').run(
        hash,
        now(),
      );
    },

    async verifyAdminPassword(password) {
      const stored = store.device().adminPasswordHash;
      if (stored === '') return false;
      return await verifyPassword(password, stored);
    },

    createSession(userAgent, at, stamp) {
      // 32 random bytes, opaque, stored as-is: revocation is a row deletion, which is
      // immediate and does not depend on a clock that can be days wrong after a power cycle.
      const id = randomBytes(32).toString('base64url');
      const createdAt = now(at);
      const expiresAt = new Date((at ?? new Date()).getTime() + SESSION_LIFETIME_MS).toISOString();
      db.prepare(
        `INSERT INTO sessions (id, created_at, expires_at, last_seen_at, user_agent, boot_id,
                               last_seen_uptime_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, createdAt, expiresAt, createdAt, userAgent, stamp?.bootId ?? null, stamp?.uptimeSeconds ?? null);
      return { id, createdAt, expiresAt, lastSeenAt: createdAt, userAgent };
    },

    session(id, options) {
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) return null;

      const session: SessionRow = {
        id: String(row['id']),
        createdAt: String(row['created_at']),
        expiresAt: String(row['expires_at']),
        lastSeenAt: String(row['last_seen_at']),
        userAgent: row['user_agent'] === null ? null : String(row['user_agent']),
      };

      const holdsOpenWindow = options?.holdsOpenWindow?.(session.id) ?? false;
      const verdict = sessionVerdict({
        anchor: {
          bootId: row['boot_id'] == null ? null : String(row['boot_id']),
          lastSeenUptimeSeconds:
            row['last_seen_uptime_seconds'] == null ? null : Number(row['last_seen_uptime_seconds']),
        },
        stamp: options?.stamp ?? null,
        idleLimitSeconds: SESSION_IDLE_SECONDS,
        holdsOpenWindow,
      });

      if (verdict.kind === 'expired') {
        // Deleted on the way past rather than left for a sweep: a session that has been looked up
        // and found expired will never be used again, and this is the same discipline the event
        // ring and the login-attempt table already follow.
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        return { session, verdict };
      }

      if (verdict.kind === 'valid' && verdict.reanchor && options?.stamp) {
        // Its anchor is from another boot, or from before the column existed, so its age is unknown.
        // Re-stamped on this use rather than retired: see the trade recorded in credential-expiry.ts.
        db.prepare('UPDATE sessions SET boot_id = ?, last_seen_uptime_seconds = ? WHERE id = ?').run(
          options.stamp.bootId,
          options.stamp.uptimeSeconds,
          id,
        );
      }

      return { session, verdict };
    },

    touchSession(id, at, stamp) {
      /*
       * One write per request would be a write per request on the card, so this is throttled to at most
       * one a minute.
       *
       * Both anchors move together, in one statement. The uptime anchor is the one the idle rule is
       * measured against, so a version of this that updated only `last_seen_at` would leave every
       * session expiring at the idle limit however hard it was being used — the throttle is why that
       * matters: the two values cannot be allowed to drift apart by a minute's worth of writes.
       *
       * The throttle interval must stay far below `SESSION_IDLE_SECONDS`, which it is by four orders of
       * magnitude, and the test in `credential-expiry.test.ts` asserts that relationship rather than the
       * numbers.
       */
      /*
       * With no stamp, the displayed timestamp moves and **the anchor is left alone**.
       *
       * Writing `null` into the anchor on a transient read failure was the absent-data mistake again, and an
       * expensive form of it: `sessionVerdict` treats a null anchor as "age unknown, re-anchor on this use",
       * so one failed read of `/proc/uptime` silently discarded up to the entire accumulated idle age. A
       * session idle for six days would have been given a fresh six days by a hiccup.
       *
       * A failed read is never evidence. The old anchor is still the best thing known about this session,
       * and keeping it means the worst case is that the idle clock stops advancing for one request rather
       * than resetting.
       */
      if (stamp) {
        db.prepare(
          `UPDATE sessions SET last_seen_at = ?, boot_id = ?, last_seen_uptime_seconds = ?
            WHERE id = ? AND last_seen_at < ?`,
        ).run(now(at), stamp.bootId, stamp.uptimeSeconds, id, staleBefore(TOUCH_THROTTLE_SECONDS, at));
      } else {
        db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?').run(
          now(at),
          id,
          staleBefore(TOUCH_THROTTLE_SECONDS, at),
        );
      }
    },

    deleteSession(id) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    },

    sweepIdleSessions(options) {
      /*
       * Judged row by row through `sessionVerdict`, not with a `DELETE … WHERE`.
       *
       * The rule is not expressible in SQL — it needs the boot anchor, and it needs to ask whether this
       * particular session holds an open confirmation window. Iterating is affordable because the table
       * holds one row per sign-in on a single-operator device, and the alternative was a second, simpler
       * rule that disagreed with the real one.
       *
       * With no stamp nothing is removed. "I could not read the clock I judge by" is not evidence that a
       * session is stale, and deleting on it would be the absent-data mistake in its most expensive form.
       */
      if (!options?.stamp) return 0;

      const rows = db.prepare('SELECT * FROM sessions').all() as Record<string, unknown>[];
      let removed = 0;
      for (const row of rows) {
        const id = String(row['id']);
        const verdict = sessionVerdict({
          anchor: {
            bootId: row['boot_id'] == null ? null : String(row['boot_id']),
            lastSeenUptimeSeconds:
              row['last_seen_uptime_seconds'] == null ? null : Number(row['last_seen_uptime_seconds']),
          },
          stamp: options.stamp,
          idleLimitSeconds: SESSION_IDLE_SECONDS,
          holdsOpenWindow: options.holdsOpenWindow?.(id) ?? false,
        });
        if (verdict.kind !== 'expired') continue;
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        removed += 1;
      }
      return removed;
    },

    revokeAllSessions() {
      // The absolute control, and it needs no clock at all: a password change ends every session that was
      // created under the old one. This replaces the wall-clock expiry that used to be the only bound on a
      // session's life, and it is strictly better — immediate, and correct on a device whose clock is days
      // out.
      const result = db.prepare('DELETE FROM sessions').run();
      return Number(result.changes ?? 0);
    },

    createToken(name, scopes, expiresAt = null) {
      const token = randomBytes(32).toString('base64url');
      const id = randomBytes(8).toString('hex');
      const createdAt = now();
      db.prepare(
        'INSERT INTO api_tokens (id, name, token_sha256, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, name, sha256(token), scopes.join(','), createdAt, expiresAt);
      return {
        token,
        row: { id, name, scopes, createdAt, lastUsedAt: null, expiresAt },
      };
    },

    tokens() {
      const rows = db.prepare('SELECT * FROM api_tokens ORDER BY created_at').all() as Record<string, unknown>[];
      return rows.map(toTokenRow);
    },

    tokenBySecret(secret, options, touch = true) {
      const row = db.prepare('SELECT * FROM api_tokens WHERE token_sha256 = ?').get(sha256(secret)) as
        | Record<string, unknown>
        | undefined;
      if (!row) return null;
      const token = toTokenRow(row);
      const at = options?.now;

      /*
       * A token's expiry is an absolute instant the operator chose — "stop working after the end of the
       * month" — so unlike a session it cannot be turned into an idle duration without changing what was
       * asked for. It therefore has to be judged against the wall clock, which means it can only be
       * *enforced* when the wall clock is worth judging against. When it is not, the verdict is
       * `unverifiable` and the caller logs it: wrongly expiring a token locks the owner out of their own
       * device, and on this hardware that can mean no way in at all.
       */
      const verdict = tokenVerdict({
        expiresAt: token.expiresAt,
        now: at ?? new Date(),
        clockTrusted: options?.clockTrusted ?? null,
        holdsOpenWindow: options?.holdsOpenWindow?.(token.id) ?? false,
      });

      if (verdict.kind !== 'expired' && touch) {
        db.prepare(
          'UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)',
        ).run(now(at), token.id, staleBefore(TOUCH_THROTTLE_SECONDS, at));
      }
      return { token, verdict };
    },

    deleteToken(id) {
      const result = db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
      return Number(result.changes ?? 0) > 0;
    },

    recordEvent(event) {
      const at = event.at ?? now();
      const detail = event.detail === undefined ? null : JSON.stringify(event.detail);
      const result = db
        .prepare('INSERT INTO events (at, level, kind, summary, detail) VALUES (?, ?, ?, ?, ?)')
        .run(at, event.level, event.kind, event.summary, detail);

      // Eviction happens on insert rather than on a timer: a timer on a device that is
      // switched off abruptly may never run, and the ring's whole purpose is surviving that.
      db.prepare(
        `DELETE FROM events WHERE id <= (
           SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?
         )`,
      ).run(EVENT_RING_SIZE);

      return {
        id: Number(result.lastInsertRowid ?? 0),
        at,
        level: event.level,
        kind: event.kind,
        summary: event.summary,
        detail: event.detail ?? null,
      };
    },

    events(options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 200, 1), EVENT_RING_SIZE);
      const conditions: string[] = [];
      const parameters: (string | number)[] = [];
      if (options.kind !== undefined && options.kind !== '') {
        conditions.push('kind = ?');
        parameters.push(options.kind);
      }
      if (options.level !== undefined && options.level !== '') {
        conditions.push('level = ?');
        parameters.push(options.level);
      }
      if (options.since !== undefined && options.since !== '') {
        conditions.push('at >= ?');
        parameters.push(options.since);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`)
        .all(...parameters, limit) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: Number(row['id']),
        at: String(row['at']),
        level: String(row['level']) as EventRow['level'],
        kind: String(row['kind']),
        summary: String(row['summary']),
        detail: row['detail'] === null ? null : safeJson(String(row['detail'])),
      }));
    },

    eventCount() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n?: number };
      return Number(row?.n ?? 0);
    },

    eventPage(options) {
      /*
       * Both reads inside one transaction, so the page and the total describe the same instant.
       *
       * Without it a row written between the two statements makes the screen say "168 of 5000 kept" above a
       * list of 169 — small, and exactly the kind of inconsistency that makes a reader distrust the whole
       * panel. `BEGIN` rather than `BEGIN IMMEDIATE`: this takes no write lock and must never block an
       * apply that is trying to record an event.
       */
      db.exec('BEGIN');
      try {
        const page = { entries: store.events(options), total: store.eventCount() };
        db.exec('COMMIT');
        return page;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    recordLoginAttempt(source, succeeded, at, stamp) {
      db.prepare(
        'INSERT INTO login_attempts (at, source, succeeded, boot_id, uptime_seconds) VALUES (?, ?, ?, ?, ?)',
      ).run(now(at), source, succeeded ? 1 : 0, stamp?.bootId ?? null, stamp?.uptimeSeconds ?? null);

      /*
       * Pruned here, by count and insertion order.
       *
       * The previous version deleted by timestamp as part of the *count* query, which made a forward
       * clock step delete the whole history and reopen the lockout window, and a backward step leave
       * future-dated rows that satisfied every later cutoff and locked out a legitimate operator. A
       * clock must not be able to destroy the evidence a decision is based on.
       */
      db.prepare(
        `DELETE FROM login_attempts
          WHERE id NOT IN (SELECT id FROM login_attempts ORDER BY id DESC LIMIT ?)`,
      ).run(LOGIN_ATTEMPT_HISTORY);
    },

    recentLoginFailures(source, windowSeconds, stamp) {
      // No stamp means no age can be computed for anything, so nothing counts. That is the direction
      // that does not lock the operator out of a device whose only management surface is its own access
      // point — see the trade recorded in core/credential-expiry.ts.
      if (!stamp) return 0;

      const rows = db
        .prepare(
          `SELECT succeeded, boot_id, uptime_seconds FROM login_attempts
            WHERE source = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(source, LOGIN_ATTEMPT_HISTORY) as Record<string, unknown>[];

      return rows.filter((row) =>
        attemptCountsTowardsLockout({
          attempt: {
            bootId: row['boot_id'] == null ? null : String(row['boot_id']),
            uptimeSeconds: row['uptime_seconds'] == null ? null : Number(row['uptime_seconds']),
            succeeded: Number(row['succeeded']) === 1,
          },
          stamp,
          windowSeconds,
        }),
      ).length;
    },

    cacheInventory(document, at) {
      db.prepare(
        `INSERT INTO inventory_cache (id, at, document) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET at = excluded.at, document = excluded.document`,
      ).run(now(at), JSON.stringify(document));
    },

    cachedInventory() {
      const row = db.prepare('SELECT at, document FROM inventory_cache WHERE id = 1').get() as
        | Record<string, unknown>
        | undefined;
      if (!row) return null;
      return { at: String(row['at']), document: safeJson(String(row['document'])) };
    },
  };

  return store;
}

/**
 * `scrypt$N$r$p$salt$hash`. The parameters travel with the hash so they can be raised later
 * without invalidating what is already stored — a password that still verifies under the old
 * cost is re-hashed on the next successful login by the caller, not here.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    // The default maxmem is 32 MB, which N=2^15 with r=8 sits exactly on; without this the
    // call fails with "memory limit exceeded" on some builds.
    maxmem: 128 * 1024 * 1024,
  });
  return ['scrypt', SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, salt.toString('base64'), derived.toString('base64')].join(
    '$',
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 128 * 1024 * 1024 });
  // Constant-time comparison: a length check first, because timingSafeEqual throws on a
  // length mismatch and the length of a hash is not a secret.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function toPeerRow(row: Record<string, unknown>): PeerRow {
  return {
    id: String(row['id']),
    label: String(row['label']),
    baseUrl: String(row['base_url']),
    // Presence, never the value. The same rule the profile's secrets follow.
    hasToken: String(row['token'] ?? '') !== '',
    createdAt: String(row['created_at']),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toTokenRow(row: Record<string, unknown>): TokenRow {
  return {
    id: String(row['id']),
    name: String(row['name']),
    scopes: String(row['scopes'])
      .split(',')
      .map((scope) => scope.trim())
      .filter((scope): scope is TokenScope => scope === 'read' || scope === 'apply' || scope === 'admin'),
    createdAt: String(row['created_at']),
    lastUsedAt: row['last_used_at'] === null ? null : String(row['last_used_at']),
    expiresAt: row['expires_at'] === null ? null : String(row['expires_at']),
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
