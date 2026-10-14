/**
 * Updating the software through the API: the bundle a device trusts, and the install that goes back when
 * the new daemon does not answer.
 *
 * The verification half is about one claim: **only a bundle signed with the device's key, carrying exactly
 * the files its signed manifest describes, inside the tree an update may replace, is accepted.** The install
 * half runs `installBundle` against real directories under the system temporary directory, with a stand-in
 * daemon whose answer the test chooses — because the property that matters is which files are in place at
 * the end, and only a real tree can say.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tree from '../src/platform/install-tree.ts';
import { signBundle, verifyBundle } from '../src/core/update-bundle.ts';
import { installBundle, readUpdateState, stageBundle, updatePaths } from '../src/core/update.ts';

const keys = (): { publicKey: string; privateKey: string } =>
  generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

const files = (version: string): Map<string, { data: Buffer; mode: number }> =>
  new Map([
    ['daemon.cjs', { data: Buffer.from(`// daemon ${version}`), mode: 0o644 }],
    ['way.cjs', { data: Buffer.from(`// way ${version}`), mode: 0o644 }],
    ['build.json', { data: Buffer.from(JSON.stringify({ builtAt: '2026-10-14T00:00:00Z', version })), mode: 0o644 }],
    ['ui/index.html', { data: Buffer.from(`<p>${version}</p>`), mode: 0o644 }],
  ]);

/* ── what a device trusts ────────────────────────────────────────────────────────────────── */

test('a bundle signed with the device key verifies, and each way of tampering with it is refused by name', () => {
  const { publicKey, privateKey } = keys();
  const good = signBundle({ version: '0.1.0+abc', builtAt: '2026-10-14T00:00:00Z', files: files('0.1.0+abc'), privateKeyPem: privateKey });
  const verdict = verifyBundle(good, publicKey);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));

  // Another key: whoever holds an admin session is not whoever decides what the device runs.
  const stranger = keys();
  const foreign = verifyBundle(good, stranger.publicKey);
  assert.equal(foreign.ok, false);
  assert.match((foreign as { reason: string }).reason, /signature does not verify/);

  // A file swapped after signing: the manifest's hash is what the signature covers.
  const envelope = JSON.parse(good.toString('utf8')) as { files: Record<string, string> };
  envelope.files['daemon.cjs'] = Buffer.from('// something else').toString('base64');
  const swapped = verifyBundle(Buffer.from(JSON.stringify(envelope)), publicKey);
  assert.match((swapped as { reason: string }).reason, /daemon\.cjs is not the file the signed manifest describes/);

  // A file smuggled in beside the manifest.
  const extra = JSON.parse(good.toString('utf8')) as { files: Record<string, string> };
  extra.files['bin/evil'] = Buffer.from('#!/bin/sh').toString('base64');
  assert.match((verifyBundle(Buffer.from(JSON.stringify(extra)), publicKey) as { reason: string }).reason, /does not list/);

  // A signed manifest that reaches outside the install tree is still refused: signing does not make a path safe.
  const escaping = new Map(files('x'));
  escaping.set('ui/../../etc/passwd', { data: Buffer.from('root::0:0'), mode: 0o644 });
  const signedEscape = signBundle({ version: 'x', builtAt: 'now', files: escaping, privateKeyPem: privateKey });
  assert.match((verifyBundle(signedEscape, publicKey) as { reason: string }).reason, /outside what an update may replace/);

  assert.equal(verifyBundle(Buffer.from('not json'), publicKey).ok, false);
});

/* ── the install, on real directories ─────────────────────────────────────────────────────── */

async function bench(t: { after(fn: () => Promise<void>): void }, answers: boolean[]) {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-update-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const installDir = join(root, 'opt');
  const stateDir = join(root, 'state');
  await tree.writeTree(installDir, files('1.0'));
  const events: string[] = [];
  const calls: string[] = [];
  const deps = {
    tree,
    stopDaemon: async () => void calls.push('stop'),
    startDaemon: async () => void calls.push('start'),
    answers: async () => answers.shift() ?? false,
    record: (event: { kind: string }) => void events.push(event.kind),
  };
  return { installDir, stateDir, deps, events, calls };
}

const runningVersion = async (installDir: string): Promise<string> =>
  (JSON.parse(await readFile(join(installDir, 'build.json'), 'utf8')) as { version: string }).version;

test('an update that answers is installed, and the bundle it replaced is kept to go back to', async (t) => {
  const b = await bench(t, [true]);
  const { publicKey, privateKey } = keys();
  const verdict = verifyBundle(signBundle({ version: '2.0', builtAt: 'now', files: files('2.0'), privateKeyPem: privateKey }), publicKey);
  assert.ok(verdict.ok);
  await stageBundle({ tree }, b, verdict.bundle);

  const outcome = await installBundle(b.deps, { installDir: b.installDir, stateDir: b.stateDir, source: 'staged' });
  assert.equal(outcome.ok, true, outcome.message);
  assert.equal(await runningVersion(b.installDir), '2.0');
  assert.equal(await readFile(join(b.installDir, 'ui/index.html'), 'utf8'), '<p>2.0</p>');
  const paths = updatePaths(b);
  assert.equal(await runningVersion(paths.previous), '1.0', 'the replaced bundle must be kept');
  assert.equal((await readUpdateState(tree, paths))?.phase, 'installed');
  assert.deepEqual(b.calls, ['stop', 'start']);
  assert.ok(b.events.includes('system.update-installed'));
});

test('an update that does not answer is taken out again, and the bundle that ran before is running', async (t) => {
  // The new daemon never answers; the old one does, once it is back.
  const b = await bench(t, [false, true]);
  const { publicKey, privateKey } = keys();
  const verdict = verifyBundle(signBundle({ version: '2.0', builtAt: 'now', files: files('2.0'), privateKeyPem: privateKey }), publicKey);
  assert.ok(verdict.ok);
  await stageBundle({ tree }, b, verdict.bundle);

  const outcome = await installBundle(b.deps, { installDir: b.installDir, stateDir: b.stateDir, source: 'staged' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.running, 'previous');
  // Mutation: skip the restore and this goes red — the device keeps a daemon that does not answer.
  assert.equal(await runningVersion(b.installDir), '1.0');
  assert.equal(await readFile(join(b.installDir, 'ui/index.html'), 'utf8'), '<p>1.0</p>');
  assert.equal((await readUpdateState(tree, updatePaths(b)))?.phase, 'rolled-back');
  assert.ok(b.events.includes('system.update-rolled-back'));
});

test('after an update that never finished, the copy kept then is not overwritten by the bundle that failed', async (t) => {
  const b = await bench(t, [true]);
  const paths = updatePaths(b);
  // The state an interrupted update leaves: a kept 1.0, and 1.5 in place having never been seen to work.
  await tree.writeTree(paths.previous, files('1.0'));
  await tree.writeTree(b.installDir, files('1.5'));
  await mkdir(paths.updatesDir, { recursive: true });
  await writeFile(paths.state, JSON.stringify({ phase: 'installing', from: '1.0', to: '1.5', at: 'then' }));
  await tree.writeTree(paths.staged, files('2.0'));

  await installBundle(b.deps, { installDir: b.installDir, stateDir: b.stateDir, source: 'staged' });
  assert.equal(await runningVersion(b.installDir), '2.0');
  assert.equal(await runningVersion(paths.previous), '1.0', 'the last bundle known to work was replaced by the one that failed');
  assert.ok(b.events.includes('system.update-kept-rollback'));
});

test('a rollback installs the kept bundle and keeps the one it replaced, so it can be undone in turn', async (t) => {
  const b = await bench(t, [true]);
  const paths = updatePaths(b);
  await tree.writeTree(paths.previous, files('0.9'));

  const outcome = await installBundle(b.deps, { installDir: b.installDir, stateDir: b.stateDir, source: 'previous' });
  assert.equal(outcome.ok, true, outcome.message);
  assert.equal(await runningVersion(b.installDir), '0.9');
  assert.equal(await runningVersion(paths.previous), '1.0');
});
