/**
 * The platform pieces a tunnel test runs on, against the real operating system: a private directory that
 * is gone afterwards, a child whose words are kept and whose whole process group is stopped, and a port
 * the kernel says is free.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';

import { spawnScoped } from '../src/platform/exec.ts';
import { freeLoopbackPort } from '../src/platform/ports.ts';
import { createScratch } from '../src/platform/scratch.ts';

test('a scratch directory is private, holds its files at 0600, and is removed', async () => {
  const scratch = await createScratch('wayfarer-scoped-');
  try {
    const file = await scratch.write('core.json', '{}');
    assert.equal(statSync(scratch.path).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    await scratch.remove();
  }
  assert.equal(existsSync(scratch.path), false);
  await assert.rejects(createScratch('elsewhere-'), /wayfarer-/);
});

test('a scoped child keeps what it printed, and stop() ends its process group, grandchildren included', async () => {
  // The grandchild `sleep` is what a direct-child kill would leave behind holding the pipes.
  const child = spawnScoped('/bin/sh', ['-c', 'echo started; echo refused >&2; sleep 30']);
  for (let i = 0; i < 50 && child.tail().length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual([...child.tail()].sort(), ['refused', 'started']);
  const started = Date.now();
  await child.stop();
  assert.equal(child.done(), true);
  assert.ok(Date.now() - started < 2_500, 'stop() waited on a process it had not ended');
});

test('a free loopback port can be bound', async () => {
  const port = await freeLoopbackPort();
  assert.ok(port > 0 && port < 65536);
});
