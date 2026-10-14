/**
 * A private working directory for a process that lives only as long as one request: today, the clients a
 * tunnel test starts.
 *
 * Under the system temporary directory with a `wayfarer-` prefix, and removed by the caller in a
 * `finally` — the rule this repository adopted after 2026-09-23, when test runs left 978 directories in
 * a home directory. Mode 0700 on the directory and 0600 on every file, because what is written here is a
 * tunnel's credentials in clear.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Scratch {
  path: string;
  /** Writes one file inside the directory and returns its full path. */
  write(name: string, content: string): Promise<string>;
  /** Removes the directory and everything in it. Safe to call more than once. */
  remove(): Promise<void>;
}

export async function createScratch(prefix: string): Promise<Scratch> {
  if (!prefix.startsWith('wayfarer-')) throw new Error(`a scratch directory must be named wayfarer-…, not ${prefix}`);
  const path = await mkdtemp(join(tmpdir(), prefix));
  await chmod(path, 0o700);
  return {
    path,
    async write(name, content) {
      if (name.includes('/')) throw new Error(`a scratch file name may not contain a slash: ${name}`);
      const file = join(path, name);
      await writeFile(file, content, { mode: 0o600 });
      return file;
    },
    async remove() {
      await rm(path, { recursive: true, force: true });
    },
  };
}
