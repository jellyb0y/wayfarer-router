/**
 * Parity: every field a person must fill is reachable from the interface as well as from the API.
 *
 * ## Why this exists at all
 *
 * The gap this closes was not found by a test, by a review or by reading the code. It was found by
 * the owner asking whether he could do a thing with the mouse. Three fields a tunnel cannot work
 * without — its obfuscation entry points, its destinations and its health probe — were configurable
 * through the API alone, and so was the access point's passphrase after the editor that held it was
 * scheduled for deletion. Until something asserts this mechanically, the person who finds each next
 * one is the person trying to use the product for its purpose.
 *
 * ## The two sides, and why neither is a list anybody maintains
 *
 * **What renders** comes from `apps/ui/parity-manifest.json`, which the interface's own test writes
 * from the rendered DOM before every comparison. It is never edited by hand. A manifest built from
 * the components' source, or from a table of what ought to render, would agree with a screen that
 * draws nothing.
 *
 * **What must be fillable** is `parityRequirements()` below, derived from the document schema in
 * three layers, in order of how little argument each one admits.
 *
 * ## Why both of them live in this package, and the comparison runs in the interface's suite
 *
 * The manifest is rewritten from the DOM immediately before it is compared. Read it from a *second*
 * process — the daemon's test run, say — and the comparison is against whatever that other suite
 * last wrote. A stale manifest fails in the reassuring direction: it still lists a field that has
 * since been deleted from a screen, so the deletion stays green. That is the exact shape this
 * project keeps finding, and defending against it with a freshness check would only add a second
 * thing that can quietly stop working.
 *
 * So staleness is removed as a possibility rather than detected: **the comparison happens in the
 * same run that generates the manifest.** Nothing here reads a file, opens a socket or knows where
 * the manifest lives; both sides arrive as arguments. That is what makes the function callable from
 * a suite in another package, and what makes the emptiness cases below reachable at all.
 *
 * What stays in the daemon's own run is a different assertion, and not about the interface: that
 * the layer-1 pointers produced here are **exactly** the set a missing-secret refusal names, in both
 * directions. A requirement the refusal could not name is the mirror of a guard control never
 * reaches; a position the refusal names that is not required is a hole.
 *
 * ## There is deliberately no exception list
 *
 * Not a parameter, not a constant, not a file. A list of fields that are allowed to be unreachable
 * is a list nobody revisits: it grows by one entry per inconvenient afternoon until the check is a
 * formality that passes. The only way a pointer leaves the required set is by the schema itself
 * saying what the value's source is — a mark in the declaration, reviewed in the diff that
 * introduces the field, next to the field it is about.
 *
 * So an **unmarked** field is a failure rather than a pass. Getting this backwards is the whole
 * difference between a check that finds tomorrow's omission and one that finds only today's.
 *
 * ## What it prints when it is given nothing
 *
 * Asked of this check, the answer must not be "the same thing it prints when everything is
 * correct". Three emptinesses are each their own fault, named separately:
 *
 * - **the manifest is not there at all** — the interface's test has never run, so nothing is known
 *   about what renders, and a comparison against an absent file is a comparison against no claim;
 * - **the manifest lists no screens** — a manifest can be present and vacuous, and an empty
 *   intersection with anything is empty. A screen that edits nothing is still *listed*, precisely so
 *   that "there is nothing to fill here" and "nobody looked here" are different states;
 * - **nothing is required** — the schema walk returned no positions. That is not parity. A check
 *   with an empty left-hand side passes against every possible right-hand side, including a product
 *   with no interface.
 *
 * Both sides empty produces both faults, not silence.
 */

import { ProfileDocument } from './profile.ts';
import { secretMatchers } from './secret-transforms.ts';
import { escapePointerSegment, isRecord, type SecretKind } from './secrets.ts';
import { sourceOf, type FieldSource } from './source.ts';

/** One position that renders, as the interface's own test observed it. */
export interface ParityField {
  /** A JSON Pointer with numeric segments normalised to `-`: a position in the document, not a row. */
  pointer: string;
  screen: string;
}

/** What `apps/ui/parity-manifest.json` holds. Written by the interface, read here, never written here. */
export interface ParityManifest {
  /** Every screen that was looked at, including the ones that edit nothing. */
  screens: string[];
  fields: ParityField[];
}

/**
 * Which layer of the boundary rule put a pointer on the required list.
 *
 * Ordered by how little argument each admits, and reported so that a failure says not only what is
 * unreachable but on whose authority it is required.
 */
export type ParityLayer =
  /**
   * The hard core. The daemon refuses to activate a profile whose secrets are missing and names the
   * positions. That list is the system's own answer to "a person must fill this", it is derived from
   * the document by the same code on both sides, and it cannot go stale. No annotation, no schema
   * opinion and no exception can be expressed against it.
   */
  | 'refusal'
  /** Declared `Secret()`. A credential, whether or not a refusal happens to name it today. */
  | 'secret'
  /** Marked in the schema as having no source but a person. */
  | 'person'
  /**
   * Declares no source at all.
   *
   * Required, deliberately, rather than skipped: the default is that a person fills a field, and a
   * field nobody has classified is a field nobody has thought about. Excusing it here would make
   * forgetting the mark the cheapest way to leave a field out of the interface, which is the exact
   * shape of an exception list that grows.
   *
   * **No position in the document reaches this layer today.** The six that did are now `generated`,
   * so every leaf carries a mark and this branch fires only for a field added tomorrow. That is the
   * intended steady state and it is also a hazard with a name in this repository: a branch no input
   * can reach is a branch nothing proves. It is proved instead against a schema built to reach it,
   * which is why `parityRequirements` takes a root at all — see there.
   */
  | 'unmarked';

export interface ParityRequirement {
  pointer: string;
  layer: ParityLayer;
  /** What the person would be supplying, in the vocabulary of the layer that required it. */
  because: string;
}

/**
 * What a person has to go and find, in the words the import checklist already uses.
 *
 * The kind rather than the pointer, because a pointer names the field and not the thing: a failure
 * reading only `/uplinks/-/config/psk` sends its reader to the schema to discover what is missing
 * from the product.
 */
const WHAT_IT_IS: Record<SecretKind, string> = {
  psk: 'a pre-shared key',
  password: 'a password',
  'private-key': 'a private key',
  token: 'a token',
  certificate: 'a certificate',
  uuid: 'an identifier from a provider',
  'config-blob': 'a configuration file from a provider',
  'subscription-url': 'a subscription link',
  secret: 'a credential',
};

/**
 * Every position a person must be able to fill, derived from the document schema and nothing else.
 *
 * Pure, and with no knowledge of who is asking: the interface's suite calls this, the daemon's
 * suite calls this, and neither can be handed a different answer.
 *
 * **Layer 1 — the refusal.** Every `Secret()` position in the document, which is precisely the set
 * of matchers the daemon's secret plan reduces this schema to, and therefore precisely the set of
 * positions a missing-secret refusal can name. Derived here from the schema rather than imported
 * from the daemon, because the interface cannot import the daemon; the daemon's own suite asserts
 * the two agree, which is where a divergence would mean something.
 *
 * `root` defaults to the profile document and exists for the same reason the walk's does: since the
 * six unmarked positions became `generated`, **no leaf in this document declares no source**, so the
 * `unmarked` layer — the loud default that the whole annotation is built on — is a branch no real
 * input reaches. An assertion made only against the document would pass just as happily with that
 * branch deleted, which is the shape this project keeps finding. Handing the derivation a schema
 * with an unclassified leaf is what makes it reachable at all.
 */
export function parityRequirements(root: unknown = ProfileDocument): ParityRequirement[] {
  const required = new Map<string, ParityRequirement>();

  for (const [pointer, kind] of secretMatchers(root as Record<string, unknown>)) {
    required.set(pointer, {
      pointer,
      layer: 'refusal',
      because: `${WHAT_IT_IS[kind]} the daemon refuses to activate a profile without`,
    });
  }

  for (const position of documentPositions(root)) {
    if (required.has(position.pointer)) continue;
    if (position.source === 'person') {
      required.set(position.pointer, {
        pointer: position.pointer,
        layer: 'person',
        because: 'a value only a person can supply',
      });
    } else if (position.source === null) {
      required.set(position.pointer, {
        pointer: position.pointer,
        layer: 'unmarked',
        because: 'a field that does not say where its value comes from',
      });
    }
  }

  return [...required.values()].sort((a, b) => a.pointer.localeCompare(b.pointer));
}

/** One leaf of the document schema, with the source that governs it. */
export interface DocumentPosition {
  pointer: string;
  /** The mark on the leaf, or an inherited `person`, or `null` when nothing declares one. */
  source: FieldSource | null;
  /** True when the governing mark came from an ancestor rather than from the leaf. */
  inherited: boolean;
}

/**
 * Every leaf position in the profile document, with where its value comes from.
 *
 * A leaf is a node nothing descends from. That distinction matters because a union of an object and
 * `null` puts a childless branch at the *container's* pointer — `/accessPoint` is such a case — and
 * counting it as a leaf would demand a mark for a position that is really the object above it. So a
 * pointer anything descended from is not a leaf, whatever else sits at it.
 *
 * Inheritance is `person`-only, and the rule is argued where it is declared, in `source.ts`.
 */
/**
 * Whether a node has positions of its own beneath it, as opposed to being a scalar.
 *
 * Used for one decision only: whether the walk enters an array. It looks through unions because an
 * array of "one of these objects" is still an array of addressable things.
 *
 * Exported for the assertion that pins which declarations are still shared by reference. That
 * assertion has to apply *this* array rule, not a restatement of it: a scalar array's element is
 * never a position, so a declaration shared there can never be lost by the walk, and a copy of the
 * rule in a test would drift from the one that decides.
 */
export const isComposite = (node: unknown): boolean => {
  if (!isRecord(node)) return false;
  if (isRecord(node['properties'])) return true;
  if (isRecord(node['items'])) return isComposite(node['items']);
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches) && branches.some((b) => isComposite(b))) return true;
  }
  return false;
};

/**
 * `root` defaults to the profile document and is a parameter for one reason: the inheritance rule —
 * `person` descends, the other four never do — cannot otherwise be proved in both directions. The
 * tree happens to carry no container marked `device`, `subscription`, `catalogue` or `generated`
 * today, so an assertion made only against it would pass just as happily with the rule inverted. That is the
 * shape this project keeps finding: a guard no input can reach. Handing the walk a schema built to
 * exercise the rule is what makes the negative direction reachable at all.
 */
export function documentPositions(root: unknown = ProfileDocument): DocumentPosition[] {
  const leaves = new Map<string, { source: FieldSource | null; inherited: boolean }>();
  const descended = new Set<string>();

  const walk = (
    node: Record<string, unknown>,
    pointer: string,
    inherited: FieldSource | null,
    ancestors: Set<unknown>,
  ): void => {
    if (typeof node !== 'object' || node === null || ancestors.has(node)) return;
    // The guard is the ancestor chain, not every node visited anywhere. A walk-wide set is a memo
    // keyed on object identity, and these declarations share objects by reference: `HardwareBinding`,
    // `PinName`, `TakeOverInterface` and `Identifier` are each written once and used at several
    // pointers. Memoised, the second pointer returns early and its leaves are never emitted at all —
    // neither required nor exempt, simply absent, which is the silent pass this annotation exists to
    // prevent.
    //
    // **The cost of this defect is not a stable number, and each time it has been measured it has
    // been a different one.** Measured by restoring the global set, against the tree of the day:
    //
    //   - the commit that fixed it said **ten** — a net across two defects that landed fixed
    //     together, since under the *old* array rule the visited set also erased `/policy/excluded/-`
    //     and `/policy/priority/-`, positions the array rule below now correctly never creates;
    //   - **eight**, once the array rule was separated out: the non-survivors of all four families;
    //   - **four**, 2026-09-21, after the three identifiers were marked `generated`. `Source()`
    //     copies the schema, so `Identifier` is no longer the *same object* at `/uplinks/-/id`,
    //     `/tunnels/-/id` and `/subscriptions/-/id` — only `/tunnels/-/config/entryPoints/-/id`
    //     still holds it raw, and one use cannot collide with itself. What remains is
    //     `/accessPoint/bind/by`, `/accessPoint/bind/value`, `/accessPoint/pinName` and
    //     `/accessPoint/takeOverInterface`.
    //   - **four**, 2026-09-21, after `/tunnels/-/config/entryPoints/-/id` was marked `generated`
    //     as well. The number did not move, and *that* is the measurement: the last raw use of
    //     `Identifier` left, and it cost nothing because a family with one use was already
    //     catching nothing. `Identifier` is now shared by reference at no pointer at all, and
    //     three families — `HardwareBinding`, `PinName`, `TakeOverInterface` — are what this guard
    //     has left. An unchanged number is worth recording precisely because it looks like nothing
    //     happened.
    //
    // That last step is worth reading twice, because nothing about the walk changed: **a mark added
    // for an unrelated reason silently reduced what this guard has left to catch.** Sharing by
    // reference is a property of the declarations, not of the walk, and any wrapper that copies —
    // `Source()`, `Secret()`, a spread in a future helper — dissolves it wherever it is applied. The
    // rule still holds and the guard is still right; there is simply less in the tree able to
    // trigger it, which is how a guard becomes unreachable without anyone touching it.
    //
    // Which positions are lost depends on the order of properties in the document — whichever use of
    // a shared declaration the walk reaches first is the one that survives — so the test that pins
    // this asserts each family whole rather than naming the casualties. A list of casualties would
    // agree with a reordering that had only moved the hole.
    const descent = new Set(ancestors);
    descent.add(node);

    const own = sourceOf(node);
    // Only `person` descends. An exempting mark on a container must not excuse a leaf added under
    // it later that nobody looked at.
    const governing = own ?? inherited;
    const carried = own === 'person' ? 'person' : own === null ? inherited : null;

    const properties = node['properties'];
    const items = node['items'];
    let hasChildren = false;

    if (isRecord(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        if (!isRecord(child)) continue;
        hasChildren = true;
        walk(child, `${pointer}/${escapePointerSegment(key)}`, carried, descent);
      }
    }
    // An array descends only when its element is composite. A list of scalars is filled by a single
    // control that writes the whole array, so the third string has no address of its own and never
    // will; demanding a control at `/…/suffixes/-` is a requirement nothing can satisfy — the mirror
    // of a guard no input can reach. An array of objects is the opposite case: each field of an
    // entry point is addressed separately, so a control at `/tunnels/-/config/entryPoints/-/uid`
    // exists and must, and the walk goes in.
    if (isRecord(items) && isComposite(items)) {
      hasChildren = true;
      walk(items, `${pointer}/-`, carried, descent);
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) if (isRecord(branch)) walk(branch, pointer, carried, descent);
    }

    if (hasChildren) descended.add(pointer);
    else if (pointer !== '') {
      // A union's branches share a pointer, so several may land here. A declared source on any
      // branch wins over none: a branch that is merely `null` says nothing about provenance.
      const existing = leaves.get(pointer);
      if (existing === undefined || (existing.source === null && governing !== null)) {
        leaves.set(pointer, { source: governing, inherited: own === null && governing !== null });
      }
    }
  };

  walk(root as Record<string, unknown>, '', null, new Set());

  return [...leaves.entries()]
    .filter(([pointer]) => !descended.has(pointer))
    .map(([pointer, entry]) => ({ pointer, source: entry.source, inherited: entry.inherited }))
    .sort((a, b) => a.pointer.localeCompare(b.pointer));
}

export type ParityFault =
  | { kind: 'manifest-absent'; path: string }
  | { kind: 'manifest-has-no-screens' }
  | { kind: 'nothing-required' }
  | { kind: 'unreachable'; pointer: string; layer: ParityLayer; because: string };

export interface ParityReport {
  faults: ParityFault[];
  /** Counted for the output, so a passing run says how much it compared rather than only that it passed. */
  requiredCount: number;
  renderedCount: number;
  screenCount: number;
}

/**
 * The verdict, as a function with a caller.
 *
 * Takes both sides as data, which is the only reason the emptiness cases above can be exercised: a
 * comparison written inline in a test can only ever be handed what the tree happens to contain that
 * day.
 *
 * `manifest` is `null` when the file is absent. Absent and empty are distinct and both fail; the
 * distinction is kept because they send a reader to different places — one to run the interface's
 * test, one to look at what it produced.
 */
export function parityReport(
  required: readonly ParityRequirement[],
  manifest: ParityManifest | null,
  manifestPath = 'apps/ui/parity-manifest.json',
): ParityReport {
  const faults: ParityFault[] = [];

  if (manifest === null) faults.push({ kind: 'manifest-absent', path: manifestPath });
  else if (manifest.screens.length === 0) faults.push({ kind: 'manifest-has-no-screens' });

  if (required.length === 0) faults.push({ kind: 'nothing-required' });

  const rendered = new Set((manifest?.fields ?? []).map((field) => field.pointer));
  for (const requirement of required) {
    if (!rendered.has(requirement.pointer)) {
      faults.push({
        kind: 'unreachable',
        pointer: requirement.pointer,
        layer: requirement.layer,
        because: requirement.because,
      });
    }
  }

  return {
    faults,
    requiredCount: required.length,
    renderedCount: rendered.size,
    screenCount: manifest?.screens.length ?? 0,
  };
}

/**
 * The failure, in words, because a pointer alone does not tell a reader what to do about it.
 *
 * Every line names both what is wrong and what would make it right, which is the rule this project
 * arrived at for refusals: one that names only what it rejects is a riddle.
 */
export function describeParity(report: ParityReport): string {
  const lines: string[] = [];
  for (const fault of report.faults) {
    switch (fault.kind) {
      case 'manifest-absent':
        lines.push(
          `${fault.path} is not there. It is written by the interface's own parity test from the ` +
            `rendered DOM; run that suite. Nothing is known about what renders until it exists, and ` +
            `an absent file is not an empty one.`,
        );
        break;
      case 'manifest-has-no-screens':
        lines.push(
          `the manifest lists no screens, so nothing was looked at. A screen that edits nothing is ` +
            `still listed; an empty list means the walk found no screens, not that no screen edits.`,
        );
        break;
      case 'nothing-required':
        lines.push(
          `nothing was required of the interface. The schema walk produced no positions a person ` +
            `must fill, which makes this comparison vacuous — it would pass against a product with ` +
            `no interface at all.`,
        );
        break;
      case 'unreachable':
        lines.push(
          `${fault.pointer} — ${fault.because} — is reachable from the API and from no screen. ` +
            `Required by: ${fault.layer}.`,
        );
        break;
    }
  }
  return lines.join('\n');
}
