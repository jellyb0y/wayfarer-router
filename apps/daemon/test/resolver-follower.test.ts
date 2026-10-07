/**
 * The resolver follower, replayed against the incident it was rewritten for.
 *
 * Bench board, 2026-09-22 23:03 MSK: an apply wrote `/etc/wayfarer/core/config.json` naming
 * `10.184.40.5`; the tunnel that apply restarted came up ten seconds later and its up-script wrote
 * `10.184.48.5` to `/run/wayfarer/tunnel/hq.dns`. Ten hours later the configuration still named
 * `10.184.40.5`, and nothing had said a word. The code that should have followed lived in a closure
 * inside `main()`, which no test can reach; every outcome but success ended it.
 *
 * These tests use real files for both sides of the comparison — the capture directory and the core
 * configuration — and the shipped readers, so what is proved is the comparison the device makes, not
 * a stand-in's opinion of it. Only the apply is faked, as the one thing that writes the file.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { createResolverFollower, type FollowerEvent, type ResolverFollowerDeps } from '../src/core/resolver-follower.ts';
import { readConvergence } from '../src/core/resolver-convergence.ts';
import { readCapturedResolvers, watchCapturedResolvers } from '../src/platform/captured-resolvers.ts';
import { tunnelDnsTag } from '../src/core/generate/core-config.ts';
import { createObserverRegistry } from '../src/core/observers.ts';
import type { ApplyOutcome } from '../src/core/apply.ts';

function hqProfile(): ProfileDocument {
  const base = emptyProfile({ name: 'Bench', now: () => '2026-09-22T00:00:00.000Z' }) as ProfileDocument;
  return {
    ...base,
    tunnels: [
      {
        id: 'hq',
        name: 'HQ',
        role: 'resource',
        onUnavailable: 'block',
        enabled: true,
        protocol: 'openvpn',
        config: { profile: 'client\ndev tun\nremote hq.example.net 1194\n', interfaceSuffix: '0' },
        resources: { domainSuffix: ['.hq.lan'], ipCidr: [] },
        // The profile's value, the one a test fixture once set and nobody's peer hands out any more.
        dns: { server: '10.184.100.5', dynamic: true, domainSuffix: ['hq.lan'] },
      },
    ],
  } as ProfileDocument;
}

const coreConfigNaming = (address: string): string =>
  `${JSON.stringify({ dns: { servers: [{ tag: 'dns-remote', server: '1.1.1.1' }, { tag: tunnelDnsTag('hq'), server: address }] } }, null, 2)}\n`;

async function board(): Promise<{
  root: string;
  captureDir: string;
  corePath: string;
  capture: (address: string) => Promise<void>;
  deps: ResolverFollowerDeps;
  events: FollowerEvent[];
  lines: { level: string; message: string }[];
  applies: string[];
  open: { value: { id: string; state: string } | null };
  failApply: { value: boolean };
  observers: ReturnType<typeof createObserverRegistry>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-follower-'));
  const captureDir = join(root, 'run-tunnel');
  const corePath = join(root, 'config.json');
  await mkdir(captureDir, { recursive: true });
  const document = hqProfile();
  const events: FollowerEvent[] = [];
  const lines: { level: string; message: string }[] = [];
  const applies: string[] = [];
  const open = { value: null as { id: string; state: string } | null };
  const failApply = { value: false };
  const observers = createObserverRegistry();

  const capture = async (address: string): Promise<void> => {
    // The up-script's own way of writing: a temporary file and a rename.
    await writeFile(join(captureDir, '.hq.dns.tmp'), `${address}\n`, 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(join(captureDir, '.hq.dns.tmp'), join(captureDir, 'hq.dns'));
  };

  const deps: ResolverFollowerDeps = {
    document: () => document,
    profileId: () => 'p1',
    verify: async (doc) =>
      await readConvergence(doc, {
        captured: () => readCapturedResolvers(captureDir),
        coreConfig: () => readFile(corePath, 'utf8'),
      }),
    // The apply, reduced to its effect on this question: it re-plans with what is captured now and
    // writes the core configuration. Refusing while a window is open is `applyDocument`'s own rule.
    apply: async (): Promise<ApplyOutcome> => {
      if (open.value?.state === 'awaiting-confirm') {
        return {
          ok: false,
          error: { status: 409, code: 'confirmation_pending', message: `Transaction ${open.value.id} is inside its confirmation window`, hint: '' },
        };
      }
      if (failApply.value) {
        return { ok: false, error: { status: 422, code: 'invented_failure', message: 'the plan is not usable', hint: '' } };
      }
      const captured = (await readCapturedResolvers(captureDir)).get('hq') ?? '10.184.100.5';
      applies.push(captured);
      await writeFile(corePath, coreConfigNaming(captured), 'utf8');
      return {
        ok: true,
        transaction: { id: `t${String(applies.length)}`, state: 'committed', blastRadius: 'service', deadlineAt: null, secondsRemaining: null },
        result: { refused: [] } as never,
      };
    },
    openTransaction: () => open.value,
    record: (event) => events.push(event),
    log: (level, _fields, message) => lines.push({ level, message }),
    observer: observers.register({ name: 'resolver-follower', watches: 'captures against the core', everyMs: 60_000 }),
  };

  return { root, captureDir, corePath, capture, deps, events, lines, applies, open, failApply, observers };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(10);
  }
}

test('the incident: a capture that changes while an apply holds its window is applied once the window closes', async () => {
  const bench = await board();
  // 23:03:39 — the apply writes the configuration from the capture the *previous* connection left.
  await bench.capture('10.184.40.5');
  await writeFile(bench.corePath, coreConfigNaming('10.184.40.5'), 'utf8');
  assert.equal((await createResolverFollower(bench.deps).check('start-up')).kind, 'converged');

  const follower = createResolverFollower(bench.deps);
  // The apply that restarted the tunnel is still inside its window when the new peer pushes.
  bench.open.value = { id: 'operator-apply', state: 'awaiting-confirm' };
  // 23:03:49 — the new connection's capture.
  await bench.capture('10.184.48.5');

  const during = await follower.check('capture-changed');
  assert.equal(during.kind, 'deferred', 'an open window is waited for, not fought');
  assert.equal(bench.applies.length, 0);
  const deferred = bench.events.find((event) => event.kind === 'resolver.reconverge-deferred');
  assert.ok(deferred, 'the wait is said, not silent');
  assert.match(deferred.summary, /operator-apply/);
  assert.match(deferred.summary, /10\.184\.48\.5/);
  assert.ok(
    bench.lines.some((line) => /resolver/.test(line.message) || /re-deriving/.test(line.message)),
    'and it reaches the journal: `journalctl | grep resolver` found nothing on the board',
  );

  // **This is the step the old code never took.** The window closes; nobody touches the capture;
  // no file-system event will ever arrive. The next round looks again, because it looks every round.
  bench.open.value = null;
  const after = await follower.check('periodic');
  assert.equal(after.kind, 'attempted');
  assert.deepEqual(bench.applies, ['10.184.48.5']);
  assert.match(await readFile(bench.corePath, 'utf8'), /10\.184\.48\.5/);
  const reconverged = bench.events.find((event) => event.kind === 'resolver.reconverged');
  assert.ok(reconverged, `expected resolver.reconverged, got ${bench.events.map((event) => event.kind).join(', ')}`);
  assert.match(reconverged.summary, /hq -> 10\.184\.48\.5/);

  // And a round after that is quiet about it, but not silent to its observer.
  assert.equal((await follower.check('periodic')).kind, 'converged');
  const report = bench.observers.report().find((entry) => entry.name === 'resolver-follower');
  assert.match(report?.lastLooked?.what ?? '', /hq -> 10\.184\.48\.5/);
  assert.match(report?.lastActed?.what ?? '', /resolver\.reconverged/);
});

test('with no event at all, the periodic round alone converges — a missed notification is not a missed change', async () => {
  const bench = await board();
  await bench.capture('10.184.40.5');
  await writeFile(bench.corePath, coreConfigNaming('10.184.40.5'), 'utf8');
  const follower = createResolverFollower({ ...bench.deps, everyMs: 25 });
  follower.start();
  try {
    await bench.capture('10.184.48.5');
    // Nobody calls `check`. Only the round runs.
    await until(() => bench.applies.includes('10.184.48.5'));
    assert.match(await readFile(bench.corePath, 'utf8'), /10\.184\.48\.5/);
  } finally {
    follower.stop();
  }
});

test('a second change inside the minute is throttled and then applied, never dropped', async () => {
  const bench = await board();
  await writeFile(bench.corePath, coreConfigNaming('10.184.100.5'), 'utf8');
  const follower = createResolverFollower({ ...bench.deps, minApplyIntervalMs: 150, everyMs: 60_000 });
  follower.start();
  try {
    await bench.capture('10.184.40.5');
    assert.equal((await follower.check('capture-changed')).kind, 'attempted');
    await bench.capture('10.184.48.5');
    const second = await follower.check('capture-changed');
    assert.equal(second.kind, 'throttled');
    assert.ok(bench.events.some((event) => event.kind === 'resolver.change-throttled'));
    // The old code said "leaving it for now" and meant for ever. The retry is scheduled.
    await until(() => bench.applies.includes('10.184.48.5'));
    assert.match(await readFile(bench.corePath, 'utf8'), /10\.184\.48\.5/);
  } finally {
    follower.stop();
  }
});

test('a re-derive that failed is not retried every minute, and is retried at once when the divergence changes', async () => {
  const bench = await board();
  await writeFile(bench.corePath, coreConfigNaming('10.184.100.5'), 'utf8');
  await bench.capture('10.184.40.5');
  bench.failApply.value = true;
  const follower = createResolverFollower({ ...bench.deps, minApplyIntervalMs: 0 });

  const first = await follower.check('capture-changed');
  assert.equal(first.kind, 'attempted');
  assert.equal(first.kind === 'attempted' ? first.event.kind : '', 'resolver.reconverge-failed');
  // The same divergence, a round later: held, said once, and no second failed transaction — a device
  // that fails an apply every minute walks itself into safe mode.
  assert.equal((await follower.check('periodic')).kind, 'held');
  assert.equal((await follower.check('periodic')).kind, 'held');
  assert.equal(bench.events.filter((event) => event.kind === 'resolver.reconverge-held').length, 1);

  bench.failApply.value = false;
  await bench.capture('10.184.48.5');
  assert.equal((await follower.check('capture-changed')).kind, 'attempted');
  assert.deepEqual(bench.applies, ['10.184.48.5']);
});

test('overlapping rounds share one attempt, so the follower cannot open two applies against itself', async () => {
  const bench = await board();
  await writeFile(bench.corePath, coreConfigNaming('10.184.100.5'), 'utf8');
  await bench.capture('10.184.48.5');
  const follower = createResolverFollower(bench.deps);
  await Promise.all([follower.check('a'), follower.check('b'), follower.check('c')]);
  await sleep(50);
  assert.deepEqual(bench.applies, ['10.184.48.5']);
});

test('a transaction left "applying" by a crash does not block the follower for ever', async () => {
  const bench = await board();
  await writeFile(bench.corePath, coreConfigNaming('10.184.100.5'), 'utf8');
  await bench.capture('10.184.48.5');
  let now = 0;
  bench.open.value = { id: 'left-behind', state: 'applying' };
  const follower = createResolverFollower({ ...bench.deps, monotonicMs: () => now, abandonedAfterMs: 1000 });
  assert.equal((await follower.check('periodic')).kind, 'deferred');
  now = 2000;
  assert.equal((await follower.check('periodic')).kind, 'attempted');
});

test('an observer whose file-system watch could not be armed is a problem, and becomes ok when it arms', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-watch-'));
  const directory = join(root, 'not-yet');
  const observers = createObserverRegistry();
  const observer = observers.register({ name: 'resolver-watch', watches: directory, everyMs: null });
  const watch = watchCapturedResolvers(() => observer.looked('changed'), {
    directory,
    retryMs: 20,
    debounceMs: 5,
    onUnavailable: (reason) => observer.notRunning(reason),
    onWatching: () => observer.armed(),
  });
  try {
    const red = observers.report()[0]!;
    assert.equal(red.state, 'not-running');
    assert.match(red.problem ?? '', /not running/);
    assert.match(red.problem ?? '', /ENOENT/);

    await mkdir(directory);
    await until(() => observers.report()[0]!.state === 'ok');
    assert.equal(observers.report()[0]!.problem, null);
  } finally {
    watch.stop();
  }
});
