/**
 * The watchdog's decisions.
 *
 * The task's own note is the thing under test: latency alone is not enough, so a channel with a low
 * median and a wide spread must lose to a steadier, slower one.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { decideSelection, score, summarise } from '../src/core/health.ts';

const THRESHOLDS = { maxLatencyMs: 500, maxJitterMs: 250, maxLossPercent: 34 };

test('the median is used, so one outlier does not condemn a steady channel', () => {
  const health = summarise({ tunnelId: 't', latenciesMs: [40, 42, 45, 4000], attempted: 4 }, THRESHOLDS);
  assert.equal(health.medianMs, 43.5);
  // The mean would be over a second and would fail the latency threshold on one stalled probe.
  assert.ok(health.medianMs! < THRESHOLDS.maxLatencyMs);
});

test('a low median with a wide spread fails on jitter, which is the point of the task', () => {
  // 40, 60, 880, 900: median 470, inside the 500ms limit. Unusable, and only jitter notices.
  const health = summarise({ tunnelId: 't', latenciesMs: [40, 60, 880, 900], attempted: 4 }, THRESHOLDS);
  assert.ok(health.medianMs! <= THRESHOLDS.maxLatencyMs, 'the median passes');
  assert.equal(health.healthy, false);
  assert.ok(health.failed.some((reason) => reason.startsWith('jitter')), health.failed.join('; '));
});

test('a steady slower channel beats a fast erratic one', () => {
  const steady = summarise({ tunnelId: 'steady', latenciesMs: [180, 185, 190, 195], attempted: 4 }, THRESHOLDS);
  const erratic = summarise({ tunnelId: 'erratic', latenciesMs: [20, 25, 700, 800], attempted: 4 }, THRESHOLDS);
  assert.equal(steady.healthy, true);
  assert.equal(erratic.healthy, false, 'it fails outright, rather than merely scoring worse');
  assert.ok(score(steady) < score(erratic));
});

test('lost probes are counted, never recorded as a latency of zero', () => {
  // Two of four answered. A zero in a latency series is a measurement; a lost probe is not one.
  const health = summarise({ tunnelId: 't', latenciesMs: [50, 60], attempted: 4 }, THRESHOLDS);
  assert.equal(health.lossPercent, 50);
  assert.equal(health.medianMs, 55, 'the median is of what answered');
  assert.equal(health.healthy, false);
  assert.ok(health.failed.some((reason) => reason.startsWith('loss')));
});

test('loss alone condemns a tunnel whose answers were fast', () => {
  // Every answer inside every limit, and half of them never came.
  const health = summarise({ tunnelId: 't', latenciesMs: [10, 11], attempted: 4 }, THRESHOLDS);
  assert.equal(health.healthy, false);
  assert.deepEqual(health.failed, ['loss 50% over 34%']);
});

test('nothing answering is its own reason, not a latency failure', () => {
  const health = summarise({ tunnelId: 't', latenciesMs: [], attempted: 4 }, THRESHOLDS);
  assert.equal(health.medianMs, null);
  assert.equal(health.jitterMs, null);
  assert.equal(health.lossPercent, 100);
  assert.deepEqual(health.failed, ['nothing answered']);
});

test('an unhealthy tunnel is never chosen on score, however fast it answered', () => {
  const fastButLossy = summarise({ tunnelId: 't', latenciesMs: [5], attempted: 4 }, THRESHOLDS);
  assert.equal(score(fastButLossy), Number.POSITIVE_INFINITY);
});

/* ── choosing ────────────────────────────────────────────────────────────────────────────── */

const healthy = (id: string, ms: number) =>
  summarise({ tunnelId: id, latenciesMs: [ms, ms + 2, ms + 3, ms + 5], attempted: 4 }, THRESHOLDS);
const broken = (id: string) => summarise({ tunnelId: id, latenciesMs: [], attempted: 4 }, THRESHOLDS);

const base = {
  excluded: [] as string[],
  sticky: true,
  onAllDown: 'block' as const,
  failStreaks: {} as Record<string, number>,
  failStreak: 2,
};

test('the operator order beats a faster tunnel further down it', () => {
  /*
   * The list is a statement about which exit traffic should leave by — a jurisdiction, a paid line, a
   * corporate route. A watchdog that reordered it because a lower choice measured faster would substitute
   * its own judgement on a question measurement cannot answer.
   */
  const decision = decideSelection({
    ...base,
    priority: ['slow-but-wanted', 'fast'],
    health: [healthy('slow-but-wanted', 300), healthy('fast', 20)],
    current: null,
  });
  assert.equal(decision.select, 'slow-but-wanted');
});

test('the first healthy tunnel in the order is chosen when the preferred one is down', () => {
  const decision = decideSelection({
    ...base,
    priority: ['first', 'second'],
    health: [broken('first'), healthy('second', 90)],
    current: null,
  });
  assert.equal(decision.select, 'second');
  assert.equal(decision.change, true);
});

test('score decides only among tunnels the operator did not rank', () => {
  const decision = decideSelection({
    ...base,
    priority: ['ranked'],
    health: [broken('ranked'), healthy('unranked-slow', 400), healthy('unranked-fast', 40)],
    current: null,
  });
  assert.equal(decision.select, 'unranked-fast');
  assert.match(decision.reason, /best of the rest by latency, jitter and loss/);
});

test('an excluded tunnel is never selected, healthy or not', () => {
  const decision = decideSelection({
    ...base,
    excluded: ['parked'],
    priority: ['parked', 'other'],
    health: [healthy('parked', 10), healthy('other', 300)],
    current: null,
  });
  assert.equal(decision.select, 'other');
});

test('a healthy current choice is kept even when something better appears', () => {
  // Switching costs every live connection through the tunnel. A few milliseconds do not pay for that.
  const decision = decideSelection({
    ...base,
    priority: [],
    health: [healthy('current', 200), healthy('better', 20)],
    current: 'current',
  });
  assert.equal(decision.select, 'current');
  assert.equal(decision.change, false);
  assert.match(decision.reason, /the current choice is healthy/);
});

test('one bad round does not move anything; a streak does', () => {
  const failing = { ...base, priority: ['a', 'b'], health: [broken('a'), healthy('b', 50)], current: 'a' };

  const afterOne = decideSelection({ ...failing, failStreaks: { a: 1 } });
  assert.equal(afterOne.select, 'a', 'a single failed round is a bad sample');
  assert.equal(afterOne.change, false);
  assert.match(afterOne.reason, /2 in a row are needed/);

  const afterTwo = decideSelection({ ...failing, failStreaks: { a: 2 } });
  assert.equal(afterTwo.select, 'b');
  assert.equal(afterTwo.change, true);
});

test('stickiness off means the order is followed as soon as it can be', () => {
  const decision = decideSelection({
    ...base,
    sticky: false,
    priority: ['preferred', 'fallback'],
    health: [healthy('preferred', 300), healthy('fallback', 20)],
    current: 'fallback',
  });
  assert.equal(decision.select, 'preferred', 'it returns to the top of the order on recovery');
  assert.equal(decision.change, true);
});

test('nothing healthy falls back to the profile choice, and says what that costs', () => {
  const blocked = decideSelection({
    ...base,
    priority: ['a'],
    health: [broken('a')],
    current: 'a',
    failStreaks: { a: 5 },
  });
  assert.equal(blocked.select, 'block');
  assert.match(blocked.reason, /blocks rather than leaking traffic outside the tunnel/);

  const direct = decideSelection({
    ...base,
    onAllDown: 'direct',
    priority: ['a'],
    health: [broken('a')],
    current: 'a',
    failStreaks: { a: 5 },
  });
  assert.equal(direct.select, 'direct');
  assert.match(direct.reason, /send traffic direct rather than block it/);
});

test('every candidate is reported, so the event ring can say why', () => {
  const decision = decideSelection({
    ...base,
    priority: ['a'],
    excluded: ['c'],
    health: [healthy('a', 50), broken('b'), healthy('c', 10)],
    current: null,
  });
  assert.deepEqual(
    decision.considered.map((entry) => `${entry.tunnelId}:${entry.healthy ? 'ok' : 'bad'}${entry.excluded ? ':excluded' : ''}`),
    ['a:ok', 'b:bad', 'c:ok:excluded'],
  );
});

/* ── the way back out of the fallback ────────────────────────────────────────────────────── */

test('a healthy tunnel is taken immediately when the fallback is selected', () => {
  /*
   * The fallback was a one-way door, and this is the test that was missing.
   *
   * `block` and `direct` are not tunnels and are never probed, so `block` was never "healthy" and its
   * fail streak never advanced past zero. With `failStreak` at 2 the watchdog reported, every round,
   * "the current choice failed 0 round(s); 2 in a row are needed before switching" — and stayed on
   * `block` with a healthy tunnel sitting beside it. A device that fell back, or that came up before any
   * tunnel was healthy, would never have recovered by itself. Observed on the bench board 2026-09-21,
   * with the tunnel measuring 196 ms at the time.
   *
   * Stickiness protects a working tunnel from one bad sample. Applied to something that is not measured
   * it is not caution, it is a latch.
   */
  const decision = decideSelection({
    current: 'block',
    health: [{ tunnelId: 'hq', medianMs: 196, jitterMs: 4, lossPercent: 0, healthy: true, failed: [] }],
    priority: ['hq'],
    excluded: [],
    sticky: true,
    failStreak: 2,
    failStreaks: {},
    onAllDown: 'block',
  });
  assert.equal(decision.select, 'hq');
  assert.equal(decision.change, true);
});

test('the same holds for the fail-open fallback', () => {
  const decision = decideSelection({
    current: 'direct',
    health: [{ tunnelId: 'hq', medianMs: 120, jitterMs: 3, lossPercent: 0, healthy: true, failed: [] }],
    priority: [],
    excluded: [],
    sticky: true,
    failStreak: 3,
    failStreaks: {},
    onAllDown: 'direct',
  });
  assert.equal(decision.select, 'hq');
  assert.equal(decision.change, true);
});

test('a tunnel removed from the profile does not hold the selection either', () => {
  // Same cause: it is no longer measured, so no streak can accumulate against it.
  const decision = decideSelection({
    current: 'deleted-one',
    health: [{ tunnelId: 'hq', medianMs: 90, jitterMs: 2, lossPercent: 0, healthy: true, failed: [] }],
    priority: ['hq'],
    excluded: [],
    sticky: true,
    failStreak: 2,
    failStreaks: {},
    onAllDown: 'block',
  });
  assert.equal(decision.select, 'hq');
});

test('stickiness still protects a measured tunnel through a bad round', () => {
  // The behaviour the guard exists for, asserted beside the fix so narrowing it cannot go too far.
  const decision = decideSelection({
    current: 'hq',
    health: [
      { tunnelId: 'hq', medianMs: 900, jitterMs: 400, lossPercent: 50, healthy: false, failed: ['loss'] },
      { tunnelId: 'spare', medianMs: 100, jitterMs: 2, lossPercent: 0, healthy: true, failed: [] },
    ],
    priority: ['hq', 'spare'],
    excluded: [],
    sticky: true,
    failStreak: 2,
    failStreaks: { hq: 1 },
    onAllDown: 'block',
  });
  assert.equal(decision.select, 'hq', 'one bad round must not move traffic');
  assert.equal(decision.change, false);
});

test('and it gives way once the streak is met', () => {
  const decision = decideSelection({
    current: 'hq',
    health: [
      { tunnelId: 'hq', medianMs: 900, jitterMs: 400, lossPercent: 50, healthy: false, failed: ['loss'] },
      { tunnelId: 'spare', medianMs: 100, jitterMs: 2, lossPercent: 0, healthy: true, failed: [] },
    ],
    priority: ['hq', 'spare'],
    excluded: [],
    sticky: true,
    failStreak: 2,
    failStreaks: { hq: 2 },
    onAllDown: 'block',
  });
  assert.equal(decision.select, 'spare');
});
