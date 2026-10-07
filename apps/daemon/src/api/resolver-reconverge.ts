/**
 * What to record after re-deriving the configuration because a peer pushed a different resolver.
 *
 * ## The defect this exists for
 *
 * Re-deriving used to record `resolver.reconverged` the moment `applyDocument` returned without
 * throwing. It had `outcome.result.refused` in its hand — a list whose own declaration in the
 * reconciler says *"changes deliberately not applied, each with the reason. Never silently
 * dropped"* — and it did not look at it. It also ignored `outcome.ok`, which is how that function
 * reports failure at least as often as by throwing.
 *
 * **Measured on the bench board, 2026-09-21.** A corporate tunnel reconnected at 12:41 and its peer
 * pushed a new resolver address. The capture fired, the file was written, the watcher fired, and
 * "resolver reconverged" was recorded at 12:41:39 and five more times after. Meanwhile
 * `/etc/wayfarer/core/config.json` had not been rewritten since 11:41:10, and the core was restarted
 * at 13:07 anyway. The resolver the device was using was dead: probed through the tunnel, the live
 * one answered in 120 ms and ours timed out three times running. Corporate names did not resolve for
 * the owner, and the log said the device had handled it — six times.
 *
 * The cause is a deadlock between classes. Re-deriving applies with the classes narrowed to `hot`
 * and `service`, deliberately, so that a value captured from a peer can never reconfigure the
 * network. But the same reconnection changed the tunnel's own subnet, the difference reaches the
 * `ip_cidr` lists, the change is promoted to `network`, and the narrowed apply refuses the file
 * write **while still performing the unit restart**. The mechanism is not wired to nothing; it is
 * wired to a gate it can never pass, because an OpenVPN reconnection that changes DNS nearly always
 * changes the subnet too.
 *
 * Narrowing that promotion is a separate change in the planner. This module fixes the half that is
 * more fundamental and would matter even with the classes right: **a report of an action is not the
 * action.** Here it was worse than the usual form of that mistake — the report was not merely
 * unverified, it was holding the evidence and did not read it.
 *
 * ## Why the verdict counts refusals rather than matching a path
 *
 * A `RefusedChange` carries `what` as prose — `"write /etc/wayfarer/core/config.json"` — so the
 * obvious check is to look for the core's configuration in that string. That check fails **open**:
 * change how `what` is composed and it quietly stops matching, and this starts reporting success
 * again. That is the defect being fixed, reintroduced by the fix.
 *
 * So the verdict rests on the count, which cannot rot. **Any** refusal means the apply did not do
 * all of what it was asked, and it does not get to call itself a success. The path match is still
 * performed, but only to sharpen the wording: when it matches, the message can say outright that the
 * captured resolver is not in use; when it does not, the message says the outcome is not
 * established. Either way the reader gets the whole refused list, and either way it is not success.
 *
 * Unestablished is its own answer here, exactly as `unknown` is for an interface class. "We refused
 * some of this and cannot show the resolver landed" and "the resolver landed" are different facts,
 * and only one of them means nobody needs to look.
 *
 * ## What was still missing, and was measured again on 2026-09-22
 *
 * The absence of refusals was being read as success. It is not one: an apply can refuse nothing and
 * write nothing, and the two are indistinguishable from the outcome alone. On the bench board that
 * day `resolver.reconverged` was recorded twice while `/etc/wayfarer/core/config.json` still named
 * `10.184.40.5`, its mtime unmoved, with `10.184.100.5` sitting in `/run/wayfarer/tunnel/hq.dns`.
 * `wplan.hq.lan` did not resolve for anybody on the network, and the log said it had been
 * handled — again.
 *
 * So the success is now emitted **from the file the core reads**, not from the attempt: the caller
 * reads the generated configuration back and compares it with what the peers pushed, and hands the
 * comparison in. Without that comparison there is no success to report — a missing verification
 * produces `resolver.reconverge-unverified`, because "nobody checked" is not "it worked". That is
 * the one rule this module exists for, applied to itself.
 */

import type { ApplyOutcome } from '../core/apply.ts';
import type { RefusedChange } from '../core/reconciler.ts';
import { PATHS } from '../core/desired-state.ts';
import { describeDivergence, type ResolverDivergence } from '../core/resolver-convergence.ts';

export interface ReconvergeEvent {
  level: 'info' | 'warn';
  kind:
    | 'resolver.reconverged'
    | 'resolver.reconverge-refused'
    | 'resolver.reconverge-failed'
    | 'resolver.reconverge-unverified';
  summary: string;
  detail: Record<string, unknown>;
}

/**
 * What the core's configuration says **after** the apply, compared with what the peers pushed.
 *
 * `readable` is separate from an empty `divergent` on purpose. A configuration that could not be read
 * or parsed produces no divergences to list, and reporting that as "nothing diverged" would be the
 * fail-open shape this module already refuses once: the absence of evidence read as evidence.
 */
export interface ReconvergeVerification {
  /** Whether the generated configuration could be read back and parsed at all. */
  readable: boolean;
  /** Tunnels whose captured resolver is still not the one the core was given. Empty is convergence. */
  divergent: ResolverDivergence[];
  /** The resolvers the core is now configured with, by tunnel id — the evidence behind a success. */
  inUse: { tunnelId: string; address: string }[];
}

/** The refusals, phrased for a person: what was skipped, how big it was, and what it would need. */
function describe(refused: RefusedChange[]): string {
  return refused.map((entry) => `${entry.what} (${entry.blastRadius}; needs ${entry.needs})`).join('; ');
}

/**
 * Turn the result of a re-derive into the one event that should be recorded for it.
 *
 * A pure function, and separate from the daemon's start-up, for the reason the bind policy's gate is
 * separate: `reconvergeForResolvers` is a closure inside `main()`, and `main()` runs on import. A
 * verdict that can only be reached by starting the daemon cannot be tested, and an untested verdict
 * about whether something succeeded is how this defect survived six reconnections.
 */
export function resolverReconvergeEvent(
  outcome: ApplyOutcome,
  verification?: ReconvergeVerification,
): ReconvergeEvent {
  const transaction = outcome.transaction?.id ?? null;

  // Refused before a transaction existed: every change was of a class this caller may not apply.
  if (!outcome.ok && outcome.error?.code === 'nothing_permitted') {
    const refused = (outcome.error.detail as { refused?: { what: string; blastRadius: string }[] } | undefined)?.refused ?? [];
    return {
      level: 'warn',
      kind: 'resolver.reconverge-refused',
      summary:
        'a peer pushed a different resolver, but every change re-deriving needed is of a class this apply ' +
        "does not make (only 'hot' and 'service'), so the captured resolver is NOT in use and no transaction " +
        `was opened: ${refused.map((entry) => `${entry.what} (${entry.blastRadius})`).join('; ')}`,
      detail: {
        transaction: null,
        coreConfigRefused: refused.some((entry) => entry.what.includes(PATHS.coreConfig)),
        coreConfigPath: PATHS.coreConfig,
        refused,
      },
    };
  }

  // Failure reported by return value rather than by throwing. The caller's `catch` never saw these.
  if (!outcome.ok) {
    return {
      level: 'warn',
      kind: 'resolver.reconverge-failed',
      summary:
        'a peer pushed a different resolver and re-deriving the configuration failed: ' +
        `${outcome.error?.message ?? 'no reason was reported'}. The captured resolver is not in use.`,
      detail: { transaction, error: outcome.error ?? null },
    };
  }

  const refused = outcome.result?.refused ?? [];
  if (refused.length > 0) {
    const coreConfigRefused = refused.some((entry) => entry.what.includes(PATHS.coreConfig));
    return {
      level: 'warn',
      kind: 'resolver.reconverge-refused',
      summary:
        `a peer pushed a different resolver, but ${refused.length} change(s) that re-deriving needed ` +
        "were refused, because it only applies the 'hot' and 'service' classes" +
        (coreConfigRefused
          ? `, and ${PATHS.coreConfig} was one of them — so the captured resolver is NOT in use, ` +
            'whatever else this apply restarted'
          : '. Whether the captured resolver reached the core is therefore not established') +
        `: ${describe(refused)}`,
      detail: {
        transaction,
        state: outcome.transaction?.state ?? null,
        coreConfigRefused,
        coreConfigPath: PATHS.coreConfig,
        refused,
      },
    };
  }

  /*
   * Nothing refused, which used to end the matter. It does not: an apply that changes no file refuses
   * nothing either. The verdict below comes from the generated configuration as it now stands.
   */
  if (verification === undefined || !verification.readable) {
    return {
      level: 'warn',
      kind: 'resolver.reconverge-unverified',
      summary:
        'a peer pushed a different resolver and re-deriving refused nothing, but ' +
        `${PATHS.coreConfig} could not be read back, so whether the captured resolver is in use is ` +
        'not established',
      detail: {
        transaction,
        state: outcome.transaction?.state ?? null,
        refused: [],
        coreConfigPath: PATHS.coreConfig,
        readable: verification?.readable ?? false,
      },
    };
  }

  if (verification.divergent.length > 0) {
    return {
      level: 'warn',
      kind: 'resolver.reconverge-unverified',
      summary:
        'a peer pushed a different resolver and re-deriving refused nothing, but ' +
        `${PATHS.coreConfig} still does not name what was captured, so the captured resolver is NOT ` +
        `in use: ${describeDivergence(verification.divergent)}`,
      detail: {
        transaction,
        state: outcome.transaction?.state ?? null,
        refused: [],
        coreConfigPath: PATHS.coreConfig,
        readable: true,
        divergent: verification.divergent,
      },
    };
  }

  return {
    level: 'info',
    kind: 'resolver.reconverged',
    summary:
      'a peer pushed a different resolver, and the core is now configured with what was captured: ' +
      (verification.inUse.length === 0
        ? 'no tunnel takes its resolver from its peer'
        : verification.inUse.map((entry) => `${entry.tunnelId} -> ${entry.address}`).join('; ')),
    detail: {
      transaction,
      state: outcome.transaction?.state ?? null,
      refused: [],
      coreConfigPath: PATHS.coreConfig,
      inUse: verification.inUse,
    },
  };
}
