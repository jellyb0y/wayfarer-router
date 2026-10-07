/**
 * The wireless client's control-socket path: arguments, parsing, and the trailing space.
 *
 * The ruling this tests: we do not contend for `fi.w1.wpa_supplicant1`, a name with exactly one
 * owner. We run our own supplicant with its own control socket in our own directory and read it with
 * `wpa_cli`, the same shape as the access point's `hostapd_cli`.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  SUPPLICANT_CONTROL_DIR,
  createSupplicantCliController,
  wpaCliArgs,
  EmptySupplicantInterfaceError,
} from '../src/platform/supplicant-cli.ts';
import { parseSupplicantCliEvent, parseSupplicantStatus } from '../src/platform/parse/supplicant-cli.ts';

test('the control directory is ours, not the distribution shared one', () => {
  assert.equal(SUPPLICANT_CONTROL_DIR, '/run/wayfarer/supplicant');
  assert.ok(
    !SUPPLICANT_CONTROL_DIR.startsWith('/run/wpa_supplicant'),
    'a socket in the shared directory is one another supplicant instance can collide with',
  );
});

test('the generator and the reader use one definition of where the socket is', async () => {
  const { SUPPLICANT_CONTROL_DIR: fromGenerator } = await import('../src/core/generate/supplicant.ts');
  assert.equal(fromGenerator, SUPPLICANT_CONTROL_DIR, 'two copies is how the access point pair came to disagree');
});

test('every call passes -p before -i, or it looks in the wrong directory', () => {
  // Asserted on the real argument builder, not on a substitute a test wrote itself.
  assert.deepEqual(wpaCliArgs('/run/wayfarer/supplicant', 'wlan0', ['status']), [
    '-p',
    '/run/wayfarer/supplicant',
    '-i',
    'wlan0',
    'status',
  ]);
  // The interactive attach is the same arguments with no command.
  assert.deepEqual(wpaCliArgs('/run/wayfarer/supplicant', 'wlan0', []), [
    '-p',
    '/run/wayfarer/supplicant',
    '-i',
    'wlan0',
  ]);
});

test('an empty interface name is refused rather than hanging forever', async () => {
  const controller = createSupplicantCliController();
  await assert.rejects(() => controller.status('  '), EmptySupplicantInterfaceError);
  assert.throws(() => controller.watch('', () => {}), EmptySupplicantInterfaceError);
});

test('status is read through the substitutable call', async () => {
  const seen: string[][] = [];
  const controller = createSupplicantCliController({
    call: async (_iface, command) => {
      seen.push(command);
      return {
        code: 0,
        stdout: 'bssid=aa:bb:cc:dd:ee:ff\nfreq=5180\nssid=VINTAGE \nwpa_state=COMPLETED\nip_address=192.168.77.9\n',
      };
    },
  });
  const status = await controller.status('wlan0');
  assert.deepEqual(seen, [['status']]);
  assert.equal(status?.state, 'COMPLETED');
  assert.equal(status?.frequencyMhz, 5180);
  assert.equal(status?.ipAddress, '192.168.77.9');
  // The whole point: the reply's SSID keeps its trailing space.
  assert.equal(status?.ssid, 'VINTAGE ');
});

test('a status reply that cannot be reached is null, not an empty status', async () => {
  const controller = createSupplicantCliController({
    call: async () => ({ code: 255, stdout: "Failed to connect to non-global ctrl_ifname: wlan0\n" }),
  });
  assert.equal(await controller.status('wlan0'), null);
});

test('the status parser keeps the name exactly as the tool printed it', () => {
  // A line ending is removed; the value is not touched. Trimming the value is the bug.
  const parsed = parseSupplicantStatus('ssid=VINTAGE \r\nwpa_state=COMPLETED\r\n');
  assert.equal(parsed.ssid, 'VINTAGE ');
  assert.equal(parsed.state, 'COMPLETED');
});

test('the interactive banner and prompt are not events', () => {
  assert.equal(parseSupplicantCliEvent('Selected interface \'wlan0\''), null);
  assert.equal(parseSupplicantCliEvent('> '), null);
  assert.equal(parseSupplicantCliEvent(''), null);
  assert.equal(parseSupplicantCliEvent('OK'), null);
});

test('the events a person needs are recognised', () => {
  assert.deepEqual(
    parseSupplicantCliEvent('<3>CTRL-EVENT-CONNECTED - Connection to aa:bb:cc:dd:ee:ff completed'),
    { kind: 'connected', bssid: 'aa:bb:cc:dd:ee:ff' },
  );
  assert.deepEqual(parseSupplicantCliEvent('<3>CTRL-EVENT-DISCONNECTED bssid=aa:bb:cc:dd:ee:ff reason=3'), {
    kind: 'disconnected',
    reason: '3',
  });
  assert.deepEqual(parseSupplicantCliEvent('<3>CTRL-EVENT-SCAN-RESULTS '), { kind: 'scan-done', success: true });
  // The wrong key, reported as itself rather than as a disconnect with an unreadable reason code.
  assert.deepEqual(
    parseSupplicantCliEvent('<3>CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="VINTAGE " auth_failures=1 duration=10'),
    { kind: 'auth-failed' },
  );
});
