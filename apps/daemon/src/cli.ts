/**
 * `way` — the operator CLI. The same bundle with a different entry point.
 *
 * It exists for the cases where the interface cannot help: a daemon that will not start, a
 * board reachable only over SSH, a device whose password has been forgotten. So it talks to the
 * database and the platform layer directly rather than to the API, and it must keep working when
 * the HTTP surface does not.
 *
 * In this epic it covers status, doctor and credentials. Profile and transaction commands arrive
 * with the machinery they drive.
 */

import { DEFAULT_AP_PASSPHRASE, DEFAULT_AP_SSID, loadConfig, resolveBindAddresses } from './config.ts';
import { localChannelsFor, refusalSummary } from './api/bind-policy.ts';
import { createPlatform } from './platform/index.ts';
import { openDatabase } from './state/db.ts';
import { createStore } from './state/store.ts';
import { machineAccess } from './core/machine-access.ts';
import { devicePipeline } from './core/device-pipeline.ts';
import { signalDaemonOnEnd } from './core/transaction-ended.ts';
import { transactionLine } from './core/transaction-line.ts';
import { collectInventory } from './inventory/index.ts';
import { createProfileStore } from './state/profiles.ts';
import { createSecretPlan } from './state/secret-plan.ts';
import { collectFacts, collectReality } from './platform/facts.ts';
import type { PipelineContext } from './core/pipeline.ts';
import { buildRecoveryDocument, revertTransaction, type ApplyDeps } from './core/apply.ts';
import { checkDrift, createDriftMonitor, operatorDrift, summarise } from './core/drift.ts';
import { planDocument } from './core/pipeline.ts';
import { assertNoSelfCapture, decideRederive, probeAddressFor } from './core/boot-guard.ts';
import { SAFE_MODE_THRESHOLD, safeModeDecision, safeModeState } from './core/safe-mode.ts';
import { certificateResetWarning } from './core/tunnel-health.ts';
import { FORBIDDEN, assertResetPlanIsOurs, factoryResetPlan, type ResetStep } from './core/factory-reset.ts';



const USAGE = `way — Wayfarer operator CLI

  way status                 what this device is and whether the daemon is up
  way doctor                 prerequisites, binaries, radios, clock, invariants
  way credentials reset      set the admin password back to the documented default
  way machine-api [status|on|off]   whether API tokens are accepted at all (off by default)
  way inventory [--json]     the discovered hardware model
  way listen [--json]        the addresses and interfaces the daemon will serve on
  way revert --txn <id>      undo a transaction: what the transient timer runs
  way transactions           recent transactions, newest first
  way rederive               refresh the generated values read off this device (runs at boot)
  way check-routes           no address this device holds may route into the tunnel
  way safe-mode              why this device is, or is not, in safe mode
  way drift [--json]         does what is on this device match the stored profile?
  way debug expose-core-api     how to reach the core's own dashboard, without exposing it
  way factory-reset --dry-run   exactly what a reset would remove, and nothing else
  way factory-reset --yes       remove all configuration and state. There is no undo.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const loaded = await loadConfig();
  const config = loaded.config;

  switch (command) {
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return 0;

    case 'status':
      return await status(config);

    case 'doctor':
      return await doctor(config);

    case 'inventory':
      return await inventory(config, rest.includes('--json'));

    case 'listen':
      return await listen(config, rest.includes('--json'));

    case 'debug':
      return await debugCommand(config, rest);

    case 'factory-reset':
      return await factoryReset(config, { execute: rest.includes('--yes'), dryRun: rest.includes('--dry-run') });

    case 'safe-mode':
      return await safeModeStatus(config);

    case 'drift':
      return await drift(config, rest.includes('--json'));

    case 'rederive':
      return await rederive(config);

    case 'check-routes': {
      const waitIndex = rest.indexOf('--wait-for-tunnel');
      const wait = waitIndex >= 0 ? Number(rest[waitIndex + 1] ?? '0') : 0;
      return await checkRoutes(
        config,
        rest.includes('--stop-core-on-capture'),
        Number.isFinite(wait) && wait > 0 ? wait : 0,
      );
    }

    case 'revert':
      return await revert(config, rest);

    case 'transactions':
      return await transactions(config);

    case 'credentials':
      return await credentials(config, rest);

    case 'machine-api': {
      const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
      try {
        const result = machineAccess(createStore(database), rest);
        (result.code === 2 ? process.stderr : process.stdout).write(result.text);
        return result.code;
      } finally {
        database.close();
      }
    }

    default:
      process.stderr.write(`way: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

async function status(config: Awaited<ReturnType<typeof loadConfig>>['config']): Promise<number> {
  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
  try {
    const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
    const store = createStore(database);
    const device = store.device();
    const unit = await platform.systemd.state(config.unitName).catch(() => null);
    const clock = await platform.clock.status().catch(() => null);

    const lines = [
      `device            ${device.deviceName}`,
      `setup complete    ${device.setupComplete ? 'yes' : 'no — the default password is still in place'}`,
      `machine API       ${device.apiEnabled ? 'enabled' : 'disabled'}`,
      `daemon            ${unit ? `${unit.activeState ?? '?'}/${unit.subState ?? '?'} (${unit.unitFileState ?? '?'})` : 'unknown'}`,
      `listening         ${config.listen.addresses.join(', ')}${config.listen.interfaces.length > 0 ? ` + interfaces ${config.listen.interfaces.join(', ')}` : ''} on port ${config.listen.port}`,
      `clock             ${clock ? `${clock.synchronized ? 'synchronised' : 'NOT synchronised'}${clock.timezone ? `, ${clock.timezone}` : ''}` : 'unknown'}`,
      `events stored     ${store.eventCount()}`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);

    if (clock?.synchronized === false) {
      process.stdout.write(
        '\nThe clock has not been synchronised. This board has no clock battery, and transports that\n' +
          'authenticate on a timestamp fail while direct connections work — which looks like broken\n' +
          'tunnels. Check this before anything else.\n',
      );
    }

    database.close();
    return 0;
  } finally {
    platform.close();
  }
}

async function doctor(config: Awaited<ReturnType<typeof loadConfig>>['config']): Promise<number> {
  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
  try {
    const model = await collectInventory(platform);
    let problems = 0;

    process.stdout.write(`system            ${model.system.boardModel ?? 'unknown board'}, ${model.system.architecture}, ${model.system.cpuCount} cores, ${model.system.memoryMb} MB\n`);
    process.stdout.write(`kernel            ${model.system.kernel}\n\n`);

    process.stdout.write('binaries\n');
    for (const binary of model.binaries) {
      const mark = binary.present ? ' ok ' : 'MISS';
      if (!binary.present) problems += 1;
      process.stdout.write(
        `  [${mark}] ${binary.name.padEnd(16)} ${binary.present ? (binary.version ?? 'version unknown') : `not found — needed for ${binary.neededFor}`}\n`,
      );
    }

    process.stdout.write('\nradios\n');
    if (model.radios.length === 0) {
      process.stdout.write('  none detected\n');
      problems += 1;
    }
    for (const radio of model.radios) {
      const derived = radio.derived;
      process.stdout.write(
        `  ${radio.phy} (${radio.reported.bus ?? 'bus unknown'}${radio.reported.usbId ? ` ${radio.reported.usbId}` : ''})\n`,
      );
      process.stdout.write(`    access point    ${derived.canHostAccessPoint.value ? 'yes' : 'no'} — ${derived.canHostAccessPoint.from}\n`);
      process.stdout.write(`    client          ${derived.canHostClient.value ? 'yes' : 'no'}\n`);
      process.stdout.write(
        `    both at once    ${derived.accessPointAndClientTogether.value.supported ? (derived.accessPointAndClientTogether.value.sameChannelOnly ? 'yes, but only on one channel' : 'yes') : 'no'}\n`,
      );
      process.stdout.write(`                    driver says: ${derived.accessPointAndClientTogether.from}\n`);
      process.stdout.write(
        `    regulatory      ${radio.reported.regulatory.country ?? 'unknown'} (${radio.reported.regulatory.source})\n`,
      );
      const usable = derived.channels.filter((channel) => !channel.disabled);
      process.stdout.write(`    channels        ${usable.length} usable across ${derived.bands.value.join(', ') || 'no band'}\n`);
    }

    process.stdout.write('\nclock\n');
    process.stdout.write(`  synchronised    ${model.clock.synchronized === null ? 'unknown' : model.clock.synchronized ? 'yes' : 'NO'}\n`);
    if (model.clock.synchronized === false) problems += 1;

    if (model.notes.length > 0) {
      process.stdout.write('\nnotes\n');
      for (const note of model.notes) process.stdout.write(`  - ${note}\n`);
    }

    /*
     * Tunnels that keep resetting.
     *
     * Last, because it is the only section that reads running state rather than hardware, and because
     * what it usually finds is the clock — which the section above has already reported. Naming the
     * clock again here, in the tunnel's own context, is deliberate: an operator reading "the tunnel
     * keeps dropping" does not connect it to a line about time synchronisation several screens up.
     */
    const tunnelUnits = await platform.systemd.listOwnedUnits('wf-openvpn@').catch(() => [] as string[]);
    // The machine's uptime, on the same clock systemd timestamps units with. See below.
    const bootSeconds = await platform.host.uptimeSeconds().catch(() => null);
    const warnings: string[] = [];
    for (const unit of tunnelUnits) {
      if (unit.includes('@.')) continue;
      const shown = await platform.systemd.show(unit).catch(() => null);
      if (shown === null) continue;
      const restarts = Number(shown.properties['NRestarts'] ?? '0');
      /*
       * Both numbers on the **same clock**, which is the whole of the fix.
       *
       * `ActiveEnterTimestampMonotonic` is microseconds since boot. The first version of this subtracted
       * it from `process.uptime()` — seconds since *this command* started — and clamped the result at
       * zero, so `activeSeconds` was always zero, every restarting tunnel looked freshly started, and
       * the guard meant to exclude a long-running tunnel could never fire. The arithmetic looked
       * plausible until the units were named.
       *
       * A machine uptime that cannot be read leaves this `null`, and the decision is skipped rather than
       * made on a guess: a false certificate warning sends somebody chasing a fault that does not exist.
       */
      const activeSinceBoot = Number(shown.properties['ActiveEnterTimestampMonotonic'] ?? '0') / 1_000_000;
      if (bootSeconds === null || activeSinceBoot <= 0) continue;
      const activeSeconds = Math.max(0, bootSeconds - activeSinceBoot);
      const warning = certificateResetWarning({
        tunnelId: /@(.+)\.service$/.exec(unit)?.[1] ?? unit,
        restarts: Number.isFinite(restarts) ? restarts : 0,
        activeSeconds,
        clockTrusted: model.clock.synchronized === true,
      });
      if (warning !== null) warnings.push(`  ${warning.message}\n    ${warning.hint}`);
    }
    if (warnings.length > 0) {
      process.stdout.write('\ntunnels\n');
      for (const line of warnings) process.stdout.write(`${line}\n`);
      problems += warnings.length;
    }

    process.stdout.write(`\n${problems === 0 ? 'no problems found' : `${problems} thing(s) need attention`}\n`);
    return problems === 0 ? 0 : 1;
  } finally {
    platform.close();
  }
}

async function inventory(config: Awaited<ReturnType<typeof loadConfig>>['config'], asJson: boolean): Promise<number> {
  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
  try {
    const model = await collectInventory(platform);
    if (asJson) {
      process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
      return 0;
    }
    for (const radio of model.radios) {
      process.stdout.write(`${radio.phy}: ${radio.reported.interfaceModes.join(', ')}\n`);
      for (const combination of radio.reported.interfaceCombinations) {
        process.stdout.write(`  combination: ${combination.text}\n`);
      }
    }
    for (const iface of model.interfaces) {
      const addresses = iface.addresses.map((address) => `${address.address}/${address.prefixLength}`).join(' ');
      process.stdout.write(`${iface.name}: ${iface.operstate ?? '?'} ${addresses}\n`);
    }
    return 0;
  } finally {
    platform.close();
  }
}

/**
 * The effective listen configuration, after the same merge the daemon performs.
 *
 * It exists so the installer can tell the operator where the interface will be reachable without
 * re-implementing that merge in shell. The first version of the installer read the JSON file
 * directly and therefore did not mention loopback — which the merge always adds — so a device was
 * listening somewhere the message did not name. Twice now this file has printed something that was
 * not what the software does, and it is the file whose whole purpose is to tell a human the truth.
 */
/**
 * Where the daemon listens — asked of the policy, not read off the configuration file.
 *
 * ## Why this used to be wrong
 *
 * This printed `config.listen` and nothing else: the port, the literal addresses and the interface
 * names pinned in `daemon.json`. On a fresh install that is `127.0.0.1` and an empty interface list,
 * so the honest reading of the old output was "loopback only" — and the installer, which asks this
 * command precisely so its closing message cannot disagree with the software, printed exactly that.
 *
 * It had not been true since the bind set stopped being a configuration value. The daemon binds the
 * configured addresses **plus** whatever `api/bind-policy.ts` decides is a local channel from what
 * the kernel reports right now: the wire, the access point, the wireless uplink — and never a
 * tunnel. A board reachable on `192.168.77.7` was being described as reachable on loopback, and the
 * operator was told to set up an SSH tunnel to reach a panel already answering on the wire.
 *
 * ## Why it recomputes rather than asks the daemon
 *
 * This command has to work when the HTTP surface does not — that is what the CLI is for. So it makes
 * the same three readings the daemon makes and calls the same two functions on them,
 * `localChannelsFor` and `resolveBindAddresses`. It does not reimplement either. A second copy of
 * the bind policy that agreed today and drifted tomorrow would be worse than the wrong output it
 * replaces, because it would be wrong only sometimes.
 *
 * The consequence is that this is a *reading*, taken now, and it can differ from what the running
 * daemon bound if an interface has come or gone since. That is stated in the output rather than
 * glossed, and `ss -tln` remains the only thing that reports what is actually open.
 */
async function listen(config: Awaited<ReturnType<typeof loadConfig>>['config'], asJson: boolean): Promise<number> {
  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });

  const links = await platform.net.links().catch(() => null);
  /*
   * `null`, not `[]`, when the radios cannot be enumerated — the same distinction the daemon draws.
   * An empty list claims the driver was asked and reported no radios, which makes every radio look
   * like a wire; `null` says nobody could ask, and the classifier then refuses to guess which
   * `ether` links are wires. Reporting the wrong one of those here would describe a device as
   * reachable on a surface it is not.
   */
  const radios = await platform.wifi
    .interfaces()
    .then((entries) => entries.map((entry) => entry.name).filter((name): name is string => name !== null))
    .catch(() => null);
  const addresses = await platform.net.addresses().catch(() => null);

  let recorded: { accessPoint: string | null; uplinks: string[]; tunnels: string[] } | null = null;
  let onUplinkNetwork = true;
  let database: ReturnType<typeof openDatabase> | null = null;
  try {
    database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
    const store = createStore(database);
    recorded = store.device().managementSurfaces;
    const profileId = store.device().activeProfileId;
    if (profileId !== null) {
      const secretPlan = createSecretPlan();
      const document = createProfileStore(database, secretPlan, () => {}).get(profileId)?.document as
        | { services?: { management?: { onUplinkNetwork?: boolean } } }
        | undefined;
      // Read defensively and default to on: `undefined` is the owner's requirement, and a throw here
      // would make the command that reports reachability the reason it cannot be reported.
      onUplinkNetwork = document?.services?.management?.onUplinkNetwork !== false;
    }
  } catch {
    /* No database is a device that has never run. The policy still answers from the links alone. */
  }

  const notes: string[] = [];
  if (links === null) notes.push('the interface list could not be read, so no local channel could be decided');
  if (radios === null) notes.push('the radio list could not be read, so no ether link is assumed to be a wire');
  if (addresses === null) notes.push('the address list could not be read, so interface names were not resolved');
  if (recorded === null) notes.push('no profile has been applied, so only the link shape decided this');

  const decision =
    links === null
      ? { bind: [] as string[], refused: [], withheld: [] }
      : localChannelsFor({
          links,
          radios,
          managementSurfaces: recorded,
          profileTunnelInterfaces: recorded?.tunnels ?? [],
          onUplinkNetwork,
        });

  // The same composition the listener set performs: the operator's pinned names and the policy's,
  // as one list, resolved against the addresses the kernel reports now.
  const effective = { ...config.listen, interfaces: [...new Set([...config.listen.interfaces, ...decision.bind])] };
  const resolved =
    addresses === null
      ? { bind: [...config.listen.addresses], unresolved: effective.interfaces }
      : resolveBindAddresses(effective, addresses);

  if (asJson) {
    /*
     * `port`, `addresses` and `interfaces` keep their old meaning — the configured block — because
     * something already parses them. The resolved answer is added under names of its own rather than
     * by redefining those three, so an older reader keeps getting what it expects instead of
     * silently getting something else.
     */
    process.stdout.write(
      `${JSON.stringify({
        port: config.listen.port,
        addresses: config.listen.addresses,
        interfaces: config.listen.interfaces,
        boundInterfaces: decision.bind,
        boundAddresses: resolved.bind,
        unresolvedInterfaces: resolved.unresolved,
        refusedInterfaces: decision.refused,
        withheldInterfaces: decision.withheld.map((entry) => entry.name),
        notes,
      })}\n`,
    );
    database?.close();
    return 0;
  }

  const lines = [
    `port                 ${config.listen.port}`,
    `configured addresses ${config.listen.addresses.join(' ') || '(none)'}`,
    `configured interfaces ${config.listen.interfaces.join(' ') || '(none)'}`,
    `local channels       ${decision.bind.join(' ') || '(none)'}`,
    `would bind           ${resolved.bind.join(' ') || '(none)'}`,
  ];
  if (resolved.unresolved.length > 0) {
    lines.push(`no address yet       ${resolved.unresolved.join(' ')}`);
  }
  if (decision.withheld.length > 0) {
    lines.push(`withheld by profile  ${decision.withheld.map((entry) => entry.name).join(' ')}`);
  }
  if (decision.refused.length > 0) {
    // Never routine. Reaching this means something classified a tunnel as a local channel.
    lines.push(`REFUSED              ${refusalSummary(decision.refused)}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  for (const note of notes) process.stdout.write(`note: ${note}\n`);
  process.stdout.write(
    '\nThis is a reading taken now, not a report from the running daemon. What is actually open:\n' +
      `  ss -tln | grep :${config.listen.port}\n`,
  );

  database?.close();
  return 0;
}

async function credentials(
  config: Awaited<ReturnType<typeof loadConfig>>['config'],
  args: string[],
): Promise<number> {
  if (args[0] !== 'reset') {
    process.stderr.write('way credentials reset\n');
    return 2;
  }
  const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
  const store = createStore(database);
  // Clearing the hash re-arms the forced change: the daemon then accepts the documented default
  // once and refuses every route but the password change until a new one is set.
  database.raw.prepare('UPDATE device SET admin_password_hash = ?, setup_complete = 0, updated_at = ? WHERE id = 1').run(
    '',
    new Date().toISOString(),
  );
  store.recordEvent({ level: 'warn', kind: 'auth.credentials-reset', summary: 'admin credentials reset from the CLI' });
  database.close();
  process.stdout.write(
    'Credentials reset. The documented default password is accepted once, and the interface will\n' +
      'refuse everything except changing it.\n',
  );
  return 0;
}

void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`way: ${String(error)}\n`);
    process.exit(1);
  },
);

/* ── revert ──────────────────────────────────────────────────────────────────────────────── */

/**
 * What the transient timer runs when a confirmation window expires.
 *
 * A **fresh process**, deliberately. If the daemon crashed after applying a bad change — or if it was
 * the bad change — an in-process timer would be gone with it. So this path shares nothing with the
 * running daemon: it opens the database, plans through the same pipeline, and reconciles. It must work
 * when the HTTP surface does not, which is the whole reason the CLI exists.
 *
 * It is also safe to run twice. The timer can fire while an operator is asking for the same revert and
 * while a start-up sweep is deciding to do it, and all three must be able to happen.
 */
/**
 * The planning context, assembled the same way for every command that needs one.
 *
 * Extracted rather than copied. The candidate lists below are claims about the host, and the one
 * thing this project does not do is assume the host — so a second copy that drifted would mean two
 * commands disagreeing about what is on the device they are both looking at.
 */
async function pipelineFor(
  config: Awaited<ReturnType<typeof loadConfig>>['config'],
  platform: ReturnType<typeof createPlatform>,
  database: ReturnType<typeof openDatabase>,
): Promise<{ store: ReturnType<typeof createStore>; profiles: ReturnType<typeof createProfileStore>; pipeline: PipelineContext }> {
  const store = createStore(database);
  const profiles = createProfileStore(database, createSecretPlan());
  const boundAddresses = config.listen.addresses;

  // The daemon's own constructor, captured resolvers included. It was hand-built here and left them
  // out, so `way drift` and the drift event after a timer revert compared against the profile's
  // starting value and reported a divergence the daemon did not see.
  const pipeline: PipelineContext = devicePipeline({ platform, config, boundAddresses: () => boundAddresses });

  return { store, profiles, pipeline };
}


/**
 * `way debug …` — things an operator needs when the ordinary route is unavailable.
 */
async function debugCommand(
  config: Awaited<ReturnType<typeof loadConfig>>['config'],
  args: string[],
): Promise<number> {
  const [what] = args;
  if (what === 'expose-core-api') return await exposeCoreApi(config);
  process.stderr.write('way debug expose-core-api\n');
  return 2;
}

/**
 * How to reach the proxy core's own dashboard when this daemon cannot proxy it.
 *
 * **It does not expose anything**, and the name is kept because the documentation and the plan both use
 * it. What it does is tell an operator how to reach a loopback-bound control API from their own machine,
 * and confirm that the thing they are about to tunnel to is actually listening.
 *
 * The earlier intention — "binds it to the LAN until the next restart" — is deliberately not
 * implemented. That API has no authentication of its own and full control over routing: a command that
 * put it on a routable address would be handing anyone on the network the ability to redirect every
 * client's traffic, for the convenience of not typing an SSH flag. The escape hatch this exists for is a
 * **core that is healthy while our daemon is not**, and an SSH port-forward serves that case exactly as
 * well without leaving a hole behind that outlives the debugging session.
 */
async function exposeCoreApi(config: Awaited<ReturnType<typeof loadConfig>>['config']): Promise<number> {
  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
  const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
  try {
    const { store, profiles } = await pipelineFor(config, platform, database);
    const activeId = store.device().activeProfileId;
    const document = activeId === null ? null : (profiles.get(activeId)?.document as Record<string, unknown> | null);
    const services = (document?.['services'] ?? {}) as { clashApi?: { enabled?: boolean; bind?: string } };
    const bind = services.clashApi?.bind ?? '127.0.0.1:9090';
    const enabled = services.clashApi?.enabled !== false;

    process.stdout.write(`core control API   ${bind}${enabled ? '' : '  (disabled in the active profile)'}\n`);

    // Verified rather than assumed: the address in a profile is an intention, and the operator is about
    // to spend a minute setting up a tunnel to it.
    const [host, portText] = bind.split(':');
    const listening = await platform.net
      .routeTo(host ?? '127.0.0.1')
      .then(() => true)
      .catch(() => false);
    const core = await platform.systemd.state('wf-core.service').catch(() => null);
    process.stdout.write(`wf-core.service    ${core?.activeState ?? 'unknown'}/${core?.subState ?? 'unknown'}\n`);
    if (core?.isActive !== true) {
      process.stdout.write(
        '\nThe core is not running, so there is nothing listening to reach. Start it, or read its log:\n' +
          '  journalctl -u wf-core.service -b\n',
      );
      return 1;
    }
    if (!listening) process.stdout.write('the bind address could not be resolved locally\n');

    process.stdout.write(
      '\nIt is bound to loopback and this command will not move it. Forward it from your own machine:\n\n' +
        `  ssh -L ${portText ?? '9090'}:${bind} <this device>\n\n` +
        `then open http://127.0.0.1:${portText ?? '9090'} there.\n\n` +
        'Why it is not exposed for you: that API has no authentication of its own and full control over\n' +
        'routing. Putting it on a routable address would let anyone on the network redirect every\n' +
        "client's traffic, and it would outlive the debugging session that seemed to justify it.\n",
    );
    return 0;
  } finally {
    database.close();
    platform.close?.();
  }
}

/**
 * Factory reset, and the dry run that prints the very same plan.
 *
 * The plan is built once and either printed or executed. That is the point: a dry run that described the
 * reset separately would be a second description, and the one operation with no undo is the worst place
 * in this project for a description that has stopped matching.
 */
async function factoryReset(
  config: Awaited<ReturnType<typeof loadConfig>>['config'],
  options: { execute: boolean; dryRun: boolean },
): Promise<number> {
  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
  try {
    const { coreUnit, templateUnits } = await import('./core/generate/units.ts');
    const generatedUnits = [
      coreUnit({ binaryPath: '/usr/bin/sing-box' }),
      ...templateUnits({ upScript: '/opt/wayfarer/bin/tunnel-up' }),
    ].map((unit) => unit.name);

    // Instances are discovered, because a template does not name them and a reset that only acted on
    // the templates would leave every running instance behind.
    const liveInstances = await platform.systemd.listOwnedUnits('wf-').catch(() => [] as string[]);

    /*
     * Discovered from the disk, not from our records: this operation deletes the transaction table,
     * which is where a takeover's undo is written. Reading it here would find nothing at the exact
     * moment it matters — see `findMovedAside`.
     */
    const movedAside = await platform.files.findMovedAside([
      '/etc/netplan',
      '/etc/systemd/network',
      '/etc/NetworkManager/system-connections',
    ]);

    const plan = factoryResetPlan({
      generatedUnits,
      liveInstances,
      movedAside,
      stateDir: config.stateDir,
    });

    // Refused whole rather than partly run, and before anything is touched.
    assertResetPlanIsOurs(plan);

    process.stdout.write('A factory reset would do exactly this, in this order:\n\n');
    for (const step of plan) {
      const detail = step.kind === 'create-path' ? ` (mode ${step.mode.toString(8)})` : '';
      process.stdout.write(`  ${step.kind.padEnd(16)} ${step.target}${detail}\n      ${step.why}\n`);
    }
    process.stdout.write('\nIt will NOT touch:\n');
    for (const entry of FORBIDDEN) process.stdout.write(`  ${entry.prefix.padEnd(28)} ${entry.why}\n`);

    if (!options.execute) {
      process.stdout.write(
        options.dryRun
          ? '\nDry run: nothing was changed.\n'
          : '\nNothing was changed. Re-run with --yes to do it. There is no undo.\n',
      );
      return 0;
    }

    process.stdout.write('\nProceeding.\n');
    let failures = 0;
    for (const step of plan) {
      const outcome = await runResetStep(platform, step).catch((error: unknown) => String(error));
      const ok = outcome === null;
      if (!ok) failures += 1;
      process.stdout.write(`  ${ok ? ' ok ' : 'FAIL'}  ${step.kind} ${step.target}${ok ? '' : ` — ${outcome}`}\n`);
    }

    process.stdout.write(
      failures === 0
        ? '\nDone. This device is as it was immediately after installation: no profile, no configuration,\n' +
          'no state. The installation itself is untouched and the daemon will start with defaults.\n'
        : `\nDone with ${failures} step(s) that did not succeed — read the lines marked FAIL above.\n`,
    );
    return failures === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`factory reset refused: ${String(error)}\n`);
    return 1;
  } finally {
    platform.close?.();
  }
}

/**
 * One step, or a message saying why it did not happen. `null` means it did.
 *
 * Everything here goes through the platform layer. That is the architecture's rule and this is the worst
 * place to break it: a factory reset is a rescue path, and the platform layer is where the traps are
 * recorded — that `mkdir`'s mode is subject to the umask, that a unit which is not loaded is already
 * stopped, that restarting your own unit can kill you before the call returns. An earlier version of
 * this function shelled out and touched the filesystem directly in three places, which put those traps
 * outside the layer that knows about them.
 */
async function runResetStep(
  platform: ReturnType<typeof createPlatform>,
  step: ResetStep,
): Promise<string | null> {
  switch (step.kind) {
    case 'stop-unit': {
      /*
       * A unit that is not loaded is already stopped, which is the state being asked for.
       *
       * systemd reports it by **throwing** — `DBusError: Unit wf-core.service not loaded.` — not by
       * returning a result, so testing only the returned string missed it. Measured on the bench board,
       * 2026-09-21: a second factory reset on a device whose units had already been removed reported
       * five failures and exited non-zero for a job it had done perfectly. A script reading that exit
       * code would conclude the reset was broken.
       *
       * Same principle as a transient timer that no longer exists: the goal is the state, not the call.
       */
      const result = await platform.systemd
        .stop(step.target)
        .catch((error: unknown) => ({ result: String(error) }));
      const absent = /not loaded|not found|no such unit/i.test(result.result);
      return result.result === 'done' || absent ? null : result.result;
    }
    case 'disable-unit':
      await platform.systemd.disable(step.target).catch(() => undefined);
      return null;
    case 'unmask-unit':
      await platform.systemd.unmask(step.target).catch(() => undefined);
      return null;
    case 'remove-nft-table':
      {
        const [family, name] = step.target.split(' ');
        const result = await platform.nft.deleteTable(family!, name!);
        return result.ok ? null : result.message;
      }
      return null;
    case 'restore-aside':
      await platform.files.restoreAside({ from: step.target.replace(/\.disabled-by-wayfarer$/, ''), to: step.target });
      return null;
    case 'restart-daemon':
      // Detached by name, so the trade-off — no result can be read, because the restart may kill this
      // process first — is a property of the platform call rather than a comment at the call site.
      platform.systemd.restartDetached(step.target);
      return null;

    case 'create-path':
      await platform.files.createDirectory(step.target, step.mode);
      return null;
    case 'remove-path': {
      if (step.target.includes('*')) {
        // The one glob in the plan: our own files inside a directory shared with other software.
        const directory = step.target.slice(0, step.target.lastIndexOf('/'));
        const fragment = step.target.slice(step.target.lastIndexOf('/') + 1).replace(/\*/g, '');
        await platform.files.removeMatchingEntries(directory, fragment);
        return null;
      }
      await platform.files.removePath(step.target);
      return null;
    }
  }
}

/**
 * Why this device is, or is not, in safe mode.
 *
 * Exists for the operator question "why has my device stopped using its tunnels", which is otherwise
 * answerable only by reading the event ring and counting transaction rows by hand. It prints the same
 * decision the daemon makes, from the same inputs, so an answer here is the answer.
 */
async function safeModeStatus(config: Awaited<ReturnType<typeof loadConfig>>['config']): Promise<number> {
  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
  const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
  try {
    const { store, profiles } = await pipelineFor(config, platform, database);
    const activeId = store.device().activeProfileId;
    if (activeId === null) {
      process.stdout.write('no active profile, so there is nothing to be in safe mode about\n');
      return 0;
    }
    const profile = profiles.get(activeId);
    if (profile === null) {
      process.stdout.write(`the active profile ${activeId} is missing from the database\n`);
      return 1;
    }

    const attempts = profiles.recentAttempts(activeId);
    const decision = safeModeDecision({ attempts, profileRevision: profiles.profileRevision(activeId) ?? 0 });
    const running = profiles.lastAppliedDocument();
    const state = safeModeState((running ?? null) as never, profile.document as never);

    process.stdout.write(`profile          ${profile.name} (${activeId})\n`);
    process.stdout.write(`last edited      ${profile.updatedAt}\n`);
    process.stdout.write(`consecutive fail ${decision.failures} of ${SAFE_MODE_THRESHOLD} needed\n`);
    process.stdout.write(`would enter      ${decision.enter ? 'yes' : 'no'}\n`);
    process.stdout.write(
      `in safe mode now ${
        state === 'in-safe-mode'
          ? 'yes'
          : state === 'nothing-to-disable'
            ? 'no — and this profile has no tunnels and no kill-switch, so safe mode would change nothing'
            : 'no'
      }\n`,
    );
    if (decision.reason !== null) process.stdout.write(`reason           ${decision.reason}\n`);
    process.stdout.write('\nrecent attempts, newest first — a success or an edit ends the run:\n');
    for (const attempt of attempts.slice(0, 8)) {
      const counted = Date.parse(attempt.at) >= Date.parse(profile.updatedAt);
      process.stdout.write(`  ${attempt.at}  ${attempt.state.padEnd(16)}${counted ? '' : '(before the last edit)'}\n`);
    }
    return 0;
  } finally {
    database.close();
    platform.close?.();
  }
}

/**
 * The first boot guard: refresh the artefacts that encode **this device's environment**.
 *
 * What it re-derives is the discovered half of a plan — the addresses and networks read off the
 * device — not the profile. The profile is replanned in the ordinary sense only so that the
 * generators can run; nothing but the allowlisted artefacts is written, no unit is installed and
 * nothing is started or stopped.
 *
 * Exit codes are the contract with systemd: non-zero means the core must not start.
 */
async function rederive(config: Awaited<ReturnType<typeof loadConfig>>['config']): Promise<number> {
  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
  const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
  try {
    const { store, profiles, pipeline } = await pipelineFor(config, platform, database);

    /*
     * The document the data plane is actually running, which is the newest **committed** one — not
     * the stored profile, which may have unapplied edits. Re-deriving from an edit nobody confirmed
     * would apply it by the back door, at boot, with no confirmation window.
     */
    const document = profiles.lastAppliedDocument();
    if (document === null) {
      process.stdout.write('rederive: nothing has been applied on this device, so there is nothing to refresh\n');
      return 0;
    }

    const planned = await planDocument(pipeline, document as never);
    const generated = planned.plan.desired.files.map((file) => ({ path: file.path, content: file.content }));

    /*
     * Which artefacts this guard may rewrite, taken from the mark the generators carry rather than
     * from a list kept here.
     *
     * A list here would be a copy of a truth that lives somewhere else, and a copy stops matching the
     * thing it copies: the day somebody adds another environment-dependent artefact, it would simply
     * not be re-derived, and the symptom would be a board unreachable after a reboot on a new network
     * — this guard's own blind spot producing the exact defect it exists to prevent.
     */
    const allowed = planned.plan.desired.files
      .filter((file) => file.environmentDependent === true)
      .map((file) => file.path);

    const onDisk = new Map<string, string>();
    for (const path of allowed) {
      const current = await platform.files.readManaged(path).catch(() => null);
      if (current !== null) onDisk.set(path, current);
    }

    const decision = decideRederive({ generated, onDisk, allowed });

    for (const artefact of decision.toWrite) {
      // The same atomic path every managed file takes: written beside and renamed, never truncated
      // in place. A boot-time rewrite interrupted by a power cut must not leave a half file that the
      // core then refuses to parse.
      await platform.files.writeAtomic(artefact.path, artefact.content, { mode: 0o600 });
      process.stdout.write(`rederive: rewrote ${artefact.path}\n`);
      store.recordEvent({
        level: 'warn',
        kind: 'boot.rederived',
        summary: `${artefact.path} encoded a different environment and was re-derived at boot`,
        detail: { path: artefact.path },
      });
    }

    process.stdout.write(
      `rederive: ${decision.considered.length} artefact(s) checked, ${decision.unchanged} unchanged, ` +
        `${decision.toWrite.length} rewritten\n`,
    );
    return 0;
  } catch (error) {
    // Loud and non-zero. The core's `Requires=` turns this into "the tunnel does not come up", which
    // is the intended outcome: a device with no tunnel can be fixed from the network.
    process.stderr.write(`rederive failed, so the core must not start: ${String(error)}\n`);
    return 1;
  } finally {
    database.close();
    platform.close?.();
  }
}

/**
 * The second boot guard: can this device still reach the networks it is itself on?
 *
 * Asked of the device alone, with no external peer, because a reachability test against an outside
 * host cannot distinguish our fault from the network's — and would therefore be ambiguous exactly
 * when it mattered.
 */
async function checkRoutes(
  config: Awaited<ReturnType<typeof loadConfig>>['config'],
  stopCoreOnCapture: boolean,
  waitForTunnelSeconds = 0,
): Promise<number> {
  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
  const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
  try {
    const store = createStore(database);

    const tunnelsIn = (snapshot: Awaited<ReturnType<typeof platform.net.snapshot>>): string[] =>
      // Read from the live link list rather than assumed from a name, so a renamed or additional
      // tunnel is still seen.
      snapshot.links.filter((link) => link.kind === 'tun' || /^tun\d+$/.test(link.name)).map((link) => link.name);

    /*
     * Wait for the tunnel before concluding there is not one.
     *
     * `After=wf-core.service` means after the *unit* started, and the core creates its tun device a
     * moment later. Measured on the bench board, 2026-09-20: at boot this check ran first and
     * reported "no tunnel device exists, so nothing can be captured" — a pass, every time, before the
     * thing it exists to catch had been created. A backstop that always passes is worse than none,
     * because it is also reassuring.
     *
     * Waiting and finding nothing is still a pass: a device with no tunnel genuinely cannot be
     * captured by one.
     */
    let snapshot = await platform.net.snapshot();
    let tunnelDevices = tunnelsIn(snapshot);
    for (let waited = 0; tunnelDevices.length === 0 && waited < waitForTunnelSeconds; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      snapshot = await platform.net.snapshot();
      tunnelDevices = tunnelsIn(snapshot);
    }

    if (tunnelDevices.length === 0) {
      process.stdout.write(
        `check-routes: no tunnel device appeared within ${waitForTunnelSeconds}s, so nothing can be captured\n`,
      );
      return 0;
    }

    /*
     * Networks reached through a **real** interface. The tunnel's own transfer network is excluded,
     * and it has to be: an address on `tun0` routes through `tun0`, which is correct and is not a
     * capture. Measured on the bench board — without this the check failed every time and would have
     * stopped the core at every boot, which is the most expensive possible way to be wrong about a
     * guard whose whole purpose is keeping the device reachable.
     */
    const tunnelSet = new Set(tunnelDevices);
    const held = snapshot.addresses.filter(
      (entry) => entry.family === 'inet' && entry.name !== 'lo' && !tunnelSet.has(entry.name),
    );
    const observations = [];
    for (const entry of held) {
      // A neighbour on that network, never our own address: the kernel resolves our own to `lo`, which
      // would make this check pass on a captured device exactly as happily as on a healthy one.
      const gateway =
        snapshot.routes.find((route) => route.device === entry.name && route.gateway !== null)?.gateway ?? null;
      const probe = probeAddressFor({ address: entry.address, prefixLength: entry.prefixLength, gateway });
      if (probe === null) continue;
      const resolved = await platform.net.routeTo(probe);
      observations.push({ address: probe, heldOn: entry.name, routesVia: resolved?.device ?? null });
    }

    if (observations.length === 0) {
      process.stdout.write('check-routes: no network with a neighbour to ask about\n');
      return 0;
    }

    const result = assertNoSelfCapture({ observations, tunnelDevices });
    for (const observation of observations) {
      process.stdout.write(`check-routes: ${observation.address} on ${observation.heldOn} -> ${observation.routesVia ?? 'unreadable'}\n`);
    }

    if (result.ok) {
      process.stdout.write(`check-routes: ${observations.length} address(es) checked, none captured\n`);
      return 0;
    }

    for (const finding of result.findings) process.stderr.write(`check-routes: ${finding.message}\n`);
    store.recordEvent({
      level: 'error',
      kind: 'boot.self-capture',
      summary: 'the tunnel captured a network this device is on; the core was stopped',
      detail: { findings: result.findings },
    });

    if (stopCoreOnCapture) {
      const stopped = await platform.systemd.stop('wf-core.service').catch((error: unknown) => ({ result: String(error) }));
      process.stderr.write(`check-routes: stopping wf-core.service — ${JSON.stringify(stopped)}\n`);
    }
    return 1;
  } catch (error) {
    process.stderr.write(`check-routes could not complete: ${String(error)}\n`);
    return 1;
  } finally {
    database.close();
    platform.close?.();
  }
}

async function revert(config: Awaited<ReturnType<typeof loadConfig>>['config'], args: string[]): Promise<number> {
  const index = args.indexOf('--txn');
  const id = index >= 0 ? args[index + 1] : undefined;
  if (id === undefined || id === '') {
    process.stderr.write('way revert --txn <id>\n');
    return 2;
  }

  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
  const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
  try {
    const { store, profiles, pipeline } = await pipelineFor(config, platform, database);

    const deps: ApplyDeps = {
      platform,
      profiles,
      store,
      pipeline,
      /*
       * A revert run by the transient timer happens in this process, not in the daemon's, so the
       * comparison that follows it has to be constructed here too.
       *
       * **Corrected 2026-09-23.** This said the report reached the daemon's `GET /api/drift` through
       * the event ring. It did not: the ring got an event, and `/api/drift` served the daemon's own
       * in-memory report, which went on showing a finding this revert had resolved. The report is now
       * written to `device.last_drift` with the boot id and uptime it was made at, and the daemon serves
       * whichever stored report is newest (`DriftMonitor.current`). The pipeline is the daemon's own
       * constructor, so the comparison is the daemon's too — captured resolvers included.
       */
      drift: createDriftMonitor({
        profiles,
        store,
        pipeline,
        log: (level, fields, message) => {
          process.stderr.write(`way revert [${level}] ${message} ${JSON.stringify(fields)}\n`);
        },
      }),
      timeSyncUnit: config.timeSyncUnit,
      wayBinary: config.wayBinary,
      // Straight to standard error, because there is no logger here and the journal is where a timer's
      // output goes. A revert that says nothing is a revert nobody can audit.
      log: (level, fields, message) => {
        process.stderr.write(`way revert [${level}] ${message} ${JSON.stringify(fields)}\n`);
      },
      // Wakes the daemon's resolver follower, which waited while this window was open. This process
      // has no follower of its own, and a second one would race the daemon's. See `core/transaction-ended.ts`.
      transactionEnded: signalDaemonOnEnd(platform.systemd, config.unitName, (message) => {
        process.stderr.write(`way revert [info] ${message}\n`);
      }),
      recoveryDocument: async () => {
        const activeId = store.device().activeProfileId;
        const current = activeId === null ? null : (profiles.get(activeId)?.document ?? null);
        return await buildRecoveryDocument({
          platform,
          inventory: async () => await collectInventory(platform),
          current: current as never,
          fallbackSsid: DEFAULT_AP_SSID,
          fallbackPassphrase: DEFAULT_AP_PASSPHRASE,
        });
      },
    };

    const outcome = await revertTransaction(deps, id, 'the confirmation window expired without a confirmation');
    process.stdout.write(`${outcome.message}\n`);
    process.stdout.write(`went back to: ${outcome.target}\n`);
    for (const entry of outcome.restored) {
      process.stdout.write(`  ${entry.outcome}: ${entry.from}${entry.why ? ` — ${entry.why}` : ''}\n`);
    }
    if (outcome.result) {
      for (const step of outcome.result.steps) {
        process.stdout.write(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.step} — ${step.detail}\n`);
      }
    }
    return outcome.ok ? 0 : 1;
  } finally {
    database.close();
    platform.close();
  }
}

/**
 * Does what is on this device match what the stored profile says it should be?
 *
 * The operator-facing half of the check the daemon runs at boot, after every revert and every
 * fifteen minutes. It exists as a command as well as an endpoint because the case it is most needed
 * in is the one where the panel is not reachable, and because a person who has just been told their
 * committed change vanished wants to ask the question themselves rather than wait for a round.
 *
 * Non-zero on a divergence, so it can be used as a check rather than only read.
 */
async function drift(config: Awaited<ReturnType<typeof loadConfig>>['config'], asJson: boolean): Promise<number> {
  const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
  const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
  try {
    const { store, profiles, pipeline } = await pipelineFor(config, platform, database);
    // Stored like every other comparison, so the daemon serves this reading too. See `operatorDrift`.
    const report = await operatorDrift({ store, profiles, pipeline });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${summarise(report)}\n`);
      process.stdout.write(
        `checked ${report.checked.files} file(s), ${report.checked.units} unit(s), ` +
          `${report.checked.sysctl} kernel setting(s) in ${report.durationMs} ms\n`,
      );
      for (const finding of report.findings) {
        process.stdout.write(`\n  ${finding.subject}${finding.pointer === null ? '' : ` ${finding.pointer}`}\n`);
        process.stdout.write(`    profile: ${finding.stored ?? 'nothing'}\n`);
        process.stdout.write(`    device : ${finding.running ?? 'nothing'}\n`);
        process.stdout.write(`    ${finding.hint}\n`);
      }
      if (report.omitted > 0) process.stdout.write(`\n  and ${report.omitted} more, not listed\n`);
    }
    // `unreadable` is not a pass. A check that could not be made must not exit zero, or a caller that
    // only reads the exit code learns "healthy" from "I could not look".
    return report.state === 'converged' || report.state === 'no-profile' ? 0 : 1;
  } finally {
    database.close();
    platform.close?.();
  }
}

async function transactions(config: Awaited<ReturnType<typeof loadConfig>>['config']): Promise<number> {
  const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
  try {
    const profiles = createProfileStore(database, createSecretPlan());
    const rows = profiles.recentTransactions(20);
    if (rows.length === 0) {
      process.stdout.write('no transactions recorded\n');
      return 0;
    }
    // The uptime the window's timer is anchored to; `null` when unreadable, which windowCountdown
    // reports as no number rather than a guess.
    const platform = createPlatform({ cacheDir: config.cacheDir, paths: config.paths });
    const uptime = await platform.host.uptimeSeconds().catch(() => null);
    platform.close?.();
    for (const row of rows) {
      process.stdout.write(transactionLine(row, uptime, new Date()));
    }
    // Said plainly rather than left to be inferred from a state name: the device is running something
    // other than what the active profile says, and the operator is entitled to know why their interface
    // is showing pending changes.
    const reverted = rows.find((row) => row.state === 'reverted');
    if (reverted !== undefined && rows.indexOf(reverted) === 0) {
      process.stdout.write(
        '\nThe most recent transaction was REVERTED, so this device is running the previous\n' +
          'configuration rather than what the active profile says. That is why the interface shows\n' +
          `pending changes. Reason: ${reverted.reason ?? 'not recorded'}\n`,
      );
    }
    return 0;
  } finally {
    database.close();
  }
}
