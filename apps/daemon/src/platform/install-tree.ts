/**
 * The installed bundle on disk: reading it, copying it aside, and putting another one in its place.
 *
 * Here because these are file writes outside the managed-file path (`files.ts`), which writes the
 * configuration a plan describes; this writes the program itself. Only the parts a bundle carries are
 * touched — `daemon.cjs`, `way.cjs`, `build.json`, `bin/`, `ui/` — so a stray file in the install
 * directory is neither shipped back nor deleted.
 *
 * Each file is written beside its final name and renamed over it, so a power cut leaves either the old
 * file or the new one and never half of one; `ui/` is swapped as a directory for the same reason.
 */

import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type TreeFiles = Map<string, { data: Buffer; mode: number }>;

const TOP_FILES = ['daemon.cjs', 'way.cjs', 'build.json'];
const TOP_DIRS = ['bin', 'ui'];

export async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

export async function readText(path: string): Promise<string | null> {
  return await readFile(path, 'utf8').catch(() => null);
}

export async function readBytes(path: string): Promise<Buffer | null> {
  return await readFile(path).catch(() => null);
}

/** The bundle-shaped files under `root`, by path relative to it. */
export async function readTree(root: string): Promise<TreeFiles> {
  const files: TreeFiles = new Map();
  const add = async (relative: string): Promise<void> => {
    const full = join(root, relative);
    const info = await stat(full).catch(() => null);
    if (info === null) return;
    if (info.isDirectory()) {
      for (const entry of await readdir(full)) await add(`${relative}/${entry}`);
      return;
    }
    if (info.isFile()) files.set(relative, { data: await readFile(full), mode: info.mode & 0o777 });
  };
  for (const name of [...TOP_FILES, ...TOP_DIRS]) await add(name);
  return files;
}

/** Writes `files` as a fresh tree at `root`, replacing whatever was there. */
export async function writeTree(root: string, files: TreeFiles): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [relative, file] of files) {
    const full = join(root, relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.data, { mode: file.mode });
    await chmod(full, file.mode);
  }
}

/** Puts the tree at `from` in place under `installDir`. */
export async function installTree(from: string, installDir: string): Promise<void> {
  const files = await readTree(from);
  const ui = new Map([...files].filter(([path]) => path.startsWith('ui/')).map(([path, file]) => [path.slice(3), file]));
  for (const [relative, file] of files) {
    if (relative.startsWith('ui/')) continue;
    const full = join(installDir, relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(`${full}.new`, file.data, { mode: file.mode });
    await chmod(`${full}.new`, file.mode);
    await rename(`${full}.new`, full);
  }
  if (ui.size > 0) {
    const fresh = join(installDir, 'ui.new');
    const old = join(installDir, 'ui.old');
    await rm(fresh, { recursive: true, force: true });
    for (const [relative, file] of ui) {
      const full = join(fresh, relative);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.data, { mode: file.mode });
    }
    await chmod(fresh, 0o755);
    await rm(old, { recursive: true, force: true });
    if (await exists(join(installDir, 'ui'))) await rename(join(installDir, 'ui'), old);
    await rename(fresh, join(installDir, 'ui'));
    await rm(old, { recursive: true, force: true });
  }
}

export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.new`, content, { mode: 0o600 });
  await rename(`${path}.new`, path);
}
