/**
 * G13: the deadline the device reports is the deadline it keeps.
 *
 * Measured 2026-09-22. `POST /api/apply` answered `secondsRemaining: 148`, and transaction
 * `6110779e063cfb9f`, created 19:03:20, was gone at 19:04:10 — undone by the window's health check,
 * which then acted on its own at 45 s. A caller who believed the reported number lost the change; a
 * retry confirmed at t+5 s survived only because it beat a deadline nobody had been told about.
 *
 * The decision (see `windowVerdict`): a health check inside the window records a finding and never
 * ends the window. The only things that end it are the ones the reported number already describes —
 * the timer at the deadline — and a person, by confirming or by asking for the revert.
 *
 * These tests run the real `applyDocument`, the real window watcher wired exactly as `index.ts` wires
 * it (through `recordWindowFinding`), the real transaction store, against a platform whose uplink is
 * **genuinely down** and a change that **did** act on it — the one case where the check has every
 * right to a finding. If anything can still end the window early, this is where it would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchoredSecondsRemaining,
  CONFIRMATION_WINDOW_MS,
} from '../src/core/transactions.ts';
import { applyDocument, revertTransaction } from '../src/core/apply.ts';
import { REVERT_REASONS, isFailureEvidence } from '../src/core/safe-mode.ts';
import { device } from './helpers/apply-bench.ts';

test('G13: a window health finding never ends the window before the deadline the device reported', async (t) => {
  const { clock, deps, profiles, armed, stopped, profile, close } = await device();
  t.after(close);

  const outcome = await applyDocument(deps, { profileId: 'p1', document: profile });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  const reported = outcome.transaction!;
  assert.equal(reported.state, 'awaiting-confirm');

  // The reported number and the armed timer are one number: the deadline the timer outside this process
  // fires at, in the frame it fires in.
  assert.equal(armed.length, 1);
  assert.equal(reported.secondsRemaining, armed[0]!.withinSeconds);
  assert.equal(reported.secondsRemaining, CONFIRMATION_WINDOW_MS / 1000);

  // Let the check run many times with every allowance elapsed and the uplink genuinely down.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const row = profiles.transaction(reported.id)!;
  // The check did find it — that half must keep working, and must say what it read.
  assert.match(row.reason ?? '', /uplink_down/, `no finding was recorded: ${row.reason}`);
  assert.match(row.reason ?? '', /operstate DOWN, flags NO-CARRIER/, 'the finding does not carry what was read');

  // And it did not act on it. Mutation: make `recordWindowFinding` call `revertTransaction` and this
  // goes red — the transaction ends 45 s (here: milliseconds) into a window reported as 150 s.
  assert.equal(row.state, 'awaiting-confirm', `the window ended before its reported deadline: state ${row.state}, reason ${row.reason}`);
  assert.deepEqual(stopped, [], 'the revert timer was disarmed, so something other than the deadline ended the window');

  // Nothing about the deadline moved either: what the device reports now is what it reported, less the
  // time that passed in the frame the timer acts on.
  clock.uptime += 100;
  const now = anchoredSecondsRemaining({
    firesAtUptimeSeconds: row.firesAtUptimeSeconds,
    uptimeSeconds: clock.uptime,
    deadlineAt: row.deadlineAt,
    now: new Date(),
  });
  assert.equal(now.secondsRemaining, (reported.secondsRemaining ?? 0) - 100);

  // A person can still keep it: the finding is information, and the decision is theirs.
  deps.windowWatch!.stop(reported.id);
});

test('G5: the revert at the deadline records what the window health check read', async (t) => {
  const { clock, deps, profiles, profile, close } = await device({ recovery: true });
  t.after(close);

  const outcome = await applyDocument(deps, { profileId: 'p1', document: profile });
  const id = outcome.transaction!.id;
  await new Promise((resolve) => setTimeout(resolve, 60));

  // The deadline arrives and the timer's `way revert --txn` runs — the same function.
  clock.uptime += CONFIRMATION_WINDOW_MS / 1000;
  await revertTransaction(deps, id, 'the confirmation deadline passed');

  const row = profiles.transaction(id)!;
  assert.equal(row.state, 'reverted', `state ${row.state}, reason ${row.reason}`);
  // Mutation: drop the `finding` fold in `revertTransaction` and this goes red — the record says only
  // "the deadline passed", and the next person cannot hold the verdict against the device.
  assert.match(row.reason ?? '', /the confirmation deadline passed\. During the window the health check had found: /);
  assert.match(row.reason ?? '', /: operstate DOWN, flags NO-CARRIER,BROADCAST,MULTICAST,UP, inet none/);
});

test('an operator revert after a finding is still a change of mind, not failure evidence', async (t) => {
  // The finding is folded into the revert's reason, and safe mode tells an operator's revert from a
  // failure by that reason. Mutation: compare with `===` in `isFailureEvidence` again and this goes red —
  // three such reverts on a healthy device would switch its tunnels off.
  const { deps, profiles, profile, close } = await device({ recovery: true });
  t.after(close);

  const outcome = await applyDocument(deps, { profileId: 'p1', document: profile });
  const id = outcome.transaction!.id;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await revertTransaction(deps, id, REVERT_REASONS.operatorRequested);

  const row = profiles.transaction(id)!;
  assert.match(row.reason ?? '', /During the window the health check had found/, 'the fixture must carry a finding');
  assert.equal(isFailureEvidence({ at: row.createdAt, state: row.state, reason: row.reason }), false);
});
