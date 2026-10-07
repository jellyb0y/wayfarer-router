/**
 * Tests for the parts of the platform layer and the state layer whose failure modes are the
 * expensive ones: where the management interface binds, whether a configuration file can be left
 * truncated, whether a ruleset can delete another program's tables, and whether the credential gate
 * actually gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeConfig, resolveBindAddresses, DEFAULT_CONFIG } from '../src/config.ts';
import { writeAtomic, readManaged, fileMode } from '../src/platform/files.ts';
import { createNftController, ForbiddenRulesetError } from '../src/platform/nft.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore, hashPassword, verifyPassword, EVENT_RING_SIZE, SESSION_IDLE_SECONDS, LOGIN_ATTEMPT_HISTORY } from '../src/state/store.ts';
// Imported from the pure module rather than from the D-Bus controller, so this suite runs on a
// device that has no development dependencies installed.
import { unitIsHealthy, normaliseUnitState } from '../src/platform/parse/unit-state.ts';
import { run, EmptyArgumentError } from '../src/platform/exec.ts';

const temp = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'wayfarer-test-'));

test('config: with no file the configured surfaces are loopback and nothing else', () => {
  /*
   * "Configured" is the whole point of the wording. The bind set is this list **plus** whatever the active
   * profile's management surfaces resolve to — the access point, and the uplink unless the profile turns it
   * off — so an empty `interfaces` no longer means the device is only reachable over a forwarded port. It
   * means nobody has named a surface the profile does not already describe.
   *
   * The warning is asserted on its substance rather than the old phrase "loopback only", which stopped being
   * true when the surfaces became derived.
   */
  const warnings: string[] = [];
  const config = mergeConfig({}, warnings);
  assert.deepEqual(config.listen.addresses, ['127.0.0.1']);
  assert.deepEqual(config.listen.interfaces, []);
  assert.ok(warnings.some((warning) => warning.includes('the active ') && warning.includes('profile resolves to')));
});

test('config: loopback is always in the bind set even when the file omits it', () => {
  const config = mergeConfig({ listen: { port: 9000, addresses: ['10.0.0.1'] } }, []);
  // The operator CLI and the update flow talk to the daemon locally and must keep working when a
  // profile removes every other address.
  assert.ok(config.listen.addresses.includes('127.0.0.1'));
  assert.equal(config.listen.port, 9000);
});

test('config: an out-of-range port falls back rather than being trusted', () => {
  const warnings: string[] = [];
  const config = mergeConfig({ listen: { port: 70000 } }, warnings);
  assert.equal(config.listen.port, DEFAULT_CONFIG.listen.port);
  assert.ok(warnings.some((warning) => warning.includes('out of range')));
});

test('binding: interface names resolve to their current addresses, and IPv6 is not bound', () => {
  const { bind, unresolved } = resolveBindAddresses(
    { port: 8088, addresses: ['127.0.0.1'], interfaces: ['ap0'] },
    [
      { name: 'ap0', address: '10.44.0.1', family: 'inet' },
      { name: 'ap0', address: 'fe80::1', family: 'inet6' },
      { name: 'wan0', address: '192.168.1.5', family: 'inet' },
    ],
  );
  assert.deepEqual(bind.sort(), ['10.44.0.1', '127.0.0.1']);
  // The uplink's address is not in the set, and nothing about it is guessed at: it is simply not
  // named in the configuration.
  assert.ok(!bind.includes('192.168.1.5'));
  assert.deepEqual(unresolved, []);
});

test('binding: an interface with no address yet is reported, not silently dropped', () => {
  const { bind, unresolved } = resolveBindAddresses(
    { port: 8088, addresses: ['127.0.0.1'], interfaces: ['ap0'] },
    [{ name: 'wan0', address: '192.168.1.5', family: 'inet' }],
  );
  assert.deepEqual(bind, ['127.0.0.1']);
  // "Bound to nothing" has to be visible rather than looking like a successful start.
  assert.deepEqual(unresolved, ['ap0']);
});

test('writeAtomic: the temporary file is in the target directory and nothing is left behind', async () => {
  const directory = await temp();
  const target = join(directory, 'config.conf');
  const result = await writeAtomic(target, 'first\n', { mode: 0o600 });

  assert.equal(result.changed, true);
  assert.equal(await readFile(target, 'utf8'), 'first\n');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  // A temporary file left in place would be indistinguishable from a partial write later.
  assert.deepEqual((await readdir(directory)).sort(), ['config.conf']);
});

test('writeAtomic: identical content and mode is not written again', async () => {
  const directory = await temp();
  const target = join(directory, 'config.conf');
  await writeAtomic(target, 'same\n', { mode: 0o640 });
  const before = (await stat(target)).mtimeMs;

  const second = await writeAtomic(target, 'same\n', { mode: 0o640 });
  // Re-applying a configuration must not cost the card a write: the whole device's measured
  // baseline is 650–750 B/s and this path is on the hot side of that budget.
  assert.equal(second.changed, false);
  assert.equal((await stat(target)).mtimeMs, before);

  const third = await writeAtomic(target, 'same\n', { mode: 0o600 });
  // A mode change alone still counts as a change.
  assert.equal(third.changed, true);
  assert.equal(await fileMode(target), 0o600);
});

test('writeAtomic: replacing a file never exposes a partial one', async () => {
  const directory = await temp();
  const target = join(directory, 'core.json');
  await writeFile(target, '{"old":true}\n');

  const big = `${'x'.repeat(200_000)}\n`;
  await writeAtomic(target, big, { mode: 0o600 });
  const written = await readFile(target, 'utf8');
  // Either the old content or the whole new content — never a prefix. A truncated core
  // configuration means the core does not start, and the device comes up with a working access
  // point and no tunnel, which looks like success.
  assert.equal(written, big);
});

test('readManaged: a missing file is null rather than an exception', async () => {
  const directory = await temp();
  assert.equal(await readManaged(join(directory, 'absent')), null);
  assert.equal(await fileMode(join(directory, 'absent')), null);
});

test('nft: a ruleset containing flush ruleset is refused before anything runs', async () => {
  // `/bin/false` stands in for nft: the point is that the refusal happens before the tool is
  // reached at all, so the test does not need nftables present.
  const controller = createNftController('/bin/false');
  await assert.rejects(
    () => controller.check('flush ruleset\ntable inet wayfarer {}\n'),
    ForbiddenRulesetError,
  );
  await assert.rejects(
    () => controller.apply('table inet x {}\nflush ruleset\n', join(tmpdir(), 'never-written.nft')),
    ForbiddenRulesetError,
  );
});

test('nft: the word in a comment does not trip the refusal, and after a comment marker it does', async () => {
  // The tool path deliberately does not exist: the refusal must happen before anything is spawned,
  // so this test needs no nftables and no platform-specific binary.
  const controller = createNftController('/nonexistent/nft');

  // A mention in a comment is not a command: this gets past the refusal and then fails to spawn,
  // which is a different error and the point of the assertion.
  await assert.rejects(
    () => controller.check('# we never flush ruleset here\ntable inet wayfarer {}\n'),
    (error: unknown) => error instanceof Error && !(error instanceof ForbiddenRulesetError),
  );

  // A command hidden behind a comment marker on the same line is still a command.
  await assert.rejects(() => controller.check('table inet a {} # x\nflush ruleset # tidy up\n'), ForbiddenRulesetError);
});

test('exec: an empty argument is refused, because hostapd_cli hangs forever on one', async () => {
  await assert.rejects(() => run('/bin/echo', ['-i', '']), EmptyArgumentError);
  await assert.rejects(() => run('/bin/echo', ['   ']), EmptyArgumentError);
});

test('exec: a command that outruns its timeout is killed and reported', async () => {
  const result = await run('/bin/sh', ['-c', 'sleep 5'], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('exec: output is capped rather than allowed to exhaust memory', async () => {
  const result = await run('/bin/sh', ['-c', 'yes wayfarer | head -c 200000'], { maxOutputBytes: 4096 });
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 4096 + 1024);
});

test('unit health needs both active and enabled', () => {
  const activeOnly = normaliseUnitState('x.service', { ActiveState: 'active', UnitFileState: 'disabled' });
  const both = normaliseUnitState('x.service', { ActiveState: 'active', UnitFileState: 'enabled' });
  // Checking one is how a device works today and comes up without the service in the morning.
  assert.equal(unitIsHealthy(activeOnly), false);
  assert.equal(unitIsHealthy(both), true);
  // systemd returns an empty string for a unit with no unit file; empty is unknown, not a state.
  assert.equal(normaliseUnitState('x.service', { ActiveState: 'active', UnitFileState: '' }).unitFileState, null);
});

test('a unit that does not exist is not "known", even though systemd answers about it', () => {
  // Measured on the board: asking about a name that does not exist returns inactive/dead/not-found
  // rather than an error, so a check based on the active state calls every typo a stopped service.
  const absent = normaliseUnitState('definitely-not-a-unit.service', {
    ActiveState: 'inactive',
    SubState: 'dead',
    LoadState: 'not-found',
  });
  assert.equal(absent.known, false);

  const installedButStopped = normaliseUnitState('real.service', {
    ActiveState: 'inactive',
    SubState: 'dead',
    LoadState: 'loaded',
    UnitFileState: 'disabled',
  });
  // "Installed but not running" and "not installed" are different answers, and capability
  // reporting depends on the difference.
  assert.equal(installedButStopped.known, true);
});

test('passwords: scrypt parameters travel with the hash and verification is exact', async () => {
  const hash = await hashPassword('a-long-enough-password');
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('a-long-enough-password', hash), true);
  assert.equal(await verifyPassword('a-long-enough-passwore', hash), false);
  // A stored value that is not a hash of ours must fail rather than throw: a corrupted row should
  // lock the account, not crash the daemon on every login attempt.
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(await verifyPassword('anything', ''), false);
});

test('store: a fresh device is unconfigured and accepts no password at all', async () => {
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  const device = store.device();
  assert.equal(device.setupComplete, false);
  assert.equal(device.adminPasswordHash, '');
  assert.equal(device.apiEnabled, false);
  // The documented default is accepted by the API layer while the hash is empty; the store itself
  // verifies nothing, so a stored empty hash can never be matched by a submitted password.
  assert.equal(await store.verifyAdminPassword(''), false);
  assert.equal(await store.verifyAdminPassword('wayfarer'), false);
  database.close();
});

test('store: setting the password completes setup', async () => {
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  await store.setAdminPassword('a-new-long-password');
  assert.equal(store.device().setupComplete, true);
  assert.equal(await store.verifyAdminPassword('a-new-long-password'), true);
  database.close();
});

test('store: sessions expire on idle time and are revocable immediately', () => {
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  const stamp = { bootId: 'boot-a', uptimeSeconds: 1_000 };
  const session = store.createSession('test-agent', undefined, stamp);
  assert.equal(store.session(session.id, { stamp })?.session.id, session.id);

  // Revocation is a row deletion, which does not depend on a clock that can be days wrong after a
  // power cycle.
  store.deleteSession(session.id);
  assert.equal(store.session(session.id, { stamp }), null);

  // Idle past the limit, measured on the board's uptime within one boot. The wall clock is not
  // consulted: the `now` here is unchanged while the uptime has moved.
  const second = store.createSession(null, undefined, stamp);
  const muchLater = { bootId: 'boot-a', uptimeSeconds: 1_000 + SESSION_IDLE_SECONDS + 1 };
  assert.equal(store.session(second.id, { stamp: muchLater })?.verdict.kind, 'expired');
  database.close();
});

test('store: tokens are stored as hashes only and can expire', () => {
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  const created = store.createToken('automation', ['read', 'apply']);
  assert.equal(store.tokenBySecret(created.token)?.token.id, created.row.id);
  assert.equal(store.tokenBySecret('not-the-token'), null);

  const rows = database.raw.prepare('SELECT token_sha256 FROM api_tokens').all() as { token_sha256: string }[];
  // The value is shown once at creation and never stored.
  assert.ok(rows.every((row) => !row.token_sha256.includes(created.token)));

  /*
   * An absolute expiry is enforced only against a clock worth judging against. With `clockTrusted`
   * true, a past expiry is expired; with it false or unknown, the token is *unverifiable* and still
   * usable, because wrongly expiring a token locks the owner out of a device whose only management
   * surface may be its own access point. The opposite of the certificate rule, deliberately — see
   * core/credential-expiry.ts.
   */
  const expired = store.createToken('old', ['read'], new Date(Date.now() - 1000).toISOString());
  assert.equal(store.tokenBySecret(expired.token, { clockTrusted: true })?.verdict.kind, 'expired');
  assert.equal(store.tokenBySecret(expired.token, { clockTrusted: false })?.verdict.kind, 'unverifiable');
  assert.equal(store.tokenBySecret(expired.token, { clockTrusted: null })?.verdict.kind, 'unverifiable');

  // Revocation is not expiry: it is a row deletion and needs no clock at all.
  assert.equal(store.deleteToken(created.row.id), true);
  assert.equal(store.tokenBySecret(created.token), null);
  database.close();
});

test('store: the event ring is bounded and keeps the newest rows', () => {
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  for (let index = 0; index < 20; index += 1) {
    store.recordEvent({ level: 'info', kind: 'test', summary: `event ${index}` });
  }
  const events = store.events({ limit: 5 });
  assert.equal(events[0]!.summary, 'event 19');
  assert.ok(store.eventCount() <= EVENT_RING_SIZE);
  assert.equal(store.events({ kind: 'nothing-like-this' }).length, 0);
  database.close();
});

test('store: login failures are counted per source inside a window of uptime, not of wall clock', () => {
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  const boot = (uptimeSeconds: number) => ({ bootId: 'boot-a', uptimeSeconds });

  store.recordLoginAttempt('10.0.0.5', false, undefined, boot(100));
  store.recordLoginAttempt('10.0.0.5', false, undefined, boot(110));
  store.recordLoginAttempt('10.0.0.6', false, undefined, boot(120));
  store.recordLoginAttempt('10.0.0.5', true, undefined, boot(130));
  assert.equal(store.recentLoginFailures('10.0.0.5', 600, boot(140)), 2);
  assert.equal(store.recentLoginFailures('10.0.0.6', 600, boot(140)), 1);
  assert.equal(store.recentLoginFailures('10.0.0.7', 600, boot(140)), 0);

  // Outside the window by uptime.
  assert.equal(store.recentLoginFailures('10.0.0.5', 600, boot(1_000)), 0);

  /*
   * A different boot: the attempts' ages are unknown, so they take no part in the decision. This means
   * a reboot clears an in-progress lockout, which is a deliberate trade — nobody can reboot this device
   * without already holding the access a lockout protects, and treating undatable rows as recent would
   * lock a legitimate operator out of a device they may have no other way into. Recorded here so the
   * behaviour cannot be "fixed" without meeting the reasoning.
   */
  assert.equal(store.recentLoginFailures('10.0.0.5', 600, { bootId: 'boot-b', uptimeSeconds: 5 }), 0);

  // And with no stamp at all nothing can be dated, so nothing counts.
  assert.equal(store.recentLoginFailures('10.0.0.5', 600, null), 0);
  database.close();
});

test('store: login history is pruned by count, so no clock step can delete evidence', () => {
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);

  // Deliberately absurd timestamps, alternating far future and far past, which is what a stepping clock
  // produces. The previous implementation deleted rows whose `at` fell before a cutoff it computed from
  // the current clock, so a forward step wiped the history and reopened the lockout window.
  for (let index = 0; index < LOGIN_ATTEMPT_HISTORY + 20; index += 1) {
    const at = new Date(index % 2 === 0 ? Date.now() + 9e10 : Date.now() - 9e10);
    store.recordLoginAttempt('10.0.0.9', false, at, { bootId: 'boot-a', uptimeSeconds: 1_000 + index });
  }

  const remaining = database.raw.prepare('SELECT COUNT(*) AS n FROM login_attempts').get() as { n: number };
  assert.equal(remaining.n, LOGIN_ATTEMPT_HISTORY, 'kept by count and insertion order');

  // And the lockout still sees them, because the count never consulted a clock.
  assert.ok(store.recentLoginFailures('10.0.0.9', 600, { bootId: 'boot-a', uptimeSeconds: 1_000 + 219 }) > 0);
  database.close();
});

test('database: migrations apply once and refuse to downgrade', () => {
  const directory = tmpdir();
  const path = join(directory, `wayfarer-migrate-${Date.now()}.db`);
  const first = openDatabase({ path });
  const version = first.version();
  assert.ok(version >= 1);
  first.close();

  const second = openDatabase({ path });
  // Re-opening applies nothing: migrations are idempotent by version, not by inspection.
  assert.equal(second.version(), version);

  // A database written by a newer build must not be written to by an older one: that is how a
  // configuration is silently corrupted, and the update flow's answer is to roll the bundle
  // forward again.
  second.raw.exec('PRAGMA user_version = 9999;');
  second.close();
  assert.throws(() => openDatabase({ path }), /newer version of the daemon/);
});
