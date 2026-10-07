/**
 * The `hostapd_cli` / `wpa_cli` wrapper (E17), exercised as a process rather than read.
 *
 * The thing under test is a shell script, and the only way to test a shell script honestly is to run
 * it and look at what it handed to the tool. So each case below installs a stand-in binary that
 * prints its own argument list, runs the wrapper against it, and asserts on that list — which means
 * a failure here is the wrapper passing the wrong arguments, not a regular expression disagreeing
 * with a comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), '../../../deploy/bin/wayfarer-cli');

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A directory holding stand-in `hostapd_cli` and `wpa_cli` that echo their arguments, plus the two
 * names the installer creates as links to the wrapper.
 */
async function stage(): Promise<{ hostapd: string; supplicant: string; sbin: string }> {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-wrapper-'));
  const sbin = join(root, 'sbin');
  await run('mkdir', ['-p', sbin]);
  for (const tool of ['hostapd_cli', 'wpa_cli']) {
    const path = join(sbin, tool);
    // Prints one argument per line, so an empty argument or one containing a space cannot be
    // confused with two — the failure mode of asserting on a joined string.
    await writeFile(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`);
    await chmod(path, 0o755);
  }
  const hostapd = join(root, 'wayfarer-hostapd_cli');
  const supplicant = join(root, 'wayfarer-wpa_cli');
  await symlink(WRAPPER, hostapd);
  await symlink(WRAPPER, supplicant);
  return { hostapd, supplicant, sbin };
}

async function invoke(command: string, args: string[], sbin: string): Promise<Ran> {
  try {
    const { stdout, stderr } = await run(command, args, { env: { ...process.env, WAYFARER_SBIN: sbin } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

test('the socket flag is supplied without anybody typing it, for both tools', async () => {
  const { hostapd, supplicant, sbin } = await stage();

  const ap = await invoke(hostapd, ['-i', 'wlx90de8047b4b4', 'status'], sbin);
  assert.equal(ap.code, 0, ap.stderr);
  assert.deepEqual(ap.stdout.split('\n').filter(Boolean), [
    '-p',
    '/run/wayfarer/hostapd',
    '-i',
    'wlx90de8047b4b4',
    'status',
  ]);

  // Not the same directory, which is the entire reason a single wrapper dispatching on its own name
  // is worth more than two aliases somebody has to keep in step.
  const uplink = await invoke(supplicant, ['-i', 'wfwan0', 'status'], sbin);
  assert.equal(uplink.code, 0, uplink.stderr);
  assert.deepEqual(uplink.stdout.split('\n').filter(Boolean), [
    '-p',
    '/run/wayfarer/supplicant',
    '-i',
    'wfwan0',
    'status',
  ]);
});

test('the arguments after the flag are passed through untouched', async () => {
  const { hostapd, sbin } = await stage();
  // An argument with a space in it, because the wrapper is written in shell and losing quoting is
  // the way a shell wrapper usually breaks.
  const result = await invoke(hostapd, ['-i', 'wlan0', 'set', 'ssid', 'two words'], sbin);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter(Boolean), [
    '-p',
    '/run/wayfarer/hostapd',
    '-i',
    'wlan0',
    'set',
    'ssid',
    'two words',
  ]);
});

test('an explicit -p is refused rather than honoured, and the message names the right directory', async () => {
  const { hostapd, sbin } = await stage();
  // The failure this prevents: `-p /var/run/hostapd` does not error, it reports a working access
  // point as absent. Honouring the operator's flag would hand back exactly that confident wrong
  // answer — which is what the wrapper exists to remove, so it must not be reachable through it.
  const result = await invoke(hostapd, ['-i', 'wlan0', '-p', '/var/run/hostapd', 'status'], sbin);
  assert.equal(result.code, 2, 'an explicit -p was accepted');
  assert.equal(result.stdout, '', 'the tool was run despite the refusal');
  assert.match(result.stderr, /refusing an explicit -p/);
  assert.match(result.stderr, /\/run\/wayfarer\/hostapd/, 'the refusal does not name the directory to use');
  // And it names the unwrapped tool, which is the sanctioned way to reach a different socket. That
  // escape hatch is why not shadowing the real binary matters.
  assert.match(result.stderr, /hostapd_cli -p <dir>/);
});

test('the joined form -p/dir is refused too', async () => {
  const { supplicant, sbin } = await stage();
  // `-p/some/dir` with no space is valid for these tools, so a check that only looked for a bare
  // `-p` would let the bypass through in the form most likely to be typed by someone in a hurry.
  const result = await invoke(supplicant, ['-i', 'wfwan0', '-p/var/run/wpa_supplicant', 'status'], sbin);
  assert.equal(result.code, 2, 'the joined -p form was accepted');
  assert.equal(result.stdout, '');
});

test('it says what it did, so the operator learns the flag exists', async () => {
  const { hostapd, sbin } = await stage();
  const result = await invoke(hostapd, ['-i', 'wlan0', 'status'], sbin);
  // On stderr, so it never lands in output something else is parsing.
  assert.match(result.stderr, /using .*hostapd_cli -p \/run\/wayfarer\/hostapd/);
  assert.ok(!result.stdout.includes('using'), 'the notice leaked into stdout');
});

test('a missing tool is reported as a missing tool, not as a silent success', async () => {
  const { hostapd } = await stage();
  const result = await invoke(hostapd, ['-i', 'wlan0', 'status'], '/nonexistent/sbin');
  assert.equal(result.code, 127);
  assert.match(result.stderr, /is not installed/);
});

test('no default interface is invented', async () => {
  const { hostapd, sbin } = await stage();
  // Measured on the bench board, hostapd_cli 2.10: an empty interface argument hangs for ever
  // instead of failing. A wrapper that helpfully supplied one would turn "which interface?" into a
  // hang, so the argument list must contain nothing but the flag and what the caller typed.
  const result = await invoke(hostapd, ['status'], sbin);
  assert.deepEqual(result.stdout.split('\n').filter(Boolean), ['-p', '/run/wayfarer/hostapd', 'status']);
});

test('the installer ships the wrapper and links both names without shadowing the real tools', async () => {
  const installer = join(dirname(fileURLToPath(import.meta.url)), '../../../deploy/install.sh');
  const text = await run('cat', [installer]);
  assert.match(text.stdout, /install -m 0755 "\$SOURCE_DIR\/deploy\/bin\/wayfarer-cli"/);
  assert.match(text.stdout, /ln -sfn "\$PREFIX\/bin\/wayfarer-cli" \/usr\/local\/bin\/wayfarer-hostapd_cli/);
  assert.match(text.stdout, /ln -sfn "\$PREFIX\/bin\/wayfarer-cli" \/usr\/local\/bin\/wayfarer-wpa_cli/);
  // The load-bearing negative: the installer must never put anything at the real tools' own names.
  // Shadowing them would replace one trap with another, and the refusal above tells an operator to
  // fall back to the unwrapped tool — advice that only works while the unwrapped tool is intact.
  assert.ok(
    !/\/usr\/local\/bin\/hostapd_cli|\/usr\/local\/bin\/wpa_cli|\/usr\/sbin\/hostapd_cli"|\/usr\/sbin\/wpa_cli"/.test(
      text.stdout,
    ),
    'the installer writes to a name belonging to the real tools',
  );
});
