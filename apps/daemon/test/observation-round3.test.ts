/**
 * Round three of the observation fixes, from the on-device re-check of 2026-09-23.
 *
 * Each test builds the observer **through the function `index.ts` calls**, not an observer of its own.
 * Round two's tests did the latter and passed while the device was wrong: they built a watch and a
 * registry by hand, asserted only `ok` / `not-running`, and gave the resolver watch no cadence — so an
 * observer that never recorded a look could never read stale, and no test asked whether it had looked.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createObserverRegistry } from '../src/core/observers.ts';
import { observeCapturedResolvers } from '../src/core/resolver-watch.ts';
import { createWatchdog, observeWatchdog, watchdogReading, type GuardOutcome, type RoundOutcome } from '../src/core/watchdog.ts';
import type { CoreApi } from '../src/platform/core-api.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(5);
  }
}

/** Every reading gets a distinct instant, so "the last look moved" is observable without sleeping seconds. */
function ticking(): () => Date {
  let n = 0;
  return () => new Date(Date.UTC(2026, 8, 23, 22, 0, 0) + (n += 1) * 1000);
}

/* ── 1. the resolver watch looks on every check, with no capture changing ───────────────── */

test('with no capture changing, the resolver watch records a look on every check, saying what it saw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-watchlook-'));
  const directory = join(root, 'tunnel');
  await mkdir(directory);
  const observers = createObserverRegistry({ wallClock: ticking() });
  const watch = observeCapturedResolvers({ observers, directory, checkMs: 40, onCapture: () => undefined });
  try {
    const report = () => observers.report().find((entry) => entry.name === 'resolver-watch')!;
    // The device: `null` for eighteen minutes after start-up. Here: a look from the moment it arms.
    assert.notEqual(report().lastLooked, null, 'arming the watch is itself a look');
    assert.notEqual(report().everySeconds, null, 'a cadence, or an observer that never looks can never be stale');

    const first = report().lastLooked!.at;
    await until(() => report().lastLooked!.at !== first);
    assert.match(report().lastLooked!.what, /the watch is on the directory at the path \(inode \d+\)/);
    const second = report().lastLooked!.at;
    await until(() => report().lastLooked!.at !== second);
    assert.equal(report().state, 'ok');
  } finally {
    watch.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a directory that is not there yet is a look that says so, every retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-watchabsent-'));
  const observers = createObserverRegistry({ wallClock: ticking() });
  const watch = observeCapturedResolvers({ observers, directory: join(root, 'absent'), checkMs: 40, onCapture: () => undefined });
  try {
    const report = () => observers.report().find((entry) => entry.name === 'resolver-watch')!;
    assert.equal(report().state, 'not-running');
    assert.match(report().lastLooked?.what ?? '', /cannot be watched yet/);
    const first = report().lastLooked!.at;
    await until(() => report().lastLooked!.at !== first);
  } finally {
    watch.stop();
    await rm(root, { recursive: true, force: true });
  }
});

/* ── 2. four guards, long notes, all four shown ─────────────────────────────────────────── */

const LONG =
  "the time since the peer last sent anything is not known yet: this is the first reading of its counter; its peer has pushed no gateway since this device started, so there is nothing to echo";

test('a reading of four guards with long notes names all four, and carries each one whole', () => {
  const guards: GuardOutcome[] = ['hq', 'partner', 'lab', 'home'].map((tunnelId, index) => ({
    tunnelId,
    selector: `g-${tunnelId}`,
    onUnavailable: 'block' as const,
    liveness:
      index === 1
        ? { state: 'dead' as const, basis: 'keepalive' as const, why: 'nothing has arrived from the peer for at least 90 s' }
        : { state: 'unmeasurable' as const, basis: 'none' as const, why: LONG },
    streak: index === 1 ? 3 : 0,
    action: index === 1 ? 'its traffic is NOT being blocked by the guard' : 'nothing: the guard reports and never blocks',
    changed: false,
    blocked: false,
  }));
  const outcome: RoundOutcome = { health: [], selected: null, changed: false, reason: 'no tunnel to probe', guards };
  const reading = watchdogReading(outcome);
  for (const id of ['hq', 'partner', 'lab', 'home']) assert.match(reading.saw, new RegExp(`${id} `));
  assert.ok(reading.saw.length <= 300, `the summary must fit the observer's summary bound: ${String(reading.saw.length)}`);

  const observers = createObserverRegistry();
  const handle = observers.register({ name: 'tunnel-watchdog', watches: 'tunnels', everyMs: 30_000 });
  handle.armed();
  const observation = observeWatchdog(handle);
  observation.onRound(outcome);
  const looked = observers.report()[0]!.lastLooked!;
  assert.deepEqual(looked.items?.map((item) => item.subject), ['hq', 'partner', 'lab', 'home']);
  assert.equal(looked.items?.[3]?.note, LONG, 'the fourth guard, whole');
  assert.equal(observers.report()[0]!.state, 'failing');
});

/* ── 3. a round slower than the interval is a working observer, not a dead one ──────────── */

test("a round slower than its interval still reads as looking, because the round's start is a look", async () => {
  let now = 0;
  const observers = createObserverRegistry({ monotonicMs: () => now });
  const handle = observers.register({ name: 'tunnel-watchdog', watches: 'tunnels', everyMs: 100 });
  handle.armed();
  const observation = observeWatchdog(handle);
  // The previous round ended at 0.
  observation.onRound({ health: [], selected: null, changed: false, reason: 'no tunnel to probe' });

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let probing = false;
  const core = {
    available: async () => true,
    proxies: async () => [{ name: 'wf-selector', type: 'Selector', now: 'a', all: ['a', 'block'] }],
    delay: async () => {
      probing = true;
      await gate; // A probe to an address that does not answer.
      return null;
    },
    select: async () => ({ ok: true, message: '' }),
  } as unknown as CoreApi;
  const watchdog = createWatchdog({
    core,
    selector: 'wf-selector',
    candidates: async () => ['a'],
    guards: async () => [],
    policy: () => ({
      priority: ['a'],
      excluded: [],
      sticky: false,
      onAllDown: 'block',
      probes: {
        count: 1,
        failStreak: 3,
        endpoints: ['http://x.invalid/'],
        intervalSeconds: 3600,
        maxLatencyMs: 500,
        maxJitterMs: 200,
        maxLossPercent: 34,
      },
    }),
    record: (event) => observation.recorded(event),
    log: () => undefined,
    onRoundStart: () => observation.onRoundStart(),
    onRound: (outcome) => observation.onRound(outcome),
  });

  now = 100; // one interval after the last round ended, the next one starts
  const running = watchdog.start(3600);
  try {
    await until(() => probing);
    now = 220; // 120 into a round that is still probing: longer than the interval
    const during = observers.report()[0]!;
    assert.equal(during.state, 'ok', `a slow round read as ${during.state}: ${during.problem ?? ''}`);
    assert.match(during.lastLooked?.what ?? '', /a round is probing/);

    now = 400; // and a round that never ends does still go stale
    assert.equal(observers.report()[0]!.state, 'stale');
  } finally {
    release();
    running.stop();
  }
});
