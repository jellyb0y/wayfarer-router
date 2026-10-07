/**
 * The only sanctioned way to write a managed file.
 *
 * The sequence is: temporary file **in the target directory**, write, `fsync` the
 * file, `chmod`/`chown`, `rename`, then `fsync` the directory.
 *
 * Every step is there because of a measured property of the target hardware:
 *
 * * The temporary file goes in the target directory because `/tmp` is a tmpfs
 *   (measured: `tmpfs 987M` mounted at `/tmp`), so a file created there and moved to
 *   `/etc` is a copy followed by an unlink, not an atomic rename. Losing power during
 *   that copy leaves a truncated configuration file, and a truncated proxy-core
 *   configuration means the core does not start — the device then comes up with a
 *   working access point and no tunnel, which looks like success.
 * * The file is synced before the rename because the root filesystem is mounted with a
 *   long commit interval, so the rename can otherwise reach the card before the
 *   content does, leaving a file that exists and is empty.
 * * The directory is synced after the rename so the rename itself survives power loss.
 */

import { constants as fsConstants } from 'node:fs';
import { chmod, chown, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface WriteAtomicOptions {
  /** File mode, e.g. 0o600 for anything holding a secret. */
  mode?: number;
  uid?: number;
  gid?: number;
  /** Create the target directory when missing, with this mode. */
  mkdirMode?: number;
}

export interface WriteAtomicResult {
  path: string;
  bytes: number;
  /** False when the content and mode already matched, so nothing was written. */
  changed: boolean;
}

/**
 * Writes `content` to `path` atomically. Returns `changed: false` when the file
 * already had exactly this content and mode — re-applying a configuration must not
 * cost the card a write, and the write rate on this device is a budget (measured
 * baseline 650–750 B/s for the whole system).
 */
export async function writeAtomic(
  path: string,
  content: string | Buffer,
  options: WriteAtomicOptions = {},
): Promise<WriteAtomicResult> {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const directory = dirname(path);

  if (options.mkdirMode !== undefined) {
    await mkdir(directory, { recursive: true, mode: options.mkdirMode });
  }

  if (await alreadyMatches(path, buffer, options)) {
    return { path, bytes: buffer.length, changed: false };
  }

  // Randomised name in the target directory: a fixed name would collide with a
  // concurrent write and a predictable one is a symlink invitation in a shared
  // directory.
  const temporary = join(directory, `.${basename(path)}.wayfarer-${randomBytes(6).toString('hex')}`);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, options.mode ?? 0o644);
    await handle.writeFile(buffer);
    // Content on the card before the name points at it.
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Mode is set explicitly rather than trusted from open(): the process umask
    // applies to the creation mode and would quietly widen or narrow it.
    if (options.mode !== undefined) await chmod(temporary, options.mode);
    if (options.uid !== undefined || options.gid !== undefined) {
      // -1 means "leave this one alone", so a caller can set just the group.
      await chown(temporary, options.uid ?? -1, options.gid ?? -1);
    }

    await rename(temporary, path);
    await syncDirectory(directory);
    return { path, bytes: buffer.length, changed: true };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Reads a managed file, returning null when it does not exist. */
export async function readManaged(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * When a file was last written, in wall-clock milliseconds, or `null` when it is not there.
 *
 * The only reading available for the age of a rule set — the core's cache is its own database in its
 * own format and is never parsed here. `null` for an absent file rather than a throw, because "there
 * is no copy on this device" is an answer the caller has to render, not an error.
 *
 * It is a **wall-clock** instant and this board has no clock battery, so the caller decides whether
 * subtracting it from `now` is honest. `core/rule-set-age.ts` makes that decision and argues it.
 */
export async function fileModifiedMs(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.mtimeMs;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function fileMode(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.mode & 0o7777;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Whether the file on disk already is what was asked for: content, mode **and ownership**.
 *
 * Ownership is part of the comparison because leaving it out makes the only sanctioned write path
 * unable to correct a wrong owner — the content matches, the function reports `changed: false`, and
 * a file that a service cannot read stays unreadable through any number of re-applies. The
 * permissions a generated file carries are the permissions its consumer requires, and an owner is
 * half of that.
 */
async function alreadyMatches(path: string, buffer: Buffer, options: WriteAtomicOptions): Promise<boolean> {
  try {
    const existing = await readFile(path);
    if (!existing.equals(buffer)) return false;

    const info = await stat(path);
    if (options.mode !== undefined && (info.mode & 0o7777) !== options.mode) return false;
    if (options.uid !== undefined && info.uid !== options.uid) return false;
    if (options.gid !== undefined && info.gid !== options.gid) return false;
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * `fsync` on a directory is what makes a rename durable. It is a no-op on some
 * filesystems and fails with EINVAL on others, which is not an error worth failing a
 * write for — the rename itself has already happened.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    /* See above. */
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

/* ── taking a file over, reversibly ──────────────────────────────────────────────────────── */

/**
 * The suffix a file gets when it is moved out of the way.
 *
 * Long and unmistakable on purpose. Somebody will find one of these on a device a year from now with
 * no memory of how it got there, and the useful thing to find is a name that says what happened and
 * who did it. A short suffix like `.bak` or `.disabled` says neither, and both already occur on real
 * systems for unrelated reasons.
 */
export const ASIDE_SUFFIX = '.disabled-by-wayfarer';

export interface AsideResult {
  from: string;
  to: string;
  /** False when the source did not exist, so nothing moved. Not an error: the work was already done. */
  moved: boolean;
}

/**
 * Moves a file another program owns out of the way, so an interface can be taken over.
 *
 * **Never a deletion.** We do not know what another program's file is for, the user may need it, and
 * deletion is the one action no revert can undo. The move is recorded on the transaction that did it,
 * and the revert path moves it back.
 *
 * Idempotent in the direction that matters: a source that is already gone reports `moved: false`
 * rather than failing, because the second run of a reconciler step must not be an error.
 *
 * The destination is refused if something is already there. Overwriting would destroy whatever that
 * was — possibly an aside copy from an earlier takeover, which is the only remaining record of what
 * the device looked like before us.
 */
export async function moveAside(path: string, suffix = ASIDE_SUFFIX): Promise<AsideResult> {
  const target = `${path}${suffix}`;

  if ((await fileMode(path)) === null) return { from: path, to: target, moved: false };

  if ((await fileMode(target)) !== null) {
    throw new Error(
      `refusing to move ${path} aside: ${target} already exists. Overwriting it would destroy the ` +
        'only remaining record of what this device looked like before, which may be from an earlier ' +
        'takeover. Resolve it by hand.',
    );
  }

  await rename(path, target);
  await syncDirectory(dirname(path));
  return { from: path, to: target, moved: true };
}

export type RestoreOutcome =
  | { outcome: 'restored'; from: string; to: string }
  | { outcome: 'nothing-to-do'; from: string; to: string; why: string }
  | { outcome: 'collision'; from: string; to: string; why: string };

/**
 * Moves a file back where it came from, undoing `moveAside`.
 *
 * Three outcomes rather than a boolean, because they need different responses and a caller that sees
 * only success or failure will handle the middle one wrongly.
 *
 * **A file that exists again at the original path is not overwritten.** It was put there by something
 * after the takeover — most likely the other manager, or a person — and clobbering it would be this
 * function doing exactly what `moveAside` refuses to do. The aside copy is kept, the collision is
 * reported, and a human resolves it. Silently winning that race is how a revert destroys the thing it
 * was supposed to protect.
 *
 * Idempotent: an aside file that is no longer there means the restore already happened, which is a
 * `nothing-to-do` rather than a failure. A revert can run more than once — the timer can fire while a
 * start-up sweep is also deciding to revert — and it must be safe every time.
 */
export async function restoreAside(entry: { from: string; to: string }): Promise<RestoreOutcome> {
  if ((await fileMode(entry.to)) === null) {
    return {
      ...entry,
      outcome: 'nothing-to-do',
      why: 'the file that was moved aside is no longer there; the restore has already happened',
    };
  }

  if ((await fileMode(entry.from)) !== null) {
    return {
      ...entry,
      outcome: 'collision',
      why:
        `${entry.from} exists again, so it was not overwritten. The copy moved aside is still at ` +
        `${entry.to}; compare them and keep the one you want.`,
    };
  }

  await rename(entry.to, entry.from);
  await syncDirectory(dirname(entry.from));
  return { ...entry, outcome: 'restored' };
}

/**
 * Whether a directory can actually be written to, answered by trying.
 *
 * By trying, because nothing else is conclusive. `access(W_OK)` consults permission bits and says nothing
 * about a read-only mount or a `ProtectSystem=strict` sandbox — and the sandbox is exactly the case that
 * cost this project a failed apply, reporting `EROFS` on a directory whose bits were perfectly writable.
 * A test that checks the wrong thing is worse than no test, so this creates and removes a real file.
 *
 * The probe name is randomised and dot-prefixed, and it is removed whether or not the write succeeded. It
 * goes in the directory under test because that is the only place that answers the question — the same
 * reason `writeAtomic` puts its temporary file there.
 */
/**
 * Whether a managed file can be written in this directory — including one that does not exist yet.
 *
 * The writer creates missing directories (`mkdir` with `recursive`), so the question is not "does
 * this directory exist" but "can it be created and written in". Those differ, and the difference was
 * a **false refusal**: measured on the bench board, 2026-09-20, the first plan to emit a wireless
 * uplink refused with `/etc/wayfarer/supplicant — ENOENT` for a directory the very next step would
 * have created. The refusal was safe — nothing was touched and no revert timer was spent — but it
 * refused work that would have succeeded, which is its own kind of wrong answer.
 *
 * So the probe walks up to the nearest ancestor that exists, because that is where the `mkdir` will
 * actually happen and therefore where permission is actually decided. A directory that cannot be
 * created is still reported, with the tool's own error code and the ancestor that produced it.
 */
export async function directoryWritable(directory: string): Promise<{ writable: boolean; reason: string }> {
  const existing = await nearestExistingAncestor(directory);
  if (existing === null) {
    return { writable: false, reason: `ENOENT (no part of ${directory} exists)` };
  }
  const probe = join(existing, `.wayfarer-writable-${randomBytes(6).toString('hex')}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(probe, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.close();
    handle = undefined;
    return { writable: true, reason: 'writable' };
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
    // The tool's own error code, surfaced verbatim. `EROFS` and `EACCES` need entirely different fixes —
    // a sandbox path versus a permission — and a message that flattened them would send somebody to the
    // wrong one.
    return {
      writable: false,
      // Naming the ancestor matters when it is not the directory asked about: "/etc/wayfarer is
      // EROFS" sends somebody to the sandbox, where "/etc/wayfarer/supplicant is EROFS" sends them
      // looking for a directory that does not exist.
      reason: existing === directory ? (code ?? String(error)) : `${code ?? String(error)} at ${existing}`,
    };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(probe).catch(() => undefined);
  }
}

/**
 * The closest path at or above `directory` that exists, or `null` if even the root does not.
 *
 * Bounded by the path's own depth, and it stops at the root rather than looping: `dirname('/')` is
 * `'/'`, which would otherwise spin forever.
 */
async function nearestExistingAncestor(directory: string): Promise<string | null> {
  let current = directory;
  for (;;) {
    const found = await stat(current).then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    if (found) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Files this project moved aside, found by looking at the disk rather than by reading our records.
 *
 * That distinction is the whole reason this exists. A takeover's undo is recorded in the transaction
 * table — and a factory reset **deletes the transaction table**, so a reset that discovered moved-aside
 * files from our own records would find none, precisely when it most needs to find them.
 *
 * Measured on the bench board, 2026-09-21: the first factory reset completed every step successfully
 * and left `/etc/netplan/20-wifi.yaml.disabled-by-wayfarer` sitting there. Nothing was lost, and nothing
 * would ever have put it back: netplan does not read that name, and the record that said to restore it
 * had just been removed by the same operation. Another program permanently displaced by a reset whose
 * own comment said it must never do that.
 *
 * The suffix is ours and is not a pattern anybody else uses, so its presence is sufficient evidence.
 */
export async function findMovedAside(
  directories: readonly string[],
  suffix = ASIDE_SUFFIX,
): Promise<{ from: string; to: string }[]> {
  const found: { from: string; to: string }[] = [];
  for (const directory of directories) {
    const entries = await readdir(directory).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith(suffix)) continue;
      const to = `${directory}/${entry}`;
      found.push({ from: to.slice(0, -suffix.length), to });
    }
  }
  return found;
}

/**
 * Removes a path and everything under it. Absent is success: the state asked for is "not there".
 */
export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Creates a directory with an explicit mode.
 *
 * `mkdir`'s own mode argument is subject to the umask, so the mode is set afterwards as well. A
 * directory created 0755 where 0700 was asked for is a directory whose contents are readable by
 * anybody with a shell, and the request would have looked satisfied.
 */
export async function createDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode);
}

/**
 * Removes the entries of one directory whose names contain `fragment`.
 *
 * For the two directories this project shares with other software: our own files go, the directory and
 * everything belonging to anybody else stays. A missing directory is not an error — there is then
 * nothing of ours in it.
 */
export async function removeMatchingEntries(directory: string, fragment: string): Promise<string[]> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.includes(fragment)) continue;
    await rm(`${directory}/${entry}`, { force: true, recursive: true });
    removed.push(entry);
  }
  return removed;
}
