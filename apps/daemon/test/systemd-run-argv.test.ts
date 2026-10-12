/**
 * The revert timer's command line, checked option by option.
 *
 * `runTransient` once passed `--corp` where `--collect` was meant. `systemd-run` refuses an unknown
 * option outright, so the timer was never armed, and `POST /api/apply` refused every `network` change
 * with `revert_timer_unavailable` — observed on the bench board, 2026-10-11, on a profile switch. No
 * test executed the command line, so a misspelt flag in a string literal had nothing to fail against.
 *
 * This runs `runTransient` against a stand-in `systemd-run` that records its arguments, and checks
 * every option against the ones `systemd-run` documents. The list is deliberately the options this
 * code is allowed to use, not every option systemd has: widening it is a decision someone makes on
 * purpose, with the man page open.
 */

import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSystemdController, type SystemBusLike } from '../src/platform/systemd.ts';

const KNOWN_OPTIONS = new Set(['--unit', '--timer-property', '--description', '--collect', '--property', '--no-block']);

test('the revert timer is armed with options systemd-run accepts, including --collect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wayfarer-systemd-run-'));
  try {
    const record = join(dir, 'argv');
    const fakeRun = join(dir, 'systemd-run');
    const fakeCtl = join(dir, 'systemctl');
    writeFileSync(fakeRun, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${record}'\n`);
    writeFileSync(fakeCtl, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeRun, 0o755);
    chmodSync(fakeCtl, 0o755);

    const bus: SystemBusLike = { getInterface: () => Promise.reject(new Error('no bus in this test')) };
    const systemd = createSystemdController({
      systemdRunPath: fakeRun,
      systemctlPath: fakeCtl,
      bus,
      uptimeSeconds: async () => 100.7,
    });

    const result = await systemd.runTransient({
      unit: 'wayfarer-revert-test.service',
      description: 'test',
      withinSeconds: 180,
      argv: ['/usr/bin/true'],
    });
    assert.equal(result.ok, true, result.message);

    const argv = readFileSync(record, 'utf8').trimEnd().split('\n');
    const commandAt = argv.indexOf('/usr/bin/true');
    assert.ok(commandAt > 0, 'the command follows the options');
    for (const option of argv.slice(0, commandAt)) {
      assert.ok(KNOWN_OPTIONS.has(option.split('=')[0]!), `systemd-run does not know ${option}`);
    }
    assert.ok(argv.includes('--collect'), 'a fired revert must not leave a unit behind');
    assert.ok(argv.includes('--timer-property=OnBootSec=280s'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
