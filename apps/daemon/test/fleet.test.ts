/**
 * The aggregate view: additive, read-only, and three-valued about reachability.
 *
 * The property these tests defend is not the table, it is the absence of a controller. Nothing here can
 * change a peer, and nothing here treats silence as failure.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { collectFleet, duplicateIdentities, type PeerTarget } from '../src/core/fleet.ts';

const self = {
  deviceId: 'aaaa0000',
  deviceName: 'hall cupboard',
  version: '0.1.0',
  uptimeSeconds: 4000,
  activeProfile: 'Home',
};

const peer = (overrides: Partial<PeerTarget> = {}): PeerTarget => ({
  id: 'p1',
  label: 'hq',
  baseUrl: 'http://192.0.2.10:8088',
  token: 'tok',
  ...overrides,
});

test('this device is reported without any network at all', async () => {
  /*
   * The whole point of the local row: an aggregate view of unreachable peers must still tell the operator
   * about the device in front of them. A fan-out that had to succeed before anything rendered would fail
   * exactly when the network is the thing being reconfigured.
   */
  const rows = await collectFleet(self, [], {
    fetchJson: async () => {
      throw new Error('no peer should have been contacted');
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, 'self');
  assert.equal(rows[0]!.deviceId, 'aaaa0000');
  assert.equal(rows[0]!.activeProfile, 'Home');
});

test('a peer that says nothing is unreachable, not down', async () => {
  // The commonest reason is that the link between here and there is what is being changed. A screen
  // saying "three devices are down" sends somebody to fix four problems instead of one.
  const rows = await collectFleet(self, [peer()], {
    fetchJson: async () => {
      throw new Error('ETIMEDOUT');
    },
    timeoutMs: 1000,
  });
  assert.equal(rows[1]!.state, 'unreachable');
  assert.match(rows[1]!.detail!, /nothing came back within 1s/);
});

test('a peer that rejects the token is refused, which is a different thing', async () => {
  // It is working and does not trust us. That calls for a new token, not for a trip to the cupboard.
  for (const status of [401, 403]) {
    const rows = await collectFleet(self, [peer()], {
      fetchJson: async () => ({ status, body: null }),
    });
    assert.equal(rows[1]!.state, 'refused');
    assert.match(rows[1]!.detail!, /It is working; it does not accept this credential/);
  }
});

test('a peer with no stored token is refused without being contacted', async () => {
  let called = false;
  const rows = await collectFleet(self, [peer({ token: null })], {
    fetchJson: async () => {
      called = true;
      return { status: 200, body: {} };
    },
  });
  assert.equal(called, false, 'there is nothing to ask with');
  assert.equal(rows[1]!.state, 'refused');
});

test('an answer is read field by field, never copied wholesale', async () => {
  /*
   * A peer may be running a different version of this software. Copying whatever it sent into our own
   * shape is how a field we no longer support comes back as a rendered value nobody can account for —
   * and how a peer could put arbitrary keys into our response.
   */
  const rows = await collectFleet(self, [peer()], {
    fetchJson: async () => ({
      status: 200,
      body: {
        deviceId: 'bbbb1111',
        deviceName: 'hq',
        version: '0.2.0',
        uptimeSeconds: 99,
        activeProfile: 'Work',
        somethingElse: 'must not appear',
        state: 'self',
      },
    }),
  });
  const row = rows[1]!;
  assert.equal(row.state, 'answered', 'the peer must not be able to claim it is us');
  assert.equal(row.deviceId, 'bbbb1111');
  assert.ok(!('somethingElse' in row));
});

test('a peer that answers with rubbish in a field contributes nothing for that field', async () => {
  const rows = await collectFleet(self, [peer()], {
    fetchJson: async () => ({ status: 200, body: { deviceId: 42, uptimeSeconds: 'ages' } }),
  });
  assert.equal(rows[1]!.state, 'answered');
  assert.equal(rows[1]!.deviceId, undefined);
  assert.equal(rows[1]!.uptimeSeconds, undefined);
});

test('the url is built from the peer base without doubling a slash', async () => {
  const urls: string[] = [];
  await collectFleet(self, [peer({ baseUrl: 'http://192.0.2.10:8088/' })], {
    fetchJson: async (url) => {
      urls.push(url);
      return { status: 200, body: {} };
    },
  });
  assert.deepEqual(urls, ['http://192.0.2.10:8088/api/system']);
});

test('peers are asked together, so one dead link costs one wait', async () => {
  // Sequential fan-out means a page that takes as long as the sum of every broken peer.
  let concurrent = 0;
  let peak = 0;
  await collectFleet(self, [peer({ id: 'a' }), peer({ id: 'b' }), peer({ id: 'c' })], {
    fetchJson: async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return { status: 200, body: {} };
    },
  });
  assert.equal(peak, 3);
});

test('two devices claiming one identity is reported, because it means a card was cloned', async () => {
  /*
   * Two installations flashed from one image share everything the device did not generate for itself, and
   * an aggregate view is where that first becomes visible — as two rows that are somehow one device.
   * Reported rather than resolved: which of them should change is not a question this code can answer,
   * and rewriting one automatically would change the identity of a device somebody else is looking at.
   */
  const rows = await collectFleet(self, [peer()], {
    fetchJson: async () => ({ status: 200, body: { deviceId: 'aaaa0000', deviceName: 'clone' } }),
  });
  assert.deepEqual(duplicateIdentities(rows), ['aaaa0000']);
});

test('distinct identities, and missing ones, raise nothing', () => {
  assert.deepEqual(
    duplicateIdentities([
      { id: '1', label: 'a', baseUrl: '', state: 'self', deviceId: 'x' },
      { id: '2', label: 'b', baseUrl: '', state: 'answered', deviceId: 'y' },
      { id: '3', label: 'c', baseUrl: '', state: 'unreachable' },
      { id: '4', label: 'd', baseUrl: '', state: 'unreachable' },
    ]),
    [],
    'two unreachable peers are not two devices with the same identity',
  );
});
