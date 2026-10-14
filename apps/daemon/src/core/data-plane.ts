/**
 * Whether client traffic actually leaves the device after a network change — checked inside the
 * confirmation window, and acted on.
 *
 * ## The symptom it exists for
 *
 * Measured on the bench board, 2026-10-11 21:15–21:31 MSK: after a reboot the device's own-traffic policy
 * rules were missing, the VLESS clients' transport looped into the tunnel, every member was unhealthy and
 * `wf-selector` stood on `block`. By every local measure the window watch takes the device was fine:
 * hostapd up, the uplink with carrier and address, `wf-core` active. No client could open a page. The
 * same holds for a tunnel whose server resets every connection (2026-10-11, the dropped HTTP disguise):
 * the units run, the traffic does not.
 *
 * So the window now also asks the question a person asks: **does a name resolve, and does a request get
 * an answer, along the path a client's traffic takes.**
 *
 * * The name is resolved by the resolver a client is handed (the device's LAN address, which DHCP
 *   advertises), so the dnsmasq → upstream path is what is measured.
 * * The request goes through `wf-selector` via the core's control interface when the plan runs the core,
 *   because that selector is where unmatched client traffic goes — egress, fallback or `block`. Without a
 *   core, client traffic is forwarded by the kernel over the uplink, and the request is made from the
 *   device itself, which takes the same uplink.
 *
 * ## When it reverts, and when it only reports
 *
 * Confirmation stays an explicit act; this never confirms anything. It **reverts** when, after a warm-up
 * for tunnels to connect and groups to pick a member, the check has failed several times in a row **and
 * the same check passed before the change**. If it failed before the change too, the change did not
 * break the traffic and going back would not bring it back, so the reading is recorded as `advisory`
 * and the person decides. Reverting a change for a fault it did not cause is how a device on a dead
 * uplink becomes impossible to configure.
 */

import { CORE_TAGS } from '@wayfarer/schemas';
import type { CheckOutcome } from './liveness.ts';
import type { DataPlaneReading } from '../state/profiles.ts';

export interface DataPlaneDeps {
  /** A request through one of the core's outbounds, as `CoreApi.check` makes it. */
  throughCore(outbound: string, url: string, timeoutMs: number): Promise<CheckOutcome>;
  /** A request made by the device itself, over the uplink. Used only where the plan runs no core. */
  direct(url: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }>;
  /** One name resolved by one resolver. */
  resolve(server: string, host: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }>;
  sleep?(ms: number): Promise<void>;
  nowMs?(): number;
}

/** What one check is about: the plan's answer to "which path does a client take". */
export interface DataPlaneTarget {
  /** The resolver a client is handed, or `null` when this device serves no local network. */
  resolver: string | null;
  /** The probe endpoints, from `policy.probes.endpoints`. */
  endpoints: string[];
  /** Whether the plan runs the core, so client traffic leaves through `wf-selector`. */
  viaCore: boolean;
}

export interface DataPlaneCheck {
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

const REQUEST_TIMEOUT_MS = 5_000;
const RESOLVE_TIMEOUT_MS = 3_000;

/**
 * Tunnels need a moment to connect and a group's selector a watchdog round to move off a dead member;
 * a failure inside this interval says nothing about the change. Chosen, not measured: the slowest
 * carrier seen on the bench board (the external VLESS client) answered within ~10 s of its unit starting,
 * and the watchdog's default round is 30 s. [assumption]
 */
export const DATA_PLANE_WARMUP_MS = 60_000;
export const DATA_PLANE_INTERVAL_MS = 5_000;
/** Consecutive failures after the warm-up before the window acts. One lost probe is noise. */
export const DATA_PLANE_FAILURES_TO_ACT = 3;
/**
 * How long the check may run in all. Inside the 180 s window with room to spare, so a revert this check
 * asks for lands before the timer's own and is reported as the check's.
 */
export const DATA_PLANE_BUDGET_MS = 140_000;

/** One check: the name, then the request. Every endpoint is tried before the request is called failed. */
export async function checkDataPlane(deps: DataPlaneDeps, target: DataPlaneTarget): Promise<DataPlaneCheck> {
  const first = target.endpoints[0];
  if (first === undefined) return { ok: false, detail: 'no probe endpoint is configured' };

  if (target.resolver !== null) {
    const host = hostOf(first);
    if (host !== null && !isAddress(host)) {
      const resolved = await deps.resolve(target.resolver, host, RESOLVE_TIMEOUT_MS);
      if (!resolved.ok) return { ok: false, detail: `${host} did not resolve through ${target.resolver}: ${resolved.detail}` };
    }
  }

  const failures: string[] = [];
  for (const url of target.endpoints) {
    if (target.viaCore) {
      const answer = await deps.throughCore(CORE_TAGS.selector, url, REQUEST_TIMEOUT_MS);
      if (answer.kind === 'answered') return { ok: true, detail: `${url} answered through ${CORE_TAGS.selector}`, latencyMs: answer.ms };
      failures.push(`${url}: ${answer.why}`);
    } else {
      const started = (deps.nowMs ?? Date.now)();
      const answer = await deps.direct(url, REQUEST_TIMEOUT_MS);
      if (answer.ok) return { ok: true, detail: `${url} answered over the uplink`, latencyMs: (deps.nowMs ?? Date.now)() - started };
      failures.push(`${url}: ${answer.detail}`);
    }
  }
  return { ok: false, detail: `no endpoint answered (${failures.join('; ')})` };
}

export interface DataPlaneWatch {
  stop(): void;
  /** Settles when the watch has reached a verdict or been stopped. */
  done: Promise<void>;
}

/**
 * Checks until the traffic is seen to work, or until it has failed long enough to act on.
 *
 * `baselinePassed` is the same check made before the change. Only `true` lets a failure revert: see the
 * file comment for why `false` and `null` (could not be told) only report.
 */
export function watchDataPlane(input: {
  deps: DataPlaneDeps;
  target: DataPlaneTarget;
  baselinePassed: boolean | null;
  record: (reading: DataPlaneReading) => void;
  /** Asked for once, when the check has failed after a baseline that passed. */
  revert: (reason: string) => Promise<void>;
  warmupMs?: number;
  intervalMs?: number;
  failuresToAct?: number;
  budgetMs?: number;
}): DataPlaneWatch {
  const sleep = input.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  const nowMs = input.deps.nowMs ?? Date.now;
  const warmupMs = input.warmupMs ?? DATA_PLANE_WARMUP_MS;
  const intervalMs = input.intervalMs ?? DATA_PLANE_INTERVAL_MS;
  const failuresToAct = input.failuresToAct ?? DATA_PLANE_FAILURES_TO_ACT;
  const budgetMs = input.budgetMs ?? DATA_PLANE_BUDGET_MS;
  const at = (): string => new Date().toISOString();
  let stopped = false;

  const run = async (): Promise<void> => {
    const started = nowMs();
    input.record({ state: 'pending', detail: 'checking that names resolve and a request is answered', at: at() });
    let streak = 0;
    let last = 'not checked yet';
    for (;;) {
      if (stopped) return;
      const check = await checkDataPlane(input.deps, input.target).catch(
        (error: unknown): DataPlaneCheck => ({ ok: false, detail: `the check itself failed: ${String(error)}` }),
      );
      if (stopped) return;
      if (check.ok) {
        input.record({ state: 'passed', detail: check.detail, at: at(), ...(check.latencyMs === undefined ? {} : { latencyMs: check.latencyMs }) });
        return;
      }
      last = check.detail;
      const elapsed = nowMs() - started;
      // Failures inside the warm-up are not counted: see `DATA_PLANE_WARMUP_MS`.
      if (elapsed >= warmupMs) streak += 1;
      if (streak >= failuresToAct || elapsed + intervalMs > budgetMs) break;
      input.record({ state: 'pending', detail: `not yet: ${check.detail}`, at: at() });
      await sleep(intervalMs);
    }
    if (stopped) return;

    if (input.baselinePassed !== true) {
      const before = input.baselinePassed === false ? 'it failed before the change too' : 'whether it passed before the change could not be told';
      input.record({ state: 'advisory', detail: `${last}; not reverted, because ${before}`, at: at() });
      return;
    }
    input.record({ state: 'failed', detail: last, at: at() });
    await input.revert(`client traffic stopped working after the change and worked before it: ${last}`);
  };

  const done = run();
  return {
    stop(): void {
      stopped = true;
    },
    done,
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function isAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}
