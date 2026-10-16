/**
 * Temporary directories for a test file, removed once every test in the file has run — passed or not.
 *
 * Measured on 2026-10-15: one run of the daemon suite left about 140 `wayfarer-*` directories in the system
 * temporary directory, each a `mkdtemp` in a test helper that nothing removed. A helper that builds a
 * device has no `t` to hang a cleanup on, so the cleanup hangs on the file instead: `node --test` runs each
 * file in its own process, and a root `after` runs when that file's tests are done.
 */

import { after } from 'node:test';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

after(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

export async function scratchDir(prefix: string): Promise<string> {
  if (!prefix.startsWith('wayfarer-')) throw new Error(`a scratch directory is named wayfarer-…, not ${prefix}`);
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}
