/**
 * An observer must be able to go red, both ways it can die quietly.
 *
 * The resolver follower did nothing for ten hours on the bench board on 2026-09-22 and was
 * indistinguishable from one with nothing to do, because it spoke only when it acted. The shared shape
 * in `core/observers.ts` exists so that a watch that failed to arm and a loop that stopped going round
 * are each a *problem* on the Status screen. These tests prove each verdict can be reached — a check
 * that can only ever say "ok" is the shape this whole change is about.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createObserverRegistry, STALE_AFTER } from '../src/core/observers.ts';
import { createDriftMonitor } from '../src/core/drift.ts';
import type { Store } from '../src/state/store.ts';
import type { ProfileStore } from '../src/state/profiles.ts';
import type { PipelineContext } from '../src/core/pipeline.ts';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return { now: () => value, advance: (ms) => (value += ms) };
}

test('an observer that was never started is not running, and says what is therefore unwatched', () => {
  const observers = createObserverRegistry({ monotonicMs: clock().now });
  observers.register({ name: 'drift', watches: 'the files on this device', everyMs: 60_000 });
  const [report] = observers.report();
  assert.equal(report!.state, 'not-running');
  assert.match(report!.problem ?? '', /never started/);
  assert.match(report!.problem ?? '', /the files on this device/);
});

test('a watch that failed to arm is a problem carrying its reason, and arming clears it', () => {
  const observers = createObserverRegistry({ monotonicMs: clock().now });
  const handle = observers.register({ name: 'resolver-watch', watches: '/run/wayfarer/tunnel', everyMs: null });
  handle.notRunning("ENOENT: no such file or directory, watch '/run/wayfarer/tunnel'");
  let [report] = observers.report();
  assert.equal(report!.state, 'not-running');
  assert.match(report!.problem ?? '', /ENOENT/);

  handle.armed();
  [report] = observers.report();
  assert.equal(report!.state, 'ok');
  assert.equal(report!.problem, null);
});

test('an observer that has not looked within its own cadence is stale, and looking makes it ok again', () => {
  const time = clock();
  const observers = createObserverRegistry({ monotonicMs: time.now });
  const handle = observers.register({ name: 'resolver-follower', watches: 'captures', everyMs: 60_000 });
  handle.armed();
  handle.looked('every captured resolver is in use');
  assert.equal(observers.report()[0]!.state, 'ok');

  // Just inside the allowance: a round that took a moment longer than its interval is not stale.
  time.advance(60_000 * STALE_AFTER - 1);
  assert.equal(observers.report()[0]!.state, 'ok');

  time.advance(2);
  const stale = observers.report()[0]!;
  assert.equal(stale.state, 'stale');
  assert.match(stale.problem ?? '', /supposed to look every 60s/);

  handle.looked('again');
  assert.equal(observers.report()[0]!.state, 'ok');
});

test('a loop that was armed and never went round once goes stale — the timer-never-fired case', () => {
  const time = clock();
  const observers = createObserverRegistry({ monotonicMs: time.now });
  observers.register({ name: 'drift', watches: 'files', everyMs: 1_000 }).armed();
  time.advance(1_600);
  const report = observers.report()[0]!;
  assert.equal(report.state, 'stale');
  assert.match(report.problem ?? '', /looked once since it started/);
});

test('an observer woken only by events is never stale for being quiet', () => {
  const time = clock();
  const observers = createObserverRegistry({ monotonicMs: time.now });
  observers.register({ name: 'address-watch', watches: 'addresses', everyMs: null }).armed();
  time.advance(10 * 24 * 3_600_000);
  assert.equal(observers.report()[0]!.state, 'ok');
});

test('ages come from the monotonic clock: a wall clock stepping back by days changes nothing', () => {
  const time = clock();
  let wall = new Date('2026-09-23T00:00:00Z');
  const observers = createObserverRegistry({ monotonicMs: time.now, wallClock: () => wall });
  const handle = observers.register({ name: 'x', watches: 'y', everyMs: 60_000 });
  handle.armed();
  handle.looked('seen');
  handle.acted('did');
  // This board has no RTC battery: after a power cut the wall clock can be days behind.
  wall = new Date('2026-09-19T00:00:00Z');
  time.advance(30_000);
  const report = observers.report()[0]!;
  assert.equal(report.lastLooked?.ageSeconds, 30);
  assert.equal(report.lastActed?.ageSeconds, 30);
  assert.equal(report.state, 'ok');
  assert.equal(report.lastLooked?.at, '2026-09-23T00:00:00.000Z', 'the instant is for reading, kept as taken');
});

test('a cadence that is a setting is read when the report is made, and a setting that throws gives none', () => {
  const time = clock();
  let seconds = 30;
  const observers = createObserverRegistry({ monotonicMs: time.now });
  observers.register({ name: 'tunnel-watchdog', watches: 'tunnels', everyMs: () => seconds * 1000 }).armed();
  time.advance(50_000);
  assert.equal(observers.report()[0]!.state, 'stale');
  seconds = 60;
  assert.equal(observers.report()[0]!.state, 'ok');
  observers.register({
    name: 'broken',
    watches: 'z',
    everyMs: () => {
      throw new Error('profile unreadable');
    },
  }).armed();
  assert.equal(observers.report()[1]!.everySeconds, null);
});

test('the drift monitor reports into its observer: armed by start, a look per round, not running once stopped', async () => {
  const time = clock();
  const observers = createObserverRegistry({ monotonicMs: time.now });
  const observer = observers.register({ name: 'drift', watches: 'files', everyMs: 60_000 });
  const monitor = createDriftMonitor({
    // No active profile: the round is cheap and still a round.
    store: { device: () => ({ activeProfileId: null }), recordEvent: () => undefined } as unknown as Store,
    profiles: {} as ProfileStore,
    pipeline: {} as PipelineContext,
    monotonicMs: time.now,
    intervalMs: 60_000,
    observer,
  });

  assert.equal(observers.report()[0]!.state, 'not-running', 'before start nothing is scheduled, and it says so');
  monitor.start();
  await monitor.run('boot');
  let report = observers.report()[0]!;
  assert.equal(report.state, 'ok');
  assert.match(report.lastLooked?.what ?? '', /no profile is active/);
  assert.match(report.lastActed?.what ?? '', /config\.no-profile/);

  monitor.stop();
  report = observers.report()[0]!;
  assert.equal(report.state, 'not-running');
  assert.match(report.problem ?? '', /stopped/);
});
