/**
 * The shipped unit file and the deadman, read as artefacts rather than described.
 *
 * Everything asserted here is a property that is **silent when wrong**. A missing process cap, a kill
 * mode that leaves children behind, an unbounded restart loop: none of them produces an error, a
 * warning, or a failing test anywhere else. They produce a device that works for a while and then
 * cannot be logged into, at which point the evidence is in a RAM-backed journal that is about to be
 * lost to the reboot somebody performs to fix it.
 *
 * None of these is a fix for any particular incident. Each is a guard with its own justification, and
 * they are labelled that way deliberately: a guard presented as a fix gets removed the day somebody
 * finds the real cause.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEPLOY = join(import.meta.dirname, '..', '..', '..', 'deploy');
const UNIT = join(DEPLOY, 'systemd', 'wayfarer.service');
const DEADMAN = join(DEPLOY, 'bench', 'wayfarer-deadman');
const INSTALLER = join(DEPLOY, 'install.sh');

/**
 * Directive values from a unit file, **with the section each one is in**.
 *
 * The section is not bookkeeping. A directive placed in the wrong section is not an error and not a
 * warning — systemd ignores it and the unit loads cleanly. Measured on the bench board: with
 * `StartLimitIntervalSec` written under `[Service]`, the file read correctly, an earlier version of
 * this test passed, and `systemctl show -p StartLimitIntervalUSec` reported the untouched default of
 * `10s`. The guard was written down and did nothing.
 *
 * So the key here is `Section.Directive`, and every assertion below names the section it expects. A
 * test that checks only for presence proves the text exists, not that anything honours it.
 */
async function directives(path: string): Promise<Map<string, string[]>> {
  const text = await readFile(path, 'utf8');
  const found = new Map<string, string[]>();
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header) {
      section = header[1]!;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = `${section}.${match[1]!}`;
    found.set(key, [...(found.get(key) ?? []), match[2]!]);
  }
  return found;
}

test('unit: a runaway cannot take the system process table with it', async () => {
  const unit = await directives(UNIT);
  const tasksMax = unit.get('Service.TasksMax')?.[0];
  assert.ok(tasksMax !== undefined, 'TasksMax is absent, so nothing bounds how many processes this daemon can create');

  const value = Number(tasksMax);
  assert.ok(Number.isInteger(value) && value > 0, `TasksMax is "${tasksMax}", which is not a count`);
  // The point is not the exact number: it is that a human can still get a login shell while our
  // software misbehaves. A cap in the tens of thousands is not a cap.
  assert.ok(value <= 4096, `TasksMax=${value} is too close to a whole process table to leave room for a login`);
  assert.ok(value >= 64, `TasksMax=${value} is below what a correct run needs and would fail normal operation`);
});

test('unit: children are killed with the cgroup, never left behind', async () => {
  const unit = await directives(UNIT);
  const killMode = unit.get('Service.KillMode')?.[0];
  // Stated explicitly even though it is systemd's default, and asserted as present rather than as
  // "not wrong". A default that is load-bearing and invisible is one somebody changes while reasoning
  // about something else; written down, it has to be argued with.
  assert.ok(killMode !== undefined, 'KillMode is not stated, so a behaviour this daemon depends on is implicit');
  // With `process`, children this daemon started survive each restart. A bounded-looking failure then
  // accumulates processes across restart cycles without limit, which is how the visible symptom ends
  // up being a machine that cannot fork a login session.
  assert.notEqual(killMode, 'process', 'KillMode=process leaves children behind at every restart');
  assert.notEqual(killMode, 'none');
  assert.equal(killMode, 'control-group');
});

test('unit: the restart loop is bounded, and bounded over a window that catches a slow one', async () => {
  const unit = await directives(UNIT);
  assert.equal(unit.get('Service.Restart')?.[0], 'always');

  const burst = Number(unit.get('Unit.StartLimitBurst')?.[0]);
  const interval = Number(unit.get('Unit.StartLimitIntervalSec')?.[0]);
  // Named with their section on purpose. In [Service] these parse without complaint and are ignored:
  // measured on the board, the effective StartLimitIntervalUSec stayed at the 10s default while the
  // file said 300. They are [Unit] directives.
  assert.ok(
    Number.isInteger(burst) && burst > 0,
    'StartLimitBurst is absent from [Unit]: the restart loop is unbounded, whatever [Service] says',
  );
  assert.ok(Number.isInteger(interval) && interval > 0, 'StartLimitIntervalSec is absent from [Unit]');

  // systemd's own default window is 10 seconds, which catches a fast loop and misses a slow one
  // entirely: a daemon that runs for thirty seconds before dying never trips it. The window has to be
  // wide enough that a crash-every-half-minute is still caught.
  assert.ok(
    interval >= 120,
    `StartLimitIntervalSec=${interval} is too short to catch a slow crash loop; the default 10s already does not`,
  );
  const restartSec = Number(unit.get('Service.RestartSec')?.[0] ?? 0);
  assert.ok(restartSec * burst < interval, 'the restarts fit inside the window, so the limit can never trip');

  // Failing is the end state. A unit that reboots the machine on failure turns one fault into a boot
  // loop, and on a board with no console that is indistinguishable from dead hardware.
  assert.equal(unit.get('Unit.StartLimitAction')?.[0] ?? 'none', 'none');
});

test('unit: the hardening that cannot be used is stated rather than quietly missing', async () => {
  const text = await readFile(UNIT, 'utf8');
  const unit = await directives(UNIT);
  // Both are measurements, not oversights: the engine needs writable-executable pages, and
  // hostapd_cli's client socket lives in a shared /tmp. Asserting their absence stops somebody adding
  // them back as an obvious improvement, and asserting the explanation stops the comment being lost.
  assert.equal(unit.has('Service.MemoryDenyWriteExecute'), false);
  assert.equal(unit.has('Service.PrivateTmp'), false);
  assert.match(text, /MemoryDenyWriteExecute cannot be used/);
  assert.match(text, /hostapd_cli/);
});

test('deadman: a fire takes our software out of the boot path, not just off the network', async () => {
  const text = await readFile(DEADMAN, 'utf8');
  // The principle, and the reason it is not merely tidy: the deadman restores the network and
  // reboots, so if the thing that locked the operator out was our own daemon, starting it again hands
  // the board straight back to the state it was rescued from. A recovery that leaves the cause
  // running is not a recovery.
  assert.match(text, /mask_verified "\$MANAGED_UNIT"/, 'a fire does not mask the daemon');
  assert.match(text, /MANAGED_UNIT=wayfarer\.service/);
  // Masking, not disabling: a mask survives anything calling `enable` — including our own installer, which
  // a half-finished deploy may well run again.
  assert.match(text, /systemctl mask "\$unit"/, 'nothing masks the generated units');
  assert.equal(/systemctl disable "\$MANAGED_UNIT"/.test(text), false, 'disable is not enough: enable would undo it');

  // Recorded and undoable. A board that rescued itself and now refuses to run our software is deeply
  // confusing unless it says so where somebody will look.
  assert.match(text, /"maskedUnit"/);
  assert.match(text, /"undoWith"/);
  assert.match(text, /cmd_release\(\)/);
  assert.match(text, /MASKED by a deadman fire/);

  /**
   * And every generated unit, not only the daemon.
   *
   * Measured on the bench board: a fire restored the network, masked `wayfarer.service` and rebooted —
   * and the board came back for ninety seconds and vanished again, because `wf-hostapd@wlan0.service`
   * was still **enabled** and took the radio at boot. Masking the control plane does nothing about the
   * data-plane units that already hold the hardware, and those are deliberately independent of the
   * daemon so a configuration survives a reboot without it. That independence is correct and is exactly
   * what makes them the thing a rescue has to stop.
   */
  assert.match(text, /OWNED_PREFIX=wf-/, 'a fire does not know which generated units to mask');
  assert.match(text, /list-unit-files/, 'only loaded units are masked, so an enabled one still starts at boot');
  assert.match(text, /masked generated units/);

  /**
   * And it **verifies** each mask by reading `is-enabled` back.
   *
   * Measured on the bench board, and the partial behaviour is what makes this essential: a template
   * *instance* masks fine because nothing occupies its path, while the template itself, every plain unit
   * and the daemon are refused outright when a unit file sits at the mask location. A fire that trusted
   * the exit code would have masked the instances and silently left everything else enabled — a partial
   * rescue that looks complete, which is worse than an obvious failure.
   */
  assert.match(text, /mask_verified\(\)/, 'the fire path does not verify its own masks');
  assert.match(text, /is-enabled "\$unit".*masked|= masked/, 'nothing reads the mask state back');
  assert.match(text, /COULD NOT MASK/, 'a mask that failed is not reported loudly');
  assert.match(text, /"couldNotMask"/, 'a failed mask is not in the fire record');
  // The template files themselves are skipped: they are not units that run, and masking one would
  // block the instances a later release needs.
  assert.match(text, /\$OWNED_PREFIX"\*@\.service\) continue/);
});

test('deadman: the safety net stays out of reach of the installer and a factory reset', async () => {
  const installer = await readFile(INSTALLER, 'utf8');
  // Enforcement by omission, which is easy to lose by accident and impossible to notice. The state
  // directory is deliberately not under /var/lib/wayfarer so a factory reset cannot take it.
  assert.equal(
    /\/usr\/local\/sbin\/wayfarer-deadman/.test(installer),
    false,
    'the installer names the deadman script, so it could remove or replace it',
  );
  assert.equal(/\/var\/lib\/wayfarer-deadman/.test(installer), false, 'the installer names the deadman state directory');

  const deadman = await readFile(DEADMAN, 'utf8');
  assert.match(deadman, /STATE_DIR=\/var\/lib\/wayfarer-deadman/);
});

test('units: nothing we install or generate lands in the administrator\u2019s directory', async () => {
  /**
   * `/etc/systemd/system` is where systemd puts masks and where an operator puts overrides. A unit file
   * there occupies the path a mask needs, so masking is **refused** — measured on the bench board:
   *
   *     # systemctl mask wayfarer
   *     Failed to mask unit: File '/etc/systemd/system/wayfarer.service' already exists
   *
   * Which disabled the safety net's central action, silently. This asserts the location from both sides —
   * the installer's and the planner's — because they are two independent places that had the same bug.
   */
  const installer = await readFile(INSTALLER, 'utf8');
  assert.match(installer, /UNIT_DIR=\/usr\/local\/lib\/systemd\/system/);
  assert.equal(
    /install -m 0644 "\$SOURCE_DIR\/deploy\/systemd\/\$UNIT_NAME" "\/etc\/systemd\/system/.test(installer),
    false,
    'the installer still writes its unit into /etc/systemd/system',
  );
  // And it clears out what older builds left there, because a file in that directory both shadows the
  // correct copy and blocks masking, with no sign of either.
  assert.match(installer, /migrate_units_out_of_etc/);

  const { PATHS } = await import('../src/core/desired-state.ts');
  assert.equal(PATHS.unitDir, '/usr/local/lib/systemd/system');

  // The daemon must be able to write where it generates, and only there.
  const unit = await directives(UNIT);
  const writable = (unit.get('Service.ReadWritePaths')?.[0] ?? '').split(/\s+/);
  assert.ok(writable.includes(PATHS.unitDir), `ReadWritePaths does not cover ${PATHS.unitDir}`);
  assert.equal(
    writable.includes('/etc/systemd/system'),
    false,
    'the daemon can still write to the administrator\u2019s directory, which is what caused the defect',
  );
});

test('installer: the daemon is enabled only after it has been seen to answer', async () => {
  const text = await readFile(INSTALLER, 'utf8');
  const started = text.indexOf('systemctl restart "$UNIT_NAME"');
  const verified = text.indexOf('if daemon_answers; then');
  const enabled = text.indexOf('run_step systemctl enable "$UNIT_NAME"');

  assert.ok(started >= 0 && verified >= 0 && enabled >= 0, 'the install/verify/enable sequence is not recognisable');
  // Enabling before verifying hands the next boot a service that has never once been observed to
  // work. With Restart=always, a device that boots into a broken bundle fails the same way every
  // power cycle — which is the worst possible state for something with no console.
  assert.ok(started < verified, 'the installer verifies before it starts, which cannot be meaningful');
  assert.ok(verified < enabled, 'the installer enables the daemon before knowing whether it works');

  // And it asks the daemon, not systemd. `is-active` says a process exists; a daemon that started,
  // failed to bind and sat there is `active` and serving nothing.
  assert.match(text, /api\/health/);
});

test('installer: a bundle that does not answer is rolled back to the one that did', async () => {
  const text = await readFile(INSTALLER, 'utf8');
  assert.match(text, /keep_previous_bundle/);
  assert.match(text, /rollback_to_previous/);
  // The restored bundle is enabled, because it is the one that should run at the next boot. Leaving
  // it installed but not enabled produces a device that recovers now and comes up dead later.
  const rollback = text.slice(text.indexOf('rollback_to_previous() {'));
  assert.match(rollback.slice(0, rollback.indexOf('\n}')), /systemctl enable/);
});

/* ── artefacts and the code that consumes them must agree ─────────────────────────────────── */

test('hostapd: the control socket we write is the one we connect to', async () => {
  // The "who consumes this?" check, applied to something that is not a file in a plan. The generator
  // writes `ctrl_interface=` and the platform layer connects to it; nothing tied the two together, and
  // they disagreed. Measured on the bench board:
  //
  //     $ hostapd_cli -i <ap> status
  //     Failed to connect to hostapd - wpa_ctrl_open: No such file or directory
  //
  // hostapd was running and healthy. The access point simply reported no state and no clients — the
  // same symptom already recorded for a PrivateTmp sandbox, reached by a different route.
  const { generateHostapd } = await import('../src/core/generate/hostapd.ts');
  const { HOSTAPD_CONTROL_DIR, hostapdArgs } = await import('../src/platform/ap.ts');
  const { builtInAndDongle } = await import('./helpers/synthetic-inventory.ts');

  const inventory = builtInAndDongle();
  const radio = inventory.radios.find((entry) => entry.derived.canHostAccessPoint.value)!;
  const config = generateHostapd({
    profile: {
      meta: { name: 'T' },
      accessPoint: { radio: { band: '5GHz', channel: 36, width: 80, country: 'DE', hidden: false }, ssid: 'T' },
    } as never,
    interfaceName: 'wlan1',
    radio,
    passphrase: 'a-passphrase',
    channelFollowsUplink: false,
  });

  const declared = /^ctrl_interface=(.+)$/m.exec(config)?.[1];
  assert.equal(declared, HOSTAPD_CONTROL_DIR, 'the generated configuration names a different socket directory');

  // And the **real** argument builder passes it. Asserting this through a substituted `call` would
  // have inspected the arguments the substitute itself built, which proves nothing about the code that
  // runs on a device — so the builder is its own function and this asserts that.
  assert.deepEqual(hostapdArgs(HOSTAPD_CONTROL_DIR, 'wlan1', ['status']), [
    '-p',
    HOSTAPD_CONTROL_DIR,
    '-i',
    'wlan1',
    'status',
  ]);
  // The subscriber takes the same path. It is a separate call site and was the one originally missed.
  assert.deepEqual(hostapdArgs(HOSTAPD_CONTROL_DIR, 'wlan1', []).slice(0, 2), ['-p', HOSTAPD_CONTROL_DIR]);
});

test('units: the sandbox’s writable set covers every directory a generator can emit into', async () => {
  /**
   * The two descriptions compared mechanically rather than from memory.
   *
   * A `network` apply was once planned, accepted, given a transaction, given a confirmation window and a
   * revert timer, and then failed with `EROFS` on `/etc/netplan` — a directory the sandbox had never
   * allowed. The permission was knowable before anything moved. The reconciler now proves writability at
   * step 1, and this asserts the other half: that the unit file and the generators agree in the first place,
   * so the runtime check is a backstop rather than the only line of defence.
   */
  const unit = await directives(UNIT);
  const writable = (unit.get('Service.ReadWritePaths')?.[0] ?? '').split(/\s+/).filter((entry) => entry !== '');
  const { PATHS, CONFIG_ROOT } = await import('../src/core/desired-state.ts');

  const covered = (path: string): boolean => writable.some((root) => path === root || path.startsWith(`${root}/`));

  /*
   * Everywhere a generator writes, **derived from `PATHS` rather than listed here**.
   *
   * The list used to be written out by hand, and a hand-written copy of a truth is a second truth
   * that drifts. Measured on the bench board, 2026-09-20: two new generator paths —
   * `/etc/wayfarer/supplicant` and `/etc/sysctl.d/90-wayfarer.conf` — were added, this test kept
   * passing because neither was in its list, and both were caught instead by the runtime check, one
   * of them only after a deploy and an apply attempt. The runtime check is meant to be the backstop,
   * not the discoverer.
   *
   * Iterating `PATHS` means a path cannot be added to the generators without this noticing.
   */
  for (const [name, value] of Object.entries(PATHS)) {
    if (typeof value !== 'string' || !value.startsWith('/')) continue;
    // A file entry is covered by its directory.
    const directory = value.includes('.') ? value.slice(0, value.lastIndexOf('/')) : value;
    assert.ok(
      covered(directory),
      `PATHS.${name} (${value}) is written by a generator and ${directory} is not in ReadWritePaths`,
    );
  }
  assert.ok(covered(CONFIG_ROOT), `${CONFIG_ROOT} is written by a generator and is not in ReadWritePaths`);

  // And the directories a takeover moves a file within. These belong to other programs, which is exactly
  // why nobody thought to check them — the file is never written, only renamed, and a rename needs write
  // permission on the directory just the same.
  assert.ok(covered('/etc/netplan'), 'a takeover renames a file in /etc/netplan and cannot without this');

  // The corollary from docs/16, asserted so it cannot rot: the list shrinks when the code stops needing a
  // path. These three were removed once nothing wrote to them, and two of them hold another system's live
  // configuration on the bench board.
  for (const path of ['/etc/hostapd', '/etc/dnsmasq.d', '/etc/nftables.conf']) {
    assert.equal(writable.includes(path), false, `${path} is writable and nothing writes to it`);
  }
});

/* ── every unit we generate, not only the one that failed ────────────────────────────────── */

/** The same section-aware parse as `directives`, for unit text held in memory. */
function directivesOf(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header) {
      section = header[1]!;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = `${section}.${match[1]!}`;
    found.set(key, [...(found.get(key) ?? []), match[2]!]);
  }
  return found;
}

async function everyGeneratedUnit(): Promise<{ name: string; text: string }[]> {
  const { coreUnit, templateUnits } = await import('../src/core/generate/units.ts');
  const units = [coreUnit({ binaryPath: '/usr/bin/sing-box' }), ...templateUnits({ upScript: '/opt/wayfarer/bin/tunnel-up' })];
  return units
    .filter((unit): unit is typeof unit & { content: string } => unit.content !== undefined)
    .map((unit) => ({ name: unit.name, text: unit.content }));
}

test('generated units: a restarting unit has a start limit whose window can actually contain the burst', async () => {
  for (const unit of await everyGeneratedUnit()) {
    const found = directivesOf(unit.text);
    if (found.get('Service.Restart') === undefined) continue;

    // The directive belongs in [Unit]. In [Service] it is accepted and ignored, which is how a limit
    // that reads correctly in the file turns out never to have been in force.
    const interval = found.get('Unit.StartLimitIntervalSec')?.[0];
    const burst = found.get('Unit.StartLimitBurst')?.[0];
    assert.ok(
      interval !== undefined && burst !== undefined,
      `${unit.name} restarts but has no start limit in [Unit], so nothing ends a crash loop`,
    );
    assert.equal(found.get('Service.StartLimitIntervalSec'), undefined, `${unit.name}: StartLimitIntervalSec in [Service] is ignored`);

    /*
     * The arithmetic is the point, not the presence of the directives.
     *
     * A burst of five with a two-second delay needs more than ten seconds to happen, so systemd's
     * default ten-second window can never contain it and the limit never fires. Measured on the bench
     * board: NRestarts=20 under StartLimitBurst=5. The window must be wide enough for the burst it is
     * counting, or it is decoration.
     */
    const delaySeconds = Number(found.get('Service.RestartSec')?.[0] ?? '0');
    const windowSeconds = Number(interval);
    const burstCount = Number(burst);
    assert.ok(
      windowSeconds > delaySeconds * burstCount,
      `${unit.name}: ${burstCount} restarts ${delaySeconds}s apart need more than ${windowSeconds}s, ` +
        'so the burst never falls inside one window and the unit restarts for ever',
    );
  }
});

test('generated units: every ExecStart names something the kernel can actually execute', async () => {
  for (const unit of await everyGeneratedUnit()) {
    const found = directivesOf(unit.text);
    for (const key of ['Service.ExecStart', 'Service.ExecStartPre', 'Service.ExecStop', 'Service.ExecStopPost']) {
      for (const line of found.get(key) ?? []) {
        const program = line.replace(/^[-@+!]+/, '').split(/\s+/)[0]!;
        assert.ok(program.startsWith('/'), `${unit.name}: ${key} must be an absolute path, got ${program}`);
        /*
         * A script bundle is not an executable. Measured on the bench board, 2026-09-20: a unit with
         * `ExecStart=/opt/wayfarer/way.cjs` failed at boot with
         * `Failed at step EXEC spawning /opt/wayfarer/way.cjs: Exec format error`, because systemd
         * execs the file directly and the kernel has no idea what a `.cjs` is. The interpreter has to
         * be named — the installer's `/usr/local/bin/way` wrapper, or the runtime explicitly.
         */
        assert.ok(
          !/\.(c?js|mjs|ts)$/.test(program),
          `${unit.name}: ${key} points straight at ${program}, which the kernel cannot exec. ` +
            'Name the wrapper or the runtime instead.',
        );
      }
    }
  }
});

/* ── the tunnel up-script and the unit that runs it ──────────────────────────────────────── */

test('the up-script and the unit agree on the variable that names the tunnel', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { openvpnUnit } = await import('../src/core/generate/units.ts');

  const script = await readFile(join(DEPLOY, 'bin', 'tunnel-up'), 'utf8');
  const unit = openvpnUnit({ upScript: '/opt/wayfarer/bin/tunnel-up' }).content!;

  /*
   * Two descriptions of one name. The unit sets it with `--setenv`, the script reads it, and nothing
   * connects them but agreement — so this compares them rather than asserting either. They were
   * `WAYFARER_TUNNEL` and `WAYFARER_TUNNEL_ID` when first written, which would have made every captured
   * resolver land under no tunnel at all, silently, because the script exits quietly when the id is
   * absent rather than guessing a filename.
   */
  const setByUnit = /--setenv\s+([A-Z_]+)\s/.exec(unit)?.[1];
  assert.ok(setByUnit, 'the unit should set the tunnel id in the environment');
  assert.ok(
    script.includes(`\${${setByUnit}:-}`),
    `the unit sets ${setByUnit} and the script does not read it`,
  );
});

test('the up-script applies no routes, which is the point of it existing', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const script = await readFile(join(DEPLOY, 'bin', 'tunnel-up'), 'utf8');

  // The core decides routing. A server pushing a default-route redirect takes it over, and one pushing
  // a large private range captures the management network — so the script must not install anything.
  for (const forbidden of ['ip route', 'route add', 'ip -4 route', 'resolvectl', 'nft ']) {
    assert.ok(!script.includes(forbidden), `the up-script runs ${forbidden}, which it must never do`);
  }
});

test('the up-script never lets the peer text reach a shell', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const script = await readFile(join(DEPLOY, 'bin', 'tunnel-up'), 'utf8');

  /*
   * `foreign_option_*` is text from whoever is on the other end of the tunnel, and this script runs as
   * root under OpenVPN. The single `eval` is the indexed variable lookup and must not interpolate a
   * value; everything else goes through `printf` and `cut`.
   */
  const evals = [...script.matchAll(/eval\s+(.*)/g)].map((match) => match[1]!);
  assert.equal(evals.length, 1, 'one eval, for the indexed lookup, and no more');
  assert.match(evals[0]!, /^"value=\\\$\{foreign_option_\$\{index\}:-\}"$/, 'the eval must expand only the index');
});
