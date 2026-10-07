/**
 * The fence classification against the bench board's own core configuration.
 *
 * Measured 2026-09-23, 09:07:52, on the board running the build that taught the follower networks:
 * `wfvpncrp` held `10.122.0.2/24`, the follower asked to add `10.122.0.0/24` to the fence, and refused
 * itself — `config.json` and `fence.json` were classed `network`, which a follower may not apply. The
 * cause, reproduced here from the board's file: `corp`'s own resource rule (`wf-guard-corp`)
 * already names `10.122.0.0/24`, and `onlyFollowedNetworksMoved` pooled every address in the whole
 * reachability region into one set. Adding the network to the exclusion list therefore read as nothing
 * appearing and nothing departing, and a change that moved nothing was refused its softening.
 *
 * The fixture is the board's `/etc/wayfarer/core/config.json` and `/etc/wayfarer/fence.json` as read that
 * morning, reduced: the inbound, the routing rules and the resolvers are as they were; the outbounds
 * keep only their type, tag, interface and members; nothing that authenticates anything is in it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyContentChange, readFenceRecord, type ReachabilityNetworks } from '../src/core/differ.ts';
import { PATHS } from '../src/core/desired-state.ts';

const here = dirname(fileURLToPath(import.meta.url));
const BOARD = readFileSync(join(here, 'fixtures/board/core-config-2026-09-23.json'), 'utf8');
const RECORD = readFileSync(join(here, 'fixtures/board/fence-2026-09-23.json'), 'utf8');

type Core = { inbounds: { route_exclude_address: string[] }[]; route: { rules: { ip_cidr?: string[]; outbound?: string }[] } };

/** The board's file, changed the way the planner changes it. */
function edited(change: (core: Core) => void): string {
  const core = JSON.parse(BOARD) as Core;
  change(core);
  return `${JSON.stringify(core, null, 2)}\n`;
}

/** The direct rule the generator writes over the same networks as the fence (rule 2 on the board). */
const directRule = (core: Core) => core.route.rules.find((rule) => rule.outbound === 'direct' && rule.ip_cidr?.includes('192.168.77.0/24'))!;
const resourceRule = (core: Core, outbound: string) => core.route.rules.find((rule) => rule.outbound === outbound)!;

/** What the planner said about the board's networks that morning. */
function networks(extra: Partial<ReachabilityNetworks> = {}): ReachabilityNetworks {
  return {
    followed: ['10.165.0.0/20', '10.136.0.0/24', '10.122.0.0/24'],
    defended: ['10.44.0.0/24', '10.44.0.1/24', '172.19.0.0/30', '192.168.77.0/24'],
    previouslyFollowed: readFenceRecord(RECORD)!,
    ...extra,
  };
}

const classify = (after: string, facts: ReachabilityNetworks = networks()) =>
  classifyContentChange(PATHS.coreConfig, BOARD, after, facts);

test('the fixture is the board’s shape: corp’s own resource rule already names 10.122.0.0/24, and the fence does not', () => {
  const core = JSON.parse(BOARD) as Core;
  assert.ok(resourceRule(core, 'wf-guard-corp').ip_cidr?.includes('10.122.0.0/24'));
  assert.ok(!core.inbounds[0]!.route_exclude_address.includes('10.122.0.0/24'));
});

test('the board at 09:07:52: corp’s network entering the fence and the direct rule is service', () => {
  const after = edited((core) => {
    core.inbounds[0]!.route_exclude_address.push('10.122.0.0/24');
    directRule(core).ip_cidr!.push('10.122.0.0/24');
  });
  // Before the fix: `network` — the address was already in the pooled set, so nothing "appeared".
  assert.equal(classify(after), 'service');
});

test('still network: the uplink’s network leaving the fence (the flap)', () => {
  const after = edited((core) => {
    core.inbounds[0]!.route_exclude_address = core.inbounds[0]!.route_exclude_address.filter((cidr) => cidr !== '192.168.77.0/24');
    directRule(core).ip_cidr = directRule(core).ip_cidr!.filter((cidr) => cidr !== '192.168.77.0/24');
  });
  assert.equal(classify(after, networks({ defended: ['10.44.0.0/24', '10.44.0.1/24', '172.19.0.0/30'] })), 'network');
});

test('still network: a defended network leaving', () => {
  const after = edited((core) => {
    core.inbounds[0]!.route_exclude_address = core.inbounds[0]!.route_exclude_address.filter((cidr) => cidr !== '10.44.0.0/24');
  });
  assert.equal(classify(after), 'network');
});

test('still network: a follower move with no record, or an unreadable one', () => {
  const after = edited((core) => {
    for (const list of [core.inbounds[0]!.route_exclude_address, directRule(core).ip_cidr!]) {
      list.splice(list.indexOf('10.165.0.0/20'), 1, '10.164.96.0/20');
    }
  });
  const moved = networks({ followed: ['10.164.96.0/20', '10.136.0.0/24'] });
  assert.equal(classify(after, moved), 'service', 'the recorded move itself must stay service, or the checks below prove nothing');
  const { previouslyFollowed: _dropped, ...withoutRecord } = moved;
  assert.equal(classify(after, withoutRecord), 'network');
  assert.equal(classify(after, { ...moved, previouslyFollowed: readFenceRecord('{not json') ?? [] }), 'network');
});

test('still network: a routing rule’s own addresses changing, even to a followed network', () => {
  // corp's resource rule gains a network the device follows. That is a change to where traffic for an
  // address goes, which the fence softening was never about.
  const after = edited((core) => {
    resourceRule(core, 'wf-guard-corp').ip_cidr!.push('10.136.0.0/24');
  });
  assert.equal(classify(after), 'network');
  const removed = edited((core) => {
    resourceRule(core, 'wf-guard-corp').ip_cidr = ['10.148.0.0/16'];
  });
  assert.equal(classify(removed), 'network');
});
