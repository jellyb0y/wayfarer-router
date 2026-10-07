import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createCoreApi } from '../src/platform/core-api.ts';

function withReplies(replies: Record<string, { status: number; text: string }>) {
  const seen: string[] = [];
  const api = createCoreApi({
    fetchJson: async (method, path) => {
      seen.push(`${method} ${path}`);
      const reply = replies[path];
      if (reply === undefined) throw new Error(`unexpected request: ${method} ${path}`);
      return reply;
    },
  });
  return { api, seen };
}

test('a rejected selection reports the core’s reason on one line', async () => {
  /*
   * The core's error body ends in a newline. This string becomes an event summary, and an untrimmed
   * one puts a line break inside the event list where an operator reads it. Observed on the bench
   * board as `400: {"message":"Selector update error: not found"}\n`.
   */
  const { api } = withReplies({
    '/proxies/wf-selector': { status: 400, text: '{"message":"Selector update error: not found"}\n' },
  });
  const result = await api.select('wf-selector', 'block');
  assert.equal(result.ok, false);
  assert.equal(result.message, '400: {"message":"Selector update error: not found"}');
  assert.ok(!result.message.includes('\n'), 'an event summary must not contain a line break');
});

test('204 is the accepted answer, and 200 is accepted too', async () => {
  for (const status of [204, 200]) {
    const { api } = withReplies({ '/proxies/wf-selector': { status, text: '' } });
    assert.deepEqual(await api.select('wf-selector', 'hq'), { ok: true, message: 'selected hq' });
  }
});

test('a lost probe is null, never a number', async () => {
  // A timeout returned as a large latency would be averaged with real samples, and the median of a
  // series containing a sentinel describes nothing.
  const path = '/proxies/hq/delay?url=http%3A%2F%2Fexample%2F204&timeout=5000';
  for (const reply of [
    { status: 503, text: '{"message":"timeout"}' },
    { status: 200, text: 'not json' },
    { status: 200, text: '{"delay":null}' },
  ]) {
    const { api } = withReplies({ [path]: reply });
    assert.equal(await api.delay('hq', 'http://example/204', 5000), null);
  }
});

test('the probe asks about the named outbound, so the path carries its name', async () => {
  // The whole reason this module exists: a probe must measure the tunnel it is attributed to.
  const path = '/proxies/t-hq/delay?url=http%3A%2F%2Fexample%2F204&timeout=4000';
  const { api, seen } = withReplies({ [path]: { status: 200, text: '{"delay":387}' } });
  assert.equal(await api.delay('t-hq', 'http://example/204', 4000), 387);
  assert.deepEqual(seen, [`GET ${path}`]);
});
