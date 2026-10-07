/**
 * The reconciler: the only code in this project with side effects.
 *
 * Planning, diffing and validation are pure. Anything outside this file that writes a file, restarts
 * a unit or shells out is a bug — and that is worth enforcing in review rather than trusting, because
 * it is the property that makes a dry run identical to the real thing minus the last step.
 *
 * ## The apply order is not negotiable
 *
 * Every entry earned its position from a failure that is silent when the order is wrong:
 *
 * ```
 * 1.  validate everything            (nft -c -f, the core's own check, ownership)
 * 2.  write managed files            (atomic: same-directory temp, fsync, rename, fsync)
 * 3.  network configuration          — network class
 * 4.  sysctl                         — network class
 * 5.  firewall                       — network class
 * 6.  time synchronisation restart   — after the firewall, never before
 * 7.  access point                   — network class
 * 8.  DHCP                           (enable, then restart)
 * 9.  tunnel transports              (listeners first)
 * 10. tunnel daemons
 * 11. proxy core                     (restart, not "enable --now")
 * 12. verify                         (is-active AND is-enabled)
 * ```
 *
 * The three that are easiest to get wrong:
 *
 * * **Time after the firewall.** Correcting a wrong clock needs a query that bypasses the tunnel,
 *   which needs the bypass rule to exist first. Restarting the time service before the ruleset is
 *   loaded sends the first query into the tunnel, where it is lost — and a wrong clock makes every
 *   timestamp-authenticated transport fail while direct connections work normally.
 * * **Enable before restart.** A failing restart aborts the sequence; if enable has not run, the unit
 *   is left disabled and the fault only appears after the next reboot.
 * * **Restart, not "enable and start".** For a unit already running, an enable-and-start call does
 *   nothing, and the new configuration is silently not applied.
 *
 * Verification checks `is-active` **and** `is-enabled`. Checking only the first produces a device that
 * works until it is power-cycled.
 *
 * ## Which classes this applies, and why that is the caller's decision
 *
 * All four are implemented. None of the dangerous two happens unless the caller **asks by name**, and
 * the default is still the two safe classes.
 *
 * That is not caution left over from an earlier slice. This function cannot tell whether anybody is
 * watching: whether a transaction was written, whether a revert timer is armed outside this process,
 * whether a deadline exists. Those are the things that make a `network` change survivable, and they
 * belong to the layer that owns them. So a caller which has not armed them cannot obtain a `network`
 * apply by accident, and one which has says so explicitly. The refusal names every change it did not
 * perform and what that change needs.
 *
 * ## The network steps, in the order they earned
 *
 * Step 3 is three things and their order matters as much as the rest:
 *
 * 1. **Clear foreign claims first.** Writing our configuration for an interface another manager still
 *    claims leaves two sources disagreeing, and the one that wins is whichever ran last — so the
 *    device works until the other side runs. The claiming file is **moved, never deleted**, and the
 *    move is recorded on the transaction before it happens so a revert can undo it.
 * 2. **`networkctl reload` then `reconfigure`.** Both, because reload makes networkd notice the files
 *    and reconfigure makes it re-evaluate the links. Reload alone leaves a link running on its old
 *    configuration and reports success.
 * 3. **Wait for addressing, and never fail on it.** A lease that has not arrived is information for
 *    the confirmation window, not an apply failure: an uplink that is simply absent is a valid state,
 *    and treating a slow DHCP server as a failed apply would make the outcome depend on the weather.
 *
 * The firewall is loaded by **restarting the unit that loads it**, not by running `nft` from here, so
 * the apply path and the boot path are one mechanism. Two mechanisms would mean the boot path is
 * verified only by power-cycling.
 */

import type { Platform } from '../platform/index.ts';
import { ASIDE_SUFFIX } from '../platform/files.ts';
import { isOwnedUnit, type DesiredState, type ManagedFile } from './desired-state.ts';
import type { BlastRadius, Plan2 } from './differ.ts';

export type ApplyClass = BlastRadius;

/**
 * The classes a caller gets without asking.
 *
 * Still only the two safe ones, and that has not changed now that the other two are implemented. A
 * `network` apply must be a deliberate act by a caller that has **already** armed a revert timer and
 * written a transaction, because the reconciler cannot tell whether anybody is watching. Making the
 * dangerous classes opt-in keeps the decision where the safety net is.
 */
const DEFAULT_CLASSES: readonly ApplyClass[] = ['hot', 'service'];

/**
 * How long addressing is given to settle before the units that depend on it are started.
 *
 * An assumption, not a measurement, and labelled as one. Too short and hostapd binds an interface
 * with no address, which is a permanent failure the restart policy then papers over noisily; too long
 * only costs seconds on an apply. The soak replaces it with a number.
 */
const NETWORK_SETTLE_MS = 20_000;

export interface ReconcileOptions {
  /**
   * Which classes the caller is asking to apply. Defaults to both safe classes.
   *
   * Passing this explicitly is how a caller says "apply the safe part of a mixed plan". It is never
   * the default, so a partial application is always a deliberate act rather than something that
   * happens because a plan turned out to contain more than expected.
   */
  classes?: ApplyClass[];
  /** Stop before making any change; used to exercise the validation gate on its own. */
  validateOnly?: boolean;
  /**
   * Where files go. Overridable so an apply can be rehearsed against a scratch prefix on a device
   * whose real configuration must not be touched.
   */
  pathPrefix?: string;
}

export interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
  /** Milliseconds, so a slow step is visible rather than inferred from a total. */
  ms: number;
}

/**
 * What a tool said. The **only** thing a step's outcome may be derived from.
 *
 * This type exists to make a particular lie unwritable. A validation step once called the firewall
 * checker on an empty ruleset, discarded the result, and reported `ok: true` unconditionally — so a
 * malformed configuration was written to disk with "validate: core configuration … ok" in the log,
 * and the truth arrived later as a generic unit failure, after files were written and units
 * restarted.
 *
 * A step that reports success without consuming a result is worse than no step at all, because the
 * log then testifies to a check that never happened. So every step goes through `record` below, which
 * takes a function returning one of these, and there is no other way to append to the step list.
 */
export interface ToolOutcome {
  ok: boolean;
  /** The tool's own words where it has any. Paraphrasing loses the part that identifies the fault. */
  detail: string;
}

export interface RefusedChange {
  what: string;
  blastRadius: BlastRadius;
  /** What has to exist before this can be applied, in words rather than a task number. */
  needs: string;
}

export interface ReconcileResult {
  applied: boolean;
  steps: StepResult[];
  /** Changes deliberately not applied, each with the reason. Never silently dropped. */
  refused: RefusedChange[];
  /** Units that failed verification, with what was wrong. */
  verificationFailures: { unit: string; active: boolean; enabled: boolean; expected: string }[];
  error?: { code: string; message: string; hint: string };
}

export class ForeignUnitError extends Error {
  readonly units: string[];

  constructor(units: string[]) {
    super(
      `refusing to act on units this device did not generate: ${units.join(', ')}. Only units whose ` +
        'names start with "wf-" are owned here; anything else belongs to other software, and stopping ' +
        'it would break something nobody asked us to touch.',
    );
    this.name = 'ForeignUnitError';
    this.units = units;
  }
}

export interface ReconcileInput {
  platform: Platform;
  desired: DesiredState;
  plan: Plan2;
  options?: ReconcileOptions;
  /** Units to restart for time synchronisation, from configuration rather than a constant here. */
  timeSyncUnit: string;
  /**
   * Called with each file this apply is **about to** move aside, before it moves.
   *
   * Before rather than after, deliberately. The caller records the intent on the transaction, so a
   * crash between the record and the move leaves a record of a move that did not happen — which the
   * restore treats as `nothing-to-do` and shrugs off. Recording afterwards would produce the opposite
   * failure: a file moved with nothing remembering where it went, and no revert able to find it.
   */
  onTakeover?: (entries: { from: string; to: string; by: string }[]) => Promise<void>;
}

export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const { platform, desired, plan } = input;
  const options = input.options ?? {};
  const requested = new Set<ApplyClass>(options.classes ?? DEFAULT_CLASSES);
  const APPLIABLE: ReadonlySet<BlastRadius> = requested;
  const steps: StepResult[] = [];
  const refused: RefusedChange[] = [];

  /**
   * Runs one step and records what the tool said.
   *
   * `ok` comes from the outcome and from nowhere else. A throw is a failed step rather than an
   * exception the caller has to remember to catch, so a tool that blows up cannot be recorded as a
   * success by omission.
   */
  const record = async (step: string, run: () => Promise<ToolOutcome>): Promise<ToolOutcome> => {
    const started = Date.now();
    let outcome: ToolOutcome;
    try {
      outcome = await run();
    } catch (error) {
      outcome = { ok: false, detail: String(error) };
    }
    steps.push({ step, ok: outcome.ok, detail: outcome.detail, ms: Date.now() - started });
    return outcome;
  };

  /* ── the refusal, computed before anything is touched ─────────────────────────────────── */

  /**
   * The paths this apply will not write, kept as paths.
   *
   * `refused` records a sentence per change; a restart that has to ask "were my reasons written?"
   * needs the path, because that is the key the plan's `becauseOf` is expressed in. Rebuilding the
   * paths later by parsing `what` back apart would make the join depend on the phrasing of a message
   * written for a person.
   */
  const refusedFilePaths = new Set<string>();
  for (const change of plan.fileChanges) {
    if (!APPLIABLE.has(change.blastRadius)) {
      refusedFilePaths.add(change.path);
      refused.push({
        what: `${change.action} ${change.path}`,
        blastRadius: change.blastRadius,
        needs: needsFor(change.blastRadius),
      });
    }
  }
  for (const change of plan.unitChanges) {
    if (!APPLIABLE.has(change.blastRadius)) {
      refused.push({
        what: `${change.action} ${change.name}`,
        blastRadius: change.blastRadius,
        needs: needsFor(change.blastRadius),
      });
    }
  }
  for (const setting of plan.sysctlChanges) {
    refused.push({
      what: `set ${setting.key} to ${setting.to}`,
      blastRadius: 'network',
      needs: needsFor('network'),
    });
  }
  for (const rename of plan.interfaceRenames) {
    refused.push({
      what: `rename ${rename.from} to ${rename.to}`,
      blastRadius: rename.carriesManagement ? 'network' : 'boot',
      needs: rename.carriesManagement
        ? needsFor('network')
        : 'a reboot. The name changes when the device next starts, and nothing changes before then.',
    });
  }

  // A plan whose *highest* class cannot be applied, and which the caller did not explicitly narrow, is
  // refused whole. A half-applied profile is the intermediate state this design refuses to leave
  // behind, and the error names every part so the refusal is actionable rather than a dead end.
  const narrowed = options.classes !== undefined;
  if (refused.length > 0 && !narrowed) {
    return {
      applied: false,
      steps,
      refused,
      verificationFailures: [],
      error: {
        code: 'blast_radius_not_applicable',
        message:
          `This plan contains ${refused.length} change${refused.length === 1 ? '' : 's'} that can cost ` +
          'access to the device, and the confirmation window that makes such a change survivable is ' +
          'not available yet. Nothing has been changed.\n' +
          refused.map((entry) => `  • ${entry.what} (${entry.blastRadius}) — needs ${entry.needs}`).join('\n'),
        hint:
          'Apply only the safe part by asking for it explicitly, with classes = ["hot", "service"]. ' +
          'That leaves the rest of the profile unapplied, and the interface will keep showing it as ' +
          'pending rather than forgetting it.',
      },
    };
  }

  /* ── 1. validate ──────────────────────────────────────────────────────────────────────── */

  const foreign = [...plan.foreignUnits];
  for (const change of plan.unitChanges) if (!isOwnedUnit(change.name)) foreign.push(change.name);
  if (foreign.length > 0) {
    const error = new ForeignUnitError([...new Set(foreign)]);
    return {
      applied: false,
      steps,
      refused,
      verificationFailures: [],
      error: { code: 'foreign_unit', message: error.message, hint: 'This is a bug in the planner, not a configuration problem.' },
    };
  }

  for (const check of desired.checks) {
    if (check.kind === 'nft-check') {
      // `nft -c -f` before `nft -f`, always. A syntax error in a generated ruleset is caught before
      // anything is touched, and the message names the line, which is why it is surfaced verbatim.
      const result = await record('validate: firewall ruleset', async () => {
        const checked = await platform.nft.check(check.ruleset);
        return { ok: checked.ok, detail: checked.ok ? 'accepted' : checked.message };
      });
      if (!result.ok) {
        return {
          applied: false,
          steps,
          refused,
          verificationFailures: [],
          error: {
            code: 'ruleset_invalid',
            message: `The generated firewall ruleset was rejected: ${result.detail}`,
            hint: 'Nothing was changed. This is a generator fault; the message names the line.',
          },
        };
      }
    }
    if (check.kind === 'paths-writable') {
      /**
       * Proven before anything starts, and only for the classes this apply will actually perform.
       *
       * A narrowed apply must not be refused for a directory only the network class touches — that would
       * make the escape hatch useless in exactly the situation it exists for.
       */
      const relevant = check.directories.filter((entry) => {
        const forThisApply = plan.fileChanges.some(
          (change) => change.path.startsWith(`${entry.path}/`) && APPLIABLE.has(change.blastRadius),
        );
        const forTakeover = requested.has('network') && desired.takeover.some((claim) => claim.path.startsWith(`${entry.path}/`));
        return forThisApply || forTakeover;
      });

      const unwritable: { path: string; why: string; reason: string }[] = [];
      const probed = await record('validate: every directory this plan writes in is writable', async () => {
        for (const entry of relevant) {
          const result = await platform.files.directoryWritable(`${prefixOf(options)}${entry.path}`);
          if (!result.writable) unwritable.push({ ...entry, reason: result.reason });
        }
        return {
          ok: unwritable.length === 0,
          detail:
            unwritable.length === 0
              ? `${relevant.length} director${relevant.length === 1 ? 'y' : 'ies'} writable`
              : unwritable.map((entry) => `${entry.path} (${entry.reason})`).join('; '),
        };
      });

      if (!probed.ok) {
        return {
          applied: false,
          steps,
          refused,
          verificationFailures: [],
          error: {
            code: 'path_not_writable',
            message:
              'This plan needs to write in a directory this daemon cannot write to, so nothing was ' +
              `attempted: ${unwritable.map((entry) => `${entry.path} — ${entry.reason} — needed for ${entry.why}`).join('; ')}`,
            hint:
              'EROFS usually means the path is missing from ReadWritePaths in wayfarer.service; EACCES ' +
              'means a permission. Nothing has been changed, and no revert timer was consumed finding out.',
          },
        };
      }
    }

    if (check.kind === 'unit-not-foreign') {
      const notOurs = check.units.filter((unit) => !isOwnedUnit(unit));
      await record('validate: every unit is ours', async () => ({
        ok: notOurs.length === 0,
        detail: notOurs.length === 0 ? `${check.units.length} units, all owned` : notOurs.join(', '),
      }));
      if (notOurs.length > 0) {
        return {
          applied: false,
          steps,
          refused,
          verificationFailures: [],
          error: {
            code: 'foreign_unit',
            message: new ForeignUnitError(notOurs).message,
            hint: 'This is a bug in the planner, not a configuration problem.',
          },
        };
      }
    }
    // `core-check` runs after the file is written, because the core validates a file on disk. It is
    // therefore performed in step 2's verification rather than here, and that ordering is stated
    // rather than left as an omission somebody might read as a missing check.
  }

  if (options.validateOnly === true) {
    return { applied: false, steps, refused, verificationFailures: [] };
  }

  /* ── 2. write managed files ───────────────────────────────────────────────────────────── */

  const prefix = options.pathPrefix ?? '';
  const appliableFiles = filesFor(desired, plan, APPLIABLE);

  for (const file of appliableFiles) {
    const path = `${prefix}${file.path}`;
    const written = await record(`write ${file.path}`, async () => {
      // `writeAtomic` and nothing else: temporary file in the target directory, fsync, chmod, rename,
      // fsync the directory. `/tmp` is a different filesystem, so a temporary file there makes the
      // move a copy, and losing power during a copy leaves a truncated configuration.
      const result = await platform.files.writeAtomic(path, file.content, { mode: file.mode, mkdirMode: 0o750 });
      return { ok: true, detail: result.changed ? `${result.bytes} bytes` : 'already matched, not rewritten' };
    });

    if (!written.ok) {
      return {
        applied: false,
        steps,
        refused,
        verificationFailures: [],
        error: {
          code: 'write_failed',
          message: `Could not write ${file.path}: ${written.detail}`,
          hint: 'Earlier files in this plan may already be written; nothing has been started or restarted.',
        },
      };
    }
  }

  /**
   * The core's own check, against the file that was just written.
   *
   * This is the step the whole "a schema check is not a validity check" rule exists for, and the
   * previous version of it was theatre: it called the firewall checker on an empty ruleset, discarded
   * the result, and reported success unconditionally. A malformed configuration reached the disk with
   * a line in the log saying it had been validated.
   *
   * It runs **after** the write because the core validates a file on disk, and **before** anything is
   * started, so a configuration that will not run fails here with the core's own message instead of
   * arriving later as a generic unit failure.
   */
  const coreCheck = desired.checks.find((check) => check.kind === 'core-check');
  if (coreCheck?.kind === 'core-check' && wantsCore(plan)) {
    const configPath = `${prefix}${coreCheck.configPath}`;
    const checked = await record('validate: core configuration', async () => {
      const result = await platform.binaries.checkCoreConfig(configPath);
      if (result === null) {
        // Not installed is a different answer from "the configuration is bad", and the two must not be
        // confused: the requirement check reports a missing core, and reporting it here as a failed
        // validation would send somebody to look at the configuration.
        return { ok: false, detail: 'no proxy core is installed, so its configuration cannot be checked' };
      }
      return { ok: result.ok, detail: result.message === '' ? 'accepted' : result.message };
    });

    if (!checked.ok) {
      return {
        applied: false,
        steps,
        refused,
        verificationFailures: [],
        error: {
          code: 'core_config_invalid',
          message: `The generated proxy-core configuration was rejected by the core itself: ${checked.detail}`,
          hint:
            'Nothing has been started or restarted. The message above is the core\'s own: a schema ' +
            'check cannot catch this class of fault, because a deprecated field is well-formed.',
        },
      };
    }
  }

  /* ── 3. clear foreign claims, before anything reads the network configuration ─────────── */

  /**
   * Taking an interface over from another network manager.
   *
   * First among the network steps, because the whole reason a second claim is dangerous is that the
   * source which ran last wins: leaving the other manager's file in place while writing ours produces
   * two configurations for one interface and a device whose behaviour depends on boot order.
   *
   * **The file is moved, never deleted.** We do not know what another program's file is for, the user
   * may need it, and deletion is the one action no revert can undo.
   */
  const takingOver = requested.has('network') ? desired.takeover : [];
  for (const claim of takingOver) {
    const moved = await record(`take over ${claim.interfaceName} from ${claim.by} (${claim.path})`, async () => {
      // The intent is recorded first: see `onTakeover`. A record of a move that did not happen is
      // harmless, a move with no record is a file nobody can put back.
      // The manager travels with the record, because the undo needs to know whose reload to run.
      await input.onTakeover?.([{ from: claim.path, to: `${claim.path}${ASIDE_SUFFIX}`, by: claim.by }]);
      const result = await platform.files.moveAside(claim.path);
      return {
        ok: true,
        detail: result.moved ? `moved to ${result.to}` : 'already moved; nothing to do',
      };
    });
    if (!moved.ok) {
      return {
        applied: false,
        steps,
        refused,
        verificationFailures: [],
        error: {
          code: 'takeover_failed',
          message: `Could not take ${claim.interfaceName} over from ${claim.by}: ${moved.detail}`,
          hint:
            'Nothing further was changed. The other manager still configures that interface, so this ' +
            'profile would have fought with it.',
        },
      };
    }
  }

  /* ── 3b. network configuration, then wait for it to settle ────────────────────────────── */

  const networkFilesChanged = plan.fileChanges.some(
    (change) => change.path.startsWith('/etc/systemd/network/') && APPLIABLE.has(change.blastRadius),
  );

  if (requested.has('network') && (networkFilesChanged || takingOver.length > 0)) {
    // `reload` then `reconfigure`, and both are needed. Reload makes networkd notice the files;
    // reconfigure makes it re-evaluate the links, which is what actually moves an address. Reload
    // alone leaves a link running on its previous configuration and reports success.
    const reloaded = await record('reload network configuration', async () => {
      const result = await platform.net.reload();
      return { ok: result.ok, detail: result.message === '' ? 'reloaded' : result.message };
    });
    if (!reloaded.ok) {
      return {
        applied: false,
        steps,
        refused,
        verificationFailures: [],
        error: {
          code: 'network_reload_failed',
          message: `systemd-networkd would not reload: ${reloaded.detail}`,
          hint: 'The files are written but not in effect. Nothing has been restarted.',
        },
      };
    }

    await record(`reconfigure ${desired.managedInterfaces.map((entry) => entry.name).join(', ') || '(no interfaces)'}`, async () => {
      const result = await platform.net.reconfigure(desired.managedInterfaces.map((entry) => entry.name));
      return { ok: result.ok, detail: result.message === '' ? 'reconfigured' : result.message };
    });

    /**
     * Wait for addresses, and do not fail when they do not arrive.
     *
     * A link that has not settled is recorded and the apply continues, because the units that follow
     * carry `Restart=on-failure` precisely for this race and because an uplink that is simply absent —
     * no cable, an access point out of range — is a valid state rather than a failed apply. Treating a
     * slow lease as an apply failure would make the outcome depend on the weather.
     *
     * The confirmation window is where an uplink that never comes up is caught, by a check that knows
     * the difference between "not yet" and "not at all".
     */
    await record(`wait for addressing to settle (up to ${NETWORK_SETTLE_MS / 1000}s)`, async () => {
      const settled = await platform.net.waitForSettle(desired.managedInterfaces, NETWORK_SETTLE_MS);
      const described = settled.perInterface
        .map(
          (entry) =>
            `${entry.name} (needs ${entry.expect}): carrier=${entry.carrier} address=${entry.address ?? 'none'}` +
            `${entry.ok ? '' : ' ← not yet'}`,
        )
        .join('; ');
      return {
        // Never a failure. See above: this is information for the window, not a gate.
        ok: true,
        detail: settled.settled ? `settled — ${described}` : `not settled in time — ${described}`,
      };
    });
  }

  /* ── 4. sysctl, after the network configuration and before the firewall ──────────────── */

  // Before the firewall, because a forwarding setting that arrives after the ruleset means the first
  // packets through are dropped by a rule whose premise is not yet true.
  for (const setting of plan.sysctlChanges) {
    if (!requested.has('network')) break;
    const written = await record(`set ${setting.key} to ${setting.to}`, async () => {
      await platform.sysctl.write(setting.key, setting.to);
      // Verified by reading it back rather than by the command's exit status. A key the kernel does
      // not have returns an error on some paths and silently does nothing on others.
      const readBack = await platform.sysctl.read(setting.key);
      return {
        ok: readBack === setting.to,
        detail: readBack === setting.to ? `${setting.key}=${readBack}` : `wrote ${setting.to}, read back ${readBack ?? 'nothing'}`,
      };
    });
    if (!written.ok) {
      return {
        applied: false,
        steps,
        refused,
        verificationFailures: [],
        error: {
          code: 'sysctl_failed',
          message: `Could not set ${setting.key}: ${written.detail}`,
          hint: `This setting exists because ${setting.reason}. Without it that will not work.`,
        },
      };
    }
  }

  /* ── 5–6. firewall, then time synchronisation. Never the other way round. ────────────── */

  const firewallApplied = plan.fileChanges.some(
    (change) => change.path.endsWith('nftables.conf') && APPLIABLE.has(change.blastRadius),
  );

  if (firewallApplied) {
    /**
     * Loaded by restarting the unit that loads it, not by running `nft` from here.
     *
     * One mechanism for the apply path and the boot path. The unit validates with `nft -c -f` in its
     * `ExecStartPre` and then loads, so what is exercised here is exactly what runs at the next boot —
     * whereas shelling out to `nft` would test a path the device never uses on its own, and leave the
     * boot path verified only by power-cycling, which nobody does on purpose.
     */
    const loaded = await record('load the firewall ruleset (wf-firewall.service)', async () => {
      const result = await platform.systemd.restart('wf-firewall.service');
      return { ok: result.result === 'done', detail: `${result.result} after ${result.waitedMs} ms` };
    });
    if (!loaded.ok) {
      return {
        applied: false,
        steps,
        refused,
        verificationFailures: [],
        error: {
          code: 'ruleset_load_failed',
          message: `The generated ruleset would not load: ${loaded.detail}`,
          hint:
            'Read `journalctl -u wf-firewall.service -b`: the unit validates with `nft -c -f` before ' +
            'loading, so the message names the line. Nothing that forwards traffic has been started, ' +
            'which is the right way round — the device is reachable and serving nobody.',
        },
      };
    }

    await record('mark the firewall ready (wf-firewall-ready.target)', async () => {
      const result = await platform.systemd.start('wf-firewall-ready.target');
      return { ok: result.result === 'done', detail: result.result };
    });

    /**
     * Time synchronisation, and only now.
     *
     * Restarting it before the ruleset is loaded sends the first query into the tunnel, where it is
     * lost — and a wrong clock makes every timestamp-authenticated transport fail while direct
     * connections work normally, which reads as broken tunnels rather than as a broken clock. The
     * bypass is a firewall rule, so the rule has to exist first.
     */
    await record(`restart ${input.timeSyncUnit} (after the firewall, never before)`, async () => {
      const result = await platform.systemd.restart(input.timeSyncUnit);
      return { ok: result.result === 'done', detail: result.result };
    });
  }

  /* ── 8–11. units, in order, enable before restart ────────────────────────────────────── */

  /**
   * A restart whose every reason was refused is **not performed, and is reported as a refusal**.
   *
   * ## The defect
   *
   * Six times in a row the core was restarted with a configuration file whose rewrite had been
   * refused, and this function recorded success every time. Each half was correct on its own: the
   * refusal named the file, the restart ran, systemd reported `done`. Nothing joined them, so an
   * apply that had changed nothing at all reported a successful restart of the thing it had not
   * changed — and the next plan, reading the same unwritten file, planned the same restart again.
   *
   * ## Why this is a refusal rather than a failed step
   *
   * A skip is a **decision not to act**, not an attempt that did not work. A step reporting
   * `ok: false` says "I tried and it did not succeed", and that did not happen — which is a lie of
   * exactly the family this mechanism exists to remove: a report of an action that never took place.
   * Recording a failure where there was no attempt would reintroduce the same disease from the other
   * side.
   *
   * It also goes in a channel that already exists. This function already tells a caller what it
   * declined to do and what each declined change needs; a skipped restart belongs there rather than
   * inventing a second way of saying one thing. And it is the difference between a caller that can
   * act and one that cannot: a script shown a refusal with its reason can re-run with the classes
   * those files need, while a script shown "the step failed" cannot, because nothing told it there
   * was nothing to succeed at.
   *
   * ## All, not any
   *
   * The test is that **every** path in `becauseOf` was refused. A restart may have been planned for a
   * second file in the same apply that *was* written, and skipping on one refused cause would leave
   * that second file on disk and never in force — the original defect with the sides swapped.
   *
   * The wrong version of this rule looks safer than the right one, which is why it is written out:
   * "any" skips more, and skipping reads as caution. It is not. It is the same silence moved.
   *
   * ## What is never skipped
   *
   * A step with no `becauseOf` at all. Absent means "not recorded", never "no causes" — a step
   * assembled somewhere that does not track causes must not be read as having been examined and
   * found causeless. An empty array cannot be produced by the differ and is treated as absent here
   * for the same reason, rather than as a set whose every member was vacuously refused.
   */
  const runnableUnitChanges: typeof plan.unitChanges = [];
  for (const change of plan.unitChanges) {
    if (!APPLIABLE.has(change.blastRadius)) continue;
    const causes = change.becauseOf;
    if (causes !== undefined && causes.length > 0 && causes.every((path) => refusedFilePaths.has(path))) {
      refused.push({
        what: `${change.action} ${change.name}`,
        blastRadius: change.blastRadius,
        needs:
          `the files it is for, every one of which this apply refused to write: ${causes.join(', ')}. ` +
          'Restarting now would put nothing new into force and would report success for a change that ' +
          'did not happen. Re-run with the class those files need, and the restart follows them.',
      });
      continue;
    }
    runnableUnitChanges.push(change);
  }

  const ordered = orderUnitChanges(runnableUnitChanges);

  for (const change of ordered) {
    const outcome = await record(`${change.action} ${change.name}`, async (): Promise<ToolOutcome> => {
      switch (change.action) {
        case 'install':
          // The unit *file* was written in step 2, through the same atomic path as every other managed
          // file. This is only telling systemd to look again: a unit file on disk that systemd has not
          // reloaded does not exist as far as `enable` is concerned, which is how an apply that wrote
          // everything correctly still failed with "Unit … does not exist".
          await platform.systemd.daemonReload();
          return { ok: true, detail: 'unit definition written, daemon reloaded' };

        case 'enable':
          await platform.systemd.enable(change.name);
          return { ok: true, detail: 'enabled' };

        case 'disable':
          await platform.systemd.disable(change.name);
          return { ok: true, detail: 'disabled' };

        case 'stop': {
          const stopped = await platform.systemd.stop(change.name);
          return { ok: stopped.result === 'done', detail: stopped.result };
        }

        case 'start':
        case 'restart': {
          // `StartUnit` returns a job, not a result: the call succeeding means the job was queued, and
          // whether the unit started arrives later as a JobRemoved signal. The platform layer waits for
          // it, which is why this reads the result rather than the call.
          const result =
            change.action === 'start'
              ? await platform.systemd.start(change.name)
              : await platform.systemd.restart(change.name);
          return { ok: result.result === 'done', detail: `${result.result} after ${result.waitedMs} ms` };
        }
      }
    });

    if (!outcome.ok) {
      return {
        applied: false,
        steps,
        refused,
        verificationFailures: [],
        error: {
          code: 'unit_failed',
          message: `${change.action} of ${change.name} did not succeed: ${outcome.detail}`,
          hint: `Read the unit's own log: journalctl -u ${change.name} -b.`,
        },
      };
    }
  }

  /* ── 12. verify: active AND enabled ──────────────────────────────────────────────────── */

  /**
   * How long **the verification phase as a whole** is given to settle, and how often a unit is asked.
   *
   * Chosen against the measured case: a `Restart=on-failure` unit with `RestartSec=2` needs one
   * restart, so anything under about five seconds would still be a coin toss.
   *
   * A budget for the phase rather than for each unit, and that distinction is not cosmetic. Per unit,
   * an apply where several units are genuinely down pays the wait once per unit — nine units, ninety
   * seconds — which turns a clear failure into an apply that looks hung. The converging system this
   * allows for is the device, not each unit separately: they settle in parallel because they were
   * started in parallel.
   */
  const VERIFY_SETTLE_MS = 10_000;
  const VERIFY_POLL_MS = 500;
  const verifyDeadline = Date.now() + VERIFY_SETTLE_MS;

  const verificationFailures: ReconcileResult['verificationFailures'] = [];

  // Only units this apply was allowed to act on. A unit whose change was refused has not been brought
  // to its desired state *by design*, and verifying it would report the refusal a second time as a
  // failure — which made a narrowed apply always fail, and would have made the `classes` escape hatch
  // useless. The refusal is already reported, in `refused`, where it says what it needs.
  const refusedUnits = new Set(
    plan.unitChanges
      .filter((change) => !APPLIABLE.has(change.blastRadius))
      .map((change) => change.name),
  );

  const toVerify = desired.units.filter(
    (unit) =>
      isOwnedUnit(unit.name) &&
      // A template is a file, not something that runs: only its instances have state.
      !unit.name.includes('@.') &&
      (unit.active || unit.enabled) &&
      !refusedUnits.has(unit.name),
  );

  for (const unit of toVerify) {
    let active = false;
    let enabled = false;

    const verified = await record(`verify ${unit.name}`, async () => {
      /*
       * Sampled over a short window rather than once.
       *
       * A unit with `Restart=` is a converging system, and one sample of a converging system is not a
       * verdict. Measured on the bench board, 2026-09-20: restarting the access point takes its
       * interface away for a moment, `dnsmasq` starts into `unknown interface wlx90de8047b4b4`, exits,
       * and `Restart=on-failure` brings it back two seconds later — healthy. Verification read it in
       * the gap and failed an apply that had in fact worked, twice.
       *
       * This is **not** "wait until it passes". The window is small and fixed, a unit still wrong at
       * the end of it is still a failure, and the elapsed time is reported so that a unit which only
       * just made it is visible rather than silently equivalent to one that was ready immediately.
       */
      const startedAt = Date.now();
      let settledAfterMs = 0;
      for (;;) {
        const state = await platform.systemd.state(unit.name);
        active = state.isActive === true;
        enabled = state.isEnabled === true;
        settledAfterMs = Date.now() - startedAt;
        if ((!unit.active || active) && (!unit.enabled || enabled)) break;
        // The phase's deadline, shared by every unit, not a fresh wait for each one.
        if (Date.now() >= verifyDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS));
      }
      return {
        ok: (!unit.active || active) && (!unit.enabled || enabled),
        // Both, reported separately. Checking only the active state produces a device that works until
        // it is power-cycled, and a line that does not distinguish them hides exactly that.
        detail:
          `active=${active} enabled=${enabled}` + (settledAfterMs >= VERIFY_POLL_MS ? ` after ${settledAfterMs} ms` : ''),
      };
    });

    if (!verified.ok) {
      verificationFailures.push({
        unit: unit.name,
        active,
        enabled,
        expected: `active=${unit.active} enabled=${unit.enabled}`,
      });
    }
  }

  if (verificationFailures.length > 0) {
    return {
      applied: false,
      steps,
      refused,
      verificationFailures,
      error: {
        code: 'verification_failed',
        message:
          'Everything was applied, but verification did not pass: ' +
          verificationFailures
            .map((entry) => `${entry.unit} is active=${entry.active} enabled=${entry.enabled}, expected ${entry.expected}`)
            .join('; '),
        hint:
          'A unit that is active but not enabled works now and is gone after a reboot, which is why ' +
          'both are checked. Read the unit log for the one that failed.',
      },
    };
  }

  return { applied: true, steps, refused, verificationFailures: [] };
}

/** The path prefix for this apply, so a rehearsal against a scratch tree probes the scratch tree. */
function prefixOf(options: ReconcileOptions): string {
  return options.pathPrefix ?? '';
}

function needsFor(blastRadius: BlastRadius): string {
  if (blastRadius === 'network') {
    return (
      'the confirmation window. A change that can cost access is applied with a deadline and a revert ' +
      'timer outside this process, and the device brings itself back if nobody confirms. Ask for the ' +
      'network class explicitly, through the path that arms that timer.'
    );
  }
  return 'a reboot to take effect.';
}

/**
 * Only the files whose own change is in a class this apply was asked to perform.
 *
 * The class set is a parameter rather than a module constant, because it is now a property of the
 * *call*: the same reconciler applies two classes for a routine change and four for one that went
 * through the confirmation window.
 */
function filesFor(desired: DesiredState, plan: Plan2, appliableClasses: ReadonlySet<BlastRadius>): ManagedFile[] {
  const appliable = new Set(
    plan.fileChanges.filter((change) => appliableClasses.has(change.blastRadius)).map((change) => change.path),
  );
  return [...desired.files, ...desired.networkFiles].filter((file) => appliable.has(file.path));
}

function wantsCore(plan: Plan2): boolean {
  return plan.unitChanges.some((change) => change.name === 'wf-core.service');
}

/**
 * Sorts unit actions into the fixed order.
 *
 * Two rules the sort exists for, and neither is expressible as "sort by name": every `enable` for a
 * unit precedes its `start` or `restart`, and the listeners a tunnel connects to come up before the
 * tunnel does — a transport that is not listening yet is a tunnel that fails its first connection and
 * then waits out a restart interval.
 */
export function orderUnitChanges<T extends { name: string; action: string }>(changes: T[]): T[] {
  const stage = (change: T): number => {
    if (change.action === 'install') return 0;
    if (change.action === 'disable' || change.action === 'stop') return 1;
    if (change.action === 'enable') return 2;
    if (change.name.startsWith('wf-dhcp@')) return 3;
    if (change.name.startsWith('wf-transport@')) return 4;
    if (change.name.startsWith('wf-socks@')) return 5;
    if (change.name.startsWith('wf-openvpn@')) return 6;
    if (change.name === 'wf-core.service') return 7;
    return 8;
  };

  // A stable sort, so two changes in the same stage keep the order the planner produced them in —
  // which is the order the profile lists them, and therefore an order somebody chose.
  return changes
    .map((change, index) => ({ change, index }))
    .sort((a, b) => stage(a.change) - stage(b.change) || a.index - b.index)
    .map((entry) => entry.change);
}
