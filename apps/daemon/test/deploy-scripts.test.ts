/**
 * Tests for the deployment scripts that edit a boot configuration.
 *
 * The kernel command line is the one file where a wrong edit produces a device that does not boot
 * and cannot be reached over the network — on hardware with no console, that means a human with a
 * card reader. So it is exercised against copies in a temporary directory, with the shapes that
 * actually occur: no `extraargs` line at all, an existing one, and one where the option is already
 * present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/platform/exec.ts';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'deploy', 'set-fsck-repair.sh');

async function fixture(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-boot-'));
  const path = join(directory, name);
  await writeFile(path, content);
  await chmod(path, 0o644);
  return path;
}

test('fsck repair: adds an extraargs line when none exists', async () => {
  const path = await fixture('armbianEnv.txt', 'verbosity=1\nconsole=both\nrootfstype=ext4\n');
  const result = await run('/bin/bash', [SCRIPT, path], { timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr);

  const after = await readFile(path, 'utf8');
  assert.match(after, /^extraargs=fsck\.repair=yes$/m);
  // Everything that was there is still there: this file also carries the root device.
  assert.match(after, /^rootfstype=ext4$/m);
  assert.match(after, /^verbosity=1$/m);
});

test('fsck repair: appends to an existing extraargs line rather than adding a second one', async () => {
  const path = await fixture('armbianEnv.txt', 'verbosity=1\nextraargs=cma=96M quiet\nrootfstype=ext4\n');
  const result = await run('/bin/bash', [SCRIPT, path], { timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr);

  const after = await readFile(path, 'utf8');
  // The loader reads the last definition only, so a second line would silently discard the first —
  // which in this fixture would drop a memory reservation the board needs to boot.
  assert.equal(after.split('\n').filter((line) => line.startsWith('extraargs=')).length, 1);
  assert.match(after, /^extraargs=cma=96M quiet fsck\.repair=yes$/m);
});

test('fsck repair: is idempotent, so the installer can be re-run', async () => {
  const path = await fixture('armbianEnv.txt', 'extraargs=fsck.repair=yes\n');
  const before = await readFile(path, 'utf8');
  const result = await run('/bin/bash', [SCRIPT, path], { timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.match(result.stdout, /already carries/);
});

test('fsck repair: --check reports without changing anything', async () => {
  const missing = await fixture('armbianEnv.txt', 'verbosity=1\n');
  const notSet = await run('/bin/bash', [SCRIPT, '--check', missing], { timeoutMs: 10_000 });
  assert.equal(notSet.code, 1);
  assert.match(notSet.stdout, /does NOT carry/);
  assert.equal(await readFile(missing, 'utf8'), 'verbosity=1\n');

  const present = await fixture('armbianEnv.txt', 'extraargs=fsck.repair=yes\n');
  const isSet = await run('/bin/bash', [SCRIPT, '--check', present], { timeoutMs: 10_000 });
  assert.equal(isSet.code, 0);
});

test('fsck repair: a single-line cmdline.txt gets the option appended to that line', async () => {
  const path = await fixture('cmdline.txt', 'console=serial0,115200 root=PARTUUID=aa rootwait\n');
  const result = await run('/bin/bash', [SCRIPT, path], { timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr);

  const after = await readFile(path, 'utf8');
  // One line, still one line: some loaders stop reading at the first newline.
  assert.equal(after.trim().split('\n').length, 1);
  assert.match(after, /rootwait fsck\.repair=yes/);
});

test('fsck repair: a missing file is refused rather than created', async () => {
  const result = await run('/bin/bash', [SCRIPT, join(tmpdir(), 'wayfarer-absent-boot-file')], {
    timeoutMs: 10_000,
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /does not exist/);
});

test('deadman: the script refuses to arm without a snapshot, and says why', async () => {
  // Run with a state directory that cannot exist, so nothing on this machine is touched. The point
  // is the refusal: an armed deadman with nothing to restore reboots and changes nothing, which is
  // worse than no deadman at all because it looks like protection.
  const script = join(import.meta.dirname, '..', '..', '..', 'deploy', 'bench', 'wayfarer-deadman');
  const help = await run('/bin/bash', [script, '--help'], { timeoutMs: 10_000 });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /arm \[minutes\]/);
  assert.match(help.stdout, /restore makes each snapshotted directory match the snapshot exactly/);

  const syntax = await run('/bin/bash', ['-n', script], { timeoutMs: 10_000 });
  assert.equal(syntax.code, 0, syntax.stderr);
});

test('deadman: the deadline it records is the same expression it gives systemd', async () => {
  /*
   * The defect this exists to prevent, measured on the board on 2026-09-21: `arm` created the timer
   * with `--on-active=20min`, whose deadline systemd re-bases to the moment of any
   * `systemctl daemon-reload` — and every apply that writes a unit runs one. The deadman was
   * therefore postponed by its full interval by the operation it was armed to protect, and an apply
   * that retries would postpone it forever. Meanwhile `status` read the deadline it had written to
   * its own record and reported "overdue by 604s" about a timer with four minutes left.
   *
   * The fix is an `OnBootSec` anchor, and the property worth asserting is not the spelling of the
   * flag but the thing that was actually wrong: the number written to the record must be the *same
   * shell expression* as the number handed to systemd, so the record cannot be a second copy that
   * drifts. Two literals that happen to agree today is the shape this codebase fails in.
   */
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const text = await readFile(join(import.meta.dirname, '..', '..', '..', 'deploy', 'bench', 'wayfarer-deadman'), 'utf8');

  const arm = /^cmd_arm\(\)\s*\{([\s\S]*?)^\}/m.exec(text)?.[1];
  assert.ok(arm, 'cmd_arm should exist');

  // Comments are stripped first. The comment above `arm` names `--on-active` in order to explain why
  // it is wrong, and a test that reads the prose describing a defect cannot tell it from the defect —
  // which is this codebase's own dominant failure mode, met here while writing a guard against it.
  const code = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.ok(
    !/--on-active/.test(code),
    'a deadman must not use --on-active: daemon-reload re-bases that deadline, and applies reload',
  );

  const given = /--timer-property=OnBootSec="\$\{([A-Za-z_][A-Za-z0-9_]*)\}s"/.exec(arm!)?.[1];
  assert.ok(given, 'arm should anchor the timer with OnBootSec derived from a variable');

  const recorded = /"fireAtUptime": %s\\n' "\$([A-Za-z_][A-Za-z0-9_]*)"/.exec(arm!)?.[1];
  assert.ok(recorded, 'arm should record fireAtUptime from a variable');

  assert.equal(
    recorded,
    given,
    'the recorded deadline and the deadline systemd acts on must be the same expression',
  );
});

test('deadman: status reports a drift between its record and the timer instead of trusting the record', async () => {
  // The status line is what a person acts on at 2am. Reporting the record alone is what let a
  // fifteen-minute disagreement read as a deadman that had already failed.
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const text = await readFile(join(import.meta.dirname, '..', '..', '..', 'deploy', 'bench', 'wayfarer-deadman'), 'utf8');

  const status = /^cmd_status\(\)\s*\{([\s\S]*?)^\}/m.exec(text)?.[1];
  assert.ok(status, 'cmd_status should exist');
  assert.match(status!, /NextElapseUSecMonotonic/, 'status should quote systemd’s own deadline on a drift');
  assert.match(status!, /DRIFT_GRACE_SECONDS/, 'the tolerance should be named, not inline');
  assert.match(text, /^DRIFT_GRACE_SECONDS=\d+$/m);
});

test('install: a rollback copy from an interrupted update is never overwritten', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const script = await readFile(join(import.meta.dirname, '..', '..', '..', 'deploy', 'install.sh'), 'utf8');

  const body = /keep_previous_bundle\(\)\s*\{([\s\S]*?)\n\}/.exec(script)?.[1];
  assert.ok(body, 'keep_previous_bundle should exist');

  /*
   * The guard, and the order that makes it mean anything: the existence check must come BEFORE the
   * copy, or the copy has already destroyed what it was guarding.
   *
   * An existing rollback copy means an earlier update started and never reached the line that clears
   * it. The bundle in place is therefore the one that failed, and copying it over the rollback would
   * replace the last known-good daemon with the broken one — leaving nothing to go back to at exactly
   * the moment a second attempt is being made because the first went wrong.
   */
  const guard = body.indexOf('$PREVIOUS_SUFFIX" ]');
  const copy = body.indexOf('cp -a');
  assert.ok(guard >= 0, 'nothing checks whether a rollback copy already exists');
  assert.ok(copy >= 0);
  assert.ok(guard < copy, 'the check must come before the copy, or the copy has already overwritten it');
});

test('the revert timer expresses a deadline, not an interval anything can restart', async () => {
  /*
   * The defect, measured on the board on 2026-09-21 in the bench deadman and then found here by
   * inspection: `--on-active=<N>` expresses the deadline as an interval from the *activation of the
   * timer unit*, and `systemctl daemon-reload` re-bases it to the moment of the reload.
   *
   * That is fatal for this particular timer. It is armed **before** the reconcile begins, and the
   * reconcile calls `daemonReload()` once for every unit it installs — so a `network` apply postponed
   * its own revert by the whole confirmation window, repeatedly, and the promise the operator's access
   * depends on ("do nothing and it comes back within three minutes") could be deferred indefinitely by
   * the apply itself.
   *
   * A deadline expressed as an interval from activation is not a deadline; it is a delay. Anchoring it
   * to boot makes the number the caller computed the same number systemd acts on, and that identity is
   * the fix rather than the anchor.
   */
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const src = join(import.meta.dirname, '..', 'src', 'platform', 'systemd.ts');
  const text = await readFile(src, 'utf8');

  // Comments are stripped: the code explains why --on-active is wrong, and a check that reads the
  // explanation cannot tell it from the defect.
  const code = text
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join('\n');

  assert.ok(!/--on-active/.test(code), 'no timer in the platform layer may use --on-active');

  const body = /async runTransient\(transient\) \{([\s\S]*?)\n    \},/.exec(code)?.[1];
  assert.ok(body, 'runTransient should exist');
  assert.match(body!, /OnBootSec=\$\{firesAtUptimeSeconds\}s/, 'the deadline must be anchored to boot');
  // And the anchor must come from the clock that does not move, read at arm time.
  assert.match(body!, /readUptimeSeconds\(\)/);
  // An unreadable uptime is a refusal, not a fallback: a deadline that cannot be anchored is a delay,
  // and the caller treats a refusal as "do not apply", which is the safe direction.
  assert.match(body!, /Refusing to/);
});

test('a countdown shown to an operator is a duration, never a foreign clock’s timestamp', async () => {
  /*
   * The device has no clock battery and its wall time can be days out after a power cycle. The
   * confirmation window's page used to take the device's ISO `deadlineAt` and subtract the browser's
   * `Date.now()`, so the countdown was wrong by however far apart the two clocks were — showing "0s
   * left, undoing the change" on a device that had not begun undoing anything. A duration means the
   * same thing in both frames; an instant does not.
   */
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const component = join(import.meta.dirname, '..', '..', 'ui', 'src', 'components', 'ConfirmationWindow.tsx');
  const text = await readFile(component, 'utf8');
  const code = text
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join('\n');

  assert.match(code, /secondsRemaining: number;/, 'the page should be handed a duration');
  assert.ok(
    !/Date\.parse\(deadlineAt\)/.test(code),
    'the page must not parse the device’s timestamp against its own clock',
  );
  assert.ok(!/deadlineAt/.test(code), 'the device’s absolute deadline has no place in the countdown');
});
