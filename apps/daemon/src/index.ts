/**
 * Daemon entry point.
 *
 * The control plane must be reachable in exactly the situations where a router is normally
 * unreachable, so this process depends on as little as possible: no proxy core, no tunnel, and
 * no network configuration of its own in this epic. It reads state, serves it, and stays up.
 */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pino } from 'pino';
import { loadConfig, resolveBindAddresses, type DaemonConfig } from './config.ts';
import {
  localChannelsFor,
  managementChannels,
  managementSurfacesChanged,
  refusalSummary,
} from './api/bind-policy.ts';
import { createPlatform, type Platform } from './platform/index.ts';
import { createNotifier } from './platform/notify.ts';
import { unreadableRadiosSummary, wirelessRolesFrom, type WirelessRoles } from './api/wireless-roles.ts';
import { openDatabase } from './state/db.ts';
import { createStore } from './state/store.ts';
import { createTelemetry } from './telemetry/index.ts';
import { buildServer, type ServerContext } from './api/server.ts';
import { createListenerSet, type AddressReading } from './api/listeners.ts';
import { createProfileStore } from './state/profiles.ts';
import { createSecretPlan } from './state/secret-plan.ts';
import { collectFacts, collectReality } from './platform/facts.ts';
import { collectInventory } from './inventory/index.ts';
import type { PipelineContext } from './core/pipeline.ts';
import {
  applyDocument,
  buildRecoveryDocument,
  recordWindowFinding,
  sweepUnconfirmed,
  type ApplyDeps,
} from './core/apply.ts';
import { createWindowWatch } from './core/window-watch.ts';
import { createDriftMonitor, DRIFT_INTERVAL_MS } from './core/drift.ts';
import { ruleSetAgesFor } from './core/rule-set-age.ts';
import { emptyProfile, type ProfileDocument as ProfileDocumentType } from '@wayfarer/schemas';
import { createWatchdog, deviceGuards, observeWatchdog } from './core/watchdog.ts';
import { createLivenessMeter, KEEPALIVE_STATUS_SECONDS } from './core/liveness.ts';
import { openVpnUnit } from './core/catalogue/openvpn.ts';
import { deviceLivenessReaders } from './platform/tunnel-readings.ts';
import {
  CAPTURED_RESOLVER_DIR,
  readCapturedResolvers,
} from './platform/captured-resolvers.ts';
import { CLAIM_DIRECTORIES, CORE_CANDIDATES, devicePipeline } from './core/device-pipeline.ts';
import { followDevice } from './core/device-follower.ts';
import { observeAddresses } from './core/address-watch.ts';
import { createObserverRegistry } from './core/observers.ts';
import { observeCapturedResolvers } from './core/resolver-watch.ts';
import { listenForTransactionsEndedElsewhere } from './core/transaction-ended.ts';
import { readStamp } from './core/credential-expiry.ts';
import { createCoreApi } from './platform/core-api.ts';
import { CORE_TAGS } from './core/generate/core-config.ts';
import { PATHS } from './core/desired-state.ts';
import { DEFAULT_AP_PASSPHRASE, DEFAULT_AP_SSID } from './config.ts';

const VERSION = '0.1.0-epic-a';

async function main(): Promise<void> {
  const loaded = await loadConfig();
  const config = loaded.config;

  const logger = pino({
    level: config.logLevel,
    // The journal adds its own timestamp and the daemon's identifier, so pino's defaults would
    // duplicate both in every line of a 200 MB RAM budget.
    base: null,
    timestamp: false,
  });

  logger.info(
    { source: loaded.source, warnings: loaded.warnings, version: VERSION, runtime: process.version },
    'wayfarer starting',
  );
  for (const warning of loaded.warnings) logger.warn({ warning }, 'configuration warning');

  const database = openDatabase({ path: `${config.stateDir}/wayfarer.db` });
  const store = createStore(database);
  const platform = createPlatform({
    cacheDir: config.cacheDir,
    paths: config.paths,
  });
  const telemetry = createTelemetry(platform);
  /**
   * Where the secrets in a profile are. Derived from the document schema, so it needs nothing from
   * the device — and nothing about a tunnel's configuration is opaque to it any more.
   *
   * It used to be built from the installed core's schema, and a device whose core had not been
   * unpacked could not store a profile with tunnels at all. Schema version 7 types every catalogue
   * configuration, so the credentials are declared in this project's own schema and the coverage no
   * longer depends on a binary. See `state/secret-plan.ts`.
   */
  const secretPlan = createSecretPlan();
  /*
   * A migration can change what a stored configuration *means*, so the operator is told.
   *
   * The blocked-endpoint step is why this exists rather than being tidy: it carries a suffix meaning
   * forward into an explicit routing rule, and an operator who is never told that their profile gained a
   * rule has no way to notice — nor to know that without it their block had quietly narrowed.
   */
  const profiles = createProfileStore(database, secretPlan, (event) => {
    store.recordEvent({
      level: 'warn',
      kind: 'profile.migrated',
      summary:
        `profile "${event.name}" was upgraded from schema version ${event.from}: ` +
        `${event.applied.join('; ')}. Review it before the next apply.`,
      detail: event,
    });
    logger.warn(event, 'a stored profile was migrated on read');
  });

  /**
   * Which units might be a proxy core this device did not start, and which directories another network
   * manager may claim an interface in.
   *
   * Configuration rather than constants at the call site: both are claims about the host, and the one
   * thing this project does not do is assume the host. A device where the distribution names these
   * differently is a configuration change, not a code change.
   */
  const coreCandidates = CORE_CANDIDATES;
  const claimDirectories = CLAIM_DIRECTORIES;

  // Log lines the interface tails come from the same stream that goes to the journal, so what
  // the interface shows and what `journalctl` shows cannot disagree.
  const forwardToTelemetry = (level: string, msg: string): void => {
    telemetry.recordLog({ level, msg, at: new Date().toISOString() });
  };

  const buildAt = await readBuildStamp();

  let logLevelRevert: NodeJS.Timeout | undefined;
  /**
   * When the raised log level goes back, as **seconds from the moment it was raised**.
   *
   * A duration rather than an instant, because the thing that performs the revert is a `setTimeout` —
   * which counts on libuv's monotonic clock and is unaffected by the wall clock. The previous version
   * recorded an ISO instant beside it, so a clock step during a debug session left the two describing
   * different moments: the session ended correctly and the reported expiry was wrong by the step.
   *
   * Paired with the monotonic reading taken when it was raised, so a remaining time can be derived
   * without consulting a clock at all.
   */
  let logLevelRevertWindow: { raisedAtMonotonicMs: number; afterSeconds: number } | null = null;

  /**
   * The wall-clock instant the raised log level is expected to end, derived at the moment of asking.
   *
   * Still a wall-clock string, because that is what a person reading the interface wants, but computed
   * **from the monotonic remainder** rather than stored. Stored, it was a second copy of a deadline the
   * `setTimeout` owned, and a clock step during a debug session left it describing a different moment
   * than the one the revert would happen at. Derived on read, the two cannot disagree by more than the
   * clock's error at the instant it is read.
   */
  const logLevelRevertsAt = (): string | null => {
    if (logLevelRevertWindow === null) return null;
    const elapsedMs = performance.now() - logLevelRevertWindow.raisedAtMonotonicMs;
    const remainingMs = Math.max(0, logLevelRevertWindow.afterSeconds * 1000 - elapsedMs);
    return new Date(Date.now() + remainingMs).toISOString();
  };

  /**
   * The planning pipeline and the transaction layer, built once.
   *
   * Handed to the API rather than constructed inside it, because the operator CLI and the start-up
   * sweep need the same ones. `docs/06` says a revert goes through exactly the same planner and
   * reconciler, and one shared object is what makes that true rather than aspirational.
   */
  // One constructor for the daemon and for `way`, so the two cannot derive different answers about
  // the same device — see `core/device-pipeline.ts` for the incident that made this one function.
  const pipeline: PipelineContext = devicePipeline({
    platform,
    config,
    boundAddresses: () => context.boundAddresses,
    /*
     * Every plan records the management surfaces it resolved.
     *
     * Written only when the value changed, because this runs on a dry run too and a write per plan would be a
     * write per look at the review screen.
     */
    onManagementSurfaces: (surfaces) => {
      if (!managementSurfacesChanged(store.device().managementSurfaces, surfaces)) return;
      store.setManagementSurfaces(surfaces);
      logger.info(surfaces, 'the management surfaces this profile resolves to');
    },
    /*
     * Every plan records which units each of its tunnels is made of.
     *
     * Written unconditionally rather than only on a change, unlike the surfaces above: the comparison
     * that makes that worthwhile there is a hand-written one, and a second hand-written comparison
     * over a list of lists is more to get wrong than a write of a few hundred bytes on the cadence
     * somebody looks at a plan review.
     *
     * The telemetry watch is updated from the same call, so the status view follows a dry run too.
     * That is deliberate: a plan review is exactly when somebody wants to know what the tunnels it
     * describes are currently doing.
     */
    onTunnelUnits: (tunnelUnits) => {
      store.setTunnelUnits(tunnelUnits);
      telemetry.watchTunnels(tunnelUnits);
    },
  });

  /**
   * The health checks that run during a confirmation window.
   *
   * Declared before `applyDeps` and given its dependencies afterwards, because the two refer to each
   * other: a finding is recorded through the apply layer, and a confirmation or revert stops the checks.
   * A finding never reverts — the window ends at the deadline the device reported.
   */
  const windowWatch = createWindowWatch({
    platform,
    log: (level, fields, message) => logger[level](fields, message),
    // Read fresh each tick rather than captured: the window can be closed by a confirmation, by the
    // transient timer, or by an operator asking for a revert, and none of those goes through here.
    stillOpen: (id) => profiles.transaction(id)?.state === 'awaiting-confirm',
    // A finding is recorded, never acted on: the window ends at the deadline it reported. See
    // `recordWindowFinding`.
    onFinding: async (id, finding) => {
      await recordWindowFinding(applyDeps, id, finding);
    },
  });

  /**
   * The check that asks whether this device is doing what its stored profile says.
   *
   * Created here, once, so that the three moments it runs at — boot, after a revert, and on its own
   * cadence — all publish into the same report. A second instance would give `GET /api/drift` a
   * different answer from the one the event ring recorded, which is two devices in one box.
   */
  /**
   * Every mechanism here that watches or waits for something in the world reports into this, so the
   * Status screen can say of each when it last looked, when it last acted, and whether it is running.
   * See `core/observers.ts` for why a mechanism that is silent while idle is indistinguishable from a
   * dead one.
   */
  const observers = createObserverRegistry();

  const ruleSetObserver = observers.register({
    name: 'rule-set-age',
    watches: 'how old this device’s copy of each rule set the routing points at is',
    everyMs: DRIFT_INTERVAL_MS,
  });
  /** The one reader of rule-set ages, shared by the drift round and the API, so both count as a look. */
  const readRuleSetAges = async (document: ProfileDocumentType): Promise<Awaited<ReturnType<typeof ruleSetAgesFor>>> => {
    const sets = await ruleSetAgesFor(document, {
      clockSynchronized: async () => (await platform.clock.status()).synchronized,
    });
    ruleSetObserver.looked(
      sets.length === 0
        ? 'the routing points at no rule set'
        : sets.map((set) => `${set.tag}: ${set.state}`).join('; '),
    );
    return sets;
  };

  const driftMonitor = createDriftMonitor({
    profiles,
    store,
    pipeline,
    log: (level, fields, message) => logger[level](fields, message),
    ruleSetAges: async (document) => await readRuleSetAges(document),
    observer: observers.register({
      name: 'drift',
      watches: 'whether the files, units and kernel settings on this device match the stored profile',
      everyMs: DRIFT_INTERVAL_MS,
    }),
  });
  // Armed with the drift round that reads it: it is not a loop of its own, and it is "running" for
  // exactly as long as the round that calls it is.
  ruleSetObserver.armed();

  const applyDeps: ApplyDeps = {
    platform,
    profiles,
    store,
    pipeline,
    // A transaction ending in this process wakes the resolver follower at once rather than at its next
    // round. Bound late: the follower is built further down and this runs only after start-up.
    transactionEnded: () => void resolverFollower.check('transaction-ended'),
    drift: driftMonitor,
    timeSyncUnit: config.timeSyncUnit,
    wayBinary: config.wayBinary,
    log: (level, fields, message) => logger[level](fields, message),
    windowWatch,
    /**
     * The recovery document, built from what the hardware reports and from the *current* access-point
     * credentials where they are usable.
     *
     * Keeping the operator's own network name and passphrase is the whole point: safe mode exists so
     * they can reach the device, and changing the name and passphrase at that moment means their phone
     * stops reconnecting — they would need the device in order to learn how to reach the device. The
     * documented fixed defaults are for a fresh device that has never been configured, which is a
     * different case.
     */
    recoveryDocument: async () => {
      const activeId = store.device().activeProfileId;
      const current = activeId === null ? null : (profiles.get(activeId)?.document ?? null);
      return await buildRecoveryDocument({
        platform,
        inventory: async () => await collectInventory(platform),
        current: current as never,
        fallbackSsid: DEFAULT_AP_SSID,
        fallbackPassphrase: DEFAULT_AP_PASSPHRASE,
        // So the recovery profile does not take the radio the operator is reachable through.
        managementInterfaces: (
          await collectFacts({
            systemd: platform.systemd,
            net: platform.net,
            coreCandidates,
            claimDirectories,
            boundAddresses: context.boundAddresses,
            binaries: [],
          })
        ).managementInterfaces,
      });
    },
  };

  const context: ServerContext = {
    config,
    // Read at request time, so the answer is the current report rather than the one that held when the
    // server was built. `null` before the first round, which the schema declares as "nobody has looked".
    // The latest report whoever made it — including the timer's `way revert` — from the database.
    drift: async () => await driftMonitor.current(),
    /*
     * Read at request time, and read from the files rather than from the last drift report.
     *
     * The report is made at boot, after a revert and every fifteen minutes; a screen asking how old
     * a list is wants the answer now, and serving it out of a report up to fifteen minutes old would
     * be this route committing the very defect it exists to expose.
     */
    /*
     * **The active profile, and the answer says so.**
     *
     * The ages describe files this device actually holds, and the only profile that caused one to be
     * written is the one that was applied. Answering about any other profile would mean joining a
     * stored set to a file by its tag — so an unapplied profile reusing the tag `geoip-ru` would be
     * shown the running profile's freshness for a list this device may never have fetched. `profileId`
     * is returned so a client cannot make that join by accident; the Routing screen compares it with
     * the profile it is editing and says nothing rather than something reassuring.
     */
    ruleSetAges: async () => {
      const activeId = store.device().activeProfileId;
      const document =
        activeId === null ? null : ((profiles.get(activeId)?.document ?? null) as ProfileDocumentType | null);
      if (document === null) return { profileId: activeId, sets: [] };
      return {
        profileId: activeId,
        sets: await readRuleSetAges(document),
      };
    },
    observers: () => observers.report(),
    platform,
    store,
    telemetry,
    startedAt: new Date(),
    version: VERSION,
    buildAt,
    unresolvedInterfaces: [],
    boundAddresses: [],
    /*
     * Read lazily, so the report is assembled from the decision and the address reading that the
     * last bind actually used rather than from fresh questions asked at request time.
     *
     * Null until the policy has run once. Null travels to the client as null: a client must be able
     * to tell "not decided yet" from "nothing was refused", and collapsing them here would put the
     * reassuring answer in front of the operator in exactly the case nobody has looked.
     */
    managementChannels: () =>
      lastChannelDecision === null
        ? null
        : managementChannels({
            classified: lastChannelDecision.classified,
            decision: lastChannelDecision,
            addresses: lastAddressReading,
            boundAddresses: context.boundAddresses,
          }),
    configWarnings: loaded.warnings,
    profileRoutes: {
      store,
      profiles,
      platform,
      inventory: async () => await collectInventory(platform),
      facts: async () => {
        const inventory = await collectInventory(platform);
        return await collectFacts({
          systemd: platform.systemd,
          net: platform.net,
          coreCandidates,
          claimDirectories,
          boundAddresses: context.boundAddresses,
          binaries: inventory.binaries.map((entry) => ({
            name: entry.name,
            present: entry.present,
            version: entry.version,
          })),
        });
      },
      reality: async (paths, units, sysctlKeys) =>
        await collectReality({
          systemd: platform.systemd,
          net: platform.net,
          paths,
          units,
          // Exactly the keys this plan wants to set, handed down from the desired state. Reading every
          // sysctl would be a page of I/O for nothing; reading a hardcoded subset was worse — the keys
          // the generator adds for IPv6 were never read, so they read as changed for ever and forced
          // every plan to the network class.
          sysctlKeys,
          boundAddresses: context.boundAddresses,
        }),
      managementPort: config.listen.port,
      // 123 is the time-synchronisation port, and it is configuration because the firewall bypass is
      // written in terms of it — a value hardcoded in the generator could not be corrected on a device
      // that uses another.
      timePorts: config.timePorts,
      timeSyncUnit: config.timeSyncUnit,
      upScriptPath: '/opt/wayfarer/bin/tunnel-up',
      pipeline,
      applyDeps,
    },
    currentLogLevel: () => logger.level,
    setLogLevel(level, minutes) {
      logger.level = level;
      if (logLevelRevert) clearTimeout(logLevelRevert);
      // Recorded in the same frame as the thing that acts on it: `setTimeout` counts on a monotonic
      // clock, so the remaining time is derived from `performance.now()` and never from a wall-clock
      // instant that a resync can move underneath it.
      logLevelRevertWindow = { raisedAtMonotonicMs: performance.now(), afterSeconds: minutes * 60 };
      // The revert is unconditional and lives here rather than in the interface: a forgotten
      // debug session must not be able to fill the journal and evict what mattered.
      logLevelRevert = setTimeout(() => {
        logger.level = config.logLevel;
        logLevelRevertWindow = null;
        logger.info({ restoredTo: config.logLevel }, 'debug level expired, log level restored');
      }, minutes * 60_000);
      logLevelRevert.unref();
      // Named `newLevel`, not `level`: pino writes its own `level` field, and a second one with the
      // same name produces a line with two `level` keys — which a JSON reader resolves to whichever
      // it saw last, so the severity of the line becomes a string.
      logger.warn({ newLevel: level, minutes }, 'log level raised for a bounded period');
      store.recordEvent({
        level: 'info',
        kind: 'debug.level',
        summary: `log level raised to ${level} for ${minutes} min`,
      });
      return { level, revertsAt: logLevelRevertsAt() };
    },
  };

  const app = await buildServer(context);
  await app.ready();

  // One HTTP server per bound address rather than one wildcard listener. Wildcard would put the
  // management interface on the uplink the moment an uplink exists, and that is the one failure
  // this design refuses to allow by accident.
  //
  // Which addresses are listening is decided by the listener set, which never tears a listener down
  // on a failed read — see src/api/listeners.ts for why that distinction is load-bearing.
  const servers = new Map<string, Server>();

  /**
   * The interfaces the management surface may bind to, recomputed on every address change.
   *
   * Held in a variable rather than derived on demand because deciding it needs the kernel's link list
   * and the driver's radio list, and both are asynchronous while the listener set asks for this
   * synchronously. `refreshLocalChannels` below does the asking.
   *
   * ## What this replaced, and why the replacement is not a widening
   *
   * This used to be the access point plus the uplinks **that the last apply had recorded**. That list
   * could not contain the wire under any configuration, because no plan touches the wire — it is the
   * lifeline every plan is written to leave alone — so it was never recorded. Measured on the bench
   * board, 2026-09-21: `ss -tln` showed loopback, `10.44.0.1` and `192.168.77.8`, and nothing on
   * `192.168.77.7`, which is `end0`. The panel was unreachable over Ethernet and had been for as long
   * as this code existed.
   *
   * The old comment here claimed the prohibition on tunnels held "by construction rather than by a
   * filter: this list is only ever the access point plus the uplinks a profile names". That was true
   * and it was the problem. **A prohibition that holds because control never reaches it stops holding
   * the moment the list gets longer**, and lengthening it is exactly what fixing the wire does. So the
   * refusal is now explicit, it is the last step, and it reports when it fires — see
   * `api/bind-policy.ts`.
   *
   * Loopback is not here: the listener always has it from `listen.addresses`.
   */
  let localChannels: string[] = [];
  /*
   * The whole decision, kept rather than reduced to the names.
   *
   * `refused` and `withheld` used to be computed and dropped on the floor here: the log saw a
   * refusal, and nothing else could. `GET /api/system` reported a port and a list of addresses, so
   * the one screen where a refusal belongs was structurally unable to mention one — and a screen
   * that is empty where a refusal belongs says quietly that there were none. The classified list is
   * kept with it, from the same call, so the report cannot describe a device assembled from two
   * readings taken a moment apart.
   */
  let lastChannelDecision: ReturnType<typeof localChannelsFor> | null = null;
  /** The addresses the last successful bind was computed from. A failed read leaves the previous. */
  let lastAddressReading: { name: string; address: string; family: string }[] = [];
  const managementSurfaces = (): string[] => localChannels;

  /**
   * Ask the system what its interfaces are, decide which are local, and refuse the rest.
   *
   * A failed read leaves `localChannels` as it was rather than emptying it. A failed read is not an
   * observed absence, and the listener set holds the same line for the same reason: tearing down a
   * working listener because one `ip` invocation timed out is how a device makes itself unreachable
   * over a transient.
   */
  const refreshLocalChannels = async (): Promise<void> => {
    const links = await platform.net.links().catch(() => null);
    if (links === null) {
      logger.warn({}, 'could not read the interface list; keeping the current management surfaces');
      return;
    }

    /*
     * `null`, not `[]`, when the radios cannot be enumerated. The two differ: an empty list says the
     * driver reports no radios, and `null` says nobody could ask. The classifier treats the second as
     * "every `ether` link is `unknown`", because a wire and a radio are indistinguishable from a link
     * alone — and an interface that cannot be shown to be local is not bound.
     */
    const radios = await platform.wifi
      .interfaces()
      .then((entries) => entries.map((entry) => entry.name).filter((name): name is string => name !== null))
      .catch(() => null);

    const document = activeDocument();
    // Read defensively: this runs on the bind path, and something that throws while deciding where to
    // listen is a device nobody can reach. `undefined` means on, which is the default and the owner's
    // requirement.
    const onUplinkNetwork = document?.services?.management?.onUplinkNetwork !== false;

    const recorded = store.device().managementSurfaces;

    const decision = localChannelsFor({
      links,
      radios,
      managementSurfaces: recorded,
      /*
       * The second source of tunnel names: the interfaces the last plan recorded its own tunnels as
       * resolving to. Recorded by the plan rather than recomputed here, because the names come from
       * per-protocol rules in `core/catalogue/` and `core/binding.ts`, and a second copy of a
       * naming rule is the defect this project spends most of its effort avoiding.
       *
       * **An empty list means "that plan created no tunnels", not "unknown".** That reading is safe
       * only while the link's own shape stays the primary verdict and this remains a supplement —
       * make it the sole source and the assumption rots without a symptom.
       */
      profileTunnelInterfaces: recorded?.tunnels ?? [],
      onUplinkNetwork,
    });

    localChannels = decision.bind;
    lastChannelDecision = decision;

    if (decision.refused.length > 0) {
      // Not a routine exclusion. Reaching this means something upstream called a tunnel a local
      // channel, and the only reason the panel is not answering inside somebody else's network is a
      // filter that should never have had anything to do.
      logger.error({ refused: decision.refused }, refusalSummary(decision.refused));
      store.recordEvent({
        level: 'error',
        kind: 'management.tunnel-refused',
        summary: refusalSummary(decision.refused),
        detail: { refused: decision.refused },
      });
    }
  };

  /**
   * Keep the core asking the resolver each peer actually pushed, and excluding every network a peer
   * handed one of our tunnel interfaces (`core/device-follower.ts`).
   *
   * **This is the half that makes the captured value mean anything.** Reading it when a plan happens to
   * be generated would give the right answer only when somebody applies something after a move, and this
   * peer moves the device often — measured on the bench board, 2026-09-21: six reconnections in forty
   * minutes, with three different resolver addresses seen in one evening and only the current one
   * reachable.
   *
   * ## Why this cannot run away with the device
   *
   * It applies with the classes narrowed to `hot` and `service`: anything classified `network` or `boot`
   * is left undone, so a captured value can never reconfigure an interface, move the access point, or
   * reboot anything. `openedBy` is null because no credential asked for this. It re-derives at most once a
   * minute, waits for any open transaction, and backs off from a divergence it already failed to fix.
   *
   * ## Why it is level-triggered now
   *
   * It used to act once per file-system event and once at start-up, and every outcome but success was
   * terminal — including the ordinary one, where the capture changes in the middle of the apply that
   * restarted the tunnel and the attempt is refused because that apply holds its window. The board ran on
   * a stale resolver for ten hours that way on 2026-09-22. See `core/resolver-follower.ts`.
   */
  const resolverFollower = followDevice({
    platform,
    store,
    profiles,
    applyDeps,
    observers,
    record: (event) => store.recordEvent(event),
    log: (level, fields, message) => logger[level](fields, message),
  });

  /*
   * The file-system watch is now only the fast path: it makes a new capture take effect in seconds
   * rather than at the next round. Convergence no longer depends on it — the round above compares the
   * two files whether or not an event arrived — but it is still an observer, and a watch that could not
   * be established is shown as one that is not running.
   *
   * Measured by reading the shipped `tunnel-up`: it is the script that creates `/run/wayfarer/tunnel`,
   * and it runs when a tunnel first connects, after the daemon has started, so on a normal boot this
   * watch cannot be established at the moment it is first attempted. It retries every 30 s.
   */
  const resolverWatch = observeCapturedResolvers({
    observers,
    onCapture: () => void resolverFollower.check('capture-changed'),
    onUnavailable: (reason) => {
      logger.warn({ directory: CAPTURED_RESOLVER_DIR, reason }, 'not watching for resolver changes yet');
      store.recordEvent({
        level: 'warn',
        kind: 'resolver.watch-unavailable',
        summary:
          'not watching for resolver changes yet: the directory the tunnel up-script writes to does not ' +
          'exist. Retrying; the resolver follower still compares every minute, so a capture is picked up ' +
          'within one round either way.',
        detail: { directory: CAPTURED_RESOLVER_DIR, reason },
      });
    },
    onEstablished: (afterRetry) => {
      if (!afterRetry) return;
      logger.info({ directory: CAPTURED_RESOLVER_DIR }, 'now watching for resolver changes');
      store.recordEvent({
        level: 'info',
        kind: 'resolver.watch-established',
        summary: 'now watching for resolver changes: the tunnel up-script has created its directory',
        detail: { directory: CAPTURED_RESOLVER_DIR },
      });
    },
  });

  /*
   * What is already captured, compared with what the core was given — at start-up, and then every
   * minute. A watcher is blind to everything that happened before it existed: a capture written while
   * the daemon was restarting delivers no event, ever.
   */
  void resolverFollower.check('start-up');
  resolverFollower.start();
  // The same, for a transaction ended by another process: the timer's `way revert` signals this one.
  const stopListeningForEnds = listenForTransactionsEndedElsewhere(process, () => {
    logger.info({}, 'another process ended a transaction; the resolver follower looks now');
    void resolverFollower.check('transaction-ended-elsewhere');
  });

  const listeners = createListenerSet({
    listen: config.listen,
    profileInterfaces: managementSurfaces,
    log: (level, fields, message) => logger[level](fields, message),
    host: {
      async start(address, port) {
        return await new Promise((resolve) => {
          const server = createServer((request, response) => {
            app.routing(request, response);
          });
          server.on('error', (error) => resolve({ ok: false, error: String(error) }));
          server.listen({ host: address, port }, () => {
            servers.set(address, server);
            resolve({ ok: true });
          });
        });
      },
      stop(address) {
        servers.get(address)?.close();
        servers.delete(address);
      },
    },
  });

  const rebind = async (): Promise<void> => {
    // Before the addresses, because the set of interfaces worth resolving is what this decides. An
    // address change is also how a new interface first becomes visible, so this is the right moment.
    await refreshLocalChannels();

    let reading: AddressReading;
    try {
      const addresses = await platform.net.addresses();
      reading = {
        ok: true,
        addresses: addresses.map((entry) => ({ name: entry.name, address: entry.address, family: entry.family })),
      };
    } catch (error) {
      reading = { ok: false, error: String(error) };
    }

    // Kept for the channel report, which must describe the *same* reading the bind used. Asking the
    // kernel again when somebody opens the page would let the report show an address that was never
    // offered to the listener, or miss one that was.
    lastAddressReading = reading.ok ? reading.addresses : lastAddressReading;

    const result = await listeners.reconcile(reading);
    context.unresolvedInterfaces = result.unresolved;
    context.boundAddresses = result.bound;

    if (result.bound.length === 0) {
      logger.error(
        { configured: config.listen },
        'not listening on any address — the interface is unreachable until one resolves',
      );
    }
    if (result.unresolved.length > 0) {
      logger.warn({ unresolved: result.unresolved }, 'configured interfaces have no address yet');
    }
  };

  await rebind();

  // The bind set is re-resolved when addresses change, so an interface that gets its address
  // late — a DHCP lease, a radio coming up — becomes reachable without a restart.
  // The same event also wakes the follower: an address on a tunnel interface is how a tunnel's network
  // first becomes visible. See `core/address-watch.ts`.
  const netWatch = observeAddresses({
    observers,
    net: platform.net,
    rebind: async () => {
      await rebind();
      return context.boundAddresses;
    },
    follower: resolverFollower,
    log: (level, fields, message) => logger[level](fields, message),
  });

  /*
   * An idle session still occupies the card until something removes it, so on a device that runs for months
   * "past the idle limit" and "gone" have to be the same thing.
   *
   * It judges by **exactly** the rule the request path uses, through the same function, with the same boot
   * anchor and the same open-window exemption. The previous version deleted on the absolute `expires_at`
   * that no authorisation path reads any more — so it was the last enforcer of an abandoned model, it
   * retired sessions in continuous use, and it could delete the session holding an open confirmation
   * window. That is not a rare race on this board: the apply restarts the time service, so a forward jump
   * of days inside the window is the designed path.
   */
  const sweepSessions = async (): Promise<number> => {
    const removed = store.sweepIdleSessions({
      stamp: await readStamp({
        bootId: () => platform.journal.currentBootId(),
        uptimeSeconds: () => platform.host.uptimeSeconds(),
      }),
      holdsOpenWindow: (credentialId) => {
        const open = profiles.unconfirmedTransaction();
        return open !== null && open.openedBy !== null && open.openedBy === credentialId;
      },
    });
    if (removed > 0) logger.info({ removed }, 'idle sessions removed');
    return removed;
  };
  const sessionObserver = observers.register({
    name: 'session-sweep',
    watches: 'browser sessions past the idle limit',
    everyMs: 60 * 60 * 1000,
  });
  const observedSweep = async (): Promise<void> => {
    try {
      const removed = await sweepSessions();
      sessionObserver.looked(`swept sessions past the idle limit: ${String(removed)} removed`);
      if (removed > 0) sessionObserver.acted(`removed ${String(removed)} idle session(s)`);
    } catch (error) {
      sessionObserver.looked(`could not sweep: ${String(error)}`);
    }
  };
  void observedSweep();
  const sessionSweep = setInterval(() => void observedSweep(), 60 * 60 * 1000);
  sessionSweep.unref();
  sessionObserver.armed();

  /**
   * The health watchdog.
   *
   * Started after the session sweep and before the listener, because it needs nothing from either and
   * because its first round is the most interesting one on a device that has just come back: a tunnel
   * that is broken at boot is reported on that round rather than waiting for a transition that never
   * comes.
   *
   * The candidate list is read from the **active profile** on every round rather than captured, so
   * applying a profile that adds or removes a tunnel is picked up without restarting anything. Only
   * `alternative` tunnels are candidates: a `resource` tunnel is not interchangeable with anything, so
   * moving traffic onto it because it measured well would send it somewhere nobody chose.
   */
  const watchdogCore = createCoreApi({ bind: coreApiBind() });
  /*
   * Liveness is asked of each tunnel's own protocol, as its catalogue entry says (`core/liveness.ts`).
   * One meter for the life of the daemon, because what it reads is a change between rounds: a counter's
   * rise, a connection's downloaded bytes, a gateway that has answered on this connection.
   */
  const livenessMeter = createLivenessMeter(
    deviceLivenessReaders({
      core: watchdogCore,
      ping: (interfaceName, address, timeoutMs) => platform.net.ping(interfaceName, address, timeoutMs),
      statusDirectory: PATHS.openvpnStatusDir,
      journal: platform.journal,
      clientUnit: openVpnUnit,
    }),
  );
  const watchdog = createWatchdog({
    core: watchdogCore,
    selector: CORE_TAGS.selector,
    candidates: async () => {
      return (activeDocument()?.tunnels ?? [])
        .filter((tunnel) => tunnel.enabled && tunnel.role === 'alternative')
        .map((tunnel) => tunnel.id);
    },
    /**
     * The destination tunnels, read from the active profile every round so a tunnel added or changed
     * takes effect on the next round rather than the next restart. Each is measured by its own protocol
     * and never by anything it carries — see `guardedTunnels` and `core/liveness.ts`.
     */
    guards: deviceGuards({
      document: () => activeDocument(),
      tunnelUnits: () => store.device().tunnelUnits,
    }),
    liveness: livenessMeter,
    policy: () => {
      const policy = activeDocument()?.policy ?? emptyProfile({ name: 'none' }).policy;
      return {
        priority: policy.priority,
        excluded: policy.excluded,
        sticky: policy.sticky,
        onAllDown: policy.onAllDown,
        probes: policy.probes,
      };
    },
    // Everything the watchdog writes to the ring is a transition it acted on or reports; a steady
    // round writes nothing, which is what `onRound` below is for.
    record: (event) => {
      store.recordEvent(event);
      watchdogObservation.recorded(event);
    },
    log: (level, fields, message) => logger[level](fields, message),
    // Guards included, one item each, a blocked one a problem, and a look at the start of every round
    // as well as the end — see `observeWatchdog`.
    onRoundStart: () => watchdogObservation.onRoundStart(),
    onRound: (outcome) => watchdogObservation.onRound(outcome),
  });
  const watchdogObserver = observers.register({
    name: 'tunnel-watchdog',
    watches: 'each tunnel’s health: to move traffic off a failing alternative, and to report whether each destination tunnel is alive',
    everyMs: () => (activeDocument()?.policy.probes.intervalSeconds ?? 30) * 1000,
  });
  const watchdogObservation = observeWatchdog(watchdogObserver);

  /**
   * The active profile's document, or `null` when there is no active profile.
   *
   * One lookup, read fresh each time it is called. It was written out at four call sites, which is not only
   * repetition: each copy was an independent chance to cache it, and a cached active document is one that
   * stops matching the moment the operator switches profiles — in a watchdog that decides where traffic
   * goes.
   */
  function activeDocument(): ProfileDocumentType | null {
    const active = store.device().activeProfileId;
    if (active === null) return null;
    return (profiles.get(active)?.document as ProfileDocumentType | undefined) ?? null;
  }

  /** The core's control interface, from the active profile rather than assumed. */
  function coreApiBind(): string {
    return activeDocument()?.services.clashApi.bind ?? '127.0.0.1:9090';
  }

  // Passed as a function, so an interval changed in a profile takes effect on the next round rather than
  // at the next restart — the same liveness the rest of the policy already had.
  const watchdogHandle = watchdog.start(() => activeDocument()?.policy.probes.intervalSeconds ?? 30);
  watchdogObserver.armed();

  /*
   * The OpenVPN counters, sampled at the cadence the clients rewrite them rather than once a round, so
   * the silence clock starts within five seconds of the last packet instead of when a round next looks.
   * A tunnel whose standing changed is measured at once. Unref'd: this never keeps the process up.
   */
  const keepaliveGuards = deviceGuards({ document: () => activeDocument(), tunnelUnits: () => store.device().tunnelUnits });
  let sampling = false;
  const keepaliveSampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void (async () => {
      const ids = (await keepaliveGuards())
        .filter((guard) => guard.method.kind === 'peer-keepalive')
        .map((guard) => guard.tunnelId);
      if ((await livenessMeter.sampleKeepalives(ids)).length > 0) watchdogHandle.nudge();
    })()
      .catch((error: unknown) => logger.warn({ error: String(error) }, 'a keepalive sample failed; the next one will try again'))
      .finally(() => {
        sampling = false;
      });
  }, KEEPALIVE_STATUS_SECONDS * 1000);
  keepaliveSampler.unref();

  /**
   * Revert anything left unconfirmed by a crash or a power cut.
   *
   * At **every** start, and before telemetry or the role watchers, because the device may currently be
   * running a configuration nobody ever confirmed. The transient timer covers a daemon that dies; this
   * covers the machine dying, which no timer can. One query when there is nothing to do.
   */
  try {
    const swept = await sweepUnconfirmed(applyDeps);
    if (swept !== null) {
      logger.warn({ ...swept, result: undefined }, 'reverted an unconfirmed transaction found at start-up');
    }
  } catch (error) {
    // Logged and survived. A sweep that throws must not stop the control plane from coming up: an
    // unreachable daemon is strictly worse than one reporting that it could not finish a revert.
    logger.error({ error: String(error) }, 'the start-up revert sweep failed');
  }

  /**
   * Does this device match its stored profile? Asked once at boot, and then every fifteen minutes.
   *
   * After the sweep, deliberately: the sweep may have reverted an unconfirmed transaction, and the
   * answer somebody wants is about the configuration the device has settled on rather than the one it
   * had a second earlier.
   *
   * It is awaited rather than fired and forgotten, because the first report is the most interesting
   * one on a device that has just come back — a file edited while the daemon was down, or a boot
   * guard that rewrote an artefact, shows up here and nowhere else — and because a report that
   * arrives after the listener is up is a report a person can race.
   */
  await driftMonitor.run('boot');
  driftMonitor.start();

  const stopTelemetry = await telemetry.start({});
  telemetry.watchUnits([config.unitName]);

  /*
   * The tunnels the last plan recorded, so the status view is populated before anything is applied.
   *
   * Read from the store rather than re-derived from the active profile, and that is the point: the
   * unit names come from per-protocol rules in `core/catalogue/`, and re-deriving them here would be
   * a second copy of a naming rule — the defect this project spends most of its effort avoiding, and
   * the same argument as the tunnel interface names on the recorded management surfaces.
   *
   * **`null` means no plan has recorded anything, and nothing is watched.** Calling `watchTunnels([])`
   * here would publish an empty list, which reads as "this device has no tunnels" — the reassuring
   * answer, in exactly the case where nobody has looked.
   */
  const recordedTunnelUnits = store.device().tunnelUnits;
  if (recordedTunnelUnits !== null) telemetry.watchTunnels(recordedTunnelUnits);

  /**
   * Which interfaces are watched comes from what the driver reports right now — an interface in AP
   * mode is watched as an access point, one in managed mode is watched for link quality. Nothing
   * here names an interface: on this hardware the names differ per board and per boot order, and in
   * the next epic the roles come from the active profile instead.
   *
   * The decision itself is in `api/wireless-roles.ts`, because it used to be in this closure and
   * this closure cannot be called by a test — `main()` runs on import. It was also wrong there:
   * `.catch(() => [])` turned a failed read into "this device has no radios", and the watch calls
   * replace their sets, so one `iw` timeout stopped all wireless telemetry and the panel reported
   * nobody connected. The last good sets are kept here so that "keep what you have" has something
   * to keep.
   */
  let lastRoles: WirelessRoles = { accessPoints: [], links: [] };
  const followDiscoveredRoles = async (): Promise<void> => {
    // `null`, not `[]`. The distinction is the whole point: see `api/wireless-roles.ts`.
    const radios = await platform.wifi.phys().catch(() => null);
    const roles = wirelessRolesFrom(radios);

    if (roles === null) {
      // Not debug. A device that has stopped looking must say so where somebody will see it, or the
      // empty station list it produces reads as an answer about the network.
      const summary = unreadableRadiosSummary(lastRoles);
      logger.warn({ watched: lastRoles }, summary);
      store.recordEvent({
        level: 'warn',
        kind: 'wireless.roles-unreadable',
        summary,
        detail: { watched: lastRoles },
      });
      return;
    }

    lastRoles = roles;
    telemetry.watchAccessPoints(roles.accessPoints);
    telemetry.watchLinks(roles.links);
    logger.debug(roles, 'watching discovered wireless roles');
  };

  const rolesObserver = observers.register({
    name: 'radio-roles',
    watches: 'which radios are access points and which are uplinks, so the right ones are watched',
    everyMs: 60_000,
  });
  const observedRoles = async (): Promise<void> => {
    await followDiscoveredRoles().catch(() => undefined);
    rolesObserver.looked(
      `${String(lastRoles.accessPoints.length)} access point(s), ${String(lastRoles.links.length)} uplink radio(s)`,
    );
  };
  await observedRoles();
  // Re-checked on address changes, which is when a radio's role most plausibly changed too.
  const roleTimer = setInterval(() => void observedRoles(), 60_000);
  roleTimer.unref();
  rolesObserver.armed();

  store.recordEvent({
    level: 'info',
    kind: 'daemon.started',
    summary: `daemon started, version ${VERSION}`,
    detail: { addresses: [...servers.keys()], port: config.listen.port, runtime: process.version },
  });
  forwardToTelemetry('info', 'daemon started');

  const notifier = createNotifier();
  await notifier.ready();
  await notifier.status(`listening on ${[...servers.keys()].join(', ') || 'nothing'}`);
  const stopWatchdog = notifier.startWatchdog();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    stopWatchdog();
    clearInterval(roleTimer);
    clearInterval(sessionSweep);
    driftMonitor.stop();
    // The watchdog holds an interval and talks to the core; stopped so a shutdown does not race a probe.
    watchdogHandle.stop();
    clearInterval(keepaliveSampler);
    netWatch.stop();
    // Stopped with the rest. It holds a file-system watch and a retry timer, and a shutdown that
    // leaves them is a process that will not exit when something else holds a handle too.
    resolverWatch.stop();
    stopListeningForEnds();
    await stopTelemetry();
    listeners.stopAll();
    await app.close();
    platform.close();
    store.recordEvent({ level: 'info', kind: 'daemon.stopped', summary: `daemon stopped on ${signal}` });
    database.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    // Logged and survived rather than fatal: the control plane staying up is worth more than a
    // clean exit, and `Restart=always` would bring it back anyway with less information.
    logger.error({ reason: String(reason) }, 'unhandled rejection');
  });
}

async function readBuildStamp(): Promise<string | null> {
  // Paths are plain strings rather than resolved from `import.meta.url`: the deployed artefact
  // is a CommonJS bundle, where `import.meta` is empty, so a build stamp looked up that way is
  // always missing on the device and always present in development — the worst way round.
  const beside = process.argv[1] === undefined ? null : `${process.argv[1].replace(/\/[^/]+$/, '')}/build.json`;
  for (const path of ['/opt/wayfarer/build.json', ...(beside === null ? [] : [beside])]) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { builtAt?: string };
      if (typeof parsed.builtAt === 'string') return parsed.builtAt;
    } catch {
      /* Next candidate. */
    }
  }
  return null;
}

void main().catch((error: unknown) => {
  // Nothing is listening yet at this point, so the journal is the only place this can go.
  process.stderr.write(`wayfarer failed to start: ${String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
