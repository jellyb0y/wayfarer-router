/**
 * The watchdog loop: what it records, what it refuses to decide, and where it reads the truth from.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createWatchdog, type WatchdogPolicy } from '../src/core/watchdog.ts';
import type { CoreApi } from '../src/platform/core-api.ts';

const POLICY: WatchdogPolicy = {
  priority: ['a', 'b'],
  excluded: [],
  sticky: true,
  onAllDown: 'block',
  probes: {
    count: 4,
    failStreak: 2,
    maxLatencyMs: 500,
    maxJitterMs: 250,
    maxLossPercent: 34,
    endpoints: ['http://one.invalid/204', 'http://two.invalid/204'],
    // Generous, so the existing tests measure decisions rather than the round budget. The budget has its
    // own test below, which sets it deliberately low.
    intervalSeconds: 3600,
  },
};

function harness(options: {
  available?: boolean;
  delays: Record<string, (number | null)[]>;
  now?: string | null;
  selectOk?: boolean;
  policy?: Partial<WatchdogPolicy>;
  /** Makes each probe take real time, so the round budget can be exercised. */
  probeCostMs?: number;
}) {
  const events: { kind: string; summary: string }[] = [];
  const selected: string[] = [];
  const asked: { outbound: string; url: string }[] = [];
  const cursor: Record<string, number> = {};
  let now = options.now ?? null;

  const core: CoreApi = {
    available: async () => options.available !== false,
    proxies: async () => [{ name: 'wf-selector', type: 'Selector', now, all: ['a', 'b', 'block'] }],
    delay: async (outbound, url) => {
      asked.push({ outbound, url });
      if (options.probeCostMs) await new Promise((resolve) => setTimeout(resolve, options.probeCostMs));
      const series = options.delays[outbound] ?? [];
      const index = cursor[outbound] ?? 0;
      cursor[outbound] = index + 1;
      /*
       * Bounds-checked rather than `??`-chained, because a deliberate `null` in the series means "this
       * probe was lost" and `??` treats it as "past the end" — so a series beginning with four nulls
       * silently returned the last element instead, and the round that was supposed to fail passed. A
       * test double that cannot express a lost probe cannot test a watchdog.
       */
      if (index < series.length) return series[index]!;
      return series.length === 0 ? null : series[series.length - 1]!;
    },
    select: async (_selector, member) => {
      if (options.selectOk === false) return { ok: false, message: '500: no' };
      selected.push(member);
      now = member;
      return { ok: true, message: `selected ${member}` };
    },
  };

  const watchdog = createWatchdog({
    core,
    selector: 'wf-selector',
    candidates: async () => Object.keys(options.delays),
    guards: async () => [],
    policy: () => ({ ...POLICY, ...options.policy }),
    record: (event) => events.push({ kind: event.kind, summary: event.summary }),
    log: () => {},
  });

  return { watchdog, events, selected, asked };
}

test('a core that is not answering decides nothing at all', async () => {
  /*
   * "I cannot measure" is not "everything is broken". Acting on a failed loopback request would switch the
   * selector, or fall back to blocking, on the one input that says nothing about any tunnel.
   */
  const { watchdog, events, selected } = harness({ available: false, delays: { a: [10] } });
  const outcome = await watchdog.runOnce();
  assert.equal(outcome.health, null, 'null, not an empty list: they mean different things');
  assert.equal(outcome.changed, false);
  assert.deepEqual(selected, []);
  assert.deepEqual(events, []);
});

test('each tunnel is probed through itself, never through the selector', async () => {
  const { watchdog, asked } = harness({ delays: { a: [10, 12, 11, 13], b: [90, 92, 91, 93] }, now: 'a' });
  await watchdog.runOnce();
  // The selector answers for whatever it currently points at, so probing it measures the current choice
  // and calls it the health of the group.
  assert.equal(asked.some((call) => call.outbound === 'wf-selector'), false);
  assert.deepEqual([...new Set(asked.map((call) => call.outbound))], ['a', 'b']);
});

test('the endpoints are rotated, so one unreachable endpoint is not the whole verdict', async () => {
  const { watchdog, asked } = harness({ delays: { a: [10, 12, 11, 13] }, now: 'a' });
  await watchdog.runOnce();
  const urls = asked.filter((call) => call.outbound === 'a').map((call) => call.url);
  assert.deepEqual(urls, [
    'http://one.invalid/204',
    'http://two.invalid/204',
    'http://one.invalid/204',
    'http://two.invalid/204',
  ]);
});

test('a steady round records nothing, because the ring is the only record of a bad boot', async () => {
  const { watchdog, events } = harness({ delays: { a: [10, 11, 12, 13] }, now: 'a' });
  await watchdog.runOnce();
  await watchdog.runOnce();
  assert.deepEqual(events, [], 'a watchdog that logged every round would push out the entries that matter');
});

test('a switch is recorded with everything the decision saw', async () => {
  // `a` never answers; `b` is fine. Two failing rounds are needed before the switch.
  const { watchdog, events, selected } = harness({
    delays: { a: [null], b: [40, 41, 42, 43] },
    now: 'a',
  });
  await watchdog.runOnce();
  assert.deepEqual(selected, [], 'one bad round is a bad sample');
  await watchdog.runOnce();
  assert.deepEqual(selected, ['b']);
  assert.ok(events.some((event) => event.kind === 'health.degraded'));
  const switched = events.find((event) => event.kind === 'health.switched');
  assert.ok(switched, 'the ring must answer "why did it do that" without a re-run');
  assert.match(switched.summary, /traffic moved from a to b/);
});

test('recovery is recorded as a transition, not on every healthy round', async () => {
  const delays: Record<string, (number | null)[]> = { a: [null, null, null, null, 20, 21, 22, 23, 20, 21, 22, 23] };
  const { watchdog, events } = harness({ delays, now: 'a' });
  await watchdog.runOnce(); // fails
  await watchdog.runOnce(); // recovers
  await watchdog.runOnce(); // still healthy
  const kinds = events.map((event) => event.kind);
  assert.deepEqual(kinds.filter((kind) => kind === 'health.recovered').length, 1);
});

test('a failed switch is recorded as a failure and the selection is not claimed', async () => {
  const { watchdog, events } = harness({
    delays: { a: [null], b: [40, 41, 42, 43] },
    now: 'a',
    selectOk: false,
  });
  await watchdog.runOnce();
  const outcome = await watchdog.runOnce();
  assert.equal(outcome.changed, false);
  assert.equal(outcome.selected, 'a', 'the selection is what the core says it is, not what we asked for');
  assert.ok(events.some((event) => event.kind === 'health.switch-failed'));
});

test('the current selection is read from the core, so a hand-made change is respected', async () => {
  // An operator pointed the selector at `b` themselves. `b` is healthy, so stickiness keeps it — even
  // though `a` is first in the configured order and also healthy.
  const { watchdog, selected } = harness({
    delays: { a: [10, 11, 12, 13], b: [80, 81, 82, 83] },
    now: 'b',
  });
  await watchdog.runOnce();
  assert.deepEqual(selected, [], 'a watchdog trusting its own memory would have fought the operator');
});

test('nothing healthy selects the profile fallback', async () => {
  const { watchdog, selected } = harness({
    delays: { a: [null], b: [null] },
    now: 'a',
  });
  await watchdog.runOnce();
  await watchdog.runOnce();
  assert.deepEqual(selected, ['block']);
});

test('a round that throws does not stop the loop', async () => {
  const core = {
    available: async () => true,
    proxies: async () => {
      throw new Error('the core went away mid-round');
    },
    delay: async () => 10,
    select: async () => ({ ok: true, message: '' }),
  } as unknown as CoreApi;
  const logged: string[] = [];
  const watchdog = createWatchdog({
    core,
    selector: 'wf-selector',
    candidates: async () => ['a'],
    guards: async () => [],
    policy: () => POLICY,
    record: () => {},
    log: (_level, _fields, message) => logged.push(message),
  });

  // `runOnce` propagates, and `start` is the layer that must survive it: a watchdog that dies on one bad
  // round leaves a device with no failover and no sign that it has none.
  await assert.rejects(() => watchdog.runOnce());
  const handle = watchdog.start(5);
  await new Promise((resolve) => setTimeout(resolve, 50));
  handle.stop();
  assert.ok(logged.some((message) => message.includes('the watchdog continues')));
});

test('the fallback the watchdog selects is a member of the generated selector', async () => {
  const { generateCoreConfig } = await import('../src/core/generate/core-config.ts');
  const { emptyProfile } = await import('@wayfarer/schemas');

  const build = (onAllDown: 'block' | 'direct', tunnels: unknown[]) => {
    const base = emptyProfile({ name: 'Bench' }) as unknown as Record<string, unknown>;
    const policy = { ...(base['policy'] as Record<string, unknown>), onAllDown };
    const config = generateCoreConfig({
      profile: { ...base, policy, tunnels } as never,
      interfaces: { accessPoint: 'wlx0', uplinks: new Map() },
      emitted: new Map(
        tunnels.map((tunnel) => [
          (tunnel as { id: string }).id,
          { target: 'outbounds', object: { type: 'socks', tag: (tunnel as { id: string }).id, server: '127.0.0.1' } },
        ]),
      ) as never,
      tunnelDns: new Map(),
      uplinkNetworks: [],
    });
    const outbounds = config['outbounds'] as { type?: string; tag?: string; outbounds?: string[] }[];
    return outbounds.find((entry) => entry.type === 'selector')!.outbounds ?? [];
  };

  const tunnels = [
    { id: 'a', name: 'A', role: 'alternative', enabled: true, provider: 'external-socks', config: { command: 'x', localPort: 1080 } },
  ];

  /*
   * A selector can only be set to one of its own members, and the watchdog points it at the fallback when
   * nothing is healthy. Listing the fallback only when there were no alternatives made it unreachable in
   * exactly the situation it exists for — measured on the bench board as
   * `could not point the selector at block: 400 {"message":"Selector update error: not found"}`.
   */
  assert.deepEqual(build('block', tunnels), ['a', 'block']);
  assert.deepEqual(build('direct', tunnels), ['a', 'direct']);
  // Last, so it is never chosen as the default.
  assert.equal(build('block', tunnels).at(-1), 'block');
  // And with no alternatives at all it is still the one member, so routing rules naming the selector work.
  assert.deepEqual(build('block', []), ['block']);
});

test('a round that cannot finish inside its interval stops and leaves the rest unknown', async () => {
  /*
   * Probes stay sequential, deliberately: every probe leaves through the same uplink, so probing in
   * parallel inflates the latency and jitter the probes are measuring — and with a 500 ms median and a
   * 250 ms mean deviation as the thresholds, the measurement would start failing tunnels because of the
   * measurement.
   *
   * So the round is bounded instead. What is not measured is left **absent from `health`** rather than
   * recorded as failing: absent data may not drive a decision, the same rule the core-unavailable branch
   * and the confirmation window already follow. A slow round degrades coverage visibly instead of
   * stretching the cadence silently.
   */
  const { watchdog, events } = harness({
    delays: { a: [100], b: [100], c: [100] },
    now: 'a',
    // One second of budget, and each probe is made to cost more than that.
    policy: { probes: { ...POLICY.probes, intervalSeconds: 1, count: 1 } },
    probeCostMs: 1100,
  });

  const outcome = await watchdog.runOnce();

  assert.deepEqual(
    outcome.health?.map((entry) => entry.tunnelId),
    ['a'],
    'only the candidate that was actually measured appears in health',
  );

  const incomplete = events.find((event) => event.kind === 'health.round-incomplete');
  assert.ok(incomplete, 'the operator is told which candidates went unmeasured');
  assert.match(incomplete.summary, /left unknown/);
  assert.match(incomplete.summary, /\bb, c\b/);
});

test('an unmeasured candidate does not advance or clear a fail streak', async () => {
  // Incrementing would push an unmeasured tunnel towards being switched away from; clearing would forgive
  // real failures. Neither is evidence, so the streak is left exactly as it was.
  const { watchdog, events } = harness({
    delays: { a: [null], b: [100] },
    now: 'a',
    policy: { probes: { ...POLICY.probes, intervalSeconds: 1, count: 1 } },
    probeCostMs: 1100,
  });

  await watchdog.runOnce();
  const incomplete = events.find((event) => event.kind === 'health.round-incomplete')!;
  assert.match(incomplete.summary, /\bb\b/);
  // `a` was measured and failed; `b` was never measured, so nothing about `b` was decided or recorded.
  assert.ok(!events.some((event) => event.summary.includes('b failed')));
});
