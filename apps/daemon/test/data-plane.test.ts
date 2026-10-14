/**
 * The window's traffic check, and the apply machinery that moved with it: one apply at a time, the outcome
 * on the row, and an activate-and-apply whose revert puts the selection back.
 *
 * The symptom behind the check (bench board, 2026-10-11): every local reading was green while no client
 * could open a page. The rule it enforces: a change that breaks traffic which worked before it is reverted
 * early; a failure that was there before the change is only reported. Both halves are tested against the
 * real `applyDocument`, with a stand-in for the network the check talks to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyProfile, type ProfileDocument } from '@wayfarer/schemas';
import { applyDocument, applyInFlight, revertTransaction } from '../src/core/apply.ts';
import { checkDataPlane, watchDataPlane, type DataPlaneDeps } from '../src/core/data-plane.ts';
import { REVERT_REASONS } from '../src/core/safe-mode.ts';
import type { DataPlaneReading } from '../src/state/profiles.ts';
import { device } from './helpers/apply-bench.ts';

/** A network the check can be pointed at: each answer in turn, the last repeated. */
function network(answers: { direct?: boolean[]; core?: boolean[]; resolve?: boolean } = {}) {
  const calls = { direct: 0, core: 0, resolve: 0 };
  let clock = 0;
  const pick = (list: boolean[] | undefined, index: number): boolean => {
    if (list === undefined || list.length === 0) return true;
    return list[Math.min(index, list.length - 1)]!;
  };
  const deps: DataPlaneDeps & { coreRunning(): Promise<boolean> } = {
    coreRunning: async () => false,
    throughCore: async () => (pick(answers.core, calls.core++) ? { kind: 'answered', ms: 42 } : { kind: 'lost', why: '503: timeout' }),
    direct: async () => (pick(answers.direct, calls.direct++) ? { ok: true, detail: 'answered' } : { ok: false, detail: 'the request failed (ECONNRESET)' }),
    resolve: async () => {
      calls.resolve += 1;
      return answers.resolve === false ? { ok: false, detail: 'ETIMEOUT' } : { ok: true, detail: 'cp.cloudflare.com is 104.16.0.1' };
    },
    // Time moves 20 s per reading and a wait costs nothing, so the warm-up and the budget are reached in
    // a few iterations rather than in minutes.
    nowMs: () => (clock += 20_000),
    sleep: async () => undefined,
  };
  return { deps, calls };
}

const TARGET = { resolver: '10.44.0.1', endpoints: ['http://cp.cloudflare.com/generate_204', 'http://connectivitycheck.gstatic.com/generate_204'], viaCore: true };

test('a check resolves the probe name through the resolver clients are handed, then asks through the selector', async () => {
  const { deps, calls } = network({ core: [false, true] });
  const check = await checkDataPlane(deps, TARGET);
  assert.equal(check.ok, true, check.detail);
  assert.equal(calls.resolve, 1);
  // The first endpoint was lost and the second answered: one endpoint down is not the traffic down.
  assert.equal(calls.core, 2);
  assert.equal(check.latencyMs, 42);

  const dead = await checkDataPlane(network({ resolve: false }).deps, TARGET);
  assert.equal(dead.ok, false);
  assert.match(dead.detail, /did not resolve through 10\.44\.0\.1/);
});

test('failures inside the warm-up are not counted, and a pass ends the watch', async () => {
  const readings: DataPlaneReading[] = [];
  let reverted = 0;
  // Fails twice — both inside the 60 s warm-up — then answers.
  const { deps } = network({ core: [false, false, false, false, true] });
  const watch = watchDataPlane({ deps, target: TARGET, baselinePassed: true, record: (r) => readings.push(r), revert: async () => void (reverted += 1) });
  await watch.done;
  assert.equal(reverted, 0);
  assert.equal(readings.at(-1)?.state, 'passed');
});

test('a failure after a baseline that passed reverts once; one after a baseline that failed only reports', async () => {
  const broken = network({ core: [false] });
  const readings: DataPlaneReading[] = [];
  const reasons: string[] = [];
  await watchDataPlane({ deps: broken.deps, target: TARGET, baselinePassed: true, record: (r) => readings.push(r), revert: async (why) => void reasons.push(why) }).done;
  assert.equal(reasons.length, 1);
  assert.equal(readings.at(-1)?.state, 'failed');
  assert.match(reasons[0]!, /worked before it/);

  const already = network({ core: [false] });
  const advisory: DataPlaneReading[] = [];
  let reverted = 0;
  await watchDataPlane({ deps: already.deps, target: TARGET, baselinePassed: false, record: (r) => advisory.push(r), revert: async () => void (reverted += 1) }).done;
  // Mutation: let `baselinePassed !== true` fall through to the revert and this goes red — a device on a
  // dead uplink would undo every change anyone tried, which is how it becomes impossible to configure.
  assert.equal(reverted, 0);
  assert.equal(advisory.at(-1)?.state, 'advisory');
  assert.match(advisory.at(-1)!.detail, /failed before the change too/);
});

test('an apply whose traffic stops after the change, having worked before it, is reverted before the deadline', async (t) => {
  const bench = await device({ recovery: true });
  t.after(bench.close);
  // Before the change no core runs, so the baseline is a request from the device, and it answers. This
  // plan runs the core, so afterwards the check asks through the selector — and nothing answers there.
  const { deps } = network({ direct: [true], core: [false] });
  bench.deps.dataPlane = deps;

  const outcome = await applyDocument(bench.deps, { profileId: 'p1', document: bench.profile });
  assert.equal(outcome.transaction?.state, 'awaiting-confirm', JSON.stringify(outcome.error));
  const id = outcome.transaction!.id;

  for (let i = 0; i < 100 && bench.profiles.transaction(id)!.state !== 'reverted'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const row = bench.profiles.transaction(id)!;
  assert.equal(row.state, 'reverted', `state ${row.state}, dataPlane ${JSON.stringify(row.dataPlane)}`);
  assert.equal(row.dataPlane?.state, 'failed');
  assert.ok(row.reason?.startsWith(REVERT_REASONS.dataPlaneFailed), row.reason ?? '');
  // The window watch is stopped by the revert as well; nothing is left running for this transaction.
  bench.deps.windowWatch!.stop(id);
});

test('an apply whose traffic works records it as passed, and stays waiting for a person', async (t) => {
  const bench = await device({ recovery: true });
  t.after(bench.close);
  bench.deps.dataPlane = network().deps;

  const outcome = await applyDocument(bench.deps, { profileId: 'p1', document: bench.profile });
  const id = outcome.transaction!.id;
  for (let i = 0; i < 100 && bench.profiles.transaction(id)!.dataPlane?.state !== 'passed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const row = bench.profiles.transaction(id)!;
  assert.equal(row.dataPlane?.state, 'passed');
  // Never a confirmation: the check reverts or reports, and keeping a change stays a person's act.
  assert.equal(row.state, 'awaiting-confirm');
  // The outcome is on the row, for a caller that was answered `202` before the apply ended.
  assert.equal(row.outcome?.ok, true);
  bench.deps.windowWatch!.stop(id);
  await revertTransaction(bench.deps, id, REVERT_REASONS.operatorRequested);
});

test('a second apply while one runs is refused, and the first is unaffected', async (t) => {
  const bench = await device({ recovery: true });
  t.after(bench.close);

  const first = applyDocument(bench.deps, { profileId: 'p1', document: bench.profile });
  assert.equal(applyInFlight(bench.profiles), true);
  const second = await applyDocument(bench.deps, { profileId: 'p1', document: bench.profile });
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, 'apply_in_progress');
  assert.equal(second.transaction, undefined, 'a refused apply must not open a transaction');

  const outcome = await first;
  assert.equal(outcome.transaction?.state, 'awaiting-confirm');
  assert.equal(applyInFlight(bench.profiles), false);
  bench.deps.windowWatch!.stop(outcome.transaction!.id);
  await revertTransaction(bench.deps, outcome.transaction!.id, REVERT_REASONS.operatorRequested);
});

test('reverting an activate-and-apply puts the previous selection back', async (t) => {
  const bench = await device({ recovery: true });
  t.after(bench.close);
  const before = bench.profiles.create(emptyProfile({ name: 'Bench AP' }) as ProfileDocument);
  const after = bench.profiles.create(bench.profile);
  bench.store.setActiveProfileId(after.id);

  const outcome = await applyDocument(bench.deps, { profileId: after.id, document: bench.profile, activeProfileBefore: before.id });
  const id = outcome.transaction!.id;
  bench.deps.windowWatch!.stop(id);
  await revertTransaction(bench.deps, id, REVERT_REASONS.operatorRequested);

  // Mutation: drop the `activeProfileBefore` branch in `revertTransaction` and this goes red — the device
  // runs the old configuration while naming the new profile active, and the next apply reinstalls it.
  assert.equal(bench.store.device().activeProfileId, before.id);
});
