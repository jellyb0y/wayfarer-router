/**
 * Round two of the observation fixes, each found by the acceptance tester on the bench board on
 * 2026-09-23 after the first round was deployed.
 *
 * 1. `way drift` said diverged while the daemon said converged: two planning contexts, one of them
 *    without the captured resolvers.
 * 2. `GET /api/drift` served a report older than the last apply, and never saw the timer's revert.
 * 4. `resolver-watch` kept saying `ok` after its directory was renamed away.
 * 5. A finding about a non-JSON file read "derives  and".
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { devicePipeline } from '../src/core/device-pipeline.ts';
import { createDriftMonitor, compareRunningState } from '../src/core/drift.ts';
import { diff } from '../src/core/differ.ts';
import { emptyDesiredState, type ManagedFile } from '../src/core/desired-state.ts';
import { watchCapturedResolvers } from '../src/platform/captured-resolvers.ts';
import { createObserverRegistry } from '../src/core/observers.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore, type Store } from '../src/state/store.ts';
import type { Platform } from '../src/platform/index.ts';
import type { ProfileStore } from '../src/state/profiles.ts';
import type { PipelineContext } from '../src/core/pipeline.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(10);
  }
}

/* ── 1. one derivation for the daemon and the CLI ──────────────────────────────────────── */

test('the daemon and the CLI build their planning context through the one constructor', async () => {
  /*
   * The CLI built its own context by hand and left out the captured resolvers, so `way drift` and the
   * drift event after a timer revert compared against the profile's starting value. The property is
   * "there is one derivation", so it is asserted where a second one would be written: neither entry
   * point may assemble a context of its own.
   */
  for (const file of ['../src/cli.ts', '../src/index.ts']) {
    const source = await readFile(join(here, file), 'utf8');
    assert.match(source, /devicePipeline\(/, `${file} must build its context with devicePipeline`);
    assert.doesNotMatch(source, /PipelineContext\s*=\s*\{/, `${file} assembles a planning context by hand again`);
  }
});

test('the one constructor reads the captured resolvers unless a test replaces them', async () => {
  const config = { listen: { port: 8088 }, timePorts: [123], wayBinary: '/usr/local/bin/way' };
  const production = devicePipeline({ platform: {} as Platform, config, boundAddresses: () => [] });
  assert.equal(typeof production.capturedResolvers, 'function', 'a context without captures derives the wrong resolver');

  const root = await mkdtemp(join(tmpdir(), 'wayfarer-pipe-'));
  await writeFile(join(root, 'hq.dns'), '10.184.48.5\n');
  const { readCapturedResolvers } = await import('../src/platform/captured-resolvers.ts');
  const overridden = devicePipeline({
    platform: {} as Platform,
    config,
    boundAddresses: () => [],
    capturedResolvers: () => readCapturedResolvers(root),
  });
  assert.equal((await overridden.capturedResolvers!()).get('hq'), '10.184.48.5');
});

/* ── 2. the report served is the latest one, whoever made it ───────────────────────────── */

async function sharedDatabase(): Promise<Store> {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-lastdrift-'));
  const store = createStore(openDatabase({ path: join(root, 'state.db') }));
  store.device();
  return store;
}

function monitorOn(store: Store, uptime: { value: number }, bootId = 'boot-a') {
  return createDriftMonitor({
    store,
    profiles: {} as ProfileStore,
    // No active profile: a real, cheap round whose reason is what the assertions read.
    pipeline: {} as PipelineContext,
    stamp: async () => ({ bootId, uptimeSeconds: uptime.value }),
  });
}

test('a report made by another process — the timer’s `way revert` — is the one the daemon serves', async () => {
  const store = await sharedDatabase();
  const uptime = { value: 1000 };
  const daemon = monitorOn(store, uptime);
  const cli = monitorOn(store, uptime);

  await daemon.run('boot');
  uptime.value = 1300;
  await cli.run('after-revert');
  uptime.value = 1330;

  const served = await daemon.current();
  assert.equal(served.report?.reason, 'after-revert', 'the daemon kept serving its own older report');
  assert.equal(served.ageSeconds, 30, 'the age is from the uptime both processes share');
  assert.deepEqual(served.report?.checkedAt, { bootId: 'boot-a', uptimeSeconds: 1300 });
});

test('a stored report from an earlier boot is shown without an age, never with a guessed one', async () => {
  const store = await sharedDatabase();
  const old = { value: 50_000 };
  await monitorOn(store, old, 'boot-before').run('periodic');
  const fresh = monitorOn(store, { value: 10 }, 'boot-now');
  const served = await fresh.current();
  assert.equal(served.report?.reason, 'periodic');
  assert.equal(served.ageSeconds, null);
});

/* ── 4. a watch that follows its directory away is a lost watch ────────────────────────── */

test('renaming the watched directory away is noticed, reported, and re-armed on the directory at the path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-lostwatch-'));
  const directory = join(root, 'tunnel');
  await mkdir(directory);
  const observers = createObserverRegistry();
  const observer = observers.register({ name: 'resolver-watch', watches: directory, everyMs: null });
  let changes = 0;
  const watch = watchCapturedResolvers(() => (changes += 1), {
    directory,
    debounceMs: 5,
    retryMs: 30,
    verifyMs: 40,
    onUnavailable: (reason) => observer.notRunning(reason),
    onWatching: () => observer.armed(),
  });
  try {
    assert.equal(observers.report()[0]!.state, 'ok');

    // What the tester did on the board: the directory moves; node emits `rename`, never `error`.
    await rename(directory, join(root, 'moved-away'));
    await until(() => observers.report()[0]!.state === 'not-running');
    assert.match(observers.report()[0]!.problem ?? '', /removed or renamed/);

    // A new directory at the path is watched again, and a capture written there is delivered.
    await mkdir(directory);
    await until(() => observers.report()[0]!.state === 'ok');
    const before = changes;
    await writeFile(join(directory, 'hq.dns'), '10.184.48.5\n');
    await until(() => changes > before);
  } finally {
    watch.stop();
    await rm(root, { recursive: true, force: true });
  }
});

/* ── 5. a line that is empty is said to be empty ───────────────────────────────────────── */

test('a line added to a non-JSON file is described in words, never as a blank', () => {
  const path = '/etc/wayfarer/README';
  const file: ManagedFile = {
    path,
    content: 'generated by wayfarer\n',
    mode: 0o644,
    purpose: 'a note for a person',
    consumedBy: { kind: 'reader', by: 'a person' },
  };
  const desired = emptyDesiredState();
  desired.files.push(file);
  const reality = {
    files: [{ path, content: 'generated by wayfarer\nadded by the tester\n', mode: 0o644 }],
    units: [],
    interfaces: [],
    managementInterfaces: ['end0'],
    sysctl: {},
  };
  const { findings } = compareRunningState({ desired, reality, classified: diff({ desired, reality }), planUsable: true });
  assert.equal(findings.length, 1);
  const message = findings[0]!.message;
  assert.doesNotMatch(message, / {2}/, `a blank where a value belongs: ${message}`);
  assert.match(message, /an empty line/);
  assert.match(message, /"added by the tester"/);
});

