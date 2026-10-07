/**
 * The job-wait, tested against the message order that broke it on hardware.
 *
 * `StartUnit` returns a job path; whether the unit started arrives later as a `JobRemoved` signal.
 * Both are messages on one socket, and a D-Bus binding dispatches everything it reads from that
 * socket in one synchronous pass. Resolving the method reply only *queues* the caller's
 * continuation as a microtask, so a signal read in the same pass is delivered **before** the caller
 * has had a chance to do anything with the job path it was just given.
 *
 * Measured on the bench board, 2026-09-20, fresh image, after an apply: `wf-firewall.service` is a
 * `Type=oneshot` running two `nft` invocations and finishes inside the same second it is started.
 * The apply reported `timeout after 90000 ms` while the journal showed `Finished
 * wf-firewall.service` — and the unit sitting there `active (exited)`. Slower units — hostapd,
 * dnsmasq — had never lost that race, which is why every earlier apply looked fine.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createSystemdController, type SystemBusLike } from '../src/platform/systemd.ts';

type Listener = (...args: unknown[]) => void;

/**
 * A stand-in bus whose manager dispatches the reply to `StartUnit` and the matching `JobRemoved`
 * in one synchronous pass, the way a binding does when both messages arrive in one socket read.
 */
function busThatSignalsBeforeTheCallerResumes(options: { delayMs?: number } = {}): {
  bus: SystemBusLike;
  emitted: string[];
} {
  const listeners = new Map<string, Listener[]>();
  const emitted: string[] = [];
  const manager = {
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    removeListener(event: string, listener: Listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
    },
    $callMethod(name: string, args: unknown[]) {
      if (name === 'Subscribe') return Promise.resolve(null);
      if (name === 'StartUnit' || name === 'StopUnit' || name === 'RestartUnit') {
        const unit = String(args[0]);
        const jobPath = '/org/freedesktop/systemd1/job/7';
        const fire = (): void => {
          emitted.push(jobPath);
          for (const listener of listeners.get('JobRemoved') ?? []) listener(7, jobPath, unit, 'done');
        };
        if (options.delayMs === undefined) {
          // The signal is dispatched before the reply's continuation runs: emit it now, and hand the
          // path back through an already-resolved promise so the caller resumes in a later microtask.
          fire();
          return Promise.resolve(jobPath);
        }
        setTimeout(fire, options.delayMs);
        return Promise.resolve(jobPath);
      }
      if (name === 'GetUnit') return Promise.resolve('/org/freedesktop/systemd1/unit/wf_2dfirewall_2eservice');
      throw new Error(`unexpected method ${name}`);
    },
  };
  const unit = {
    on() {},
    $readAllProps: () =>
      Promise.resolve({
        Id: 'wf-firewall.service',
        LoadState: 'loaded',
        ActiveState: 'active',
        SubState: 'exited',
        UnitFileState: 'enabled',
      }),
  };
  return {
    emitted,
    bus: {
      getInterface(_service: string, _path: string, iface: string) {
        return Promise.resolve(iface.endsWith('Manager') ? manager : unit);
      },
    },
  };
}

/**
 * The job timeout's timer is `unref`ed, so a wait that never settles does not hold the loop open and
 * the process simply leaves. This keeps a referenced timer alive for the duration of a wait so the
 * failure shows up as the timeout it is rather than as an event loop that ran out of things to do.
 */
async function withLoopHeldOpen<T>(body: () => Promise<T>): Promise<T> {
  const keepalive = setInterval(() => {}, 20);
  try {
    return await body();
  } finally {
    clearInterval(keepalive);
  }
}

test('a unit that finishes before the caller sees its job path still reports done', async () => {
  const { bus } = busThatSignalsBeforeTheCallerResumes();
  const systemd = createSystemdController({ bus, jobTimeoutMs: 400 });
  const result = await withLoopHeldOpen(() => systemd.start('wf-firewall.service'));
  assert.equal(
    result.result,
    'done',
    'a oneshot that completes instantly must not be reported as a timeout: this exact case failed an apply on hardware',
  );
});

test('a job whose signal arrives normally still reports done', async () => {
  const { bus } = busThatSignalsBeforeTheCallerResumes({ delayMs: 10 });
  const systemd = createSystemdController({ bus, jobTimeoutMs: 400 });
  const result = await withLoopHeldOpen(() => systemd.start('wf-firewall.service'));
  assert.equal(result.result, 'done');
  assert.ok(result.waitedMs >= 0, 'the wait is measured');
});

/**
 * A bus whose job never emits a completion signal at all, so the wait has to fall back to reading
 * the unit. `activeState` is whatever the caller of this helper says the unit ended up in.
 */
function busThatNeverSignals(unitState: { ActiveState: string; SubState: string }): SystemBusLike {
  const manager = {
    on() {},
    removeListener() {},
    $callMethod(name: string) {
      if (name === 'Subscribe') return Promise.resolve(null);
      if (name === 'StartUnit' || name === 'StopUnit') return Promise.resolve('/job/9');
      if (name === 'GetUnit') return Promise.resolve('/unit/x');
      throw new Error(`unexpected method ${name}`);
    },
  };
  const unit = {
    on() {},
    $readAllProps: () =>
      Promise.resolve({ Id: 'wf-firewall.service', LoadState: 'loaded', UnitFileState: 'enabled', ...unitState }),
  };
  return {
    getInterface(_service: string, _path: string, iface: string) {
      return Promise.resolve(iface.endsWith('Manager') ? manager : unit);
    },
  };
}

test('a timeout on a unit that did reach the wanted state reports done, and says the evidence was the unit', async () => {
  const systemd = createSystemdController({
    bus: busThatNeverSignals({ ActiveState: 'active', SubState: 'exited' }),
    jobTimeoutMs: 100,
  });
  const result = await withLoopHeldOpen(() => systemd.start('wf-firewall.service'));
  assert.equal(result.result, 'done');
  assert.match(
    result.unit,
    /no completion signal; unit read as active\/exited/,
    'the step log must say the result came from reading the unit, not from a signal',
  );
});

test('a timeout on a unit that did not start stays a timeout and names the state seen', async () => {
  const systemd = createSystemdController({
    bus: busThatNeverSignals({ ActiveState: 'activating', SubState: 'start' }),
    jobTimeoutMs: 100,
  });
  const result = await withLoopHeldOpen(() => systemd.start('wf-core.service'));
  assert.match(result.result, /^timeout \(unit is activating\/start\)$/);
});

test('a stop that times out is judged against inactive, not active', async () => {
  const systemd = createSystemdController({
    bus: busThatNeverSignals({ ActiveState: 'active', SubState: 'running' }),
    jobTimeoutMs: 100,
  });
  const result = await withLoopHeldOpen(() => systemd.stop('wf-core.service'));
  assert.match(
    result.result,
    /^timeout \(unit is active\/running\)$/,
    'a unit still running is not a successful stop, however the job ended',
  );
});

/* ── a revert must not stop the unit it is running inside ────────────────────────────────── */

test('stopping a transient unit stops the timer, and the service only when we are not inside it', async () => {
  const { createSystemdController } = await import('../src/platform/systemd.ts');
  const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'wayfarer-systemctl-'));
  const log = join(dir, 'calls');
  const fake = join(dir, 'systemctl');
  // Records its arguments and succeeds, so the assertion is about what was asked of systemctl.
  await writeFile(fake, `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`);
  await chmod(fake, 0o755);

  // `stopTransient` is a CLI path, but the controller opens a bus when it is created, so it is given
  // a stand-in — the same seam the job-wait tests use.
  const systemd = createSystemdController({
    systemctlPath: fake,
    bus: busThatNeverSignals({ ActiveState: 'inactive', SubState: 'dead' }),
  });
  const result = await systemd.stopTransient('wayfarer-revert@abc.service');

  const { readFile } = await import('node:fs/promises');
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  const stop = calls.find((line) => line.startsWith('stop '))!;

  assert.ok(stop.includes('wayfarer-revert@abc.timer'), 'the timer must always be stopped, or it fires again');

  /*
   * On a machine where this process is not inside that unit — every test runner, and the daemon in
   * production — the service is stopped too. The interesting case is the other one, and it is
   * asserted through the message rather than by faking a cgroup: when the revert runs *as* the
   * transient unit, stopping the service kills the revert mid-flight. That is what left a transaction
   * `reverting` for ever on the bench board with the uplink still down.
   */
  const insideIt = result.message.includes('this process is inside it');
  assert.equal(
    stop.includes('wayfarer-revert@abc.service'),
    !insideIt,
    'the service is stopped exactly when we are not the thing running in it',
  );
});

test('a transient unit that no longer exists counts as disarmed, not as a failure', async () => {
  const { createSystemdController } = await import('../src/platform/systemd.ts');
  const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'wayfarer-systemctl-gone-'));
  const fake = join(dir, 'systemctl');
  // What systemd says about a transient unit after a reboot has taken it away.
  await writeFile(fake, '#!/bin/sh\necho "Failed to stop x.timer: Unit x.timer not loaded." >&2\nexit 5\n');
  await chmod(fake, 0o755);

  const systemd = createSystemdController({
    systemctlPath: fake,
    bus: busThatNeverSignals({ ActiveState: 'inactive', SubState: 'dead' }),
  });
  const result = await systemd.stopTransient('wayfarer-revert@abc.service');

  assert.equal(
    result.ok,
    true,
    'the goal is "no timer armed", and a unit that does not exist meets it — reporting this as a ' +
      'failure made a perfect recovery across a hard reset log a warning about its own success',
  );
  assert.match(result.message, /already disarmed/);
});

/* ── powering off ────────────────────────────────────────────────────────────────────────── */

test('poweroff asks systemctl for an orderly power-off and nothing else', async () => {
  const { createSystemdController } = await import('../src/platform/systemd.ts');
  const { mkdtemp, writeFile, chmod, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'wayfarer-systemctl-poweroff-'));
  const log = join(dir, 'calls');
  const fake = join(dir, 'systemctl');
  // A stand-in that records and succeeds. Pointed at by path, so nothing in this test can reach the
  // machine's own systemctl, and a controller that ignored the path would fail on the missing log.
  await writeFile(fake, `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`);
  await chmod(fake, 0o755);

  const systemd = createSystemdController({
    systemctlPath: fake,
    bus: busThatNeverSignals({ ActiveState: 'inactive', SubState: 'dead' }),
  });
  const result = await systemd.poweroff('asked for by token ops');

  assert.equal(result.ok, true);
  // `poweroff` and not `poweroff -f` or `--force`: an orderly stop, so the card is not abandoned mid-write.
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['poweroff']);
});
