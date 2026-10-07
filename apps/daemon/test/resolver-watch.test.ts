/**
 * The trigger: what is supposed to happen when a peer's resolver is captured.
 *
 * ## What was measured, 2026-09-22
 *
 * On the bench board the hq tunnel's peer pushed `10.184.100.5`, the up script captured it into
 * `/run/wayfarer/tunnel/hq.dns`, and `/etc/wayfarer/core/config.json` went on naming
 * `10.184.40.5` for hours — mtime unmoved — while `wplan.hq.lan` stopped resolving for every
 * client on the network. Re-planning by hand produced the captured value immediately, so the
 * generator, the planner and the apply were all working: **nothing asked them.**
 *
 * The trigger is this watcher, and it had two ways of never firing, both exercised here:
 *
 * 1. `/run/wayfarer/tunnel` is created by `tunnel-up`, when a tunnel first connects. `/run` is empty
 *    at boot and the daemon starts before any tunnel, so at the moment the watch is attempted the
 *    directory is normally absent. The old version returned `null` and the daemon recorded that it
 *    was not watching — and then **nothing ever looked again**, for the life of the process, while
 *    the comment at the call site claimed it was retried.
 * 2. A watcher is blind to whatever happened before it existed. A capture written while the daemon
 *    was restarting — every deploy, every upgrade, every reboot — delivers no event, ever.
 *
 * Both are about a mechanism that is *silent* when it is not working, which is why the handle now
 * answers `watching()` rather than merely existing.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { watchCapturedResolvers, readCapturedResolvers } from '../src/platform/captured-resolvers.ts';

/** Waits for a condition, polling, so a test never depends on a fixed sleep being long enough. */
async function until(predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('a directory that does not exist yet is retried, not given up on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-resolver-'));
  const directory = join(root, 'tunnel');

  let changes = 0;
  const unavailable: string[] = [];
  let established: boolean | null = null;

  // The state at daemon start on a normal boot: the up script has not run, so nothing is there.
  const watch = watchCapturedResolvers(
    () => {
      changes += 1;
    },
    {
      directory,
      debounceMs: 10,
      retryMs: 25,
      onUnavailable: (reason) => unavailable.push(reason),
      onWatching: (afterRetry) => {
        established = afterRetry;
      },
    },
  );

  try {
    // Before: `watchCapturedResolvers` returned `null` here and the daemon never looked again. The
    // handle now exists and reports honestly that it is not watching anything yet.
    assert.equal(watch.watching(), false, 'claimed to be watching a directory that does not exist');
    assert.equal(unavailable.length, 1, 'the daemon was not told why it is not watching');

    // The tunnel connects: the up script creates the directory and writes what the peer pushed.
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'hq.dns'), '10.184.100.5\n', 'utf8');

    await until(() => watch.watching(), 'the watch to be established after a retry');
    assert.equal(established, true, 'a watch that arrived late was not reported');

    // The whole point: the value written while nobody was watching still provokes a re-derive.
    await until(() => changes > 0, 'a change to be delivered for what was captured before the watch');
    assert.deepEqual(await readCapturedResolvers(directory), new Map([['hq', '10.184.100.5']]));

    // And it is still reported once, not once per retry: a line every 25 ms is a log nobody reads.
    assert.equal(unavailable.length, 1, 'the unavailability was reported on every attempt');
  } finally {
    watch.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a capture written into a watched directory provokes a re-derive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-resolver-'));
  let changes = 0;
  const watch = watchCapturedResolvers(
    () => {
      changes += 1;
    },
    { directory, debounceMs: 10, retryMs: 25 },
  );

  try {
    assert.equal(watch.watching(), true);
    // Written the way the up script writes it: a temporary file and a rename, so a reader never sees
    // half a value.
    await writeFile(join(directory, '.hq.dns.tmp'), '10.184.100.5\n', 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(join(directory, '.hq.dns.tmp'), join(directory, 'hq.dns'));

    await until(() => changes > 0, 'a change to be delivered for a fresh capture');
  } finally {
    watch.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('stopping the watch stops the retry as well', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-resolver-'));
  const directory = join(root, 'never-created');
  let changes = 0;
  const watch = watchCapturedResolvers(
    () => {
      changes += 1;
    },
    { directory, debounceMs: 5, retryMs: 5 },
  );

  watch.stop();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'hq.dns'), '10.184.100.5\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 60));

  // A stopped watch that keeps retrying is a shutdown that does not finish, and a daemon that acts
  // after it was told to stop.
  assert.equal(watch.watching(), false);
  assert.equal(changes, 0, 'a stopped watch still delivered a change');
  await rm(root, { recursive: true, force: true });
});
