/**
 * How old the rule sets this device is routing on actually are.
 *
 * ## The obligation this pays for
 *
 * A remote rule set is fetched by the core and cached, and a **failed refresh falls back to the copy
 * on disk rather than refusing**. That was chosen deliberately: a device that stops routing because
 * a list could not be refetched is a device that turns a network blip into an outage.
 *
 * The bill for that choice is this file. A stale list does not know addresses allocated since it was
 * written, so a rule meant to send a whole country through a proxy quietly stops covering part of
 * it — and **nothing looks wrong**. The tunnel is up, the rule is present, the core is healthy, and
 * traffic leaves unproxied. That is the exact failure `docs/13-plan.md`'s Epic G exists to stop:
 * a claim about what the device is doing that rests on nothing anybody read.
 *
 * ## Where the age comes from, and what could not be had
 *
 * Established rather than assumed, and the honest answer is smaller than one would like.
 *
 * * The core downloads remote sets and keeps them in `experimental.cache_file`
 *   (`PATHS.coreCache`). That file is the core's own database in the core's own format. This project
 *   does not parse it and must not start: a format nobody published is a format that changes without
 *   telling us, and an age read out of a guessed layout is worse than no age at all.
 * * The core's management API, as this device speaks it (`platform/core-api.ts`), offers `/version`,
 *   `/proxies` and a delay probe. **No rule-set timestamps.** It is also optional — `clashApi` can be
 *   turned off in the profile — so an answer that depended on it would be absent exactly when
 *   somebody had turned the management surface down.
 *
 * So what the daemon can observe is **file timestamps, and nothing else**:
 *
 * * For a `local` set the file at `path` **is** the set, so its timestamp is that set's own and the
 *   age is exact.
 * * For a `remote` set the only timestamp is the cache file's, and that file holds **every** remote
 *   set at once.
 *
 * ## The remote figure is a LOWER bound, and it understates
 *
 * **Corrected 2026-09-22, after the first version of this file said the opposite in four places.**
 * The wrong sentence was *"it can only overstate an age, never understate — the direction that fails
 * safe"*, and it is worth recording because it was stated confidently, three times, and inverted.
 *
 * The cache file's modification time is the instant of the **most recent** write by **any** set in
 * it. Every individual set was therefore last refreshed at or before that instant, so its true age
 * is **at least** `now − mtime`. The figure is a floor. Measured: two remote sets sharing a cache
 * written an hour ago, one of them genuinely thirty days stale — both report `fresh, 3600s`. **One
 * set refreshing keeps every other set in the cache looking healthy**, which is precisely the
 * silent-stale-list failure this whole mechanism exists to catch.
 *
 * So a fresh-looking figure on a remote set is **not evidence of freshness**. It is evidence that
 * *something* in the cache was refreshed. Every sentence this file produces for a remote set says so,
 * and `exact: false` carries the same fact to anything reading the values rather than the words.
 *
 * **The one thing that survives, and the only reason the finding is worth having:** if the *lower*
 * bound already exceeds the threshold, the true age certainly exceeds it too. So the overdue finding
 * **never false-alarms on a remote set; it only misses.** A red answer is always true; a green one is
 * only "nothing here proves otherwise". That asymmetry is stated again where the threshold is
 * decided, because it is what makes a bound worth reporting at all.
 *
 * The real fix is not a better reading of this file — there is no better reading of it. It is for the
 * daemon to fetch each remote set itself, into its own file, and hand the core a `local` set pointing
 * at it, so the age is per set, exact, and observed by the thing reporting it. That is written up as
 * a plan row (Epic F, `docs/13-plan.md`) with what it costs, and is deliberately not done here.
 *
 * ## The clock, which is the part that has to be argued
 *
 * A file's modification time is a **wall-clock** instant, and so is `now`. This board has no RTC
 * battery: after being switched off its clock resumes from the last timestamp written before
 * shutdown — measured on this class of hardware at four days behind — and the apply that opens a
 * confirmation window deliberately restarts the time service, so a step of days while the daemon is
 * running is a designed path rather than a corner case.
 *
 * No monotonic reading spans a power cycle, and every remote set worth asking about was fetched
 * during an earlier boot, so "measure it within this boot" is not available either. This is the same
 * shape as the snapshot age, which was fixed by asking the reader's question instead of inventing a
 * frame: **an age is computed only when the clock is trusted, and otherwise the answer is that it
 * cannot be measured, with the reason.**
 *
 * Clock trust is an *input* here, exactly as it is for the certificate warning: `timedatectl`'s
 * `NTPSynchronized`. `null` — the reading failed — is not `false` and is not `true`; it is one more
 * way of not knowing, and it produces the same refusal to compute.
 *
 * ### Synchronised **now** does not mean synchronised **then**
 *
 * Checking the clock at reading time closes only half the class, and the other half was measured:
 * the board boots to a fallback time, the core refreshes a set and stamps the file with it, NTP then
 * steps the clock forward, and the age is computed across the jump. Observed: `mtime` 0 with the
 * clock synchronised gave *"last refreshed 11574d ago"* and a red drift finding naming a set that had
 * been refreshed minutes earlier. That would very likely have been the owner's first meeting with
 * this feature.
 *
 * One cheap rule closes the whole class without a second clock: **a file cannot predate the software
 * that wrote it.** `notBeforeMs` is when this build of Wayfarer came into existence; a modification
 * time earlier than that is clock damage, not age, and is reported as unmeasurable.
 *
 * What that costs, stated rather than discovered: **an upgrade moves the floor forward**, so a
 * genuinely old cache written before the upgrade reads as unmeasurable until the next refresh
 * rewrites it. That is a *lost* finding and never a false one, which is the same direction of failure
 * the bound above already has, so the two are consistent rather than fighting. `notBeforeMs` of
 * `null` means no floor could be established, and the rule is then simply not applied — stated here
 * so that an absent `build.json` is a known gap rather than a silent one.
 *
 * ## What "unreasonably old" is, and why it is not a constant
 *
 * From `updateIntervalHours` — the owner's own statement of how fast this list goes out of date —
 * multiplied by `MISSED_REFRESHES`.
 *
 * One missed refresh is the designed path: the fallback exists for it, and a finding that fires
 * every time an uplink blinks is a finding people learn to scroll past, which costs more than it
 * buys. Two is bad luck. **Three consecutive misses is a pattern** — the refresh is not working
 * rather than unlucky — and it is the first point at which there is something to act on.
 *
 * Deriving it from his number rather than picking hours also makes it proportionate: a list he
 * refreshes daily is complained about after three days, and one he refreshes weekly after three
 * weeks, which is what he said about how fast each goes stale.
 *
 * **A set with no stated interval gets an age and no verdict.** The profile says nothing about how
 * often it may be refreshed, so nothing here can honestly say when it is overdue, and inventing a
 * threshold for it would be the constant this paragraph exists to avoid. The consequence of leaving
 * that field empty is therefore written on the control that leaves it empty.
 */

import type { ProfileDocument, RuleSet } from '@wayfarer/schemas';
import { PATHS } from './desired-state.ts';
import { fileModifiedMs, readManaged } from '../platform/files.ts';

/**
 * How many refreshes in a row must have been missed before a set is a finding.
 *
 * Three, argued above. A number here rather than in the comparison so that changing the policy is
 * one line and shows up as a policy change in a diff.
 *
 * **On a remote set this threshold can only be crossed truthfully.** The figure it is compared
 * against is a lower bound on the age, so a bound that already exceeds three intervals means the
 * real age does too. The finding never false-alarms; it misses. That asymmetry is the reason a
 * bound is worth comparing at all, and it is why the policy can be as tight as three rather than
 * needing slack for a figure that might be an overestimate. It cannot be one.
 */
export const MISSED_REFRESHES = 3;

/**
 * What a file on this device says about a rule set.
 *
 * Deliberately not "the age": the reading and the arithmetic are separated so the arithmetic is pure
 * and every branch below is reachable from a fixture rather than from a board in a particular state.
 */
export interface RuleSetObservation {
  tag: string;
  /** The file that was looked at, named so a reader can go and look at the same one. */
  source: string | null;
  /**
   * That file's modification time, in wall-clock milliseconds.
   *
   * `null` means there is no timestamp, and **`unreadable` is what separates the two ways of having
   * none**: the file is genuinely not there, or the read failed and nothing was learned.
   */
  modifiedMs: number | null;
  /**
   * Why the file could not be read at all. `null` when it was read, **and also when it is genuinely
   * absent** — absence is an observation and this field is for the failure to make one.
   *
   * The layer below distinguishes these deliberately: `fileModifiedMs` returns `null` for `ENOENT`
   * and throws for anything else. Flattening the throw into `null` — which the first version of this
   * file did — reports a cache the daemon may not read as *never fetched*, and sends the operator to
   * check a network when the fault is a permission on this device.
   */
  unreadable: string | null;
  /**
   * True when the file holds this set alone, so the age is that set's own.
   *
   * False for a remote set, whose timestamp comes from the cache file every remote set shares. That
   * figure is a **lower bound** on this set's age — see the header — so `false` means "this number
   * may be far smaller than the truth", never "roughly right".
   */
  exact: boolean;
}

/**
 * The four things an age is computed from, **read together because they are only meaningful
 * together.**
 *
 * One reader rather than four, for the reason `readStamp` gives about boot identity and uptime: two
 * readers of one quantity is how two parts of a system come to disagree about it. `nowMs` is taken
 * in the same call as the modification times so that the subtraction is between two readings of one
 * clock at one moment.
 */
export interface RuleSetReading {
  observations: RuleSetObservation[];
  /**
   * `NTPSynchronized`, as the time service reports it.
   *
   * `null` means the reading failed, which is a third answer and not a quiet `false`: both of them
   * refuse to compute, and only one of them is a statement about the clock.
   */
  clockSynchronized: boolean | null;
  /** The wall-clock instant the ages are measured against. */
  nowMs: number;
  /**
   * When this build of Wayfarer came into existence, and therefore the earliest instant any file it
   * caused to be written can honestly carry.
   *
   * `null` when no floor could be established, and the check is then not applied — see the header.
   */
  notBeforeMs: number | null;
}

export type RuleSetAgeState =
  /** Refreshed within the window the profile asks for. On a remote set: *nothing proves otherwise*. */
  | 'fresh'
  /** Older than `MISSED_REFRESHES` intervals: the finding this file exists to raise. */
  | 'overdue'
  /** There is no file, so this set has never been fetched onto this device. */
  | 'never-fetched'
  /** The file could not be read, so nothing at all was learned about it. Never `never-fetched`. */
  | 'unreadable'
  /** The profile states no refresh interval, so nothing here can say when it is overdue. */
  | 'no-cadence'
  /** The clock cannot be trusted, so no age is computed. Never a number. */
  | 'unmeasurable';

export interface RuleSetAge {
  tag: string;
  type: 'remote' | 'local';
  state: RuleSetAgeState;
  /**
   * Seconds since the file was written. `null` whenever no honest number exists.
   *
   * On a remote set this is a **lower** bound on the age and not the age: the true figure is at
   * least this and may be very much more. `exact` says which it is.
   */
  ageSeconds: number | null;
  /**
   * The same number in words, formatted **here**, so there is one formatter for it in the product.
   *
   * A screen prints this rather than dividing `ageSeconds` itself. Two formatters for one quantity
   * had already drifted once — a pill reading `1h` above a sentence reading `83m ago`.
   */
  ageLabel: string | null;
  /** The cadence the profile states, in hours. `null` when it states none. */
  intervalHours: number | null;
  /** The age at which this set becomes a finding. `null` when no cadence was stated. */
  overdueAfterSeconds: number | null;
  /** The file the answer came from, so a person can look at the same thing this did. */
  observedFrom: string | null;
  /** False when the figure is a lower bound shared with every other remote set. See `ageSeconds`. */
  exact: boolean;
  /** One sentence. What a screen prints when there is no number, and beside it when there is. */
  summary: string;
}

/** Human-readable, and only ever produced from a number this file was willing to compute. */
export function describeAge(seconds: number): string {
  if (seconds < 90) return `${String(Math.max(0, Math.round(seconds)))}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${String(Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${String(Math.round(hours))}h`;
  return `${String(Math.round(hours / 24))}d`;
}

/**
 * Every rule set the profile carries, with how old it is and whether that is a problem.
 *
 * Pure. Given both sides, so every state above is reachable from a fixture.
 *
 * **Observations are paired with sets by position, never by tag.** A tag is unique in a valid
 * profile and the invariants refuse a duplicate, but this function is reachable from places that
 * have not been through them, and a join on a key that may repeat silently lets the last observation
 * win — which is how a `remote` set came to be reportable as `exact: true` against a local file. A
 * reading whose length does not match the sets is treated as no reading at all, because a
 * misaligned pairing is worse than an absent one.
 */
export function ruleSetAges(input: { sets: readonly RuleSet[]; reading: RuleSetReading }): RuleSetAge[] {
  const aligned = input.reading.observations.length === input.sets.length;

  return input.sets.map((set, index) => {
    const observation: RuleSetObservation = aligned
      ? input.reading.observations[index]!
      : { tag: set.tag, source: null, modifiedMs: null, unreadable: 'the reading did not describe this set', exact: false };
    const intervalHours = set.updateIntervalHours ?? null;
    const overdueAfterSeconds = intervalHours === null ? null : intervalHours * 3600 * MISSED_REFRESHES;

    const base = {
      tag: set.tag,
      type: set.type,
      intervalHours,
      overdueAfterSeconds,
      observedFrom: observation.source,
      exact: observation.exact,
      ageSeconds: null,
      ageLabel: null,
    };

    if (observation.unreadable !== null) {
      /*
       * **"I could not look" is not "there is nothing there."**
       *
       * Reported as its own state with its own hint, because the two send an operator to opposite
       * places: a set that was never fetched is a network or a URL, and a file that could not be read
       * is a permission on this device. Saying the first about the second is a confident wrong
       * instruction, which is worse than no instruction.
       */
      return {
        ...base,
        state: 'unreadable' as const,
        summary: `this device could not read the file that would say how old it is (${observation.unreadable})`,
      };
    }

    if (observation.modifiedMs === null) {
      /*
       * No file. For a remote set that means nothing has ever been downloaded — the core has no copy
       * to fall back to, so the rule matches nothing and the traffic it was written for goes out the
       * ordinary way. That is the failure in its loudest form, not its mildest.
       */
      return {
        ...base,
        state: 'never-fetched' as const,
        summary:
          set.type === 'remote'
            ? 'never fetched onto this device, so the rules that point at it match nothing'
            : 'the file this set is read from is not on this device',
      };
    }

    // Clock trust is an input. `false` and `null` are different facts and the same verdict.
    if (input.reading.clockSynchronized !== true) {
      return {
        ...base,
        state: 'unmeasurable' as const,
        summary:
          input.reading.clockSynchronized === false
            ? 'the clock has not been synchronised since boot, so its age cannot be measured'
            : 'the clock’s state could not be read, so its age cannot be measured',
      };
    }

    /*
     * A file cannot predate the software that wrote it.
     *
     * The clock being right *now* says nothing about what it read when this file was stamped, and a
     * board with no RTC battery stamps files with a fallback time on every boot before NTP lands.
     * A timestamp below the floor is clock damage; it is not an age and must not become one.
     */
    if (input.reading.notBeforeMs !== null && observation.modifiedMs < input.reading.notBeforeMs) {
      return {
        ...base,
        state: 'unmeasurable' as const,
        summary:
          'the file is stamped earlier than this build of Wayfarer existed, so the clock cannot be ' +
          'trusted for it and no age is reported',
      };
    }

    const ageSeconds = Math.round((input.reading.nowMs - observation.modifiedMs) / 1000);
    if (ageSeconds < 0) {
      // A file written in the future is evidence about the clock, not about the file.
      return {
        ...base,
        state: 'unmeasurable' as const,
        summary: 'this device’s clock is behind the file’s own timestamp, so its age cannot be measured',
      };
    }

    const measured = { ...base, ageSeconds, ageLabel: describeAge(ageSeconds) };
    /*
     * The words for a lower bound, and they say what the number is *not*.
     *
     * "At least this old" rather than "at most this fresh": the second is true and reads as
     * reassurance, and a reader who takes a shared figure for this set's own age has been misled by
     * a sentence that was technically correct.
     */
    const figure = observation.exact
      ? `refreshed ${describeAge(ageSeconds)} ago`
      : `at least ${describeAge(ageSeconds)} old — the cache holds every remote set together, so this ` +
        'figure only says something in it was refreshed then, and this set may be far older';

    if (overdueAfterSeconds === null) {
      /*
       * No cadence stated, so no verdict. The number is still worth printing — a person who can see
       * "nine days" can judge it even when this cannot — and the control that leaves the interval
       * empty is where the consequence belongs.
       */
      return {
        ...measured,
        state: 'no-cadence' as const,
        summary: `${figure}; no refresh interval is set, so nothing judges it`,
      };
    }

    if (ageSeconds > overdueAfterSeconds) {
      return {
        ...measured,
        state: 'overdue' as const,
        summary:
          `${figure}, which is already more than ` +
          `${String(MISSED_REFRESHES)} refreshes of ${String(intervalHours)}h missed in a row`,
      };
    }

    return { ...measured, state: 'fresh' as const, summary: figure };
  });
}

/**
 * The reader, composed from things it is handed rather than things it reaches for.
 *
 * `modifiedMs`, `clockSynchronized` and `notBeforeMs` touch the operating system, so they arrive as
 * functions. The composition is here rather than at the call sites because **which file answers for
 * which kind of set** is the decision argued at the top of this file, and a caller repeating it is a
 * caller that can get it wrong.
 *
 * `nowMs` is taken **once**, after the timestamps, so every set in one report is measured against
 * one reading of the clock. Taking it per set would let a slow stat make two sets in the same
 * report disagree about what "now" was.
 *
 * One observation per set, **in order**, which is the pairing `ruleSetAges` relies on.
 */
export function readRuleSets(readers: {
  modifiedMs: (path: string) => Promise<number | null>;
  clockSynchronized: () => Promise<boolean | null>;
  nowMs?: () => number;
  notBeforeMs?: () => Promise<number | null>;
}): (sets: readonly RuleSet[]) => Promise<RuleSetReading> {
  /**
   * A read that failed is carried as a failure. `fileModifiedMs` returns `null` only for a file that
   * is not there and throws for everything else, and that distinction is the whole of item 2.
   */
  const look = async (path: string): Promise<{ modifiedMs: number | null; unreadable: string | null }> => {
    try {
      return { modifiedMs: await readers.modifiedMs(path), unreadable: null };
    } catch (error) {
      return { modifiedMs: null, unreadable: String(error instanceof Error ? error.message : error) };
    }
  };

  return async (sets) => {
    /*
     * The cache file is read once even when twenty remote sets point at it. It is one bound on all
     * of them, and statting it per set would imply twenty independent measurements where there is
     * one.
     */
    const anyRemote = sets.some((set) => set.type === 'remote');
    const cache = anyRemote ? await look(PATHS.coreCache) : { modifiedMs: null, unreadable: null };

    const observations: RuleSetObservation[] = [];
    for (const set of sets) {
      if (set.type === 'remote') {
        observations.push({ tag: set.tag, source: PATHS.coreCache, ...cache, exact: false });
        continue;
      }
      // A local set with no path is a profile the invariants should have caught; here it is simply
      // a set with no file to look at, which the arithmetic already renders as "not on this device".
      const path = set.path ?? null;
      const read = path === null ? { modifiedMs: null, unreadable: null } : await look(path);
      observations.push({ tag: set.tag, source: path, ...read, exact: true });
    }

    return {
      observations,
      clockSynchronized: await readers.clockSynchronized().catch(() => null),
      nowMs: (readers.nowMs ?? Date.now)(),
      notBeforeMs: await (readers.notBeforeMs ?? softwareBuiltAtMs)().catch(() => null),
    };
  };
}

/**
 * When this build of Wayfarer came into existence, for the floor argued in the header.
 *
 * Two sources, in order, because the first is absent in development and the second is absent
 * nowhere: the build stamp the installer writes, then the modification time of the bundle this
 * process is running from. Either is an instant at which this software already existed, which is all
 * the floor claims.
 *
 * Read once per process. The answer cannot change while the process runs, and a stat per drift round
 * for a value that never moves is a cost with no reading behind it.
 */
let builtAtOnce: Promise<number | null> | null = null;
export function softwareBuiltAtMs(): Promise<number | null> {
  builtAtOnce ??= (async (): Promise<number | null> => {
    // Plain strings rather than `import.meta.url`: the deployed artefact is a CommonJS bundle where
    // `import.meta` is empty, so a stamp looked up that way is missing on the device and present in
    // development — the worst way round. The same reasoning as `readBuildStamp` in `index.ts`.
    const beside = process.argv[1] === undefined ? null : `${process.argv[1].replace(/\/[^/]+$/, '')}/build.json`;
    for (const path of ['/opt/wayfarer/build.json', ...(beside === null ? [] : [beside])]) {
      const text = await readManaged(path).catch(() => null);
      if (text === null) continue;
      try {
        const parsed = JSON.parse(text) as { builtAt?: string };
        const at = typeof parsed.builtAt === 'string' ? Date.parse(parsed.builtAt) : Number.NaN;
        if (Number.isFinite(at)) return at;
      } catch {
        /* Next candidate. */
      }
    }
    if (process.argv[1] === undefined) return null;
    return fileModifiedMs(process.argv[1]).catch(() => null);
  })();
  return builtAtOnce;
}

/**
 * Which rule sets a routing rule actually points at.
 *
 * A set nothing points at is loaded and refreshed for nobody, and its age is not a finding: raising
 * one would teach people that this check fires about things that do not matter, which is how the
 * ones that do matter stop being read.
 */
export function ruleSetsInUse(rules: readonly { kind: string; sets?: readonly string[] }[]): Set<string> {
  const used = new Set<string>();
  for (const rule of rules) {
    if (rule.kind !== 'ruleSet') continue;
    for (const tag of rule.sets ?? []) used.add(tag);
  }
  return used;
}

/**
 * **The whole answer for one profile, and the only place the three steps are written down.**
 *
 * Choosing which sets are in use, building the reader, and doing the arithmetic were copied between
 * the drift check and the API route in the first version of this work — against the argument its own
 * commit message made about `PATHS.coreCache`. Two copies of a selection rule is how one of them
 * comes to answer about a different set of sets.
 */
export async function ruleSetAgesFor(
  document: ProfileDocument,
  readers: {
    clockSynchronized: () => Promise<boolean | null>;
    modifiedMs?: (path: string) => Promise<number | null>;
    nowMs?: () => number;
    notBeforeMs?: () => Promise<number | null>;
  },
): Promise<RuleSetAge[]> {
  const inUse = ruleSetsInUse(document.routing.rules);
  const watched = document.routing.ruleSets.filter((set) => inUse.has(set.tag));
  const read = readRuleSets({
    modifiedMs: readers.modifiedMs ?? fileModifiedMs,
    clockSynchronized: readers.clockSynchronized,
    ...(readers.nowMs === undefined ? {} : { nowMs: readers.nowMs }),
    ...(readers.notBeforeMs === undefined ? {} : { notBeforeMs: readers.notBeforeMs }),
  });
  return ruleSetAges({ sets: watched, reading: await read(watched) });
}
