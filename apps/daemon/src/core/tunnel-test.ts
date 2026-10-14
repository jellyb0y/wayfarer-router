/**
 * Testing a tunnel configuration before it is saved or applied: a throwaway client, one request through
 * it, and the client's own words when it fails.
 *
 * ## The symptom it exists for
 *
 * Measured on the bench board, 2026-10-11: a profile was switched to two VLESS tunnels parsed from a
 * subscription, and both were dead — the parser had dropped `headerType=http`, and the server reset every
 * connection made without the disguise. Nothing could have said so before the switch: the only way to try
 * a configuration was to apply it, and the only place the reason appeared was the external client's log,
 * read over a shell, at a level (`warning`) that hid it. A person changing servers needs the answer
 * **before** the change: does this configuration connect, and if not, what did the client say.
 *
 * ## How
 *
 * The configuration is planned by its catalogue entry exactly as an apply would plan it — the same carrier
 * decision, the same external client configuration — and run in a private directory with processes that
 * live for this request only:
 *
 * * a proxy core with the planned outbound and its control interface on a free loopback port, asked for
 *   a delay through that outbound, the same question the watchdog asks of a running tunnel;
 * * for an external carrier, the external client as well, at `debug`, because its log is the answer.
 *
 * Nothing configured is touched: no managed file, no unit, no port of the running plan. Entries whose
 * tunnel is an interface of its own (OpenVPN, Cloak) are not tested this way — standing one up would
 * create an interface and routes beside the running ones, which is a change, not a test.
 */

import { looksLikeSecretField } from '@wayfarer/protocols';
import type { TunnelProtocol } from '@wayfarer/schemas';
import type { ScopedProcess } from '../platform/exec.ts';
import type { Scratch } from '../platform/scratch.ts';
import { catalogueEntry, type CarrierChoice, type EntryPlanContext } from './catalogue/index.ts';
import { secretText } from './catalogue/values.ts';
import type { CheckOutcome } from './liveness.ts';

export interface TunnelTestDeps {
  scratch(prefix: string): Promise<Scratch>;
  spawn(command: string, args: string[]): ScopedProcess;
  freePort(): Promise<number>;
  /** The core's control interface at `bind`: whether it answers, and a delay through one outbound. */
  coreAvailable(bind: string): Promise<boolean>;
  check(bind: string, outbound: string, url: string, timeoutMs: number): Promise<CheckOutcome>;
  /** Where the proxy core and the external client are installed, or `null` when they are not. */
  binaries(): Promise<{ core: string | null; xray: string | null }>;
  sleep?(ms: number): Promise<void>;
  nowMs?(): number;
}

export type TunnelTestStage = 'plan' | 'unsupported' | 'start' | 'request';

export interface TunnelTestResult {
  ok: boolean;
  latencyMs?: number;
  endpoint?: string;
  carrier?: CarrierChoice;
  failure?: { stage: TunnelTestStage; message: string };
  /** The clients' last lines, credentials removed. Present on a failure, and on a success when asked. */
  log: string[];
}

/** The whole test, end to end. A tunnel that has not answered by then is reported as not answering. */
export const TUNNEL_TEST_TIMEOUT_MS = 15_000;
const OUTBOUND = 'wf-test';

export async function testTunnel(
  deps: TunnelTestDeps,
  input: { protocol: TunnelProtocol; config: unknown; endpoints: string[]; timeoutMs?: number },
): Promise<TunnelTestResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  const nowMs = deps.nowMs ?? Date.now;
  const deadline = nowMs() + (input.timeoutMs ?? TUNNEL_TEST_TIMEOUT_MS);
  const redact = redactorFor(input.config);

  const carrierPort = await deps.freePort();
  const context: EntryPlanContext = {
    tunnel: { id: OUTBOUND, name: 'the tested configuration', index: 0 },
    // Nothing known about the core: an entry must then offer everything, which is what a test wants —
    // whether the core can run it is the start step's to find out, in the core's own words.
    core: { known: false, outboundTypes: new Set() },
    installed: new Set(),
    allocatePort: () => carrierPort,
  };
  const planned = catalogueEntry(input.protocol).plan(input.config, context);
  if (!planned.ok) return { ok: false, failure: { stage: 'plan', message: planned.refusal.reason }, log: [] };
  const plan = planned.plan;

  const ownProcess = plan.units.some((unit) => !unit.name.startsWith('wf-socks@')) || plan.interfaces.length > 0 || plan.target !== 'outbounds';
  if (ownProcess) {
    return {
      ok: false,
      failure: {
        stage: 'unsupported',
        message:
          `A ${input.protocol} tunnel is an interface of its own, and standing one up beside the running ones would ` +
          'change the device rather than test a configuration. Apply it, and its health shows within a minute.',
      },
      log: [],
    };
  }

  const installed = await deps.binaries();
  if (installed.core === null) {
    return { ok: false, carrier: plan.carrier!, failure: { stage: 'start', message: 'The proxy core is not installed on this device.' }, log: [] };
  }
  const external = plan.units.length > 0;
  if (external && installed.xray === null) {
    return {
      ok: false,
      carrier: plan.carrier!,
      failure: { stage: 'start', message: `This configuration needs the external client (${plan.carrier?.reason ?? ''}), and it is not installed.` },
      log: [],
    };
  }

  const scratch = await deps.scratch('wayfarer-tunnel-test-');
  const processes: ScopedProcess[] = [];
  const log = (): string[] => processes.flatMap((child) => child.tail()).map(redact).slice(-40);
  try {
    if (external) {
      const clientFile = plan.files.find((file) => file.path.endsWith('.json'));
      if (clientFile === undefined) throw new Error('the plan for the external client holds no configuration file');
      const client = JSON.parse(clientFile.content) as Record<string, unknown>;
      // Its log is the answer when a handshake is refused; at `warning` the reason is not in it.
      client['log'] = { loglevel: 'debug' };
      const path = await scratch.write('client.json', JSON.stringify(client));
      processes.push(deps.spawn(installed.xray!, ['run', '-config', path, '-format', 'json']));
    }

    const apiPort = await deps.freePort();
    const bind = `127.0.0.1:${String(apiPort)}`;
    const core = {
      log: { level: 'debug', timestamp: false },
      outbounds: [{ ...plan.object, tag: OUTBOUND }, { type: 'direct', tag: 'direct' }],
      route: { final: OUTBOUND },
      experimental: { clash_api: { external_controller: bind } },
    };
    const corePath = await scratch.write('core.json', JSON.stringify(core));
    processes.push(deps.spawn(installed.core, ['run', '-c', corePath]));

    // Up when its control interface answers; a client that exits first failed to start.
    for (;;) {
      const exited = processes.find((child) => child.done());
      if (exited !== undefined) {
        return { ok: false, carrier: plan.carrier!, failure: { stage: 'start', message: 'A client exited as soon as it started.' }, log: log() };
      }
      if (await deps.coreAvailable(bind)) break;
      if (nowMs() > deadline) {
        return { ok: false, carrier: plan.carrier!, failure: { stage: 'start', message: 'The proxy core did not come up in time.' }, log: log() };
      }
      await sleep(200);
    }

    let last = 'nothing was asked';
    while (nowMs() < deadline) {
      for (const endpoint of input.endpoints) {
        const remaining = Math.max(1000, Math.min(5000, deadline - nowMs()));
        const answer = await deps.check(bind, OUTBOUND, endpoint, remaining);
        if (answer.kind === 'answered') return { ok: true, latencyMs: answer.ms, endpoint, carrier: plan.carrier!, log: [] };
        last = `${endpoint}: ${answer.why}`;
      }
      await sleep(500);
    }
    return { ok: false, carrier: plan.carrier!, failure: { stage: 'request', message: `No endpoint answered through it (${last}).` }, log: log() };
  } finally {
    await Promise.all(processes.map(async (child) => await child.stop()));
    await scratch.remove();
  }
}

/**
 * Removes the configuration's credentials from log lines.
 *
 * A client at `debug` can print the account id it presents, and these lines go into an API response and
 * onto a screen. Every value at a position whose name reads as a secret is replaced, and so is the VLESS
 * account id, which is a credential under a name (`id`) that reads as nothing.
 */
function redactorFor(config: unknown): (line: string) => string {
  const values = new Set<string>();
  const walk = (value: unknown, key: string | null): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'object' && !Array.isArray(value) && !('$secret' in value)) {
      for (const [name, inner] of Object.entries(value as Record<string, unknown>)) walk(inner, name);
      return;
    }
    if (key !== null && (key === 'id' || looksLikeSecretField(key))) {
      const text = secretText(value);
      if (text.length >= 4) values.add(text);
    }
  };
  walk(config, null);
  return (line) => {
    let out = line;
    for (const value of values) out = out.split(value).join('…');
    return out;
  };
}
