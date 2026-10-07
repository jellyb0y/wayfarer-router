/**
 * The deploy script's safety net, exercised against a stand-in device.
 *
 * These tests exist because of a specific failure rather than for coverage. Arming the deadman used
 * to be an opt-in flag; it was passed for a risky apply and omitted for a deploy that had worked
 * before, that deploy died mid-copy, and the board had to be power-cycled by hand. The behaviours
 * below are the ones that make that impossible, and each of them is invisible to a human reading the
 * script — which is precisely why they are asserted.
 *
 * The stand-in **refuses what the real thing would refuse**: it answers `wayfarer-deadman status`
 * with a scripted status rather than with success, so the script's refusals are reachable. A
 * stand-in that only recorded calls would prove the calls were made, which is not the same as
 * proving they would work — and that distinction is the one that let the original defect through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/platform/exec.ts';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'deploy.sh');
// The repository root is not needed here: see the note in `deploy()` below.

/**
 * A directory holding fake `ssh` and `rsync` ahead of the real ones on PATH, plus a log of every
 * remote command the script issued. The order of that log is the interesting part: "armed before
 * anything was copied" is an ordering claim, and only a transcript can settle it.
 */
async function standIn(options: {
  status: string;
  health: 'ok' | 'dead';
  /** 1K blocks free on the device, as `df -kP` reports them. Default: plenty. */
  freeKb?: number;
}): Promise<{
  env: Record<string, string>;
  transcript: () => Promise<string[]>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-deploy-'));
  const log = join(directory, 'transcript');
  await writeFile(log, '');

  const ssh = join(directory, 'ssh');
  await writeFile(
    ssh,
    [
      '#!/bin/bash',
      '# Strip the option pairs, then the host, and treat the rest as the remote command.',
      'args=("$@")',
      'i=0',
      'while [ $i -lt ${#args[@]} ]; do',
      '  case "${args[$i]}" in',
      '    -o|-i) i=$((i+2)) ;;',
      '    *) break ;;',
      '  esac',
      'done',
      'cmd="${args[*]:$((i+1))}"',
      `printf 'ssh %s\\n' "$cmd" >> ${JSON.stringify(log)}`,
      'case "$cmd" in',
      '  *df*)',
      '    # Two lines, as df -kP gives: a header and one row. Field 4 is the available blocks.',
      '    echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
      '    echo "/dev/mmcblk0p1 60000000 2700000 $FAKE_FREE_KB 5% /"',
      '    exit 0 ;;',
      '  *"wayfarer-deadman status"*) printf "%s\\n" "$FAKE_DEADMAN_STATUS"; exit 0 ;;',
      '  *"wayfarer-deadman snapshot"*) echo "snapshot written"; exit 0 ;;',
      '  *"wayfarer-deadman arm"*) echo "armed"; exit 0 ;;',
      '  *"wayfarer-deadman disarm"*) echo "disarmed"; exit 0 ;;',
      '  *curl*)',
      '    if [ "$FAKE_HEALTH" = ok ]; then echo "{\\"ok\\":true}"; exit 0; else exit 22; fi ;;',
      '  *journalctl*) echo "(journal)"; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  await chmod(ssh, 0o755);

  const rsync = join(directory, 'rsync');
  await writeFile(
    rsync,
    ['#!/bin/bash', `printf 'rsync %s\\n' "$*" >> ${JSON.stringify(log)}`, 'exit 0', ''].join('\n'),
  );
  await chmod(rsync, 0o755);

  return {
    env: {
      PATH: `${directory}:${process.env['PATH'] ?? ''}`,
      FAKE_DEADMAN_STATUS: options.status,
      FAKE_HEALTH: options.health,
      // 55 GiB by default, which is what the bench board's card actually reports free.
      FAKE_FREE_KB: String(options.freeKb ?? 57_000_000),
      WAYFARER_HOST: 'root@device.invalid',
    },
    transcript: async () =>
      (await readFile(log, 'utf8'))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
  };
}

const HEALTHY_STATUS = 'armed: no\nsnapshot: /var/lib/wayfarer-deadman/good.tar, 40960 bytes, 120s old\nlast fire: never';

async function deploy(
  env: Record<string, string>,
  args: string[] = ['--fast', '--no-build'],
): Promise<{ code: number; stdout: string; stderr: string }> {
  // No working directory is set on purpose: the script derives the repository root from its own
  // path, so a run from anywhere must find the same tree. If that ever stops being true, these tests
  // are where it shows up.
  const result = await run('/bin/bash', [SCRIPT, ...args], {
    timeoutMs: 60_000,
    env: { ...process.env, ...env } as Record<string, string>,
  });
  return { code: result.code ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test('deploy: the deadman is armed without being asked for, and before anything is copied', async () => {
  const device = await standIn({ status: HEALTHY_STATUS, health: 'ok' });
  const result = await deploy(device.env);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  const transcript = await device.transcript();
  const armed = transcript.findIndex((line) => line.includes('wayfarer-deadman arm'));
  assert.ok(armed >= 0, `nothing armed the deadman:\n${transcript.join('\n')}`);

  // No flag was passed. That is the whole change: a net that has to be asked for is one that gets
  // forgotten on exactly the deploy that needed it.
  const firstPayloadCopy = transcript.findIndex((line) => line.startsWith('rsync') && line.includes('daemon.cjs'));
  assert.ok(firstPayloadCopy >= 0, 'the bundle was never copied');
  assert.ok(
    armed < firstPayloadCopy,
    `the deadman was armed after the first payload copy, which leaves that copy unprotected:\n${transcript.join('\n')}`,
  );
});

test('deploy: disarming happens only after the daemon has answered', async () => {
  const device = await standIn({ status: HEALTHY_STATUS, health: 'ok' });
  const result = await deploy(device.env);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  const transcript = await device.transcript();
  const health = transcript.findIndex((line) => line.includes('curl'));
  const disarmed = transcript.findIndex((line) => line.includes('wayfarer-deadman disarm'));
  assert.ok(health >= 0, 'the daemon was never asked whether it was answering');
  assert.ok(disarmed >= 0, 'a verified deploy left the deadman armed');
  assert.ok(
    health < disarmed,
    `the deadman was disarmed before the health check, so it protected nothing:\n${transcript.join('\n')}`,
  );
});

test('deploy: a deploy that does not verify leaves the deadman ARMED', async () => {
  // The defect this replaces: an unconditional EXIT trap disarmed the deadman on every exit, so a
  // deploy that broke the network tidied away the one thing that would have fixed it.
  const device = await standIn({ status: HEALTHY_STATUS, health: 'dead' });
  const result = await deploy(device.env);
  assert.equal(result.code, 1, 'a deploy whose daemon never answered must fail');

  const transcript = await device.transcript();
  assert.ok(
    transcript.some((line) => line.includes('wayfarer-deadman arm')),
    'the deadman was never armed',
  );
  assert.ok(
    !transcript.some((line) => line.includes('wayfarer-deadman disarm')),
    `an unverified deploy disarmed the deadman:\n${transcript.join('\n')}`,
  );
  assert.match(result.stderr, /did NOT verify/);
  assert.match(result.stderr, /left the deadman ARMED|leaving the deadman ARMED|ARMED/);
});

test('deploy: no snapshot on the device is a refusal, and no snapshot is taken to fix it', async () => {
  // Taking one automatically would bless whatever state the board is in — possibly a half-applied
  // one from a deploy that just failed — as the configuration to fall back to. That turns the safety
  // net into a way to make a broken configuration permanent, which is why docs/15 forbids it.
  const device = await standIn({ status: 'armed: no\nsnapshot: none\nlast fire: never', health: 'ok' });
  const result = await deploy(device.env);
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);

  const transcript = await device.transcript();
  assert.ok(
    !transcript.some((line) => line.includes('wayfarer-deadman snapshot')),
    `the script took a snapshot on its own:\n${transcript.join('\n')}`,
  );
  assert.ok(
    !transcript.some((line) => line.includes('wayfarer-deadman arm')),
    'it armed a deadman with nothing to restore',
  );
  assert.ok(
    !transcript.some((line) => line.startsWith('rsync') && line.includes('daemon.cjs')),
    'it deployed anyway',
  );
  assert.match(result.stderr, /wayfarer-deadman snapshot/);
});

test('deploy: a deadman already armed on the device is a refusal, not a second arm', async () => {
  // The unit name is fixed on purpose, so a second arm fails at systemd rather than producing two
  // timers where the operator believes there is one. Refusing here makes that a sentence instead of
  // a stack trace, and an arm already running means somebody else is mid-change on this board.
  const device = await standIn({
    status: 'armed: 240s left\nsnapshot: /var/lib/wayfarer-deadman/good.tar, 40960 bytes, 90s old',
    health: 'ok',
  });
  const result = await deploy(device.env);
  assert.equal(result.code, 1);

  const transcript = await device.transcript();
  assert.ok(!transcript.some((line) => line.includes('wayfarer-deadman arm')), 'it armed a second deadman');
  assert.ok(!transcript.some((line) => line.startsWith('rsync') && line.includes('daemon.cjs')), 'it deployed anyway');
});

test('deploy: --no-deadman is possible and says plainly what it costs', async () => {
  const device = await standIn({ status: 'armed: no\nsnapshot: none', health: 'ok' });
  const result = await deploy(device.env, ['--fast', '--no-build', '--no-deadman']);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  const transcript = await device.transcript();
  assert.ok(!transcript.some((line) => line.includes('wayfarer-deadman arm')), 'it armed despite --no-deadman');
  // An escape hatch that is silent is one people take by habit.
  assert.match(result.stderr, /NO deadman/);
  assert.match(result.stderr, /until somebody reaches it physically/);
});

test('deploy: the device always receives this tree’s copy of the deadman script', async () => {
  // A board protected by a version of the safety net that is not in the repository is a board whose
  // recovery behaviour nobody can read. The install happens before the arm because it changes no
  // network configuration and the arm needs the script to exist.
  const device = await standIn({ status: HEALTHY_STATUS, health: 'ok' });
  await deploy(device.env);

  const transcript = await device.transcript();
  const installed = transcript.findIndex((line) => line.startsWith('rsync') && line.includes('wayfarer-deadman'));
  const armed = transcript.findIndex((line) => line.includes('wayfarer-deadman arm'));
  assert.ok(installed >= 0, `the deadman script was never copied:\n${transcript.join('\n')}`);
  assert.ok(installed < armed, 'the script armed a deadman it had not yet installed');
});

/* ── what reaches the device, and what it is allowed to cost ──────────────────────────────── */

test('deploy: free space is checked before anything is written, and a refusal names the numbers', async () => {
  // Losing the connection is a terrible way to find out a filesystem is full, and a deploy that
  // dies mid-copy is how the bench board came to need a human. The check is cheap and the refusal
  // happens before the first byte.
  const device = await standIn({ status: HEALTHY_STATUS, health: 'ok', freeKb: 20_000 });
  const result = await deploy(device.env, ['--no-build']);
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /not enough free space/);
  assert.match(result.stderr, /MB available/);
  assert.match(result.stderr, /Nothing has been written/);

  const transcript = await device.transcript();
  assert.ok(
    !transcript.some((line) => line.startsWith('rsync')),
    `it copied something despite refusing:\n${transcript.join('\n')}`,
  );
});

test('deploy: the free-space check runs before the first copy on the full path too', async () => {
  const device = await standIn({ status: HEALTHY_STATUS, health: 'ok' });
  const result = await deploy(device.env, ['--no-build']);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  const transcript = await device.transcript();
  const checked = transcript.findIndex((line) => line.includes('df'));
  const firstCopy = transcript.findIndex((line) => line.startsWith('rsync') && line.includes('wayfarer-install'));
  assert.ok(checked >= 0, `free space was never read:\n${transcript.join('\n')}`);
  assert.ok(firstCopy >= 0, 'the payload was never staged');
  assert.ok(checked < firstCopy, 'space was checked after the copy had already started');
});

test('deploy: sourcemaps are not shipped unless asked for', async () => {
  // Measured on this tree: the maps are two thirds of the payload and the device works identically
  // without them. The card is the only part of the device that wears out, so this is a decision
  // about write volume rather than about tidiness.
  const withoutMaps = await standIn({ status: HEALTHY_STATUS, health: 'ok' });
  assert.equal((await deploy(withoutMaps.env, ['--no-build'])).code, 0);
  const plain = await withoutMaps.transcript();
  assert.ok(
    !plain.some((line) => line.includes('.cjs.map')),
    `a sourcemap was shipped without being asked for:\n${plain.join('\n')}`,
  );

  const withMaps = await standIn({ status: HEALTHY_STATUS, health: 'ok' });
  assert.equal((await deploy(withMaps.env, ['--no-build', '--with-sourcemaps'])).code, 0);
  const verbose = await withMaps.transcript();
  assert.ok(
    verbose.some((line) => line.includes('daemon.cjs.map')),
    `--with-sourcemaps did not ship the map:\n${verbose.join('\n')}`,
  );
});

test('deploy: the install payload is removed afterwards, and no source tree is sent', async () => {
  const device = await standIn({ status: HEALTHY_STATUS, health: 'ok' });
  assert.equal((await deploy(device.env, ['--no-build'])).code, 0);

  const transcript = await device.transcript();
  // Nothing from a source directory, a package directory or a lockfile has any business on a device
  // that runs one bundled file.
  for (const forbidden of ['/src/', 'node_modules', 'pnpm-lock', 'tsconfig']) {
    assert.ok(
      !transcript.some((line) => line.startsWith('rsync') && line.includes(forbidden)),
      `${forbidden} was copied to the device:\n${transcript.join('\n')}`,
    );
  }
  assert.ok(
    transcript.some((line) => line.includes('rm -rf /opt/wayfarer-install')),
    `the payload was left on the card:\n${transcript.join('\n')}`,
  );
  // A board deployed before this change still has the old directory; cleaning it up here beats a
  // note somebody has to read.
  assert.ok(
    transcript.some((line) => line.includes('rm -rf /opt/wayfarer-src')),
    'the superseded staging directory is never cleaned up',
  );
});

test('deploy: --keep-payload leaves it in place for someone debugging the installer', async () => {
  const device = await standIn({ status: HEALTHY_STATUS, health: 'ok' });
  assert.equal((await deploy(device.env, ['--no-build', '--keep-payload'])).code, 0);
  const transcript = await device.transcript();
  assert.ok(!transcript.some((line) => line.includes('rm -rf /opt/wayfarer-install')));
});

test('deploy: an unreachable device is refused before any check that could be blamed for it', async () => {
  /*
   * Observed 2026-09-21 with the wrong ssh key: the first thing the script said was "could not read
   * free space on the device; proceeding without the check" — a warning about disk space on a board
   * it had never reached, and an invitation to proceed. The message named whichever check happened
   * to be first instead of the thing that was wrong.
   *
   * Asserted as an ordering, derived from the script text, because the ordering is the property: the
   * reachability refusal has to come before the first check whose failure it would explain.
   */
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const text = await readFile(join(import.meta.dirname, '..', '..', '..', 'scripts', 'deploy.sh'), 'utf8');
  const code = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  const reach = code.indexOf('\nrequire_device');
  const space = code.indexOf('\ncheck_free_space\n');
  assert.ok(reach >= 0, 'nothing proves the device is reachable');
  assert.ok(space >= 0, 'the free-space check should still be called');
  assert.ok(reach < space, 'reachability must be established before the free-space check runs');

  const body = /require_device\(\)\s*\{([\s\S]*?)\n\}/.exec(text)?.[1];
  assert.ok(body, 'require_device should exist');
  assert.match(body!, /\bdie\b/, 'an unreachable device must be a refusal, not a warning');
});

test('deploy: space is checked before the deadman is armed, so a refusal costs nothing', async () => {
  // Found by the refusal test above, and worth its own assertion because it is a pure ordering
  // property. Arming first and refusing second leaves a deadman armed over a deploy that never
  // started: the board restores its configuration and reboots for nothing, and the operator is left
  // reading a failure message about disk space while the device disappears.
  const device = await standIn({ status: HEALTHY_STATUS, health: 'ok' });
  assert.equal((await deploy(device.env, ['--no-build'])).code, 0);

  const transcript = await device.transcript();
  const checked = transcript.findIndex((line) => line.includes('df'));
  const armed = transcript.findIndex((line) => line.includes('wayfarer-deadman arm'));
  assert.ok(checked >= 0 && armed >= 0);
  assert.ok(checked < armed, `space was checked after arming:\n${transcript.join('\n')}`);
});
