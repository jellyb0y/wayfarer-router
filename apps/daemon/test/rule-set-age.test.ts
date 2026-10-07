/**
 * The age of a rule set: where it may honestly be read from, and what "too old" means.
 *
 * Every branch here is reachable from a fixture because the arithmetic takes both sides. Three
 * things these tests are careful about, each because the first version of this file got it wrong:
 *
 * * The remote figure is a **lower** bound and understates. A test that only checked a number would
 *   have agreed with the inverted claim; these check the **words**, because the words are what a
 *   person acts on and the inversion lived in them.
 * * A read that failed is not an observed absence, and the two send an operator to opposite places.
 * * The clock being right *now* says nothing about what it read when the file was stamped.
 *
 * The threshold is pinned with **literal** hours rather than arithmetic on `MISSED_REFRESHES`: a
 * test that derives its expectation from the constant agrees with whatever the constant says, and
 * mutating 3 to 1 killed nothing.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PATHS } from '../src/core/desired-state.ts';
import { fileModifiedMs } from '../src/platform/files.ts';
import {
  describeAge,
  readRuleSets,
  ruleSetAges,
  ruleSetsInUse,
  softwareBuiltAtMs,
  type RuleSetObservation,
  type RuleSetReading,
} from '../src/core/rule-set-age.ts';

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const HOUR = 3600 * 1000;
/** Any instant before every timestamp these tests use, so the clock-damage floor never fires here. */
const BUILT_AT = NOW - 10_000 * HOUR;

const REMOTE = {
  tag: 'geoip-ru',
  type: 'remote' as const,
  url: 'https://example.invalid/geoip-ru.srs',
  format: 'binary' as const,
  updateIntervalHours: 24,
};

function seen(overrides: Partial<RuleSetObservation> = {}): RuleSetObservation {
  return { tag: REMOTE.tag, source: PATHS.coreCache, modifiedMs: NOW - HOUR, unreadable: null, exact: false, ...overrides };
}

function reading(overrides: Partial<RuleSetReading> = {}): RuleSetReading {
  return { observations: [seen()], clockSynchronized: true, nowMs: NOW, notBeforeMs: BUILT_AT, ...overrides };
}

const only = <T>(list: T[]): T => {
  assert.equal(list.length, 1, 'these tests are about one set; more than one means the fixture changed');
  return list[0]!;
};

/** One set, aged a stated number of hours, with everything else out of the way. */
function agedHours(hours: number, set: typeof REMOTE = REMOTE) {
  return only(ruleSetAges({
    sets: [set],
    reading: reading({ observations: [seen({ modifiedMs: NOW - hours * HOUR })] }),
  }));
}

/* ── the bound, and the fact that it understates ─────────────────────────────────────────── */

test('a remote set’s figure is a lower bound, and says so rather than sounding fresh', () => {
  const age = agedHours(1);
  assert.equal(age.state, 'fresh');
  assert.equal(age.ageSeconds, 3600);
  assert.equal(age.exact, false);

  /*
   * The wording is the assertion, because the wording is where the inversion lived. The cache file's
   * timestamp is the most recent write by **any** set in it, so this set was refreshed at or before
   * that instant: the true age is *at least* this, and may be very much more.
   */
  assert.match(age.summary, /^at least 60m old/);
  assert.match(age.summary, /may be far older/);
  assert.equal(age.summary.includes('at most'), false, 'the figure is a floor; "at most this fresh" reads as reassurance');
});

test('one set refreshing makes every other set in the cache look fresh, and the answer admits it', () => {
  /*
   * **The limitation, measured and written down rather than implied.**
   *
   * Two remote sets share one cache file. Something wrote it an hour ago; which set that was is not
   * knowable from outside the file. So both report the same figure, and one of them may be a month
   * stale — which is the silent-stale-list failure this mechanism exists to catch, surviving inside
   * it. The real fix is a plan row (Epic F): fetch each set into its own file and hand the core a
   * `local` set pointing at it. Until then the only honest thing is to say what the number is not.
   */
  const other = { ...REMOTE, tag: 'geosite-ru' };
  const ages = ruleSetAges({
    sets: [REMOTE, other],
    reading: reading({ observations: [seen(), seen({ tag: other.tag })] }),
  });
  assert.deepEqual(ages.map((entry) => entry.ageSeconds), [3600, 3600]);
  for (const entry of ages) {
    assert.equal(entry.exact, false);
    assert.match(entry.summary, /the cache holds every remote set together/);
  }
});

test('a local set is exact, and is not given the remote set’s caveat', () => {
  const local = { tag: 'trackers', type: 'local' as const, path: '/etc/wayfarer/rule-sets/trackers.json' };
  const age = only(ruleSetAges({
    sets: [local],
    reading: reading({ observations: [seen({ tag: local.tag, source: local.path, exact: true })] }),
  }));
  assert.equal(age.exact, true);
  assert.equal(age.summary, 'refreshed 60m ago; no refresh interval is set, so nothing judges it');
  assert.equal(age.summary.includes('at least'), false, 'an exact figure is not hedged');
});

/* ── the threshold, pinned with numbers rather than with the constant ────────────────────── */

test('a daily list is overdue after 73 hours and not after 71', () => {
  /*
   * Literal hours on purpose. The first version computed its window from `MISSED_REFRESHES` and
   * built its regex from it too, so `3 → 1` killed no test anywhere in the repository: the test
   * agreed with whatever the constant said. These two assertions bracket the policy, so lowering it
   * fails the first and raising it fails the second.
   */
  assert.equal(agedHours(71).state, 'fresh', '71h is inside three daily refreshes');
  assert.equal(agedHours(73).state, 'overdue', '73h is past three daily refreshes');
});

test('a weekly list is overdue after 505 hours and not after 500', () => {
  // The same bracket at another interval, so the policy is pinned as a multiple of the owner's own
  // number rather than as a duration that happens to be right for one cadence.
  const weekly = { ...REMOTE, updateIntervalHours: 168 };
  assert.equal(agedHours(500, weekly).state, 'fresh');
  assert.equal(agedHours(505, weekly).state, 'overdue');
  assert.equal(agedHours(505, weekly).overdueAfterSeconds, 504 * 3600);
});

test('a set with no stated interval gets an age and no verdict', () => {
  const { updateIntervalHours: _unused, ...noCadence } = REMOTE;
  const age = only(ruleSetAges({
    sets: [noCadence],
    reading: reading({ observations: [seen({ modifiedMs: NOW - 900 * HOUR })] }),
  }));
  assert.equal(age.state, 'no-cadence');
  assert.equal(age.ageSeconds, 900 * 3600, 'the number is still worth printing; only the verdict is withheld');
  assert.equal(age.overdueAfterSeconds, null);
  assert.match(age.summary, /no refresh interval is set/);
});

/* ── the clock ───────────────────────────────────────────────────────────────────────────── */

test('an unsynchronised clock yields no number, however old the file is', () => {
  const observations = [seen({ modifiedMs: NOW - 900 * HOUR })];

  const unsynced = only(ruleSetAges({ sets: [REMOTE], reading: reading({ observations, clockSynchronized: false }) }));
  assert.equal(unsynced.state, 'unmeasurable');
  assert.equal(unsynced.ageSeconds, null);
  assert.equal(unsynced.ageLabel, null);
  assert.match(unsynced.summary, /not been synchronised/);

  // `null` is a third answer, not a quiet `false`: the same refusal, a different sentence.
  const unread = only(ruleSetAges({ sets: [REMOTE], reading: reading({ observations, clockSynchronized: null }) }));
  assert.equal(unread.state, 'unmeasurable');
  assert.notEqual(unread.summary, unsynced.summary, 'two different reasons must not print the same sentence');
});

test('a file stamped before this build existed is clock damage, not an age', () => {
  /*
   * **The jump that lands.** The board boots to a fallback time, the core refreshes the set and
   * stamps the file with it, NTP then steps the clock forward, and every check above is satisfied:
   * the clock *is* synchronised, and the timestamp is not in the future. Measured on the first
   * version: `mtime` 0 gave *"last refreshed 11574d ago"* and a red finding about a set refreshed
   * minutes earlier.
   *
   * A file cannot predate the software that wrote it, so the floor closes the whole class with one
   * comparison and no second clock.
   */
  const bogus = only(ruleSetAges({
    sets: [REMOTE],
    reading: reading({ observations: [seen({ modifiedMs: 0 })], clockSynchronized: true, notBeforeMs: NOW - 1000 * HOUR }),
  }));
  assert.equal(bogus.state, 'unmeasurable');
  assert.equal(bogus.ageSeconds, null, 'no number at all: 11574 days is not an age, it is a broken clock');
  assert.equal(bogus.ageLabel, null);
  assert.match(bogus.summary, /earlier than this build of Wayfarer existed/);

  // And the same file with the floor unavailable is the known gap, stated rather than silent.
  const noFloor = only(ruleSetAges({
    sets: [REMOTE],
    reading: reading({ observations: [seen({ modifiedMs: 0 })], notBeforeMs: null }),
  }));
  assert.equal(noFloor.state, 'overdue', 'with no floor the rule cannot be applied; the header says so');
});

test('a timestamp in the future is evidence about the clock, not a fresh list', () => {
  const age = only(ruleSetAges({
    sets: [REMOTE],
    reading: reading({ observations: [seen({ modifiedMs: NOW + 10 * HOUR })] }),
  }));
  assert.equal(age.state, 'unmeasurable');
  assert.equal(age.ageSeconds, null);
  assert.match(age.summary, /behind the file/);
});

test('the build floor is established from something that exists on every device', async () => {
  // Either the installer's stamp or the bundle this process runs from. In this test run it is the
  // second, and the assertion is only that a floor is found at all — a floor of `null` is the gap.
  const floor = await softwareBuiltAtMs();
  assert.equal(typeof floor, 'number');
  assert.ok((floor ?? 0) > 0 && (floor ?? 0) <= Date.now());
});

/* ── "I could not look" is not "there is nothing there" ──────────────────────────────────── */

test('a file the daemon may not read is its own state, not a set that was never fetched', () => {
  /*
   * The layer below distinguishes these deliberately — `fileModifiedMs` returns `null` for `ENOENT`
   * and throws for everything else — and the first version flattened the throw into `null`. The
   * result was a report saying *"never fetched onto this device, so the rules that point at it match
   * nothing"* about a cache file that was sitting right there, and a hint sending the operator to
   * check a network when the fault was a permission on the device.
   */
  const age = only(ruleSetAges({
    sets: [REMOTE],
    reading: reading({ observations: [seen({ modifiedMs: null, unreadable: 'EACCES: permission denied' })] }),
  }));
  assert.equal(age.state, 'unreadable');
  assert.equal(age.ageSeconds, null);
  assert.match(age.summary, /could not read the file/);
  assert.match(age.summary, /EACCES/, 'the reason is carried, because it is what tells an operator what to fix');
  assert.equal(age.summary.includes('never fetched'), false);
});

test('a genuinely absent file is still reported as never fetched', () => {
  // The other half: absence is an observation, and it keeps the sentence that names the consequence.
  const age = only(ruleSetAges({ sets: [REMOTE], reading: reading({ observations: [seen({ modifiedMs: null })] }) }));
  assert.equal(age.state, 'never-fetched');
  assert.match(age.summary, /the rules that point at it match nothing/);
});

/* ── the reader: which file answers for which kind of set ────────────────────────────────── */

test('a remote set is bounded by the cache file and a local set is measured by its own', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wayfarer-rule-set-'));
  const localPath = join(root, 'trackers.json');
  await writeFile(localPath, '{}', 'utf8');
  const localModified = NOW - 5 * HOUR;
  await utimes(localPath, new Date(localModified), new Date(localModified));

  const cacheModified = NOW - 2 * HOUR;
  const read = readRuleSets({
    // The cache lives at an absolute path this test cannot write to, so only that leaf is answered
    // from a table; the local set's timestamp comes off a real file through the shipped reader.
    modifiedMs: async (path) => (path === PATHS.coreCache ? cacheModified : fileModifiedMs(path)),
    clockSynchronized: async () => true,
    nowMs: () => NOW,
    notBeforeMs: async () => BUILT_AT,
  });

  const sets = [REMOTE, { tag: 'trackers', type: 'local' as const, path: localPath }];
  const result = await read(sets);
  assert.equal(result.observations.length, sets.length, 'one observation per set, in order');

  assert.equal(result.observations[0]!.source, PATHS.coreCache);
  assert.equal(result.observations[0]!.exact, false);
  assert.equal(result.observations[0]!.modifiedMs, cacheModified);

  const local = result.observations[1]!;
  assert.equal(local.source, localPath);
  assert.equal(local.exact, true, 'the file at `path` **is** the set, so its timestamp is that set’s own');
  assert.ok(local.modifiedMs !== null && Math.abs(local.modifiedMs - localModified) < 1000);

  const ages = ruleSetAges({ sets, reading: result });
  assert.equal(ages[1]!.exact, true);
  assert.match(ages[1]!.summary, /^refreshed 5h ago;/);
  assert.equal(ages[1]!.summary.includes('every remote set'), false);
  assert.equal(ages[1]!.ageLabel, '5h');
});

test('a local set with no path has no file to look at, rather than a guessed one', async () => {
  const read = readRuleSets({
    modifiedMs: async () => {
      throw new Error('nothing should be stat-ed for a set with no path');
    },
    clockSynchronized: async () => true,
    nowMs: () => NOW,
    notBeforeMs: async () => BUILT_AT,
  });
  const result = await read([{ tag: 'nowhere', type: 'local' }]);
  assert.deepEqual(result.observations, [
    { tag: 'nowhere', source: null, modifiedMs: null, unreadable: null, exact: true },
  ]);
});

test('a stat that throws is carried as a failure to look, not as an absent file', async () => {
  const read = readRuleSets({
    modifiedMs: async () => {
      throw new Error('EACCES: permission denied, stat');
    },
    clockSynchronized: async () => true,
    nowMs: () => NOW,
    notBeforeMs: async () => BUILT_AT,
  });
  const result = await read([REMOTE]);
  assert.equal(result.observations[0]!.modifiedMs, null);
  assert.match(result.observations[0]!.unreadable ?? '', /EACCES/);
  assert.equal(only(ruleSetAges({ sets: [REMOTE], reading: result })).state, 'unreadable');
});

/* ── pairing, formatting and selection ───────────────────────────────────────────────────── */

test('observations are paired by position, so a repeated tag cannot make a remote set exact', () => {
  /*
   * A duplicate tag is refused by the invariants and is unreachable through a valid profile, which
   * is exactly why the internal function must not quietly rely on that: a join on a key that may
   * repeat lets the last observation win, and the first version could report a `remote` set as
   * `exact: true` against a local file.
   */
  const duplicated = [REMOTE, { tag: REMOTE.tag, type: 'local' as const, path: '/etc/wayfarer/rule-sets/dup.json' }];
  const ages = ruleSetAges({
    sets: duplicated,
    reading: reading({
      observations: [seen(), seen({ source: '/etc/wayfarer/rule-sets/dup.json', exact: true })],
    }),
  });
  assert.equal(ages[0]!.exact, false, 'the remote set keeps the remote observation');
  assert.equal(ages[0]!.observedFrom, PATHS.coreCache);
  assert.equal(ages[1]!.exact, true);
});

test('a reading that does not line up with the sets is treated as no reading at all', () => {
  // A misaligned pairing is worse than an absent one: it answers confidently about the wrong file.
  const ages = ruleSetAges({ sets: [REMOTE, { ...REMOTE, tag: 'other' }], reading: reading() });
  for (const age of ages) {
    assert.equal(age.state, 'unreadable');
    assert.equal(age.ageSeconds, null);
  }
});

test('there is one formatter for an age, and the answer carries its own words', () => {
  // Two formatters for one number had already drifted: a pill reading `1h` above a sentence reading
  // `83m ago`, because one switched to hours at 60 minutes and the other at 90.
  assert.equal(describeAge(83 * 60), '83m');
  assert.equal(describeAge(91 * 60), '2h');
  assert.equal(agedHours(1).ageLabel, '60m', 'one formatter: 60 minutes is 60m everywhere, never 1h in one place');
  assert.equal(agedHours(100).ageLabel, '4d');
});

test('only the sets a rule points at are in use', () => {
  const used = ruleSetsInUse([
    { kind: 'protect-own-networks' },
    { kind: 'ruleSet', sets: ['geoip-ru', 'geosite-ru'] },
    { kind: 'ruleSet', sets: ['geoip-ru'] },
    // A rule of another kind that happens to carry a `sets`-shaped field must not contribute.
    { kind: 'domain', sets: ['not-a-rule-set'] },
  ]);
  assert.deepEqual([...used].sort(), ['geoip-ru', 'geosite-ru']);
});
