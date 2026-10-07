/**
 * The drift check: does what is on this device match what the stored profile says it should be?
 *
 * ## Why it exists
 *
 * Nothing in this device compared the running configuration with the stored one. Not at boot — the
 * boot guard re-derives the *environment-dependent* artefacts and looks at nothing else. Not after a
 * revert — `revertTransaction` deliberately leaves the profile pointer where it is, so the stored
 * document and the running one are expected to differ and nobody was told. Not periodically — the
 * daemon ran a resolver watcher and a confirmation-window watcher and no third thing.
 *
 * Two costs were measured on the bench board and both were found by hand:
 *
 * 1. **2026-09-22.** `profile.firewall.blockedEndpoints` held six entries while
 *    `/etc/wayfarer/core/config.json` held none. A confirmation window on an unrelated transaction
 *    had expired and taken the change with it. The undo was correct; the silence was not.
 * 2. **2026-09-21.** The core kept asking `10.184.40.5` while the daemon had captured `10.184.100.5`
 *    to `/run/wayfarer/tunnel/hq.dns`. `wplan.hq.lan` stopped resolving for every client on
 *    the network, the tunnel was healthy throughout, and nothing reported the mismatch.
 *
 * A third was found in passing and is the same shape: the core's `route_exclude_address` still named
 * `10.164.0.0/20`, a subnet the hq tunnel had left for `10.165.0.0/20`, so the exclusion protected
 * nothing and the network actually in use was not excluded at all.
 *
 * ## What it compares, and what it deliberately does not
 *
 * It re-derives from the **stored profile** and compares against the files on disk, the units systemd
 * reports, and the sysctl keys the plan sets. It does not compare against `lastAppliedDocument()`:
 * per `docs/13-plan.md` row G4 that names the *full intended* document even when the apply was
 * narrowed, so it can name a document the device never fully ran — and a baseline that may be fiction
 * cannot answer a question about reality.
 *
 * It does not look at pending interface renames. A `.link` file is an artefact we write and it *is*
 * checked; the kernel applying it is a boot event, and calling a device that has not rebooted yet
 * "diverged" would make the check permanently red for a reason nobody can act on except by rebooting.
 *
 * ## Report, not repair
 *
 * This check has no side effect on the configuration and is not permitted one. A device that notices
 * a difference and silently re-applies is a device that performs a change nobody ordered — which this
 * project has already suffered twice, once when an automatic re-derive applied a whole staged plan
 * (`docs/13-plan.md` row G3) and once when a narrowed apply put in a document it then recorded in
 * full. Re-applying is also the one action that destroys the evidence: whatever caused the divergence
 * would be papered over on a fifteen-minute cadence and never investigated. The repair is an apply,
 * and an apply is a thing a person asks for, with a confirmation window behind it.
 *
 * ## The clock
 *
 * This board has no RTC battery, so nothing here does wall-clock arithmetic. The age of a report is
 * taken from `performance.now()`, which is monotonic from process start, and the schedule is a
 * `setInterval`, which counts on the same clock. The ISO instant on a report is for a person reading
 * it and is never subtracted from anything.
 */

import type { ProfileDocument } from '@wayfarer/schemas';
import type { ProfileStore } from '../state/profiles.ts';
import type { Store } from '../state/store.ts';
import { planDocument, type PipelineContext } from './pipeline.ts';
import { differingPointers, type Plan2, type Reality, type UnitChange } from './differ.ts';
import { MISSED_REFRESHES, ruleSetAgesFor, type RuleSetAge } from './rule-set-age.ts';
import type { DesiredState, ManagedFile } from './desired-state.ts';
import { UNOBSERVED, type ObserverHandle } from './observers.ts';
import { readStamp, type MonotonicStamp } from './credential-expiry.ts';
import { readStockUnits, type StockUnitReading } from '../platform/stock-units.ts';

/** What kind of thing diverged. The axis is *what a person has to look at*, not which code found it. */
export type DivergenceKind =
  | 'file-missing'
  | 'file-content'
  | 'file-mode'
  | 'unit-stopped'
  | 'unit-stale'
  | 'unit-unknown'
  | 'unit-enablement'
  | 'unit-extra'
  | 'sysctl'
  | 'unplannable'
  /**
   * A rule set the routing points at that has not been refreshed for as long as the profile's own
   * interval says it should have been, several times over.
   *
   * It belongs in this report and not in a report of its own, because it is the same question:
   * *does what is on this device match what the stored profile says it should be?* The profile says
   * refresh this list every N hours; the device holds a copy written long before that allows. The
   * argument, the threshold and what the age can honestly be read from are in `rule-set-age.ts`.
   */
  | 'rule-set-stale'
  /**
   * A distribution unit the installer masked because it contends with one of ours, and which is no
   * longer masked. The list and each reason are in `platform/stock-units.ts`.
   *
   * Here and not in a report of its own for the same reason as the rule sets: the question is still
   * *is this device running what it is supposed to*, and the installer's mask is part of that.
   */
  | 'unit-conflicting';

/**
 * One divergence, in the shape this repository already uses for a finding.
 *
 * `severity`, `code`, `message` and `hint` are `core/invariants.ts`'s `Finding` contract, kept
 * deliberately rather than reinvented: the interface already knows how to put one of these in front
 * of somebody. Two fields are added and one is narrowed, because a finding about the *device* is not
 * a finding about the profile:
 *
 * * `pointer` on an invariant finding is a JSON Pointer **into the profile document**. Nothing here
 *   can honestly produce one — the generators turn a profile into a file and there is no way back —
 *   so this carries `subject` (the path, unit name or sysctl key) and, when both sides of a file
 *   parse as JSON, `pointer` as a pointer **into that file**. Claiming the profile pointer we cannot
 *   derive would be worse than naming the file precisely.
 * * `stored` and `running` are the two values, which is the whole point. A finding that says a file
 *   differs and not how is a finding somebody has to go and read the file to act on, and reading the
 *   file by hand is exactly what this check exists to replace.
 */
export interface DriftFinding {
  severity: 'error';
  code: 'config_diverged';
  kind: DivergenceKind;
  /** The generated file path, the unit name, or the sysctl key. Never a guess. */
  subject: string;
  /** A JSON Pointer **inside `subject`**, when it is a JSON file both sides of which parsed. */
  pointer: string | null;
  /** What re-deriving the stored profile produces. `null` means "nothing there". */
  stored: string | null;
  /** What this device actually holds. `null` means absent. */
  running: string | null;
  message: string;
  hint: string;
  /**
   * The file paths whose divergence is **why** this unit finding exists.
   *
   * The same field, with the same meaning, as `UnitChange.becauseOf` in the differ, and carried
   * straight through from it rather than re-derived: a restart is planned for the files a unit
   * consumes, and a unit reported stale without saying which file went stale sends somebody to read
   * every file the unit touches. Absent means "not recorded", never "no causes" — the differ's own
   * rule, unchanged.
   */
  becauseOf?: string[];
}

/**
 * Why a report says what it says.
 *
 * `unreadable` is its own state and not an empty finding list, for the reason this project states
 * everywhere it reads something: "I could not look" must never render as "there is nothing wrong".
 */
export type DriftState = 'converged' | 'diverged' | 'no-profile' | 'unreadable';

export interface DriftReport {
  state: DriftState;
  /** Why the check ran, so the event ring shows a boot report apart from a fifteen-minute one. */
  reason: string;
  findings: DriftFinding[];
  /** What was looked at, so "nothing to report" is distinguishable from "nothing was examined". */
  checked: { files: number; units: number; sysctl: number };
  /**
   * Findings left out because the report is capped.
   *
   * A device whose whole configuration is absent produces a finding per file per pointer, and an
   * event ring entry holding thousands of them is an event ring that has evicted everything else.
   */
  omitted: number;
  /** Why the check could not be made, when `state` is `unreadable`. */
  error?: string;
  /** For a person reading the report. **Never** subtracted from anything: this board has no RTC. */
  at: string;
  /** The monotonic reading the age of this report is computed from. See the note on the clock above. */
  checkedAtMonotonicMs: number;
  /**
   * When it ran, on the clock every process on this boot shares: the boot id and the seconds since it.
   *
   * `checkedAtMonotonicMs` is `performance.now()`, which is monotonic **within one process** and means
   * nothing in another. A report made by the timer's `way revert` is read by the daemon, so its age has
   * to be computed from something both can read: `/proc/uptime`, qualified by the boot it counts from.
   * `null` when either could not be read, and then the age is unknown rather than guessed.
   */
  checkedAt?: MonotonicStamp | null;
  /** What the check itself cost, from the same monotonic clock. */
  durationMs: number;
}

/** How many findings one report may carry. Beyond this they are counted, not listed. */
const MAX_FINDINGS = 40;
/** How many differing pointers one file may contribute, so one rewritten file cannot fill the cap. */
const MAX_POINTERS_PER_FILE = 8;
/** How much of a value is shown. Long enough for a subnet, a resolver or a rule; short enough to read. */
const MAX_VALUE_CHARS = 200;

/* ── the comparison, pure ────────────────────────────────────────────────────────────────── */

export interface DriftInput {
  desired: DesiredState;
  reality: Reality;
  /**
   * The differ's own classification of the same desired state against the same reality.
   *
   * Taken rather than recomputed, and that is the point: there is exactly one piece of code in this
   * repository that decides whether a unit is stale or extra, and a second one written here would
   * agree with it until the day one of them changed. What this adds is the two values, which the
   * classification does not carry because a plan review does not need them.
   */
  classified: Plan2;
  /** The invariant findings from planning the stored profile; an unplannable profile is a divergence. */
  planUsable: boolean;
  /** The first reason the plan is unusable, for the message. */
  planError?: { pointer: string; message: string } | null;
  /**
   * The age of every rule set the routing points at, already judged.
   *
   * Passed in rather than computed here for the same reason `classified` is: the decision about
   * what an age may honestly be read from, and what "too old" means, is argued in one file
   * (`rule-set-age.ts`) and a second copy of it would agree until one of them changed.
   */
  ruleSets?: RuleSetAge[];
  /** How each conflicting distribution unit stands. Read by the platform layer; judged here. */
  stockUnits?: StockUnitReading[];
}

/**
 * Every way in which this device is not running its stored profile.
 *
 * Pure, and handed both sides, so every finding below is reachable from a fixture rather than from a
 * board in a particular state.
 */
export function compareRunningState(input: DriftInput): { findings: DriftFinding[]; omitted: number } {
  const findings: DriftFinding[] = [];
  let omitted = 0;
  const push = (finding: DriftFinding): void => {
    if (findings.length >= MAX_FINDINGS) omitted += 1;
    else findings.push(finding);
  };

  /*
   * Rule-set ages first, and **before the unplannable early return below**, deliberately.
   *
   * A list's age has nothing to do with whether the stored profile can be planned: the core is
   * running from the configuration it already has and the cache it already has, so a profile that
   * cannot be planned is a device whose rule sets are *more* likely to be going stale, not less.
   * Reporting the age only when everything else is well would hide it exactly when it matters.
   *
   * Only `overdue` becomes a finding. `fresh` is nothing to say; `never-fetched` is reported too,
   * because a set the rules point at with no copy on this device matches nothing at all; and
   * `unmeasurable` and `no-cadence` are **not** findings — they are states the Routing screen says
   * in words, and an error a person cannot act on is an error that teaches people to ignore errors.
   */
  for (const set of input.ruleSets ?? []) {
    if (set.state !== 'overdue' && set.state !== 'never-fetched' && set.state !== 'unreadable') continue;
    push({
      severity: 'error',
      code: 'config_diverged',
      kind: 'rule-set-stale',
      // The tag, because that is the word the owner typed and the word a routing rule names.
      subject: `rule set "${set.tag}"`,
      pointer: null,
      stored:
        set.intervalHours === null
          ? 'a list this device fetches'
          : `refreshed every ${String(set.intervalHours)}h`,
      running: set.summary,
      message:
        `the routing sends traffic through rule set "${set.tag}", and this device's copy of it ${set.summary}. ` +
        'A list that is out of date does not know addresses allocated since it was written, so some of ' +
        'the traffic that rule was written for is leaving by the ordinary route while everything looks healthy',
      hint: ruleSetHint(set),
    });
  }

  /*
   * Also before the unplannable return: a stock unit that grabs the access point's ports costs its
   * clients their addresses whatever state the stored profile is in.
   */
  for (const reading of input.stockUnits ?? []) {
    const finding = stockUnitFinding(reading);
    if (finding !== null) push(finding);
  }

  if (!input.planUsable) {
    push({
      severity: 'error',
      code: 'config_diverged',
      kind: 'unplannable',
      subject: input.planError?.pointer ?? '/',
      pointer: input.planError?.pointer ?? null,
      stored: input.planError?.message ?? 'the stored profile cannot be realised on this hardware',
      running: null,
      message:
        'the stored profile cannot be planned against this device, so nothing can be compared with ' +
        `what is running: ${input.planError?.message ?? 'the plan reported an error'}`,
      hint: 'Open the plan review for the active profile; it names the field and what to do instead.',
    });
    // No file or unit comparison follows. A desired state built from an unusable plan is not a
    // statement about what should be running, and reporting it as one would name values nobody chose.
    return { findings, omitted };
  }

  const realityFiles = new Map(input.reality.files.map((file) => [file.path, file]));

  for (const file of [...input.desired.files, ...input.desired.networkFiles]) {
    const current = realityFiles.get(file.path);
    if (current === undefined) {
      // The path was not in the reading at all. Not "absent" — nobody asked about it. Three-valued.
      push(missingReading(file));
      continue;
    }
    if (current.content === null) {
      push({
        severity: 'error',
        code: 'config_diverged',
        kind: 'file-missing',
        subject: file.path,
        pointer: null,
        stored: `${file.content.length} bytes derived from the profile`,
        running: null,
        message: `${file.path} is not on this device, and the stored profile says it should be: ${file.purpose}`,
        hint: 'Apply the active profile to write it, or find out what removed it.',
      });
      continue;
    }
    if (current.content !== file.content) {
      for (const finding of contentFindings(file, current.content)) push(finding);
      continue;
    }
    if (current.mode !== null && current.mode !== file.mode) {
      push({
        severity: 'error',
        code: 'config_diverged',
        kind: 'file-mode',
        subject: file.path,
        pointer: null,
        stored: `0o${file.mode.toString(8)}`,
        running: `0o${current.mode.toString(8)}`,
        message:
          `${file.path} holds the right content with the wrong permissions: the profile derives ` +
          `0o${file.mode.toString(8)} and the device has 0o${current.mode.toString(8)}`,
        hint: 'A file a service cannot read is a service that fails. Apply the active profile.',
      });
    }
  }

  const realityUnits = new Map(input.reality.units.map((unit) => [unit.name, unit]));
  for (const change of input.classified.unitChanges) {
    const finding = unitFinding(change, realityUnits.get(change.name));
    if (finding !== null) push(finding);
  }

  for (const change of input.classified.sysctlChanges) {
    push({
      severity: 'error',
      code: 'config_diverged',
      kind: 'sysctl',
      subject: change.key,
      pointer: null,
      stored: change.to,
      running: change.from,
      message:
        `the kernel setting ${change.key} is ${change.from ?? 'unset'} and the stored profile derives ` +
        `${change.to} — ${change.reason}`,
      hint: 'Apply the active profile. A sysctl is not persisted by writing the drop-in alone.',
    });
  }

  return { findings, omitted };
}

/**
 * One conflicting distribution unit, as a finding — or nothing when it is masked or not installed.
 *
 * `unreadable` is a finding, not silence: "systemd could not be asked" must not read as "still masked".
 */
export function stockUnitFinding(reading: StockUnitReading): DriftFinding | null {
  if (reading.standing === 'masked' || reading.standing === 'absent') return null;
  const undo = `systemctl disable --now ${reading.unit} && systemctl mask ${reading.unit}`;
  if (reading.standing === 'unreadable') {
    return {
      severity: 'error',
      code: 'config_diverged',
      kind: 'unit-conflicting',
      subject: reading.unit,
      pointer: null,
      stored: 'masked',
      running: null,
      message:
        `systemd could not say whether ${reading.unit} is still masked (${reading.error ?? 'no answer'}). ` +
        `It is masked because ${reading.reason}`,
      hint: `Read it by hand: systemctl is-enabled ${reading.unit}. If it is not "masked": ${undo}`,
    };
  }
  const enablement = reading.unitFileState ?? 'unknown';
  const activity = reading.activeState ?? 'unknown';
  const running = `${enablement}, ${activity}`;
  const now =
    reading.activeState === 'active'
      ? 'it is running now, so the access point\'s clients may already be getting no address'
      : reading.unitFileState === 'enabled'
        ? 'it is enabled, so it starts at the next boot and the race is decided by which unit binds first'
        : reading.unitFileState === 'masked-runtime'
          ? 'it is masked only until the next boot'
          : 'nothing stops it being enabled or started again';
  return {
    severity: 'error',
    code: 'config_diverged',
    kind: 'unit-conflicting',
    subject: reading.unit,
    pointer: null,
    stored: 'masked',
    running,
    message: `${reading.unit} is no longer masked (${running}): ${now}. It was masked because ${reading.reason}`,
    hint: `Mask it again: ${undo} — or re-run the installer, which does the same.`,
  };
}

/**
 * Where to send the operator, **which is not the same place for the three ways a set can be wrong.**
 *
 * Neither branch of the first version looked at `set.type`, so a stale file sitting on this device
 * sent somebody to check an uplink and a URL that a `local` set does not have. A hint is an
 * instruction; a confidently wrong instruction costs more than none, because it is followed.
 */
function ruleSetHint(set: RuleSetAge): string {
  if (set.state === 'unreadable') {
    return set.observedFrom === null
      ? 'This device could not read the file that would date this set; check its permissions and the daemon’s access to it.'
      : `This device could not read ${set.observedFrom}; check that file’s permissions and ownership. It is not a network fault.`;
  }
  if (set.type === 'local') {
    return set.state === 'never-fetched'
      ? `The file this set is read from is not on this device${set.observedFrom === null ? '' : ` (${set.observedFrom})`}; put it there, or point the set at a path that exists.`
      : `Whatever writes ${set.observedFrom ?? 'this file'} on this device has not rewritten it; this set is read from a file here, not fetched.`;
  }
  return set.state === 'never-fetched'
    ? 'Check that this device can reach the URL the set is fetched from; until it can, the rules pointing at it match nothing.'
    : `Check this device's uplink and the URL the set is fetched from: at least ${String(MISSED_REFRESHES)} refreshes in a row have not landed.`;
}

function missingReading(file: ManagedFile): DriftFinding {
  return {
    severity: 'error',
    code: 'config_diverged',
    kind: 'file-missing',
    subject: file.path,
    pointer: null,
    stored: `${file.content.length} bytes derived from the profile`,
    running: null,
    message:
      `${file.path} was not read back, so whether it matches the stored profile is unknown. ` +
      'That is reported rather than passed over.',
    hint: 'Check that the daemon can read the configuration directory.',
  };
}

/**
 * The findings for one file whose content differs.
 *
 * A JSON file is compared pointer by pointer, because "the core configuration differs" sends somebody
 * to read a 40 KB document and `/route/rules/3/domain` does not. Anything else — a unit file, an
 * `nftables` ruleset, a `hostapd` configuration — is compared line by line and reported at the first
 * line that differs, with its number, which is the same service a diff would give and costs one pass.
 */
function contentFindings(file: ManagedFile, running: string): DriftFinding[] {
  let stored: unknown;
  let live: unknown;
  try {
    stored = JSON.parse(file.content);
    live = JSON.parse(running);
  } catch {
    return [lineFinding(file, running)];
  }

  const findings: DriftFinding[] = [];
  const differing = differingPointers(stored, live);
  let pointers = differing;

  /*
   * **A list whose order means nothing is compared as a set, and a reading is named as a reading.**
   *
   * Measured on the bench board, 2026-09-22: the report said the device was not running its stored
   * profile at `/inbounds/0/route_exclude_address/3` — "the profile derives 10.164.0.0/20 and the
   * device holds 10.136.0.0/24 (and 4 more)" — about a file written seconds after an apply from that very
   * profile. Both halves of that were wrong. The list is built from the networks on the device's
   * interfaces in the order the kernel lists them, which changes whenever a tunnel is recreated; and
   * it was compared by index, so one element moving made every later position a "difference". A
   * check that is red on a device that matches is a check that is always red, and an always-red check
   * hides the divergence that is real — that same report also carried the hq resolver, and nobody
   * could see it for the noise.
   */
  for (const mark of file.observed ?? []) {
    const under = (pointer: string): boolean => pointer === mark.pointer || pointer.startsWith(`${mark.pointer}/`);
    if (!pointers.some(under)) continue;
    const derived = valueAt(stored, mark.pointer);
    const held = valueAt(live, mark.pointer);
    if (!mark.unordered || !Array.isArray(derived) || !Array.isArray(held)) continue;
    pointers = pointers.filter((pointer) => !under(pointer));
    const key = (value: unknown): string => JSON.stringify(value);
    const heldKeys = new Set(held.map(key));
    const derivedKeys = new Set(derived.map(key));
    const onlyDerived = derived.filter((value) => !heldKeys.has(key(value)));
    const onlyHeld = held.filter((value) => !derivedKeys.has(key(value)));
    // The same members in another order: the core reads them as the same list, and so does this.
    if (onlyDerived.length === 0 && onlyHeld.length === 0) continue;
    findings.push({
      severity: 'error',
      code: 'config_diverged',
      kind: 'file-content',
      subject: file.path,
      pointer: mark.pointer,
      stored: render(onlyDerived),
      running: render(onlyHeld),
      message:
        `${file.path} at ${mark.pointer} is a list read off this device, not written in the profile — ` +
        `${mark.from} — and the reading has moved since the file was written. ` +
        (onlyHeld.length > 0
          ? `The device holds ${render(onlyHeld) ?? '[]'}, which a derivation now would drop. `
          : '') +
        (onlyDerived.length > 0
          ? `A derivation now adds ${render(onlyDerived) ?? '[]'}, which the device does not hold. `
          : '') +
        'The next apply writes the derivation.',
      hint:
        onlyHeld.length > 0
          ? 'Check that everything the device holds and a derivation now drops is really gone (an interface ' +
            'down, a tunnel restarting) before applying: an apply now removes it.'
          : 'Apply the active profile to put the current reading in force.',
    });
  }

  // Two documents that differ as text and not as JSON: key order, or whitespace. Still a divergence —
  // the file was rewritten by something that is not this daemon — and still worth naming.
  // Only when nothing differed as JSON at all: a difference fully explained by the order of a list
  // whose order means nothing is no difference, and must not come back through this door.
  if (differing.length === 0) return [lineFinding(file, running)];

  for (const pointer of pointers.slice(0, MAX_POINTERS_PER_FILE)) {
    if (file.credentials === true || carriesSecret(pointer)) {
      /*
       * **A divergence at a credential says that it differs, and never what it is.**
       *
       * These findings reach `GET /api/drift`, the **persisted** event ring and the Status screen.
       * The generated core configuration holds real credentials in clear by necessity — a proxy's
       * `password`, a VLESS account's `uuid` — so printing the two values of a differing pointer
       * publishes the credential to every reader of any of those three, and writes it to disk in a
       * table nothing redacts.
       *
       * This is the rule `renderPlan` already applies one layer along, where it refuses to return
       * generated file content at all with the note that doing so would *"defeat redaction
       * completely while looking like a safety feature"*. The same sentence applies here, and the
       * first version of this check did exactly what that note forbids.
       *
       * The finding keeps everything an operator needs to act — the file, the pointer, that the two
       * sides disagree — and loses only the one thing he must not be told by a log.
       */
      findings.push({
        severity: 'error',
        code: 'config_diverged',
        kind: 'file-content',
        subject: file.path,
        pointer,
        stored: 'a credential, withheld',
        running: 'a credential, withheld',
        message:
          `${file.path} differs from the stored profile at ${pointer}, which holds a credential. ` +
          'Both values are withheld: this finding is served by the API, shown on a screen and kept ' +
          'in the event ring, and none of those is a place for a password.',
        hint: 'Apply the active profile to put the derived value in force, or find out what wrote this one.',
      });
      continue;
    }
    const storedValue = render(valueAt(stored, pointer));
    const runningValue = render(valueAt(live, pointer));
    // A single value read off the device — a captured resolver — says so, so nobody goes looking in the
    // profile for a number the profile never held.
    const reading = (file.observed ?? []).find((mark) => pointer === mark.pointer || pointer.startsWith(`${mark.pointer}/`));
    findings.push({
      severity: 'error',
      code: 'config_diverged',
      kind: 'file-content',
      subject: file.path,
      pointer,
      stored: storedValue,
      running: runningValue,
      message:
        reading === undefined
          ? `${file.path} differs from the stored profile at ${pointer}: the profile derives ` +
            `${storedValue ?? 'nothing there'} and the device holds ${runningValue ?? 'nothing there'}`
          : `${file.path} differs at ${pointer}, a value read off this device rather than written in the ` +
            `profile — ${reading.from}: a derivation now gives ${storedValue ?? 'nothing there'} and the ` +
            `device holds ${runningValue ?? 'nothing there'}`,
      hint: 'Apply the active profile to put the derived value in force, or find out what wrote this one.',
    });
  }
  if (pointers.length > MAX_POINTERS_PER_FILE) {
    findings.push({
      severity: 'error',
      code: 'config_diverged',
      kind: 'file-content',
      subject: file.path,
      pointer: null,
      stored: `${pointers.length} differing pointers`,
      running: `${MAX_POINTERS_PER_FILE} of them are listed above`,
      message:
        `${file.path} differs from the stored profile at ${pointers.length} pointers; the first ` +
        `${MAX_POINTERS_PER_FILE} are listed. A file differing this widely was not edited by hand.`,
      hint: 'Compare the file with a plan review of the active profile.',
    });
  }
  return findings;
}

/**
 * Key names in a **generated** configuration whose value is a credential.
 *
 * Named rather than derived, because there is no mechanical link to derive it from: a catalogue
 * entry translates a profile field marked `x-secret` into whatever the core calls it, and
 * `ProxyConfig.auth.password` becoming `password` while `VlessConfig.id` becomes `uuid` is exactly
 * the kind of renaming that breaks a mapping built out of the schema.
 *
 * So the list is checked from the other end instead: `catalogue-secrets.test.ts` plans every
 * catalogue entry with a sentinel in each of its marked fields and fails if the sentinel comes out
 * under a key that is not here. A protocol added without a thought about this is a red test rather
 * than a password in the event ring.
 *
 * Matching is on the **last segment** of the pointer. A credential is a leaf; a container whose name
 * happens to match would be a false positive that costs only a withheld value, which is the correct
 * direction for this to be wrong in.
 */
const SECRET_LEAVES: ReadonlySet<string> = new Set([
  'password',
  'uuid',
  'private_key',
  'pre_shared_key',
  'psk',
  'auth_str',
  'token',
  'key',
  'secret',
]);

export function carriesSecret(pointer: string): boolean {
  const last = pointer.split('/').pop() ?? '';
  return SECRET_LEAVES.has(last.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * The first differing line of a non-JSON file, with its number — or, for a file its generator marked
 * as holding credentials, only the fact that it differs.
 *
 * The mark is `ManagedFile.credentials`, set where the file is written. It closed the hole this
 * comment used to record (`docs/13-plan.md` row G12): the `.ovpn` blob a catalogue entry writes holds
 * the operator's private key and a `hostapd` configuration its passphrase, and this function printed
 * the differing line of either into the API, a screen and the event ring. Deciding it from the file
 * mode was tried and rejected — every generated file here is `0600`.
 */
function lineFinding(file: ManagedFile, running: string): DriftFinding {
  const storedLines = file.content.split('\n');
  const runningLines = running.split('\n');
  let index = 0;
  while (index < storedLines.length && index < runningLines.length && storedLines[index] === runningLines[index]) {
    index += 1;
  }
  const storedLine = storedLines[index] ?? null;
  const runningLine = runningLines[index] ?? null;
  if (file.credentials === true) {
    /*
     * **The file is named and its content is not.** The generator marked this file as holding
     * credentials — an `.ovpn` blob with a private key and a `tls-crypt` key inline, a `hostapd`
     * passphrase — and these findings reach `GET /api/drift`, the Status screen and the persisted
     * event ring. Not even the line number is given: in a key block it says how far into the key the
     * difference starts, and "somewhere in this file" is all an operator needs to go and look.
     */
    return {
      severity: 'error',
      code: 'config_diverged',
      kind: 'file-content',
      subject: file.path,
      pointer: null,
      stored: 'credentials, withheld',
      running: 'credentials, withheld',
      message:
        `${file.path} differs from what the stored profile derives. The file holds credentials, so ` +
        'neither version is shown: this finding is served by the API, shown on a screen and kept in the ' +
        'event ring, and none of those is a place for a key.',
      hint: 'Compare the file on the device with a fresh plan, as root, or apply the active profile to rewrite it.',
    };
  }
  return {
    severity: 'error',
    code: 'config_diverged',
    kind: 'file-content',
    subject: file.path,
    // A line number, not a JSON Pointer. Named in the message rather than squeezed into `pointer`,
    // which this shape promises is a pointer or nothing.
    pointer: null,
    stored: clip(storedLine),
    running: clip(runningLine),
    message:
      `${file.path} differs from the stored profile at line ${index + 1}: the profile derives ` +
      `${describeLine(storedLine)} and the device holds ${describeLine(runningLine)}`,
    hint: 'Apply the active profile to put the derived content in force, or find out what wrote this one.',
  };
}

/**
 * One unit change from the differ, as a divergence.
 *
 * `install` is left out on purpose and it is the only omission: it means systemd's in-memory copy of
 * a definition is older than the file, which is a fact about a daemon-reload rather than about the
 * configuration, and it is planned from a file change that is already reported above in its own
 * right. Reporting it too would name the same divergence twice under two subjects.
 */
function unitFinding(change: UnitChange, current: { active: boolean; enabled: boolean; known: boolean } | undefined): DriftFinding | null {
  const base = {
    severity: 'error' as const,
    code: 'config_diverged' as const,
    subject: change.name,
    pointer: null,
    ...(change.becauseOf === undefined ? {} : { becauseOf: change.becauseOf }),
  };
  switch (change.action) {
    case 'install':
      return null;
    case 'start':
      if (current?.known === false || current === undefined) {
        return {
          ...base,
          kind: 'unit-unknown',
          stored: 'running',
          running: 'systemd does not know this unit',
          message:
            `${change.name} is in the stored profile — ${change.purpose} — and systemd has never ` +
            'heard of it, so nothing is running it',
          hint: 'Apply the active profile: the unit file has to be written and systemd reloaded.',
        };
      }
      return {
        ...base,
        kind: 'unit-stopped',
        stored: 'active',
        running: 'inactive',
        message: `${change.name} is not running, and the stored profile says it should be: ${change.purpose}`,
        hint: 'Read the unit\'s journal before re-applying: a unit that stopped usually says why.',
      };
    case 'restart':
      return {
        ...base,
        kind: 'unit-stale',
        stored: 'running the configuration the stored profile derives',
        running: 'running an older configuration',
        message:
          `${change.name} is running, but not from the configuration the stored profile derives ` +
          `(${(change.becauseOf ?? []).join(', ') || 'the file it consumes changed'})`,
        hint: 'Apply the active profile. Restarting the unit by hand puts the file in force without recording it.',
      };
    case 'stop':
      return {
        ...base,
        kind: 'unit-extra',
        stored: 'not asked for by this profile',
        running: 'active',
        message: `${change.name} is running and the stored profile does not ask for it: ${change.purpose}`,
        hint: 'Apply the active profile to stop it, or find out what started it.',
      };
    case 'enable':
    case 'disable':
      return {
        ...base,
        kind: 'unit-enablement',
        stored: change.action === 'enable' ? 'enabled' : 'disabled',
        running: current?.enabled === true ? 'enabled' : 'disabled',
        message:
          `${change.name} is ${current?.enabled === true ? 'enabled' : 'disabled'} and the stored profile ` +
          `derives ${change.action === 'enable' ? 'enabled' : 'disabled'} — which decides whether it comes ` +
          'back after a reboot, not whether it is running now',
        hint: 'Apply the active profile. This is the fault that only appears at the next boot.',
      };
    default:
      return null;
  }
}

/** The value a JSON Pointer names, or `undefined` when nothing is there. `'/'` is the whole document. */
export function valueAt(document: unknown, pointer: string): unknown {
  if (pointer === '/' || pointer === '') return document;
  let cursor: unknown = document;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function render(value: unknown): string | null {
  if (value === undefined) return null;
  return clip(JSON.stringify(value) ?? String(value));
}

/**
 * A line, as a sentence can carry it. Quoted, so an empty line is `""` rather than nothing at all:
 * measured 2026-09-23, a line added to the end of `/etc/wayfarer/README` read "the profile derives  and
 * the device holds …" — the derived side was the empty line after the last newline, printed as a blank.
 */
function describeLine(line: string | null): string {
  if (line === null) return 'the end of the file';
  if (line.trim() === '') return 'an empty line';
  return JSON.stringify(clip(line));
}

function clip(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= MAX_VALUE_CHARS ? value : `${value.slice(0, MAX_VALUE_CHARS)}… (${value.length} chars)`;
}

/* ── the check, which reads the device ───────────────────────────────────────────────────── */

export interface DriftDeps {
  profiles: ProfileStore;
  store: Store;
  pipeline: PipelineContext;
  /**
   * The monotonic clock. `performance.now()` in production; a counter in a test.
   *
   * Injected rather than called directly so a test can assert the duration without sleeping, and
   * named for its frame so nobody replaces it with `Date.now()` on a board that has no RTC battery.
   */
  monotonicMs?: () => number;
  /**
   * How old this device's copy of each rule set is.
   *
   * Optional **only because leaving it out is not silence**: the default is the shipped
   * `ruleSetAgesFor`, driven by the platform this context already holds. An optional dependency
   * whose default is "do nothing" would be a check that quietly does not run on whichever caller
   * forgot it, which is a shape this repository has already paid for; an optional dependency whose
   * default is the production implementation is an override for tests and nothing else.
   */
  /** Boot id and uptime now. Defaults to reading them through `pipeline.platform`; a test passes a counter. */
  stamp?: () => Promise<MonotonicStamp | null>;
  ruleSetAges?: (
    document: ProfileDocument,
    readers: { clockSynchronized: () => Promise<boolean | null> },
  ) => Promise<RuleSetAge[]>;
  /**
   * How each conflicting distribution unit stands. Defaults to asking `pipeline.platform.systemd`, for
   * the reason `ruleSetAges` defaults to the shipped reader: a default of "nothing" would be a check
   * that silently does not run for whichever caller forgot it.
   */
  stockUnits?: () => Promise<StockUnitReading[]>;
}

/**
 * Re-derive the stored profile and compare it with what this device is actually doing.
 *
 * Reads. Never writes, never reconciles, never applies. See the note at the top of this file.
 */
export async function checkDrift(deps: DriftDeps, reason: string): Promise<DriftReport> {
  const monotonic = deps.monotonicMs ?? ((): number => performance.now());
  const startedAt = monotonic();
  const finish = (partial: Omit<DriftReport, 'at' | 'checkedAtMonotonicMs' | 'durationMs' | 'reason'>): DriftReport => ({
    ...partial,
    reason,
    at: new Date().toISOString(),
    checkedAtMonotonicMs: startedAt,
    durationMs: Math.round(monotonic() - startedAt),
  });

  const activeId = deps.store.device().activeProfileId;
  const stored = activeId === null ? null : ((deps.profiles.get(activeId)?.document ?? null) as ProfileDocument | null);
  if (stored === null) {
    return finish({
      state: 'no-profile',
      findings: [],
      checked: { files: 0, units: 0, sysctl: 0 },
      omitted: 0,
    });
  }

  try {
    const planned = await planDocument(deps.pipeline, stored);
    const firstError = planned.plan.findings.find((finding) => finding.severity === 'error') ?? null;

    /*
     * Only the sets a routing rule actually points at.
     *
     * A set nothing points at is fetched and refreshed for nobody, so its age cannot cost anybody
     * traffic. The Routing screen already says a set is unused, in its own words and on its own row;
     * raising a *divergence* about one would teach people that this report fires about things that
     * do not matter, and that is how the ones that do stop being read.
     */
    const ruleSets = await (deps.ruleSetAges ?? ruleSetAgesFor)(stored, {
      // Clock trust is an input, exactly as it is for the certificate warning. `null` — the reading
      // failed — is carried through as `null` and never flattened into `false`.
      clockSynchronized: async () => (await deps.pipeline.platform.clock.status()).synchronized,
    });

    const stockUnits = await (deps.stockUnits ?? (async () => await readStockUnits(deps.pipeline.platform.systemd)))();

    const { findings, omitted } = compareRunningState({
      desired: planned.plan.desired,
      reality: planned.reality,
      classified: planned.classified,
      planUsable: planned.plan.usable,
      planError: firstError === null ? null : { pointer: firstError.pointer, message: firstError.message },
      ruleSets,
      stockUnits,
    });
    return finish({
      state: findings.length === 0 ? 'converged' : 'diverged',
      findings,
      checked: {
        files: planned.plan.desired.files.length + planned.plan.desired.networkFiles.length,
        units: planned.reality.units.length,
        sysctl: planned.plan.desired.sysctl.length,
      },
      omitted,
    });
  } catch (error) {
    /*
     * A check that could not be made is its own answer.
     *
     * Returning `converged` here would make every failure of the inventory, the platform layer or the
     * core's schema fetch read as a healthy device — the exact shape this repository records as *a
     * default meaning "assume everything" turns a missing wire into silence*.
     */
    return finish({
      state: 'unreadable',
      findings: [],
      checked: { files: 0, units: 0, sysctl: 0 },
      omitted: 0,
      error: String(error),
    });
  }
}

/* ── the monitor: the three moments, and the one place the last report lives ─────────────── */

export interface DriftMonitor {
  /** Runs the check, records what changed, and keeps the report. Never throws. */
  run(reason: string): Promise<DriftReport>;
  /** The last report, or `null` when the check has not run once. `null` is not "converged". */
  last(): DriftReport | null;
  /** Seconds since the last report, from the monotonic clock. `null` when there is no report. */
  ageSeconds(): number | null;
  /**
   * The latest report **made by any process** — this daemon, or the `way revert` a timer ran — with its
   * age from the boot-scoped uptime clock. What `GET /api/drift` serves.
   */
  current(): Promise<{ report: DriftReport | null; ageSeconds: number | null }>;
  /** Starts the periodic round. Idempotent. */
  start(): void;
  stop(): void;
}

/**
 * How often the check runs unattended.
 *
 * Fifteen minutes, and the number comes from the fastest divergence this device can produce on its
 * own. Measured on the bench board, 2026-09-21: one OpenVPN peer reconnected six times in forty
 * minutes — about seven minutes apart — and handed out a different resolver and a different transfer
 * subnet each time. The resolver watcher already reacts to that within a minute and refuses to act
 * more than once a minute, so this is not the mechanism that catches it; it is the backstop for the
 * case where that watcher's write was refused, silently changed nothing, or never fired. A backstop
 * must be slower than the thing it backs up or it competes with it, and it must be fast enough that
 * a divergence is never more than a coffee break old. Fifteen minutes is four rounds an hour on a
 * check measured at a few hundred milliseconds — see `docs/06-apply-and-rollback.md` for the figure.
 */
export const DRIFT_INTERVAL_MS = 15 * 60_000;

export function createDriftMonitor(
  deps: DriftDeps & {
    log?: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string) => void;
    intervalMs?: number;
    /** Where it says that it looked, what it saw and whether its round is scheduled. See `core/observers.ts`. */
    observer?: ObserverHandle;
    /**
     * Compare a first report with the **stored** one before writing an event, rather than with nothing.
     * For a one-shot process: `way drift` run twice in a row on an unchanged device says it once.
     */
    continueFromStored?: boolean;
  },
): DriftMonitor {
  const monotonic = deps.monotonicMs ?? ((): number => performance.now());
  const observer = deps.observer ?? UNOBSERVED;
  let report: DriftReport | null = null;
  /** Boot id and uptime, read through the platform this monitor already plans with. */
  const stamp =
    deps.stamp ??
    (async (): Promise<MonotonicStamp | null> => {
      try {
        const platform = deps.pipeline.platform;
        return await readStamp({
          bootId: () => platform.journal.currentBootId(),
          uptimeSeconds: () => platform.host.uptimeSeconds(),
        });
      } catch {
        return null;
      }
    });
  /** Written so the daemon and the CLI read one report. A store that cannot hold it is not fatal. */
  const persist = (value: DriftReport): void => {
    try {
      deps.store.setLastDrift?.(value);
    } catch (error) {
      deps.log?.('warn', { error: String(error) }, 'the drift report could not be stored');
    }
  };
  /**
   * What the last report said, reduced to the facts a person would act on.
   *
   * An event is recorded when this changes and not on every round. A device left diverged — which is
   * the normal state after a revert, because the profile pointer is deliberately not moved back —
   * would otherwise write the same entry every fifteen minutes until the event ring held nothing
   * else, and a ring full of one repeated fact is a ring that has evicted the reason for it.
   */
  let lastSignature: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const signatureOf = (value: DriftReport): string =>
    JSON.stringify([
      value.state,
      value.error ?? null,
      value.findings.map((finding) => [finding.kind, finding.subject, finding.pointer, finding.stored, finding.running]),
    ]);

  const run = async (reason: string): Promise<DriftReport> => {
    let priorStored: DriftReport | null = null;
    if (deps.continueFromStored === true && lastSignature === null) {
      try {
        priorStored = (deps.store.lastDrift?.() ?? null) as DriftReport | null;
      } catch {
        priorStored = null;
      }
    }
    const fresh = await checkDrift(deps, reason);
    fresh.checkedAt = await stamp();
    report = fresh;
    persist(fresh);
    observer.looked(summarise(fresh));
    if (lastSignature === null && deps.continueFromStored === true) {
      // The stored report as it was before this run overwrote it, read at the top of the run.
      lastSignature = priorStored === null ? null : signatureOf(priorStored);
    }
    const signature = signatureOf(fresh);
    if (signature === lastSignature) return fresh;

    const level = fresh.state === 'diverged' ? 'error' : fresh.state === 'unreadable' ? 'warn' : 'info';
    deps.store.recordEvent({
      level,
      kind: `config.${fresh.state}`,
      summary: summarise(fresh),
      // The findings travel whole. A summary that says "three differences" and drops which three is a
      // summary somebody has to reproduce the check to act on.
      detail: {
        reason,
        durationMs: fresh.durationMs,
        checked: fresh.checked,
        omitted: fresh.omitted,
        findings: fresh.findings,
        ...(fresh.error === undefined ? {} : { error: fresh.error }),
      },
    });
    /*
     * Marked as reported **after** the write, not before.
     *
     * Setting it first means a `recordEvent` that throws leaves the answer recorded as told, and the
     * next round — with the same divergence — says nothing. An event that failed to be written is not
     * an event that was written, and the difference is one silent divergence.
     */
    lastSignature = signature;
    observer.acted(`recorded config.${fresh.state}: the answer changed`);
    deps.log?.(level, { reason, state: fresh.state, findings: fresh.findings.length }, summarise(fresh));
    return fresh;
  };

  const guarded = async (reason: string): Promise<DriftReport> => {
    try {
      return await run(reason);
    } catch (error) {
      /*
       * Swallowed here and nowhere else. This runs on the boot path and at the end of an undo, and a
       * report that throws must not stop a device coming back or leave an undo looking failed. The
       * failure is still a report, in the `unreadable` state, so it cannot read as a healthy device:
       * "I could not look" and "there is nothing wrong" stay different answers.
       */
      const failed: DriftReport = {
        state: 'unreadable',
        reason,
        findings: [],
        checked: { files: 0, units: 0, sysctl: 0 },
        omitted: 0,
        error: String(error),
        at: new Date().toISOString(),
        checkedAtMonotonicMs: monotonic(),
        durationMs: 0,
      };
      failed.checkedAt = await stamp();
      report = failed;
      persist(failed);
      observer.looked(`the check could not be made: ${String(error)}`);
      deps.log?.('warn', { reason, error: String(error) }, 'the drift check could not be made');
      return failed;
    }
  };

  return {
    run: guarded,
    last() {
      return report;
    },
    ageSeconds() {
      return report === null ? null : Math.round((monotonic() - report.checkedAtMonotonicMs) / 1000);
    },
    async current() {
      let stored: DriftReport | null = null;
      try {
        stored = (deps.store.lastDrift?.() ?? null) as DriftReport | null;
      } catch {
        stored = null;
      }
      const now = await stamp();
      const uptimeAge = (value: DriftReport | null): number | null =>
        value?.checkedAt != null && now !== null && value.checkedAt.bootId === now.bootId
          ? Math.max(0, Math.round(now.uptimeSeconds - value.checkedAt.uptimeSeconds))
          : null;
      // The newer of the two. Within this process the in-memory one is also the stored one, unless the
      // write failed; a report another process wrote is newer exactly when its uptime is larger.
      const storedAge = uptimeAge(stored);
      const ownAge = uptimeAge(report);
      if (stored !== null && storedAge !== null && (report === null || ownAge === null || storedAge < ownAge)) {
        return { report: stored, ageSeconds: storedAge };
      }
      if (report !== null) return { report, ageSeconds: ownAge ?? Math.round((monotonic() - report.checkedAtMonotonicMs) / 1000) };
      // A stored report from another boot: shown, with no age, because none can honestly be computed.
      return { report: stored, ageSeconds: storedAge };
    },
    start() {
      if (timer !== null) return;
      // `setInterval` counts on a monotonic clock, which is the only kind this board has that can be
      // trusted: a time resync inside a round must not make the next round early, late or immediate.
      timer = setInterval(() => void guarded('periodic'), deps.intervalMs ?? DRIFT_INTERVAL_MS);
      timer.unref();
      observer.armed();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      observer.notRunning('stopped');
    },
  };
}

/** One sentence, in the terms a person asked the question in. */
export function summarise(report: DriftReport): string {
  switch (report.state) {
    case 'no-profile':
      return 'no profile is active, so there is nothing this device is supposed to be running';
    case 'unreadable':
      return `this device could not be compared with its stored profile: ${report.error ?? 'unknown'}`;
    case 'converged':
      return (
        `this device matches its stored profile: ${report.checked.files} file(s), ` +
        `${report.checked.units} unit(s) and ${report.checked.sysctl} kernel setting(s) checked`
      );
    case 'diverged': {
      const first = report.findings[0];
      const rest = report.findings.length - 1 + report.omitted;
      return (
        `this device is not running its stored profile: ${first?.message ?? 'a difference was found'}` +
        (rest > 0 ? ` (and ${rest} more)` : '')
      );
    }
  }
}

/**
 * A comparison a person asked for — `way drift` — **stored like every other one**.
 *
 * It called `checkDrift` directly and printed the answer, so its reading of the device never reached
 * `device.last_drift`. Measured on the bench board, 2026-09-23: with a marker line added to the README,
 * `way drift` said `diverged` at 22:13 while `/api/drift` said `converged` from 22:05, until the
 * periodic round at 22:18. Every check is a reading of the device, whoever runs it; now this one is
 * stored with its origin, `operator`, and the daemon serves it at once.
 */
export async function operatorDrift(
  deps: DriftDeps & { log?: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string) => void },
): Promise<DriftReport> {
  return await createDriftMonitor({ ...deps, continueFromStored: true }).run('operator');
}
