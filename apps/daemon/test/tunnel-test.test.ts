/**
 * Testing a tunnel configuration before applying it (`core/tunnel-test.ts`).
 *
 * The symptom (bench board, 2026-10-11): two VLESS tunnels parsed from a subscription were dead, and the
 * only way to find out was to apply them and read the external client's log over a shell. These tests hold
 * the test to what it promises: the configuration is planned as an apply would plan it, the clients live
 * for the request only, their words come back with the credentials removed, and nothing is left behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ScopedProcess } from '../src/platform/exec.ts';
import type { Scratch } from '../src/platform/scratch.ts';
import type { CheckOutcome } from '../src/core/liveness.ts';
import { testTunnel, type TunnelTestDeps } from '../src/core/tunnel-test.ts';

const UUID = '9d9181b6-e40c-4595-a485-3ae0a67a0f59';

function stand(options: { answer?: CheckOutcome; exitAtOnce?: string; xray?: boolean } = {}) {
  const spawned: { command: string; args: string[]; stopped: boolean }[] = [];
  const written = new Map<string, string>();
  let removed = false;
  let clock = 0;
  const deps: TunnelTestDeps = {
    scratch: async (prefix): Promise<Scratch> => {
      assert.ok(prefix.startsWith('wayfarer-'));
      return {
        path: '/tmp/wayfarer-tunnel-test-x',
        write: async (name, content) => {
          written.set(name, content);
          return `/tmp/wayfarer-tunnel-test-x/${name}`;
        },
        remove: async () => {
          removed = true;
        },
      };
    },
    spawn: (command, args): ScopedProcess => {
      const entry = { command, args, stopped: false };
      spawned.push(entry);
      const exits = options.exitAtOnce === command;
      return {
        // A client at debug that prints the account id it presents — which must not reach the answer.
        tail: () => [`${command}: dialing as ${UUID}`, `${command}: connection reset by peer`],
        exited: new Promise(() => undefined),
        done: () => exits,
        stop: async () => {
          entry.stopped = true;
        },
      };
    },
    freePort: async () => 40000 + spawned.length,
    coreAvailable: async () => true,
    check: async () => options.answer ?? { kind: 'answered', ms: 87 },
    binaries: async () => ({ core: '/usr/local/bin/sing-box', xray: options.xray === false ? null : '/usr/local/bin/xray' }),
    sleep: async () => undefined,
    nowMs: () => (clock += 1000),
  };
  return { deps, spawned, written, removed: () => removed };
}

const PLAIN = { server: '5.39.255.51', port: 8080, id: UUID, network: 'tcp', security: 'none' };

test('a native configuration runs one throwaway core with the planned outbound, and answers with the delay', async () => {
  const s = stand();
  const result = await testTunnel(s.deps, { protocol: 'vless', config: PLAIN, endpoints: ['http://cp.cloudflare.com/generate_204'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.latencyMs, 87);
  assert.equal(result.carrier?.kind, 'native');
  assert.deepEqual(s.spawned.map((entry) => entry.command), ['/usr/local/bin/sing-box']);
  const core = JSON.parse(s.written.get('core.json')!) as { outbounds: { tag: string; type: string }[]; route: { final: string } };
  assert.equal(core.outbounds[0]!.type, 'vless');
  assert.equal(core.route.final, 'wf-test');
  // Gone whatever the answer: the processes stopped and the directory with the credential removed.
  assert.ok(s.spawned.every((entry) => entry.stopped));
  assert.equal(s.removed(), true);
});

test('an HTTP-disguised configuration starts the external client at debug, and a failure carries its words without the account id', async () => {
  const s = stand({ answer: { kind: 'lost', why: '503: EOF' } });
  const result = await testTunnel(s.deps, {
    protocol: 'vless',
    config: { ...PLAIN, headerType: 'http', host: '5.39.255.51', path: '/' },
    endpoints: ['http://cp.cloudflare.com/generate_204'],
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.carrier?.kind, 'external');
  assert.equal(result.failure?.stage, 'request');
  assert.deepEqual(s.spawned.map((entry) => entry.command), ['/usr/local/bin/xray', '/usr/local/bin/sing-box']);
  const client = JSON.parse(s.written.get('client.json')!) as { log: { loglevel: string } };
  assert.equal(client.log.loglevel, 'debug');
  assert.ok(result.log.some((line) => /connection reset by peer/.test(line)), 'the client’s own words are the answer');
  // Mutation: drop the redactor and this goes red — the account id reaches an API response and a screen.
  assert.ok(result.log.every((line) => !line.includes(UUID)), result.log.join('\n'));
  assert.ok(s.spawned.every((entry) => entry.stopped));
  assert.equal(s.removed(), true);
});

test('a client that exits at once is a start failure, and nothing is left running', async () => {
  const s = stand({ exitAtOnce: '/usr/local/bin/sing-box' });
  const result = await testTunnel(s.deps, { protocol: 'vless', config: PLAIN, endpoints: ['http://cp.cloudflare.com/generate_204'] });
  assert.equal(result.failure?.stage, 'start');
  assert.ok(s.spawned.every((entry) => entry.stopped));
  assert.equal(s.removed(), true);
});

test('a configuration that needs the external client says so when it is not installed, and starts nothing', async () => {
  const s = stand({ xray: false });
  const result = await testTunnel(s.deps, {
    protocol: 'vless',
    config: { ...PLAIN, headerType: 'http' },
    endpoints: ['http://cp.cloudflare.com/generate_204'],
  });
  assert.equal(result.failure?.stage, 'start');
  assert.match(result.failure!.message, /external client/);
  assert.equal(s.spawned.length, 0);
});

test('an OpenVPN tunnel is not stood up beside the running ones', async () => {
  const s = stand();
  const result = await testTunnel(s.deps, {
    protocol: 'openvpn',
    config: { ovpn: 'client\nremote 203.0.113.9 1194 udp\n', credentials: { username: 'u', password: 'p' } },
    endpoints: ['http://cp.cloudflare.com/generate_204'],
  });
  assert.ok(result.failure?.stage === 'unsupported' || result.failure?.stage === 'plan', JSON.stringify(result));
  assert.equal(s.spawned.length, 0);
});
