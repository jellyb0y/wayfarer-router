import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  RESET_WARNING_THRESHOLD,
  certificateResetWarning,
} from '../src/core/tunnel-health.ts';

const base = { tunnelId: 'hq', restarts: RESET_WARNING_THRESHOLD, activeSeconds: 5, clockTrusted: true };

test('one or two resets are not a warning: a dropped connection is ordinary', () => {
  assert.equal(certificateResetWarning({ ...base, restarts: 1 }), null);
  assert.equal(certificateResetWarning({ ...base, restarts: 2 }), null);
  assert.ok(certificateResetWarning({ ...base, restarts: 3 }));
});

test('a tunnel that has been up for an hour is not resetting, whatever its lifetime count says', () => {
  // The pattern is connect-drop-connect. A long-running tunnel that restarted three times last week
  // has no certificate problem, and telling its owner it does teaches them to ignore the warning.
  assert.equal(certificateResetWarning({ ...base, restarts: 9, activeSeconds: 3600 }), null);
});

test('when the clock is not known to be right, the clock is named first', () => {
  const warning = certificateResetWarning({ ...base, clockTrusted: false })!;
  /*
   * A board with no battery-backed clock that has just been powered on somewhere with no time source
   * rejects every certificate it is shown. Naming the certificate first sends its owner to replace
   * credentials that were never wrong.
   */
  assert.match(warning.message, /clock is not known to be correct/);
  assert.match(warning.hint, /^Check the date on this device first/);
  assert.ok(warning.message.indexOf('clock') < warning.message.indexOf('certificate'));
});

test('when the clock is trusted, the certificate is the suspect', () => {
  const warning = certificateResetWarning({ ...base, clockTrusted: true })!;
  assert.match(warning.message, /expired certificate/);
  assert.ok(!warning.message.includes('clock is not known'));
});

test('an unverifiable clock is treated as untrusted, not as fine', () => {
  // "We could not tell" and "it is wrong" produce identical certificate failures, so a warning that
  // named the clock only when it was proved wrong would stay silent in exactly the case it exists for.
  const warning = certificateResetWarning({ ...base, clockTrusted: false })!;
  assert.match(warning.hint, /nothing about the tunnel is at fault/);
});

/* ── the call site, not just the pure function ───────────────────────────────────────────── */

test('the two timestamps the doctor compares are on the same clock', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const cli = await readFile(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');

  /*
   * The pure function above was tested with hand-written values, which is why nobody looked at the
   * numbers going *in*. The call site subtracted `ActiveEnterTimestampMonotonic` — microseconds since
   * **boot** — from `process.uptime()`, seconds since **this process** started, and clamped the result at
   * zero. `activeSeconds` was therefore always zero, every restarting tunnel looked freshly started, and
   * the guard that excludes a long-running tunnel could never fire. The arithmetic looked plausible until
   * the units were named.
   *
   * A guard that can never fire is already in the catalogue; this instance is sharper because it reads
   * correctly.
   */
  // Comments stripped first: the paragraph above this assertion explains the bug and names the call,
  // and a test that matched prose would fail on its own documentation.
  const code = cli.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !code.includes('process.uptime()'),
    'process.uptime() is process-relative and cannot be compared with a boot-relative timestamp',
  );
  assert.ok(cli.includes('platform.host.uptimeSeconds()'), 'the machine uptime is the comparable clock');
  // And an unreadable uptime skips the decision rather than guessing at it.
  assert.match(cli, /if \(bootSeconds === null \|\| activeSinceBoot <= 0\) continue;/);
});

test('the uptime reader is boot-relative and reports unknown rather than zero', async () => {
  const { createHostReader } = await import('../src/platform/host.ts');
  const host = createHostReader();
  const seconds = await host.uptimeSeconds();

  if (process.platform === 'linux') {
    assert.ok(seconds !== null && seconds > 0, 'a running Linux machine has a positive uptime');
  } else {
    // No procfs. `null` is the honest answer, and the caller skips rather than treating it as zero —
    // zero would mean "just started", which is exactly the wrong conclusion.
    assert.equal(seconds, null);
  }
});
