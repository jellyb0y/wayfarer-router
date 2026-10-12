/**
 * Notices policy rules that have gone and puts them back.
 *
 * The networkd drop-in (`planner.ts`) stops the one remover measured so far; this exists for whatever
 * removes them next, and for a device the drop-in has not reached yet. Without the device's own bypass
 * the tunnel clients loop into the tunnel and nothing can recover; without the core's capture the leak
 * guard (`generate/firewall.ts`) refuses clients instead of letting them past the tunnels — closed, but
 * with no internet. Either way a person would otherwise need a shell on the device to find out.
 *
 * It looks every {@link RULES_WATCH_CHECK_MS} and as soon as a policy rule changes. It never acts during
 * an apply — the apply restarts these units itself and checks the rules at its end — and it backs off:
 * one repair per {@link RULES_REPAIR_MIN_INTERVAL_MS}, and after {@link RULES_REPAIR_ATTEMPTS} repairs in
 * a row that did not hold it reports itself failing and stops restarting, so a cause it cannot fix does
 * not turn into a restart loop of the units that carry the traffic.
 */
import type { Platform } from '../platform/index.ts';
import type { ObserverRegistry } from './observers.ts';
import { describePolicyRules, readPolicyRules } from './policy-rules.ts';
import { reassertPolicyRules } from './reconciler.ts';

export const RULES_WATCH_CHECK_MS = 30_000;
export const RULES_REPAIR_MIN_INTERVAL_MS = 60_000;
export const RULES_REPAIR_ATTEMPTS = 3;

export interface RulesWatch {
  /** Look now, outside the cadence. Returns when the look (and any repair) is done. */
  check(): Promise<void>;
  stop(): void;
}

export function watchPolicyRules(input: {
  observers: ObserverRegistry;
  platform: Platform;
  timePorts: number[];
  /** An apply is running: it owns these units until it ends. */
  applying: () => boolean;
  record: (event: { level: 'info' | 'warn' | 'error'; kind: string; summary: string; detail?: unknown }) => void;
  checkMs?: number;
  /** Monotonic milliseconds; injected so the back-off can be tested without waiting. */
  now?: () => number;
}): RulesWatch {
  const checkMs = input.checkMs ?? RULES_WATCH_CHECK_MS;
  const now = input.now ?? (() => performance.now());
  const observer = input.observers.register({
    name: 'policy-rules',
    watches: "the policy rules that keep this device's own traffic direct and clients inside the tunnels",
    everyMs: checkMs,
  });

  let lastRepairAt: number | null = null;
  let failedRepairs = 0;
  let running: Promise<void> | null = null;

  const look = async (): Promise<void> => {
    const rules = await input.platform.net.rules();
    if (rules === null) {
      observer.looked('could not read the policy rules');
      return;
    }
    // The core's capture is expected exactly while its unit is active: a core that is not running has
    // no rules to have lost, and whether it should be running is the watchdog's and the apply's question.
    const coreActive = (await input.platform.systemd.state('wf-core.service')).isActive;
    const reading = readPolicyRules({ rules, timePorts: input.timePorts, coreActive });
    const saw = describePolicyRules(reading);
    observer.looked(saw);
    if (reading.missingBypass.length === 0 && !reading.coreCaptureMissing) {
      failedRepairs = 0;
      observer.failing(null);
      return;
    }

    if (input.applying()) {
      observer.looked(`${saw}; an apply is running and restores them itself, so nothing was done`);
      return;
    }
    if (failedRepairs >= RULES_REPAIR_ATTEMPTS) {
      observer.failing(`${saw}; ${String(RULES_REPAIR_ATTEMPTS)} repairs did not hold, so no more are attempted until they reappear`);
      return;
    }
    if (lastRepairAt !== null && now() - lastRepairAt < RULES_REPAIR_MIN_INTERVAL_MS) {
      observer.failing(`${saw}; the next repair is allowed once a minute has passed since the last`);
      return;
    }

    lastRepairAt = now();
    const steps: string[] = [];
    const result = await reassertPolicyRules(input.platform, { policyRules: { timePorts: input.timePorts, core: true } }, async (step, run) => {
      const outcome = await run();
      steps.push(`${step}: ${outcome.ok ? 'ok' : 'failed'} (${outcome.detail})`);
      return outcome;
    });
    failedRepairs = result.ok ? 0 : failedRepairs + 1;
    observer.acted(`restarted ${result.acted.join(' and ') || 'nothing'}: ${result.after}`);
    observer.failing(result.ok ? null : result.after);
    input.record({
      level: result.ok ? 'warn' : 'error',
      kind: 'policy-rules.reinstated',
      summary: result.ok
        ? `policy rules were missing and were put back: ${result.before}`
        : `policy rules are missing and a repair did not restore them: ${result.after}`,
      detail: { before: result.before, after: result.after, restarted: result.acted, steps },
    });
  };

  const check = (): Promise<void> => {
    // One look at a time: a burst of rule events during a repair must not start a second repair.
    running ??= look()
      .catch((error: unknown) => observer.looked(`the check failed: ${String(error)}`))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const timer = setInterval(() => void check(), checkMs);
  timer.unref();
  const monitor = input.platform.net.watchRules(() => void check());
  observer.armed();
  void check();

  return {
    check,
    stop(): void {
      clearInterval(timer);
      monitor.stop();
    },
  };
}
