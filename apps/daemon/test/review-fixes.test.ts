/**
 * Tests for the failure modes found in review. Each one is written against the behaviour that
 * matters rather than the shape of the code, because in every case the wrong behaviour looked
 * entirely reasonable in the diff.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createListenerSet, type AddressReading, type ListenerHost } from '../src/api/listeners.ts';
import { writeAtomic } from '../src/platform/files.ts';
import { openDatabase } from '../src/state/db.ts';
import { createStore, SESSION_IDLE_SECONDS } from '../src/state/store.ts';
import { parseIpRoutes, defaultRoute } from '../src/platform/parse/ip-json.ts';
import { run } from '../src/platform/exec.ts';

function recordingHost(): ListenerHost & { started: string[]; stopped: string[]; fail: Set<string> } {
  const started: string[] = [];
  const stopped: string[] = [];
  const fail = new Set<string>();
  return {
    started,
    stopped,
    fail,
    async start(address) {
      if (fail.has(address)) return { ok: false, error: 'EADDRNOTAVAIL' };
      started.push(address);
      return { ok: true };
    },
    stop(address) {
      stopped.push(address);
    },
  };
}

const LISTEN = { port: 8088, addresses: ['127.0.0.1'], interfaces: ['ap0'] };

test('listeners: a failed address read never closes a listener', async () => {
  const host = recordingHost();
  const listeners = createListenerSet({ listen: LISTEN, host });

  const good: AddressReading = { ok: true, addresses: [{ name: 'ap0', address: '10.44.0.1', family: 'inet' }] };
  await listeners.reconcile(good);
  assert.deepEqual(listeners.addresses().sort(), ['10.44.0.1', '127.0.0.1']);

  // This is the whole point: the read failed, so nothing is known — and the interface the operator
  // is connected through must not be torn down on a guess.
  const failure = await listeners.reconcile({ ok: false, error: 'ip -j exited 1' });
  assert.equal(failure.teardownSkipped, true);
  assert.deepEqual(failure.closed, []);
  assert.deepEqual(host.stopped, []);
  assert.deepEqual(listeners.addresses().sort(), ['10.44.0.1', '127.0.0.1']);

  // And an address that really went away is still gone at the next successful read, so waiting cost
  // nothing.
  const gone = await listeners.reconcile({ ok: true, addresses: [] });
  assert.deepEqual(gone.closed, ['10.44.0.1']);
  assert.deepEqual(host.stopped, ['10.44.0.1']);
  assert.deepEqual(listeners.addresses(), ['127.0.0.1']);
});

test('listeners: a failed read still brings up the literal addresses, which do not depend on it', async () => {
  const host = recordingHost();
  const listeners = createListenerSet({ listen: LISTEN, host });
  const result = await listeners.reconcile({ ok: false, error: 'no netlink' });
  // A daemon that has never managed to read the address table must at least answer on loopback.
  assert.deepEqual(result.bound, ['127.0.0.1']);
  assert.equal(result.teardownSkipped, true);
});

test('listeners: an address that fails to bind is reported and not counted as bound', async () => {
  const host = recordingHost();
  host.fail.add('10.44.0.1');
  const listeners = createListenerSet({ listen: LISTEN, host });
  const result = await listeners.reconcile({
    ok: true,
    addresses: [{ name: 'ap0', address: '10.44.0.1', family: 'inet' }],
  });
  assert.deepEqual(result.failed, [{ address: '10.44.0.1', error: 'EADDRNOTAVAIL' }]);
  assert.deepEqual(result.bound, ['127.0.0.1']);
});

test('listeners: an interface with no address is unresolved, and that is not an absence to act on', async () => {
  const host = recordingHost();
  const listeners = createListenerSet({ listen: LISTEN, host });
  const result = await listeners.reconcile({
    ok: true,
    addresses: [{ name: 'wan0', address: '192.168.1.5', family: 'inet' }],
  });
  assert.deepEqual(result.unresolved, ['ap0']);
  // The uplink's address is never bound: it is not named in the configuration.
  assert.deepEqual(result.bound, ['127.0.0.1']);
});

test('writeAtomic: a wrong owner is corrected, not reported as unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-own-'));
  const target = join(directory, 'managed.conf');
  await writeAtomic(target, 'content\n', { mode: 0o640 });

  const info = await stat(target);
  // Asking for the ownership the file already has is genuinely no change.
  const same = await writeAtomic(target, 'content\n', { mode: 0o640, uid: info.uid, gid: info.gid });
  assert.equal(same.changed, false);

  // Asking for a different owner is a change even when the bytes match. Without this, the only
  // sanctioned write path cannot correct an owner, and a file its consumer cannot read stays
  // unreadable through any number of re-applies.
  const differentGid = info.gid === 0 ? 1 : 0;
  let corrected: { changed: boolean };
  try {
    corrected = await writeAtomic(target, 'content\n', { mode: 0o640, uid: info.uid, gid: differentGid });
  } catch (error) {
    // An unprivileged test runner cannot chown; the decision to write is what is under test, and it
    // has already been made by the time chown throws.
    assert.match(String(error), /EPERM|EINVAL/);
    return;
  }
  assert.equal(corrected.changed, true);
  assert.equal((await stat(target)).gid, differentGid);
});

test('writeAtomic: a mode change alone is still a change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wayfarer-mode-'));
  const target = join(directory, 'managed.conf');
  await writeAtomic(target, 'x\n', { mode: 0o644 });
  assert.equal((await writeAtomic(target, 'x\n', { mode: 0o600 })).changed, true);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test('sessions: an expired session is deleted when it is looked up', () => {
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  const stamp = { bootId: 'boot-a', uptimeSeconds: 1_000 };
  const session = store.createSession(null, undefined, stamp);

  const idle = { bootId: 'boot-a', uptimeSeconds: 1_000 + SESSION_IDLE_SECONDS + 1 };
  assert.equal(store.session(session.id, { stamp: idle })?.verdict.kind, 'expired');

  // Not merely reported as invalid: gone. On a device that runs for months, "expired" and "removed"
  // have to be the same thing or the table only grows.
  const rows = database.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  assert.equal(rows.n, 0);
  database.close();
});

test('sessions: the sweep judges idle time, by the same rule as the request path', () => {
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  const stamp = { bootId: 'boot-a', uptimeSeconds: 1_000 };
  const live = store.createSession(null, undefined, stamp);

  // A row from an earlier boot: its age is unknown, so it is NOT swept. The request path re-anchors it
  // instead of retiring it, and the sweep must not disagree with the request path about the same row.
  database.raw
    .prepare(
      `INSERT INTO sessions (id, created_at, expires_at, last_seen_at, user_agent, boot_id,
                             last_seen_uptime_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('other-boot', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z', '2020-01-01T00:00:00.000Z', null, 'boot-old', 9_000);

  assert.equal(store.sweepIdleSessions({ stamp }), 0, 'nothing is idle yet, and an unknown age is not idle');

  // Now move the uptime past the idle limit. The live session goes; the one from another boot stays.
  const idle = { bootId: 'boot-a', uptimeSeconds: 1_000 + SESSION_IDLE_SECONDS + 1 };
  assert.equal(store.sweepIdleSessions({ stamp: idle }), 1);
  assert.equal(store.session(live.id, { stamp: idle }), null);
  assert.ok(store.session('other-boot', { stamp: idle }));
  database.close();
});

test('sessions: the sweep honours the open-window exemption the request path honours', () => {
  /*
   * The defect this replaces, and it is the one the exemption was written to prevent, appearing at the other
   * door: the per-request check honoured the open window and the raw `DELETE` did not.
   *
   * The trigger is the designed path rather than bad luck. The apply restarts the time service, so a
   * forward jump of days inside the window is expected on this board — and the old sweep deleted every
   * session created before the resync, refusing the operator inside their own countdown. If the re-login
   * lost the race, the change they were about to keep was reverted.
   */
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  const stamp = { bootId: 'boot-a', uptimeSeconds: 1_000 };
  const session = store.createSession(null, undefined, stamp);
  const idle = { bootId: 'boot-a', uptimeSeconds: 1_000 + SESSION_IDLE_SECONDS + 1 };

  assert.equal(
    store.sweepIdleSessions({ stamp: idle, holdsOpenWindow: (id) => id === session.id }),
    0,
    'a session holding an open confirmation window is never swept',
  );
  assert.ok(store.session(session.id, { stamp: idle, holdsOpenWindow: (id) => id === session.id }));

  // And it goes as soon as the window is not its own.
  assert.equal(store.sweepIdleSessions({ stamp: idle, holdsOpenWindow: () => false }), 1);
  database.close();
});

test('sessions: with no stamp the sweep removes nothing', () => {
  // "I could not read the clock I judge by" is not evidence that a session is stale.
  const database = openDatabase({ path: ':memory:' });
  const store = createStore(database);
  store.createSession(null, undefined, { bootId: 'boot-a', uptimeSeconds: 1 });
  assert.equal(store.sweepIdleSessions({ stamp: null }), 0);
  assert.equal(store.sweepIdleSessions(), 0);
  database.close();
});

test('sessions: no authorisation path reads the absolute expiry', async () => {
  /*
   * `expires_at` is descriptive now. It is kept because a row saying when a session was created and what
   * life it was given is worth having in an incident — but an unread stored value that *looks* like a
   * control is exactly how the sweep came to enforce a model the request path had abandoned. So the fact
   * that nothing reads it is asserted rather than trusted.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (const file of ['state/store.ts', 'core/credential-expiry.ts', 'api/server.ts']) {
    const text = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8');
    const code = text
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .join('\n');
    assert.ok(
      !/expires_at\s*<=|expires_at\s*<|WHERE expires_at/.test(code),
      `${file} still judges a session by its absolute expiry`,
    );
  }
});

test('routes: the family comes from the command that was run, and the filter is real', () => {
  const v4 = parseIpRoutes(
    JSON.stringify([
      { dst: 'default', gateway: '192.168.1.1', dev: 'wan0', metric: 600 },
      { dst: '10.44.0.0/24', dev: 'ap0' },
    ]),
    'inet',
  );
  const v6 = parseIpRoutes(JSON.stringify([{ dst: 'default', gateway: 'fe80::1', dev: 'wan0', metric: 1024 }]), 'inet6');

  assert.equal(v4[0]!.family, 'inet');
  assert.equal(v6[0]!.family, 'inet6');

  const both = [...v4, ...v6];
  assert.equal(defaultRoute(both, 'inet')?.gateway, '192.168.1.1');
  assert.equal(defaultRoute(both, 'inet6')?.gateway, 'fe80::1');
  // The earlier version asked whether the string 'default' contained a colon, so the argument did
  // nothing and the IPv6 route was returned for both families.
  assert.notEqual(defaultRoute(both, 'inet')?.gateway, defaultRoute(both, 'inet6')?.gateway);
  assert.equal(defaultRoute(v4, 'inet6'), null);
});

test('routes: lowest metric wins within a family', () => {
  const routes = parseIpRoutes(
    JSON.stringify([
      { dst: 'default', gateway: '10.0.0.1', dev: 'wan1', metric: 700 },
      { dst: 'default', gateway: '192.168.1.1', dev: 'wan0', metric: 100 },
    ]),
    'inet',
  );
  assert.equal(defaultRoute(routes)?.gateway, '192.168.1.1');
});

test('exec: the output cap counts bytes, not UTF-16 code units', async () => {
  // Four bytes per character in UTF-8, two code units in UTF-16: a cap applied to string length
  // lets this occupy roughly twice the intended budget, and on a 2 GB board the cap exists to bound
  // exactly the output nobody controls.
  //
  // The data is piped through `cat` rather than generated by a shell loop: a loop spawning
  // thousands of `printf` calls is at the mercy of whatever else the test runner is doing, and a
  // test that fails only when the machine is busy teaches people to re-run tests.
  const payload = '\u{1F6B0}'.repeat(2000);
  assert.equal(Buffer.byteLength(payload, 'utf8'), 8000);
  assert.equal(payload.length, 4000, 'the string is shorter in code units than in bytes, which is the point');

  const result = await run('/bin/cat', [], { stdin: payload, maxOutputBytes: 1024 });
  const kept = Buffer.byteLength(result.stdout, 'utf8');
  assert.equal(result.truncated, true, `kept ${kept} bytes, exit ${String(result.code)}, stderr ${result.stderr}`);
  assert.ok(kept <= 1024, `kept ${kept} bytes, cap was 1024`);
});

test('exec: multi-byte output that fits is not mangled at a chunk boundary', async () => {
  const result = await run('/bin/sh', ['-c', 'printf "καλημέρα κόσμε\\n"'], { maxOutputBytes: 4096 });
  assert.equal(result.truncated, false);
  assert.equal(result.stdout.trim(), 'καλημέρα κόσμε');
});

test('journal paging: consecutive pages are contiguous, with more entries than fit in one', async () => {
  // The stand-in emits 20 entries and reproduces the real tool's tail-anchoring for `-n`, so a
  // regression to `--after-cursor X -n N` fails here rather than on a device.
  const { createJournalReader } = await import('../src/platform/journal-reader.ts');
  const reader = createJournalReader(join(import.meta.dirname, 'fixtures', 'bin', 'fake-journalctl'));

  const first = await reader.read({ limit: 5 });
  // The first page is the newest entries, which is what a fresh view wants.
  assert.deepEqual(
    first.entries.map((entry) => entry.message),
    ['entry 016', 'entry 017', 'entry 018', 'entry 019', 'entry 020'],
  );
  assert.equal(first.hasMore, true, 'older entries exist, and that must be a fact rather than a guess');

  // Paging forward from an early cursor must walk the run in order with no gap. The old code asked
  // journalctl for the newest N after the cursor, which silently skipped everything between.
  let cursor = 'c003';
  const walked: string[] = [];
  for (let page = 0; page < 4; page += 1) {
    const result = await reader.read({ limit: 4, afterCursor: cursor });
    walked.push(...result.entries.map((entry) => entry.message));
    if (result.entries.length === 0) break;
    cursor = result.entries[result.entries.length - 1]!.cursor!;
  }
  assert.deepEqual(walked, Array.from({ length: 16 }, (_, index) => `entry ${String(index + 4).padStart(3, '0')}`));
});

test('journal paging: the last page says there is nothing more', async () => {
  const { createJournalReader } = await import('../src/platform/journal-reader.ts');
  const reader = createJournalReader(join(import.meta.dirname, 'fixtures', 'bin', 'fake-journalctl'));

  const full = await reader.read({ limit: 4, afterCursor: 'c016' });
  assert.deepEqual(
    full.entries.map((entry) => entry.message),
    ['entry 017', 'entry 018', 'entry 019', 'entry 020'],
  );
  // A page that came out exactly full with nothing behind it is the end of the log, and it must not
  // look like a paging obligation.
  assert.equal(full.hasMore, false);
  assert.equal((await reader.read({ limit: 4, afterCursor: 'c020' })).entries.length, 0);
});

test('journal paging: a read cut short by its own timeout is reported as incomplete, not as a full page', async () => {
  const { createJournalReader } = await import('../src/platform/journal-reader.ts');
  // The stand-in emits two entries and then goes quiet without exiting: the shape of a slow read on
  // a busy board or behind a heavy filter.
  const reader = createJournalReader(join(import.meta.dirname, 'fixtures', 'bin', 'fake-journalctl-slow'), 400);

  const result = await reader.read({ limit: 10, afterCursor: 'c000' });
  assert.equal(result.entries.length, 2);
  // Both facts have to reach the caller. `hasMore` alone would say "keep paging"; `incomplete` is
  // what says the lines between here and the next page are missing and no cursor will reveal them.
  assert.equal(result.incomplete, true);
  assert.equal(result.hasMore, true);
  assert.match(result.incompleteReason ?? '', /stopped after/);
});

test('journal paging: a complete page is not marked incomplete', async () => {
  const { createJournalReader } = await import('../src/platform/journal-reader.ts');
  const reader = createJournalReader(join(import.meta.dirname, 'fixtures', 'bin', 'fake-journalctl'), 5000);
  const result = await reader.read({ limit: 4, afterCursor: 'c016' });
  assert.equal(result.incomplete, false);
  assert.equal(result.incompleteReason, null);
  assert.equal(result.hasMore, false);
});

test('bounded line reads report one outcome, so a caller cannot read "more" while ignoring "cut short"', async () => {
  const { runLines } = await import('../src/platform/exec.ts');

  const complete = await runLines('/bin/sh', ['-c', 'printf "a\\nb\\n"'], { maxLines: 10, timeoutMs: 2000 });
  assert.equal(complete.kind, 'complete');

  const more = await runLines('/bin/sh', ['-c', 'printf "a\\nb\\nc\\n"'], { maxLines: 2, timeoutMs: 2000 });
  assert.equal(more.kind, 'more');
  assert.deepEqual(more.lines, ['a', 'b']);

  const cutShort = await runLines('/bin/sh', ['-c', 'printf "a\\n"; sleep 5'], { maxLines: 10, timeoutMs: 300 });
  assert.equal(cutShort.kind, 'cut-short');
  assert.deepEqual(cutShort.lines, ['a']);
  // The union is the point: there is no boolean to read on its own, and a new ending would force
  // every caller through the compiler.
  assert.equal(cutShort.kind === 'cut-short' ? cutShort.reason : null, 'timeout');
});

test('telemetry: a poll that arrives while one is running is skipped and counted, not stacked', async () => {
  const { createTelemetry } = await import('../src/telemetry/index.ts');

  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const slowPlatform = {
    net: { watch: () => ({ stop: () => undefined }), snapshot: async () => ({ links: [], addresses: [], routes: [], at: Date.now() }), addresses: async () => [] },
    systemd: {
      watch: async () => ({ stop: () => undefined }),
      state: async (unit: string) => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 120));
        inFlight -= 1;
        return { unit, activeState: 'active', subState: 'running', unitFileState: 'enabled', loadState: 'loaded', isActive: true, isEnabled: true, known: true };
      },
    },
    ap: { watch: () => ({ stop: () => undefined }), status: async () => null, stations: async () => ({ complete: true, stations: [], iterated: false }) },
    wifi: { link: async () => ({ connected: false }) },
    clock: { status: async () => ({ timezone: null, ntpEnabled: null, synchronized: null, localRtc: null, timeUsec: null, rtcTimeUsec: null }) },
  } as unknown as Parameters<typeof createTelemetry>[0];

  const telemetry = createTelemetry(slowPlatform);
  telemetry.watchUnits(['slow.service']);
  // A poll costs 120 ms and the interval is 10 ms: a fixed-rate timer would start a new round four
  // times before the first finished, and each round walks child processes and D-Bus calls. On a
  // 2 GB board that ends with the daemon killed by its own memory limit, which looks like a leak.
  const stop = await telemetry.start({ pollIntervalMs: 10, coalesceMs: 5 });

  const asked = await Promise.all([telemetry.pollNow(), telemetry.pollNow(), telemetry.pollNow()]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await stop();

  // At most one poll in flight at any moment, whatever the interval.
  assert.equal(maxInFlight, 1, `${maxInFlight} polls overlapped`);
  // Concurrent requests are refused rather than queued, and the refusal is visible.
  assert.ok(asked.includes(false), 'a concurrent pollNow should have been skipped');
  const poller = telemetry.snapshot().poller;
  assert.ok(poller.skipped >= 1, `skips were not recorded (${JSON.stringify(poller)})`);
  assert.ok(poller.polls >= 1);
  assert.ok((poller.lastDurationMs ?? 0) >= 100, 'the poll duration should be recorded');
  // With the interval measured from the end of a poll, the number of polls is bounded by the work,
  // not by the tick rate: 400 ms of wall time over a 120 ms poll is a handful, not forty.
  assert.ok(calls <= 6, `${calls} polls ran in 400 ms, which means they were stacking`);
});
