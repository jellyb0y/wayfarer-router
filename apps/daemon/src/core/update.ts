/**
 * Installing a verified bundle, and going back when the new daemon does not answer.
 *
 * Run by `way update`, in a transient unit of its own (`POST /api/system/update` starts it), never inside
 * the daemon: the daemon is what gets stopped and replaced, and an installer that died with it would leave
 * the device with half a program. The steps are the ones `docs/11-deployment.md` set out for this command
 * and `deploy/install.sh` already performs for a first install, restated here for an update:
 *
 * 1. **Keep what runs now** as the copy to go back to — unless the previous update never finished. Then
 *    the bundle in place is the one that failed, and the copy already kept is the last one known to work;
 *    overwriting it would destroy the only way back at the moment a second attempt is being made.
 * 2. **Stop, replace, start.**
 * 3. **Ask the daemon**, not systemd: a process that started and cannot serve is `active`.
 * 4. **No answer: put the kept copy back** and start that, and say which of the two is running.
 *
 * The state of an update is a file (`updates/state.json`), written before each step, so an update cut off
 * by a power loss is visible to the next one and to `GET /api/system`.
 */

import type { TreeFiles } from '../platform/install-tree.ts';
import type { VerifiedBundle } from './update-bundle.ts';

export interface UpdateTree {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  readTree(root: string): Promise<TreeFiles>;
  writeTree(root: string, files: TreeFiles): Promise<void>;
  installTree(from: string, installDir: string): Promise<void>;
  removeTree(path: string): Promise<void>;
  writeText(path: string, content: string): Promise<void>;
}

export interface UpdateDeps {
  tree: UpdateTree;
  stopDaemon(): Promise<void>;
  startDaemon(): Promise<void>;
  /** Whether the daemon answers `/api/health`, asked for up to its own limit. */
  answers(): Promise<boolean>;
  record(event: { level: 'info' | 'warn' | 'error'; kind: string; summary: string; detail?: unknown }): void;
  now?(): Date;
}

export interface UpdatePaths {
  installDir: string;
  /** `<stateDir>/updates`: the staged bundle, the kept copy and the state file. */
  updatesDir: string;
}

export interface UpdateState {
  phase: 'staged' | 'installing' | 'installed' | 'rolled-back' | 'failed';
  from: string | null;
  to: string | null;
  at: string;
  detail?: string;
}

export function updatePaths(input: { installDir: string; stateDir: string }): UpdatePaths & { staged: string; previous: string; incoming: string; state: string } {
  const updatesDir = `${input.stateDir}/updates`;
  return {
    installDir: input.installDir,
    updatesDir,
    staged: `${updatesDir}/staged`,
    previous: `${updatesDir}/previous`,
    incoming: `${updatesDir}/incoming`,
    state: `${updatesDir}/state.json`,
  };
}

export async function readUpdateState(tree: Pick<UpdateTree, 'readText'>, paths: UpdatePaths): Promise<UpdateState | null> {
  const text = await tree.readText(`${paths.updatesDir}/state.json`);
  if (text === null) return null;
  try {
    return JSON.parse(text) as UpdateState;
  } catch {
    return null;
  }
}

/** Writes a verified bundle where `way update --staged` will take it from. */
export async function stageBundle(deps: Pick<UpdateDeps, 'tree' | 'now'>, input: { installDir: string; stateDir: string }, bundle: VerifiedBundle): Promise<void> {
  const paths = updatePaths(input);
  const files: TreeFiles = new Map(
    bundle.manifest.files.map((entry) => [entry.path, { data: bundle.files.get(entry.path)!, mode: entry.mode & 0o755 }]),
  );
  await deps.tree.writeTree(paths.staged, files);
  const current = await versionOf(deps.tree, paths.installDir);
  await writeState(deps, paths.state, { phase: 'staged', from: current, to: bundle.manifest.version });
}

export interface InstallOutcome {
  ok: boolean;
  /** What is running at the end: the new version, the kept one, or nothing that answers. */
  running: 'new' | 'previous' | 'none';
  from: string | null;
  to: string | null;
  message: string;
}

/**
 * Installs `staged` (an update) or `previous` (a rollback to the kept copy). A rollback is the same
 * journey in the other direction: what runs now is kept, so a rollback can itself be rolled back.
 */
export async function installBundle(deps: UpdateDeps, input: { installDir: string; stateDir: string; source: 'staged' | 'previous' }): Promise<InstallOutcome> {
  const paths = updatePaths(input);
  const sourceDir = input.source === 'staged' ? paths.staged : paths.previous;
  if (!(await deps.tree.exists(`${sourceDir}/daemon.cjs`))) {
    return { ok: false, running: 'previous', from: null, to: null, message: input.source === 'staged' ? 'nothing is staged' : 'there is no kept copy to go back to' };
  }

  // Read whole before anything is written: a rollback's source is the very directory step 1 rewrites.
  const incoming = await deps.tree.readTree(sourceDir);
  const from = await versionOf(deps.tree, paths.installDir);
  const to = versionFrom(incoming);
  const state = await readUpdateState(deps.tree, paths);
  const interrupted = state?.phase === 'installing';

  if (interrupted) {
    deps.record({
      level: 'warn',
      kind: 'system.update-kept-rollback',
      summary: 'an earlier update never finished, so the copy kept then is kept: it is the last bundle known to have run',
    });
  } else {
    await deps.tree.writeTree(paths.previous, await deps.tree.readTree(paths.installDir));
  }
  await deps.tree.writeTree(paths.incoming, incoming);
  await writeState(deps, paths.state, { phase: 'installing', from, to });

  await deps.stopDaemon();
  await deps.tree.installTree(paths.incoming, paths.installDir);
  await deps.startDaemon();

  if (await deps.answers()) {
    await writeState(deps, paths.state, { phase: 'installed', from, to });
    await deps.tree.removeTree(paths.incoming);
    if (input.source === 'staged') await deps.tree.removeTree(paths.staged);
    deps.record({
      level: 'info',
      kind: input.source === 'staged' ? 'system.update-installed' : 'system.update-rolled-back',
      summary: `${input.source === 'staged' ? 'updated' : 'rolled back'} from ${from ?? 'an unknown version'} to ${to ?? 'an unknown version'}; the daemon answers`,
      detail: { from, to },
    });
    return { ok: true, running: 'new', from, to, message: `${to ?? 'the new version'} is running` };
  }

  // The new one does not answer: the kept copy goes back, and is asked the same question.
  deps.record({ level: 'error', kind: 'system.update-unanswered', summary: `${to ?? 'the new version'} did not answer; putting ${from ?? 'the previous version'} back`, detail: { from, to } });
  await deps.stopDaemon();
  await deps.tree.installTree(paths.previous, paths.installDir);
  await deps.startDaemon();
  const back = await deps.answers();
  await writeState(deps, paths.state, {
    phase: back ? 'rolled-back' : 'failed',
    from,
    to,
    detail: back ? `${to ?? 'the new version'} did not answer` : 'neither version answered',
  });
  await deps.tree.removeTree(paths.incoming);
  deps.record({
    level: back ? 'warn' : 'error',
    kind: back ? 'system.update-rolled-back' : 'system.update-failed',
    summary: back
      ? `${to ?? 'the new version'} did not answer, and ${from ?? 'the previous version'} is running again`
      : `neither ${to ?? 'the new version'} nor ${from ?? 'the previous version'} answers`,
    detail: { from, to },
  });
  return {
    ok: false,
    running: back ? 'previous' : 'none',
    from,
    to,
    message: back ? `${to ?? 'the new version'} did not answer; ${from ?? 'the previous version'} is running again` : 'neither version answers',
  };
}

async function writeState(deps: Pick<UpdateDeps, 'tree' | 'now'>, path: string, state: Omit<UpdateState, 'at'>): Promise<void> {
  await deps.tree.writeText(path, `${JSON.stringify({ ...state, at: (deps.now?.() ?? new Date()).toISOString() })}\n`);
}

async function versionOf(tree: Pick<UpdateTree, 'readText'>, root: string): Promise<string | null> {
  const text = await tree.readText(`${root}/build.json`);
  return text === null ? null : versionFromText(text);
}

function versionFrom(files: TreeFiles): string | null {
  const stamp = files.get('build.json');
  return stamp === undefined ? null : versionFromText(stamp.data.toString('utf8'));
}

function versionFromText(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { version?: unknown; builtAt?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : typeof parsed.builtAt === 'string' ? `built ${parsed.builtAt}` : null;
  } catch {
    return null;
  }
}
